import { metrics } from './public/simulator.js';

export class PerformanceReportError extends Error {
  constructor(status, message, code) { super(message); this.status = status; if (code) this.code = code; }
}
const fail = (status, message, code) => { throw new PerformanceReportError(status, message, code); };
const maxDate = 8640000000000000;
const maxRows = 50000;
const maxCurvePoints = 2000;
const finite = value => typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= 1e15;
const timestamp = value => Number.isSafeInteger(value) && value >= 0 && value <= maxDate;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const cleanNumber = value => Number.isFinite(value) ? (Math.round(value * 1e8) / 1e8 || 0) : null;
const day = time => new Date(time).toISOString().slice(0, 10);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const amountSum = values => {
  let total = 0, correction = 0;
  for (const value of values) { const adjusted = value - correction, next = total + adjusted; correction = (next - total) - adjusted; total = next; }
  return cleanNumber(total);
};
function validUserId(value) {
  const result = typeof value === 'string' && /^[1-9]\d*$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(result) || result < 1) fail(400, 'Select a valid account.');
  return result;
}
function dateBound(value, end = false) {
  if (value === undefined || value === null || value === '') return null;
  let result;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    result = Date.parse(`${value}T00:00:00.000Z`);
    if (!timestamp(result) || day(result) !== value) fail(400, 'Enter a valid report date.');
    if (end) result += 86400000;
  } else result = typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value;
  if (!timestamp(result)) fail(400, 'Enter a valid report date.');
  return result;
}
function rangeFor(query, time) {
  if (!object(query) || Object.keys(query).some(key => !['source', 'accountId', 'from', 'to'].includes(key))) fail(400, 'The performance report contains unsupported filters.');
  const source = query.source === undefined || query.source === '' ? 'assessment' : query.source;
  if (!['assessment', 'sponsored'].includes(source)) fail(400, 'Choose assessment or sponsored-account performance.');
  const from = dateBound(query.from), to = dateBound(query.to, true) ?? time + 1;
  if (from !== null && from >= to) fail(400, 'The report start must precede its end.');
  if (source === 'sponsored' && (typeof query.accountId !== 'string' || !uuid.test(query.accountId))) fail(400, 'Choose a valid sponsored account.');
  if (source === 'assessment' && query.accountId !== undefined && query.accountId !== '') fail(400, 'An external account ID cannot select an assessment.');
  return { source, from, to, timezone: 'UTC', toExclusive: true };
}
const inRange = (time, range) => (range.from === null || time >= range.from) && time < range.to;
function downsample(points, valueKey) {
  if (points.length <= maxCurvePoints) return { points, totalPoints: points.length, downsampled: false };
  const selected = new Map([[0, points[0]], [points.length - 1, points.at(-1)]]);
  const groups = Math.floor((maxCurvePoints - 2) / 2), size = (points.length - 2) / groups;
  for (let group = 0; group < groups; group++) {
    const begin = 1 + Math.floor(group * size), end = Math.min(points.length - 1, 1 + Math.floor((group + 1) * size));
    let low = begin, high = begin;
    for (let index = begin + 1; index < end; index++) { if (points[index][valueKey] < points[low][valueKey]) low = index; if (points[index][valueKey] > points[high][valueKey]) high = index; }
    selected.set(low, points[low]); selected.set(high, points[high]);
  }
  return { points: [...selected.entries()].sort((a, b) => a[0] - b[0]).map(([, point]) => point), totalPoints: points.length, downsampled: true };
}
function drawdown(points, key, opening = null) {
  let peak = opening?.value ?? null, peakAt = opening?.time ?? null, maxAmount = 0, maxPercent = null;
  let amountPeakAt = null, amountTroughAt = null, percentPeakAt = null, percentTroughAt = null;
  for (const point of points) {
    const value = point[key]; if (!finite(value)) continue;
    if (peak === null || value > peak) { peak = value; peakAt = point.time; }
    const amount = Math.max(0, peak - value), percent = peak > 0 ? amount / peak * 100 : null;
    if (amount > maxAmount) { maxAmount = amount; amountPeakAt = peakAt; amountTroughAt = point.time; }
    if (percent !== null && (maxPercent === null || percent > maxPercent)) { maxPercent = percent; percentPeakAt = peakAt; percentTroughAt = point.time; }
  }
  return { maxAmount: cleanNumber(maxAmount), maxPercent: cleanNumber(maxPercent), amountPeakAt, amountTroughAt, percentPeakAt, percentTroughAt, observations: points.length, measuredFromRecordedSamples: true };
}
function statistics(events, cashflows) {
  const closes = events.filter(event => event.closing), wins = closes.filter(event => event.netProfit > 0), losses = closes.filter(event => event.netProfit < 0);
  const positive = amountSum(events.filter(event => event.netProfit > 0).map(event => event.netProfit)), negative = cleanNumber(-amountSum(events.filter(event => event.netProfit < 0).map(event => event.netProfit)));
  const net = amountSum(events.map(event => event.netProfit));
  return { closedTradeCount: closes.length, winningTrades: wins.length, losingTrades: losses.length, breakevenTrades: closes.length - wins.length - losses.length,
    netProfit: net, grossProfit: positive, grossLoss: negative, winRate: closes.length ? cleanNumber(wins.length / closes.length * 100) : null,
    averageWin: wins.length ? cleanNumber(amountSum(wins.map(event => event.netProfit)) / wins.length) : null,
    averageLoss: losses.length ? cleanNumber(amountSum(losses.map(event => event.netProfit)) / losses.length) : null,
    expectancy: closes.length ? cleanNumber(net / closes.length) : null,
    profitFactor: negative > 0 ? cleanNumber(positive / negative) : null,
    profitFactorStatus: negative > 0 ? 'finite' : positive > 0 ? 'no_recorded_losses' : 'no_recorded_profit_or_loss',
    cashFlows: amountSum(cashflows.map(event => event.cashFlow)), tradingCostEvents: events.filter(event => event.classification === 'trading_cost' || !event.closing).length };
}
function grouped(events, cashflows, key) {
  const buckets = new Map();
  for (const event of [...events, ...cashflows]) { const label = key(event.time); if (!buckets.has(label)) buckets.set(label, { events: [], flows: [] }); buckets.get(label)[event.cashFlow !== undefined ? 'flows' : 'events'].push(event); }
  return [...buckets.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([label, bucket]) => ({ [key.name === 'monthKey' ? 'month' : 'date']: label, ...statistics(bucket.events, bucket.flows) }));
}
function monthKey(time) { return day(time).slice(0, 7); }
function dayKey(time) { return day(time); }
function consistency(daily, events) {
  const positive = daily.filter(item => item.netProfit > 0), negative = daily.filter(item => item.netProfit < 0), flat = daily.filter(item => item.netProfit === 0 && item.closedTradeCount > 0);
  const positiveTotal = amountSum(positive.map(item => item.netProfit)), best = positive.length ? positive.reduce((value, item) => item.netProfit > value.netProfit ? item : value) : null;
  const winning = events.filter(item => item.closing && item.netProfit > 0), winningTotal = amountSum(winning.map(item => item.netProfit));
  const largest = winning.length ? Math.max(...winning.map(item => item.netProfit)) : null;
  const tradeDays = daily.filter(item => item.closedTradeCount || item.tradingCostEvents);
  return { positiveDays: positive.length, negativeDays: negative.length, flatDays: flat.length, recordedTradingDays: tradeDays.length,
    bestDay: best?.date ?? null, bestDayProfit: best?.netProfit ?? null,
    bestDayShareOfPositiveProfitPercent: positiveTotal > 0 ? cleanNumber(best.netProfit / positiveTotal * 100) : null,
    profitableDaySharePercent: tradeDays.length ? cleanNumber(positive.length / tradeDays.length * 100) : null,
    largestWinningFillSharePercent: winningTotal > 0 ? cleanNumber(largest / winningTotal * 100) : null,
    appliesQualificationRule: false, explanation: 'Concentration statistics describe recorded results; they do not add or change academy qualification rules.' };
}

