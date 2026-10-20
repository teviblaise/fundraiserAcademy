import { randomUUID } from 'node:crypto';

export class AdminAccessError extends Error {
  constructor(status, message, code) { super(message); this.status = status; if (code) this.code = code; }
}

export const ADMIN_ROLES = Object.freeze(['owner', 'admin', 'reviewer', 'support']);
const permissions = {
  owner: ['overview.read','traders.read','traders.manage','assessments.read','contracts.read','contracts.publish','certificates.read','reviews.read','reviews.write','audit.read','staff.manage','support.manage','system.read','finance.read','finance.write','reports.export'],
  admin: ['overview.read','traders.read','traders.manage','assessments.read','contracts.read','contracts.publish','certificates.read','reviews.read','reviews.write','audit.read','support.manage','system.read','finance.read','finance.write','reports.export'],
  reviewer: ['overview.read','traders.read','assessments.read','contracts.read','certificates.read','reviews.read','reviews.write'],
  support: ['overview.read','support.manage'],
};
export const ADMIN_PERMISSIONS = Object.freeze(Object.fromEntries(Object.entries(permissions).map(([role, values]) => [role, Object.freeze(values)])));
const validId = id => Number.isSafeInteger(id) && id > 0;
const detailKeys = new Set(['role','previousRole','status','previousStatus','contractId','contractVersion','certificateId','reviewId','decision','previousDecision','count','source','subjectType','documentHash','fileName','format','title','supportConversationId','revision','reviewVersion','activeContractId','sessionsRevoked','deviceNotificationsRevoked','operator','userId','permission','accountId','statementId','payoutId','amountCents','netProfitCents','traderShareCents','companyShareCents','accountSizeCents','traderShareBps','currency','externalReference','externalPaymentReference']);
const denied = () => new AdminAccessError(403, 'This account does not have the required administrator access.', 'ADMIN_ACCESS_DENIED');

function textReason(value) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}]/u.test(value) || value.trim().length < 3 || value.trim().length > 2000) throw new AdminAccessError(400, 'Provide an administrative reason of 3–2,000 characters without control characters.');
  return value.trim();
}
function safeDetail(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new AdminAccessError(400, 'Provide valid audit metadata.');
  const keys = Object.keys(value);
  if (keys.length > 20 || keys.some(key => !detailKeys.has(key))) throw new AdminAccessError(400, 'Audit metadata contains unsupported fields.');
  const clean = {};
  for (const key of keys) {
    const item = value[key];
    if (item === null || typeof item === 'boolean' || typeof item === 'number' && Number.isFinite(item)) clean[key] = item;
    else if (typeof item === 'string' && item.length <= 512 && !/[\p{Cc}\p{Cf}]/u.test(item)) clean[key] = item;
    else throw new AdminAccessError(400, 'Audit metadata must contain bounded, non-secret scalar values.');
  }
  return clean;
}
function boundedInteger(value, fallback, min, max) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && !/^\d+$/.test(value)) throw new AdminAccessError(400, 'Invalid administrative page parameters.');
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new AdminAccessError(400, 'Invalid administrative page parameters.');
  return number;
}

