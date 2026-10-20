import { createAdminApi, administrativePermissions, pageRows, decimalToUnits, positiveInteger, queryString, csvDownloadName } from './admin-api.js';

const $ = id => document.getElementById(id);
const api = createAdminApi();
const content = $('admin-content');
const actionDialog = $('admin-action-dialog');
const unlockDialog = $('admin-reauth-dialog');
const money = value => Number.isFinite(value) ? new Intl.NumberFormat(undefined, { style: 'currency', currency: 'USD' }).format(value) : 'Not recorded';
const cents = value => Number.isSafeInteger(value) ? money(value / 100) : 'Not recorded';
const percent = value => Number.isFinite(value) ? `${value.toLocaleString(undefined, { maximumFractionDigits: 2 })}%` : 'Not recorded';
const date = value => Number.isFinite(value) && value > 0 ? new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : 'Not recorded';
const label = value => typeof value === 'string' ? value.replace(/_/g, ' ').replace(/\b\w/g, letter => letter.toUpperCase()) : 'Not recorded';
let access = null, permissions = new Set(), section = 'overview', requestEpoch = 0, loading = false, writing = false;
let privilegesExpiresAt = 0, unlockResolve = null, unlockReject = null, unlockPending = false, activeAction = null;
let pageQuery = {}, currentTraderId = null, currentAccountId = null;
const downloads = new Set();
const sections = [
  ['overview', 'Overview', 'overview.read', 'Your operational picture', 'A current view of academy records, qualification activity, and the work waiting for your team.'],
  ['traders', 'Traders', 'traders.read', 'People & accounts', 'Find a trader, inspect their saved assessment, and manage account access with an audit record.'],
  ['assessments', 'Assessments', 'assessments.read', 'Qualification monitoring', 'Review server-recorded challenge results and risk snapshots. Administrative review does not change trading results.'],
  ['certificates', 'Certificates', 'certificates.read', 'Verified achievements', 'Review completion certificates and download the original owner-bound records.'],
  ['contracts', 'Agreements', 'contracts.read', 'Terms & signatures', 'Publish the actual academy agreement, inspect immutable versions, and review recorded signatures.'],
  ['reviews', 'Sponsorship reviews', 'reviews.read', 'From qualification to review', 'Review eligible signed traders. An approved review records a company decision; it does not purchase or fund a prop account.'],
  ['accounts', 'Sponsored accounts', 'finance.read', 'External account records', 'Record company-sponsored accounts and their agreed terms. These are manual records of external activity.'],
  ['payouts', 'Profits & payouts', 'finance.read', 'Manual financial ledger', 'Track recorded profit shares and external payout progress. Recording a payment does not send money.'],
  ['support', 'Customer support', 'support.manage', 'Your support queue', 'Review human handoff requests and continue the saved conversation in the support inbox.'],
  ['reports', 'Reports & exports', 'reports.export', 'Operational reporting', 'Download bounded, filtered reports. Trading valuations reflect saved reference snapshots, not a live sponsored-account feed.'],
  ['staff', 'Staff & permissions', 'staff.manage', 'Controlled team access', 'Assign the minimum role needed. Every administrator must have a verified email and enabled two-factor authentication.'],
  ['audit', 'Audit trail', 'audit.read', 'Accountability', 'Inspect append-only administrative actions and the reasons recorded by staff.'],
  ['system', 'System status', 'system.read', 'Service configuration', 'See configured integrations and operating limits without exposing credentials or private storage paths.'],
];

