import test from 'node:test';
import assert from 'node:assert/strict';
import { createMarketData, MarketDataError } from '../market-data.mjs';

const NOW = Date.parse('2026-10-12T12:00:00Z');
const SECOND = NOW / 1000;
const CANDLES = [
  [SECOND - 900, 100, 112, 105, 110, 5],
  [SECOND - 1800, 95, 108, 100, 105, 3],
  [SECOND - 900, 100, 112, 105, 110, 5],
];
const response = value => ({ ok: true, json: async () => structuredClone(value) });
const ticker = { price: '111.25', time: '2026-10-12T11:59:58.000Z' };

test('crypto reference normalizes actual OHLC, retains provider timestamp, and shares a fresh cache without mutable responses', async () => {
  const calls = [];
  const market = createMarketData({ now: () => NOW, fetchFn: async url => { calls.push(url); return response(url.includes('/ticker') ? ticker : CANDLES); } });
  try {
    const result = await market.get('BTCUSD');
    assert.equal(result.kind, 'ohlc');
    assert.equal(result.source, 'Coinbase Exchange');
    assert.equal(result.price, 111.25);
    assert.equal(result.asOf, SECOND - 2);
    assert.equal(result.fetchedAt, NOW);
    assert.equal(result.status, 'ok');
    assert.equal(result.stale, false);
    assert.equal(result.delayed, false);
    assert.deepEqual(result.points, []);
    assert.deepEqual(result.candles.map(candle => candle.time), [SECOND - 1800, SECOND - 900]);
    assert.deepEqual(result.candles[1], { time: SECOND - 900, open: 105, high: 112, low: 100, close: 110, volume: 5 });
    assert.equal(new URL(calls[0]).searchParams.get('granularity'), '900');
    result.candles[0].close = -100;
    const cached = await market.get('BTCUSD');
    assert.equal(cached.status, 'cached');
    assert.equal(cached.candles[0].close, 105);
    assert.equal(calls.length, 2);
  } finally { market.close(); }
});

test('concurrent identical requests share one provider fetch and return independent data', async () => {
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  let calls = 0;
  const market = createMarketData({ now: () => NOW, fetchFn: async url => { calls++; await ready; return response(url.includes('/ticker') ? ticker : CANDLES); } });
  try {
    const first = market.get('ETHUSD', '5m'), second = market.get('ETHUSD', '5m');
    release();
    const [a, b] = await Promise.all([first, second]);
    assert.equal(calls, 2);
    a.candles[0].open = -1;
    assert.equal(b.candles[0].open, 100);
  } finally { market.close(); }
});

test('historical crypto pagination bounds the provider window and uses the last historical close, without a live ticker', async () => {
  const end = SECOND - 86400;
  const calls = [];
  const market = createMarketData({ now: () => NOW, fetchFn: async url => { calls.push(url); return response([[end - 900, 95, 110, 100, 105, 3], [end + 900, 110, 130, 115, 125, 1]]); } });
  try {
    const result = await market.get('BTCUSD', '15m', end);
    assert.equal(result.price, 105);
    assert.equal(result.asOf, end - 900);
    assert.equal(result.candles.length, 1);
    assert.equal(result.stale, false);
    assert.equal(calls.length, 1);
    const query = new URL(calls[0]).searchParams;
    assert.equal(Date.parse(query.get('end')) / 1000, end);
    assert.equal(Date.parse(query.get('start')) / 1000, end - 300 * 900);
  } finally { market.close(); }
});

test('FX references stay daily and never fabricate intraday candles or open/high/low values', async () => {
  const calls = [];
  const market = createMarketData({ now: () => NOW, twelveDataApiKey: '', fetchFn: async url => {
    calls.push(url);
    return response(url.includes('/latest?') ? { base: 'EUR', amount: 1, date: '2026-10-12', rates: { USD: 1.165 } } : { base: 'EUR', amount: 1, rates: { '2026-10-09': { USD: 1.16 }, '2026-10-08': { USD: 1.155 } } });
  } });
  try {
    const result = await market.get('EURUSD', '1m');
    assert.equal(result.kind, 'daily');
    assert.equal(result.interval, '1d');
    assert.equal(result.delayed, true);
    assert.equal(result.asOf, Date.parse('2026-10-12T00:00:00Z') / 1000);
    assert.equal(result.price, 1.165);
    assert.deepEqual(result.candles, []);
    assert.deepEqual(result.points, [
      { time: Date.parse('2026-10-08T00:00:00Z') / 1000, close: 1.155 },
      { time: Date.parse('2026-10-09T00:00:00Z') / 1000, close: 1.16 },
      { time: Date.parse('2026-10-12T00:00:00Z') / 1000, close: 1.165 },
    ]);
    const query = new URL(calls[0]).searchParams;
    assert.equal(query.get('base'), 'EUR');
    assert.equal(query.get('symbols'), 'USD');
    assert.equal((await market.get('EURUSD', '1h')).status, 'cached');
    assert.equal(calls.length, 2);
  } finally { market.close(); }
});

