import { createHash, randomBytes } from 'node:crypto';
import { createPasswordManager } from './passwords.mjs';

const digest = value => createHash('sha256').update(value).digest('hex');
const linkLifetime = 20 * 60000;
const requestCooldown = 60000;
const requestWindow = 3600000;
const commonPasswords = new Set(['passwordpassword', 'password123456789', 'qwertyuiopasdfgh', 'qwertyuiopasdfghjkl', 'letmeinletmeinletmein', 'iloveyouiloveyou', 'adminadminadminadmin', 'welcome123456789', 'changemechangeme', 'fundraiseracademy', 'fundraiseracademy123']);
export const passwordResetRequestMessage = 'If an account exists for that email, we’ll send a password reset link. Check your inbox and spam folder.';
export const passwordResetSuccessMessage = 'Your password has been changed. Sign in with your new password. All previous sessions have been signed out.';

function invalidLink() {
  return Object.assign(new Error('This password reset link is invalid or has expired. Request a new link.'), { status: 400, code: 'PASSWORD_RESET_INVALID' });
}

// Only digests persist in the credential tables. A raw link exists exclusively
// in the private email outbox until its send, cancellation, or final failure.
export function createPasswordRecovery(db, { delivery, now = Date.now, isAvailable = () => true, onReset = () => {}, hashPassword } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS password_resets (
    token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    expires INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS password_resets_user ON password_resets(user_id);
    CREATE TABLE IF NOT EXISTS password_reset_requests (
    email_hash TEXT PRIMARY KEY, next_at INTEGER NOT NULL,
    window_start INTEGER NOT NULL, attempts INTEGER NOT NULL);`);
  const passwords = hashPassword ? null : createPasswordManager();
  const encodePassword = hashPassword ?? passwords.encode;
  const active = new Set();

  function request(emailValue) {
    // Invalid input receives the same response and never becomes a database key.
    const email = typeof emailValue === 'string' ? emailValue.trim().toLowerCase() : '';
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
    const time = now();
    db.prepare('DELETE FROM password_reset_requests WHERE window_start<?').run(time - 86400000);
    const emailHash = digest(email);
    const previous = db.prepare('SELECT * FROM password_reset_requests WHERE email_hash=?').get(emailHash);
    if (previous && (previous.next_at > time || previous.window_start + requestWindow > time && previous.attempts >= 5)) return;
    const windowStart = previous && previous.window_start + requestWindow > time ? previous.window_start : time;
    const attempts = windowStart === previous?.window_start ? previous.attempts + 1 : 1;
    db.prepare(`INSERT INTO password_reset_requests(email_hash,next_at,window_start,attempts) VALUES (?,?,?,?)
      ON CONFLICT(email_hash) DO UPDATE SET next_at=excluded.next_at,window_start=excluded.window_start,attempts=excluded.attempts`).run(emailHash, time + requestCooldown, windowStart, attempts);
    const row = db.prepare('SELECT id FROM users WHERE email=?').get(email);
    if (!row || !delivery.status(row.id).emailAvailable) return;
    const token = randomBytes(32).toString('hex');
    const tokenHash = digest(token);
    db.exec('BEGIN IMMEDIATE');
    try {
      delivery.cancelPasswordResets(row.id);
      db.prepare('DELETE FROM password_resets WHERE user_id=?').run(row.id);
      db.prepare('INSERT INTO password_resets(token,user_id,expires,created_at) VALUES (?,?,?,?)').run(tokenHash, row.id, time + linkLifetime, time);
      delivery.queuePasswordReset(row.id, { token, digest: tokenHash, expiresAt: time + linkLifetime });
      db.exec('COMMIT');
    } catch {
      db.exec('ROLLBACK');
      // Provider configuration and account existence must never change the
      // public response. The persisted cooldown also covers delivery failures.
    }
  }

  async function performReset(token, password) {
    if (typeof password !== 'string' || [...password].length < 15 || [...password].length > 128 || password.includes('\u0000')) {
      throw Object.assign(new Error('Choose a password with 15–128 characters. A long, unique passphrase works well.'), { status: 400, code: 'PASSWORD_TOO_WEAK' });
    }
    const comparison = password.toLowerCase();
    if (commonPasswords.has(comparison) || /^(.)\1+$/su.test(comparison) || /^(?:password|qwerty|admin|letmein|welcome|changeme){2,}$/u.test(comparison) || '0123456789'.repeat(13).includes(comparison) || '9876543210'.repeat(13).includes(comparison)) {
      throw Object.assign(new Error('Choose a less predictable password. A long, unique passphrase works well.'), { status: 400, code: 'PASSWORD_TOO_WEAK' });
    }
    if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) throw invalidLink();
    const tokenHash = digest(token);
    const original = db.prepare(`SELECT password_resets.user_id,users.password FROM password_resets
      JOIN users ON users.id=password_resets.user_id WHERE token=? AND expires>?`).get(tokenHash, now());
    if (!original) throw invalidLink();
    const encoded = await encodePassword(password);
    if (!isAvailable()) throw Object.assign(new Error('The server is restarting. Please try again shortly.'), { status: 503 });
    db.exec('BEGIN IMMEDIATE');
    try {
      // The link may have been consumed, replaced, or expired while scrypt ran.
      // Comparing the stored credential also prevents competing reset links
      // from replacing a password that changed after this operation began.
      const current = db.prepare(`SELECT password_resets.user_id,users.password FROM password_resets
        JOIN users ON users.id=password_resets.user_id WHERE token=? AND expires>?`).get(tokenHash, now());
      if (!current || current.password !== original.password) throw invalidLink();
      db.prepare('UPDATE users SET password=? WHERE id=?').run(encoded, current.user_id);
      db.prepare('DELETE FROM password_resets WHERE user_id=?').run(current.user_id);
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(current.user_id);
      delivery.cancelPasswordResets(current.user_id);
      delivery.revokeDeviceNotifications(current.user_id);
      delivery.queuePasswordChanged(current.user_id);
      db.prepare('INSERT INTO events(user_id,kind,detail,created_at) VALUES (?,?,?,?)').run(current.user_id, 'password-reset', '{"sessionsRevoked":true,"deviceNotificationsRevoked":true}', now());
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    onReset(original.user_id);
  }

  function reset(token, password) {
    const task = performReset(token, password);
    active.add(task);
    task.then(() => active.delete(task), () => active.delete(task));
    return task;
  }
  return { request, reset, close: () => Promise.allSettled([...active, passwords?.close()]) };
}
