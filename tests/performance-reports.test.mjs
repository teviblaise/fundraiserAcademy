import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createPerformanceReports} from '../performance-reports.mjs';
import {createAccount, applyReferenceQuotes, openTrade} from '../public/simulator.js';

const time=Date.UTC(2026,9,22,12);
const at=value=>Date.parse(value+'T12:00:00.000Z');
const own='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
function fixture(options={}){
 const db=new DatabaseSync(':memory:');
 db.exec(`PRAGMA foreign_keys=ON;CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,password TEXT);CREATE TABLE accounts(user_id INTEGER PRIMARY KEY REFERENCES users(id),state TEXT);CREATE TABLE sponsored_accounts(id TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),label TEXT);INSERT INTO users VALUES(1,'private@example.com','private-password-hash'),(2,'another@example.com','another-private-hash');`);
 let current=time,historyReads=0;const data=new Map();
 const reports=createPerformanceReports(db,{now:()=>current,historicalRecords(id){historyReads++;return data.get(id);},...options});
 const write=(state,id=1)=>db.prepare('INSERT INTO accounts VALUES(?,?) ON CONFLICT(user_id) DO UPDATE SET state=excluded.state').run(id,typeof state==='string'?state:JSON.stringify(state));
 const state=createAccount(time);write(state);write(createAccount(time),2);
 db.prepare('INSERT INTO sponsored_accounts VALUES(?,?,?)').run(own,1,'Own allocation');db.prepare('INSERT INTO sponsored_accounts VALUES(?,?,?)').run(other,2,'Another allocation');
 return{db,reports,state,write,data,setTime(value){current=value;},historyReads:()=>historyReads,close(){db.close();}};
}
function closed(id,profit,date){return{id,profit,closedAt:at(date)};}
function historyFixture(extra={}){return{currency:'EUR',deals:[],snapshots:[],history:{historyComplete:true,historyFrom:at('2026-01-01'),historyThrough:time,observedAt:time},...extra};}
function deal(id,date,netProfit,extra={}){return{id,time:at(date),currency:'EUR',classification:'trade',netProfit,isClosing:true,entryType:'DEAL_ENTRY_OUT',...extra};}

test('assessment reports reconstruct reconciled realized balances without inventing historical marked equity',()=>{
 const f=fixture();try{
  f.state.history=[closed(3,0,'2026-02-01'),closed(2,-50,'2026-01-31'),closed(1,150,'2026-01-10')];f.state.balance=f.state.initial+100;f.write(f.state);
  const r=f.reports.client(1);assert.equal(r.source,'assessment');assert.equal(r.account.currency,'USD');assert.equal(r.summary.closedTradeCount,3);assert.equal(r.summary.netProfit,100);assert.equal(r.summary.grossProfit,150);assert.equal(r.summary.grossLoss,50);assert.equal(r.summary.profitFactor,3);assert.equal(r.summary.winRate,33.33333333);assert.equal(r.summary.averageLoss,-50);assert.equal(r.summary.expectancy,33.33333333);
  assert.deepEqual(r.balanceCurve.points.map(x=>x.balance),[10150,10100,10100]);assert.equal(r.balanceCurve.openingBalance,10000);assert.equal(r.balanceCurve.kind,'realized_balance');assert.equal(r.equityCurve.points.length,0);assert.match(r.coverage.warnings.join(' '),/Historical marked equity was not recorded/);assert.equal(r.drawdown.realizedBalance.maxAmount,50);assert.equal(r.consistency.appliesQualificationRule,false);
  assert.deepEqual(r.monthly.map(x=>[x.month,x.netProfit,x.closedTradeCount]),[['2026-01',100,2],['2026-02',0,1]]);assert.doesNotMatch(JSON.stringify(r),/private@example|private-password/);
 }finally{f.close();}
});

