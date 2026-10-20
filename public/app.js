const toggle = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
toggle?.addEventListener('click', () => {
  const expanded = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(expanded));
  navigation?.classList.toggle('open', expanded);
});
navigation?.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
  toggle?.setAttribute('aria-expanded', 'false');
  navigation.classList.remove('open');
}));
async function authRequest(endpoint, data) {
  const response = await fetch(endpoint, { method: 'POST', credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(15000), headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy' }, body: JSON.stringify(data) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(result.error || 'We couldn’t complete your request. Please try again.');
    error.code = result.code;
    throw error;
  }
  return result;
}
async function loginDestination(user) {
  if (user?.assessmentAccess === false) return '/client.html';
  try {
    const response = await fetch('/api/contract', { signal: AbortSignal.timeout(2500) });
    if (response.ok) {
      const progress = await response.json();
      if (progress.assessmentPassed && progress.status !== 'signed') return '/contract.html';
    }
  } catch {
    // A successful login still opens the dashboard if optional agreement status is unavailable.
  }
  return '/client.html';
}

function twoFactorLogin() {
  const form = document.getElementById('login-form');
  const panel = document.getElementById('login-two-factor');
  const verification = document.getElementById('login-two-factor-form');
  if (!form || !panel || !verification) return null;
  const password = form.elements.namedItem('password');
  const loginButton = form.querySelector('button[type="submit"]');
  const loginStatus = form.querySelector('[role="status"]');
  const code = document.getElementById('login-two-factor-code');
  const label = document.getElementById('login-two-factor-label');
  const hint = document.getElementById('login-two-factor-hint');
  const status = document.getElementById('login-two-factor-status');
  const submit = verification.querySelector('button[type="submit"]');
  const switchMode = document.getElementById('login-two-factor-switch');
  const cancel = document.getElementById('login-two-factor-cancel');
  let challenge = null;
  let expiresAt = 0;
  let expirationTimer = null;
  let pending = false;
  let recoveryMode = false;
  let revision = 0;

  function clearChallenge() {
    challenge = null;
    expiresAt = 0;
    revision += 1;
    clearTimeout(expirationTimer);
    expirationTimer = null;
    code.value = '';
    code.setCustomValidity('');
    password.value = '';
  }

  function passwordStep(message = '') {
    clearChallenge();
    panel.hidden = true;
    form.hidden = false;
    pending = false;
    submit.disabled = switchMode.disabled = cancel.disabled = false;
    verification.removeAttribute('aria-busy');
    loginButton.disabled = false;
    loginStatus.textContent = message;
    password.focus();
  }

  function changeMode(recovery) {
    recoveryMode = recovery;
    code.value = '';
    code.setCustomValidity('');
    code.setAttribute('inputmode', recovery ? 'text' : 'numeric');
    code.setAttribute('maxlength', recovery ? '64' : '6');
    if (recovery) code.removeAttribute('pattern');
    else code.setAttribute('pattern', '[0-9]{6}');
    label.textContent = recovery ? 'Unused recovery code' : 'Authenticator code';
    hint.textContent = recovery
      ? 'Enter one of the recovery codes saved when you enabled two-factor authentication. Each code works once; spaces and hyphens are accepted.'
      : 'Enter the current 6-digit code from your authenticator app.';
    switchMode.textContent = recovery ? 'Use an authenticator code' : 'Use a recovery code';
    switchMode.setAttribute('aria-pressed', String(recovery));
    status.textContent = '';
  }

  function expired() {
    if (!challenge || Date.now() < expiresAt) return false;
    passwordStep('This sign-in request has expired. Enter your password again to continue.');
    return true;
  }

  code.addEventListener('input', () => code.setCustomValidity(''));
  switchMode.addEventListener('click', () => {
    if (pending || expired()) return;
    changeMode(!recoveryMode);
    code.focus();
  });
  cancel.addEventListener('click', () => {
    if (pending) return;
    const cancelled = challenge;
    passwordStep('Sign-in verification cancelled.');
    if (cancelled) authRequest('/api/login/2fa/cancel', { challenge: cancelled }).catch(() => {
      // The local challenge is already cleared; the server also expires it after five minutes.
    });
  });
  verification.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || !challenge || expired()) return;
    const value = recoveryMode ? code.value.replace(/[\s-]/g, '').toLowerCase() : code.value.trim();
    const valid = recoveryMode ? /^[a-f0-9]{32}$/.test(value) : /^[0-9]{6}$/.test(value);
    code.setCustomValidity(valid ? '' : recoveryMode ? 'Enter a complete 32-character recovery code.' : 'Enter the 6-digit code from your authenticator app.');
    if (!verification.reportValidity()) return;
    pending = true;
    submit.disabled = switchMode.disabled = cancel.disabled = true;
    verification.setAttribute('aria-busy', 'true');
    status.textContent = 'Checking your code…';
    const currentRevision = revision;
    try {
      const request = authRequest('/api/login/2fa', { challenge, code: value });
      code.value = '';
      const result = await request;
      if (currentRevision !== revision) return;
      if (!result.user || typeof result.user !== 'object') throw new Error('We couldn’t complete sign-in. Please start again.');
      clearChallenge();
      status.textContent = 'Opening your dashboard…';
      window.location.assign(await loginDestination(result.user));
    } catch (error) {
      if (currentRevision !== revision) return;
      if (['TWO_FACTOR_CHALLENGE_INVALID', 'SECURITY_STATE_CHANGED'].includes(error.code)) {
        passwordStep('This sign-in request is no longer available. Enter your password again to continue.');
        return;
      }
      status.textContent = error.code === 'TWO_FACTOR_RATE_LIMITED'
        ? 'Too many unsuccessful attempts. Wait 15 minutes, then start sign-in again.'
        : error.code === 'TWO_FACTOR_UNAVAILABLE'
          ? 'Authenticator verification is temporarily unavailable. Try an unused recovery code or contact support.'
        : error.code === 'TWO_FACTOR_INVALID'
          ? recoveryMode ? 'That recovery code is invalid or has already been used. Try an unused code.' : 'That code is invalid or has already been used. Wait for a new code in your authenticator app, then try again.'
          : 'We couldn’t confirm sign-in. Check your connection and try again. If this request has already completed, start sign-in again.';
      code.focus();
    } finally {
      if (currentRevision === revision) {
        pending = false;
        submit.disabled = switchMode.disabled = cancel.disabled = false;
        verification.removeAttribute('aria-busy');
      }
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) expired();
  });
  window.addEventListener('pagehide', () => {
    if (challenge) passwordStep();
    password.value = '';
  });

  return {
    begin(result) {
      if (typeof result.challenge !== 'string' || !/^[a-f0-9]{64}$/.test(result.challenge)) throw new Error('We couldn’t start verification. Please sign in again.');
      const expiry = Number(result.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= Date.now()) throw new Error('This sign-in request has expired. Please sign in again.');
      clearChallenge();
      challenge = result.challenge;
      expiresAt = expiry;
      changeMode(false);
      form.hidden = true;
      panel.hidden = false;
      loginStatus.textContent = '';
      expirationTimer = setTimeout(expired, Math.max(0, expiresAt - Date.now()));
      code.focus();
    },
  };
}
const loginVerification = twoFactorLogin();
for (const [id, endpoint] of [['interest-form', '/api/register'], ['login-form', '/api/login']]) {
  const form = document.getElementById(id);
  const firstName = form?.elements.namedItem('firstName');
  const otherNames = form?.elements.namedItem('otherNames');
  const cleanName = value => value.trim().replace(/\s+/gu, ' ');
  function validateNameLength() {
    if (!firstName) return;
    const name = [cleanName(firstName.value), cleanName(otherNames?.value || '')].filter(Boolean).join(' ');
    firstName.setCustomValidity(name.length > 100 ? 'Your first name and other names together must be 100 characters or fewer.' : '');
  }
  firstName?.addEventListener('input', validateNameLength);
  otherNames?.addEventListener('input', validateNameLength);
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    validateNameLength();
    if (!form.reportValidity()) return;
    const button = form.querySelector('button[type="submit"]');
    const status = form.querySelector('[role="status"]');
    button.disabled = true; status.textContent = 'Connecting…';
    try {
      const values = Object.fromEntries(new FormData(form));
      const data = { email: values.email.trim(), password: values.password };
      if (endpoint === '/api/register') {
        data.firstName = cleanName(values.firstName);
        data.otherNames = cleanName(values.otherNames || '');
        data.market = values.experience;
        data.consent = values.consent === 'on';
      }
      const result = await authRequest(endpoint, data);
      if (endpoint === '/api/login') {
        form.elements.namedItem('password').value = '';
        data.password = values.password = '';
        if (result.twoFactorRequired) {
          if (!loginVerification) throw new Error('Verification could not load. Reload this page and sign in again.');
          loginVerification.begin(result);
          return;
        }
      }
      status.textContent = 'Opening your dashboard…';
      window.location.assign(endpoint === '/api/login' ? await loginDestination(result.user) : '/client.html');
    } catch (error) { status.textContent = error.message; button.disabled = false; }
  });
}
const year = document.querySelector('#year');
if (year) year.textContent = String(new Date().getFullYear());

// Load support independently so it never delays registration or the trading desk.
const supportLauncher = document.createElement('a');
supportLauncher.id = 'academy-support-launcher';
supportLauncher.href = '/support.html';
supportLauncher.className = 'fixed bottom-4 right-4 z-40 inline-flex items-center gap-2 rounded-full border border-lime/30 bg-lime px-5 py-3 text-sm font-semibold text-black shadow-xl';
supportLauncher.textContent = 'Support';
supportLauncher.setAttribute('aria-label', 'Open Fundraiser Academy customer support');
document.body.append(supportLauncher);
import('/support-chat.js').then(module => module.initSupportChat(supportLauncher)).catch(() => {
  // The ordinary support-page link remains usable if the widget cannot load.
});
