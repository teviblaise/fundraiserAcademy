const INTERVALS = Object.freeze({ '1m': 60, '5m': 300, '15m': 900, '1h': 3600, '1d': 86400 });
const SYMBOLS = Object.freeze({
  BTCUSD: { provider: 'coinbase', product: 'BTC-USD' },
  ETHUSD: { provider: 'coinbase', product: 'ETH-USD' },
  EURUSD: { provider: 'frankfurter', base: 'EUR' },
  GBPUSD: { provider: 'frankfurter', base: 'GBP' },
});
const SOURCES = Object.freeze({
  coinbase: { name: 'Coinbase Exchange', url: 'https://www.coinbase.com/advanced-trade', delayed: false },
  frankfurter: { name: 'Frankfurter / ECB daily reference', url: 'https://www.frankfurter.dev/', delayed: true },
});

export class MarketDataError extends Error {
  constructor(message, status = 503) {
    super(message);
    this.name = 'MarketDataError';
    this.status = status;
  }
}

function number(value, allowZero = false) {
  if ((typeof value !== 'number' && typeof value !== 'string') || String(value).trim() === '') throw new Error('Invalid market value');
  const result = Number(value);
  if (!Number.isFinite(result) || (allowZero ? result < 0 : result <= 0)) throw new Error('Invalid market value');
  return result;
}

function seconds(value) {
  const result = number(value);
  if (!Number.isSafeInteger(result)) throw new Error('Invalid market time');
  return result;
}

function dateSeconds(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Invalid reference date');
  const stamp = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(stamp) || new Date(stamp).toISOString().slice(0, 10) !== value) throw new Error('Invalid reference date');
  return stamp / 1000;
}

function normalizeCandles(payload, start, end) {
  if (!Array.isArray(payload)) throw new Error('Invalid candle response');
  const values = new Map();
  for (const raw of payload) {
    if (!Array.isArray(raw) || raw.length < 6) throw new Error('Invalid candle');
    const [time, low, high, open, close, volume] = [seconds(raw[0]), number(raw[1]), number(raw[2]), number(raw[3]), number(raw[4]), number(raw[5], true)];
    if (low > high || open < low || open > high || close < low || close > high) throw new Error('Invalid candle range');
    if (time >= start && time <= end && !values.has(time)) values.set(time, { time, open, high, low, close, volume });
  }
  const candles = [...values.values()].sort((a, b) => a.time - b.time).slice(-300);
  if (!candles.length) throw new Error('No candles are available for this period');
  return candles;
}

function normalizePoints(payload, base, start, end) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payload.rates || typeof payload.rates !== 'object' || Array.isArray(payload.rates)) throw new Error('Invalid reference response');
  if (payload.base && payload.base !== base) throw new Error('Unexpected reference currency');
  if (payload.amount !== undefined && number(payload.amount) !== 1) throw new Error('Unexpected reference amount');
  const points = [];
  for (const [date, rates] of Object.entries(payload.rates)) {
    const time = dateSeconds(date);
    if (!rates || typeof rates !== 'object' || Array.isArray(rates)) throw new Error('Invalid reference rate');
    const close = number(rates.USD);
    if (time >= start && time <= end) points.push({ time, close });
  }
  points.sort((a, b) => a.time - b.time);
  if (!points.length) throw new Error('No daily references are available for this period');
  return points.slice(-300);
}

