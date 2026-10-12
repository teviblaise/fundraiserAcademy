import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKETS, createAccount, ensureTools, applyReferenceQuotes, marketDependencies, rawQuoteFresh, quoteIsExecutable, quoteCurrencyToUSD, quote, pnl, metrics, openTrade, closeTrade, setLimits, updateStops, placeLimit, advanceMarket, markQuoteUnavailable, refreshRisk } from '../public/simulator.js';

const now = Date.UTC(2026, 9, 12, 12);
function feed(account, values, time = now) {
  return applyReferenceQuotes(account, Object.entries(values).map(([symbol, price]) => ({ symbol, price, asOf: time / 1000, fetchedAt: time, source: 'Controlled forex reference fixture', executable: true })), time);
}
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `Expected ${actual} to equal ${expected}`);

test('ten forex pairs expose currencies and precision, without fabricated starting quotes', () => {
  assert.deepEqual(Object.keys(MARKETS).filter(symbol => MARKETS[symbol].category === 'Forex'), ['EURUSD', 'GBPUSD', 'AUDUSD', 'NZDUSD', 'USDJPY', 'USDCHF', 'USDCAD', 'EURGBP', 'EURJPY', 'GBPJPY']);
  const account = createAccount(now);
  for (const [symbol, market] of Object.entries(MARKETS)) {
    assert.equal(market.baseCurrency, symbol.slice(0, 3));
    assert.equal(market.quoteCurrency, symbol.slice(3));
    assert.equal(market.decimals, market.quoteCurrency === 'JPY' ? 3 : market.category === 'Forex' ? 5 : 2);
    assert.equal(account.prices[symbol].mid, null);
    assert.equal(quoteIsExecutable(account, symbol, now), false);
  }
});

test('adding markets to an existing reference account preserves progress and adds empty price slots', () => {
  const account = createAccount(now);
  account.balance = 10123;
  account.tradingDays = ['2026-10-10'];
  account.prices = { EURUSD: { mid: 1.08 } };
  const epoch = account.notificationEpoch;
  ensureTools(account);
  assert.equal(account.balance, 10123);
  assert.equal(account.notificationEpoch, epoch);
  assert.deepEqual(account.tradingDays, ['2026-10-10']);
  assert.equal(account.prices.USDJPY.mid, null);
  assert.equal(account.migrationRequired, false);
});

test('market dependencies include needed conversion markets and deduplicate self-converting pairs', () => {
  assert.deepEqual(marketDependencies('EURUSD'), ['EURUSD']);
  assert.deepEqual(marketDependencies('AUDUSD'), ['AUDUSD']);
  assert.deepEqual(marketDependencies('USDJPY'), ['USDJPY']);
  assert.deepEqual(marketDependencies('USDCHF'), ['USDCHF']);
  assert.deepEqual(marketDependencies('USDCAD'), ['USDCAD']);
  assert.deepEqual(marketDependencies('EURGBP'), ['EURGBP', 'GBPUSD']);
  assert.deepEqual(marketDependencies('EURJPY'), ['EURJPY', 'USDJPY']);
  assert.deepEqual(marketDependencies('GBPJPY'), ['GBPJPY', 'USDJPY']);
  assert.throws(() => marketDependencies('constructor'), /supported/);
});

test('USDJPY uses the current inverse yen conversion for buy and sell profit', () => {
  for (const side of ['buy', 'sell']) {
    const account = createAccount(now);
    feed(account, { USDJPY: 150 });
    const position = openTrade(account, { symbol: 'USDJPY', side, quantity: 1000 }, now);
    near(position.marginUsd, 1000 / 30);
    feed(account, { USDJPY: 151 });
    const expected = (side === 'buy' ? 1 : -1) * 1000 / 151;
    near(pnl(account, position), expected);
    near(metrics(account, now).floating, expected);
    near(closeTrade(account, position.id, 'Manual close', now), expected);
    near(account.balance, 10000 + expected);
    near(account.history[0].entryQuote.usdRate, 1 / 150);
    near(account.history[0].exitQuote.usdRate, 1 / 151);
    assert.equal(account.history[0].exitQuote.conversionQuote.symbol, 'USDJPY');
    assert.equal(account.history[0].exitQuote.conversionQuote.source, 'Controlled forex reference fixture');
  }
});

test('CHF and CAD denominated profit converts to USD using inverse reference prices', () => {
  for (const [symbol, entry, exit] of [['USDCHF', .9, .91], ['USDCAD', 1.35, 1.36]]) {
    const account = createAccount(now);
    feed(account, { [symbol]: entry });
    const position = openTrade(account, { symbol, side: 'buy', quantity: 1000 }, now);
    near(position.marginUsd, 1000 / 30);
    feed(account, { [symbol]: exit });
    near(pnl(account, position), (exit - entry) * 1000 / exit);
    assert.equal(quote(account, symbol).conversionQuote.direction, 'inverse');
  }
});

