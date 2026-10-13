// HTTP actions and live snapshots share this guard so a delayed response cannot
// restore an earlier trade, quote, or assessment after a newer snapshot arrives.
export function createAccountOrderGuard(initial = null) {
  let revision = null, epoch = null;
  const retiredEpochs = new Set();
  function accept(next) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) return false;
    const versioned = Number.isSafeInteger(next.revision) && next.revision >= 0 && typeof next.streamEpoch === 'string' && next.streamEpoch.length > 0;
    if (!versioned) return revision === null;
    if (retiredEpochs.has(next.streamEpoch) || (epoch === next.streamEpoch && revision !== null && next.revision < revision)) return false;
    if (epoch !== null && epoch !== next.streamEpoch) retiredEpochs.add(epoch);
    revision = next.revision; epoch = next.streamEpoch;
    return true;
  }
  if (initial) accept(initial);
  return { accept };
}

export function createAccountFeed({
  getSymbol, onAccount, onStatus = () => {}, onUnauthorized = () => {}, poll,
  EventSourceImpl = globalThis.EventSource, documentImpl = globalThis.document, windowImpl = globalThis.window,
  setIntervalImpl = globalThis.setInterval, clearIntervalImpl = globalThis.clearInterval,
  nowImpl = Date.now, inactivityTimeoutMs = 15000,
}) {
  let source = null, connected = false, running = false, destroyed = false, suspended = false, polling = false;
  let generation = 0, lastStatus = null, pollTimer = null, reconnectTimer = null, lastAccountAt = null;
  const visible = () => !suspended && !documentImpl?.hidden;
  function status(next) { if (lastStatus !== next) { lastStatus = next; onStatus(next); } }
  function closeSource() { generation++; source?.close(); source = null; connected = false; }
  function connect() {
    if (!running || destroyed || !visible() || source) return;
    if (typeof EventSourceImpl !== 'function') { status('polling'); return; }
    const requestedSymbol = getSymbol(), id = ++generation;
    status('connecting');
    let candidate;
    try { candidate = new EventSourceImpl(`/api/account-stream?symbol=${encodeURIComponent(requestedSymbol)}`, { withCredentials: true }); }
    catch { status('polling'); return; }
    source = candidate;
    lastAccountAt = nowImpl();
    const current = () => running && !destroyed && visible() && source === candidate && generation === id;
    const fallback = () => { if (!current()) return; closeSource(); status('polling'); };
    candidate.addEventListener('open', () => { if (current()) status('connecting'); });
    candidate.addEventListener('account', event => {
      if (!current()) return;
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload?.symbol !== requestedSymbol || requestedSymbol !== getSymbol() || !payload.account || typeof payload.account !== 'object' || Array.isArray(payload.account)) return;
      lastAccountAt = nowImpl(); connected = true; status('live'); onAccount(payload.account, payload);
    });
    candidate.addEventListener('error', fallback);
    candidate.addEventListener('stream-error', fallback);
    candidate.addEventListener('auth-expired', () => { if (!current()) return; stop(); onUnauthorized(); });
  }
  function visibilityChange() {
    if (!running || destroyed) return;
    if (!visible()) { closeSource(); status('paused'); }
    else connect();
  }
  function pageHide() { suspended = true; visibilityChange(); }
  function pageShow() { suspended = false; visibilityChange(); }
  function stop() {
    if (destroyed) return;
    running = false; destroyed = true; closeSource();
    if (pollTimer !== null) clearIntervalImpl(pollTimer);
    if (reconnectTimer !== null) clearIntervalImpl(reconnectTimer);
    documentImpl?.removeEventListener('visibilitychange', visibilityChange);
    windowImpl?.removeEventListener('pagehide', pageHide);
    windowImpl?.removeEventListener('pageshow', pageShow);
    status('stopped');
  }
  return {
    start() {
      if (running || destroyed) return;
      running = true;
      documentImpl?.addEventListener('visibilitychange', visibilityChange);
      windowImpl?.addEventListener('pagehide', pageHide);
      windowImpl?.addEventListener('pageshow', pageShow);
      pollTimer = setIntervalImpl(() => {
        if (!running || !visible()) return;
        // An HTTP connection can open even when a proxy buffers all account
        // frames. Recover through GET polling rather than waiting indefinitely.
        if (source && nowImpl() - lastAccountAt >= inactivityTimeoutMs) { closeSource(); status('polling'); }
        if (connected || polling) return;
        polling = true;
        Promise.resolve().then(() => { if (running && visible() && !connected) return poll(); }).catch(() => {}).finally(() => { polling = false; });
      }, 1500);
      reconnectTimer = setIntervalImpl(connect, 3000);
      if (visible()) connect(); else status('paused');
    },
    selectSymbol() { if (!running || destroyed) return; closeSource(); if (visible()) connect(); else status('paused'); },
    stop,
  };
}
