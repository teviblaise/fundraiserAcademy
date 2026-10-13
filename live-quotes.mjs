import WebSocket from 'ws';
import { HttpsProxyAgent } from 'https-proxy-agent';

const COINBASE_SOCKET_URL = 'wss://ws-feed.exchange.coinbase.com';
const PRODUCTS = Object.freeze({ 'BTC-USD': 'BTCUSD', 'ETH-USD': 'ETHUSD' });
const SOURCE = 'Coinbase Exchange';
const MAX_SOURCE_AGE = 120000;
const MAX_RECEIPT_AGE = 30000;
const UNAVAILABLE = 'Crypto streaming is temporarily unavailable. Fresh REST reference quotes remain available when the provider responds.';

function defaultSocketFactory(url) {
  const proxy = process.env.https_proxy || process.env.HTTPS_PROXY || process.env.http_proxy || process.env.HTTP_PROXY;
  const agent = proxy ? new HttpsProxyAgent(proxy) : undefined;
  const socket = new WebSocket(url, { handshakeTimeout: 8000, maxPayload: 32768, ...(agent ? { agent } : {}) });
  if (agent) socket.once('close', () => agent.destroy());
  return socket;
}

/** Shared public crypto feed. Forex continues to use the configured REST plan. */
export function createLiveQuotes({ socketFactory = defaultSocketFactory, now = Date.now, reconnectBaseMs = 1000, reconnectMaxMs = 30000, heartbeatTimeoutMs = 20000, handshakeTimeoutMs = 8000, healthIntervalMs = 5000, setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout, setIntervalFn = setInterval, clearIntervalFn = clearInterval } = {}) {
  if (![socketFactory, now, setTimeoutFn, clearTimeoutFn, setIntervalFn, clearIntervalFn].every(value => typeof value === 'function')) throw new TypeError('A socket factory, clock, and timer functions are required');
  if (![reconnectBaseMs, reconnectMaxMs, heartbeatTimeoutMs, handshakeTimeoutMs, healthIntervalMs].every(value => Number.isFinite(value) && value > 0) || reconnectMaxMs < reconnectBaseMs) throw new TypeError('Stream timings must be positive and bounded');
  const quotes = new Map(), listeners = new Set();
  let socket = null, started = false, closed = false, ready = false, generation = 0, attempts = 0, lastMessageAt = null;
  let reconnectTimer = null, handshakeTimer = null, healthTimer = null, state = 'idle', error = null;
  const unref = timer => { timer?.unref?.(); return timer; };
  const cancelHealth = () => { if (handshakeTimer !== null) clearTimeoutFn(handshakeTimer); if (healthTimer !== null) clearIntervalFn(healthTimer); handshakeTimer = healthTimer = null; };

  function stopSocket(target) {
    if (!target) return;
    // Error handlers remain attached to retired sockets so a late transport error
    // cannot become an unhandled EventEmitter exception or expose its URL.
    try { if (typeof target.terminate === 'function') target.terminate(); else target.close(); } catch { /* The socket is already retired. */ }
  }

  function fail(target) {
    if (closed || target !== socket) return;
    socket = null; ready = false; cancelHealth(); state = 'reconnecting'; error = UNAVAILABLE;
    stopSocket(target);
    const delay = Math.min(reconnectMaxMs, reconnectBaseMs * 2 ** Math.min(attempts++, 30));
    reconnectTimer = unref(setTimeoutFn(() => { reconnectTimer = null; connect(); }, delay));
  }

  function fresh(entry) {
    const clock = now(), value = entry?.quote;
    return !closed && ready && socket?.readyState === WebSocket.OPEN && entry?.generation === generation && lastMessageAt !== null && clock - lastMessageAt <= heartbeatTimeoutMs &&
      value && clock - value.asOf * 1000 <= MAX_SOURCE_AGE && clock - value.asOf * 1000 >= -5000 && clock - value.fetchedAt <= MAX_RECEIPT_AGE && clock - value.fetchedAt >= 0;
  }

  function message(target, raw) {
    if (closed || target !== socket || !ready) return;
    let payload;
    try {
      const text = typeof raw === 'string' ? raw : raw?.toString();
      if (typeof text !== 'string' || text.length > 32768) return;
      payload = JSON.parse(text);
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return;
    } catch { return; }
    if (payload.type === 'error') { fail(target); return; }
    if (payload.type === 'subscriptions' || payload.type === 'heartbeat' && Object.hasOwn(PRODUCTS, payload.product_id)) { lastMessageAt = now(); return; }
    if (payload.type !== 'ticker' || !Object.hasOwn(PRODUCTS, payload.product_id)) return;
    if ((typeof payload.price !== 'string' && typeof payload.price !== 'number') || String(payload.price).trim() === '' || typeof payload.time !== 'string') return;
    const price = Number(payload.price), observedAt = Date.parse(payload.time), asOf = Math.floor(observedAt / 1000), clock = now();
    if (!Number.isFinite(price) || price <= 0 || !Number.isFinite(observedAt) || observedAt <= 0 || clock - asOf * 1000 > MAX_SOURCE_AGE || observedAt - clock > 5000) return;
    const symbol = PRODUCTS[payload.product_id], previous = quotes.get(symbol);
    const sequence = Number.isSafeInteger(payload.sequence) && payload.sequence >= 0 ? payload.sequence : null;
    if (previous && (observedAt < previous.observedAt || observedAt === previous.observedAt && (sequence !== null && previous.sequence !== null ? sequence <= previous.sequence : price === previous.quote.price))) return;
    const quote = { symbol, baseCurrency: symbol.slice(0, 3), quoteCurrency: 'USD', price, asOf, fetchedAt: clock, source: SOURCE, sourceUrl: 'https://www.coinbase.com/advanced-trade', deliveryMode: 'streaming', executable: true };
    quotes.set(symbol, { quote, observedAt, sequence, generation });
    lastMessageAt = clock; attempts = 0; error = null;
    for (const listener of listeners) { try { listener(structuredClone(quote)); } catch { /* Isolate consumers from the provider transport. */ } }
  }

  function connect() {
    if (closed || socket) return;
    state = 'connecting'; generation++;
    let target;
    try {
      target = socketFactory(COINBASE_SOCKET_URL);
      if (!target || typeof target.on !== 'function' || typeof target.send !== 'function') throw new Error('Invalid socket implementation');
      socket = target;
      target.on('error', () => fail(target));
      target.on('close', () => fail(target));
      target.on('message', raw => message(target, raw));
      target.on('open', () => {
        if (closed || target !== socket) return;
        if (handshakeTimer !== null) clearTimeoutFn(handshakeTimer); handshakeTimer = null;
        ready = true; state = 'connected'; lastMessageAt = now();
        try { target.send(JSON.stringify({ type: 'subscribe', product_ids: Object.keys(PRODUCTS), channels: ['ticker', 'heartbeat'] })); }
        catch { fail(target); return; }
        healthTimer = unref(setIntervalFn(() => { if (lastMessageAt === null || now() - lastMessageAt > heartbeatTimeoutMs) fail(target); }, healthIntervalMs));
      });
      handshakeTimer = unref(setTimeoutFn(() => fail(target), handshakeTimeoutMs));
    } catch {
      // Constructor errors may contain proxy credentials or full request URLs.
      // Preserve only a fixed message, and use the same bounded retry schedule.
      if (!target) target = {};
      socket = target; fail(target);
    }
  }

  function get(symbol) {
    if (!['BTCUSD', 'ETHUSD'].includes(symbol) || closed) return null;
    if (!started) { started = true; connect(); }
    const entry = quotes.get(symbol);
    return fresh(entry) ? structuredClone(entry.quote) : null;
  }

  return {
    get,
    status(symbol) { return { state, connected: ready && !closed, fresh: Boolean(fresh(quotes.get(symbol))), error }; },
    subscribe(listener) { if (typeof listener !== 'function') throw new TypeError('A quote listener is required'); if (closed) return () => {}; listeners.add(listener); return () => listeners.delete(listener); },
    close() {
      if (closed) return;
      closed = true; state = 'closed'; ready = false; cancelHealth();
      if (reconnectTimer !== null) clearTimeoutFn(reconnectTimer); reconnectTimer = null;
      const target = socket; socket = null; stopSocket(target); quotes.clear(); listeners.clear();
    },
  };
}
