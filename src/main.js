import './style.css';
import { keccak256, toHex, formatUnits } from 'viem';
import { makeSplit, formatAmount, csvCell, escapeHtml as esc, SAMPLE_ADDRESSES } from './split.js';
import * as wallet from './wallet.js';

const $ = selector => document.querySelector(selector);
const colors = ['#a8bc8b', '#c6d4b2', '#e0e7d4', '#c7c9ae', '#b6c6b7', '#e4d9c2', '#c3d8c4', '#d9c6b2', '#bac8d4', '#d8d0df'];
const readStore = (key, fallback) => { try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; } };
const store = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch { toast('浏览器存储不可用，本次记录可能无法保留。'); } };
let history = readStore('arc-split-history-v1', []);
history = Array.isArray(history) ? history.filter(r => r && ['demo', 'testnet', 'mainnet'].includes(r.mode) && ['success', 'pending', 'failed'].includes(r.status) && typeof r.note === 'string' && typeof r.total === 'string' && /^\d{1,16}$/.test(r.total) && typeof r.id === 'string' && typeof r.date === 'string' && Array.isArray(r.payouts) && r.payouts.length <= 10).slice(0, 50) : [];
let contracts = readStore('arc-split-contracts-v1', {});
if (!contracts || typeof contracts !== 'object') contracts = {};
let mode = 'demo';
let account = null;
let members = [];
let prepared = null;
let busy = false;
let toastTimer;

function toast(message) { $('#toast').textContent = message; $('#toast').classList.add('visible'); clearTimeout(toastTimer); toastTimer = setTimeout(() => $('#toast').classList.remove('visible'), 5500); }
async function refreshLocalBalance() {
  if (!wallet.localAvailable() || !account || mode === 'demo') return;
  const address = account, network = mode;
  $('#local-wallet-balance').textContent = '正在查询余额……';
  try {
    const balance = await wallet.publicClient(network).getBalance({ address });
    if (account === address && mode === network) $('#local-wallet-balance').textContent = `${network === 'testnet' ? '测试网' : '主网'}余额：${formatUnits(balance, 18)} USDC`;
  } catch { if (account === address && mode === network) $('#local-wallet-balance').textContent = '余额暂未取得，请检查网络后重新连接。'; }
}
function setBusy(value) {
  busy = value;
  document.querySelectorAll('button, select, input').forEach(el => { if (!el.closest('form[method="dialog"]')) el.disabled = value; });
  if (!value) { refresh(); document.querySelectorAll('.remove-member').forEach(el => { el.disabled = members.length <= 2; }); }
}
function currentPlan() { return makeSplit($('#amount').value, members, { live: mode !== 'demo', note: $('#note').value.trim() }); }
const pendingPayment = () => history.find(r => r.mode === mode && r.status === 'pending');

function renderMembers() {
  $('#members').innerHTML = members.map((m, i) => `<div class="member-row" data-index="${i}"><span class="avatar" style="--member-bg:${colors[i]};--member-color:#4c6544" aria-hidden="true">${esc(m.name.slice(0, 1) || String(i + 1))}</span><div class="member-fields"><label class="sr-only" for="name-${i}">第 ${i + 1} 位成员名称</label><input id="name-${i}" class="member-name" data-field="name" maxlength="20" value="${esc(m.name)}" placeholder="成员名称" /><label class="sr-only" for="address-${i}">第 ${i + 1} 位收款地址</label><input id="address-${i}" class="member-address" data-field="address" value="${esc(m.address)}" placeholder="收款钱包地址 0x…" spellcheck="false" autocomplete="off" /></div><label class="percent-field"><span class="sr-only">第 ${i + 1} 位成员分账比例</span><input data-field="percent" inputmode="decimal" value="${esc(m.percent)}" aria-label="第 ${i + 1} 位成员分账比例" /><span aria-hidden="true">%</span></label><button class="remove-member" data-remove="${i}" aria-label="移除第 ${i + 1} 位成员" ${members.length <= 2 ? 'disabled' : ''}>×</button></div>`).join('');
}

