import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../public/login.html', import.meta.url), 'utf8');
const challenge = 'a'.repeat(64);
const backup = 'ab12cd34-ef56ab78-cd90ef12-ab34cd56';

function fixture({ fetcher, registration = false } = {}) {
  let time = 1800000000000;
  let timerId = 0;
  const timers = new Map();
  const calls = [];
  const redirects = [];
  const documentEvents = new Map();
  const windowEvents = new Map();
  function node(id) {
    return {
      id, value: '', textContent: '', hidden: id === 'login-two-factor', disabled: false,
      listeners: new Map(), attributes: new Map(), validityMessage: '',
      addEventListener(type, listener) { this.listeners.set(type, listener); },
      setAttribute(name, value) { this.attributes.set(name, value); },
      removeAttribute(name) { this.attributes.delete(name); },
      setCustomValidity(message) { this.validityMessage = message; },
      focus() { this.focused = true; },
      querySelector() { return null; },
      reportValidity() { return true; },
    };
  }
  const ids = ['login-form', 'login-email', 'login-password', 'login-button', 'login-status', 'login-two-factor', 'login-two-factor-form', 'login-two-factor-code', 'login-two-factor-label', 'login-two-factor-hint', 'login-two-factor-status', 'two-factor-button', 'login-two-factor-switch', 'login-two-factor-cancel', 'year'];
  if (registration) ids.push('interest-form', 'firstName', 'otherNames', 'registration-button', 'registration-status');
  const nodes = new Map(ids.map(id => [id, node(id)]));
  nodes.get('login-email').value = 'trader@example.com';
  nodes.get('login-password').value = 'a long original password';
  function form(id, fields, button, status) {
    const item = nodes.get(id);
    item.fields = fields;
    item.elements = { namedItem: name => nodes.get(fields[name]) || null };
    item.querySelector = selector => selector === 'button[type="submit"]' ? nodes.get(button) : selector === '[role="status"]' ? nodes.get(status) : null;
  }
  form('login-form', { email: 'login-email', password: 'login-password' }, 'login-button', 'login-status');
  form('login-two-factor-form', { code: 'login-two-factor-code' }, 'two-factor-button', 'login-two-factor-status');
  nodes.get('login-two-factor-form').reportValidity = () => Boolean(nodes.get('login-two-factor-code').value && !nodes.get('login-two-factor-code').validityMessage);
  if (registration) {
    form('interest-form', { firstName: 'firstName', otherNames: 'otherNames', email: 'login-email', password: 'login-password' }, 'registration-button', 'registration-status');
    nodes.get('interest-form').values = { firstName: ' Ada ', otherNames: '  Jane   Jones ', experience: 'forex', consent: 'on' };
    nodes.get('firstName').value = ' Ada ';
    nodes.get('otherNames').value = '  Jane   Jones ';
  }
  const document = {
    hidden: false,
    querySelector: () => null,
    getElementById: id => nodes.get(id) || null,
    createElement: () => node('support-launcher'),
    body: { append() {} },
    addEventListener: (type, listener) => documentEvents.set(type, listener),
  };
  const window = {
    location: { assign: destination => redirects.push(destination) },
    addEventListener: (type, listener) => windowEvents.set(type, listener),
  };
  class FixtureDate extends Date { static now() { return time; } }
  class FixtureFormData {
    constructor(item) { this.entries = Object.entries(item.fields).map(([name, id]) => [name, nodes.get(id).value]); this.entries.push(...Object.entries(item.values || {})); }
    [Symbol.iterator]() { return this.entries[Symbol.iterator](); }
  }
  vm.runInNewContext(script, {
    document, window, Date: FixtureDate, FormData: FixtureFormData, AbortSignal,
    setTimeout(callback, duration) { const id = ++timerId; timers.set(id, { callback, at: time + duration }); return id; },
    clearTimeout: id => timers.delete(id),
    fetch: async (url, options) => {
      calls.push({ url, options, values: options?.body ? JSON.parse(options.body) : null });
      const value = fetcher ? await fetcher(url, options, { time }) : { ok: true, status: 202, body: { twoFactorRequired: true, challenge, expiresAt: time + 300000 } };
      return { ...value, json: async () => value.body || {} };
    },
  });
  return {
    nodes, calls, redirects, document, window, timers,
    event: (id, type = 'submit') => nodes.get(id).listeners.get(type)?.({ preventDefault() {} }),
    advance(milliseconds) {
      time += milliseconds;
      for (const [id, timer] of [...timers]) if (timer.at <= time) { timers.delete(id); timer.callback(); }
    },
    visibility() { documentEvents.get('visibilitychange')?.(); },
    pagehide() { windowEvents.get('pagehide')?.(); },
  };
}

