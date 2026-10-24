import { assessmentSummary, guidedNextStep } from './client-summary.js';
import { fundraiserName } from './fundraiser-name.js';

export function initializeClientPage({document: doc = globalThis.document, window: win = globalThis.window, fetchFn = globalThis.fetch} = {}) {
if (!doc?.getElementById('welcome-name')) return;
const document = doc, window = win, location = win.location, fetch = fetchFn;

const $ = id => document.getElementById(id);
const money = value => Number.isFinite(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value) : '—';
const date = value => Number.isFinite(value) ? new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Not available';
const cleanName = value => value.trim().replace(/\s+/gu, ' ');
let user = null;
let account = null;
let contract = null;
let refreshing = false;
let loadingProfile = false;
let signedOut = false;
let confirmationQueued = false;
const needsConfirmation = () => user?.assessmentAccess === false || (user?.emailConfirmationRequired === true && user?.emailVerified !== true);
const confirmationUnavailable = 'Confirmation emails are not available yet. Your details are saved. Please try again later or contact the academy.';

async function api(path, data) {
  const response = await fetch(path, {
    credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000),
    ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy' }, body: JSON.stringify(data) }),
  });
  if (response.status === 401) {
    signedOut = true;
    location.replace('/login.html');
    throw new Error('Please log in to continue.');
  }
  let result;
  try { result = await response.json(); } catch { throw new Error('The server returned an unreadable response. Please try again.'); }
  if (!response.ok) {
    if (result.code === 'EMAIL_CONFIRMATION_REQUIRED' && user) {
      user = { ...user, assessmentAccess: false, emailConfirmationRequired: true, emailVerified: false };
      renderAccess();
    }
    throw new Error(result.error || 'Your request could not be completed.');
  }
  return result;
}

function failureMessage(error) {
  return error.name === 'TimeoutError' || error.name === 'AbortError' ? 'This request took too long. Please try again.' : error.message;
}

function confirmationFailureMessage(error) {
  const detail = failureMessage(error);
  return /RESEND_API_KEY|EMAIL_FROM|APP_ORIGIN|configured|configuration|provider|sender/i.test(detail) ? confirmationUnavailable : detail;
}

function renderProfile(next, { fillForm = true } = {}) {
  user = next;
  const firstName = next.firstName || next.name?.split(' ')[0] || '';
  const displayName = fundraiserName(next);
  $('welcome-name').textContent = displayName + '.';
  $('profile-name').textContent = displayName;
  $('profile-email').textContent = next.email;
  $('profile-market').textContent = next.market || 'Not provided';
  $('profile-id').textContent = String(next.id);
  $('profile-joined').textContent = date(next.createdAt);
  $('profile-initials').textContent = Array.from(firstName)[0]?.toUpperCase() || 'FA';
  if (fillForm) {
    $('profile-first-name').value = next.firstName || firstName;
    $('profile-other-names').value = next.otherNames || '';
    $('profile-trading-market').value = next.market || 'I trade both';
    validateNameLength();
  }
  renderAccess();
}

function renderAccess() {
  const pending = needsConfirmation();
  $('confirm-email').hidden = !pending;
  $('confirmation-email').textContent = user.email;
  document.querySelectorAll('[data-assessment-link]').forEach(link => {
    if (!link.dataset.savedHref) link.dataset.savedHref = link.getAttribute('href');
    if (pending) {
      link.removeAttribute('href');
      link.setAttribute('aria-disabled', 'true');
      link.title = 'Confirm your email to unlock this section';
    } else {
      link.setAttribute('href', link.dataset.savedHref);
      link.removeAttribute('aria-disabled');
      link.removeAttribute('title');
    }
  });
  if (pending) {
    account = null;
    contract = null;
    for (const id of ['summary-balance', 'summary-equity', 'summary-profit', 'summary-days', 'summary-positions', 'summary-trades', 'summary-pending', 'summary-margin', 'daily-loss', 'total-loss']) $(id).textContent = '—';
    $('summary-floating').textContent = 'Available after email confirmation';
    $('assessment-status').textContent = 'Confirm email to start';
    $('assessment-detail').textContent = 'Your profile is saved. Confirm your email address before starting your $10,000 demo assessment.';
    $('assessment-progress').value = 0;
    $('assessment-progress-label').textContent = 'Assessment progress becomes available after email confirmation.';
    $('valuation-note').textContent = 'Your assessment account and trading controls unlock when your email address is confirmed.';
    $('journey-assessment').textContent = 'Confirm your email first, then demonstrate your skill on the practice desk.';
    $('journey-certificate').textContent = 'Complete the assessment after email confirmation to earn your certificate.';
    $('journey-contract').textContent = 'The required agreement becomes available after a successful assessment.';
    $('certificate-count').textContent = '—';
    $('certificate-detail').textContent = 'Certificates become available after email confirmation and a successful assessment.';
    $('latest-certificate').hidden = true;
  }
  renderNextStep();
}

