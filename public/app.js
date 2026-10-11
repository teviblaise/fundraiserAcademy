const toggle = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
toggle.addEventListener('click', () => {
  const expanded = toggle.getAttribute('aria-expanded') !== 'true';
  toggle.setAttribute('aria-expanded', String(expanded));
  navigation.classList.toggle('open', expanded);
});
navigation.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
  toggle.setAttribute('aria-expanded', 'false');
  navigation.classList.remove('open');
}));
async function authRequest(endpoint, data) {
  const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy' }, body: JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Request failed.');
  return result;
}
for (const [id, endpoint] of [['interest-form', '/api/register'], ['login-form', '/api/login']]) {
  const form = document.getElementById(id);
  form?.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const status = form.querySelector('[role="status"]');
    button.disabled = true; status.textContent = 'Connecting…';
    try {
      const values = Object.fromEntries(new FormData(form));
      await authRequest(endpoint, { name: values.name, email: values.email, password: values.password, market: values.experience, consent: values.consent === 'on' });
      window.location.assign('/dashboard.html');
    } catch (error) { status.textContent = error.message; button.disabled = false; }
  });
}
document.querySelector('#year').textContent = String(new Date().getFullYear());
