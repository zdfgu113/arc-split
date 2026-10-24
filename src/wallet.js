import { createPublicClient, createWalletClient, custom, http, isAddress, getAddress, parseEventLogs, encodeFunctionData } from 'viem';
import { arc, arcTestnet } from 'viem/chains';
import artifact from './artifact.json' with { type: 'json' };
import { NATIVE_PER_MICRO } from './split.js';

export const chains = { testnet: arcTestnet, mainnet: arc };
export const MAINNET_BUDGET_WEI = 5n * 10n ** 18n;
export const publicClient = mode => createPublicClient({ chain: chains[mode], transport: http(chains[mode].rpcUrls.default.http[0], { timeout: 15_000, retryCount: 1 }) });
export const localAvailable = () => typeof document !== 'undefined' && document.querySelector('meta[name="arc-local-wallet"]')?.content === 'enabled';
async function localRequest(path, body = {}) {
  const response = await fetch(`/api/local/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Arc-Local': '1' }, body: JSON.stringify(body), credentials: 'same-origin' });
  const result = await response.json();
  if (!response.ok || !result.ok) throw Object.assign(new Error(result.message ?? '本机钱包未响应，请保持本机应用运行。'), { code: result.code });
  return result;
}
function localTransaction(mode, account, request) {
  return localRequest('transaction', { mode, account, ...(request.address ? { to: request.address } : {}), data: request.data ?? encodeFunctionData(request), ...Object.fromEntries(['value', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas'].map(k => [k, (request[k] ?? 0n).toString()])) });
}
const provider = () => {
  if (!window.ethereum?.request) throw new Error('未检测到浏览器钱包。请使用安装了钱包扩展的浏览器。');
  return window.ethereum;
};

export async function connect(mode) {
  if (localAvailable()) return getAddress((await localRequest('status')).address);
  const chain = chains[mode];
  const wallet = provider();
  const accounts = await wallet.request({ method: 'eth_requestAccounts' });
  if (!accounts.length) throw new Error('钱包未提供账户。');
  const chainId = `0x${chain.id.toString(16)}`;
  try { await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] }); }
  catch (error) {
    if (error.code !== 4902) throw error;
    await wallet.request({ method: 'wallet_addEthereumChain', params: [{ chainId, chainName: chain.name, nativeCurrency: chain.nativeCurrency, rpcUrls: chain.rpcUrls.default.http, blockExplorerUrls: [chain.blockExplorers.default.url] }] });
    await wallet.request({ method: 'wallet_switchEthereumChain', params: [{ chainId }] });
  }
  const account = getAddress(accounts[0]);
  await assertWallet(mode, account);
  return account;
}

async function assertWallet(mode, account) {
  if (localAvailable()) {
    if (!Object.hasOwn(chains, mode) || getAddress((await localRequest('status')).address) !== account) throw new Error('本机钱包账户不符，请重新连接。');
    return;
  }
  const wallet = provider();
  const accounts = await wallet.request({ method: 'eth_accounts' });
  const chainId = await wallet.request({ method: 'eth_chainId' });
  if (!accounts[0] || getAddress(accounts[0]) !== account) throw new Error('钱包账户已变化，请重新连接并核对付款。');
  if (BigInt(chainId) !== BigInt(chains[mode].id)) throw new Error('钱包网络已变化，请重新连接到所选 Arc 网络。');
}

export async function checkContract(mode, address) {
  if (!isAddress(address)) throw new Error('请输入有效的合约地址。');
  const client = publicClient(mode);
  if (await client.getChainId() !== chains[mode].id) throw new Error('RPC 网络与所选网络不一致，已停止操作。');
  const code = await client.getCode({ address });
  if (!code || code.toLowerCase() !== artifact.deployedBytecode.toLowerCase()) throw new Error('该地址的代码与当前版本的同账合约不一致。请核对网络和部署版本。');
  return getAddress(address);
}

async function feeParameters(client) {
  const estimate = await client.estimateFeesPerGas();
  const floor = 20_000_000_000n;
  const maxFeePerGas = (estimate.maxFeePerGas ?? 0n) < floor ? floor : estimate.maxFeePerGas;
  const priority = estimate.maxPriorityFeePerGas ?? 0n;
  return { maxFeePerGas, maxPriorityFeePerGas: priority > maxFeePerGas ? maxFeePerGas : priority };
}

export async function prepare(mode, account, address, plan, referenceId, note) {
  await assertWallet(mode, account);
  const contract = await checkContract(mode, address);
  if (plan.payouts.some(p => getAddress(p.address) === contract)) throw new Error('分账合约自身不能作为收款人。');
  const client = publicClient(mode);
  const args = [plan.payouts.map(p => getAddress(p.address)), plan.payouts.map(p => p.nativeAmount), referenceId, note];
  const value = plan.total * NATIVE_PER_MICRO;
  const { request } = await client.simulateContract({ account, address: contract, abi: artifact.abi, functionName: 'split', args, value });
  const gas = (await client.estimateContractGas(request)) * 120n / 100n;
  const fees = await feeParameters(client);
  const maxFee = gas * fees.maxFeePerGas;
  if (mode === 'mainnet' && value + maxFee > MAINNET_BUDGET_WEI) throw new Error('本笔主网最高支出超过本次授权的 5 USDC 预算。');
  if (await client.getBalance({ address: account }) < value + maxFee) throw new Error('USDC 余额不足，需同时覆盖分账总额与网络费用。');
  const fromBlock = await client.getBlockNumber();
  return { mode, account, contract, referenceId, plan, note, fromBlock, request: { ...request, gas, ...fees }, maxFee };
}

export async function send(prepared) {
  await assertWallet(prepared.mode, prepared.account);
  if (localAvailable()) return (await localTransaction(prepared.mode, prepared.account, prepared.request)).hash;
  const client = createWalletClient({ chain: chains[prepared.mode], transport: custom(provider()) });
  return client.writeContract(prepared.request);
}

export function verifyReceipt(receipt, expected) {
  if (receipt.status !== 'success') throw new Error('交易已回滚，分账没有完成。');
  const events = parseEventLogs({ abi: artifact.abi, eventName: 'SplitPaid', logs: receipt.logs.filter(log => log.address.toLowerCase() === expected.contract.toLowerCase()) });
  const event = events.find(e => e.args.referenceId === expected.referenceId && e.args.payer.toLowerCase() === expected.account.toLowerCase());
  if (!event || event.args.total !== expected.plan.total * NATIVE_PER_MICRO || event.args.recipients.length !== expected.plan.payouts.length) throw new Error('交易未包含匹配的分账凭证，请在区块浏览器核查。');
  if (expected.note !== undefined && event.args.note !== expected.note) throw new Error('链上付款备注与预览不一致，请核查交易。');
  for (let i = 0; i < expected.plan.payouts.length; i++) {
    const payout = expected.plan.payouts[i];
    if (event.args.recipients[i].toLowerCase() !== payout.address.toLowerCase() || event.args.amounts[i] !== payout.nativeAmount) throw new Error('链上收款人与预览不一致，请核查交易。');
  }
  return receipt;
}

export async function waitForPayment(hash, expected) {
  const receipt = await publicClient(expected.mode).waitForTransactionReceipt({ hash, timeout: 90_000 });
  return verifyReceipt(receipt, expected);
}

export async function findPayment(entry) {
  const client = publicClient(entry.mode);
  let hash = entry.hash;
  if (!hash) {
    // An ambiguous wallet response stays blocked until a matching onchain event is found.
    const events = await client.getLogs({ address: entry.contract, event: artifact.abi.find(item => item.type === 'event' && item.name === 'SplitPaid'), args: { payer: entry.account, referenceId: entry.id }, fromBlock: BigInt(entry.fromBlock), toBlock: 'latest' });
    hash = events[0]?.transactionHash;
    if (!hash) throw new Error('尚未找到该付款编号的链上凭证。请先在钱包中核对，不要重复付款。');
  }
  return { hash, receipt: await client.getTransactionReceipt({ hash }) };
}

export async function deploy(mode, account, onSubmitted) {
  if (typeof mode !== 'string' || !Object.hasOwn(chains, mode)) throw new Error('请选择 Arc 测试网或主网。');
  await assertWallet(mode, account);
  const chain = chains[mode];
  const client = publicClient(mode);
  if (await client.getChainId() !== chain.id) throw new Error('部署 RPC 返回了错误的网络。');
  const balance = await client.getBalance({ address: account });
  if (balance === 0n) throw new Error(`${mode === 'testnet' ? '测试网' : '主网'} USDC 余额为零，请先确认正确网络的入金已到账。`);
  const fees = await feeParameters(client);
  const gas = (await client.estimateGas({ account, data: artifact.bytecode })) * 120n / 100n;
  const maxFee = gas * fees.maxFeePerGas;
  if (mode === 'mainnet' && maxFee > MAINNET_BUDGET_WEI) throw new Error('主网部署费用上限超过本次授权的 5 USDC 预算。');
  if (balance < maxFee) throw new Error(`${mode === 'testnet' ? '测试网' : '主网'} USDC 不足以支付部署费用。`);
  const hash = localAvailable()
    ? (await localTransaction(mode, account, { data: artifact.bytecode, gas, ...fees })).hash
    : await createWalletClient({ chain, transport: custom(provider()) }).deployContract({ account, abi: artifact.abi, bytecode: artifact.bytecode, gas, ...fees });
  onSubmitted(hash);
  const receipt = await client.waitForTransactionReceipt({ hash, timeout: 90_000 });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('合约部署未成功，请检查交易记录。');
  return checkContract(mode, receipt.contractAddress);
}

export const isUserRejection = error => error.code === 4001 || error.cause?.code === 4001 || /User rejected|User denied/i.test(error.message ?? '');

export function friendlyError(error) {
  if (isUserRejection(error)) return '你已取消钱包操作，没有继续发送交易。';
  return error.shortMessage ?? error.message ?? '操作未完成，请重试。';
}
