import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { searchEntries } from '../public/site-search-index.js';
import { searchSite, searchCategories, MAX_QUERY_LENGTH } from '../public/site-search-engine.js';

test('curated public destinations exist and every deep link points to a real element', async () => {
  const identifiers = new Set();
  assert.ok(searchEntries.length > 0);
  assert.equal(searchCategories.includes('All'), false);
  for (const entry of searchEntries) {
    assert.equal(identifiers.has(entry.id), false, entry.id);
    identifiers.add(entry.id);
    assert.match(entry.title, /\S/);
    assert.match(entry.description, /\S/);
    assert.equal(typeof entry.requiresLogin, 'boolean');
    assert.ok(searchCategories.includes(entry.category));
    assert.match(entry.url, /^\/[a-z0-9-]+\.html(?:#[a-z0-9-]+)?$/);
    assert.doesNotMatch(entry.url, /api\/|admin|support-agent|\?/);
    const [pathname, hash] = entry.url.split('#');
    const page = await readFile(new URL(`../public${pathname}`, import.meta.url), 'utf8');
    if (hash) assert.ok(page.includes(`id="${hash}"`), entry.url);
  }
});

test('common help questions find their most relevant destinations', () => {
  for (const [query, id] of [
    ['How do I reset my password?', 'password-recovery'],
    ['certificate nickname', 'certificates'],
    ['5% daily drawdown', 'daily-drawdown'],
    ['10% total draw down', 'total-drawdown'],
    ['How many trading days?', 'trading-days'],
    ['How long to pass?', 'trading-days'],
    ['How long do payouts take?', 'payout-processing'],
    ['equity curve', 'performance-reports'],
    ['payout request', 'payout-requests'],
    ['MetaApi', 'metatrader-performance'],
    ['first name', 'profile-name'],
    ['change my name', 'profile-name'],
    ['customer support agent', 'support'],
    ['signup email confirmation', 'email-confirmation'],
    ['confirmation email not received', 'email-confirmation'],
    ['two factor authentication', 'two-factor'],
    ['export my personal data', 'personal-data-export'],
  ]) assert.equal(searchSite(query).results[0]?.id, id, query);
});

test('case, accents, common aliases, partial words and modest typing errors are supported', () => {
  assert.equal(searchSite('MÉTAAPI').results[0]?.id, 'metatrader-performance');
  assert.equal(searchSite('certficate').results[0]?.id, 'certificates');
  assert.equal(searchSite('certifciate').results[0]?.id, 'certificates');
  assert.equal(searchSite('cert').results[0]?.id, 'certificates');
  assert.equal(searchSite('withdrawal request').results[0]?.id, 'payout-requests');
  assert.equal(searchSite('TOTP').results[0]?.id, 'two-factor');
  assert.ok(searchSite('25k profit').results.some(entry => entry.id === 'profit-sharing'));
});

test('filters, deterministic popular results and pagination limits preserve truthful counts', () => {
  const all = searchSite('', { limit: 6 });
  assert.equal(all.total, searchEntries.length);
  assert.equal(all.results.length, 6);
  assert.equal(all.results[0].id, 'academy-model');
  assert.equal(all.truncated, true);
  assert.deepEqual(searchSite(''), searchSite(''));
  for (const category of searchCategories) {
    const page = searchSite('', { category, limit: 50 });
    assert.equal(page.total, searchEntries.filter(entry => entry.category === category).length);
    assert.ok(page.results.every(entry => entry.category === category));
    assert.equal(page.truncated, false);
  }
  assert.equal(searchSite('certificate', { category: 'Help' }).total, 0);
  assert.equal(searchSite('', { category: 'Unknown' }).total, 0);
});

test('hostile, excessive and unknown queries remain bounded and never turn into arbitrary links', () => {
  assert.equal(MAX_QUERY_LENGTH, 160);
  for (const query of [null, undefined, {}, 5]) assert.deepEqual(searchSite(query), { results: [], total: 0, query: '', truncated: false });
  assert.ok(searchSite('a'.repeat(1000000)).query.length <= MAX_QUERY_LENGTH);
  assert.ok(searchSite('', { limit: 1000000 }).results.length <= 50);
  assert.ok(searchSite('', { limit: -5 }).results.length <= 1);
  for (const query of ['zzxqnonexistent', 'https://attacker.invalid/collect', '<script>alert(1)</script>', 'api admin password secret']) {
    assert.equal(searchSite(query).total, 0, query);
  }
  assert.equal(searchSite('the and of').total, 0);
  assert.equal(searchSite('certificate zzzzznonexistent').total, 0);
});

test('search results cannot mutate the shared index and source uses no network or query persistence', async () => {
  const result = searchSite('certificate');
  result.results[0].title = 'Changed by a caller';
  assert.notEqual(searchSite('certificate').results[0].title, 'Changed by a caller');
  assert.ok(Object.isFrozen(searchEntries));
  assert.ok(searchEntries.every(entry => Object.isFrozen(entry) && Object.isFrozen(entry.keywords)));
  const source = await readFile(new URL('../public/site-search-engine.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /fetch\s*\(|XMLHttpRequest|WebSocket|localStorage|sessionStorage|document\.cookie|sendBeacon/);
  const index = JSON.stringify(searchEntries);
  assert.doesNotMatch(index, /@|onrender\.com|RESEND_API_KEY|METAAPI_API_TOKEN|recipientUserId|contentBase64/);
});
