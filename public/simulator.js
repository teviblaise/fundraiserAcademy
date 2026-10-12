export const MARKETS = {
  EURUSD: { label: 'EUR / USD', category: 'Forex', decimals: 5, leverage: 30, unit: 'EUR units', baseCurrency: 'EUR', quoteCurrency: 'USD' },
  GBPUSD: { label: 'GBP / USD', category: 'Forex', decimals: 5, leverage: 30, unit: 'GBP units', baseCurrency: 'GBP', quoteCurrency: 'USD' },
  AUDUSD: { label: 'AUD / USD', category: 'Forex', decimals: 5, leverage: 30, unit: 'AUD units', baseCurrency: 'AUD', quoteCurrency: 'USD' },
  NZDUSD: { label: 'NZD / USD', category: 'Forex', decimals: 5, leverage: 30, unit: 'NZD units', baseCurrency: 'NZD', quoteCurrency: 'USD' },
  USDJPY: { label: 'USD / JPY', category: 'Forex', decimals: 3, leverage: 30, unit: 'USD units', baseCurrency: 'USD', quoteCurrency: 'JPY' },
  USDCHF: { label: 'USD / CHF', category: 'Forex', decimals: 5, leverage: 30, unit: 'USD units', baseCurrency: 'USD', quoteCurrency: 'CHF' },
  USDCAD: { label: 'USD / CAD', category: 'Forex', decimals: 5, leverage: 30, unit: 'USD units', baseCurrency: 'USD', quoteCurrency: 'CAD' },
  EURGBP: { label: 'EUR / GBP', category: 'Forex', decimals: 5, leverage: 30, unit: 'EUR units', baseCurrency: 'EUR', quoteCurrency: 'GBP' },
  EURJPY: { label: 'EUR / JPY', category: 'Forex', decimals: 3, leverage: 30, unit: 'EUR units', baseCurrency: 'EUR', quoteCurrency: 'JPY' },
  GBPJPY: { label: 'GBP / JPY', category: 'Forex', decimals: 3, leverage: 30, unit: 'GBP units', baseCurrency: 'GBP', quoteCurrency: 'JPY' },
  BTCUSD: { label: 'BTC / USD', category: 'Crypto', decimals: 2, leverage: 2, unit: 'BTC', baseCurrency: 'BTC', quoteCurrency: 'USD' },
  ETHUSD: { label: 'ETH / USD', category: 'Crypto', decimals: 2, leverage: 2, unit: 'ETH', baseCurrency: 'ETH', quoteCurrency: 'USD' },
};

