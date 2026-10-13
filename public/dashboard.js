import { MARKETS, quote, quoteIsExecutable, marketDependencies, rawQuoteFresh, pnl, metrics } from './simulator.js';
import {showContractNextStep} from './contract-status.js';
import {createMarketReference} from './market-reference.js';
import {createAccountFeed, createAccountOrderGuard} from './account-feed.js';

const $ = id => document.getElementById(id);
let account;
const accountOrderGuard = createAccountOrderGuard();
let accountFeed = null;
let accountDelivery = 'connecting';
let traderId;
let selected = 'EURUSD';
let pushSubscribed=false;
let workerRegistration=null;
let notificationSettings=null;
let checkedPassedAttempt=null;
let warnedLegacyAttempt=null;
let orderSubmitting=false;
let orderFeedback=null;
const money = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value) : '—';
const price = (symbol, value) => Number.isFinite(value) ? value.toFixed(MARKETS[symbol].decimals) : '—';
const lotSize = symbol => MARKETS[symbol].lotSize ?? (MARKETS[symbol].category === 'Forex' ? 100000 : 1);
const lotVolume = trade => new Intl.NumberFormat('en-US', { maximumFractionDigits:10 }).format(trade.lots ?? trade.quantity / (trade.lotSize ?? lotSize(trade.symbol)));
const color = value => !Number.isFinite(value) ? 'text-muted' : value < 0 ? 'text-red-400' : 'text-lime';
const quoteTime = value => Number.isFinite(value) && value > 0 ? new Intl.DateTimeFormat(undefined, { month:'short', day:'numeric', hour:'2-digit', minute:'2-digit', second:'2-digit', timeZone:'UTC' }).format(value) + ' UTC' : 'awaiting quote';
const message = text => { $('dashboard-message').textContent = text; };
function applyAccount(next) {
  if (!accountOrderGuard.accept(next)) return false;
  const previous = account?.locked;
  account = next;
  if (previous !== undefined && account.locked && account.locked !== previous) message(account.locked === 'Profit target achieved' ? 'Practice challenge passed: 10% realized profit with no open positions.' : `${account.locked} reached. Positions closed and new trades locked.`);
  return true;
}
function orderMessage(text, state) {
  orderFeedback = {text, state};
  renderOrderStatus();
}
function renderOrderStatus(m = metrics(account)) {
  let paused = '';
  if (!orderSubmitting) {
    if (account.migrationRequired) paused = 'This previous attempt is read only. Use Start reference-priced attempt to begin trading with reference prices.';
    else if (account.locked) paused = account.locked === 'Profit target achieved' ? 'Assessment completed. Visit Trader agreement for the next required step.' : `Trading is locked: ${account.locked}. See the risk monitor for details.`;
    else if (!executionReady()) {
      const missing = marketDependencies(selected).filter(symbol => !rawQuoteFresh(account, symbol));
      paused = `Trading is paused until fresh ${missing.join(', ') || selected} references are available. See the reference status above.`;
    } else if (m.executionReady === false) paused = `New trades are paused while open positions await fresh prices${m.staleSymbols?.length ? ` (${m.staleSymbols.join(', ')})` : ''}. See the reference status above.`;
  }
  const status = $('order-status');
  const text = [orderFeedback?.text, paused].filter(Boolean).join(' ');
  const state = orderFeedback?.state === 'error' || orderFeedback?.state === 'pending' ? orderFeedback.state : paused ? 'blocked' : orderFeedback?.state || '';
  if (status.textContent !== text) status.textContent = text;
  status.hidden = !text; status.dataset.state = state;
  status.className = `mt-3 text-sm ${state === 'error' ? 'text-red-400' : state === 'success' ? 'text-lime' : 'text-muted'}`;
}
async function api(endpoint, data) {
  const response = await fetch(endpoint, data === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json','X-Requested-With':'FundraiserAcademy'}, body:JSON.stringify(data) });
  const result = await response.json();
  if (response.status === 401) { window.location.replace('/login.html'); throw new Error('Please log in.'); }
  if (!response.ok) throw new Error(result.error || 'Server request failed.');
  return result;
}
try {
  const result = await api('/api/me');
  traderId=result.user.id;
  applyAccount((await api('/api/account')).account);
  $('trader-name').textContent = `Welcome, ${result.user.name}. Your practice account is saved on the server.`;
  document.querySelector('main').hidden = false;
} catch (error) {
  if (!account) { window.location.replace('/login.html'); await new Promise(() => {}); }
}
const marketReference=createMarketReference($('real-market-reference'),selected,traderId);
$('sign-out').addEventListener('click', async () => { accountFeed?.stop(); try { const subscription=await workerRegistration?.pushManager.getSubscription(); await api('/api/logout', {endpoint:subscription?.endpoint}); if(subscription)await subscription.unsubscribe(); window.location.assign('/login.html'); } catch(error) { message(error.message); startAccountFeed(); } });
for (const category of [...new Set(Object.values(MARKETS).map(market => market.category))]) {
  const markets = Object.entries(MARKETS).filter(([, market]) => market.category === category);
  const options = document.createElement('optgroup'); options.label = category;
  const alertOptions = document.createElement('optgroup'); alertOptions.label = category;
  const group = document.createElement('div'); group.className = 'flex w-full flex-wrap gap-2'; group.setAttribute('role', 'group'); group.setAttribute('aria-label', `${category} markets`);
  const heading = document.createElement('p'); heading.className = 'w-full text-xs text-muted'; heading.textContent = `${category} · ${markets.length} markets`; group.append(heading);
  for (const [symbol, market] of markets) {
    const option = document.createElement('option'); option.value = symbol; option.textContent = market.label; options.append(option); alertOptions.append(option.cloneNode(true));
    const button = document.createElement('button'); button.type = 'button'; button.textContent = market.label; button.dataset.symbol = symbol; button.className = 'desk-action'; button.addEventListener('click', () => selectMarket(symbol)); group.append(button);
  }
  $('symbol').append(options); $('alert-symbol').append(alertOptions); $('market-tabs').append(group);
}
let editingPosition=null;
const seenNotifications=new Set(account.notifications.map(n=>`${account.notificationEpoch}:${n.id}`));
function popup(notice) {
  const div=document.createElement('article');div.className='rounded-xl border border-line bg-paper p-4 shadow-xl';
  const heading=document.createElement('strong');heading.className='text-sm';heading.textContent=notice.title;
  const text=document.createElement('p');text.className='mt-2 text-xs text-muted';text.textContent=notice.text;
  const dismiss=document.createElement('button');dismiss.className='desk-action mt-3';dismiss.textContent='Dismiss';dismiss.addEventListener('click',()=>div.remove());
  div.append(heading,text,dismiss);const container=$('toast-notifications');container.append(div);while(container.children.length>3)container.firstChild.remove();setTimeout(()=>div.remove(),10000);
}
function initialiseLimits() {
  $('personal-daily').value=account.limits.dailyLoss??'';
  $('personal-risk').value=account.limits.maxRisk??'';
  $('personal-positions').value=account.limits.maxPositions;
}
initialiseLimits();
function selectMarket(symbol) {
  orderFeedback = null;
  selected = symbol; $('symbol').value = symbol;
  marketReference.selectSymbol(symbol);
  $('quantity').value = MARKETS[symbol].defaultLots ?? (MARKETS[symbol].category === 'Forex' ? '0.1' : symbol === 'BTCUSD' ? '0.01' : '0.1');
  $('limit-price').value = ''; $('stop-loss').value = ''; $('take-profit').value = ''; render();
  accountFeed?.selectSymbol();
  void tick();
}

function executionReady(symbol = selected) {
  return !account.migrationRequired && quoteIsExecutable(account, symbol);
}
function unavailableReference(symbol) {
  const stale = marketDependencies(symbol).filter(dependency => !rawQuoteFresh(account, dependency));
  const conversion = stale.find(dependency => dependency !== symbol);
  if (conversion) return `The ${conversion} reference needed to convert ${MARKETS[symbol].quoteCurrency} to USD is unavailable or stale. ${account.prices[conversion]?.error || ''}`.trim();
  return account.prices[symbol]?.error || 'A fresh verified quote and any required USD conversion are unavailable.';
}

function renderExecutionState(m = metrics(account)) {
  const q = quote(account, selected), ready = executionReady();
  marketReference.updateExecutionQuote?.(selected, q, ready);
  $('bid-price').textContent = ready ? price(selected, q.bid) : '—';
  $('ask-price').textContent = ready ? price(selected, q.ask) : '—';
  $('feed-dot').classList.toggle('bg-lime', ready);
  $('feed-dot').classList.toggle('bg-amber-400', !ready);
  const quoteDelivery = q.deliveryMode === 'streaming' ? 'Streaming quotes' : q.deliveryMode === 'polling' ? 'Periodic quotes' : 'Reference quotes';
  $('feed-status').textContent = account.migrationRequired ? 'Previous attempt · start a reference-priced account' : `${MARKETS[selected].label} · ${quoteDelivery} · ${ready ? 'Active' : 'Paused'}`;
  const accountUpdates = accountDelivery === 'live' ? 'Live account updates' : accountDelivery === 'polling' ? 'Periodic account updates' : accountDelivery === 'connecting' ? 'Connecting live updates' : 'Updates paused';
  $('tick-count').textContent = `${q.source ? `Source: ${q.source}` : 'Awaiting provider'} · ${accountUpdates}`;
  $('execution-quote-status').textContent = account.migrationRequired
    ? 'Start a reference-priced attempt with Reset demo. Your previous attempt is preserved in the server audit record.'
    : ready
      ? `${q.source} · Quote ${quoteTime(q.asOf * 1000)} · Retrieved ${quoteTime(q.fetchedAt)}.${q.conversionQuote ? ` USD conversion: ${q.conversionQuote.symbol} · ${quoteTime(q.conversionQuote.asOf * 1000)}.` : ''}`
      : `${q.source ? `Last source: ${q.source} · Quote ${quoteTime(q.asOf * 1000)}. ` : ''}${unavailableReference(selected)} Orders, closes and protection edits wait for fresh references. Refresh reference prices or choose another market.`;
  const blocked = orderSubmitting || Boolean(account.locked) || !ready || m.executionReady === false;
  $('submit-order').disabled = blocked;
  $('submit-order').classList.toggle('opacity-50', blocked);
  renderOrderStatus(m);
  if (!account.migrationRequired && m.executionReady === false) $('execution-quote-status').textContent += ` Open-position risk checks are waiting for fresh prices: ${m.staleSymbols?.join(', ') || 'provider unavailable'}.`;
  for (const button of $('positions').querySelectorAll('[data-execution-symbol]')) button.disabled = !executionReady(button.dataset.executionSymbol);
  if (editingPosition !== null && $('protection-dialog').open) {
    const position = account.positions.find(p => p.id === editingPosition);
    const canEdit = position && executionReady(position.symbol);
    $('protection-form').querySelector('button[type="submit"]').disabled = !canEdit;
    if (!canEdit) $('protection-status').textContent = 'Protection edits are paused until this position has a fresh reference price and any required USD conversion.';
  }
}

function estimate() {
  const quantity = Number($('quantity').value) * lotSize(selected);
  const market = MARKETS[selected];
  if (!executionReady() || metrics(account).executionReady === false) {
    $('order-estimate').textContent = 'Fresh reference prices and any required USD conversions are needed before margin can be checked and an order can fill.';
    return;
  }
  const q = quote(account, selected);
  const usdRate = market.quoteCurrency === 'USD' ? 1 : q.usdRate;
  const entry = $('side').value === 'buy' ? q.ask : q.bid;
  const plannedEntry = $('order-type').value === 'limit' && Number($('limit-price').value) > 0 ? Number($('limit-price').value) : entry;
  $('order-estimate').textContent = Number.isFinite(quantity) && quantity > 0 ? `Estimated margin: ${money(plannedEntry * quantity * usdRate / market.leverage)} · No added spread · ${market.leverage}:1 demo leverage` : 'Enter a positive lot volume.';
}

function row(cells) {
  const tr = document.createElement('tr');
  for (const cell of cells) { const td = document.createElement('td'); if (cell instanceof Node) td.append(cell); else td.textContent = String(cell); tr.append(td); }
  return tr;
}
function resultNode(value) { const span = document.createElement('span'); span.className = color(value); span.textContent = money(value); return span; }
function emptyRow(text, columns) { const tr = row([text]); tr.firstChild.colSpan = columns; tr.firstChild.className += ' text-muted'; return tr; }

function renderTables() {
  $('positions').replaceChildren(); $('journal').replaceChildren();
  $('position-count').textContent = `${account.positions.length} / ${account.limits.maxPositions} positions`;
  $('journal-count').textContent = `${account.history.length} closed trades`;
  if (!account.positions.length) $('positions').append(emptyRow('No open positions. Place a demo trade to get started.', 6));
  for (const position of account.positions) {
    const close = document.createElement('button'); close.className = 'desk-action'; close.textContent = 'Close'; close.dataset.executionSymbol = position.symbol; close.disabled = !executionReady(position.symbol); close.setAttribute('aria-label', `Close ${position.symbol} position ${position.id}`);
    close.addEventListener('click', async () => { close.disabled = true; try { const result = await api('/api/trades/close', {id:position.id}); applyAccount(result.account); message(`Position #${position.id} closed at the verified reference. Realized result: ${money(result.account.history.find(trade=>trade.id===position.id)?.profit)}.`); render(); } catch(error) { message(error.message); await tick(); renderExecutionState(); } });
    const actions=document.createElement('div'); actions.className='flex gap-2';
    const edit=document.createElement('button'); edit.className='desk-action'; edit.textContent='Edit SL/TP'; edit.dataset.executionSymbol=position.symbol; edit.disabled=!executionReady(position.symbol);
    edit.addEventListener('click',()=>{ editingPosition=position.id; $('protection-title').textContent=`${position.symbol} #${position.id} protection`; $('edit-stop').value=position.stopLoss??''; $('edit-target').value=position.takeProfit??''; $('protection-status').textContent=''; $('protection-dialog').showModal(); renderExecutionState(); });
    actions.append(edit,close);
    const floating = account.migrationRequired ? null : pnl(account, position);
    const floatingNode = resultNode(floating);
    if (!executionReady(position.symbol) && Number.isFinite(floating)) { floatingNode.append(' · last reference'); floatingNode.className = 'text-muted'; }
    $('positions').append(row([`${position.symbol} · ${position.side.toUpperCase()}`, lotVolume(position), price(position.symbol, position.entry), `${position.stopLoss === null ? '—' : price(position.symbol, position.stopLoss)} / ${position.takeProfit === null ? '—' : price(position.symbol, position.takeProfit)}`, floatingNode, actions]));
  }
  if (!account.history.length) $('journal').append(emptyRow('Closed trades will appear here.', 6));
  for (const trade of account.history.slice(0, 200)) $('journal').append(row([`${trade.symbol} · ${trade.side.toUpperCase()}`, lotVolume(trade), `${price(trade.symbol, trade.entry)} → ${price(trade.symbol, trade.exit)}`, resultNode(trade.profit), new Date(trade.closedAt).toLocaleString(), trade.reason]));
  if (account.history.length > 200) $('journal').append(emptyRow('Showing the latest 200 trades. Export for the full journal.', 6));
}

function render() {
  if(account.locked==='Profit target achieved' && checkedPassedAttempt!==account.notificationEpoch){checkedPassedAttempt=account.notificationEpoch;void showContractNextStep($('contract-next-step'));}
  const m = metrics(account); const market = MARKETS[selected];
  const valued = !account.migrationRequired && m.valuationComplete !== false;
  for (const [id, value] of [['balance', account.balance], ['equity', valued ? m.equity : null], ['net', valued ? m.net : null], ['free-margin', valued ? m.freeMargin : null]]) $(id).textContent = money(value);
  $('net').className = `metric-value ${valued ? color(m.net) : 'text-muted'}`;
  $('floating').textContent = account.migrationRequired ? 'Previous attempt · read only' : !valued ? 'Waiting for reference valuations' : `${money(m.floating)} floating P&L${m.executionReady === false ? ' · last reference, awaiting fresh prices' : ''}`; $('floating').className = `text-xs ${m.executionReady === false ? 'text-muted' : color(valued ? m.floating : null)}`;
  $('used-margin').textContent = `${money(m.margin)} margin used`;
  $('quantity-label').textContent = 'Volume (lots)';
  $('quantity').min = market.lotStep ?? (market.category === 'Forex' ? '0.01' : '0.001');
  $('quantity').step = market.lotStep ?? (market.category === 'Forex' ? '0.01' : '0.001');
  $('quantity').max = market.maxLots ?? 1000;
  $('lot-size-note').textContent = `1 lot = ${lotSize(selected).toLocaleString('en-US')} ${market.baseCurrency}${market.category === 'Forex' ? ' units' : ''}.`;
  $('ticket-price-unit').textContent = `Prices in ${market.quoteCurrency} per ${market.baseCurrency}`;
  const conversionNote = $('quote-currency-note'); conversionNote.hidden = market.quoteCurrency === 'USD';
  conversionNote.textContent = `Prices are in ${market.quoteCurrency}; margin, profit or loss, and risk limits are converted to USD using a fresh reference rate.`;
  $('risk-status').textContent = account.locked === 'Profit target achieved' ? 'Practice challenge passed' : account.locked ? `${account.locked} — locked` : 'Challenge in progress';
  $('target-meter').value = Math.min(100, Math.max(0, (account.balance - account.initial) / (account.initial * .1) * 100));
  $('target-risk').textContent = `${money(account.balance - account.initial)} / ${money(account.initial * .1)} realized profit · ${account.tradingDays.length}/3 trading days · close all positions to pass`;
  if(!account.locked && account.balance>=account.initial*1.1) $('risk-status').textContent='Profit target reached — complete 3 trading days and close positions';
  $('daily-meter').value = Math.min(100, m.dailyLoss / (account.dailyStart * .05) * 100);
  $('total-meter').value = Math.min(100, m.totalLoss / 1000 * 100);
  $('daily-risk').textContent = `${money(m.dailyLoss)} / ${money(account.dailyStart * .05)} · day ${account.day} UTC`;
  $('total-risk').textContent = `${money(m.totalLoss)} / $1,000.00`;
  $('win-rate').textContent = m.winRate === null ? '—' : `${m.winRate.toFixed(1)}%`;
  $('max-drawdown').textContent = `${account.worstDrawdown.toFixed(2)}%`;
  if (account.migrationRequired) {
    if (warnedLegacyAttempt !== account.notificationEpoch) { warnedLegacyAttempt=account.notificationEpoch; message('Start a reference-priced attempt using Reset demo. Your previous assessment remains preserved in the audit record; its trading actions are read only.'); }
    $('risk-status').textContent = 'Previous attempt · reference reset required';
    $('reset-account').textContent = 'Start reference-priced attempt';
    $('reset-dialog').querySelector('h3').textContent = 'Start a reference-priced attempt?';
    $('reset-dialog').querySelector('p').textContent = 'Your previous attempt and its price basis will be preserved in the server audit record. This starts a new $10,000 demo assessment using fresh verified market references. Export the previous journal first if you want a copy.';
  } else {
    $('reset-account').textContent = 'Reset demo';
    $('reset-dialog').querySelector('h3').textContent = 'Reset your practice account?';
    $('reset-dialog').querySelector('p').textContent = 'This restarts your practice account. Previous attempts remain in the server audit record. Export the current journal first if you want a copy.';
    if (m.executionReady === false) $('risk-status').textContent = `${account.locked ? account.locked + ' · ' : ''}Risk checks awaiting fresh references`;
  }
  for (const button of $('market-tabs').querySelectorAll('[data-symbol]')) { button.setAttribute('aria-pressed', String(button.dataset.symbol === selected)); button.classList.toggle('bg-lime', button.dataset.symbol === selected); button.classList.toggle('text-black', button.dataset.symbol === selected); }
  $('limits-summary').textContent=`Daily cap: ${account.limits.dailyLoss===null?'academy default':money(account.limits.dailyLoss)} · Trade risk: ${account.limits.maxRisk===null?'not set':money(account.limits.maxRisk)} · ${account.limits.maxPositions} positions`;
  estimate(); renderTables(); renderExecutionState(m); renderTools();
}

$('symbol').addEventListener('change', event => selectMarket(event.target.value));
$('quantity').addEventListener('input', estimate); $('side').addEventListener('change', estimate);
$('limit-price').addEventListener('input', estimate);
$('order-form').addEventListener('submit', async event => {
  event.preventDefault();
  const isLimit=$('order-type').value==='limit';
  orderSubmitting=true; $('submit-order').disabled = true;
  $('submit-order').textContent = isLimit ? 'Placing limit order…' : 'Placing demo trade…';
  orderMessage('Checking the reference price and your risk limits…', 'pending');
  try {
    const result = await api(isLimit?'/api/orders':'/api/trades', { symbol:selected, side:$('side').value, lots:Number($('quantity').value), limitPrice:isLimit?Number($('limit-price').value):undefined, stopLoss:$('stop-loss').value === '' ? null : Number($('stop-loss').value), takeProfit:$('take-profit').value === '' ? null : Number($('take-profit').value) });
    applyAccount(result.account);
    const outcome = isLimit?'Limit order queued. It will execute at a fresh reference price at your limit or better, subject to server risk checks.':'Demo order filled at the server-verified reference price. No real money was used.';
    message(outcome); orderMessage(outcome, 'success');
  } catch(error) { message(error.message); orderMessage(error.message, 'error'); $('order-status').scrollIntoView({block:'nearest',inline:'nearest'}); await tick(); }
  finally { orderSubmitting=false; $('submit-order').textContent = 'Place demo trade'; }
  render();
});
let polling = false;
async function tick() {
  if (polling) return; polling = true;
  try {
    if (applyAccount((await api(`/api/account?symbol=${encodeURIComponent(selected)}`)).account)) render();
  } catch(error) { message(error.message); }
  finally { polling = false; }
}
$('next-tick').addEventListener('click', tick);
$('reset-account').addEventListener('click', () => $('reset-dialog').showModal());
$('cancel-reset').addEventListener('click', () => $('reset-dialog').close());
$('confirm-reset').addEventListener('click', async () => {
  $('confirm-reset').disabled = true;
  try { const result = await api('/api/account/reset', {}); applyAccount(result.account); seenNotifications.clear(); initialiseLimits(); selectMarket(selected); $('reset-dialog').close(); message(result.message); }
  catch(error) { message(error.message); }
  finally { $('confirm-reset').disabled=false; }
});
$('export-journal').addEventListener('click', async () => {
  try {
    const report = await api('/api/journal');
    const url = URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
    const link = document.createElement('a'); link.href=url; link.download='fundraiser-demo-journal.json'; link.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
    message('Server-recorded practice journal exported with its quote source and price basis.');
  } catch(error) { message(error.message); }
});
async function toolAction(endpoint,data,success) {
  const result=await api(endpoint,data); applyAccount(result.account); if(success) message(success); render();
}
function renderTools() {
  $('pending-orders').replaceChildren();
  if(!account.pending.length) $('pending-orders').append(emptyRow('No pending limit orders.',5));
  for(const order of account.pending) {
    const cancel=document.createElement('button'); cancel.className='desk-action'; cancel.textContent='Cancel order';
    cancel.addEventListener('click',async()=>{try{await toolAction('/api/orders/cancel',{id:order.id},'Limit order cancelled.');}catch(e){message(e.message);}});
    $('pending-orders').append(row([`${order.symbol} · ${order.side.toUpperCase()}`,lotVolume(order),price(order.symbol,order.limitPrice),`${order.stopLoss === null ? '—' : price(order.symbol,order.stopLoss)} / ${order.takeProfit === null ? '—' : price(order.symbol,order.takeProfit)}`,cancel]));
  }
  $('alerts-list').replaceChildren();
  if(!account.alerts.length) { const p=document.createElement('p'); p.className='text-xs text-muted'; p.textContent='No price alerts yet.'; $('alerts-list').append(p); }
  for(const alert of account.alerts) {
    const div=document.createElement('div'); div.className='rounded-lg border border-line p-3 text-xs';
    const text=document.createElement('p'); text.textContent=`${alert.symbol} ${alert.direction} ${price(alert.symbol,alert.target)} · ${alert.active?'Active':'Triggered'}`;
    const remove=document.createElement('button'); remove.className='desk-action mt-2'; remove.textContent='Remove alert';
    remove.addEventListener('click',async()=>{try{await toolAction('/api/alerts/remove',{id:alert.id},'Price alert removed.');}catch(e){message(e.message);}});
    div.append(text,remove); $('alerts-list').append(div);
  }
  $('notifications-list').replaceChildren();
  $('unread-count').textContent=`(${account.notifications.filter(n=>!n.read).length} unread)`;
  if(!account.notifications.length) { const p=document.createElement('p'); p.className='text-xs text-muted'; p.textContent='Trade and price notifications will appear here.'; $('notifications-list').append(p); }
  for(const notice of account.notifications) {
    const div=document.createElement('article'); div.className=`rounded-lg border border-line p-3 ${notice.read?'':'bg-lime/20'}`;
    const title=document.createElement('strong'); title.className='text-xs'; title.textContent=notice.title;
    const text=document.createElement('p'); text.className='mt-1 text-xs text-muted'; text.textContent=notice.text;
    const time=document.createElement('p'); time.className='mt-2 text-[10px] text-muted'; time.textContent=new Date(notice.createdAt).toLocaleString(); div.append(title,text,time); $('notifications-list').append(div);
    const noticeKey=`${account.notificationEpoch}:${notice.id}`;
    if(!seenNotifications.has(noticeKey)) {
      seenNotifications.add(noticeKey);popup(notice);
      if(!pushSubscribed && 'Notification' in window && Notification.permission==='granted') { try { new Notification(notice.title,{body:notice.text,tag:noticeKey}); } catch { /* Inbox delivery remains available if the platform rejects desktop notifications. */ } }
    }
  }
  $('notification-permission').textContent='Notification' in window?`Browser permission: ${Notification.permission}`:'Browser notifications are not supported; use this inbox.';
}
$('order-type').addEventListener('change',()=>{ const isLimit=$('order-type').value==='limit'; $('limit-price-field').hidden=!isLimit; $('limit-price').required=isLimit; estimate(); });
for(const [id,endpoint,getData,success] of [
  ['limits-form','/api/limits',()=>({dailyLoss:$('personal-daily').value===''?null:Number($('personal-daily').value),maxRisk:$('personal-risk').value===''?null:Number($('personal-risk').value),maxPositions:Number($('personal-positions').value)}),'Personal risk limits saved.'],
  ['alert-form','/api/alerts',()=>({symbol:$('alert-symbol').value,direction:$('alert-direction').value,target:Number($('alert-target').value)}),'Price alert created. It will check the next server quote.'],
]) $(id).addEventListener('submit',async event=>{event.preventDefault();const button=event.target.querySelector('button[type="submit"]');button.disabled=true;try{await toolAction(endpoint,getData(),success);}catch(e){message(e.message);}finally{button.disabled=false;}});
$('protection-form').addEventListener('submit',async event=>{event.preventDefault();const button=event.target.querySelector('button[type="submit"]');button.disabled=true;try{await toolAction('/api/trades/protection',{id:editingPosition,stopLoss:$('edit-stop').value===''?null:Number($('edit-stop').value),takeProfit:$('edit-target').value===''?null:Number($('edit-target').value)},'Position protection updated.');$('protection-dialog').close();}catch(e){$('protection-status').textContent=e.message;await tick();}finally{renderExecutionState();}});
$('cancel-protection').addEventListener('click',()=>$('protection-dialog').close());
$('mark-read').addEventListener('click',async()=>{try{await toolAction('/api/notifications/read',{});}catch(e){message(e.message);}});
function displayDeliverySettings() {
  if(!notificationSettings)return;
  $('delivery-status').textContent=`Email: ${notificationSettings.emailAvailable?(notificationSettings.emailEnabled?'enabled':notificationSettings.emailVerified?'verified, disabled':'verify to enable'):'provider/sender/HTTPS configuration needed'} · Push on this device: ${pushSubscribed?'enabled':'disabled'} · Queue: ${notificationSettings.pending} pending, ${notificationSettings.failed} failed`;
  $('enable-email').disabled=!notificationSettings.emailAvailable;
  $('disable-email').disabled=!notificationSettings.emailEnabled;
  $('disable-push').disabled=!pushSubscribed;
}
async function refreshDeliverySettings() {notificationSettings=await api('/api/notification-settings');displayDeliverySettings();}
async function initialiseBackgroundPush() {
  if(!('serviceWorker' in navigator) || !window.isSecureContext)return;
  navigator.serviceWorker.addEventListener('message',event=>{const notice=event.data?.notice;if(event.data?.type!=='FA_NOTIFICATION'||typeof notice?.title!=='string'||typeof notice?.text!=='string')return;if(!seenNotifications.has(notice.key)){seenNotifications.add(notice.key);popup(notice);}void tick();});
  try {workerRegistration=await navigator.serviceWorker.register('/sw.js');await navigator.serviceWorker.ready;pushSubscribed=Boolean(await workerRegistration.pushManager.getSubscription());displayDeliverySettings();}catch{message('Background push is unavailable in this browser. Popup and inbox notifications still work.');}
}
$('enable-notifications').addEventListener('click',async()=>{
  if(!workerRegistration||!('PushManager' in window)||!('Notification' in window)){message('Background push needs HTTPS (or localhost), a supported browser, and notification permission. Popups remain available.');return;}
  try {
    const permission=await Notification.requestPermission();
    if(permission!=='granted'){message('Notification permission was not granted. Popups and the inbox remain available.');return;}
    await refreshDeliverySettings();
    const encoded=notificationSettings.publicKey.replace(/-/g,'+').replace(/_/g,'/');
    const key=Uint8Array.from(atob(encoded),char=>char.charCodeAt(0));
    const subscription=await workerRegistration.pushManager.getSubscription()||await workerRegistration.pushManager.subscribe({userVisibleOnly:true,applicationServerKey:key});
    notificationSettings=await api('/api/push/subscribe',{subscription:subscription.toJSON()});pushSubscribed=true;displayDeliverySettings();message('Background push enabled. Notifications can arrive when the page is closed if your browser/OS supports it.');
  }catch(error){message(`Background push could not be enabled: ${error.message}. Popups remain available.`);}
});
$('disable-push').addEventListener('click',async()=>{try{const subscription=await workerRegistration?.pushManager.getSubscription();if(subscription){notificationSettings=await api('/api/push/unsubscribe',{endpoint:subscription.endpoint});await subscription.unsubscribe();}pushSubscribed=false;displayDeliverySettings();message('Background push disabled on this device.');}catch(error){message(error.message);}});
$('enable-email').addEventListener('click',async()=>{try{if(!notificationSettings)await refreshDeliverySettings();if(notificationSettings.emailVerified){notificationSettings=await api('/api/email/preferences',{enabled:true});message('Email alerts enabled.');}else{notificationSettings=await api('/api/email/request-verification',{});message('Verification email queued. Check your inbox and confirm the link to enable alerts.');}displayDeliverySettings();}catch(error){message(error.message);}});
$('disable-email').addEventListener('click',async()=>{try{notificationSettings=await api('/api/email/preferences',{enabled:false});displayDeliverySettings();message('Email alerts disabled.');}catch(error){message(error.message);}});
checkedPassedAttempt=account.locked==='Profit target achieved'?account.notificationEpoch:null;
render();
function startAccountFeed() {
  accountFeed?.stop();
  accountFeed = createAccountFeed({
    getSymbol: () => selected,
    onAccount: next => { if (applyAccount(next)) render(); },
    onStatus: state => { accountDelivery = state; renderExecutionState(); },
    onUnauthorized: () => window.location.replace('/login.html'),
    poll: tick,
  });
  accountFeed.start();
}
startAccountFeed();
setInterval(() => { if(!document.hidden) { renderExecutionState(); estimate(); } },1000);
setInterval(()=>{if(!document.hidden)void refreshDeliverySettings().catch(()=>{});},15000);
// Optional delivery setup must not delay quote checks, order handling or polling.
void initialiseBackgroundPush();
void refreshDeliverySettings().catch(error=>message(error.message));
void showContractNextStep($('contract-next-step'));
