import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

const script = readFileSync(new URL('../public/password-recovery.js', import.meta.url), 'utf8');
const resetHtml = readFileSync(new URL('../public/reset-password.html', import.meta.url), 'utf8');
const token = 'a'.repeat(64);

function fixture(kind, { resetToken = token, fetcher } = {}) {
  const ids = kind === 'forgot'
    ? ['year', 'forgot-password-form', 'recovery-email', 'request-reset-button', 'recovery-status', 'recovery-next-steps', 'recovery-try-again']
    : ['year', 'reset-password-form', 'new-password', 'confirm-password', 'toggle-passwords', 'save-password-button', 'reset-status', 'password-match', 'reset-request-link', 'reset-login-link', 'reset-introduction', 'reset-title'];
  const nodes = new Map(ids.map(id => [id, {
    value: '', textContent: '', hidden: false, disabled: false, type: 'password',
    listeners: new Map(), attributes: new Map(), validityMessage: '',
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    setAttribute(name, value) { this.attributes.set(name, value); },
    removeAttribute(name) { this.attributes.delete(name); },
    setCustomValidity(message) { this.validityMessage = message; },
    focus() { this.focused = true; },
    reportValidity() {
      return kind === 'reset'
        ? ['new-password', 'confirm-password'].every(name => nodes.get(name).value && !nodes.get(name).validityMessage)
        : Boolean(nodes.get('recovery-email').value);
    },
  }]));
  const calls = [];
  const window = { __faPasswordResetToken: resetToken };
  vm.runInNewContext(script, {
    document: { getElementById: id => nodes.get(id) || null }, window, AbortSignal,
    fetch: async (...args) => {
      calls.push(args);
      return fetcher ? fetcher(...args) : { ok: true, status: 200, json: async () => ({}) };
    },
  });
  return {
    nodes, calls, window,
    async event(id, type = 'submit') {
      return nodes.get(id).listeners.get(type)?.({ preventDefault() {} });
    },
  };
}

test('reset fragment is removed before any resource and its inline script matches the CSP hash', () => {
  const inline = /<script>([\s\S]*?)<\/script>/.exec(resetHtml);
  assert.ok(inline);
  assert.ok(resetHtml.indexOf(inline[0]) < resetHtml.indexOf('<link '));
  assert.ok(resetHtml.indexOf(inline[0]) < resetHtml.indexOf('src="/password-recovery.js"'));
  const hash = createHash('sha256').update(inline[1]).digest('base64');
  assert.ok(resetHtml.includes(`'sha256-${hash}'`));
  const window = {};
  let replaced;
  vm.runInNewContext(inline[1], {
    location: { hash: `#token=${token}`, pathname: '/reset-password.html', search: '?untrusted=query' },
    history: { replaceState: (...args) => { replaced = args; } }, window, URLSearchParams,
  });
  assert.equal(window.__faPasswordResetToken, token);
  assert.equal(replaced[2], '/reset-password.html');
  assert.match(resetHtml, /name="referrer" content="no-referrer"/);
  assert.doesNotMatch(resetHtml, /src="https?:|src="\/app\.js"/);
});

test('opening valid or invalid links never automatically consumes a reset token', () => {
  const valid = fixture('reset');
  assert.equal(valid.calls.length, 0);
  assert.equal(valid.nodes.get('reset-password-form').hidden, false);
  assert.equal('__faPasswordResetToken' in valid.window, false);
  for (const resetToken of [null, '', 'bad-token']) {
    const invalid = fixture('reset', { resetToken });
    assert.equal(invalid.calls.length, 0);
    assert.equal(invalid.nodes.get('reset-password-form').hidden, true);
    assert.equal(invalid.nodes.get('reset-request-link').hidden, false);
    assert.match(invalid.nodes.get('reset-status').textContent, /invalid or has expired/);
  }
});

test('reset requires matching passphrases, counts Unicode characters, and clears secrets after success', async () => {
  const page = fixture('reset');
  const password = page.nodes.get('new-password');
  const confirmation = page.nodes.get('confirm-password');
  password.value = 'short';
  confirmation.value = 'short';
  await page.event('reset-password-form');
  assert.equal(page.calls.length, 0);
  password.value = '🔐'.repeat(15);
  confirmation.value = 'different passphrase';
  await page.event('reset-password-form');
  assert.equal(page.calls.length, 0);
  confirmation.value = password.value;
  await page.event('reset-password-form');
  assert.equal(page.calls.length, 1);
  assert.equal(page.calls[0][0], '/api/password/reset');
  assert.deepEqual(JSON.parse(page.calls[0][1].body), { token, password: '🔐'.repeat(15) });
  assert.equal(password.value, '');
  assert.equal(confirmation.value, '');
  assert.equal(page.nodes.get('reset-password-form').hidden, true);
  assert.match(page.nodes.get('reset-status').textContent, /All previous sessions have been signed out/);
  await page.event('reset-password-form');
  assert.equal(page.calls.length, 1);
});

test('forgot-password success always uses the same account-private message', async () => {
  for (const returned of [{ exists: true, message: 'known account' }, { exists: false, message: 'unknown account' }]) {
    const page = fixture('forgot', { fetcher: async () => ({ ok: true, status: 202, json: async () => returned }) });
    page.nodes.get('recovery-email').value = ' trader@example.com ';
    await page.event('forgot-password-form');
    assert.equal(page.calls[0][0], '/api/password/forgot');
    assert.deepEqual(JSON.parse(page.calls[0][1].body), { email: 'trader@example.com' });
    assert.equal(page.nodes.get('recovery-status').textContent, 'If an account exists for that email, we’ll send a password reset link. Check your inbox and spam folder.');
    assert.equal(page.nodes.get('forgot-password-form').hidden, true);
    assert.equal(page.nodes.get('recovery-next-steps').hidden, false);
  }
});