test('historical FX pages use only reference points within the requested day', async () => {
  const calls = [];
  const end = Date.parse('2026-10-09T00:00:00Z') / 1000;
  const market = createMarketData({ now: () => NOW, twelveDataApiKey: '', fetchFn: async url => {
    calls.push(url);
    return response({ base: 'GBP', rates: { '2026-10-08': { USD: 1.33 }, '2026-10-09': { USD: 1.34 }, '2026-10-12': { USD: 1.35 } } });
  } });
  try {
    const result = await market.get('GBPUSD', '15m', end);
    assert.equal(result.price, 1.34);
    assert.equal(result.asOf, end);
    assert.equal(result.points.length, 2);
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\.\.2026-10-09\?/);
  } finally { market.close(); }
});

test('source failures return only matching stale data, preserve its timestamps, and back off across source symbols', async () => {
  let now = NOW, fail = false, calls = 0;
  const market = createMarketData({ now: () => now, fetchFn: async url => { calls++; if (fail) throw new Error('Network rejected'); return response(url.includes('/ticker') ? ticker : CANDLES); } });
  try {
    const first = await market.get('BTCUSD');
    now += 31000; fail = true;
    const stale = await market.get('BTCUSD');
    assert.equal(stale.stale, true);
    assert.equal(stale.status, 'cached');
    assert.equal(stale.asOf, first.asOf);
    assert.equal(stale.fetchedAt, first.fetchedAt);
    const count = calls;
    assert.equal((await market.get('BTCUSD')).stale, true);
    await assert.rejects(market.get('ETHUSD'), error => error instanceof MarketDataError && error.status === 503 && /temporarily unavailable/.test(error.message));
    assert.equal(calls, count);
    now += 31000; fail = false;
    assert.equal((await market.get('BTCUSD')).status, 'ok');
    assert.equal(calls, count + 2);
  } finally { market.close(); }
});

test('unavailable or malformed sources produce explicit errors rather than imaginary prices', async () => {
  const badPayloads = [
    [[SECOND - 900, 100, 112, 120, 110, 5]],
    [[SECOND - 900, 100, 112, 105, NaN, 5]],
    [[SECOND - 900, 100, 112, 105, 110, -1]],
    [],
  ];
  for (const payload of badPayloads) {
    const market = createMarketData({ now: () => NOW, fetchFn: async url => response(url.includes('/ticker') ? ticker : payload) });
    try { await assert.rejects(market.get('BTCUSD'), error => error.status === 503); }
    finally { market.close(); }
  }
  const fx = createMarketData({ now: () => NOW, twelveDataApiKey: '', fetchFn: async url => response(url.includes('/latest?') ? { base: 'EUR', date: '2026-10-12', rates: { USD: 1.1 } } : { base: 'EUR', rates: { '2026-02-30': { USD: 1.1 } } }) });
  try { await assert.rejects(fx.get('EURUSD'), error => error.status === 503); }
  finally { fx.close(); }
});

test('older last trades are marked stale without altering real source values', async () => {
  const market = createMarketData({ now: () => NOW, fetchFn: async url => response(url.includes('/ticker') ? { price: '100', time: '2026-10-12T11:55:00Z' } : CANDLES) });
  try {
    const result = await market.get('BTCUSD');
    assert.equal(result.price, 100);
    assert.equal(result.stale, true);
    assert.equal(result.asOf, SECOND - 300);
  } finally { market.close(); }
});

