import { test } from 'node:test';
import assert from 'node:assert/strict';
import { amountUnits, percentageUnits, makeSplit, csvCell, escapeHtml } from '../src/split.js';

const members = percents => percents.map((percent, i) => ({ name: `member ${i}`, address: `0x${String(i + 5).repeat(40)}`, percent }));
test('70/30 conserves a ten-USDC payment and native precision', () => {
  const split = makeSplit('10', members(['70', '30']));
  assert.deepEqual(split.payouts.map(p => p.amount), [7_000_000n, 3_000_000n]);
  assert.equal(split.payouts[0].nativeAmount, 7_000_000_000_000_000_000n);
});
test('fractional micro-USDC is allocated by largest remainder with stable ties', () => {
  assert.deepEqual(makeSplit('0.000005', members(['33.33', '33.33', '33.34'])).payouts.map(p => p.amount), [2n, 1n, 2n]);
  assert.deepEqual(makeSplit('0.000003', members(['50', '50'])).payouts.map(p => p.amount), [2n, 1n]);
});
test('allocation always conserves the amount for many small boundary totals', () => {
  for (let i = 3; i < 1000; i++) {
    const split = makeSplit(`0.${String(i).padStart(6, '0')}`, members(['33.33', '33.33', '33.34']));
    assert.equal(split.payouts.reduce((a, p) => a + p.amount, 0n), BigInt(i));
    assert.ok(split.payouts.every(p => p.amount > 0n));
  }
});
test('rejects invalid, scientific, negative and excess-precision amounts', () => {
  for (const value of ['0', '-1', '1e6', '1.0000001', 'Infinity', '', '1,000', '1000000001']) assert.throws(() => amountUnits(value));
  assert.equal(amountUnits('0.000001'), 1n);
  assert.equal(amountUnits('0001.2'), 1_200_000n);
});
test('enforces exact 100 percent, 2-10 recipients, nonzero payouts and note byte limit', () => {
  assert.throws(() => makeSplit('10', members(['70', '29.99'])));
  assert.throws(() => makeSplit('10', members(['100'])));
  assert.throws(() => makeSplit('10', members(Array(11).fill('10'))));
  assert.throws(() => makeSplit('0.000001', members(['50', '50'])));
  assert.throws(() => percentageUnits('0'));
  assert.throws(() => percentageUnits('0.001'));
  assert.throws(() => makeSplit('10', members(['50', '50']), { note: '中'.repeat(33) }));
});
test('live mode rejects zero, invalid, sample and duplicate recipient addresses', () => {
  for (const bad of ['', '0x123', '0x' + '0'.repeat(40), '0x' + '1'.repeat(40)]) {
    const rows = members(['70', '30']); rows[0].address = bad;
    assert.throws(() => makeSplit('10', rows, { live: true }));
  }
  const rows = members(['70', '30']); rows[1].address = rows[0].address;
  assert.throws(() => makeSplit('10', rows, { live: true }));
  assert.doesNotThrow(() => makeSplit('10', members(['70', '30']), { live: true }));
});
test('CSV prevents formula injection and HTML output escapes user text', () => {
  assert.equal(csvCell('=SUM(A1)'), '"\'=SUM(A1)"');
  assert.equal(csvCell('a,"b'), '"a,""b"');
  assert.equal(escapeHtml('<img src=x onerror="x">'), '&lt;img src=x onerror=&quot;x&quot;&gt;');
});
