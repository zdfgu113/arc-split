import { before, after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, unlink, rmdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { network } from 'hardhat';
import { createPublicClient, createWalletClient, custom, encodeFunctionData, keccak256, toHex } from 'viem';
import { arc, arcTestnet } from 'viem/chains';
import { createLocalWallet } from '../scripts/local-wallet.mjs';
import { inspectRequest, validateIntent, signAndSubmit, readSigned, publicFailure, LocalSigningError, checkMainnetBudget, approvalText } from '../scripts/local-signing.mjs';
import { createLocalServer } from '../scripts/local-app.mjs';
import artifact from '../src/artifact.json' with { type: 'json' };
import { verifyReceipt } from '../src/wallet.js';

let directory, file, account, connection, client, sender, recipients, contract, server;
const password = 'temporary-local-evm-test-only';
const fees = { gas: '1000000', maxFeePerGas: '20000000000', maxPriorityFeePerGas: '1000000000' };
const deploy = () => ({ mode: 'testnet', account, data: artifact.bytecode, value: '0', ...fees });
const payment = (ref = 'test-local-signing') => ({ mode: 'testnet', account, to: contract, data: encodeFunctionData({ abi: artifact.abi, functionName: 'split', args: [recipients, [700_000_000_000_000_000n, 300_000_000_000_000_000n], keccak256(toHex(ref)), '本机钱包测试'] }), value: '1000000000000000000', ...fees });
const envelope = async (input, rpc = client, owner = account) => {
  const intent = { ...input, nonce: await rpc.getTransactionCount({ address: owner, blockTag: 'pending' }), expiresAt: Date.now() + 9 * 60_000 };
  return { intent, summary: (await validateIntent(intent, owner, rpc)).summary, password };
};
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'arc-signer-test-')); file = join(directory, 'ephemeral.json');
  account = (await createLocalWallet(file, password)).address;
  connection = await network.connect('localArc');
  client = createPublicClient({ chain: arcTestnet, transport: custom(connection.provider) });
  sender = createWalletClient({ chain: arcTestnet, transport: custom(connection.provider) });
  recipients = (await sender.getAddresses()).slice(1, 3);
  await connection.provider.request({ method: 'hardhat_setBalance', params: [account, '0x3635c9adc5dea00000'] });
  contract = (await client.waitForTransactionReceipt({ hash: await sender.deployContract({ account: (await sender.getAddresses())[0], abi: artifact.abi, bytecode: artifact.bytecode }) })).contractAddress;
});
after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  await connection?.close();
  if (directory) { for (const name of await readdir(directory)) await unlink(join(directory, name)); await rmdir(directory); }
});

test('signing policy refuses arbitrary calls, networks, altered amounts and unsafe fees before unlocking', () => {
  const valid = payment();
  assert.equal(inspectRequest(valid, account).kind, 'split');
  for (const changed of [
    { mode: 'demo' }, { mode: '__proto__' }, { mode: ['mainnet'] }, { mode: ['testnet'] }, { mode: {} }, { account: recipients[0] }, { value: '999' }, { data: '0x12345678' },
    { gas: '20999' }, { maxFeePerGas: '19999999999' }, { maxFeePerGas: '1000000000001' }, { maxPriorityFeePerGas: '21000000000' },
    { data: valid.data + '00' }, { password: 'must-never-enter-the-api' }, { rpcUrl: 'https://example.com' },
  ]) assert.throws(() => inspectRequest({ ...valid, ...changed }, account));
  assert.equal(inspectRequest({ ...deploy(), mode: 'mainnet' }, account).kind, 'deploy');
  assert.throws(() => inspectRequest({ ...deploy(), mode: 'mainnet', value: '1' }, account));
  assert.throws(() => inspectRequest({ ...deploy(), data: artifact.bytecode + '00' }, account));
});

test('independent validation rejects wrong chains, code, nonce, balance, gas and expired confirmations', async () => {
  const { intent } = await envelope(payment());
  for (const changed of [{ nonce: 99 }, { expiresAt: Date.now() - 1 }, { expiresAt: Date.now() + 11 * 60_000 }, { extra: true }]) await assert.rejects(validateIntent({ ...intent, ...changed }, account, client));
  for (const changed of [
    { getChainId: async () => 1 }, { getCode: async () => '0x00' }, { getBalance: async () => 0n }, { estimateGas: async () => 5_000_001n },
  ]) await assert.rejects(validateIntent(intent, account, { ...client, ...changed }));
  const payload = await envelope(payment());
  await assert.rejects(signAndSubmit({ ...payload, summary: payload.summary.replace('USDC', 'wrong') }, { file, client }));
  assert.equal((await client.getTransactionCount({ address: account })), 0);
  assert.equal(publicFailure(new Error('secret-sentinel')).message.includes('secret-sentinel'), false);
});