test('fresh cached live quotes become stale as their source timestamp ages, while historical pages remain intentional history', async () => {
  let now = NOW;
  const market = createMarketData({ now: () => now, fetchFn: async url => response(url.includes('/ticker') ? { price: '100', time: '2026-10-12T11:58:10Z' } : CANDLES) });
  try {
    assert.equal((await market.get('BTCUSD')).stale, false);
    await market.get('BTCUSD', '15m', SECOND);
    now += 11000;
    assert.equal((await market.get('BTCUSD')).stale, true);
    assert.equal((await market.get('BTCUSD', '15m', SECOND)).stale, false);
  } finally { market.close(); }
});

test('validation rejects unsupported inputs and future history without sending network requests', async () => {
  let calls = 0;
  const market = createMarketData({ now: () => NOW, fetchFn: async () => { calls++; throw new Error('Must not fetch'); } });
  try {
    for (const input of [['https://private.example', '15m'], ['BTCUSD', '4h'], ['BTCUSD', '15m', SECOND + 120], ['BTCUSD', '15m', NaN], ['BTCUSD', '15m', String(SECOND)], ['BTCUSD', '15m', -1]]) {
      await assert.rejects(market.get(...input), error => error.status === 400);
    }
    assert.equal(calls, 0);
  } finally { market.close(); }
});

test('bounded LRU cache evicts older histories and total timeout also bounds a stalled fetch implementation', async () => {
  let calls = 0;
  const market = createMarketData({ now: () => NOW, maxEntries: 2, fetchFn: async url => {
    calls++;
    const end = Date.parse(new URL(url).searchParams.get('end')) / 1000;
    return response([[end - 900, 95, 110, 100, 105, 3]]);
  } });
  try {
    await market.get('BTCUSD', '15m', SECOND - 86400);
    await market.get('BTCUSD', '15m', SECOND - 2 * 86400);
    await market.get('BTCUSD', '15m', SECOND - 3 * 86400);
    await market.get('BTCUSD', '15m', SECOND - 86400);
    assert.equal(calls, 4);
  } finally { market.close(); }
  const stalled = createMarketData({ timeoutMs: 20, fetchFn: async () => new Promise(() => {}) });
  const start = Date.now();
  try {
    await assert.rejects(stalled.get('BTCUSD'), error => error.status === 503);
    assert.ok(Date.now() - start < 1000);
  } finally { stalled.close(); }
});

test('closing market references aborts active requests and rejects later reads', async () => {
  let aborted = 0;
  const market = createMarketData({ fetchFn: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(new Error('Aborted')); }, { once: true })) });
  const pending = market.get('BTCUSD');
  market.close();
  await assert.rejects(pending, error => error.status === 503);
  await assert.rejects(market.get('BTCUSD'), error => error.status === 503);
  assert.equal(aborted, 2);
});

test('execution quotes use the exact last-trade reference without fetching candles, adding a spread, or sharing mutable responses', async () => {
  const calls = [];
  const market = createMarketData({ now: () => NOW, fetchFn: async url => { calls.push(url); assert.match(url, /\/products\/BTC-USD\/ticker$/); return response(ticker); } });
  try {
    const value = await market.getExecutionQuote('BTCUSD');
    assert.deepEqual(value, { symbol: 'BTCUSD', baseCurrency: 'BTC', quoteCurrency: 'USD', price: 111.25, asOf: SECOND - 2, fetchedAt: NOW, source: 'Coinbase Exchange', sourceUrl: 'https://www.coinbase.com/advanced-trade', executable: true });
    value.price = 0;
    assert.equal((await market.getExecutionQuote('BTCUSD')).price, 111.25);
    assert.equal(calls.length, 1);
  } finally { market.close(); }
});

test('execution requests share an in-flight quote across trading and chart readers', async () => {
  let release, calls = 0;
  const ready = new Promise(resolve => { release = resolve; });
  const market = createMarketData({ now: () => NOW, fetchFn: async url => { calls++; await ready; return response(url.includes('/ticker') ? ticker : CANDLES); } });
  try {
    const execution = market.getExecutionQuote('BTCUSD'), duplicate = market.getExecutionQuote('BTCUSD'), chart = market.get('BTCUSD');
    release();
    const [first, second, reference] = await Promise.all([execution, duplicate, chart]);
    assert.equal(calls, 2);
    assert.equal(first.price, reference.price);
    assert.equal(first.asOf, reference.asOf);
    assert.equal(reference.quoteKind, 'last-trade');
    assert.equal(reference.executable, true);
    first.price = 999;
    assert.equal(second.price, 111.25);
  } finally { market.close(); }
});