function renderNextStep() {
  if (needsConfirmation()) {
    $('next-heading').textContent = 'Confirm your email to begin';
    $('next-detail').textContent = 'Your client profile is ready. Confirm your email address to unlock your assessment and trading desk.';
    $('next-action').textContent = 'Confirm your email →';
    $('next-action').href = '#confirm-email';
    return;
  }
  const next = guidedNextStep(account, contract);
  $('next-heading').textContent = next.heading;
  $('next-detail').textContent = next.detail;
  $('next-action').textContent = next.label + ' →';
  $('next-action').href = next.href;
}

function renderAccount(next) {
  account = next;
  const summary = assessmentSummary(next);
  $('assessment-status').textContent = summary.status;
  $('assessment-detail').textContent = summary.detail;
  $('summary-balance').textContent = money(summary.balance);
  $('summary-equity').textContent = money(summary.equity);
  $('summary-floating').textContent = summary.valuationLabel;
  $('summary-profit').textContent = money(summary.realized);
  $('summary-target').textContent = `${money(summary.target)} realized target · 10%`;
  $('summary-days').textContent = `${summary.days} / 3`;
  $('assessment-progress').value = summary.targetProgress;
  $('assessment-progress-label').textContent = `${money(summary.realized)} / ${money(summary.target)} realized profit · ${summary.days} distinct UTC trading ${summary.days === 1 ? 'day' : 'days'}`;
  $('summary-positions').textContent = String(summary.positions);
  $('summary-trades').textContent = String(summary.closedTrades);
  $('summary-pending').textContent = String(summary.pendingOrders);
  $('summary-margin').textContent = money(summary.freeMargin);
  $('daily-loss').textContent = `${money(summary.dailyLoss)} / ${money(summary.dailyCap)} limit`;
  $('total-loss').textContent = `${money(summary.totalLoss)} / ${money(summary.totalCap)} limit`;
  $('daily-loss-note').textContent = `UTC day ${summary.dailyDate} · based on day-start equity`;
  $('valuation-note').textContent = `${summary.valuationLabel}. This is a snapshot; open the trading desk for continuously updated reference prices and risk controls.`;
  $('journey-assessment').textContent = summary.status + '. ' + summary.detail;
  renderNextStep();
}

function renderCertificates(result) {
  const certificates = result.certificates;
  if (!Array.isArray(certificates)) throw new Error('Certificate records could not be read.');
  $('certificate-count').textContent = String(certificates.length);
  $('journey-certificate').textContent = certificates.length ? `${certificates.length} completion ${certificates.length === 1 ? 'certificate is' : 'certificates are'} saved to your account.` : 'Your certificate appears here after a successful assessment.';
  const latest = certificates.slice().sort((a, b) => b.issuedAt - a.issuedAt)[0];
  $('certificate-detail').textContent = latest ? `Latest: ${latest.holder} · issued ${date(latest.issuedAt)}. Choose your registered name or nickname on the certificates page.` : 'No certificates yet. Pass your assessment over at least 3 trading days to earn your first.';
  $('latest-certificate').hidden = !latest || !/^[a-f0-9-]{36}$/.test(latest.id);
  if (!$('latest-certificate').hidden) {
    $('latest-certificate').href = `/api/certificates/${latest.id}.svg`;
    $('latest-certificate').download = `Fundraiser-Academy-${latest.id}.svg`;
  }
}