test('EURGBP uses GBPUSD to value profit and saves USD margin at entry', () => {
  const account = createAccount(now);
  feed(account, { EURGBP: .85, GBPUSD: 1.25 });
  const position = openTrade(account, { symbol: 'EURGBP', side: 'buy', quantity: 1000 }, now);
  near(position.marginUsd, .85 * 1000 * 1.25 / 30);
  feed(account, { EURGBP: .86, GBPUSD: 1.27 });
  near(pnl(account, position), .01 * 1000 * 1.27);
  near(metrics(account, now).margin, position.marginUsd);
  near(closeTrade(account, position.id, 'Manual close', now), 12.7);
  assert.equal(account.history[0].entryQuote.conversionQuote.price, 1.25);
  assert.equal(account.history[0].exitQuote.conversionQuote.price, 1.27);
  assert.equal(quoteCurrencyToUSD(account, 'EURGBP').conversionQuote.direction, 'direct');
});

test('yen cross profit and margin use USDJPY rather than treating yen as dollars', () => {
  for (const [symbol, entry] of [['EURJPY', 165], ['GBPJPY', 195]]) {
    const account = createAccount(now);
    feed(account, { [symbol]: entry, USDJPY: 150 });
    const position = openTrade(account, { symbol, side: 'buy', quantity: 1000 }, now);
    near(position.marginUsd, entry * 1000 / 150 / 30);
    feed(account, { [symbol]: entry + 1, USDJPY: 151 });
    near(pnl(account, position), 1000 / 151);
    near(metrics(account, now).margin, position.marginUsd);
  }
});

test('new dollar quoted pairs realize USD P&L directly', () => {
  for (const [symbol, entry] of [['AUDUSD', .65], ['NZDUSD', .6]]) {
    const account = createAccount(now);
    feed(account, { [symbol]: entry });
    const position = openTrade(account, { symbol, side: 'buy', quantity: 1000 }, now);
    feed(account, { [symbol]: entry + .01 });
    near(closeTrade(account, position.id, 'Manual close', now), 10);
    assert.equal('usdRate' in position.entryQuote, false);
    assert.deepEqual(quoteCurrencyToUSD(account, symbol), { usdRate: 1, conversionQuote: null });
  }
});

test('USD margin rejects oversized yen trades without imposing yen-sized margin', () => {
  const account = createAccount(now);
  feed(account, { USDJPY: 150 });
  assert.throws(() => openTrade(account, { symbol: 'USDJPY', side: 'buy', quantity: 300001 }, now), /margin/);
  const position = openTrade(account, { symbol: 'USDJPY', side: 'buy', quantity: 300000 }, now);
  near(position.marginUsd, 10000);
  near(metrics(account, now).freeMargin, 0);
});

test('personal dollar stop risk converts yen on entry, pending orders and stop updates', () => {
  const account = createAccount(now);
  feed(account, { USDJPY: 150 });
  setLimits(account, { maxRisk: 10 }, now);
  assert.throws(() => openTrade(account, { symbol: 'USDJPY', side: 'buy', quantity: 1000, stopLoss: 148 }, now), /maximum risk/);
  const position = openTrade(account, { symbol: 'USDJPY', side: 'buy', quantity: 1000, stopLoss: 149 }, now);
  assert.throws(() => updateStops(account, position.id, 148, null, now), /maximum risk/);
  updateStops(account, position.id, 149.5, null, now);
  assert.throws(() => placeLimit(account, { symbol: 'USDJPY', side: 'buy', quantity: 1000, limitPrice: 149.5, stopLoss: 147 }, now), /maximum risk/);
  placeLimit(account, { symbol: 'USDJPY', side: 'buy', quantity: 1000, limitPrice: 149.5, stopLoss: 149 }, now);
  assert.equal(account.pending.length, 1);
});

test('a cross requires its own and conversion quotes to be fresh for entry and close', () => {
  const account = createAccount(now);
  feed(account, { EURGBP: .85 });
  assert.equal(rawQuoteFresh(account, 'EURGBP', now), true);
  assert.equal(quoteIsExecutable(account, 'EURGBP', now), false);
  assert.throws(() => openTrade(account, { symbol: 'EURGBP', side: 'buy', quantity: 1000 }, now), /unavailable/);
  feed(account, { GBPUSD: 1.25 });
  const position = openTrade(account, { symbol: 'EURGBP', side: 'buy', quantity: 1000 }, now);
  const later = now + 31000;
  feed(account, { EURGBP: .86 }, later);
  assert.equal(rawQuoteFresh(account, 'EURGBP', later), true);
  assert.equal(rawQuoteFresh(account, 'GBPUSD', later), false);
  assert.equal(quoteIsExecutable(account, 'EURGBP', later), false);
  assert.throws(() => closeTrade(account, position.id, 'Manual close', later), /unavailable/);
  near(metrics(account, later).floating, 12.5);
  assert.equal(metrics(account, later).executionReady, false);
  feed(account, { GBPUSD: 1.26 }, later);
  near(closeTrade(account, position.id, 'Manual close', later), 12.6);
});

