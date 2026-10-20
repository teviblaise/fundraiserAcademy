import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackend } from '../backend.mjs';
import { generateTotpCode } from '../two-factor.mjs';
import { createReferenceFixture } from './helpers/reference-fixture.mjs';
import { testDeliveryOptions, confirmRegistration } from './helpers/email-fixture.mjs';

const password = 'a private administrator testing passphrase';
const reason = 'Reviewed the account through the authorized staff workflow.';
const digest = value => createHash('sha256').update(value).digest('hex');

async function fixture() {
  const folder = await mkdtemp(path.join(tmpdir(), 'fa-admin-http-'));
  const database = path.join(folder, 'academy.sqlite');
  let time = Date.now();
  const backend = createBackend(database, {
    now: () => time, autoTick: false, adminOptions: { ownerEmails: 'owner@example.com' },
    marketData: createReferenceFixture({ now: () => time }),
    deliveryOptions: { ...testDeliveryOptions, now: () => time },
    supportOptions: { staffEmails: '', aiOptions: { apiKey: '' } },
  });
  const server = http.createServer((req, res) => backend.handle(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const app = {
    database, origin, time: () => time, advance: duration => { time += duration; },
    inspect(work) { const db = new DatabaseSync(database); try { return work(db); } finally { db.close(); } },
    async request(endpoint, data, cookie, headers = {}) {
      const response = await fetch(origin + endpoint, {
        method: data === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy', ...(cookie ? { Cookie: cookie } : {}), ...headers },
        ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      });
      const body = response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text();
      return { status: response.status, body, cookie: response.headers.get('set-cookie')?.split(';')[0], headers: response.headers };
    },
    async register(email, { confirmed = true, factor = false, extra = {} } = {}) {
      const registration = await app.request('/api/register', { firstName: 'Ada', otherNames: 'Lovelace', email, password, market: 'I trade both', consent: true, ...extra });
      assert.equal(registration.status, 201, JSON.stringify(registration.body));
      if (confirmed) await confirmRegistration(database, app.request, registration);
      const actor = { email, id: registration.body.user.id, cookie: registration.cookie, recoveryCodes: [] };
      if (factor) await app.enroll(actor);
      return actor;
    },
    async enroll(actor) {
      const setup = await app.request('/api/security/2fa/setup', { password }, actor.cookie);
      assert.equal(setup.status, 200, JSON.stringify(setup.body));
      const confirmed = await app.request('/api/security/2fa/confirm', { password, code: generateTotpCode(setup.body.secret, { time }) }, actor.cookie);
      assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));
      Object.assign(actor, { cookie: confirmed.cookie, secret: setup.body.secret, recoveryCodes: [...confirmed.body.recoveryCodes] });
      return actor;
    },
    async unlock(actor) {
      time += 31000;
      const result = await app.request('/api/admin/reauth', { password, code: generateTotpCode(actor.secret, { time }) }, actor.cookie);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result;
    },
    async login(actor) {
      const result = await app.request('/api/login', { email: actor.email, password });
      if (result.status !== 202) return result;
      return app.request('/api/login/2fa', { challenge: result.body.challenge, code: actor.recoveryCodes.shift() });
    },
    async close() { await new Promise(resolve => server.close(resolve)); await backend.close(); await rm(folder, { recursive: true, force: true }); },
  };
  return app;
}

