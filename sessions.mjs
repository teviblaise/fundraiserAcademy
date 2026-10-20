import { randomUUID } from 'node:crypto';

export const SESSION_LIFETIME_MS = 7 * 86400000;
export const SESSION_IDLE_TIMEOUT_MS = 24 * 3600000;
export const SESSION_TOUCH_INTERVAL_MS = 60000;
export const SESSION_LIST_LIMIT = 200;
export const sessionPolicy = Object.freeze({ absoluteLifetimeMs: SESSION_LIFETIME_MS, idleTimeoutMs: SESSION_IDLE_TIMEOUT_MS, sessionListLimit: SESSION_LIST_LIMIT });

const tokenPattern = /^[a-f0-9]{64}$/;
const idPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const stale = () => Object.assign(new Error('Your security settings changed. Please sign in again.'), { status: 401, code: 'SECURITY_STATE_CHANGED' });
const validUserId = value => Number.isSafeInteger(value) && value > 0;

function safeAgent(value) {
  if (typeof value !== 'string') return '';
  // This is an untrusted descriptive hint, never evidence of a device's
  // identity. Do not persist control characters or an unbounded header.
  return value.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '').replace(/\s+/gu, ' ').trim().slice(0, 512);
}

function describeAgent(agent) {
  const browser = /(?:Edg|EdgA|EdgiOS)\//u.test(agent) ? 'Microsoft Edge'
    : /(?:OPR|Opera)\//u.test(agent) ? 'Opera'
      : /SamsungBrowser\//u.test(agent) ? 'Samsung Internet'
        : /(?:Firefox|FxiOS)\//u.test(agent) ? 'Firefox'
          : /(?:Chrome|CriOS|Chromium)\//u.test(agent) ? 'Chrome'
            : /Version\/[\d.]+.*Safari\//u.test(agent) ? 'Safari' : 'Unknown browser';
  const device = /iPad/u.test(agent) ? 'iPad'
    : /iPhone|iPod/u.test(agent) ? 'iPhone'
      : /Android/u.test(agent) ? 'Android'
        : /CrOS/u.test(agent) ? 'ChromeOS'
          : /Windows/u.test(agent) ? 'Windows'
            : /Macintosh|Mac OS X/u.test(agent) ? 'macOS'
              : /Linux/u.test(agent) ? 'Linux' : 'Unknown device';
  return { browser, device };
}

function publicSession(row, currentHash) {
  return {
    id: row.public_id,
    current: row.token === currentHash,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen,
    expiresAt: row.expires,
    ...describeAgent(row.user_agent),
  };
}

