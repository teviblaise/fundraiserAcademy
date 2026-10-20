import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createSessions, sessionPolicy, SESSION_LIFETIME_MS, SESSION_IDLE_TIMEOUT_MS, SESSION_TOUCH_INTERVAL_MS, SESSION_LIST_LIMIT } from '../sessions.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const token = number => digest(`private-session-${number}`);
const chrome = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/123.0.0.0 Safari/537.36';
const safari = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1';
const publicKeys = ['id', 'current', 'createdAt', 'lastSeenAt', 'expiresAt', 'browser', 'device'];

function fixture({ legacy = [] } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,password TEXT);
    INSERT INTO users VALUES (1,'owner@example.com','private owner password hash'),(2,'other@example.com','private other password hash');
    CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);`);
  let time = 1792368000000;
  for (const row of legacy) db.prepare('INSERT INTO sessions(token,user_id,expires) VALUES (?,?,?)').run(row.token, row.userId, time + row.expiresIn);
  const sessions = createSessions(db, { now: () => time });
  return { db, sessions, now: () => time, advance: milliseconds => { time += milliseconds; }, close: () => db.close() };
}

test('legacy sessions migrate without changing credentials, expiry, or inventing a creation date', () => {
  const app = fixture({ legacy: [{ token: token(1), userId: 1, expiresIn: 3600000 }, { token: token(2), userId: 1, expiresIn: -1 }, { token: token(3), userId: 2, expiresIn: 7200000 }] });
  try {
    const rows = app.db.prepare('SELECT * FROM sessions ORDER BY user_id').all();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].token, token(1));
    assert.equal(rows[0].expires, app.now() + 3600000);
    assert.equal(rows[0].created_at, null);
    assert.equal(rows[0].last_seen, app.now());
    assert.equal(rows[0].user_agent, '');
    assert.match(rows[0].public_id, /^[a-f0-9-]{36}$/);
    assert.equal(app.sessions.version(1), 0);
    assert.equal(app.sessions.lookup(token(1)).user.email, 'owner@example.com');
    const publicView = app.sessions.list(1, token(1));
    assert.equal(publicView.length, 1);
    assert.equal(publicView[0].createdAt, null);
    assert.equal(publicView[0].current, true);
    const publicId = publicView[0].id;
    app.advance(500);
    const restarted = createSessions(app.db, { now: app.now });
    assert.equal(restarted.list(1, token(1))[0].id, publicId);
    assert.equal(restarted.list(1, token(1))[0].lastSeenAt, app.now() - 500);
    assert.equal(restarted.list(1, token(1))[0].createdAt, null);
  } finally { app.close(); }
});

test('new sessions have independent public IDs, bounded sanitized metadata, and a private internal lookup', () => {
  const app = fixture();
  try {
    const first = app.sessions.create(1, token(1), { userAgent: chrome, expectedVersion: 0 });
    const second = app.sessions.create(1, token(2), { userAgent: safari });
    assert.deepEqual(Object.keys(first), publicKeys);
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.id, token(1));
    assert.equal(first.current, true);
    assert.equal(first.browser, 'Chrome');
    assert.equal(first.device, 'Windows');
    assert.equal(second.browser, 'Safari');
    assert.equal(second.device, 'iPhone');
    assert.equal(first.createdAt, app.now());
    assert.equal(first.lastSeenAt, app.now());
    assert.equal(first.expiresAt, app.now() + SESSION_LIFETIME_MS);
    const internal = app.sessions.lookup(token(1));
    assert.equal(internal.user.password, 'private owner password hash');
    assert.equal(internal.session.tokenHash, token(1));
    assert.equal(internal.session.userId, 1);
    assert.equal(internal.session.id, first.id);
    assert.equal(internal.session.version, 0);
    app.sessions.create(1, token(3), { userAgent: `\u0000\r\n\u202e${chrome}\u2028${'x'.repeat(1000)}` });
    const stored = app.db.prepare('SELECT user_agent FROM sessions WHERE token=?').get(token(3)).user_agent;
    assert.equal(stored.length, 512);
    assert.doesNotMatch(stored, /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    const listed = app.sessions.list(1, token(1));
    const json = JSON.stringify(listed);
    for (const item of listed) assert.deepEqual(Object.keys(item), publicKeys);
    for (const secret of [token(1), token(2), token(3), chrome, safari, 'owner@example.com', 'private owner password hash', 'user_agent', 'userAgent', 'tokenHash', 'ipAddress']) assert.ok(!json.includes(secret), secret);
  } finally { app.close(); }
});

test('browser and device labels are descriptive hints and unknown agents do not invent a device or location', () => {
  const app = fixture();
  try {
    const cases = [
      ['Mozilla/5.0 (Windows) Chrome/120 Safari/537.36 Edg/120', 'Microsoft Edge', 'Windows'],
      ['Mozilla/5.0 (Android) Chrome/120 Safari/537.36 SamsungBrowser/22', 'Samsung Internet', 'Android'],
      ['Mozilla/5.0 (X11; Linux) Chrome/120 OPR/100', 'Opera', 'Linux'],
      ['Mozilla/5.0 (iPad) FxiOS/123', 'Firefox', 'iPad'],
      ['Mozilla/5.0 (CrOS x86_64) Chrome/123', 'Chrome', 'ChromeOS'],
      ['Mozilla/5.0 (Macintosh) Version/17.0 Safari/605', 'Safari', 'macOS'],
      ['secret-client 192.0.2.1 Lagos', 'Unknown browser', 'Unknown device'],
      [null, 'Unknown browser', 'Unknown device'],
    ];
    cases.forEach(([userAgent, browser, device], index) => {
      const item = app.sessions.create(1, token(index), { userAgent });
      assert.equal(item.browser, browser);
      assert.equal(item.device, device);
      assert.ok(!JSON.stringify(item).includes('192.0.2.1'));
      assert.ok(!JSON.stringify(item).includes('Lagos'));
    });
  } finally { app.close(); }
});

test('activity is throttled, passive checks do not extend idle time, and idle sessions expire exactly at the deadline', () => {
  const app = fixture();
  try {
    app.sessions.create(1, token(1));
    const start = app.now();
    app.advance(SESSION_TOUCH_INTERVAL_MS - 1);
    assert.equal(app.sessions.lookup(token(1)).session.lastSeenAt, start);
    app.advance(1);
    assert.equal(app.sessions.lookup(token(1)).session.lastSeenAt, app.now());
    const touched = app.now();
    app.advance(SESSION_TOUCH_INTERVAL_MS);
    assert.equal(app.sessions.lookup(token(1), { touch: false }).session.lastSeenAt, touched);
    assert.equal(app.sessions.list(1, token(1))[0].lastSeenAt, touched, 'listing is not activity for every other device');
    app.advance(SESSION_IDLE_TIMEOUT_MS - SESSION_TOUCH_INTERVAL_MS - 1);
    assert.ok(app.sessions.lookup(token(1), { touch: false }));
    app.advance(1);
    assert.equal(app.sessions.lookup(token(1), { touch: false }), null);
    assert.equal(app.db.prepare('SELECT count(*) AS total FROM sessions').get().total, 0);
  } finally { app.close(); }
});

test('absolute lifetime is seven days and activity never extends it', () => {
  const app = fixture();
  try {
    const created = app.sessions.create(1, token(1));
    const start = app.now();
    for (let day = 0; day < 7; day++) {
      app.advance(23 * 3600000);
      assert.ok(app.sessions.lookup(token(1)));
      assert.equal(app.sessions.lookup(token(1)).session.expiresAt, created.expiresAt);
    }
    app.advance(start + SESSION_LIFETIME_MS - app.now() - 1);
    assert.ok(app.sessions.lookup(token(1)));
    app.advance(1);
    assert.equal(app.sessions.lookup(token(1)), null);
  } finally { app.close(); }
});

test('session lists are owner bound, current first, limited, and report a separate active total', () => {
  const app = fixture();
  try {
    for (let index = 0; index < SESSION_LIST_LIMIT + 5; index++) {
      app.sessions.create(1, token(index));
      app.advance(1);
    }
    const other = app.sessions.create(2, token('other'));
    const oldestId = app.sessions.lookup(token(0)).session.id;
    const listed = app.sessions.list(1, token(0));
    assert.equal(listed.length, SESSION_LIST_LIMIT);
    assert.equal(app.sessions.count(1), SESSION_LIST_LIMIT + 5);
    assert.equal(listed[0].id, oldestId);
    assert.equal(listed[0].current, true);
    assert.equal(listed.filter(item => item.current).length, 1);
    assert.ok(!listed.some(item => item.id === other.id));
    assert.equal(app.sessions.list(2, token(0))[0].current, false);
    assert.deepEqual(app.sessions.list(null, token(0)), []);
    app.advance(SESSION_IDLE_TIMEOUT_MS);
    assert.equal(app.sessions.count(1), 0);
    assert.deepEqual(app.sessions.list(1, token(0)), []);
  } finally { app.close(); }
});

test('single revocation requires the owner and public ID, allows the current session, and is idempotent', () => {
  const app = fixture();
  try {
    const owner = app.sessions.create(1, token(1));
    const other = app.sessions.create(2, token(2));
    const empty = { revoked: false, count: 0, hashes: [] };
    assert.deepEqual(app.sessions.revoke(1, other.id), empty);
    assert.deepEqual(app.sessions.revoke(1, token(1)), empty, 'authentication hashes are not accepted as public IDs');
    assert.deepEqual(app.sessions.revoke(1, `${owner.id}' OR 1=1--`), empty);
    assert.deepEqual(app.sessions.revoke(1, randomUUID()), empty);
    assert.deepEqual(app.sessions.revoke(1, owner.id), { revoked: true, count: 1, hashes: [token(1)] });
    assert.equal(app.sessions.lookup(token(1)), null);
    assert.ok(app.sessions.lookup(token(2)));
    assert.deepEqual(app.sessions.revoke(1, owner.id), empty);
    assert.equal(app.sessions.version(1), 0, 'revocation does not implicitly bump the login generation');
  } finally { app.close(); }
});