test('latest chart headers refresh the same execution quote while cached candles stay intact', async () => {
  let now = NOW, lastPrice = '111.25';
  const calls = [];
  const market = createMarketData({ now: () => now, fetchFn: async url => { calls.push(url); return response(url.includes('/ticker') ? { price: lastPrice, time: new Date(now - 1000).toISOString() } : CANDLES); } });
  try {
    const first = await market.get('BTCUSD');
    now += 6000; lastPrice = '114.075';
    const next = await market.get('BTCUSD'), execution = await market.getExecutionQuote('BTCUSD');
    assert.equal(next.status, 'cached');
    assert.equal(next.price, 114.075);
    assert.equal(next.price, execution.price);
    assert.equal(next.asOf, execution.asOf);
    assert.deepEqual(next.candles, first.candles);
    assert.equal(calls.filter(url => url.includes('/candles?')).length, 1);
    assert.equal(calls.filter(url => url.includes('/ticker')).length, 2);
  } finally { market.close(); }
});

test('failed refreshes never execute a cached quote and provider backoff applies to related symbols', async () => {
  let now = NOW, fail = false, calls = 0;
  const market = createMarketData({ now: () => now, fetchFn: async () => { calls++; if (fail) throw new Error('A secret-bearing provider failure'); return response({ ...ticker, time: new Date(now - 1000).toISOString() }); } });
  try {
    await market.getExecutionQuote('BTCUSD');
    now += 6000; fail = true;
    await assert.rejects(market.getExecutionQuote('BTCUSD'), error => error.status === 503 && !error.message.includes('secret-bearing'));
    await assert.rejects(market.getExecutionQuote('BTCUSD'), error => error.status === 503);
    await assert.rejects(market.getExecutionQuote('ETHUSD'), error => error.status === 503);
    assert.equal(calls, 2);
    now += 31000; fail = false;
    assert.equal((await market.getExecutionQuote('BTCUSD')).executable, true);
    assert.equal(calls, 3);
  } finally { market.close(); }
});

test('execution rejects stale, invalid, and future quote timestamps without replacing them with synthetic prices', async () => {
  const invalid = [
    { price: '111.25', time: new Date(NOW - 121000).toISOString() },
    { price: '111.25', time: new Date(NOW + 61000).toISOString() },
    { price: '111.25', time: 'invalid' },
    { price: '0', time: ticker.time },
    { price: 'NaN', time: ticker.time },
    { price: '-1', time: ticker.time },
  ];
  for (const value of invalid) {
    const market = createMarketData({ now: () => NOW, fetchFn: async () => response(value) });
    try { await assert.rejects(market.getExecutionQuote('BTCUSD'), error => error instanceof MarketDataError && error.status === 503); }
    finally { market.close(); }
  }
  let now = NOW;
  const market = createMarketData({ now: () => now, fetchFn: async () => response({ price: '100', time: new Date(NOW - 119000).toISOString() }) });
  try {
    await market.getExecutionQuote('BTCUSD');
    now += 2000;
    await assert.rejects(market.getExecutionQuote('BTCUSD'), error => /stale quote/.test(error.message));
  } finally { market.close(); }
});

test('daily ECB rates never execute forex orders and missing configuration sends no network requests', async () => {
  let calls = 0;
  const market = createMarketData({ now: () => NOW, twelveDataApiKey: '', fetchFn: async () => { calls++; return response({ base: 'EUR', date: '2026-10-12', rates: { USD: 1.16 } }); } });
  try {
    await assert.rejects(market.getExecutionQuote('EURUSD'), error => error.status === 503 && /API key/.test(error.message) && /daily reference/.test(error.message));
    await assert.rejects(market.getExecutionQuote('GBPUSD'), error => error.status === 503);
    await assert.rejects(market.getExecutionQuote('INVALID'), error => error.status === 400);
    assert.equal(calls, 0);
  } finally { market.close(); }
});

