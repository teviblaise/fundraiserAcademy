import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createBackend} from '../backend.mjs';
import {createCertificates} from '../certificates.mjs';
import {createAccount} from '../public/simulator.js';
import {generateTotpCode} from '../two-factor.mjs';
import {providedAgreement} from '../agreement.mjs';
import {summarizeProgressiveProcessing} from '../progressive-finance.mjs';
import {createReferenceFixture} from './helpers/reference-fixture.mjs';
import {testDeliveryOptions,confirmRegistration} from './helpers/email-fixture.mjs';

const password='A private progressive HTTP fixture passphrase';
const reason='Reconciled against the isolated external fixture record.';

async function fixture(){
 const folder=await mkdtemp(path.join(tmpdir(),'fa-progressive-http-')),database=path.join(folder,'academy.sqlite');
 let time=Date.UTC(2026,9,23,13),backend,server,origin;
 async function start(){
  backend=createBackend(database,{now:()=>time,autoTick:false,adminOptions:{ownerEmails:'owner@example.com'},
   marketData:createReferenceFixture({now:()=>time}),deliveryOptions:{...testDeliveryOptions,now:()=>time},
   supportOptions:{staffEmails:'',aiOptions:{apiKey:''}},platformOptions:{sponsored:{apiToken:''},operations:{autoStart:false,backupDirectory:path.join(folder,'backups')}}});
  server=http.createServer((req,res)=>backend.handle(req,res,new URL(req.url,'http://localhost').pathname));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));origin=`http://127.0.0.1:${server.address().port}`;
 }
 const app={database,time:()=>time,advance(ms=1){time+=ms;},
  inspect(work){const db=new DatabaseSync(database);try{return work(db);}finally{db.close();}},
  async request(endpoint,data,cookie,headers={}){
   const response=await fetch(origin+endpoint,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Requested-With':'FundraiserAcademy',...(cookie?{Cookie:cookie}:{}),...headers},...(data===undefined?{}:{body:JSON.stringify(data)})});
   return{status:response.status,headers:response.headers,cookie:response.headers.get('set-cookie')?.split(';')[0],body:response.headers.get('content-type')?.includes('application/json')?await response.json():await response.text()};
  },
  async checked(endpoint,data,cookie){const result=await app.request(endpoint,data,cookie);assert.ok(result.status>=200&&result.status<300,JSON.stringify({endpoint,...result}));return result.body;},
  async register(email,{factor=false,confirmed=true}={}){
   const registration=await app.request('/api/register',{firstName:email.startsWith('owner')?'Olivia':'Emmanuel',otherNames:'Private Fixture',email,password,market:'I trade both',consent:true});
   assert.equal(registration.status,201,JSON.stringify(registration.body));if(confirmed)await confirmRegistration(database,app.request,registration);
   const actor={id:registration.body.user.id,email,cookie:registration.cookie};
   if(factor){const setup=await app.checked('/api/security/2fa/setup',{password},actor.cookie);const enabled=await app.request('/api/security/2fa/confirm',{password,code:generateTotpCode(setup.secret,{time})},actor.cookie);assert.equal(enabled.status,200,JSON.stringify(enabled.body));assert.ok(enabled.cookie);actor.cookie=enabled.cookie;actor.secret=setup.secret;}
   return actor;
  },
  async login(actor){const login=await app.request('/api/login',{email:actor.email,password});const signed=login.status===202?await app.request('/api/login/2fa',{challenge:login.body.challenge,code:generateTotpCode(actor.secret,{time})}):login;assert.equal(signed.status,200,JSON.stringify(signed.body));actor.cookie=signed.cookie;return signed;},
  qualify(actor){app.inspect(db=>{const state=createAccount(time);state.balance=11000;state.positions=[];state.locked='Profit target achieved';state.tradingDays=['2026-10-20','2026-10-21','2026-10-22'];createCertificates(db).issue(actor.id,state,time);db.prepare('UPDATE accounts SET state=? WHERE user_id=?').run(JSON.stringify(state),actor.id);});},
  async unlock(owner){time+=31000;return app.checked('/api/admin/reauth',{password,code:generateTotpCode(owner.secret,{time})},owner.cookie);},
  async authorize(actor,purpose){return app.checked('/api/account/authorize',{purpose,password},actor.cookie);},
  async approve(owner,actor){
   app.qualify(actor);const status=await app.checked('/api/contract',undefined,actor.cookie),document=status.contract;
   await app.checked('/api/contract/sign',{contractId:document.id,contractVersion:document.version,contractHash:document.hash,legalName:'Emmanuel Legal Fixture',consent:true},actor.cookie);
   await app.unlock(owner);const review=await app.checked(`/api/admin/reviews/${actor.id}`,undefined,owner.cookie);
   await app.checked(`/api/admin/reviews/${actor.id}`,{status:'approved',expectedRevision:review.revision,expectedContractId:review.contractId,expectedCertificateId:review.certificateId,reason,clientMessage:'The isolated sponsorship review is approved.'},owner.cookie);
   return document;
  },
  async create(owner,actor,label='Allocation A',extra={}){return(await app.checked('/api/admin/accounts',{userId:actor.id,firmName:'Fixture prop firm',label,accountSizeCents:1000000,profitSharingPolicy:'progressive_cleared',evidence:'Private account evidence, never client-facing.',reason,...extra},owner.cookie)).account;},
  receiptInput(amount,reference,extra={}){return{amountReceivedCents:amount,externalReference:reference,clearedAt:time,evidence:'Private cleared-funds evidence and reconciliation note.',reason,...extra};},
  async receipt(owner,account,amount,reference,extra={}){time++;return app.checked(`/api/admin/accounts/${account.id}/receipts`,app.receiptInput(amount,reference,extra),owner.cookie);},
  async restart(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await backend.close();await start();},
  async close(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));await backend.close();await rm(folder,{recursive:true,force:true});}
 };
 await start();return app;
}