test('password acceptance shows the second factor and cannot navigate or fetch private profile data', async () => {
  const page = fixture();
  await page.event('login-form');
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0].url, '/api/login');
  assert.deepEqual(page.redirects, []);
  assert.equal(page.nodes.get('login-form').hidden, true);
  assert.equal(page.nodes.get('login-two-factor').hidden, false);
  assert.equal(page.nodes.get('login-password').value, '');
  assert.equal(page.nodes.get('login-two-factor-code').focused, true);
  assert.equal(page.timers.size, 1);
  assert.equal(JSON.stringify(page.window).includes(challenge), false);
  assert.doesNotMatch(script, /localStorage|sessionStorage|console\.|URLSearchParams/);
});

test('OTP validation preserves leading zeros and only full authentication opens the dashboard', async () => {
  const page = fixture({ fetcher: async (url, options, { time }) => url === '/api/login'
    ? { ok: true, status: 202, body: { twoFactorRequired: true, challenge, expiresAt: time + 300000 } }
    : { ok: true, status: 200, body: { user: { id: 1, assessmentAccess: false } } } });
  await page.event('login-form');
  page.nodes.get('login-two-factor-code').value = '123';
  await page.event('login-two-factor-form');
  assert.equal(page.calls.length, 1);
  page.nodes.get('login-two-factor-code').value = '012345';
  await page.event('login-two-factor-form');
  assert.deepEqual(page.calls[1].values, { challenge, code: '012345' });
  assert.equal(page.calls[1].url, '/api/login/2fa');
  assert.equal(page.calls[1].options.cache, 'no-store');
  assert.equal(page.calls[1].options.credentials, 'same-origin');
  assert.equal(page.nodes.get('login-two-factor-code').value, '');
  assert.equal(page.timers.size, 0);
  assert.deepEqual(page.redirects, ['/client.html']);
  await page.event('login-two-factor-form');
  assert.equal(page.calls.length, 2);
});

test('recovery codes support pasted separators and invalid codes remain on the verification step', async () => {
  const page = fixture({ fetcher: async (url, options, { time }) => url === '/api/login'
    ? { ok: true, status: 202, body: { twoFactorRequired: true, challenge, expiresAt: time + 300000 } }
    : { ok: false, status: 400, body: { code: 'TWO_FACTOR_INVALID', error: 'Invalid code' } } });
  await page.event('login-form');
  page.nodes.get('login-two-factor-code').value = '123456';
  await page.event('login-two-factor-switch', 'click');
  assert.equal(page.nodes.get('login-two-factor-code').value, '');
  assert.equal(page.nodes.get('login-two-factor-code').attributes.get('inputmode'), 'text');
  assert.equal(page.nodes.get('login-two-factor-code').attributes.has('pattern'), false);
  page.nodes.get('login-two-factor-code').value = backup.toUpperCase().replaceAll('-', ' - ');
  await page.event('login-two-factor-form');
  assert.deepEqual(page.calls[1].values, { challenge, code: backup.replaceAll('-', '') });
  assert.deepEqual(page.redirects, []);
  assert.equal(page.nodes.get('login-two-factor').hidden, false);
  assert.match(page.nodes.get('login-two-factor-status').textContent, /already been used/);
  assert.equal(page.nodes.get('login-two-factor-code').value, '');
  await page.event('login-two-factor-switch', 'click');
  assert.equal(page.nodes.get('login-two-factor-code').attributes.get('inputmode'), 'numeric');
  assert.equal(page.nodes.get('login-two-factor-code').attributes.get('pattern'), '[0-9]{6}');
});

test('back cancels the server challenge and clears local secrets before restoring the password form', async () => {
  const page = fixture();
  await page.event('login-form');
  page.nodes.get('login-two-factor-code').value = '123456';
  await page.event('login-two-factor-cancel', 'click');
  assert.equal(page.calls[1].url, '/api/login/2fa/cancel');
  assert.deepEqual(page.calls[1].values, { challenge });
  assert.equal(page.nodes.get('login-two-factor').hidden, true);
  assert.equal(page.nodes.get('login-form').hidden, false);
  assert.equal(page.nodes.get('login-password').value, '');
  assert.equal(page.nodes.get('login-two-factor-code').value, '');
  assert.equal(page.nodes.get('login-password').focused, true);
  assert.equal(page.timers.size, 0);
  await page.event('login-two-factor-form');
  assert.equal(page.calls.length, 2);
  assert.deepEqual(page.redirects, []);
});

test('temporarily unavailable authenticator verification keeps the secure recovery-code option usable', async () => {
  const page = fixture({ fetcher: async (url, options, { time }) => {
    if (url === '/api/login') return { ok: true, status: 202, body: { twoFactorRequired: true, challenge, expiresAt: time + 300000 } };
    if (JSON.parse(options.body).code.length === 6) return { ok: false, status: 503, body: { code: 'TWO_FACTOR_UNAVAILABLE' } };
    return { ok: true, status: 200, body: { user: { id: 1, assessmentAccess: false } } };
  } });
  await page.event('login-form');
  page.nodes.get('login-two-factor-code').value = '123456';
  await page.event('login-two-factor-form');
  assert.match(page.nodes.get('login-two-factor-status').textContent, /Try an unused recovery code or contact support/);
  assert.equal(page.nodes.get('login-two-factor').hidden, false);
  await page.event('login-two-factor-switch', 'click');
  page.nodes.get('login-two-factor-code').value = backup;
  await page.event('login-two-factor-form');
  assert.equal(page.calls[2].values.challenge, challenge);
  assert.deepEqual(page.redirects, ['/client.html']);
});