const day = time => new Date(time).toISOString().slice(0, 10);
const hasMarket = symbol => typeof symbol === 'string' && Object.hasOwn(MARKETS,symbol);
export const REFERENCE_MAX_SOURCE_AGE = 120000;
export const REFERENCE_MAX_FETCH_AGE = 30000;
const emptyPrice = () => ({ mid: null, previous: null, history: [], asOf: null, fetchedAt: null, source: null, available: false, executable: false });
const CONVERSION_MARKETS = { GBP: { symbol: 'GBPUSD', direction: 'direct' }, JPY: { symbol: 'USDJPY', direction: 'inverse' }, CHF: { symbol: 'USDCHF', direction: 'inverse' }, CAD: { symbol: 'USDCAD', direction: 'inverse' } };
const quoteMetadata = q => ({ price: q.price, asOf: q.asOf, fetchedAt: q.fetchedAt, source: q.source, ...('usdRate' in q ? { usdRate: q.usdRate, conversionQuote: q.conversionQuote } : {}) });
export function marketDependencies(symbol) {
  if (!hasMarket(symbol)) throw new Error('Choose a supported market.');
  const conversion = CONVERSION_MARKETS[MARKETS[symbol].quoteCurrency];
  return [...new Set([symbol, ...(conversion ? [conversion.symbol] : [])])];
}
export function rawQuoteFresh(account, symbol, now = Date.now()) {
  if (!hasMarket(symbol)) return false;
  const p = account.prices?.[symbol];
  return account.executionMode === 'reference' && !!p && p.available === true && p.executable === true && Number.isFinite(p.mid) && p.mid > 0 && Number.isFinite(p.asOf) && Number.isFinite(p.fetchedAt) && typeof p.source === 'string' && p.source.length > 0 && now - p.asOf * 1000 <= REFERENCE_MAX_SOURCE_AGE && now - p.asOf * 1000 >= -5000 && now - p.fetchedAt <= REFERENCE_MAX_FETCH_AGE && now - p.fetchedAt >= -5000;
}
export function quoteIsExecutable(account, symbol, now = Date.now()) {
  return hasMarket(symbol) && marketDependencies(symbol).every(dependency => rawQuoteFresh(account, dependency, now));
}
export function quoteCurrencyToUSD(account, symbol) {
  if (!hasMarket(symbol)) throw new Error('Choose a supported market.');
  if (MARKETS[symbol].quoteCurrency === 'USD') return { usdRate: 1, conversionQuote: null };
  const conversion = CONVERSION_MARKETS[MARKETS[symbol].quoteCurrency];
  const p = account.executionMode === 'reference' ? account.prices?.[conversion.symbol] : null;
  if (!p || !Number.isFinite(p.mid) || p.mid <= 0) return { usdRate: null, conversionQuote: null };
  return { usdRate: conversion.direction === 'inverse' ? 1 / p.mid : p.mid, conversionQuote: { symbol: conversion.symbol, price: p.mid, source: p.source ?? null, asOf: p.asOf ?? null, fetchedAt: p.fetchedAt ?? null, direction: conversion.direction } };
}
export function assertExecutableQuote(account, symbol, now = Date.now()) {
  if (!hasMarket(symbol)) throw new Error('Choose a supported market.');
  if (!quoteIsExecutable(account, symbol, now)) throw new Error(`A fresh reference price for ${symbol} is unavailable. Trading is paused until the market feed recovers.`);
  return quote(account, symbol);
}
export function markQuoteUnavailable(account, symbol, message = 'Reference feed unavailable.') {
  if (!hasMarket(symbol)) throw new Error('Choose a supported market.');
  account.prices ??= {};
  account.prices[symbol] ??= emptyPrice();
  Object.assign(account.prices[symbol], { available: false, executable: false, error: String(message).slice(0, 300) });
}
export function applyReferenceQuotes(account, quotes, now = Date.now()) {
  ensureTools(account);
  if (account.executionMode !== 'reference') throw new Error('This assessment must be restarted before reference-price trading.');
  captureDayBaseline(account,now);
  const updates = Array.isArray(quotes) ? quotes : Object.entries(quotes).map(([symbol, q]) => ({ ...q, symbol }));
  for (const update of updates) {
    const { symbol, price, asOf, fetchedAt, source, executable } = update;
    if (!hasMarket(symbol) || !Number.isFinite(price) || price <= 0 || !Number.isFinite(asOf) || !Number.isFinite(fetchedAt) || typeof source !== 'string' || !source.trim() || executable !== true || now - asOf * 1000 > REFERENCE_MAX_SOURCE_AGE || now - asOf * 1000 < -5000 || now - fetchedAt > REFERENCE_MAX_FETCH_AGE || now - fetchedAt < -5000) throw new Error('Only fresh, timestamped reference quotes can be used for execution.');
    const p = account.prices[symbol] ??= emptyPrice();
    if (p.asOf !== null && asOf < p.asOf) continue;
    if (p.mid !== price || p.asOf !== asOf || p.source !== source) {
      p.previous = p.mid;
      p.mid = price;
      p.history.push(price);
      p.history = p.history.slice(-80);
      account.ticks++;
    }
    Object.assign(p, { asOf, fetchedAt, source, available: true, executable: true, error: null });
  }
  return account;
}
export function ensureTools(account) {
  account.executionMode ??= 'legacy';
  account.migrationRequired = account.executionMode !== 'reference';
  account.notificationEpoch ??= globalThis.crypto.randomUUID();
  account.tradingDays ??= [...new Set([...account.positions,...account.history].map(p=>day(p.openedAt)))];
  if(account.executionMode==='reference' && account.locked==='Profit target achieved' && account.tradingDays.length<3)account.locked=null;
  account.limits ??= { dailyLoss: null, maxRisk: null, maxPositions: 20 };
  account.pending ??= [];
  account.alerts ??= [];
  account.notifications ??= [];
  account.nextNotice ??= 1;
  account.nextAlert ??= 1;
  account.prices ??= {};
  for (const symbol of Object.keys(MARKETS)) account.prices[symbol] ??= emptyPrice();
  return account;
}
export function notify(account, title, text, now = Date.now()) {
  ensureTools(account);
  account.notifications.unshift({ id: account.nextNotice++, title, text, createdAt: now, read: false });
  account.notifications = account.notifications.slice(0, 100);
}
export function setLimits(account, limits, now = Date.now()) {
  ensureTools(account);
  const { dailyLoss = null, maxRisk = null, maxPositions = 20 } = limits;
  if (dailyLoss !== null && (!Number.isFinite(dailyLoss) || dailyLoss <= 0 || dailyLoss > account.dailyStart * .05)) throw new Error('Personal daily loss must be positive and no higher than the academy daily limit.');
  if (maxRisk !== null && (!Number.isFinite(maxRisk) || maxRisk <= 0 || maxRisk > account.initial * .1)) throw new Error('Maximum risk per trade must be positive and no higher than the total loss allowance.');
  if (!Number.isInteger(maxPositions) || maxPositions < 1 || maxPositions > 20) throw new Error('Maximum open positions must be between 1 and 20.');
  account.limits = { dailyLoss, maxRisk, maxPositions };
  notify(account,'Risk limits saved','Personal limits apply alongside the academy challenge rules.',now);
  refreshRisk(account,now);
}
function validateStops(side, entry, quantity, stopLoss, takeProfit, account, reference = null, usdRate = 1) {
  for (const [label,value] of [['Stop loss',stopLoss],['Take profit',takeProfit]]) if (value !== null && (!Number.isFinite(value) || value <= 0)) throw new Error(`${label} must be a positive price.`);
  if (stopLoss !== null && (side === 'buy' ? stopLoss >= (reference?.bid ?? entry) : stopLoss <= (reference?.ask ?? entry))) throw new Error('Stop loss must be below the bid for a buy or above the ask for a sell.');
  if (takeProfit !== null && (side === 'buy' ? takeProfit <= (reference?.ask ?? entry) : takeProfit >= (reference?.bid ?? entry))) throw new Error('Take profit must be above the ask for a buy or below the bid for a sell.');
  if (account.limits.maxRisk !== null && (stopLoss === null || !Number.isFinite(usdRate) || Math.max(0, side === 'buy' ? entry-stopLoss : stopLoss-entry) * quantity * usdRate > account.limits.maxRisk)) throw new Error('Set a stop loss within your maximum risk per trade. Gaps can still exceed planned risk.');
}
export function updateStops(account, id, stopLoss, takeProfit, now = Date.now()) {
  ensureTools(account);
  const p=account.positions.find(p=>p.id===id);
  if (!p) throw new Error('This position is no longer open.');
  const q = assertExecutableQuote(account,p.symbol,now);
  validateStops(p.side,p.entry,p.quantity,stopLoss,takeProfit,account,q,quoteCurrencyToUSD(account,p.symbol).usdRate);
  p.stopLoss=stopLoss; p.takeProfit=takeProfit;
  notify(account,'Trade protection updated',`${p.symbol} position #${p.id}: stop loss and take profit updated.`,now);
}
export function placeLimit(account, order, now = Date.now()) {
  ensureTools(account); refreshRisk(account,now);
  if(account.locked) throw new Error('Trading is locked.');
  const {symbol,side,quantity,limitPrice,stopLoss=null,takeProfit=null}=order;
  if (!hasMarket(symbol) || !['buy','sell'].includes(side) || !Number.isFinite(quantity) || quantity<=0 || !Number.isFinite(limitPrice) || limitPrice<=0) throw new Error('Enter a valid market, direction, quantity, and limit price.');
  const q=assertExecutableQuote(account,symbol,now);
  if(side==='buy'?limitPrice>=q.ask:limitPrice<=q.bid) throw new Error('A buy limit must be below the ask; a sell limit must be above the bid.');
  if(account.pending.length>=20) throw new Error('The demo allows 20 pending orders.');
  validateStops(side,limitPrice,quantity,stopLoss,takeProfit,account,null,quoteCurrencyToUSD(account,symbol).usdRate);
  const pending={id:account.nextId++,symbol,side,quantity,limitPrice,stopLoss,takeProfit,createdAt:now};
  account.pending.push(pending);
  notify(account,'Limit order placed',`${symbol} ${side} limit #${pending.id} at ${limitPrice}. Margin is checked at execution.`,now);
  return pending;
}
export function addAlert(account, {symbol,direction,target}, now=Date.now()) {
  ensureTools(account);
  if(!hasMarket(symbol) || !['above','below'].includes(direction) || !Number.isFinite(target) || target<=0) throw new Error('Enter a supported market, alert direction, and positive price.');
  if(account.alerts.filter(a=>a.active).length>=20) throw new Error('The demo allows 20 active price alerts.');
  const alert={id:account.nextAlert++,symbol,direction,target,active:true,createdAt:now};
  account.alerts.unshift(alert); account.alerts=account.alerts.filter(a=>a.active).concat(account.alerts.filter(a=>!a.active).slice(0,80));
  return alert;
}
export function createAccount(now = Date.now()) {
  return ensureTools({ version: 2, executionMode: 'reference', initial: 10000, balance: 10000, dailyStart: 10000, day: day(now), peak: 10000, worstDrawdown: 0, locked: null, ticks: 0, nextId: 1, positions: [], history: [], prices: Object.fromEntries(Object.keys(MARKETS).map(key => [key, emptyPrice()])) });
}
export function quote(account, symbol) {
  if (!hasMarket(symbol)) throw new Error('Choose a supported market.');
  const p = account.executionMode === 'reference' ? account.prices?.[symbol] ?? emptyPrice() : emptyPrice();
  const mid = Number.isFinite(p.mid) && p.mid > 0 ? p.mid : null;
  return { bid: mid, ask: mid, price: mid, source: p.source ?? null, asOf: p.asOf ?? null, fetchedAt: p.fetchedAt ?? null, available: p.available === true, executable: p.executable === true, ...(MARKETS[symbol].quoteCurrency === 'USD' ? {} : quoteCurrencyToUSD(account,symbol)) };
}
export function pnl(account, position) {
  const prices = quote(account, position.symbol);
  const { usdRate } = quoteCurrencyToUSD(account,position.symbol);
  if (prices.price === null || usdRate === null) return NaN;
  return (position.side === 'buy' ? prices.bid - position.entry : position.entry - prices.ask) * position.quantity * usdRate;
}
function positionMargin(account, position) {
  if (Number.isFinite(position.marginUsd)) return position.marginUsd;
  const market = MARKETS[position.symbol];
  const entryRate = market.quoteCurrency === 'USD' ? 1 : Number.isFinite(position.entryQuote?.usdRate) ? position.entryQuote.usdRate : market.baseCurrency === 'USD' ? 1 / position.entry : NaN;
  return position.entry * position.quantity * entryRate / market.leverage;
}
export function metrics(account, now = Date.now()) {
  const floating = account.positions.reduce((sum, p) => sum + pnl(account, p), 0);
  const equity = account.balance + floating;
  const margin = account.positions.reduce((sum, p) => sum + positionMargin(account, p), 0);
  const wins = account.history.filter(t => t.profit > 0).length;
  const unpricedSymbols = [...new Set(account.positions.filter(p => !Number.isFinite(pnl(account,p)) || !Number.isFinite(positionMargin(account,p))).map(p => p.symbol))];
  const staleSymbols = [...new Set(account.positions.filter(p => !quoteIsExecutable(account,p.symbol,now)).map(p => p.symbol))];
  const valuationComplete = !unpricedSymbols.length;
  return { floating: valuationComplete ? floating : null, equity: valuationComplete ? equity : null, margin: Number.isFinite(margin) ? margin : null, freeMargin: valuationComplete ? equity - margin : null, net: valuationComplete ? equity - account.initial : null, dailyLoss: valuationComplete ? Math.max(0, account.dailyStart - equity) : null, totalLoss: valuationComplete ? Math.max(0, account.initial - equity) : null, drawdown: valuationComplete ? Math.max(0, (account.peak - equity) / account.peak * 100) : null, winRate: account.history.length ? wins / account.history.length * 100 : null, valuationComplete, executionReady: !staleSymbols.length && valuationComplete, staleSymbols, unpricedSymbols };
}
function captureDayBaseline(account,now) {
  const nextDay=day(now);
  if(nextDay===account.day || account.pendingDailyBaseline?.day===nextDay)return;
  const m=metrics(account,now);
  if(m.valuationComplete)account.pendingDailyBaseline={day:nextDay,equity:m.equity};
}
export function closeTrade(account, id, reason = 'Manual close', now = Date.now()) {
  const index = account.positions.findIndex(p => p.id === id);
  if (index < 0) throw new Error('This position is no longer open.');
  const position = account.positions[index];
  const prices = assertExecutableQuote(account, position.symbol, now);
  const profit = pnl(account, position);
  account.balance += profit;
  account.history.unshift({ ...position, exit: position.side === 'buy' ? prices.bid : prices.ask, exitQuote: quoteMetadata(prices), profit, closedAt: now, reason });
  account.positions.splice(index, 1);
  notify(account,'Trade closed',`${position.symbol} ${position.side} #${position.id}: ${reason}. Realized P&L $${profit.toFixed(2)}.`,now);
  return profit;
}
export function refreshRisk(account, now = Date.now()) {
  ensureTools(account);
  if (account.migrationRequired) { account.riskPending = true; return null; }
  captureDayBaseline(account,now);
  let m = metrics(account,now);
  account.riskPending = !m.executionReady;
  if (account.riskPending) return null;
  if (day(now) !== account.day) {
    account.day = day(now);
    account.dailyStart = account.pendingDailyBaseline?.day === account.day ? account.pendingDailyBaseline.equity : m.equity;
    delete account.pendingDailyBaseline;
    if (['Daily loss limit','Personal daily loss limit'].includes(account.locked)) account.locked = null;
    m = metrics(account,now);
  }
  account.peak = Math.max(account.peak, m.equity);
  account.worstDrawdown = Math.max(account.worstDrawdown, metrics(account,now).drawdown);
  const reason = m.totalLoss >= account.initial * 0.1 ? 'Total loss limit' : m.dailyLoss >= account.dailyStart * 0.05 ? 'Daily loss limit' : account.limits.dailyLoss !== null && m.dailyLoss >= account.limits.dailyLoss ? 'Personal daily loss limit' : account.positions.length && m.freeMargin < 0 ? 'Insufficient margin' : null;
  if (reason) {
    if(account.locked!==reason) notify(account,'Risk limit reached',`${reason}: positions closed and pending orders cancelled.`,now);
    if (reason !== 'Insufficient margin') account.locked = reason;
    account.pending=[];
    for (const position of [...account.positions]) closeTrade(account, position.id, reason, now);
  }
  if (!account.locked && !account.positions.length && account.balance >= account.initial * 1.1 && account.tradingDays.length>=3) { account.locked = 'Profit target achieved'; account.pending=[]; notify(account,'Practice challenge passed','10% realized profit reached over at least 3 trading days with no open positions.',now); }
  return reason;
}
export function openTrade(account, { symbol, side, quantity, stopLoss = null, takeProfit = null }, now = Date.now()) {
  refreshRisk(account, now);
  if (account.locked) throw new Error(`${account.locked} reached. Trading is locked.`);
  if (!hasMarket(symbol) || !['buy', 'sell'].includes(side)) throw new Error('Choose a valid market and direction.');
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Quantity must be a positive number.');
  if (account.positions.length >= account.limits.maxPositions) throw new Error('Your maximum open-position limit has been reached.');
  const prices = assertExecutableQuote(account, symbol, now);
  for (const existing of account.positions) assertExecutableQuote(account,existing.symbol,now);
  const entry = side === 'buy' ? prices.ask : prices.bid;
  const { usdRate } = quoteCurrencyToUSD(account,symbol);
  validateStops(side,entry,quantity,stopLoss,takeProfit,account,prices,usdRate);
  const margin = entry * quantity * usdRate / MARKETS[symbol].leverage;
  const m = metrics(account,now);
  if (margin > m.freeMargin) throw new Error('Insufficient free margin. Reduce your quantity.');
  const position = { id: account.nextId++, symbol, side, quantity, entry, marginUsd: margin, entryQuote: quoteMetadata(prices), stopLoss, takeProfit, openedAt: now };
  account.positions.push(position);
  if(!account.tradingDays.includes(day(now)))account.tradingDays.push(day(now));
  notify(account,'Trade filled',`${symbol} ${side} #${position.id}: ${quantity} units at ${entry.toFixed(MARKETS[symbol].decimals)}.`,now);
  refreshRisk(account, now);
  return position;
}
export function advanceMarket(account, now = Date.now()) {
  ensureTools(account);
  if (account.migrationRequired) return null;
  for(const alert of account.alerts) {
    if (!quoteIsExecutable(account,alert.symbol,now)) continue;
    const mid=account.prices[alert.symbol].mid;
    if(alert.active && (alert.direction==='above'?mid>=alert.target:mid<=alert.target)) { alert.active=false; alert.triggeredAt=now; notify(account,'Price alert',`${alert.symbol} mid price is ${mid.toFixed(MARKETS[alert.symbol].decimals)}, ${alert.direction} ${alert.target}.`,now); }
  }
  for (const position of [...account.positions]) {
    if (!quoteIsExecutable(account,position.symbol,now)) continue;
    const prices = quote(account, position.symbol);
    const exit = position.side === 'buy' ? prices.bid : prices.ask;
    if (position.stopLoss !== null && (position.side === 'buy' ? exit <= position.stopLoss : exit >= position.stopLoss)) closeTrade(account, position.id, 'Stop loss', now);
    else if (position.takeProfit !== null && (position.side === 'buy' ? exit >= position.takeProfit : exit <= position.takeProfit)) closeTrade(account, position.id, 'Take profit', now);
  }
  const reason=refreshRisk(account,now);
  if(!account.locked && metrics(account,now).executionReady) for(const pending of [...account.pending]) {
    if (!quoteIsExecutable(account,pending.symbol,now)) continue;
    const q=quote(account,pending.symbol);
    if(pending.side==='buy'?q.ask<=pending.limitPrice:q.bid>=pending.limitPrice) {
      account.pending=account.pending.filter(p=>p.id!==pending.id);
      try { const p=openTrade(account,pending,now); p.limitOrderId=pending.id; }
      catch(error) { notify(account,'Limit order rejected',`Order #${pending.id}: ${error.message}`,now); }
    }
  }
  return reason;
}
