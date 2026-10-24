import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {Worker} from 'node:worker_threads';
import {createAdminAccess} from '../admin-access.mjs';
import {createAdminFinance} from '../admin-finance.mjs';
import {createContracts} from '../contracts.mjs';
import {installProvidedAgreement,providedAgreement} from '../agreement.mjs';
import {buildReinstatementAgreement,payoutInitiationDeadline,summarizeProgressiveProcessing} from '../progressive-finance.mjs';

const why='Reconcile actual externally cleared funds in an isolated fixture.';
const policy='progressive_cleared';
function fixture(database=':memory:'){
 const db=new DatabaseSync(database);db.exec(`PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;PRAGMA journal_mode=WAL;
  CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL,first_name TEXT NOT NULL);
  CREATE TABLE notification_preferences(user_id INTEGER PRIMARY KEY,verified INTEGER NOT NULL);
  CREATE TABLE two_factor(user_id INTEGER PRIMARY KEY,secret TEXT);
  CREATE TABLE certificates(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),issued_at INTEGER,trading_days INTEGER,profit_percent REAL);
  CREATE TABLE events(id INTEGER PRIMARY KEY,user_id INTEGER,kind TEXT,detail TEXT,created_at INTEGER);
  INSERT INTO users VALUES(1,'Owner Fixture','owner@example.com','Owner'),(2,'Ana Maria Fixture','fundraiser@example.com','Ana Maria'),(3,'Other Fixture','other@example.com','Other');
  INSERT INTO notification_preferences VALUES(1,1),(2,1),(3,1);INSERT INTO two_factor VALUES(1,'factor-presence-only');`);
 let time=Date.UTC(2026,9,26,12),failAudit=false,approvalValid=true;
 for(const userId of [2,3])db.prepare('INSERT INTO certificates VALUES(?,?,?,?,?)').run(randomUUID(),userId,time,3,10);
 const access=createAdminAccess(db,{now:()=>time,ownerEmails:'owner@example.com'}),contracts=createContracts(db);
 installProvidedAgreement(contracts,{now:time});
 const approvals=new Map();
 function sign(userId=2){const before=contracts.status(userId);const after=contracts.sign(userId,{contractId:before.contract.id,contractHash:before.contract.hash,contractVersion:before.contract.version,legalName:userId===2?'Ana Maria Fixture':'Other Fixture',consent:true},time);const approval={userId,reviewId:randomUUID(),reviewRevision:1,certificateId:after.assessment.certificateId,contractId:after.contract.id,contractVersion:after.contract.version,contractHash:after.contract.hash,signatureId:after.signature.id};approvals.set(userId,approval);return approval;}
 sign(2);sign(3);
 const workflows={requireApproved(userId){if(!approvalValid||!approvals.has(userId))throw Object.assign(new Error('Current signed approval is required.'),{status:409});return{...approvals.get(userId)};}};
 const guarded={require:access.require,audit(...args){if(failAudit)throw new Error('Isolated audit failure');return access.audit(...args);}};
 const finance=createAdminFinance(db,{access:guarded,workflows,now:()=>time});
 const app={db,finance,contracts,approvals,sign,time:()=>time,advance(delta=1){time+=delta;},setAuditFailure(value){failAudit=value;},setApproval(value){approvalValid=value;},
  create(input={}){return finance.createAccount(1,{userId:2,firmName:'Approved external firm',label:'Allocation '+randomUUID(),accountSizeCents:1000000,profitSharingPolicy:policy,evidence:'External allocation reviewed in this isolated fixture.',reason:why,...input}).account;},
  receipt(accountId,amountReceivedCents,input={}){return finance.recordClearedReceipt(1,accountId,{amountReceivedCents,externalReference:randomUUID(),clearedAt:time,evidence:'Private external receipt evidence',reason:why,...input});},
  payout(accountId,amountCents){return finance.createPayout(1,{accountId,amountCents,reason:why}).payout;},
  approve(payout){return finance.updatePayout(1,payout.id,{status:'approved',revision:payout.revision,reason:why}).payout;},
  closeAccount(account){const current=finance.accountDetail(account.id).account;return finance.updateAccount(1,account.id,{status:'closed',revision:current.revision,reason:why}).account;},
  close(){db.close();}
 };return app;
}