test('mainnet approval identifies real funds, network 5042, and the five-USDC cumulative limit', () => {
  const details = inspectRequest({ ...deploy(), mode: 'mainnet' }, account);
  const text = approvalText({ nonce: 0, expiresAt: Date.now() + 60000 }, details);
  assert.match(text, /部署同账主网合约/);
  assert.match(text, /真实资金.*5042/);
  assert.match(text, /累计预算上限：5 USDC/);
  assert.doesNotMatch(text, /测试币/);
});

test('mainnet budget includes unresolved signed reservations and rejects missing or tampered costs', async () => {
  const details = inspectRequest({ ...deploy(), mode: 'mainnet' }, account);
  const path = join(directory, `nonce-mainnet-${account.toLowerCase()}-0.public.json`);
  assert.equal((await checkMainnetBudget(file, details)).remaining, 5n * 10n ** 18n);
  try {
    await writeFile(path, JSON.stringify({ hash: `0x${'1'.repeat(64)}`, reservedCostWei: '4980000000000000000' }));
    assert.equal((await checkMainnetBudget(file, details)).remaining, 20_000_000_000_000_000n);
    await writeFile(path, JSON.stringify({ reservedCostWei: '4980000000000000001' }));
    await assert.rejects(checkMainnetBudget(file, details), /超过授权的 5 USDC/);
    await writeFile(path, JSON.stringify({ hash: `0x${'1'.repeat(64)}` }));
    await assert.rejects(checkMainnetBudget(file, details));
    await writeFile(path, JSON.stringify({ reservedCostWei: '-1' }));
    await assert.rejects(checkMainnetBudget(file, details));
    await checkMainnetBudget(file, inspectRequest(deploy(), account));
  } finally { await unlink(path); }
});

test('chain-5042 signing deploys and pays only on an isolated EVM, with cumulative reservations and idempotent recovery', async () => {
  const simulation = await network.connect('localArcMainnet');
  const ephemeral = join(directory, 'mainnet-simulation-wallet.json');
  const owner = (await createLocalWallet(ephemeral, password)).address;
  const rpc = createPublicClient({ chain: arc, transport: custom(simulation.provider) });
  const testWallet = createWalletClient({ chain: arc, transport: custom(simulation.provider) });
  const recipient = (await testWallet.getAddresses())[1];
  try {
    await simulation.provider.request({ method: 'hardhat_setBalance', params: [owner, '0x4563918244f40000'] });
    const deployment = { mode: 'mainnet', account: owner, data: artifact.bytecode, value: '0', ...fees };
    const deployed = await signAndSubmit(await envelope(deployment, rpc, owner), { file: ephemeral, client: rpc });
    const deployedReceipt = await rpc.waitForTransactionReceipt({ hash: deployed.hash });
    assert.equal(deployedReceipt.status, 'success');
    assert.equal((await rpc.getTransaction({ hash: deployed.hash })).chainId, 5042);
    const address = deployedReceipt.contractAddress;
    const before = await rpc.getBalance({ address: recipient });
    const id = keccak256(toHex('isolated-mainnet-budget-test'));
    const request = { mode: 'mainnet', account: owner, to: address, value: '10000000000000000', data: encodeFunctionData({ abi: artifact.abi, functionName: 'split', args: [[owner, recipient], [7_000_000_000_000_000n, 3_000_000_000_000_000n], id, 'isolated simulation'] }), ...fees };
    const payload = await envelope(request, rpc, owner);
    const paid = await signAndSubmit(payload, { file: ephemeral, client: rpc });
    const receipt = await rpc.waitForTransactionReceipt({ hash: paid.hash });
    verifyReceipt(receipt, { account: owner, contract: address, referenceId: id, note: 'isolated simulation', plan: { total: 10000n, payouts: [{ address: owner, nativeAmount: 7_000_000_000_000_000n }, { address: recipient, nativeAmount: 3_000_000_000_000_000n }] } });
    assert.equal(await rpc.getBalance({ address: recipient }) - before, 3_000_000_000_000_000n);
    const details = inspectRequest(request, owner);
    assert.equal((await checkMainnetBudget(ephemeral, details)).reserved, 50_000_000_000_000_000n);
    assert.equal((await signAndSubmit(payload, { file: ephemeral, client: rpc })).hash, paid.hash);
    assert.equal((await checkMainnetBudget(ephemeral, details)).reserved, 50_000_000_000_000_000n);
    assert.equal(await rpc.getTransactionCount({ address: owner }), 2);
  } finally { await simulation.close(); }
});

test('an ephemeral encrypted wallet signs a real simulated-chain deployment and recovers the same hash', async () => {
  const payload = await envelope(deploy());
  const result = await signAndSubmit(payload, { file, client });
  assert.equal(result.submitted, true);
  const receipt = await client.waitForTransactionReceipt({ hash: result.hash });
  assert.equal(receipt.status, 'success');
  assert.equal((await client.getCode({ address: receipt.contractAddress })).toLowerCase(), artifact.deployedBytecode.toLowerCase());
  assert.equal((await signAndSubmit(payload, { file, client })).hash, result.hash);
  assert.equal((await client.getTransactionCount({ address: account })), 1);
  assert.equal(JSON.stringify(result).includes(password), false);
});