function node(tag, className = '', text = null) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== null && text !== undefined) element.textContent = String(text);
  return element;
}
function link(text, href, className = 'text-lime underline underline-offset-4') {
  const element = node('a', className, text);
  if (typeof href === 'string' && href.startsWith('/') && !href.startsWith('//')) element.href = href;
  return element;
}
function button(text, handler, className = 'desk-action') {
  const element = node('button', className, text); element.type = 'button'; element.addEventListener('click', handler); return element;
}
function badge(text, positive = false) { return node('span', `inline-block rounded-full border px-2.5 py-1 text-[10px] ${positive ? 'border-lime/40 bg-lime/10 text-lime' : 'border-line text-muted'}`, label(text)); }
function notify(message, focus = false) { $('admin-status').textContent = message; if (focus) $('admin-status').focus(); }
function card(title, description) {
  const element = node('section', 'desk-card min-w-0');
  if (title) element.append(node('h2', 'mb-3 text-xl tracking-tight', title));
  if (description) element.append(node('p', 'mb-5 text-sm text-muted', description));
  return element;
}
function empty(text = 'No records match these filters.') { return node('p', 'rounded-xl border border-dashed border-line px-5 py-8 text-center text-sm text-muted', text); }
function detailGrid(values) {
  const list = node('dl', 'grid min-w-0 gap-4 text-sm sm:grid-cols-2 xl:grid-cols-3');
  for (const [term, value] of values) { const part = node('div', 'min-w-0'); part.append(node('dt', 'metric-label mb-1', term), node('dd', 'break-words', value)); list.append(part); }
  return list;
}
function table(columns, rows) {
  if (!rows.length) return empty();
  const wrap = node('div', 'max-w-full overflow-x-auto rounded-lg border border-line');
  const element = node('table', 'desk-table'); const head = node('thead'); const headRow = node('tr');
  for (const column of columns) headRow.append(node('th', '', column.title));
  head.append(headRow); element.append(head); const body = node('tbody');
  for (const row of rows) {
    const tr = node('tr');
    for (const column of columns) { const td = node('td'); const value = column.value(row); td.append(value instanceof Node ? value : document.createTextNode(value === null || value === undefined ? '—' : String(value))); tr.append(td); }
    body.append(tr);
  }
  element.append(body); wrap.append(element); return wrap;
}
function toolbar(...children) { const element = node('div', 'mb-5 flex flex-wrap items-center justify-between gap-3'); element.append(...children); return element; }
function pageNavigation(page, go) {
  const element = node('div', 'mt-5 flex flex-wrap items-center justify-between gap-3 text-xs text-muted');
  element.append(node('p', '', page.total ? `Showing ${page.offset + 1}–${Math.min(page.offset + page.items.length, page.total)} of ${page.total}` : '0 records'));
  const controls = node('div', 'flex gap-2'); const previous = button('← Previous', () => go(Math.max(0, page.offset - (page.limit || 25)))); previous.disabled = page.offset <= 0;
  const next = button('Next →', () => go(page.nextOffset ?? page.offset + (page.limit || 25))); next.disabled = page.nextOffset === null && page.offset + page.items.length >= page.total;
  controls.append(previous, next); element.append(controls); return element;
}
function selectInput(name, choices, value = '') {
  const input = node('select'); input.name = name;
  for (const choice of choices) { const option = node('option', '', Array.isArray(choice) ? choice[1] : label(choice)); option.value = Array.isArray(choice) ? choice[0] : choice; input.append(option); }
  if (Array.from(input.options).some(option => option.value === String(value))) input.value = String(value);
  return input;
}
function filters(fields, values, submit) {
  const form = node('form', 'mb-5 grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-4');
  for (const field of fields) {
    const holder = node('div', 'min-w-0'); const id = `admin-filter-${field.name}`; const caption = node('label', 'mb-1 block text-xs font-semibold', field.label); caption.htmlFor = id;
    const input = field.choices ? selectInput(field.name, field.choices, values[field.name] || '') : node('input'); input.id = id; input.name = field.name; if (!field.choices) { input.type = field.type || 'search'; input.value = values[field.name] || ''; input.maxLength = 254; }
    input.className = 'mb-0'; holder.append(caption, input); form.append(holder);
  }
  const apply = node('button', 'desk-action mb-0 min-h-11', 'Apply filters'); apply.type = 'submit'; form.append(apply);
  form.addEventListener('submit', event => { event.preventDefault(); submit(Object.fromEntries(new FormData(form))); }); return form;
}
function can(permission) { return permissions.has(permission); }
function closeNavigation() { $('admin-sidebar').classList.add('hidden'); $('admin-nav-overlay').hidden = true; $('admin-menu').setAttribute('aria-expanded', 'false'); }
function navigation() {
  const nav = $('admin-navigation'); nav.replaceChildren();
  for (const entry of sections) {
    if (!can(entry[2])) continue;
    const item = button(entry[1], () => { navigate(entry[0]); closeNavigation(); }, 'rounded-lg px-3 py-2.5 text-left text-xs font-semibold hover:bg-lime/10');
    item.dataset.adminSection = entry[0]; if (entry[0] === section) { item.classList.add('bg-lime/10', 'text-lime'); item.setAttribute('aria-current', 'page'); }
    nav.append(item);
  }
}
function showDenied(current) {
  $('admin-loading').hidden = true; $('admin-main').hidden = true; $('admin-denied').hidden = false; $('admin-unlock').hidden = true; content.replaceChildren();
  const message = !current?.role ? 'This account has no administrative role. Ask an authorized owner to assign the appropriate role.'
    : !current.active ? 'Administrative access is unavailable while this account is suspended.'
      : !current.emailVerified ? 'Confirm ownership of your email address before using administration. Account security provides a confirmation email action.'
        : !current.twoFactorEnabled ? 'Enable two-factor authentication from Account security before using administration.' : 'Your administrative access is not available. Refresh or contact an authorized owner.';
  $('admin-denied-message').textContent = message; $('admin-navigation').replaceChildren();
}
async function refreshAccess() {
  const result = await api('/api/admin/access'); access = result; permissions = administrativePermissions(result);
  privilegesExpiresAt = Number(result.privilegesExpiresAt || result.expiresAt || 0);
  $('admin-role').textContent = result.role ? label(result.role) : 'No admin role';
  if (result.authorized !== true && result.eligible !== true) { showDenied(result); return false; }
  $('admin-loading').hidden = true; $('admin-denied').hidden = true; $('admin-main').hidden = false; $('admin-unlock').hidden = false;
  navigation(); updatePrivilegeStatus(); return true;
}
async function handleError(error, { local = false } = {}) {
  if (error.status === 401 && error.code !== 'PASSWORD_REAUTHENTICATION_FAILED') { clearPrivateView(); window.location.replace('/login.html'); return; }
  if (error.status === 403 && !local) {
    try { if (!await refreshAccess()) return; } catch { /* Keep the original truthful error below. */ }
  }
  notify(error.name === 'TimeoutError' ? 'The request took too long. Please try again.' : error.message || 'The request could not be completed.', true);
}
function clearPrivateView() {
  requestEpoch++; access = null; permissions = new Set(); privilegesExpiresAt = 0; content.replaceChildren();
  $('admin-main').hidden = true; $('admin-reauth-password').value = $('admin-reauth-code').value = '';
  if (actionDialog.open) actionDialog.close(); if (unlockDialog.open) unlockDialog.close();
}
function updatePrivilegeStatus() {
  const remaining = privilegesExpiresAt - Date.now();
  $('admin-unlock').textContent = remaining > 0 ? 'Actions unlocked' : 'Unlock actions';
  $('admin-unlock-status').textContent = remaining > 0 ? `Administrative actions are unlocked for ${Math.ceil(remaining / 60000)} ${remaining > 60000 ? 'minutes' : 'minute'}. Changes still need an explicit confirmation and reason.` : 'Viewing mode. Unlock actions with your password and a fresh second factor when you need to make a change.';
}
function ensureUnlocked() {
  if (privilegesExpiresAt > Date.now() + 1000) return Promise.resolve();
  if (unlockResolve) return Promise.reject(new Error('Finish the security confirmation already open.'));
  $('admin-reauth-password').value = $('admin-reauth-code').value = ''; $('admin-reauth-status').textContent = '';
  unlockDialog.showModal(); $('admin-reauth-password').focus();
  return new Promise((resolve, reject) => { unlockResolve = resolve; unlockReject = reject; });
}
function cancelUnlock() {
  if (unlockPending) return;
  const reject = unlockReject; unlockResolve = unlockReject = null;
  $('admin-reauth-password').value = $('admin-reauth-code').value = '';
  if (unlockDialog.open) unlockDialog.close(); reject?.(new Error('Security confirmation cancelled. No change was submitted.'));
}
$('admin-reauth-form').addEventListener('submit', async event => {
  event.preventDefault(); if (unlockPending || !$('admin-reauth-form').reportValidity()) return;
  unlockPending = true; $('admin-reauth-submit').disabled = $('admin-reauth-cancel').disabled = true;
  const values = { password: $('admin-reauth-password').value, code: $('admin-reauth-code').value.trim() };
  $('admin-reauth-password').value = $('admin-reauth-code').value = ''; $('admin-reauth-status').textContent = 'Checking your security proof…';
  try {
    const result = await api('/api/admin/reauth', values); const expiry = Number(result.privilegesExpiresAt || result.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('Your administrative confirmation could not be read. Try again.');
    privilegesExpiresAt = expiry; const resolve = unlockResolve; unlockResolve = unlockReject = null; unlockDialog.close(); updatePrivilegeStatus(); resolve?.();
  } catch (error) { $('admin-reauth-status').textContent = error.message; if (error.status === 401 && error.code !== 'PASSWORD_REAUTHENTICATION_FAILED') handleError(error); }
  finally { unlockPending = false; $('admin-reauth-submit').disabled = $('admin-reauth-cancel').disabled = false; }
});
$('admin-reauth-cancel').addEventListener('click', cancelUnlock);
unlockDialog.addEventListener('cancel', event => { event.preventDefault(); cancelUnlock(); });
$('admin-unlock').addEventListener('click', () => ensureUnlocked().then(() => notify('Administrative actions unlocked.')).catch(error => notify(error.message)));

function fieldElement(spec) {
  const holder = node('div', 'mb-4'); const id = `admin-field-${spec.name}`;
  if (spec.type === 'checkbox') {
    const caption = node('label', 'flex items-start gap-3 text-sm'); const input = node('input', 'mb-0 mt-1 h-4 w-4 shrink-0 accent-lime'); input.type = 'checkbox'; input.name = spec.name; input.id = id; input.required = spec.required === true; caption.append(input, document.createTextNode(spec.label)); holder.append(caption); return holder;
  }
  const caption = node('label', 'mb-2 block text-xs font-semibold', spec.label); caption.htmlFor = id;
  const input = spec.choices ? selectInput(spec.name, spec.choices, spec.value ?? '') : node(spec.type === 'textarea' ? 'textarea' : 'input');
  input.name = spec.name; input.id = id; input.required = spec.required !== false;
  if (!spec.choices && spec.type !== 'textarea') input.type = spec.type || 'text';
  if (spec.type === 'file') input.accept = '.pdf,.txt,application/pdf,text/plain';
  else if (!spec.choices) input.value = spec.value ?? '';
  if (spec.type === 'number') { if (spec.min !== undefined) input.min = String(spec.min); if (spec.max !== undefined) input.max = String(spec.max); if (spec.step !== undefined) input.step = String(spec.step); }
  if (spec.type === 'textarea') { input.rows = 4; input.maxLength = spec.maxLength || 2000; } else if (spec.type !== 'file') input.maxLength = spec.maxLength || 254;
  if (spec.placeholder) input.placeholder = spec.placeholder;
  holder.append(caption, input); if (spec.help) holder.append(node('p', 'text-xs text-muted', spec.help)); return holder;
}
const reasonField = { name: 'reason', label: 'Reason for this administrative change', type: 'textarea', maxLength: 500, help: 'This reason is recorded in the audit trail. Do not include passwords or authentication codes.' };
async function openAction({ title, description, fields, submit = 'Save change', execute }) {
  if (writing) return;
  try { await ensureUnlocked(); } catch (error) { notify(error.message); return; }
  activeAction = { execute };
  $('admin-action-title').textContent = title; $('admin-action-description').textContent = description;
  $('admin-action-fields').replaceChildren(...fields.map(fieldElement)); $('admin-action-submit').textContent = submit; $('admin-action-status').textContent = '';
  actionDialog.showModal(); $('admin-action-fields').querySelector('input,select,textarea')?.focus();
}
function closeAction() { if (writing) return; activeAction = null; if (actionDialog.open) actionDialog.close(); $('admin-action-fields').replaceChildren(); }
$('admin-action-cancel').addEventListener('click', closeAction);
actionDialog.addEventListener('cancel', event => { if (writing) event.preventDefault(); else activeAction = null; });
$('admin-action-form').addEventListener('submit', async event => {
  event.preventDefault(); if (writing || !activeAction || !$('admin-action-form').reportValidity()) return;
  writing = true; $('admin-action-submit').disabled = $('admin-action-cancel').disabled = true;
  const action = activeAction; const data = new FormData($('admin-action-form')); $('admin-action-status').textContent = 'Submitting your audited change…';
  try {
    await ensureUnlocked();
    const result = await action.execute(data);
    writing = false; closeAction(); notify(result?.message || 'Your change was saved and recorded in the audit trail.', true);
    if (await refreshAccess()) await loadCurrent();
  } catch (error) {
    if (error.code === 'ADMIN_REAUTH_REQUIRED') privilegesExpiresAt = 0;
    $('admin-action-status').textContent = error.message || 'Your change could not be completed.';
    if (error.status === 401 && error.code !== 'PASSWORD_REAUTHENTICATION_FAILED') handleError(error);
  } finally { writing = false; $('admin-action-submit').disabled = $('admin-action-cancel').disabled = false; updatePrivilegeStatus(); }
});
async function post(endpoint, data) {
  try { return await api(endpoint, data); } catch (error) { if (error.code === 'ADMIN_REAUTH_REQUIRED') { privilegesExpiresAt = 0; updatePrivilegeStatus(); } throw error; }
}
function reloadPage(offset = 0) { pageQuery.offset = offset; return loadCurrent(); }
function traderButton(row) { return button(`${row.name || 'Trader'} · #${row.id}`, () => { currentTraderId = row.id; section = 'traders'; pageQuery = {}; navigation(); loadCurrent(); }, 'text-left text-xs font-semibold text-lime underline underline-offset-4'); }
const traderColumns = [
  { title: 'Trader', value: traderButton }, { title: 'Email', value: row => row.email }, { title: 'Access', value: row => badge(row.accountStatus, row.accountStatus === 'active') },
  { title: 'Assessment', value: row => badge(row.assessment?.status, row.assessment?.status === 'passed') }, { title: 'Realized return', value: row => percent(row.assessment?.returnPercent) },
  { title: 'Trading days', value: row => row.assessment?.tradingDays ?? 0 }, { title: 'Email', value: row => row.emailVerified ? 'Confirmed' : 'Pending' }, { title: 'Agreement', value: row => label(row.contractStatus) },
];
const traderFilters = [ {name:'search',label:'Find by name or email'}, {name:'status',label:'Account access',choices:[['','All accounts'],['active','Active'],['suspended','Suspended']]}, {name:'emailStatus',label:'Email ownership',choices:[['','All email states'],['confirmed','Confirmed'],['pending','Pending']]}, {name:'assessmentStatus',label:'Assessment',choices:[['','All assessments'],['running','Running'],['passed','Passed'],['failed','Failed'],['locked','Locked'],['legacy','Legacy']]} ];

async function renderOverview(epoch) {
  const data = await api('/api/admin/overview'); if (epoch !== requestEpoch) return;
  const metrics = data.metrics || {}; const cards = node('div', 'grid gap-4 sm:grid-cols-2 xl:grid-cols-4');
  for (const [title, value, help] of [ ['Registered traders', metrics.totalTraders, 'Saved academy profiles'], ['Active assessments', metrics.activeAssessments, 'Current qualification attempts'], ['Qualified traders', metrics.qualifiedTraders, 'Recorded qualifying results'], ['Current signatures', metrics.currentSignatures, 'Active agreement version'], ['Pending email', metrics.unconfirmedEmails, 'Ownership not yet confirmed'], ['Certificates issued', metrics.certificates, 'Historical completion records'], ['Waiting for support', data.support?.waiting, 'Human handoff queue'], ['Reviews pending', data.reviews?.pending_review, 'Sponsorship review records'] ]) {
    const item = card(); item.append(node('p', 'metric-label', title), node('p', 'mb-2 text-3xl font-semibold tracking-tight', Number.isFinite(value) ? value.toLocaleString() : 'Not recorded'), node('p','text-xs text-muted',help)); cards.append(item);
  }
  content.append(cards);
  const row = node('div','grid gap-6 xl:grid-cols-2'); const trend = card('Activity over time', 'Counts from saved registrations and qualifying certificates. No synthetic activity is added.');
  const days = Array.isArray(data.daily) ? data.daily : [];
  trend.append(table([{title:'UTC date',value:x=>x.date},{title:'Registrations',value:x=>x.registrations},{title:'Qualifying assessments',value:x=>x.qualifiedAssessments}],days)); row.append(trend);
  const work = card('Today’s work queues', 'Open a section to review the underlying records.');
  const actions = node('div','space-y-3'); for (const [target, text, permission] of [['traders','Review client profiles','traders.read'],['reviews','Review eligible traders','reviews.read'],['contracts','Inspect agreement versions','contracts.read'],['support','Open customer support','support.manage'],['payouts','Review recorded payouts','finance.read']]) if(can(permission)) actions.append(button(text+' →',()=>navigate(target),'block w-full rounded-lg border border-line px-4 py-3 text-left text-sm hover:bg-lime/10'));
  work.append(actions,node('p','mt-5 text-xs text-muted',`Updated ${date(data.generatedAt)}. Assessment valuations are saved reference snapshots.`));row.append(work);content.append(row);
}
async function renderTraders(epoch, assessments = false) {
  if (currentTraderId && !assessments) return renderTraderDetail(epoch, currentTraderId);
  const endpoint = assessments ? '/api/admin/assessments' : '/api/admin/traders'; const data = await api(endpoint+queryString({limit:25,...pageQuery})); if(epoch!==requestEpoch)return;
  const page = pageRows(data); const sectionCard=card(assessments?'Assessment monitor':'Trader directory', assessments?'Results and trades are read-only. Paper balances cannot be withdrawn.':'Open a trader to inspect qualification, agreements, internal notes, and account access.');
  sectionCard.append(filters(traderFilters,pageQuery,values=>{pageQuery={...values,offset:0};loadCurrent();}),table(traderColumns,page.items),pageNavigation(page,reloadPage)); content.append(sectionCard);
}
function positionRows(rows) { return Array.isArray(rows) ? rows : []; }
async function renderTraderDetail(epoch, id) {
  const data = await api(`/api/admin/traders/${encodeURIComponent(id)}${queryString({tradeLimit:25,tradeOffset:pageQuery.tradeOffset||0})}`); if(epoch!==requestEpoch)return;
  const trader = data.trader || data; const assessment = trader.assessment || {};
  content.append(toolbar(button('← Back to traders',()=>{currentTraderId=null;pageQuery={};loadCurrent();}),node('p','text-xs text-muted',`Client #${trader.id}`)));
  const identity = card(trader.name || 'Trader',trader.email); identity.append(detailGrid([['Account access',label(trader.accountStatus)],['Email ownership',trader.emailVerified?'Confirmed':'Unconfirmed'],['Trading interest',trader.market||'Not recorded'],['Joined',date(trader.createdAt)],['Two-factor authentication',trader.twoFactorEnabled?'Enabled':'Not enabled'],['Active sessions',trader.sessionCount??'Not recorded']]));
  const actions=node('div','mt-5 flex flex-wrap gap-3');
  if(can('traders.manage')) {
    const suspended=trader.accountStatus==='suspended';actions.append(button(suspended?'Reactivate account':'Suspend account',()=>openAction({title:suspended?'Reactivate this account?':'Suspend this account?',description:suspended?'Restore account access. Earlier records remain unchanged.':'Sign out this trader and block account access. Background protective trading checks continue; saved records are retained.',fields:[reasonField],submit:suspended?'Reactivate account':'Suspend account',execute:form=>post(`/api/admin/traders/${trader.id}/status`,{status:suspended?'active':'suspended',reason:form.get('reason')})})),button('Sign out all sessions',()=>openAction({title:'Revoke this trader’s sessions?',description:'Existing sessions and pending sign-in requests will lose access. This does not change the password or disable two-factor authentication.',fields:[reasonField],submit:'Revoke sessions',execute:form=>post(`/api/admin/traders/${trader.id}/revoke-sessions`,{reason:form.get('reason')})})));
  }
  if(can('reviews.read'))actions.append(button('Open sponsorship review',()=>{section='reviews';currentTraderId=null;pageQuery={search:trader.email};navigation();loadCurrent();}));identity.append(actions);content.append(identity);
  const snapshot=card('Assessment snapshot','Saved reference-priced account data. This panel does not change qualification results.');snapshot.append(detailGrid([['Status',label(assessment.status)],['Balance',money(assessment.balance)],['Equity snapshot',money(assessment.equity)],['Realized result',money(assessment.realizedProfit)],['Return',percent(assessment.returnPercent)],['Trading days',assessment.tradingDays??0],['Open positions',assessment.openPositions??0],['Pending orders',assessment.pendingOrders??0],['Last valuation',date(assessment.lastValuationAt)]]));if(assessment.lockedReason)snapshot.append(node('p','mt-5 text-xs text-muted',assessment.lockedReason));content.append(snapshot);
  const trades=card('Trading records','Server-recorded simulation fills and currently saved positions.');
  for(const [title,rows] of [['Open positions',positionRows(trader.positions)],['Pending orders',positionRows(trader.pendingOrders)],['Closed trade history',trader.tradeHistory?.items||[]]]) {trades.append(node('h3','mb-3 mt-5 text-sm',title),table([{title:'ID',value:x=>x.id},{title:'Market',value:x=>x.symbol},{title:'Side',value:x=>label(x.side)},{title:'Volume',value:x=>x.lots??x.quantity??'—'},{title:'Entry / limit',value:x=>x.entryPrice??x.entry??x.limitPrice??x.price??'—'},{title:'Result (USD)',value:x=>Number.isFinite(x.realizedProfit)?money(x.realizedProfit):title==='Closed trade history'?'Not recorded':'Open / pending'},{title:'Time',value:x=>date(x.closedAt??x.openedAt??x.createdAt)}],rows));}
  if(trader.tradeHistory)trades.append(pageNavigation(pageRows(trader.tradeHistory),offset=>{pageQuery.tradeOffset=offset;loadCurrent();}));content.append(trades);
  const certs=card('Certificates & signed agreements');certs.append(table([{title:'Certificate',value:x=>x.holder||x.id},{title:'Return',value:x=>percent(x.profitPercent)},{title:'Days',value:x=>x.tradingDays},{title:'Issued',value:x=>date(x.issuedAt)}],trader.certificates||[]));certs.append(node('h3','my-4 text-sm','Agreement signatures'),table([{title:'Version',value:x=>x.contractVersion??x.version},{title:'Legal name',value:x=>x.legalName},{title:'Signed',value:x=>date(x.signedAt)}],trader.agreements||[]));content.append(certs);
  const notes=card('Internal notes','Visible to authorized academy staff. Do not include passwords, access codes, or private account credentials.');if(can('reviews.write'))notes.append(toolbar(button('Add internal note',()=>openAction({title:'Add an internal note',description:'This note remains in the internal record and audit trail. It is not sent to the trader.',fields:[{name:'text',label:'Note',type:'textarea',maxLength:2000},reasonField],submit:'Save note',execute:form=>post(`/api/admin/traders/${trader.id}/notes`,{text:form.get('text'),reason:form.get('reason')})}))));notes.append(table([{title:'Note',value:x=>x.text??x.note},{title:'Added by',value:x=>x.authorName??x.actorName??'Staff'},{title:'Recorded',value:x=>date(x.createdAt)}],trader.notes||[]));content.append(notes);
}
async function renderCertificates(epoch) {
  const data=await api('/api/admin/certificates'+queryString({limit:25,...pageQuery}));if(epoch!==requestEpoch)return;const page=pageRows(data);const area=card('Completion certificates','Certificate names and snapshots are preserved. Downloading does not approve sponsorship.');
  area.append(filters([{name:'search',label:'Find trader or certificate holder'},{name:'userId',label:'Client ID',type:'number'}],pageQuery,values=>{pageQuery={...values,offset:0};loadCurrent();}),table([{title:'Trader',value:x=>`${x.traderName||''} · #${x.userId}`},{title:'Holder',value:x=>x.holder},{title:'Return',value:x=>percent(x.profitPercent)},{title:'Trading days',value:x=>x.tradingDays},{title:'Issued',value:x=>date(x.issuedAt)},{title:'Basis',value:x=>x.qualified?'Reference-qualified':label(x.priceMode)},{title:'Document',value:x=>link('Download SVG',x.downloadUrl)}],page.items),pageNavigation(page,reloadPage));content.append(area);
}
async function filePayload(file) {
  if(!(file instanceof File)||!file.size||file.size>10*1024*1024)throw new Error('Select a PDF or UTF-8 text agreement of at most 10 MB.');
  const name=file.name.toLowerCase();if(!name.endsWith('.pdf')&&!name.endsWith('.txt'))throw new Error('Select a .pdf or .txt agreement.');
  const buffer=await file.arrayBuffer();const bytes=new Uint8Array(buffer);let binary='';for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return{fileName:file.name,format:name.endsWith('.pdf')?'pdf':'text',contentBase64:btoa(binary)};
}
async function renderContracts(epoch) {
  const data=await api('/api/admin/contracts'+queryString({limit:25,...pageQuery}));if(epoch!==requestEpoch)return;const page=pageRows(data);const current=card('Current required agreement',data.active?'Publishing a new version requires eligible traders to read and sign that version before new sponsorship approval.':'The academy has not published an agreement. No substitute terms are generated by this dashboard.');
  if(data.active)current.append(detailGrid([['Title',data.active.title],['Version',data.active.version],['Published',date(data.active.publishedAt)],['SHA-256',data.active.hash]]),link('Open current document',data.active.documentUrl));
  if(can('contracts.publish'))current.append(node('div','mt-5'),button('Publish academy agreement',()=>openAction({title:'Publish the company-provided agreement',description:'Upload the actual authorized PDF or UTF-8 text. Publishing creates an immutable version and makes it the required agreement. It does not sign on a trader’s behalf.',fields:[{name:'title',label:'Document title',maxLength:160,value:'Fundraiser Academy Trader Agreement'},{name:'version',label:'Unique version',placeholder:'e.g. 2026-01',maxLength:80},{name:'file',label:'Actual agreement document',type:'file'},reasonField,{name:'authorized',label:'I am authorized to publish this document as the academy’s required agreement.',type:'checkbox',required:true}],submit:'Publish required agreement',execute:async form=>post('/api/admin/contracts',{title:form.get('title'),version:form.get('version'),...await filePayload(form.get('file')),reason:form.get('reason')})})));content.append(current);
  const history=card('Published versions');history.append(table([{title:'Title',value:x=>x.title},{title:'Version',value:x=>x.version},{title:'Required',value:x=>x.active?'Current':'Historical'},{title:'Signed',value:x=>x.signatureCount??0},{title:'Published',value:x=>date(x.publishedAt)},{title:'Document',value:x=>link('Open document',x.documentUrl)}],page.items),pageNavigation(page,reloadPage));content.append(history);
  const signatures=data.signatures;if(signatures){const area=card('Recorded signatures','Immutable signatures bind the document version, hash, and qualifying certificate.');const p=pageRows(signatures);area.append(table([{title:'Trader',value:x=>`${x.traderName} · #${x.userId}`},{title:'Legal name',value:x=>x.legalName},{title:'Version',value:x=>x.contractVersion},{title:'Signed at',value:x=>date(x.signedAt)},{title:'Certificate',value:x=>x.certificateId}],p.items));content.append(area);}
}
async function renderReviews(epoch) {
  const query={limit:25,...pageQuery};
  const data=await api('/api/admin/reviews'+queryString(query));if(epoch!==requestEpoch)return;const page=pageRows(data,Array.isArray(data.items)?'items':'entries');const area=card('Sponsorship review queue','Eligibility is checked against the current agreement and its exact qualifying certificate. Approved reviews still require external account arrangements.');
  area.append(filters([{name:'search',label:'Find by name or email'},{name:'status',label:'Review status',choices:[['','All reviews'],['pending_review','Pending review'],['needs_information','Needs information'],['approved','Approved'],['rejected','Rejected'],['stale','Changed agreement / stale']]}],pageQuery,values=>{pageQuery={...values,offset:0};loadCurrent();}),table([{title:'Trader',value:x=>button(`${x.name} · #${x.userId}`,()=>reviewAction(x),'text-left text-xs font-semibold text-lime underline underline-offset-4')},{title:'Email',value:x=>x.email},{title:'Review',value:x=>badge(x.stale?'Stale':x.status,x.status==='approved'&&!x.stale)},{title:'Eligibility',value:x=>label(x.eligibility?.status)},{title:'Agreement',value:x=>x.contractVersion||'Not signed'},{title:'Updated',value:x=>date(x.updatedAt)},{title:'Action',value:x=>can('reviews.write')?button('Review decision',()=>reviewAction(x)):node('span','text-muted','Read only')}],page.items),pageNavigation(page,reloadPage));content.append(area);
}
function reviewAction(item) {
  if(!can('reviews.write')){notify(`Client #${item.userId}: ${label(item.status)}. ${item.clientMessage||''}`);return;}
  openAction({title:`Review sponsorship · ${item.name||'Client #'+item.userId}`,description:`Current eligibility: ${label(item.eligibility?.status)}. Agreement: ${item.contractVersion||'not signed'}. An approval is a review decision; it does not issue a prop account or transfer funds.`,fields:[{name:'status',label:'Review decision',choices:[['','Choose a decision'],['pending_review','Pending review'],['needs_information','Needs information'],['approved','Approve sponsorship review'],['rejected','Reject review']],value:['pending_review','needs_information','approved','rejected'].includes(item.status)?item.status:''},{name:'clientMessage',label:'Message visible to this trader',type:'textarea',required:false,maxLength:500,value:item.clientMessage||'',help:'Keep internal notes and sensitive evidence out of this message.'},reasonField],submit:'Record review decision',execute:form=>post(`/api/admin/reviews/${item.userId}`,{status:form.get('status'),clientMessage:form.get('clientMessage'),reason:form.get('reason'),expectedRevision:item.revision,expectedContractId:item.contractId,expectedCertificateId:item.certificateId})});
}
const policyNames={cumulative_high_water:'Cumulative high-water profit share',settled_period:'Externally settled period profit share'};
function createAccountAction() {
  openAction({title:'Record a sponsored external account',description:'Record an account arranged externally after an approved review. Enter the actual agreed terms. No prop-firm purchase, deposit, or funding instruction is sent.',fields:[{name:'userId',label:'Approved trader client ID',type:'number',min:1,step:1},{name:'firmName',label:'Prop firm name',maxLength:160},{name:'label',label:'Account label',maxLength:160,help:'Use a descriptive label, not passwords, login keys, or access credentials.'},{name:'accountSize',label:'Nominal account size (USD)',type:'number',min:0.01,step:0.01,help:'This is account allocation, not company cash spent or deposited.'},{name:'traderShare',label:'Agreed trader profit share (%)',type:'number',min:0,max:100,step:0.01},{name:'profitSharingPolicy',label:'Profit-sharing policy in the signed terms',choices:[['','Choose the agreed policy'],['cumulative_high_water',policyNames.cumulative_high_water],['settled_period',policyNames.settled_period]],help:'High-water sharing recovers earlier losses before new shares accrue. Settled-period sharing requires an externally settled period attestation.'},{name:'evidence',label:'Agreement / external account evidence',type:'textarea',maxLength:2000,help:'Record an appropriate reference and operating notes. Do not add credentials or bank details.'},reasonField],submit:'Save external account record',execute:form=>post('/api/admin/accounts',{userId:positiveInteger(form.get('userId'),'client ID'),firmName:form.get('firmName'),label:form.get('label'),accountSizeCents:decimalToUnits(form.get('accountSize')),traderShareBps:decimalToUnits(form.get('traderShare'),{maximum:10000}),profitSharingPolicy:form.get('profitSharingPolicy'),evidence:form.get('evidence'),reason:form.get('reason')})});
}
async function renderAccounts(epoch) {
  if(currentAccountId)return renderAccountDetail(epoch,currentAccountId);
  const data=await api('/api/admin/accounts'+queryString({limit:25,...pageQuery}));if(epoch!==requestEpoch)return;const page=pageRows(data,Array.isArray(data.items)?'items':'accounts');const area=card('Sponsored external accounts','Manual records linked to approved reviews. These records are not a live prop-firm performance or balance feed.');
  if(can('finance.write'))area.append(toolbar(button('Record sponsored account',createAccountAction)));
  area.append(filters([{name:'search',label:'Find account or trader'},{name:'status',label:'Account status',choices:[['','All accounts'],['active','Active'],['paused','Paused'],['closed','Closed']]}],pageQuery,values=>{pageQuery={...values,offset:0};loadCurrent();}),table([{title:'Account',value:x=>button(x.label||x.id,()=>{currentAccountId=x.id;loadCurrent();},'text-left text-xs font-semibold text-lime underline underline-offset-4')},{title:'Trader',value:x=>`${x.traderName||''} · #${x.userId}`},{title:'Firm',value:x=>x.firmName},{title:'Nominal account size',value:x=>cents(x.accountSizeCents)},{title:'Trader share',value:x=>percent(x.traderShareBps/100)},{title:'Status',value:x=>badge(x.status,x.status==='active')},{title:'Available recorded share',value:x=>cents(x.availableCents)}],page.items),pageNavigation(page,reloadPage));content.append(area);
}
async function renderAccountDetail(epoch,id) {
  const data=await api(`/api/admin/accounts/${encodeURIComponent(id)}`);if(epoch!==requestEpoch)return;const account=data.account;
  if(!account||typeof account!=='object')throw new Error('The sponsored account could not be read.');
  content.append(toolbar(button('← Back to sponsored accounts',()=>{currentAccountId=null;loadCurrent();}),node('p','text-xs text-muted','Manual external account record')));
  const area=card(account.label,`${account.firmName} · ${account.traderName||'Client #'+account.userId}`);
  area.append(detailGrid([['Status',label(account.status)],['Nominal account allocation',cents(account.accountSizeCents)],['Agreed trader share',percent(account.traderShareBps/100)],['Profit-sharing policy',policyNames[account.profitSharingPolicy]||label(account.profitSharingPolicy)],['Cumulative recorded result',cents(account.cumulativeNetProfitCents)],['High-water recorded profit',cents(account.highWaterProfitCents)],['Earned recorded trader share',cents(account.earnedCents)],['Reserved for payouts',cents(account.reservedCents)],['Recorded paid',cents(account.paidCents)],['Available recorded share',cents(account.availableCents)],['Agreement version',account.review?.contractVersion||'Not recorded'],['Created',date(account.createdAt)]]));
  area.append(node('p','mt-5 text-xs text-muted',account.profitSharingPolicy==='cumulative_high_water'?'Under the selected high-water policy, earlier losses must be recovered before a new profit share accrues. Existing earned shares are not turned into trader debt.':'Positive periods must be externally settled before they are recorded under the selected policy. Losses remain company-borne under the agreement.'));
  if(can('finance.write')){
    const actions=node('div','mt-5 flex flex-wrap gap-3');if(account.status!=='closed')actions.append(button('Update account status',()=>openAction({title:'Update external account record',description:'Record the operational status of this external account. Account size and agreed financial terms are immutable.',fields:[{name:'status',label:'Recorded account status',choices:[['active','Active'],['paused','Paused'],['closed','Closed']],value:account.status},reasonField],submit:'Save recorded status',execute:form=>post(`/api/admin/accounts/${account.id}`,{status:form.get('status'),revision:account.revision,reason:form.get('reason')})})),button('Record profit / loss statement',()=>statementAction(account)));actions.append(button('Create payout record',()=>payoutAction(account)));area.append(actions);
  }
  content.append(area);
  const statements=card('Manual profit statements','Immutable external statement records. A statement is not a provider-verified live price or balance feed.');statements.append(table([{title:'Reference',value:x=>x.externalReference},{title:'Period',value:x=>[x.periodStart,x.periodEnd].filter(Boolean).join(' → ')||'Not recorded'},{title:'Net result',value:x=>cents(x.netProfitCents)},{title:'Trader share',value:x=>cents(x.traderShareCents)},{title:'Company share',value:x=>cents(x.companyShareCents)},{title:'Evidence',value:x=>x.evidence},{title:'Recorded',value:x=>date(x.createdAt)}],data.statements||[]));content.append(statements);
  const payouts=card('Account payout records','Payment status is recorded by authorized staff after external actions. This website does not transfer money.');payouts.append(payoutTable(data.payouts||[]));content.append(payouts);
}
function statementAction(account) {
  const settled=account.profitSharingPolicy==='settled_period';
  const fields=[{name:'netProfit',label:'Externally recorded net profit / loss (USD)',type:'number',step:0.01,help:'Use a negative amount for a loss. This does not create a debt owed by the trader.'},{name:'externalReference',label:'Unique external statement reference',maxLength:160},{name:'periodStart',label:'Statement period starts (UTC date)',type:'date',required:settled},{name:'periodEnd',label:'Statement period ends (UTC date)',type:'date',required:settled},{name:'evidence',label:'Statement evidence / reconciliation notes',type:'textarea',maxLength:2000}];
  if(settled)fields.push({name:'externalSettlementConfirmed',label:'I confirm this profit period was settled externally under the signed terms.',type:'checkbox',required:true});fields.push(reasonField);
  openAction({title:'Record an external profit statement',description:`Policy: ${policyNames[account.profitSharingPolicy]||label(account.profitSharingPolicy)}. Entries are immutable. Check the reference, amount, period, and evidence before saving.`,fields,submit:'Record manual statement',execute:form=>post(`/api/admin/accounts/${account.id}/statements`,{netProfitCents:decimalToUnits(form.get('netProfit'),{allowNegative:true}),externalReference:form.get('externalReference'),periodStart:form.get('periodStart')||undefined,periodEnd:form.get('periodEnd')||undefined,evidence:form.get('evidence'),...(settled?{externalSettlementConfirmed:form.get('externalSettlementConfirmed')==='on'}:{}),reason:form.get('reason')})});
}
function payoutAction(account) {
  openAction({title:'Create a manual payout record',description:`Available recorded trader share: ${cents(account.availableCents)}. This reserves an amount for review; it does not send money.`,fields:[{name:'amount',label:'Payout amount (USD)',type:'number',min:0.01,step:0.01},reasonField],submit:'Create payout record',execute:form=>post('/api/admin/payouts',{accountId:account.id,amountCents:decimalToUnits(form.get('amount')),reason:form.get('reason')})});
}
function payoutTable(items) {
  return table([{title:'Trader / account',value:x=>`${x.traderName||'Client #'+x.userId} · ${x.label||x.accountId}`},{title:'Amount',value:x=>cents(x.amountCents)},{title:'Status',value:x=>badge(x.status,x.status==='paid')},{title:'Payment reference',value:x=>x.externalPaymentReference||'Not recorded'},{title:'Paid externally',value:x=>date(x.paidAt)},{title:'Recorded',value:x=>date(x.createdAt)},{title:'Action',value:x=>can('finance.write')&&['requested','approved'].includes(x.status)?button(x.status==='requested'?'Review payout':'Record payment / reject',()=>updatePayoutAction(x)):node('span','text-muted','Immutable record')}],items);
}
function updatePayoutAction(item) {
  const choices=item.status==='requested'?[['','Choose a decision'],['approved','Approve payout record'],['rejected','Reject payout record']]:[['','Choose an external outcome'],['paid','Record an external payment'],['rejected','Reject / release reservation']];
  openAction({title:'Update manual payout record',description:`${cents(item.amountCents)} for ${item.traderName||'Client #'+item.userId}. Recording “paid” requires a real external payment reference and does not initiate a transfer.`,fields:[{name:'status',label:'New recorded status',choices},{name:'externalPaymentReference',label:'External payment reference (required when recording paid)',required:false,maxLength:160,help:'Record the completed external transaction reference. Do not add bank login or card details.'},reasonField],submit:'Save payout record',execute:form=>{const status=form.get('status'),reference=String(form.get('externalPaymentReference')||'').trim();if(status==='paid'&&!reference)throw new Error('Enter the external payment reference before recording this payout as paid.');return post(`/api/admin/payouts/${item.id}`,{status,revision:item.revision,...(reference?{externalPaymentReference:reference}:{}),reason:form.get('reason')});}});
}
async function renderPayouts(epoch) {
  const data=await api('/api/admin/payouts'+queryString({limit:25,...pageQuery}));if(epoch!==requestEpoch)return;const page=pageRows(data,Array.isArray(data.items)?'items':'payouts');const area=card('Manual payout ledger','Requested and approved entries reserve recorded shares. Mark paid only after an external payment is completed. No bank transfer is initiated here.');
  area.append(filters([{name:'search',label:'Find account or trader'},{name:'status',label:'Payout status',choices:[['','All statuses'],['requested','Requested'],['approved','Approved'],['paid','Paid externally'],['rejected','Rejected']]}],pageQuery,values=>{pageQuery={...values,offset:0};loadCurrent();}),payoutTable(page.items),pageNavigation(page,reloadPage));content.append(area);
  const help=card('Profit statement entry','Open a sponsored account to record immutable profit / loss statements, inspect the selected sharing policy, or create a payout against the available recorded share.');help.append(button('Open sponsored accounts →',()=>navigate('accounts')));content.append(help);
}
async function renderSupport(epoch) {
  const data=await api('/api/admin/support'+queryString(pageQuery));if(epoch!==requestEpoch)return;
  const area=card('Human support requests','The support inbox contains the saved transcript and the controls to claim, reply, and close a conversation.');area.append(toolbar(link('Open support inbox →','/support-agent.html','button'),node('p','text-xs text-muted','Agent availability is not inferred from an open page.')));
  area.append(filters([{name:'status',label:'Queue',choices:[['active','Active requests'],['waiting','Waiting'],['assigned','Assigned'],['closed','Closed']]}],pageQuery,values=>{pageQuery=values;loadCurrent();}),table([{title:'Client',value:x=>x.client?.name||'Client'},{title:'Email',value:x=>x.client?.email||'Not recorded'},{title:'Status',value:x=>badge(x.status,x.status==='assigned')},{title:'Assigned agent',value:x=>x.assignedAgentName||'Unassigned'},{title:'Latest message',value:x=>typeof x.preview==='string'?x.preview.slice(0,160):'No message preview'},{title:'Updated',value:x=>date(x.updatedAt)}],Array.isArray(data.conversations)?data.conversations:[]));
  if(data.nextCursor)area.append(node('div','mt-5'),button('More conversations →',()=>{pageQuery.before=data.nextCursor;loadCurrent();}));content.append(area);
}
function downloadText(text,name,type='text/csv;charset=utf-8') {
  const url=URL.createObjectURL(new Blob([text],{type}));downloads.add(url);const anchor=node('a');anchor.href=url;anchor.download=name;document.body.append(anchor);anchor.click();anchor.remove();setTimeout(()=>{URL.revokeObjectURL(url);downloads.delete(url);},10000);
}
async function renderReports(epoch) {
  if(epoch!==requestEpoch)return;
  const area=card('Export operational records','Exports contain private account information. Use only the records needed for your work and store downloads securely. Each export is limited to 5,000 records; narrow filters if the result is larger.');
  const form=node('form','grid gap-4 sm:grid-cols-2');
  for(const spec of [{name:'type',label:'Report',choices:[['traders','Trader directory'],['assessments','Assessment snapshots'],['trades','Closed simulated trades'],['certificates','Completion certificates'],['contracts','Contract signatures']]},{name:'from',label:'From UTC date',type:'date',required:false},{name:'to',label:'Through UTC date',type:'date',required:false},{name:'userId',label:'Client ID (optional)',type:'number',min:1,step:1,required:false}])form.append(fieldElement(spec));
  const submit=node('button','button self-end','Generate CSV report');submit.type='submit';form.append(submit);const reportStatus=node('p','text-sm sm:col-span-2');reportStatus.setAttribute('role','status');const preview=node('div','mt-6 min-w-0');
  form.addEventListener('submit',async event=>{event.preventDefault();if(writing||!form.reportValidity())return;submit.disabled=true;try{await ensureUnlocked();const values=Object.fromEntries(new FormData(form));const result=await api('/api/admin/reports'+queryString({...values,limit:5000}));if(typeof result.csv!=='string'||!Array.isArray(result.headers)||!Array.isArray(result.rows))throw new Error('The report could not be read.');if(epoch!==requestEpoch)return;const returned=result.returned??result.rows.length;reportStatus.textContent=`${returned} of ${result.total??returned} records exported.${result.truncated?' This report is truncated: narrow the date or client filters to export the remaining records.':''}`;downloadText(result.csv,csvDownloadName(values.type));preview.replaceChildren(node('h3','mb-3 text-sm','First 20 exported records'),table(result.headers.map((header,index)=>({title:String(header),value:row=>row[index]})),result.rows.slice(0,20)));}catch(error){if(error.code==='ADMIN_REAUTH_REQUIRED')privilegesExpiresAt=0;reportStatus.textContent=error.message;handleError(error,{local:true});}finally{submit.disabled=false;updatePrivilegeStatus();}});
  area.append(form,reportStatus,preview);content.append(area);
}
async function renderStaff(epoch) {
  const data=await api('/api/admin/staff');if(epoch!==requestEpoch)return;const raw=Array.isArray(data.staff)?data.staff:Array.isArray(data.items)?data.items:[];const area=card('Administrative roles','Only eligible, verified accounts with two-factor authentication can receive a role. Environment-managed owner access must be changed in server configuration.');
  area.append(toolbar(button('Assign a staff role',()=>openAction({title:'Assign administrative access',description:'Choose the minimum permission level needed. The target must already have a verified email and two-factor authentication enabled. The server protects existing owners from lockout.',fields:[{name:'userId',label:'Registered client ID',type:'number',min:1,step:1},{name:'role',label:'Administrative role',choices:[['','Choose a role'],['support','Support: inbox access'],['reviewer','Reviewer: qualification and sponsorship review'],['admin','Admin: academy operations'],['owner','Owner: operations and staff permissions']]},reasonField],submit:'Assign role',execute:form=>post('/api/admin/staff/grant',{userId:positiveInteger(form.get('userId'),'client ID'),role:form.get('role'),reason:form.get('reason')})}))));
  area.append(table([{title:'Account',value:x=>`${x.name} · #${x.id??x.userId}`},{title:'Email',value:x=>x.email},{title:'Role',value:x=>badge(x.role,x.role==='owner')},{title:'Eligibility',value:x=>x.eligible?'Verified + 2FA':!x.emailVerified?'Email not confirmed':!x.twoFactorEnabled?'2FA not enabled':'Unavailable'},{title:'Source',value:x=>x.environmentManaged?'Server configuration':'Assigned role'},{title:'Granted',value:x=>date(x.grantedAt)},{title:'Action',value:x=>x.environmentManaged?node('span','text-muted','Configuration-managed'):button('Revoke role',()=>openAction({title:'Revoke administrative access?',description:`${x.name||x.email} will lose the assigned administrative role. This does not delete the client account or its trading records.`,fields:[reasonField],submit:'Revoke role',execute:form=>post('/api/admin/staff/revoke',{userId:x.id??x.userId,reason:form.get('reason')})}))}],raw));content.append(area);
}
async function renderAudit(epoch) {
  const data=await api('/api/admin/audit'+queryString({limit:25,...pageQuery}));if(epoch!==requestEpoch)return;const page=pageRows(data,Array.isArray(data.items)?'items':'entries');const area=card('Administrative audit trail','Reasons and action details are retained as append-only records. No edit or delete action is provided.');
  area.append(filters([{name:'actorId',label:'Staff client ID',type:'number'},{name:'targetId',label:'Target client ID',type:'number'},{name:'action',label:'Action name'}],pageQuery,values=>{pageQuery={...values,offset:0};loadCurrent();}),table([{title:'Recorded',value:x=>date(x.createdAt)},{title:'Staff',value:x=>x.actorName||`User #${x.actorId??'operator'}`},{title:'Action',value:x=>x.action},{title:'Target',value:x=>x.targetName||x.targetId||'Academy'},{title:'Reason',value:x=>x.reason},{title:'Details',value:x=>{const details=node('details');details.append(node('summary','cursor-pointer text-lime','Inspect'));const pre=node('pre','mt-3 max-w-lg whitespace-pre-wrap break-all text-[10px] text-muted',JSON.stringify(x.detail||{},null,2));details.append(pre);return details;}}],page.items),pageNavigation(page,reloadPage));content.append(area);
}
function objectDetails(value,depth=0) {
  const list=node('dl','space-y-3 text-sm');if(!value||typeof value!=='object')return node('p','text-sm text-muted',String(value??'Not recorded'));
  for(const [key,item]of Object.entries(value).slice(0,50)){const row=node('div','min-w-0 border-b border-line pb-3');row.append(node('dt','metric-label mb-1',label(key.replace(/([a-z])([A-Z])/g,'$1 $2'))));if(item&&typeof item==='object'&&depth<2)row.append(objectDetails(item,depth+1));else row.append(node('dd','break-words',typeof item==='boolean'?(item?'Yes':'No'):item===null?'Not recorded':typeof item==='object'?JSON.stringify(item):String(item)));list.append(row);}return list;
}
async function renderSystem(epoch) {
  const data=await api('/api/admin/system');if(epoch!==requestEpoch)return;
  const integrations=card('Configured integrations','Configured credentials do not prove provider availability or delivery. Use the stated status and a controlled operational check.');integrations.append(table([{title:'Service',value:x=>x.name},{title:'Configuration',value:x=>x.configured===true?'Configured':x.configured===false?'Not configured':'Not reported'},{title:'Status',value:x=>label(x.status)},{title:'Detail',value:x=>x.description||'Not recorded'}],Array.isArray(data.integrations)?data.integrations:[]));content.append(integrations);
  const grid=node('div','grid gap-6 xl:grid-cols-2');for(const [title,value]of [['Application',data.application],['Security policy',data.security],['Storage & backups',data.storage],['Operating limits',data.limits],['Transactional mail queue',data.outbox]])if(value){const area=card(title);area.append(objectDetails(value));grid.append(area);}content.append(grid,node('p','text-xs text-muted',`Configuration snapshot: ${date(data.generatedAt)}. No API keys, encryption keys, or private server paths are shown.`));
}
const renderers={overview:renderOverview,traders:renderTraders,assessments:epoch=>renderTraders(epoch,true),certificates:renderCertificates,contracts:renderContracts,reviews:renderReviews,accounts:renderAccounts,payouts:renderPayouts,support:renderSupport,reports:renderReports,staff:renderStaff,audit:renderAudit,system:renderSystem};
function navigate(next) {
  if(writing)return;
  const entry=sections.find(item=>item[0]===next);if(!entry||!can(entry[2]))return;
  section=next;pageQuery={};currentTraderId=null;currentAccountId=null;navigation();loadCurrent();
}
async function loadCurrent() {
  if(!access||(access.authorized!==true&&access.eligible!==true))return;
  const entry=sections.find(item=>item[0]===section);if(!entry||!can(entry[2])){section=sections.find(item=>can(item[2]))?.[0]||'overview';navigation();}
  const selected=sections.find(item=>item[0]===section);$('admin-section-title').textContent=selected?.[1]||'Administration';$('admin-section-eyebrow').textContent=selected?.[3]||'ACADEMY OPERATIONS';$('admin-section-description').textContent=selected?.[4]||'';
  const epoch=++requestEpoch;loading=true;$('admin-refresh').disabled=true;content.replaceChildren(node('p','rounded-xl border border-line p-6 text-sm text-muted','Loading saved administrative records…'));notify('');
  try{const target=node('div');content.replaceChildren();await renderers[section](epoch);if(epoch===requestEpoch&&content.childElementCount===0)content.append(empty());}
  catch(error){if(epoch===requestEpoch){content.replaceChildren(empty('This section could not be loaded. Your records have not been replaced with example data.'));await handleError(error);}}
  finally{if(epoch===requestEpoch){loading=false;$('admin-refresh').disabled=false;}}
}
async function initialize() {
  $('admin-retry').hidden=true;$('admin-loading-message').textContent='Checking your administrative access…';
  try{if(await refreshAccess())await loadCurrent();}catch(error){if(error.status===401){clearPrivateView();window.location.replace('/login.html');return;}$('admin-loading-message').textContent=error.message||'Administrative access could not be checked.';$('admin-retry').hidden=false;}
}
$('admin-menu').addEventListener('click',()=>{const open=$('admin-menu').getAttribute('aria-expanded')==='true';$('admin-sidebar').classList.toggle('hidden',open);$('admin-nav-overlay').hidden=open;$('admin-menu').setAttribute('aria-expanded',String(!open));});
$('admin-menu-close').addEventListener('click',closeNavigation);$('admin-nav-overlay').addEventListener('click',closeNavigation);
$('admin-refresh').addEventListener('click',()=>{if(!writing)loadCurrent();});$('admin-retry').addEventListener('click',initialize);
$('admin-logout').addEventListener('click',async()=>{if(writing||unlockPending)return;try{const response=await fetch('/api/logout',{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json','X-Requested-With':'FundraiserAcademy'},body:'{}'});if(!response.ok&&response.status!==401)throw new Error('Sign-out could not be completed. Try again.');clearPrivateView();window.location.replace('/login.html');}catch(error){notify(error.message,true);}});
document.addEventListener('visibilitychange',()=>{if(document.hidden){$('admin-reauth-password').value=$('admin-reauth-code').value='';if(!unlockPending&&unlockDialog.open)cancelUnlock();}else updatePrivilegeStatus();});
window.addEventListener('pagehide',()=>{$('admin-reauth-password').value=$('admin-reauth-code').value='';privilegesExpiresAt=0;for(const url of downloads)URL.revokeObjectURL(url);downloads.clear();});
$('admin-year').textContent=String(new Date().getFullYear());setInterval(updatePrivilegeStatus,1000);initialize();
