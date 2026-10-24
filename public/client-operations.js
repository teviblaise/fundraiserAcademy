import {createProfitSharingView,payoutStatement,payoutProcessingText} from './profit-sharing-view.js';

(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const section = byId('sponsorship-operations');
  if (!section) return;
  const content = byId('sponsorship-content');
  const status = byId('sponsorship-load-status');
  const refresh = byId('refresh-sponsorship');
  let loading = false;
  let loaded = false;
  let ended = false;
  let generation = 0;
  const sharing = createProfitSharingView({document,onDownload:receipt=>{
    if (ended) return;
    try {
      const statement=payoutStatement(receipt),url=URL.createObjectURL(new Blob([JSON.stringify(statement,null,2)],{type:'application/json'}));
      const link=document.createElement('a');link.href=url;link.download=`fundraiser-academy-payout-${statement.id}.json`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
      status.textContent='Your payout statement download started. Keep this financial record private.';
    } catch(error) {status.textContent=error.message;}
  }});

  const reviewStates = {
    assessment_required: ['Assessment required', 'Pass a reference-priced assessment with at least 10% realized profit over 3 distinct trading days before sponsorship review.', '/dashboard.html', 'Continue your assessment'],
    awaiting_contract: ['Awaiting academy agreement', 'Your qualifying assessment is recorded. The academy must publish the required agreement before you can sign and continue.'],
    signature_required: ['Agreement signature required', 'Read and sign the current trader agreement before the academy can review your sponsorship.', '/contract.html', 'Review your agreement'],
    email_confirmation_required: ['Email confirmation required', 'Confirm your account email before the academy can approve sponsorship.', '#confirm-email', 'Confirm your email'],
    account_suspended: ['Account restricted', 'Contact support to discuss your account before continuing with sponsorship.', '/support.html', 'Contact support'],
    eligible: ['Ready for review', 'Your qualifying assessment and signed agreement are recorded. A company review is required before sponsorship is approved.'],
    pending_review: ['Awaiting company review', 'The academy has your assessment and agreement. A reviewer still needs to make a sponsorship decision.'],
    needs_information: ['More information needed', 'The academy needs more information before completing your review. Check the message below and contact support.', '/support.html', 'Contact support'],
    approved: ['Review approved', 'Your sponsorship review is approved. The academy must arrange any external prop account separately. Recorded account arrangements appear below.'],
    rejected: ['Review not approved', 'The academy has not approved this sponsorship review. Check any message below or contact support for help.', '/support.html', 'Contact support'],
  };
  const accountStates = { active: 'Recorded active', paused: 'Recorded paused', closed: 'Recorded closed' };
  const payoutStates = { requested: 'Requested', approved: 'Approved for payment', paid: 'Recorded as paid', rejected: 'Rejected' };
  const policies = {
    cumulative_high_water: 'Profit share uses the cumulative high-water policy in your recorded account terms.',
    settled_period: 'Profit share uses the settled-period policy in your recorded account terms.',
    progressive_cleared: 'Your retained tier applies to the next eligible cleared prop-firm payout. All eligible accounts in your continuous contractual relationship contribute to the same progression total.',
  };
  const safeText = value => typeof value === 'string' ? value : '';
  const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
  const money = value => Number.isSafeInteger(value) ? new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value / 100) : '—';
  function date(value) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > 8640000000000000) return null;
    return new Date(value).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  }
  function element(tag, className, value) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (value !== undefined) node.textContent = value;
    return node;
  }
  function metric(label, value) {
    const wrapper = element('div');
    wrapper.append(element('dt', 'metric-label mb-1', label), element('dd', 'break-words text-sm', value));
    return wrapper;
  }
  function summary(count, shown, singular, plural) {
    const total = `${count} ${count === 1 ? singular : plural} recorded.`;
    return shown < count ? `${total} Showing the ${shown} most recent. Contact support for older records.` : total;
  }
  function validate(payload) {
    if (!record(payload) || !record(payload.review) || typeof payload.review.status !== 'string' || !record(payload.funding)) throw new Error('INVALID_RESPONSE');
    for (const [key, total] of [['accounts', 'accountsTotal'], ['payouts', 'payoutsTotal']]) {
      if (!Array.isArray(payload.funding[key]) || payload.funding[key].length > 100 || payload.funding[key].some(item => !record(item)) || !Number.isSafeInteger(payload.funding[total]) || payload.funding[total] < payload.funding[key].length) throw new Error('INVALID_RESPONSE');
    }
    for (const key of ['progressions','receipts']) if (payload.funding[key] !== undefined && (!Array.isArray(payload.funding[key]) || payload.funding[key].length > 100 || payload.funding[key].some(item=>!record(item)))) throw new Error('INVALID_RESPONSE');
    return payload;
  }
  function renderReview(view) {
    const description = Object.hasOwn(reviewStates, view.status) ? reviewStates[view.status] : ['Review status unavailable', 'Contact support to check the current status of your sponsorship review.'];
    byId('sponsorship-review-status').textContent = description[0];
    byId('sponsorship-review-detail').textContent = description[1];
    const saved = record(view.review) ? view.review : null;
    byId('sponsorship-stale-note').hidden = saved?.stale !== true;
    const message = safeText(saved?.clientMessage) || safeText(view.message);
    byId('sponsorship-message-panel').hidden = !message;
    byId('sponsorship-client-message').textContent = message;
    const updated = date(saved?.updatedAt);
    byId('sponsorship-reviewed-at').textContent = updated ? `Last review update: ${updated}` : '';
    byId('sponsorship-reviewed-at').hidden = !updated;
    const action = byId('sponsorship-next-action');
    action.hidden = !description[2];
    action.textContent = description[3] || '';
    if (description[2]) action.setAttribute('href', description[2]);
    else action.removeAttribute('href');
  }
  function renderAccount(row) {
    const card = element('article', 'rounded-lg border border-line p-4');
    card.append(element('h4', 'break-words text-sm font-semibold', safeText(row.label) || 'Sponsored account'));
    card.append(element('p', 'mt-1 break-words text-xs text-muted', safeText(row.firmName) || 'Prop firm not recorded'));
    card.append(element('p', 'mt-3 text-xs text-lime', Object.hasOwn(accountStates, row.status) ? accountStates[row.status] : 'Account status unavailable'));
    const share = Number.isSafeInteger(row.traderShareBps) && row.traderShareBps >= 0 && row.traderShareBps <= 10000 ? `${row.traderShareBps / 100}%` : '—';
    const metrics = element('dl', 'mt-4 grid grid-cols-2 gap-4');
    const progressive=row.sharingModel==='progressive_cleared';
    metrics.append(metric('Account size', money(row.accountSizeCents)), metric(progressive?'Your share on next eligible payout':'Your profit share', share), metric(progressive?'Qualifying net payouts · all eligible accounts':'Recorded net profit', money(progressive?row.progression?.cumulativeQualifyingNetPayoutsCents:row.cumulativeNetProfitCents)), metric('Your earned share', money(row.earnedCents)), metric('Reserved for payouts', money(row.reservedCents)), metric('Recorded payments', money(row.paidCents)), metric('Unreserved earned share', money(row.availableCents)));
    card.append(metrics);
    if (Object.hasOwn(policies, row.profitSharingPolicy)) card.append(element('p', 'mt-4 text-xs text-muted', policies[row.profitSharingPolicy]));
    if (!progressive) card.append(element('p','mt-3 text-xs text-muted','Existing account terms remain in effect. Historical statements and payments have not been recalculated.'));
    const updated = date(row.updatedAt);
    if (updated) card.append(element('p', 'mt-3 text-xs text-muted', `Account record updated: ${updated}`));
    return card;
  }
  function renderPayout(row) {
    const card = element('article', 'rounded-lg border border-line p-4');
    const top = element('div', 'flex flex-wrap items-center justify-between gap-3');
    top.append(element('h4', 'text-lg font-semibold', money(row.amountCents)), element('span', 'rounded-full border border-line px-3 py-1 text-xs', Object.hasOwn(payoutStates, row.status) ? payoutStates[row.status] : 'Payout status unavailable'));
    card.append(top, element('p', 'mt-3 break-words text-sm', safeText(row.label) || 'Sponsored account'), element('p', 'mt-1 break-words text-xs text-muted', safeText(row.firmName) || 'Prop firm not recorded'));
    const created = date(row.createdAt), paid = date(row.paidAt), updated = date(row.updatedAt);
    if (created) card.append(element('p', 'mt-3 text-xs text-muted', `Recorded: ${created}`));
    if (row.status === 'paid' && paid) card.append(element('p', 'mt-1 text-xs text-muted', `Recorded payment date: ${paid}`));
    else if (updated) card.append(element('p', 'mt-1 text-xs text-muted', `Updated: ${updated}`));
    const processing=payoutProcessingText(row);if(processing)card.append(element('p','mt-3 text-xs text-muted',processing));
    return card;
  }
  function render(payload) {
    renderReview(payload.review);
    const funding = payload.funding;
    sharing.render(byId('sponsored-profit-sharing'),funding);
    byId('sponsored-accounts-summary').textContent = summary(funding.accountsTotal, funding.accounts.length, 'account', 'accounts');
    byId('sponsored-payouts-summary').textContent = summary(funding.payoutsTotal, funding.payouts.length, 'payout', 'payouts');
    byId('sponsored-accounts-list').replaceChildren(...(funding.accounts.length ? funding.accounts.map(renderAccount) : [element('p', 'rounded-lg border border-line p-4 text-sm text-muted', 'No sponsored account arrangements have been recorded for your account yet.')]));
    byId('sponsored-payouts-list').replaceChildren(...(funding.payouts.length ? funding.payouts.map(renderPayout) : [element('p', 'rounded-lg border border-line p-4 text-sm text-muted', 'No payout records yet. Payouts appear here after the academy records them.')]));
    content.hidden = false;
    loaded = true;
  }
  function clear() {
    content.hidden = true;
    byId('sponsored-accounts-list').replaceChildren();
    byId('sponsored-payouts-list').replaceChildren();
    byId('sponsored-profit-sharing').replaceChildren();
    for (const id of ['sponsorship-review-status', 'sponsorship-review-detail', 'sponsorship-client-message', 'sponsorship-reviewed-at', 'sponsored-accounts-summary', 'sponsored-payouts-summary']) byId(id).textContent = '';
    loaded = false;
  }
  async function load() {
    if (loading || ended) return;
    loading = true;
    const requestGeneration = ++generation;
    refresh.disabled = true;
    section.setAttribute('aria-busy', 'true');
    byId('sponsorship-login').hidden = true;
    status.textContent = 'Refreshing your sponsorship information…';
    try {
      const response = await fetch('/api/sponsorship', { method: 'GET', credentials: 'same-origin', cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(20000) });
      if (ended || requestGeneration !== generation) return;
      if (response.status === 401) {
        clear();
        byId('sponsorship-login').hidden = false;
        status.textContent = 'Please log in again to view your sponsorship records.';
        return;
      }
      if (response.status === 403) {
        clear();
        throw new Error('ACCESS_DENIED');
      }
      if (!response.ok) throw new Error('REQUEST_FAILED');
      const payload = validate(await response.json());
      if (ended || requestGeneration !== generation) return;
      render(payload);
      status.textContent = `Records refreshed at ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.`;
    } catch (error) {
      if (ended || requestGeneration !== generation) return;
      const message = error.message === 'ACCESS_DENIED' ? 'Your sponsorship records are unavailable. Contact support for help.' : 'We couldn’t load your sponsorship information. Please try refreshing.';
      status.textContent = message + (loaded ? ' Previously loaded records below may be out of date.' : '');
    } finally {
      if (requestGeneration === generation && !ended) {
        loading = false;
        refresh.disabled = false;
        section.setAttribute('aria-busy', 'false');
      }
    }
  }
  refresh.addEventListener('click', load);
  byId('refresh-overview')?.addEventListener('click', load);
  window.addEventListener('pagehide', () => {
    ended = true;
    generation++;
    loading = false;
    clear();
    status.textContent = 'Refresh to view your sponsorship information.';
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) { ended = false; void load(); }
  });
  void load();
})();