test('local signed split pays exact recipients; retry never signs or pays again', async () => {
  const input = payment();
  const before = await Promise.all(recipients.map(address => client.getBalance({ address })));
  const result = await signAndSubmit(await envelope(input), { file, client });
  const receipt = await client.waitForTransactionReceipt({ hash: result.hash });
  verifyReceipt(receipt, { account, contract, referenceId: keccak256(toHex('test-local-signing')), note: '本机钱包测试', plan: { total: 1_000_000n, payouts: recipients.map((address, i) => ({ address, nativeAmount: [700_000_000_000_000_000n, 300_000_000_000_000_000n][i] })) } });
  for (let i = 0; i < 2; i++) assert.equal((await client.getBalance({ address: recipients[i] })) - before[i], [700_000_000_000_000_000n, 300_000_000_000_000_000n][i]);
  assert.equal((await readSigned(file, inspectRequest(input, account))).hash, result.hash);
  await assert.rejects(readSigned(file, inspectRequest({ ...input, data: input.data.replace(Buffer.from('本机钱包测试').toString('hex'), Buffer.from('本机钱包试验').toString('hex')) }, account)));
});

test('an uncertain broadcast preserves its public hash and blocks another intent using that nonce', async () => {
  const payload = await envelope(payment('ambiguous-broadcast'));
  let submissions = 0;
  const failing = { ...client, sendRawTransaction: async () => { submissions++; throw new Error('offline'); } };
  const result = await signAndSubmit(payload, { file, client: failing });
  assert.equal(result.submitted, false);
  assert.equal((await signAndSubmit(payload, { file, client: failing })).hash, result.hash);
  assert.equal(submissions, 1);
  await assert.rejects(signAndSubmit(await envelope(payment('must-not-replace')), { file, client: failing }));
  assert.equal(submissions, 1);
});

test('loopback bridge enforces Host, Origin, cookie, JSON, custom header and same-origin fetch', async () => {
  let approvals = 0;
  let onApprove = async payload => {
    assert.match(payload.summary, /网络费用上限/);
    for (const recipient of recipients) assert.ok(payload.summary.includes(recipient));
    throw new LocalSigningError('用户取消', 4001);
  };
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><head></head><body>Local bridge test fixture</body></html>');
  server = createLocalServer({ dist: directory, file, getClient: () => client, approve: payload => { approvals++; return onApprove(payload); } });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const root = await fetch(origin);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /name="arc-local-wallet"/);
  const cookie = root.headers.get('set-cookie').split(';')[0];
  const headers = { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'X-Arc-Local': '1' };
  const call = (path, body, changed = {}) => fetch(origin + path, { method: 'POST', headers: { ...headers, ...changed }, body: JSON.stringify(body) });
  const status = await call('/api/local/status', {});
  assert.deepEqual(await status.json(), { ok: true, address: account, encrypted: true });
  for (const changed of [{ Origin: 'https://evil.example' }, { Cookie: '' }, { 'X-Arc-Local': '' }, { 'Content-Type': 'text/plain' }, { 'Sec-Fetch-Site': 'same-site' }, { Origin: 'null' }]) assert.equal((await call('/api/local/status', {}, changed)).status, 403, JSON.stringify(changed));
  const hostStatus = await new Promise((resolve, reject) => {
    const request = httpRequest(origin, { headers: { Host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); });
    request.on('error', reject); request.end();
  });
  assert.equal(hostStatus, 403);
  assert.equal((await fetch(origin + '/api/local/status')).status, 403);
  assert.equal((await call('/api/local/transaction', { ...payment(), value: '1' })).status, 400);
  assert.equal((await call('/api/local/signMessage', {})).status, 404);
  const recovered = await (await call('/api/local/transaction', deploy())).json();
  assert.equal(recovered.recovered, true);
  assert.equal(approvals, 0);
  const cancelled = await (await call('/api/local/transaction', payment('native-cancel'))).json();
  assert.equal(cancelled.code, 4001);
  let release;
  onApprove = () => new Promise((resolve, reject) => { release = () => reject(new LocalSigningError('用户取消', 4001)); });
  const waiting = call('/api/local/transaction', payment('native-wait'));
  while (!release) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal((await call('/api/local/transaction', payment('second-window'))).status, 409);
  release(); await waiting;
  assert.equal(approvals, 2);
  assert.equal((await fetch(origin + '/scripts/local-wallet.mjs')).status, 404);
  assert.equal((await fetch(origin + '/wallet-v3.json')).status, 404);
});