test('the provided ten-clause agreement is private, qualification-gated, explicitly signed, and never reactivates over a later version',async()=>{
 const app=await fixture();try{
  const owner=await app.register('owner@example.com',{factor:true}),trader=await app.register('trader@example.com');
  const before=await app.checked('/api/contract',undefined,trader.cookie);assert.equal(before.status,'assessment_required');assert.equal(before.contract,null);assert.equal(before.signature,null);
  const stored=app.inspect(db=>db.prepare('SELECT id FROM contract_documents WHERE version=?').get(providedAgreement.version));assert.ok(stored);
  assert.equal((await app.request(`/api/contracts/${stored.id}/document`,undefined,trader.cookie)).status,403);
  assert.equal((await app.request('/api/contract/sign',{contractId:stored.id,consent:true,legalName:'Emmanuel Legal Fixture'},trader.cookie)).status,403);
  app.qualify(trader);const status=await app.checked('/api/contract',undefined,trader.cookie);assert.equal(status.status,'signature_required');assert.equal(status.contract.version,providedAgreement.version);assert.equal(status.contract.hash,providedAgreement.hash);
  const document=await app.request(status.contract.documentUrl,undefined,trader.cookie);assert.equal(document.status,200);assert.equal(document.headers.get('cache-control'),'no-store');assert.equal(document.headers.get('x-contract-sha256'),providedAgreement.hash);
  assert.equal(document.body,await readFile(new URL('../agreements/progressive-profit-sharing-v1.txt',import.meta.url),'utf8'));
  assert.match(document.body,/10\. Amendments/);assert.match(document.body,/Permanent Tier Retention Across Sponsored Accounts/);
  const input={contractId:status.contract.id,contractVersion:status.contract.version,contractHash:status.contract.hash,legalName:'Emmanuel Legal Fixture',consent:false};
  assert.equal((await app.request('/api/contract/sign',input,trader.cookie)).status,400);input.consent=true;
  const signed=await app.checked('/api/contract/sign',input,trader.cookie);assert.equal(signed.status,'signed');assert.equal(signed.signature.legalName,'Emmanuel Legal Fixture');
  await app.unlock(owner);const later=await app.checked('/api/admin/contracts',{contentBase64:Buffer.from('A later fixture agreement; not public program terms.').toString('base64'),format:'text',version:'later-fixture-v2',title:'Later fixture terms',fileName:'later.txt',reason},owner.cookie);
  await app.restart();const current=await app.checked('/api/contract',undefined,trader.cookie);assert.equal(current.contract.id,later.contract.id);assert.equal(current.status,'signature_required');assert.equal(current.history.length,1);assert.equal(current.history[0].contractVersion,providedAgreement.version);
  assert.equal((await app.request(status.contract.documentUrl,undefined,trader.cookie)).body,document.body);
  assert.equal(app.inspect(db=>db.prepare('SELECT count(*) n FROM contract_signatures').get().n),1);
 }finally{await app.close();}
});