test('missing conversion cannot fabricate zero P&L, a day baseline, or risk decisions', () => {
  const account = createAccount(now);
  feed(account, { EURJPY: 165, USDJPY: 150 });
  const position = openTrade(account, { symbol: 'EURJPY', side: 'buy', quantity: 1000 }, now);
  feed(account, { EURJPY: 166 });
  account.prices.USDJPY.mid = null;
  const later = now + 86400000;
  feed(account, { EURJPY: 166 }, later);
  assert.ok(Number.isNaN(pnl(account, position)));
  const snapshot = metrics(account, later);
  assert.equal(snapshot.floating, null);
  assert.equal(snapshot.equity, null);
  assert.equal(snapshot.valuationComplete, false);
  assert.equal(snapshot.executionReady, false);
  assert.deepEqual(snapshot.unpricedSymbols, ['EURJPY']);
  assert.equal(refreshRisk(account, later), null);
  assert.equal(account.riskPending, true);
  assert.equal(account.day, '2026-10-12');
  assert.equal(account.pendingDailyBaseline, undefined);
  assert.equal(account.dailyStart, 10000);
  assert.throws(() => closeTrade(account, position.id, 'Manual close', later), /unavailable/);
});

test('day rollover preserves the last known USD valuation when conversion updates arrive', () => {
  const account = createAccount(now);
  feed(account, { EURJPY: 165, USDJPY: 150 });
  openTrade(account, { symbol: 'EURJPY', side: 'buy', quantity: 1000 }, now);
  feed(account, { EURJPY: 166 });
  const later = now + 86400000;
  feed(account, { EURJPY: 166, USDJPY: 151 }, later);
  refreshRisk(account, later);
  near(account.dailyStart, 10000 + 1000 / 150);
  near(metrics(account, later).equity, 10000 + 1000 / 151);
});

test('stale conversion pauses protective fills and pending orders until conversion recovers', () => {
  const account = createAccount(now);
  feed(account, { EURJPY: 165, USDJPY: 150 });
  const position = openTrade(account, { symbol: 'EURJPY', side: 'buy', quantity: 1000, stopLoss: 164 }, now);
  placeLimit(account, { symbol: 'EURJPY', side: 'buy', quantity: 1000, limitPrice: 164, stopLoss: 163 }, now);
  markQuoteUnavailable(account, 'USDJPY');
  feed(account, { EURJPY: 163.5 });
  advanceMarket(account, now);
  assert.equal(account.positions[0].id, position.id);
  assert.equal(account.pending.length, 1);
  near(metrics(account, now).floating, -1500 / 150);
  assert.equal(account.riskPending, true);
  feed(account, { USDJPY: 150 });
  advanceMarket(account, now);
  assert.equal(account.history[0].reason, 'Stop loss');
  near(account.history[0].profit, -10);
  assert.equal(account.pending.length, 0);
  assert.equal(account.positions[0].entry, 163.5);
});

test('previous dollar quoted positions retain their original margin without migration', () => {
  const account = createAccount(now);
  feed(account, { EURUSD: 1.08 });
  const position = openTrade(account, { symbol: 'EURUSD', side: 'buy', quantity: 1000 }, now);
  delete position.marginUsd;
  ensureTools(account);
  assert.equal(account.migrationRequired, false);
  near(metrics(account, now).margin, 36);
});

test('academy daily drawdown measures USD losses rather than the numeric yen difference', () => {
  const account = createAccount(now);
  feed(account, { USDJPY: 150 });
  openTrade(account, { symbol: 'USDJPY', side: 'buy', quantity: 75000 }, now);
  feed(account, { USDJPY: 149.9 });
  assert.equal(refreshRisk(account, now), null);
  assert.equal(account.positions.length, 1);
  near(metrics(account, now).dailyLoss, .1 * 75000 / 149.9);
  feed(account, { USDJPY: 149 });
  assert.equal(refreshRisk(account, now), 'Daily loss limit');
  assert.equal(account.locked, 'Daily loss limit');
  assert.equal(account.positions.length, 0);
  near(account.history[0].profit, -75000 / 149);
});