function renderContract(result) {
  contract = result;
  const descriptions = {
    assessment_required: 'Available after you pass an assessment. Signing is compulsory before sponsorship review.',
    awaiting_contract: 'Assessment completed. Awaiting the company agreement; signing is compulsory before sponsorship review.',
    signature_required: 'Your agreement is ready. Read and sign it on the academy agreement page.',
    signed: 'Your signature is recorded. View your signed agreement and signature receipt.',
  };
  $('journey-contract').textContent = descriptions[result.status] || 'View the agreement page for your current status.';
  $('journey-review').textContent = result.status === 'signed' ? 'Agreement complete. Sponsorship is subject to company review and eligibility; approval has not been granted by this dashboard.' : 'Complete the assessment and required agreement before sponsorship review. Funding is subject to eligibility and company review.';
  renderNextStep();
}

function renderNotifications(result) {
  $('email-verification').textContent = result.emailVerified ? 'Verified' : needsConfirmation() ? 'Confirmation required to start your assessment' : 'Not yet verified · existing account access remains available';
  $('email-alert-status').textContent = !result.emailAvailable ? 'Email delivery is not configured yet' : result.emailEnabled && result.emailVerified ? 'Enabled' : result.emailEnabled ? 'Awaiting email verification' : 'Disabled';
  const devices = result.pushSubscriptions;
  $('push-alert-status').textContent = Number.isInteger(devices) && devices > 0 ? `${devices} registered ${devices === 1 ? 'device' : 'devices'}` : 'No devices registered';
  $('notification-detail').textContent = needsConfirmation() ? 'Confirm your email using the card above to unlock your assessment. Optional trade emails stay off until you choose to enable them later.' : !result.emailVerified ? 'Use “Enable email alerts” on your trading desk to request a verification link when email delivery is available. Push delivery depends on browser and device permissions.' : 'Manage trade emails, background push, and price alerts on your trading desk. Push delivery depends on browser and device permissions.';
}

async function refreshOverview() {
  if (refreshing || signedOut) return;
  refreshing = true;
  $('refresh-overview').disabled = true;
  $('overview-status').textContent = 'Refreshing your assessment overview…';
  const assessmentRequests = [
    { path: '/api/account?symbol=BTCUSD', render: result => renderAccount(result.account), fail: error => {
      $('assessment-status').textContent = 'Snapshot unavailable';
      $('assessment-detail').textContent = failureMessage(error) + ' You can still open the trading desk or edit your profile.';
      $('journey-assessment').textContent = 'Your assessment snapshot is currently unavailable. Check the trading desk for your saved progress.';
      $('valuation-note').textContent = account ? 'The figures above are from an earlier refresh. Open the trading desk to check your current account.' : 'Account balances will appear when the snapshot is available.';
    } },
    { path: '/api/certificates', render: renderCertificates, fail: error => {
      $('certificate-detail').textContent = failureMessage(error);
      $('journey-certificate').textContent = 'Certificate status is currently unavailable. Open your certificates page to check.';
    } },
    { path: '/api/contract', render: renderContract, fail: error => {
      $('journey-contract').textContent = failureMessage(error) + ' Check the academy agreement page for your status.';
    } },
  ];
  const requests = needsConfirmation() ? [{
    path: '/api/registration-status', render: result => {
      if (!confirmationQueued) $('confirmation-status').textContent = result.emailConfirmationAvailable ? 'Check your inbox for your confirmation link. You can request another email below.' : confirmationUnavailable;
    }, fail: error => { if (!confirmationQueued) $('confirmation-status').textContent = failureMessage(error) + ' You can try requesting another confirmation email.'; },
  }] : assessmentRequests;
  requests.push({ path: '/api/notification-settings', render: renderNotifications, fail: error => {
      $('email-verification').textContent = 'Status unavailable';
      $('email-alert-status').textContent = 'Status unavailable';
      $('push-alert-status').textContent = 'Status unavailable';
      $('notification-detail').textContent = failureMessage(error) + ' Notification settings are available on your trading desk.';
    } });
  const outcomes = await Promise.allSettled(requests.map(async request => {
    try { request.render(await api(request.path)); }
    catch (error) { if (!signedOut) request.fail(error); throw error; }
  }));
  if (!signedOut) {
    const incomplete = outcomes.some(outcome => outcome.status === 'rejected');
    $('overview-status').textContent = `Last refreshed ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.${incomplete ? ' Some sections are unavailable; your profile is ready.' : needsConfirmation() ? ' Confirm your email to unlock your assessment.' : ' Open the trading desk for live prices.'}`;
  }
  refreshing = false;
  $('refresh-overview').disabled = false;
}

