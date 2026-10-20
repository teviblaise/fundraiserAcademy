import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackend } from '../backend.mjs';
import { nativeScrypt } from '../passwords.mjs';
import { generateTotpCode } from '../two-factor.mjs';
import { createReferenceFixture } from './helpers/reference-fixture.mjs';
import { testDeliveryOptions, confirmRegistration } from './helpers/email-fixture.mjs';

const password = 'a private original security passphrase';
const registration = { firstName: 'Ada', otherNames: 'Lovelace', email: 'ada@example.com', password, market: 'I trade both', consent: true };
const digest = value => createHash('sha256').update(value).digest('hex');
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function fixture(options = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'fa-security-'));
  const database = path.join(folder, 'academy.sqlite');
  let time = Date.now();
  const settings = { marketData: createReferenceFixture({ now: () => time }), deliveryOptions: { ...testDeliveryOptions, now: () => time }, now: () => time, autoTick: false, ...options };
  let backend = createBackend(database, settings);
  const server = http.createServer((req, res) => backend.handle(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const app = {
    origin, database,
    time: () => time,
    advance: milliseconds => { time += milliseconds; },
    inspect(work) { const db = new DatabaseSync(database); try { return work(db); } finally { db.close(); } },
    async request(endpoint, data, cookie, headers = {}) {
      const response = await fetch(origin + endpoint, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy', ...(cookie ? { Cookie: cookie } : {}), ...headers }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0], cache: response.headers.get('cache-control') };
    },
    async register({ email = registration.email, confirmed = true } = {}) {
      const owner = await app.request('/api/register', { ...registration, email });
      assert.equal(owner.status, 201);
      if (confirmed) await confirmRegistration(database, app.request, owner);
      return owner;
    },
    async enroll(cookie) {
      const setup = await app.request('/api/security/2fa/setup', { password }, cookie);
      assert.equal(setup.status, 200);
      const confirmed = await app.request('/api/security/2fa/confirm', { password, code: generateTotpCode(setup.body.secret, { time }) }, cookie);
      assert.equal(confirmed.status, 200);
      return { ...confirmed, secret: setup.body.secret };
    },
    async login(email = registration.email, currentPassword = password, cookie) { return app.request('/api/login', { email, password: currentPassword }, cookie); },
    resetToken() { return app.inspect(db => /#token=([a-f0-9]{64})/.exec(JSON.parse(db.prepare("SELECT payload FROM notification_outbox WHERE channel='password-reset' ORDER BY id DESC LIMIT 1").get()?.payload ?? '{}').text ?? '')?.[1]); },
    async restart() { await backend.close(); backend = createBackend(database, settings); },
    beginClose: () => backend.close(),
    async close() { await new Promise(resolve => server.close(resolve)); await backend.close(); await rm(folder, { recursive: true, force: true }); },
  };
  return app;
}

test('security status is private, enrollment requires email ownership, and setup never exposes its seed on later reads', async () => {
  const app = await fixture();
  try {
    assert.equal((await app.request('/api/security')).status, 401);
    const owner = await app.register({ confirmed: false });
    const status = await app.request('/api/security', undefined, owner.cookie, { 'User-Agent': 'Chrome/123 Windows' });
    assert.equal(status.status, 200);
    assert.equal(status.cache, 'no-store');
    assert.equal(status.body.twoFactor.enabled, false);
    assert.equal(status.body.twoFactor.enrollmentAllowed, false);
    assert.equal(status.body.sessionsTotal, 1);
    assert.equal(status.body.sessions[0].current, true);
    assert.ok(!JSON.stringify(status.body).includes(digest(owner.cookie.slice('fa_session='.length))));
    for (const endpoint of ['/api/security/2fa/setup', '/api/security/2fa/confirm']) {
      const blocked = await app.request(endpoint, { password, code: '123456' }, owner.cookie);
      assert.equal(blocked.status, 403);
      assert.equal(blocked.body.code, 'EMAIL_CONFIRMATION_REQUIRED');
      assert.ok(!Object.hasOwn(blocked.body, 'secret'));
    }
    await confirmRegistration(app.database, app.request, owner);
    assert.equal((await app.request('/api/security', undefined, owner.cookie)).body.twoFactor.enrollmentAllowed, true);
    const setup = await app.request('/api/security/2fa/setup', { password }, owner.cookie);
    assert.equal(setup.status, 200);
    assert.match(setup.body.secret, /^[A-Z2-7]{32}$/);
    assert.match(setup.body.qrDataUrl, /^data:image\/png;base64,/);
    assert.ok(setup.body.otpauthUri.startsWith('otpauth://totp/'));
    const after = await app.request('/api/security', undefined, owner.cookie);
    assert.equal(after.body.twoFactor.enrollmentPending, true);
    assert.ok(!JSON.stringify(after.body).includes(setup.body.secret));
    app.inspect(db => assert.ok(!JSON.stringify(db.prepare('SELECT * FROM two_factor').all()).includes(setup.body.secret)));
    const confirmed = await app.request('/api/security/2fa/confirm', { password, code: generateTotpCode(setup.body.secret, { time: app.time() }) }, owner.cookie);
    assert.equal(confirmed.status, 200);
    assert.notEqual(confirmed.cookie, owner.cookie);
    assert.equal(confirmed.body.recoveryCodes.length, 10);
    assert.equal((await app.request('/api/me', undefined, owner.cookie)).status, 401);
    const profile = await app.request('/api/me', undefined, confirmed.cookie);
    assert.equal(profile.body.user.assessmentAccess, true);
    const final = await app.request('/api/security', undefined, confirmed.cookie);
    assert.equal(final.body.twoFactor.enabled, true);
    assert.equal(final.body.twoFactor.recoveryCodesRemaining, 10);
    assert.ok(!JSON.stringify(final).includes(confirmed.body.recoveryCodes[0]));
    app.inspect(db => {
      const rows = JSON.stringify(db.prepare('SELECT * FROM two_factor_recovery_codes').all());
      assert.ok(!rows.includes(confirmed.body.recoveryCodes[0].replaceAll('-', '')));
      assert.equal(db.prepare("SELECT count(*) n FROM notification_outbox WHERE channel='security'").get().n, 1);
    });
  } finally { await app.close(); }
});

test('password verification only issues a challenge; completion, replay, cancellation, and expiry enforce the second factor', async () => {
  const app = await fixture();
  try {
    const owner = await app.register();
    const factor = await app.enroll(owner.cookie);
    const challenge = await app.login();
    assert.equal(challenge.status, 202);
    assert.equal(challenge.body.twoFactorRequired, true);
    assert.equal(challenge.cookie, 'fa_session=');
    assert.ok(!Object.hasOwn(challenge.body, 'user'));
    assert.equal((await app.request('/api/me')).status, 401);
    assert.equal((await app.request('/api/login/2fa', { challenge: challenge.body.challenge, code: generateTotpCode(factor.secret, { time: app.time() }) })).status, 400, 'the enrollment TOTP was already consumed');
    app.advance(30000);
    const completed = await app.request('/api/login/2fa', { challenge: challenge.body.challenge, code: generateTotpCode(factor.secret, { time: app.time() }) });
    assert.equal(completed.status, 200);
    assert.equal(completed.body.user.email, registration.email);
    assert.equal((await app.request('/api/me', undefined, completed.cookie)).status, 200);
    assert.equal((await app.request('/api/login/2fa', { challenge: challenge.body.challenge, code: factor.body.recoveryCodes[0] })).body.code, 'TWO_FACTOR_CHALLENGE_INVALID');
    const canceled = await app.login();
    assert.equal((await app.request('/api/login/2fa/cancel', { challenge: canceled.body.challenge })).status, 200);
    assert.equal((await app.request('/api/login/2fa', { challenge: canceled.body.challenge, code: factor.body.recoveryCodes[0] })).body.code, 'TWO_FACTOR_CHALLENGE_INVALID');
    const expiring = await app.login();
    app.advance(5 * 60000);
    assert.equal((await app.request('/api/login/2fa', { challenge: expiring.body.challenge, code: factor.body.recoveryCodes[0] })).body.code, 'TWO_FACTOR_CHALLENGE_INVALID');
  } finally { await app.close(); }
});

test('a different account cookie cannot remain authenticated behind a two-factor sign-in challenge', async () => {
  const app = await fixture();
  try {
    const owner = await app.register();
    const factor = await app.enroll(owner.cookie);
    const other = await app.register({ email: 'grace@example.com' });
    const wrong = await app.login(registration.email, 'an incorrect but lengthy password', other.cookie);
    assert.equal(wrong.status, 401);
    assert.equal((await app.request('/api/me', undefined, other.cookie)).status, 200);
    const challenge = await app.login(registration.email, password, other.cookie);
    assert.equal(challenge.status, 202);
    assert.equal(challenge.cookie, 'fa_session=');
    assert.equal((await app.request('/api/me', undefined, other.cookie)).status, 401);
    const logged = await app.request('/api/login/2fa', { challenge: challenge.body.challenge, code: factor.body.recoveryCodes[0] }, other.cookie);
    assert.equal(logged.status, 200);
    assert.equal(logged.body.user.id, owner.body.user.id);
  } finally { await app.close(); }
});

test('recovery codes are single-use across competing sign-in requests and survive an application restart', async () => {
  const app = await fixture();
  try {
    const owner = await app.register();
    const factor = await app.enroll(owner.cookie);
    await app.restart();
    const [one, two] = await Promise.all([app.login(), app.login()]);
    const completions = await Promise.all([one, two].map(result => app.request('/api/login/2fa', { challenge: result.body.challenge, code: factor.body.recoveryCodes[0] })));
    assert.deepEqual(completions.map(result => result.status).sort(), [200, 400]);
    const challenge = await app.login();
    const replay = await app.request('/api/login/2fa', { challenge: challenge.body.challenge, code: factor.body.recoveryCodes[0] });
    assert.equal(replay.body.code, 'TWO_FACTOR_INVALID');
    const success = completions.find(result => result.status === 200);
    const security = await app.request('/api/security', undefined, success.cookie);
    assert.equal(security.body.twoFactor.recoveryCodesRemaining, 9);
  } finally { await app.close(); }
});

test('session revocation requires fresh password plus factor, binds opaque IDs to the owner, and rolls back a failed target', async () => {
  const app = await fixture();
  try {
    const owner = await app.register();
    const factor = await app.enroll(owner.cookie);
    const challenge = await app.login();
    const second = await app.request('/api/login/2fa', { challenge: challenge.body.challenge, code: factor.body.recoveryCodes[0] });
    const other = await app.register({ email: 'grace@example.com' });
    const foreign = (await app.request('/api/security', undefined, other.cookie)).body.sessions[0];
    const own = (await app.request('/api/security', undefined, factor.cookie)).body.sessions.find(item => !item.current);
    const missingPassword = await app.request('/api/security/sessions/revoke', { sessionId: own.id, code: factor.body.recoveryCodes[1] }, factor.cookie);
    assert.equal(missingPassword.status, 401);
    const missingFactor = await app.request('/api/security/sessions/revoke', { sessionId: own.id, password }, factor.cookie);
    assert.equal(missingFactor.body.code, 'TWO_FACTOR_INVALID');
    const forbidden = await app.request('/api/security/sessions/revoke', { sessionId: foreign.id, password, code: factor.body.recoveryCodes[1] }, factor.cookie);
    assert.equal(forbidden.status, 404);
    assert.equal((await app.request('/api/me', undefined, other.cookie)).status, 200);
    const revoked = await app.request('/api/security/sessions/revoke', { sessionId: own.id, password, code: factor.body.recoveryCodes[1] }, factor.cookie);
    assert.equal(revoked.status, 200, 'a rejected foreign target must not consume the recovery code');
    assert.equal(revoked.body.signedOut, false);
    assert.equal((await app.request('/api/me', undefined, second.cookie)).status, 401);
    assert.equal((await app.request('/api/me', undefined, factor.cookie)).status, 200);
    const current = revoked.body.security.sessions.find(item => item.current);
    const self = await app.request('/api/security/sessions/revoke', { sessionId: current.id, password, code: factor.body.recoveryCodes[2] }, factor.cookie);
    assert.equal(self.body.signedOut, true);
    assert.equal(self.cookie, 'fa_session=');
    assert.equal(self.body.security, null);
    assert.equal((await app.request('/api/me', undefined, factor.cookie)).status, 401);
  } finally { await app.close(); }
});

test('revoke-other-devices rotates the retained cookie, invalidates pending challenges, and revoke-all signs out the current browser', async () => {
  const app = await fixture();
  try {
    const owner = await app.register();
    const factor = await app.enroll(owner.cookie);
    const firstChallenge = await app.login();
    const second = await app.request('/api/login/2fa', { challenge: firstChallenge.body.challenge, code: factor.body.recoveryCodes[0] });
    const pending = await app.login();
    const revoked = await app.request('/api/security/sessions/revoke-others', { password, code: factor.body.recoveryCodes[1] }, factor.cookie);
    assert.equal(revoked.status, 200);
    assert.notEqual(revoked.cookie, factor.cookie);
    assert.equal(revoked.body.security.sessionsTotal, 1);
    for (const cookie of [factor.cookie, second.cookie]) assert.equal((await app.request('/api/me', undefined, cookie)).status, 401);
    assert.equal((await app.request('/api/me', undefined, revoked.cookie)).status, 200);
    assert.equal((await app.request('/api/login/2fa', { challenge: pending.body.challenge, code: factor.body.recoveryCodes[2] })).body.code, 'TWO_FACTOR_CHALLENGE_INVALID');
    const all = await app.request('/api/security/sessions/revoke-all', { password, code: factor.body.recoveryCodes[2] }, revoked.cookie);
    assert.equal(all.status, 200);
    assert.equal(all.body.signedOut, true);
    assert.equal((await app.request('/api/me', undefined, revoked.cookie)).status, 401);
    app.inspect(db => assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(owner.body.user.id).n, 0));
  } finally { await app.close(); }
});

test('rotating recovery codes invalidates the old set, and disabling two-factor restores password-only sign-in', async () => {
  const app = await fixture();
  try {
    const owner = await app.register();
    const factor = await app.enroll(owner.cookie);
    const rotated = await app.request('/api/security/2fa/recovery-codes', { password, code: factor.body.recoveryCodes[0] }, factor.cookie);
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.recoveryCodes.length, 10);
    assert.ok(!rotated.body.recoveryCodes.includes(factor.body.recoveryCodes[1]));
    const challenge = await app.login();
    assert.equal((await app.request('/api/login/2fa', { challenge: challenge.body.challenge, code: factor.body.recoveryCodes[1] })).body.code, 'TWO_FACTOR_INVALID');
    const disabled = await app.request('/api/security/2fa/disable', { password, code: rotated.body.recoveryCodes[0] }, rotated.cookie);
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.security.twoFactor.enabled, false);
    assert.equal(disabled.body.security.twoFactor.recoveryCodesRemaining, 0);
    assert.equal((await app.request('/api/login/2fa', { challenge: challenge.body.challenge, code: rotated.body.recoveryCodes[1] })).body.code, 'TWO_FACTOR_CHALLENGE_INVALID');
    assert.equal((await app.login()).status, 200);
  } finally { await app.close(); }
});

test('password recovery signs out every session but preserves the enabled factor and unused recovery codes', async () => {
  const app = await fixture();
  try {
    const owner = await app.register();
    const factor = await app.enroll(owner.cookie);
    const pending = await app.login();
    await app.request('/api/password/forgot', { email: registration.email });
    const reset = await app.request('/api/password/reset', { token: app.resetToken(), password: 'a fresh private replacement passphrase' });
    assert.equal(reset.status, 200);
    assert.equal((await app.request('/api/me', undefined, factor.cookie)).status, 401);
    assert.equal((await app.request('/api/login/2fa', { challenge: pending.body.challenge, code: factor.body.recoveryCodes[0] })).body.code, 'TWO_FACTOR_CHALLENGE_INVALID');
    const login = await app.login(registration.email, 'a fresh private replacement passphrase');
    assert.equal(login.status, 202);
    const completed = await app.request('/api/login/2fa', { challenge: login.body.challenge, code: factor.body.recoveryCodes[0] });
    assert.equal(completed.status, 200);
    const status = (await app.request('/api/security', undefined, completed.cookie)).body;
    assert.equal(status.twoFactor.enabled, true);
    assert.equal(status.twoFactor.recoveryCodesRemaining, 9);
  } finally { await app.close(); }
});

test('an in-flight password-only login cannot bypass enrollment completed during the password KDF', async () => {
  const held = deferred(), started = deferred();
  let gateNext = false;
  const app = await fixture({ async passwordScrypt(...args) { if (gateNext) { gateNext = false; started.resolve(); await held.promise; } return nativeScrypt(...args); } });
  try {
    const owner = await app.register();
    const setup = await app.request('/api/security/2fa/setup', { password }, owner.cookie);
    gateNext = true;
    const loginPromise = app.login();
    await started.promise;
    const confirmed = await app.request('/api/security/2fa/confirm', { password, code: generateTotpCode(setup.body.secret, { time: app.time() }) }, owner.cookie);
    assert.equal(confirmed.status, 200);
    held.resolve();
    const login = await loginPromise;
    assert.equal(login.status, 409);
    assert.equal(login.body.code, 'SECURITY_STATE_CHANGED');
    assert.equal(login.cookie, undefined);
    app.inspect(db => assert.equal(db.prepare('SELECT count(*) n FROM sessions WHERE user_id=?').get(owner.body.user.id).n, 1));
  } finally { held.resolve(); await app.close(); }
});

test('revoke-all blocks an in-flight password login even when its password remains correct', async () => {
  const held = deferred(), started = deferred();
  let gateNext = false;
  const app = await fixture({ async passwordScrypt(...args) { if (gateNext) { gateNext = false; started.resolve(); await held.promise; } return nativeScrypt(...args); } });
  try {
    const owner = await app.register();
    gateNext = true;
    const loginPromise = app.login();
    await started.promise;
    const revoked = await app.request('/api/security/sessions/revoke-all', { password }, owner.cookie);
    assert.equal(revoked.status, 200);
    held.resolve();
    const login = await loginPromise;
    assert.equal(login.status, 409);
    assert.equal(login.cookie, undefined);
    const next = await app.login();
    const setup = await app.request('/api/security/2fa/setup', { password }, next.cookie);
    assert.equal(setup.status, 200);
  } finally { held.resolve(); await app.close(); }
});

test('a session revoked during password reauthentication cannot enable a factor or consume a recovery code', async () => {
  let held = deferred(), started = deferred(), gateNext = false;
  const app = await fixture({ async passwordScrypt(...args) { if (gateNext) { gateNext = false; started.resolve(); await held.promise; } return nativeScrypt(...args); } });
  try {
    const owner = await app.register();
    const setup = await app.request('/api/security/2fa/setup', { password }, owner.cookie);
    gateNext = true;
    const confirmation = app.request('/api/security/2fa/confirm', { password, code: generateTotpCode(setup.body.secret, { time: app.time() }) }, owner.cookie);
    await started.promise;
    assert.equal((await app.request('/api/logout', {}, owner.cookie)).status, 200);
    held.resolve();
    assert.equal((await confirmation).status, 401);
    const login = await app.login();
    assert.equal(login.status, 200, 'the interrupted enrollment must remain disabled');
    const factor = await app.enroll(login.cookie);
    held = deferred(); started = deferred(); gateNext = true;
    const disabling = app.request('/api/security/2fa/disable', { password, code: factor.body.recoveryCodes[0] }, factor.cookie);
    await started.promise;
    assert.equal((await app.request('/api/logout', {}, factor.cookie)).status, 200);
    held.resolve();
    assert.equal((await disabling).status, 401);
    const challenge = await app.login();
    assert.equal(challenge.status, 202);
    assert.equal((await app.request('/api/login/2fa', { challenge: challenge.body.challenge, code: factor.body.recoveryCodes[0] })).status, 200, 'the interrupted disable must not spend its proof');
  } finally { held.resolve(); await app.close(); }
});

test('revoking a session while its trade awaits a quote prevents the requested fill', async () => {
  const started = deferred(), held = deferred();
  let hold = false;
  const reference = createReferenceFixture();
  const app = await fixture({ marketData: { ...reference, async getExecutionQuote(symbol) { if (hold) { hold = false; started.resolve(); await held.promise; } return reference.getExecutionQuote(symbol); } } });
  try {
    const owner = await app.register();
    const other = await app.login();
    const sessions = (await app.request('/api/security', undefined, other.cookie)).body.sessions;
    const target = sessions.find(item => !item.current);
    hold = true;
    const trade = app.request('/api/trades', { symbol: 'EURUSD', side: 'buy', lots: 0.01 }, owner.cookie);
    await started.promise;
    const revoke = await app.request('/api/security/sessions/revoke', { sessionId: target.id, password }, other.cookie);
    assert.equal(revoke.status, 200);
    held.resolve();
    assert.equal((await trade).status, 401);
    app.inspect(db => {
      const account = JSON.parse(db.prepare('SELECT state FROM accounts WHERE user_id=?').get(owner.body.user.id).state);
      assert.equal(account.positions.length, 0);
      assert.equal(db.prepare("SELECT count(*) n FROM events WHERE kind='trade-open'").get().n, 0);
    });
  } finally { held.resolve(); await app.close(); }
});

test('all factor and session mutations reject foreign origins before consuming credentials or factors', async () => {
  const app = await fixture();
  try {
    const owner = await app.register();
    const factor = await app.enroll(owner.cookie);
    const status = await app.request('/api/security', undefined, factor.cookie);
    const headers = { Origin: 'https://attacker.example' };
    assert.equal((await app.request('/api/security', undefined, factor.cookie, headers)).status, 403);
    for (const endpoint of ['/api/security/2fa/setup', '/api/security/2fa/confirm', '/api/security/2fa/cancel', '/api/security/2fa/disable', '/api/security/2fa/recovery-codes', '/api/security/sessions/revoke', '/api/security/sessions/revoke-others', '/api/security/sessions/revoke-all']) {
      assert.equal((await app.request(endpoint, { password, code: factor.body.recoveryCodes[0], sessionId: status.body.sessions[0].id }, factor.cookie, headers)).status, 403);
    }
    const challenge = await app.login();
    assert.equal((await app.request('/api/login/2fa', { challenge: challenge.body.challenge, code: factor.body.recoveryCodes[0] }, undefined, headers)).status, 403);
    assert.equal((await app.request('/api/login/2fa/cancel', { challenge: challenge.body.challenge }, undefined, headers)).status, 403);
    assert.equal((await app.request('/api/login/2fa', { challenge: challenge.body.challenge, code: factor.body.recoveryCodes[0] })).status, 200);
  } finally { await app.close(); }
});

test('factor security changes immediately close revoked SSE streams', async () => {
  const app = await fixture({ streamTickMs: 10000 });
  try {
    const owner = await app.register();
    const setup = await app.request('/api/security/2fa/setup', { password }, owner.cookie);
    const response = await fetch(app.origin + '/api/account-stream?symbol=EURUSD', { headers: { Cookie: owner.cookie }, signal: AbortSignal.timeout(10000) });
    assert.equal(response.status, 200);
    const body = response.text();
    const confirmed = await app.request('/api/security/2fa/confirm', { password, code: generateTotpCode(setup.body.secret, { time: app.time() }) }, owner.cookie);
    assert.equal(confirmed.status, 200);
    assert.match(await body, /event: auth-expired/);
  } finally { await app.close(); }
});

test('a session revoked while its local QR is generated cannot receive an enrollment key', async () => {
  const held = deferred(), started = deferred();
  const app = await fixture({ async qrEncoder() { started.resolve(); await held.promise; return 'data:image/png;base64,AA=='; } });
  try {
    const owner = await app.register();
    const setup = app.request('/api/security/2fa/setup', { password }, owner.cookie);
    await started.promise;
    assert.equal((await app.request('/api/logout', {}, owner.cookie)).status, 200);
    held.resolve();
    const response = await setup;
    assert.equal(response.status, 401);
    assert.ok(!Object.hasOwn(response.body, 'secret'));
    assert.ok(!Object.hasOwn(response.body, 'qrDataUrl'));
  } finally { held.resolve(); await app.close(); }
});

test('shutdown waits for local QR generation and returns a safe retry without using a closed database', async () => {
  const held = deferred(), started = deferred();
  const app = await fixture({ async qrEncoder() { started.resolve(); await held.promise; return 'data:image/png;base64,AA=='; } });
  try {
    const owner = await app.register();
    const setup = app.request('/api/security/2fa/setup', { password }, owner.cookie);
    await started.promise;
    let closed = false;
    const closing = app.beginClose().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    held.resolve();
    const response = await setup;
    assert.equal(response.status, 503);
    assert.ok(!Object.hasOwn(response.body, 'secret'));
    await closing;
  } finally { held.resolve(); await app.close(); }
});

test('pre-registering someone else’s email cannot bind an attacker’s factor before the mailbox owner resets the password', async () => {
  const app = await fixture();
  try {
    const preRegistered = await app.register({ confirmed: false });
    assert.equal((await app.request('/api/security/2fa/setup', { password }, preRegistered.cookie)).status, 403);
    assert.equal((await app.request('/api/security/2fa/confirm', { password, code: '123456' }, preRegistered.cookie)).status, 403);
    await app.request('/api/password/forgot', { email: registration.email });
    const ownerPassword = 'a mailbox owner’s private replacement passphrase';
    assert.equal((await app.request('/api/password/reset', { token: app.resetToken(), password: ownerPassword })).status, 200);
    assert.equal((await app.request('/api/me', undefined, preRegistered.cookie)).status, 401);
    assert.equal((await app.login()).status, 401);
    const legitimate = await app.login(registration.email, ownerPassword);
    assert.equal(legitimate.status, 200, 'no attacker-created factor may survive to lock out the mailbox owner');
    const state = await app.request('/api/security', undefined, legitimate.cookie);
    assert.equal(state.body.twoFactor.enabled, false);
    assert.equal(state.body.twoFactor.enrollmentPending, false);
    assert.equal(state.body.twoFactor.enrollmentAllowed, false, 'password recovery does not silently change verification preference');
  } finally { await app.close(); }
});

test('grandfathered assessment access does not waive email ownership for authenticator enrollment', async () => {
  const app = await fixture();
  try {
    const owner = await app.register({ confirmed: false });
    app.inspect(db => db.prepare('UPDATE users SET email_confirmation_required=0 WHERE id=?').run(owner.body.user.id));
    const profile = await app.request('/api/me', undefined, owner.cookie);
    assert.equal(profile.body.user.assessmentAccess, true);
    assert.equal(profile.body.user.emailVerified, false);
    assert.equal((await app.request('/api/security/2fa/setup', { password }, owner.cookie)).body.code, 'EMAIL_CONFIRMATION_REQUIRED');
    assert.equal((await app.request('/api/security/2fa/confirm', { password, code: '123456' }, owner.cookie)).body.code, 'EMAIL_CONFIRMATION_REQUIRED');
    assert.equal((await app.request('/api/security/sessions/revoke-all', { password }, owner.cookie)).status, 200, 'unverified clients can still secure existing sessions');
  } finally { await app.close(); }
});

test('enrollment rechecks mailbox ownership after both password hashing and asynchronous QR generation', async () => {
  const qrHeld = deferred(), qrStarted = deferred(), passwordHeld = deferred(), passwordStarted = deferred();
  let gateQr = true, gatePassword = false;
  const app = await fixture({
    async qrEncoder() { if (gateQr) { gateQr = false; qrStarted.resolve(); await qrHeld.promise; } return 'data:image/png;base64,AA=='; },
    async passwordScrypt(...args) { if (gatePassword) { gatePassword = false; passwordStarted.resolve(); await passwordHeld.promise; } return nativeScrypt(...args); },
  });
  try {
    const owner = await app.register();
    const verification = value => app.inspect(db => db.prepare('UPDATE notification_preferences SET verified=? WHERE user_id=?').run(value, owner.body.user.id));
    const setup = app.request('/api/security/2fa/setup', { password }, owner.cookie);
    await qrStarted.promise;
    verification(0);
    qrHeld.resolve();
    const refusedQr = await setup;
    assert.equal(refusedQr.status, 403);
    assert.equal(refusedQr.body.code, 'EMAIL_CONFIRMATION_REQUIRED');
    assert.ok(!Object.hasOwn(refusedQr.body, 'secret'));
    verification(1);
    const nextSetup = await app.request('/api/security/2fa/setup', { password }, owner.cookie);
    assert.equal(nextSetup.status, 200);
    gatePassword = true;
    const confirm = app.request('/api/security/2fa/confirm', { password, code: generateTotpCode(nextSetup.body.secret, { time: app.time() }) }, owner.cookie);
    await passwordStarted.promise;
    verification(0);
    passwordHeld.resolve();
    assert.equal((await confirm).body.code, 'EMAIL_CONFIRMATION_REQUIRED');
    app.inspect(db => assert.equal(db.prepare('SELECT secret FROM two_factor WHERE user_id=?').get(owner.body.user.id).secret, null));
  } finally { qrHeld.resolve(); passwordHeld.resolve(); await app.close(); }
});

test('existing enabled factors remain recoverable if an older account lacks email verification metadata', async () => {
  const app = await fixture();
  try {
    const owner = await app.register();
    const factor = await app.enroll(owner.cookie);
    app.inspect(db => db.prepare('UPDATE notification_preferences SET verified=0 WHERE user_id=?').run(owner.body.user.id));
    const rotated = await app.request('/api/security/2fa/recovery-codes', { password, code: factor.body.recoveryCodes[0] }, factor.cookie);
    assert.equal(rotated.status, 200);
    assert.equal(rotated.body.security.twoFactor.enrollmentAllowed, false);
    const disabled = await app.request('/api/security/2fa/disable', { password, code: rotated.body.recoveryCodes[0] }, rotated.cookie);
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.security.twoFactor.enabled, false);
    assert.equal((await app.request('/api/security/2fa/setup', { password }, disabled.cookie)).body.code, 'EMAIL_CONFIRMATION_REQUIRED');
  } finally { await app.close(); }
});
