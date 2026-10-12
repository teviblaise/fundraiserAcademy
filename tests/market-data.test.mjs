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
  const market = createMarketData({ now: () => NOW, fetchFn: async url => {
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
  const market = createMarketData({ now: () => NOW, fetchFn: async url => {
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
  const fx = createMarketData({ now: () => NOW, fetchFn: async url => response(url.includes('/latest?') ? { base: 'EUR', date: '2026-10-12', rates: { USD: 1.1 } } : { base: 'EUR', rates: { '2026-02-30': { USD: 1.1 } } }) });
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
