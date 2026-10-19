import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash, scrypt as scryptCallback } from 'node:crypto';
import { promisify } from 'node:util';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackend } from '../backend.mjs';
import { createReferenceFixture } from './helpers/reference-fixture.mjs';
import { testDeliveryOptions, confirmRegistration } from './helpers/email-fixture.mjs';

const scrypt = promisify(scryptCallback);
const oldPassword = 'original private recovery password';
const newPassword = 'a different long private passphrase';
const registration = { firstName: 'Ada', otherNames: 'Lovelace', email: 'ada@example.com', password: oldPassword, market: 'I trade both', consent: true };
const digest = value => createHash('sha256').update(value).digest('hex');
const unicodePassword = count => Array.from({ length: count }, (_, index) => String.fromCodePoint(0x1f300 + index)).join('');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(options = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'fa-recovery-'));
  const database = path.join(folder, 'academy.sqlite');
  let time = Date.now();
  const deliveryOptions = { ...testDeliveryOptions, now: () => time, ...options.deliveryOptions };
  const settings = { marketData: options.marketData ?? createReferenceFixture({ now: () => time }), deliveryOptions, now: () => time, autoTick: false, ...options.backendOptions };
  let backend = createBackend(database, settings);
  const server = http.createServer((req, res) => backend.handle(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const app = {
    database, origin,
    advance: milliseconds => { time += milliseconds; },
    inspect(work) { const db = new DatabaseSync(database); try { return work(db); } finally { db.close(); } },
    async request(endpoint, data, cookie, headers = {}) {
      const response = await fetch(origin + endpoint, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy', ...(cookie ? { Cookie: cookie } : {}), ...headers },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    },
    async register({ confirmed = true } = {}) {
      const registered = await app.request('/api/register', registration);
      assert.equal(registered.status, 201);
      if (confirmed) await confirmRegistration(database, app.request, registered);
      return registered;
    },
    resetToken() {
      return app.inspect(db => {
        const row = db.prepare("SELECT payload FROM notification_outbox WHERE channel='password-reset' ORDER BY id DESC LIMIT 1").get();
        return /#token=([a-f0-9]{64})/.exec(JSON.parse(row?.payload ?? '{}').text ?? '')?.[1];
      });
    },
    async restart() { await backend.close(); backend = createBackend(database, settings); },
    beginClose: () => backend.close(),
    async close() { await new Promise(resolve => server.close(resolve)); await backend.close(); await rm(folder, { recursive: true, force: true }); },
  };
  return app;
}

test('forgot password conceals account existence, normalizes email, persists cooldown, and never exposes a raw token', async () => {
  const app = await fixture();
  try {
    await app.register();
    const known = await app.request('/api/password/forgot', { email: ' ADA@EXAMPLE.COM ' });
    const unknown = await app.request('/api/password/forgot', { email: 'unknown@example.com' });
    const invalid = await app.request('/api/password/forgot', { email: null });
    assert.equal(known.status, 202);
    assert.deepEqual(known, unknown);
    assert.deepEqual(known, invalid);
    assert.equal(known.cookie, undefined);
    const token = app.resetToken();
    assert.match(token, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(known).includes(token));
    app.inspect(db => {
      const stored = db.prepare('SELECT * FROM password_resets').get();
      assert.equal(stored.token, digest(token));
      assert.equal(stored.expires - stored.created_at, 20 * 60000);
      assert.ok(!JSON.stringify(db.prepare('SELECT * FROM password_reset_requests').all()).includes(registration.email));
      assert.equal(db.prepare("SELECT count(*) n FROM notification_outbox WHERE channel='password-reset'").get().n, 1);
    });
    await app.restart();
    assert.deepEqual(await app.request('/api/password/forgot', { email: registration.email }), known);
    assert.equal(app.resetToken(), token, 'restart must preserve the per-address cooldown');
    app.advance(61000);
    await app.request('/api/password/forgot', { email: registration.email });
    assert.notEqual(app.resetToken(), token);
    app.inspect(db => {
      assert.equal(db.prepare('SELECT count(*) n FROM password_resets').get().n, 1);
      const canceled = db.prepare("SELECT payload,status FROM notification_outbox WHERE channel='password-reset' ORDER BY id LIMIT 1").get();
      assert.equal(canceled.status, 'cancelled');
      assert.ok(!canceled.payload.includes(token));
    });
    const replaced = await app.request('/api/password/reset', { token, password: newPassword });
    assert.equal(replaced.status, 400);
    assert.equal(replaced.body.code, 'PASSWORD_RESET_INVALID');
  } finally { await app.close(); }
});

test('delivery disabled and exhausted IP limits keep the same generic forgot response without creating links', async () => {
  const app = await fixture({ deliveryOptions: { config: {} } });
  try {
    await app.register({ confirmed: false });
    const expected = await app.request('/api/password/forgot', { email: registration.email });
    assert.equal(expected.status, 202);
    for (let index = 0; index < 203; index++) assert.deepEqual(await app.request('/api/password/forgot', { email: `absent${index}@example.com` }), expected);
    app.inspect(db => {
      assert.equal(db.prepare('SELECT count(*) n FROM password_resets').get().n, 0);
      assert.equal(db.prepare('SELECT count(*) n FROM password_reset_requests').get().n, 200, 'only the first 200 requests from a shared proxy may create cooldown records');
    });
  } finally { await app.close(); }
});

test('a reset revokes every session and device, keeps account data and preferences, and requires a fresh login', async () => {
  const app = await fixture();
  try {
    const owner = await app.register();
    const otherSession = await app.request('/api/login', { email: registration.email, password: oldPassword });
    assert.equal(otherSession.status, 200);
    const before = app.inspect(db => {
      db.prepare('UPDATE notification_preferences SET email_enabled=0 WHERE user_id=?').run(owner.body.user.id);
      db.prepare('INSERT INTO push_subscriptions(endpoint,user_id,subscription) VALUES (?,?,?)').run('https://push.example.com/private', owner.body.user.id, '{}');
      db.prepare('INSERT INTO notification_outbox(user_id,notice_key,channel,target,payload,status,next_at) VALUES (?,?,?,?,?,?,?)').run(owner.body.user.id, 'private-push', 'push', 'https://push.example.com/private', '{"text":"private trade update"}', 'pending', Date.now());
      return {
        account: db.prepare('SELECT state FROM accounts WHERE user_id=?').get(owner.body.user.id).state,
        user: db.prepare('SELECT email,name,first_name,other_names,market,created_at,email_confirmation_required FROM users WHERE id=?').get(owner.body.user.id),
        preferences: db.prepare('SELECT * FROM notification_preferences WHERE user_id=?').get(owner.body.user.id),
        certificates: db.prepare('SELECT * FROM certificates WHERE user_id=?').all(owner.body.user.id),
      };
    });
    await app.request('/api/password/forgot', { email: registration.email });
    const token = app.resetToken();
    await app.restart();
    // Startup intentionally increments account revision; snapshot after restart.
    before.account = app.inspect(db => db.prepare('SELECT state FROM accounts WHERE user_id=?').get(owner.body.user.id).state);
    const reset = await app.request('/api/password/reset', { token, password: newPassword }, owner.cookie);
    assert.equal(reset.status, 200);
    assert.equal(reset.cookie, 'fa_session=');
    for (const sessionCookie of [owner.cookie, otherSession.cookie]) assert.equal((await app.request('/api/me', undefined, sessionCookie)).status, 401);
    assert.equal((await app.request('/api/login', { email: registration.email, password: oldPassword })).status, 401);
    const login = await app.request('/api/login', { email: registration.email, password: newPassword });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.emailVerified, true);
    app.inspect(db => {
      assert.deepEqual(db.prepare('SELECT email,name,first_name,other_names,market,created_at,email_confirmation_required FROM users WHERE id=?').get(owner.body.user.id), before.user);
      assert.equal(db.prepare('SELECT state FROM accounts WHERE user_id=?').get(owner.body.user.id).state, before.account);
      assert.deepEqual(db.prepare('SELECT * FROM notification_preferences WHERE user_id=?').get(owner.body.user.id), before.preferences);
      assert.deepEqual(db.prepare('SELECT * FROM certificates WHERE user_id=?').all(owner.body.user.id), before.certificates);
      assert.equal(db.prepare('SELECT count(*) n FROM password_resets').get().n, 0);
      assert.match(db.prepare('SELECT password FROM users WHERE id=?').get(owner.body.user.id).password, /^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
      assert.equal(db.prepare('SELECT count(*) n FROM push_subscriptions').get().n, 0);
      const push = db.prepare("SELECT status,payload FROM notification_outbox WHERE notice_key='private-push'").get();
      assert.equal(push.status, 'cancelled');
      assert.ok(!push.payload.includes('private trade update'));
      assert.equal(db.prepare("SELECT count(*) n FROM notification_outbox WHERE channel='password-changed'").get().n, 1);
      assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind='password-reset'").get().n, 1);
      assert.ok(!JSON.stringify(db.prepare('SELECT * FROM events').all()).includes(token));
    });
    const reused = await app.request('/api/password/reset', { token, password: newPassword });
    assert.equal(reused.status, 400);
    assert.equal(reused.body.code, 'PASSWORD_RESET_INVALID');
  } finally { await app.close(); }
});

test('expired, missing, malformed and consumed links use one safe error, and pending email access stays pending', async () => {
  const app = await fixture();
  try {
    await app.register({ confirmed: false });
    await app.request('/api/password/forgot', { email: registration.email });
    const token = app.resetToken();
    app.advance(20 * 60000);
    const expired = await app.request('/api/password/reset', { token, password: newPassword });
    assert.equal(expired.status, 400);
    for (const invalid of [undefined, '', {}, '0'.repeat(64), `${token}?extra`]) {
      assert.deepEqual((await app.request('/api/password/reset', { token: invalid, password: newPassword })).body, expired.body);
    }
    await app.request('/api/password/forgot', { email: registration.email });
    const accepted = await app.request('/api/password/reset', { token: app.resetToken(), password: unicodePassword(15) });
    assert.equal(accepted.status, 200);
    const login = await app.request('/api/login', { email: registration.email, password: unicodePassword(15) });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.assessmentAccess, false);
    assert.equal(login.body.user.emailVerified, false);
    assert.equal((await app.request('/api/account', undefined, login.cookie)).status, 403);
  } finally { await app.close(); }
});

test('password reset validates passphrases without consuming a valid link and rejects cross-origin requests', async () => {
  const app = await fixture();
  try {
    await app.register();
    await app.request('/api/password/forgot', { email: registration.email });
    const token = app.resetToken();
    for (const password of ['', 'short password', '🌱'.repeat(14), 'x'.repeat(129), null, 'a'.repeat(15) + '\u0000']) {
      const result = await app.request('/api/password/reset', { token, password });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'PASSWORD_TOO_WEAK');
    }
    assert.equal((await app.request('/api/password/reset', { token, password: newPassword }, undefined, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await app.request('/api/password/forgot', { email: registration.email }, undefined, { Origin: 'https://attacker.example' })).status, 403);
    const accepted = await app.request('/api/password/reset', { token, password: unicodePassword(128) });
    assert.equal(accepted.status, 200, '128 Unicode code points must remain valid');
    assert.equal((await app.request('/api/login', { email: registration.email, password: unicodePassword(128) })).status, 200);
  } finally { await app.close(); }
});

test('obvious common passwords are rejected without imposing composition rules or trimming a passphrase', async () => {
  const app = await fixture();
  try {
    await app.register();
    await app.request('/api/password/forgot', { email: registration.email });
    const token = app.resetToken();
    for (const password of ['passwordpassword', 'PasswordPassword', '123456789012345', 'aaaaaaaaaaaaaaa']) {
      const result = await app.request('/api/password/reset', { token, password });
      assert.equal(result.status, 400);
      assert.equal(result.body.code, 'PASSWORD_TOO_WEAK');
    }
    const passphrase = '  glass orchard lantern pebble  ';
    assert.equal((await app.request('/api/password/reset', { token, password: passphrase })).status, 200);
    assert.equal((await app.request('/api/login', { email: registration.email, password: passphrase.trim() })).status, 401);
    assert.equal((await app.request('/api/login', { email: registration.email, password: passphrase })).status, 200);
  } finally { await app.close(); }
});

test('simultaneous reset submissions can change the password only once', async () => {
  const app = await fixture();
  try {
    await app.register();
    await app.request('/api/password/forgot', { email: registration.email });
    const token = app.resetToken();
    const results = await Promise.all([
      app.request('/api/password/reset', { token, password: newPassword }),
      app.request('/api/password/reset', { token, password: 'another different long password' }),
    ]);
    assert.deepEqual(results.map(result => result.status).sort(), [200, 400]);
    app.inspect(db => assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind='password-reset'").get().n, 1));
  } finally { await app.close(); }
});

test('an old-password login already hashing cannot create a session after recovery', async () => {
  const started = deferred(); const released = deferred();
  let holdLogin = false;
  const app = await fixture({ backendOptions: { async passwordScrypt(password, salt, length, options) {
    if (holdLogin && password === oldPassword) { started.resolve(); await released.promise; }
    return scrypt(password, salt, length, options);
  } } });
  try {
    await app.register();
    await app.request('/api/password/forgot', { email: registration.email });
    holdLogin = true;
    const login = app.request('/api/login', { email: registration.email, password: oldPassword });
    await started.promise;
    const reset = await app.request('/api/password/reset', { token: app.resetToken(), password: newPassword });
    assert.equal(reset.status, 200);
    released.resolve();
    assert.equal((await login).status, 401);
    app.inspect(db => assert.equal(db.prepare('SELECT count(*) n FROM sessions').get().n, 0));
  } finally { released.resolve(); await app.close(); }
});

test('a trade awaiting a price cannot execute after password reset, while protective market refresh remains active', async () => {
  const started = deferred(); const released = deferred();
  const marketData = createReferenceFixture();
  const actualQuote = marketData.getExecutionQuote;
  marketData.getExecutionQuote = async symbol => { started.resolve(); await released.promise; return actualQuote(symbol); };
  const app = await fixture({ marketData });
  try {
    const owner = await app.register();
    await app.request('/api/password/forgot', { email: registration.email });
    const trade = app.request('/api/trades', { symbol: 'EURUSD', side: 'buy', lots: 0.01 }, owner.cookie);
    await started.promise;
    const reset = await app.request('/api/password/reset', { token: app.resetToken(), password: newPassword });
    assert.equal(reset.status, 200);
    released.resolve();
    assert.equal((await trade).status, 401);
    app.inspect(db => {
      const account = JSON.parse(db.prepare('SELECT state FROM accounts').get().state);
      assert.equal(account.positions.length, 0);
      assert.equal(account.history.length, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind='trade-open'").get().n, 0);
    });
  } finally { released.resolve(); await app.close(); }
});

test('legacy passwords counted by UTF-16 remain usable at sign-in', async () => {
  const app = await fixture();
  try {
    const owner = await app.register();
    const password = '🌱'.repeat(6);
    const salt = '0123456789abcdef0123456789abcdef';
    const encoded = `${salt}:${(await scrypt(password, salt, 64)).toString('hex')}`;
    app.inspect(db => db.prepare('UPDATE users SET password=? WHERE id=?').run(encoded, owner.body.user.id));
    assert.equal((await app.request('/api/login', { email: registration.email, password })).status, 200);
  } finally { await app.close(); }
});

test('expiration or replacement while scrypt awaits cannot consume a reset link', async () => {
  for (const mode of ['expired', 'replaced']) {
    const started = deferred(); const released = deferred();
    const app = await fixture({ backendOptions: { async passwordScrypt(password, salt, length, options) {
      if (password === newPassword) { started.resolve(); await released.promise; }
      return scrypt(password, salt, length, options);
    } } });
    try {
      await app.register();
      await app.request('/api/password/forgot', { email: registration.email });
      const token = app.resetToken();
      const reset = app.request('/api/password/reset', { token, password: newPassword });
      await started.promise;
      app.advance(mode === 'expired' ? 20 * 60000 : 61000);
      if (mode === 'replaced') {
        await app.request('/api/password/forgot', { email: registration.email });
        assert.notEqual(app.resetToken(), token);
      }
      released.resolve();
      const result = await reset;
      assert.equal(result.status, 400, mode);
      assert.equal(result.body.code, 'PASSWORD_RESET_INVALID', mode);
      assert.equal((await app.request('/api/login', { email: registration.email, password: oldPassword })).status, 200, mode);
    } finally { released.resolve(); await app.close(); }
  }
});

test('password recovery immediately expires an SSE session even while its market provider is blocked', async () => {
  const started = deferred(); const released = deferred();
  const marketData = createReferenceFixture();
  const actualQuote = marketData.getExecutionQuote;
  marketData.getExecutionQuote = async symbol => { started.resolve(); await released.promise; return actualQuote(symbol); };
  const app = await fixture({ marketData });
  try {
    const owner = await app.register();
    await app.request('/api/password/forgot', { email: registration.email });
    const stream = await fetch(`${app.origin}/api/account-stream?symbol=EURUSD`, { headers: { Cookie: owner.cookie }, signal: AbortSignal.timeout(4000) });
    assert.equal(stream.status, 200);
    await started.promise;
    const reset = await app.request('/api/password/reset', { token: app.resetToken(), password: newPassword });
    assert.equal(reset.status, 200);
    assert.match(await stream.text(), /event: auth-expired\ndata: .*password was changed/u);
  } finally { released.resolve(); await app.close(); }
});

test('request mail limits persist per address even across different request windows and process restarts', async () => {
  const app = await fixture();
  try {
    await app.register();
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await app.request('/api/password/forgot', { email: registration.email })).status, 202);
      app.advance(61000);
    }
    await app.restart();
    assert.equal((await app.request('/api/password/forgot', { email: registration.email })).status, 202);
    app.inspect(db => assert.equal(db.prepare("SELECT count(*) n FROM notification_outbox WHERE channel='password-reset'").get().n, 5));
    app.advance(3600000);
    assert.equal((await app.request('/api/password/forgot', { email: registration.email })).status, 202);
    app.inspect(db => assert.equal(db.prepare("SELECT count(*) n FROM notification_outbox WHERE channel='password-reset'").get().n, 6));
  } finally { await app.close(); }
});

test('reset rate limits use a token digest and an independent shared-proxy budget without hashing malformed links', async () => {
  let calls = 0;
  const app = await fixture({ backendOptions: { async passwordScrypt(value, salt, length) { calls++; return Buffer.alloc(length, 1); } } });
  try {
    await app.register();
    await app.request('/api/password/forgot', { email: registration.email });
    const token = app.resetToken();
    for (let attempt = 0; attempt < 10; attempt++) {
      assert.equal((await app.request('/api/password/reset', { token, password: 'short' }, undefined, { 'X-Forwarded-For': `192.0.2.${attempt}` })).status, 400);
    }
    assert.equal((await app.request('/api/password/reset', { token, password: newPassword })).status, 429);
    for (let attempt = 0; attempt < 89; attempt++) {
      assert.equal((await app.request('/api/password/reset', { token: `malformed-${attempt}`, password: newPassword }, undefined, { 'X-Forwarded-For': `198.51.100.${attempt}` })).status, 400);
    }
    assert.equal((await app.request('/api/password/reset', { token: 'malformed-final', password: newPassword })).status, 429);
    assert.equal(calls, 1, 'invalid links and rejected passwords must never run a KDF');
  } finally { await app.close(); }
});

test('password workload overload returns a safe 503 while already accepted logins finish', { timeout: 10000 }, async () => {
  const gate = deferred(); const overloaded = deferred();
  let hold = false;
  let active = 0; let maximum = 0;
  const app = await fixture({ backendOptions: { async passwordScrypt(value, salt, length) {
    active++; maximum = Math.max(maximum, active);
    if (hold) await gate.promise;
    active--;
    return Buffer.alloc(length, 1);
  } } });
  try {
    await app.register();
    hold = true;
    const logins = Array.from({ length: 19 }, async () => {
      const response = await app.request('/api/login', { email: registration.email, password: oldPassword });
      if (response.status === 503) overloaded.resolve(response);
      return response;
    });
    const rejected = await overloaded.promise;
    assert.match(rejected.body.error, /busy/u);
    assert.ok(!JSON.stringify(rejected).includes(oldPassword));
    assert.equal(maximum, 2);
    gate.resolve();
    const results = await Promise.all(logins);
    assert.equal(results.filter(result => result.status === 503).length, 1);
    assert.equal(results.filter(result => result.status === 200).length, 18);
  } finally { gate.resolve(); await app.close(); }
});

test('backend shutdown waits for an in-flight reset KDF before closing SQLite and keeps the old credential', async () => {
  const gate = deferred(); const started = deferred();
  let hold = false;
  const app = await fixture({ backendOptions: { async passwordScrypt(value, salt, length) {
    if (hold) { started.resolve(); await gate.promise; }
    return Buffer.alloc(length, 1);
  } } });
  try {
    const owner = await app.register();
    const original = app.inspect(db => db.prepare('SELECT password FROM users').get().password);
    await app.request('/api/password/forgot', { email: registration.email });
    const token = app.resetToken();
    hold = true;
    const reset = app.request('/api/password/reset', { token, password: newPassword });
    await started.promise;
    let closed = false;
    const closing = app.beginClose().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    assert.equal((await app.request('/api/me', undefined, owner.cookie)).status, 503);
    gate.resolve();
    assert.equal((await reset).status, 503);
    await closing;
    app.inspect(db => {
      assert.equal(db.prepare('SELECT password FROM users').get().password, original);
      assert.equal(db.prepare('SELECT count(*) n FROM password_resets').get().n, 1);
      assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind='password-reset'").get().n, 0);
    });
    await app.restart();
    assert.equal((await app.request('/api/password/reset', { token, password: newPassword })).status, 200);
  } finally { gate.resolve(); await app.close(); }
});
