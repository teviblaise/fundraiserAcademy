import { createHash, randomUUID } from 'node:crypto';

export class AdminFinanceError extends Error {
  constructor(status, message, code) { super(message); this.status = status; if (code) this.code = code; }
}

const maxMoney = 1_000_000_000_000;
const maxAggregate = Number.MAX_SAFE_INTEGER;
const policies = ['cumulative_high_water', 'settled_period'];
const accountStatuses = ['active', 'paused', 'closed'];
const payoutStatuses = ['requested', 'approved', 'paid', 'rejected'];
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const fail = (status, message, code) => { throw new AdminFinanceError(status, message, code); };
const recordSource = 'manual_external_record';

function integer(value, label, min, max, fallback) {
  if (value === undefined && fallback !== undefined) return fallback;
  const parsed = typeof value === 'string' && /^-?\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) fail(400, `${label} must be an integer between ${min} and ${max}.`);
  return parsed;
}
function text(value, label, max, { optional = false, min = 1 } = {}) {
  if (optional && (value === undefined || value === null || value === '')) return null;
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)) fail(400, `Enter a valid ${label} without control characters.`);
  const clean = value.normalize('NFKC').trim();
  if (clean.length < min || clean.length > max) fail(400, `${label} must contain ${min}–${max} characters.`);
  return clean;
}
const reason = value => text(value, 'administrative reason', 500, { min: 3 });
function id(value, label = 'record') {
  if (typeof value !== 'string' || !uuid.test(value)) fail(400, `Select a valid ${label}.`);
  return value.toLowerCase();
}
function date(value, label) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) fail(400, `Enter a valid ${label} as YYYY-MM-DD.`);
  return value;
}
function safeNumber(value, label) {
  if (value > BigInt(maxAggregate) || value < -BigInt(maxAggregate)) fail(409, `${label} exceeds the supported accounting limit.`);
  return Number(value);
}
const roundedShare = (profit, bps) => safeNumber((BigInt(Math.max(0, profit)) * BigInt(bps) + 5000n) / 10000n, 'Profit share');
function page(query) { return { limit: integer(query.limit, 'Page size', 1, 100, 25), offset: integer(query.offset, 'Page offset', 0, 1000000, 0) }; }
function unknownKeys(data, allowed) {
  if (!data || typeof data !== 'object' || Array.isArray(data) || Object.keys(data).some(key => !allowed.includes(key))) fail(400, 'The finance request contains unsupported fields.');
}

