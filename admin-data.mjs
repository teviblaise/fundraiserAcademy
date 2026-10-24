import { metrics } from './public/simulator.js';
import { contractConsentStatement, requiredContractDocument } from './contracts.mjs';

export class AdminDataError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}
const fail = message => { throw new AdminDataError(400, message); };
const finite = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const timestamp = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? value : null;
const text = (value, maximum = 200) => typeof value === 'string' ? value.slice(0, maximum) : '';
const userId = value => {
  const id = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(id) || id < 1) fail('Select a valid trader.');
  return id;
};
function integer(value, fallback, minimum, maximum, label) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) fail(`Select a valid ${label}.`);
  return value;
}
function pagination(query = {}, maximum = 100) {
  return { limit: integer(query.limit, 25, 1, maximum, 'page size'), offset: integer(query.offset, 0, 0, 1000000, 'page offset') };
}
function page(items, total, { limit, offset }) {
  return { items, total, limit, offset, nextOffset: offset + items.length < total ? offset + items.length : null };
}
function choose(value, allowed, fallback, label) {
  if (value === undefined || value === null || value === '' || value === 'all') return fallback;
  if (!allowed.includes(value)) fail(`Select a valid ${label}.`);
  return value;
}
function searchValue(value) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > 150 || /[\p{Cc}\p{Cf}]/u.test(value)) fail('Search must contain at most 150 characters without control characters.');
  return value.trim();
}
const like = value => `%${value.replace(/[\\%_]/g, '\\$&')}%`;
function parseState(raw) {
  try { const state = JSON.parse(raw); return state && typeof state === 'object' && !Array.isArray(state) ? state : null; } catch { return null; }
}
function assessmentStatus(state, hasAccount = true) {
  if (!hasAccount) return 'not_started';
  if (!state) return 'unavailable';
  if (state.migrationRequired || state.executionMode !== 'reference') return 'legacy';
  if (finite(state.initial) === null || state.initial <= 0 || finite(state.balance) === null || !Array.isArray(state.positions) || !Array.isArray(state.history) || !Array.isArray(state.tradingDays)) return 'unavailable';
  const days = new Set(state.tradingDays.filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))).size;
  if (state.locked === 'Profit target achieved' && state.positions.length === 0 && state.balance >= state.initial * 1.1 && days >= 3) return 'passed';
  if (state.locked === 'Total loss limit') return 'failed';
  return state.locked ? 'locked' : 'running';
}
function assessmentView(state, hasAccount, time) {
  const status = assessmentStatus(state, hasAccount);
  if (!state) return { status, valuationMode: 'persisted_reference', initialBalance: null, balance: null, realizedProfit: null, returnPercent: null, tradingDays: 0, openPositions: 0, pendingOrders: 0, closedTrades: 0, lockedReason: null, lastValuationAt: null, valuationCurrent: false, equity: null, floatingProfit: null };
  const initial = finite(state.initial), balance = finite(state.balance);
  const realizedProfit = initial === null || balance === null ? null : finite(balance - initial);
  let valuation = null;
  if (!['legacy', 'unavailable'].includes(status)) { try { valuation = metrics(state, time); } catch { /* Corrupt pricing metadata must not invent a valuation. */ } }
  const fetched = Object.values(state.prices && typeof state.prices === 'object' ? state.prices : {}).map(item => timestamp(item?.fetchedAt)).filter(Boolean);
  return {
    status, valuationMode: 'persisted_reference', initialBalance: initial, balance, realizedProfit,
    returnPercent: initial > 0 && balance !== null ? finite((balance / initial - 1) * 100) : null,
    tradingDays: Array.isArray(state.tradingDays) ? new Set(state.tradingDays.filter(value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value))).size : 0,
    openPositions: Array.isArray(state.positions) ? state.positions.length : 0,
    pendingOrders: Array.isArray(state.pending) ? state.pending.length : 0,
    closedTrades: Array.isArray(state.history) ? state.history.length : 0,
    lockedReason: typeof state.locked === 'string' ? state.locked.slice(0, 160) : null,
    lastValuationAt: fetched.length ? fetched.reduce((maximum,value)=>Math.max(maximum,value),0) : null,
    valuationCurrent: Boolean(valuation?.valuationComplete && valuation?.executionReady),
    equity: finite(valuation?.equity), floatingProfit: finite(valuation?.floating),
  };
}
function tradeView(trade, pending = false) {
  if (!trade || typeof trade !== 'object' || Array.isArray(trade)) return null;
  const result = {
    id: Number.isSafeInteger(trade.id) ? trade.id : null, symbol: text(trade.symbol, 20), side: ['buy', 'sell'].includes(trade.side) ? trade.side : null,
    lots: finite(trade.lots), quantity: finite(trade.quantity), entry: finite(trade.entry), stopLoss: finite(trade.stopLoss), takeProfit: finite(trade.takeProfit),
    openedAt: timestamp(trade.openedAt), entrySource: text(trade.entryQuote?.source, 160) || null,
    entryQuoteAt: finite(trade.entryQuote?.asOf),
  };
  if (pending) return { ...result, limitPrice: finite(trade.limitPrice ?? trade.price), createdAt: timestamp(trade.createdAt) };
  return { ...result, exit: finite(trade.exit), realizedProfit: finite(trade.profit), closedAt: timestamp(trade.closedAt), reason: text(trade.reason, 160) || null, exitSource: text(trade.exitQuote?.source, 160) || null };
}
function certificateQualified(row) {
  if (row.price_mode !== 'reference' || !Number.isSafeInteger(row.trading_days) || row.trading_days < 3 || !timestamp(row.issued_at) || finite(row.initial_balance) === null || row.initial_balance <= 0 || finite(row.final_balance) === null || finite(row.profit_percent) === null || row.profit_percent < 10) return false;
  const actual = (row.final_balance / row.initial_balance - 1) * 100;
  return Number.isFinite(actual) && actual >= 10 && Math.abs(actual - row.profit_percent) <= Math.max(1e-8, Math.abs(actual) * 1e-10);
}
function certificateView(row) {
  return { id: row.id, userId: row.user_id, traderName: row.trader_name, traderFirstName: row.trader_first_name, email: row.email, holder: row.holder,
    issuedAt: timestamp(row.issued_at), initialBalance: finite(row.initial_balance), finalBalance: finite(row.final_balance), profitPercent: finite(row.profit_percent), tradingDays: row.trading_days, priceMode: row.price_mode, qualified: certificateQualified(row), downloadUrl: `/api/admin/certificates/${encodeURIComponent(row.id)}.svg` };
}
function documentView(row) {
  return row ? { id: row.id, title: row.title, version: row.version, hash: row.hash, format: row.format, fileName: row.file_name, publishedAt: row.published_at, active: Boolean(row.active), scope:row.recipient_user_id==null?'global':'personal',recipientUserId:row.recipient_user_id??null,signatureCount: row.signature_count ?? 0, documentUrl: `/api/admin/contracts/${encodeURIComponent(row.id)}/document` } : null;
}
function signatureView(row) {
  return { id: row.id, userId: row.user_id, traderName: row.trader_name, traderFirstName: row.trader_first_name, email: row.email, legalName: row.legal_name, signedAt: row.signed_at, contractId: row.contract_id, contractVersion: row.contract_version, contractHash: row.contract_hash, certificateId: row.certificate_id };
}
const qualifiedSQL = alias => `${alias}.price_mode='reference' AND ${alias}.trading_days>=3 AND ${alias}.trading_days=CAST(${alias}.trading_days AS INTEGER) AND ${alias}.issued_at>0 AND ${alias}.initial_balance>0 AND abs(${alias}.initial_balance)<1e100 AND ${alias}.final_balance>=${alias}.initial_balance*1.1 AND abs(${alias}.final_balance)<1e100 AND ${alias}.profit_percent>=10 AND abs(${alias}.profit_percent)<1e100 AND abs(((${alias}.final_balance/${alias}.initial_balance)-1)*100-${alias}.profit_percent)<=max(1e-8,abs(${alias}.profit_percent)*1e-10)`;
const stateStatusSQL = `CASE WHEN has_account=0 THEN 'not_started' WHEN valid_json=0 THEN 'unavailable'
  WHEN json_extract(state_json,'$.migrationRequired')=1 OR coalesce(json_extract(state_json,'$.executionMode'),'legacy')!='reference' THEN 'legacy'
  WHEN coalesce(json_type(state_json,'$.initial'),'') NOT IN ('integer','real') OR json_extract(state_json,'$.initial')<=0 OR coalesce(json_type(state_json,'$.balance'),'') NOT IN ('integer','real') OR coalesce(json_type(state_json,'$.positions'),'')!='array' OR coalesce(json_type(state_json,'$.history'),'')!='array' OR coalesce(json_type(state_json,'$.tradingDays'),'')!='array' THEN 'unavailable'
  WHEN json_extract(state_json,'$.locked')='Profit target achieved' AND json_array_length(state_json,'$.positions')=0 AND json_extract(state_json,'$.balance')>=json_extract(state_json,'$.initial')*1.1 AND (SELECT count(DISTINCT value) FROM json_each(state_json,'$.tradingDays') WHERE type='text' AND value GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')>=3 THEN 'passed'
  WHEN json_extract(state_json,'$.locked')='Total loss limit' THEN 'failed' WHEN json_extract(state_json,'$.locked') IS NOT NULL AND json_extract(state_json,'$.locked')!='' THEN 'locked' ELSE 'running' END`;

