import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/client.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/client-operations.js', import.meta.url), 'utf8');
const timestamp = Date.UTC(2026, 9, 21, 10);
const response = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
const empty = (status = 'assessment_required') => ({
  review: { status, eligible: false, review: null, fundingApproved: false, message: null },
  funding: { accounts: [], payouts: [], accountsTotal: 0, payoutsTotal: 0, historyLimit: 100, source: 'manual_external_record', transfersMoney: false },
});
const recorded = () => ({
  review: { status: 'approved', eligible: true, review: { id: 'review-id', status: 'approved', revision: 1, clientMessage: 'Your review is complete. Contact the academy for the next step.', updatedAt: timestamp, stale: false }, fundingApproved: false, message: 'Your sponsorship review is approved. The academy must complete any external account arrangements separately.' },
  funding: {
    accounts: [{ id: 'account-id', firmName: 'External prop firm', label: 'Allocation one', accountSizeCents: 1000000, traderShareBps: 3750, currency: 'USD', status: 'active', profitSharingPolicy: 'cumulative_high_water', cumulativeNetProfitCents: -12345, earnedCents: 4501, reservedCents: 1001, paidCents: 2000, availableCents: 1500, updatedAt: timestamp, source: 'manual_external_record' }],
    payouts: [{ id: 'payout-id', label: 'Allocation one', firmName: 'External prop firm', amountCents: 2000, currency: 'USD', status: 'paid', createdAt: timestamp - 86400000, paidAt: timestamp, updatedAt: timestamp, source: 'manual_external_payment_record', transfersMoney: false }],
    accountsTotal: 1, payoutsTotal: 1, historyLimit: 100, source: 'manual_external_record', transfersMoney: false,
  },
});

class Element {
  constructor(tagName = 'div', id = '') { this.tagName = tagName; this.id = id; this.hidden = false; this.disabled = false; this.children = []; this.attributes = new Map(); this.listeners = new Map(); this._text = ''; }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unsafe HTML rendering is forbidden.'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); }
  addEventListener(name, callback) { this.listeners.set(name, callback); }
  async event(name, data = {}) { return this.listeners.get(name)?.({ preventDefault() {}, ...data }); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this._text = ''; this.children = children; }
  descendants(tag) { return this.children.flatMap(child => [...(child.tagName === tag ? [child] : []), ...child.descendants(tag)]); }
}

function fixture(fetcher = async () => response(empty())) {
  const nodes = new Map();
  for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1], match[3]);
    element.hidden = /\bhidden(?:\s|$|=)/.test(match[2]);
    nodes.set(element.id, element);
  }
  const calls = [], events = new Map();
  vm.runInNewContext(script, {
    document: { getElementById: id => nodes.get(id) || null, createElement: tag => new Element(tag) },
    window: { addEventListener: (name, callback) => events.set(name, callback) }, AbortSignal,
    fetch: async (...args) => { calls.push(args); return fetcher(...args); },
  });
  return {
    nodes, calls,
    async settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); },
    async click(id = 'refresh-sponsorship') { await nodes.get(id).event('click'); },
    async pagehide() { await events.get('pagehide')?.({}); },
    async pageshow() { await events.get('pageshow')?.({ persisted: true }); },
  };
}

test('client sponsorship shows its actual review, exact-cent recorded amounts, and external arrangement limitations', async () => {
  const page = fixture(async () => response(recorded())); await page.settle();
  assert.equal(page.nodes.get('sponsorship-content').hidden, false);
  assert.equal(page.nodes.get('sponsorship-review-status').textContent, 'Review approved');
  assert.match(page.nodes.get('sponsorship-review-detail').textContent, /arrange any external prop account separately/);
  assert.equal(page.nodes.get('sponsorship-client-message').textContent, recorded().review.review.clientMessage);
  const account = page.nodes.get('sponsored-accounts-list').textContent;
  for (const label of ['Allocation one', 'External prop firm', '$10,000.00', '37.5%', '-$123.45', '$45.01', '$10.01', '$20.00', '$15.00', 'cumulative high-water']) assert.ok(account.includes(label), label);
  assert.match(page.nodes.get('sponsored-payouts-list').textContent, /\$20\.00Recorded as paid/);
  assert.match(page.nodes.get('sponsored-payouts-list').textContent, /Recorded payment date/);
  assert.match(html, /Figures reflect recorded statements rather than a live connection/);
  assert.match(html, /Payments are handled outside this website/);
  assert.match(html, /href="\/admin\.html">Staff console/);
  assert.equal(page.calls[0][0], '/api/sponsorship');
  const options = page.calls[0][1];
  assert.equal(options.method, 'GET'); assert.equal(options.credentials, 'same-origin'); assert.equal(options.cache, 'no-store'); assert.equal(options.referrerPolicy, 'no-referrer'); assert.ok(options.signal instanceof AbortSignal); assert.equal('body' in options, false);
});

test('private reviewer messages and company/account labels stay text, never executable markup', async () => {
  const payload = recorded(), attack = '<img src=x onerror=alert(1)>';
  payload.review.review.clientMessage = attack; payload.funding.accounts[0].label = attack; payload.funding.accounts[0].firmName = attack; payload.funding.payouts[0].label = attack;
  const page = fixture(async () => response(payload)); await page.settle();
  assert.equal(page.nodes.get('sponsorship-client-message').textContent, attack);
  for (const id of ['sponsored-accounts-list', 'sponsored-payouts-list']) {
    assert.ok(page.nodes.get(id).textContent.includes(attack)); assert.equal(page.nodes.get(id).descendants('img').length, 0);
  }
});