test('progressive account and cleared-receipt routes require verified financial staff, origin checks, fresh proof, and the signed tier policy',async()=>{
 const app=await fixture();try{
  const endpoint=`/api/admin/accounts/${randomUUID()}/receipts`;
  assert.equal((await app.request(endpoint,{reason})).status,401);
  const owner=await app.register('owner@example.com',{factor:true}),trader=await app.register('trader@example.com'),unconfirmed=await app.register('pending@example.com',{confirmed:false});
  assert.equal((await app.request(endpoint,{reason},trader.cookie)).status,403);assert.equal((await app.request(endpoint,{reason},unconfirmed.cookie)).status,403);
  assert.equal((await app.request(endpoint,{reason},owner.cookie)).body.code,'ADMIN_REAUTH_REQUIRED');
  await app.approve(owner,trader);
  assert.equal((await app.request('/api/admin/accounts',{userId:trader.id,firmName:'Fixture prop firm',label:'Invalid split',accountSizeCents:1000000,profitSharingPolicy:'progressive_cleared',traderShareBps:7000,evidence:'Private evidence.',reason},owner.cookie)).status,400);
  assert.equal((await app.request('/api/admin/accounts',{userId:trader.id,firmName:'Fixture prop firm',label:'Invalid fixed policy',accountSizeCents:1000000,profitSharingPolicy:'cumulative_high_water',traderShareBps:5000,evidence:'Private evidence.',reason},owner.cookie)).status,400);
  const account=await app.create(owner,trader);assert.equal(account.sharingModel,'progressive_cleared');assert.equal(account.traderShareBps,5000);
  const receiptEndpoint=`/api/admin/accounts/${account.id}/receipts`,input=app.receiptInput(10000,'clear-001');
  assert.equal((await app.request(receiptEndpoint,input,owner.cookie,{Origin:'https://untrusted.example'})).status,403);
  assert.equal((await app.request(receiptEndpoint,input,owner.cookie,{'X-Requested-With':''})).status,403);
  assert.equal((await app.request(receiptEndpoint,{...input,thirdPartyChargesCents:1000},owner.cookie)).status,400);
  const first=await app.checked(receiptEndpoint,input,owner.cookie);assert.equal(first.receipt.traderShareCents,5000);
  const retry=await app.checked(receiptEndpoint,{...input,externalReference:'CLEAR-001'},owner.cookie);assert.equal(retry.reused,true);assert.equal(retry.receipt.id,first.receipt.id);
  assert.equal((await app.request(receiptEndpoint,{...input,amountReceivedCents:10001},owner.cookie)).status,409);
  assert.equal((await app.request(`/api/admin/traders/${trader.id}/profit-sharing`,undefined,trader.cookie)).status,403);
  const sharing=await app.checked(`/api/admin/traders/${trader.id}/profit-sharing`,undefined,owner.cookie);assert.equal(sharing.progression.cumulativeQualifyingNetPayoutsCents,10000);assert.equal(sharing.relationships.length,1);
  assert.equal(app.inspect(db=>db.prepare('SELECT count(*) n FROM progressive_receipts').get().n),1);
 }finally{await app.close();}
});