function refresh() {
  let plan;
  let error = '';
  try { plan = currentPlan(); } catch (e) { error = e.message; }
  $('#receipt-note').textContent = $('#note').value.trim() || '未命名分账';
  $('#member-counter').textContent = `${members.length} 位成员`;
  $('#receipt-total').textContent = plan ? formatAmount(plan.total) : '—';
  $('#receipt-sum').textContent = plan ? `${formatAmount(plan.total)} USDC` : '—';
  const percentSum = members.reduce((sum, m) => sum + (Number(m.percent) || 0), 0);
  $('#total-percent').textContent = `比例合计 ${Number(percentSum.toFixed(2))}%`;
  $('#total-percent').classList.toggle('invalid', Math.abs(percentSum - 100) > .00001);
  $('#split-bar').innerHTML = members.map((m, i) => `<span style="background:${colors[i]};flex:${Number(m.percent) > 0 ? Math.min(100, Number(m.percent)) : 0}"></span>`).join('');
  $('#receipt-members').innerHTML = members.map((m, i) => `<div class="payout-row"><span class="payout-dot" style="background:${colors[i]}"></span><div class="payout-name">${esc(m.name || `成员 ${i + 1}`)}<span class="payout-percent">${esc(m.percent)}%</span></div><span class="payout-amount">${plan ? formatAmount(plan.payouts[i].amount) : '—'}<small>USDC</small></span></div>`).join('');
  $('#validation-error').textContent = error;
  const pending = pendingPayment();
  $('#review-button').disabled = busy || Boolean(error) || Boolean(pending);
  $('#review-button').innerHTML = `${pending ? '上一笔付款等待核查' : mode === 'demo' ? '预览这笔分账' : '核对并准备付款'} <span aria-hidden="true">↗</span>`;
  $('#export-button').disabled = busy || !plan;
  $('#add-member').disabled = busy || members.length >= 10;
  $('#receipt-network').textContent = mode === 'demo' ? '仅演示 · 不发送资产' : wallet.chains[mode].name;
  $('#payment-help').textContent = pending ? '请在付款记录中检查上一笔交易，避免重复付款。' : mode === 'demo' ? '先看清明细，再决定付款。' : contracts[mode] ? '先模拟验证，确认后由钱包请求你签名。' : '真实付款前，请在「合约设置」中配置合约。';
  $('#wallet-button').innerHTML = account ? `${wallet.localAvailable() ? '本机 · ' : ''}${account.slice(0, 6)}…${account.slice(-4)}` : `${wallet.localAvailable() ? '连接本机钱包' : '连接钱包'} <span aria-hidden="true">↗</span>`;
}

function renderHistory() {
  $('#history-count').textContent = String(history.length);
  $('#history-items').innerHTML = history.length ? history.map(r => `<article class="history-row"><span class="history-icon" aria-hidden="true">${r.status === 'success' ? '✓' : r.status === 'failed' ? '×' : '◷'}</span><div><strong>${esc(r.note || '未命名分账')}</strong><p>${new Date(r.date).toLocaleString('zh-CN', { hour12: false })} · ${r.payouts.length} 位成员${r.mode === 'demo' ? ' · 演示记录' : ''}</p>${r.mode !== 'demo' && /^0x[0-9a-f]{64}$/i.test(r.hash ?? '') ? `<a href="${wallet.chains[r.mode].blockExplorers.default.url}/tx/${r.hash}" target="_blank" rel="noopener noreferrer">查看链上交易 ↗</a>` : ''}${r.mode !== 'demo' && r.status === 'pending' ? `<button class="text-button" data-check="${esc(r.id)}">检查确认状态</button>` : ''}</div><div class="history-value"><strong>${formatAmount(BigInt(r.total))} <small>USDC</small></strong><span>${r.mode === 'demo' ? '仅演示，未付款' : r.status === 'success' ? '链上分账已核实' : r.status === 'failed' ? '交易回滚，未完成' : r.hash ? '已提交，尚未确认' : '钱包付款状态待核查'}</span></div></article>`).join('') : '<div class="empty-history"><span aria-hidden="true">▤</span><div>还没有付款记录。<br />完成第一笔分账后，明细会出现在这里。</div></div>';
}

