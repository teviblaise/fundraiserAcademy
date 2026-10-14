const $ = id => document.getElementById(id);
const status = $('support-agent-status');
const caseStatus = $('support-case-status');
const list = $('support-agent-list');
const messagesElement = $('support-case-messages');
const replyForm = $('support-agent-reply');
const input = $('support-agent-message');
const sendButton = $('support-agent-send');
const claimButton = $('support-case-claim');
const closeButton = $('support-case-close');
const olderButton = $('support-case-older');
const filter = $('support-agent-filter');
const moreButton = $('support-agent-more');
let authorized = false;
let selected = null;
let current = null;
let client = null;
let polling = null;
let refreshing = false;
let busy = false;
let pendingReply = null;
let generation = 0;
let caseVersion = 0;
let olderCursor = null;
let messages = new Map();
let renderedSignature = '';
let listGeneration = 0;
let listItems = new Map();
let nextCursor = null;
let loadedMore = false;

function node(tag, className, content) {
  const item = document.createElement(tag);
  if (className) item.className = className;
  if (content !== undefined) item.textContent = content;
  return item;
}

async function request(path, data) {
  const response = await fetch(path, { credentials: 'same-origin', signal: AbortSignal.timeout(15000), ...(data === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy' }, body: JSON.stringify(data) }) });
  let result;
  try { result = await response.json(); } catch { result = {}; }
  if (!response.ok) {
    const error = new Error(result.error || 'The support request could not be completed.');
    error.status = response.status;
    throw error;
  }
  return result;
}

function fail(error, target = status) {
  if (error.status === 401) { window.location.assign('/login.html'); return; }
  if (error.status === 403) {
    authorized = false;
    $('support-agent-workspace').hidden = true;
    $('support-agent-denied').hidden = false;
    clearInterval(polling);
    polling = null;
  }
  target.textContent = error.name === 'TimeoutError' || error.name === 'AbortError' ? 'The request took too long. Refresh the conversation before retrying. Replies use the same message ID when retried.' : error.message;
}

function renderCase() {
  if (!current) return;
  const name = client?.name || 'Academy client';
  $('support-case-title').textContent = name;
  $('support-case-detail').textContent = [client?.email, current.status === 'waiting' ? 'Waiting for an agent' : current.status === 'assigned' ? `Assigned to ${current.assignedAgentName || 'an academy agent'}` : current.status === 'closed' ? 'Conversation closed' : 'Assistant conversation'].filter(Boolean).join(' · ');
  claimButton.hidden = current.status !== 'waiting';
  closeButton.hidden = !current.canReply;
  replyForm.hidden = !current.canReply;
  claimButton.disabled = busy;
  closeButton.disabled = busy;
  input.disabled = busy;
  sendButton.disabled = busy;
  sendButton.textContent = busy ? 'Sending…' : pendingReply ? 'Retry reply' : 'Send reply';
  olderButton.hidden = olderCursor === null;
  olderButton.disabled = busy;
  const ordered = [...messages.values()].sort((a, b) => a.id - b.id);
  const signature = JSON.stringify(ordered);
  if (signature === renderedSignature) return;
  renderedSignature = signature;
  const bottom = messagesElement.scrollHeight - messagesElement.clientHeight - messagesElement.scrollTop < 70;
  messagesElement.replaceChildren();
  for (const message of ordered) {
    const row = node('article', message.role === 'agent' ? 'rounded-lg border border-lime/30 bg-lime/10 p-4' : 'rounded-lg border border-line bg-paper p-4');
    const label = message.role === 'user' ? name : message.role === 'agent' ? 'Academy agent' : message.role === 'assistant' ? message.source === 'ai' ? 'AI assistant' : 'Academy guide' : 'Support update';
    row.append(node('p', 'mb-2 text-[10px] font-semibold uppercase tracking-wider text-muted', label));
    row.append(node('p', 'whitespace-pre-wrap break-words text-sm', String(message.content || '')));
    const date = new Date(message.createdAt);
    if (Number.isFinite(date.getTime())) {
      const time = node('time', 'mt-3 block text-[10px] text-muted', date.toLocaleString());
      time.dateTime = date.toISOString();
      row.append(time);
    }
    messagesElement.append(row);
  }
  if (bottom) messagesElement.scrollTop = messagesElement.scrollHeight;
}

function applyCase(result, { older = false } = {}) {
  const next = result.conversation;
  if (!next || next.id !== selected) return;
  if (current?.id !== next.id || older || messages.size === 0) olderCursor = next.olderCursor ?? null;
  current = next;
  client = result.client;
  for (const message of next.messages || []) messages.set(message.id, message);
  if (pendingReply && (next.messages || []).some(message => message.clientMessageId === pendingReply.clientMessageId)) {
    if (input.value.trim() === pendingReply.message) input.value = '';
    pendingReply = null;
    if (!busy) caseStatus.textContent = 'Your reply is saved.';
  }
  const listed = listItems.get(next.id);
  if (listed) {
    const match = filter.value === 'all' || filter.value === 'active' && ['waiting', 'assigned'].includes(next.status) || filter.value === next.status;
    if (!match) listItems.delete(next.id);
    else listItems.set(next.id, { ...listed, ...next, client });
    renderList();
  }
  renderCase();
}

async function loadCase({ older = false } = {}) {
  if (!selected || busy) return;
  const view = generation;
  const version = caseVersion;
  const path = `/api/support/staff/conversations/${encodeURIComponent(selected)}${older && olderCursor !== null ? `?before=${encodeURIComponent(olderCursor)}` : ''}`;
  try {
    const result = await request(path);
    if (view === generation && version === caseVersion && !busy) applyCase(result, { older });
  } catch (error) { if (view === generation && version === caseVersion) fail(error, caseStatus); }
}

function renderList() {
  const conversations = [...listItems.values()].sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id));
  $('support-agent-count').textContent = `${conversations.length} shown`;
  list.replaceChildren();
  if (!conversations.length) list.append(node('p', 'text-sm text-muted', filter.value === 'active' ? 'No support conversations are waiting or assigned.' : 'No conversations match this view.'));
  for (const conversation of conversations) {
    const button = node('button', conversation.id === selected ? 'w-full rounded-lg border border-lime/50 bg-lime/10 p-4 text-left' : 'w-full rounded-lg border border-line bg-paper p-4 text-left hover:bg-lime/10');
    button.type = 'button';
    button.setAttribute('aria-pressed', String(conversation.id === selected));
    button.append(node('strong', 'block break-words text-sm', conversation.client?.name || 'Academy client'));
    button.append(node('span', 'mt-1 block break-all text-xs text-muted', conversation.client?.email || ''));
    button.append(node('span', 'mt-2 block text-[10px] font-semibold uppercase tracking-wider text-lime', conversation.status === 'waiting' ? 'Waiting for an agent' : conversation.status === 'assigned' ? `Assigned · ${conversation.assignedAgentName || 'Academy agent'}` : conversation.status));
    if (conversation.preview) button.append(node('span', 'mt-2 line-clamp-2 block break-words text-xs text-muted', conversation.preview));
    button.addEventListener('click', () => selectCase(conversation.id));
    list.append(button);
  }
  moreButton.hidden = nextCursor === null;
}

async function refresh(more = false) {
  if (refreshing || busy || document.hidden) return;
  if (more && nextCursor === null) return;
  refreshing = true;
  const version = listGeneration;
  moreButton.disabled = true;
  try {
    const query = `?status=${encodeURIComponent(filter.value)}${more ? `&before=${encodeURIComponent(nextCursor)}` : ''}`;
    const result = await request(`/api/support/staff/conversations${query}`);
    if (version !== listGeneration) return;
    authorized = true;
    $('support-agent-denied').hidden = true;
    $('support-agent-workspace').hidden = false;
    if (!loadedMore && !more) listItems = new Map();
    for (const conversation of result.conversations || []) listItems.set(conversation.id, conversation);
    if (more || !loadedMore) nextCursor = result.nextCursor ?? null;
    if (more) loadedMore = true;
    renderList();
    status.textContent = 'Inbox loaded. Requests stay queued until an agent claims them.';
    await loadCase();
    schedule();
  } catch (error) { if (version === listGeneration) fail(error); }
  finally { refreshing = false; moreButton.disabled = false; if (version !== listGeneration) refresh(); }
}

async function selectCase(id) {
  if (busy) return;
  selected = id;
  current = null;
  client = null;
  generation += 1;
  messages = new Map();
  renderedSignature = '';
  olderCursor = null;
  pendingReply = null;
  input.value = '';
  replyForm.hidden = true;
  claimButton.hidden = true;
  closeButton.hidden = true;
  olderButton.hidden = true;
  $('support-case-title').textContent = 'Loading conversation…';
  $('support-case-detail').textContent = '';
  messagesElement.replaceChildren();
  caseStatus.textContent = '';
  await loadCase();
  refresh();
}

function schedule() {
  clearInterval(polling);
  polling = null;
  if (authorized && !document.hidden) polling = setInterval(refresh, 5000);
}

async function mutate(action, payload = {}) {
  if (busy || !selected) return;
  busy = true;
  caseVersion += 1;
  const view = generation;
  caseStatus.textContent = action === 'claim' ? 'Claiming this request…' : action === 'close' ? 'Closing this conversation…' : 'Saving your reply…';
  renderCase();
  try {
    const result = await request(`/api/support/staff/conversations/${encodeURIComponent(selected)}/${action}`, payload);
    if (view !== generation) return;
    if (action === 'reply') { pendingReply = null; input.value = ''; }
    applyCase(result);
    caseStatus.textContent = action === 'reply' ? 'Reply saved. The customer can see it in their support conversation.' : action === 'claim' ? 'You are assigned to this conversation.' : 'Conversation closed. Its transcript remains saved.';
  } catch (error) { if (view === generation) fail(error, caseStatus); }
  finally { busy = false; renderCase(); }
  refresh();
}

claimButton.addEventListener('click', () => mutate('claim'));
closeButton.addEventListener('click', () => {
  if (window.confirm('Close this support conversation? The customer can start a new one if they need more help.')) mutate('close');
});
replyForm.addEventListener('submit', event => {
  event.preventDefault();
  const message = input.value.trim();
  if (!message || busy || !replyForm.reportValidity()) return;
  if (!pendingReply || pendingReply.message !== message) pendingReply = { message, clientMessageId: crypto.randomUUID() };
  mutate('reply', pendingReply);
});
olderButton.addEventListener('click', async () => {
  olderButton.disabled = true;
  const height = messagesElement.scrollHeight;
  const top = messagesElement.scrollTop;
  await loadCase({ older: true });
  messagesElement.scrollTop = top + messagesElement.scrollHeight - height;
  olderButton.disabled = false;
});
$('support-agent-refresh').addEventListener('click', () => refresh());
moreButton.addEventListener('click', () => refresh(true));
filter.addEventListener('change', () => {
  listGeneration += 1;
  listItems = new Map();
  nextCursor = null;
  loadedMore = false;
  renderList();
  refresh();
});
document.addEventListener('visibilitychange', () => { schedule(); if (!document.hidden) refresh(); });
window.addEventListener('pagehide', () => { clearInterval(polling); polling = null; });
window.addEventListener('pageshow', schedule);
refresh();