export function createPerformanceReports(db, { now = Date.now, sponsoredSync, maxSnapshotBuckets = 50000 } = {}) {
  if (typeof now !== 'function' || !Number.isSafeInteger(maxSnapshotBuckets) || maxSnapshotBuckets < 10 || maxSnapshotBuckets > 100000) throw new TypeError('Provide a report clock and a bounded snapshot retention count.');
  db.exec(`CREATE TABLE IF NOT EXISTS performance_assessment_snapshots (
    user_id INTEGER NOT NULL REFERENCES users(id), attempt TEXT NOT NULL, bucket_at INTEGER NOT NULL,
    first_sample TEXT NOT NULL, last_sample TEXT NOT NULL, low_sample TEXT NOT NULL, high_sample TEXT NOT NULL,
    PRIMARY KEY(user_id,attempt,bucket_at));
    CREATE INDEX IF NOT EXISTS performance_assessment_samples_time ON performance_assessment_snapshots(user_id,bucket_at DESC);`);
  const exists = name => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name));
  function captureAssessment(userId, state, at = now()) {
    userId = validUserId(userId);
    if (!timestamp(at) || !object(state) || state.executionMode !== 'reference' || !finite(state.balance) || !finite(state.initial) || state.initial <= 0 || typeof state.notificationEpoch !== 'string' || !state.notificationEpoch || state.notificationEpoch.length > 100 || !Array.isArray(state.positions) || !Array.isArray(state.history)) return { captured: false, reason: 'invalid_or_legacy_assessment' };
    let valuation; try { valuation = metrics(state, at); } catch { return { captured: false, reason: 'invalid_valuation' }; }
    if (!valuation.valuationComplete || !valuation.executionReady || !finite(valuation.equity)) return { captured: false, reason: 'unavailable_reference_valuation' };
    const sample = { time: at, balance: state.balance, equity: valuation.equity }, bucket = Math.floor(at / 60000) * 60000;
    const old = db.prepare('SELECT first_sample,last_sample,low_sample,high_sample FROM performance_assessment_snapshots WHERE user_id=? AND attempt=? AND bucket_at=?').get(userId, state.notificationEpoch, bucket);
    let first = sample, last = sample, low = sample, high = sample;
    if (old) {
      try {
        first = JSON.parse(old.first_sample); last = JSON.parse(old.last_sample); low = JSON.parse(old.low_sample); high = JSON.parse(old.high_sample);
        if (![first, last, low, high].every(point => object(point) && timestamp(point.time) && finite(point.balance) && finite(point.equity))) throw new Error();
      } catch { first = sample; last = sample; low = sample; high = sample; }
      if (at < first.time) first = sample; if (at >= last.time) last = sample; if (sample.equity < low.equity) low = sample; if (sample.equity > high.equity) high = sample;
    }
    db.prepare('INSERT INTO performance_assessment_snapshots VALUES (?,?,?,?,?,?,?) ON CONFLICT(user_id,attempt,bucket_at) DO UPDATE SET first_sample=excluded.first_sample,last_sample=excluded.last_sample,low_sample=excluded.low_sample,high_sample=excluded.high_sample')
      .run(userId, state.notificationEpoch, bucket, ...[first, last, low, high].map(point => JSON.stringify(point)));
    db.prepare('DELETE FROM performance_assessment_snapshots WHERE user_id=? AND (attempt,bucket_at) IN (SELECT attempt,bucket_at FROM performance_assessment_snapshots WHERE user_id=? ORDER BY bucket_at DESC,attempt DESC LIMIT -1 OFFSET ?)').run(userId, userId, maxSnapshotBuckets);
    return { captured: true, observedAt: at };
  }
  function assessment(userId, time) {
    const row = db.prepare('SELECT state FROM accounts WHERE user_id=?').get(userId);
    if (!row) fail(404, 'The assessment account was not found.');
    let state = null;
    if (typeof row.state === 'string' && row.state.length <= 32 * 1024 * 1024) { try { state = JSON.parse(row.state); } catch {} }
    if (!object(state) || state.executionMode !== 'reference' || !finite(state.initial) || state.initial <= 0 || !finite(state.balance) || !Array.isArray(state.history)) return { account: { id: null, label: 'Current assessment', currency: 'USD', attempt: null }, events: [], flows: [], snapshots: [], coverage: { status: 'unavailable', historyComplete: false, skippedRecords: 0, warnings: ['Reference assessment history is unavailable or belongs to a retired pricing mode.'] } };
    const events = [], ids = new Set(); let skipped = 0;
    for (const trade of state.history.slice(0, maxRows)) {
      if (!object(trade) || !Number.isSafeInteger(trade.id) || trade.id < 1 || ids.has(trade.id) || !finite(trade.profit) || !timestamp(trade.closedAt) || trade.closedAt > time + 5000) { skipped++; continue; }
      ids.add(trade.id); events.push({ time: trade.closedAt, netProfit: trade.profit, closing: true, classification: 'trade', id: String(trade.id) });
    }
    events.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    const snapshots = [], sampleIds = new Set();
    for (const value of db.prepare('SELECT first_sample,last_sample,low_sample,high_sample FROM performance_assessment_snapshots WHERE user_id=? AND attempt=? ORDER BY bucket_at').all(userId, typeof state.notificationEpoch === 'string' ? state.notificationEpoch : '')) {
      for (const raw of Object.values(value)) { let point; try { point = JSON.parse(raw); } catch { continue; } if (!object(point) || !timestamp(point.time) || point.time > time + 5000 || !finite(point.balance) || !finite(point.equity)) continue; const key = `${point.time}:${point.balance}:${point.equity}`; if (!sampleIds.has(key)) { sampleIds.add(key); snapshots.push(point); } }
    }
    snapshots.sort((a, b) => a.time - b.time);
    const complete = state.history.length <= maxRows && skipped === 0, reconciled = complete && Math.abs(state.initial + amountSum(events.map(item => item.netProfit)) - state.balance) <= Math.max(.000001, Math.abs(state.balance) * 1e-10);
    const warnings = [];
    if (!complete) warnings.push('Some closed fills are omitted or invalid; totals cover only the usable bounded history.');
    if (!reconciled) warnings.push('Recorded closed fills do not reconcile to the saved balance; a historical balance curve is not inferred.');
    if (!snapshots.length) warnings.push('Historical marked equity was not recorded. Equity observations begin when this reporting feature captures actual reference valuations.');
    return { account: { id: null, label: 'Current assessment', currency: 'USD', attempt: typeof state.notificationEpoch === 'string' ? state.notificationEpoch : null }, events, flows: [], snapshots, initial: state.initial, reconstructBalance: reconciled,
      coverage: { status: complete && reconciled ? 'available' : 'partial', historyComplete: complete, skippedRecords: skipped, historyTruncated: state.history.length > maxRows, historyLimit: maxRows, warnings, snapshotSampling: 'First, last, lowest and highest recorded equity sample per observed UTC minute.', snapshotRetentionBuckets: maxSnapshotBuckets } };
  }
  function sponsored(userId, accountId, time) {
    if (!exists('sponsored_accounts')) fail(404, 'Sponsored account not found.');
    const account = db.prepare('SELECT id,label,user_id FROM sponsored_accounts WHERE id=? AND user_id=?').get(accountId.toLowerCase(), userId);
    if (!account) fail(404, 'Sponsored account not found.');
    const raw = sponsoredSync?.performanceData?.(account.id);
    if (!object(raw)) return { account: { id: account.id, label: account.label, currency: null, attempt: null }, events: [], flows: [], snapshots: [], coverage: { status: 'not_connected', historyComplete: false, skippedRecords: 0, warnings: ['Connect and synchronize this MetaApi account before live performance is available.'] } };
    const currency = typeof raw.currency === 'string' && /^[A-Z][A-Z0-9]{1,11}$/.test(raw.currency) ? raw.currency : null;
    const events = [], flows = [], snapshots = [], seen = new Set(); let skipped = 0, adjustments = 0, unknownClose = 0;
    const deals = Array.isArray(raw.deals) ? raw.deals : [], marks = Array.isArray(raw.snapshots) ? raw.snapshots : [];
    for (const deal of deals.slice(0, maxRows)) {
      if (!currency || !object(deal) || deal.currency !== currency || typeof deal.id !== 'string' || !deal.id || seen.has(deal.id) || !timestamp(deal.time) || deal.time > time + 5000) { skipped++; continue; }
      seen.add(deal.id);
      if (deal.classification === 'cashflow') { if (finite(deal.cashFlow)) flows.push({ time: deal.time, cashFlow: deal.cashFlow }); else skipped++; continue; }
      if (!['trade', 'trading_cost'].includes(deal.classification)) { adjustments++; continue; }
      if (!finite(deal.netProfit)) { skipped++; continue; }
      const closing = deal.classification === 'trade' && (deal.isClosing === true || ['DEAL_ENTRY_OUT', 'DEAL_ENTRY_OUT_BY', 'DEAL_ENTRY_INOUT'].includes(deal.entryType));
      if (deal.classification === 'trade' && typeof deal.isClosing !== 'boolean' && !['DEAL_ENTRY_IN', 'DEAL_ENTRY_OUT', 'DEAL_ENTRY_OUT_BY', 'DEAL_ENTRY_INOUT'].includes(deal.entryType)) unknownClose++;
      events.push({ time: deal.time, netProfit: deal.netProfit, closing, classification: deal.classification, id: deal.id });
    }
    for (const point of marks.slice(0, maxRows)) {
      if (!currency || !object(point) || point.currency !== currency || !timestamp(point.at) || point.at > time + 5000 || !finite(point.balance) || !finite(point.equity)) { skipped++; continue; }
      snapshots.push({ time: point.at, balance: point.balance, equity: point.equity });
    }
    events.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id)); flows.sort((a, b) => a.time - b.time); snapshots.sort((a, b) => a.time - b.time);
    const connection = object(raw.connection) ? raw.connection : {}, warnings = [];
    if (!currency) warnings.push('The provider account currency has not been verified. Amounts are not combined or converted.');
    if (!connection.historyComplete) warnings.push('Provider deal-history coverage is incomplete; statistics cover synchronized records only.');
    if (connection.stale) warnings.push('The last successful provider synchronization is stale.');
    if (skipped) warnings.push('Invalid, duplicate or currency-mismatched provider records were omitted.');
    if (adjustments) warnings.push('Provider adjustments with unknown trading classification are excluded from profit.');
    if (unknownClose) warnings.push('Some execution records lack a verified closing-entry type; those records do not enter fill-count and win-rate statistics.');
    if (!snapshots.length) warnings.push('No observed broker equity snapshots are available; no historical equity is invented.');
    const truncated = Boolean(raw.truncated) || deals.length > maxRows || marks.length > maxRows;
    return { account: { id: account.id, label: account.label, currency, attempt: null }, events, flows, snapshots,
      coverage: { status: currency && connection.historyComplete && !skipped && !adjustments && !unknownClose && !truncated ? 'available' : 'partial', historyComplete: Boolean(connection.historyComplete) && !skipped && !adjustments && !unknownClose && !truncated,
        historyFrom: timestamp(connection.historyFrom) ? connection.historyFrom : null, historyThrough: timestamp(connection.historyThrough) ? connection.historyThrough : null,
        lastSuccessfulSyncAt: timestamp(connection.lastSuccessAt) ? connection.lastSuccessAt : null, stale: Boolean(connection.stale), skippedRecords: skipped, excludedAdjustments: adjustments, unclassifiedClosingEntries: unknownClose, historyTruncated: truncated, warnings,
        provider: 'MetaApi', monetaryUnit: 'Native broker account currency; no exchange conversion.', snapshotSampling: 'Actual synchronized broker equity observations.' } };
  }
  function build(userId, query = {}) {
    userId = validUserId(userId);
    if (!db.prepare('SELECT id FROM users WHERE id=?').get(userId)) fail(404, 'Account not found.');
    const time = now(); if (!timestamp(time) || time >= maxDate) throw new TypeError('The report clock must return a valid timestamp.');
    const range = rangeFor(query, time), data = range.source === 'assessment' ? assessment(userId, time) : sponsored(userId, query.accountId, time);
    const events = data.events.filter(item => inRange(item.time, range)), flows = data.flows.filter(item => inRange(item.time, range)), snapshots = data.snapshots.filter(item => inRange(item.time, range));
    const summary = statistics(events, flows), daily = grouped(events, flows, dayKey), monthly = grouped(events, flows, monthKey);
    let balancePoints = [], opening = null, kind = 'observed_balance';
    if (data.reconstructBalance) {
      kind = 'realized_balance'; let balance = data.initial;
      for (const event of data.events) { if (range.from !== null && event.time < range.from) balance += event.netProfit; }
      opening = { value: cleanNumber(balance), time: range.from };
      for (const event of events) { balance += event.netProfit; balancePoints.push({ time: event.time, balance: cleanNumber(balance) }); }
    } else balancePoints = snapshots.map(({ time: at, balance }) => ({ time: at, balance }));
    const equityPoints = snapshots.map(({ time: at, balance, equity }) => ({ time: at, balance, equity }));
    let cumulative = 0, flowIndex = 0; const adjustments = data.flows.filter(item => equityPoints.length && item.time > equityPoints[0].time);
    const adjusted = equityPoints.map(point => { while (flowIndex < adjustments.length && adjustments[flowIndex].time <= point.time) cumulative += adjustments[flowIndex++].cashFlow; return { time: point.time, equity: point.equity - cumulative }; });
    return { generatedAt: time, source: range.source, account: data.account, range, summary, monthly, daily, consistency: consistency(daily, events),
      equityCurve: { kind: 'observed_equity', ...downsample(equityPoints, 'equity'), description: 'Only recorded marked-equity observations are plotted. Lines between observations do not recover unrecorded price movements.' },
      balanceCurve: { kind, openingBalance: opening?.value ?? null, ...downsample(balancePoints, 'balance'), description: kind === 'realized_balance' ? 'Reconstructed from reconciled recorded closed fills. This is realized balance, not historical marked equity.' : 'Actual observed broker balances; deposits and withdrawals can change this curve.' },
      drawdown: { observedEquity: drawdown(equityPoints, 'equity'), cashFlowAdjustedEquity: drawdown(adjusted, 'equity'), realizedBalance: drawdown(balancePoints, 'balance', opening), cashFlowAdjustment: 'Cash-flow-adjusted drawdown removes recorded deposits/withdrawals after the first included equity observation. Other account adjustments can still change observed equity; they are not inferred to be trading profit.' },
      coverage: { ...data.coverage, closedFillUnit: range.source === 'sponsored' ? 'Verified closing execution records; partial closes can be separate fills.' : 'Recorded closed assessment positions.', returnedTradingEvents: events.length, returnedCashFlowEvents: flows.length, observedEquityPoints: equityPoints.length, chartPointLimit: maxCurvePoints,
        observedEquityFrom: data.snapshots[0]?.time ?? null, observedEquityThrough: data.snapshots.at(-1)?.time ?? null,
        availableFrom: data.events.length || data.snapshots.length ? Math.min(...[data.events[0]?.time, data.snapshots[0]?.time].filter(timestamp)) : null,
        availableThrough: data.events.length || data.snapshots.length ? Math.max(...[data.events.at(-1)?.time, data.snapshots.at(-1)?.time].filter(timestamp)) : null } };
  }
  return { captureAssessment, client: build, admin: build };
}
