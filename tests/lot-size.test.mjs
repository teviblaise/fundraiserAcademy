import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKETS, createAccount, applyReferenceQuotes, validateOrderLots, lotToQuantity, quantityToLots, normalizeOrderSize, openTrade, closeTrade, metrics, setLimits, placeLimit, advanceMarket, ensureTools } from '../public/simulator.js';

const now = Date.UTC(2026, 9, 13, 12);
const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `Expected ${actual} to equal ${expected}`);
function feed(account, values, time = now) {
  applyReferenceQuotes(account, Object.entries(values).map(([symbol, price]) => ({ symbol, price, asOf: time / 1000, fetchedAt: time, source: 'Controlled lot-size reference fixture', executable: true })), time);
}

test('lot contracts define forex base units and transparent crypto coin sizes', () => {
  for (const [symbol, market] of Object.entries(MARKETS)) {
    assert.equal(market.lotSize, market.category === 'Forex' ? 100000 : 1);
    assert.equal(market.lotStep, market.category === 'Forex' ? .01 : .001);
    assert.equal(market.defaultLots, market.category === 'Forex' ? .1 : symbol === 'BTCUSD' ? .01 : .1);
  }
  assert.equal(lotToQuantity('EURUSD', .01), 1000);
  assert.equal(lotToQuantity('EURUSD', .29), 29000);
  assert.equal(lotToQuantity('BTCUSD', .027), .027);
  assert.equal(quantityToLots('EURUSD', 1000), .01);
});

test('lot validation rejects malformed sizes, unsupported increments, and mixed units', () => {
  for (const lots of [undefined, null, '', '0.1', NaN, Infinity, -1, 0, .001, 1000.01]) {
    assert.throws(() => lotToQuantity('EURUSD', lots), /Lot size/);
  }
  assert.throws(() => lotToQuantity('EURUSD', .015), /increments of 0.01/);
  assert.throws(() => lotToQuantity('BTCUSD', .0001), /between 0.001/);
  assert.throws(() => lotToQuantity('BTCUSD', .0015), /increments of 0.001/);
  assert.throws(() => validateOrderLots('constructor', .1), /supported market/);
  assert.throws(() => normalizeOrderSize({ symbol: 'EURUSD', lots: .01, quantity: 1000 }), /not both/);
  assert.deepEqual(normalizeOrderSize({ symbol: 'EURUSD', lots: .01, quantity: undefined }), { quantity: 1000, lots: .01, lotSize: 100000 });
  assert.deepEqual(normalizeOrderSize({ symbol: 'EURUSD', quantity: 1000, lots: undefined }), { quantity: 1000, lots: .01, lotSize: 100000 });
  assert.equal(validateOrderLots('EURUSD', .1 + .2), .3);
});

test('forex lots preserve long and short dollar P&L, margin, and execution audit', () => {
  for (const side of ['buy', 'sell']) {
    const account = createAccount(now);
    feed(account, { EURUSD: 1.08 });
    const position = openTrade(account, { symbol: 'EURUSD', side, lots: .01 }, now);
    assert.equal(position.quantity, 1000);
    assert.equal(position.lots, .01);
    assert.equal(position.lotSize, 100000);
    assert.equal(position.entryQuote.price, 1.08);
    near(metrics(account, now).margin, 36);
    feed(account, { EURUSD: 1.09 });
    const profit = side === 'buy' ? 10 : -10;
    near(metrics(account, now).floating, profit);
    near(closeTrade(account, position.id, 'Lot-size close', now), profit);
    near(account.balance, 10000 + profit);
    assert.equal(account.history[0].quantity, 1000);
    assert.equal(account.history[0].lots, .01);
    assert.equal(account.history[0].lotSize, 100000);
    assert.equal(account.history[0].exitQuote.price, 1.09);
  }
});

test('JPY lots use USD conversion for margin and profit on base-USD and cross pairs', () => {
  for (const side of ['buy', 'sell']) {
    for (const [symbol, entry] of [['USDJPY', 150], ['EURJPY', 165]]) {
      const account = createAccount(now);
      feed(account, { USDJPY: 150, [symbol]: entry });
      const position = openTrade(account, { symbol, side, lots: .01 }, now);
      near(position.marginUsd, entry * 1000 / 150 / 30);
      feed(account, { USDJPY: 151, [symbol]: entry + 1 });
      near(closeTrade(account, position.id, 'JPY lot close', now), (side === 'buy' ? 1 : -1) * 1000 / 151);
      assert.equal(account.history[0].entryQuote.conversionQuote.symbol, 'USDJPY');
    }
  }
});