test('admin HTTP access requires an explicit role, confirmed email, and enrolled authenticator', async () => {
  const app = await fixture();
  try {
    for (const endpoint of ['/api/admin/access', '/api/admin/overview', '/api/sponsorship']) assert.equal((await app.request(endpoint)).status, 401);
    const owner = await app.register('owner@example.com', { confirmed: false });
    let access = await app.request('/api/admin/access', undefined, owner.cookie);
    assert.equal(access.body.role, 'owner');
    assert.equal(access.body.authorized, false);
    assert.deepEqual(access.body.permissions, []);
    assert.equal((await app.request('/api/admin/overview', undefined, owner.cookie)).status, 403);
    assert.equal((await app.request('/api/admin/reauth', { password, code: '123456' }, owner.cookie)).status, 403);
    // Use the normal email-confirmation mechanism, never an admin verification bypass.
    await confirmRegistration(app.database, app.request, { status: 201, body: { user: { id: owner.id } } });
    access = await app.request('/api/admin/access', undefined, owner.cookie);
    assert.equal(access.body.emailVerified, true);
    assert.equal(access.body.twoFactorEnabled, false);
    assert.equal(access.body.authorized, false);
    await app.enroll(owner);
    access = await app.request('/api/admin/access', undefined, owner.cookie);
    assert.equal(access.status, 200);
    assert.equal(access.body.authorized, true);
    assert.equal(access.body.environmentManaged, true);
    assert.equal(access.body.privilegesExpiresAt, null);
    assert.equal((await app.request('/api/admin/overview', undefined, owner.cookie)).status, 200);
    const ordinary = await app.register('ordinary@example.com', { factor: true, extra: { role: 'owner', admin: true } });
    assert.equal((await app.request('/api/admin/access', undefined, ordinary.cookie)).body.role, null);
    for (const endpoint of ['/api/admin/overview', '/api/admin/traders', '/api/admin/system', '/api/admin/staff', '/api/admin/audit', '/api/admin/accounts']) {
      assert.equal((await app.request(endpoint, undefined, ordinary.cookie)).status, 403, endpoint);
    }
  } finally { await app.close(); }
});

test('sensitive writes and report exports require a fresh factor, expire after five minutes, and never return proof material', async () => {
  const app = await fixture();
  try {
    const owner = await app.register('owner@example.com', { factor: true });
    const ordinary = await app.register('ordinary@example.com');
    const action = `/api/admin/traders/${ordinary.id}/notes`;
    const blocked = await app.request(action, { text: 'An internal reviewer note.', reason }, owner.cookie);
    assert.equal(blocked.status, 403);
    assert.equal(blocked.body.code, 'ADMIN_REAUTH_REQUIRED');
    const initialReport = await app.request('/api/admin/reports?type=traders', undefined, owner.cookie);
    assert.equal(initialReport.body.code, 'ADMIN_REAUTH_REQUIRED');
    const reused = await app.request('/api/admin/reauth', { password, code: generateTotpCode(owner.secret, { time: app.time() }) }, owner.cookie);
    assert.equal(reused.status, 400, 'the authenticator enrollment code was already consumed');
    const wrong = await app.request('/api/admin/reauth', { password: 'an incorrect administrator password', code: owner.recoveryCodes[0] }, owner.cookie);
    assert.equal(wrong.status, 401);
    assert.equal((await app.request('/api/admin/access', undefined, owner.cookie)).body.privilegesExpiresAt, null);
    const proof = await app.unlock(owner);
    assert.deepEqual(Object.keys(proof.body).sort(), ['expiresAt', 'privilegesExpiresAt']);
    assert.equal(proof.body.expiresAt, app.time() + 300000);
    assert.equal(proof.headers.get('cache-control'), 'no-store');
    assert.equal((await app.request(action, { text: 'An internal reviewer note.', reason }, owner.cookie)).status, 200);
    const exported = await app.request('/api/admin/reports?type=traders', undefined, owner.cookie);
    assert.equal(exported.status, 200);
    assert.match(exported.body.csv, /ordinary@example.com/);
    assert.ok(!JSON.stringify(exported.body).includes(password));
    assert.ok(!JSON.stringify(exported.body).includes(owner.secret));
    app.inspect(db => {
      const grant = db.prepare('SELECT * FROM admin_step_up').get();
      assert.equal(grant.user_id, owner.id);
      assert.equal(grant.token, digest(owner.cookie.slice('fa_session='.length)));
      assert.match(grant.fingerprint, /^[a-f0-9]{64}$/);
      assert.ok(!JSON.stringify(grant).includes(password));
      assert.ok(!JSON.stringify(grant).includes(owner.secret));
      assert.equal(db.prepare("SELECT count(*) n FROM admin_audit WHERE action='report.exported'").get().n, 1);
    });
    app.advance(300000);
    assert.equal((await app.request(action, { text: 'Expired proof cannot append this.', reason }, owner.cookie)).body.code, 'ADMIN_REAUTH_REQUIRED');
    assert.equal((await app.request('/api/admin/reports?type=traders', undefined, owner.cookie)).body.code, 'ADMIN_REAUTH_REQUIRED');
    assert.equal((await app.request('/api/admin/overview', undefined, owner.cookie)).status, 200, 'normal authorized reads remain available');
    assert.equal((await app.request('/api/admin/access', undefined, owner.cookie)).body.privilegesExpiresAt, null);
    assert.equal(app.inspect(db => db.prepare('SELECT count(*) n FROM admin_step_up').get().n), 0);
  } finally { await app.close(); }
});

