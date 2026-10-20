import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { createAdminAccess } from '../admin-access.mjs';
import { createAdminFinance } from '../admin-finance.mjs';

const accountInput = { userId:2,firmName:'External Example Firm',label:'Sponsored allocation A',accountSizeCents:1000000,traderShareBps:3333,profitSharingPolicy:'cumulative_high_water',evidence:'Operator reviewed the external allocation receipt.',reason:'Record approved sponsored allocation.' };
const statementInput = { netProfitCents:10000,externalReference:'statement-001',evidence:'Operator reviewed a settled external statement.',reason:'Record externally reported realized results.' };

function fixture(filename=':memory:') {
  const db = new DatabaseSync(filename);
  db.exec(`PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
    CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL);
    CREATE TABLE notification_preferences(user_id INTEGER PRIMARY KEY,verified INTEGER NOT NULL);
    CREATE TABLE two_factor(user_id INTEGER PRIMARY KEY,secret TEXT);
    INSERT INTO users VALUES(1,'Owner','owner@example.com'),(2,'Trader One','trader@example.com'),(3,'Trader Two','other@example.com');
    INSERT INTO notification_preferences VALUES(1,1),(2,1),(3,1);
    INSERT INTO two_factor VALUES(1,'test-only-factor-present');`);
  let time=Date.UTC(2026,9,25),failAudit=false;
  const access=createAdminAccess(db,{now:()=>time,ownerEmails:'owner@example.com'});
  const approved={userId:2,reviewId:randomUUID(),reviewRevision:2,certificateId:randomUUID(),contractId:randomUUID(),contractVersion:'provided-v1',contractHash:'a'.repeat(64),signatureId:randomUUID()};
  let approvalValid=true;
  const workflows={requireApproved(userId){if(!approvalValid||userId!==2)throw Object.assign(new Error('Current approval is required.'),{status:409});return{...approved};}};
  const guardedAccess={require:access.require,audit(...args){if(failAudit)throw new Error('Test audit write failed.');return access.audit(...args);}};
  const finance=createAdminFinance(db,{access:guardedAccess,workflows,now:()=>time});
  return{db,access,finance,approved,advance:delta=>time+=delta,setApproval:value=>approvalValid=value,setAuditFailure:value=>failAudit=value,create:extra=>finance.createAccount(1,{...accountInput,...extra}).account,statement:(id,extra={})=>finance.recordStatement(1,id,{...statementInput,...extra}),close:()=>db.close()};
}

test('finance starts empty with truthful manual records and zero totals',()=>{
  const app=fixture();
  try{
    assert.deepEqual(app.finance.accounts().accounts,[]);
    assert.deepEqual(app.finance.payouts().payouts,[]);
    const summary=app.finance.summary();
    assert.equal(summary.netProfitCents,0);assert.equal(summary.earnedCents,0);assert.equal(summary.availableCents,0);
    assert.equal(summary.source,'manual_external_record');assert.equal(summary.transfersMoney,false);
  }finally{app.close();}
});

test('sponsored accounts bind exact current approval and immutable terms, with no assumed profit policy',()=>{
  const app=fixture();
  try{
    assert.throws(()=>app.create({profitSharingPolicy:undefined}),e=>e.status===400);
    app.setApproval(false);assert.throws(()=>app.create(),e=>e.status===409);app.setApproval(true);
    const account=app.create();
    assert.equal(account.currency,'USD');assert.equal(account.status,'active');assert.equal(account.profitSharingPolicy,'cumulative_high_water');
    assert.deepEqual(account.review,{reviewId:app.approved.reviewId,reviewRevision:2,certificateId:app.approved.certificateId,contractId:app.approved.contractId,contractVersion:'provided-v1',contractHash:'a'.repeat(64),signatureId:app.approved.signatureId});
    assert.equal(account.accountSizeCents,1000000);assert.equal(account.traderShareBps,3333);
    assert.throws(()=>app.db.prepare('UPDATE sponsored_accounts SET trader_share_bps=1 WHERE id=?').run(account.id),/immutable/);
    assert.throws(()=>app.db.prepare('DELETE FROM sponsored_accounts WHERE id=?').run(account.id),/cannot be deleted/);
    assert.equal(app.access.auditList().entries[0].action,'finance.account-created');
  }finally{app.close();}
});