test('configured forex uses the exact intraday close and timestamp; API credentials stay out of normalized data', async () => {
  const calls = [];
  const market = createMarketData({ now: () => NOW, twelveDataApiKey: 'test-private-key', fetchFn: async url => { calls.push(url); return response({ symbol: 'EUR/USD', close: '1.167385', timestamp: SECOND - 20, is_market_open: true }); } });
  try {
    const value = await market.getExecutionQuote('EURUSD');
    assert.deepEqual(value, { symbol: 'EURUSD', baseCurrency: 'EUR', quoteCurrency: 'USD', price: 1.167385, asOf: SECOND - 20, fetchedAt: NOW, source: 'Twelve Data', sourceUrl: 'https://twelvedata.com/', executable: true });
    assert.equal(calls.length, 1);
    const request = new URL(calls[0]);
    assert.equal(request.origin, 'https://api.twelvedata.com');
    assert.equal(request.pathname, '/quote');
    assert.equal(request.searchParams.get('symbol'), 'EUR/USD');
    assert.equal(request.searchParams.get('interval'), '1min');
    assert.equal(request.searchParams.get('timezone'), 'UTC');
    assert.equal(request.searchParams.get('apikey'), 'test-private-key');
    assert.equal(JSON.stringify(value).includes('test-private-key'), false);
  } finally { market.close(); }
});

test('forex freshness uses the last quote observation rather than its interval timestamp', async () => {
  const market = createMarketData({ now: () => NOW, twelveDataApiKey: 'test-private-key', fetchFn: async () => response({ symbol: 'EUR/USD', close: '1.167385', timestamp: SECOND - 600, last_quote_at: SECOND - 20, is_market_open: true }) });
  try {
    const quote = await market.getExecutionQuote('EURUSD');
    assert.equal(quote.price, 1.167385);
    assert.equal(quote.asOf, SECOND - 20);
    assert.equal(quote.executable, true);
  } finally { market.close(); }
});

test('invalid or stale last-quote timestamps cannot fall back to a fresh interval timestamp', async () => {
  for (const last_quote_at of [null, 'invalid', SECOND - 121, SECOND + 61]) {
    const market = createMarketData({ now: () => NOW, twelveDataApiKey: 'test-private-key', fetchFn: async () => response({ symbol: 'EUR/USD', close: '1.167385', timestamp: SECOND, last_quote_at, is_market_open: true }) });
    try { await assert.rejects(market.getExecutionQuote('EURUSD'), error => error.status === 503); }
    finally { market.close(); }
  }
});

test('major and cross forex execution quotes retain the native quote currency instead of treating every price as USD', async () => {
  const fixtures = [
    ['EURUSD', 'EUR', 'USD', 1.167385], ['GBPUSD', 'GBP', 'USD', 1.35],
    ['AUDUSD', 'AUD', 'USD', 0.67495], ['NZDUSD', 'NZD', 'USD', 0.61235],
    ['USDJPY', 'USD', 'JPY', 149.735], ['USDCHF', 'USD', 'CHF', 0.86725],
    ['USDCAD', 'USD', 'CAD', 1.36845], ['EURGBP', 'EUR', 'GBP', 0.86555],
    ['EURJPY', 'EUR', 'JPY', 174.985], ['GBPJPY', 'GBP', 'JPY', 202.575],
  ];
  const calls = [];
  const market = createMarketData({ now: () => NOW, twelveDataApiKey: 'test-private-key', fetchFn: async url => {
    const query = new URL(url).searchParams;
    calls.push(query.get('symbol'));
    const fixture = fixtures.find(([, base, quote]) => `${base}/${quote}` === query.get('symbol'));
    assert.ok(fixture, 'The requested provider symbol is one of the configured forex pairs');
    return response({ symbol: query.get('symbol'), close: String(fixture[3]), timestamp: SECOND - 10, is_market_open: true });
  } });
  try {
    for (const [symbol, base, quote, price] of fixtures) {
      const value = await market.getExecutionQuote(symbol);
      assert.equal(value.symbol, symbol);
      assert.equal(value.baseCurrency, base);
      assert.equal(value.quoteCurrency, quote);
      assert.equal(value.price, price);
      assert.equal(value.executable, true);
      assert.equal(value.asOf, SECOND - 10);
    }
    assert.deepEqual(calls, fixtures.map(([, base, quote]) => `${base}/${quote}`));
  } finally { market.close(); }
});

