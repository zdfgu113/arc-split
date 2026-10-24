import { before, after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { network } from 'hardhat';
import { createPublicClient, createWalletClient, custom, keccak256, toHex, parseEventLogs } from 'viem';
import { hardhat } from 'viem/chains';
import { compileContracts } from '../scripts/compile.mjs';
import { verifyReceipt } from '../src/wallet.js';

let connection, client, sender, accounts, abi, bytecode, address, rejectBytecode;
const reference = text => keccak256(toHex(text));
before(async () => {
  const compiled = await compileContracts({ 'Reject.sol': { content: 'pragma solidity ^0.8.28; contract Reject { receive() external payable { revert("rejected"); } }' } });
  const contract = compiled['ArcSplit.sol'].ArcSplit;
  abi = contract.abi; bytecode = `0x${contract.evm.bytecode.object}`;
  rejectBytecode = `0x${compiled['Reject.sol'].Reject.evm.bytecode.object}`;
  connection = await network.connect('local');
  client = createPublicClient({ chain: hardhat, transport: custom(connection.provider) });
  sender = createWalletClient({ chain: hardhat, transport: custom(connection.provider) });
  accounts = await sender.getAddresses();
});
after(async () => { await connection?.close(); });
beforeEach(async () => { const hash = await sender.deployContract({ account: accounts[0], abi, bytecode }); address = (await client.waitForTransactionReceipt({ hash })).contractAddress; });
const pay = (recipients, amounts, id = reference('invoice-1'), value = amounts.reduce((a, b) => a + b, 0n), note = '项目结算', account) => sender.writeContract({ account: account ?? accounts[0], address, abi, functionName: 'split', args: [recipients, amounts, id, note], value });
const used = (id = reference('invoice-1'), account = accounts[0]) => client.readContract({ address, abi, functionName: 'paid', args: [account, id] });

test('a real EVM transfer pays every recipient exactly and leaves no new balance in the contract', async () => {
  const recipients = accounts.slice(1, 3);
  const before = await Promise.all(recipients.map(address => client.getBalance({ address })));
  const amounts = [7_000_000_000_000_000_000n, 3_000_000_000_000_000_000n];
  const hash = await pay(recipients, amounts);
  const receipt = await client.waitForTransactionReceipt({ hash });
  assert.equal(receipt.status, 'success');
  for (let i = 0; i < 2; i++) assert.equal((await client.getBalance({ address: recipients[i] })) - before[i], amounts[i]);
  assert.equal(await client.getBalance({ address }), 0n);
  assert.equal(await used(), true);
  const event = parseEventLogs({ abi, eventName: 'SplitPaid', logs: receipt.logs })[0];
  assert.equal(event.args.total, amounts[0] + amounts[1]);
  assert.deepEqual(event.args.amounts, amounts);
  assert.equal(event.args.note, '项目结算');
});
test('a rejected second receiver rolls back the first payout and payment reference', async () => {
  const hash = await sender.deployContract({ account: accounts[0], abi: [], bytecode: rejectBytecode });
  const reject = (await client.waitForTransactionReceipt({ hash })).contractAddress;
  const before = await client.getBalance({ address: accounts[1] });
  await assert.rejects(pay([accounts[1], reject], [700n, 300n]));
  assert.equal(await client.getBalance({ address: accounts[1] }), before);
  assert.equal(await client.getBalance({ address }), 0n);
  assert.equal(await used(), false);
});
test('the same payer cannot pay an invoice twice', async () => {
  await client.waitForTransactionReceipt({ hash: await pay(accounts.slice(1, 3), [700n, 300n]) });
  const balance = await client.getBalance({ address: accounts[1] });
  await assert.rejects(pay(accounts.slice(1, 3), [700n, 300n]));
  assert.equal(await client.getBalance({ address: accounts[1] }), balance);
});
test('another payer can use the same reference independently', async () => {
  await client.waitForTransactionReceipt({ hash: await pay(accounts.slice(2, 4), [700n, 300n]) });
  await client.waitForTransactionReceipt({ hash: await pay(accounts.slice(2, 4), [700n, 300n], reference('invoice-1'), 1000n, '', accounts[1]) });
  assert.equal(await used(reference('invoice-1'), accounts[1]), true);
});
test('wrong totals, zero payouts and empty references cannot move funds', async () => {
  for (const value of [999n, 1001n, 0n]) await assert.rejects(pay(accounts.slice(1, 3), [700n, 300n], reference('invoice-1'), value));
  await assert.rejects(pay(accounts.slice(1, 3), [0n, 1000n]));
  await assert.rejects(pay(accounts.slice(1, 3), [700n, 300n], `0x${'0'.repeat(64)}`));
  assert.equal(await used(), false);
});
test('zero, duplicate and contract-self recipients are rejected', async () => {
  for (const recipient of ['0x0000000000000000000000000000000000000000', accounts[1], address]) await assert.rejects(pay([accounts[1], recipient], [700n, 300n]));
});
test('mismatched arrays and unsupported recipient counts are rejected', async () => {
  await assert.rejects(pay([accounts[1]], [1000n]));
  await assert.rejects(pay(accounts.slice(1, 3), [1000n]));
  await assert.rejects(pay(accounts.slice(1, 12), Array(11).fill(1n)));
});
test('note length is bounded by bytes, including non-ASCII characters', async () => {
  await assert.rejects(pay(accounts.slice(1, 3), [700n, 300n], reference('invoice-1'), 1000n, '中'.repeat(33)));
  const receipt = await client.waitForTransactionReceipt({ hash: await pay(accounts.slice(1, 3), [700n, 300n], reference('invoice-1'), 1000n, '中'.repeat(32)) });
  assert.equal(receipt.status, 'success');
});
test('a receipt cannot be called paid without the correct successful event and exact payouts', async () => {
  const recipients = accounts.slice(1, 3);
  const amounts = [7_000_000_000_000_000_000n, 3_000_000_000_000_000_000n];
  const receipt = await client.waitForTransactionReceipt({ hash: await pay(recipients, amounts) });
  const expected = { account: accounts[0], contract: address, referenceId: reference('invoice-1'), note: '项目结算', plan: { total: 10_000_000n, payouts: recipients.map((address, i) => ({ address, nativeAmount: amounts[i] })) } };
  assert.equal(verifyReceipt(receipt, expected).status, 'success');
  assert.throws(() => verifyReceipt({ ...receipt, status: 'reverted' }, expected));
  assert.throws(() => verifyReceipt({ ...receipt, logs: [] }, expected));
  assert.throws(() => verifyReceipt(receipt, { ...expected, referenceId: reference('wrong') }));
  assert.throws(() => verifyReceipt(receipt, { ...expected, note: 'wrong memo' }));
  assert.throws(() => verifyReceipt(receipt, { ...expected, plan: { ...expected.plan, payouts: [{ address: accounts[4], nativeAmount: amounts[0] }, expected.plan.payouts[1]] } }));
});
