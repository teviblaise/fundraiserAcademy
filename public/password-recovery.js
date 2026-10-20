(() => {
  'use strict';
  const year = document.getElementById('year');
  if (year) year.textContent = String(new Date().getFullYear());

  const genericRecoveryMessage = 'If an account exists for that email, we’ll send a password reset link. Check your inbox and spam folder.';
  const invalidLinkMessage = 'This password reset link is invalid or has expired. Request a new link.';

  async function request(endpoint, values) {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy' },
      credentials: 'same-origin',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(15000),
      body: JSON.stringify(values),
    });
    const result = await response.json().catch(() => ({}));
    return { response, result };
  }

  const forgotForm = document.getElementById('forgot-password-form');
  if (forgotForm) {
    const email = document.getElementById('recovery-email');
    const button = document.getElementById('request-reset-button');
    const status = document.getElementById('recovery-status');
    const nextSteps = document.getElementById('recovery-next-steps');
    let pending = false;
    forgotForm.addEventListener('submit', async event => {
      event.preventDefault();
      if (pending || !forgotForm.reportValidity()) return;
      pending = true;
      button.disabled = true;
      button.textContent = 'Sending request…';
      forgotForm.setAttribute('aria-busy', 'true');
      status.textContent = 'Requesting a secure reset link…';
      try {
        const { response } = await request('/api/password/forgot', { email: email.value.trim() });
        if (!response.ok) throw new Error('Request failed');
        // Use the same message for every address and never expose account lookup results.
        status.textContent = genericRecoveryMessage;
        forgotForm.hidden = true;
        nextSteps.hidden = false;
        status.focus();
      } catch {
        status.textContent = 'We couldn’t complete your request. Check your connection and try again shortly.';
        status.focus();
      } finally {
        pending = false;
        button.disabled = false;
        button.textContent = 'Send a reset link';
        forgotForm.removeAttribute('aria-busy');
      }
    });
    document.getElementById('recovery-try-again').addEventListener('click', () => {
      nextSteps.hidden = true;
      forgotForm.hidden = false;
      status.textContent = '';
      email.focus();
    });
  }

  const resetForm = document.getElementById('reset-password-form');
  if (!resetForm) return;
  // The head script removes the fragment before any stylesheet, image, or other script loads.
  let token = window.__faPasswordResetToken;
  delete window.__faPasswordResetToken;
  const password = document.getElementById('new-password');
  const confirmation = document.getElementById('confirm-password');
  const showPasswords = document.getElementById('toggle-passwords');
  const button = document.getElementById('save-password-button');
  const status = document.getElementById('reset-status');
  const match = document.getElementById('password-match');
  const requestLink = document.getElementById('reset-request-link');
  const loginLink = document.getElementById('reset-login-link');
  const introduction = document.getElementById('reset-introduction');
  let pending = false;

  function unusableLink() {
    token = null;
    password.value = '';
    confirmation.value = '';
    resetForm.hidden = true;
    introduction.hidden = true;
    status.textContent = invalidLinkMessage;
    requestLink.hidden = false;
  }

  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) {
    unusableLink();
    return;
  }
  resetForm.hidden = false;

  function validatePasswords() {
    const length = Array.from(password.value).length;
    password.setCustomValidity(length && length < 15 ? 'Use at least 15 characters.' : length > 128 ? 'Use 128 characters or fewer.' : '');
    const different = Boolean(confirmation.value && password.value !== confirmation.value);
    confirmation.setCustomValidity(different ? 'Your passwords do not match.' : '');
    confirmation.setAttribute('aria-invalid', String(different));
    const message = confirmation.value ? different ? 'Passwords do not match yet.' : 'Passwords match.' : '';
    if (match.textContent !== message) match.textContent = message;
  }
  password.addEventListener('input', validatePasswords);
  confirmation.addEventListener('input', validatePasswords);
  showPasswords.addEventListener('click', () => {
    const show = password.type === 'password';
    password.type = confirmation.type = show ? 'text' : 'password';
    showPasswords.setAttribute('aria-pressed', String(show));
    showPasswords.textContent = show ? 'Hide passwords' : 'Show passwords';
  });

  resetForm.addEventListener('submit', async event => {
    event.preventDefault();
    if (pending || !token) return;
    validatePasswords();
    if (!resetForm.reportValidity()) return;
    pending = true;
    button.disabled = true;
    showPasswords.disabled = true;
    password.readOnly = confirmation.readOnly = true;
    resetForm.setAttribute('aria-busy', 'true');
    button.textContent = 'Saving password…';
    status.textContent = 'Securing your account…';
    try {
      const { response, result } = await request('/api/password/reset', { token, password: password.value });
      if (!response.ok) {
        if (result.code === 'PASSWORD_RESET_INVALID') {
          unusableLink();
          status.focus();
          return;
        }
        const error = new Error('Request failed');
        error.userMessage = response.status === 400 && typeof result.error === 'string' ? result.error : 'We couldn’t update your password. Please try again shortly.';
        throw error;
      }
      token = null;
      password.value = '';
      confirmation.value = '';
      password.type = confirmation.type = 'password';
      resetForm.hidden = true;
      introduction.hidden = true;
      document.getElementById('reset-title').textContent = 'Password updated.';
      status.textContent = 'Your password has been changed. All previous sessions have been signed out. Sign in with your new password to continue. If two-factor authentication is enabled, you will still need your authenticator app or an unused recovery code.';
      loginLink.textContent = 'Sign in with your new password →';
      loginLink.className = 'button mt-6';
      status.focus();
    } catch (error) {
      status.textContent = error.userMessage || 'We couldn’t complete your request. Check your connection and try again. If your link has already been used, request a new one.';
      requestLink.hidden = false;
      status.focus();
    } finally {
      pending = false;
      button.disabled = false;
      showPasswords.disabled = false;
      password.readOnly = confirmation.readOnly = false;
      resetForm.removeAttribute('aria-busy');
      button.textContent = 'Save new password';
    }
  });
})();