function saveHistory() { store('arc-split-history-v1', history); renderHistory(); refresh(); }
function sample() {
  members = ['设计与产品', '开发交付', '协作支持'].map((name, i) => ({ name, address: mode === 'demo' ? SAMPLE_ADDRESSES[i] : '', percent: ['60', '25', '15'][i] }));
  $('#amount').value = mode === 'demo' ? '1000' : '1';
  $('#note').value = '十月项目结算'; prepared = null; renderMembers(); refresh();
}
function record(plan, id, status, hash) {
  return { id, mode, status, hash, account, contract: contracts[mode] ?? null, note: $('#note').value.trim(), total: plan.total.toString(), date: new Date().toISOString(), payouts: plan.payouts.map(p => ({ name: p.name, address: p.address, percent: p.percent, amount: p.amount.toString(), nativeAmount: p.nativeAmount.toString() })) };
}
function expectedFrom(record) {
  return { mode: record.mode, account: record.account, contract: record.contract, referenceId: record.id, note: record.note, plan: { total: BigInt(record.total), payouts: record.payouts.map(p => ({ ...p, nativeAmount: BigInt(p.nativeAmount) })) } };
}

$('#members').addEventListener('input', event => {
  const row = event.target.closest('[data-index]'); if (!row || !event.target.dataset.field) return;
  members[Number(row.dataset.index)][event.target.dataset.field] = event.target.value;
  if (event.target.dataset.field === 'name') row.querySelector('.avatar').textContent = event.target.value.slice(0, 1) || '?';
  prepared = null; refresh();
});
$('#members').addEventListener('click', event => { const button = event.target.closest('[data-remove]'); if (button && members.length > 2) { members.splice(Number(button.dataset.remove), 1); prepared = null; renderMembers(); refresh(); } });
$('#add-member').addEventListener('click', () => { if (members.length < 10) { members.push({ name: `成员 ${members.length + 1}`, address: '', percent: '' }); prepared = null; renderMembers(); refresh(); $(`#name-${members.length - 1}`).focus(); } });
$('#amount').addEventListener('input', () => { prepared = null; refresh(); });
$('#note').addEventListener('input', () => { prepared = null; refresh(); });
$('#sample-button').addEventListener('click', () => { sample(); toast(mode === 'demo' ? '示例已加载，可以直接调整金额和比例。' : '示例比例已加载，请填写真实收款地址。'); });
$('#mode').addEventListener('change', () => {
  $('#review-dialog').close();
  $('#settings-dialog').close();
  mode = $('#mode').value; account = null; prepared = null;
  $('#local-wallet-details').hidden = true;
  $('#mode-notice').innerHTML = `<span class="notice-icon" aria-hidden="true">i</span><span>${mode === 'demo' ? '正在体验演示模式，不会连接钱包或发送真实资产。' : mode === 'testnet' ? '当前是 Arc 测试网。使用测试币，不具备真实货币价值。' : '当前是 Arc 主网。付款会消耗真实 USDC，并且无法撤回。'}</span>`;
  sample();
});
$('#wallet-button').addEventListener('click', async () => {
  if (mode === 'demo') { toast('演示模式不需要钱包。请先选择 Arc 测试网体验真实流程。'); return; }
  setBusy(true);
  try {
    account = await wallet.connect(mode);
    toast(wallet.localAvailable() ? '本机钱包已连接，尚未解锁或签名。' : '钱包已连接，请核对收款人并配置合约。');
    if (wallet.localAvailable()) {
      $('#local-wallet-details').hidden = false;
      $('#local-wallet-address').textContent = account;
      $('#testnet-faucet').hidden = mode !== 'testnet';
      await refreshLocalBalance();
    }
  } catch (e) { toast(wallet.friendlyError(e)); } finally { setBusy(false); }
});
$('#copy-local-address').addEventListener('click', async () => {
  if (!account) return;
  try { await navigator.clipboard.writeText(account); toast('公开收款地址已复制。'); }
  catch { toast('未能复制，请选中上方完整地址并手动复制。'); }
});

