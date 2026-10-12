/**
 * Recognize simple candle shapes in supplied OHLC history.
 * Times must be Unix seconds. Findings describe shapes, not trade signals.
 */
export function detectCandlePatterns(candles) {
  if (!Array.isArray(candles)) return [];

  const ordered = candles.filter(validCandle).slice().sort((a, b) => a.time - b.time);
  // One OHLC bar per timestamp; a refreshed bar replaces the earlier snapshot.
  const bars = [...new Map(ordered.map(candle => [candle.time, candle])).values()];
  const patterns = [];

  for (let index = 0; index < bars.length; index += 1) {
    const candle = bars[index];
    const range = candle.high - candle.low;
    if (range <= 0) continue;
    const body = Math.abs(candle.close - candle.open);
    const tolerance = epsilon(candle);
    const isDoji = body <= range * 0.1 + tolerance;

    if (isDoji) {
      patterns.push({
        time: candle.time,
        name: 'Doji',
        bias: 'neutral',
        explanation: 'The open and close are close together relative to the candle range. This suggests indecision; context and later candles matter.',
      });
    }

    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);
    if (!isDoji && body <= range * 0.35 + tolerance && lowerWick + tolerance >= body * 2 && upperWick <= body * 0.5 + tolerance) {
      patterns.push({
        time: candle.time,
        name: 'Hammer',
        bias: 'bullish',
        explanation: 'A small body and long lower wick show a recovery from lower prices. This hammer shape may matter after a decline; a reversal is not confirmed.',
      });
    }

    const previous = bars[index - 1];
    if (!previous) continue;
    const previousBody = Math.abs(previous.close - previous.open);
    const pairTolerance = Math.max(tolerance, epsilon(previous));
    if (body <= previousBody + pairTolerance) continue;

    if (previous.close < previous.open && candle.close > candle.open && candle.open <= previous.close + pairTolerance && candle.close >= previous.open - pairTolerance) {
      patterns.push({
        time: candle.time,
        name: 'Bullish engulfing',
        bias: 'bullish',
        explanation: 'An upward candle body covers the previous downward candle body. Buyers recovered that price range; trend context and confirmation are still needed.',
      });
    } else if (previous.close > previous.open && candle.close < candle.open && candle.open >= previous.close - pairTolerance && candle.close <= previous.open + pairTolerance) {
      patterns.push({
        time: candle.time,
        name: 'Bearish engulfing',
        bias: 'bearish',
        explanation: 'A downward candle body covers the previous upward candle body. Sellers recovered that price range; trend context and confirmation are still needed.',
      });
    }
  }

  return patterns.slice(-12);
}

function validCandle(candle) {
  return candle !== null && typeof candle === 'object'
    && Number.isSafeInteger(candle.time) && candle.time >= 0
    && ['open', 'high', 'low', 'close'].every(field => Number.isFinite(candle[field]))
    && candle.high >= Math.max(candle.open, candle.close)
    && candle.low <= Math.min(candle.open, candle.close)
    && candle.high >= candle.low
    && Number.isFinite(candle.high - candle.low);
}

function epsilon(candle) {
  return Number.EPSILON * Math.max(Math.abs(candle.open), Math.abs(candle.high), Math.abs(candle.low), Math.abs(candle.close), Number.MIN_VALUE) * 8;
}