/** Public reference prices are separate from the academy's simulated execution prices. */
export function createMarketData({ fetchFn = globalThis.fetch, now = Date.now, cryptoTtlMs = 30000, fxTtlMs = 3600000, timeoutMs = 8000, maxEntries = 64, errorBackoffMs = 30000 } = {}) {
  if (typeof fetchFn !== 'function' || typeof now !== 'function') throw new TypeError('A fetch function and clock are required');
  if (![cryptoTtlMs, fxTtlMs, timeoutMs, maxEntries, errorBackoffMs].every(value => Number.isFinite(value) && value > 0)) throw new TypeError('Market cache settings must be positive');
  timeoutMs = Math.min(timeoutMs, 8000);
  maxEntries = Math.min(Math.floor(maxEntries), 64);
  if (maxEntries < 1) throw new TypeError('At least one cache entry is required');
  const cache = new Map(), pending = new Map(), cooldown = new Map(), controllers = new Set();
  let closed = false;

  function unavailable(provider) {
    return new MarketDataError(`${SOURCES[provider].name} prices are temporarily unavailable. Try again shortly.`);
  }

  function copy(value, cached = false, stale = false, historical = false) {
    const quoteAged = !historical && value.kind === 'ohlc' && Math.floor(now() / 1000) - value.asOf > 120;
    return { ...structuredClone(value), status: cached ? 'cached' : 'ok', stale: value.stale || stale || quoteAged };
  }

  function touch(key, entry) {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  }

  async function json(url, signal) {
    const response = await fetchFn(url, { signal, headers: { Accept: 'application/json', 'User-Agent': 'FundraiserAcademy/1.0 (public market reference)' } });
    if (!response?.ok) throw new Error('Market provider is unavailable');
    return response.json();
  }

  async function load(symbol, interval, requestedEnd, signal) {
    const spec = SYMBOLS[symbol], source = SOURCES[spec.provider];
    const currentTime = Math.floor(now() / 1000);
    const end = requestedEnd === undefined ? currentTime : Math.min(requestedEnd, currentTime);
    const historical = requestedEnd !== undefined;
    let price, asOf, candles = [], points = [];
    if (spec.provider === 'coinbase') {
      const start = Math.max(1, end - INTERVALS[interval] * 300);
      const query = new URLSearchParams({ granularity: String(INTERVALS[interval]), start: new Date(start * 1000).toISOString(), end: new Date(end * 1000).toISOString() });
      const url = `https://api.exchange.coinbase.com/products/${spec.product}`;
      const [history, ticker] = await Promise.all([json(`${url}/candles?${query}`, signal), historical ? null : json(`${url}/ticker`, signal)]);
      candles = normalizeCandles(history, start, end);
      const last = candles.at(-1);
      if (historical) {
        price = last.close;
        asOf = last.time;
      } else {
        price = number(ticker?.price);
        if (typeof ticker.time !== 'string') throw new Error('Invalid ticker timestamp');
        asOf = Math.floor(Date.parse(ticker.time) / 1000);
        if (!Number.isSafeInteger(asOf) || asOf <= 0 || asOf > currentTime + 60) throw new Error('Invalid ticker timestamp');
      }
    } else {
      const endDay = Math.floor(end / 86400) * 86400;
      const start = Math.max(0, endDay - 450 * 86400);
      const date = time => new Date(time * 1000).toISOString().slice(0, 10);
      const query = new URLSearchParams({ base: spec.base, symbols: 'USD' });
      const url = 'https://api.frankfurter.dev/v1';
      const [history, latest] = await Promise.all([json(`${url}/${date(start)}..${date(endDay)}?${query}`, signal), historical ? null : json(`${url}/latest?${query}`, signal)]);
      points = normalizePoints(history, spec.base, start, endDay);
      const last = points.at(-1);
      price = last.close;
      asOf = last.time;
      if (!historical) {
        if (!latest || typeof latest !== 'object' || (latest.base && latest.base !== spec.base)) throw new Error('Invalid latest reference');
        if (latest.amount !== undefined && number(latest.amount) !== 1) throw new Error('Unexpected reference amount');
        const latestTime = dateSeconds(latest.date), latestPrice = number(latest.rates?.USD);
        if (latestTime > endDay) throw new Error('Invalid latest reference date');
        if (latestTime >= asOf) {
          price = latestPrice;
          asOf = latestTime;
          if (!points.some(point => point.time === latestTime)) points.push({ time: latestTime, close: latestPrice });
          else points[points.length - 1] = { time: latestTime, close: latestPrice };
          points = points.slice(-300);
        }
      }
    }
    return { symbol, source: source.name, sourceUrl: source.url, kind: spec.provider === 'coinbase' ? 'ohlc' : 'daily', price, asOf, fetchedAt: now(), stale: !historical && spec.provider === 'coinbase' && currentTime - asOf > 120, interval, candles, points, status: 'ok', delayed: source.delayed };
  }

  async function get(symbol, interval = '15m', end = undefined) {
    if (!Object.hasOwn(SYMBOLS, symbol)) throw new MarketDataError('Choose EURUSD, GBPUSD, BTCUSD, or ETHUSD.', 400);
    if (!Object.hasOwn(INTERVALS, interval)) throw new MarketDataError('Choose a supported chart interval: 1m, 5m, 15m, 1h, or 1d.', 400);
    if (end !== undefined && (typeof end !== 'number' || !Number.isSafeInteger(end) || end <= 0 || end > Math.floor(now() / 1000) + 60)) throw new MarketDataError('History end must be a valid past Unix timestamp in seconds.', 400);
    const provider = SYMBOLS[symbol].provider;
    if (provider === 'frankfurter') interval = '1d';
    const key = `${symbol}:${interval}:${end === undefined ? 'latest' : end}`;
    if (closed) throw unavailable(provider);
    const entry = cache.get(key);
    if (entry && entry.expires > now()) {
      touch(key, entry);
      return copy(entry.value, true, false, end !== undefined);
    }
    if (pending.has(key)) {
      const value = await pending.get(key);
      return copy(value, value.status === 'cached', false, end !== undefined);
    }
    if ((cooldown.get(provider) || 0) > now()) {
      if (entry) return copy(entry.value, true, true, end !== undefined);
      throw unavailable(provider);
    }
    if (pending.size >= maxEntries) throw new MarketDataError('Market reference requests are busy. Try again shortly.');
    const controller = new AbortController();
    controllers.add(controller);
    let timer;
    const deadline = new Promise((resolve, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(unavailable(provider)); }, timeoutMs);
      controller.signal.addEventListener('abort', () => reject(unavailable(provider)), { once: true });
    });
    const operation = (async () => {
      try {
        const value = await Promise.race([load(symbol, interval, end, controller.signal), deadline]);
        if (closed) throw unavailable(provider);
        touch(key, { value, expires: now() + (provider === 'coinbase' ? cryptoTtlMs : fxTtlMs) });
        cooldown.delete(provider);
        return value;
      } catch {
        controller.abort();
        if (!closed) cooldown.set(provider, now() + errorBackoffMs);
        if (entry && !closed) return { ...entry.value, status: 'cached', stale: true };
        throw unavailable(provider);
      } finally {
        clearTimeout(timer);
        controllers.delete(controller);
        pending.delete(key);
      }
    })();
    pending.set(key, operation);
    const value = await operation;
    return copy(value, value.status === 'cached', false, end !== undefined);
  }

  return { get, close() { closed = true; for (const controller of controllers) controller.abort(); cache.clear(); } };
}
