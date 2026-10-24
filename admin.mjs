import { createHash } from 'node:crypto';
import { certificateSvg } from './certificates.mjs';
import { createAdminData } from './admin-data.mjs';
import { createAdminWorkflows } from './admin-workflows.mjs';
import { createAdminFinance } from './admin-finance.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (status, message, code) => Object.assign(new Error(message), { status, code });
const privilegeLifetime = 5 * 60000;
const numericId = value => {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw fail(400, 'Select a valid registered account.');
  return Number(value);
};

export function createAdminConsole(db, { access, sessions, twoFactor, contracts, leaderboard, delivery, support,
  user, sessionHash, reauthenticate, body, respond, requireOrigin, limit, now = Date.now,
  revokeAccount, closeRevokedStreams, systemStatus, isStopping = () => false } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS admin_step_up (
    token TEXT PRIMARY KEY REFERENCES sessions(token) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id), fingerprint TEXT NOT NULL,
    expires INTEGER NOT NULL);`);
  const workflows = createAdminWorkflows(db, { access, contracts, leaderboard, now });
  const data = createAdminData(db, { now, workflows });
  const finance = createAdminFinance(db, { access, workflows, now });

  function fingerprint(id) {
    const state = twoFactor.snapshot(id), role = access.context(id);
    return digest(JSON.stringify({ password: digest(state.password), factor: state.version, generation: state.sessionVersion,
      role: role.role, permissions: [...role.permissions].sort(), environmentManaged: role.environmentManaged }));
  }
  function grantUntil(req, id) {
    const token = sessionHash(req);
    const row = db.prepare('SELECT fingerprint,expires FROM admin_step_up WHERE token=? AND user_id=?').get(token, id);
    if (!row) return null;
    if (row.expires <= now() || row.fingerprint !== fingerprint(id) || !access.context(id).eligible) {
      db.prepare('DELETE FROM admin_step_up WHERE token=?').run(token);
      return null;
    }
    return row.expires;
  }
  function privileged(req, id, permission) {
    if (user(req).id !== id) throw fail(401, 'Sign in again to continue.');
    const current = access.require(id, permission);
    if (!grantUntil(req, id)) throw fail(403, 'Confirm your password and a fresh two-factor code to make administrator changes.', 'ADMIN_REAUTH_REQUIRED');
    return current;
  }
  function transaction(work) {
    const owns = !db.isTransaction;
    if (owns) db.exec('BEGIN IMMEDIATE');
    try { const result = work(); if (owns) db.exec('COMMIT'); return result; }
    catch (error) { if (owns) db.exec('ROLLBACK'); throw error; }
  }
  function targetFrom(input) {
    const id = input.userId ?? input.targetId;
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : null;
    const row = id !== undefined ? db.prepare('SELECT id,email FROM users WHERE id=?').get(numericId(id))
      : email ? db.prepare('SELECT id,email FROM users WHERE email=?').get(email) : null;
    if (!row) throw fail(404, 'The registered account was not found.');
    if (email && row.email !== email) throw fail(400, 'The account ID and email do not identify the same account.');
    return row.id;
  }
  function contractDocument(id) {
    const row = db.prepare('SELECT id,title,version,hash,format,file_name,content FROM contract_documents WHERE id=?').get(id);
    if (!row) throw fail(404, 'Contract document not found.');
    const content = Buffer.from(row.content);
    if (digest(content) !== row.hash) throw fail(500, 'Stored contract integrity could not be verified.');
    return { ...row, content };
  }
  function clientView(id) { return { review: workflows.clientView(id), funding: finance.clientView(id) }; }

  async function handle(req, res, pathname, current) {
    if (pathname !== '/api/admin' && !pathname.startsWith('/api/admin/')) return false;
    requireOrigin(req);
    const query = Object.fromEntries(new URL(req.url, 'http://localhost').searchParams);
    const id = current.id;
    if (req.method === 'GET' && pathname === '/api/admin/access') {
      const context = access.context(id);
      respond(res, 200, { ...context, authorized: context.eligible, privilegesExpiresAt: context.eligible ? grantUntil(req,id) : null });
      return true;
    }
    // Permission checks precede parsing, expensive data reads, or uploads.
    access.require(id, 'overview.read');
    limit(req, `admin-read:${id}`, 180, 60000);
    if (req.method === 'POST' && pathname === '/api/admin/reauth') {
      limit(req, `admin-reauth:${id}`, 10, 600000);
      const input = await body(req);
      const expected = await reauthenticate(req, id, input.password);
      access.require(id, 'overview.read');
      let expiresAt;
      twoFactor.authorize(id, expected, input.code, { onAuthorized() {
        user(req); access.require(id, 'overview.read');
        if (isStopping()) throw fail(503, 'The server is restarting. Try again shortly.');
        expiresAt = now() + privilegeLifetime;
        db.prepare('INSERT INTO admin_step_up(token,user_id,fingerprint,expires) VALUES (?,?,?,?) ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id,fingerprint=excluded.fingerprint,expires=excluded.expires')
          .run(sessionHash(req), id, fingerprint(id), expiresAt);
        access.audit(id, 'admin.privilege-confirmed', { reason: 'Confirmed administrator credentials for a limited privileged session.', detail: { source:'admin-dashboard' } });
      } });
      respond(res, 200, { expiresAt, privilegesExpiresAt: expiresAt }); return true;
    }
    if (req.method === 'GET') {
      let result;
      if (pathname === '/api/admin/overview') { access.require(id,'overview.read'); result = data.overview(query); }
      else if (pathname === '/api/admin/traders') { access.require(id,'traders.read'); result = data.traders(query); }
      else if (/^\/api\/admin\/traders\/[1-9]\d*$/.test(pathname)) { access.require(id,'traders.read'); result = data.trader(numericId(pathname.split('/').at(-1)),query); }
      else if (/^\/api\/admin\/traders\/[1-9]\d*\/profit-sharing$/.test(pathname)) { access.require(id,'finance.read'); result = finance.profitSharing(numericId(pathname.split('/').at(-2))); }
      else if (pathname === '/api/admin/assessments') { access.require(id,'assessments.read'); result = data.assessments(query); }
      else if (pathname === '/api/admin/certificates') { access.require(id,'certificates.read'); result = data.certificatesPage(query); }
      else if (pathname === '/api/admin/contracts') { access.require(id,'contracts.read'); result = data.contractsPage(query); }
      else if (pathname === '/api/admin/reviews') { access.require(id,'reviews.read'); result = workflows.reviews(query); }
      else if (/^\/api\/admin\/reviews\/[1-9]\d*$/.test(pathname)) { access.require(id,'reviews.read'); result = workflows.review(numericId(pathname.split('/').at(-1))); }
      else if (pathname === '/api/admin/accounts') { access.require(id,'finance.read'); result = finance.accounts(query); }
      else if (/^\/api\/admin\/accounts\/[a-f0-9-]{36}$/.test(pathname)) { access.require(id,'finance.read'); result = finance.accountDetail(pathname.split('/').at(-1)); }
      else if (pathname === '/api/admin/payouts') { access.require(id,'finance.read'); result = finance.payouts(query); }
      else if (pathname === '/api/admin/staff') { access.require(id,'staff.manage'); result = { items:access.staff() }; }
      else if (pathname === '/api/admin/audit') { access.require(id,'audit.read'); result = access.auditList(query); }
      else if (pathname === '/api/admin/support') { access.require(id,'support.manage'); result = support.staffList(current,{before:query.before,status:query.status||'active'}); }
      else if (pathname === '/api/admin/system') { access.require(id,'system.read'); result = systemStatus(); }
      else if (pathname === '/api/admin/reports') {
        access.require(id,'reports.export'); privileged(req,id,'reports.export');
        result = data.report(query);
        access.audit(id,'report.exported',{reason:'Downloaded an administrator report with allowlisted fields.',detail:{subjectType:query.type||'traders',count:result.returned??result.rows?.length??0}});
      } else {
        const certificate = /^\/api\/admin\/certificates\/([a-f0-9-]{36})\.svg$/.exec(pathname);
        const contract = /^\/api\/admin\/contracts\/([a-f0-9-]{36})\/document$/.exec(pathname);
        if (certificate) {
          access.require(id,'certificates.read');
          const row = db.prepare('SELECT id,holder,issued_at AS issuedAt,initial_balance AS initialBalance,final_balance AS finalBalance,profit_percent AS profitPercent,trading_days AS tradingDays,price_mode AS priceMode FROM certificates WHERE id=?').get(certificate[1]);
          if (!row) throw fail(404,'Certificate not found.');
          res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"}); res.end(certificateSvg(row)); return true;
        }
        if (contract) {
          access.require(id,'contracts.read'); const document=contractDocument(contract[1]);
          res.writeHead(200,{'Content-Type':document.format==='pdf'?'application/pdf':'text/plain; charset=utf-8','Content-Length':document.content.length,'Content-Disposition':`inline; filename="${document.file_name.replace(/[^A-Za-z0-9._-]/g,'-')}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'self'",'X-Contract-SHA256':document.hash});res.end(document.content);return true;
        }
        throw fail(404,'Administrator endpoint not found.');
      }
      user(req); access.require(id,'overview.read');
      respond(res,200,result); return true;
    }
    if (req.method !== 'POST') throw fail(405,'Use GET or POST for administrator requests.');
    const traderAction = /^\/api\/admin\/traders\/([1-9]\d*)\/(status|revoke-sessions|notes)$/.exec(pathname);
    const reviewAction = /^\/api\/admin\/reviews\/([1-9]\d*)$/.exec(pathname);
    const relationshipAction = /^\/api\/admin\/traders\/([1-9]\d*)\/profit-sharing$/.exec(pathname);
    const reinstatementPreparation = /^\/api\/admin\/traders\/([1-9]\d*)\/profit-sharing\/prepare-reinstatement$/.exec(pathname);
    const accountAction = /^\/api\/admin\/accounts\/([a-f0-9-]{36})(\/statements|\/receipts)?$/.exec(pathname);
    const payoutAction = /^\/api\/admin\/payouts\/([a-f0-9-]{36})(\/initiate)?$/.exec(pathname);
    const permission = traderAction ? traderAction[2]==='notes'?'reviews.write':'traders.manage' : reviewAction?'reviews.write'
      : pathname==='/api/admin/contracts'?'contracts.publish' : pathname.startsWith('/api/admin/staff/')?'staff.manage'
        : pathname==='/api/admin/accounts'||accountAction||pathname==='/api/admin/payouts'||payoutAction||relationshipAction||reinstatementPreparation?'finance.write':null;
    if (!permission) throw fail(404,'Administrator endpoint not found.');
    privileged(req,id,permission);
    limit(req,`admin-write:${id}`,60,600000);
    const input = await body(req, pathname==='/api/admin/contracts'?14*1024*1024:16384);
    privileged(req,id,permission);
    let result, revoked = null;
    if (traderAction) {
      const target=numericId(traderAction[1]);
      const options={onRevoke({userId}){privileged(req,id,permission);const removed=revokeAccount(userId);revoked=userId;return removed;}};
      result=traderAction[2]==='status'?workflows.updateStatus(id,target,input,options)
        :traderAction[2]==='revoke-sessions'?workflows.revokeSessions(id,target,input,options):workflows.appendNote(id,target,input);
    } else if (reviewAction) result=workflows.decideReview(id,numericId(reviewAction[1]),input);
    else if (pathname==='/api/admin/contracts') result=workflows.publishContract(id,input);
    else if (pathname==='/api/admin/accounts') result=finance.createAccount(id,input);
    else if (reinstatementPreparation) result=finance.prepareReinstatement(id,numericId(reinstatementPreparation[1]),input);
    else if (relationshipAction) result=finance.updateRelationship(id,numericId(relationshipAction[1]),input);
    else if (accountAction) result=accountAction[2]==='/receipts'?finance.recordClearedReceipt(id,accountAction[1],input):accountAction[2]?finance.recordStatement(id,accountAction[1],input):finance.updateAccount(id,accountAction[1],input);
    else if (pathname==='/api/admin/payouts') result=finance.createPayout(id,input);
    else if (payoutAction) result=payoutAction[2]?finance.initiatePayout(id,payoutAction[1],input):finance.updatePayout(id,payoutAction[1],input);
    else if (['/api/admin/staff/grant','/api/admin/staff/revoke'].includes(pathname)) {
      result=transaction(()=>{
        privileged(req,id,'staff.manage');
        const target=targetFrom(input);
        const role=pathname.endsWith('/grant')?access.grant(id,target,input.role,input.reason):access.revoke(id,target,input.reason);
        revokeAccount(target);revoked=target;
        return{...role,items:access.staff(),signedOut:target===id};
      });
    } else throw fail(404,'Administrator endpoint not found.');
    if(revoked!==null) closeRevokedStreams(revoked,'Your account access changed. Please sign in again.');
    respond(res,200,result);return true;
  }
  return { handle, clientView, data, finance, workflows, privileged };
}