test('UTC date filters are inclusive for date-only end bounds and use the preceding balance as the realized opening',()=>{
 const f=fixture();try{
  f.state.history=[closed(3,-30,'2026-02-01'),closed(2,50,'2026-01-31'),closed(1,100,'2026-01-01')];f.state.balance=10120;f.write(f.state);
  const r=f.reports.client(1,{from:'2026-01-31',to:'2026-01-31'});assert.equal(r.summary.netProfit,50);assert.equal(r.summary.closedTradeCount,1);assert.equal(r.range.timezone,'UTC');assert.equal(r.balanceCurve.openingBalance,10100);assert.equal(r.balanceCurve.points[0].balance,10150);assert.equal(r.monthly.length,1);
  const numeric=f.reports.client(1,{from:String(at('2026-01-31')),to:String(at('2026-02-01'))});assert.equal(numeric.summary.netProfit,50);
  for(const query of[{from:'2026-02-30'},{to:'not-a-date'},{from:'2026-02-02',to:'2026-02-01'},{from:-1},{from:'1e6'},{source:'live'},{userId:2},{source:'assessment',accountId:own},{source:'sponsored',accountId:'invalid'}])assert.throws(()=>f.reports.client(1,query),e=>e.status===400);
 }finally{f.close();}
});

test('capture keeps actual minute extrema and chronological observations while excluding other attempts',()=>{
 const f=fixture();try{
  const base=Math.floor(time/60000)*60000;for(const [offset,balance]of[[0,10000],[100,10200],[200,9800],[300,10100]]){f.state.balance=balance;assert.equal(f.reports.captureAssessment(1,f.state,base+offset).captured,true);}
  f.setTime(time+400);f.write(f.state);const r=f.reports.client(1);assert.deepEqual(r.equityCurve.points.map(x=>[x.time,x.equity]),[[base,10000],[base+100,10200],[base+200,9800],[base+300,10100]]);assert.equal(r.drawdown.observedEquity.maxAmount,400);assert.equal(f.db.prepare('SELECT count(*) n FROM performance_assessment_snapshots').get().n,1);assert.equal(r.balanceCurve.kind,'observed_balance');
  const reset=createAccount(time+1000);assert.notEqual(reset.notificationEpoch,f.state.notificationEpoch);f.write(reset);assert.equal(f.reports.client(1).equityCurve.points.length,0);f.setTime(time+1000);assert.equal(f.reports.captureAssessment(1,reset,time+1000).captured,true);assert.equal(f.reports.client(1).equityCurve.points.length,1);
 }finally{f.close();}
});

test('capture requires fresh actual valuation and never stores stale open positions or retired accounts',()=>{
 const f=fixture();try{
  applyReferenceQuotes(f.state,[{symbol:'EURUSD',price:1.1,asOf:Math.floor(time/1000),fetchedAt:time,source:'Isolated reference',executable:true}],time);openTrade(f.state,{symbol:'EURUSD',side:'buy',lots:.01},time);
  assert.equal(f.reports.captureAssessment(1,f.state,time).captured,true);
  assert.equal(f.reports.captureAssessment(1,f.state,time+86400000).captured,false);assert.equal(f.reports.captureAssessment(1,{...f.state,executionMode:'synthetic'},time).captured,false);assert.equal(f.reports.captureAssessment(1,{...f.state,balance:Infinity},time).captured,false);assert.equal(f.reports.captureAssessment(1,{...f.state,history:[null]},time).captured,false);
  assert.equal(f.db.prepare('SELECT count(*) n FROM performance_assessment_snapshots').get().n,1);
 }finally{f.close();}
});

test('snapshot retention is bounded across attempts and downsampled charts preserve recorded extrema',()=>{
 const f=fixture({maxSnapshotBuckets:10});try{
  for(let i=0;i<12;i++)f.reports.captureAssessment(1,f.state,time-i*60000);
  assert.equal(f.db.prepare('SELECT count(*) n FROM performance_assessment_snapshots WHERE user_id=1').get().n,10);assert.equal(f.db.prepare('SELECT min(bucket_at) first FROM performance_assessment_snapshots').get().first,Math.floor(time/60000)*60000-9*60000);
  f.data.set(own,historyFixture({snapshots:Array.from({length:3001},(_,i)=>({at:time-400000+i*100,currency:'EUR',balance:1000,equity:i===1700?500:i===1300?1500:1000}))}));
  const r=f.reports.client(1,{source:'sponsored',accountId:own});assert.equal(r.equityCurve.totalPoints,3001);assert.ok(r.equityCurve.points.length<=2000);assert.equal(r.equityCurve.downsampled,true);assert.ok(r.equityCurve.points.some(x=>x.equity===500));assert.ok(r.equityCurve.points.some(x=>x.equity===1500));assert.equal(r.drawdown.observedEquity.maxAmount,1000);assert.equal(r.drawdown.observedEquity.observations,3001);
 }finally{f.close();}
});

