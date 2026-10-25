import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createAccount, advanceMarket, openTrade, closeTrade, refreshRisk, MARKETS, ensureTools, setLimits, updateStops, placeLimit, addAlert, notify, applyReferenceQuotes, markQuoteUnavailable, assertExecutableQuote, marketDependencies } from './public/simulator.js';
import { createDelivery } from './delivery.mjs';
import {createCertificates,certificateSvg} from './certificates.mjs';
import {createContracts,publishContractFile} from './contracts.mjs';
import {installProvidedAgreement} from './agreement.mjs';
import {createMarketData} from './market-data.mjs';
import {createSupport} from './support.mjs';
import {createLeaderboard} from './leaderboard.mjs';
import {createPasswordRecovery,passwordResetRequestMessage,passwordResetSuccessMessage} from './password-recovery.mjs';
import {createPasswordManager,nativeScrypt} from './passwords.mjs';
import {createTwoFactor} from './two-factor.mjs';
import {createSessions,sessionPolicy} from './sessions.mjs';
import QRCode from 'qrcode';
import {createAdminAccess} from './admin-access.mjs';
import {createAdminConsole} from './admin.mjs';
import {createAccountPlatform} from './account-platform.mjs';
import {parseTrustProxyHops,requestClientAddress} from './network-security.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const sessionLifetime = 7 * 86400000;
const isMarket = symbol => typeof symbol === 'string' && Object.hasOwn(MARKETS, symbol);
const preferredMarkets = ['I trade forex', 'I trade crypto', 'I trade both'];
class RequestError extends Error { constructor(status, message, code) { super(message); this.status = status; if (code) this.code = code; } }
function splitLegacyName(name) {
  const [firstName = '', ...rest] = name.trim().split(/\s+/u);
  return { firstName, otherNames: rest.join(' ') };
}
function namePart(value, label, required = false) {
  if (typeof value !== 'string' || /[\p{Cc}\p{Zl}\p{Zp}]/u.test(value)) throw new RequestError(400, `Enter a valid ${label} without control characters.`);
  const part = value.trim().replace(/\p{Zs}+/gu, ' ');
  if (part.length > 100 || required && !part || part && !/\p{L}/u.test(part)) throw new RequestError(400, `Enter a valid ${label}; your complete name must be at most 100 characters.`);
  return part;
}
function structuredName(data) {
  const firstName = namePart(data.firstName, 'first name', true);
  const otherNames = namePart(data.otherNames === undefined ? '' : data.otherNames, 'other names');
  const name = [firstName, otherNames].filter(Boolean).join(' ');
  if (name.length > 100) throw new RequestError(400, 'Your complete name must be at most 100 characters.');
  return { name, firstName, otherNames };
}
function registrationName(data) {
  if (Object.hasOwn(data, 'firstName') || Object.hasOwn(data, 'otherNames')) {
    const parts = structuredName(data);
    // A mixed request must identify one name, rather than silently choosing
    // between contradictory legal/certificate names from two client versions.
    if (Object.hasOwn(data, 'name') && (typeof data.name !== 'string' || data.name.trim().replace(/\p{Zs}+/gu, ' ') !== parts.name)) throw new RequestError(400, 'Your full name must match your first name and other names.');
    return parts;
  }
  const name = namePart(data.name, 'name', true);
  return { name, ...splitLegacyName(name) };
}
const publicUser = (row, emailVerified) => ({ id: row.id, name: row.name, firstName: row.first_name, otherNames: row.other_names, email: row.email, market: row.market, createdAt: row.created_at, emailVerified, emailConfirmationRequired: Boolean(row.email_confirmation_required), assessmentAccess: !row.email_confirmation_required || emailVerified });
export function createBackend(databasePath, { marketData: injectedMarketData, deliveryOptions, supportOptions, adminOptions, platformOptions, agreementOptions, passwordScrypt = nativeScrypt, qrEncoder = (uri, options) => QRCode.toDataURL(uri, options), twoFactorOptions, now = Date.now, tickMs = 5000, autoTick = true, streamTickMs = 1000 } = {}) {
  const trustedProxyHops = parseTrustProxyHops(process.env.TRUST_PROXY_HOPS);
  if (!Number.isFinite(streamTickMs) || streamTickMs < 10 || streamTickMs > 60000) throw new TypeError('Live account refresh must be between 10 and 60000 milliseconds.');
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, market TEXT NOT NULL, password TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (user_id INTEGER PRIMARY KEY REFERENCES users(id), state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  // Add split profile names without replacing the registered full name or any
  // immutable certificate/signature snapshots. The transaction makes upgrades
  // safe to resume and a restart never re-infers already edited names.
  db.exec('BEGIN');
  try {
    const columns = db.prepare('PRAGMA table_info(users)').all();
    if (!columns.some(column => column.name === 'first_name')) db.exec("ALTER TABLE users ADD COLUMN first_name TEXT NOT NULL DEFAULT ''");
    if (!columns.some(column => column.name === 'other_names')) db.exec("ALTER TABLE users ADD COLUMN other_names TEXT NOT NULL DEFAULT ''");
    // Existing clients keep their earned assessment access. Only new signups
    // receive the mandatory confirmation flag when they are inserted below.
    if (!columns.some(column => column.name === 'email_confirmation_required')) db.exec('ALTER TABLE users ADD COLUMN email_confirmation_required INTEGER NOT NULL DEFAULT 0');
    const migrateName = db.prepare('UPDATE users SET first_name=?, other_names=? WHERE id=?');
    for (const row of db.prepare("SELECT id,name FROM users WHERE first_name=''").all()) {
      const parts = splitLegacyName(row.name);
      migrateName.run(parts.firstName, parts.otherNames, row.id);
    }
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); db.close(); throw error; }
  const sessions = createSessions(db, { now });
  const twoFactor = createTwoFactor(db, databasePath, { now, ...twoFactorOptions });
  const delivery=createDelivery(db,databasePath,deliveryOptions);
  const adminAccess=createAdminAccess(db,{now,...adminOptions});
  const profileView = row => publicUser(row, Boolean(db.prepare('SELECT verified FROM notification_preferences WHERE user_id=?').get(row.id)?.verified));
  const certificates=createCertificates(db);
  const contracts=createContracts(db);
  if(agreementOptions?.install!==false)installProvidedAgreement(contracts,{now:now()});
  const leaderboard=createLeaderboard(db,{now});
  const marketData=injectedMarketData ?? createMarketData();
  const support=createSupport(db,{now,staffAccess:id=>{const context=adminAccess.context(id);return context.eligible&&context.permissions.includes('support.manage');},...supportOptions});
  const queues = new Map();
  const timerPending = new Set();
  const securityPending = new Set();
  const streams = new Map();
  const streamPending = new Set();
  const streamEpoch = randomUUID();
  const streamBufferLimit = 262144;
  let streamCount = 0;
  let stopping = false;
  let closePromise;
  const passwords = createPasswordManager({ scrypt: passwordScrypt });
  const passwordRecovery = createPasswordRecovery(db, {
    delivery, now, isAvailable: () => !stopping,
    hashPassword: passwords.encode,
    onCommitReset(id) {
      sessions.bumpVersion(id);
      twoFactor.invalidateAuthentication(id);
      db.prepare('UPDATE users SET recovery_required=0 WHERE id=?').run(id);
    },
    onReset(id) {
      for (const connection of [...(streams.get(id) ?? [])]) endStream(connection, 'auth-expired', { error: 'Your password was changed. Please log in again.' });
    },
  });
  if(process.env.CONTRACT_FILE)publishContractFile(contracts,{file:process.env.CONTRACT_FILE,version:process.env.CONTRACT_VERSION,title:process.env.CONTRACT_TITLE});
  const rates = new Map();
  const respond = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
  function limit(req, group, max, duration) {
    limitKey(`${requestClientAddress(req,trustedProxyHops)}:${group}`, max, duration);
  }
  function limitKey(key, max, duration) {
    const now = Date.now(); const value = rates.get(key);
    if (!value || value.until < now) rates.set(key, { count: 1, until: now + duration });
    else if (++value.count > max) throw new RequestError(429, 'Too many requests. Please try again later.');
    if (rates.size > 10000) for (const [k, v] of rates) if (v.until < now) rates.delete(k);
  }
  function requireOrigin(req) {
    const origin = req.headers.origin;
    const allowed = process.env.APP_ORIGIN;
    if (origin) {
      let matches = false;
      try { matches = allowed ? origin === allowed : new URL(origin).host === req.headers.host; } catch { /* Reject malformed origins. */ }
      if (!matches) throw new RequestError(403, 'Request origin is not allowed.');
    }
  }
  async function body(req, maxBytes = 16384) {
    if (req.headers['x-requested-with'] !== 'FundraiserAcademy' || !req.headers['content-type']?.startsWith('application/json')) throw new RequestError(403, 'Use the website to submit this request.');
    requireOrigin(req);
    let content = '';
    for await (const chunk of req) { content += chunk; if (Buffer.byteLength(content) > maxBytes) throw new RequestError(413, 'Request is too large.'); }
    if (stopping) throw new RequestError(503, 'The trading server is restarting. Please try again shortly.');
    try { const data = JSON.parse(content); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; }
    catch { throw new RequestError(400, 'Invalid JSON request.'); }
  }
  function cookie(res, token, maxAge = sessionLifetime / 1000) {
    res.setHeader('Set-Cookie', `fa_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
  }
  function sessionHash(req) {
    const token = /(?:^|;\s*)fa_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    return token ? hash(token) : null;
  }
  function user(req) {
    const token = sessionHash(req);
    if (!token) throw new RequestError(401, 'Please log in to continue.');
    const found = sessions.lookup(token);
    if (!found) throw new RequestError(401, 'Your session has expired. Please log in again.');
    assertActive(found.user.id);
    return profileView(found.user);
  }
  function assertActive(id) {
    if(platform.controls.isDeleted(id))throw new RequestError(401,'This account has been closed.','ACCOUNT_DELETED');
    if(db.prepare('SELECT recovery_required FROM users WHERE id=?').get(id)?.recovery_required)throw new RequestError(403,'Recover your password before signing in after a system restore.','RECOVERY_REQUIRED');
    if(adminAccess.isSuspended(id)) throw new RequestError(403,'This account is suspended. Contact academy support for an account review.','ACCOUNT_SUSPENDED');
  }
  function newSession(req, id, expectedVersion) {
    assertActive(id);
    const token = randomBytes(32).toString('hex');
    sessions.create(id, hash(token), { userAgent: req.headers['user-agent'], expectedVersion });
    return token;
  }
  function session(req, res, id, expectedVersion) { cookie(res, newSession(req, id, expectedVersion)); }
  function revokePresentedSession(req) {
    const old = sessions.lookup(sessionHash(req), { touch: false });
    if (!old) return;
    sessions.revoke(old.user.id, old.session.id);
    closeRevokedStreams(old.user.id);
  }
  function securityView(id, currentHash) {
    const enrollmentAllowed = Boolean(db.prepare('SELECT verified FROM notification_preferences WHERE user_id=?').get(id)?.verified);
    return { twoFactor: { ...twoFactor.status(id), enrollmentAllowed }, sessions: sessions.list(id, currentHash), sessionsTotal: sessions.count(id), ...sessionPolicy };
  }
  function requireVerifiedEnrollment(req, id) {
    const current = user(req);
    if (current.id !== id) throw new RequestError(401, 'Please log in again.');
    // A password chosen by someone who pre-registers another person's address
    // must never let that person bind their authenticator to the mailbox owner.
    // Grandfathered assessment access is independent of this ownership check.
    if (!current.emailVerified) throw new RequestError(403, 'Confirm your email before enabling two-factor authentication. Open your client dashboard to verify your address.', 'EMAIL_CONFIRMATION_REQUIRED');
  }
  function closeRevokedStreams(id, message = 'Your session was signed out. Please log in again.') {
    for (const connection of [...(streams.get(id) ?? [])]) {
      if (!sessions.lookup(connection.token, { touch: false })) endStream(connection, 'auth-expired', { error: message });
    }
  }
  async function reauthenticate(req, id, password) {
    // Capture every credential generation before the asynchronous password KDF.
    // A reset, enrollment, or sign-out that wins that race invalidates this proof.
    const expected = twoFactor.snapshot(id);
    const matches = await passwords.verify(typeof password === 'string' && [...password].length <= 128 ? password : '', expected.password);
    if (stopping) throw new RequestError(503, 'The server is restarting. Please try again shortly.');
    if (user(req).id !== id) throw new RequestError(401, 'Please log in again.');
    twoFactor.assertSnapshot(id, expected);
    if (!matches) throw new RequestError(401, 'Your current password is incorrect.', 'PASSWORD_REAUTHENTICATION_FAILED');
    return expected;
  }
  function rotateSecuritySession(req, id, action) {
    // Called synchronously inside the factor transaction, so credential changes
    // and session revocation either all commit or all roll back together.
    user(req);
    sessions.revokeAll(id);
    const version = sessions.bumpVersion(id);
    twoFactor.invalidateAuthentication(id);
    delivery.revokeDeviceNotifications(id);
    const token = newSession(req, id, version);
    event(id, 'security-change', { action, sessionsRevoked: true, deviceNotificationsRevoked: true });
    const notices = { enabled: 'two-factor-enabled', disabled: 'two-factor-disabled', 'recovery-regenerated': 'recovery-codes-regenerated' };
    if (notices[action]) delivery.queueSecurityNotice(id, notices[action]);
    return token;
  }
  function revokeAccount(id) {
    const removed=sessions.revokeAll(id);
    sessions.bumpVersion(id);
    twoFactor.invalidateAuthentication(id);
    delivery.revokeDeviceNotifications(id);
    return {count:removed.count};
  }
  const adminConsole=createAdminConsole(db,{access:adminAccess,sessions,twoFactor,contracts,leaderboard,delivery,support,
    user,sessionHash,reauthenticate,body,respond,requireOrigin,limit,now,revokeAccount,closeRevokedStreams,isStopping:()=>stopping,
    systemStatus(){
      const mail=delivery.status(0);
      const stream=marketData.streamStatus?.('BTCUSD');
      const sponsored=platform.sponsored.status();
      return {generatedAt:now(),application:{mode:'single-server',database:'SQLite',nodeVersion:process.versions.node},
        security:{adminTwoFactorRequired:true,privilegeMinutes:5,sessionDays:7,idleHours:24,ownerConfigured:Boolean(adminOptions?.ownerEmails||process.env.ADMIN_OWNER_EMAILS)},
        integrations:[
          {name:'Transactional email',configured:mail.emailAvailable,status:mail.emailAvailable?'configured':'not_configured',description:'Resend sender configuration; configured does not confirm inbox receipt.'},
          {name:'Forex reference prices',configured:Boolean(process.env.TWELVE_DATA_API_KEY),status:process.env.TWELVE_DATA_API_KEY?'configured':'not_configured',description:'Twelve Data Basic periodic quotes. Provider availability is checked during execution.'},
          {name:'Crypto reference prices',configured:true,status:stream?.connected?'stream_connected':'REST_fallback',description:'Public Coinbase prices; source freshness still controls simulated fills.'},
          {name:'Generative support',configured:Boolean(process.env.SUPPORT_AI_API_KEY),status:process.env.SUPPORT_AI_API_KEY?'configured':'academy_guide',description:'Company guide remains available without AI credentials.'},
          {name:'Sponsored MetaTrader performance',configured:sponsored.configured,status:sponsored.configured?'configured':'not_configured',description:'MetaApi reads linked existing accounts. Configuration does not confirm live synchronization; inspect Operations and MetaTrader connections.'},
          {name:'Payment execution',configured:false,status:'manual_records',description:'Staff reconcile statements and record externally executed payments. This application does not send money.'}],
        storage:{durability:'Keep the private database directory on persistent operator-managed storage.',backups:'Encrypted scheduled backups and isolated recovery checks are available in Operations. Preserve the separate backup encryption key and copy backups off this server.'},
        outbox:{pending:db.prepare("SELECT count(*) n FROM notification_outbox WHERE status IN ('pending','sending')").get().n,failed:db.prepare("SELECT count(*) n FROM notification_outbox WHERE status='failed'").get().n}};
    }});
  const platform=createAccountPlatform(db,databasePath,{admin:adminConsole,access:adminAccess,sessions,twoFactor,
    user,sessionHash,reauthenticate,body,respond,requireOrigin,limit,revokeAccount,closeRevokedStreams,
    configuration:()=>({emailAvailable:delivery.status(0).emailAvailable,forexConfigured:Boolean(process.env.TWELVE_DATA_API_KEY)}),
    now,options:platformOptions});
  const revision = state => Number.isSafeInteger(state.revision) && state.revision >= 0 ? state.revision : 0;
  const load = id => {
    const state = ensureTools(JSON.parse(db.prepare('SELECT state FROM accounts WHERE user_id=?').get(id).state));
    state.revision = revision(state);
    state.streamEpoch = streamEpoch;
    return state;
  };
  const save = (id, state) => {
    const previous = JSON.parse(db.prepare('SELECT state FROM accounts WHERE user_id=?').get(id).state);
    state.revision = revision(previous) + 1;
    state.streamEpoch = streamEpoch;
    const result=db.prepare('UPDATE accounts SET state=? WHERE user_id=?').run(JSON.stringify(state), id);
    if(result.changes)platform.reports.captureAssessment(id,state,now());
    return result;
  };
  const event = (id, kind, detail) => db.prepare('INSERT INTO events(user_id,kind,detail,created_at) VALUES (?,?,?,?)').run(id, kind, JSON.stringify(detail), Date.now());
  function commit(id, state, kind, detail) {
    const previous=load(id);
    const oldNotices=new Set(previous.notifications.map(n=>`${n.createdAt}:${n.id}`));
    db.exec('BEGIN');
    try { certificates.issue(id,state,now()); const fresh=state.notifications.filter(n=>!oldNotices.has(`${n.createdAt}:${n.id}`)); save(id,state); event(id,kind,detail); delivery.enqueue(id,state,fresh); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // Every operation that writes account state shares one queue with background fills.
  // Provider calls may await the network, so loading and saving outside this queue
  // could otherwise overwrite an intervening trade or reset.
  function serialized(id, work) {
    if (stopping) return Promise.reject(new RequestError(503, 'The trading server is restarting. Please try again shortly.'));
    const task = (queues.get(id) ?? Promise.resolve()).then(() => {
      if (stopping) throw new RequestError(503, 'The trading server is restarting. Please try again shortly.');
      return work();
    });
    const settled = task.catch(() => {});
    queues.set(id, settled);
    settled.then(() => { if (queues.get(id) === settled) queues.delete(id); });
    return task;
  }
  function requireReferenceAccount(state) {
    if (state.migrationRequired) throw new RequestError(409, 'This earlier assessment uses retired prices. Reset the practice account to begin a reference-price assessment. Earlier results and certificates remain saved.');
  }
  function requireFresh(state, symbols) {
    for (const symbol of new Set(symbols)) {
      try { assertExecutableQuote(state, symbol, now()); }
      catch (error) { throw new RequestError(503, error.message); }
    }
  }
  async function syncReferenceState(id, requestedSymbols = []) {
    if(platform.controls.isDeleted(id))throw new RequestError(401,'This account has been closed.','ACCOUNT_DELETED');
    const before = load(id);
    // Old fills must never receive a windfall from changing their price source.
    if (before.migrationRequired) return before;
    const requested = [
      ...requestedSymbols,
      ...before.positions.map(p => p.symbol),
      ...before.pending.map(p => p.symbol),
      ...before.alerts.filter(a => a.active).map(a => a.symbol),
    ];
    const symbols = [...new Set(requested.flatMap(symbol=>marketDependencies(symbol)))];
    const quotes = await Promise.allSettled(symbols.map(symbol => marketData.getExecutionQuote(symbol)));
    if (stopping) throw new RequestError(503, 'The trading server is restarting. Please try again shortly.');
    if(platform.controls.isDeleted(id))throw new RequestError(401,'This account has been closed.','ACCOUNT_DELETED');
    // Reload after the await; account mutations are serialized, while independent
    // preference changes and certificate records can still be written normally.
    const state = load(id);
    for (let i = 0; i < symbols.length; i++) {
      const symbol = symbols[i], result = quotes[i];
      try {
        if (result.status === 'rejected') throw result.reason;
        if (result.value?.symbol !== symbol) throw new Error('The market provider returned a mismatched reference price.');
        applyReferenceQuotes(state, [result.value], now());
      } catch (error) { markQuoteUnavailable(state, symbol, error?.message || 'Reference price unavailable.'); }
    }
    const notices = state.nextNotice;
    const historyCount = state.history.length;
    const previousStatus = state.locked;
    advanceMarket(state, now());
    if (state.nextNotice !== notices || state.history.length !== historyCount || state.locked !== previousStatus) {
      commit(id, state, 'reference-market-event', { closedTrades: state.history.slice(0, state.history.length - historyCount), notifications: state.notifications.filter(n => n.id >= notices), status: state.locked });
    } else save(id, state);
    return state;
  }
  // Live browser updates are snapshots of the same persisted account used for
  // fills and risk checks. The browser never supplies prices to this channel.
  function removeStream(connection) {
    if (connection.closed) return;
    connection.closed = true;
    connection.req.removeListener('aborted', connection.cleanup);
    connection.res.removeListener('close', connection.cleanup);
    const connections = streams.get(connection.userId);
    connections?.delete(connection);
    if (connections?.size === 0) streams.delete(connection.userId);
    streamCount--;
  }
  function endStream(connection, eventName, data) {
    if (connection.closed) return;
    removeStream(connection);
    if (connection.res.destroyed || connection.res.writableEnded) return;
    if (connection.res.writableLength >= streamBufferLimit) { connection.res.destroy(); return; }
    connection.res.end(eventName ? `event: ${eventName}\ndata: ${JSON.stringify(data)}\n\n` : undefined);
  }
  function validStream(connection) {
    if (connection.closed || stopping) return false;
    if (connection.res.destroyed || connection.res.writableEnded) { removeStream(connection); return false; }
    const found = sessions.lookup(connection.token, { touch: false });
    if (!found || found.user.id !== connection.userId || adminAccess.isSuspended(connection.userId)) {
      endStream(connection, 'auth-expired', { error: 'Your session has expired. Please log in again.' });
      return false;
    }
    return true;
  }
  function writeStream(connection, frame) {
    if (!validStream(connection)) return;
    // Never hold an account queue waiting for a slow browser to consume data.
    // A long journal may produce a large legitimate snapshot. Allow that frame
    // through once, then disconnect if it remains queued when another arrives.
    if (connection.res.writableLength >= streamBufferLimit || connection.accountFramePending && connection.res.writableLength > 0) {
      removeStream(connection); connection.res.destroy(); return;
    }
    connection.accountFramePending = false;
    try {
      const accepted = connection.res.write(frame);
      if (frame.startsWith('event: account\n')) connection.accountFramePending = accepted === false || connection.res.writableLength > 0;
    }
    catch { removeStream(connection); connection.res.destroy(); }
  }
  function activeStreams(id) {
    return [...(streams.get(id) ?? [])].filter(validStream);
  }
  function refreshStreams(id) {
    if (stopping || streamPending.has(id) || !streams.has(id)) return;
    // At most one queued/in-flight refresh per account, even with several tabs.
    streamPending.add(id);
    return serialized(id, async () => {
      const connections = activeStreams(id);
      if (!connections.length) return;
      const symbols = [...new Set(connections.map(connection => connection.symbol))];
      const account = await syncReferenceState(id, symbols);
      if (stopping) return;
      for (const connection of activeStreams(id)) {
        writeStream(connection, `event: account\ndata: ${JSON.stringify({ account, symbol: connection.symbol, serverTime: now() })}\n\n`);
      }
    }).catch(error => {
      if (stopping) return;
      console.error('Live account refresh failed:', error.message);
      for (const connection of activeStreams(id)) writeStream(connection, `event: stream-error\ndata: ${JSON.stringify({ error: 'Live account updates are temporarily unavailable.' })}\n\n`);
    }).finally(() => streamPending.delete(id));
  }
  function openStream(req, res, current, symbol) {
    requireOrigin(req);
    limit(req, `account-stream:${current.id}`, 60, 60000);
    if ((streams.get(current.id)?.size ?? 0) >= 4 || streamCount >= 1000) throw new RequestError(429, 'Too many live dashboard connections. Close another dashboard tab and try again.');
    const connection = { req, res, userId: current.id, token: sessionHash(req), symbol, closed: false };
    connection.cleanup = () => removeStream(connection);
    if (!streams.has(current.id)) streams.set(current.id, new Set());
    streams.get(current.id).add(connection); streamCount++;
    req.once('aborted', connection.cleanup);
    res.once('close', connection.cleanup);
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store, no-transform',
      'X-Content-Type-Options': 'nosniff',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    writeStream(connection, 'retry: 3000\n\n');
    void refreshStreams(current.id);
  }
  const streamTimer = setInterval(() => {
    if (!stopping) for (const id of streams.keys()) void refreshStreams(id);
  }, streamTickMs);
  streamTimer.unref();
  const heartbeatTimer = setInterval(() => {
    if (!stopping) for (const connections of streams.values()) for (const connection of connections) writeStream(connection, ': heartbeat\n\n');
  }, 15000);
  heartbeatTimer.unref();
  // Existing passed attempts retain their completion and certificates, including
  // legacy attempts that are now frozen until their owner explicitly resets.
  for(const row of db.prepare('SELECT user_id,state FROM accounts').all()) {
    const state=ensureTools(JSON.parse(row.state));save(row.user_id,state);
    if(state.locked==='Profit target achieved')commit(row.user_id,state,'certificate-check',{});
  }
  const timer = autoTick ? setInterval(() => {
    if (stopping) return;
    try {
      // Open exposure, pending orders, and alerts remain protected after logout
      // or session expiry. Flat idle accounts do not generate ticker traffic.
      const rows = db.prepare(`SELECT accounts.user_id,accounts.state FROM accounts
        JOIN users ON users.id=accounts.user_id
        WHERE (users.email_confirmation_required=0 OR EXISTS (SELECT 1 FROM notification_preferences WHERE notification_preferences.user_id=users.id AND notification_preferences.verified=1))
        AND (EXISTS (SELECT 1 FROM sessions WHERE sessions.user_id=accounts.user_id AND sessions.expires>?)
          OR json_array_length(accounts.state,'$.positions')>0
          OR json_array_length(accounts.state,'$.pending')>0
          OR EXISTS (SELECT 1 FROM json_each(accounts.state,'$.alerts') AS alert WHERE json_extract(alert.value,'$.active')=1))`).all(Date.now());
      for (const row of rows) {
        const state = ensureTools(JSON.parse(row.state));
        if (state.migrationRequired || timerPending.has(row.user_id) || streamPending.has(row.user_id)) continue;
        const watching = state.positions.length || state.pending.length || state.alerts.some(a => a.active);
        const dailyLock = ['Daily loss limit', 'Personal daily loss limit'].includes(state.locked);
        if (!watching && !dailyLock) continue;
        timerPending.add(row.user_id);
        serialized(row.user_id, () => syncReferenceState(row.user_id)).catch(error => {
          if (!stopping) console.error('Reference-price tick failed:', error.message);
        }).finally(() => timerPending.delete(row.user_id));
      }
    } catch (error) { if (!stopping) console.error('Reference-price tick failed:', error.message); }
  }, tickMs) : null;
  timer?.unref();

  async function handle(req, res, pathname) {
    try {
      if (stopping) throw new RequestError(503, 'The trading server is restarting. Please try again shortly.');
      if (req.method === 'GET' && pathname === '/api/leaderboard') {
        limit(req, 'leaderboard-public', 20, 60000);
        const query = new URL(req.url, 'http://localhost').searchParams;
        const number = (key, fallback) => query.has(key) && /^\d+$/.test(query.get(key)) ? Number(query.get(key)) : query.has(key) ? NaN : fallback;
        respond(res, 200, leaderboard.page({limit:number('limit',20),offset:number('offset',0)})); return;
      }
      if (req.method === 'GET' && pathname === '/api/registration-status') {
        limit(req, 'registration-status', 120, 60000);
        respond(res, 200, { emailConfirmationAvailable: delivery.status(0).emailAvailable }); return;
      }
      if(req.method==='POST' && pathname==='/api/email/verify') {
        limit(req,'verification',30,600000);
        const data=await body(req);
        try {delivery.verify(data.token);}catch(error){throw new RequestError(400,error.message);}
        respond(res,200,{message:'Your email address is confirmed. You can continue to your client dashboard.'});return;
      }
      if (req.method === 'POST' && pathname === '/api/password/forgot') {
        let throttled = false;
        try { limit(req, 'password-forgot', 200, 600000); }
        catch (error) { if (error.status !== 429) throw error; throttled = true; }
        const data = await body(req);
        if (!throttled) passwordRecovery.request(data.email);
        respond(res, 202, { message: passwordResetRequestMessage }); return;
      }
      if (req.method === 'POST' && pathname === '/api/password/reset') {
        limit(req, 'password-reset', 100, 600000);
        const data = await body(req);
        if (typeof data.token === 'string' && /^[a-f0-9]{64}$/.test(data.token)) limitKey(`password-reset-token:${hash(data.token)}`, 10, 600000);
        try { await passwordRecovery.reset(data.token, data.password); }
        catch (error) { if (error.status) throw new RequestError(error.status, error.message, error.code); throw error; }
        cookie(res, '', 0);
        respond(res, 200, { message: passwordResetSuccessMessage }); return;
      }
      if (req.method === 'POST' && pathname === '/api/login/2fa/cancel') {
        limit(req, 'auth-factor-cancel', 60, 600000);
        const data = await body(req);
        twoFactor.cancelChallenge(data.challenge);
        respond(res, 200, { cancelled: true }); return;
      }
      if (req.method === 'POST' && pathname === '/api/login/2fa') {
        limit(req, 'auth-factor', 100, 600000);
        const data = await body(req);
        if (typeof data.challenge === 'string' && /^[a-f0-9]{64}$/.test(data.challenge)) limitKey(`auth-factor:${hash(data.challenge)}`, 10, 600000);
        let token;
        const completed = twoFactor.completeChallenge(data.challenge, data.code, {
          onComplete({ userId, method }) {
            assertActive(userId);
            token = newSession(req, userId, sessions.version(userId));
            event(userId, 'login', { twoFactor: true, method });
          },
        });
        cookie(res, token);
        respond(res, 200, { user: profileView(db.prepare('SELECT * FROM users WHERE id=?').get(completed.userId)) }); return;
      }
      if (req.method === 'POST' && ['/api/register','/api/login'].includes(pathname)) {
        limit(req,'auth',20,600000);
        const data = await body(req);
        const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
        const password = typeof data.password === 'string' ? data.password : '';
        const passwordLength = [...password].length;
        // Sign-in accepts existing credentials, including passwords created
        // before Unicode characters were counted by code point at registration.
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || passwordLength < (pathname === '/api/register' ? 12 : 1) || passwordLength > 128) throw new RequestError(400, pathname === '/api/register' ? 'Enter a valid email and a password with 12–128 characters.' : 'Enter a valid email and password.');
        if (pathname === '/api/register') {
          const { name, firstName, otherNames } = registrationName(data);
          if (!preferredMarkets.includes(data.market) || data.consent !== true) throw new RequestError(400,'Enter your name, select your market, and accept the registration notice.');
          const passwordHash = await passwords.encodeLegacy(password);
          if (stopping) throw new RequestError(503, 'The trading server is restarting. Please try again shortly.');
          let id;
          db.exec('BEGIN');
          try {
            id = Number(db.prepare('INSERT INTO users(email,name,first_name,other_names,market,password,created_at,email_confirmation_required) VALUES (?,?,?,?,?,?,?,1)').run(email,name,firstName,otherNames,data.market,passwordHash,Date.now()).lastInsertRowid);
            db.prepare('INSERT INTO accounts VALUES (?,?)').run(id,JSON.stringify(createAccount(now())));
            event(id,'registration',{}); db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); if (error.code?.includes('CONSTRAINT') || error.message.includes('UNIQUE')) throw new RequestError(409,'Unable to register this email. Try logging in.'); throw error; }
          const confirmation = { required: true, available: delivery.status(id).emailAvailable, queued: false, status: 'unavailable' };
          try {
            const queued = await delivery.requestVerification(id, { purpose: 'account' });
            Object.assign(confirmation, queued, { queued: true, status: 'queued' });
          } catch (error) { confirmation.error = error.message; }
          session(req,res,id); respond(res,201,{user:profileView(db.prepare('SELECT * FROM users WHERE id=?').get(id)),confirmation}); return;
        }
        const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
        const expected = row ? twoFactor.snapshot(row.id) : null;
        const matches = await passwords.verify(password, row?.password);
        if (stopping) throw new RequestError(503, 'The trading server is restarting. Please try again shortly.');
        // A reset can complete while scrypt is running. An old credential must
        // never create a fresh session after the reset revoked existing ones.
        if (!row || !matches || db.prepare('SELECT password FROM users WHERE id=?').get(row.id)?.password !== row.password) throw new RequestError(401,'Email or password is incorrect.');
        assertActive(row.id);
        twoFactor.assertSnapshot(row.id, expected);
        if (expected.enabled) {
          const challenge = twoFactor.createChallenge(row.id, expected);
          // Starting another sign-in must not leave an earlier account's full
          // authentication cookie available behind the factor challenge UI.
          revokePresentedSession(req);
          cookie(res, '', 0);
          respond(res, 202, { twoFactorRequired: true, ...challenge }); return;
        }
        revokePresentedSession(req);
        session(req,res,row.id,expected.sessionVersion); respond(res,200,{user:profileView(db.prepare('SELECT * FROM users WHERE id=?').get(row.id))}); return;
      }
      const current = user(req);
      if(await platform.handle(req,res,pathname,current))return;
      user(req);
      if(pathname==='/api/admin'||pathname.startsWith('/api/admin/')){await adminConsole.handle(req,res,pathname,current);return;}
      if(req.method==='GET'&&pathname==='/api/sponsorship'){respond(res,200,{...adminConsole.clientView(current.id),connections:platform.sponsored.clientView(current.id)});return;}
      if (pathname === '/api/security' || pathname.startsWith('/api/security/')) {
        requireOrigin(req);
        if (req.method === 'GET' && pathname === '/api/security') {
          limit(req, `security-read:${current.id}`, 120, 60000);
          respond(res, 200, securityView(current.id, sessionHash(req))); return;
        }
        const factorActions = ['/api/security/2fa/setup', '/api/security/2fa/confirm', '/api/security/2fa/cancel', '/api/security/2fa/disable', '/api/security/2fa/recovery-codes'];
        const sessionActions = ['/api/security/sessions/revoke', '/api/security/sessions/revoke-others', '/api/security/sessions/revoke-all'];
        if (req.method !== 'POST' || ![...factorActions, ...sessionActions].includes(pathname)) throw new RequestError(404, 'Security endpoint not found.');
        limit(req, `security-write:${current.id}`, 30, 600000);
        const data = await body(req);
        const enrollmentAction = ['/api/security/2fa/setup', '/api/security/2fa/confirm'].includes(pathname);
        if (enrollmentAction) requireVerifiedEnrollment(req, current.id);
        const expected = await reauthenticate(req, current.id, data.password);
        if (enrollmentAction) requireVerifiedEnrollment(req, current.id);
        if (pathname === '/api/security/2fa/setup') {
          const enrollment = twoFactor.beginEnrollment(current.id, expected);
          const qrTask = Promise.resolve(qrEncoder(enrollment.otpauthUri, { errorCorrectionLevel: 'M', margin: 2, width: 320 }));
          securityPending.add(qrTask);
          let qrDataUrl;
          try { qrDataUrl = await qrTask; } finally { securityPending.delete(qrTask); }
          if (stopping) throw new RequestError(503, 'The server is restarting. Please try again shortly.');
          requireVerifiedEnrollment(req, current.id);
          twoFactor.assertSnapshot(current.id, expected);
          if (!twoFactor.enrollmentCurrent(current.id, enrollment.secret)) throw new RequestError(409, 'Two-factor setup changed. Start setup again.', 'SECURITY_STATE_CHANGED');
          respond(res, 200, { ...enrollment, qrDataUrl }); return;
        }
        if (pathname === '/api/security/2fa/cancel') {
          const result = twoFactor.cancelEnrollment(current.id, expected);
          respond(res, 200, { ...result, security: securityView(current.id, sessionHash(req)) }); return;
        }
        if (factorActions.includes(pathname)) {
          let token;
          const change = { onChange({ action }) {
            if (action === 'enabled') requireVerifiedEnrollment(req, current.id);
            token = rotateSecuritySession(req, current.id, action);
          } };
          let result;
          if (pathname === '/api/security/2fa/confirm') result = twoFactor.confirmEnrollment(current.id, expected, data.code, change);
          else if (pathname === '/api/security/2fa/disable') result = twoFactor.disable(current.id, expected, data.code, change);
          else result = twoFactor.regenerateRecoveryCodes(current.id, expected, data.code, change);
          cookie(res, token);
          closeRevokedStreams(current.id, 'Your account security changed. Please log in again.');
          const message = pathname === '/api/security/2fa/confirm' ? 'Two-factor authentication is enabled. Save your recovery codes now. Other sessions have been signed out.'
            : pathname === '/api/security/2fa/disable' ? 'Two-factor authentication is disabled. Other sessions have been signed out.'
              : 'New recovery codes are ready. Earlier recovery codes no longer work. Other sessions have been signed out.';
          respond(res, 200, { ...result, message, security: securityView(current.id, hash(token)) }); return;
        }
        let token, signedOut = false;
        const beforeHash = sessionHash(req);
        twoFactor.authorize(current.id, expected, data.code, {
          onAuthorized() {
            user(req);
            if (pathname === '/api/security/sessions/revoke') {
              const found = db.prepare('SELECT token FROM sessions WHERE user_id=? AND public_id=?').get(current.id, typeof data.sessionId === 'string' ? data.sessionId : '');
              if (!found) throw new RequestError(404, 'Session not found.');
              const removed = sessions.revoke(current.id, data.sessionId);
              if (!removed.revoked) throw new RequestError(404, 'Session not found.');
              signedOut = found.token === beforeHash;
              sessions.bumpVersion(current.id);
              twoFactor.invalidateAuthentication(current.id);
            } else if (pathname === '/api/security/sessions/revoke-all') {
              sessions.revokeAll(current.id);
              sessions.bumpVersion(current.id);
              twoFactor.invalidateAuthentication(current.id);
              signedOut = true;
            } else token = rotateSecuritySession(req, current.id, 'other-sessions-revoked');
            delivery.revokeDeviceNotifications(current.id);
            event(current.id, 'sessions-revoked', { action: pathname.split('/').at(-1), signedOut });
            delivery.queueSecurityNotice(current.id, 'sessions-revoked');
          },
        });
        if (signedOut) cookie(res, '', 0);
        else if (token) cookie(res, token);
        closeRevokedStreams(current.id);
        respond(res, 200, { message: signedOut ? 'You have been signed out. Sign in again to continue.' : 'Selected sessions have been signed out.', signedOut, security: signedOut ? null : securityView(current.id, token ? hash(token) : beforeHash) }); return;
      }
      if (pathname === '/api/leaderboard/preferences') {
        requireOrigin(req);
        if (req.method === 'GET') {
          limit(req, `leaderboard-preferences-read:${current.id}`, 60, 60000);
          respond(res, 200, leaderboard.preferences(current.id)); return;
        }
        if (req.method === 'POST') {
          limit(req, `leaderboard-preferences-write:${current.id}`, 30, 600000);
          const data = await body(req);
          user(req);
          respond(res, 200, leaderboard.setPreferences(current.id, data)); return;
        }
        throw new RequestError(405, 'Use GET or POST for leaderboard preferences.');
      }
      if (pathname === '/api/support' || pathname.startsWith('/api/support/')) {
        // Signup confirmation is required for trading. Pending users still need
        // authenticated support to resolve confirmation and onboarding problems.
        requireOrigin(req);
        const query = new URL(req.url, 'http://localhost').searchParams;
        let result;
        if (req.method === 'GET') {
          limit(req, `support-read:${current.id}`, 120, 60000);
          if (pathname === '/api/support') result = support.clientView(current, { ...(query.has('conversationId') ? { conversationId: query.get('conversationId') } : {}), before: query.get('before') });
          else if (pathname === '/api/support/conversations') result = support.clientList(current, { before: query.get('before') });
          else if (pathname === '/api/support/staff/conversations') result = support.staffList(current, { before: query.get('before'), status: query.get('status') || 'active' });
          else {
            const match = /^\/api\/support\/staff\/conversations\/([^/]+)$/.exec(pathname);
            if (match) result = support.staffView(current, match[1], query.get('before'));
          }
        } else if (req.method === 'POST') {
          limit(req, `support-write:${current.id}`, 100, 600000);
          const data = await body(req);
          user(req);
          if (pathname === '/api/support/messages') result = await support.message(current, data);
          else if (pathname === '/api/support/handoff') result = support.handoff(current, data);
          else {
            const match = /^\/api\/support\/staff\/conversations\/([^/]+)\/(claim|reply|close)$/.exec(pathname);
            if (match) result = support.staffAction(current, match[1], match[2], data);
          }
        }
        if (!result) throw new RequestError(404, 'Support endpoint not found.');
        // A long provider request must not send private chat history to a session
        // that was signed out while the answer was being generated.
        user(req);
        respond(res, 200, result); return;
      }
      const pendingRoutes = ['/api/me', '/api/profile', '/api/logout', '/api/notification-settings', '/api/email/resend-confirmation', '/api/email/request-verification', '/api/email/preferences', '/api/push/subscribe', '/api/push/unsubscribe'];
      if (!current.assessmentAccess && !pendingRoutes.includes(pathname)) throw new RequestError(403, 'Confirm your email address before starting or continuing the trading assessment. Open the confirmation link from your inbox or request a new one from your client dashboard.', 'EMAIL_CONFIRMATION_REQUIRED');
      if (req.method === 'POST' && pathname === '/api/email/resend-confirmation') {
        limit(req, `email-confirmation:${current.id}`, 10, 600000);
        await body(req);
        user(req);
        if (current.emailVerified) { respond(res, 200, { user: current, confirmation: { required: current.emailConfirmationRequired, available: delivery.status(current.id).emailAvailable, queued: false, status: 'already_confirmed' } }); return; }
        try {
          const queued = await delivery.requestVerification(current.id, { purpose: 'account' });
          respond(res, 200, { user: current, confirmation: { required: current.emailConfirmationRequired, available: true, ...queued, queued: true, status: 'queued' } });
        } catch (error) { throw new RequestError(400, error.message); }
        return;
      }
      if (req.method === 'GET' && pathname === '/api/account-stream') {
        const symbol = new URL(req.url, 'http://localhost').searchParams.get('symbol') || 'EURUSD';
        if (!isMarket(symbol)) throw new RequestError(400, 'Select a supported market.');
        openStream(req, res, current, symbol); return;
      }
      if(req.method==='GET' && pathname==='/api/market-reference'){
        limit(req,`market-reference:${current.id}`,60,60000);
        const query=new URL(req.url,'http://localhost').searchParams;
        try {const reference=await marketData.get(query.get('symbol'),query.get('interval')||'15m',query.has('end')?Number(query.get('end')):undefined);user(req);respond(res,200,reference);}
        catch(error){respond(res,error.status||503,{error:error.message,unavailable:true});}
        return;
      }
      if (req.method === 'GET' && pathname === '/api/me') { respond(res,200,{user:current}); return; }
      if (req.method === 'POST' && pathname === '/api/profile') {
        limit(req, `profile:${current.id}`, 30, 600000);
        const data = await body(req);
        const keys = Object.keys(data);
        if (!keys.length || keys.some(key => !['firstName', 'otherNames', 'market'].includes(key))) throw new RequestError(400, 'Update only your first name, other names, and preferred market. Your sign-in email cannot be changed here.');
        const updated = await serialized(current.id, () => {
          user(req);
          const previous = db.prepare('SELECT * FROM users WHERE id=?').get(current.id);
          const names = Object.hasOwn(data, 'firstName') || Object.hasOwn(data, 'otherNames')
            ? structuredName({ firstName: Object.hasOwn(data, 'firstName') ? data.firstName : previous.first_name, otherNames: Object.hasOwn(data, 'otherNames') ? data.otherNames : previous.other_names })
            : { name: previous.name, firstName: previous.first_name, otherNames: previous.other_names };
          const market = Object.hasOwn(data, 'market') ? data.market : previous.market;
          if (!preferredMarkets.includes(market)) throw new RequestError(400, 'Select a valid preferred market.');
          db.exec('BEGIN');
          try {
            db.prepare('UPDATE users SET name=?,first_name=?,other_names=?,market=? WHERE id=?').run(names.name, names.firstName, names.otherNames, market, current.id);
            event(current.id, 'profile-update', { firstName: names.firstName, otherNames: names.otherNames, market });
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          return profileView(db.prepare('SELECT * FROM users WHERE id=?').get(current.id));
        });
        respond(res, 200, { user: updated, message: 'Profile saved. Previously issued certificates and signed agreements retain their recorded names.' }); return;
      }
      if(req.method==='GET' && pathname==='/api/contract'){respond(res,200,contracts.status(current.id));return;}
      if(req.method==='POST' && pathname==='/api/contract/sign'){
        limit(req,'contract-sign',20,600000);const data=await body(req);
        user(req);
        respond(res,200,contracts.sign(current.id,data,now()));return;
      }
      const contractPath=/^\/api\/contracts\/([a-f0-9-]{36})\/document$/.exec(pathname);
      if(req.method==='GET' && contractPath){
        const document=contracts.document(current.id,contractPath[1]);
        res.writeHead(200,{'Content-Type':document.format==='pdf'?'application/pdf':'text/plain; charset=utf-8','Content-Length':document.content.length,'Content-Disposition':`inline; filename="${document.fileName}"`,'Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; frame-ancestors 'self'",'X-Contract-SHA256':document.hash});
        res.end(document.content);return;
      }
      if(req.method==='GET' && pathname==='/api/certificates'){respond(res,200,{certificates:certificates.list(current.id)});return;}
      if(req.method==='GET' && pathname==='/api/certificate-preferences'){respond(res,200,certificates.preferences(current.id));return;}
      if(req.method==='POST' && pathname==='/api/certificate-preferences'){
        limit(req,'certificate-preferences',30,600000);const data=await body(req);
        user(req);
        try{respond(res,200,certificates.setPreferences(current.id,data));}catch(error){throw new RequestError(400,error.message);}return;
      }
      const certificatePath=/^\/api\/certificates\/([a-f0-9-]{36})(\.svg)?$/.exec(pathname);
      if(req.method==='GET' && certificatePath){
        const certificate=certificates.get(current.id,certificatePath[1]);
        if(!certificate)throw new RequestError(404,'Certificate not found.');
        if(certificatePath[2]){res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"});res.end(certificateSvg(certificate));}
        else respond(res,200,{certificate});return;
      }
      if(req.method==='GET' && pathname==='/api/notification-settings') {respond(res,200,delivery.status(current.id));return;}
      if(req.method==='POST' && ['/api/push/subscribe','/api/push/unsubscribe','/api/email/request-verification','/api/email/preferences'].includes(pathname)) {
        limit(req,'notification-settings',20,600000);
        const data=await body(req);
        user(req);
        try {
          if(pathname==='/api/push/subscribe')delivery.subscribe(current.id,data.subscription);
          else if(pathname==='/api/push/unsubscribe')delivery.unsubscribe(current.id,data.endpoint);
          else if(pathname==='/api/email/request-verification')await delivery.requestVerification(current.id,{purpose:current.assessmentAccess?'notifications':'account'});
          else {if(typeof data.enabled!=='boolean')throw new Error('Select a valid email preference.');delivery.setEmail(current.id,data.enabled);}
        }catch(error){throw new RequestError(400,error.message);}
        respond(res,200,delivery.status(current.id));return;
      }
      if (req.method === 'POST' && pathname === '/api/logout') {
        const data=await body(req);
        user(req);
        if(typeof data.endpoint==='string')delivery.unsubscribe(current.id,data.endpoint);
        const token = sessionHash(req);
        db.prepare('DELETE FROM sessions WHERE token=?').run(token);
        for (const connection of [...(streams.get(current.id) ?? [])]) if (connection.token === token) endStream(connection, 'auth-expired', { error: 'You have signed out. Please log in again.' });
        cookie(res,'',0); respond(res,200,{ok:true}); return;
      }
      if (req.method === 'GET' && pathname === '/api/account') {
        limit(req, `account:${current.id}`, 120, 60000);
        const symbol = new URL(req.url, 'http://localhost').searchParams.get('symbol') || 'EURUSD';
        if (!isMarket(symbol)) throw new RequestError(400, 'Select a supported market.');
        const state = await serialized(current.id, () => syncReferenceState(current.id, [symbol]));
        user(req);
        respond(res, 200, { account: state }); return;
      }
      if (req.method === 'GET' && pathname === '/api/journal') {
        const state = await serialized(current.id, () => load(current.id));
        user(req);
        respond(res,200,{notice:state.migrationRequired ? 'Historical demo assessment recorded before reference-price execution; archived fills use the earlier price model.' : 'Server-recorded demo trading at reference market prices; fills are simulated and do not represent live broker execution.',exportedAt:new Date(now()).toISOString(),account:state}); return;
      }
      if (req.method==='POST' && ['/api/limits','/api/trades/protection','/api/orders','/api/orders/cancel','/api/alerts','/api/alerts/remove','/api/notifications/read'].includes(pathname)) {
        limit(req,'trades',120,60000);
        const data=await body(req);
        const state=await serialized(current.id, async () => {
          user(req);
          const before = load(current.id);
          if (pathname !== '/api/notifications/read') requireReferenceAccount(before);
          let requestedSymbols = [];
          if (pathname === '/api/orders' || pathname === '/api/alerts') {
            if (!isMarket(data.symbol)) throw new RequestError(400, 'Select a supported market.');
            requestedSymbols = [data.symbol];
          } else if (pathname === '/api/trades/protection') {
            const position = before.positions.find(p => p.id === data.id);
            if (!Number.isInteger(data.id) || !position) throw new RequestError(400, 'This position is no longer open.');
            requestedSymbols = [position.symbol];
          }
          // Cancelling and acknowledging notices remain possible during outages.
          const needsSync = ['/api/limits', '/api/trades/protection', '/api/orders', '/api/alerts'].includes(pathname);
          const account = needsSync ? await syncReferenceState(current.id, requestedSymbols) : load(current.id);
          user(req);
          try {
            if(pathname==='/api/limits') setLimits(account,data,now());
            else if(pathname==='/api/trades/protection') {
              requireFresh(account, requestedSymbols);
              updateStops(account,data.id,data.stopLoss??null,data.takeProfit??null,now());
            } else if(pathname==='/api/orders') {
              requireFresh(account, [data.symbol, ...account.positions.map(p => p.symbol)]);
              placeLimit(account,data,now());
            } else if(pathname==='/api/alerts') addAlert(account,data,now());
            else if(pathname==='/api/notifications/read') for(const n of account.notifications) n.read=true;
            else {
              const key=pathname==='/api/orders/cancel'?'pending':'alerts';
              if(!Number.isInteger(data.id) || !account[key].some(item=>item.id===data.id)) throw new Error('This item no longer exists.');
              account[key]=account[key].filter(item=>item.id!==data.id);
              if(key==='pending') notify(account,'Limit order cancelled',`Pending order #${data.id} cancelled.`,now());
            }
            commit(current.id,account,pathname.slice(5),data);
          } catch(error) { if (error instanceof RequestError) throw error; throw new RequestError(400,error.message); }
          return account;
        });
        respond(res,200,{account:state}); return;
      }
      if (req.method === 'POST' && ['/api/trades','/api/trades/close','/api/account/reset'].includes(pathname)) {
        limit(req,'trades',120,60000);
        const data = await body(req);
        const result = await serialized(current.id, async () => {
          user(req);
          let state = load(current.id);
          if (pathname === '/api/account/reset') {
            event(current.id,'reset-archive',state);
            state = createAccount(now()); commit(current.id,state,'reset',{});
            return {account:state,message:'Practice account reset for reference-price trading. Earlier attempts and certificates remain saved.'};
          }
          requireReferenceAccount(state);
          let symbol;
          if (pathname === '/api/trades') {
            if (!isMarket(data.symbol)) throw new RequestError(400, 'Select a supported market.');
            symbol = data.symbol;
          } else {
            const position = state.positions.find(p => p.id === data.id);
            if (!Number.isInteger(data.id) || !position) throw new RequestError(400, 'This position is no longer open.');
            symbol = position.symbol;
          }
          // Persist market fills and risk liquidation first, even when the
          // requested order is subsequently rejected or its quote is unavailable.
          state = await syncReferenceState(current.id, [symbol]);
          user(req);
          requireFresh(state, pathname === '/api/trades' ? [symbol, ...state.positions.map(p => p.symbol)] : [symbol]);
          try {
            if (pathname === '/api/trades') {
              const trade = openTrade(state,{symbol:data.symbol,side:data.side,...(Object.hasOwn(data,'quantity') ? { quantity:data.quantity } : {}),...(Object.hasOwn(data,'lots') ? { lots:data.lots } : {}),stopLoss:data.stopLoss ?? null,takeProfit:data.takeProfit ?? null},now());
              commit(current.id,state,'trade-open',trade);
            } else {
              closeTrade(state,data.id,'Manual close',now()); refreshRisk(state,now());
              commit(current.id,state,'trade-close',state.history[0]);
            }
          } catch (error) { if (error instanceof RequestError) throw error; throw new RequestError(400,error.message); }
          return {account:state};
        });
        respond(res,200,result); return;
      }
      throw new RequestError(404,'API endpoint not found.');
    } catch (error) {
      if (!error.status || error.status>=500) {
        const incident=platform.capture(error,{route:pathname,method:req.method,status:error.status||500});
        if(!error.status)console.error('API request failed',incident?.id||'unclassified');
      }
      if (res.headersSent) { res.destroy(); return; }
      respond(res,error.status || 500,{error:error.status ? error.message : 'Server error. Please try again.',...((error.status && error.code) ? {code:error.code} : {})});
    }
  }
  if(autoTick)platform.start();
  return { handle, capture:(error,metadata)=>platform.capture(error,metadata), health(){db.prepare('SELECT 1').get();return{status:stopping?'stopping':'ok'};}, close() {
    if (closePromise) return closePromise;
    stopping = true;
    if (timer) clearInterval(timer);
    clearInterval(streamTimer);
    clearInterval(heartbeatTimer);
    for (const connections of [...streams.values()]) for (const connection of [...connections]) endStream(connection);
    marketData.close?.();
    delivery.close();
    closePromise = Promise.allSettled([...queues.values(),...securityPending,support.close(),passwordRecovery.close(),passwords.close(),platform.close()]).then(() => db.close());
    return closePromise;
  } };
}