test('new progressive allocations bind the exact supplied agreement and start at 50 percent without staff overrides',()=>{
 const app=fixture();try{
  for(const input of [{profitSharingPolicy:'settled_period',traderShareBps:7000},{traderShareBps:6000}])assert.throws(()=>app.create(input),error=>error.status===400);
  assert.equal(app.db.prepare('SELECT count(*) n FROM progressive_relationships').get().n,0);
  const account=app.create();assert.equal(account.traderShareBps,5000);assert.equal(account.sharingModel,policy);assert.equal(account.profitSharingPolicy,policy);assert.equal(account.traderFirstName,'Ana Maria');
  assert.equal(account.progression.cumulativeQualifyingNetPayoutsCents,0);assert.equal(account.progression.contractVersion,providedAgreement.version);
  const other=app.create({userId:3});assert.notEqual(other.progression.id,account.progression.id);
  app.approvals.get(2).contractHash='f'.repeat(64);assert.throws(()=>app.create(),error=>error.status===409);
 }finally{app.close();}
});

test('arbitrary signed text cannot be silently adopted as the progressive agreement',()=>{
 const app=fixture();try{
  app.contracts.publish({version:'unrelated-custom-v1',format:'text',content:Buffer.from('An unrelated agreement without progressive terms.'),now:app.time()});app.sign();
  assert.throws(()=>app.create(),error=>error.code==='PROGRESSIVE_AGREEMENT_REQUIRED');
  assert.equal(app.db.prepare('SELECT count(*) n FROM progressive_relationships').get().n,0);
 }finally{app.close();}
});

test('the entire threshold-crossing receipt uses the previous tier and upgrades only the next eligible receipt',()=>{
 const app=fixture();try{
  const account=app.create(),amounts=[999999,1,1499999,1,100],expected=[5000,5000,6000,6000,7000],next=[5000,6000,6000,7000,7000];let cumulative=0;
  amounts.forEach((amount,index)=>{const {receipt,progression}=app.receipt(account.id,amount);cumulative+=amount;assert.equal(receipt.appliedTraderShareBps,expected[index]);assert.equal(receipt.nextTraderShareBps,next[index]);assert.equal(receipt.cumulativeAfterCents,cumulative);assert.equal(receipt.traderShareCents+receipt.companyShareCents,amount);assert.equal(progression.currentTraderShareBps,next[index]);});
  assert.equal(app.finance.accountDetail(account.id).receipts[3].appliedTraderShareBps,5000,'earlier receipts retain their original split');
  const record=app.finance.accountDetail(account.id).receipts[0];assert.throws(()=>app.db.prepare('UPDATE progressive_receipts SET applied_trader_share_bps=1 WHERE id=?').run(record.id),/immutable/);
  assert.throws(()=>app.db.prepare('UPDATE progressive_relationships SET current_tier_bps=5000 WHERE id=?').run(account.progression.id),/immutable/);
 }finally{app.close();}
});

test('one large first receipt can cross both thresholds without repricing itself',()=>{
 const app=fixture();try{
  const account=app.create(),first=app.receipt(account.id,3000000);assert.equal(first.receipt.appliedTraderShareBps,5000);assert.equal(first.receipt.traderShareCents,1500000);assert.equal(first.progression.currentTraderShareBps,7000);
  assert.equal(app.receipt(account.id,10000).receipt.traderShareCents,7000);
 }finally{app.close();}
});