test('sponsored statistics include fees and swaps once while deposits and withdrawals remain separate from profit',()=>{
 const f=fixture();try{
  f.data.set(own,historyFixture({deals:[deal('opening','2026-01-10',-2,{isClosing:false,entryType:'DEAL_ENTRY_IN'}),deal('winner','2026-01-11',95),deal('loser','2026-01-12',-40),deal('flat','2026-02-01',0),{id:'deposit',time:at('2026-01-12'),currency:'EUR',classification:'cashflow',cashFlow:1000},{id:'withdrawal',time:at('2026-01-12')+1,currency:'EUR',classification:'cashflow',cashFlow:-200}]}));
  const r=f.reports.client(1,{source:'sponsored',accountId:own});assert.equal(r.account.currency,'EUR');assert.equal(r.summary.netProfit,53);assert.equal(r.summary.cashFlows,800);assert.equal(r.summary.closedTradeCount,3);assert.equal(r.summary.grossProfit,95);assert.equal(r.summary.grossLoss,42);assert.equal(r.summary.averageWin,95);assert.equal(r.summary.averageLoss,-40);assert.equal(r.summary.tradingCostEvents,1);assert.equal(r.summary.profitFactor,2.26190476);assert.equal(r.consistency.positiveDays,1);assert.equal(r.consistency.negativeDays,2);assert.equal(r.consistency.flatDays,1);assert.equal(r.consistency.bestDayShareOfPositiveProfitPercent,100);assert.equal(r.consistency.profitableDaySharePercent,25);assert.equal(r.monthly[0].netProfit,53);assert.equal(r.monthly[0].cashFlows,800);assert.equal(r.coverage.historyComplete,true);assert.match(r.coverage.closedFillUnit,/partial closes/);assert.equal(r.balanceCurve.kind,'observed_balance');assert.deepEqual(r.balanceCurve.points,[]);
 }finally{f.close();}
});

test('cash-flow-adjusted drawdown removes recorded transfers without calling cash withdrawals trading losses',()=>{
 const f=fixture();try{
  const t=at('2026-01-01');f.data.set(own,historyFixture({deals:[{id:'deposit',time:t+1000,currency:'EUR',classification:'cashflow',cashFlow:100},{id:'withdrawal',time:t+2000,currency:'EUR',classification:'cashflow',cashFlow:-200}],snapshots:[{at:t,balance:1000,equity:1000,currency:'EUR'},{at:t+1000,balance:1100,equity:1100,currency:'EUR'},{at:t+2000,balance:900,equity:900,currency:'EUR'},{at:t+3000,balance:900,equity:850,currency:'EUR'}]}));
  const r=f.reports.client(1,{source:'sponsored',accountId:own});assert.equal(r.summary.netProfit,0);assert.equal(r.summary.cashFlows,-100);assert.equal(r.summary.grossLoss,0);assert.equal(r.drawdown.observedEquity.maxAmount,250);assert.equal(r.drawdown.cashFlowAdjustedEquity.maxAmount,50);assert.equal(r.drawdown.cashFlowAdjustedEquity.maxPercent,5);assert.equal(r.drawdown.realizedBalance.maxAmount,200);assert.equal(r.summary.profitFactorStatus,'no_recorded_profit_or_loss');
 }finally{f.close();}
});

test('reports enforce the signed-in owner before obtaining historical sponsored records',()=>{
 const f=fixture();try{
  f.data.set(own,historyFixture({deals:[deal('private','2026-01-01',100)]}));assert.throws(()=>f.reports.client(2,{source:'sponsored',accountId:own}),e=>e.status===404);assert.equal(f.historyReads(),0);assert.equal(f.reports.client(1,{source:'sponsored',accountId:own}).summary.netProfit,100);assert.equal(f.historyReads(),1);assert.throws(()=>f.reports.client(999),e=>e.status===404);assert.throws(()=>f.reports.client('1 OR 1=1'),e=>e.status===400);assert.throws(()=>f.reports.client(0),e=>e.status===400);
 }finally{f.close();}
});

