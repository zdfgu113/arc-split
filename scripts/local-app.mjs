import { createServer } from 'node:http';
import { readFile, lstat } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { walletAddress, defaultKeystore } from './local-wallet.mjs';
import { inspectRequest, validateIntent, readSigned, publicFailure, LocalSigningError, checkMainnetBudget } from './local-signing.mjs';
import { publicClient } from '../src/wallet.js';

const root = fileURLToPath(new URL('../dist/', import.meta.url));
const nativeScript = fileURLToPath(new URL('./Confirm-LocalTransaction.ps1', import.meta.url));
const powershell = join(homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'native', 'powershell', 'pwsh.exe');

export function nativeApproval(payload) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershell, ['-NoProfile', '-STA', '-File', nativeScript], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '';
    child.stderr.resume();
    child.stdout.on('data', chunk => { if (output.length <= 8192) output += chunk; });
    child.on('error', () => reject(new LocalSigningError('本机确认窗口未能启动，请检查 PowerShell。')));
    child.stdin.on('error', () => {});
    child.on('close', () => {
      let result;
      try { result = JSON.parse(output); } catch { reject(new LocalSigningError('确认窗口未返回完整结果，请核查本机交易记录；不要重复付款。')); return; }
      if (result.ok && /^0x[0-9a-f]{64}$/i.test(result.hash ?? '')) resolve({ hash: result.hash, submitted: result.submitted === true, recovered: result.recovered === true });
      else reject(new LocalSigningError(result.code === 4001 ? '你已取消本机钱包操作。' : '本机签名未完成，请核查交易记录与确认窗口。', result.code === 4001 ? 4001 : 'native_result_unknown'));
    });
    child.stdin.end(JSON.stringify(payload));
  });
}

async function readJson(request) {
  let length = 0, chunks = [];
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 32768) throw new LocalSigningError('请求过长。');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new LocalSigningError('请求格式无效。'); }
}

// Only this loopback origin can call the bridge; there is no generic RPC/sign-message endpoint.
export function createLocalServer({ dist = root, file = defaultKeystore, approve = nativeApproval, getClient = publicClient } = {}) {
  const token = randomBytes(32).toString('base64url');
  let signing = false;
  const server = createServer(async (request, response) => {
    const host = `127.0.0.1:${server.address().port}`, origin = `http://${host}`;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self' https://rpc.testnet.arc.io https://rpc.mainnet.arc.io; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    const json = (status, value) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); response.end(JSON.stringify(value)); };
    if (request.headers.host !== host || (request.headers.origin && request.headers.origin !== origin)) { json(403, { ok: false, message: '只允许本机同源访问。' }); return; }
    const url = request.url;
    if (url.startsWith('/api/')) {
      if (request.method !== 'POST' || request.headers.origin !== origin || ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site']) || request.headers['content-type'] !== 'application/json' || request.headers['x-arc-local'] !== '1' || !request.headers.cookie?.split(';').some(c => c.trim() === `arc_split_session=${token}`)) { json(403, { ok: false, message: '本机会话无效，请重新打开应用。' }); return; }
      try {
        if (!['/api/local/status', '/api/local/transaction'].includes(url)) { json(404, { ok: false }); return; }
        const input = await readJson(request);
        const { address } = await walletAddress(file);
        if (url === '/api/local/status') {
          if (!input || Object.keys(input).length) throw new LocalSigningError('状态请求无效。');
          json(200, { ok: true, address, encrypted: true }); return;
        }
        if (signing) { json(409, { ok: false, message: '已有本机确认窗口，请先完成或取消该操作。' }); return; }
        signing = true;
        try {
          const details = inspectRequest(input, address);
          const previous = await readSigned(file, details);
          if (previous) { json(200, previous); return; }
          const client = getClient(details.mode);
          const intent = { ...input, nonce: await client.getTransactionCount({ address, blockTag: 'pending' }), expiresAt: Date.now() + 10 * 60_000 };
          const { summary } = await validateIntent(intent, address, client);
          await checkMainnetBudget(file, details);
          const result = await approve({ intent, summary });
          json(200, { ok: true, ...result });
        } finally { signing = false; }
      } catch (error) { json(400, publicFailure(error)); }
      return;
    }
    if (request.method !== 'GET' || !(/^\/(?:assets\/[a-zA-Z0-9_.-]+\.(?:js|css)|favicon\.svg)?$/.test(url))) { json(404, { ok: false }); return; }
    try {
      const path = join(dist, url === '/' ? 'index.html' : url.slice(1));
      if (!(await lstat(path)).isFile()) throw new Error();
      let content = await readFile(path);
      const type = url === '/' ? 'text/html' : url.endsWith('.js') ? 'text/javascript' : url.endsWith('.css') ? 'text/css' : 'image/svg+xml';
      if (url === '/') {
        content = content.toString('utf8').replace('</head>', '<meta name="arc-local-wallet" content="enabled" /></head>');
        response.setHeader('Set-Cookie', `arc_split_session=${token}; HttpOnly; SameSite=Strict; Path=/`);
      }
      response.writeHead(200, { 'Content-Type': `${type}; charset=utf-8` }); response.end(content);
    } catch { json(404, { ok: false, message: '请先运行 npm run build 构建本地应用。' }); }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 2) throw new Error();
    await walletAddress();
    const server = createLocalServer();
    server.on('error', () => { process.stderr.write('本机应用未能启动，端口 5178 可能已被占用。\n'); process.exitCode = 1; });
    server.listen(5178, '127.0.0.1', () => {
      process.stdout.write('同账本机钱包应用：http://127.0.0.1:5178\n保持此进程运行；每笔交易另需本机窗口确认。\n');
      if (process.platform === 'win32') spawn('explorer.exe', ['http://127.0.0.1:5178'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    });
  } catch { process.stderr.write('未能读取本机加密钱包；请先创建或验证已有钱包。\n'); process.exitCode = 1; }
}
