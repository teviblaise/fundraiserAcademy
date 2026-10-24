const GUIDE_ANSWERS = [
  ['How does Fundraiser Academy work?', 'We call our traders Fundraisers. We help people who can already trade but need capital to scale. Approved Fundraisers may receive a company-sponsored account from an approved third-party prop firm, subject to its rules and authorizations. The company bears agreed evaluation costs and ordinary permitted trading losses under the written agreement.'],
  ['Why is Fundraiser added to my name?', 'Your Academy display title is your registered first name followed by Fundraiser. Your registered names, legal signature, and certificate-name choice are managed separately. Public leaderboard participation uses your chosen public alias.'],
  ['How does profit sharing progress?', 'Newly admitted Fundraisers start at 50% to the Fundraiser and 50% to the company. Cumulative qualifying net payouts actually received and cleared by the company across eligible sponsored accounts advance the next eligible payout to 60% at $10,000 and 70% at $25,000. The payout that reaches a threshold uses the earlier tier. Earned tiers stay in place during a continuous contractual relationship.'],
  ['When are payouts processed?', 'The company must initiate the Fundraiser’s payment within three business days after receiving cleared prop-firm funds. The processing calendar is Monday–Friday in Africa/Lagos. A payout request or approval is separate from external payment initiation and completion.'],
  ['What are the assessment rules?', 'The demo assessment starts at $10,000. Passing requires 10% realized profit, no open positions, and at least three distinct UTC trading days. The total drawdown limit is 10% of the initial balance; the daily drawdown limit is 5% of UTC day-start equity.'],
  ['How do I confirm my email?', 'Use an email address you can access when registering. Open the confirmation link sent to that address, then refresh your client dashboard. Check spam and use “Resend confirmation email” on your dashboard if needed. New users must confirm their email before trading.'],
  ['What happens after passing?', 'A passing Fundraiser receives a certificate and can choose their registered name or nickname on it. Read and sign the company-provided agreement before sponsorship review. Passing the assessment and signing do not automatically approve funding.'],
];

function element(tag, className, content) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (content !== undefined) node.textContent = content;
  return node;
}

async function supportRequest(path, data) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    signal: AbortSignal.timeout(data === undefined ? 12000 : 35000),
    ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy' }, body: JSON.stringify(data) }),
  });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok) {
    const error = new Error(result.error || 'Support is temporarily unavailable. Please try again.');
    error.status = response.status;
    throw error;
  }
  return result;
}