$('#review-button').addEventListener('click', async () => {
  setBusy(true);
  try {
    const plan = currentPlan();
    if (mode !== 'demo') {
      if (!account) throw new Error('请先连接钱包。');
      if (!contracts[mode]) { $('#settings-dialog').showModal(); throw new Error('请先配置所选网络的分账合约。'); }
      const referenceId = keccak256(toHex(crypto.randomUUID()));
      prepared = await wallet.prepare(mode, account, contracts[mode], plan, referenceId, $('#note').value.trim());
    } else prepared = { plan };
    $('#review-title').textContent = mode === 'demo' ? '看看这笔分账怎么分' : '请核对完整收款地址';
    $('#review-content').innerHTML = `<div class="dialog-total">${formatAmount(plan.total)}<small>USDC</small></div>${plan.payouts.map(p => `<div class="review-member"><div><strong>${esc(p.name || '未命名成员')}</strong><span>${formatAmount(p.amount)} USDC</span></div><code>${esc(p.address || '演示成员 · 未填写地址')}</code></div>`).join('')}${mode !== 'demo' ? `<div class="review-detail">付款账户：${esc(account)}<br />网络：${esc(wallet.chains[mode].name)}<br />合约：${esc(prepared.contract)}<br />预计网络费用上限：${formatAmount((prepared.maxFee + 999_999_999_999n) / 1_000_000_000_000n, 6)} USDC</div>` : ''}`;
    $('#acknowledge-row').hidden = mode === 'demo'; $('#acknowledge').checked = false;
    $('#confirm-button').textContent = mode === 'demo' ? '演示这笔分账' : '确认并在钱包中付款';
    $('#review-hint').textContent = mode === 'demo' ? '只会生成一份演示记录，不会产生链上交易。' : wallet.localAvailable() ? '接下来会打开本机确认窗口。只在该窗口输入密码，网页不接触私钥。' : '需要你在自己的钱包中确认，应用不接触私钥。';
    $('#review-dialog').showModal();
  } catch (e) { toast(wallet.friendlyError(e)); } finally { setBusy(false); }
});

$('#confirm-button').addEventListener('click', async () => {
  if (!prepared || busy) return;
  if (mode !== 'demo' && !$('#acknowledge').checked) { toast('请先核对地址并勾选确认。'); return; }
  setBusy(true);
  let entry;
  const payment = prepared;
  try {
    if (mode === 'demo') { history.unshift(record(payment.plan, crypto.randomUUID(), 'success')); toast('演示完成，没有发送任何资产。'); }
    else {
      entry = { ...record(payment.plan, payment.referenceId, 'pending'), account: payment.account, contract: payment.contract, mode: payment.mode, fromBlock: payment.fromBlock.toString() }; history.unshift(entry); saveHistory();
      const hash = await wallet.send(payment);
      entry.hash = hash; saveHistory();
      $('#review-dialog').close(); toast('交易已提交，正在等待链上分账凭证。');
      const receipt = await wallet.publicClient(payment.mode).waitForTransactionReceipt({ hash, timeout: 90_000 });
      if (receipt.status !== 'success') { entry.status = 'failed'; throw new Error('交易已回滚，分账未完成。'); }
      wallet.verifyReceipt(receipt, payment); entry.status = 'success'; entry.blockNumber = receipt.blockNumber.toString(); toast('链上分账已完成，全部收款明细已核实。');
    }
    $('#review-dialog').close();
  } catch (e) {
    if (entry && !entry.hash && wallet.isUserRejection(e)) { history = history.filter(r => r.id !== entry.id); entry = null; }
    toast(entry?.status === 'pending' ? '付款结果尚未核实。请在付款记录中检查状态，不要重复付款。' : wallet.friendlyError(e));
  }
  finally { history = [...history.filter(r => r.status === 'pending'), ...history.filter(r => r.status !== 'pending').slice(0, 48)]; prepared = null; saveHistory(); await refreshLocalBalance(); setBusy(false); }
});

