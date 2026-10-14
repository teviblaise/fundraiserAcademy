import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { manageSupportRole } from './support.mjs';

const [action, ...args] = process.argv.slice(2);
const databasePath = process.env.DATABASE_PATH || fileURLToPath(new URL('./data/academy.sqlite', import.meta.url));
let db;
try {
  if (!['grant', 'revoke', 'list'].includes(action) || args.length && (args.length !== 2 || args[0] !== '--email') || action !== 'list' && args.length !== 2 || action === 'list' && args.length) throw new Error('Usage: node support-admin.mjs grant|revoke --email registered-agent@example.com, or node support-admin.mjs list');
  if (!existsSync(databasePath)) throw new Error('The academy database does not exist at DATABASE_PATH. Run this command on the application server using its existing database.');
  db = new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON;');
  console.log(JSON.stringify(manageSupportRole(db, action, args[1]), null, 2));
} catch (error) { console.error(error.message); process.exitCode = 1; }
finally { db?.close(); }