test('privileged admin proof is bound to one session and is revoked by account security rotation', async () => {
  const app = await fixture();
  try {
    const owner = await app.register('owner@example.com', { factor: true });
    await app.unlock(owner);
    const second = await app.login(owner);
    assert.equal(second.status, 200);
    assert.notEqual(second.cookie, owner.cookie);
    assert.equal((await app.request('/api/admin/reports', undefined, second.cookie)).body.code, 'ADMIN_REAUTH_REQUIRED');
    assert.equal((await app.request('/api/admin/reports', undefined, owner.cookie)).status, 200);
    const rotated = await app.request('/api/security/sessions/revoke-others', { password, code: owner.recoveryCodes.shift() }, owner.cookie);
    assert.equal(rotated.status, 200);
    assert.notEqual(rotated.cookie, owner.cookie);
    assert.equal((await app.request('/api/admin/overview', undefined, owner.cookie)).status, 401);
    assert.equal((await app.request('/api/admin/overview', undefined, second.cookie)).status, 401);
    assert.equal((await app.request('/api/admin/overview', undefined, rotated.cookie)).status, 200);
    assert.equal((await app.request('/api/admin/reports', undefined, rotated.cookie)).body.code, 'ADMIN_REAUTH_REQUIRED');
  } finally { await app.close(); }
});

test('suspension revokes every session and pending sign-in challenge, blocks login, and restoration requires new sign-in', async () => {
  const app = await fixture();
  try {
    const owner = await app.register('owner@example.com', { factor: true });
    const trader = await app.register('trader@example.com', { factor: true });
    const second = await app.login(trader);
    assert.equal(second.status, 200);
    const pending = await app.request('/api/login', { email: trader.email, password });
    assert.equal(pending.status, 202);
    await app.unlock(owner);
    const target = `/api/admin/traders/${trader.id}/status`;
    assert.equal((await app.request(target, { status: 'suspended', reason: '' }, owner.cookie)).status, 400);
    assert.equal((await app.request('/api/me', undefined, trader.cookie)).status, 200, 'validation errors do not partially suspend the trader');
    const suspended = await app.request(target, { status: 'suspended', reason }, owner.cookie);
    assert.equal(suspended.status, 200, JSON.stringify(suspended.body));
    assert.equal(suspended.body.sessionsRevoked, 2);
    for (const cookie of [trader.cookie, second.cookie]) assert.equal((await app.request('/api/me', undefined, cookie)).status, 401);
    assert.equal((await app.request('/api/login', { email: trader.email, password })).body.code, 'ACCOUNT_SUSPENDED');
    const abandoned = await app.request('/api/login/2fa', { challenge: pending.body.challenge, code: trader.recoveryCodes.shift() });
    assert.ok([400, 401].includes(abandoned.status));
    assert.equal((await app.request(`/api/admin/traders/${owner.id}/status`, { status: 'suspended', reason }, owner.cookie)).status, 409);
    assert.equal((await app.request(target, { status: 'active', reason }, owner.cookie)).status, 200);
    assert.equal((await app.request('/api/me', undefined, trader.cookie)).status, 401, 'restoration never resurrects revoked cookies');
    const restored = await app.login(trader);
    assert.equal(restored.status, 200);
    assert.equal((await app.request('/api/me', undefined, restored.cookie)).status, 200);
    const revoked = await app.request(`/api/admin/traders/${trader.id}/revoke-sessions`, { reason }, owner.cookie);
    assert.equal(revoked.status, 200);
    assert.equal(revoked.body.revokedCount, 1);
    assert.equal((await app.request('/api/me', undefined, restored.cookie)).status, 401);
    const actions = app.inspect(db => db.prepare('SELECT action FROM admin_audit WHERE target_user_id=? ORDER BY rowid').all(trader.id).map(row => row.action));
    assert.deepEqual(actions, ['trader.status-changed', 'trader.status-changed', 'trader.sessions-revoked']);
  } finally { await app.close(); }
});