test('revoke others retains the current device and rejects a missing, foreign, or expired current session', () => {
  const app = fixture();
  try {
    app.sessions.create(1, token(1));
    app.sessions.create(1, token(2));
    app.sessions.create(2, token(3));
    const empty = { revoked: false, count: 0, hashes: [] };
    assert.deepEqual(app.sessions.revokeOthers(1, undefined), empty);
    assert.deepEqual(app.sessions.revokeOthers(1, token(3)), empty);
    assert.deepEqual(app.sessions.revokeOthers(1, token('missing')), empty);
    assert.deepEqual(app.sessions.revokeOthers(1, token(1)), { revoked: true, count: 1, hashes: [token(2)] });
    assert.ok(app.sessions.lookup(token(1)));
    assert.equal(app.sessions.lookup(token(2)), null);
    assert.ok(app.sessions.lookup(token(3)));
    app.advance(SESSION_IDLE_TIMEOUT_MS);
    app.sessions.create(1, token(4));
    assert.deepEqual(app.sessions.revokeOthers(1, token(1)), empty);
    assert.ok(app.sessions.lookup(token(4)), 'an expired current token cannot revoke a newly created session');
  } finally { app.close(); }
});

test('revoke all is scoped to one user and generation changes guard new sessions without invalidating retained ones', () => {
  const app = fixture();
  try {
    app.sessions.create(1, token(1), { expectedVersion: 0 });
    app.sessions.create(1, token(2));
    app.sessions.create(2, token(3));
    const capturedVersion = app.sessions.version(1);
    assert.equal(app.sessions.bumpVersion(1), 1);
    assert.ok(app.sessions.lookup(token(1)), 'only explicit revocation removes retained sessions');
    assert.equal(app.sessions.lookup(token(1)).session.version, 1);
    assert.throws(() => app.sessions.create(1, token(4), { expectedVersion: capturedVersion }), { status: 401, code: 'SECURITY_STATE_CHANGED' });
    assert.equal(app.sessions.lookup(token(4)), null);
    assert.deepEqual(app.sessions.revokeAll(1), { revoked: true, count: 2, hashes: [token(1), token(2)] });
    assert.equal(app.sessions.count(1), 0);
    assert.equal(app.sessions.count(2), 1);
    assert.equal(app.sessions.version(1), 1);
    assert.equal(app.sessions.version(2), 0);
    assert.equal(app.sessions.version(999), null);
    assert.equal(app.sessions.bumpVersion(999), null);
    assert.throws(() => app.sessions.create(999, token(5)), { status: 401, code: 'SECURITY_STATE_CHANGED' });
    assert.ok(app.sessions.create(1, token(6), { expectedVersion: 1 }));
  } finally { app.close(); }
});

