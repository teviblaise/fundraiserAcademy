import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { createLeaderboard } from '../leaderboard.mjs';
import { createCertificates } from '../certificates.mjs';
import { createContracts, contractConsentStatement } from '../contracts.mjs';
import { createAccount } from '../public/simulator.js';
import { createBackend } from '../backend.mjs';
import { testDeliveryOptions } from './helpers/email-fixture.mjs';

const terms = Buffer.from('Operator-provided contract terms for the leaderboard tests.');
const publication = (version = 'v1', now = 500) => ({ content: terms, format: 'text', version, title: 'Trader agreement', now });
const signature = document => ({ contractId: document.id, contractVersion: document.version, contractHash: document.hash, legalName: 'Private Legal Name', consent: true });
function fixture() {
  const db = new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL);
    CREATE TABLE events(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);`);
  for (let id = 1; id <= 12; id++) db.prepare('INSERT INTO users VALUES (?,?,?)').run(id, `Private Registered Name ${id}`, `private-${id}@example.com`);
  const certificates = createCertificates(db), contracts = createContracts(db), leaderboard = createLeaderboard(db, { now: () => 5000 });
  function qualify(id = 1, final = 12000, issued = 1000, extra = {}) {
    const state = createAccount();
    Object.assign(state, { balance: final, positions: [], locked: 'Profit target achieved', tradingDays: ['2026-10-09', '2026-10-10', '2026-10-11'], ...extra });
    return certificates.issue(id, state, issued);
  }
  function sign(id, document, at = 2000) { return contracts.sign(id, signature(document), at); }
  function join(id, alias = `Public Trader ${id}`) { return leaderboard.setPreferences(id, { enabled: true, alias }); }
  return { db, certificates, contracts, leaderboard, qualify, sign, join };
}

test('leaderboard is empty and private by default, with truthful qualification and agreement stages', () => {
  const { db, leaderboard, contracts, qualify, sign, join } = fixture();
  try {
    assert.equal(leaderboard.page().total, 0);
    assert.deepEqual(leaderboard.preferences(1), { enabled: false, alias: '', eligibility: { eligible: false, status: 'assessment_required' }, entry: null });
    qualify();
    assert.equal(leaderboard.preferences(1).eligibility.status, 'awaiting_contract');
    assert.equal(join(1).entry, null, 'early opt-in does not invent an unsigned ranking');
    const document = contracts.publish(publication());
    assert.equal(leaderboard.preferences(1).eligibility.status, 'signature_required');
    sign(1, document);
    const owner = leaderboard.preferences(1);
    assert.equal(owner.enabled, true); assert.equal(owner.eligibility.eligible, true); assert.equal(owner.entry.rank, 1);
    const { entries, total, scope } = leaderboard.page();
    assert.equal(scope, 'qualification_current_contract'); assert.equal(total, 1);
    assert.deepEqual(Object.keys(entries[0]).sort(), ['completedAt', 'displayAlias', 'publicEntryId', 'rank', 'realizedProfit', 'returnPercent', 'tradingDays'].sort());
    assert.equal(entries[0].displayAlias, 'Public Trader 1'); assert.equal(entries[0].returnPercent, 20); assert.equal(entries[0].realizedProfit, 2000);
    const exposed = JSON.stringify(leaderboard.page());
    assert.doesNotMatch(exposed, /private-|Private Registered|Private Legal|certificateId|userId|contractId|signature/i);
  } finally { db.close(); }
});

test('ranks use displayed return, competition ties, stable ordering, paging, and owner rank beyond page', () => {
  const { db, leaderboard, contracts, qualify, sign, join } = fixture();
  try {
    const document = contracts.publish(publication());
    qualify(1, 12000.49, 1100); qualify(2, 12000.41, 1000); qualify(3, 11500, 1200); qualify(4, 11100, 1200);
    for (const id of [1, 2, 3, 4]) { sign(id, document); join(id); }
    const first = leaderboard.page({ limit: 1, offset: 0 });
    const second = leaderboard.page({ limit: 1, offset: 1 });
    const third = leaderboard.page({ limit: 1, offset: 2 });
    assert.equal(first.entries[0].displayAlias, 'Public Trader 2', 'completion time breaks visual order, without breaking equal ranks');
    assert.equal(first.entries[0].returnPercent, second.entries[0].returnPercent);
    assert.equal(first.entries[0].rank, 1); assert.equal(second.entries[0].rank, 1); assert.equal(third.entries[0].rank, 3);
    assert.equal(leaderboard.preferences(4).entry.rank, 4);
    assert.equal(first.nextOffset, 1); assert.equal(leaderboard.page({ limit: 2, offset: 2 }).nextOffset, null);
    assert.deepEqual(leaderboard.page({ limit: 2, offset: 20 }).entries, []);
    for (const input of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { offset: -1 }, { offset: 1000001 }, { offset: NaN }]) assert.throws(() => leaderboard.page(input), error => error.status === 400);
  } finally { db.close(); }
});

test('ranking stays bound to the signed certificate after resets, later attempts, and certificate name edits', () => {
  const { db, leaderboard, certificates, contracts, qualify, sign, join } = fixture();
  try {
    const document = contracts.publish(publication());
    const original = qualify(1, 11200); sign(1, document); join(1, 'Steady Trader');
    const before = leaderboard.page().entries[0];
    certificates.setPreferences(1, { mode: 'nickname', nickname: 'Different Certificate Name', applyExisting: true });
    qualify(1, 19000, 3000);
    db.exec('CREATE TABLE accounts(user_id INTEGER PRIMARY KEY,state TEXT NOT NULL);');
    db.prepare('INSERT INTO accounts VALUES (?,?)').run(1, JSON.stringify({ balance: 999999999, initial: 10000, locked: 'Profit target achieved' }));
    assert.deepEqual(leaderboard.page().entries[0], before);
    assert.equal(db.prepare('SELECT certificate_id FROM contract_signatures WHERE user_id=1').get().certificate_id, original.id);
    assert.equal(leaderboard.page().entries[0].returnPercent, 12);
  } finally { db.close(); }
});

test('synthetic, invalid, short, and inconsistent certificate results never enter public rankings', () => {
  const { db, leaderboard, contracts, qualify, sign, join } = fixture();
  try {
    const document = contracts.publish(publication());
    const certificate = qualify(); sign(1, document); join(1);
    const update = (field, value) => db.prepare(`UPDATE certificates SET ${field}=? WHERE id=?`).run(value, certificate.id);
    for (const [field, bad, good] of [
      ['price_mode', 'synthetic', 'reference'], ['trading_days', 2, 3], ['trading_days', 3.5, 3],
      ['initial_balance', 0, 10000], ['initial_balance', -1, 10000], ['final_balance', 10999, 12000],
      ['profit_percent', 5, 20], ['profit_percent', 99, 20], ['final_balance', Infinity, 12000],
      ['issued_at', -1, 1000],
    ]) {
      update(field, bad); assert.equal(leaderboard.page().total, 0, `${field}=${bad} is excluded`); update(field, good);
    }
    assert.equal(leaderboard.page().total, 1);
    qualify(2, 12000, 1000, { executionMode: 'synthetic' }); sign(2, document); join(2);
    qualify(3); join(3);
    assert.equal(leaderboard.page().total, 1, 'legacy synthetic and unsigned traders stay excluded');
  } finally { db.close(); }
});

test('signatures must bind the current contract version/hash and a certificate owned by that trader', () => {
  const { db, leaderboard, contracts, qualify, sign, join } = fixture();
  try {
    const first = contracts.publish(publication());
    qualify(1); qualify(2); const otherCertificate = qualify(3);
    sign(1, first); join(1);
    const second = contracts.publish(publication('v2', 2500));
    assert.equal(leaderboard.page().total, 0);
    assert.equal(leaderboard.preferences(1).eligibility.status, 'signature_required');
    sign(1, second, 3000);
    assert.equal(leaderboard.page().total, 1);
    const insert = db.prepare('INSERT INTO contract_signatures VALUES (?,?,?,?,?,?,?,?,?,?,?)');
    insert.run('bad-owner', 2, second.id, second.version, second.hash, otherCertificate.id, 'Private Name', 'Private Registered', 'private@example.com', contractConsentStatement, 3000);
    join(2);
    assert.equal(leaderboard.preferences(2).eligibility.status, 'ineligible_certificate');
    assert.equal(leaderboard.page().total, 1);
    for (const [id, version, hash] of [[4, 'wrong', second.hash], [5, second.version, 'wrong']]) {
      const certificate = qualify(id);
      insert.run(`bad-metadata-${id}`, id, second.id, version, hash, certificate.id, 'Private Name', 'Private Registered', 'private@example.com', contractConsentStatement, 3000);
      join(id);
    }
    assert.equal(leaderboard.page().total, 1);
  } finally { db.close(); }
});

test('public aliases require explicit choice, reject impersonating payload fields, and remain stable across opt-out', () => {
  const { db, leaderboard, contracts, qualify, sign } = fixture();
  try {
    const document = contracts.publish(publication()); qualify(); sign(1, document);
    for (const data of [
      { enabled: true }, { enabled: 'true', alias: 'Valid Alias' }, { enabled: true, alias: 'Valid Alias', rank: 1 },
      { enabled: true, alias: '<img src=x>' }, { enabled: true, alias: 'Bad\nAlias' }, { enabled: true, alias: 'Bad\u200dAlias' },
      { enabled: true, alias: 'a'.repeat(41) }, { enabled: true, alias: '---' }, { enabled: false, alias: null },
    ]) assert.throws(() => leaderboard.setPreferences(1, data), error => error.status === 400);
    const joined = leaderboard.setPreferences(1, { enabled: true, alias: "  Étoile's   Trader-7 " });
    const publicId = joined.entry.publicEntryId;
    assert.equal(joined.alias, "Étoile's Trader-7");
    assert.throws(() => leaderboard.setPreferences(2, { enabled: true, alias: "ÉTOILE'S Trader-7" }), error => error.status === 409);
    assert.equal(leaderboard.setPreferences(1, { enabled: false }).entry, null);
    assert.equal(leaderboard.page().total, 0);
    assert.doesNotMatch(JSON.stringify(leaderboard.page()), /Étoile/);
    assert.equal(leaderboard.setPreferences(1, { enabled: true }).entry.publicEntryId, publicId);
    assert.equal(leaderboard.setPreferences(1, { enabled: false, alias: '' }).alias, '');
    assert.equal(leaderboard.preferences(2).alias, '', 'owner preferences never expose another user profile');
  } finally { db.close(); }
});

test('HTTP leaderboard is public and read-only, while owner privacy controls require session and CSRF validation', async () => {
  const folder = await mkdtemp(path.join(tmpdir(), 'fa-leaderboard-'));
  const database = path.join(folder, 'academy.sqlite');
  let quoteCalls = 0;
  const backend = createBackend(database, { autoTick: false, deliveryOptions: testDeliveryOptions, marketData: { getExecutionQuote() { quoteCalls++; throw new Error('Leaderboard must never fetch quotes'); }, close() {} } });
  const server = http.createServer((req, res) => backend.handle(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const request = async (endpoint, data, cookie, extra = {}) => {
    const response = await fetch(origin + endpoint, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy', ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  let privateDb;
  try {
    assert.equal((await request('/api/leaderboard')).status, 200);
    assert.equal((await request('/api/leaderboard/preferences')).status, 401);
    const first = await request('/api/register', { name: 'Private First Name', email: 'private-first@example.com', password: 'a-long-test-password-leaderboard', market: 'I trade forex', consent: true });
    const second = await request('/api/register', { name: 'Private Second Name', email: 'private-second@example.com', password: 'a-long-test-password-leaderboard', market: 'I trade forex', consent: true });
    assert.equal(first.body.user.emailVerified, false);
    assert.equal((await request('/api/leaderboard/preferences', undefined, first.cookie)).body.enabled, false);
    assert.equal((await request('/api/leaderboard/preferences', { enabled: true, alias: 'Public Champion' }, first.cookie)).status, 200, 'pending confirmation can manage public consent');
    assert.equal((await request('/api/leaderboard/preferences', undefined, second.cookie)).body.alias, '');
    assert.equal((await request('/api/leaderboard/preferences', { enabled: true, alias: 'Injected', returnPercent: 500 }, first.cookie)).status, 400);
    assert.equal((await request('/api/leaderboard/preferences', { enabled: true, alias: 'Injected', userId: second.body.user.id }, first.cookie)).status, 400);
    assert.equal((await request('/api/leaderboard/preferences', { enabled: false }, first.cookie, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await request('/api/leaderboard/preferences', { enabled: false }, first.cookie, { 'X-Requested-With': '' })).status, 403);
    privateDb = new DatabaseSync(database); privateDb.exec('PRAGMA foreign_keys=ON;');
    const certificates = createCertificates(privateDb), contracts = createContracts(privateDb);
    const document = contracts.publish({ ...publication(), now: Date.now() - 10000 });
    const state = createAccount(); Object.assign(state, { balance: 11750, positions: [], locked: 'Profit target achieved', tradingDays: ['2026-10-09', '2026-10-10', '2026-10-11'] });
    certificates.issue(first.body.user.id, state, Date.now() - 5000); contracts.sign(first.body.user.id, signature(document));
    const board = await request('/api/leaderboard?limit=1&offset=0');
    assert.equal(board.status, 200); assert.equal(board.body.total, 1); assert.equal(board.body.entries[0].displayAlias, 'Public Champion'); assert.equal(board.body.entries[0].returnPercent, 17.5);
    assert.doesNotMatch(JSON.stringify(board.body), /private-first|Private First Name|Private Legal Name|certificateId|userId|contractId/);
    assert.equal((await request('/api/leaderboard/preferences', undefined, first.cookie)).body.entry.rank, 1);
    assert.equal((await request('/api/leaderboard/preferences', { enabled: false }, first.cookie)).status, 200);
    assert.equal((await request('/api/leaderboard')).body.total, 0);
    assert.equal((await request('/api/leaderboard?limit=0')).status, 400);
    assert.equal((await request('/api/leaderboard?limit=1.5')).status, 400);
    assert.equal((await request('/api/leaderboard?offset=-1')).status, 400);
    assert.equal(quoteCalls, 0);
    for (let i = 0; i < 20; i++) await request('/api/leaderboard');
    assert.equal((await request('/api/leaderboard')).status, 429);
  } finally {
    await new Promise(resolve => server.close(resolve)); await backend.close(); privateDb?.close(); await rm(folder, { recursive: true, force: true });
  }
});