test('cleared receipts aggregate across accounts, apply the pre-receipt tier at both boundaries, and retain tiers after losses and account replacement',async()=>{
 const app=await fixture();try{
  const owner=await app.register('owner@example.com',{factor:true}),trader=await app.register('trader@example.com'),other=await app.register('other@example.com');
  await app.approve(owner,trader);const a=await app.create(owner,trader,'Allocation A'),b=await app.create(owner,trader,'Allocation B');
  const tradingResult=await app.checked(`/api/admin/accounts/${a.id}/statements`,{netProfitCents:9000000,externalReference:'not-cash',evidence:'Only a trading P&L statement.',reason},owner.cookie);assert.equal(tradingResult.statement.traderShareCents,0);assert.equal(tradingResult.account.earnedCents,0);
  assert.equal((await app.checked('/api/payouts',undefined,trader.cookie)).progressions[0].cumulativeQualifyingNetPayoutsCents,0);
  const first=await app.receipt(owner,a,990000,'clear-a1');assert.equal(first.receipt.appliedTraderShareBps,5000);assert.equal(first.receipt.traderShareCents,495000);assert.equal(first.progression.currentTraderShareBps,5000);
  const boundary=await app.receipt(owner,b,10000,'clear-b1');assert.equal(boundary.receipt.appliedTraderShareBps,5000);assert.equal(boundary.receipt.traderShareCents,5000);assert.equal(boundary.receipt.cumulativeAfterCents,1000000);assert.equal(boundary.progression.currentTraderShareBps,6000);
  const upper=await app.receipt(owner,a,1500000,'clear-a2');assert.equal(upper.receipt.appliedTraderShareBps,6000);assert.equal(upper.receipt.traderShareCents,900000);assert.equal(upper.receipt.cumulativeAfterCents,2500000);assert.equal(upper.progression.currentTraderShareBps,7000);
  const next=await app.receipt(owner,b,11000,'clear-b2',{thirdPartyChargesCents:1000,chargesAgreementReference:'Private written fee agreement.'});assert.equal(next.receipt.qualifyingNetPayoutCents,10000);assert.equal(next.receipt.appliedTraderShareBps,7000);assert.equal(next.receipt.traderShareCents,7000);assert.equal(next.receipt.companyShareCents,3000);
  const outOfOrder=await app.request(`/api/admin/accounts/${a.id}/receipts`,app.receiptInput(10000,'omitted-earlier',{clearedAt:first.receipt.clearedAt}),owner.cookie);assert.equal(outOfOrder.status,409);assert.equal(outOfOrder.body.code,'CLEARED_RECEIPT_OUT_OF_ORDER');
  await app.checked(`/api/admin/accounts/${a.id}`,{status:'closed',revision:a.revision,reason},owner.cookie);await app.checked(`/api/admin/accounts/${b.id}`,{status:'paused',revision:b.revision,reason},owner.cookie);
  const replacement=await app.create(owner,trader,'Replacement allocation',{firmName:'A different approved fixture firm'});assert.equal(replacement.traderShareBps,7000);assert.equal(replacement.progression.id,a.progression.id);
  const funding=await app.checked('/api/payouts',undefined,trader.cookie);assert.equal(funding.progressions[0].cumulativeQualifyingNetPayoutsCents,2510000);assert.equal(funding.receipts.length,4);assert.equal(funding.receipts[0].appliedTraderShareBps,7000);
  for(const receipt of funding.receipts)assert.equal(receipt.traderShareCents+receipt.companyShareCents,receipt.qualifyingNetPayoutCents);
  assert.doesNotMatch(JSON.stringify(funding),/Private cleared-funds|Private written fee|Private account evidence|externalReference|evidence|createdBy|owner@example/);
  assert.doesNotMatch(JSON.stringify({progressions:funding.progressions,receipts:funding.receipts}),/signatureId|contractHash|writtenAgreementReference/);
  const unrelated=await app.checked('/api/payouts',undefined,other.cookie);assert.equal(unrelated.receipts.length,0);assert.equal(unrelated.progressions.length,0);
  const earlier=await app.checked(`/api/admin/accounts/${a.id}`,undefined,owner.cookie);assert.equal(earlier.receipts.find(row=>row.id===first.receipt.id).appliedTraderShareBps,5000);assert.equal(earlier.receipts.find(row=>row.id===first.receipt.id).traderShareCents,495000);
 }finally{await app.close();}
});