test('every finance mutation requires financial staff and atomically rolls back when audit fails',()=>{
  const app=fixture();
  try{
    assert.throws(()=>app.finance.createAccount(2,accountInput),e=>e.status===403);
    assert.equal(app.finance.accounts().total,0);
    app.setAuditFailure(true);assert.throws(()=>app.create(),/audit write failed/);assert.equal(app.finance.accounts().total,0);
    app.setAuditFailure(false);const account=app.create();app.setAuditFailure(true);
    assert.throws(()=>app.statement(account.id),/audit write failed/);
    assert.equal(app.finance.accountDetail(account.id).statementsTotal,0);assert.equal(app.finance.accountDetail(account.id).account.earnedCents,0);
    app.setAuditFailure(false);app.statement(account.id);app.setAuditFailure(true);
    assert.throws(()=>app.finance.createPayout(1,{accountId:account.id,amountCents:100,reason:'Reserve a manual payout.'}),/audit write failed/);
    assert.equal(app.finance.payouts().total,0);assert.equal(app.finance.accountDetail(account.id).account.reservedCents,0);
  }finally{app.close();}
});

test('high-water sharing carries losses forward without charging the trader or inflating one-cent allocations',()=>{
  const app=fixture();
  try{
    const account=app.create();
    const first=app.statement(account.id,{netProfitCents:10001,externalReference:'high-1'});assert.equal(first.statement.traderShareCents,3333);
    const loss=app.statement(account.id,{netProfitCents:-2000,externalReference:'high-2'});assert.equal(loss.statement.traderShareCents,0);assert.equal(loss.statement.companyShareCents,-2000);
    const recovery=app.statement(account.id,{netProfitCents:1999,externalReference:'high-3'});assert.equal(recovery.statement.traderShareCents,0);
    const next=app.statement(account.id,{netProfitCents:2,externalReference:'high-4'});assert.equal(next.statement.traderShareCents,1);assert.equal(next.account.earnedCents,3334);assert.equal(next.account.cumulativeNetProfitCents,10002);assert.equal(next.account.highWaterProfitCents,10002);
    const fragmented=app.create({label:'One-cent settlement test'});
    for(let index=0;index<100;index++)app.statement(fragmented.id,{netProfitCents:1,externalReference:`cent-${index}`});
    assert.equal(app.finance.accountDetail(fragmented.id).account.earnedCents,33,'rounded total, not rounded independent positive statements');
    assert.equal(app.finance.accountDetail(fragmented.id).account.availableCents,33);
    assert.throws(()=>app.db.prepare('UPDATE sponsored_statements SET net_profit_cents=999 WHERE account_id=?').run(account.id),/immutable/);
    assert.throws(()=>app.db.prepare('DELETE FROM sponsored_statements WHERE account_id=?').run(account.id),/immutable/);
  }finally{app.close();}
});

