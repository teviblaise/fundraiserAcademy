import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createAdminAccess, ADMIN_ROLES } from './admin-access.mjs';

const usage = 'Usage: node admin-cli.mjs list, or node admin-cli.mjs grant --email registered@example.com --role owner|admin|reviewer|support [--reason "..."] or revoke --email registered@example.com [--reason "..."]';
const [action, ...args] = process.argv.slice(2);
const databasePath = process.env.DATABASE_PATH || fileURLToPath(new URL('./data/academy.sqlite', import.meta.url));
let db;
try {
  if (!['grant','revoke','list'].includes(action) || args.length % 2 !== 0) throw new Error(usage);
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    if (!['--email','--role','--reason'].includes(name) || options[name] !== undefined || typeof args[index + 1] !== 'string' || !args[index + 1]) throw new Error(usage);
    options[name] = args[index + 1];
  }
  if (action === 'list' && args.length || action !== 'list' && !options['--email'] || action === 'grant' && !ADMIN_ROLES.includes(options['--role']) || action === 'revoke' && options['--role']) throw new Error(usage);
  if (!existsSync(databasePath)) throw new Error('The academy database does not exist at DATABASE_PATH. Run this command on the application server using its existing database.');
  db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  for (const table of ['users','notification_preferences','two_factor','sessions']) if (!db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(table)) throw new Error('Start the current academy server first to initialize account security before managing administrators.');
  if (!db.prepare('PRAGMA table_info(users)').all().some(column => column.name === 'session_version')) throw new Error('Start the current academy server first to initialize account security before managing administrators.');
  const access = createAdminAccess(db);
  if (action === 'list') console.log(JSON.stringify(access.staff(), null, 2));
  else {
    const email = options['--email'].trim().toLowerCase();
    if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('Provide the registered staff email using --email.');
    const user = db.prepare('SELECT id,email,name FROM users WHERE email=?').get(email);
    if (!user) throw new Error('No registered account uses that email. Register, confirm email ownership, and enable two-factor authentication first.');
    const reason = options['--reason'] || 'Role changed by an operator on the application server.';
    db.exec('BEGIN IMMEDIATE');
    let result;
    try {
      result = action === 'grant' ? access.grant(null, user.id, options['--role'], reason) : access.revoke(null, user.id, reason);
      // Existing sessions and challenges must reauthenticate after an access
      // change, including any login whose password check was already running.
      db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id);
      const changed = db.prepare(`UPDATE users SET session_version=session_version+1
        WHERE id=? AND typeof(session_version)='integer' AND session_version>=0 AND session_version<?`).run(user.id, Number.MAX_SAFE_INTEGER);
      if (changed.changes !== 1) throw new Error('The account security generation is invalid.');
      db.prepare('UPDATE two_factor SET pending_secret=NULL,pending_expires=NULL,version=version+1 WHERE user_id=?').run(user.id);
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='two_factor_challenges'").get()) db.prepare('DELETE FROM two_factor_challenges WHERE user_id=?').run(user.id);
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='push_subscriptions'").get()) db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(user.id);
      if (db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='notification_outbox'").get()) db.prepare("UPDATE notification_outbox SET status='cancelled',payload='{}' WHERE user_id=? AND channel='push' AND status IN ('pending','sending')").run(user.id);
      db.exec('COMMIT');
    } catch (failure) { db.exec('ROLLBACK'); throw failure; }
    console.log(JSON.stringify({ email: user.email, name: user.name, role: result.role, eligible: result.eligible, environmentManaged: result.environmentManaged, sessionsRevoked: true }, null, 2));
  }
} catch (failure) {
  // Avoid printing database diagnostics that could include stored credentials.
  console.error(failure.status ? failure.message : failure.code?.startsWith('SQLITE') ? 'The administrator change could not be completed. Check the existing application database.' : failure.message);
  process.exitCode = 1;
} finally { db?.close(); }