export function createSessions(db, { now = Date.now } = {}) {
  if (typeof now !== 'function') throw new TypeError('A session clock is required.');
  const clock = () => {
    const time = now();
    if (!Number.isSafeInteger(time) || time < 0) throw new TypeError('The session clock must return a valid timestamp.');
    return time;
  };
  // Existing sessions retain their original absolute expiry. Their creation
  // time was not recorded, so it remains null instead of inventing a date.
  // Seeding activity at migration gives valid legacy sessions an idle window.
  db.exec('BEGIN IMMEDIATE');
  try {
    const users = db.prepare('PRAGMA table_info(users)').all();
    if (!users.some(column => column.name === 'session_version')) db.exec('ALTER TABLE users ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
    db.exec('CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL)');
    const columns = db.prepare('PRAGMA table_info(sessions)').all();
    if (!columns.some(column => column.name === 'public_id')) db.exec('ALTER TABLE sessions ADD COLUMN public_id TEXT');
    if (!columns.some(column => column.name === 'created_at')) db.exec('ALTER TABLE sessions ADD COLUMN created_at INTEGER');
    if (!columns.some(column => column.name === 'last_seen')) db.exec('ALTER TABLE sessions ADD COLUMN last_seen INTEGER');
    if (!columns.some(column => column.name === 'user_agent')) db.exec("ALTER TABLE sessions ADD COLUMN user_agent TEXT NOT NULL DEFAULT ''");
    const assignId = db.prepare('UPDATE sessions SET public_id=? WHERE token=?');
    for (const row of db.prepare("SELECT token FROM sessions WHERE public_id IS NULL OR public_id=''").all()) assignId.run(randomUUID(), row.token);
    db.prepare('UPDATE sessions SET last_seen=? WHERE last_seen IS NULL').run(clock());
    db.exec('CREATE UNIQUE INDEX IF NOT EXISTS sessions_public_id ON sessions(public_id); CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id)');
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }

  function prune(time = clock()) {
    return db.prepare('DELETE FROM sessions WHERE expires<=? OR last_seen<=?').run(time, time - SESSION_IDLE_TIMEOUT_MS).changes;
  }
  prune();

  function version(userId) {
    if (!validUserId(userId)) return null;
    return db.prepare('SELECT session_version FROM users WHERE id=?').get(userId)?.session_version ?? null;
  }

  // Runtime mutations deliberately do not begin/commit a transaction. A
  // password/factor change can atomically bump this generation, revoke
  // sessions and consume its challenge in the caller's existing transaction.
  // The generation binds pending login work; retained sessions stay valid.
  function bumpVersion(userId) {
    if (!validUserId(userId)) return null;
    const updated = db.prepare(`UPDATE users SET session_version=session_version+1
      WHERE id=? AND typeof(session_version)='integer' AND session_version>=0 AND session_version<?
      RETURNING session_version`).get(userId, Number.MAX_SAFE_INTEGER);
    if (updated) return updated.session_version;
    if (version(userId) === null) return null;
    throw new Error('The security generation is invalid.');
  }

  function create(userId, tokenHash, { userAgent, expectedVersion } = {}) {
    if (!validUserId(userId) || typeof tokenHash !== 'string' || !tokenPattern.test(tokenHash)) throw new TypeError('A user and hashed session token are required.');
    const generation = version(userId);
    if (generation === null || expectedVersion !== undefined && expectedVersion !== generation) throw stale();
    if (!Number.isSafeInteger(generation) || generation < 0) throw stale();
    const time = clock();
    const row = { token: tokenHash, public_id: randomUUID(), created_at: time, last_seen: time, expires: time + SESSION_LIFETIME_MS, user_agent: safeAgent(userAgent) };
    // A second process sharing this database can change account security
    // between the generation read and insertion. The predicate belongs to
    // the INSERT itself so stale authentication can never create a session
    // after that process has revoked the earlier generation.
    const inserted = db.prepare(`INSERT INTO sessions(token,user_id,expires,public_id,created_at,last_seen,user_agent)
      SELECT ?,id,?,?,?,?,? FROM users WHERE id=? AND session_version=?`)
      .run(tokenHash, row.expires, row.public_id, time, time, row.user_agent, userId, generation);
    if (inserted.changes !== 1) throw stale();
    return publicSession(row, tokenHash);
  }

  function lookup(tokenHash, { touch = true } = {}) {
    if (typeof tokenHash !== 'string' || !tokenPattern.test(tokenHash)) return null;
    const row = db.prepare(`SELECT users.*,sessions.public_id AS session_id,sessions.user_id AS session_user_id,
      sessions.expires AS session_expires,sessions.created_at AS session_created_at,
      sessions.last_seen AS session_last_seen FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=?`).get(tokenHash);
    if (!row) return null;
    const time = clock();
    if (row.session_expires <= time || row.session_last_seen <= time - SESSION_IDLE_TIMEOUT_MS) {
      db.prepare('DELETE FROM sessions WHERE token=?').run(tokenHash);
      return null;
    }
    let lastSeenAt = row.session_last_seen;
    if (touch && time - lastSeenAt >= SESSION_TOUCH_INTERVAL_MS) {
      db.prepare('UPDATE sessions SET last_seen=? WHERE token=?').run(time, tokenHash);
      lastSeenAt = time;
    }
    const { session_id, session_user_id, session_expires, session_created_at, session_last_seen, ...user } = row;
    return { user, session: { id: session_id, userId: session_user_id, tokenHash, createdAt: session_created_at, lastSeenAt, expiresAt: session_expires, version: user.session_version } };
  }

  function list(userId, currentHash) {
    if (!validUserId(userId)) return [];
    prune();
    return db.prepare(`SELECT token,public_id,created_at,last_seen,expires,user_agent FROM sessions WHERE user_id=?
      ORDER BY CASE WHEN token=? THEN 0 ELSE 1 END,last_seen DESC,public_id LIMIT ?`)
      .all(userId, typeof currentHash === 'string' ? currentHash : '', SESSION_LIST_LIMIT)
      .map(row => publicSession(row, currentHash));
  }

  function count(userId) {
    if (!validUserId(userId)) return 0;
    const time = clock();
    return db.prepare('SELECT count(*) AS total FROM sessions WHERE user_id=? AND expires>? AND last_seen>?')
      .get(userId, time, time - SESSION_IDLE_TIMEOUT_MS).total;
  }

  function remove(userId, where, value) {
    if (!validUserId(userId)) return { revoked: false, count: 0, hashes: [] };
    const rows = db.prepare(`SELECT token FROM sessions WHERE user_id=?${where}`).all(...(value === undefined ? [userId] : [userId, value]));
    if (rows.length) db.prepare(`DELETE FROM sessions WHERE user_id=?${where}`).run(...(value === undefined ? [userId] : [userId, value]));
    return { revoked: rows.length > 0, count: rows.length, hashes: rows.map(row => row.token) };
  }
  function revoke(userId, publicId) {
    if (typeof publicId !== 'string' || !idPattern.test(publicId)) return { revoked: false, count: 0, hashes: [] };
    return remove(userId, ' AND public_id=?', publicId);
  }
  function revokeOthers(userId, currentHash) {
    // A missing/invalid current token must never turn "other devices" into
    // an implicit sign-out of the entire account.
    if (!validUserId(userId) || typeof currentHash !== 'string' || !tokenPattern.test(currentHash)) return { revoked: false, count: 0, hashes: [] };
    const current = lookup(currentHash, { touch: false });
    if (current?.user.id !== userId) return { revoked: false, count: 0, hashes: [] };
    return remove(userId, ' AND token<>?', currentHash);
  }
  function revokeAll(userId) { return remove(userId, ''); }

  return { version, bumpVersion, create, lookup, list, count, revoke, revokeOthers, revokeAll, prune };
}
