import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, keccak256, toHex } from 'viem';
import { connect, send, isUserRejection } from '../src/wallet.js';
import { inspectRequest } from '../scripts/local-signing.mjs';
import artifact from '../src/artifact.json' with { type: 'json' };

test('web client connects without an extension and sends only the exact public intent to the local bridge', async () => {
  const account = '0x4444444444444444444444444444444444444444';
  const contract = '0x5555555555555555555555555555555555555555';
  const args = [['0x6666666666666666666666666666666666666666', '0x7777777777777777777777777777777777777777'], [700_000_000_000_000_000n, 300_000_000_000_000_000n], keccak256(toHex('local-client')), '测试'];
  const request = { address: contract, abi: artifact.abi, functionName: 'split', args, value: 10n ** 18n, gas: 200000n, maxFeePerGas: 20_000_000_000n, maxPriorityFeePerGas: 0n };
  const saved = { document: globalThis.document, fetch: globalThis.fetch };
  const calls = [];
  let cancelled = false;
  globalThis.document = { querySelector: () => ({ content: 'enabled' }) };
  globalThis.fetch = async (path, options) => {
    calls.push({ path, options });
    return { ok: !cancelled || path.endsWith('/status'), json: async () => path.endsWith('/status') ? { ok: true, address: account } : cancelled ? { ok: false, code: 4001, message: '用户取消' } : { ok: true, hash: `0x${'a'.repeat(64)}` } };
  };
  try {
    assert.equal(await connect('testnet'), account);
    assert.equal(await send({ mode: 'testnet', account, request }), `0x${'a'.repeat(64)}`);
    const posted = calls.find(c => c.path.endsWith('/transaction'));
    assert.equal(posted.options.headers['X-Arc-Local'], '1');
    const intent = JSON.parse(posted.options.body);
    assert.equal(intent.data, encodeFunctionData({ abi: artifact.abi, functionName: 'split', args }));
    assert.equal(inspectRequest(intent, account).value, 10n ** 18n);
    assert.equal('password' in intent, false);
    cancelled = true;
    await assert.rejects(send({ mode: 'testnet', account, request }), isUserRejection);
  } finally {
    if (saved.document === undefined) delete globalThis.document; else globalThis.document = saved.document;
    globalThis.fetch = saved.fetch;
  }
});