test('payout initiation uses the cleared-funds business-day deadline, preserves partial obligations, and keeps unpaid earnings protected from deletion',async()=>{
 const app=await fixture();try{
  const owner=await app.register('owner@example.com',{factor:true}),trader=await app.register('trader@example.com');await app.approve(owner,trader);const account=await app.create(owner,trader);
  const cleared=await app.receipt(owner,account,100000,'friday-cleared');const expected=new Date(cleared.receipt.clearedAt);expected.setUTCDate(28);assert.equal(cleared.receipt.initiationDueAt,expected.getTime(),'Friday receipt is due Wednesday at the same Lagos local time');
  const request={accountId:account.id,amountCents:25000,idempotencyKey:randomUUID()};assert.equal((await app.request('/api/payouts/request',request,trader.cookie)).body.code,'ACCOUNT_REAUTH_REQUIRED');await app.authorize(trader,'payout');
  const requested=await app.checked('/api/payouts/request',request,trader.cookie);assert.equal(requested.payout.receiptAllocations.length,1);assert.equal(requested.payout.initiationDueAt,cleared.receipt.initiationDueAt);assert.equal(requested.payout.processingState,'not_initiated');
  const approved=await app.checked(`/api/admin/payouts/${requested.payout.id}`,{status:'approved',revision:requested.payout.revision,reason},owner.cookie);
  assert.equal((await app.request(`/api/admin/payouts/${requested.payout.id}`,{status:'paid',revision:approved.payout.revision,externalPaymentReference:'completion-before-initiation',reason},owner.cookie)).status,409);
  assert.equal((await app.request(`/api/admin/payouts/${requested.payout.id}/initiate`,{revision:approved.payout.revision,reason},owner.cookie)).status,400);
  const initiated=await app.checked(`/api/admin/payouts/${requested.payout.id}/initiate`,{revision:approved.payout.revision,externalInitiationReference:'Private bank initiation fixture.',reason},owner.cookie);assert.equal(initiated.payout.processingState,'initiated');assert.equal(initiated.payout.initiationDueAt,cleared.receipt.initiationDueAt);
  assert.equal((await app.request(`/api/admin/payouts/${requested.payout.id}`,{status:'rejected',revision:initiated.payout.revision,reason},owner.cookie)).status,409);
  const paid=await app.checked(`/api/admin/payouts/${requested.payout.id}`,{status:'paid',revision:initiated.payout.revision,externalPaymentReference:'Private completed payment fixture.',reason},owner.cookie);assert.equal(paid.payout.status,'paid');assert.equal(paid.payout.transfersMoney,false);
  const funding=await app.checked('/api/payouts',undefined,trader.cookie);assert.equal(funding.receipts[0].initiatedCents,25000);assert.equal(funding.receipts[0].outstandingCents,25000);assert.equal(funding.accounts[0].availableCents,25000);assert.equal(funding.accounts[0].paidCents,25000);assert.doesNotMatch(JSON.stringify(funding),/Private bank|Private completed/);
  await app.checked(`/api/admin/accounts/${account.id}`,{status:'closed',revision:account.revision,reason},owner.cookie);await app.authorize(trader,'delete');const pending=await app.checked('/api/account/delete',{confirmation:'DELETE MY ACCOUNT'},trader.cookie);assert.equal(pending.status,'pending_closure');assert.ok(pending.blockers.some(item=>item.code==='EARNED_SHARE_UNSETTLED'));assert.equal((await app.request('/api/me',undefined,trader.cookie)).status,200);
  app.advance(cleared.receipt.initiationDueAt-app.time()+1);await app.login(owner);
  const obligations=app.inspect(db=>summarizeProgressiveProcessing(db,{now:app.time}));assert.equal(obligations.overdueReceipts,1);assert.equal(obligations.overdueTraderShareCents,25000);
  const health=await app.checked('/api/admin/operations',undefined,owner.cookie),deadlineCheck=health.health.checks.find(item=>item.id==='payout-processing');assert.equal(deadlineCheck.state,'critical',JSON.stringify(deadlineCheck));assert.match(deadlineCheck.summary,/1 cleared receipts/);assert.match(deadlineCheck.summary,/250\.00/);
 }finally{await app.close();}
});

