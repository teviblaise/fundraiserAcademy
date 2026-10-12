import test from 'node:test';
import assert from 'node:assert/strict';
import { detectCandlePatterns } from '../public/candle-patterns.js';

const candle = (time, open, high, low, close) => ({ time, open, high, low, close });

test('only finite, correctly bounded OHLC bars with numeric second timestamps are considered', () => {
  assert.deepEqual(detectCandlePatterns(null), []);
  assert.deepEqual(detectCandlePatterns({}), []);
  assert.deepEqual(detectCandlePatterns([
    null,
    candle(1, 10, 9, 8, 10),
    candle(2, 10, 11, 10.5, 10),
    candle(3, 10, Infinity, 9, 10),
    candle(4, '10', 11, 9, 10),
    candle(-1, 10, 11, 9, 10),
    candle(2.5, 10, 11, 9, 10),
    candle('5', 10, 11, 9, 10),
    candle(Number.MAX_SAFE_INTEGER + 1, 10, 11, 9, 10),
    candle(6, 0, Number.MAX_VALUE, -Number.MAX_VALUE, 0),
    candle(5, 10, 10, 10, 10),
  ]), []);
});

test('dojis use the full candle range, including an exactly 10% body, and exclude zero range', () => {
  const found = detectCandlePatterns([
    candle(1, 100, 110, 90, 100),
    candle(2, 100, 110, 90, 102),
    candle(3, 100, 110, 90, 103),
    candle(4, 100, 100, 100, 100),
  ]);
  assert.deepEqual(found.map(({ time, name, bias }) => ({ time, name, bias })), [
    { time: 1, name: 'Doji', bias: 'neutral' },
    { time: 2, name: 'Doji', bias: 'neutral' },
  ]);
});

test('small prices preserve relative candle shapes without a fixed price threshold', () => {
  assert.equal(detectCandlePatterns([candle(1, 0.00001, 0.000012, 0.000008, 0.0000102)])[0]?.name, 'Doji');
  assert.equal(detectCandlePatterns([candle(2, 0.000010, 0.0000112, 0.000007, 0.000011)])[0]?.name, 'Hammer');
});

test('hammer requires a small body, long lower wick, short upper wick, and is not a doji', () => {
  const found = detectCandlePatterns([
    candle(1, 103, 104.5, 100, 104),
    candle(2, 104, 104.5, 100, 103),
    candle(3, 103, 105, 100, 104), // Upper wick too long.
    candle(4, 103, 104.5, 102, 104), // Lower wick too short.
    candle(5, 103, 104, 100, 103), // No body: doji, not hammer.
  ]);
  assert.deepEqual(found.filter(pattern => pattern.name === 'Hammer').map(pattern => pattern.time), [1, 2]);
  assert.deepEqual(found.filter(pattern => pattern.time === 5).map(pattern => pattern.name), ['Doji']);
});

test('bullish and bearish engulfing require opposite direction and cover the previous body', () => {
  const bullish = detectCandlePatterns([
    candle(1, 105, 106, 101, 102),
    candle(2, 101, 107, 100, 106),
  ]);
  assert.deepEqual(bullish.map(({ time, name, bias }) => ({ time, name, bias })), [
    { time: 2, name: 'Bullish engulfing', bias: 'bullish' },
  ]);
  const bearish = detectCandlePatterns([
    candle(1, 102, 106, 101, 105),
    candle(2, 106, 107, 100, 101),
  ]);
  assert.deepEqual(bearish.map(({ time, name, bias }) => ({ time, name, bias })), [
    { time: 2, name: 'Bearish engulfing', bias: 'bearish' },
  ]);
  assert.ok(bullish[0].explanation.includes('confirmation'));
});

test('matching direction, uncovered body edges, equal body size, and zero-body prior candles do not engulf', () => {
  for (const bars of [
    [candle(1, 102, 106, 101, 105), candle(2, 101, 107, 100, 106)],
    [candle(1, 105, 106, 101, 102), candle(2, 103, 109, 102, 108)],
    [candle(1, 105, 106, 101, 102), candle(2, 102, 106, 101, 105)],
    [candle(1, 103, 104, 102, 103), candle(2, 101, 107, 100, 106)],
  ]) {
    assert.equal(detectCandlePatterns(bars).some(pattern => pattern.name.includes('engulfing')), false);
  }
});

test('history is chronological, bounded to the latest 12 findings, and does not modify input', () => {
  const bars = Array.from({ length: 20 }, (_, index) => candle(index + 1, 100, 110, 90, 100)).reverse();
  const snapshot = structuredClone(bars);
  const found = detectCandlePatterns(bars);
  assert.deepEqual(found.map(pattern => pattern.time), Array.from({ length: 12 }, (_, index) => index + 9));
  assert.deepEqual(bars, snapshot);
  assert.ok(found.every(pattern => typeof pattern.explanation === 'string' && pattern.explanation.length > 0));
});

test('a refreshed timestamp replaces its earlier snapshot and creates no duplicate pattern', () => {
  assert.deepEqual(detectCandlePatterns([
    candle(1, 100, 110, 90, 100),
    candle(1, 100, 104, 99, 103),
  ]), []);
});
