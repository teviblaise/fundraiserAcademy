import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const html = readFileSync(new URL('../public/security.html', import.meta.url), 'utf8');
const script = readFileSync(new URL('../public/security.js', import.meta.url), 'utf8');
const codes = Array.from({ length: 10 }, (_, i) => `${String(i).padStart(8, '0')}-1234ABCD-01234567-89ABCDEF`);
const accountSecurity = (enabled = false, sessions = [
  { id: 'current-session', current: true, browser: 'Chrome', device: 'Linux', createdAt: null, lastSeenAt: Date.now(), expiresAt: Date.now() + 100000 },
  { id: 'other-session', current: false, browser: 'Safari', device: 'iPhone', createdAt: Date.now(), lastSeenAt: Date.now(), expiresAt: Date.now() + 100000 },
]) => ({ twoFactor: { enabled, enrollmentAllowed: true, enabledAt: enabled ? Date.now() : null, enrollmentPending: false, enrollmentExpiresAt: null, recoveryCodesRemaining: enabled ? 10 : 0 }, sessions, sessionsTotal: sessions.length, absoluteLifetimeMs: 7 * 86400000, idleTimeoutMs: 86400000, sessionListLimit: 200 });

class Element {
  constructor(tagName = 'div', id = '') {
    this.tagName = tagName; this.id = id; this.children = []; this.attributes = new Map(); this.listeners = new Map();
    this.value = ''; this._text = ''; this.hidden = false; this.disabled = false; this.required = false; this.checked = false; this.open = false;
    this.classList = { toggle() {} };
  }
  set textContent(value) { this._text = String(value); this.children = []; }
  get textContent() { return this._text + this.children.map(child => child.textContent).join(''); }
  set innerHTML(_) { throw new Error('Unsafe HTML rendering is forbidden.'); }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name); }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') delete this.src; }
  addEventListener(name, callback) { this.listeners.set(name, [...(this.listeners.get(name) || []), callback]); }
  async event(name, extra = {}) { for (const callback of this.listeners.get(name) || []) await callback({ preventDefault() {}, currentTarget: this, ...extra }); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this._text = ''; this.children = nodes; }
  querySelectorAll(name) { return this.children.flatMap(child => [...(child.tagName === name ? [child] : []), ...child.querySelectorAll(name)]); }
  focus() { this.focused = true; }
  showModal() { this.open = true; }
  close() { this.open = false; this.event('close'); }
  click() { return this.event('click'); }
  remove() { this.removed = true; }
}

function fixture({ security = accountSecurity(), fetcher } = {}) {
  const nodes = new Map();
  for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
    const element = new Element(match[1], match[3]);
    element.hidden = /\bhidden(?:\s|$|=)/.test(match[2]);
    element.required = /\brequired(?:\s|$|=)/.test(match[2]);
    nodes.set(element.id, element);
  }
  const formFields = {
    'setup-two-factor-form': ['setup-password'],
    'confirm-two-factor-form': ['confirm-setup-password', 'authenticator-code'],
    'security-action-form': ['security-action-password', 'security-action-code'],
  };
  for (const [id, fields] of Object.entries(formFields)) nodes.get(id).reportValidity = () => fields.every(field => {
    const node = nodes.get(field);
    return !node.required || (node.value && (field !== 'authenticator-code' || /^\d{6}$/.test(node.value)));
  });
  const documentListeners = new Map();
  const windowListeners = new Map();
  const intervals = new Map();
  const timeouts = [];
  const copies = [];
  const downloads = [];
  const revokedUrls = [];
  const redirects = [];
  const calls = [];
  let nextTimer = 1;
  const document = {
    hidden: false, body: new Element('body'),
    getElementById: id => nodes.get(id) || null,
    createElement: name => new Element(name),
    addEventListener: (name, callback) => documentListeners.set(name, callback),
  };
  const window = {
    location: { replace: url => redirects.push(url) },
    addEventListener: (name, callback) => windowListeners.set(name, callback),
  };
  vm.runInNewContext(script, {
    document, window, AbortSignal, Blob,
    URL: { createObjectURL: blob => { downloads.push(blob); return `blob:test-${downloads.length}`; }, revokeObjectURL: url => revokedUrls.push(url) },
    navigator: { clipboard: { writeText: async value => copies.push(value) } },
    setInterval: callback => { const id = nextTimer++; intervals.set(id, callback); return id; },
    clearInterval: id => intervals.delete(id),
    setTimeout: callback => { timeouts.push(callback); return timeouts.length; },
    fetch: async (endpoint, options) => {
      calls.push({ endpoint, options });
      const result = fetcher ? await fetcher(endpoint, options) : endpoint === '/api/security'
        ? security
        : endpoint === '/api/security/2fa/setup'
          ? { secret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', qrDataUrl: 'data:image/png;base64,aGVsbG8=', expiresAt: Date.now() + 300000 }
          : { recoveryCodes: codes, security: accountSecurity(true) };
      return result?.response || { ok: true, status: 200, json: async () => result };
    },
  });
  return {
    nodes, calls, document, window, intervals, copies, downloads, revokedUrls, redirects,
    async settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); },
    async event(id, type = 'click') { await nodes.get(id).event(type); },
    async hidden() { document.hidden = true; await documentListeners.get('visibilitychange')?.(); },
    async visible() { document.hidden = false; await documentListeners.get('visibilitychange')?.(); },
    async pagehide() { await windowListeners.get('pagehide')?.({}); },
    async setup() { nodes.get('setup-password').value = 'a strong current passphrase'; await nodes.get('setup-two-factor-form').event('submit'); },
    async confirm() { nodes.get('confirm-setup-password').value = 'a strong current passphrase'; nodes.get('authenticator-code').value = '123456'; await nodes.get('confirm-two-factor-form').event('submit'); },
    async action(kind, code = '654321') { await nodes.get(kind).event('click'); nodes.get('security-action-password').value = 'a strong current passphrase'; nodes.get('security-action-code').value = code; await nodes.get('security-action-form').event('submit'); },
  };
}

