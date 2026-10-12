import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackend } from '../backend.mjs';
import {DatabaseSync} from 'node:sqlite';
import {createReferenceFixture} from './helpers/reference-fixture.mjs';

test('backend registration, authentication, isolated trading records, reset audit, and persistence', async () => {
  const folder = await mkdtemp(path.join(tmpdir(),'fa-api-'));
  const database = path.join(folder,'test.sqlite');
  const reference=createReferenceFixture();
  const options={marketData:reference,autoTick:false};
  let backend = createBackend(database,options);
  const server = http.createServer((req,res) => backend.handle(req,res,new URL(req.url,'http://localhost').pathname));
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  async function request(endpoint,data,cookie,extra={}) {
    const response = await fetch(origin+endpoint,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Requested-With':'FundraiserAcademy',...(cookie?{Cookie:cookie}:{}),...extra},...(data===undefined?{}:{body:JSON.stringify(data)})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],header:response.headers.get('set-cookie')};
  }
  const registration = {name:'Trader One',email:'one@example.com',password:'a-long-unique-test-password',market:'I trade forex',consent:true};
  try {
    assert.equal((await request('/api/account')).status,401);
    assert.equal((await request('/api/market-reference?symbol=BTCUSD')).status,401);
    assert.equal((await request('/api/register',{...registration,password:'short'})).status,400);
    assert.equal((await request('/api/register',registration,undefined,{Origin:'https://other.example'})).status,403);
    const first=await request('/api/register',registration);
    assert.equal(first.status,201); assert.match(first.header,/HttpOnly/); assert.match(first.header,/SameSite=Lax/); assert.ok(!('password' in first.body.user));
    assert.equal((await request('/api/market-reference?symbol=UNSUPPORTED',undefined,first.cookie)).status,400);
    assert.equal((await request('/api/market-reference?symbol=BTCUSD&interval=invalid',undefined,first.cookie)).status,400);
    const second=await request('/api/register',{...registration,email:'two@example.com',name:'Trader Two'});
    assert.equal(second.status,201);
    assert.equal((await request('/api/register',registration)).status,409);
    assert.equal((await request('/api/login',{email:registration.email,password:'a-different-long-password'})).status,401);
    assert.equal((await request('/api/me',undefined,first.cookie)).body.user.name,'Trader One');
    const order=await request('/api/trades',{symbol:'EURUSD',side:'buy',quantity:1000,balance:999999},first.cookie);
    assert.equal(order.status,200); assert.equal(order.body.account.balance,10000); assert.equal(order.body.account.positions.length,1);
    assert.equal((await request('/api/account',undefined,second.cookie)).body.account.positions.length,0);
    assert.equal((await request('/api/trades/close',{id:order.body.account.positions[0].id},second.cookie)).status,400);
    assert.equal((await request('/api/trades/protection',{id:order.body.account.positions[0].id,stopLoss:1,takeProfit:2},second.cookie)).status,400);
    assert.equal((await request('/api/trades/protection',{id:order.body.account.positions[0].id,stopLoss:1,takeProfit:2},first.cookie)).status,200);
    const closed=await request('/api/trades/close',{id:order.body.account.positions[0].id},first.cookie);
    assert.equal(closed.status,200); assert.equal(closed.body.account.history.length,1);
    assert.equal((await request('/api/limits',{dailyLoss:501},first.cookie)).status,400);
    assert.equal((await request('/api/limits',{dailyLoss:100,maxRisk:10,maxPositions:2},first.cookie)).status,200);
    const pending=await request('/api/orders',{symbol:'EURUSD',side:'buy',quantity:1000,limitPrice:1.05,stopLoss:1.049},first.cookie);
    assert.equal(pending.status,200);assert.equal(pending.body.account.pending.length,1);
    assert.equal((await request('/api/orders/cancel',{id:pending.body.account.pending[0].id},second.cookie)).status,400);
    assert.equal((await request('/api/orders/cancel',{id:pending.body.account.pending[0].id},first.cookie)).status,200);
    const alert=await request('/api/alerts',{symbol:'BTCUSD',direction:'above',target:100000},first.cookie);
    assert.equal(alert.status,200);assert.equal(alert.body.account.alerts.length,1);
    assert.equal((await request('/api/alerts/remove',{id:alert.body.account.alerts[0].id},second.cookie)).status,400);
    const read=await request('/api/notifications/read',{},first.cookie);
    assert.ok(read.body.account.notifications.length>0);assert.ok(read.body.account.notifications.every(n=>n.read));
    assert.equal((await request('/api/account',undefined,second.cookie)).body.account.notifications.length,0);
    await backend.close(); backend=createBackend(database,options);
    assert.equal((await request('/api/account',undefined,first.cookie)).body.account.history.length,1);
    assert.equal((await request('/api/account',undefined,first.cookie)).body.account.limits.dailyLoss,100);
    assert.equal((await request('/api/account',undefined,first.cookie)).body.account.alerts.length,1);
    assert.equal((await request('/api/journal',undefined,first.cookie)).body.account.history.length,1);
    const reset=await request('/api/account/reset',{},first.cookie);
    assert.equal(reset.body.account.balance,10000); assert.equal(reset.body.account.history.length,0);
    assert.equal((await request('/api/logout',{},first.cookie)).status,200);
    assert.equal((await request('/api/account',undefined,first.cookie)).status,401);
    const login=await request('/api/login',{email:registration.email,password:registration.password});
    assert.equal(login.status,200); assert.equal((await request('/api/account',undefined,login.cookie)).status,200);
    assert.equal((await request('/api/certificates',undefined,login.cookie)).body.certificates.length,0);
    assert.equal((await request('/api/certificate-preferences',{mode:'nickname',nickname:''},login.cookie)).status,400);
    const nickname=await request('/api/certificate-preferences',{mode:'nickname',nickname:'Alpha Trader'},login.cookie);
    assert.equal(nickname.body.displayName,'Alpha Trader');
    assert.equal((await request('/api/certificate-preferences',undefined,second.cookie)).body.mode,'name');
    // Seed a completed simulator attempt directly in this temporary test database.
    // The public API never accepts client balances or certificate issuance requests.
    const fixtureDb=new DatabaseSync(database);
    const row=fixtureDb.prepare('SELECT state FROM accounts WHERE user_id=?').get(first.body.user.id);
    const passed=JSON.parse(row.state);passed.balance=11000;passed.locked='Profit target achieved';passed.positions=[];passed.tradingDays=['2026-10-09','2026-10-10','2026-10-11'];
    fixtureDb.prepare('UPDATE accounts SET state=? WHERE user_id=?').run(JSON.stringify(passed),first.body.user.id);fixtureDb.close();
    await backend.close();backend=createBackend(database,options);
    const earned=(await request('/api/certificates',undefined,login.cookie)).body.certificates;
    assert.equal(earned.length,1);assert.equal(earned[0].holder,'Alpha Trader');assert.equal(earned[0].tradingDays,3);assert.equal(earned[0].priceMode,'reference');
    assert.equal((await request(`/api/certificates/${earned[0].id}`,undefined,second.cookie)).status,404);
    const svgResponse=await fetch(`${origin}/api/certificates/${earned[0].id}.svg`,{headers:{Cookie:login.cookie}});
    assert.equal(svgResponse.status,200);assert.ok((await svgResponse.text()).includes('Certificate of Completion'));
    await request('/api/certificate-preferences',{mode:'name',nickname:'Alpha Trader',applyExisting:true},login.cookie);
    const renamed=(await request('/api/certificates',undefined,login.cookie)).body.certificates[0];
    assert.equal(renamed.holder,'Trader One');assert.equal(renamed.id,earned[0].id);assert.equal(renamed.issuedAt,earned[0].issuedAt);assert.equal(renamed.finalBalance,earned[0].finalBalance);
    await backend.close();backend=createBackend(database,options);
    assert.equal((await request('/api/certificates',undefined,login.cookie)).body.certificates.length,1);
    await request('/api/account/reset',{},login.cookie);
    assert.equal((await request('/api/certificates',undefined,login.cookie)).body.certificates.length,1);
  } finally {
    await new Promise(resolve=>server.close(resolve)); await backend.close(); await rm(folder,{recursive:true,force:true});
  }
});