test('eligible accounts and firms share one retained tier while losses and account closure do not reset progression',()=>{
 const app=fixture();try{
  const first=app.create();app.receipt(first.id,1000000);const second=app.create({firmName:'Another approved external firm'});assert.equal(second.traderShareBps,6000);assert.equal(second.progression.id,first.progression.id);
  const loss=app.finance.recordStatement(1,second.id,{netProfitCents:-500000,externalReference:'loss-only',evidence:'Observed trading loss, not a cleared payout',reason:why});assert.equal(loss.statement.traderShareCents,0);assert.equal(loss.account.earnedCents,0);assert.equal(loss.account.progression.currentTraderShareBps,6000);
  const profit=app.finance.recordStatement(1,second.id,{netProfitCents:9000000,externalReference:'not-cash',evidence:'Trading profit has not cleared to the company',reason:why});assert.equal(profit.statement.traderShareCents,0);assert.equal(profit.account.progression.cumulativeQualifyingNetPayoutsCents,1000000);
  app.closeAccount(first);const third=app.create();assert.equal(third.traderShareBps,6000);assert.equal(third.progression.cumulativeQualifyingNetPayoutsCents,1000000);
  const final=app.receipt(third.id,1500000);assert.equal(final.receipt.appliedTraderShareBps,6000);assert.equal(final.progression.currentTraderShareBps,7000);
 }finally{app.close();}
});

test('only agreed transaction charges reduce cleared qualifying cash and all statement cents reconcile',()=>{
 const app=fixture();try{
  const account=app.create();assert.throws(()=>app.receipt(account.id,10000,{thirdPartyChargesCents:100}),error=>error.status===400);
  const {receipt}=app.receipt(account.id,10001,{thirdPartyChargesCents:2,chargesAgreementReference:'Signed processing charge clause'});assert.equal(receipt.qualifyingNetPayoutCents,9999);assert.equal(receipt.traderShareCents,5000);assert.equal(receipt.companyShareCents,4999);assert.equal(receipt.amountReceivedCents-receipt.thirdPartyChargesCents,receipt.traderShareCents+receipt.companyShareCents);
  const zero=app.receipt(account.id,5,{thirdPartyChargesCents:5,chargesAgreementReference:'Agreed fee equals received funds'});assert.equal(zero.receipt.traderShareCents,0);assert.equal(zero.progression.cumulativeQualifyingNetPayoutsCents,9999);
  for(const amount of [0,-1,0.01,'100',NaN,Infinity,Number.MAX_SAFE_INTEGER])assert.throws(()=>app.receipt(account.id,amount),error=>error.status===400);
  for(const input of [{thirdPartyChargesCents:-1},{thirdPartyChargesCents:10001},{clearedAt:app.time()+1}])assert.throws(()=>app.receipt(account.id,10000,input),error=>error.status===400);
 }finally{app.close();}
});

test('cleared references are idempotent across an owner’s accounts and receipt chronology cannot silently reorder tiers',()=>{
 const app=fixture();try{
  const one=app.create(),two=app.create(),input={amountReceivedCents:1000000,externalReference:'  RECEIPT-ONE ',clearedAt:app.time(),evidence:'Cleared bank evidence',reason:why};
  const first=app.finance.recordClearedReceipt(1,one.id,input),again=app.finance.recordClearedReceipt(1,one.id,{...input,externalReference:'receipt-one'});assert.equal(first.reused,false);assert.equal(again.reused,true);assert.equal(again.receipt.id,first.receipt.id);assert.equal(again.progression.currentTraderShareBps,6000);
  assert.throws(()=>app.finance.recordClearedReceipt(1,two.id,input),error=>error.code==='CLEARED_RECEIPT_CONFLICT');assert.throws(()=>app.finance.recordClearedReceipt(1,one.id,{...input,amountReceivedCents:1}),error=>error.code==='CLEARED_RECEIPT_CONFLICT');
  app.advance(100);app.receipt(two.id,100);assert.throws(()=>app.receipt(one.id,100,{clearedAt:app.time()-50}),error=>error.code==='CLEARED_RECEIPT_OUT_OF_ORDER');assert.equal(app.finance.profitSharing(2).progression.cumulativeQualifyingNetPayoutsCents,1000100);
 }finally{app.close();}
});