test('lot-size margin rejection uses actual exposure without altering the account', () => {
  const account = createAccount(now);
  feed(account, { USDJPY: 150 });
  assert.throws(() => openTrade(account, { symbol: 'USDJPY', side: 'buy', lots: 3.01 }, now), /free margin/);
  assert.equal(account.positions.length, 0);
  assert.equal(account.balance, 10000);
  const position = openTrade(account, { symbol: 'USDJPY', side: 'buy', lots: 3 }, now);
  assert.equal(position.quantity, 300000);
  near(metrics(account, now).freeMargin, 0);
});

test('personal stop-loss risk applies to canonical quantity after lot conversion', () => {
  const account = createAccount(now);
  feed(account, { EURJPY: 165, USDJPY: 150 });
  setLimits(account, { maxRisk: 10 }, now);
  assert.throws(() => openTrade(account, { symbol: 'EURJPY', side: 'buy', lots: .02, stopLoss: 164 }, now), /maximum risk/);
  assert.equal(account.positions.length, 0);
  const position = openTrade(account, { symbol: 'EURJPY', side: 'buy', lots: .01, stopLoss: 164 }, now);
  assert.equal(position.quantity, 1000);
  near(position.marginUsd, 165 * 1000 / 150 / 30);
});

test('pending lot orders retain their size and fill with authoritative units', () => {
  const account = createAccount(now);
  feed(account, { EURUSD: 1.08 });
  const pending = placeLimit(account, { symbol: 'EURUSD', side: 'buy', lots: .02, limitPrice: 1.07, stopLoss: 1.06 }, now);
  assert.equal(pending.quantity, 2000);
  assert.equal(pending.lots, .02);
  assert.equal(pending.lotSize, 100000);
  feed(account, { EURUSD: 1.069 });
  advanceMarket(account, now);
  assert.equal(account.pending.length, 0);
  assert.equal(account.positions.length, 1);
  assert.equal(account.positions[0].quantity, 2000);
  assert.equal(account.positions[0].lots, .02);
  assert.equal(account.positions[0].limitOrderId, pending.id);
  assert.equal(account.positions[0].entry, 1.069);
  assert.ok(!account.notifications.some(notice => notice.title === 'Limit order rejected'));
});

test('pending lot orders reject conflicting size fields and obey converted stop risk', () => {
  const account = createAccount(now);
  feed(account, { USDJPY: 150 });
  setLimits(account, { maxRisk: 10 }, now);
  assert.throws(() => placeLimit(account, { symbol: 'USDJPY', side: 'buy', lots: .01, quantity: 1000, limitPrice: 149 }, now), /not both/);
  assert.throws(() => placeLimit(account, { symbol: 'USDJPY', side: 'buy', lots: .02, limitPrice: 149, stopLoss: 148 }, now), /maximum risk/);
  assert.equal(account.pending.length, 0);
});

test('crypto lots equal coins and retain coin-based accounting', () => {
  const account = createAccount(now);
  feed(account, { BTCUSD: 60000 });
  const position = openTrade(account, { symbol: 'BTCUSD', side: 'buy', lots: .01 }, now);
  assert.equal(position.quantity, .01);
  assert.equal(position.lotSize, 1);
  near(position.marginUsd, 300);
  feed(account, { BTCUSD: 60100 });
  near(closeTrade(account, position.id, 'Crypto lot close', now), 1);
});

test('legacy quantity orders and stored records preserve their units without migration', () => {
  const account = createAccount(now);
  feed(account, { EURUSD: 1.08 });
  const position = openTrade(account, { symbol: 'EURUSD', side: 'buy', quantity: 999 }, now);
  assert.equal(position.quantity, 999);
  assert.equal(position.lots, .00999);
  delete position.lots;
  delete position.lotSize;
  ensureTools(account);
  assert.equal(Object.hasOwn(position, 'lots'), false);
  assert.equal(position.quantity, 999);
  feed(account, { EURUSD: 1.09 });
  near(closeTrade(account, position.id, 'Preserve historical units', now), 9.99);
  assert.equal(account.history[0].quantity, 999);
  assert.equal(Object.hasOwn(account.history[0], 'lots'), false);
});
