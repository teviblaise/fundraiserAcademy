import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const issuer = 'Fundraiser Academy';
const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const enrollmentLifetime = 10 * 60000;
const challengeLifetime = 5 * 60000;
const failureWindow = 15 * 60000;
const maxFailures = 10;
const maxChallengeAttempts = 5;
const digest = value => createHash('sha256').update(value).digest('hex');
const error = (status, code, message) => Object.assign(new Error(message), { status, code });
const invalidFactor = () => error(400, 'TWO_FACTOR_INVALID', 'That authentication code is invalid or has already been used. Try the current code or an unused recovery code.');
const invalidChallenge = () => error(400, 'TWO_FACTOR_CHALLENGE_INVALID', 'This sign-in request has expired or is no longer valid. Sign in again.');
const changed = () => error(409, 'SECURITY_STATE_CHANGED', 'Your security settings changed. Refresh this page and try again.');
const unavailable = () => error(503, 'TWO_FACTOR_UNAVAILABLE', 'Two-factor authentication is temporarily unavailable. Please contact support.');

function encodeBase32(bytes) {
  let bits = 0, value = 0, output = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { output += alphabet[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits) output += alphabet[(value << (5 - bits)) & 31];
  return output;
}
function decodeBase32(secret) {
  if (typeof secret !== 'string' || !/^[A-Z2-7]+={0,6}$/.test(secret)) throw new TypeError('Invalid authenticator secret.');
  let bits = 0, value = 0;
  const output = [];
  for (const character of secret.replace(/=+$/, '')) {
    value = (value << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) { output.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(output);
}

// Exported for deterministic RFC 6238 interoperability tests. Live accounts use
// the standard six digits, SHA-1, and a 30-second period.
export function generateTotpCode(secret, { time = Date.now(), counter = Math.floor(time / 30000), digits = 6, algorithm = 'sha1' } = {}) {
  if (!Number.isSafeInteger(counter) || counter < 0 || ![6, 8].includes(digits) || !['sha1', 'sha256', 'sha512'].includes(algorithm)) throw new TypeError('Invalid TOTP parameters.');
  const movingFactor = Buffer.alloc(8);
  movingFactor.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac(algorithm, decodeBase32(secret)).update(movingFactor).digest();
  const offset = mac.at(-1) & 15;
  return String((mac.readUInt32BE(offset) & 0x7fffffff) % (10 ** digits)).padStart(digits, '0');
}

function readKey(filename) {
  const metadata = lstatSync(filename);
  if (!metadata.isFile() || metadata.isSymbolicLink() || (process.platform !== 'win32' && (metadata.mode & 0o077))) throw new Error('The two-factor key file must be a private regular file with mode 600 on POSIX systems.');
  const stored = JSON.parse(readFileSync(filename, 'utf8'));
  if (stored.version !== 1 || typeof stored.key !== 'string') throw new Error('Invalid two-factor encryption key file.');
  return parseKey(stored.key);
}
function parseKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]{43}=$/.test(value)) throw new Error('TWO_FACTOR_ENCRYPTION_KEY must contain a base64-encoded 32-byte key.');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32 || key.toString('base64') !== value) throw new Error('TWO_FACTOR_ENCRYPTION_KEY must contain a base64-encoded 32-byte key.');
  return key;
}
function installKey(filename) {
  mkdirSync(path.dirname(filename), { recursive: true });
  const key = randomBytes(32);
  const temporary = `${filename}.${randomBytes(12).toString('hex')}.tmp`;
  let descriptor;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    writeFileSync(descriptor, `${JSON.stringify({ version: 1, key: key.toString('base64') })}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor); descriptor = undefined;
    // An exclusive hard link installs the complete file atomically and never
    // replaces a key created by another process starting at the same time.
    try { linkSync(temporary, filename); } catch (failure) { if (failure.code !== 'EEXIST') throw failure; }
    return readKey(filename);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try { unlinkSync(temporary); } catch (failure) { if (failure.code !== 'ENOENT') throw failure; }
  }
}

export function createTwoFactor(db, databasePath, { now = Date.now, encryptionKey = process.env.TWO_FACTOR_ENCRYPTION_KEY } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS two_factor (
    user_id INTEGER PRIMARY KEY REFERENCES users(id), secret TEXT, pending_secret TEXT,
    pending_expires INTEGER, version INTEGER NOT NULL DEFAULT 0,
    last_counter INTEGER NOT NULL DEFAULT -1, enabled_at INTEGER,
    failures INTEGER NOT NULL DEFAULT 0, failure_started INTEGER NOT NULL DEFAULT 0,
    blocked_until INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS two_factor_recovery_codes (
    user_id INTEGER NOT NULL REFERENCES users(id), code_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY(user_id,code_hash));
    CREATE TABLE IF NOT EXISTS two_factor_challenges (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    password_fingerprint TEXT NOT NULL, version INTEGER NOT NULL,
    session_version INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0);
    CREATE INDEX IF NOT EXISTS two_factor_challenges_user ON two_factor_challenges(user_id);`);
  if (!db.prepare('PRAGMA table_info(two_factor_challenges)').all().some(column => column.name === 'session_version')) {
    db.exec('ALTER TABLE two_factor_challenges ADD COLUMN session_version INTEGER NOT NULL DEFAULT 0');
  }
  const keyPath = path.join(path.dirname(databasePath), 'two-factor-key.json');
  let encryption;
  if (encryptionKey !== undefined && encryptionKey !== '') encryption = parseKey(encryptionKey);
  else if (existsSync(keyPath)) {
    try { encryption = readKey(keyPath); } catch { /* Existing protected accounts fail closed below. */ }
  } else if (!db.prepare('SELECT 1 FROM two_factor WHERE secret IS NOT NULL OR pending_secret IS NOT NULL LIMIT 1').get()) {
    encryption = installKey(keyPath);
  }

  function encrypt(userId, secret) {
    if (!encryption) throw unavailable();
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', encryption, iv);
    cipher.setAAD(Buffer.from(`FundraiserAcademy:TOTP:${userId}:v1`));
    const encrypted = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
    return `v1:${iv.toString('base64')}:${cipher.getAuthTag().toString('base64')}:${encrypted.toString('base64')}`;
  }
  function decrypt(userId, envelope) {
    if (!encryption) throw unavailable();
    try {
      const [version, iv, tag, ciphertext, extra] = envelope.split(':');
      if (version !== 'v1' || extra !== undefined) throw new Error('Invalid encryption envelope.');
      const decipher = createDecipheriv('aes-256-gcm', encryption, Buffer.from(iv, 'base64'));
      decipher.setAAD(Buffer.from(`FundraiserAcademy:TOTP:${userId}:v1`));
      decipher.setAuthTag(Buffer.from(tag, 'base64'));
      const secret = Buffer.concat([decipher.update(Buffer.from(ciphertext, 'base64')), decipher.final()]).toString('utf8');
      if (!/^[A-Z2-7]{32,}$/.test(secret)) throw new Error('Invalid authenticator secret.');
      return secret;
    } catch { throw unavailable(); }
  }
  function ensure(userId) {
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
    if (!user) throw error(401, 'AUTH_REQUIRED', 'Sign in to continue.');
    db.prepare('INSERT OR IGNORE INTO two_factor(user_id) VALUES (?)').run(userId);
    return { ...db.prepare('SELECT * FROM two_factor WHERE user_id=?').get(userId), password: user.password, email: user.email, sessionVersion: user.session_version ?? 0 };
  }
  function snapshot(userId) {
    const row = ensure(userId);
    return { password: row.password, version: row.version, enabled: Boolean(row.secret), sessionVersion: row.sessionVersion };
  }
  function checkSnapshot(userId, expected) {
    const row = ensure(userId);
    if (!expected || expected.password !== row.password || expected.version !== row.version || expected.sessionVersion !== row.sessionVersion) throw changed();
    return row;
  }
  function transaction(work) {
    db.exec('BEGIN IMMEDIATE');
    let result;
    try { result = work(); db.exec('COMMIT'); } catch (failure) { db.exec('ROLLBACK'); throw failure; }
    // Failed verification must commit its counters, while never committing a
    // credential mutation. Work returns an error rather than throwing it.
    if (result?.failure) throw result.failure;
    return result;
  }
  function blocked(row) {
    return row.blocked_until > now() ? error(429, 'TWO_FACTOR_RATE_LIMITED', 'Too many authentication attempts. Wait 15 minutes before trying again.') : null;
  }
  function recordFailure(row) {
    const time = now();
    const inWindow = row.failure_started + failureWindow > time;
    const failures = inWindow ? row.failures + 1 : 1;
    db.prepare('UPDATE two_factor SET failures=?,failure_started=?,blocked_until=? WHERE user_id=?').run(failures, inWindow ? row.failure_started : time, failures >= maxFailures ? time + failureWindow : 0, row.user_id);
    return failures >= maxFailures ? error(429, 'TWO_FACTOR_RATE_LIMITED', 'Too many authentication attempts. Wait 15 minutes before trying again.') : invalidFactor();
  }
  function clearFailures(userId) {
    db.prepare('UPDATE two_factor SET failures=0,failure_started=0,blocked_until=0 WHERE user_id=?').run(userId);
  }
  function matchingCounter(secret, value, lastCounter) {
    if (typeof value !== 'string' || value.length > 128) return null;
    const code = value.replace(/[\s-]/g, '');
    if (!/^\d{6}$/.test(code)) return null;
    const current = Math.floor(now() / 30000);
    let matched = null;
    for (const drift of [-1, 0, 1]) {
      const candidate = current + drift;
      if (candidate < 0) continue;
      const equal = timingSafeEqual(Buffer.from(code), Buffer.from(generateTotpCode(secret, { counter: candidate })));
      if (equal && candidate > lastCounter) matched = candidate;
    }
    return matched;
  }
  function useFactor(row, value, { pending = false, recovery = true } = {}) {
    const locked = blocked(row);
    if (locked) return { failure: locked };
    const encrypted = pending ? row.pending_secret : row.secret;
    if (!encrypted) return { failure: invalidFactor() };
    // Recovery codes remain usable if a database backup was restored without
    // its encryption key. Never turn a missing key into a factor bypass.
    const normalized = typeof value === 'string' && value.length <= 128 ? value.replace(/[\s-]/g, '').toUpperCase() : '';
    if (recovery && !pending && /^[A-F0-9]{32}$/.test(normalized)) {
      const consumed = db.prepare('DELETE FROM two_factor_recovery_codes WHERE user_id=? AND code_hash=?').run(row.user_id, digest(`${row.user_id}:${normalized}`));
      if (consumed.changes) { clearFailures(row.user_id); return { method: 'recovery' }; }
      return { failure: recordFailure(row) };
    }
    const counter = matchingCounter(decrypt(row.user_id, encrypted), value, pending ? -1 : row.last_counter);
    if (counter !== null) {
      db.prepare('UPDATE two_factor SET last_counter=? WHERE user_id=?').run(counter, row.user_id);
      clearFailures(row.user_id);
      return { method: 'authenticator' };
    }
    return { failure: recordFailure(row) };
  }
  function replaceRecoveryCodes(userId) {
    const codes = Array.from({ length: 10 }, () => randomBytes(16).toString('hex').toUpperCase());
    db.prepare('DELETE FROM two_factor_recovery_codes WHERE user_id=?').run(userId);
    const statement = db.prepare('INSERT INTO two_factor_recovery_codes(user_id,code_hash,created_at) VALUES (?,?,?)');
    for (const code of codes) statement.run(userId, digest(`${userId}:${code}`), now());
    return codes.map(code => code.match(/.{8}/g).join('-'));
  }
  function deleteChallenges(userId) { db.prepare('DELETE FROM two_factor_challenges WHERE user_id=?').run(userId); }
  function status(userId) {
    const row = ensure(userId);
    return { enabled: Boolean(row.secret), enabledAt: row.enabled_at ?? null,
      enrollmentPending: !row.secret && Boolean(row.pending_secret) && row.pending_expires > now(),
      enrollmentExpiresAt: !row.secret && row.pending_expires > now() ? row.pending_expires : null,
      recoveryCodesRemaining: db.prepare('SELECT count(*) count FROM two_factor_recovery_codes WHERE user_id=?').get(userId).count };
  }
  function beginEnrollment(userId, expected) {
    return transaction(() => {
      const row = checkSnapshot(userId, expected);
      if (row.secret) throw error(409, 'TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already enabled.');
      if (blocked(row)) return { failure: blocked(row) };
      const secret = encodeBase32(randomBytes(20));
      const expiresAt = now() + enrollmentLifetime;
      db.prepare('UPDATE two_factor SET pending_secret=?,pending_expires=? WHERE user_id=?').run(encrypt(userId, secret), expiresAt, userId);
      const query = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: '6', period: '30' });
      return { secret, otpauthUri: `otpauth://totp/${encodeURIComponent(`${issuer}:${row.email}`)}?${query}`, expiresAt };
    });
  }
  function confirmEnrollment(userId, expected, code, { onChange } = {}) {
    return transaction(() => {
      const row = checkSnapshot(userId, expected);
      if (row.secret) throw error(409, 'TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already enabled.');
      if (!row.pending_secret || row.pending_expires <= now()) throw error(400, 'TWO_FACTOR_ENROLLMENT_EXPIRED', 'This setup has expired. Start two-factor setup again.');
      const factor = useFactor(row, code, { pending: true, recovery: false });
      if (factor.failure) return factor;
      db.prepare('UPDATE two_factor SET secret=pending_secret,pending_secret=NULL,pending_expires=NULL,version=version+1,enabled_at=? WHERE user_id=?').run(now(), userId);
      const recoveryCodes = replaceRecoveryCodes(userId);
      deleteChallenges(userId);
      synchronousCallback(onChange, { userId, action: 'enabled' });
      return { recoveryCodes };
    });
  }
  function cancelEnrollment(userId, expected) {
    return transaction(() => {
      const row = checkSnapshot(userId, expected);
      if (row.secret) throw error(409, 'TWO_FACTOR_ALREADY_ENABLED', 'Two-factor authentication is already enabled.');
      db.prepare('UPDATE two_factor SET pending_secret=NULL,pending_expires=NULL WHERE user_id=?').run(userId);
      return { cancelled: true };
    });
  }
  function disable(userId, expected, code, { onChange } = {}) {
    return transaction(() => {
      const row = checkSnapshot(userId, expected);
      if (!row.secret) throw error(400, 'TWO_FACTOR_NOT_ENABLED', 'Two-factor authentication is not enabled.');
      const factor = useFactor(row, code);
      if (factor.failure) return factor;
      db.prepare('UPDATE two_factor SET secret=NULL,pending_secret=NULL,pending_expires=NULL,version=version+1,last_counter=-1,enabled_at=NULL WHERE user_id=?').run(userId);
      db.prepare('DELETE FROM two_factor_recovery_codes WHERE user_id=?').run(userId);
      deleteChallenges(userId);
      synchronousCallback(onChange, { userId, action: 'disabled' });
      return { disabled: true };
    });
  }
  function regenerateRecoveryCodes(userId, expected, code, { onChange } = {}) {
    return transaction(() => {
      const row = checkSnapshot(userId, expected);
      if (!row.secret) throw error(400, 'TWO_FACTOR_NOT_ENABLED', 'Two-factor authentication is not enabled.');
      const factor = useFactor(row, code);
      if (factor.failure) return factor;
      const recoveryCodes = replaceRecoveryCodes(userId);
      db.prepare('UPDATE two_factor SET version=version+1 WHERE user_id=?').run(userId);
      deleteChallenges(userId);
      synchronousCallback(onChange, { userId, action: 'recovery-regenerated' });
      return { recoveryCodes };
    });
  }
  function createChallenge(userId, expected) {
    return transaction(() => {
      const row = checkSnapshot(userId, expected);
      if (!row.secret) throw error(409, 'TWO_FACTOR_NOT_ENABLED', 'Two-factor authentication is not enabled.');
      if (blocked(row)) return { failure: blocked(row) };
      const time = now();
      db.prepare('DELETE FROM two_factor_challenges WHERE expires<=?').run(time);
      // Keep parallel browser tabs usable, but cap stored requests per user.
      const previous = db.prepare('SELECT token FROM two_factor_challenges WHERE user_id=? ORDER BY expires DESC LIMIT -1 OFFSET 4').all(userId);
      for (const item of previous) db.prepare('DELETE FROM two_factor_challenges WHERE token=?').run(item.token);
      const challenge = randomBytes(32).toString('hex');
      const expiresAt = time + challengeLifetime;
      db.prepare('INSERT INTO two_factor_challenges(token,user_id,password_fingerprint,version,session_version,expires) VALUES (?,?,?,?,?,?)').run(digest(challenge), userId, digest(row.password), row.version, row.sessionVersion, expiresAt);
      return { challenge, expiresAt };
    });
  }
  function completeChallenge(challenge, code, { onComplete } = {}) {
    if (typeof challenge !== 'string' || !/^[a-f0-9]{64}$/.test(challenge)) throw invalidChallenge();
    return transaction(() => {
      const token = digest(challenge);
      const pending = db.prepare('SELECT * FROM two_factor_challenges WHERE token=?').get(token);
      if (!pending || pending.expires <= now() || pending.attempts >= maxChallengeAttempts) {
        if (pending) db.prepare('DELETE FROM two_factor_challenges WHERE token=?').run(token);
        return { failure: invalidChallenge() };
      }
      const row = ensure(pending.user_id);
      if (!row.secret || digest(row.password) !== pending.password_fingerprint || row.version !== pending.version || row.sessionVersion !== pending.session_version) {
        db.prepare('DELETE FROM two_factor_challenges WHERE token=?').run(token);
        return { failure: invalidChallenge() };
      }
      const factor = useFactor(row, code);
      if (factor.failure) {
        if (factor.failure.code !== 'TWO_FACTOR_RATE_LIMITED') {
          db.prepare('UPDATE two_factor_challenges SET attempts=attempts+1 WHERE token=?').run(token);
          if (pending.attempts + 1 >= maxChallengeAttempts) db.prepare('DELETE FROM two_factor_challenges WHERE token=?').run(token);
        }
        return factor;
      }
      // Completing one challenge invalidates every competing sign-in request.
      // A second request cannot spend the same TOTP or recovery code.
      deleteChallenges(row.user_id);
      const completed = { userId: row.user_id, method: factor.method };
      synchronousCallback(onComplete, completed);
      return completed;
    });
  }
  function authorize(userId, expected, code, { onAuthorized } = {}) {
    return transaction(() => {
      const row = checkSnapshot(userId, expected);
      const factor = row.secret ? useFactor(row, code) : { method: 'password' };
      if (factor.failure) return factor;
      const authorized = { userId, method: factor.method };
      synchronousCallback(onAuthorized, authorized);
      return authorized;
    });
  }
  function synchronousCallback(callback, value) {
    if (!callback) return;
    const result = callback(value);
    if (result && typeof result.then === 'function') throw new TypeError('Security transaction callbacks must be synchronous.');
  }
  function enrollmentCurrent(userId, secret) {
    const row = ensure(userId);
    if (row.secret || !row.pending_secret || row.pending_expires <= now() || typeof secret !== 'string' || !/^[A-Z2-7]{32}$/.test(secret)) return false;
    return timingSafeEqual(Buffer.from(decrypt(userId, row.pending_secret)), Buffer.from(secret));
  }
  function assertSnapshot(userId, expected) { checkSnapshot(userId, expected); }
  function cancelChallenge(challenge) {
    if (typeof challenge === 'string' && /^[a-f0-9]{64}$/.test(challenge)) db.prepare('DELETE FROM two_factor_challenges WHERE token=?').run(digest(challenge));
    return { cancelled: true };
  }
  function invalidateChallenges(userId) {
    db.prepare('UPDATE two_factor SET pending_secret=NULL,pending_expires=NULL,version=version+1 WHERE user_id=?').run(userId);
    deleteChallenges(userId);
  }
  return { snapshot, assertSnapshot, status, beginEnrollment, enrollmentCurrent, confirmEnrollment, cancelEnrollment, disable, regenerateRecoveryCodes, createChallenge, completeChallenge, cancelChallenge, authorize, invalidateChallenges, invalidateAuthentication: invalidateChallenges };
}
