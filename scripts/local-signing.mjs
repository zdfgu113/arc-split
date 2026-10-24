import { readFile, open, lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { decodeFunctionData, encodeFunctionData, formatUnits, getAddress, keccak256, toHex } from 'viem';
import { chains, publicClient, MAINNET_BUDGET_WEI } from '../src/wallet.js';
import artifact from '../src/artifact.json' with { type: 'json' };
import { NATIVE_PER_MICRO, SAMPLE_ADDRESSES } from '../src/split.js';
import { defaultKeystore, walletAddress, withLocalWallet } from './local-wallet.mjs';

export class LocalSigningError extends Error {
  constructor(message, code = 'local_signing_failed') { super(message); this.code = code; }
}
const stop = message => { throw new LocalSigningError(message); };
export const publicFailure = error => ({ ok: false, code: error instanceof LocalSigningError ? error.code : 'local_signing_failed', message: error instanceof LocalSigningError ? error.message : '本机钱包操作未完成，请核查网络、密码和交易记录；不要重复付款。' });
const fields = ['mode', 'account', 'to', 'data', 'value', 'gas', 'maxFeePerGas', 'maxPriorityFeePerGas'];
const integer = (value, name) => {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,77})$/.test(value)) stop(`${name}格式无效。`);
  return BigInt(value);
};

export function inspectRequest(input, address) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !fields.includes(k))) stop('交易字段不受支持。');
  if (typeof input.mode !== 'string' || !Object.hasOwn(chains, input.mode)) stop('只支持 Arc 测试网与主网。');
  if (input.account !== getAddress(address)) stop('付款账户与本机钱包不一致。');
  const { mode, account, data } = input;
  if (typeof data !== 'string' || !/^0x[0-9a-f]+$/i.test(data) || data.length > 24000 || data.length % 2) stop('交易数据格式无效。');
  const value = integer(input.value, '金额'), gas = integer(input.gas, 'Gas 数量'), maxFeePerGas = integer(input.maxFeePerGas, '费用上限'), maxPriorityFeePerGas = integer(input.maxPriorityFeePerGas, '优先费用');
  if (gas < 21000n || gas > 5_000_000n || maxFeePerGas < 20_000_000_000n || maxFeePerGas > 1_000_000_000_000n || maxPriorityFeePerGas > maxFeePerGas) stop('交易费用超出本机钱包支持范围。');
  let kind, to, referenceId, recipients = [], amounts = [], note = '';
  if (input.to == null) {
    if (value !== 0n || data.toLowerCase() !== artifact.bytecode.toLowerCase()) stop('只允许部署当前版本的同账合约，部署转入金额必须为零。');
    kind = 'deploy';
  } else {
    try { to = getAddress(input.to); } catch { stop('合约地址无效。'); }
    let decoded;
    try { decoded = decodeFunctionData({ abi: artifact.abi, data }); } catch { stop('只允许调用当前同账合约的分账功能。'); }
    if (decoded.functionName !== 'split' || encodeFunctionData({ abi: artifact.abi, ...decoded }).toLowerCase() !== data.toLowerCase()) stop('分账数据无效。');
    [recipients, amounts, referenceId, note] = decoded.args;
    if (recipients.length < 2 || recipients.length > 10 || recipients.length !== amounts.length || referenceId === `0x${'0'.repeat(64)}` || Buffer.byteLength(note, 'utf8') > 96) stop('分账人数、付款编号或备注不符合要求。');
    const seen = new Set();
    recipients.forEach((recipient, i) => {
      const lower = recipient.toLowerCase();
      if (lower === to.toLowerCase() || /^0x0{40}$/.test(lower) || seen.has(lower) || SAMPLE_ADDRESSES.some(a => a.toLowerCase() === lower) || amounts[i] <= 0n || amounts[i] % NATIVE_PER_MICRO) stop('收款地址或金额不符合要求。');
      seen.add(lower);
    });
    if (value <= 0n || value > 1_000_000_000n * 10n ** 18n || amounts.reduce((a, b) => a + b, 0n) !== value) stop('分账总额与收款明细不一致。');
    kind = 'split';
  }
  const fingerprint = keccak256(toHex(JSON.stringify([mode, account, to ?? null, data.toLowerCase(), value.toString()])));
  const id = keccak256(toHex(JSON.stringify([mode, account, kind, to ?? null, referenceId ?? keccak256(artifact.bytecode)])));
  return { mode, account, to, data, value, gas, maxFeePerGas, maxPriorityFeePerGas, kind, id, fingerprint, recipients, amounts, note };
}