test('security generation and revocations participate in an outer atomic transaction', () => {
  const app = fixture();
  try {
    app.sessions.create(1, token(1));
    app.db.exec('BEGIN IMMEDIATE');
    app.sessions.bumpVersion(1);
    app.sessions.revokeAll(1);
    app.sessions.create(1, token(2), { expectedVersion: 1 });
    app.db.exec('ROLLBACK');
    assert.equal(app.sessions.version(1), 0);
    assert.ok(app.sessions.lookup(token(1)));
    assert.equal(app.sessions.lookup(token(2)), null);
    app.db.exec('BEGIN IMMEDIATE');
    app.sessions.bumpVersion(1);
    app.sessions.revokeAll(1);
    app.sessions.create(1, token(3), { expectedVersion: 1 });
    app.db.exec('COMMIT');
    assert.equal(app.sessions.version(1), 1);
    assert.equal(app.sessions.lookup(token(1)), null);
    assert.ok(app.sessions.lookup(token(3)));
  } finally { app.close(); }
});

test('another SQLite connection cannot insert a stale session after revocation or overwrite a generation increment', () => {
  const directory = mkdtempSync(path.join(tmpdir(), 'fa-sessions-race-'));
  const filename = path.join(directory, 'academy.sqlite');
  const db = new DatabaseSync(filename);
  let other;
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,password TEXT); INSERT INTO users VALUES (1,'owner@example.com','private password hash')");
    let intercept;
    // Interpose immediately before the actual SQL write. The competing writer
    // uses a separate real SQLite connection, rather than substituting a fake
    // row or mutating this manager's JavaScript state.
    const interceptedDb = {
      exec: sql => db.exec(sql),
      prepare(sql) {
        const statement = db.prepare(sql);
        return new Proxy(statement, {
          get(target, property) {
            const value = target[property];
            if (typeof value !== 'function') return value;
            return (...parameters) => {
              if (intercept && /^(?:INSERT INTO sessions|UPDATE users SET session_version)/u.test(sql)) {
                const work = intercept;
                intercept = undefined;
                work();
              }
              return value.apply(target, parameters);
            };
          },
        });
      },
    };
    const sessions = createSessions(interceptedDb, { now: () => 1792368000000 });
    other = new DatabaseSync(filename);
    sessions.create(1, token(1));
    const capturedVersion = sessions.version(1);
    intercept = () => {
      other.exec('BEGIN IMMEDIATE; UPDATE users SET session_version=session_version+1 WHERE id=1; DELETE FROM sessions WHERE user_id=1; COMMIT');
    };
    assert.throws(() => sessions.create(1, token(2), { expectedVersion: capturedVersion }), { status: 401, code: 'SECURITY_STATE_CHANGED' });
    assert.equal(sessions.version(1), 1);
    assert.equal(sessions.count(1), 0, 'the stale write must not resurrect a session after revocation');
    assert.ok(sessions.create(1, token(3), { expectedVersion: 1 }));
    intercept = () => other.prepare('UPDATE users SET session_version=session_version+1 WHERE id=1').run();
    assert.equal(sessions.bumpVersion(1), 3, 'both competing generation increments must survive');
    assert.equal(sessions.version(1), 3);
  } finally { other?.close(); db.close(); rmSync(directory, { recursive: true, force: true }); }
});

test('invalid identities and non-hashed tokens never create, locate, or revoke a session', () => {
  const app = fixture();
  try {
    app.sessions.create(1, token(1));
    for (const value of [undefined, null, {}, [], 0, -1, '1', '1 OR 1=1', 1.2]) {
      assert.equal(app.sessions.version(value), null);
      assert.equal(app.sessions.bumpVersion(value), null);
      assert.equal(app.sessions.count(value), 0);
      assert.deepEqual(app.sessions.revokeAll(value), { revoked: false, count: 0, hashes: [] });
    }
    for (const value of [undefined, null, {}, [], 123, 'raw-token', token(1).toUpperCase(), `${token(1)}' OR 1=1`]) {
      assert.equal(app.sessions.lookup(value), null);
      assert.throws(() => app.sessions.create(1, value), TypeError);
    }
    assert.equal(app.sessions.count(1), 1);
    assert.deepEqual(sessionPolicy, { absoluteLifetimeMs: 7 * 86400000, idleTimeoutMs: 24 * 3600000, sessionListLimit: 200 });
    assert.ok(Object.isFrozen(sessionPolicy));
  } finally { app.close(); }
});