test('owner staff grants sign out the target and reviewer roles cannot manage traders, finances, staff, or exports', async () => {
  const app = await fixture();
  try {
    const owner = await app.register('owner@example.com', { factor: true });
    const reviewer = await app.register('reviewer@example.com', { factor: true });
    const pending = await app.register('pending@example.com');
    await app.unlock(owner);
    assert.equal((await app.request('/api/admin/staff/grant', { userId: pending.id, role: 'reviewer', reason }, owner.cookie)).status, 409, 'staff must enable their own factor first');
    const granted = await app.request('/api/admin/staff/grant', { userId: reviewer.id, role: 'reviewer', reason }, owner.cookie);
    assert.equal(granted.status, 200, JSON.stringify(granted.body));
    assert.equal((await app.request('/api/me', undefined, reviewer.cookie)).status, 401);
    const signed = await app.login(reviewer);
    assert.equal(signed.status, 200);
    reviewer.cookie = signed.cookie;
    const access = await app.request('/api/admin/access', undefined, reviewer.cookie);
    assert.equal(access.body.role, 'reviewer');
    assert.equal(access.body.authorized, true);
    for (const endpoint of ['/api/admin/traders', '/api/admin/assessments', '/api/admin/contracts', '/api/admin/certificates', '/api/admin/reviews']) assert.equal((await app.request(endpoint, undefined, reviewer.cookie)).status, 200, endpoint);
    for (const endpoint of ['/api/admin/staff', '/api/admin/audit', '/api/admin/accounts', '/api/admin/payouts', '/api/admin/system', '/api/admin/reports', '/api/admin/support']) assert.equal((await app.request(endpoint, undefined, reviewer.cookie)).status, 403, endpoint);
    await app.unlock(reviewer);
    assert.equal((await app.request(`/api/admin/traders/${pending.id}/notes`, { text: 'Reviewer-only internal observation.', reason }, reviewer.cookie)).status, 200, 'reviewers can record internal review notes');
    for (const [endpoint, input] of [
      [`/api/admin/traders/${pending.id}/status`, { status: 'suspended', reason }],
      [`/api/admin/traders/${pending.id}/revoke-sessions`, { reason }],
      ['/api/admin/staff/grant', { userId: pending.id, role: 'owner', reason }],
      ['/api/admin/contracts', { reason }], ['/api/admin/accounts', { reason }], ['/api/admin/payouts', { reason }],
    ]) assert.equal((await app.request(endpoint, input, reviewer.cookie)).status, 403, endpoint);
    assert.equal((await app.request('/api/admin/staff/revoke', { userId: reviewer.id, reason }, owner.cookie)).status, 200);
    assert.equal((await app.request('/api/admin/traders', undefined, reviewer.cookie)).status, 401);
    reviewer.cookie = (await app.login(reviewer)).cookie;
    assert.equal((await app.request('/api/admin/access', undefined, reviewer.cookie)).body.authorized, false);
    assert.equal((await app.request('/api/admin/overview', undefined, reviewer.cookie)).status, 403);
    const client = await app.request('/api/sponsorship', undefined, pending.cookie);
    assert.equal(client.status, 200);
    assert.ok(!JSON.stringify(client.body).includes('Reviewer-only internal observation.'));
  } finally { await app.close(); }
});

