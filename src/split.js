import { isAddress, getAddress } from 'viem';

export const MICRO = 1_000_000n;
export const NATIVE_PER_MICRO = 1_000_000_000_000n;
export const SAMPLE_ADDRESSES = ['0x1111111111111111111111111111111111111111', '0x2222222222222222222222222222222222222222', '0x3333333333333333333333333333333333333333'];

function decimalUnits(text, decimals) {
  const raw = String(text).trim();
  if (raw.length > 32) throw new Error('数字过长，请缩短输入。');
  if (!new RegExp(`^\\d+(?:\\.\\d{1,${decimals}})?$`).test(raw)) throw new Error(`请输入有效数字，最多 ${decimals} 位小数。`);
  const [whole, fraction = ''] = raw.split('.');
  return BigInt(whole) * 10n ** BigInt(decimals) + BigInt(fraction.padEnd(decimals, '0'));
}

export function amountUnits(text) {
  const value = decimalUnits(text, 6);
  if (value <= 0n || value > 1_000_000_000n * MICRO) throw new Error('分账总额须大于 0，且不超过 10 亿 USDC。');
  return value;
}

export function percentageUnits(text) {
  const value = decimalUnits(text, 2);
  if (value <= 0n || value > 10_000n) throw new Error('每位成员的比例须大于 0，且不超过 100%。');
  return value;
}

export function makeSplit(amount, members, { live = false, note = '' } = {}) {
  const total = amountUnits(amount);
  if (members.length < 2 || members.length > 10) throw new Error('请设置 2–10 位收款成员。');
  if (new TextEncoder().encode(note).length > 96) throw new Error('备注过长，请缩短至 96 字节以内（约 32 个汉字）。');
  const weights = members.map(m => percentageUnits(m.percent));
  if (weights.reduce((a, b) => a + b, 0n) !== 10_000n) throw new Error('分账比例合计必须恰好为 100%。');
  if (live) {
    const addresses = members.map(m => {
      if (!isAddress(m.address) || /^0x0{40}$/i.test(m.address)) throw new Error('请为每位成员填写有效的钱包地址。');
      if (SAMPLE_ADDRESSES.includes(m.address.toLowerCase())) throw new Error('请将演示地址替换为真实收款地址。');
      return getAddress(m.address);
    });
    if (new Set(addresses).size !== addresses.length) throw new Error('收款地址不能重复。');
  }
  const amounts = weights.map(w => total * w / 10_000n);
  let remainder = total - amounts.reduce((a, b) => a + b, 0n);
  // Give leftover micro-USDC to the largest fractions, with stable input-order ties.
  const order = weights.map((w, i) => ({ i, fraction: total * w % 10_000n })).sort((a, b) => a.fraction === b.fraction ? a.i - b.i : a.fraction > b.fraction ? -1 : 1);
  for (const { i } of order) { if (remainder === 0n) break; amounts[i]++; remainder--; }
  if (amounts.some(a => a === 0n)) throw new Error('总额太小，至少有一位成员不足 0.000001 USDC。');
  return { total, payouts: members.map((m, i) => ({ ...m, amount: amounts[i], nativeAmount: amounts[i] * NATIVE_PER_MICRO })) };
}

export function formatAmount(micro, minimumFractionDigits = 2) {
  return new Intl.NumberFormat('zh-CN', { minimumFractionDigits, maximumFractionDigits: 6 }).format(Number(micro) / 1_000_000);
}

export function csvCell(value) {
  let text = String(value);
  if (/^[\s]*[=+@-]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