test('cross-currency daily chart references query and normalize the requested quote currency for history and latest', async () => {
  for (const [symbol, base, quote, first, latest] of [
    ['USDJPY', 'USD', 'JPY', 149.5, 149.75],
    ['USDCAD', 'USD', 'CAD', 1.36, 1.37],
    ['EURGBP', 'EUR', 'GBP', 0.864, 0.865],
  ]) {
    const calls = [];
    const market = createMarketData({ now: () => NOW, twelveDataApiKey: '', fetchFn: async url => {
      calls.push(url);
      const query = new URL(url).searchParams;
      assert.equal(query.get('base'), base);
      assert.equal(query.get('symbols'), quote);
      return response(url.includes('/latest?') ? { base, amount: 1, date: '2026-10-12', rates: { [quote]: latest, USD: 999 } } : { base, amount: 1, rates: { '2026-10-09': { [quote]: first, USD: 999 } } });
    } });
    try {
      const result = await market.get(symbol, '1m');
      assert.equal(result.baseCurrency, base);
      assert.equal(result.quoteCurrency, quote);
      assert.equal(result.price, latest);
      assert.equal(result.quoteKind, 'daily-reference');
      assert.equal(result.executable, false);
      assert.equal(result.interval, '1d');
      assert.deepEqual(result.points, [
        { time: Date.parse('2026-10-09T00:00:00Z') / 1000, close: first },
        { time: Date.parse('2026-10-12T00:00:00Z') / 1000, close: latest },
      ]);
      assert.equal(calls.length, 2);
    } finally { market.close(); }
  }
});

test('cross forex historical pages use native pair prices and cannot execute from daily references', async () => {
  const end = Date.parse('2026-10-09T00:00:00Z') / 1000;
  const calls = [];
  const market = createMarketData({ now: () => NOW, twelveDataApiKey: 'test-private-key', fetchFn: async url => {
    calls.push(url);
    assert.equal(new URL(url).searchParams.get('base'), 'EUR');
    assert.equal(new URL(url).searchParams.get('symbols'), 'JPY');
    return response({ base: 'EUR', rates: { '2026-10-08': { JPY: 174.5, USD: 1.15 }, '2026-10-09': { JPY: 174.75, USD: 1.16 }, '2026-10-12': { JPY: 175.5, USD: 1.17 } } });
  } });
  try {
    const result = await market.get('EURJPY', '15m', end);
    assert.equal(result.price, 174.75);
    assert.equal(result.quoteCurrency, 'JPY');
    assert.equal(result.executable, false);
    assert.equal(result.asOf, end);
    assert.equal(result.points.length, 2);
    assert.equal(calls.length, 1);
  } finally { market.close(); }
});

test('cross forex rejects a missing quote currency in daily history instead of accepting an unrelated USD rate', async () => {
  const market = createMarketData({ now: () => NOW, twelveDataApiKey: '', fetchFn: async url => response(url.includes('/latest?') ? { base: 'USD', date: '2026-10-12', rates: { USD: 1, JPY: 149.75 } } : { base: 'USD', rates: { '2026-10-09': { USD: 1 } } }) });
  try { await assert.rejects(market.get('USDJPY'), error => error.status === 503); }
  finally { market.close(); }
});

test('FX charts label live quote headers separately from their daily reference history and fall back honestly', async () => {
  let now = NOW, fail = false;
  const market = createMarketData({ now: () => now, twelveDataApiKey: 'test-private-key', fetchFn: async url => {
    if (url.includes('twelvedata')) { if (fail) return { ok: false, status: 429 }; return response({ symbol: 'EUR/USD', close: '1.167385', timestamp: SECOND - 20, is_market_open: true }); }
    return response(url.includes('/latest?') ? { base: 'EUR', date: '2026-10-12', rates: { USD: 1.16 } } : { base: 'EUR', rates: { '2026-10-09': { USD: 1.15 } } });
  } });
  try {
    const first = await market.get('EURUSD');
    assert.equal(first.kind, 'daily');
    assert.equal(first.source, 'Twelve Data');
    assert.equal(first.historySource, 'Frankfurter / ECB daily reference');
    assert.equal(first.quoteKind, 'intraday');
    assert.equal(first.executable, true);
    assert.equal(first.delayed, false);
    assert.equal(first.price, 1.167385);
    assert.equal(first.points.at(-1).close, 1.16);
    assert.deepEqual(first.candles, []);
    now += 31000; fail = true;
    const fallback = await market.get('EURUSD');
    assert.equal(fallback.price, 1.16);
    assert.equal(fallback.asOf, Date.parse('2026-10-12T00:00:00Z') / 1000);
    assert.equal(fallback.quoteKind, 'daily-reference');
    assert.equal(fallback.source, 'Frankfurter / ECB daily reference');
    assert.equal(fallback.executable, false);
    assert.equal(fallback.delayed, true);
    await assert.rejects(market.getExecutionQuote('EURUSD'), error => error.status === 503);
  } finally { market.close(); }
});