export function initializeAdminSchema(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS admin_roles (
    user_id INTEGER PRIMARY KEY REFERENCES users(id), role TEXT NOT NULL CHECK(role IN ('owner','admin','reviewer','support')),
    granted_by INTEGER REFERENCES users(id), granted_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_account_status (
    user_id INTEGER PRIMARY KEY REFERENCES users(id), status TEXT NOT NULL CHECK(status IN ('active','suspended')),
    reason TEXT NOT NULL, updated_by INTEGER REFERENCES users(id), updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS admin_audit (
    id TEXT PRIMARY KEY, actor_user_id INTEGER REFERENCES users(id), target_user_id INTEGER REFERENCES users(id),
    action TEXT NOT NULL, reason TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS admin_audit_created ON admin_audit(created_at DESC,id DESC);
    CREATE INDEX IF NOT EXISTS admin_audit_target ON admin_audit(target_user_id,created_at DESC);
    CREATE TRIGGER IF NOT EXISTS admin_audit_no_update BEFORE UPDATE ON admin_audit
      BEGIN SELECT RAISE(ABORT, 'Administrative audit records are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS admin_audit_no_delete BEFORE DELETE ON admin_audit
      BEGIN SELECT RAISE(ABORT, 'Administrative audit records are immutable'); END;`);
}

export function createAdminAccess(db, { now = Date.now, ownerEmails = process.env.ADMIN_OWNER_EMAILS || '' } = {}) {
  initializeAdminSchema(db);
  const owners = new Set((Array.isArray(ownerEmails) ? ownerEmails : String(ownerEmails).split(',')).map(value => String(value).trim().toLowerCase()).filter(value => value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)));
  const rowFor = userId => validId(userId) ? db.prepare(`SELECT u.id,u.email,u.name,r.role,
    p.verified, t.secret IS NOT NULL AS factor_enabled, COALESCE(s.status,'active') AS account_status,
    r.granted_at,r.granted_by FROM users u LEFT JOIN admin_roles r ON r.user_id=u.id
    LEFT JOIN notification_preferences p ON p.user_id=u.id
    LEFT JOIN two_factor t ON t.user_id=u.id
    LEFT JOIN admin_account_status s ON s.user_id=u.id WHERE u.id=?`).get(userId) : null;

  function accountStatus(userId) {
    if (!validId(userId)) throw new AdminAccessError(400, 'Select a valid user account.');
    const row = db.prepare('SELECT status,reason,updated_by AS updatedBy,updated_at AS updatedAt FROM admin_account_status WHERE user_id=?').get(userId);
    return row || { status: 'active', reason: null, updatedBy: null, updatedAt: null };
  }
  function isSuspended(userId) { return validId(userId) && db.prepare("SELECT 1 FROM admin_account_status WHERE user_id=? AND status='suspended'").get(userId) !== undefined; }
  function context(userId) {
    const row = rowFor(userId);
    const environmentManaged = Boolean(row && owners.has(row.email));
    const role = row ? environmentManaged ? 'owner' : row.role ?? null : null;
    const emailVerified = Boolean(row?.verified);
    const twoFactorEnabled = Boolean(row?.factor_enabled);
    const active = Boolean(row && row.account_status === 'active');
    const eligible = Boolean(role && active && emailVerified && twoFactorEnabled);
    return { role, permissions: eligible ? [...ADMIN_PERMISSIONS[role]] : [], environmentManaged, emailVerified, twoFactorEnabled, active, eligible };
  }
  function requireAccess(userId, permission) {
    const current = context(userId);
    if (!current.eligible || typeof permission !== 'string' || !current.permissions.includes(permission)) throw denied();
    return current;
  }
  function audit(actorId, action, { targetId = null, reason, detail = {} } = {}) {
    if (actorId !== null && !validId(actorId) || targetId !== null && !validId(targetId)) throw new AdminAccessError(400, 'Select valid audit actors and targets.');
    if (typeof action !== 'string' || !/^[a-z][a-z0-9.-]{1,79}$/.test(action)) throw new AdminAccessError(400, 'Provide a valid administrative audit action.');
    const explanation = textReason(reason);
    const metadata = safeDetail(detail);
    const id = randomUUID();
    db.prepare('INSERT INTO admin_audit(id,actor_user_id,target_user_id,action,reason,detail,created_at) VALUES (?,?,?,?,?,?,?)').run(id, actorId, targetId, action, explanation, JSON.stringify(metadata), now());
    return { id };
  }
  function eligibleOwners(excludedId) {
    return db.prepare('SELECT id FROM users').all().filter(row => row.id !== excludedId && context(row.id).role === 'owner' && context(row.id).eligible).length;
  }
  function assertAccountChange(actorId, targetId, nextStatus) {
    if (!['active','suspended'].includes(nextStatus) || !validId(targetId) || !rowFor(targetId)) throw new AdminAccessError(400, 'Select a registered account and a valid status.');
    if (actorId !== null) requireAccess(actorId, 'traders.manage');
    const target = context(targetId);
    if (nextStatus === 'suspended') {
      if (actorId === targetId) throw new AdminAccessError(409, 'You cannot suspend your own account.');
      if (target.role === 'owner' && eligibleOwners(targetId) === 0) throw new AdminAccessError(409, 'Keep at least one active, verified owner with two-factor authentication.');
      if (target.role === 'owner' && actorId !== null && context(actorId).role !== 'owner') throw denied();
    }
    return target;
  }
  function assertRoleChange(actorId, targetId, nextRole) {
    if (actorId !== null) requireAccess(actorId, 'staff.manage');
    if (!validId(targetId) || !rowFor(targetId)) throw new AdminAccessError(404, 'The registered staff account was not found.');
    const target = context(targetId);
    if (target.environmentManaged) throw new AdminAccessError(409, 'This owner is managed by ADMIN_OWNER_EMAILS. Update the server setting and restart instead.');
    if (actorId === targetId && nextRole !== target.role) throw new AdminAccessError(409, 'You cannot remove or change your own administrator role.');
    if (target.role === 'owner' && nextRole !== 'owner' && eligibleOwners(targetId) === 0) throw new AdminAccessError(409, 'Keep at least one active, verified owner with two-factor authentication.');
    return target;
  }
  function grant(actorId, targetId, role, reason) {
    if (!ADMIN_ROLES.includes(role)) throw new AdminAccessError(400, 'Choose owner, admin, reviewer, or support.');
    const previous = assertRoleChange(actorId, targetId, role);
    const explanation = textReason(reason);
    if (!previous.active || !previous.emailVerified || !previous.twoFactorEnabled) throw new AdminAccessError(409, 'Staff accounts must be active, have a confirmed email, and enable two-factor authentication first.');
    db.prepare(`INSERT INTO admin_roles(user_id,role,granted_by,granted_at) VALUES (?,?,?,?)
      ON CONFLICT(user_id) DO UPDATE SET role=excluded.role,granted_by=excluded.granted_by,granted_at=excluded.granted_at`).run(targetId, role, actorId, now());
    audit(actorId, 'staff.role-granted', { targetId, reason: explanation, detail: { role, previousRole: previous.role, source: actorId === null ? 'local-server' : 'admin-dashboard' } });
    return context(targetId);
  }
  function revoke(actorId, targetId, reason) {
    const previous = assertRoleChange(actorId, targetId, null);
    const explanation = textReason(reason);
    if (!previous.role) throw new AdminAccessError(404, 'This account has no administrator role.');
    db.prepare('DELETE FROM admin_roles WHERE user_id=?').run(targetId);
    audit(actorId, 'staff.role-revoked', { targetId, reason: explanation, detail: { previousRole: previous.role, source: actorId === null ? 'local-server' : 'admin-dashboard' } });
    return context(targetId);
  }
  function staff() {
    return db.prepare('SELECT id,email,name FROM users WHERE id IN (SELECT user_id FROM admin_roles) OR email IN (SELECT value FROM json_each(?)) ORDER BY email,id')
      .all(JSON.stringify([...owners])).map(user => ({ ...user, ...context(user.id), grantedAt: rowFor(user.id).granted_at ?? null, grantedBy: rowFor(user.id).granted_by ?? null }));
  }
  function auditList({ limit = 50, offset = 0, actorId, targetId, action } = {}) {
    limit = boundedInteger(limit, 50, 1, 100); offset = boundedInteger(offset, 0, 0, 1000000);
    const clauses = [], parameters = [];
    for (const [column, value] of [['actor_user_id', actorId], ['target_user_id', targetId]]) {
      if (value !== undefined && value !== null && value !== '') { const id = boundedInteger(value, null, 1, Number.MAX_SAFE_INTEGER); clauses.push(`${column}=?`); parameters.push(id); }
    }
    if (action !== undefined && action !== '') { if (typeof action !== 'string' || !/^[a-z][a-z0-9.-]{1,79}$/.test(action)) throw new AdminAccessError(400, 'Choose a valid audit action.'); clauses.push('action=?'); parameters.push(action); }
    const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
    const total = db.prepare(`SELECT count(*) AS total FROM admin_audit${where}`).get(...parameters).total;
    const rows = db.prepare(`SELECT a.id,a.actor_user_id AS actorId,a.target_user_id AS targetId,a.action,a.reason,a.detail,a.created_at AS createdAt,
      actor.name AS actorName,target.name AS targetName FROM admin_audit a LEFT JOIN users actor ON actor.id=a.actor_user_id LEFT JOIN users target ON target.id=a.target_user_id${where.replaceAll('actor_user_id', 'a.actor_user_id').replaceAll('target_user_id', 'a.target_user_id').replaceAll('action=', 'a.action=')}
      ORDER BY a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`).all(...parameters, limit, offset).map(row => ({ ...row, detail: JSON.parse(row.detail) }));
    return { entries: rows, total, limit, offset };
  }
  return { context, require: requireAccess, staff, grant, revoke, audit, auditList, accountStatus, isSuspended, assertAccountChange };
}