function validateNameLength() {
  const fullName = [cleanName($('profile-first-name').value), cleanName($('profile-other-names').value)].filter(Boolean).join(' ');
  $('profile-first-name').setCustomValidity(fullName.length > 100 ? 'Your first name and other names together must be 100 characters or fewer.' : '');
}

$('profile-first-name').addEventListener('input', validateNameLength);
$('profile-other-names').addEventListener('input', validateNameLength);
$('profile-form').addEventListener('submit', async event => {
  event.preventDefault();
  validateNameLength();
  if (!event.currentTarget.reportValidity() || signedOut) return;
  $('save-profile').disabled = true;
  $('profile-status').textContent = 'Saving your account details…';
  try {
    const result = await api('/api/profile', {
      firstName: cleanName($('profile-first-name').value),
      otherNames: cleanName($('profile-other-names').value),
      market: $('profile-trading-market').value,
    });
    renderProfile(result.user);
    $('profile-status').textContent = 'Account details saved.';
  } catch (error) { if (!signedOut) $('profile-status').textContent = failureMessage(error); }
  finally { $('save-profile').disabled = false; }
});

$('sign-out').addEventListener('click', async () => {
  $('sign-out').disabled = true;
  $('logout-status').hidden = false;
  $('logout-status').textContent = 'Signing out…';
  try {
    await api('/api/logout', {});
    signedOut = true;
    location.replace('/login.html');
  } catch (error) { if (!signedOut) { $('logout-status').textContent = failureMessage(error); $('sign-out').disabled = false; } }
});
async function checkLatestProfile() {
  if (refreshing || signedOut) return;
  $('refresh-overview').disabled = true;
  $('check-confirmation').disabled = true;
  try {
    const result = await api('/api/me');
    renderProfile(result.user, { fillForm: false });
    if (needsConfirmation()) $('confirmation-status').textContent = 'Your email is not confirmed yet. Open the confirmation link in your inbox, then check again.';
    await refreshOverview();
  } catch (error) { if (!signedOut) $('overview-status').textContent = failureMessage(error); }
  finally { $('refresh-overview').disabled = false; $('check-confirmation').disabled = false; }
}
$('refresh-overview').addEventListener('click', () => void checkLatestProfile());
$('check-confirmation').addEventListener('click', () => void checkLatestProfile());
$('resend-confirmation').addEventListener('click', async () => {
  if (!needsConfirmation() || signedOut) return;
  $('resend-confirmation').disabled = true;
  $('confirmation-status').textContent = 'Requesting your confirmation email…';
  try {
    const result = await api('/api/email/resend-confirmation', {});
    const confirmation = result.confirmation;
    confirmationQueued = confirmation?.queued === true;
    if (result.user?.emailVerified || confirmation?.status === 'already_confirmed') {
      renderProfile(result.user, { fillForm: false });
      await refreshOverview();
    } else {
      $('confirmation-status').textContent = confirmationQueued ? 'Your confirmation email is queued for delivery. Check your inbox and spam folder. If it doesn’t arrive, request another email after a short wait.' : confirmation?.available === false ? confirmationUnavailable : confirmation?.required === false ? 'Your email is already confirmed. Refresh your overview to continue.' : confirmation?.error ? confirmationFailureMessage(new Error(confirmation.error)) : 'The email could not be queued. Please try again shortly.';
    }
  } catch (error) { if (!signedOut) $('confirmation-status').textContent = confirmationFailureMessage(error); }
  finally { $('resend-confirmation').disabled = false; }
});
$('retry-profile').addEventListener('click', () => void loadProfile());

async function loadProfile() {
  if (loadingProfile || signedOut) return;
  loadingProfile = true;
  $('retry-profile').hidden = true;
  $('login-link').hidden = true;
  $('client-loading-message').textContent = 'Loading your account details…';
  try {
    const result = await api('/api/me');
    renderProfile(result.user);
    document.querySelector('main').hidden = false;
    $('client-loading').hidden = true;
    void refreshOverview();
  } catch (error) {
    if (!signedOut) {
      $('client-loading-message').textContent = failureMessage(error);
      $('retry-profile').hidden = false;
      $('login-link').hidden = false;
    }
  } finally { loadingProfile = false; }
}

return {ready: loadProfile(), checkLatestProfile};
}

if (typeof document !== 'undefined') initializeClientPage();