test('forex refuses stale, closed, malformed, and rate-limited quotes without revealing keys or provider error bodies', async () => {
  const values = [
    { ok: true, body: { symbol: 'EUR/USD', close: '1.16', timestamp: SECOND - 121, is_market_open: true } },
    { ok: true, body: { symbol: 'EUR/USD', close: '1.16', timestamp: SECOND, is_market_open: false } },
    { ok: true, body: { symbol: 'GBP/USD', close: '1.16', timestamp: SECOND, is_market_open: true } },
    { ok: true, body: { status: 'error', code: 429, message: 'test-private-key is rejected' } },
    { ok: false, status: 429 },
  ];
  for (const value of values) {
    let calls = 0;
    const market = createMarketData({ now: () => NOW, twelveDataApiKey: 'test-private-key', fetchFn: async () => { calls++; return value.ok ? response(value.body) : value; } });
    try {
      await assert.rejects(market.getExecutionQuote('EURUSD'), error => error.status === 503 && !error.message.includes('test-private-key'));
      await assert.rejects(market.getExecutionQuote('EURUSD'), error => error.status === 503);
      assert.equal(calls, 1);
    } finally { market.close(); }
  }
  let calls = 0;
  const weekend = createMarketData({ now: () => Date.parse('2026-10-10T12:00:00Z'), twelveDataApiKey: 'test-private-key', fetchFn: async () => { calls++; throw new Error('Must not fetch'); } });
  try {
    await assert.rejects(weekend.getExecutionQuote('EURUSD'), error => /market is closed/.test(error.message));
    assert.equal(calls, 0);
  } finally { weekend.close(); }
});

test('forex quote caching lasts at most thirty seconds and crypto at most five seconds', async () => {
  let now = NOW, calls = 0;
  const market = createMarketData({ now: () => now, executionCryptoTtlMs: 100000, executionFxTtlMs: 100000, twelveDataApiKey: 'test-private-key', fetchFn: async url => { calls++; return response(url.includes('twelvedata') ? { symbol: 'GBP/USD', close: '1.35', timestamp: Math.floor(now / 1000), is_market_open: true } : { price: '111.25', time: new Date(now).toISOString() }); } });
  try {
    await market.getExecutionQuote('BTCUSD');
    await market.getExecutionQuote('GBPUSD');
    now += 4999;
    await market.getExecutionQuote('BTCUSD');
    assert.equal(calls, 2);
    now += 1;
    await market.getExecutionQuote('BTCUSD');
    assert.equal(calls, 3);
    now = NOW + 29999;
    await market.getExecutionQuote('GBPUSD');
    assert.equal(calls, 3);
    now += 1;
    await market.getExecutionQuote('GBPUSD');
    assert.equal(calls, 4);
  } finally { market.close(); }
});

test('closing execution data aborts an in-flight ticker, and execution timeouts remain bounded', async () => {
  let aborted = 0;
  const market = createMarketData({ fetchFn: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => { aborted++; reject(new Error('Aborted')); }, { once: true })) });
  const pending = market.getExecutionQuote('BTCUSD');
  market.close();
  await assert.rejects(pending, error => error.status === 503);
  await assert.rejects(market.getExecutionQuote('BTCUSD'), error => error.status === 503);
  assert.equal(aborted, 1);
  const stalled = createMarketData({ timeoutMs: 20, fetchFn: async () => new Promise(() => {}) });
  try { await assert.rejects(stalled.getExecutionQuote('BTCUSD'), error => error.status === 503); }
  finally { stalled.close(); }
  const cached = createMarketData({ now: () => NOW, fetchFn: async () => response(ticker) });
  await cached.getExecutionQuote('BTCUSD');
  const cachedRead = cached.getExecutionQuote('BTCUSD');
  cached.close();
  await assert.rejects(cachedRead, error => error.status === 503);
});
