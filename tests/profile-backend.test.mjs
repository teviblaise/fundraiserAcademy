import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackend } from '../backend.mjs';
import { createAccount } from '../public/simulator.js';
import { createCertificates } from '../certificates.mjs';
import { createContracts } from '../contracts.mjs';
import { createReferenceFixture } from './helpers/reference-fixture.mjs';
import { testDeliveryOptions, confirmRegistration } from './helpers/email-fixture.mjs';

const password = 'long-private-profile-test-password';
const registration = { firstName: 'Ada', otherNames: 'Lovelace', email: 'ada@example.com', password, market: 'I trade both', consent: true };
const profileKeys = ['assessmentAccess', 'createdAt', 'email', 'emailConfirmationRequired', 'emailVerified', 'firstName', 'id', 'market', 'name', 'otherNames'];

async function fixture(seed, deliveryOptions = testDeliveryOptions) {
  const folder = await mkdtemp(path.join(tmpdir(), 'fa-profile-'));
  const database = path.join(folder, 'academy.sqlite');
  if (seed) await seed(database);
  let backend = createBackend(database, { marketData: createReferenceFixture(), deliveryOptions, autoTick: false });
  const server = http.createServer((req, res) => backend.handle(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    database,
    async request(endpoint, data, cookie, extra = {}) {
      const response = await fetch(origin + endpoint, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy', ...(cookie ? { Cookie: cookie } : {}), ...extra },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    },
    async restart() { await backend.close(); backend = createBackend(database, { marketData: createReferenceFixture(), deliveryOptions, autoTick: false }); },
    async close() { await new Promise(resolve => server.close(resolve)); await backend.close(); await rm(folder, { recursive: true, force: true }); },
  };
}

function assertPublicUser(user) {
  assert.deepEqual(Object.keys(user).sort(), profileKeys);
  assert.ok(Number.isSafeInteger(user.createdAt));
  assert.ok(user.createdAt > 0);
  assert.ok(!JSON.stringify(user).includes(password));
}

test('structured and legacy registration expose persisted split names and only public profile fields', async () => {
  const app = await fixture();
  try {
    const structured = await app.request('/api/register', { ...registration, firstName: '  Émilie  ', otherNames: '  王  O’Connor  ', name: 'Émilie 王 O’Connor' });
    assert.equal(structured.status, 201);
    assertPublicUser(structured.body.user);
    assert.equal(structured.body.user.firstName, 'Émilie');
    assert.equal(structured.body.user.otherNames, '王 O’Connor');
    assert.equal(structured.body.user.name, 'Émilie 王 O’Connor');
    const singleton = await app.request('/api/register', { ...registration, firstName: 'Björk', otherNames: '', email: 'single@example.com' });
    assert.equal(singleton.status, 201);
    assert.equal(singleton.body.user.name, 'Björk');
    assert.equal(singleton.body.user.otherNames, '');
    const { firstName, otherNames, ...oldClient } = registration;
    const legacy = await app.request('/api/register', { ...oldClient, name: 'Chimamanda Ngozi Adichie', email: 'legacy@example.com' });
    assert.equal(legacy.status, 201);
    assert.equal(legacy.body.user.firstName, 'Chimamanda');
    assert.equal(legacy.body.user.otherNames, 'Ngozi Adichie');
    await app.restart();
    const me = await app.request('/api/me', undefined, structured.cookie);
    assert.deepEqual(me.body.user, structured.body.user);
    const login = await app.request('/api/login', { email: registration.email, password });
    assert.equal(login.status, 200);
    assert.deepEqual(login.body.user, structured.body.user);
    assertPublicUser(login.body.user);
  } finally { await app.close(); }
});

test('registration rejects invalid structured names and conflicting full names before creating a user', async () => {
  const app = await fixture();
  try {
    for (const invalid of [
      { firstName: '' }, { firstName: '   ' }, { firstName: 42 }, { firstName: {} },
      { firstName: 'Ada\n' }, { firstName: '123' }, { otherNames: null }, { otherNames: ['Lovelace'] },
      { otherNames: 'Love\u0000lace' }, { firstName: 'A'.repeat(70), otherNames: 'B'.repeat(31) },
      { name: 'Different Person' }, { name: 42 },
    ]) {
      const result = await app.request('/api/register', { ...registration, ...invalid });
      assert.equal(result.status, 400, JSON.stringify(invalid));
    }
    const { firstName, ...missingFirst } = registration;
    assert.equal((await app.request('/api/register', missingFirst)).status, 400);
    const valid = await app.request('/api/register', { ...registration, firstName: 'Ó'.repeat(49), otherNames: '王'.repeat(50) });
    assert.equal(valid.status, 201);
    assert.equal(valid.body.user.name.length, 100);
    const db = new DatabaseSync(app.database);
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM users').get().n, 1); }
    finally { db.close(); }
  } finally { await app.close(); }
});

test('existing users migrate additively without changing full names, credentials, or membership dates', async () => {
  const originalName = '  María   José Álvarez  ';
  const salt = '0123456789abcdef0123456789abcdef';
  const storedPassword = `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
  const createdAt = 1700000000000;
  const app = await fixture(database => {
    const db = new DatabaseSync(database);
    try {
      db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,market TEXT NOT NULL,password TEXT NOT NULL,created_at INTEGER NOT NULL); CREATE TABLE accounts (user_id INTEGER PRIMARY KEY REFERENCES users(id),state TEXT NOT NULL);');
      db.prepare('INSERT INTO users VALUES (?,?,?,?,?,?)').run(7, 'migrated@example.com', originalName, 'I trade forex', storedPassword, createdAt);
      db.prepare('INSERT INTO accounts VALUES (?,?)').run(7, JSON.stringify(createAccount()));
    } finally { db.close(); }
  });
  try {
    const login = await app.request('/api/login', { email: 'migrated@example.com', password });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.name, originalName);
    assert.equal(login.body.user.firstName, 'María');
    assert.equal(login.body.user.otherNames, 'José Álvarez');
    assert.equal(login.body.user.createdAt, createdAt);
    assert.equal(login.body.user.emailConfirmationRequired, false);
    assert.equal(login.body.user.emailVerified, false);
    assert.equal(login.body.user.assessmentAccess, true, 'users who registered before mandatory confirmation retain access');
    assert.equal((await app.request('/api/account', undefined, login.cookie)).status, 200);
    assert.equal((await app.request('/api/profile', { market: 'I trade crypto' }, login.cookie)).body.user.name, originalName, 'changing only a preferred market preserves the exact old registered name');
    const updated = await app.request('/api/profile', { firstName: 'María José', otherNames: 'Álvarez' }, login.cookie);
    assert.equal(updated.status, 200);
    await app.restart();
    const me = await app.request('/api/me', undefined, login.cookie);
    assert.equal(me.body.user.firstName, 'María José', 'restart must retain an explicitly chosen multiword first name');
    assert.equal(me.body.user.otherNames, 'Álvarez');
    assert.equal(me.body.user.createdAt, createdAt);
    const db = new DatabaseSync(app.database);
    try {
      assert.equal(db.prepare('SELECT password FROM users WHERE id=7').get().password, storedPassword);
      assert.equal(db.prepare('PRAGMA table_info(users)').all().filter(column => ['first_name', 'other_names'].includes(column.name)).length, 2);
    } finally { db.close(); }
  } finally { await app.close(); }
});

test('profile updates require the owner session and website origin, reject protected fields, and remain isolated', async () => {
  const app = await fixture();
  try {
    const first = await app.request('/api/register', registration);
    const second = await app.request('/api/register', { ...registration, firstName: 'Grace', otherNames: 'Hopper', email: 'grace@example.com' });
    assert.equal((await app.request('/api/profile', { firstName: 'New' })).status, 401);
    assert.equal((await app.request('/api/me')).status, 401);
    assert.equal((await app.request('/api/profile', { firstName: 'New' }, first.cookie, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await app.request('/api/profile', { firstName: 'New' }, first.cookie, { 'X-Requested-With': '' })).status, 403);
    for (const fields of [
      { id: second.body.user.id }, { email: 'changed@example.com' }, { password: 'new-password' }, { name: 'Different Name' },
      { firstName: null }, { firstName: '' }, { otherNames: 1 }, { market: 'Unsupported market' }, {},
    ]) assert.equal((await app.request('/api/profile', fields, first.cookie)).status, 400, JSON.stringify(fields));
    const update = await app.request(`/api/profile?userId=${second.body.user.id}`, { firstName: 'Augusta', market: 'I trade crypto' }, first.cookie);
    assert.equal(update.status, 200);
    assertPublicUser(update.body.user);
    assert.equal(update.body.user.name, 'Augusta Lovelace');
    assert.equal(update.body.user.email, registration.email);
    assert.equal(update.body.user.createdAt, first.body.user.createdAt);
    assert.deepEqual((await app.request('/api/me', undefined, second.cookie)).body.user, second.body.user);
    assert.deepEqual((await app.request(`/api/me?userId=${second.body.user.id}`, undefined, first.cookie)).body.user, update.body.user);
    const clear = await app.request('/api/profile', { otherNames: '' }, first.cookie);
    assert.equal(clear.body.user.name, 'Augusta');
    assert.equal((await app.request('/api/login', { email: registration.email, password })).status, 200);
  } finally { await app.close(); }
});

test('changing a profile retains account records and historical certificate/signature names; future certificates use the saved name', async () => {
  const app = await fixture();
  try {
    const registrationResult = await app.request('/api/register', registration);
    await confirmRegistration(app.database, app.request, registrationResult);
    const id = registrationResult.body.user.id;
    const cookie = registrationResult.cookie;
    assert.equal((await app.request('/api/limits', { dailyLoss: 120, maxRisk: 25, maxPositions: 2 }, cookie)).status, 200);
    assert.equal((await app.request('/api/alerts', { symbol: 'BTCUSD', direction: 'above', target: 100000 }, cookie)).status, 200);
    const order = await app.request('/api/trades', { symbol: 'EURUSD', side: 'buy', lots: .01, stopLoss: 1.08 }, cookie);
    assert.equal(order.status, 200);
    assert.equal((await app.request('/api/trades/close', { id: order.body.account.positions[0].id }, cookie)).status, 200);
    const db = new DatabaseSync(app.database);
    let certificate, signed, accountBefore;
    try {
      const state = JSON.parse(db.prepare('SELECT state FROM accounts WHERE user_id=?').get(id).state);
      state.balance = 11000; state.locked = 'Profit target achieved'; state.tradingDays = ['2026-10-09', '2026-10-10', '2026-10-11'];
      certificate = createCertificates(db).issue(id, state);
      db.prepare('UPDATE accounts SET state=? WHERE user_id=?').run(JSON.stringify(state), id);
      const contracts = createContracts(db);
      const published = contracts.publish({ content: Buffer.from('Operator-provided private agreement terms.'), format: 'text', title: 'Trader agreement', version: 'profile-history-v1' });
      signed = contracts.sign(id, { contractId: published.id, contractVersion: published.version, contractHash: published.hash, legalName: 'Ada Lovelace', consent: true });
      accountBefore = db.prepare('SELECT state FROM accounts WHERE user_id=?').get(id).state;
    } finally { db.close(); }
    const profile = await app.request('/api/profile', { firstName: 'Augusta', otherNames: 'Ada King', market: 'I trade forex' }, cookie);
    assert.equal(profile.status, 200);
    const stored = new DatabaseSync(app.database);
    try {
      assert.equal(stored.prepare('SELECT state FROM accounts WHERE user_id=?').get(id).state, accountBefore, 'saving a profile must not touch account state');
      assert.equal(stored.prepare('SELECT holder FROM certificates WHERE id=?').get(certificate.id).holder, 'Ada Lovelace');
      const signature = stored.prepare('SELECT registered_name,legal_name,email FROM contract_signatures WHERE id=?').get(signed.signature.id);
      assert.equal(signature.registered_name, 'Ada Lovelace');
      assert.equal(signature.legal_name, 'Ada Lovelace');
      assert.equal(signature.email, registration.email);
      assert.equal(stored.prepare("SELECT count(*) AS n FROM events WHERE user_id=? AND kind='profile-update'").get(id).n, 1);
      const future = createAccount(); future.balance = 11000; future.locked = 'Profit target achieved'; future.tradingDays = ['2026-10-10', '2026-10-11', '2026-10-12'];
      const earned = createCertificates(stored).issue(id, future);
      assert.equal(earned.holder, 'Augusta Ada King');
      assert.notEqual(earned.id, certificate.id);
    } finally { stored.close(); }
    await app.restart();
    const certificates = (await app.request('/api/certificates', undefined, cookie)).body.certificates;
    assert.equal(certificates.length, 2);
    assert.equal(certificates.find(row => row.id === certificate.id).holder, 'Ada Lovelace');
    const contract = (await app.request('/api/contract', undefined, cookie)).body;
    assert.equal(contract.registeredName, 'Augusta Ada King');
    assert.equal(contract.signature.legalName, 'Ada Lovelace');
    const state = (await app.request('/api/journal', undefined, cookie)).body.account;
    assert.equal(state.history.length, 1); assert.equal(state.alerts.length, 1); assert.equal(state.limits.dailyLoss, 120);
  } finally { await app.close(); }
});

test('profile edits use their own bounded rate limit', async () => {
  const app = await fixture();
  try {
    const owner = await app.request('/api/register', registration);
    for (let index = 0; index < 30; index++) assert.equal((await app.request('/api/profile', { market: 'I trade forex' }, owner.cookie)).status, 200);
    assert.equal((await app.request('/api/profile', { market: 'I trade both' }, owner.cookie)).status, 429);
    assert.equal((await app.request('/api/me', undefined, owner.cookie)).body.user.market, 'I trade forex');
  } finally { await app.close(); }
});

test('new accounts must confirm ownership before every assessment route; confirmation enables access without email notification opt-in', async () => {
  const app = await fixture();
  try {
    assert.deepEqual((await app.request('/api/registration-status')).body, { emailConfirmationAvailable: true });
    const owner = await app.request('/api/register', { ...registration, emailVerified: true, emailConfirmationRequired: false, assessmentAccess: true });
    assert.equal(owner.status, 201);
    assert.equal(owner.body.user.emailConfirmationRequired, true);
    assert.equal(owner.body.user.emailVerified, false);
    assert.equal(owner.body.user.assessmentAccess, false);
    assert.equal(owner.body.confirmation.queued, true);
    assert.equal(owner.body.confirmation.status, 'queued');
    assert.ok(owner.body.confirmation.expiresAt > Date.now());
    assert.ok(!JSON.stringify(owner.body).includes('test-only-not-sent'));
    assert.ok(!('token' in owner.body.confirmation));
    for (const [endpoint, data] of [
      ['/api/account'], ['/api/journal'], ['/api/account-stream?symbol=BTCUSD'], ['/api/market-reference?symbol=BTCUSD'],
      ['/api/trades', { symbol: 'BTCUSD', side: 'buy', lots: .001 }], ['/api/trades/close', { id: 1 }],
      ['/api/trades/protection', { id: 1 }], ['/api/orders', { symbol: 'BTCUSD', side: 'buy', lots: .001, limitPrice: 63000 }],
      ['/api/orders/cancel', { id: 1 }], ['/api/alerts', { symbol: 'BTCUSD', direction: 'above', target: 70000 }],
      ['/api/alerts/remove', { id: 1 }], ['/api/limits', { dailyLoss: 120 }], ['/api/notifications/read', {}],
      ['/api/account/reset', {}], ['/api/certificates'], ['/api/certificate-preferences'],
      ['/api/certificate-preferences', { mode: 'name' }], ['/api/contract'], ['/api/contract/sign', {}],
    ]) {
      const result = await app.request(endpoint, data, owner.cookie);
      assert.equal(result.status, 403, endpoint);
      assert.equal(result.body.code, 'EMAIL_CONFIRMATION_REQUIRED', endpoint);
    }
    assert.equal((await app.request('/api/profile', { otherNames: 'Byron' }, owner.cookie)).status, 200);
    const settings = (await app.request('/api/notification-settings', undefined, owner.cookie)).body;
    assert.equal(settings.emailVerified, false);
    assert.equal(settings.emailEnabled, false);
    assert.equal((await app.request('/api/email/resend-confirmation', {}, owner.cookie)).status, 400, 'resend cooldown prevents duplicate email');
    await app.restart();
    assert.equal((await app.request('/api/me', undefined, owner.cookie)).body.user.assessmentAccess, false);
    assert.equal((await app.request('/api/account', undefined, owner.cookie)).status, 403);
    await confirmRegistration(app.database, app.request, owner);
    const confirmed = (await app.request('/api/me', undefined, owner.cookie)).body.user;
    assert.equal(confirmed.emailVerified, true);
    assert.equal(confirmed.assessmentAccess, true);
    assert.equal(confirmed.emailConfirmationRequired, true);
    assert.equal((await app.request('/api/account', undefined, owner.cookie)).status, 200);
    assert.equal((await app.request('/api/trades', { symbol: 'BTCUSD', side: 'buy', lots: .001 }, owner.cookie)).status, 200);
    const prefs = (await app.request('/api/notification-settings', undefined, owner.cookie)).body;
    assert.equal(prefs.emailVerified, true);
    assert.equal(prefs.emailEnabled, false, 'account ownership confirmation must not opt into trading emails');
    const resend = await app.request('/api/email/resend-confirmation', {}, owner.cookie);
    assert.equal(resend.body.confirmation.status, 'already_confirmed');
    assert.equal(resend.body.confirmation.queued, false);
  } finally { await app.close(); }
});

test('confirmation links expire, can be resent by their owner, are single use, and confirm only the token owner', async () => {
  const app = await fixture();
  try {
    const first = await app.request('/api/register', registration);
    const second = await app.request('/api/register', { ...registration, email: 'second-confirmation@example.com' });
    let expiredToken;
    const db = new DatabaseSync(app.database);
    try {
      const payload = JSON.parse(db.prepare("SELECT payload FROM notification_outbox WHERE user_id=? AND channel='verify'").get(second.body.user.id).payload);
      expiredToken = /#token=([a-f0-9]{64})/.exec(payload.text)[1];
      db.prepare('UPDATE email_verifications SET expires=? WHERE user_id=?').run(Date.now() - 1, second.body.user.id);
    } finally { db.close(); }
    assert.equal((await app.request('/api/email/verify', { token: expiredToken }, first.cookie)).status, 400);
    assert.equal((await app.request('/api/email/resend-confirmation', {})).status, 401);
    assert.equal((await app.request('/api/email/resend-confirmation', {}, second.cookie, { Origin: 'https://attacker.example' })).status, 403);
    const resent = await app.request('/api/email/resend-confirmation', {}, second.cookie);
    assert.equal(resent.status, 200);
    assert.equal(resent.body.confirmation.queued, true);
    let token;
    const freshDb = new DatabaseSync(app.database);
    try {
      const payload = JSON.parse(freshDb.prepare("SELECT payload FROM notification_outbox WHERE user_id=? AND channel='verify' ORDER BY id DESC LIMIT 1").get(second.body.user.id).payload);
      token = /#token=([a-f0-9]{64})/.exec(payload.text)[1];
    } finally { freshDb.close(); }
    assert.notEqual(token, expiredToken);
    const verified = await app.request('/api/email/verify', { token }, first.cookie);
    assert.equal(verified.status, 200);
    assert.ok(!JSON.stringify(verified.body).includes(registration.email));
    assert.equal((await app.request('/api/me', undefined, first.cookie)).body.user.emailVerified, false);
    assert.equal((await app.request('/api/me', undefined, second.cookie)).body.user.emailVerified, true);
    assert.equal((await app.request('/api/email/verify', { token })).status, 400);
    assert.equal((await app.request('/api/email/verify', { token: expiredToken })).status, 400);
  } finally { await app.close(); }
});

test('missing email configuration leaves signup pending with truthful availability and no queued email', async () => {
  const app = await fixture(undefined, { ...testDeliveryOptions, config: {} });
  try {
    assert.deepEqual((await app.request('/api/registration-status')).body, { emailConfirmationAvailable: false });
    const owner = await app.request('/api/register', registration);
    assert.equal(owner.status, 201);
    assert.equal(owner.body.confirmation.available, false);
    assert.equal(owner.body.confirmation.queued, false);
    assert.equal(owner.body.confirmation.status, 'unavailable');
    assert.match(owner.body.confirmation.error, /configured by the operator/);
    assert.equal(owner.body.user.assessmentAccess, false);
    assert.equal((await app.request('/api/email/resend-confirmation', {}, owner.cookie)).status, 400);
    assert.equal((await app.request('/api/account/reset', {}, owner.cookie)).status, 403);
    assert.equal((await app.request('/api/logout', {}, owner.cookie)).status, 200);
    const login = await app.request('/api/login', { email: registration.email, password });
    assert.equal(login.status, 200);
    assert.equal(login.body.user.assessmentAccess, false);
    const db = new DatabaseSync(app.database);
    try { assert.equal(db.prepare("SELECT count(*) AS n FROM notification_outbox WHERE channel='verify'").get().n, 0); }
    finally { db.close(); }
  } finally { await app.close(); }
});