test('malformed, duplicated, future, mixed-currency and unknown historical records cannot fabricate verified profit',()=>{
 const f=fixture();try{
  f.data.set(own,historyFixture({deals:[deal('real','2026-01-01',10),deal('real','2026-01-01',1000),deal('wrong-currency','2026-01-01',500,{currency:'USD'}),deal('future','2026-01-01',700,{time:time+6000}),deal('nan','2026-01-01',NaN),deal('adjustment','2026-01-01',900,{classification:'adjustment'}),null,deal('unknown-close','2026-01-02',5,{isClosing:undefined,entryType:'UNKNOWN'})],snapshots:[{at:time,currency:'EUR',balance:100,equity:100},{at:time,currency:'USD',balance:999999,equity:999999},null]}));
  const r=f.reports.client(1,{source:'sponsored',accountId:own});assert.equal(r.summary.netProfit,15);assert.equal(r.summary.closedTradeCount,1);assert.equal(r.coverage.historyComplete,false);assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.excludedAdjustments,1);assert.equal(r.coverage.unclassifiedClosingEntries,1);assert.equal(r.equityCurve.points.length,1);assert.ok(r.coverage.skippedRecords>=6);assert.ok(r.coverage.warnings.length>=3);
 }finally{f.close();}
});

test('missing or unverified historical records exposes unavailable coverage and never assumes USD currency',()=>{
 const f=fixture();try{
  let r=f.reports.client(1,{source:'sponsored',accountId:own});assert.equal(r.coverage.status,'unavailable');assert.equal(r.account.currency,null);assert.deepEqual(r.equityCurve.points,[]);
  f.data.set(own,historyFixture({currency:null,deals:[deal('ignored','2026-01-01',100)],history:{historyComplete:false}}));r=f.reports.client(1,{source:'sponsored',accountId:own});assert.equal(r.account.currency,null);assert.equal(r.summary.netProfit,0);assert.equal(r.coverage.status,'partial');assert.equal(r.coverage.historyComplete,false);assert.equal(r.coverage.historical,true);assert.match(r.coverage.warnings.join(' '),/currency has not been verified/);
 }finally{f.close();}
});

test('corrupted or incomplete assessment history produces bounded truthful reports without a manufactured balance curve',()=>{
 const f=fixture();try{
  f.state.history=[closed(1,100,'2026-01-01'),closed(1,900,'2026-01-02'),null,{id:2,profit:'10',closedAt:at('2026-01-01')}];f.state.balance=10100;f.write(f.state);const r=f.reports.client(1);assert.equal(r.summary.netProfit,100);assert.equal(r.summary.closedTradeCount,1);assert.equal(r.coverage.historyComplete,false);assert.equal(r.coverage.status,'partial');assert.equal(r.balanceCurve.kind,'observed_balance');assert.deepEqual(r.balanceCurve.points,[]);
  for(const state of ['{broken',JSON.stringify(null),{...createAccount(time),executionMode:'synthetic'},{...createAccount(time),balance:null}]){f.write(state);assert.equal(f.reports.client(1).coverage.status,'unavailable');}
 }finally{f.close();}
});

test('zero-loss results remain finite JSON and distinguish unbounded profit factor from no recorded activity',()=>{
 const f=fixture();try{
  let r=f.reports.client(1);assert.equal(r.summary.profitFactor,null);assert.equal(r.summary.profitFactorStatus,'no_recorded_profit_or_loss');assert.equal(r.summary.winRate,null);assert.equal(r.consistency.bestDayShareOfPositiveProfitPercent,null);
  f.state.history=[closed(1,100,'2026-01-01'),closed(2,300,'2026-01-02')];f.state.balance=10400;f.write(f.state);r=f.reports.client(1);assert.equal(r.summary.profitFactor,null);assert.equal(r.summary.profitFactorStatus,'no_recorded_losses');assert.equal(r.consistency.bestDayShareOfPositiveProfitPercent,75);assert.equal(r.consistency.largestWinningFillSharePercent,75);assert.doesNotMatch(JSON.stringify(r),/Infinity|NaN/);assert.equal(r.consistency.appliesQualificationRule,false);
 }finally{f.close();}
});

