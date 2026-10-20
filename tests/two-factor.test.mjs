import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createTwoFactor, generateTotpCode } from '../two-factor.mjs';

const sha256 = value => createHash('sha256').update(value).digest('hex');
const expectedError = (work, code, status) => assert.throws(work, failure => failure.code === code && (status === undefined || failure.status === status));
const asciiBase32 = value => {
  const binary = [...Buffer.from(value)].map(byte => byte.toString(2).padStart(8, '0')).join('');
  return binary.match(/.{1,5}/g).map(bits => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(bits.padEnd(5, '0'), 2)]).join('');
};

function fixture(options = {}) {
  const folder = mkdtempSync(path.join(tmpdir(), 'fa-two-factor-'));
  const database = path.join(folder, 'academy.sqlite');
  let time = 1800000000000;
  let db = new DatabaseSync(database);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,password TEXT,session_version INTEGER NOT NULL DEFAULT 0);
    INSERT INTO users(id,email,password) VALUES (1,'ada@example.com','encoded-original-password'),(2,'grace@example.com','encoded-second-password');`);
  let security = createTwoFactor(db, database, { now: () => time, ...options });
  const app = {
    database, folder, keyPath: path.join(folder, 'two-factor-key.json'),
    get db() { return db; }, get security() { return security; },
    get time() { return time; },
    advance(milliseconds = 30000) { time += milliseconds; },
    code(secret, drift = 0) { return generateTotpCode(secret, { time: time + drift * 30000 }); },
    enroll(userId = 1) {
      const snapshot = security.snapshot(userId);
      const enrollment = security.beginEnrollment(userId, snapshot);
      const confirmed = security.confirmEnrollment(userId, snapshot, app.code(enrollment.secret));
      return { ...enrollment, ...confirmed };
    },
    challenge(userId = 1) { return security.createChallenge(userId, security.snapshot(userId)); },
    restart(settings = options) { db.close(); db = new DatabaseSync(database); security = createTwoFactor(db, database, { now: () => time, ...settings }); },
    close() { db.close(); rmSync(folder, { recursive: true, force: true }); },
  };
  return app;
}

// Published RFC 6238 Appendix B values, covering all specified hash algorithms.
test('TOTP interoperates with every RFC 6238 SHA-1/SHA-256/SHA-512 test vector', () => {
  const vectors = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  const algorithms = ['sha1', 'sha256', 'sha512'];
  const secrets = ['12345678901234567890', '12345678901234567890123456789012', '1234567890123456789012345678901234567890123456789012345678901234'].map(asciiBase32);
  for (const [seconds, ...expected] of vectors) {
    for (let index = 0; index < algorithms.length; index++) {
      assert.equal(generateTotpCode(secrets[index], { time: seconds * 1000, digits: 8, algorithm: algorithms[index] }), expected[index]);
      assert.equal(generateTotpCode(secrets[index], { time: seconds * 1000, algorithm: algorithms[index] }), expected[index].slice(-6));
    }
  }
  assert.throws(() => generateTotpCode('not-base32'));
  assert.throws(() => generateTotpCode(secrets[0], { counter: -1 }));
});

test('enrollment uses an encrypted 160-bit secret, private stable key, and a standard authenticator URI', () => {
  const app = fixture();
  try {
    const before = app.security.status(1);
    assert.deepEqual(before, { enabled: false, enabledAt: null, enrollmentPending: false, enrollmentExpiresAt: null, recoveryCodesRemaining: 0 });
    const snapshot = app.security.snapshot(1);
    const enrollment = app.security.beginEnrollment(1, snapshot);
    assert.match(enrollment.secret, /^[A-Z2-7]{32}$/);
    const uri = new URL(enrollment.otpauthUri);
    assert.equal(uri.protocol, 'otpauth:');
    assert.equal(uri.hostname, 'totp');
    assert.equal(decodeURIComponent(uri.pathname), '/Fundraiser Academy:ada@example.com');
    assert.equal(uri.searchParams.get('secret'), enrollment.secret);
    assert.equal(uri.searchParams.get('issuer'), 'Fundraiser Academy');
    assert.equal(uri.searchParams.get('digits'), '6');
    assert.equal(uri.searchParams.get('period'), '30');
    assert.equal(enrollment.expiresAt, app.time + 600000);
    const privateRow = app.db.prepare('SELECT * FROM two_factor WHERE user_id=1').get();
    assert.match(privateRow.pending_secret, /^v1:/);
    assert.ok(!JSON.stringify(privateRow).includes(enrollment.secret));
    assert.ok(!JSON.stringify(app.security.status(1)).includes(enrollment.secret));
    assert.equal(app.security.status(1).enabled, false);
    assert.equal(app.security.status(1).enrollmentPending, true);
    assert.equal(app.security.enrollmentCurrent(1, enrollment.secret), true);
    assert.equal(statSync(app.keyPath).mode & 0o777, 0o600);
    const originalKey = readFileSync(app.keyPath, 'utf8');
    app.restart();
    assert.equal(readFileSync(app.keyPath, 'utf8'), originalKey);
    assert.equal(app.security.enrollmentCurrent(1, enrollment.secret), true);
    app.security.confirmEnrollment(1, app.security.snapshot(1), app.code(enrollment.secret));
    assert.equal(app.security.status(1).enabled, true);
  } finally { app.close(); }
});

test('setup replacement, cancellation, and ten-minute expiry cannot enable an unconfirmed secret', () => {
  const app = fixture();
  try {
    let snapshot = app.security.snapshot(1);
    const first = app.security.beginEnrollment(1, snapshot);
    const second = app.security.beginEnrollment(1, snapshot);
    assert.notEqual(first.secret, second.secret);
    assert.equal(app.security.enrollmentCurrent(1, first.secret), false);
    assert.equal(app.security.enrollmentCurrent(1, second.secret), true);
    expectedError(() => app.security.confirmEnrollment(1, snapshot, 'not-a-code'), 'TWO_FACTOR_INVALID', 400);
    app.security.cancelEnrollment(1, snapshot);
    assert.equal(app.security.status(1).enrollmentPending, false);
    expectedError(() => app.security.confirmEnrollment(1, snapshot, app.code(second.secret)), 'TWO_FACTOR_ENROLLMENT_EXPIRED');
    snapshot = app.security.snapshot(1);
    const third = app.security.beginEnrollment(1, snapshot);
    app.advance(600000);
    assert.equal(app.security.enrollmentCurrent(1, third.secret), false);
    assert.equal(app.security.status(1).enrollmentExpiresAt, null);
    expectedError(() => app.security.confirmEnrollment(1, snapshot, app.code(third.secret)), 'TWO_FACTOR_ENROLLMENT_EXPIRED');
    assert.equal(app.security.status(1).enabled, false);
  } finally { app.close(); }
});

test('enabling requires proof and displays ten 128-bit recovery codes only in the successful mutation result', () => {
  const app = fixture();
  try {
    const enrollment = app.enroll();
    assert.equal(enrollment.recoveryCodes.length, 10);
    assert.equal(new Set(enrollment.recoveryCodes).size, 10);
    for (const code of enrollment.recoveryCodes) assert.match(code, /^[A-F0-9]{8}(?:-[A-F0-9]{8}){3}$/);
    const rows = app.db.prepare('SELECT code_hash FROM two_factor_recovery_codes WHERE user_id=1').all();
    assert.equal(rows.length, 10);
    assert.equal(rows[0].code_hash.length, 64);
    const persisted = JSON.stringify(rows);
    for (const code of enrollment.recoveryCodes) assert.ok(!persisted.includes(code.replaceAll('-', '')));
    assert.equal(app.security.status(1).recoveryCodesRemaining, 10);
    assert.ok(!JSON.stringify(app.security.status(1)).includes('recoveryCodes"'));
    assert.equal(app.db.prepare('SELECT pending_secret FROM two_factor WHERE user_id=1').get().pending_secret, null);
    expectedError(() => app.security.beginEnrollment(1, app.security.snapshot(1)), 'TWO_FACTOR_ALREADY_ENABLED');
  } finally { app.close(); }
});

test('authenticator codes are single use across setup, sign-in, and account security actions, including restart', () => {
  const app = fixture();
  try {
    const enrollment = app.enroll();
    let challenge = app.challenge();
    expectedError(() => app.security.completeChallenge(challenge.challenge, app.code(enrollment.secret)), 'TWO_FACTOR_INVALID');
    app.advance();
    assert.equal(app.security.completeChallenge(challenge.challenge, app.code(enrollment.secret)).userId, 1);
    expectedError(() => app.security.completeChallenge(challenge.challenge, app.code(enrollment.secret)), 'TWO_FACTOR_CHALLENGE_INVALID');
    app.restart();
    challenge = app.challenge();
    expectedError(() => app.security.completeChallenge(challenge.challenge, app.code(enrollment.secret)), 'TWO_FACTOR_INVALID');
    expectedError(() => app.security.regenerateRecoveryCodes(1, app.security.snapshot(1), app.code(enrollment.secret)), 'TWO_FACTOR_INVALID');
    app.advance();
    assert.equal(app.security.authorize(1, app.security.snapshot(1), app.code(enrollment.secret)).method, 'authenticator');
    expectedError(() => app.security.disable(1, app.security.snapshot(1), app.code(enrollment.secret)), 'TWO_FACTOR_INVALID');
  } finally { app.close(); }
});

test('TOTP accepts one adjacent 30-second step and rejects older codes or reuse of the future step', () => {
  const app = fixture();
  try {
    const enrollment = app.enroll();
    app.advance(90000);
    assert.equal(app.security.completeChallenge(app.challenge().challenge, app.code(enrollment.secret, -1)).method, 'authenticator');
    app.advance(90000);
    assert.equal(app.security.completeChallenge(app.challenge().challenge, app.code(enrollment.secret, 1)).method, 'authenticator');
    app.advance();
    expectedError(() => app.security.completeChallenge(app.challenge().challenge, app.code(enrollment.secret)), 'TWO_FACTOR_INVALID');
    app.advance(90000);
    expectedError(() => app.security.completeChallenge(app.challenge().challenge, app.code(enrollment.secret, -2)), 'TWO_FACTOR_INVALID');
  } finally { app.close(); }
});

test('recovery codes work case-insensitively once, are account-bound, and competing challenges cannot replay them', () => {
  const app = fixture();
  try {
    const one = app.enroll();
    app.enroll(2);
    const first = app.challenge(), second = app.challenge();
    assert.equal(app.security.completeChallenge(first.challenge, one.recoveryCodes[0].toLowerCase()).method, 'recovery');
    expectedError(() => app.security.completeChallenge(second.challenge, one.recoveryCodes[1]), 'TWO_FACTOR_CHALLENGE_INVALID');
    expectedError(() => app.security.completeChallenge(app.challenge().challenge, one.recoveryCodes[0]), 'TWO_FACTOR_INVALID');
    expectedError(() => app.security.completeChallenge(app.challenge(2).challenge, one.recoveryCodes[1]), 'TWO_FACTOR_INVALID');
    assert.equal(app.security.status(1).recoveryCodesRemaining, 9);
    assert.equal(app.security.status(2).recoveryCodesRemaining, 10);
  } finally { app.close(); }
});

test('challenges are stored only as digests, expire in five minutes, cancel safely, and allow five failures only', () => {
  const app = fixture();
  try {
    const enrollment = app.enroll();
    const challenge = app.challenge();
    assert.match(challenge.challenge, /^[a-f0-9]{64}$/);
    assert.equal(challenge.expiresAt, app.time + 300000);
    const stored = app.db.prepare('SELECT * FROM two_factor_challenges').get();
    assert.equal(stored.token, sha256(challenge.challenge));
    assert.equal(stored.password_fingerprint, sha256('encoded-original-password'));
    assert.equal(stored.session_version, 0);
    for (let index = 0; index < 5; index++) expectedError(() => app.security.completeChallenge(challenge.challenge, 'not-a-code'), 'TWO_FACTOR_INVALID');
    expectedError(() => app.security.completeChallenge(challenge.challenge, enrollment.recoveryCodes[0]), 'TWO_FACTOR_CHALLENGE_INVALID');
    const expiring = app.challenge();
    app.advance(300000);
    expectedError(() => app.security.completeChallenge(expiring.challenge, enrollment.recoveryCodes[0]), 'TWO_FACTOR_CHALLENGE_INVALID');
    const cancelled = app.challenge();
    assert.deepEqual(app.security.cancelChallenge(cancelled.challenge), { cancelled: true });
    assert.deepEqual(app.security.cancelChallenge('malformed'), { cancelled: true });
    expectedError(() => app.security.completeChallenge(cancelled.challenge, enrollment.recoveryCodes[0]), 'TWO_FACTOR_CHALLENGE_INVALID');
  } finally { app.close(); }
});

test('per-account failure limits persist across new challenges and restart, then recover after a cooldown', () => {
  const app = fixture();
  try {
    const enrollment = app.enroll();
    let challenge = app.challenge();
    for (let index = 0; index < 5; index++) expectedError(() => app.security.completeChallenge(challenge.challenge, 'not-a-code'), 'TWO_FACTOR_INVALID');
    app.restart();
    challenge = app.challenge();
    for (let index = 0; index < 4; index++) expectedError(() => app.security.completeChallenge(challenge.challenge, 'not-a-code'), 'TWO_FACTOR_INVALID');
    expectedError(() => app.security.completeChallenge(challenge.challenge, 'not-a-code'), 'TWO_FACTOR_RATE_LIMITED', 429);
    app.restart();
    expectedError(() => app.challenge(), 'TWO_FACTOR_RATE_LIMITED');
    expectedError(() => app.security.disable(1, app.security.snapshot(1), enrollment.recoveryCodes[0]), 'TWO_FACTOR_RATE_LIMITED');
    app.advance(15 * 60000 + 1);
    assert.equal(app.security.completeChallenge(app.challenge().challenge, enrollment.recoveryCodes[0]).userId, 1);
    assert.equal(app.db.prepare('SELECT failures FROM two_factor WHERE user_id=1').get().failures, 0);
  } finally { app.close(); }
});

test('password changes, factor versions, and session generations invalidate pending sign-in requests', () => {
  for (const update of [
    "UPDATE users SET password='encoded-new-password' WHERE id=1",
    'UPDATE two_factor SET version=version+1 WHERE user_id=1',
    'UPDATE users SET session_version=session_version+1 WHERE id=1',
  ]) {
    const app = fixture();
    try {
      const enrollment = app.enroll();
      const original = app.security.snapshot(1);
      const challenge = app.challenge();
      app.db.exec(update);
      expectedError(() => app.security.createChallenge(1, original), 'SECURITY_STATE_CHANGED', 409);
      expectedError(() => app.security.completeChallenge(challenge.challenge, enrollment.recoveryCodes[0]), 'TWO_FACTOR_CHALLENGE_INVALID');
      expectedError(() => app.security.disable(1, original, enrollment.recoveryCodes[0]), 'SECURITY_STATE_CHANGED');
      assert.equal(app.security.status(1).recoveryCodesRemaining, 10);
    } finally { app.close(); }
  }
});

test('factor and session transactions roll back consumed codes and all side effects if a synchronous callback fails', () => {
  const app = fixture();
  try {
    const enrollment = app.enroll();
    const snapshot = app.security.snapshot(1);
    const challenge = app.challenge();
    const abort = () => { app.db.exec('UPDATE users SET session_version=session_version+1 WHERE id=1'); throw new Error('Simulated transaction failure'); };
    assert.throws(() => app.security.completeChallenge(challenge.challenge, enrollment.recoveryCodes[0], { onComplete: abort }), /Simulated transaction failure/);
    assert.equal(app.security.status(1).recoveryCodesRemaining, 10);
    assert.equal(app.security.snapshot(1).sessionVersion, 0);
    assert.equal(app.db.prepare('SELECT count(*) count FROM two_factor_challenges').get().count, 1);
    assert.throws(() => app.security.regenerateRecoveryCodes(1, snapshot, enrollment.recoveryCodes[0], { onChange: abort }), /Simulated transaction failure/);
    assert.equal(app.security.snapshot(1).version, snapshot.version);
    assert.equal(app.security.status(1).recoveryCodesRemaining, 10);
    assert.throws(() => app.security.disable(1, snapshot, enrollment.recoveryCodes[0], { onChange: abort }), /Simulated transaction failure/);
    assert.equal(app.security.status(1).enabled, true);
    assert.equal(app.security.status(1).recoveryCodesRemaining, 10);
    assert.throws(() => app.security.authorize(1, snapshot, enrollment.recoveryCodes[0], { onAuthorized: abort }), /Simulated transaction failure/);
    assert.equal(app.security.completeChallenge(challenge.challenge, enrollment.recoveryCodes[0]).method, 'recovery');
  } finally { app.close(); }
});

test('enrollment activation callback is atomic and callbacks receive only non-secret identifiers', () => {
  const app = fixture();
  try {
    const snapshot = app.security.snapshot(1);
    const enrollment = app.security.beginEnrollment(1, snapshot);
    assert.throws(() => app.security.confirmEnrollment(1, snapshot, app.code(enrollment.secret), { onChange: () => { throw new Error('Unavailable session store'); } }), /Unavailable session store/);
    assert.equal(app.security.status(1).enabled, false);
    assert.equal(app.security.status(1).recoveryCodesRemaining, 0);
    let change;
    app.security.confirmEnrollment(1, snapshot, app.code(enrollment.secret), { onChange: data => { change = data; } });
    assert.deepEqual(change, { userId: 1, action: 'enabled' });
  } finally { app.close(); }
});

test('regeneration invalidates every older recovery code and challenge; disabling removes all factors', () => {
  const app = fixture();
  try {
    const enrollment = app.enroll();
    const challenge = app.challenge();
    const replacement = app.security.regenerateRecoveryCodes(1, app.security.snapshot(1), enrollment.recoveryCodes[0]);
    assert.equal(replacement.recoveryCodes.length, 10);
    expectedError(() => app.security.completeChallenge(challenge.challenge, replacement.recoveryCodes[0]), 'TWO_FACTOR_CHALLENGE_INVALID');
    expectedError(() => app.security.completeChallenge(app.challenge().challenge, enrollment.recoveryCodes[1]), 'TWO_FACTOR_INVALID');
    assert.equal(app.security.completeChallenge(app.challenge().challenge, replacement.recoveryCodes[0]).method, 'recovery');
    app.security.disable(1, app.security.snapshot(1), replacement.recoveryCodes[1]);
    assert.equal(app.security.status(1).enabled, false);
    assert.equal(app.security.status(1).recoveryCodesRemaining, 0);
    assert.equal(app.db.prepare('SELECT secret FROM two_factor WHERE user_id=1').get().secret, null);
    assert.equal(app.security.authorize(1, app.security.snapshot(1), undefined).method, 'password');
  } finally { app.close(); }
});

test('session-management authorization requires a fresh factor when enabled and is atomic with revocation', () => {
  const app = fixture();
  try {
    const enrollment = app.enroll();
    let calls = 0;
    expectedError(() => app.security.authorize(1, app.security.snapshot(1), 'not-a-code', { onAuthorized: () => calls++ }), 'TWO_FACTOR_INVALID');
    assert.equal(calls, 0);
    const result = app.security.authorize(1, app.security.snapshot(1), enrollment.recoveryCodes[0], { onAuthorized: () => {
      calls++;
      app.db.exec('UPDATE users SET session_version=session_version+1 WHERE id=1');
      app.security.invalidateAuthentication(1);
    } });
    assert.deepEqual(result, { userId: 1, method: 'recovery' });
    assert.equal(calls, 1);
    assert.equal(app.security.snapshot(1).sessionVersion, 1);
    assert.equal(app.security.status(1).enabled, true);
    assert.equal(app.security.status(1).recoveryCodesRemaining, 9);
  } finally { app.close(); }
});

test('authentication invalidation preserves enabled factors and recovery codes but clears setup and challenges', () => {
  const app = fixture();
  try {
    const enrollment = app.enroll();
    const oldVersion = app.security.snapshot(1).version;
    const challenge = app.challenge();
    app.security.invalidateAuthentication(1);
    assert.equal(app.security.snapshot(1).version, oldVersion + 1);
    assert.equal(app.security.status(1).enabled, true);
    assert.equal(app.security.status(1).recoveryCodesRemaining, 10);
    expectedError(() => app.security.completeChallenge(challenge.challenge, enrollment.recoveryCodes[0]), 'TWO_FACTOR_CHALLENGE_INVALID');
    const pending = app.security.beginEnrollment(2, app.security.snapshot(2));
    app.security.invalidateAuthentication(2);
    assert.equal(app.security.enrollmentCurrent(2, pending.secret), false);
  } finally { app.close(); }
});

test('missing or wrong encryption keys fail closed for TOTP while single-use recovery remains available', () => {
  const app = fixture();
  try {
    const enrollment = app.enroll();
    const privateKey = readFileSync(app.keyPath, 'utf8');
    app.restart({ encryptionKey: randomBytes(32).toString('base64') });
    app.advance();
    expectedError(() => app.security.completeChallenge(app.challenge().challenge, app.code(enrollment.secret)), 'TWO_FACTOR_UNAVAILABLE', 503);
    assert.equal(app.security.completeChallenge(app.challenge().challenge, enrollment.recoveryCodes[0]).method, 'recovery');
    unlinkSync(app.keyPath);
    app.restart();
    assert.equal(existsSync(app.keyPath), false, 'lost key must not be silently replaced');
    expectedError(() => app.security.completeChallenge(app.challenge().challenge, app.code(enrollment.secret)), 'TWO_FACTOR_UNAVAILABLE');
    assert.equal(app.security.completeChallenge(app.challenge().challenge, enrollment.recoveryCodes[1]).method, 'recovery');
    expectedError(() => app.security.completeChallenge(app.challenge().challenge, enrollment.recoveryCodes[1]), 'TWO_FACTOR_INVALID');
    const replacement = app.security.regenerateRecoveryCodes(1, app.security.snapshot(1), enrollment.recoveryCodes[2]);
    assert.equal(replacement.recoveryCodes.length, 10);
    expectedError(() => app.security.completeChallenge(app.challenge().challenge, enrollment.recoveryCodes[3]), 'TWO_FACTOR_INVALID');
    assert.equal(app.security.completeChallenge(app.challenge().challenge, replacement.recoveryCodes[0]).method, 'recovery');
    writeFileSync(app.keyPath, privateKey, { mode: 0o600 });
    app.restart();
    assert.equal(app.security.completeChallenge(app.challenge().challenge, app.code(enrollment.secret)).method, 'authenticator');
    unlinkSync(app.keyPath);
    app.restart();
    app.security.disable(1, app.security.snapshot(1), replacement.recoveryCodes[1]);
    assert.equal(app.security.status(1).enabled, false);
  } finally { app.close(); }
});

test('AES-GCM authenticates both ciphertext and account identity, preventing secret substitution', () => {
  const app = fixture();
  try {
    const first = app.enroll();
    app.enroll(2);
    const other = app.db.prepare('SELECT secret FROM two_factor WHERE user_id=2').get().secret;
    app.db.prepare('UPDATE two_factor SET secret=? WHERE user_id=1').run(other);
    app.advance();
    expectedError(() => app.security.completeChallenge(app.challenge().challenge, app.code(first.secret)), 'TWO_FACTOR_UNAVAILABLE');
    assert.equal(app.security.completeChallenge(app.challenge().challenge, first.recoveryCodes[0]).method, 'recovery');
    app.db.prepare('UPDATE two_factor SET secret=? WHERE user_id=1').run('v1:corrupt:corrupt:corrupt');
    expectedError(() => app.security.completeChallenge(app.challenge().challenge, app.code(first.secret)), 'TWO_FACTOR_UNAVAILABLE');
  } finally { app.close(); }
});

test('operator-provided keys survive restart, never create local key files, and reject malformed configuration', () => {
  const encryptionKey = randomBytes(32).toString('base64');
  const app = fixture({ encryptionKey });
  try {
    const enrollment = app.enroll();
    assert.equal(existsSync(app.keyPath), false);
    app.restart({ encryptionKey });
    app.advance();
    assert.equal(app.security.completeChallenge(app.challenge().challenge, app.code(enrollment.secret)).method, 'authenticator');
    assert.throws(() => createTwoFactor(app.db, app.database, { encryptionKey: 'not-a-32-byte-key' }), /base64-encoded 32-byte key/);
    assert.throws(() => createTwoFactor(app.db, app.database, { encryptionKey: 'a'.repeat(43) + '=' }), /base64-encoded 32-byte key/);
  } finally { app.close(); }
});

test('challenge table migration binds pre-existing requests to the default session generation', () => {
  const app = fixture();
  try {
    app.db.exec('DROP TABLE two_factor_challenges; CREATE TABLE two_factor_challenges(token TEXT PRIMARY KEY,user_id INTEGER,password_fingerprint TEXT,version INTEGER,expires INTEGER,attempts INTEGER DEFAULT 0);');
    app.restart();
    assert.equal(app.db.prepare('PRAGMA table_info(two_factor_challenges)').all().find(column => column.name === 'session_version').notnull, 1);
    const enrollment = app.enroll();
    assert.equal(app.security.completeChallenge(app.challenge().challenge, enrollment.recoveryCodes[0]).userId, 1);
  } finally { app.close(); }
});