test('security page isolates authentication secrets from third parties and browser storage', () => {
  assert.match(html, /connect-src 'self'/);
  assert.match(html, /img-src 'self' data:/);
  assert.match(html, /name="referrer" content="no-referrer"/);
  assert.doesNotMatch(html, /src="https?:|src="\/app\.js"|support-chat\.js/);
  assert.doesNotMatch(script, /localStorage|sessionStorage|console\.|innerHTML|insertAdjacentHTML/);
  assert.match(html, /autocomplete="current-password"/);
  assert.match(html, /Use a fresh code for each security change/);
});

test('sessions render untrusted device labels as text and describe legacy dates and actual listing limits honestly', async () => {
  const security = accountSecurity(false, [{ id: 'session', current: true, browser: '<img src=x onerror=alert(1)>', device: 'Unknown device', createdAt: null, lastSeenAt: Date.now(), expiresAt: Date.now() + 100000 }]);
  security.sessionsTotal = 203;
  const page = fixture({ security });
  await page.settle();
  assert.equal(page.nodes.get('security-main').hidden, false);
  const list = page.nodes.get('security-sessions');
  assert.match(list.textContent, /<img src=x onerror=alert\(1\)>/);
  assert.match(list.textContent, /Not recorded/);
  assert.equal(list.querySelectorAll('img').length, 0);
  assert.match(page.nodes.get('session-summary').textContent, /203 active sessions · Showing 1 recent session/);
  assert.match(page.nodes.get('session-expiry-policy').textContent, /7 days.*24 hours/);
  assert.equal(page.nodes.get('revoke-other-sessions').disabled, false);
});

test('authenticator setup does not enable protection until code proof and displays recovery codes once', async () => {
  const page = fixture();
  await page.settle();
  await page.setup();
  assert.equal(page.nodes.get('setup-password').value, '');
  assert.equal(page.nodes.get('two-factor-on').hidden, true);
  assert.equal(page.nodes.get('authenticator-enrollment').hidden, false);
  assert.match(page.nodes.get('authenticator-secret').textContent, /^[A-Z2-7]+$/);
  assert.equal(page.nodes.get('authenticator-qr').src, 'data:image/png;base64,aGVsbG8=');
  assert.equal(page.calls.at(-1).endpoint, '/api/security/2fa/setup');
  await page.confirm();
  assert.equal(page.calls.at(-1).endpoint, '/api/security/2fa/confirm');
  assert.equal(page.nodes.get('two-factor-on').hidden, false);
  assert.equal(page.nodes.get('confirm-setup-password').value, '');
  assert.equal(page.nodes.get('authenticator-code').value, '');
  assert.equal(page.nodes.get('authenticator-secret').textContent, '');
  assert.equal(page.nodes.get('authenticator-qr').src, undefined);
  assert.equal(page.nodes.get('recovery-codes').children.length, 10);
  await page.event('dismiss-recovery-codes');
  assert.equal(page.nodes.get('recovery-codes-panel').hidden, false);
  await page.event('copy-recovery-codes');
  assert.equal(page.copies.at(-1), codes.join('\n'));
  await page.event('download-recovery-codes');
  assert.match(await page.downloads[0].text(), /Each code can replace an authenticator code once/);
  page.nodes.get('recovery-codes-saved').checked = true;
  await page.event('recovery-codes-saved', 'change');
  await page.event('dismiss-recovery-codes');
  assert.equal(page.nodes.get('recovery-codes-panel').hidden, true);
  assert.equal(page.nodes.get('recovery-codes').children.length, 0);
  assert.equal(page.revokedUrls.length, 1);
  await page.event('copy-recovery-codes');
  assert.equal(page.copies.length, 1);
});

test('new authenticator enrollment is unavailable until actual email ownership is confirmed, including a pending enrollment', async () => {
  for (const pending of [false, true]) {
    const security = accountSecurity();
    security.twoFactor.enrollmentAllowed = false;
    security.twoFactor.enrollmentPending = pending;
    security.twoFactor.enrollmentExpiresAt = pending ? Date.now() + 300000 : null;
    const page = fixture({ security });
    await page.settle();
    assert.equal(page.nodes.get('two-factor-ownership-required').hidden, false);
    assert.equal(page.nodes.get('two-factor-off').hidden, true);
    assert.equal(page.nodes.get('setup-two-factor-form').hidden, true);
    assert.equal(page.nodes.get('authenticator-enrollment').hidden, true);
    assert.equal(page.nodes.get('setup-two-factor-button').disabled, true);
    assert.equal(page.nodes.get('confirm-two-factor-button').disabled, true);
    await page.setup();
    await page.confirm();
    assert.deepEqual(page.calls.map(call => call.endpoint), ['/api/security']);
    assert.equal(page.nodes.get('revoke-other-sessions').disabled, false);
    await page.event('revoke-other-sessions');
    assert.equal(page.nodes.get('security-action-dialog').open, true);
    assert.equal(page.nodes.get('security-action-factor').hidden, true);
  }
});

test('existing two-factor protection remains manageable when email ownership confirmation is unavailable', async () => {
  const security = accountSecurity(true);
  security.twoFactor.enrollmentAllowed = false;
  const page = fixture({ security });
  await page.settle();
  assert.equal(page.nodes.get('two-factor-ownership-required').hidden, true);
  assert.equal(page.nodes.get('two-factor-on').hidden, false);
  assert.equal(page.nodes.get('two-factor-off').hidden, true);
  assert.equal(page.nodes.get('regenerate-recovery-codes').disabled, false);
  assert.equal(page.nodes.get('disable-two-factor').disabled, false);
  await page.event('disable-two-factor');
  assert.equal(page.nodes.get('security-action-dialog').open, true);
  assert.equal(page.nodes.get('security-action-factor').hidden, false);
  assert.equal(page.nodes.get('security-action-code').required, true);
});

test('confirmation is requested explicitly, reports a queued email honestly, and never changes trade-email preferences', async () => {
  const security = accountSecurity();
  security.twoFactor.enrollmentAllowed = false;
  const page = fixture({ fetcher: async endpoint => endpoint === '/api/security' ? security : { user: { emailVerified: false }, confirmation: { available: true, queued: true, status: 'queued', cooldownUntil: Date.now() + 60000 } } });
  await page.settle();
  assert.deepEqual(page.calls.map(call => call.endpoint), ['/api/security']);
  await page.event('security-confirm-email');
  assert.equal(page.calls.at(-1).endpoint, '/api/email/resend-confirmation');
  assert.deepEqual(JSON.parse(page.calls.at(-1).options.body), {});
  assert.match(page.nodes.get('security-confirmation-status').textContent, /queued for delivery/);
  assert.doesNotMatch(page.nodes.get('security-confirmation-status').textContent, /delivered|has been sent/);
  assert.equal(page.nodes.get('security-confirm-email').disabled, true);
  assert.match(page.nodes.get('security-confirm-email').textContent, /Request again in \d+s/);
  assert.equal(page.nodes.get('setup-two-factor-form').hidden, true);
  await page.event('security-confirm-email');
  assert.deepEqual(page.calls.map(call => call.endpoint), ['/api/security', '/api/email/resend-confirmation']);
  assert.match(html, /Account confirmation does not turn on optional trade-alert emails/);
});

test('unavailable confirmation delivery has human-readable guidance without provider configuration details', async () => {
  for (const unavailable of [
    { user: { emailVerified: false }, confirmation: { available: false, queued: false, status: 'unavailable' } },
    { response: { ok: false, status: 400, json: async () => ({ error: 'Email delivery needs RESEND_API_KEY, EMAIL_FROM, and a public HTTPS APP_ORIGIN configured by the operator.' }) } },
  ]) {
    const security = accountSecurity();
    security.twoFactor.enrollmentAllowed = false;
    const page = fixture({ fetcher: async endpoint => endpoint === '/api/security' ? security : unavailable });
    await page.settle(); await page.event('security-confirm-email');
    const message = page.nodes.get('security-confirmation-status').textContent;
    assert.equal(message, 'Confirmation emails are not available yet. Your profile is saved. Try again later or contact the academy.');
    assert.doesNotMatch(message, /RESEND|EMAIL_FROM|APP_ORIGIN|queued|delivered/);
    assert.equal(page.nodes.get('security-confirm-email').disabled, false);
    assert.equal(page.nodes.get('setup-two-factor-form').hidden, true);
    assert.deepEqual(page.calls.map(call => call.endpoint), ['/api/security', '/api/email/resend-confirmation']);
  }
});

test('checking email ownership refreshes security without sending another email and unlocks enrollment only after proof', async () => {
  const security = accountSecurity();
  security.twoFactor.enrollmentAllowed = false;
  let confirmed = false;
  const page = fixture({ fetcher: async () => confirmed ? accountSecurity() : security });
  await page.settle(); await page.event('security-check-email');
  assert.match(page.nodes.get('security-confirmation-status').textContent, /not confirmed yet/);
  assert.equal(page.nodes.get('setup-two-factor-form').hidden, true);
  confirmed = true;
  await page.event('security-check-email');
  assert.equal(page.nodes.get('two-factor-ownership-required').hidden, true);
  assert.equal(page.nodes.get('setup-two-factor-form').hidden, false);
  assert.equal(page.nodes.get('setup-two-factor-button').disabled, false);
  assert.ok(page.calls.every(call => call.endpoint === '/api/security'));
});

test('hiding the page clears passwords, QR/setup key, and one-time codes, while allowing authenticator confirmation after an app switch', async () => {
  const page = fixture();
  await page.settle();
  await page.setup();
  page.nodes.get('confirm-setup-password').value = 'temporarily typed password';
  await page.hidden();
  assert.equal(page.nodes.get('confirm-setup-password').value, '');
  assert.equal(page.nodes.get('authenticator-secret').textContent, '');
  assert.equal(page.nodes.get('authenticator-qr').src, undefined);
  assert.equal(page.nodes.get('authenticator-enrollment').hidden, false);
  assert.match(page.nodes.get('enrollment-expiry').textContent, /can still confirm a code/);
  await page.visible();
  await page.confirm();
  assert.equal(page.nodes.get('recovery-codes-panel').hidden, false);
  await page.hidden();
  assert.equal(page.nodes.get('recovery-codes-panel').hidden, true);
  assert.equal(page.nodes.get('recovery-codes').children.length, 0);
  assert.match(page.nodes.get('security-status').textContent, /generate a new set/);
  await page.pagehide();
  assert.equal(page.nodes.get('authenticator-enrollment').hidden, true);
  assert.equal(page.intervals.size, 0);
});

test('a response arriving after the page was hidden cannot reveal fresh recovery codes', async () => {
  let finish;
  const page = fixture({ fetcher: async endpoint => {
    if (endpoint === '/api/security') return accountSecurity();
    if (endpoint.endsWith('/setup')) return { secret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', expiresAt: Date.now() + 300000 };
    return await new Promise(resolve => { finish = resolve; });
  } });
  await page.settle(); await page.setup();
  const pending = page.confirm();
  await page.settle();
  await page.hidden();
  finish({ recoveryCodes: codes, security: accountSecurity(true) });
  await pending;
  assert.equal(page.nodes.get('two-factor-on').hidden, false);
  assert.equal(page.nodes.get('recovery-codes-panel').hidden, true);
  assert.equal(page.nodes.get('recovery-codes').children.length, 0);
  assert.match(page.nodes.get('security-status').textContent, /one-time recovery codes were cleared/);
});

test('management requires a current password and second factor only when enabled, with no code persisted after a failure', async () => {
  const page = fixture({ security: accountSecurity(true), fetcher: async endpoint => endpoint === '/api/security' ? accountSecurity(true) : { response: { ok: false, status: 401, json: async () => ({ error: 'Your current password is incorrect.', code: 'PASSWORD_REAUTHENTICATION_FAILED' }) } } });
  await page.settle();
  await page.event('regenerate-recovery-codes');
  assert.equal(page.nodes.get('security-action-dialog').open, true);
  assert.equal(page.nodes.get('security-action-factor').hidden, false);
  assert.equal(page.nodes.get('security-action-code').required, true);
  page.nodes.get('security-action-password').value = 'incorrect current passphrase';
  await page.event('security-action-form', 'submit');
  assert.equal(page.calls.length, 1);
  page.nodes.get('security-action-code').value = codes[0];
  await page.event('security-action-form', 'submit');
  assert.equal(page.calls.at(-1).endpoint, '/api/security/2fa/recovery-codes');
  const values = JSON.parse(page.calls.at(-1).options.body);
  assert.equal(values.code, codes[0]);
  assert.equal(page.nodes.get('security-action-password').value, '');
  assert.equal(page.nodes.get('security-action-code').value, '');
  assert.match(page.nodes.get('security-action-status').textContent, /password is incorrect/);
  assert.deepEqual(page.redirects, []);
});

test('revoked sessions clear existing recovery codes and return to login, while normal current-device logout needs no password', async () => {
  let revoked = false;
  const page = fixture({ fetcher: async endpoint => {
    if (revoked) return { response: { ok: false, status: 401, json: async () => ({ error: 'Please log in again.' }) } };
    if (endpoint === '/api/security') return accountSecurity();
    if (endpoint.endsWith('/setup')) return { secret: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567', expiresAt: Date.now() + 300000 };
    return { recoveryCodes: codes, security: accountSecurity(true) };
  } });
  await page.settle(); await page.setup(); await page.confirm();
  revoked = true;
  await page.event('refresh-security');
  assert.equal(page.nodes.get('recovery-codes').children.length, 0);
  assert.equal(page.nodes.get('authenticator-secret').textContent, '');
  assert.equal(page.redirects.at(-1), '/login.html');
  const logoutPage = fixture(); await logoutPage.settle();
  await logoutPage.nodes.get('security-sessions').querySelectorAll('button')[0].event('click');
  assert.equal(logoutPage.calls.at(-1).endpoint, '/api/logout');
  assert.deepEqual(JSON.parse(logoutPage.calls.at(-1).options.body), {});
  assert.equal(logoutPage.redirects.at(-1), '/login.html');
});

test('session revocation sends the opaque session ID and a backup code, and all-device logout clears local secrets', async () => {
  const page = fixture({ security: accountSecurity(true), fetcher: async endpoint => endpoint === '/api/security' ? accountSecurity(true) : endpoint.endsWith('/revoke-all') ? { signedOut: true, security: null } : { message: 'Selected sessions have been signed out.', security: accountSecurity(true, [accountSecurity(true).sessions[0]]) } });
  await page.settle();
  await page.nodes.get('security-sessions').querySelectorAll('button')[1].event('click');
  page.nodes.get('security-action-password').value = 'a strong current passphrase';
  page.nodes.get('security-action-code').value = codes[0];
  await page.event('security-action-form', 'submit');
  assert.equal(page.calls.at(-1).endpoint, '/api/security/sessions/revoke');
  assert.deepEqual(JSON.parse(page.calls.at(-1).options.body), { password: 'a strong current passphrase', code: codes[0], sessionId: 'other-session' });
  assert.equal(page.nodes.get('revoke-other-sessions').disabled, true);
  await page.action('revoke-all-sessions', codes[1]);
  assert.equal(page.calls.at(-1).endpoint, '/api/security/sessions/revoke-all');
  assert.equal(page.redirects.at(-1), '/login.html');
});

test('a refresh in flight blocks competing writes and resumes actions after the authoritative snapshot arrives', async () => {
  let complete;
  let reads = 0;
  const page = fixture({ fetcher: async endpoint => {
    if (endpoint === '/api/security' && ++reads === 2) return await new Promise(resolve => { complete = resolve; });
    return accountSecurity();
  } });
  await page.settle();
  const pending = page.event('refresh-security'); await page.settle();
  page.nodes.get('setup-password').value = 'a strong current passphrase';
  await page.event('setup-two-factor-form', 'submit');
  await page.event('revoke-all-sessions');
  assert.equal(page.calls.length, 2);
  assert.equal(page.nodes.get('security-action-dialog').open, false);
  complete(accountSecurity()); await pending;
  assert.equal(page.nodes.get('setup-two-factor-button').disabled, false);
  await page.event('revoke-all-sessions');
  assert.equal(page.nodes.get('security-action-dialog').open, true);
});