test('fresh installations create no external-history tables or fabricated account curves from manual financial statements',()=>{
 const f=fixture();try{
  f.db.exec('CREATE TABLE sponsored_statements(account_id TEXT,net_profit_cents INTEGER);');
  f.db.prepare('INSERT INTO sponsored_statements VALUES(?,?)').run(own,500000);
  const reports=createPerformanceReports(f.db,{now:()=>time});
  const result=reports.client(1,{source:'sponsored',accountId:own});
  assert.equal(result.coverage.status,'unavailable');assert.equal(result.account.currency,null);
  assert.equal(result.summary.netProfit,0);assert.deepEqual(result.equityCurve.points,[]);assert.deepEqual(result.balanceCurve.points,[]);
  assert.match(result.coverage.warnings.join(' '),/Manual sponsorship and payout records do not establish a trading equity curve/);
  assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table' AND name LIKE 'sponsored_sync_%'").get().n,0);
  assert.equal(f.db.prepare('SELECT net_profit_cents FROM sponsored_statements').get().net_profit_cents,500000);
 }finally{f.close();}
});

test('previously recorded account history remains readable, owner-bound and unchanged after the external connector is removed',()=>{
 const f=fixture();try{
  f.db.exec(`CREATE TABLE sponsored_sync_links(account_id TEXT PRIMARY KEY,currency TEXT,history_from INTEGER,history_through INTEGER,history_complete INTEGER,last_success_at INTEGER,provider_account_id TEXT,active INTEGER);
    CREATE TABLE sponsored_sync_deals(account_id TEXT,id TEXT,time INTEGER,currency TEXT,type TEXT,entry_type TEXT,classification TEXT,net_profit REAL,cash_flow REAL,is_closing INTEGER);
    CREATE TABLE sponsored_sync_snapshots(id TEXT,account_id TEXT,at INTEGER,currency TEXT,balance REAL,equity REAL);`);
  f.db.prepare('INSERT INTO sponsored_sync_links VALUES(?,?,?,?,?,?,?,?)').run(own,'EUR',at('2026-01-01'),time,1,time,'private-retired-binding',1);
  f.db.prepare('INSERT INTO sponsored_sync_deals VALUES(?,?,?,?,?,?,?,?,?,?)').run(own,'retained-close',at('2026-01-12'),'EUR','DEAL_TYPE_BUY','DEAL_ENTRY_OUT','trade',97,null,1);
  f.db.prepare('INSERT INTO sponsored_sync_snapshots VALUES(?,?,?,?,?,?)').run('retained-equity',own,time,'EUR',10097,10110);
  const reports=createPerformanceReports(f.db,{now:()=>time});
  const changes=f.db.prepare('SELECT total_changes() n').get().n;
  assert.throws(()=>reports.client(2,{source:'sponsored',accountId:own}),error=>error.status===404);
  const result=reports.client(1,{source:'sponsored',accountId:own});
  assert.equal(result.summary.netProfit,97);assert.equal(result.account.currency,'EUR');assert.equal(result.summary.closedTradeCount,1);
  assert.equal(result.equityCurve.points[0].equity,10110);assert.equal(result.coverage.historical,true);assert.equal(result.coverage.observedAt,time);
  assert.equal(result.coverage.historyComplete,true);assert.equal(result.coverage.source,'Recorded account history');
  assert.match(result.coverage.warnings.join(' '),/read-only and do not receive automatic updates/);
  assert.doesNotMatch(JSON.stringify(result),/private-retired-binding|providerAccountId|lastSuccessfulSyncAt|"stale"/);
  assert.equal(f.db.prepare('SELECT total_changes() n').get().n,changes);
  assert.equal(f.db.prepare('SELECT provider_account_id FROM sponsored_sync_links').get().provider_account_id,'private-retired-binding');
  assert.equal(f.db.prepare('SELECT count(*) n FROM sponsored_sync_deals').get().n,1);
  assert.equal(f.db.prepare('SELECT count(*) n FROM sponsored_sync_snapshots').get().n,1);
  f.db.exec('UPDATE sponsored_sync_links SET history_complete=2; UPDATE sponsored_sync_deals SET is_closing=2,entry_type=NULL;');
  const uncertain=reports.client(1,{source:'sponsored',accountId:own});
  assert.equal(uncertain.coverage.historyComplete,false);assert.equal(uncertain.coverage.unclassifiedClosingEntries,1);assert.equal(uncertain.summary.closedTradeCount,0);
  assert.equal(f.db.prepare('SELECT is_closing FROM sponsored_sync_deals').get().is_closing,2);
 }finally{f.close();}
});
