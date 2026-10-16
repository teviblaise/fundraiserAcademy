const $ = id => document.getElementById(id);
const pageSize = 20;
const money = value => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
const percent = value => `${value >= 0 ? '+' : ''}${value.toFixed(2)}%`;
const date = value => new Date(value).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' });
let preferences = null;
let offset = 0;
let nextOffset = null;
let boardRequest = 0;
let preferencesRequest = 0;
let loadingBoard = false;
let saving = false;
let lastBoard = null;

async function api(path, data) {
  let response;
  try {
    response = await fetch(path, {
      credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(12000),
      ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy' }, body: JSON.stringify(data) }),
    });
  } catch (error) {
    throw new Error(error.name === 'TimeoutError' || error.name === 'AbortError' ? 'The request took too long. Please try again.' : 'Could not reach the academy. Check your connection and try again.');
  }
  let result;
  try { result = await response.json(); } catch { throw new Error('The server returned an unreadable response. Please try again.'); }
  if (!response.ok) {
    const error = new Error(result.error || 'Your request could not be completed. Please try again.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function validEntry(entry) {
  return entry && typeof entry.displayAlias === 'string' && entry.displayAlias.length > 0 && Number.isInteger(entry.rank) && entry.rank > 0 && Number.isFinite(entry.returnPercent) && Number.isFinite(entry.realizedProfit) && Number.isInteger(entry.tradingDays) && entry.tradingDays >= 3 && Number.isFinite(entry.completedAt) && !Number.isNaN(new Date(entry.completedAt).getTime());
}

function renderBoard(result) {
  if (!Array.isArray(result.entries) || !result.entries.every(validEntry) || !Number.isInteger(result.total) || result.total < 0 || !Number.isInteger(result.offset) || result.offset < 0 || (result.nextOffset !== null && (!Number.isInteger(result.nextOffset) || result.nextOffset <= result.offset))) throw new Error('The ranking records could not be read. Please refresh to try again.');
  offset = result.offset;
  nextOffset = result.nextOffset;
  lastBoard = result;
  $('ranked-count').textContent = String(result.total);
  $('rankings-body').replaceChildren();
  for (const entry of result.entries) {
    const row = document.createElement('tr');
    const rank = document.createElement('th');
    rank.scope = 'row';
    rank.className = 'text-lime';
    rank.textContent = `#${entry.rank}`;
    row.append(rank);
    for (const [index, text] of [entry.displayAlias, percent(entry.returnPercent), money(entry.realizedProfit), String(entry.tradingDays), date(entry.completedAt)].entries()) {
      const cell = document.createElement('td');
      if (index === 0) cell.className = 'font-semibold';
      if (index === 1) cell.className = 'font-semibold text-lime';
      cell.textContent = text;
      row.append(cell);
    }
    $('rankings-body').append(row);
  }
  const empty = result.total === 0;
  $('ranking-empty').hidden = !empty;
  $('rankings-scroll').hidden = !result.entries.length;
  $('ranking-status').textContent = '';
  $('ranking-status').hidden = true;
  $('ranking-updated').textContent = Number.isFinite(result.updatedAt) ? `Updated ${new Date(result.updatedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · qualifying assessment records` : 'Latest qualifying assessment records';
  $('page-detail').textContent = empty ? 'No public entries yet.' : result.entries.length ? `Showing ${offset + 1}–${offset + result.entries.length} of ${result.total} traders` : 'There are no entries on this page. Return to the previous page.';
}

function setBoardLoading(value) {
  loadingBoard = value;
  $('rankings-table').setAttribute('aria-busy', String(value));
  $('refresh-rankings').disabled = value;
  $('previous-page').disabled = value || offset === 0;
  $('next-page').disabled = value || nextOffset === null;
}

async function loadBoard(requestedOffset = offset) {
  const requestId = ++boardRequest;
  setBoardLoading(true);
  $('ranking-status').hidden = false;
  $('ranking-status').textContent = 'Loading the leaderboard…';
  try {
    const result = await api(`/api/leaderboard?limit=${pageSize}&offset=${requestedOffset}`);
    if (requestId !== boardRequest) return;
    renderBoard(result);
  } catch (error) {
    if (requestId !== boardRequest) return;
    $('ranking-status').hidden = false;
    $('ranking-status').textContent = `${error.message}${lastBoard ? ' The previous results remain below.' : ''}`;
    $('ranking-updated').textContent = lastBoard ? 'Previous results · refresh to check for changes' : 'Rankings are currently unavailable';
  } finally { if (requestId === boardRequest) setBoardLoading(false); }
}

const eligibilityCopy = {
  assessment_required: { detail: 'Complete your assessment first. Your entry can appear after a verified pass and signing the current agreement.', href: '/dashboard.html', label: 'Continue your assessment →' },
  awaiting_contract: { detail: 'Your assessment is complete. The company agreement is not available yet. Your entry can appear after you sign the current agreement.', href: '/contract.html', label: 'View agreement status →' },
  signature_required: { detail: 'Review and sign the current academy agreement to make your qualifying assessment eligible for the board.', href: '/contract.html', label: 'Review your agreement →' },
  ineligible_certificate: { detail: 'The qualifying assessment linked to your agreement could not be verified for the leaderboard. Contact support to review your record.', href: '/support.html', label: 'Contact the academy →' },
  eligible: { detail: 'Your qualifying assessment and current signed agreement meet the leaderboard requirements. Choose whether to share your result below.' },
};

function renderPreferences(result, { fillForm = true } = {}) {
  if (!result || typeof result.enabled !== 'boolean' || typeof result.alias !== 'string' || !result.eligibility || typeof result.eligibility.eligible !== 'boolean' || (result.entry !== null && !validEntry(result.entry))) throw new Error('Your participation settings could not be read. Please try again.');
  preferences = result;
  $('preferences-loading').hidden = true;
  $('preferences-guest').hidden = true;
  $('preferences-error').hidden = true;
  $('preferences-account').hidden = false;
  if (fillForm) {
    $('participation-enabled').checked = result.enabled;
    $('public-alias').value = result.alias;
    $('public-alias').setCustomValidity('');
  }
  const current = result.entry;
  $('your-rank-label').textContent = current ? 'Your rank · all public entries' : 'Your participation';
  $('your-rank').textContent = current ? `#${current.rank} · ${current.displayAlias}` : !result.enabled ? 'Not listed' : 'Waiting for eligibility';
  $('your-rank-detail').textContent = current ? `${percent(current.returnPercent)} realized return · ${money(current.realizedProfit)} demo profit · ${current.tradingDays} trading days` : !result.enabled ? 'Your result is private. Enable participation to join when eligible.' : 'Your preference is saved. Your alias and result appear only after your records meet the requirements.';
  const copy = eligibilityCopy[result.eligibility.status] || { detail: 'Your assessment and current signed agreement must be verified before you can appear. Contact support if your eligibility needs review.' };
  $('eligibility-detail').textContent = copy.detail;
  $('eligibility-action').hidden = !copy.href;
  if (copy.href) {
    $('eligibility-action').href = copy.href;
    $('eligibility-action').textContent = copy.label;
  }
  updateAliasRequirement();
}

function showGuest() {
  preferences = null;
  $('preferences-loading').hidden = true;
  $('preferences-account').hidden = true;
  $('preferences-error').hidden = true;
  $('preferences-guest').hidden = false;
}

async function loadPreferences({ fillForm = true } = {}) {
  const requestId = ++preferencesRequest;
  $('retry-preferences').disabled = true;
  try {
    const result = await api('/api/leaderboard/preferences');
    if (requestId !== preferencesRequest || saving) return;
    renderPreferences(result, { fillForm });
  } catch (error) {
    if (requestId !== preferencesRequest || saving) return;
    $('preferences-loading').hidden = true;
    if (error.status === 401) showGuest();
    else {
      $('preferences-error-message').textContent = error.message;
      $('preferences-error').hidden = false;
    }
  } finally { if (requestId === preferencesRequest) $('retry-preferences').disabled = false; }
}

function updateAliasRequirement() {
  const enabled = $('participation-enabled').checked;
  $('public-alias').required = enabled;
  $('public-alias').setCustomValidity('');
}

$('participation-enabled').addEventListener('change', updateAliasRequirement);
$('public-alias').addEventListener('input', () => $('public-alias').setCustomValidity(''));
$('participation-form').addEventListener('submit', async event => {
  event.preventDefault();
  if (saving || !preferences) return;
  const enabled = $('participation-enabled').checked;
  const alias = $('public-alias').value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
  if (alias && !/^[\p{L}\p{M}\p{N} '\u2019-]+$/u.test(alias)) $('public-alias').setCustomValidity('Use letters, numbers, spaces, apostrophes, or hyphens.');
  if (enabled && !alias) $('public-alias').setCustomValidity('Choose a public alias to join the leaderboard.');
  if (!event.currentTarget.reportValidity()) return;
  saving = true;
  ++preferencesRequest;
  $('save-participation').disabled = true;
  $('participation-enabled').disabled = true;
  $('public-alias').disabled = true;
  $('participation-status').textContent = 'Saving your participation preference…';
  try {
    const result = await api('/api/leaderboard/preferences', { enabled, alias });
    renderPreferences(result);
    $('participation-status').textContent = !result.enabled ? 'Saved. Your entry is hidden from the public leaderboard.' : result.entry ? 'Saved. Your alias and qualifying assessment are now on the leaderboard.' : 'Saved. Your entry will appear once your assessment and current agreement meet the requirements.';
    void loadBoard(0);
  } catch (error) {
    if (error.status === 401) showGuest();
    $('participation-status').textContent = error.status === 401 ? 'Your session expired. Log in again to save your participation preference.' : error.message;
    if (error.status === 401) {
      $('preferences-loading').hidden = false;
      $('preferences-loading').textContent = 'Your session expired. Log in again to manage your entry.';
    }
  } finally {
    saving = false;
    $('save-participation').disabled = false;
    $('participation-enabled').disabled = false;
    $('public-alias').disabled = false;
  }
});

$('refresh-rankings').addEventListener('click', () => {
  if (loadingBoard) return;
  void loadBoard();
  if (!saving) void loadPreferences({ fillForm: preferences === null });
});
$('previous-page').addEventListener('click', () => { if (!loadingBoard && offset > 0) void loadBoard(Math.max(0, offset - pageSize)); });
$('next-page').addEventListener('click', () => { if (!loadingBoard && nextOffset !== null) void loadBoard(nextOffset); });
$('retry-preferences').addEventListener('click', () => void loadPreferences({ fillForm: preferences === null }));

void loadBoard(0);
void loadPreferences();