test('financial permissions and audit failures atomically roll back relationships, receipts, and initiation evidence',()=>{
 const app=fixture();try{
  app.setAuditFailure(true);assert.throws(()=>app.create(),/audit failure/);assert.equal(app.db.prepare('SELECT count(*) n FROM progressive_relationships').get().n,0);app.setAuditFailure(false);
  const account=app.create();assert.throws(()=>app.finance.recordClearedReceipt(2,account.id,{amountReceivedCents:100,clearedAt:app.time(),externalReference:'unauthorized',evidence:'evidence',reason:why}),error=>error.status===403);
  app.setAuditFailure(true);assert.throws(()=>app.receipt(account.id,1000000),/audit failure/);assert.equal(app.finance.profitSharing(2).progression.currentTraderShareBps,5000);assert.equal(app.db.prepare('SELECT count(*) n FROM progressive_receipts').get().n,0);app.setAuditFailure(false);
  app.receipt(account.id,10000);const payout=app.approve(app.payout(account.id,5000));app.setAuditFailure(true);assert.throws(()=>app.finance.initiatePayout(1,payout.id,{revision:payout.revision,externalInitiationReference:'failed-audit-reference',reason:why}),/audit failure/);assert.equal(app.db.prepare('SELECT count(*) n FROM progressive_payout_initiations').get().n,0);assert.equal(app.finance.payouts().payouts[0].revision,payout.revision);
 }finally{app.close();}
});

test('receipt allocation preserves the original deadline through rejection, partial payments, and new requests',()=>{
 const app=fixture();try{
  const account=app.create(),receipt=app.receipt(account.id,10000).receipt,first=app.payout(account.id,2000);assert.equal(first.initiationDueAt,receipt.initiationDueAt);
  app.finance.updatePayout(1,first.id,{status:'rejected',revision:first.revision,reason:why});app.advance(4*86400000);
  let second=app.approve(app.payout(account.id,2000));assert.equal(second.initiationDueAt,receipt.initiationDueAt);assert.equal(second.overdue,true);
  assert.throws(()=>app.finance.updatePayout(1,second.id,{status:'paid',revision:second.revision,externalPaymentReference:'premature-completion',reason:why}),error=>error.status===409);
  const initiated=app.finance.initiatePayout(1,second.id,{revision:second.revision,externalInitiationReference:'actual-initiation-1',reason:why});second=initiated.payout;assert.equal(second.processingState,'initiated');assert.equal(second.initiationWasLate,true);
  assert.throws(()=>app.finance.updatePayout(1,second.id,{status:'rejected',revision:second.revision,reason:why}),error=>error.status===409);
  assert.equal(app.finance.initiatePayout(1,second.id,{revision:1,externalInitiationReference:'actual-initiation-1',reason:why}).reused,true);
  assert.throws(()=>app.finance.initiatePayout(1,second.id,{revision:second.revision,externalInitiationReference:'different-proof',reason:why}),error=>error.status===409);
  const summary=app.finance.processingSummary();assert.equal(summary.overdueReceipts,1);assert.equal(summary.overdueTraderShareCents,3000);assert.equal(summary.uninitiatedTraderShareCents,3000);
  const paid=app.finance.updatePayout(1,second.id,{status:'paid',revision:second.revision,externalPaymentReference:'actual-completion-1',reason:why}).payout;assert.equal(paid.status,'paid');
  const rest=app.approve(app.payout(account.id,3000));app.finance.initiatePayout(1,rest.id,{revision:rest.revision,externalInitiationReference:'actual-initiation-rest',reason:why});assert.equal(app.finance.processingSummary().overdueReceipts,0);assert.equal(app.finance.accountDetail(account.id).receipts[0].outstandingCents,0);
 }finally{app.close();}
});