test('reinstatement requires the exact mutually signed starting-tier document and late receipts keep their original relationship',async()=>{
 const app=await fixture();try{
  const owner=await app.register('owner@example.com',{factor:true}),trader=await app.register('trader@example.com'),other=await app.register('other@example.com');await app.approve(owner,other);await app.checked('/api/leaderboard/preferences',{enabled:true,alias:'Other Public Fixture'},other.cookie);const boardBefore=await app.checked('/api/leaderboard'),otherContractBefore=await app.checked('/api/contract',undefined,other.cookie),otherReviewBefore=await app.checked(`/api/admin/reviews/${other.id}`,undefined,owner.cookie);assert.equal(boardBefore.entries.length,1);await app.approve(owner,trader);const oldAccount=await app.create(owner,trader);
  const earned=await app.receipt(owner,oldAccount,3000000,'old-relationship-clear');assert.equal(earned.receipt.appliedTraderShareBps,5000);assert.equal(earned.progression.currentTraderShareBps,7000);
  const relationEndpoint=`/api/admin/traders/${trader.id}/profit-sharing`;
  assert.equal((await app.request(relationEndpoint,{action:'terminate',revision:earned.progression.revision,reason},owner.cookie)).status,409,'an active sponsored account must be closed before contractual termination');
  await app.checked(`/api/admin/accounts/${oldAccount.id}`,{status:'closed',revision:oldAccount.revision,reason},owner.cookie);
  const terminated=await app.checked(relationEndpoint,{action:'terminate',revision:earned.progression.revision,reason},owner.cookie);assert.equal(terminated.progression.status,'terminated');assert.equal(terminated.progression.currentTraderShareBps,7000);
  assert.equal((await app.request('/api/admin/accounts',{userId:trader.id,firmName:'Fixture firm',label:'Premature reinstatement',accountSizeCents:1000000,profitSharingPolicy:'progressive_cleared',evidence:'Private evidence.',reason},owner.cookie)).status,409);
  const terms={revision:terminated.progression.revision,writtenAgreementReference:'Jointly agreed fixture reinstatement terms, revision A.',startingTraderShareBps:6000,reason};
  assert.equal((await app.request(relationEndpoint,{...terms,action:'reinstate',traderConsentConfirmed:true},owner.cookie)).status,409,'a staff consent checkbox cannot replace a fresh trader signature');
  app.advance();await app.checked('/api/admin/contracts',{contentBase64:Buffer.from('Unrelated freshly signed fixture terms with no reinstatement tier.').toString('base64'),format:'text',version:'unrelated-fresh-v2',title:'Unrelated fixture terms',fileName:'unrelated.txt',recipientUserId:trader.id,reason},owner.cookie);await app.approve(owner,trader);
  assert.equal((await app.request(relationEndpoint,{...terms,action:'reinstate',traderConsentConfirmed:true},owner.cookie)).status,409,'fresh consent to unrelated terms cannot authorize a lower starting tier');
  const prepared=await app.checked(`${relationEndpoint}/prepare-reinstatement`,terms,owner.cookie);assert.ok(prepared.document.contentBase64);assert.match(Buffer.from(prepared.document.contentBase64,'base64').toString('utf8'),/60%/);
  const {hash:_hash,...document}=prepared.document;
  const scoped=await app.checked('/api/admin/contracts',{...document,recipientUserId:trader.id,reason},owner.cookie);app.advance();await app.approve(owner,trader);
  const otherContractAfter=await app.checked('/api/contract',undefined,other.cookie),otherReviewAfter=await app.checked(`/api/admin/reviews/${other.id}`,undefined,owner.cookie);assert.equal(otherContractAfter.contract.id,otherContractBefore.contract.id);assert.equal(otherContractAfter.contract.version,providedAgreement.version);assert.equal(otherContractAfter.status,'signed');assert.equal(otherReviewAfter.status,'approved');assert.equal(otherReviewAfter.contractId,otherReviewBefore.contractId);assert.equal(otherReviewAfter.revision,otherReviewBefore.revision);
  assert.equal((await app.request(`/api/contracts/${scoped.contract.id}/document`,undefined,other.cookie)).status,404);
  assert.equal((await app.request('/api/contract/sign',{contractId:scoped.contract.id,contractVersion:scoped.contract.version,contractHash:scoped.contract.hash,legalName:'Another Legal Fixture',consent:true},other.cookie)).status,409);
  assert.deepEqual((await app.checked('/api/leaderboard')).entries,boardBefore.entries,'personal reinstatement terms cannot remove another opted-in fundraiser from the ranking');
  const reinstated=await app.checked(relationEndpoint,{...terms,action:'reinstate',traderConsentConfirmed:true},owner.cookie);assert.equal(reinstated.progression.status,'active');assert.equal(reinstated.progression.currentTraderShareBps,6000);assert.equal(reinstated.progression.cumulativeQualifyingNetPayoutsCents,0);assert.equal(reinstated.progression.previousRelationshipId,terminated.progression.id);assert.notEqual(reinstated.progression.id,terminated.progression.id);
  const replacement=await app.create(owner,trader,'Reinstated allocation');assert.equal(replacement.traderShareBps,6000);
  const late=await app.receipt(owner,oldAccount,10000,'late-old-relationship-clear');assert.equal(late.receipt.relationshipId,terminated.progression.id);assert.equal(late.receipt.appliedTraderShareBps,7000);assert.equal(late.receipt.traderShareCents,7000);
  const current=await app.checked(relationEndpoint,undefined,owner.cookie);assert.equal(current.progression.id,reinstated.progression.id);assert.equal(current.progression.currentTraderShareBps,6000);assert.equal(current.progression.cumulativeQualifyingNetPayoutsCents,0);
  const next=await app.receipt(owner,replacement,10000,'new-relationship-clear');assert.equal(next.receipt.appliedTraderShareBps,6000);assert.equal(next.receipt.traderShareCents,6000);
  const funding=await app.checked('/api/payouts',undefined,trader.cookie);assert.equal(funding.progressions.length,2);assert.equal(funding.accounts.find(row=>row.id===oldAccount.id).earnedCents,1507000);assert.equal(funding.accounts.find(row=>row.id===replacement.id).earnedCents,6000);
  assert.equal(app.inspect(db=>db.prepare('SELECT count(*) n FROM contract_signatures WHERE user_id=?').get(trader.id).n),3);
 }finally{await app.close();}
});
