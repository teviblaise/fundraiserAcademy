import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createBackend} from '../backend.mjs';
import {createReferenceFixture} from './helpers/reference-fixture.mjs';

async function harness(options={}){
  const folder=await mkdtemp(path.join(tmpdir(),'fa-reference-api-'));
  const database=path.join(folder,'academy.sqlite');
  const reference=createReferenceFixture();
  const backend=createBackend(database,{marketData:reference,autoTick:false,...options});
  const server=http.createServer((req,res)=>backend.handle(req,res,new URL(req.url,'http://localhost').pathname));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  async function request(endpoint,data,cookie){
    const response=await fetch(base+endpoint,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Requested-With':'FundraiserAcademy',...(cookie?{Cookie:cookie}:{})},...(data===undefined?{}:{body:JSON.stringify(data)})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  const user=await request('/api/register',{name:'Reference API Trader',email:'reference-api@example.com',password:'a-long-reference-api-test-password',market:'I trade both',consent:true});
  return {reference,backend,database,request,cookie:user.cookie,userId:user.body.user.id,async close(){await new Promise(resolve=>server.close(resolve));await backend.close();await rm(folder,{recursive:true,force:true});}};
}

test('HTTP fills and P&L use server references; source failures cannot execute and recovery honors stops',async()=>{
  const h=await harness();
  try{
    const {request,cookie,reference}=h;
    const open=await request('/api/trades',{symbol:'BTCUSD',side:'buy',quantity:.01,stopLoss:63500,price:1,balance:999999,source:'Forged browser quote'},cookie);
    assert.equal(open.status,200);assert.equal(open.body.account.positions[0].entry,64000);assert.equal(open.body.account.balance,10000);
    const id=open.body.account.positions[0].id;
    assert.equal(open.body.account.positions[0].entryQuote.price,64000);assert.equal(open.body.account.positions[0].entryQuote.source,'Test-only reference provider');
    assert.ok(open.body.account.positions[0].entryQuote.asOf>0);
    reference.failures.add('BTCUSD');
    const paused=await request('/api/account?symbol=BTCUSD',undefined,cookie);
    assert.equal(paused.status,200);assert.equal(paused.body.account.prices.BTCUSD.mid,64000);assert.equal(paused.body.account.prices.BTCUSD.available,false);
    assert.equal((await request('/api/trades/close',{id},cookie)).status,503);
    assert.equal((await request('/api/trades',{symbol:'BTCUSD',side:'buy',quantity:.01,price:63000},cookie)).status,503);
    assert.equal((await request('/api/trades/protection',{id,stopLoss:63000,takeProfit:null},cookie)).status,503);
    const stillPaused=await request('/api/account?symbol=BTCUSD',undefined,cookie);
    assert.equal(stillPaused.body.account.positions.length,1);assert.equal(stillPaused.body.account.history.length,0);assert.equal(stillPaused.body.account.balance,10000);
    reference.failures.delete('BTCUSD');reference.prices.BTCUSD=63000;
    const recovered=await request('/api/account?symbol=BTCUSD',undefined,cookie);
    assert.equal(recovered.body.account.positions.length,0);assert.equal(recovered.body.account.history[0].reason,'Stop loss');assert.equal(recovered.body.account.history[0].exit,63000);assert.equal(recovered.body.account.history[0].profit,-10);assert.equal(recovered.body.account.balance,9990);
    assert.equal(recovered.body.account.history[0].exitQuote.price,63000);
    const sell=await request('/api/trades',{symbol:'BTCUSD',side:'sell',quantity:.01},cookie);assert.equal(sell.body.account.positions[0].entry,63000);
    reference.prices.BTCUSD=62000;
    const closed=await request('/api/trades/close',{id:sell.body.account.positions[0].id},cookie);assert.equal(closed.body.account.history[0].exit,62000);assert.equal(closed.body.account.history[0].profit,10);assert.equal(closed.body.account.balance,10000);
    assert.ok(reference.calls.every(symbol=>symbol==='BTCUSD'),'opening and closing crypto never fetches idle forex');
  }finally{await h.close();}
});

test('logged-out paper positions continue to receive protective reference-price checks',async()=>{
  const h=await harness({autoTick:true,tickMs:20});let db;
  try{
    const open=await h.request('/api/trades',{symbol:'BTCUSD',side:'buy',quantity:.01,stopLoss:63500},h.cookie);assert.equal(open.status,200);
    assert.equal((await h.request('/api/logout',{},h.cookie)).status,200);
    h.reference.prices.BTCUSD=63000;
    db=new DatabaseSync(h.database);
    let state;const deadline=Date.now()+2000;
    do{state=JSON.parse(db.prepare('SELECT state FROM accounts WHERE user_id=?').get(h.userId).state);if(state.positions.length===0)break;await new Promise(resolve=>setTimeout(resolve,20));}while(Date.now()<deadline);
    assert.equal(state.positions.length,0);assert.equal(state.history[0].reason,'Stop loss');assert.equal(state.history[0].exit,63000);assert.equal(state.balance,9990);
  }finally{db?.close();await h.close();}
});

test('polls and orders serialize behind provider awaits, preventing lost fills',async()=>{
  const h=await harness();
  try{
    const baseGet=h.reference.getExecutionQuote;let release;let started;
    const gate=new Promise(resolve=>release=resolve);const entered=new Promise(resolve=>started=resolve);
    let held=false;
    h.reference.getExecutionQuote=async symbol=>{if(!held){held=true;started();await gate;}return baseGet(symbol);};
    const poll=h.request('/api/account?symbol=BTCUSD',undefined,h.cookie);
    await entered;
    const order1=h.request('/api/trades',{symbol:'BTCUSD',side:'buy',quantity:.01},h.cookie);
    const order2=h.request('/api/trades',{symbol:'BTCUSD',side:'sell',quantity:.01},h.cookie);
    release();
    const responses=await Promise.all([poll,order1,order2]);assert.ok(responses.every(response=>response.status===200));
    const final=await h.request('/api/account?symbol=BTCUSD',undefined,h.cookie);
    assert.equal(final.body.account.positions.length,2);assert.equal(new Set(final.body.account.positions.map(p=>p.id)).size,2);assert.deepEqual(final.body.account.positions.map(p=>p.entry),[64000,64000]);
    const reset=await h.request('/api/account/reset',{},h.cookie);assert.equal(reset.body.account.positions.length,0);
    const after=await h.request('/api/account?symbol=BTCUSD',undefined,h.cookie);assert.equal(after.body.account.positions.length,0);assert.equal(after.body.account.history.length,0);
    const db=new DatabaseSync(h.database);const archive=JSON.parse(db.prepare("SELECT detail FROM events WHERE user_id=? AND kind='reset-archive' ORDER BY id DESC LIMIT 1").get(h.userId).detail);assert.equal(archive.positions.length,2);db.close();
  }finally{await h.close();}
});

test('old attempts stay frozen until explicit reset and retain their complete audit snapshot',async()=>{
  const h=await harness();let db;
  try{
    db=new DatabaseSync(h.database);
    const previous=JSON.parse(db.prepare('SELECT state FROM accounts WHERE user_id=?').get(h.userId).state);
    previous.version=1;delete previous.executionMode;previous.balance=10125;
    previous.positions=[{id:1,symbol:'BTCUSD',side:'buy',quantity:.01,entry:60000,stopLoss:null,takeProfit:null,openedAt:Date.now()}];
    previous.prices.BTCUSD={mid:61000,previous:60500,history:[60500,61000]};
    previous.tradingDays=['2026-10-10'];
    db.prepare('UPDATE accounts SET state=? WHERE user_id=?').run(JSON.stringify(previous),h.userId);
    h.reference.prices.BTCUSD=120000;
    const legacy=await h.request('/api/account?symbol=BTCUSD',undefined,h.cookie);
    assert.equal(legacy.body.account.migrationRequired,true);assert.equal(legacy.body.account.balance,10125);assert.equal(legacy.body.account.positions[0].entry,60000);assert.equal(legacy.body.account.prices.BTCUSD.mid,61000);assert.deepEqual(h.reference.calls,[]);
    assert.equal((await h.request('/api/trades/close',{id:1},h.cookie)).status,409);
    const reset=await h.request('/api/account/reset',{},h.cookie);assert.equal(reset.body.account.executionMode,'reference');assert.equal(reset.body.account.balance,10000);assert.equal(reset.body.account.positions.length,0);
    const archive=JSON.parse(db.prepare("SELECT detail FROM events WHERE user_id=? AND kind='reset-archive' ORDER BY id DESC LIMIT 1").get(h.userId).detail);
    assert.equal(archive.balance,previous.balance);assert.deepEqual(archive.positions,previous.positions);assert.deepEqual(archive.prices.BTCUSD,previous.prices.BTCUSD);
    const fresh=await h.request('/api/account?symbol=BTCUSD',undefined,h.cookie);assert.equal(fresh.body.account.prices.BTCUSD.mid,120000);assert.equal(fresh.body.account.balance,10000);
  }finally{db?.close();await h.close();}
});