test('business-day initiation deadlines use Monday–Friday in Africa/Lagos rather than UTC weekdays',()=>{
 for(const [from,to] of [
  ['2026-10-30T12:00:00Z','2026-11-04T12:00:00Z'],
  ['2026-10-26T08:00:00Z','2026-10-29T08:00:00Z'],
  ['2026-10-30T23:30:00Z','2026-11-03T23:30:00Z'],
  ['2026-10-25T23:30:00Z','2026-10-28T23:30:00Z']
 ])assert.equal(new Date(payoutInitiationDeadline(Date.parse(from))).toISOString(),new Date(to).toISOString());
 for(const invalid of [-1,1.1,NaN,Infinity,'100',8640000000000000])assert.throws(()=>payoutInitiationDeadline(invalid),error=>error.status===400);
 const empty=new DatabaseSync(':memory:');try{assert.equal(summarizeProgressiveProcessing(empty).uninitiatedTraderShareCents,0);assert.equal(empty.prepare("SELECT count(*) n FROM sqlite_master WHERE type='table'").get().n,0);}finally{empty.close();}
});

test('termination retains unpaid earned shares and later cleared receipts on the original relationship',()=>{
 const app=fixture();try{
  const account=app.create();app.receipt(account.id,1000000);assert.throws(()=>app.finance.updateRelationship(1,2,{action:'terminate',revision:2,reason:why}),error=>error.status===409);
  app.closeAccount(account);const old=app.finance.profitSharing(2).progression,ended=app.finance.updateRelationship(1,2,{action:'terminate',revision:old.revision,reason:why}).progression;assert.equal(ended.status,'terminated');assert.equal(ended.currentTraderShareBps,6000);
  assert.throws(()=>app.create(),error=>error.status===409);app.advance(1);const late=app.receipt(account.id,10000);assert.equal(late.receipt.appliedTraderShareBps,6000);assert.equal(late.progression.status,'terminated');assert.equal(late.account.availableCents,506000);
  assert.equal(app.payout(account.id,506000).amountCents,506000);
 }finally{app.close();}
});

test('reinstatement requires the exact freshly signed written tier determination rather than a staff checkbox',()=>{
 const app=fixture();try{
  const account=app.create();app.receipt(account.id,3000000);app.closeAccount(account);const ended=app.finance.updateRelationship(1,2,{action:'terminate',revision:app.finance.profitSharing(2).progression.revision,reason:why}).progression;
  const terms={revision:ended.revision,writtenAgreementReference:'Written reinstatement arrangement 2026-01',startingTraderShareBps:6000,reason:why};
  const prepared=app.finance.prepareReinstatement(1,2,terms);assert.equal(prepared.published,false);assert.equal(prepared.signed,false);assert.equal(app.finance.profitSharing(2).progression.status,'terminated');
  assert.equal(prepared.document.recipientUserId,2);
  assert.throws(()=>app.finance.updateRelationship(1,2,{...terms,action:'reinstate',traderConsentConfirmed:true}),error=>error.code==='REINSTATEMENT_SIGNATURE_REQUIRED');
  const expected=buildReinstatementAgreement({previousRelationshipId:ended.id,...terms});assert.equal(prepared.document.hash,expected.hash);assert.match(expected.content.toString(),/60% to the Fundraiser and 40% to the Company/);assert.match(expected.content.toString(),/USD 0\.00/);assert.match(expected.content.toString(),/Previously accrued and unpaid entitlements remain payable/);
  app.advance(1);app.contracts.publish({...prepared.document,content:Buffer.from(prepared.document.contentBase64,'base64'),now:app.time()});app.sign();
  assert.equal(app.contracts.status(3).contract.version,providedAgreement.version,'a personal reinstatement never replaces another fundraiser’s agreement');
  assert.throws(()=>app.contracts.document(3,app.contracts.status(2).contract.id),error=>error.status===404);
  assert.throws(()=>app.finance.updateRelationship(1,2,{...terms,action:'reinstate',startingTraderShareBps:5000,traderConsentConfirmed:true}),error=>error.code==='REINSTATEMENT_SIGNATURE_REQUIRED');
  const active=app.finance.updateRelationship(1,2,{...terms,action:'reinstate',traderConsentConfirmed:true}).progression;assert.equal(active.previousRelationshipId,ended.id);assert.equal(active.currentTraderShareBps,6000);assert.equal(active.cumulativeQualifyingNetPayoutsCents,0);
  const next=app.create();assert.equal(next.progression.id,active.id);assert.equal(next.traderShareBps,6000);assert.equal(app.finance.accountDetail(account.id).account.earnedCents,1500000);
  const late=app.receipt(account.id,10000);assert.equal(late.receipt.appliedTraderShareBps,7000);assert.equal(app.finance.profitSharing(2).progression.cumulativeQualifyingNetPayoutsCents,0,'late receipts remain with the terminated relationship');
 }finally{app.close();}
});

