import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccount, openTrade, closeTrade, metrics, refreshRisk, advanceMarket, quote, setLimits, placeLimit, addAlert, updateStops } from '../public/simulator.js';

const now = Date.UTC(2026, 9, 11, 12);
test('buy and sell use the correct bid/ask and realize P&L', () => {
  for (const side of ['buy', 'sell']) {
    const a = createAccount(now);
    const q = quote(a, 'EURUSD');
    const p = openTrade(a, {symbol:'EURUSD', side, quantity:10000}, now);
    assert.equal(p.entry, side === 'buy' ? q.ask : q.bid);
    assert.ok(Math.abs(metrics(a).floating + 1.2) < 1e-8);
    a.prices.EURUSD.mid += side === 'buy' ? 0.001 : -0.001;
    const profit = closeTrade(a, p.id, 'Manual close', now);
    assert.ok(Math.abs(profit - 8.8) < 1e-8);
    assert.equal(a.positions.length, 0);
    assert.equal(a.balance, 10000 + profit);
  }
});
test('margin and stop direction reject invalid orders without opening trades', () => {
  const a = createAccount(now);
  assert.throws(() => openTrade(a,{symbol:'BTCUSD',side:'buy',quantity:100},now), /margin/);
  assert.throws(() => openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000,stopLoss:2},now), /Stop loss/);
  assert.throws(() => openTrade(a,{symbol:'EURUSD',side:'sell',quantity:-1},now), /positive/);
  assert.equal(a.positions.length,0);
});
test('daily equity breach liquidates and locks until the next UTC day', () => {
  const a = createAccount(now);
  openTrade(a,{symbol:'EURUSD',side:'buy',quantity:100000},now);
  a.prices.EURUSD.mid -= 0.006;
  assert.equal(refreshRisk(a,now),'Daily loss limit');
  assert.equal(a.positions.length,0);
  assert.throws(() => openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},now), /locked/);
  refreshRisk(a,now + 86400000);
  assert.equal(a.locked,null);
  assert.equal(metrics(a).dailyLoss,0);
  openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},now + 86400000);
});
test('total loss lock does not reset on the next day', () => {
  const a = createAccount(now); a.balance=8900;
  refreshRisk(a,now); assert.equal(a.locked,'Total loss limit');
  refreshRisk(a,now+86400000); assert.equal(a.locked,'Total loss limit');
});
test('stop loss and take profit execute at the triggering quote', () => {
  for (const mode of ['stopLoss','takeProfit']) {
    const a=createAccount(now);
    openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000,[mode]:mode==='stopLoss'?1.084:1.086},now);
    a.prices.EURUSD.mid=mode==='stopLoss'?1.08:1.09;
    advanceMarket(a,now);
    assert.equal(a.positions.length,0);
    assert.equal(a.history[0].reason,mode==='stopLoss'?'Stop loss':'Take profit');
    assert.equal(a.history[0].exit,quote(a,'EURUSD').bid);
  }
});
test('market history is bounded and deterministic', () => {
  const a=createAccount(now), b=createAccount(now);
  for(let i=0;i<100;i++){ advanceMarket(a,now); advanceMarket(b,now); }
  assert.deepEqual(a.prices,b.prices);
  assert.equal(a.prices.BTCUSD.history.length,80);
});
test('10% realized profit passes only after 3 distinct trading days with all positions closed', () => {
  const a=createAccount(now);
  const p=openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},now);
  a.balance=11010;
  refreshRisk(a,now); assert.equal(a.locked,null);
  closeTrade(a,p.id,'Manual close',now); refreshRisk(a,now);
  assert.equal(a.locked,null);
  for(const offset of [1,2]){const t=openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},now+offset*86400000);closeTrade(a,t.id,'Manual close',now+offset*86400000);refreshRisk(a,now+offset*86400000);}
  assert.equal(a.locked,'Profit target achieved');
  assert.throws(()=>openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},now+2*86400000),/locked/);
});
test('multiple fills on the same UTC day count only once; placing an unfilled limit does not count',()=>{
  const a=createAccount(now);
  placeLimit(a,{symbol:'EURUSD',side:'buy',quantity:1000,limitPrice:1},now);assert.equal(a.tradingDays.length,0);
  for(let i=0;i<3;i++){const p=openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},now+i*1000);closeTrade(a,p.id,'Manual close',now+i*1000);}
  assert.deepEqual(a.tradingDays,['2026-10-11']);
});
test('personal risk limits cannot weaken academy limits and enforce stop-based risk',()=>{
  const a=createAccount(now);
  assert.throws(()=>setLimits(a,{dailyLoss:501},now),/academy/);
  setLimits(a,{dailyLoss:100,maxRisk:10,maxPositions:1},now);
  assert.throws(()=>openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},now),/stop loss/);
  const p=openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000,stopLoss:1.08},now);
  assert.throws(()=>openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000,stopLoss:1.08},now),/position/);
  assert.throws(()=>updateStops(a,p.id,1,null,now),/maximum risk/);
  updateStops(a,p.id,1.084,1.09,now);
  assert.equal(p.stopLoss,1.084);
  a.prices.EURUSD.mid=0.98;refreshRisk(a,now);
  assert.equal(a.locked,'Personal daily loss limit');
  assert.equal(a.positions.length,0);
  refreshRisk(a,now+86400000);assert.equal(a.locked,null);
});
test('limit orders wait and execute at requested price or better; alerts fire once',()=>{
  const a=createAccount(now);
  const order=placeLimit(a,{symbol:'EURUSD',side:'buy',quantity:1000,limitPrice:1.08},now);
  const alert=addAlert(a,{symbol:'EURUSD',direction:'below',target:1.08},now);
  advanceMarket(a,now);assert.equal(a.pending.length,1);assert.equal(a.positions.length,0);assert.equal(alert.active,true);
  a.prices.EURUSD.mid=1.079;advanceMarket(a,now);
  assert.equal(a.pending.length,0);assert.equal(a.positions.length,1);
  assert.ok(a.positions[0].entry<=order.limitPrice);
  assert.equal(a.positions[0].limitOrderId,order.id);
  assert.equal(alert.active,false);
  assert.equal(a.notifications.filter(n=>n.title==='Price alert').length,1);
  advanceMarket(a,now);assert.equal(a.notifications.filter(n=>n.title==='Price alert').length,1);
  closeTrade(a,a.positions[0].id,'Manual close',now);
  assert.ok(a.notifications.some(n=>n.title==='Trade closed'));
});
test('sell limits fill above their limit; margin rejection produces a notification',()=>{
  const a=createAccount(now);
  placeLimit(a,{symbol:'EURUSD',side:'sell',quantity:1000,limitPrice:1.09},now);
  a.prices.EURUSD.mid=1.091;advanceMarket(a,now);
  assert.ok(a.positions[0].entry>=1.09);
  placeLimit(a,{symbol:'BTCUSD',side:'buy',quantity:100,limitPrice:63000},now);
  a.prices.BTCUSD.mid=62000;advanceMarket(a,now);
  assert.equal(a.pending.length,0);
  assert.ok(a.notifications.some(n=>n.title==='Limit order rejected'&&n.text.includes('margin')));
});