$('#history-items').addEventListener('click', async event => {
  const button = event.target.closest('[data-check]'); if (!button) return;
  const entry = history.find(r => r.id === button.dataset.check); if (!entry) return;
  setBusy(true);
  try {
    const { receipt, hash } = await wallet.findPayment(entry);
    entry.hash = hash;
    if (receipt.status !== 'success') { entry.status = 'failed'; toast('交易已回滚，未完成分账。'); }
    else { wallet.verifyReceipt(receipt, expectedFrom(entry)); entry.status = 'success'; entry.blockNumber = receipt.blockNumber.toString(); toast('交易已确认，收款明细已核实。'); }
  } catch { toast('尚未取得匹配的链上凭证，请继续等待或查看区块浏览器。'); }
  finally { saveHistory(); await refreshLocalBalance(); setBusy(false); }
});
$('#clear-history').addEventListener('click', () => { if (history.some(r => r.status === 'pending')) { toast('还有未确认交易，请先核查，避免丢失付款状态。'); return; } if (history.length && confirm('清空此浏览器的记录？链上记录不会被删除。')) { history = []; saveHistory(); } });

$('#export-button').addEventListener('click', () => {
  try {
    const plan = currentPlan();
    const rows = [['备注', '模式', '成员', '收款地址', '比例(%)', '金额(USDC)'], ...plan.payouts.map(p => [$('#note').value.trim(), mode === 'demo' ? '演示，不是付款凭证' : wallet.chains[mode].name, p.name, p.address, p.percent, `${p.amount / 1_000_000n}.${(p.amount % 1_000_000n).toString().padStart(6, '0')}`])];
    const url = URL.createObjectURL(new Blob(['\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n')], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = '同账-分账明细.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); toast('分账明细已导出；导出文件不代表已经付款。');
  } catch (e) { toast(e.message); }
});
$('#settings-button').addEventListener('click', () => { $('#contract-address').value = contracts[mode] ?? ''; $('#settings-dialog').showModal(); });
$('#save-contract').addEventListener('click', async () => {
  if (mode === 'demo') { toast('请先选择 Arc 测试网或主网。'); return; }
  setBusy(true); try { contracts[mode] = await wallet.checkContract(mode, $('#contract-address').value.trim()); store('arc-split-contracts-v1', contracts); $('#settings-dialog').close(); toast('合约代码与网络已核实，地址已保存。'); } catch (e) { toast(wallet.friendlyError(e)); } finally { setBusy(false); }
});
$('#deploy-contract').addEventListener('click', async () => {
  if (mode !== 'testnet') { toast('请先切换到 Arc 测试网；此处不部署主网合约。'); return; }
  if (!account) { toast('请先关闭设置并连接测试网钱包。'); return; }
  setBusy(true);
  try {
    let address;
    const pending = readStore('arc-split-pending-deploy-v1', null);
    if (pending?.hash) {
      const receipt = await wallet.publicClient('testnet').getTransactionReceipt({ hash: pending.hash });
      if (receipt.status !== 'success') { store('arc-split-pending-deploy-v1', null); throw new Error('上次部署已回滚，可以再次部署。'); }
      address = await wallet.checkContract('testnet', receipt.contractAddress);
    } else address = await wallet.deployTestnet(account, hash => { store('arc-split-pending-deploy-v1', { hash }); toast('部署交易已提交，正在等待确认；请勿重复部署。'); });
    contracts.testnet = address; store('arc-split-contracts-v1', contracts); store('arc-split-pending-deploy-v1', null); $('#contract-address').value = address; toast('测试网合约已部署并核实，地址已保存。');
  } catch (e) { toast(wallet.friendlyError(e)); } finally { await refreshLocalBalance(); setBusy(false); }
});

window.ethereum?.on?.('accountsChanged', () => { account = null; prepared = null; $('#review-dialog').close(); refresh(); });
window.ethereum?.on?.('chainChanged', () => { account = null; prepared = null; $('#review-dialog').close(); refresh(); });
const mobileSettings = document.createElement('button');
mobileSettings.className = 'button mobile-settings';
mobileSettings.setAttribute('aria-label', '合约设置');
mobileSettings.textContent = '⚙';
mobileSettings.addEventListener('click', () => $('#settings-button').click());
$('.topbar-actions').append(mobileSettings);
sample(); renderHistory();
if (wallet.localAvailable()) { $('#mode').value = 'testnet'; $('#mode').dispatchEvent(new Event('change')); $('#wallet-button').click(); }