test('a terminated progressive relationship cannot bypass written reinstatement by selecting legacy fixed-share policies',()=>{
 const app=fixture();try{
  const account=app.create();app.closeAccount(account);const current=app.finance.profitSharing(2).progression;
  app.finance.updateRelationship(1,2,{action:'terminate',revision:current.revision,reason:why});
  app.advance(1);app.contracts.publish({version:'ordinary-followup-v1',format:'text',content:Buffer.from('An ordinary follow-up agreement without written reinstatement terms.'),now:app.time()});app.sign();
  for(const input of [{profitSharingPolicy:'settled_period',traderShareBps:1000},{profitSharingPolicy:'cumulative_high_water',traderShareBps:7000},{profitSharingPolicy:policy}])assert.throws(()=>app.create(input),error=>error.code==='RELATIONSHIP_REINSTATEMENT_REQUIRED');
  assert.equal(app.finance.accounts().total,1);assert.equal(app.finance.profitSharing(2).progression.status,'terminated');
 }finally{app.close();}
});

test('legacy written shares remain intact and only supported retained tiers can adopt the new schedule',()=>{
 for(const bps of [5000,6000,7000,6500,8000]){
  const app=fixture();try{
   const original=app.approvals.get(2);app.approvals.set(2,{...original,contractVersion:'legacy-provided-v1',contractHash:'c'.repeat(64)});
   const legacy=app.create({profitSharingPolicy:'cumulative_high_water',traderShareBps:bps});app.approvals.set(2,original);
   if([5000,6000,7000].includes(bps)){const adopted=app.create();assert.equal(adopted.traderShareBps,bps);assert.equal(adopted.progression.cumulativeQualifyingNetPayoutsCents,0);}else assert.throws(()=>app.create(),error=>error.code==='PROGRESSIVE_LEGACY_AMENDMENT_REQUIRED');
   assert.equal(app.finance.accountDetail(legacy.id).account.traderShareBps,bps);assert.equal(app.finance.accountDetail(legacy.id).account.sharingModel,'legacy_fixed');
  }finally{app.close();}
 }
});

test('client statements stay owner-scoped and exclude internal receipt evidence, references, and operator identity',()=>{
 const app=fixture();try{
  const account=app.create();app.receipt(account.id,10000,{externalReference:'private-bank-reference',evidence:'private-admin-evidence',thirdPartyChargesCents:1,chargesAgreementReference:'private-fee-agreement'});
  const own=app.finance.clientView(2),other=app.finance.clientView(3);assert.equal(own.receipts.length,1);assert.equal(other.receipts.length,0);assert.equal(other.progressions.length,0);assert.equal(own.accounts[0].traderFirstName,undefined);
  assert.doesNotMatch(JSON.stringify(own),/private-bank-reference|private-admin-evidence|private-fee-agreement|createdBy|created_by|writtenAgreementReference|recipientAccountDeleted/);
  assert.equal(own.receipts[0].traderShareCents+own.receipts[0].companyShareCents,own.receipts[0].qualifyingNetPayoutCents);
 }finally{app.close();}
});

