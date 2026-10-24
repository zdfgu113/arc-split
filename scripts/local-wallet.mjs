import { mkdir, open, readFile, lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Wallet, getAddress } from 'ethers';
import { generatePrivateKey } from 'viem/accounts';

export const defaultKeystore = join(homedir(), '.codex', 'secrets', 'arc-split', 'wallet-v3.json');

function fail(code, message) { return Object.assign(new Error(message), { code }); }
function checkPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 1024) throw fail('password_length', '密码需为 12–1024 个字符。');
}

async function readKeystore(file) {
  const stat = await lstat(file);
  if (!stat.isFile() || stat.size > 128 * 1024) throw fail('invalid_keystore', '钱包文件格式不符合要求。');
  const json = await readFile(file, 'utf8');
  let data;
  try { data = JSON.parse(json); } catch { throw fail('invalid_keystore', '钱包文件格式不符合要求。'); }
  const crypto = data.crypto ?? data.Crypto;
  const kdf = crypto?.kdfparams;
  if (data.version !== 3 || !/^[a-f0-9]{40}$/i.test(data.address ?? '') || crypto?.cipher !== 'aes-128-ctr' || crypto?.kdf !== 'scrypt' || !kdf || ![131072, 262144].includes(kdf.n) || kdf.r !== 8 || kdf.p !== 1 || kdf.dklen !== 32) throw fail('invalid_keystore', '不是此工具支持的标准加密钱包文件。');
  return { json, address: getAddress(`0x${data.address}`) };
}

export async function walletAddress(file = defaultKeystore) {
  const { address } = await readKeystore(file);
  return { address, keystorePath: resolve(file), encrypted: true, verified: false };
}

export async function verifyLocalWallet(file, password) {
  return withLocalWallet(file, password, restored => ({ address: restored.address, keystorePath: resolve(file), encrypted: true, verified: true }));
}

// Callers must return public results only; the signing process exits after each operation.
export async function withLocalWallet(file, password, action) {
  checkPassword(password);
  const { json, address } = await readKeystore(file);
  let restored;
  try { restored = await Wallet.fromEncryptedJson(json, password); }
  catch { throw fail('unlock_failed', '密码不正确，或钱包文件已损坏。'); }
  if (restored.address !== address) throw fail('address_mismatch', '解密后的地址与文件记录不一致。');
  return action(restored);
}

export async function createLocalWallet(file, password) {
  checkPassword(password);
  try { await lstat(file); throw fail('already_exists', '已有钱包文件，已停止创建，原文件不会覆盖。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  // The private key exists only in this short-lived, user-launched process.
  const wallet = new Wallet(generatePrivateKey());
  const json = await wallet.encrypt(password);
  const handle = await open(file, 'wx', 0o600);
  try { await handle.writeFile(json + '\n', 'utf8'); await handle.sync(); }
  finally { await handle.close(); }
  const result = await verifyLocalWallet(file, password);
  if (result.address !== wallet.address) throw fail('address_mismatch', '钱包地址校验未通过，请保留原文件检查。');
  return { ...result, format: 'Web3 Secret Storage v3', createdAt: new Date().toISOString() };
}

async function main() {
  const [command = 'address', target = defaultKeystore, ...extra] = process.argv.slice(2);
  if (extra.length || !['create', 'verify', 'address'].includes(command)) throw fail('invalid_command', '仅支持 create、verify 或 address；密码不能放在命令参数中。');
  if (command === 'address') return { ok: true, status: 'address', ...await walletAddress(target) };
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
    if (input.length > 8192) throw fail('invalid_input', '输入过长。');
  }
  let password;
  try { password = JSON.parse(input).password; } catch { throw fail('invalid_input', '请使用本机密码窗口操作。'); }
  input = '';
  const result = command === 'create' ? await createLocalWallet(target, password) : await verifyLocalWallet(target, password);
  password = null;
  return { ok: true, status: command === 'create' ? 'created' : 'verified', ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.stdout.write(JSON.stringify(await main()) + '\n'); }
  catch (error) {
    const known = ['password_length', 'invalid_keystore', 'unlock_failed', 'address_mismatch', 'already_exists', 'invalid_input', 'invalid_command'];
    const code = known.includes(error.code) ? error.code : error.code === 'EEXIST' ? 'already_exists' : 'operation_failed';
    const message = known.includes(error.code) ? error.message : '操作未完成；如已生成钱包文件，请保留原文件，不要覆盖。';
    // Never print library errors: crypto exceptions can contain sensitive arguments.
    process.stdout.write(JSON.stringify({ ok: false, code, message }) + '\n');
    process.exitCode = 1;
  }
}