test('expired or server-invalidated challenges require a fresh password login', async () => {
  const page = fixture();
  await page.event('login-form');
  page.advance(300001);
  assert.equal(page.nodes.get('login-form').hidden, false);
  assert.match(page.nodes.get('login-status').textContent, /expired/);
  page.nodes.get('login-two-factor-code').value = '123456';
  await page.event('login-two-factor-form');
  assert.equal(page.calls.length, 1);
  for (const errorCode of ['TWO_FACTOR_CHALLENGE_INVALID', 'SECURITY_STATE_CHANGED']) {
    const invalid = fixture({ fetcher: async (url, options, { time }) => url === '/api/login'
      ? { ok: true, status: 202, body: { twoFactorRequired: true, challenge, expiresAt: time + 300000 } }
      : { ok: false, status: 400, body: { code: errorCode } } });
    await invalid.event('login-form');
    invalid.nodes.get('login-two-factor-code').value = '123456';
    await invalid.event('login-two-factor-form');
    assert.equal(invalid.nodes.get('login-form').hidden, false);
    assert.equal(invalid.nodes.get('login-two-factor-code').value, '');
    assert.equal(invalid.nodes.get('login-button').disabled, false);
    assert.deepEqual(invalid.redirects, []);
  }
});

test('verification blocks duplicate submissions and cancellation while a proof is in flight', async () => {
  let finish;
  const page = fixture({ fetcher: (url, options, { time }) => url === '/api/login'
    ? { ok: true, status: 202, body: { twoFactorRequired: true, challenge, expiresAt: time + 300000 } }
    : new Promise(resolve => { finish = resolve; }) });
  await page.event('login-form');
  page.nodes.get('login-two-factor-code').value = '123456';
  const pending = page.event('login-two-factor-form');
  assert.equal(page.nodes.get('login-two-factor-cancel').disabled, true);
  await page.event('login-two-factor-cancel', 'click');
  await page.event('login-two-factor-form');
  assert.equal(page.calls.length, 2);
  assert.equal(page.nodes.get('login-two-factor').hidden, false);
  finish({ ok: false, status: 400, body: { code: 'TWO_FACTOR_INVALID' } });
  await pending;
  assert.equal(page.nodes.get('login-two-factor-cancel').disabled, false);
});

test('leaving the page clears credentials and ordinary login retains agreement routing', async () => {
  const challengePage = fixture();
  await challengePage.event('login-form');
  challengePage.nodes.get('login-two-factor-code').value = backup;
  challengePage.pagehide();
  assert.equal(challengePage.nodes.get('login-two-factor-code').value, '');
  assert.equal(challengePage.nodes.get('login-password').value, '');
  assert.equal(challengePage.timers.size, 0);
  const normal = fixture({ fetcher: async url => url === '/api/login'
    ? { ok: true, status: 200, body: { user: { id: 1, assessmentAccess: true } } }
    : { ok: true, status: 200, body: { assessmentPassed: true, status: 'awaiting-signature' } } });
  await normal.event('login-form');
  assert.deepEqual(normal.calls.map(call => call.url), ['/api/login', '/api/contract']);
  assert.deepEqual(normal.redirects, ['/contract.html']);
});

test('registration keeps its profile normalization and bypasses login-only verification controls', async () => {
  const page = fixture({ registration: true, fetcher: async () => ({ ok: true, status: 201, body: { user: { id: 2 } } }) });
  await page.event('interest-form');
  assert.equal(page.calls[0].url, '/api/register');
  assert.deepEqual(page.calls[0].values, {
    email: 'trader@example.com', password: 'a long original password', firstName: 'Ada', otherNames: 'Jane Jones', market: 'forex', consent: true,
  });
  assert.deepEqual(page.redirects, ['/client.html']);
  assert.equal(page.nodes.get('login-two-factor').hidden, true);
});

test('login and password-reset copy explain recovery without suggesting an email bypass', () => {
  assert.match(html, /autocomplete="one-time-code"/);
  assert.match(html, /inputmode="numeric"/);
  assert.match(html, /id="login-form" method="post" action="\/api\/login"/);
  assert.match(html, /id="login-two-factor"[^>]*hidden/);
  assert.match(html, /A password reset does not turn off two-factor authentication/);
  const resetHtml = readFileSync(new URL('../public/reset-password.html', import.meta.url), 'utf8');
  const resetScript = readFileSync(new URL('../public/password-recovery.js', import.meta.url), 'utf8');
  assert.match(resetHtml, /If two-factor authentication is enabled, you will still need your authenticator app or an unused recovery code/);
  assert.match(resetScript, /If two-factor authentication is enabled, you will still need your authenticator app or an unused recovery code/);
});