test('settled-period policy is explicit and requires nonoverlapping externally settled statement evidence',()=>{
  const app=fixture();
  try{
    const account=app.create({profitSharingPolicy:'settled_period',traderShareBps:5000});
    assert.throws(()=>app.statement(account.id),e=>e.status===400);
    const external={externalSettlementConfirmed:true,periodStart:'2026-10-01',periodEnd:'2026-10-07'};
    const first=app.statement(account.id,{...external});assert.equal(first.statement.traderShareCents,5000);assert.equal(first.statement.externalSettlementConfirmed,true);
    assert.throws(()=>app.statement(account.id,{...external,externalReference:'same-period-different-reference'}),e=>e.status===409);
    assert.throws(()=>app.statement(account.id,{...external,periodStart:'2026-10-07',periodEnd:'2026-10-10',externalReference:'touches-covered-day'}),e=>e.status===409);
    assert.throws(()=>app.statement(account.id,{...external,periodStart:'2026-10-26',periodEnd:'2026-10-27',externalReference:'future-period'}),e=>e.status===400);
    app.statement(account.id,{...external,periodStart:'2026-10-08',periodEnd:'2026-10-14',netProfitCents:-2000,externalReference:'loss-period'});
    const third=app.statement(account.id,{...external,periodStart:'2026-10-15',periodEnd:'2026-10-21',netProfitCents:2000,externalReference:'settled-recovery-period'});
    assert.equal(third.statement.traderShareCents,1000,'the explicitly chosen settled-period contract policy differs from high-water sharing');
    assert.equal(third.account.earnedCents,6000);
  }finally{app.close();}
});

test('money, evidence, periods, references, and immutable terms reject unsafe or ambiguous inputs',()=>{
  const app=fixture();
  try{
    for(const invalid of [{accountSizeCents:0},{accountSizeCents:1.2},{accountSizeCents:Number.MAX_SAFE_INTEGER},{traderShareBps:10001},{traderShareBps:-1},{evidence:''},{firmName:'Firm\nInjected'},{password:'must-not-be-accepted'}])assert.throws(()=>app.create(invalid),e=>e.status===400);
    const account=app.create();
    assert.throws(()=>app.create({label:' SPONSORED ALLOCATION A '}),e=>e.status===409);
    for(const invalid of [{netProfitCents:1.5},{netProfitCents:NaN},{netProfitCents:Infinity},{netProfitCents:'12.34'},{evidence:''},{externalReference:'bad\rheader'},{periodStart:'2026-02-30'},{periodStart:'2026-10-12',periodEnd:'2026-10-11'},{externalSettlementConfirmed:'yes'}])assert.throws(()=>app.statement(account.id,invalid),e=>e.status===400);
    app.statement(account.id,{externalReference:' STATEMENT-001 '});
    assert.throws(()=>app.statement(account.id,{externalReference:'statement-001'}),e=>e.status===409);
    assert.throws(()=>app.finance.updateAccount(1,account.id,{status:'paused',revision:1,traderShareBps:1,reason:'Try editing immutable terms.'}),e=>e.status===400);
    assert.equal(app.finance.accountDetail(account.id).statementsTotal,1);
  }finally{app.close();}
});