export function createAdminFinance(db, { access, workflows, now = Date.now } = {}) {
  if (!access?.require || !access?.audit || !workflows?.requireApproved) throw new TypeError('Finance requires administrator access and sponsorship-review services.');
  db.exec(`CREATE TABLE IF NOT EXISTS sponsored_accounts (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), firm_name TEXT NOT NULL,
    label TEXT NOT NULL, label_key TEXT NOT NULL, account_size_cents INTEGER NOT NULL,
    trader_share_bps INTEGER NOT NULL, profit_sharing_policy TEXT NOT NULL CHECK(profit_sharing_policy IN ('cumulative_high_water','settled_period')),
    currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency='USD'), status TEXT NOT NULL CHECK(status IN ('active','paused','closed')),
    review_id TEXT NOT NULL, review_revision INTEGER NOT NULL, certificate_id TEXT NOT NULL,
    contract_id TEXT NOT NULL, contract_version TEXT NOT NULL, contract_hash TEXT NOT NULL, signature_id TEXT NOT NULL,
    evidence TEXT NOT NULL, created_by INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1, UNIQUE(user_id,label_key));
    CREATE INDEX IF NOT EXISTS sponsored_accounts_user ON sponsored_accounts(user_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS sponsored_statements (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES sponsored_accounts(id), user_id INTEGER NOT NULL REFERENCES users(id),
    net_profit_cents INTEGER NOT NULL, trader_share_cents INTEGER NOT NULL, company_share_cents INTEGER NOT NULL,
    cumulative_net_profit_cents INTEGER NOT NULL, high_water_profit_cents INTEGER NOT NULL,
    external_reference TEXT NOT NULL, reference_key TEXT NOT NULL, evidence TEXT NOT NULL,
    period_start TEXT, period_end TEXT, external_settlement_confirmed INTEGER NOT NULL DEFAULT 0,
    created_by INTEGER NOT NULL REFERENCES users(id), created_at INTEGER NOT NULL, UNIQUE(account_id,reference_key));
    CREATE INDEX IF NOT EXISTS sponsored_statements_account ON sponsored_statements(account_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS sponsored_payouts (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES sponsored_accounts(id), user_id INTEGER NOT NULL REFERENCES users(id),
    amount_cents INTEGER NOT NULL CHECK(amount_cents>0), currency TEXT NOT NULL DEFAULT 'USD' CHECK(currency='USD'),
    status TEXT NOT NULL CHECK(status IN ('requested','approved','paid','rejected')),
    external_payment_reference TEXT, payment_reference_key TEXT UNIQUE, paid_at INTEGER,
    created_by INTEGER NOT NULL REFERENCES users(id), updated_by INTEGER NOT NULL REFERENCES users(id),
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1);
    CREATE INDEX IF NOT EXISTS sponsored_payouts_account ON sponsored_payouts(account_id,created_at DESC);
    CREATE TABLE IF NOT EXISTS sponsored_payout_events (
    id TEXT PRIMARY KEY, payout_id TEXT NOT NULL REFERENCES sponsored_payouts(id), actor_user_id INTEGER NOT NULL REFERENCES users(id),
    previous_status TEXT, status TEXT NOT NULL, reason TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sponsored_client_payout_requests (
    user_id INTEGER NOT NULL REFERENCES users(id), request_key_hash TEXT NOT NULL,
    account_id TEXT NOT NULL REFERENCES sponsored_accounts(id), amount_cents INTEGER NOT NULL,
    payout_id TEXT NOT NULL UNIQUE REFERENCES sponsored_payouts(id), created_at INTEGER NOT NULL,
    PRIMARY KEY(user_id,request_key_hash));
    CREATE TRIGGER IF NOT EXISTS sponsored_account_terms_immutable BEFORE UPDATE ON sponsored_accounts
    WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.firm_name IS NOT OLD.firm_name OR NEW.label IS NOT OLD.label
      OR NEW.label_key IS NOT OLD.label_key OR NEW.account_size_cents IS NOT OLD.account_size_cents OR NEW.trader_share_bps IS NOT OLD.trader_share_bps
      OR NEW.profit_sharing_policy IS NOT OLD.profit_sharing_policy OR NEW.currency IS NOT OLD.currency OR NEW.review_id IS NOT OLD.review_id
      OR NEW.review_revision IS NOT OLD.review_revision OR NEW.certificate_id IS NOT OLD.certificate_id OR NEW.contract_id IS NOT OLD.contract_id
      OR NEW.contract_version IS NOT OLD.contract_version OR NEW.contract_hash IS NOT OLD.contract_hash OR NEW.signature_id IS NOT OLD.signature_id
      OR NEW.evidence IS NOT OLD.evidence OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
      BEGIN SELECT RAISE(ABORT,'Sponsored account terms are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS sponsored_accounts_no_delete BEFORE DELETE ON sponsored_accounts
      BEGIN SELECT RAISE(ABORT,'Sponsored account records cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS sponsored_statements_no_update BEFORE UPDATE ON sponsored_statements
      BEGIN SELECT RAISE(ABORT,'Recorded statements are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS sponsored_statements_no_delete BEFORE DELETE ON sponsored_statements
      BEGIN SELECT RAISE(ABORT,'Recorded statements are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS sponsored_payout_terms_immutable BEFORE UPDATE ON sponsored_payouts
    WHEN NEW.id IS NOT OLD.id OR NEW.account_id IS NOT OLD.account_id OR NEW.user_id IS NOT OLD.user_id
      OR NEW.amount_cents IS NOT OLD.amount_cents OR NEW.currency IS NOT OLD.currency OR NEW.created_by IS NOT OLD.created_by
      OR NEW.created_at IS NOT OLD.created_at OR OLD.status IN ('paid','rejected')
      BEGIN SELECT RAISE(ABORT,'Payout terms and final records are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS sponsored_payouts_no_delete BEFORE DELETE ON sponsored_payouts
      BEGIN SELECT RAISE(ABORT,'Payout records cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS sponsored_payout_events_no_update BEFORE UPDATE ON sponsored_payout_events
      BEGIN SELECT RAISE(ABORT,'Payout history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS sponsored_payout_events_no_delete BEFORE DELETE ON sponsored_payout_events
      BEGIN SELECT RAISE(ABORT,'Payout history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS sponsored_client_payout_requests_no_update BEFORE UPDATE ON sponsored_client_payout_requests
      BEGIN SELECT RAISE(ABORT,'Client payout requests are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS sponsored_client_payout_requests_no_delete BEFORE DELETE ON sponsored_client_payout_requests
      BEGIN SELECT RAISE(ABORT,'Client payout requests are immutable'); END;`);

  function transaction(actorId, work, { client = false } = {}) {
    const ownsTransaction = !db.isTransaction;
    if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
    try { if (client) requireClient(actorId); else access.require(actorId, 'finance.write'); const result = work(); if (ownsTransaction) db.exec('COMMIT'); return result; }
    catch (error) { if (ownsTransaction) db.exec('ROLLBACK'); if (error.code?.includes('CONSTRAINT') || /UNIQUE constraint failed/.test(error.message)) fail(409, 'That external reference, account label, or payout request has already been recorded.'); throw error; }
  }
  function requireClient(userId) {
    const target = integer(userId, 'Trader ID', 1, Number.MAX_SAFE_INTEGER);
    if (!db.prepare('SELECT 1 FROM users WHERE id=?').get(target)) fail(401, 'Sign in again to request a payout.');
    if (!db.prepare('SELECT 1 FROM notification_preferences WHERE user_id=? AND verified=1').get(target)) fail(403, 'Confirm your account email before requesting a payout.', 'EMAIL_CONFIRMATION_REQUIRED');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='admin_account_status'").get() && db.prepare("SELECT 1 FROM admin_account_status WHERE user_id=? AND status='suspended'").get(target)) fail(403, 'This account is suspended. Contact academy support to review outstanding payments.', 'ACCOUNT_SUSPENDED');
    if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_deletions'").get() && db.prepare("SELECT 1 FROM account_deletions WHERE user_id=? AND status='deleted'").get(target)) fail(403, 'This account has been deleted.', 'ACCOUNT_DELETED');
    return target;
  }
  function accountRow(accountId) {
    const row = db.prepare('SELECT a.*,u.name AS trader_name,u.email AS trader_email FROM sponsored_accounts a JOIN users u ON u.id=a.user_id WHERE a.id=?').get(id(accountId, 'sponsored account'));
    if (!row) fail(404, 'Sponsored account not found.');
    return row;
  }
  function balance(accountId) {
    const statementRows = db.prepare('SELECT net_profit_cents,trader_share_cents,high_water_profit_cents FROM sponsored_statements WHERE account_id=?').all(accountId);
    let net = 0n, earned = 0n, high = 0;
    for (const row of statementRows) { net += BigInt(row.net_profit_cents); earned += BigInt(row.trader_share_cents); high = Math.max(high, row.high_water_profit_cents); }
    let reserved = 0n, paid = 0n;
    for (const row of db.prepare("SELECT amount_cents,status FROM sponsored_payouts WHERE account_id=? AND status!='rejected'").all(accountId)) {
      if (row.status === 'paid') paid += BigInt(row.amount_cents); else reserved += BigInt(row.amount_cents);
    }
    const available = earned - reserved - paid;
    if (available < 0n) fail(409, 'Stored payout reservations exceed the recorded trader share. Review the ledger.');
    return { cumulativeNetProfitCents: safeNumber(net, 'Cumulative profit'), highWaterProfitCents: high, earnedCents: safeNumber(earned, 'Earned share'), reservedCents: safeNumber(reserved, 'Reserved payouts'), paidCents: safeNumber(paid, 'Recorded payments'), availableCents: safeNumber(available, 'Available share') };
  }
  function accountView(row, { client = false } = {}) {
    const result = { id: row.id, userId: row.user_id, firmName: row.firm_name, label: row.label, accountSizeCents: row.account_size_cents,
      traderShareBps: row.trader_share_bps, profitSharingPolicy: row.profit_sharing_policy, currency: row.currency, status: row.status,
      revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, ...balance(row.id), source: recordSource,
      review: { reviewId: row.review_id, reviewRevision: row.review_revision, certificateId: row.certificate_id, contractId: row.contract_id, contractVersion: row.contract_version, contractHash: row.contract_hash, signatureId: row.signature_id } };
    if (!client) Object.assign(result, { traderName: row.trader_name, traderEmail: row.trader_email, evidence: row.evidence });
    return result;
  }
  function statementView(row, { client = false } = {}) {
    const result = { id: row.id, accountId: row.account_id, netProfitCents: row.net_profit_cents, traderShareCents: row.trader_share_cents,
      companyShareCents: row.company_share_cents, cumulativeNetProfitCents: row.cumulative_net_profit_cents,
      highWaterProfitCents: row.high_water_profit_cents, periodStart: row.period_start, periodEnd: row.period_end,
      externalSettlementConfirmed: Boolean(row.external_settlement_confirmed), createdAt: row.created_at, source: recordSource };
    if (!client) Object.assign(result, { externalReference: row.external_reference, evidence: row.evidence });
    return result;
  }
  function payoutRow(payoutId) {
    const row = db.prepare('SELECT p.*,a.firm_name,a.label,u.name AS trader_name,u.email AS trader_email FROM sponsored_payouts p JOIN sponsored_accounts a ON a.id=p.account_id JOIN users u ON u.id=p.user_id WHERE p.id=?').get(id(payoutId, 'payout'));
    if (!row) fail(404, 'Payout record not found.');
    return row;
  }
  function payoutView(row, { client = false } = {}) {
    const requestOrigin = db.prepare('SELECT 1 FROM sponsored_client_payout_requests WHERE payout_id=?').get(row.id) ? 'trader' : 'staff';
    const history = db.prepare("SELECT id,actor_user_id,previous_status,status,reason,created_at FROM sponsored_payout_events WHERE payout_id=? ORDER BY CASE WHEN previous_status IS NULL THEN 0 WHEN previous_status='requested' THEN 1 WHEN previous_status='approved' THEN 2 ELSE 3 END,created_at,id LIMIT 20").all(row.id).map(event => ({ id:event.id,previousStatus:event.previous_status,status:event.status,createdAt:event.created_at,...(!client ? {actorId:event.actor_user_id,reason:event.reason} : {}) }));
    const result = { id: row.id, accountId: row.account_id, userId: row.user_id, firmName: row.firm_name, label: row.label, amountCents: row.amount_cents,
      currency: row.currency, status: row.status, revision: row.revision, paidAt: row.paid_at, createdAt: row.created_at, updatedAt: row.updated_at,
      source: 'manual_external_payment_record', requestOrigin, history, transfersMoney: false };
    if (!client) Object.assign(result, { traderName: row.trader_name, traderEmail: row.trader_email, externalPaymentReference: row.external_payment_reference });
    return result;
  }
  function pagedRows(query, kind) {
    const { limit, offset } = page(query);
    const where = [], params = [];
    const alias = kind === 'accounts' ? 'a' : 'p';
    if (query.userId !== undefined) { where.push(`${alias}.user_id=?`); params.push(integer(query.userId, 'Trader ID', 1, Number.MAX_SAFE_INTEGER)); }
    if (query.status !== undefined && query.status !== '') {
      if (!(kind === 'accounts' ? accountStatuses : payoutStatuses).includes(query.status)) fail(400, 'Select a valid ledger status.');
      where.push(`${alias}.status=?`); params.push(query.status);
    }
    if (query.accountId !== undefined && kind === 'payouts') { where.push('p.account_id=?'); params.push(id(query.accountId, 'sponsored account')); }
    if (query.search !== undefined && query.search !== '') {
      const search = text(query.search, 'search', 100);
      where.push("(instr(lower(u.name),lower(?))>0 OR instr(lower(u.email),lower(?))>0 OR instr(lower(a.firm_name),lower(?))>0 OR instr(lower(a.label),lower(?))>0)");
      params.push(search, search, search, search);
    }
    const from = kind === 'accounts' ? 'sponsored_accounts a JOIN users u ON u.id=a.user_id' : 'sponsored_payouts p JOIN sponsored_accounts a ON a.id=p.account_id JOIN users u ON u.id=p.user_id';
    const conditions = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const total = db.prepare(`SELECT count(*) total FROM ${from}${conditions}`).get(...params).total;
    const fields = kind === 'accounts' ? 'a.*,u.name AS trader_name,u.email AS trader_email' : 'p.*,a.firm_name,a.label,u.name AS trader_name,u.email AS trader_email';
    const rows = db.prepare(`SELECT ${fields} FROM ${from}${conditions} ORDER BY ${alias}.created_at DESC,${alias}.id LIMIT ? OFFSET ?`).all(...params, limit, offset);
    return { [kind]: rows.map(row => kind === 'accounts' ? accountView(row) : payoutView(row)), total, limit, offset, nextOffset: offset + rows.length < total ? offset + rows.length : null };
  }
  function accounts(query = {}) { return pagedRows(query, 'accounts'); }
  function payouts(query = {}) { return pagedRows(query, 'payouts'); }
  function accountDetail(accountId) {
    const row = accountRow(accountId);
    const statements = db.prepare('SELECT * FROM sponsored_statements WHERE account_id=? ORDER BY created_at DESC,id DESC LIMIT 200').all(row.id);
    const payoutRecords = db.prepare('SELECT p.*,a.firm_name,a.label,u.name AS trader_name,u.email AS trader_email FROM sponsored_payouts p JOIN sponsored_accounts a ON a.id=p.account_id JOIN users u ON u.id=p.user_id WHERE p.account_id=? ORDER BY p.created_at DESC,p.id DESC LIMIT 200').all(row.id);
    return { account: accountView(row), statements: statements.map(row => statementView(row)), payouts: payoutRecords.map(row => payoutView(row)), statementsTotal: db.prepare('SELECT count(*) total FROM sponsored_statements WHERE account_id=?').get(row.id).total, payoutsTotal: db.prepare('SELECT count(*) total FROM sponsored_payouts WHERE account_id=?').get(row.id).total, historyLimit: 200 };
  }
  function createAccount(actorId, data) {
    unknownKeys(data, ['userId','firmName','label','accountSizeCents','traderShareBps','profitSharingPolicy','evidence','reason']);
    const userId = integer(data.userId, 'Trader ID', 1, Number.MAX_SAFE_INTEGER), firmName = text(data.firmName, 'prop firm name', 120), label = text(data.label, 'account label', 120);
    const size = integer(data.accountSizeCents, 'Account size in cents', 1, maxMoney), bps = integer(data.traderShareBps, 'Trader share in basis points', 0, 10000);
    if (!policies.includes(data.profitSharingPolicy)) fail(400, 'Select the profit-sharing policy required by the signed agreement.');
    const evidence = text(data.evidence, 'external account evidence', 2000), why = reason(data.reason);
    return transaction(actorId, () => {
      const approved = workflows.requireApproved(userId);
      if (approved.userId !== userId || !approved.reviewId || !approved.certificateId || !approved.contractId || !approved.contractVersion || !approved.contractHash || !approved.signatureId || !Number.isSafeInteger(approved.reviewRevision)) fail(409, 'A valid current sponsorship approval is required.');
      const accountId = randomUUID(), time = now();
      db.prepare(`INSERT INTO sponsored_accounts(id,user_id,firm_name,label,label_key,account_size_cents,trader_share_bps,profit_sharing_policy,status,review_id,review_revision,certificate_id,contract_id,contract_version,contract_hash,signature_id,evidence,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,'active',?,?,?,?,?,?,?,?,?,?,?)`)
        .run(accountId,userId,firmName,label,`${firmName.toLowerCase()}:${label.toLowerCase()}`,size,bps,data.profitSharingPolicy,String(approved.reviewId),approved.reviewRevision,approved.certificateId,approved.contractId,approved.contractVersion,approved.contractHash,approved.signatureId,evidence,actorId,time,time);
      access.audit(actorId, 'finance.account-created', { targetId: userId, reason: why, detail: { accountId, accountSizeCents: size, traderShareBps: bps, currency: 'USD', reviewId: String(approved.reviewId), contractId: approved.contractId, contractVersion: approved.contractVersion, certificateId: approved.certificateId } });
      return { account: accountView(accountRow(accountId)) };
    });
  }
  function updateAccount(actorId, accountId, data) {
    unknownKeys(data, ['status','revision','reason']);
    if (!accountStatuses.includes(data.status)) fail(400, 'Select active, paused, or closed.');
    const revision = integer(data.revision, 'Account revision', 1, Number.MAX_SAFE_INTEGER), why = reason(data.reason);
    return transaction(actorId, () => {
      const row = accountRow(accountId);
      if (row.revision !== revision) fail(409, 'The account changed. Refresh before updating it.');
      if (row.status === 'closed') fail(409, 'Closed account records cannot be reopened or edited.');
      if (row.status === data.status) fail(409, 'The account already has that status.');
      db.prepare('UPDATE sponsored_accounts SET status=?,revision=revision+1,updated_at=? WHERE id=? AND revision=?').run(data.status, now(), row.id, revision);
      access.audit(actorId, 'finance.account-status', { targetId: row.user_id, reason: why, detail: { accountId: row.id, previousStatus: row.status, status: data.status, revision: revision + 1 } });
      return { account: accountView(accountRow(row.id)) };
    });
  }
  function recordStatement(actorId, accountId, data) {
    unknownKeys(data, ['netProfitCents','externalReference','evidence','periodStart','periodEnd','externalSettlementConfirmed','reason']);
    const net = integer(data.netProfitCents, 'Net realized profit or loss in cents', -maxMoney, maxMoney);
    const reference = text(data.externalReference, 'external statement reference', 120), evidence = text(data.evidence, 'statement evidence', 2000), why = reason(data.reason);
    const start = date(data.periodStart, 'period start'), end = date(data.periodEnd, 'period end');
    if (start && end && start > end) fail(400, 'The period end cannot precede its start.');
    if (data.externalSettlementConfirmed !== undefined && typeof data.externalSettlementConfirmed !== 'boolean') fail(400, 'Confirm whether the statement was externally settled.');
    return transaction(actorId, () => {
      const row = accountRow(accountId);
      if (row.status === 'closed') fail(409, 'Record the final statement before closing this account.');
      if (row.profit_sharing_policy === 'settled_period') {
        if (data.externalSettlementConfirmed !== true || !start || !end) fail(400, 'Settled-period sharing requires a settled external statement and its complete period dates.');
        if (end > new Date(now()).toISOString().slice(0, 10)) fail(400, 'An externally settled period cannot end after the current UTC date.');
        if (db.prepare('SELECT 1 FROM sponsored_statements WHERE account_id=? AND period_start<=? AND period_end>=? LIMIT 1').get(row.id,end,start)) fail(409, 'An external settled statement already covers part of that period.');
      }
      const previous = balance(row.id), cumulative = safeNumber(BigInt(previous.cumulativeNetProfitCents) + BigInt(net), 'Cumulative profit');
      const high = Math.max(previous.highWaterProfitCents, cumulative, 0);
      const share = row.profit_sharing_policy === 'cumulative_high_water' ? roundedShare(high,row.trader_share_bps) - roundedShare(previous.highWaterProfitCents,row.trader_share_bps) : roundedShare(net,row.trader_share_bps);
      safeNumber(BigInt(previous.earnedCents) + BigInt(share), 'Earned share');
      const company = net - share, statementId = randomUUID(), time = now();
      db.prepare(`INSERT INTO sponsored_statements(id,account_id,user_id,net_profit_cents,trader_share_cents,company_share_cents,cumulative_net_profit_cents,high_water_profit_cents,external_reference,reference_key,evidence,period_start,period_end,external_settlement_confirmed,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(statementId,row.id,row.user_id,net,share,company,cumulative,high,reference,reference.toLowerCase(),evidence,start,end,data.externalSettlementConfirmed === true ? 1 : 0,actorId,time);
      access.audit(actorId, 'finance.statement-recorded', { targetId: row.user_id, reason: why, detail: { accountId: row.id, statementId, netProfitCents: net, traderShareCents: share, companyShareCents: company, externalReference: reference, currency: 'USD' } });
      return { statement: statementView(db.prepare('SELECT * FROM sponsored_statements WHERE id=?').get(statementId)), account: accountView(accountRow(row.id)) };
    });
  }
  function payoutEvent(actorId, payoutId, previousStatus, status, why) { db.prepare('INSERT INTO sponsored_payout_events(id,payout_id,actor_user_id,previous_status,status,reason,created_at) VALUES (?,?,?,?,?,?,?)').run(randomUUID(),payoutId,actorId,previousStatus,status,why,now()); }
  function createPayout(actorId, data) {
    unknownKeys(data, ['accountId','amountCents','reason']);
    const accountId = id(data.accountId, 'sponsored account'), amount = integer(data.amountCents, 'Payout amount in cents', 1, maxMoney), why = reason(data.reason);
    return transaction(actorId, () => {
      const row = accountRow(accountId);
      if (balance(row.id).availableCents < amount) fail(409, 'The payout exceeds the unreserved recorded trader share.');
      const payoutId = randomUUID(), time = now();
      db.prepare("INSERT INTO sponsored_payouts(id,account_id,user_id,amount_cents,status,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'requested',?,?,?,?)").run(payoutId,row.id,row.user_id,amount,actorId,actorId,time,time);
      payoutEvent(actorId,payoutId,null,'requested',why);
      access.audit(actorId,'finance.payout-requested',{targetId:row.user_id,reason:why,detail:{accountId:row.id,payoutId,amountCents:amount,currency:'USD',status:'requested'}});
      return { payout: payoutView(payoutRow(payoutId)), account: accountView(accountRow(row.id)) };
    });
  }
  function createClientPayout(userId, data) {
    unknownKeys(data, ['accountId','amountCents','idempotencyKey']);
    const target = integer(userId, 'Trader ID', 1, Number.MAX_SAFE_INTEGER);
    const accountId = id(data.accountId, 'sponsored account'), amount = integer(data.amountCents, 'Payout amount in cents', 1, maxMoney);
    if (typeof data.idempotencyKey !== 'string' || !/^[A-Za-z0-9._:-]{16,128}$/.test(data.idempotencyKey)) fail(400, 'Provide a unique payout request key with 16–128 letters, digits, dots, underscores, colons, or hyphens.');
    const keyHash = createHash('sha256').update(data.idempotencyKey).digest('hex');
    return transaction(target, () => {
      // Scope the first account lookup to its owner. A valid UUID must not reveal
      // another trader's balance, firm, label, or request history.
      const row = db.prepare('SELECT * FROM sponsored_accounts WHERE id=? AND user_id=?').get(accountId,target);
      if (!row) fail(404, 'Sponsored account not found.');
      const existing = db.prepare('SELECT * FROM sponsored_client_payout_requests WHERE user_id=? AND request_key_hash=?').get(target,keyHash);
      if (existing) {
        if (existing.account_id !== row.id || existing.amount_cents !== amount) fail(409, 'This payout request key was already used for different details.', 'PAYOUT_REQUEST_CONFLICT');
        return {payout:payoutView(payoutRow(existing.payout_id),{client:true}),account:accountView(row,{client:true}),reused:true};
      }
      if (balance(row.id).availableCents < amount) fail(409, 'The payout exceeds your unreserved recorded earned share.', 'PAYOUT_BALANCE_EXCEEDED');
      const payoutId = randomUUID(), time = now(), why = 'Trader requested payment of their recorded earned share.';
      db.prepare("INSERT INTO sponsored_payouts(id,account_id,user_id,amount_cents,status,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,'requested',?,?,?,?)").run(payoutId,row.id,target,amount,target,target,time,time);
      db.prepare('INSERT INTO sponsored_client_payout_requests(user_id,request_key_hash,account_id,amount_cents,payout_id,created_at) VALUES (?,?,?,?,?,?)').run(target,keyHash,row.id,amount,payoutId,time);
      payoutEvent(target,payoutId,null,'requested',why);
      access.audit(target,'finance.payout-requested',{targetId:target,reason:why,detail:{accountId:row.id,payoutId,amountCents:amount,currency:'USD',status:'requested',source:'client-dashboard'}});
      return {payout:payoutView(payoutRow(payoutId),{client:true}),account:accountView(row,{client:true}),reused:false};
    },{client:true});
  }
  function updatePayout(actorId, payoutId, data) {
    unknownKeys(data, ['status','revision','externalPaymentReference','paidAt','reason']);
    if (!['approved','paid','rejected'].includes(data.status)) fail(400, 'Select approved, paid, or rejected.');
    const revision = integer(data.revision, 'Payout revision', 1, Number.MAX_SAFE_INTEGER), why = reason(data.reason);
    const paymentReference = text(data.externalPaymentReference, 'external payment reference', 120, { optional: true });
    if (data.status !== 'paid' && (paymentReference || data.paidAt !== undefined)) fail(400, 'Payment evidence can only be recorded when marking an approved payout paid.');
    return transaction(actorId, () => {
      const row = payoutRow(payoutId);
      if (row.revision !== revision) fail(409, 'The payout changed. Refresh before updating it.');
      if (!((row.status === 'requested' && ['approved','rejected'].includes(data.status)) || (row.status === 'approved' && ['paid','rejected'].includes(data.status)))) fail(409, 'That payout status change is not permitted.');
      let paidAt = null;
      if (data.status === 'paid') {
        if (!paymentReference) fail(400, 'Record the external payment reference before marking this payout paid.');
        paidAt = integer(data.paidAt, 'External payment time', row.created_at, now(), now());
      }
      db.prepare('UPDATE sponsored_payouts SET status=?,external_payment_reference=?,payment_reference_key=?,paid_at=?,updated_by=?,updated_at=?,revision=revision+1 WHERE id=? AND revision=?').run(data.status,paymentReference,paymentReference?.toLowerCase() ?? null,paidAt,actorId,now(),row.id,revision);
      payoutEvent(actorId,row.id,row.status,data.status,why);
      access.audit(actorId,`finance.payout-${data.status}`,{targetId:row.user_id,reason:why,detail:{accountId:row.account_id,payoutId:row.id,amountCents:row.amount_cents,currency:'USD',previousStatus:row.status,status:data.status,revision:revision+1,...(paymentReference ? {externalPaymentReference:paymentReference} : {})}});
      return { payout: payoutView(payoutRow(row.id)), account: accountView(accountRow(row.account_id)) };
    });
  }
  function clientView(userId) {
    const target = integer(userId, 'Trader ID', 1, Number.MAX_SAFE_INTEGER);
    const rows = db.prepare('SELECT a.* FROM sponsored_accounts a WHERE a.user_id=? ORDER BY a.created_at DESC,a.id LIMIT 100').all(target);
    const ownPayouts = db.prepare('SELECT p.*,a.firm_name,a.label FROM sponsored_payouts p JOIN sponsored_accounts a ON a.id=p.account_id WHERE p.user_id=? ORDER BY p.created_at DESC,p.id LIMIT 100').all(target);
    return { accounts: rows.map(row => accountView(row,{client:true})), payouts: ownPayouts.map(row => payoutView(row,{client:true})), accountsTotal: db.prepare('SELECT count(*) total FROM sponsored_accounts WHERE user_id=?').get(target).total, payoutsTotal: db.prepare('SELECT count(*) total FROM sponsored_payouts WHERE user_id=?').get(target).total, historyLimit:100, source:recordSource, transfersMoney:false };
  }
  function summary() {
    const accountCounts = Object.fromEntries(accountStatuses.map(status => [status,db.prepare('SELECT count(*) total FROM sponsored_accounts WHERE status=?').get(status).total]));
    let earned = 0n, reserved = 0n, paid = 0n, net = 0n;
    for (const row of db.prepare('SELECT net_profit_cents,trader_share_cents FROM sponsored_statements').all()) {net+=BigInt(row.net_profit_cents);earned+=BigInt(row.trader_share_cents);}
    for (const row of db.prepare("SELECT amount_cents,status FROM sponsored_payouts WHERE status!='rejected'").all()) {if(row.status==='paid')paid+=BigInt(row.amount_cents);else reserved+=BigInt(row.amount_cents);}
    return { accounts:accountCounts,payouts:Object.fromEntries(payoutStatuses.map(status=>[status,db.prepare('SELECT count(*) total FROM sponsored_payouts WHERE status=?').get(status).total])),netProfitCents:safeNumber(net,'Portfolio net profit'),earnedCents:safeNumber(earned,'Portfolio earned share'),reservedCents:safeNumber(reserved,'Portfolio reservations'),paidCents:safeNumber(paid,'Portfolio payments'),availableCents:safeNumber(earned-reserved-paid,'Portfolio available share'),currency:'USD',source:recordSource,transfersMoney:false };
  }
  return { accounts,accountDetail,createAccount,updateAccount,recordStatement,payouts,createPayout,createClientPayout,updatePayout,clientView,summary };
}