// Formula protection applies before CSV quoting, including formulas hidden behind
// leading spaces, tabs or line breaks. Exports never contain unselected fields.
export function adminCsvCell(value) {
  let content = value === null || value === undefined ? '' : String(value);
  if (/^[\s\u0000-\u001f]*[=+\-@]/u.test(content) || /^[\t\r\n]/u.test(content)) content = `'${content}`;
  return `"${content.replace(/"/g, '""')}"`;
}
function csv(headers, rows) { return '\ufeff' + [headers, ...rows].map(row => row.map(adminCsvCell).join(',')).join('\r\n') + '\r\n'; }
function dateBound(value, end = false) {
  if (value === undefined || value === null || value === '') return null;
  let result;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    result = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(result) || new Date(result).toISOString().slice(0, 10) !== value) fail('Select a valid report date.');
    if (end) result += 86400000;
  } else result = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(result) || result < 0 || result > 8640000000000000) fail('Select a valid report date.');
  return result;
}

export function createAdminData(db, { now = Date.now, workflows } = {}) {
  const exists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  function base() {
    const status = exists('admin_account_status'), factor = exists('two_factor');
    return `WITH base AS (SELECT u.id,u.name,u.email,u.market,u.created_at,u.first_name,u.other_names,u.email_confirmation_required,
      a.state AS raw_state,CASE WHEN json_valid(a.state) THEN CASE WHEN json_type(a.state)='object' THEN a.state ELSE '{}' END ELSE '{}' END AS state_json,CASE WHEN a.user_id IS NULL THEN 0 ELSE 1 END AS has_account,CASE WHEN json_valid(a.state) THEN json_type(a.state)='object' ELSE 0 END AS valid_json,
      coalesce(p.verified,0) AS email_verified,${status ? "coalesce(s.status,'active')" : "'active'"} AS account_status,${factor ? 'CASE WHEN f.secret IS NULL THEN 0 ELSE 1 END' : '0'} AS factor_enabled
      FROM users u LEFT JOIN accounts a ON a.user_id=u.id LEFT JOIN notification_preferences p ON p.user_id=u.id
      ${status ? 'LEFT JOIN admin_account_status s ON s.user_id=u.id' : ''} ${factor ? 'LEFT JOIN two_factor f ON f.user_id=u.id' : ''}),
      classified AS (SELECT *,${stateStatusSQL} AS assessment_status FROM base)`;
  }
  function traderFilter(query = {}) {
    const clauses = [], params = [];
    const search = searchValue(query.search ?? query.q);
    if (search) { clauses.push("(name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\')"); params.push(like(search), like(search)); }
    const status = choose(query.status, ['active', 'suspended'], null, 'account status');
    if (status) { clauses.push('account_status=?'); params.push(status); }
    const emailStatus = choose(query.emailStatus, ['confirmed', 'pending', 'unconfirmed', 'verified'], null, 'email status');
    if (emailStatus) clauses.push(['confirmed', 'verified'].includes(emailStatus) ? 'email_verified=1' : 'email_verified=0');
    const assessment = choose(query.assessmentStatus, ['running', 'passed', 'failed', 'locked', 'legacy', 'not_started', 'unavailable'], null, 'assessment status');
    if (assessment) { clauses.push('assessment_status=?'); params.push(assessment); }
    return { where: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
  }
  function activeDocument() { return db.prepare('SELECT d.* FROM contract_documents d JOIN active_contract a ON a.contract_id=d.id WHERE a.singleton=1').get(); }
  function contractStatus(id, document) {
    const qualified = db.prepare(`SELECT 1 FROM certificates c WHERE c.user_id=? AND ${qualifiedSQL('c')} LIMIT 1`).get(id);
    if (!qualified) return 'assessment_required';
    if (!document) return 'awaiting_contract';
    const signed = db.prepare(`SELECT s.contract_version,s.contract_hash,s.consent_statement,s.signed_at,c.* FROM contract_signatures s LEFT JOIN certificates c ON c.id=s.certificate_id WHERE s.user_id=? AND s.contract_id=?`).get(id, document.id);
    if (!signed) return 'signature_required';
    return signed.user_id === id && signed.contract_version === document.version && signed.contract_hash === document.hash && signed.consent_statement === contractConsentStatement && certificateQualified(signed) && signed.signed_at >= Math.max(signed.issued_at, document.published_at) ? 'signed' : 'invalid_signature';
  }
  function traderItem(row, document = requiredContractDocument(db,row.id)) {
    const state = parseState(row.raw_state);
    return { id: row.id, name: row.name, firstName: row.first_name, email: row.email, market: row.market, createdAt: row.created_at, emailVerified: Boolean(row.email_verified), assessmentAccess: !row.email_confirmation_required || Boolean(row.email_verified), accountStatus: row.account_status, twoFactorEnabled: Boolean(row.factor_enabled), certificateCount: db.prepare('SELECT count(*) n FROM certificates WHERE user_id=?').get(row.id).n, contractStatus: contractStatus(row.id, document), assessment: assessmentView(state, Boolean(row.has_account), now()) };
  }
  function traders(query = {}) {
    const paging = pagination(query), filter = traderFilter(query);
    const count = db.prepare(`${base()} SELECT count(*) n FROM classified ${filter.where}`).get(...filter.params).n;
    const items = db.prepare(`${base()} SELECT * FROM classified ${filter.where} ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?`).all(...filter.params, paging.limit, paging.offset).map(row => traderItem(row));
    return page(items, count, paging);
  }
  function assessments(query = {}) { return traders(query); }
  function certificatesPage(query = {}) {
    const paging = pagination(query), clauses = [], params = [];
    const search = searchValue(query.search ?? query.q);
    if (search) { clauses.push("(u.name LIKE ? ESCAPE '\\' OR u.email LIKE ? ESCAPE '\\' OR c.holder LIKE ? ESCAPE '\\')"); params.push(like(search), like(search), like(search)); }
    if (query.userId !== undefined && query.userId !== '') { clauses.push('c.user_id=?'); params.push(userId(query.userId)); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = db.prepare(`SELECT count(*) n FROM certificates c JOIN users u ON u.id=c.user_id ${where}`).get(...params).n;
    const rows = db.prepare(`SELECT c.*,u.name AS trader_name,u.first_name AS trader_first_name,u.email FROM certificates c JOIN users u ON u.id=c.user_id ${where} ORDER BY c.issued_at DESC,c.id LIMIT ? OFFSET ?`).all(...params, paging.limit, paging.offset);
    return page(rows.map(certificateView), total, paging);
  }
  function contractsPage(query = {}) {
    const paging = pagination(query), active = activeDocument();
    const total = db.prepare('SELECT count(*) n FROM contract_documents').get().n;
    const documentRows = db.prepare(`SELECT d.id,d.title,d.version,d.hash,d.format,d.file_name,d.published_at,d.recipient_user_id,CASE WHEN d.recipient_user_id IS NULL AND d.id=? THEN 1 WHEN EXISTS(SELECT 1 FROM user_active_contract p WHERE p.user_id=d.recipient_user_id AND p.contract_id=d.id) THEN 1 ELSE 0 END AS active,(SELECT count(*) FROM contract_signatures s WHERE s.contract_id=d.id) AS signature_count FROM contract_documents d ORDER BY d.published_at DESC,d.id LIMIT ? OFFSET ?`).all(active?.id ?? '', paging.limit, paging.offset);
    const signatureCount = db.prepare('SELECT count(*) n FROM contract_signatures').get().n;
    const signatureRows = db.prepare('SELECT s.*,u.name AS trader_name,u.first_name AS trader_first_name,u.email FROM contract_signatures s JOIN users u ON u.id=s.user_id ORDER BY s.signed_at DESC,s.id LIMIT ? OFFSET ?').all(paging.limit, paging.offset);
    return { ...page(documentRows.map(documentView), total, paging), active: active ? documentView({ ...active, active: 1, signature_count: db.prepare('SELECT count(*) n FROM contract_signatures WHERE contract_id=?').get(active.id).n }) : null, signatures: page(signatureRows.map(signatureView), signatureCount, paging) };
  }
  function trader(id, query = {}) {
    id = userId(id);
    const row = db.prepare(`${base()} SELECT * FROM classified WHERE id=?`).get(id);
    if (!row) throw new AdminDataError(404, 'Trader not found.');
    const state = parseState(row.raw_state), item = traderItem(row), paging = { limit: integer(query.tradeLimit ?? query.limit, 50, 1, 100, 'trade page size'), offset: integer(query.tradeOffset ?? query.offset, 0, 0, 1000000, 'trade offset') };
    const history = (Array.isArray(state?.history) ? state.history : []).filter(value=>value && typeof value==='object' && !Array.isArray(value));
    const certificates = certificatesPage({ userId: id, limit: 100 });
    const agreementRows = db.prepare('SELECT s.*,u.name AS trader_name,u.first_name AS trader_first_name,u.email FROM contract_signatures s JOIN users u ON u.id=s.user_id WHERE s.user_id=? ORDER BY s.signed_at DESC,s.id LIMIT 100').all(id);
    const sessionCount = exists('sessions') ? db.prepare('SELECT count(*) n FROM sessions WHERE user_id=? AND expires>? AND last_seen>?').get(id, now(), now() - 86400000).n : 0;
    const notes = exists('admin_notes') ? db.prepare('SELECT n.id,n.user_id AS userId,n.actor_user_id AS actorUserId,u.name AS actorName,n.text,n.created_at AS createdAt FROM admin_notes n LEFT JOIN users u ON u.id=n.actor_user_id WHERE n.user_id=? ORDER BY n.created_at DESC,n.id DESC LIMIT 100').all(id) : [];
    const reviewHistory = exists('sponsorship_review_history') ? db.prepare('SELECT id,user_id AS userId,revision,status,contract_id AS contractId,contract_hash AS contractHash,certificate_id AS certificateId,reason,client_message AS clientMessage,actor_user_id AS actorUserId,created_at AS createdAt FROM sponsorship_review_history WHERE user_id=? ORDER BY revision DESC,id DESC LIMIT 100').all(id) : [];
    return { ...item, profile: { firstName: row.first_name, otherNames: row.other_names }, positions: (Array.isArray(state?.positions) ? state.positions : []).slice(0, 100).map(value => tradeView(value)).filter(Boolean), pendingOrders: (Array.isArray(state?.pending) ? state.pending : []).slice(0, 100).map(value => tradeView(value, true)).filter(Boolean), tradeHistory: page(history.slice(paging.offset, paging.offset + paging.limit).map(value => tradeView(value)).filter(Boolean), history.length, paging), certificates: certificates.items, certificateTotal: certificates.total, agreements: agreementRows.map(signatureView), agreementTotal: db.prepare('SELECT count(*) n FROM contract_signatures WHERE user_id=?').get(id).n, notes, reviewHistory, noteTotal: exists('admin_notes') ? db.prepare('SELECT count(*) n FROM admin_notes WHERE user_id=?').get(id).n : 0, reviewHistoryTotal: exists('sponsorship_review_history') ? db.prepare('SELECT count(*) n FROM sponsorship_review_history WHERE user_id=?').get(id).n : 0, sessionCount, ...(workflows?.review ? { review: workflows.review(id) } : {}), valuationMode: 'persisted_reference' };
  }
  function overview(query = {}) {
    const days = integer(query.days, 30, 1, 90, 'analytics period');
    const time = now(), first = new Date(time); first.setUTCHours(0, 0, 0, 0); first.setUTCDate(first.getUTCDate() - days + 1);
    const start = first.getTime(), end = start + days * 86400000;
    const counts = db.prepare(`${base()} SELECT count(*) AS totalTraders,sum(email_verified=1) AS confirmedEmails,sum(email_verified=0) AS unconfirmedEmails,sum(assessment_status='running') AS activeAssessments,sum(assessment_status='passed') AS passedAssessments,sum(assessment_status='failed') AS failedAssessments,sum(assessment_status='locked') AS lockedAssessments,sum(assessment_status='legacy') AS legacyAssessments FROM classified`).get();
    const metrics = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value ?? 0]));
    metrics.certificates = db.prepare('SELECT count(*) n FROM certificates').get().n;
    metrics.qualifiedTraders = db.prepare(`SELECT count(DISTINCT c.user_id) n FROM certificates c WHERE ${qualifiedSQL('c')}`).get().n;
    const document = activeDocument();
    metrics.currentSignatures = db.prepare(`SELECT count(*) n FROM contract_signatures s JOIN certificates c ON c.id=s.certificate_id JOIN contract_documents d ON d.id=s.contract_id LEFT JOIN user_active_contract p ON p.user_id=s.user_id WHERE s.contract_id=coalesce(p.contract_id,?) AND (d.recipient_user_id IS NULL OR d.recipient_user_id=s.user_id) AND s.contract_version=d.version AND s.contract_hash=d.hash AND s.consent_statement=? AND c.user_id=s.user_id AND s.signed_at>=max(c.issued_at,d.published_at) AND ${qualifiedSQL('c')}`).get(document?.id??null,contractConsentStatement).n;
    const registrations = new Map(db.prepare("SELECT strftime('%Y-%m-%d',created_at/1000,'unixepoch') AS day,count(*) n FROM users WHERE created_at>=? AND created_at<? GROUP BY day").all(start, end).map(row => [row.day, row.n]));
    const completions = new Map(db.prepare(`SELECT strftime('%Y-%m-%d',c.issued_at/1000,'unixepoch') AS day,count(*) n FROM certificates c WHERE c.issued_at>=? AND c.issued_at<? AND ${qualifiedSQL('c')} GROUP BY day`).all(start, end).map(row => [row.day, row.n]));
    const daily = Array.from({ length: days }, (_, index) => { const date = new Date(start + index * 86400000).toISOString().slice(0, 10); return { date, registrations: registrations.get(date) ?? 0, qualifiedAssessments: completions.get(date) ?? 0 }; });
    const support = { ai: 0, waiting: 0, assigned: 0, closed: 0, total: 0 };
    if (exists('support_conversations')) for (const row of db.prepare('SELECT status,count(*) n FROM support_conversations GROUP BY status').all()) { if (Object.hasOwn(support, row.status)) support[row.status] = row.n; support.total += row.n; }
    const reviews = { pending_review: 0, needs_information: 0, approved: 0, rejected: 0, total: 0 };
    if (typeof workflows?.summary === 'function') {
      const summary=workflows.summary();
      for (const [status,count] of Object.entries(summary.counts || {})) if (Number.isSafeInteger(count) && count>=0) reviews[status]=count;
      reviews.total=Number.isSafeInteger(summary.total)?summary.total:reviews.total;
    } else if (exists('sponsorship_reviews')) for (const row of db.prepare('SELECT status,count(*) n FROM sponsorship_reviews GROUP BY status').all()) { if (Object.hasOwn(reviews, row.status)) reviews[row.status] = row.n; reviews.total += row.n; }
    return { generatedAt: time, valuationMode: 'persisted_reference', metrics, daily, support, reviews };
  }
  function report(query = {}) {
    const type = choose(query.type, ['traders', 'assessments', 'trades', 'certificates', 'contracts'], 'traders', 'report type');
    const limit = integer(query.limit, 5000, 1, 5000, 'report limit');
    const from = dateBound(query.from), to = dateBound(query.to, typeof query.to === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(query.to));
    if (from !== null && to !== null && to <= from) fail('The report end date must follow its start date.');
    const selectedUser = query.userId === undefined || query.userId === '' ? null : userId(query.userId);
    let headers, source, fields, order, dateColumn, userColumn;
    if (type === 'traders' || type === 'assessments') {
      headers = ['Trader ID', 'Name', 'Email', 'Created UTC', 'Email confirmed', 'Account status', 'Assessment status', 'Initial demo USD', 'Balance demo USD', 'Realized demo profit USD'];
      source = `${base()} SELECT %FIELDS% FROM classified %WHERE%`;
      fields = "id,name,email,created_at,email_verified,account_status,assessment_status,json_extract(state_json,'$.initial') AS initial,json_extract(state_json,'$.balance') AS balance";
      dateColumn = 'created_at'; userColumn = 'id'; order = 'created_at DESC,id DESC';
    } else if (type === 'certificates') {
      headers = ['Certificate ID', 'Trader ID', 'Name', 'Email', 'Holder', 'Issued UTC', 'Initial demo USD', 'Final demo USD', 'Return percent', 'Trading days', 'Price mode'];
      source = 'SELECT %FIELDS% FROM certificates c JOIN users u ON u.id=c.user_id %WHERE%';
      fields = 'c.id,c.user_id,u.name,u.email,c.holder,c.issued_at,c.initial_balance,c.final_balance,c.profit_percent,c.trading_days,c.price_mode'; dateColumn = 'c.issued_at'; userColumn = 'c.user_id'; order = 'c.issued_at DESC,c.id';
    } else if (type === 'contracts') {
      headers = ['Signature ID', 'Trader ID', 'Name', 'Email', 'Legal name', 'Signed UTC', 'Contract ID', 'Version', 'Document SHA256', 'Certificate ID'];
      source = 'SELECT %FIELDS% FROM contract_signatures s JOIN users u ON u.id=s.user_id %WHERE%'; fields = 's.id,s.user_id,u.name,u.email,s.legal_name,s.signed_at,s.contract_id,s.contract_version,s.contract_hash,s.certificate_id'; dateColumn = 's.signed_at'; userColumn = 's.user_id'; order = 's.signed_at DESC,s.id';
    } else {
      headers = ['Trader ID', 'Name', 'Email', 'Trade ID', 'Symbol', 'Side', 'Lots', 'Base units', 'Entry reference', 'Exit reference', 'Realized demo profit USD', 'Opened UTC', 'Closed UTC', 'Reason'];
      source = `SELECT %FIELDS% FROM users u JOIN accounts a ON a.user_id=u.id JOIN json_each(CASE WHEN json_valid(a.state) THEN CASE WHEN json_type(a.state,'$.history')='array' THEN json_extract(a.state,'$.history') ELSE '[]' END ELSE '[]' END) h %WHERE%`;
      fields = 'u.id AS user_id,u.name,u.email,h.value AS trade_json'; dateColumn = "json_extract(CASE WHEN h.type='object' THEN h.value ELSE '{}' END,'$.closedAt')"; userColumn = 'u.id'; order = "json_extract(CASE WHEN h.type='object' THEN h.value ELSE '{}' END,'$.closedAt') DESC,u.id,h.key";
    }
    const clauses = type === 'trades' ? ["h.type='object'"] : [], params = [];
    if (from !== null) { clauses.push(`${dateColumn}>=?`); params.push(from); }
    if (to !== null) { clauses.push(`${dateColumn}<?`); params.push(to); }
    if (selectedUser !== null) { clauses.push(`${userColumn}=?`); params.push(selectedUser); }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
    const total = db.prepare(source.replace('%FIELDS%', 'count(*) n').replace('%WHERE%', where)).get(...params).n;
    const found = db.prepare(source.replace('%FIELDS%', fields).replace('%WHERE%', where) + ` ORDER BY ${order} LIMIT ?`).all(...params, limit);
    const iso = value => timestamp(value) ? new Date(value).toISOString() : '';
    const rows = found.map(row => {
      if (type === 'traders' || type === 'assessments') return [row.id, row.name, row.email, iso(row.created_at), Boolean(row.email_verified), row.account_status, row.assessment_status, finite(row.initial), finite(row.balance), finite(row.balance) !== null && finite(row.initial) !== null ? finite(row.balance - row.initial) : null];
      if (type === 'certificates') return [row.id, row.user_id, row.name, row.email, row.holder, iso(row.issued_at), finite(row.initial_balance), finite(row.final_balance), finite(row.profit_percent), row.trading_days, row.price_mode];
      if (type === 'contracts') return [row.id, row.user_id, row.name, row.email, row.legal_name, iso(row.signed_at), row.contract_id, row.contract_version, row.contract_hash, row.certificate_id];
      const trade = tradeView(parseState(row.trade_json));
      return [row.user_id, row.name, row.email, trade?.id, trade?.symbol, trade?.side, trade?.lots, trade?.quantity, trade?.entry, trade?.exit, trade?.realizedProfit, iso(trade?.openedAt), iso(trade?.closedAt), trade?.reason];
    });
    return { type, headers, rows, csv: csv(headers, rows), total, returned: rows.length, truncated: total > rows.length, generatedAt: now(), valuationMode: 'persisted_reference', from, to };
  }
  return { overview, traders, trader, assessments, certificatesPage, contractsPage, report };
}