test('requested and approved payouts reserve funds, rejection releases them, and payments need explicit approval and reference',()=>{
  const app=fixture();
  try{
    const account=app.create({traderShareBps:5000});app.statement(account.id);
    const first=app.finance.createPayout(1,{accountId:account.id,amountCents:3000,reason:'Reserve trader settlement.'});
    assert.equal(first.payout.status,'requested');assert.equal(first.account.reservedCents,3000);assert.equal(first.account.availableCents,2000);assert.equal(first.payout.transfersMoney,false);
    assert.throws(()=>app.finance.createPayout(1,{accountId:account.id,amountCents:2001,reason:'Do not overreserve trader share.'}),e=>e.status===409);
    assert.throws(()=>app.finance.updatePayout(1,first.payout.id,{status:'paid',revision:1,externalPaymentReference:'bank-1',reason:'Attempt to skip approval.'}),e=>e.status===409);
    const approved=app.finance.updatePayout(1,first.payout.id,{status:'approved',revision:1,reason:'Approve recorded settlement.'});assert.equal(approved.account.reservedCents,3000);
    assert.throws(()=>app.finance.updatePayout(1,first.payout.id,{status:'paid',revision:2,reason:'No payment evidence supplied.'}),e=>e.status===400);
    assert.throws(()=>app.finance.updatePayout(1,first.payout.id,{status:'paid',revision:1,externalPaymentReference:'bank-1',reason:'Use stale revision.'}),e=>e.status===409);
    app.advance(1000);
    const paid=app.finance.updatePayout(1,first.payout.id,{status:'paid',revision:2,externalPaymentReference:'bank-1',reason:'Record payment executed externally.'});assert.equal(paid.account.paidCents,3000);assert.equal(paid.account.reservedCents,0);assert.equal(paid.account.availableCents,2000);
    assert.throws(()=>app.finance.updatePayout(1,first.payout.id,{status:'rejected',revision:3,reason:'Cannot reverse paid record.'}),e=>e.status===409);
    const second=app.finance.createPayout(1,{accountId:account.id,amountCents:2000,reason:'Reserve remaining share.'});
    const rejected=app.finance.updatePayout(1,second.payout.id,{status:'rejected',revision:1,reason:'Operator declined settlement.'});assert.equal(rejected.account.availableCents,2000);
    assert.throws(()=>app.finance.updatePayout(1,second.payout.id,{status:'approved',revision:2,reason:'Cannot revive rejected record.'}),e=>e.status===409);
    assert.equal(app.db.prepare('SELECT count(*) n FROM sponsored_payout_events').get().n,5);
    assert.throws(()=>app.db.prepare('UPDATE sponsored_payouts SET amount_cents=1 WHERE id=?').run(first.payout.id),/immutable/);
    assert.throws(()=>app.db.prepare('DELETE FROM sponsored_payout_events').run(),/immutable/);
  }finally{app.close();}
});

test('external payment references cannot be reused for a second recorded payment',()=>{
  const app=fixture();
  try{
    const account=app.create({traderShareBps:10000});app.statement(account.id);
    const first=app.finance.createPayout(1,{accountId:account.id,amountCents:100,reason:'First external settlement.'}).payout;
    app.finance.updatePayout(1,first.id,{status:'approved',revision:1,reason:'Approve first settlement.'});app.finance.updatePayout(1,first.id,{status:'paid',revision:2,externalPaymentReference:'Transfer-Shared',reason:'Record first external transfer.'});
    const second=app.finance.createPayout(1,{accountId:account.id,amountCents:100,reason:'Second external settlement.'}).payout;
    app.finance.updatePayout(1,second.id,{status:'approved',revision:1,reason:'Approve second settlement.'});
    assert.throws(()=>app.finance.updatePayout(1,second.id,{status:'paid',revision:2,externalPaymentReference:' transfer-shared ',reason:'Reject duplicate external transfer reference.'}),e=>e.status===409);
    assert.equal(app.finance.payouts({status:'approved'}).total,1);assert.equal(app.finance.summary().paidCents,100);
  }finally{app.close();}
});

test('status edits require revisions; closed accounts retain history and owed payouts without new statements',()=>{
  const app=fixture();
  try{
    const account=app.create();app.statement(account.id);
    const paused=app.finance.updateAccount(1,account.id,{status:'paused',revision:1,reason:'Pause external allocation.'});assert.equal(paused.account.revision,2);
    assert.throws(()=>app.finance.updateAccount(1,account.id,{status:'active',revision:1,reason:'Stale concurrent update.'}),e=>e.status===409);
    const closed=app.finance.updateAccount(1,account.id,{status:'closed',revision:2,reason:'Close external allocation.'});assert.equal(closed.account.status,'closed');
    assert.throws(()=>app.finance.updateAccount(1,account.id,{status:'active',revision:3,reason:'Try reopening final account.'}),e=>e.status===409);
    assert.throws(()=>app.statement(account.id,{externalReference:'late-statement'}),e=>e.status===409);
    const payout=app.finance.createPayout(1,{accountId:account.id,amountCents:100,reason:'Settle share from closed allocation.'});assert.equal(payout.payout.status,'requested');assert.equal(app.finance.accountDetail(account.id).statementsTotal,1);
  }finally{app.close();}
});