export function initSupportChat(launcher) {
  if (document.getElementById('academy-support-dialog')) return;
  const dialog = element('dialog', 'support-dialog fixed bottom-4 right-4 left-auto top-auto z-50 m-0 w-[min(440px,calc(100%-24px))] max-h-[calc(100dvh-32px)] overflow-hidden rounded-2xl border border-line bg-paper p-0 text-white shadow-2xl');
  dialog.id = 'academy-support-dialog';
  dialog.setAttribute('aria-labelledby', 'academy-support-title');
  // This template contains only fixed UI labels. All server content is rendered with textContent.
  dialog.innerHTML = `
    <header class="flex shrink-0 items-start justify-between gap-4 border-b border-line px-5 py-4">
      <div class="min-w-0"><p class="mb-1 text-[10px] font-semibold uppercase tracking-widest text-lime">Fundraiser Academy</p><h2 id="academy-support-title" class="mb-1 text-xl tracking-tight">Customer support</h2><p class="text-xs text-muted" data-support-mode>Loading support…</p></div>
      <button type="button" class="desk-action shrink-0" data-support-close aria-label="Close customer support">Close</button>
    </header>
    <div class="min-h-0 overflow-y-auto px-5 pt-4 pb-5" data-support-body>
      <p class="mb-3 text-xs text-muted">Ask about the company, registration, assessments, or certificates. For account-specific help, request an agent.</p>
      <div class="mb-4" data-support-guide><p class="metric-label">Academy guide · published information</p><div class="space-y-2" data-support-faq></div></div>
      <div class="mb-4 rounded-lg border border-line bg-[#151515] p-4" data-support-signin hidden><p class="mb-3 text-sm">Sign in to save a conversation and request a human agent. You can ask for support before confirming your email.</p><div class="flex flex-wrap gap-2"><a class="desk-action" href="/login.html">Sign in</a><a class="desk-action" href="/contact.html">Create account</a></div></div>
      <div class="mb-4" data-support-history-wrap hidden><label class="metric-label" for="support-conversations">Your conversations</label><select id="support-conversations" class="mb-0 text-xs" data-support-history><option value="">Current conversation</option></select><button type="button" class="desk-action mt-2" data-support-more-history hidden>Load more conversations</button></div>
      <div class="mb-3 flex flex-wrap gap-2" data-support-tools hidden><button type="button" class="desk-action" data-support-handoff>Talk to an agent</button><button type="button" class="desk-action" data-support-new hidden>Start a new conversation</button><a class="desk-action" href="/support-agent.html" data-support-staff hidden>Agent inbox</a></div>
      <p class="mb-4 rounded-lg border border-lime/30 bg-lime/10 px-3 py-2 text-xs" data-support-state hidden></p>
      <button type="button" class="desk-action mb-3" data-support-older hidden>Load earlier messages</button>
      <div class="space-y-3" data-support-transcript aria-label="Support conversation" aria-live="polite" aria-relevant="additions"></div>
    </div>
    <div class="shrink-0 border-t border-line bg-[#151515] px-5 py-4">
      <form data-support-form hidden><label class="metric-label" for="support-message">Your message</label><textarea id="support-message" name="message" class="mb-3 max-h-36 resize-y text-sm" rows="2" maxlength="2000" required placeholder="How can we help?" aria-describedby="support-privacy"></textarea><button type="submit" class="button small" data-support-send>Send message</button></form>
      <p id="support-privacy" class="mt-3 text-[10px] leading-relaxed text-muted">Messages may be processed by our AI provider and read by authorized support staff. Never share passwords, API keys, payment details, or identity documents. You can request an agent directly. <a href="/privacy.html" class="underline underline-offset-2">Privacy</a></p>
      <p class="mt-3 text-xs" role="status" aria-live="polite" data-support-status></p>
      <button type="button" class="desk-action mt-3" data-support-retry hidden>Retry connection</button>
    </div>`;
  document.body.append(dialog);
  launcher.setAttribute('aria-haspopup', 'dialog');
  launcher.setAttribute('aria-controls', dialog.id);
  launcher.setAttribute('aria-expanded', 'false');
  launcher.setAttribute('role', 'button');
  const find = selector => dialog.querySelector(selector);
  const mode = find('[data-support-mode]');
  const status = find('[data-support-status]');
  const form = find('[data-support-form]');
  const input = find('#support-message');
  const send = find('[data-support-send]');
  const handoff = find('[data-support-handoff]');
  const stateLabel = find('[data-support-state]');
  const transcript = find('[data-support-transcript]');
  const body = find('[data-support-body]');
  const history = find('[data-support-history]');
  const olderButton = find('[data-support-older]');
  let conversation = null;
  let capabilities = {};
  let authenticated = null;
  let connectionFailed = false;
  let busy = false;
  let fetching = false;
  let newDraft = false;
  let pending = null;
  let timer = null;
  let opener = null;
  let viewGeneration = 0;
  let requestSequence = 0;
  let appliedSequence = 0;
  let olderCursor = null;
  let messages = new Map();
  let renderedSignature = '';
  let historyCursor = null;
  let historyLoading = false;
  let historyItems = new Map();

  for (const [question, answer] of GUIDE_ANSWERS) {
    const detail = element('details', 'rounded-lg border border-line px-3 py-2 text-xs');
    const summary = element('summary', 'cursor-pointer font-semibold text-white', question);
    detail.append(summary, element('p', 'mt-2 text-muted', answer));
    find('[data-support-faq]').append(detail);
  }

  function render() {
    const active = authenticated === true;
    const closed = conversation?.status === 'closed';
    const transferred = ['waiting', 'assigned'].includes(conversation?.status);
    mode.textContent = authenticated === null ? connectionFailed ? 'Academy guide · support connection unavailable' : 'Loading support…' : authenticated === false ? 'Academy guide · quick company answers' : conversation?.status === 'waiting' ? 'Human support · waiting for an agent' : conversation?.status === 'assigned' ? 'Human support · agent assigned' : closed ? 'Saved conversation · closed' : capabilities.aiAvailable ? 'AI assistant · company questions' : 'Academy guide · AI replies are unavailable';
    find('[data-support-retry]').hidden = !connectionFailed;
    find('[data-support-signin]').hidden = authenticated !== false;
    find('[data-support-guide]').hidden = authenticated === true && messages.size > 0;
    find('[data-support-tools]').hidden = !active;
    find('[data-support-staff]').hidden = !capabilities.staff;
    find('[data-support-new]').hidden = !closed;
    handoff.hidden = transferred || closed;
    handoff.disabled = false;
    form.hidden = !active || closed;
    send.disabled = busy;
    input.disabled = busy;
    send.textContent = busy ? 'Sending…' : pending ? 'Retry message' : 'Send message';
    history.disabled = busy;
    find('[data-support-history-wrap]').hidden = !active || history.options.length < 3;
    stateLabel.hidden = !conversation || conversation.status === 'ai';
    if (conversation?.status === 'waiting') stateLabel.textContent = 'Agent request sent. A team member will reply here when available. Automated replies are paused.';
    else if (conversation?.status === 'assigned') stateLabel.textContent = `${conversation.assignedAgentName || 'An academy agent'} is assigned to this conversation. Their replies appear below. Automated replies are paused.`;
    else if (closed) stateLabel.textContent = 'This conversation is closed. Its history is saved. Start a new conversation if you need more help.';
    olderButton.hidden = olderCursor === null;
    const ordered = [...messages.values()].sort((a, b) => a.id - b.id);
    const signature = JSON.stringify(ordered);
    if (signature === renderedSignature) return;
    const atBottom = body.scrollHeight - body.clientHeight - body.scrollTop < 70;
    renderedSignature = signature;
    transcript.replaceChildren();
    for (const message of ordered) {
      const user = message.role === 'user';
      const row = element('article', user ? 'ml-7 rounded-xl border border-lime/30 bg-lime/10 p-3' : 'mr-7 rounded-xl border border-line bg-[#151515] p-3');
      const label = user ? 'You' : message.role === 'agent' ? 'Academy agent' : message.role === 'system' ? 'Support update' : message.source === 'ai' ? 'AI assistant' : 'Academy guide';
      row.append(element('p', 'mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted', label));
      row.append(element('p', 'whitespace-pre-wrap break-words text-sm', String(message.content || '')));
      const timestamp = new Date(message.createdAt);
      if (Number.isFinite(timestamp.getTime())) {
        const time = element('time', 'mt-2 block text-[10px] text-muted', timestamp.toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }));
        time.dateTime = timestamp.toISOString();
        row.append(time);
      }
      transcript.append(row);
    }
    if (atBottom) body.scrollTop = body.scrollHeight;
  }

  function apply(result, sequence, generation, { older = false } = {}) {
    if (generation !== viewGeneration || sequence < appliedSequence) return;
    appliedSequence = sequence;
    authenticated = true;
    connectionFailed = false;
    capabilities = result.capabilities || {};
    const next = result.conversation || null;
    if (conversation?.id !== next?.id) {
      messages = new Map();
      olderCursor = next?.olderCursor ?? null;
    } else if (older || messages.size === 0) olderCursor = next?.olderCursor ?? null;
    conversation = next;
    if (next) {
      for (const message of next.messages || []) messages.set(message.id, message);
      if (pending && (next.messages || []).some(message => message.clientMessageId === pending.clientMessageId)) {
        if (input.value.trim() === pending.message) input.value = '';
        pending = null;
        if (!busy) status.textContent = 'Your message is saved.';
      }
      newDraft = false;
    }
    render();
    if (result.processing && !busy) status.textContent = 'Your message is saved. Preparing a reply…';
    else if (!busy && status.textContent === 'Your message is saved. Preparing a reply…') status.textContent = '';
  }

  function reportError(error) {
    if (error.status === 401) {
      viewGeneration += 1;
      authenticated = false;
      capabilities = {};
      conversation = null;
      messages = new Map();
      olderCursor = null;
      historyItems = new Map();
      historyCursor = null;
      history.replaceChildren(element('option', '', 'Current conversation'));
      history.firstElementChild.value = '';
      status.textContent = 'Sign in to continue your saved support conversation.';
    } else {
      connectionFailed = true;
      status.textContent = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'The request took too long. Your message may already be saved. Retry with the same message or refresh support.' : error.message;
    }
    render();
  }

  async function refresh() {
    if (!dialog.open || document.hidden || fetching || busy || newDraft || authenticated === false) return;
    fetching = true;
    const generation = viewGeneration;
    const sequence = ++requestSequence;
    try {
      const query = conversation?.id ? `?conversationId=${encodeURIComponent(conversation.id)}` : '';
      apply(await supportRequest(`/api/support${query}`), sequence, generation);
    } catch (error) { if (generation === viewGeneration) reportError(error); }
    finally { fetching = false; }
  }

  async function loadHistory(more = false) {
    if (historyLoading || more && historyCursor === null) return;
    historyLoading = true;
    const generation = viewGeneration;
    find('[data-support-more-history]').disabled = true;
    try {
      const result = await supportRequest(`/api/support/conversations${more ? `?before=${encodeURIComponent(historyCursor)}` : ''}`);
      if (generation !== viewGeneration || authenticated !== true) return;
      for (const item of result.conversations || []) historyItems.set(item.id, item);
      if (more || historyCursor === null || historyItems.size <= 50) historyCursor = result.nextCursor ?? null;
      const previous = history.value;
      history.replaceChildren(element('option', '', 'Current conversation'));
      history.firstElementChild.value = '';
      for (const item of [...historyItems.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))) {
        const date = new Date(item.createdAt);
        const option = element('option', '', `${Number.isFinite(date.getTime()) ? date.toLocaleDateString() : 'Conversation'} · ${item.status === 'ai' ? 'Assistant' : item.status}`);
        option.value = item.id;
        history.append(option);
      }
      history.value = previous;
      find('[data-support-history-wrap]').hidden = history.options.length < 3;
      find('[data-support-more-history]').hidden = historyCursor === null;
    } catch { /* Conversation history is optional; the current conversation remains usable. */ }
    finally { historyLoading = false; find('[data-support-more-history]').disabled = false; }
  }

  function schedule() {
    clearInterval(timer);
    timer = null;
    if (dialog.open && !document.hidden) timer = setInterval(refresh, 5000);
  }

  async function open(event) {
    event?.preventDefault();
    if (dialog.open) return;
    opener = event?.currentTarget || document.activeElement;
    dialog.showModal();
    launcher.setAttribute('aria-expanded', 'true');
    if (!newDraft) authenticated = null;
    render();
    await refresh();
    if (authenticated === true) loadHistory();
    schedule();
  }

  function close() { if (dialog.open) dialog.close(); }
  launcher.addEventListener('click', open);
  launcher.addEventListener('keydown', event => { if (event.key === ' ') open(event); });
  document.querySelectorAll('[data-open-support]').forEach(button => button.addEventListener('click', open));
  find('[data-support-close]').addEventListener('click', close);
  find('[data-support-more-history]').addEventListener('click', () => loadHistory(true));
  find('[data-support-retry]').addEventListener('click', async () => {
    if (busy || fetching) return;
    authenticated = null;
    connectionFailed = false;
    status.textContent = 'Connecting to support…';
    render();
    if (newDraft) newDraft = false;
    await refresh();
    if (authenticated === true) { status.textContent = ''; loadHistory(); }
  });
  dialog.addEventListener('close', () => {
    clearInterval(timer);
    timer = null;
    launcher.setAttribute('aria-expanded', 'false');
    opener?.focus?.();
  });
  dialog.addEventListener('click', event => { if (event.target === dialog) { const box = dialog.getBoundingClientRect(); if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) close(); } });
  document.addEventListener('visibilitychange', () => { schedule(); if (!document.hidden) refresh(); });
  window.addEventListener('pagehide', () => { clearInterval(timer); timer = null; });
  window.addEventListener('pageshow', schedule);

  form.addEventListener('submit', async event => {
    event.preventDefault();
    const message = input.value.trim();
    if (busy || !message || !form.reportValidity()) return;
    const conversationId = conversation?.status !== 'closed' ? conversation?.id : undefined;
    // The server may assign a conversation after a timed-out first send. Keep
    // that original message ID until delivered, even if the new ID is learned.
    if (!pending || pending.message !== message || pending.conversationId && pending.conversationId !== conversationId) pending = { message, clientMessageId: crypto.randomUUID(), ...(conversationId ? { conversationId } : {}) };
    const payload = pending;
    const generation = viewGeneration;
    const sequence = ++requestSequence;
    busy = true;
    status.textContent = conversation && ['waiting', 'assigned'].includes(conversation.status) ? 'Saving your message for the support team…' : 'Sending your message…';
    render();
    try {
      const result = await supportRequest('/api/support/messages', payload);
      if (generation !== viewGeneration) return;
      pending = null;
      input.value = '';
      apply(result, sequence, generation);
      status.textContent = result.processing ? 'Your message is saved. Preparing a reply…' : result.conversation?.status === 'waiting' ? 'Your message is saved for the support team.' : result.conversation?.status === 'assigned' ? 'Your message is saved for your assigned agent.' : '';
      loadHistory();
    } catch (error) { if (generation === viewGeneration) reportError(error); }
    finally { busy = false; render(); }
  });

  handoff.addEventListener('click', async () => {
    if (handoff.disabled) return;
    handoff.disabled = true;
    const generation = viewGeneration;
    const sequence = ++requestSequence;
    status.textContent = 'Requesting a human agent…';
    try {
      const result = await supportRequest('/api/support/handoff', conversation?.id ? { conversationId: conversation.id } : {});
      apply(result, sequence, generation);
      if (generation === viewGeneration) status.textContent = 'Your request is saved. Agent replies will appear in this conversation.';
      loadHistory();
    } catch (error) { if (generation === viewGeneration) reportError(error); }
    finally { handoff.disabled = false; }
  });

  find('[data-support-new]').addEventListener('click', () => {
    viewGeneration += 1;
    conversation = null;
    messages = new Map();
    olderCursor = null;
    pending = null;
    newDraft = true;
    history.value = '';
    status.textContent = 'Start with a new question or request an agent directly.';
    render();
    input.focus();
  });

  history.addEventListener('change', async () => {
    const generation = ++viewGeneration;
    const sequence = ++requestSequence;
    pending = null;
    newDraft = false;
    messages = new Map();
    olderCursor = null;
    conversation = null;
    status.textContent = 'Loading your conversation…';
    try {
      const query = history.value ? `?conversationId=${encodeURIComponent(history.value)}` : '';
      apply(await supportRequest(`/api/support${query}`), sequence, generation);
      if (generation === viewGeneration) status.textContent = '';
    } catch (error) { if (generation === viewGeneration) reportError(error); }
  });

  olderButton.addEventListener('click', async () => {
    if (!conversation?.id || olderCursor === null) return;
    olderButton.disabled = true;
    const generation = viewGeneration;
    const sequence = ++requestSequence;
    const scrollHeight = body.scrollHeight;
    const scrollTop = body.scrollTop;
    try {
      const query = `?conversationId=${encodeURIComponent(conversation.id)}&before=${encodeURIComponent(olderCursor)}`;
      apply(await supportRequest(`/api/support${query}`), sequence, generation, { older: true });
      if (generation === viewGeneration) body.scrollTop = scrollTop + body.scrollHeight - scrollHeight;
    } catch (error) { if (generation === viewGeneration) reportError(error); }
    finally { olderButton.disabled = false; }
  });
}
