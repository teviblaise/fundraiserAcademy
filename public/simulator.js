export const MARKETS = {
  EURUSD: { label: 'EUR / USD', category: 'Forex', start: 1.085, decimals: 5, spread: 0.00012, volatility: 0.00045, leverage: 30, unit: 'EUR units' },
  GBPUSD: { label: 'GBP / USD', category: 'Forex', start: 1.272, decimals: 5, spread: 0.00016, volatility: 0.0006, leverage: 30, unit: 'GBP units' },
  BTCUSD: { label: 'BTC / USD', category: 'Crypto', start: 64000, decimals: 2, spread: 20, volatility: 90, leverage: 2, unit: 'BTC' },
  ETHUSD: { label: 'ETH / USD', category: 'Crypto', start: 3200, decimals: 2, spread: 2, volatility: 6, leverage: 2, unit: 'ETH' },
};

const day = time => new Date(time).toISOString().slice(0, 10);
export function ensureTools(account) {
  account.notificationEpoch ??= globalThis.crypto.randomUUID();
  account.tradingDays ??= [...new Set([...account.positions,...account.history].map(p=>day(p.openedAt)))];
  if(account.locked==='Profit target achieved' && account.tradingDays.length<3)account.locked=null;
  account.limits ??= { dailyLoss: null, maxRisk: null, maxPositions: 20 };
  account.pending ??= [];
  account.alerts ??= [];
  account.notifications ??= [];
  account.nextNotice ??= 1;
  account.nextAlert ??= 1;
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
function validateStops(side, entry, quantity, stopLoss, takeProfit, account, reference = null) {
  for (const [label,value] of [['Stop loss',stopLoss],['Take profit',takeProfit]]) if (value !== null && (!Number.isFinite(value) || value <= 0)) throw new Error(`${label} must be a positive price.`);
  if (stopLoss !== null && (side === 'buy' ? stopLoss >= (reference?.bid ?? entry) : stopLoss <= (reference?.ask ?? entry))) throw new Error('Stop loss must be below the bid for a buy or above the ask for a sell.');
  if (takeProfit !== null && (side === 'buy' ? takeProfit <= (reference?.ask ?? entry) : takeProfit >= (reference?.bid ?? entry))) throw new Error('Take profit must be above the ask for a buy or below the bid for a sell.');
  if (account.limits.maxRisk !== null && (stopLoss === null || Math.max(0, side === 'buy' ? entry-stopLoss : stopLoss-entry) * quantity > account.limits.maxRisk)) throw new Error('Set a stop loss within your maximum risk per trade. Gaps can still exceed planned risk.');
}
export function updateStops(account, id, stopLoss, takeProfit, now = Date.now()) {
  ensureTools(account);
  const p=account.positions.find(p=>p.id===id);
  if (!p) throw new Error('This position is no longer open.');
  validateStops(p.side,p.entry,p.quantity,stopLoss,takeProfit,account,quote(account,p.symbol));
  p.stopLoss=stopLoss; p.takeProfit=takeProfit;
  notify(account,'Trade protection updated',`${p.symbol} position #${p.id}: stop loss and take profit updated.`,now);
}
export function placeLimit(account, order, now = Date.now()) {
  ensureTools(account); refreshRisk(account,now);
  if(account.locked) throw new Error('Trading is locked.');
  const {symbol,side,quantity,limitPrice,stopLoss=null,takeProfit=null}=order;
  if (!MARKETS[symbol] || !['buy','sell'].includes(side) || !Number.isFinite(quantity) || quantity<=0 || !Number.isFinite(limitPrice) || limitPrice<=0) throw new Error('Enter a valid market, direction, quantity, and limit price.');
  const q=quote(account,symbol);
  if(side==='buy'?limitPrice>=q.ask:limitPrice<=q.bid) throw new Error('A buy limit must be below the ask; a sell limit must be above the bid.');
  if(account.pending.length>=20) throw new Error('The demo allows 20 pending orders.');
  validateStops(side,limitPrice,quantity,stopLoss,takeProfit,account);
  const pending={id:account.nextId++,symbol,side,quantity,limitPrice,stopLoss,takeProfit,createdAt:now};
  account.pending.push(pending);
  notify(account,'Limit order placed',`${symbol} ${side} limit #${pending.id} at ${limitPrice}. Margin is checked at execution.`,now);
  return pending;
}
export function addAlert(account, {symbol,direction,target}, now=Date.now()) {
  ensureTools(account);
  if(!MARKETS[symbol] || !['above','below'].includes(direction) || !Number.isFinite(target) || target<=0) throw new Error('Enter a supported market, alert direction, and positive price.');
  if(account.alerts.filter(a=>a.active).length>=20) throw new Error('The demo allows 20 active price alerts.');
  const alert={id:account.nextAlert++,symbol,direction,target,active:true,createdAt:now};
  account.alerts.unshift(alert); account.alerts=account.alerts.filter(a=>a.active).concat(account.alerts.filter(a=>!a.active).slice(0,80));
  return alert;
}
export function createAccount(now = Date.now()) {
  return ensureTools({ version: 1, initial: 10000, balance: 10000, dailyStart: 10000, day: day(now), peak: 10000, worstDrawdown: 0, locked: null, seed: 38179, ticks: 0, nextId: 1, positions: [], history: [], prices: Object.fromEntries(Object.entries(MARKETS).map(([key, market]) => [key, { mid: market.start, previous: market.start, history: [market.start] }])) });
}
export function quote(account, symbol) {
  const market = MARKETS[symbol];
  if (!market) throw new Error('Choose a supported market.');
  const mid = account.prices[symbol].mid;
  return { bid: mid - market.spread / 2, ask: mid + market.spread / 2 };
}
export function pnl(account, position) {
  const prices = quote(account, position.symbol);
  return (position.side === 'buy' ? prices.bid - position.entry : position.entry - prices.ask) * position.quantity;
}
export function metrics(account) {
  const floating = account.positions.reduce((sum, p) => sum + pnl(account, p), 0);
  const equity = account.balance + floating;
  const margin = account.positions.reduce((sum, p) => sum + p.entry * p.quantity / MARKETS[p.symbol].leverage, 0);
  const wins = account.history.filter(t => t.profit > 0).length;
  return { floating, equity, margin, freeMargin: equity - margin, net: equity - account.initial, dailyLoss: Math.max(0, account.dailyStart - equity), totalLoss: Math.max(0, account.initial - equity), drawdown: Math.max(0, (account.peak - equity) / account.peak * 100), winRate: account.history.length ? wins / account.history.length * 100 : null };
}
export function closeTrade(account, id, reason = 'Manual close', now = Date.now()) {
  const index = account.positions.findIndex(p => p.id === id);
  if (index < 0) throw new Error('This position is no longer open.');
  const position = account.positions[index];
  const prices = quote(account, position.symbol);
  const profit = pnl(account, position);
  account.balance += profit;
  account.history.unshift({ ...position, exit: position.side === 'buy' ? prices.bid : prices.ask, profit, closedAt: now, reason });
  account.positions.splice(index, 1);
  notify(account,'Trade closed',`${position.symbol} ${position.side} #${position.id}: ${reason}. Realized P&L $${profit.toFixed(2)}.`,now);
  return profit;
}
export function refreshRisk(account, now = Date.now()) {
  ensureTools(account);
  let m = metrics(account);
  if (day(now) !== account.day) {
    account.day = day(now);
    account.dailyStart = m.equity;
    if (['Daily loss limit','Personal daily loss limit'].includes(account.locked)) account.locked = null;
    m = metrics(account);
  }
  account.peak = Math.max(account.peak, m.equity);
  account.worstDrawdown = Math.max(account.worstDrawdown, metrics(account).drawdown);
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
  if (!MARKETS[symbol] || !['buy', 'sell'].includes(side)) throw new Error('Choose a valid market and direction.');
  if (!Number.isFinite(quantity) || quantity <= 0) throw new Error('Quantity must be a positive number.');
  if (account.positions.length >= account.limits.maxPositions) throw new Error('Your maximum open-position limit has been reached.');
  const prices = quote(account, symbol);
  const entry = side === 'buy' ? prices.ask : prices.bid;
  validateStops(side,entry,quantity,stopLoss,takeProfit,account,prices);
  const margin = entry * quantity / MARKETS[symbol].leverage;
  const spreadCost = MARKETS[symbol].spread * quantity;
  const m = metrics(account);
  if (margin + spreadCost > m.freeMargin) throw new Error('Insufficient free margin. Reduce your quantity.');
  if (m.dailyLoss + spreadCost >= Math.min(account.dailyStart*.05,account.limits.dailyLoss??Infinity) || m.totalLoss + spreadCost >= account.initial * 0.1) throw new Error('The spread cost would exceed a loss limit. Reduce your quantity.');
  const position = { id: account.nextId++, symbol, side, quantity, entry, stopLoss, takeProfit, openedAt: now };
  account.positions.push(position);
  if(!account.tradingDays.includes(day(now)))account.tradingDays.push(day(now));
  notify(account,'Trade filled',`${symbol} ${side} #${position.id}: ${quantity} units at ${entry.toFixed(MARKETS[symbol].decimals)}.`,now);
  refreshRisk(account, now);
  return position;
}
export function advanceMarket(account, now = Date.now()) {
  ensureTools(account);
  const random = () => { account.seed = (Math.imul(account.seed, 1664525) + 1013904223) >>> 0; return account.seed / 4294967296; };
  for (const [symbol, market] of Object.entries(MARKETS)) {
    const price = account.prices[symbol];
    price.previous = price.mid;
    price.mid = Math.max(market.start * 0.1, price.mid + (random() - 0.5) * 2 * market.volatility);
    price.history.push(price.mid);
    if (price.history.length > 80) price.history.shift();
  }
  account.ticks++;
  for(const alert of account.alerts) {
    const mid=account.prices[alert.symbol].mid;
    if(alert.active && (alert.direction==='above'?mid>=alert.target:mid<=alert.target)) { alert.active=false; alert.triggeredAt=now; notify(account,'Price alert',`${alert.symbol} mid price is ${mid.toFixed(MARKETS[alert.symbol].decimals)}, ${alert.direction} ${alert.target}.`,now); }
  }
  for (const position of [...account.positions]) {
    const prices = quote(account, position.symbol);
    const exit = position.side === 'buy' ? prices.bid : prices.ask;
    if (position.stopLoss !== null && (position.side === 'buy' ? exit <= position.stopLoss : exit >= position.stopLoss)) closeTrade(account, position.id, 'Stop loss', now);
    else if (position.takeProfit !== null && (position.side === 'buy' ? exit >= position.takeProfit : exit <= position.takeProfit)) closeTrade(account, position.id, 'Take profit', now);
  }
  const reason=refreshRisk(account,now);
  if(!account.locked) for(const pending of [...account.pending]) {
    const q=quote(account,pending.symbol);
    if(pending.side==='buy'?q.ask<=pending.limitPrice:q.bid>=pending.limitPrice) {
      account.pending=account.pending.filter(p=>p.id!==pending.id);
      try { const p=openTrade(account,pending,now); p.limitOrderId=pending.id; }
      catch(error) { notify(account,'Limit order rejected',`Order #${pending.id}: ${error.message}`,now); }
    }
  }
  return reason;
}