export function approvalText(intent, details) {
  const fee = details.gas * details.maxFeePerGas;
  return [
    details.kind === 'deploy' ? `操作：部署同账${details.mode === 'mainnet' ? '主网' : '测试网'}合约` : '操作：USDC 团队分账',
    `网络：${details.mode === 'testnet' ? 'Arc 测试网 · 测试币' : 'Arc 主网 · 真实资金'}（${chains[details.mode].id}）`,
    `付款地址：${details.account}`,
    `合约地址：${details.to ?? '新建当前版本合约'}`,
    `付款总额：${formatUnits(details.value, 18)} USDC`,
    ...details.recipients.map((address, i) => `收款 ${i + 1}：${address}\n金额：${formatUnits(details.amounts[i], 18)} USDC`),
    `备注：${JSON.stringify(details.note)}`,
    `网络费用上限：${formatUnits(fee, 18)} USDC`,
    `总支出上限：${formatUnits(details.value + fee, 18)} USDC`,
    ...(details.mode === 'mainnet' ? ['本次本机签名累计预算上限：5 USDC；按每笔签名的最高支出保守预留，包含待核实交易。'] : []),
    `Gas 上限：${details.gas}；每 Gas 最高：${details.maxFeePerGas} wei`,
    `账户交易序号：${intent.nonce}`,
    `确认有效期至：${new Date(intent.expiresAt).toLocaleString('zh-CN', { hour12: false })}`,
    '请逐一核对完整地址。确认并输入密码后，本机会签名并提交这笔交易。',
  ].join('\n\n');
}

export async function validateIntent(intent, address, client = publicClient(intent?.mode)) {
  if (!intent || typeof intent !== 'object' || Object.keys(intent).some(k => ![...fields, 'nonce', 'expiresAt'].includes(k))) stop('交易确认内容无效。');
  const input = Object.fromEntries(fields.filter(k => Object.hasOwn(intent, k)).map(k => [k, intent[k]]));
  const details = inspectRequest(input, address);
  if (!Number.isSafeInteger(intent.nonce) || intent.nonce < 0 || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= Date.now() || intent.expiresAt > Date.now() + 10 * 60_000) stop('交易确认已过期或序号无效，请重新预览。');
  const tx = { account: address, to: details.to, data: details.data, value: details.value };
  if (await client.getChainId() !== chains[details.mode].id) stop('RPC 网络不符，已停止签名。');
  if (await client.getTransactionCount({ address, blockTag: 'pending' }) !== intent.nonce) stop('账户交易序号已变化，请核查之前的交易。');
  if (details.to && (await client.getCode({ address: details.to }))?.toLowerCase() !== artifact.deployedBytecode.toLowerCase()) stop('合约代码与当前版本不一致，已停止签名。');
  await client.call(tx);
  if (await client.estimateGas(tx) > details.gas) stop('Gas 上限不足，请重新预览。');
  if (await client.getBalance({ address }) < details.value + details.gas * details.maxFeePerGas) stop('USDC 余额不足，无法覆盖付款与费用。');
  return { details, summary: approvalText(intent, details) };
}

const journalPath = (file, id) => join(dirname(file), `signed-${id.slice(2)}.public.json`);
export async function checkMainnetBudget(file, details) {
  if (details.mode !== 'mainnet') return;
  const prefix = `nonce-mainnet-${details.account.toLowerCase()}-`;
  let reserved = 0n;
  for (const name of await readdir(dirname(file))) {
    if (!name.startsWith(prefix) || !/^\d+\.public\.json$/.test(name.slice(prefix.length))) continue;
    const path = join(dirname(file), name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 8192) stop('主网预算记录异常，请人工核查。');
    let entry;
    try { entry = JSON.parse(await readFile(path, 'utf8')); } catch { stop('主网预算记录异常，请人工核查。'); }
    const cost = integer(entry.reservedCostWei, '主网预算记录');
    if (cost <= 0n || cost > MAINNET_BUDGET_WEI) stop('主网预算记录异常，请人工核查。');
    reserved += cost;
  }
  if (reserved + details.value + details.gas * details.maxFeePerGas > MAINNET_BUDGET_WEI) stop('本次主网累计最高支出超过授权的 5 USDC，已停止签名。');
  return { reserved, remaining: MAINNET_BUDGET_WEI - reserved };
}

