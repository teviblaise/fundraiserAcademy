import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKETS, createAccount, applyReferenceQuotes, openTrade, closeTrade, metrics, refreshRisk, advanceMarket, quote, setLimits, placeLimit, addAlert, updateStops } from '../public/simulator.js';

const now = Date.UTC(2026, 9, 11, 12);
const feed = (a, symbol, price, time=now) => applyReferenceQuotes(a,[{symbol,price,asOf:time/1000,fetchedAt:time,source:'Test reference feed',executable:true}],time);
function account(time=now) {
  const a=createAccount(time);
  const testPrices={EURUSD:1.085,GBPUSD:1.272,BTCUSD:64000,ETHUSD:3200};
  for(const [symbol,testPrice] of Object.entries(testPrices))feed(a,symbol,testPrice,time);
  return a;
}
test('buy and sell fill exactly at the reference price and realize reference-priced P&L', () => {
  for (const side of ['buy', 'sell']) {
    const a = account();
    const q = quote(a, 'EURUSD');
    const p = openTrade(a, {symbol:'EURUSD', side, quantity:10000}, now);
    assert.equal(p.entry,q.price);
    assert.equal(metrics(a,now).floating,0);
    feed(a,'EURUSD',q.price+(side==='buy'?0.001:-0.001));
    const profit = closeTrade(a,p.id,'Manual close',now);
    assert.ok(Math.abs(profit-10)<1e-8);
    assert.equal(a.positions.length,0);
    assert.equal(a.balance,10000+profit);
    assert.equal(a.history[0].exit,quote(a,'EURUSD').price);
    assert.equal(a.history[0].entryQuote.source,'Test reference feed');
    assert.equal(a.history[0].exitQuote.asOf,now/1000);
  }
});
test('margin and stop direction reject invalid orders without opening trades', () => {
  const a = account();
  assert.throws(()=>openTrade(a,{symbol:'BTCUSD',side:'buy',quantity:100},now),/margin/);
  assert.throws(()=>openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000,stopLoss:2},now),/Stop loss/);
  assert.throws(()=>openTrade(a,{symbol:'EURUSD',side:'sell',quantity:-1},now),/positive/);
  assert.equal(a.positions.length,0);
});
test('daily equity breach liquidates at reference price and locks until the next UTC day', () => {
  const a = account();
  openTrade(a,{symbol:'EURUSD',side:'buy',quantity:100000},now);
  feed(a,'EURUSD',1.079);
  assert.equal(refreshRisk(a,now),'Daily loss limit');
  assert.equal(a.positions.length,0);
  assert.equal(a.history[0].exit,1.079);
  assert.throws(()=>openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},now),/locked/);
  refreshRisk(a,now+86400000);
  assert.equal(a.locked,null);
  assert.equal(metrics(a,now+86400000).dailyLoss,0);
  feed(a,'EURUSD',1.079,now+86400000);
  openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},now+86400000);
});
test('total loss lock does not reset on the next day', () => {
  const a=account();a.balance=8900;
  refreshRisk(a,now);assert.equal(a.locked,'Total loss limit');
  refreshRisk(a,now+86400000);assert.equal(a.locked,'Total loss limit');
});
test('stop loss and take profit execute at the triggering reference quote including gaps', () => {
  for (const mode of ['stopLoss','takeProfit']) {
    const a=account();
    openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000,[mode]:mode==='stopLoss'?1.084:1.086},now);
    feed(a,'EURUSD',mode==='stopLoss'?1.08:1.09);
    advanceMarket(a,now);
    assert.equal(a.positions.length,0);
    assert.equal(a.history[0].reason,mode==='stopLoss'?'Stop loss':'Take profit');
    assert.equal(a.history[0].exit,quote(a,'EURUSD').price);
  }
});
test('ticks never invent prices and reference history is bounded', () => {
  const a=createAccount(now);
  for(let i=0;i<100;i++)advanceMarket(a,now+i*1000);
  assert.equal(a.prices.BTCUSD.mid,null);
  assert.equal(a.ticks,0);
  assert.deepEqual(a.prices.BTCUSD.history,[]);
  for(let i=0;i<100;i++)feed(a,'BTCUSD',64000+i,now+i*1000);
  assert.equal(a.prices.BTCUSD.history.length,80);
  assert.equal(a.prices.BTCUSD.mid,64099);
  assert.equal(a.ticks,100);
});
test('10% realized profit passes only after 3 distinct trading days with all positions closed', () => {
  const a=account();
  const p=openTrade(a,{symbol:'EURUSD',side:'buy',quantity:100000},now);
  feed(a,'EURUSD',1.096);
  refreshRisk(a,now);assert.equal(a.locked,null);
  closeTrade(a,p.id,'Manual close',now);refreshRisk(a,now);
  assert.equal(a.locked,null);
  for(const offset of [1,2]){
    const time=now+offset*86400000;feed(a,'EURUSD',1.096,time);
    const t=openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},time);
    closeTrade(a,t.id,'Manual close',time);refreshRisk(a,time);
  }
  assert.equal(a.locked,'Profit target achieved');
  assert.throws(()=>openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},now+2*86400000),/locked/);
});
test('multiple fills on one UTC day count once; an unfilled limit does not count',()=>{
  const a=account();
  placeLimit(a,{symbol:'EURUSD',side:'buy',quantity:1000,limitPrice:1},now);assert.equal(a.tradingDays.length,0);
  for(let i=0;i<3;i++){const p=openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},now+i*1000);closeTrade(a,p.id,'Manual close',now+i*1000);}
  assert.deepEqual(a.tradingDays,['2026-10-11']);
});
test('personal risk limits cannot weaken academy limits and enforce stop-based risk',()=>{
  const a=account();
  assert.throws(()=>setLimits(a,{dailyLoss:501},now),/academy/);
  setLimits(a,{dailyLoss:100,maxRisk:10,maxPositions:1},now);
  assert.throws(()=>openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},now),/stop loss/);
  const p=openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000,stopLoss:1.08},now);
  assert.throws(()=>openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000,stopLoss:1.08},now),/position/);
  assert.throws(()=>updateStops(a,p.id,1,null,now),/maximum risk/);
  updateStops(a,p.id,1.084,1.09,now);assert.equal(p.stopLoss,1.084);
  feed(a,'EURUSD',0.98);refreshRisk(a,now);
  assert.equal(a.locked,'Personal daily loss limit');assert.equal(a.positions.length,0);
  refreshRisk(a,now+86400000);assert.equal(a.locked,null);
});
test('limit orders wait then fill at the observed price or better; alerts fire once',()=>{
  const a=account();
  const order=placeLimit(a,{symbol:'EURUSD',side:'buy',quantity:1000,limitPrice:1.08},now);
  const alert=addAlert(a,{symbol:'EURUSD',direction:'below',target:1.08},now);
  advanceMarket(a,now);assert.equal(a.pending.length,1);assert.equal(a.positions.length,0);assert.equal(alert.active,true);
  feed(a,'EURUSD',1.079);advanceMarket(a,now);
  assert.equal(a.pending.length,0);assert.equal(a.positions.length,1);
  assert.equal(a.positions[0].entry,1.079);assert.ok(a.positions[0].entry<=order.limitPrice);
  assert.equal(a.positions[0].limitOrderId,order.id);assert.equal(alert.active,false);
  assert.equal(a.notifications.filter(n=>n.title==='Price alert').length,1);
  advanceMarket(a,now);assert.equal(a.notifications.filter(n=>n.title==='Price alert').length,1);
  closeTrade(a,a.positions[0].id,'Manual close',now);
  assert.ok(a.notifications.some(n=>n.title==='Trade closed'));
});
test('sell limits fill above their limit; margin rejection produces a notification',()=>{
  const a=account();
  placeLimit(a,{symbol:'EURUSD',side:'sell',quantity:1000,limitPrice:1.09},now);
  feed(a,'EURUSD',1.091);advanceMarket(a,now);assert.equal(a.positions[0].entry,1.091);
  placeLimit(a,{symbol:'BTCUSD',side:'buy',quantity:100,limitPrice:63000},now);
  feed(a,'BTCUSD',62000);advanceMarket(a,now);
  assert.equal(a.pending.length,0);
  assert.ok(a.notifications.some(n=>n.title==='Limit order rejected'&&n.text.includes('margin')));
});
