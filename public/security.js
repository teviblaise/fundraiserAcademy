(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const status = byId('security-status');
  const setupPassword = byId('setup-password');
  const confirmPassword = byId('confirm-setup-password');
  const confirmCode = byId('authenticator-code');
  const actionPassword = byId('security-action-password');
  const actionCode = byId('security-action-code');
  const dialog = byId('security-action-dialog');
  const downloadUrls = new Set();
  let security = null;
  let busy = false;
  let loading = false;
  let action = null;
  let actionOpener = null;
  let setupSecret = '';
  let enrollmentExpiresAt = null;
  let recoveryCodes = [];
  let sensitiveEpoch = 0;
  let enrollmentTimer = null;
  let confirmationPending = false;
  let confirmationCooldownUntil = 0;
  let confirmationTimer = null;
  const confirmationUnavailable = 'Confirmation emails are not available yet. Your profile is saved. Try again later or contact the academy.';

  byId('year').textContent = String(new Date().getFullYear());
  byId('security-menu').addEventListener('click', () => {
    const button = byId('security-menu');
    const expanded = button.getAttribute('aria-expanded') === 'true';
    button.setAttribute('aria-expanded', String(!expanded));
    byId('navigation').classList.toggle('open', !expanded);
  });

  function notify(message, focus = false) {
    status.textContent = message;
    if (focus) status.focus();
  }

  async function request(endpoint, values) {
    const response = await fetch(endpoint, {
      method: values === undefined ? 'GET' : 'POST',
      headers: values === undefined ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy' },
      credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer',
      signal: AbortSignal.timeout(20000),
      ...(values === undefined ? {} : { body: JSON.stringify(values) }),
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(typeof result.error === 'string' ? result.error : 'We couldn’t complete that action. Please try again.');
      error.status = response.status;
      if (response.status === 401 && result.code !== 'PASSWORD_REAUTHENTICATION_FAILED') {
        clearSensitiveView(); closeEnrollment(); window.location.replace('/login.html');
      }
      throw error;
    }
    return result;
  }

  function formatDate(value) {
    if (!Number.isFinite(value) || value <= 0) return 'Not recorded';
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }

  function clearPasswords() {
    for (const input of [setupPassword, confirmPassword, confirmCode, actionPassword, actionCode]) input.value = '';
  }

  function clearSetupKey() {
    setupSecret = '';
    byId('authenticator-secret').textContent = '';
    byId('authenticator-qr').removeAttribute('src');
    byId('authenticator-qr').hidden = true;
    byId('enrollment-key-panel').hidden = true;
  }

  function clearRecoveryCodes() {
    recoveryCodes = [];
    byId('recovery-codes').replaceChildren();
    byId('recovery-codes-panel').hidden = true;
    byId('recovery-codes-saved').checked = false;
    byId('dismiss-recovery-codes').disabled = true;
    for (const url of downloadUrls) URL.revokeObjectURL(url);
    downloadUrls.clear();
  }

  function closeEnrollment() {
    clearSetupKey();
    enrollmentExpiresAt = null;
    clearInterval(enrollmentTimer);
    enrollmentTimer = null;
    byId('authenticator-enrollment').hidden = true;
    byId('setup-two-factor-form').hidden = security?.twoFactor?.enrollmentAllowed !== true;
    confirmPassword.value = confirmCode.value = '';
  }

  function tickEnrollment() {
    if (!enrollmentExpiresAt) return;
    const remaining = enrollmentExpiresAt - Date.now();
    if (remaining <= 0) {
      closeEnrollment();
      notify('This authenticator setup has expired. Enter your password to create a new setup key.');
      return;
    }
    const minutes = Math.ceil(remaining / 60000);
    byId('enrollment-expiry').textContent = `${setupSecret ? 'Setup key expires' : 'The setup key was cleared when this page was hidden. You can still confirm a code from your authenticator, or start again. This setup expires'} in ${minutes} ${minutes === 1 ? 'minute' : 'minutes'}.`;
  }

  function controlsDisabled(value) {
    for (const id of ['restart-enrollment', 'regenerate-recovery-codes', 'disable-two-factor', 'revoke-all-sessions', 'security-sign-out']) byId(id).disabled = value;
    for (const id of ['setup-two-factor-button', 'confirm-two-factor-button']) byId(id).disabled = value || security?.twoFactor?.enrollmentAllowed !== true || security?.twoFactor?.enabled === true;
    byId('security-confirm-email').disabled = value || confirmationPending || Date.now() < confirmationCooldownUntil;
    byId('security-check-email').disabled = value || confirmationPending;
    byId('revoke-other-sessions').disabled = value || !security || (security.sessionsTotal ?? security.sessions.length) <= security.sessions.filter(item => item.current).length;
    for (const button of byId('security-sessions').querySelectorAll('button')) button.disabled = value;
  }

  function addDetail(parent, label, value) {
    const item = document.createElement('div');
    const term = document.createElement('dt');
    const description = document.createElement('dd');
    term.className = 'metric-label mb-1';
    term.textContent = label;
    description.textContent = value;
    item.append(term, description);
    parent.append(item);
  }

  function renderSessions() {
    const list = byId('security-sessions');
    list.replaceChildren();
    for (const session of security.sessions) {
      const item = document.createElement('li');
      item.className = 'rounded-xl border border-line bg-paper p-4 sm:p-5';
      const heading = document.createElement('div');
      heading.className = 'mb-4 flex flex-wrap items-center justify-between gap-3';
      const titleGroup = document.createElement('div');
      titleGroup.className = 'min-w-0';
      const title = document.createElement('h3');
      title.className = 'break-words text-sm tracking-normal';
      const browser = typeof session.browser === 'string' ? session.browser : '';
      const device = typeof session.device === 'string' ? session.device : '';
      title.textContent = [...new Set([browser, device].filter(Boolean))].join(' · ') || 'Unrecognized browser or device';
      titleGroup.append(title);
      if (session.current) {
        const badge = document.createElement('p');
        badge.className = 'mt-1 text-xs text-lime';
        badge.textContent = 'This device · current session';
        titleGroup.append(badge);
      }
      const button = document.createElement('button');
      button.type = 'button'; button.className = 'desk-action shrink-0';
      button.textContent = session.current ? 'Log out' : 'Log out device';
      button.setAttribute('aria-label', `${session.current ? 'Log out of this device' : 'Log out device'}: ${title.textContent}`);
      button.addEventListener('click', () => session.current ? signOut() : openAction('revoke', button, session));
      heading.append(titleGroup, button);
      const details = document.createElement('dl');
      details.className = 'grid gap-4 text-xs sm:grid-cols-3';
      addDetail(details, 'Signed in', formatDate(session.createdAt));
      addDetail(details, 'Last active', formatDate(session.lastSeenAt));
      addDetail(details, 'Expires', formatDate(session.expiresAt));
      item.append(heading, details);
      list.append(item);
    }
    if (security.sessions.length === 0) {
      const empty = document.createElement('li');
      empty.className = 'rounded-xl border border-line p-5 text-sm text-muted';
      empty.textContent = 'No active sessions were returned. Refresh to check your sign-in status.';
      list.append(empty);
    }
    const total = Number.isSafeInteger(security.sessionsTotal) ? security.sessionsTotal : security.sessions.length;
    const shown = security.sessions.length;
    byId('session-summary').textContent = `${total} active ${total === 1 ? 'session' : 'sessions'}${total > shown ? ` · Showing ${shown} recent ${shown === 1 ? 'session' : 'sessions'}` : ''}. Times use your device’s timezone.`;
    const absoluteDays = security.absoluteLifetimeMs / 86400000;
    const idleHours = security.idleTimeoutMs / 3600000;
    byId('session-expiry-policy').textContent = Number.isFinite(absoluteDays) && absoluteDays > 0 && Number.isFinite(idleHours) && idleHours > 0
      ? `Sessions expire after ${absoluteDays} days, or after ${idleHours} hours without activity, whichever comes first.` : '';
  }

  function renderSecurity(value) {
    if (!value || !value.twoFactor || !Array.isArray(value.sessions)) throw new Error('Your security settings could not be read. Please refresh.');
    security = value;
    const factor = security.twoFactor;
    const enabled = factor.enabled === true;
    const enrollmentAllowed = factor.enrollmentAllowed === true;
    byId('two-factor-badge').textContent = enabled ? 'Enabled' : 'Not enabled';
    byId('two-factor-badge').className = enabled ? 'rounded-full border border-lime/40 bg-lime/10 px-3 py-1 text-xs text-lime' : 'rounded-full border border-line px-3 py-1 text-xs text-muted';
    byId('two-factor-description').textContent = enabled ? 'Your password and an authenticator or unused recovery code are required when you log in.' : 'An authenticator app adds a one-time code to your password when you log in.';
    byId('two-factor-off').hidden = enabled || !enrollmentAllowed;
    byId('two-factor-ownership-required').hidden = enabled || enrollmentAllowed;
    byId('two-factor-on').hidden = !enabled;
    byId('two-factor-enabled-at').textContent = formatDate(factor.enabledAt);
    const remaining = Number.isSafeInteger(factor.recoveryCodesRemaining) ? Math.max(0, factor.recoveryCodesRemaining) : 0;
    byId('recovery-codes-remaining').textContent = `${remaining} unused ${remaining === 1 ? 'code' : 'codes'}`;
    byId('recovery-codes-warning').hidden = !enabled || remaining > 0;
    byId('setup-two-factor-button').textContent = factor.enrollmentPending ? 'Create a new setup key' : 'Set up authenticator';
    if (enabled || !enrollmentAllowed) closeEnrollment();
    else if (!enrollmentExpiresAt) byId('setup-two-factor-form').hidden = false;
    renderSessions();
    controlsDisabled(busy || loading);
  }

  async function loadSecurity({ initial = false } = {}) {
    if (loading || busy) return;
    loading = true;
    controlsDisabled(true);
    byId('security-retry').hidden = true;
    byId('refresh-security').disabled = true;
    try {
      renderSecurity(await request('/api/security'));
      byId('security-loading').hidden = true;
      byId('security-main').hidden = false;
      if (!initial) notify('Your security settings and sessions are up to date.');
    } catch (error) {
      if (error.status === 401) { window.location.replace('/login.html'); return; }
      const message = error.name === 'TimeoutError' ? 'Loading took too long. Check your connection and try again.' : error.message;
      if (initial || !security) {
        byId('security-loading-message').textContent = message;
        byId('security-retry').hidden = false;
      } else notify(message, true);
    } finally {
      loading = false;
      byId('refresh-security').disabled = false;
      controlsDisabled(busy);
    }
  }

  function showRecoveryCodes(codes, epoch) {
    clearRecoveryCodes();
    if (epoch !== sensitiveEpoch || document.hidden) {
      notify('Your security change succeeded. The one-time recovery codes were cleared because this page was hidden. Generate a new set before you need them.', true);
      return;
    }
    if (!Array.isArray(codes) || codes.length !== 10 || codes.some(code => typeof code !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{8}){3}$/i.test(code))) {
      notify('Your security change succeeded, but the recovery codes could not be displayed. Generate a new set before you need them.', true);
      return;
    }
    recoveryCodes = codes.slice();
    for (const code of recoveryCodes) {
      const item = document.createElement('li');
      item.className = 'min-w-0 select-all break-all rounded-lg border border-lime/20 bg-paper px-3 py-2 font-mono text-xs text-lime';
      item.textContent = code;
      byId('recovery-codes').append(item);
    }
    byId('recovery-codes-panel').hidden = false;
    byId('recovery-codes-heading').focus();
    notify('Two-factor protection is ready. Save your new recovery codes now.');
  }

  byId('setup-two-factor-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || loading || security?.twoFactor?.enabled || security?.twoFactor?.enrollmentAllowed !== true || !byId('setup-two-factor-form').reportValidity()) return;
    busy = true; controlsDisabled(true);
    const epoch = sensitiveEpoch;
    const password = setupPassword.value;
    setupPassword.value = '';
    notify('Creating your private authenticator setup…');
    try {
      const result = await request('/api/security/2fa/setup', { password });
      if (epoch !== sensitiveEpoch || document.hidden) { notify('A setup key was created, but it was cleared because this page was hidden. Enter your password to start again.'); return; }
      if (typeof result.secret !== 'string' || !/^[A-Z2-7]{16,128}$/.test(result.secret) || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) throw new Error('The setup key could not be displayed. Please start again.');
      closeEnrollment();
      setupSecret = result.secret;
      enrollmentExpiresAt = result.expiresAt;
      byId('authenticator-secret').textContent = setupSecret;
      byId('enrollment-key-panel').hidden = false;
      const qr = byId('authenticator-qr');
      if (typeof result.qrDataUrl === 'string' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(result.qrDataUrl) && result.qrDataUrl.length < 200000) { qr.src = result.qrDataUrl; qr.hidden = false; }
      byId('setup-two-factor-form').hidden = true;
      byId('authenticator-enrollment').hidden = false;
      tickEnrollment();
      enrollmentTimer = setInterval(tickEnrollment, 1000);
      confirmPassword.focus();
      notify('Add this setup key to your authenticator, then verify a code to enable two-factor authentication.');
    } catch (error) { notify(error.message, true); }
    finally { busy = false; controlsDisabled(false); }
  });

  byId('confirm-two-factor-form').addEventListener('submit', async event => {
    event.preventDefault();
    tickEnrollment();
    if (busy || loading || security?.twoFactor?.enabled || security?.twoFactor?.enrollmentAllowed !== true || !enrollmentExpiresAt || !byId('confirm-two-factor-form').reportValidity()) return;
    busy = true; controlsDisabled(true);
    const epoch = sensitiveEpoch;
    const password = confirmPassword.value;
    const code = confirmCode.value;
    confirmPassword.value = confirmCode.value = '';
    notify('Verifying your authenticator…');
    try {
      const result = await request('/api/security/2fa/confirm', { password, code });
      renderSecurity(result.security);
      closeEnrollment();
      showRecoveryCodes(result.recoveryCodes, epoch);
    } catch (error) { notify(error.message, true); }
    finally { busy = false; controlsDisabled(false); }
  });

  byId('restart-enrollment').addEventListener('click', () => {
    if (busy) return;
    closeEnrollment();
    notify('Enter your password to create a new setup key. Creating it will replace the previous pending key.');
    setupPassword.focus();
  });

  async function copy(value, success) {
    if (!value) return;
    try { await navigator.clipboard.writeText(value); notify(success); }
    catch { notify('Copy is unavailable in this browser. Select the text to copy it, or download your recovery codes.'); }
  }
  byId('copy-setup-key').addEventListener('click', () => copy(setupSecret, 'Setup key copied. Add it to your authenticator and keep it private.'));
  byId('copy-recovery-codes').addEventListener('click', () => copy(recoveryCodes.join('\n'), 'Recovery codes copied. Save them somewhere secure.'));
  byId('download-recovery-codes').addEventListener('click', () => {
    if (!recoveryCodes.length) return;
    const text = `Fundraiser Academy — recovery codes\nSaved ${new Date().toISOString().slice(0, 10)}\n\n${recoveryCodes.join('\n')}\n\nEach code can replace an authenticator code once. Your password is still required.\nKeep these codes private and separate from your authenticator device.\nGenerating a new set makes all previous codes unusable.\nFundraiser Academy support will never ask you to send these codes.\n`;
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    downloadUrls.add(url);
    const link = document.createElement('a');
    link.href = url; link.download = 'fundraiser-academy-recovery-codes.txt';
    document.body.append(link); link.click(); link.remove();
    setTimeout(() => { URL.revokeObjectURL(url); downloadUrls.delete(url); }, 1000);
    notify('Your recovery-code download was requested. Check that the file is saved before continuing.');
  });
  byId('recovery-codes-saved').addEventListener('change', () => { byId('dismiss-recovery-codes').disabled = !byId('recovery-codes-saved').checked; });
  byId('dismiss-recovery-codes').addEventListener('click', () => {
    if (!byId('recovery-codes-saved').checked) return;
    clearRecoveryCodes();
    notify('Your recovery codes are saved. Keep them private and use each one only once.', true);
  });

  const actions = {
    regenerate: { title: 'Generate new recovery codes?', detail: 'All previous recovery codes will stop working. You’ll receive ten new codes to save. This also logs out your other devices.', button: 'Generate new codes', endpoint: '/api/security/2fa/recovery-codes' },
    disable: { title: 'Turn off two-factor authentication?', detail: 'Your password will be the only code needed to log in. All recovery codes will stop working and your other devices will be logged out.', button: 'Turn off protection', endpoint: '/api/security/2fa/disable' },
    revoke: { title: 'Log out this device?', detail: 'This session will lose access to your account. It will need to log in again to continue.', button: 'Log out device', endpoint: '/api/security/sessions/revoke' },
    others: { title: 'Log out other devices?', detail: 'Every other session will lose access to your account. You’ll stay signed in on this device.', button: 'Log out other devices', endpoint: '/api/security/sessions/revoke-others' },
    all: { title: 'Log out all devices?', detail: 'Every session will lose access to your account, including this one. You’ll need to log in again to continue.', button: 'Log out all devices', endpoint: '/api/security/sessions/revoke-all' },
  };

  function closeAction() {
    if (dialog.open) dialog.close();
    actionPassword.value = actionCode.value = '';
    byId('security-action-status').textContent = '';
    action = null;
    if (actionOpener && !actionOpener.disabled && !document.hidden) actionOpener.focus();
    actionOpener = null;
  }

  function openAction(kind, opener, session) {
    if (busy || loading || !security) return;
    action = { kind, sessionId: session?.id };
    actionOpener = opener;
    const definition = actions[kind];
    byId('security-action-heading').textContent = definition.title;
    byId('security-action-detail').textContent = definition.detail;
    byId('security-action-submit').textContent = definition.button;
    byId('security-action-factor').hidden = !security.twoFactor.enabled;
    actionCode.required = security.twoFactor.enabled === true;
    actionPassword.value = actionCode.value = '';
    byId('security-action-status').textContent = '';
    dialog.showModal();
    actionPassword.focus();
  }

  byId('regenerate-recovery-codes').addEventListener('click', event => openAction('regenerate', event.currentTarget));
  byId('disable-two-factor').addEventListener('click', event => openAction('disable', event.currentTarget));
  byId('revoke-other-sessions').addEventListener('click', event => openAction('others', event.currentTarget));
  byId('revoke-all-sessions').addEventListener('click', event => openAction('all', event.currentTarget));
  byId('security-action-cancel').addEventListener('click', () => { if (!busy) closeAction(); });
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => { actionPassword.value = actionCode.value = ''; action = null; });
  byId('security-action-form').addEventListener('submit', async event => {
    event.preventDefault();
    if (busy || loading || !action || !byId('security-action-form').reportValidity()) return;
    const selected = action;
    const definition = actions[selected.kind];
    const epoch = sensitiveEpoch;
    const values = { password: actionPassword.value, ...(security.twoFactor.enabled ? { code: actionCode.value.trim() } : {}), ...(selected.kind === 'revoke' ? { sessionId: selected.sessionId } : {}) };
    actionPassword.value = actionCode.value = '';
    busy = true; controlsDisabled(true);
    byId('security-action-submit').disabled = byId('security-action-cancel').disabled = true;
    byId('security-action-status').textContent = 'Confirming your security change…';
    try {
      const result = await request(definition.endpoint, values);
      closeAction();
      if (result.signedOut) { clearRecoveryCodes(); closeEnrollment(); window.location.replace('/login.html'); return; }
      renderSecurity(result.security);
      if (selected.kind === 'regenerate') showRecoveryCodes(result.recoveryCodes, epoch);
      else {
        if (selected.kind === 'disable') clearRecoveryCodes();
        notify(typeof result.message === 'string' ? result.message : 'Your security settings have been updated.', true);
      }
    } catch (error) {
      if (dialog.open) byId('security-action-status').textContent = error.message;
      else notify(error.message, true);
    } finally {
      busy = false; controlsDisabled(false);
      byId('security-action-submit').disabled = byId('security-action-cancel').disabled = false;
    }
  });

  async function signOut() {
    if (busy || loading) return;
    busy = true; controlsDisabled(true);
    try {
      await request('/api/logout', {});
      clearPasswords(); clearRecoveryCodes(); closeEnrollment();
      window.location.replace('/login.html');
    } catch (error) { notify(error.message, true); }
    finally { busy = false; controlsDisabled(false); }
  }
  byId('security-sign-out').addEventListener('click', signOut);
  byId('refresh-security').addEventListener('click', () => loadSecurity());
  byId('security-retry').addEventListener('click', () => loadSecurity({ initial: true }));

  function tickConfirmationCooldown() {
    const remaining = Math.max(0, Math.ceil((confirmationCooldownUntil - Date.now()) / 1000));
    byId('security-confirm-email').textContent = remaining ? `Request again in ${remaining}s` : 'Send confirmation email';
    byId('security-confirm-email').disabled = busy || loading || confirmationPending || remaining > 0;
    if (!remaining) { clearInterval(confirmationTimer); confirmationTimer = null; }
  }

  function startConfirmationCooldown(until = Date.now() + 60000) {
    confirmationCooldownUntil = Number.isFinite(until) ? Math.max(Date.now(), Math.min(until, Date.now() + 60000)) : Date.now() + 60000;
    clearInterval(confirmationTimer);
    tickConfirmationCooldown();
    if (confirmationCooldownUntil > Date.now()) confirmationTimer = setInterval(tickConfirmationCooldown, 1000);
  }

  byId('security-confirm-email').addEventListener('click', async () => {
    if (busy || loading || confirmationPending || Date.now() < confirmationCooldownUntil || security?.twoFactor?.enabled || security?.twoFactor?.enrollmentAllowed === true) return;
    confirmationPending = true;
    controlsDisabled(busy || loading);
    byId('security-confirmation-status').textContent = 'Requesting your confirmation email…';
    try {
      const result = await request('/api/email/resend-confirmation', {});
      const confirmation = result.confirmation || {};
      if (result.user?.emailVerified === true || confirmation.status === 'already_confirmed') {
        byId('security-confirmation-status').textContent = 'Your email address is already confirmed. Refreshing your security settings…';
        await loadSecurity();
      } else if (confirmation.queued === true || confirmation.status === 'queued') {
        byId('security-confirmation-status').textContent = 'Your confirmation email is queued for delivery. Check your inbox and spam folder, then open the link and check your confirmation here.';
        startConfirmationCooldown(confirmation.cooldownUntil);
      } else if (confirmation.available === false || confirmation.status === 'unavailable') {
        byId('security-confirmation-status').textContent = confirmationUnavailable;
      } else {
        byId('security-confirmation-status').textContent = 'We couldn’t queue your confirmation email. Please try again shortly or contact the academy.';
      }
    } catch (error) {
      if (/RESEND_API_KEY|EMAIL_FROM|APP_ORIGIN|not configured/i.test(error.message)) byId('security-confirmation-status').textContent = confirmationUnavailable;
      else if (/recently requested|wait one minute/i.test(error.message)) {
        byId('security-confirmation-status').textContent = 'A confirmation email was recently requested. Check your inbox and spam folder, or wait one minute before trying again.';
        startConfirmationCooldown();
      } else if (error.status === 429) byId('security-confirmation-status').textContent = 'Too many confirmation requests. Wait a few minutes before trying again.';
      else byId('security-confirmation-status').textContent = 'We couldn’t request your confirmation email. Check your connection and try again shortly.';
    } finally {
      confirmationPending = false;
      controlsDisabled(busy || loading);
      tickConfirmationCooldown();
    }
  });
  byId('security-check-email').addEventListener('click', async () => {
    if (busy || loading || confirmationPending) return;
    await loadSecurity();
    if (security && !security.twoFactor.enabled && !security.twoFactor.enrollmentAllowed) byId('security-confirmation-status').textContent = 'Your email is not confirmed yet. Open the confirmation link in your inbox, then check again.';
  });

  function clearSensitiveView() {
    sensitiveEpoch += 1;
    const hadCodes = recoveryCodes.length > 0;
    clearPasswords(); clearSetupKey(); clearRecoveryCodes();
    if (!busy) closeAction();
    if (enrollmentExpiresAt) tickEnrollment();
    if (hadCodes) notify('Your displayed recovery codes were cleared because this page was hidden. If you did not save them, generate a new set using your authenticator or an unused recovery code.');
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearSensitiveView(); else { tickEnrollment(); tickConfirmationCooldown(); } });
  window.addEventListener('pagehide', () => { clearSensitiveView(); closeEnrollment(); clearInterval(confirmationTimer); confirmationTimer = null; });
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      tickConfirmationCooldown();
      if (confirmationCooldownUntil > Date.now() && !confirmationTimer) confirmationTimer = setInterval(tickConfirmationCooldown, 1000);
      loadSecurity();
    }
  });
  loadSecurity({ initial: true });
})();