test('admin-derived support access disappears when two-factor authentication is disabled and never exposes trader PII', async () => {
  const app = await fixture();
  try {
    const owner = await app.register('owner@example.com', { factor: true });
    const staff = await app.register('support@example.com', { factor: true });
    const trader = await app.register('private-trader@example.com');
    await app.unlock(owner);
    assert.equal((await app.request('/api/admin/staff/grant', { userId: staff.id, role: 'support', reason }, owner.cookie)).status, 200);
    staff.cookie = (await app.login(staff)).cookie;
    for (const endpoint of ['/api/admin/support', '/api/support/staff/conversations']) assert.equal((await app.request(endpoint, undefined, staff.cookie)).status, 200);
    const overview = await app.request('/api/admin/overview', undefined, staff.cookie);
    assert.equal(overview.status, 200);
    assert.ok(!JSON.stringify(overview.body).includes(trader.email));
    assert.equal((await app.request('/api/admin/traders', undefined, staff.cookie)).status, 403);
    const disabled = await app.request('/api/security/2fa/disable', { password, code: staff.recoveryCodes.shift() }, staff.cookie);
    assert.equal(disabled.status, 200);
    const access = await app.request('/api/admin/access', undefined, disabled.cookie);
    assert.equal(access.body.role, 'support');
    assert.equal(access.body.authorized, false);
    assert.deepEqual(access.body.permissions, []);
    for (const endpoint of ['/api/admin/support', '/api/support/staff/conversations']) assert.equal((await app.request(endpoint, undefined, disabled.cookie)).status, 403, endpoint);
  } finally { await app.close(); }
});

test('admin contract publication enforces origin and proof, serves exact private document bytes, and does not approve funding', async () => {
  const app = await fixture();
  try {
    const owner = await app.register('owner@example.com', { factor: true });
    const trader = await app.register('trader@example.com');
    const content = 'Isolated test-only company document. Not production legal terms.\n';
    const input = { contentBase64: Buffer.from(content).toString('base64'), format: 'text', version: 'http-test-v1', title: 'Private test document', fileName: 'test-agreement.txt', reason };
    assert.equal((await app.request('/api/admin/contracts', input, owner.cookie)).body.code, 'ADMIN_REAUTH_REQUIRED');
    await app.unlock(owner);
    assert.equal((await app.request('/api/admin/contracts', input, owner.cookie, { Origin: 'https://untrusted.example' })).status, 403);
    assert.equal((await app.request('/api/admin/contracts', input, owner.cookie, { 'X-Requested-With': '' })).status, 403);
    assert.equal((await app.request('/api/admin/contracts', { ...input, contentBase64: 'not-base64' }, owner.cookie)).status, 400);
    const published = await app.request('/api/admin/contracts', input, owner.cookie);
    assert.equal(published.status, 200, JSON.stringify(published.body));
    const id = published.body.contract.id;
    const endpoint = `/api/admin/contracts/${id}/document`;
    assert.equal((await app.request(endpoint)).status, 401);
    assert.equal((await app.request(endpoint, undefined, trader.cookie)).status, 403);
    const document = await app.request(endpoint, undefined, owner.cookie);
    assert.equal(document.status, 200);
    assert.equal(document.body, content);
    assert.equal(document.headers.get('x-contract-sha256'), digest(content));
    assert.equal(document.headers.get('cache-control'), 'no-store');
    assert.equal(app.inspect(db => db.prepare("SELECT count(*) n FROM admin_audit WHERE action='contract.published'").get().n), 1);
    const client = await app.request('/api/sponsorship', undefined, trader.cookie);
    assert.equal(client.status, 200);
    assert.equal(client.body.review.fundingApproved, false);
    assert.deepEqual(client.body.funding.accounts, []);
    assert.deepEqual(client.body.funding.payouts, []);
    assert.equal(client.body.funding.transfersMoney, false);
    const blockedApproval = await app.request(`/api/admin/reviews/${trader.id}`, { status: 'approved', expectedRevision: 0, expectedContractId: id, expectedCertificateId: null, reason }, owner.cookie);
    assert.equal(blockedApproval.status, 409);
    assert.equal(blockedApproval.body.code, 'SPONSORSHIP_NOT_ELIGIBLE');
    const blockedAccount = await app.request('/api/admin/accounts', {
      userId: trader.id, firmName: 'Test-only external firm', label: 'Unapproved allocation',
      accountSizeCents: 1000000, traderShareBps: 7000, profitSharingPolicy: 'cumulative_high_water',
      evidence: 'Isolated test allocation evidence; no actual account purchase.', reason,
    }, owner.cookie);
    assert.equal(blockedAccount.status, 409);
    assert.equal(blockedAccount.body.code, 'SPONSORSHIP_APPROVAL_REQUIRED');
  } finally { await app.close(); }
});
