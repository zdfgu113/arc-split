import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, unlink, rmdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createLocalWallet, verifyLocalWallet, walletAddress } from '../scripts/local-wallet.mjs';

test('local wallet encrypts, restores the same address, rejects wrong passwords and cannot overwrite an existing wallet', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'arc-wallet-test-'));
  const file = join(directory, 'ephemeral-keystore.json');
  const altered = join(directory, 'altered.json');
  const password = 'ephemeral-test-password-only';
  try {
    const created = await createLocalWallet(file, password);
    assert.equal(created.verified, true);
    assert.match(created.address, /^0x[0-9a-fA-F]{40}$/);
    assert.equal('privateKey' in created, false);
    const raw = await readFile(file, 'utf8');
    const encrypted = JSON.parse(raw);
    assert.equal(encrypted.version, 3);
    assert.equal(raw.includes(password), false);
    const crypto = encrypted.crypto ?? encrypted.Crypto;
    assert.equal(crypto.kdf, 'scrypt');
    assert.equal((await verifyLocalWallet(file, password)).address, created.address);
    assert.equal((await walletAddress(file)).address, created.address);
    await assert.rejects(verifyLocalWallet(file, 'another-test-password'), error => error.code === 'unlock_failed');
    await assert.rejects(createLocalWallet(file, password), error => error.code === 'already_exists');
    assert.equal((await readFile(file, 'utf8')) === raw, true);
    encrypted.address = '0'.repeat(40);
    await writeFile(altered, JSON.stringify(encrypted));
    await assert.rejects(verifyLocalWallet(altered, password));
    crypto.kdfparams.n = 2 ** 30;
    await writeFile(altered, JSON.stringify(encrypted));
    await assert.rejects(walletAddress(altered), error => error.code === 'invalid_keystore');
  } finally {
    for (const name of [file, altered]) { try { await unlink(name); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    await rmdir(directory);
  }
});

test('a weak password is rejected before wallet creation', async () => {
  await assert.rejects(createLocalWallet(join(tmpdir(), 'not-created-arc-wallet.json'), 'short'), error => error.code === 'password_length');
});
