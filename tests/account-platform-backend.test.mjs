import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createBackend} from '../backend.mjs';
import {createCertificates} from '../certificates.mjs';
import {createAccount} from '../public/simulator.js';
import {generateTotpCode} from '../two-factor.mjs';
import {createReferenceFixture} from './helpers/reference-fixture.mjs';
import {testDeliveryOptions,confirmRegistration} from './helpers/email-fixture.mjs';

const password='An isolated account platform passphrase';
const reason='Verified through the isolated account-platform workflow.';
const digest=value=>createHash('sha256').update(value).digest('hex');
const deferred=()=>{let resolve;const promise=new Promise(done=>{resolve=done;});return{promise,resolve};};

async function fixture(options={}){
 const folder=await mkdtemp(path.join(tmpdir(),'fa-platform-http-')),database=path.join(folder,'academy.sqlite');
 let time=Date.now();const references=options.marketData??createReferenceFixture({now:()=>time});
 const provider=options.provider??{async fetch(_id,query){return{accountInformation:{currency:'EUR',balance:11097,equity:11110},deals:[{id:'closing-fill',type:'DEAL_TYPE_BUY',entryType:'DEAL_ENTRY_OUT',profit:100,commission:-2,swap:-1,fee:0,time:query.to-1000},{id:'capital-deposit',type:'DEAL_TYPE_BALANCE',profit:1000,time:query.to-500}],complete:true,nextOffset:query.offset+2};},async close(){}};
 const backend=createBackend(database,{now:()=>time,autoTick:false,adminOptions:{ownerEmails:'owner@example.com'},marketData:references,deliveryOptions:{...testDeliveryOptions,now:()=>time},supportOptions:{staffEmails:'',aiOptions:{apiKey:''}},platformOptions:{sponsored:{provider,syncTimeoutMs:10000},operations:{autoStart:false,backupDirectory:path.join(folder,'backups')}}});
 const server=http.createServer((req,res)=>backend.handle(req,res,new URL(req.url,'http://localhost').pathname));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin=`http://127.0.0.1:${server.address().port}`;
 const app={folder,database,origin,backend,references,time:()=>time,advance(ms){time+=ms;},
  inspect(work){const db=new DatabaseSync(database);try{return work(db);}finally{db.close();}},
  async request(endpoint,data,cookie,extraHeaders={}){const response=await fetch(origin+endpoint,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Requested-With':'FundraiserAcademy',...(cookie?{Cookie:cookie}:{}),...extraHeaders},...(data===undefined?{}:{body:JSON.stringify(data)})});return{status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0],headers:response.headers};},
  async register(email,{confirmed=true,factor=false}={}){const registration=await app.request('/api/register',{firstName:email.startsWith('owner')?'Owner':'Trader',otherNames:'Fixture',email,password,market:'I trade both',consent:true});assert.equal(registration.status,201,JSON.stringify(registration.body));if(confirmed)await confirmRegistration(database,app.request,registration);const actor={id:registration.body.user.id,email,cookie:registration.cookie,recoveryCodes:[]};if(factor){const setup=await app.request('/api/security/2fa/setup',{password},actor.cookie);assert.equal(setup.status,200,JSON.stringify(setup.body));const enabled=await app.request('/api/security/2fa/confirm',{password,code:generateTotpCode(setup.body.secret,{time})},actor.cookie);assert.equal(enabled.status,200,JSON.stringify(enabled.body));Object.assign(actor,{cookie:enabled.cookie,secret:setup.body.secret,recoveryCodes:[...enabled.body.recoveryCodes]});}return actor;},
  async authorize(actor,purpose){if(actor.secret)app.advance(31000);const response=await app.request('/api/account/authorize',{purpose,password,...(actor.secret?{code:generateTotpCode(actor.secret,{time})}:{})},actor.cookie);assert.equal(response.status,200,JSON.stringify(response.body));return response;},
  async unlock(actor){app.advance(31000);const response=await app.request('/api/admin/reauth',{password,code:generateTotpCode(actor.secret,{time})},actor.cookie);assert.equal(response.status,200,JSON.stringify(response.body));return response;},
  async login(actor,newPassword=password){const response=await app.request('/api/login',{email:actor.email,password:newPassword});if(response.status!==202)return response;return app.request('/api/login/2fa',{challenge:response.body.challenge,code:actor.recoveryCodes.shift()});},
  async sponsor(owner,trader){await app.unlock(owner);const published=await app.request('/api/admin/contracts',{contentBase64:Buffer.from('Only an isolated test agreement, never public program terms.').toString('base64'),format:'text',version:'platform-fixture-v1',title:'Isolated platform agreement',fileName:'fixture.txt',reason},owner.cookie);assert.equal(published.status,200,JSON.stringify(published.body));const document=published.body.contract;
   app.inspect(db=>{const state=createAccount(time);state.balance=11000;state.locked='Profit target achieved';state.tradingDays=['2026-10-01','2026-10-02','2026-10-03'];createCertificates(db).issue(trader.id,state,time);db.prepare('UPDATE accounts SET state=? WHERE user_id=?').run(JSON.stringify(state),trader.id);});
   const signed=await app.request('/api/contract/sign',{contractId:document.id,contractVersion:document.version,contractHash:document.hash,legalName:'Trader Legal Fixture',consent:true},trader.cookie);assert.equal(signed.status,200,JSON.stringify(signed.body));
   const review=await app.request(`/api/admin/reviews/${trader.id}`,undefined,owner.cookie);assert.equal(review.status,200);const approved=await app.request(`/api/admin/reviews/${trader.id}`,{status:'approved',expectedRevision:review.body.revision,expectedContractId:review.body.contractId,expectedCertificateId:review.body.certificateId,reason,clientMessage:'Your isolated review is approved.'},owner.cookie);assert.equal(approved.status,200,JSON.stringify(approved.body));
   const created=await app.request('/api/admin/accounts',{userId:trader.id,firmName:'Isolated provider',label:'Isolated sponsored allocation',accountSizeCents:1000000,traderShareBps:7000,profitSharingPolicy:'cumulative_high_water',evidence:'Private fixture evidence, not customer-facing.',reason},owner.cookie);assert.equal(created.status,200,JSON.stringify(created.body));return created.body.account;},
  resetToken(id){return app.inspect(db=>{const row=db.prepare("SELECT payload FROM notification_outbox WHERE channel='password-reset' AND user_id=? ORDER BY id DESC LIMIT 1").get(id);return /#token=([a-f0-9]{64})/.exec(JSON.parse(row?.payload??'{}').text??'')?.[1];});},
  async close(){await new Promise(resolve=>server.close(resolve));await backend.close();await rm(folder,{recursive:true,force:true});}
 };return app;
}

test('account privileges require password plus fresh factor, remain purpose/session bound, and expire without exposing proof',async()=>{
 const app=await fixture();try{
  assert.equal((await app.request('/api/account/status')).status,401);const trader=await app.register('trader@example.com',{factor:true});
  assert.equal((await app.request('/api/account/export',{},trader.cookie)).body.code,'ACCOUNT_REAUTH_REQUIRED');assert.equal((await app.request('/api/account/authorize',{purpose:'all',password},trader.cookie)).status,400);
  const consumed=await app.request('/api/account/authorize',{purpose:'export',password,code:generateTotpCode(trader.secret,{time:app.time()})},trader.cookie);assert.equal(consumed.status,400);
  assert.equal((await app.request('/api/account/authorize',{purpose:'export',password:'incorrect long password',code:trader.recoveryCodes[0]},trader.cookie)).status,401);
  const authorized=await app.authorize(trader,'export');assert.deepEqual(Object.keys(authorized.body).sort(),['expiresAt','purpose']);assert.equal(authorized.body.expiresAt,app.time()+300000);assert.equal(authorized.headers.get('cache-control'),'no-store');assert.equal(authorized.cookie,undefined);
  const exported=await app.request('/api/account/export',{},trader.cookie);assert.equal(exported.status,200);assert.equal((await app.request('/api/account/delete',{confirmation:'DELETE MY ACCOUNT'},trader.cookie)).body.code,'ACCOUNT_REAUTH_REQUIRED');
  const another=await app.login(trader);assert.equal(another.status,200);assert.equal((await app.request('/api/account/export',{},another.cookie)).body.code,'ACCOUNT_REAUTH_REQUIRED');
  app.inspect(db=>{const row=db.prepare('SELECT * FROM account_tool_privileges').get();assert.equal(row.token,digest(trader.cookie.slice('fa_session='.length)));assert.match(row.fingerprint,/^[a-f0-9]{64}$/);assert.doesNotMatch(JSON.stringify(row),new RegExp(password+'|'+trader.secret));});
  app.advance(300000);assert.equal((await app.request('/api/account/export',{},trader.cookie)).body.code,'ACCOUNT_REAUTH_REQUIRED');assert.equal((await app.request('/api/account/status',undefined,trader.cookie)).status,200);
 }finally{await app.close();}
});

test('personal exports page every own dataset and exclude other customers, internal notes, and authentication material',async()=>{
 const app=await fixture();try{
  const trader=await app.register('trader@example.com'),other=await app.register('other@example.com');
  app.inspect(db=>{for(let n=0;n<4;n++)db.prepare('INSERT INTO events(user_id,kind,detail,created_at) VALUES(?,?,?,?)').run(trader.id,'owned-fixture',JSON.stringify({index:n,apiToken:'do-not-export-provider-token',market:'EURUSD'}),app.time()+n);db.prepare('INSERT INTO events(user_id,kind,detail,created_at) VALUES(?,?,?,?)').run(other.id,'other-private',JSON.stringify({name:'Another customer private record'}),app.time());db.prepare('INSERT INTO admin_notes(id,user_id,actor_user_id,text,created_at) VALUES(?,?,?,?,?)').run(randomUUID(),trader.id,other.id,'Internal note must never be exported',app.time());});
  await app.authorize(trader,'export');let offset=0,events=[];let first;
  for(let n=0;n<10;n++){const page=await app.request('/api/account/export',{offset,limit:2,...(first?{fingerprint:first.fingerprint}:{})},trader.cookie);assert.equal(page.status,200,JSON.stringify(page.body));first??=page.body;assert.match(page.body.fingerprint,/^[a-f0-9]{64}$/);assert.equal(page.body.fingerprint,first.fingerprint);events.push(...page.body.sections.events.items);assert.doesNotMatch(JSON.stringify(page.body),/other@example|Another customer private|Internal note|do-not-export-provider-token|password_hash|fa_session|encryptedSecret/);assert.equal(page.body.profile.email,trader.email);if(page.body.nextOffset===null){assert.equal(page.body.complete,true);break;}assert.equal(page.body.complete,false);offset=page.body.nextOffset;}
  assert.equal(events.filter(event=>event.kind==='owned-fixture').length,4);assert.ok(events.length>=5);assert.equal(first.sections.events.limit,2);assert.equal((await app.request('/api/account/export',{limit:1001},trader.cookie)).status,400);assert.equal((await app.request('/api/account/authorize',{purpose:'export',password},trader.cookie,{Origin:'https://untrusted.example'})).status,403);
  app.inspect(db=>db.prepare('INSERT INTO events(user_id,kind,detail,created_at) VALUES(?,?,?,?)').run(other.id,'unrelated-update','{}',app.time()));
  assert.equal((await app.request('/api/account/export',{offset:2,limit:2,fingerprint:first.fingerprint},trader.cookie)).status,200,'another customer cannot invalidate this customer’s export');
  app.inspect(db=>db.prepare('UPDATE events SET detail=? WHERE user_id=? AND kind=?').run(JSON.stringify({index:99,market:'GBPUSD'}),trader.id,'owned-fixture'));
  const changed=await app.request('/api/account/export',{offset:2,limit:2,fingerprint:first.fingerprint},trader.cookie);assert.equal(changed.status,409);assert.equal(changed.body.code,'ACCOUNT_EXPORT_CHANGED');
  const restarted=await app.request('/api/account/export',{offset:0,limit:2},trader.cookie);assert.equal(restarted.status,200);assert.notEqual(restarted.body.fingerprint,first.fingerprint);
 }finally{await app.close();}
});

test('completed account deletion removes operational personal data, clears every session and token, and returns an honest receipt',async()=>{
 const app=await fixture();try{
  const trader=await app.register('trader@example.com',{factor:true});const second=await app.login(trader);assert.equal(second.status,200);
  await app.request('/api/password/forgot',{email:trader.email});const resetToken=app.resetToken(trader.id);assert.match(resetToken,/^[a-f0-9]{64}$/);
  await app.authorize(trader,'delete');assert.equal((await app.request('/api/account/delete',{confirmation:'delete'},trader.cookie)).status,400);
  const deleted=await app.request('/api/account/delete',{confirmation:'DELETE MY ACCOUNT'},trader.cookie);assert.equal(deleted.status,200,JSON.stringify(deleted.body));assert.equal(deleted.body.status,'deleted');assert.equal(deleted.body.accountDeleted,true);assert.equal(deleted.body.signedOut,true);assert.equal(deleted.cookie,'fa_session=');assert.ok(Array.isArray(deleted.body.retained));assert.ok(deleted.body.retained.some(item=>item.category==='administration_records'&&item.recordCount>=2),'the receipt lists the deletion audit records that remain');assert.ok(deleted.body.retained.every(item=>typeof item.category==='string'&&typeof item.label==='string'&&Number.isSafeInteger(item.recordCount)&&item.recordCount>0));assert.equal(typeof deleted.body.retentionNotice,'string');assert.ok(deleted.body.retentionNotice.length>0);
  assert.equal((await app.request('/api/me',undefined,trader.cookie)).status,401);assert.equal((await app.request('/api/me',undefined,second.cookie)).status,401);assert.equal((await app.request('/api/login',{email:trader.email,password})).status,401);assert.notEqual((await app.request('/api/password/reset',{token:resetToken,password:'A replacement isolated test passphrase'})).status,200);
  app.inspect(db=>{const user=db.prepare('SELECT * FROM users WHERE id=?').get(trader.id);assert.equal(user.name,'Deleted account');assert.notEqual(user.email,trader.email);for(const table of ['sessions','accounts','two_factor','password_resets','email_verifications','notification_outbox','notification_preferences','performance_assessment_snapshots'])assert.equal(db.prepare(`SELECT count(*) n FROM ${table} WHERE user_id=?`).get(trader.id).n,0,table);assert.equal(db.prepare('SELECT status FROM account_deletions WHERE user_id=?').get(trader.id).status,'deleted');assert.ok(db.prepare('SELECT count(*) n FROM admin_audit WHERE actor_user_id=?').get(trader.id).n>=2);});
 }finally{await app.close();}
});

test('owner and financial obligations keep deletion pending and signed in until an authorized closure review completes',async()=>{
 const app=await fixture();try{
  const owner=await app.register('owner@example.com',{factor:true}),trader=await app.register('trader@example.com');const account=await app.sponsor(owner,trader);
  await app.authorize(owner,'delete');const ownerPending=await app.request('/api/account/delete',{confirmation:'DELETE MY ACCOUNT'},owner.cookie);assert.equal(ownerPending.body.status,'pending_closure');assert.equal(ownerPending.body.signedOut,false);assert.ok(ownerPending.body.blockers.some(x=>x.code==='STAFF_ACCESS_ASSIGNED'));assert.equal((await app.request('/api/admin/overview',undefined,owner.cookie)).status,200);
  await app.authorize(trader,'delete');const pending=await app.request('/api/account/delete',{confirmation:'DELETE MY ACCOUNT'},trader.cookie);assert.equal(pending.body.status,'pending_closure');assert.equal(pending.body.signedOut,false);assert.ok(pending.body.blockers.some(x=>x.code==='SPONSORED_ACCOUNT_OPEN'));assert.equal((await app.request('/api/payouts',undefined,trader.cookie)).status,200);assert.equal((await app.request('/api/me',undefined,trader.cookie)).status,200);
  assert.equal((await app.request('/api/admin/privacy',undefined,trader.cookie)).status,403);assert.ok((await app.request('/api/admin/privacy',undefined,owner.cookie)).body.items.some(x=>x.userId===trader.id));
  assert.equal((await app.request(`/api/admin/accounts/${account.id}`,{status:'closed',revision:account.revision,reason},owner.cookie)).status,200);
  const completed=await app.request(`/api/admin/privacy/${trader.id}/complete`,{reason},owner.cookie);assert.equal(completed.status,200,JSON.stringify(completed.body));assert.equal(completed.body.status,'deleted');assert.ok(completed.body.retained.some(x=>x.category==='signed_agreements'));assert.ok(completed.body.retained.some(x=>x.category==='financial_records'));assert.equal((await app.request('/api/me',undefined,trader.cookie)).status,401);
 }finally{await app.close();}
});

test('trader payout requests reserve exact owned earnings once and expose approval/payment history without payment execution',async()=>{
 const app=await fixture();try{
  const owner=await app.register('owner@example.com',{factor:true}),trader=await app.register('trader@example.com'),other=await app.register('other@example.com');const account=await app.sponsor(owner,trader);
  const statement=await app.request(`/api/admin/accounts/${account.id}/statements`,{netProfitCents:100000,externalReference:'platform-statement-001',evidence:'External statement verified in fixture',reason},owner.cookie);assert.equal(statement.status,200,JSON.stringify(statement.body));assert.equal(statement.body.account.availableCents,70000);
  const payload={accountId:account.id,amountCents:25000,idempotencyKey:randomUUID()};assert.equal((await app.request('/api/payouts/request',payload,trader.cookie)).body.code,'ACCOUNT_REAUTH_REQUIRED');await app.authorize(trader,'payout');
  const created=await app.request('/api/payouts/request',payload,trader.cookie);assert.equal(created.status,200,JSON.stringify(created.body));assert.equal(created.body.reused,false);assert.equal(created.body.account.availableCents,45000);assert.equal(created.body.payout.requestOrigin,'trader');assert.equal(created.body.payout.transfersMoney,false);
  const repeated=await app.request('/api/payouts/request',payload,trader.cookie);assert.equal(repeated.body.reused,true);assert.equal(repeated.body.payout.id,created.body.payout.id);assert.equal(repeated.body.account.reservedCents,25000);assert.equal((await app.request('/api/payouts/request',{...payload,amountCents:25001},trader.cookie)).status,409);
  await app.authorize(other,'payout');assert.equal((await app.request('/api/payouts/request',{...payload,idempotencyKey:randomUUID()},other.cookie)).status,404);
  const payout=created.body.payout;const approved=await app.request(`/api/admin/payouts/${payout.id}`,{status:'approved',revision:payout.revision,reason},owner.cookie);assert.equal(approved.status,200);const paid=await app.request(`/api/admin/payouts/${payout.id}`,{status:'paid',revision:approved.body.payout.revision,externalPaymentReference:'external-fixture-transfer-001',reason},owner.cookie);assert.equal(paid.status,200,JSON.stringify(paid.body));
  const history=await app.request('/api/payouts',undefined,trader.cookie);assert.equal(history.body.payouts.length,1);assert.deepEqual(history.body.payouts[0].history.map(x=>x.status),['requested','approved','paid']);assert.equal(history.body.accounts[0].paidCents,25000);assert.equal(history.body.transfersMoney,false);assert.doesNotMatch(JSON.stringify(history.body),/external-fixture-transfer|Private fixture evidence|actorId|actorName/);assert.equal((await app.request('/api/payouts',undefined,other.cookie)).body.payouts.length,0);
 }finally{await app.close();}
});

test('performance HTTP reports capture actual assessment samples and never allow a user filter to select somebody else',async()=>{
 const app=await fixture();try{
  const trader=await app.register('trader@example.com');let report=await app.request('/api/performance',undefined,trader.cookie);assert.equal(report.status,200);assert.equal(report.body.account.currency,'USD');assert.equal(report.body.summary.closedTradeCount,0);
  const account=await app.request('/api/account?symbol=EURUSD',undefined,trader.cookie);assert.equal(account.status,200);report=await app.request('/api/performance',undefined,trader.cookie);assert.equal(report.status,200);assert.ok(report.body.equityCurve.points.length>=1);assert.ok(report.body.equityCurve.points.every(x=>x.equity===10000));assert.equal(report.body.equityCurve.kind,'observed_equity');assert.equal(report.body.consistency.appliesQualificationRule,false);assert.equal((await app.request('/api/performance?userId=999',undefined,trader.cookie)).status,400);assert.equal((await app.request('/api/performance?from=2026-02-30',undefined,trader.cookie)).status,400);
 }finally{await app.close();}
});

test('MetaApi assignment and read-only sync preserve native currency, hide provider IDs from clients and do not credit payout earnings',async()=>{
 const app=await fixture();try{
  const owner=await app.register('owner@example.com',{factor:true}),trader=await app.register('trader@example.com'),other=await app.register('other@example.com');const account=await app.sponsor(owner,trader);
  const linked=await app.request(`/api/admin/connections/${account.id}/link`,{providerAccountId:'metaapi-isolated-account-123',historyFrom:'2026-10-01',reason,expectedRevision:0},owner.cookie);assert.equal(linked.status,200,JSON.stringify(linked.body));assert.equal(linked.body.status,'awaiting_sync');
  const synced=await app.request(`/api/admin/connections/${account.id}/sync`,{},owner.cookie);assert.equal(synced.status,200,JSON.stringify(synced.body));assert.equal(synced.body.currency,'EUR');assert.equal(synced.body.dealCount,2);assert.equal(synced.body.controlsTrades,false);assert.equal(synced.body.transfersMoney,false);
  const client=await app.request('/api/sponsored-accounts',undefined,trader.cookie);assert.equal(client.status,200);assert.equal(client.body.connections.accounts[0].currency,'EUR');assert.doesNotMatch(JSON.stringify(client.body),/metaapi-isolated-account-123|providerAccountId|apiToken/);assert.equal(client.body.funding.accounts[0].availableCents,0);
  const report=await app.request(`/api/performance?source=sponsored&accountId=${account.id}`,undefined,trader.cookie);assert.equal(report.status,200,JSON.stringify(report.body));assert.equal(report.body.account.currency,'EUR');assert.equal(report.body.summary.netProfit,97);assert.equal(report.body.summary.cashFlows,1000);assert.equal(report.body.summary.closedTradeCount,1);assert.equal(report.body.equityCurve.points.length,1);assert.equal((await app.request(`/api/performance?source=sponsored&accountId=${account.id}`,undefined,other.cookie)).status,404);assert.equal((await app.request('/api/admin/connections',undefined,trader.cookie)).status,403);
  const administrative=await app.request(`/api/admin/performance?userId=${trader.id}&source=sponsored&accountId=${account.id}`,undefined,owner.cookie);assert.equal(administrative.status,200);assert.equal(administrative.body.summary.netProfit,97);
 }finally{await app.close();}
});

test('a MetaApi response cannot commit observations after the operator authorization expires while awaiting the provider',async()=>{
 const began=deferred(),release=deferred();const app=await fixture({provider:{async fetch(_id,query){began.resolve();await release.promise;return{accountInformation:{currency:'USD',balance:10000,equity:10001},deals:[],complete:true,nextOffset:query.offset};},async close(){release.resolve();}}});
 try{
  const owner=await app.register('owner@example.com',{factor:true}),trader=await app.register('trader@example.com');const account=await app.sponsor(owner,trader);assert.equal((await app.request(`/api/admin/connections/${account.id}/link`,{providerAccountId:'metaapi-isolated-await-123',historyFrom:'2026-10-01',reason},owner.cookie)).status,200);
  const syncing=app.request(`/api/admin/connections/${account.id}/sync`,{},owner.cookie);await began.promise;app.advance(300001);release.resolve();const result=await syncing;assert.equal(result.status,403);assert.equal(result.body.code,'ADMIN_REAUTH_REQUIRED');app.inspect(db=>{assert.equal(db.prepare('SELECT count(*) n FROM sponsored_sync_snapshots').get().n,0);assert.equal(db.prepare('SELECT count(*) n FROM sponsored_sync_deals').get().n,0);});
 }finally{release.resolve();await app.close();}
});

test('operational backup/recovery routes require owner authorization, verify isolated restore copies and preserve production sessions',async()=>{
 const app=await fixture();try{
  const owner=await app.register('owner@example.com',{factor:true}),trader=await app.register('trader@example.com');assert.equal((await app.request('/api/admin/operations',undefined,trader.cookie)).status,403);assert.equal((await app.request('/api/admin/operations/backup',{reason},owner.cookie)).body.code,'ADMIN_REAUTH_REQUIRED');await app.unlock(owner);
  app.backend.capture(Object.assign(new Error('private-password api_key=private-provider-value'),{code:'SQLITE_BUSY'}),{route:'/api/users/private@example.com?token=private-token',method:'POST',status:500});const errors=await app.request('/api/admin/errors',undefined,owner.cookie);assert.equal(errors.status,200);assert.equal(errors.body.items.length,1);assert.equal(errors.body.items[0].code,'SQLITE_BUSY');assert.doesNotMatch(JSON.stringify(errors.body),/private-password|private-provider-value|private@example|private-token/);
  const backup=await app.request('/api/admin/operations/backup',{reason},owner.cookie);assert.equal(backup.status,200,JSON.stringify(backup.body));assert.equal(backup.body.encrypted,true);assert.equal(backup.body.verified,true);assert.equal(backup.body.recovery.productionModified,false);assert.equal(backup.body.recovery.oldSessionsRevoked,true);assert.equal(backup.body.recovery.recoveryCodesRevoked,true);
  const verified=await app.request('/api/admin/operations/check',{backupId:backup.body.backupId,reason},owner.cookie);assert.equal(verified.status,200,JSON.stringify(verified.body));assert.equal(verified.body.integrity,'ok');assert.equal(verified.body.productionModified,false);assert.equal((await app.request('/api/me',undefined,owner.cookie)).status,200);assert.equal((await app.request('/api/me',undefined,trader.cookie)).status,200);
  const status=await app.request('/api/admin/operations',undefined,owner.cookie);assert.equal(status.body.backups.length,1);assert.equal(status.body.offsiteConfigured,false);assert.equal(status.body.persistentStorageRequired,true);assert.doesNotMatch(JSON.stringify(status.body),new RegExp(password+'|'+owner.secret));
 }finally{await app.close();}
});

test('a restored-account recovery flag blocks sign-in until a real password reset clears it and preserves the enrolled authenticator',async()=>{
 const app=await fixture();try{
  const trader=await app.register('trader@example.com',{factor:true});app.inspect(db=>db.prepare('UPDATE users SET recovery_required=1 WHERE id=?').run(trader.id));const blocked=await app.request('/api/login',{email:trader.email,password});assert.equal(blocked.status,403);assert.equal(blocked.body.code,'RECOVERY_REQUIRED');assert.equal((await app.request('/api/account/status',undefined,trader.cookie)).body.code,'RECOVERY_REQUIRED');
  const forgot=await app.request('/api/password/forgot',{email:trader.email});assert.equal(forgot.status,202);const token=app.resetToken(trader.id);assert.match(token,/^[a-f0-9]{64}$/);const nextPassword='A new isolated recovery account passphrase';const reset=await app.request('/api/password/reset',{token,password:nextPassword});assert.equal(reset.status,200,JSON.stringify(reset.body));app.inspect(db=>{assert.equal(db.prepare('SELECT recovery_required FROM users WHERE id=?').get(trader.id).recovery_required,0);assert.ok(db.prepare('SELECT secret FROM two_factor WHERE user_id=?').get(trader.id).secret);});
  assert.equal((await app.request('/api/me',undefined,trader.cookie)).status,401);const challenge=await app.request('/api/login',{email:trader.email,password:nextPassword});assert.equal(challenge.status,202);assert.equal(challenge.body.twoFactorRequired,true);app.advance(31000);const signed=await app.request('/api/login/2fa',{challenge:challenge.body.challenge,code:generateTotpCode(trader.secret,{time:app.time()})});assert.equal(signed.status,200,JSON.stringify(signed.body));assert.equal((await app.request('/api/account/status',undefined,signed.cookie)).status,200);
 }finally{await app.close();}
});

test('deletion during an awaited price fetch cannot recreate the erased assessment or commit a trade',async()=>{
 const began=deferred(),release=deferred();let block=false;
 const source=createReferenceFixture();const marketData={...source,async getExecutionQuote(symbol){if(block){began.resolve();await release.promise;}return source.getExecutionQuote(symbol);}};
 const app=await fixture({marketData});try{
  const trader=await app.register('trader@example.com');await app.authorize(trader,'delete');block=true;const trade=app.request('/api/trades',{symbol:'EURUSD',side:'buy',lots:.01},trader.cookie);await began.promise;
  const removed=await app.request('/api/account/delete',{confirmation:'DELETE MY ACCOUNT'},trader.cookie);assert.equal(removed.status,200,JSON.stringify(removed.body));assert.equal(removed.body.status,'deleted');release.resolve();const response=await trade;assert.equal(response.status,401);assert.equal(response.body.code,'ACCOUNT_DELETED');app.inspect(db=>{assert.equal(db.prepare('SELECT count(*) n FROM accounts WHERE user_id=?').get(trader.id).n,0);assert.equal(db.prepare('SELECT count(*) n FROM performance_assessment_snapshots WHERE user_id=?').get(trader.id).n,0);assert.equal(db.prepare('SELECT count(*) n FROM events WHERE user_id=?').get(trader.id).n,0);});
 }finally{release.resolve();await app.close();}
});