test('client finance view stays owner-scoped and strips operator evidence, references and staff identities',()=>{
  const app=fixture();
  try{
    const account=app.create();app.statement(account.id);app.finance.createPayout(1,{accountId:account.id,amountCents:100,reason:'Operator internal settlement reason.'});
    const own=app.finance.clientView(2),other=app.finance.clientView(3);
    assert.equal(own.accounts.length,1);assert.equal(own.payouts.length,1);assert.equal(other.accounts.length,0);assert.equal(other.payouts.length,0);
    assert.doesNotMatch(JSON.stringify(own),/Operator|owner@example|trader@example|evidence|externalReference|externalPaymentReference|createdBy|updatedBy|password|secret/);
    assert.equal(own.transfersMoney,false);assert.equal(own.accounts[0].source,'manual_external_record');
    assert.throws(()=>app.finance.clientView('2 OR 1=1'),e=>e.status===400);
  }finally{app.close();}
});

test('finance list search, filters and pagination are bounded and parameterized',()=>{
  const app=fixture();
  try{
    app.create();app.create({label:'Second label'});app.create({label:'Third label'});
    const first=app.finance.accounts({limit:'1',offset:'0',search:'External'});assert.equal(first.total,3);assert.equal(first.accounts.length,1);assert.equal(first.nextOffset,1);
    assert.equal(app.finance.accounts({search:"' OR 1=1 --"}).total,0);
    assert.equal(app.finance.accounts({userId:3}).total,0);
    for(const invalid of [{limit:0},{limit:101},{offset:-1},{limit:1.5},{status:'other'},{userId:'2;DROP'}])assert.throws(()=>app.finance.accounts(invalid),e=>e.status===400);
    assert.throws(()=>app.finance.accountDetail(randomUUID()),e=>e.status===404);
    assert.throws(()=>app.finance.payouts({accountId:'not-an-id'}),e=>e.status===400);
  }finally{app.close();}
});

test('separate SQLite writers cannot reserve the same available share twice',async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'fa-finance-race-')),filename=path.join(folder,'academy.sqlite');
  const app=fixture(filename);let workers=[];
  try{
    const account=app.create({traderShareBps:10000});app.statement(account.id,{netProfitCents:10000});
    const workerSource=`const {parentPort,workerData}=require('node:worker_threads');const {DatabaseSync}=require('node:sqlite');(async()=>{const {createAdminFinance}=await import(workerData.module);const db=new DatabaseSync(workerData.filename);db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000');const finance=createAdminFinance(db,{access:{require(){},audit(){}},workflows:{requireApproved(){throw new Error('not used')}},now:()=>Date.UTC(2026,9,25)});parentPort.postMessage({ready:true});parentPort.once('message',()=>{try{finance.createPayout(1,{accountId:workerData.accountId,amountCents:6000,reason:'Concurrent reservation test.'});parentPort.postMessage({status:200});}catch(error){parentPort.postMessage({status:error.status||500});}finally{db.close();parentPort.close();}});})().catch(error=>{parentPort.postMessage({error:error.message});parentPort.close()});`;
    workers=Array.from({length:2},()=>new Worker(workerSource,{eval:true,workerData:{module:new URL('../admin-finance.mjs',import.meta.url).href,filename,accountId:account.id}}));
    await Promise.all(workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',message=>message.ready?resolve():reject(new Error(message.error||'Worker did not initialize')));worker.once('error',reject);})));
    const results=workers.map(worker=>new Promise((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);}));workers.forEach(worker=>worker.postMessage('reserve'));
    const statuses=(await Promise.all(results)).map(result=>result.status).sort();assert.deepEqual(statuses,[200,409]);
    assert.equal(app.finance.accountDetail(account.id).account.reservedCents,6000);assert.equal(app.finance.accountDetail(account.id).account.availableCents,4000);
  }finally{await Promise.all(workers.map(worker=>worker.terminate()));app.close();await rm(folder,{recursive:true,force:true});}
});