test('pending requirements and empty records never imply funded accounts, and stale decisions describe current requirements', async () => {
  let payload = empty('signature_required');
  const page = fixture(async () => response(payload)); await page.settle();
  assert.equal(page.nodes.get('sponsorship-next-action').getAttribute('href'), '/contract.html');
  assert.match(page.nodes.get('sponsored-accounts-list').textContent, /No sponsored account arrangements/);
  assert.match(page.nodes.get('sponsored-payouts-list').textContent, /No payout records yet/);
  payload = empty('awaiting_contract');
  payload.review.review = { stale: true, updatedAt: timestamp, clientMessage: '' };
  await page.click();
  assert.equal(page.nodes.get('sponsorship-review-status').textContent, 'Awaiting academy agreement');
  assert.equal(page.nodes.get('sponsorship-stale-note').hidden, false);
  assert.equal(page.nodes.get('sponsorship-message-panel').hidden, true);
  assert.equal(page.nodes.get('sponsorship-next-action').hidden, true);
  assert.equal(page.nodes.get('sponsorship-next-action').getAttribute('href'), undefined);
  payload = empty('unknown_future_status'); await page.click();
  assert.equal(page.nodes.get('sponsorship-review-status').textContent, 'Review status unavailable');
  assert.equal(page.nodes.get('sponsorship-next-action').hidden, true);
});

test('expired or forbidden access clears previously loaded private records and gives safe next steps', async () => {
  for (const denied of [401, 403]) {
    let status = 200;
    const page = fixture(async () => response(status === 200 ? recorded() : { error: 'private operator error' }, status)); await page.settle();
    status = denied; await page.click();
    assert.equal(page.nodes.get('sponsorship-content').hidden, true);
    assert.equal(page.nodes.get('sponsored-accounts-list').children.length, 0);
    assert.equal(page.nodes.get('sponsored-payouts-list').children.length, 0);
    assert.equal(page.nodes.get('sponsorship-client-message').textContent, '');
    assert.equal(page.nodes.get('sponsorship-login').hidden, denied !== 401);
    assert.match(page.nodes.get('sponsorship-load-status').textContent, denied === 401 ? /log in again/ : /Contact support/);
    assert.doesNotMatch(page.nodes.get('sponsorship-load-status').textContent, /private operator error|out of date/);
    assert.equal(page.nodes.get('refresh-sponsorship').disabled, false);
  }
});

test('network failures retain a clearly stale snapshot and user retry replaces it with current records', async () => {
  let phase = 0;
  const page = fixture(async () => { if (phase === 1) throw new Error('private network details'); return response(phase === 2 ? empty('pending_review') : recorded()); });
  await page.settle(); phase = 1; await page.click();
  assert.equal(page.nodes.get('sponsorship-content').hidden, false);
  assert.match(page.nodes.get('sponsorship-load-status').textContent, /Previously loaded records below may be out of date/);
  assert.doesNotMatch(page.nodes.get('sponsorship-load-status').textContent, /private network details/);
  phase = 2; await page.click('refresh-overview');
  assert.equal(page.nodes.get('sponsorship-review-status').textContent, 'Awaiting company review');
  assert.match(page.nodes.get('sponsored-accounts-list').textContent, /No sponsored account arrangements/);
  assert.doesNotMatch(page.nodes.get('sponsorship-load-status').textContent, /out of date/);
});

test('malformed or inconsistent record responses cannot produce a successful sponsorship snapshot', async () => {
  const invalid = [null, {}, { ...recorded(), funding: { accounts: null, payouts: [] } }, { ...recorded(), funding: { ...recorded().funding, accountsTotal: 0 } }, { ...recorded(), funding: { ...recorded().funding, payouts: [null] } }];
  for (const body of invalid) {
    let current = body;
    const page = fixture(async () => response(current)); await page.settle();
    assert.equal(page.nodes.get('sponsorship-content').hidden, true);
    assert.match(page.nodes.get('sponsorship-load-status').textContent, /couldn’t load/);
    assert.equal(page.nodes.get('refresh-sponsorship').disabled, false);
    current = empty(); await page.click();
    assert.equal(page.nodes.get('sponsorship-content').hidden, false);
  }
});

test('leaving the page clears records, ignores an old response, and a restored page fetches its own current snapshot', async () => {
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  let calls = 0;
  const page = fixture(async () => ++calls === 1 ? pending : response(empty('needs_information')));
  await page.click(); assert.equal(page.calls.length, 1, 'double clicks do not duplicate in-flight reads');
  await page.pagehide(); resolve(response(recorded())); await page.settle();
  assert.equal(page.nodes.get('sponsorship-content').hidden, true);
  assert.equal(page.nodes.get('sponsored-accounts-list').children.length, 0);
  await page.pageshow(); await page.settle();
  assert.equal(page.calls.length, 2);
  assert.equal(page.nodes.get('sponsorship-review-status').textContent, 'More information needed');
  assert.equal(page.nodes.get('refresh-sponsorship').disabled, false);
  assert.equal(page.nodes.get('sponsorship-operations').getAttribute('aria-busy'), 'false');
});
