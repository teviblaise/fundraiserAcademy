import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccount, ensureTools, applyReferenceQuotes, markQuoteUnavailable, quote, quoteIsExecutable, openTrade, closeTrade, placeLimit, updateStops, addAlert, advanceMarket, refreshRisk, setLimits, metrics } from '../public/simulator.js';

const now=Date.UTC(2026,9,12,12);
const sample=(symbol='EURUSD',price=1.08,time=now,extra={})=>({symbol,price,asOf:time/1000,fetchedAt:time,source:'Authenticated market fixture',executable:true,...extra});
const feed=(a,symbol,price,time=now)=>applyReferenceQuotes(a,[sample(symbol,price,time)],time);
const priced=()=>{const a=createAccount(now);feed(a,'EURUSD',1.08);return a;};
const buy=a=>openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},now);

test('new assessments wait for actual reference data and cannot trade fabricated initial prices',()=>{
  const a=createAccount(now);
  assert.equal(a.version,2);assert.equal(a.executionMode,'reference');assert.equal(a.migrationRequired,false);
  assert.equal(quote(a,'EURUSD').bid,null);assert.equal(quote(a,'EURUSD').ask,null);
  for(let i=0;i<10;i++)advanceMarket(a,now+i*1000);
  assert.equal(a.ticks,0);assert.equal(a.prices.EURUSD.mid,null);
  assert.throws(()=>openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000},now),/fresh reference price/);
  assert.throws(()=>placeLimit(a,{symbol:'EURUSD',side:'buy',quantity:1000,limitPrice:1.07},now),/fresh reference price/);
  assert.deepEqual(a.positions,[]);assert.deepEqual(a.pending,[]);assert.deepEqual(a.tradingDays,[]);
});
test('reference execution does not add a manufactured spread or random slippage',()=>{
  const a=priced(),p=buy(a);
  assert.equal(p.entry,1.08);assert.equal(quote(a,'EURUSD').bid,1.08);assert.equal(quote(a,'EURUSD').ask,1.08);
  assert.equal(metrics(a,now).floating,0);
  advanceMarket(a,now+1500);assert.equal(a.prices.EURUSD.mid,1.08);
  assert.equal(closeTrade(a,p.id,'Manual close',now+1500),0);
  assert.deepEqual(a.history[0].entryQuote,{price:1.08,asOf:now/1000,fetchedAt:now,source:'Authenticated market fixture'});
  assert.deepEqual(a.history[0].exitQuote,a.history[0].entryQuote);
});
test('stale provider timestamps cannot be laundered by a recent fetch',()=>{
  const a=createAccount(now);
  assert.throws(()=>applyReferenceQuotes(a,[sample('EURUSD',1.08,now,{asOf:(now-120001)/1000})],now),/fresh, timestamped/);
  assert.equal(a.prices.EURUSD.mid,null);
  const b=priced();b.prices.EURUSD.asOf=(now-120001)/1000;
  assert.equal(quoteIsExecutable(b,'EURUSD',now),false);
  assert.throws(()=>buy(b),/fresh reference price/);
});
test('old fetches, non-executable data, invalid prices and future dates never become fills',()=>{
  for(const bad of [{fetchedAt:now-30001},{executable:false},{price:0},{price:NaN},{asOf:(now+5001)/1000},{fetchedAt:now+5001},{source:''}]){
    const a=createAccount(now);
    assert.throws(()=>applyReferenceQuotes(a,[sample('EURUSD',1.08,now,bad)],now),/fresh, timestamped/);
    assert.equal(a.ticks,0);assert.equal(a.prices.EURUSD.mid,null);
  }
});
test('a stale snapshot cannot close, open, place limits, or edit protection',()=>{
  const a=priced(),p=buy(a),stale=now+30001;
  assert.equal(quote(a,'EURUSD').price,1.08);
  assert.equal(quoteIsExecutable(a,'EURUSD',stale),false);
  assert.throws(()=>closeTrade(a,p.id,'Manual close',stale),/fresh reference price/);
  assert.throws(()=>openTrade(a,{symbol:'EURUSD',side:'sell',quantity:1000},stale),/fresh reference price/);
  assert.throws(()=>placeLimit(a,{symbol:'EURUSD',side:'buy',quantity:1000,limitPrice:1.07},stale),/fresh reference price/);
  assert.throws(()=>updateStops(a,p.id,1.07,1.09,stale),/fresh reference price/);
  assert.equal(a.balance,10000);assert.equal(a.positions.length,1);assert.equal(a.history.length,0);
  assert.equal(p.stopLoss,null);assert.equal(p.takeProfit,null);
});
test('feed outages retain display marks but pause stops, pending fills and alerts',()=>{
  const a=priced();
  const p=openTrade(a,{symbol:'EURUSD',side:'buy',quantity:1000,stopLoss:1.07},now);
  placeLimit(a,{symbol:'EURUSD',side:'buy',quantity:1000,limitPrice:1.07},now);
  const alert=addAlert(a,{symbol:'EURUSD',direction:'below',target:1.07},now);
  feed(a,'EURUSD',1.06);markQuoteUnavailable(a,'EURUSD','Provider timed out');
  advanceMarket(a,now);
  assert.equal(quote(a,'EURUSD').price,1.06);assert.equal(quoteIsExecutable(a,'EURUSD',now),false);
  assert.equal(metrics(a,now).valuationComplete,true);assert.equal(metrics(a,now).executionReady,false);
  assert.ok(Math.abs(metrics(a,now).floating+20)<1e-8);
  assert.deepEqual(metrics(a,now).staleSymbols,['EURUSD']);assert.equal(a.riskPending,true);
  assert.equal(a.positions.length,1);assert.equal(a.positions[0].id,p.id);assert.equal(a.pending.length,1);assert.equal(alert.active,true);
  feed(a,'EURUSD',1.05,now+1000);advanceMarket(a,now+1000);
  assert.equal(a.history[0].reason,'Stop loss');assert.equal(a.history[0].exit,1.05);
  assert.equal(a.positions[0].entry,1.05);assert.equal(a.pending.length,0);assert.equal(alert.active,false);
});
test('repeated source observations update freshness without inventing ticks or history',()=>{
  const a=priced();const history=[...a.prices.EURUSD.history];const ticks=a.ticks;
  applyReferenceQuotes(a,[sample('EURUSD',1.08,now,{fetchedAt:now+20000})],now+20000);
  assert.deepEqual(a.prices.EURUSD.history,history);assert.equal(a.ticks,ticks);
  assert.equal(quoteIsExecutable(a,'EURUSD',now+40000),true);
  applyReferenceQuotes(a,[sample('EURUSD',1.079,now-1000)],now+20000);
  assert.equal(a.prices.EURUSD.mid,1.08);assert.equal(a.prices.EURUSD.fetchedAt,now+20000);
});
test('new trades cannot calculate margin from another stale open position',()=>{
  const a=priced();buy(a);feed(a,'BTCUSD',60000,now+40000);
  assert.throws(()=>openTrade(a,{symbol:'BTCUSD',side:'buy',quantity:.01},now+40000),/EURUSD.*unavailable/);
  assert.equal(a.positions.length,1);assert.equal(a.history.length,0);
});
test('a fresh close can reduce an existing position even while a different market is unavailable',()=>{
  const a=priced();feed(a,'GBPUSD',1.25);
  const p=buy(a);openTrade(a,{symbol:'GBPUSD',side:'buy',quantity:1000},now);
  markQuoteUnavailable(a,'GBPUSD');feed(a,'EURUSD',1.09,now+1000);
  assert.ok(Math.abs(closeTrade(a,p.id,'Manual close',now+1000)-10)<1e-8);
  refreshRisk(a,now+1000);assert.equal(a.positions.length,1);assert.equal(a.positions[0].symbol,'GBPUSD');assert.equal(a.riskPending,true);
});
test('prototype keys are not supported markets',()=>{
  for(const symbol of ['constructor','toString','__proto__']){
    const a=priced();
    assert.throws(()=>quote(a,symbol),/supported market/);
    assert.throws(()=>applyReferenceQuotes(a,[sample(symbol,1.08)],now),/fresh, timestamped/);
    assert.throws(()=>markQuoteUnavailable(a,symbol),/supported market/);
    assert.throws(()=>openTrade(a,{symbol,side:'buy',quantity:1000},now),/valid market/);
    assert.throws(()=>placeLimit(a,{symbol,side:'buy',quantity:1000,limitPrice:1.07},now),/valid market/);
    assert.throws(()=>addAlert(a,{symbol,direction:'above',target:1.09},now),/supported market/);
  }
});
test('pending exposure pauses without rejection when another position has stale pricing',()=>{
  const a=priced();buy(a);feed(a,'BTCUSD',60000);
  const pending=placeLimit(a,{symbol:'BTCUSD',side:'buy',quantity:.01,limitPrice:59000},now);
  feed(a,'BTCUSD',58000,now+40000);advanceMarket(a,now+40000);
  assert.equal(a.pending.length,1);assert.equal(a.pending[0].id,pending.id);assert.equal(a.positions.length,1);
  assert.equal(a.notifications.some(n=>n.title==='Limit order rejected'),false);
  feed(a,'EURUSD',1.08,now+41000);advanceMarket(a,now+41000);
  assert.equal(a.pending.length,0);assert.equal(a.positions.length,2);assert.equal(a.positions.find(p=>p.symbol==='BTCUSD').entry,58000);
});
test('risk liquidation waits for fresh prices for every open position',()=>{
  const a=priced();feed(a,'GBPUSD',1.25);
  openTrade(a,{symbol:'EURUSD',side:'buy',quantity:100000},now);
  openTrade(a,{symbol:'GBPUSD',side:'buy',quantity:1000},now);
  feed(a,'EURUSD',1.074);markQuoteUnavailable(a,'GBPUSD');
  assert.equal(refreshRisk(a,now),null);assert.equal(a.riskPending,true);assert.equal(a.locked,null);assert.equal(a.positions.length,2);
  feed(a,'GBPUSD',1.249,now+1000);
  assert.equal(refreshRisk(a,now+1000),'Daily loss limit');assert.equal(a.positions.length,0);
  assert.equal(a.history.find(p=>p.symbol==='EURUSD').exit,1.074);
  assert.equal(a.history.find(p=>p.symbol==='GBPUSD').exit,1.249);
});
test('personal limits can be saved while the feed is unavailable and enforce on recovery',()=>{
  const a=priced();openTrade(a,{symbol:'EURUSD',side:'buy',quantity:100000},now);
  feed(a,'EURUSD',1.078);markQuoteUnavailable(a,'EURUSD');
  setLimits(a,{dailyLoss:100,maxRisk:50,maxPositions:1},now);
  assert.equal(a.limits.dailyLoss,100);assert.equal(a.positions.length,1);assert.equal(a.locked,null);
  feed(a,'EURUSD',1.078,now+1000);advanceMarket(a,now+1000);
  assert.equal(a.locked,'Personal daily loss limit');assert.equal(a.history[0].exit,1.078);
});
test('stale open positions cannot pass a challenge or roll its day forward',()=>{
  const a=priced();buy(a);a.balance=11200;a.tradingDays=['2026-10-10','2026-10-11','2026-10-12'];
  refreshRisk(a,now+86400000);
  assert.equal(a.locked,null);assert.equal(a.positions.length,1);assert.equal(a.day,'2026-10-12');assert.equal(a.dailyStart,10000);
});
test('an overnight feed outage preserves the previous mark as the new daily baseline so a recovery gap counts',()=>{
  for(const outageTick of [false,true]){
    const a=priced();openTrade(a,{symbol:'EURUSD',side:'buy',quantity:100000},now);
    feed(a,'EURUSD',1.077);refreshRisk(a,now);
    assert.equal(a.locked,null);
    const nextDay=now+86400000;
    if(outageTick){markQuoteUnavailable(a,'EURUSD');advanceMarket(a,nextDay);assert.equal(a.day,'2026-10-12');}
    feed(a,'EURUSD',1.071,nextDay);
    assert.equal(refreshRisk(a,nextDay),'Daily loss limit');
    assert.ok(Math.abs(a.dailyStart-9700)<1e-8);assert.ok(Math.abs(a.balance-9100)<1e-8);
    assert.equal(a.history[0].exit,1.071);assert.equal(a.day,'2026-10-13');
  }
});
test('legacy attempts preserve their balances, positions, prices and completion state until an explicit reset',()=>{
  const a=createAccount(now);a.version=1;delete a.executionMode;
  a.prices.EURUSD={mid:1.085,previous:1.08,history:[1.08,1.085]};
  a.positions=[{id:1,symbol:'EURUSD',side:'buy',quantity:1000,entry:1.085,openedAt:now,stopLoss:1.084,takeProfit:null}];
  a.balance=11200;a.locked='Profit target achieved';a.tradingDays=[];
  const retained={balance:a.balance,locked:a.locked,positions:structuredClone(a.positions),prices:structuredClone(a.prices)};
  ensureTools(a);advanceMarket(a,now+86400000);refreshRisk(a,now+86400000);
  assert.equal(a.executionMode,'legacy');assert.equal(a.migrationRequired,true);
  assert.equal(a.balance,retained.balance);assert.equal(a.locked,retained.locked);assert.deepEqual(a.positions,retained.positions);assert.deepEqual(a.prices,retained.prices);
  assert.equal(quote(a,'EURUSD').price,null);
  assert.throws(()=>closeTrade(a,1,'Manual close',now),/fresh reference price/);
  assert.throws(()=>applyReferenceQuotes(a,[sample()],now),/restarted/);
});
