import { writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { formatUnits, getContractAddress, keccak256 } from 'viem';
import { publicClient, MAINNET_BUDGET_WEI } from '../src/wallet.js';
import { walletAddress } from './local-wallet.mjs';
import artifact from '../src/artifact.json' with { type: 'json' };

// Read-only estimate: the temporary balance override never changes the chain or unlocks the wallet.
const { address } = await walletAddress();
const client = publicClient('mainnet');
const chainId = await client.getChainId();
assert.equal(chainId, 5042);
const [balance, nonce, fees] = await Promise.all([
  client.getBalance({ address }),
  client.getTransactionCount({ address, blockTag: 'pending' }),
  client.estimateFeesPerGas(),
]);
const maxFeePerGas = (fees.maxFeePerGas ?? 0n) < 20_000_000_000n ? 20_000_000_000n : fees.maxFeePerGas;
const result = { network: 'Arc Mainnet', chainId, account: address, balanceUSDC: formatUnits(balance, 18), nonce, authorizedBudgetUSDC: '5', maxFeePerGasWei: maxFeePerGas.toString(), plannedSplitUSDC: '0.01', bytecodeHash: keccak256(artifact.bytecode), broadcast: false, signed: false, estimatedAt: new Date().toISOString() };
try {
  const estimate = await client.estimateGas({ account: address, data: artifact.bytecode, stateOverride: [{ address, balance: MAINNET_BUDGET_WEI }] });
  const gas = estimate * 120n / 100n;
  assert.ok(gas > 21000n && gas <= 5_000_000n);
  const maxFee = gas * maxFeePerGas;
  Object.assign(result, { estimateWithTemporaryBalanceOverride: true, deploymentGasWithMargin: gas.toString(), deploymentFeeUpperBoundUSDC: formatUnits(maxFee, 18), deploymentWithinBudget: maxFee <= MAINNET_BUDGET_WEI, predictedContract: getContractAddress({ from: address, nonce: BigInt(nonce) }) });
} catch {
  Object.assign(result, { estimateWithTemporaryBalanceOverride: false, deploymentFeeUpperBoundUSDC: null, note: 'RPC 未提供未入金账户的模拟报价；入金后须重新估算并由本人确认。' });
}
await writeFile(new URL('../docs/mainnet-preflight.json', import.meta.url), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify(result));