export async function readSigned(file, details) {
  const path = journalPath(file, details.id);
  let json;
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.size > 8192) stop('本机交易记录异常，请人工核查。');
    json = await readFile(path, 'utf8');
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let entry;
  try { entry = JSON.parse(json); } catch { stop('本机交易记录异常，请人工核查。'); }
  if (entry.fingerprint !== details.fingerprint || !/^0x[0-9a-f]{64}$/i.test(entry.hash ?? '')) stop('该付款编号已有其他交易，请人工核查，不能重复签名。');
  return { ok: true, hash: entry.hash, recovered: true };
}

export async function signAndSubmit({ intent, summary, password }, { file = defaultKeystore, client } = {}) {
  const { address } = await walletAddress(file);
  const details = inspectRequest(Object.fromEntries(fields.filter(k => Object.hasOwn(intent, k)).map(k => [k, intent[k]])), address);
  const previous = await readSigned(file, details);
  if (previous) return previous;
  client ??= publicClient(details.mode);
  const checked = await validateIntent(intent, address, client);
  await checkMainnetBudget(file, details);
  if (summary !== checked.summary) stop('交易内容与确认窗口不一致，已停止签名。');
  return withLocalWallet(file, password, async wallet => {
    if (wallet.address !== address) stop('本机钱包文件已变化，已停止签名。');
    // Recheck after decryption; neither a stale password window nor another transaction may change the nonce.
    if (intent.expiresAt <= Date.now() || await client.getTransactionCount({ address, blockTag: 'pending' }) !== intent.nonce) stop('交易确认已失效，请重新核查。');
    await checkMainnetBudget(file, details);
    const serializedTransaction = await wallet.signTransaction({ type: 2, chainId: chains[details.mode].id, nonce: intent.nonce, to: details.to, data: details.data, value: details.value, gasLimit: details.gas, maxFeePerGas: details.maxFeePerGas, maxPriorityFeePerGas: details.maxPriorityFeePerGas });
    const hash = keccak256(serializedTransaction);
    // Reserve this nonce even if broadcasting fails; another intent must not replace an unresolved signed payment.
    const guard = await open(join(dirname(file), `nonce-${details.mode}-${address.toLowerCase()}-${intent.nonce}.public.json`), 'wx', 0o600);
    try { await guard.writeFile(JSON.stringify({ hash, fingerprint: details.fingerprint, reservedCostWei: (details.value + details.gas * details.maxFeePerGas).toString() }) + '\n'); await guard.sync(); }
    finally { await guard.close(); }
    // Persist the public hash BEFORE broadcasting so an interrupted response cannot trigger another payment.
    const handle = await open(journalPath(file, details.id), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify({ hash, fingerprint: details.fingerprint, mode: details.mode, nonce: intent.nonce, createdAt: new Date().toISOString() }) + '\n'); await handle.sync(); }
    finally { await handle.close(); }
    try {
      const sent = await client.sendRawTransaction({ serializedTransaction });
      if (sent !== hash) stop('RPC 返回的交易编号不一致，请核查。');
      return { ok: true, hash, submitted: true };
    // shortcut: an unsubmitted signed transaction needs manual reconciliation; add protected raw-transaction recovery before unattended use.
    } catch { return { ok: true, hash, submitted: false, message: '已签名，提交结果待核查。请保留交易编号，不要重新付款。' }; }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) stop('请使用本机交易确认窗口。');
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (input.length > 65536) stop('输入过长。'); }
    const payload = JSON.parse(input); input = '';
    const result = await signAndSubmit(payload); payload.password = null;
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) { process.stdout.write(JSON.stringify(publicFailure(error)) + '\n'); process.exitCode = 1; }
}