test('late cleared funds for a closed profile remain externally settleable and are visible to staff without restoring login',()=>{
 const app=fixture();try{
  const account=app.create();app.closeAccount(account);const current=app.finance.profitSharing(2).progression;app.finance.updateRelationship(1,2,{action:'terminate',revision:current.revision,reason:why});
  app.db.exec("CREATE TABLE account_deletions(user_id INTEGER PRIMARY KEY,status TEXT);INSERT INTO account_deletions VALUES(2,'deleted');UPDATE users SET name='Deleted account',email='deleted@deleted.invalid' WHERE id=2;");app.advance(1);
  const result=app.receipt(account.id,10000);assert.equal(result.receipt.recipientAccountDeleted,true);assert.equal(app.finance.processingSummary().closedRecipientReceipts,1);
  assert.throws(()=>app.finance.createClientPayout(2,{accountId:account.id,amountCents:5000,idempotencyKey:randomUUID()}),error=>error.code==='ACCOUNT_DELETED');
  const payout=app.approve(app.payout(account.id,5000)),initiated=app.finance.initiatePayout(1,payout.id,{revision:payout.revision,externalInitiationReference:'actual-lawful-offline-settlement',reason:why}).payout;
  app.finance.updatePayout(1,payout.id,{status:'paid',revision:initiated.revision,externalPaymentReference:'actual-lawful-settlement-completed',reason:why});assert.equal(app.finance.processingSummary().closedRecipientReceipts,0);assert.equal(app.db.prepare('SELECT status FROM account_deletions WHERE user_id=2').get().status,'deleted');
 }finally{app.close();}
});

async function runReceiptWorker(database,approved,time,input){
 const source=`import {parentPort,workerData} from 'node:worker_threads';import {DatabaseSync} from 'node:sqlite';import {createAdminAccess} from ${JSON.stringify(new URL('../admin-access.mjs',import.meta.url).href)};import {createAdminFinance} from ${JSON.stringify(new URL('../admin-finance.mjs',import.meta.url).href)};const db=new DatabaseSync(workerData.database);db.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');try{const access=createAdminAccess(db,{now:()=>workerData.time,ownerEmails:'owner@example.com'});const finance=createAdminFinance(db,{access,now:()=>workerData.time,workflows:{requireApproved(){return workerData.approved;}}});const result=finance.recordClearedReceipt(1,workerData.input.accountId,workerData.input.data);parentPort.postMessage({ok:true,result});}catch(error){parentPort.postMessage({ok:false,status:error.status,message:error.message});}finally{db.close();}`;
 return new Promise((resolve,reject)=>{const worker=new Worker(new URL('data:text/javascript,'+encodeURIComponent(source)),{workerData:{database,approved,time,input}});worker.once('message',resolve);worker.once('error',reject);worker.once('exit',code=>{if(code)reject(new Error('Receipt worker failed'));});});
}
test('independent SQLite writers serialize cross-account threshold progression and same-reference retries',async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'academy-progressive-')),database=path.join(folder,'finance.sqlite'),app=fixture(database);
 try{
  const one=app.create(),two=app.create();app.receipt(one.id,800000);const data={amountReceivedCents:100000,externalReference:'same-retry',clearedAt:app.time(),evidence:'Real cleared reference in concurrency fixture',reason:why};
  const retried=await Promise.all([runReceiptWorker(database,app.approvals.get(2),app.time(),{accountId:one.id,data}),runReceiptWorker(database,app.approvals.get(2),app.time(),{accountId:one.id,data})]);assert.ok(retried.every(item=>item.ok),JSON.stringify(retried));assert.deepEqual(retried.map(item=>item.result.reused).sort(),[false,true]);assert.equal(app.finance.profitSharing(2).progression.cumulativeQualifyingNetPayoutsCents,900000);
  const results=await Promise.all([runReceiptWorker(database,app.approvals.get(2),app.time(),{accountId:one.id,data:{...data,externalReference:'next-one'}}),runReceiptWorker(database,app.approvals.get(2),app.time(),{accountId:two.id,data:{...data,externalReference:'next-two'}})]);assert.ok(results.every(item=>item.ok),JSON.stringify(results));assert.deepEqual(results.map(item=>item.result.receipt.appliedTraderShareBps).sort(),[5000,6000]);assert.equal(app.finance.profitSharing(2).progression.cumulativeQualifyingNetPayoutsCents,1100000);
 }finally{app.close();await rm(folder,{recursive:true,force:true});}
});
