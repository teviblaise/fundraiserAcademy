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
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
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
