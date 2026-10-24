import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {createSessions} from '../sessions.mjs';
import {createTwoFactor} from '../two-factor.mjs';
import {createCertificates} from '../certificates.mjs';
import {createContracts} from '../contracts.mjs';
import {createLeaderboard} from '../leaderboard.mjs';
import {initializeSupportSchema} from '../support.mjs';
import {createAdminAccess} from '../admin-access.mjs';
import {createAdminWorkflows} from '../admin-workflows.mjs';
import {createAdminFinance} from '../admin-finance.mjs';
import {createPerformanceReports} from '../performance-reports.mjs';
import {createSponsoredSync} from '../sponsored-sync.mjs';
import {createAccountControls,applyAccountDeletionLedger} from '../account-controls.mjs';
import {createAccount} from '../public/simulator.js';
import {installProvidedAgreement} from '../agreement.mjs';

const time=Date.UTC(2026,9,22,10),confirmation={confirmation:'DELETE MY ACCOUNT'};
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
 let clock=time;
 const db=new DatabaseSync(':memory:');
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,market TEXT NOT NULL,password TEXT NOT NULL,created_at INTEGER NOT NULL,first_name TEXT NOT NULL DEFAULT '',other_names TEXT NOT NULL DEFAULT '',email_confirmation_required INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE accounts(user_id INTEGER PRIMARY KEY REFERENCES users(id),state TEXT NOT NULL);
 CREATE TABLE events(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE notification_preferences(user_id INTEGER PRIMARY KEY REFERENCES users(id),email_enabled INTEGER NOT NULL DEFAULT 0,verified INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE push_subscriptions(endpoint TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),subscription TEXT NOT NULL);
 CREATE TABLE email_verifications(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL,purpose TEXT NOT NULL DEFAULT 'notifications');
 CREATE TABLE notification_outbox(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),notice_key TEXT NOT NULL,channel TEXT NOT NULL,target TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'pending',attempts INTEGER NOT NULL DEFAULT 0,next_at INTEGER NOT NULL,UNIQUE(user_id,notice_key,channel,target));
 CREATE TABLE password_resets(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL,created_at INTEGER NOT NULL);
 CREATE TABLE password_reset_requests(email_hash TEXT PRIMARY KEY,next_at INTEGER NOT NULL,window_start INTEGER NOT NULL,attempts INTEGER NOT NULL);
 INSERT INTO users(id,email,name,market,password,created_at,first_name,other_names) VALUES
 (1,'owner@example.com','Owner Operator','I trade both','owner-private-password-hash',1,'Owner','Operator'),
 (2,'ada@example.com','Ada Trader','I trade forex','ada-private-password-hash',2,'Ada','Trader'),
 (3,'other@example.com','Other Customer','I trade crypto','other-private-password-hash',3,'Other','Customer'),
 (4,'reviewer@example.com','Former Reviewer','I trade both','reviewer-private-password-hash',4,'Former','Reviewer');
 INSERT INTO notification_preferences VALUES(1,0,1),(2,1,1),(3,0,1),(4,0,1);`);
 const sessions=createSessions(db,{now:()=>clock});
 createTwoFactor(db,'/tmp/unused-controls.sqlite',{now:()=>clock,encryptionKey:Buffer.alloc(32,7).toString('base64')});
 for(const id of [1,2,3,4])db.prepare('INSERT INTO two_factor(user_id,secret,enabled_at) VALUES (?,?,?)').run(id,`private-factor-secret-${id}`,time);
 const certificates=createCertificates(db),contracts=createContracts(db),leaderboard=createLeaderboard(db,{now:()=>clock});
 initializeSupportSchema(db);
 const access=createAdminAccess(db,{now:()=>clock,ownerEmails:'owner@example.com'});
 const workflows=createAdminWorkflows(db,{access,contracts,leaderboard,now:()=>clock});
 const approval={userId:2,reviewId:randomUUID(),reviewRevision:1,certificateId:randomUUID(),contractId:randomUUID(),contractVersion:'fixture-v1',contractHash:'a'.repeat(64),signatureId:randomUUID()};
 const approvals=new Map([[2,approval]]);
 const finance=createAdminFinance(db,{access,now:()=>clock,workflows:{requireApproved(id){const approved=approvals.get(id);assert.ok(approved,'a fixture sponsorship approval is required');return {...approved};}}});
 createPerformanceReports(db,{now:()=>clock});
 let failClosedAudit=false;
 const guarded={context:access.context,audit(...args){if(failClosedAudit&&args[1]==='account.closed')throw new Error('Isolated audit failure');return access.audit(...args);}};
 const controls=createAccountControls(db,{access:guarded,now:()=>clock});
 for(const id of [1,2,3,4])db.prepare('INSERT INTO accounts(user_id,state) VALUES (?,?)').run(id,JSON.stringify(createAccount(time)));
 function allocation(overrides={}){return finance.createAccount(1,{userId:2,firmName:'Fixture Prop Firm',label:'Fixture external allocation',accountSizeCents:1000000,traderShareBps:7000,profitSharingPolicy:'cumulative_high_water',evidence:'Isolated external receipt reference',reason:'Record an isolated allocation',...overrides}).account;}
 function progressiveAllocation(userId=2,overrides={}){
  const state=createAccount(clock);state.balance=11000;state.locked='Profit target achieved';state.tradingDays=['2026-10-19','2026-10-20','2026-10-21'];
  const certificate=certificates.issue(userId,state,clock);
  const document=installProvidedAgreement(contracts,{now:clock});
  const signed=contracts.sign(userId,{contractId:document.id,contractVersion:document.version,contractHash:document.hash,legalName:userId===2?'Ada Legal Trader':'Other Legal Trader',consent:true},clock);
  const revised={...approval,userId,certificateId:certificate?.id??signed.signature.certificateId,contractId:document.id,contractVersion:document.version,contractHash:document.hash,signatureId:signed.signature.id};
  if(userId===2)Object.assign(approval,revised);else approvals.set(userId,revised);
  return allocation({userId,label:`Progressive allocation ${userId}`,traderShareBps:5000,profitSharingPolicy:'progressive_cleared',...overrides});
 }
 function seedPrivate(){
  const own='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
  db.prepare('INSERT INTO support_conversations(id,owner_user_id,status,created_at,updated_at) VALUES (?,2,\'ai\',?,?),(?,3,\'ai\',?,?)').run(own,time,time,other,time,time);
  db.prepare("INSERT INTO support_messages(id,conversation_id,author_user_id,role,content,source,created_at) VALUES (1,?,2,'user','My private customer message','client',?),(2,?,1,'agent','An authorized reply','staff',?),(3,?,3,'user','OTHER_CUSTOMER_PRIVATE_MESSAGE','client',?)").run(own,time,own,time,other,time);
  db.prepare('UPDATE support_messages SET reply_to_message_id=1 WHERE id=2').run();
  db.prepare('INSERT INTO support_audit(conversation_id,actor_user_id,action,detail,created_at) VALUES (?,2,\'message\',\'{}\',?)').run(own,time);
  sessions.create(2,'a'.repeat(64),{userAgent:'Mozilla private device'});
  db.exec(`CREATE TABLE account_tool_privileges(token TEXT REFERENCES sessions(token) ON DELETE CASCADE,user_id INTEGER REFERENCES users(id),purpose TEXT,fingerprint TEXT,expires INTEGER);
    INSERT INTO account_tool_privileges VALUES('${'a'.repeat(64)}',2,'export','private-fingerprint',${time+60000});`);
  db.prepare('INSERT INTO two_factor_recovery_codes VALUES (?,?,?)').run(2,'private-recovery-code-hash',time);
  db.prepare('INSERT INTO two_factor_challenges(token,user_id,password_fingerprint,version,expires) VALUES (?,2,?,0,?)').run('private-login-challenge','private-password-fingerprint',time+60000);
  db.prepare('INSERT INTO password_resets VALUES (?,2,?,?)').run('private-reset-token',time+60000,time);
  db.prepare('INSERT INTO password_reset_requests VALUES (?,?,?,1)').run(hash('ada@example.com'),time+60000,time);
  db.prepare('INSERT INTO email_verifications VALUES (?,2,?,\'account\')').run('private-email-token',time+60000);
  db.prepare('INSERT INTO push_subscriptions VALUES (?,2,?)').run('https://push.example/private-endpoint',JSON.stringify({keys:{auth:'private-push-secret'}}));
  db.prepare('INSERT INTO notification_outbox(user_id,notice_key,channel,target,payload,next_at) VALUES (2,\'fixture\',\'verify\',\'ada@example.com\',?,?)').run(JSON.stringify({text:'private verification URL token'}),time);
  db.prepare('INSERT INTO leaderboard_profiles VALUES (2,?,1,\'AdaAlias\',\'adaalias\',?)').run(randomUUID(),time);
  const point=JSON.stringify({time,balance:10000,equity:10000});db.prepare('INSERT INTO performance_assessment_snapshots VALUES (2,\'attempt\',?,?,?,?,?)').run(time,point,point,point,point);
  return {own,other};
 }
 return {db,access,workflows,controls,finance,certificates,contracts,sessions,allocation,progressiveAllocation,seedPrivate,approval,advance(ms){clock+=ms;},time:()=>clock,failAudit(value){failClosedAudit=value;},close(){db.close();}};
}

test('personal export uses allowlisted own records and never exports authentication, delivery secrets, staff identities, or internal notes',()=>{
 const app=fixture();try{
  app.seedPrivate();app.workflows.appendNote(1,2,{text:'INTERNAL_ADJUDICATION_NOTE',reason:'Record a private reviewer note'});
  const exported=app.controls.exportData(2),serialized=JSON.stringify(exported);
  assert.equal(exported.profile.email,'ada@example.com');assert.equal(exported.preferences.security.twoFactorEnabled,true);
  assert.equal(exported.sections.supportMessages.items.length,2);assert.equal(exported.sections.assessmentEquityObservations.items.length,1);
  assert.equal(exported.sections.sessions.items.length,1);assert.equal(exported.sections.notificationDelivery.items.length,1);
  for(const privateValue of ['ada-private-password-hash','private-factor-secret','private-recovery-code-hash','private-login-challenge','private-reset-token','private-email-token','private-fingerprint','private-endpoint','private-push-secret','private verification URL token','INTERNAL_ADJUDICATION_NOTE','owner@example.com','OTHER_CUSTOMER_PRIVATE_MESSAGE'])assert.ok(!serialized.includes(privateValue),privateValue);
  assert.equal(exported.complete,true);assert.equal(exported.nextOffset,null);
  const other=app.controls.exportData(3);assert.equal(other.sections.supportMessages.items.length,1);assert.equal(other.profile.email,'other@example.com');assert.ok(!JSON.stringify(other).includes('My private customer message'));
 }finally{app.close();}
});

test('export follows bounded pages across current and archived trades without silently truncating a dataset',()=>{
 const app=fixture();try{
  const state=createAccount(time);state.history=Array.from({length:5},(_,id)=>({id,profit:id,closedAt:time+id,credential:'secret must be removed'}));
  app.db.prepare('UPDATE accounts SET state=? WHERE user_id=2').run(JSON.stringify(state));
  app.db.prepare('INSERT INTO events(user_id,kind,detail,created_at) VALUES (2,\'reset-archive\',?,?)').run(JSON.stringify({...state,history:[{id:99,profit:10,password:'private-archive-password'}]}),time);
  const accumulated=[];let offset=0,pages=0;
  do{const page=app.controls.exportData(2,{limit:2,offset});accumulated.push(...page.sections.assessmentTrades.items);assert.ok(page.sections.assessmentTrades.items.length<=2);offset=page.nextOffset;pages++;assert.ok(pages<10);}while(offset!==null);
  assert.deepEqual(accumulated.map(row=>row.id),[0,1,2,3,4]);assert.equal(pages,3);
  const exported=app.controls.exportData(2,{limit:2});assert.equal(exported.complete,false);assert.equal(exported.sections.archivedTrades.items[0].record.id,99);assert.ok(!JSON.stringify(exported).includes('private-archive-password'));assert.ok(!JSON.stringify(exported).includes('secret must be removed'));
  for(const bad of [{limit:0},{limit:1001},{limit:'1e2'},{offset:-1},{offset:[]},{limit:null}])assert.throws(()=>app.controls.exportData(2,bad),error=>error.status===400);
  for(const id of [0,-1,'2',NaN,'2 OR 1=1'])assert.throws(()=>app.controls.exportData(id),error=>error.status===400);
 }finally{app.close();}
});

test('confirmed closure removes operational personal data and authentication while preserving a nonlogin tombstone and private deletion receipt',()=>{
 const app=fixture();try{
  app.seedPrivate();assert.throws(()=>app.controls.requestDeletion(2,{confirmation:'DELETE'}),error=>error.status===400);assert.equal(app.controls.requests().total,0);
  const result=app.controls.requestDeletion(2,confirmation);
  assert.equal(result.status,'deleted');assert.equal(result.accountDeleted,true);assert.equal(result.signedOut,true);assert.match(result.retentionNotice,/not a claim that all personal data/);
  const user=app.db.prepare('SELECT * FROM users WHERE id=2').get();assert.equal(user.name,'Deleted account');assert.notEqual(user.email,'ada@example.com');assert.match(user.email,/^deleted\.[a-f0-9-]+@deleted\.invalid$/);assert.notEqual(user.password,'ada-private-password-hash');assert.equal(user.certificate_nickname,'');assert.equal(user.market,'');
  for(const table of ['accounts','events','sessions','account_tool_privileges','two_factor','two_factor_recovery_codes','two_factor_challenges','password_resets','email_verifications','push_subscriptions','notification_outbox','notification_preferences','leaderboard_profiles','performance_assessment_snapshots'])assert.equal(app.db.prepare(`SELECT count(*) n FROM ${table} WHERE user_id=2`).get().n,0,table);
  assert.equal(app.db.prepare('SELECT count(*) n FROM password_reset_requests WHERE email_hash=?').get(hash('ada@example.com')).n,0);
  assert.equal(app.db.prepare('SELECT count(*) n FROM support_messages').get().n,1);assert.equal(app.db.prepare('SELECT owner_user_id FROM support_conversations').get().owner_user_id,3);
  assert.equal(app.controls.isDeleted(2),true);assert.equal(app.controls.isDeleted(3),false);assert.throws(()=>app.controls.exportData(2),error=>error.status===410);assert.throws(()=>app.controls.cancelDeletion(2),error=>error.status===409);
  assert.equal(app.controls.requestDeletion(2,confirmation).requestId,result.requestId);assert.equal(app.db.prepare('PRAGMA foreign_key_check').all().length,0);
  assert.throws(()=>app.db.exec('DELETE FROM account_deletions WHERE user_id=2'),/immutable/);assert.throws(()=>app.db.exec("UPDATE account_deletions SET receipt='{}' WHERE user_id=2"),/immutable/);
 }finally{app.close();}
});

test('owner and explicit staff assignments hold closure pending without removing login or inventing completed deletion',()=>{
 const app=fixture();try{
  const owner=app.controls.requestDeletion(1,confirmation);assert.equal(owner.status,'pending_closure');assert.equal(owner.accountDeleted,false);assert.ok(owner.blockers.some(row=>row.code==='STAFF_ACCESS_ASSIGNED'));assert.equal(app.controls.isDeleted(1),false);assert.equal(app.db.prepare('SELECT email FROM users WHERE id=1').get().email,'owner@example.com');
  app.access.grant(1,4,'reviewer','Assign review responsibilities');const staff=app.controls.requestDeletion(4,confirmation);assert.equal(staff.status,'pending_closure');app.access.revoke(1,4,'Staff assignment ended');assert.equal(app.controls.completeDeletion(4).status,'deleted');
  const requests=app.controls.requests({status:'all',limit:1});assert.equal(requests.total,2);assert.equal(requests.items.length,1);assert.equal(requests.nextOffset,1);
  assert.equal(app.controls.cancelDeletion(1).status,'active');assert.equal(app.controls.requests().total,0);
  for(const bad of [{limit:'1e2'},{offset:[]},{status:'other'}])assert.throws(()=>app.controls.requests(bad),error=>error.status===400);
 }finally{app.close();}
});

test('open allocations and unsettled profit prevent closure; pending users can request settlement before completion',()=>{
 const app=fixture();try{
  const account=app.allocation();app.finance.recordStatement(1,account.id,{netProfitCents:10000,externalReference:'fixture-profit',evidence:'Verified external fixture statement',reason:'Record a verified profit statement'});
  let result=app.controls.requestDeletion(2,confirmation);assert.equal(result.status,'pending_closure');assert.ok(result.blockers.some(row=>row.code==='SPONSORED_ACCOUNT_OPEN'));assert.ok(result.blockers.some(row=>row.code==='EARNED_SHARE_UNSETTLED'));
  const request=app.finance.createClientPayout(2,{accountId:account.id,amountCents:7000,idempotencyKey:randomUUID()});assert.equal(request.payout.status,'requested');
  result=app.controls.completeDeletion(2);assert.ok(result.blockers.some(row=>row.code==='PAYOUT_PENDING'));
  app.finance.updatePayout(1,request.payout.id,{status:'approved',revision:1,reason:'Approve the fixture payout'});app.finance.updatePayout(1,request.payout.id,{status:'paid',revision:2,externalPaymentReference:'fixture-transfer',reason:'Record the external fixture payment'});
  app.finance.updateAccount(1,account.id,{status:'closed',revision:1,reason:'External allocation closed'});
  result=app.controls.completeDeletion(2);assert.equal(result.status,'deleted');assert.ok(result.retained.some(row=>row.category==='financial_records'));
  assert.equal(app.finance.accountDetail(account.id).payouts[0].status,'paid');assert.throws(()=>app.db.prepare('DELETE FROM sponsored_accounts WHERE id=?').run(account.id),/cannot be deleted/);
 }finally{app.close();}
});

test('progressive receipts and continuous contractual rights block closure until explicitly terminated and fully paid',()=>{
 const app=fixture();try{
  app.seedPrivate();const account=app.progressiveAllocation();
  const received=app.finance.recordClearedReceipt(1,account.id,{amountReceivedCents:1000000,externalReference:'private-bank-cleared-001',clearedAt:app.time(),evidence:'Private bank reconciliation evidence',reason:'Record actual cleared firm payout'});
  assert.equal(received.receipt.traderShareCents,500000);assert.equal(received.progression.currentTraderShareBps,6000);
  app.finance.updateAccount(1,account.id,{status:'closed',revision:account.revision,reason:'Close the external sponsored account'});
  let pending=app.controls.requestDeletion(2,confirmation);
  assert.equal(pending.status,'pending_closure');assert.equal(pending.signedOut,false);
  assert.ok(pending.blockers.some(item=>item.code==='PROGRESSIVE_RELATIONSHIP_ACTIVE'));
  assert.ok(pending.blockers.some(item=>item.code==='EARNED_SHARE_UNSETTLED'));
  const ownAccount=app.controls.exportData(2).sections.sponsoredAccounts.items[0];assert.equal(ownAccount.profitSharingPolicy,'progressive_cleared');assert.equal(ownAccount.recordedTraderShareBps,5000);assert.equal(ownAccount.traderShareBps,6000);assert.equal(ownAccount.currentTraderShareBps,6000);
  assert.equal(app.db.prepare('SELECT count(*) n FROM sessions WHERE user_id=2').get().n,1);
  app.finance.updateRelationship(1,2,{action:'terminate',revision:received.progression.revision,reason:'End the contractual relationship before requested closure'});
  const request=app.finance.createClientPayout(2,{accountId:account.id,amountCents:500000,idempotencyKey:randomUUID()});
  const approved=app.finance.updatePayout(1,request.payout.id,{status:'approved',revision:request.payout.revision,reason:'Approve cleared earned share for external payment'});
  const initiated=app.finance.initiatePayout(1,request.payout.id,{revision:approved.payout.revision,externalInitiationReference:'private-bank-initiation-001',reason:'Record actual external payment initiation'});
  pending=app.controls.completeDeletion(2);assert.equal(pending.status,'pending_closure');assert.ok(pending.blockers.some(item=>item.code==='PAYOUT_PENDING'));assert.ok(pending.blockers.some(item=>item.code==='EARNED_SHARE_UNSETTLED'));
  app.finance.updatePayout(1,request.payout.id,{status:'paid',revision:initiated.payout.revision,externalPaymentReference:'private-bank-payment-001',reason:'Record completed external payment'});
  const snapshot=Object.fromEntries(['progressive_relationships','progressive_account_links','progressive_receipts','progressive_payout_allocations','progressive_payout_initiations','progressive_relationship_events'].map(table=>[table,app.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
  const financialCount=Object.values(snapshot).reduce((count,rows)=>count+rows.length,0)+['sponsored_accounts','sponsored_statements','sponsored_payouts','sponsored_client_payout_requests'].reduce((count,table)=>count+app.db.prepare(`SELECT count(*) n FROM ${table} WHERE user_id=2`).get().n,0)+app.db.prepare('SELECT count(*) n FROM sponsored_payout_events WHERE payout_id=?').get(request.payout.id).n;
  const completed=app.controls.completeDeletion(2);assert.equal(completed.status,'deleted');assert.equal(completed.signedOut,true);
  assert.equal(completed.retained.find(item=>item.category==='financial_records').recordCount,financialCount);
  assert.doesNotMatch(JSON.stringify(completed),/private-bank|Private bank|Ada Legal Trader/);
  for(const [table,rows]of Object.entries(snapshot))assert.deepEqual(app.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all(),rows,table);
  assert.equal(app.db.prepare('SELECT current_tier_bps,status FROM progressive_relationships WHERE user_id=2').get().current_tier_bps,6000);
  assert.equal(app.db.prepare('SELECT count(*) n FROM sessions WHERE user_id=2').get().n,0);assert.equal(app.db.prepare('PRAGMA foreign_key_check').all().length,0);
  for(const table of ['progressive_receipts','progressive_payout_allocations','progressive_payout_initiations','progressive_relationship_events'])assert.throws(()=>app.db.exec(`DELETE FROM ${table}`),/immutable/,table);
 }finally{app.close();}
});

test('an active progressive relationship alone prevents implicit loss of retained tier rights during deletion',()=>{
 const app=fixture();try{
  const account=app.progressiveAllocation();app.finance.updateAccount(1,account.id,{status:'closed',revision:account.revision,reason:'Close the account without ending sponsorship'});
  const pending=app.controls.requestDeletion(2,confirmation);assert.equal(pending.status,'pending_closure');assert.deepEqual(pending.blockers.map(item=>item.code),['PROGRESSIVE_RELATIONSHIP_ACTIVE']);
  const relation=app.finance.profitSharing(2).progression;app.finance.updateRelationship(1,2,{action:'terminate',revision:relation.revision,reason:'Formally end the sponsored contractual relationship'});
  assert.equal(app.controls.completeDeletion(2).status,'deleted');
 }finally{app.close();}
});

test('late cleared funds remain payable from retained records without restoring a closed customer profile',()=>{
 const app=fixture();try{
  const account=app.progressiveAllocation();app.finance.updateAccount(1,account.id,{status:'closed',revision:account.revision,reason:'Close the sponsored allocation'});
  app.finance.updateRelationship(1,2,{action:'terminate',revision:app.finance.profitSharing(2).progression.revision,reason:'End the sponsored contractual relationship'});
  assert.equal(app.controls.requestDeletion(2,confirmation).status,'deleted');const user=app.db.prepare('SELECT name,email,password FROM users WHERE id=2').get();
  app.advance(60000);
  const receipt=app.finance.recordClearedReceipt(1,account.id,{amountReceivedCents:10000,externalReference:'late-external-bank-receipt',clearedAt:app.time(),evidence:'Firm payout cleared after account closure',reason:'Preserve the company obligation for late cleared funds'});
  assert.equal(receipt.receipt.traderShareCents,5000);assert.equal(receipt.progression.status,'terminated');
  assert.equal(app.controls.isDeleted(2),true);assert.deepEqual(app.db.prepare('SELECT name,email,password FROM users WHERE id=2').get(),user);
  assert.throws(()=>app.finance.createClientPayout(2,{accountId:account.id,amountCents:5000,idempotencyKey:randomUUID()}),error=>error.status===403);
  const requested=app.finance.createPayout(1,{accountId:account.id,amountCents:5000,reason:'Reserve late accrued entitlement for external settlement'});
  const approved=app.finance.updatePayout(1,requested.payout.id,{status:'approved',revision:requested.payout.revision,reason:'Approve manual settlement from retained financial records'});
  const initiated=app.finance.initiatePayout(1,requested.payout.id,{revision:approved.payout.revision,externalInitiationReference:'late-closed-customer-initiation',reason:'Record actual initiation to the former customer'});
  app.finance.updatePayout(1,requested.payout.id,{status:'paid',revision:initiated.payout.revision,externalPaymentReference:'late-closed-customer-completion',reason:'Record external completion of accrued entitlement'});
  assert.equal(app.finance.accountDetail(account.id).account.availableCents,0);assert.equal(app.finance.accountDetail(account.id).account.paidCents,5000);
  assert.equal(app.controls.isDeleted(2),true);assert.equal(app.db.prepare('SELECT count(*) n FROM sessions WHERE user_id=2').get().n,0);assert.equal(app.db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{app.close();}
});

test('own exports fully page progressive statements, relationships and payment evidence without leaking internal data',()=>{
 const app=fixture();try{
  const account=app.progressiveAllocation(),other=app.progressiveAllocation(3);const receiptIds=[];
  for(let index=0;index<3;index++){
   const recorded=app.finance.recordClearedReceipt(1,account.id,{amountReceivedCents:11000,thirdPartyChargesCents:1000,externalReference:`PRIVATE_COMPANY_BANK_RECEIPT_${index}`,chargesAgreementReference:'PRIVATE_FEE_AGREEMENT_REFERENCE',clearedAt:app.time(),evidence:'PRIVATE_FINANCE_RECONCILIATION_NOTES',reason:'Record reconciled cleared funds'});receiptIds.push(recorded.receipt.id);
  }
  app.finance.recordClearedReceipt(1,other.id,{amountReceivedCents:99000,externalReference:'OTHER_CUSTOMER_BANK_RECEIPT',clearedAt:app.time(),evidence:'OTHER_CUSTOMER_PRIVATE_EVIDENCE',reason:'Record other customer cleared funds'});
  const requested=app.finance.createClientPayout(2,{accountId:account.id,amountCents:15000,idempotencyKey:randomUUID()});
  const approved=app.finance.updatePayout(1,requested.payout.id,{status:'approved',revision:requested.payout.revision,reason:'PRIVATE_STAFF_APPROVAL_REASON'});
  app.finance.initiatePayout(1,requested.payout.id,{revision:approved.payout.revision,externalInitiationReference:'PRIVATE_BANK_INITIATION_REFERENCE',reason:'PRIVATE_STAFF_INITIATION_REASON'});
  app.finance.updateAccount(1,account.id,{status:'closed',revision:account.revision,reason:'Close the sponsored account for contract termination'});
  app.finance.updateRelationship(1,2,{action:'terminate',revision:app.finance.profitSharing(2).progression.revision,reason:'PRIVATE_RELATIONSHIP_TERMINATION_REASON'});
  const collected={},pages=[];let offset=0,fingerprint;
  for(let n=0;n<20;n++){
   const page=app.controls.exportData(2,{limit:1,offset,...(fingerprint?{fingerprint}:{})});fingerprint??=page.fingerprint;assert.equal(page.fingerprint,fingerprint);pages.push(page);
   for(const [name,section]of Object.entries(page.sections)){collected[name]??=[];collected[name].push(...section.items);}
   if(page.complete){assert.equal(page.nextOffset,null);break;}offset=page.nextOffset;
  }
  assert.equal(pages.at(-1).complete,true);assert.deepEqual(collected.qualifyingPayoutReceipts.map(row=>row.id),receiptIds);
  assert.equal(collected.profitSharingRelationships.length,1);assert.equal(collected.profitSharingRelationships[0].status,'terminated');
  assert.equal(collected.profitSharingAccountLinks.length,1);assert.equal(collected.payoutReceiptAllocations.length,3);assert.equal(collected.paymentInitiations.length,1);assert.equal(collected.profitSharingHistory.length,1);
  const exportedAccount=collected.sponsoredAccounts[0];assert.equal(exportedAccount.sharingModel,'progressive_cleared');assert.equal(exportedAccount.profitSharingPolicy,'progressive_cleared');assert.equal(exportedAccount.recordedTraderShareBps,5000);
  for(const receipt of collected.qualifyingPayoutReceipts){assert.equal(receipt.amountReceivedCents-receipt.thirdPartyChargesCents,receipt.qualifyingNetPayoutCents);assert.equal(receipt.traderShareCents+receipt.companyShareCents,receipt.qualifyingNetPayoutCents);assert.equal(receipt.appliedTraderShareBps,5000);assert.ok(Number.isSafeInteger(receipt.initiationDueAt));}
  const serialized=JSON.stringify(pages);for(const secret of ['PRIVATE_COMPANY_BANK','PRIVATE_FEE_AGREEMENT','PRIVATE_FINANCE','PRIVATE_STAFF','PRIVATE_BANK_INITIATION','PRIVATE_RELATIONSHIP','OTHER_CUSTOMER','owner@example.com','created_by','actor_user_id','written_agreement_reference'])assert.ok(!serialized.includes(secret),secret);
  app.finance.recordClearedReceipt(1,other.id,{amountReceivedCents:1,externalReference:'another-other-customer-receipt',clearedAt:app.time(),evidence:'Other private reconciliation',reason:'Record another actual receipt'});
  assert.equal(app.controls.exportData(2,{limit:1,offset:1,fingerprint}).fingerprint,fingerprint,'another customer cannot invalidate this account’s export');
  app.finance.recordClearedReceipt(1,account.id,{amountReceivedCents:1,externalReference:'later-owned-receipt',clearedAt:app.time(),evidence:'Owned reconciliation record',reason:'Record another actual receipt'});
  assert.throws(()=>app.controls.exportData(2,{limit:1,offset:1,fingerprint}),error=>error.code==='ACCOUNT_EXPORT_CHANGED');
 }finally{app.close();}
});

test('a newer deletion ledger preserves progressive legal records without resurrecting an old profile',()=>{
 const app=fixture();try{
  const account=app.progressiveAllocation();app.finance.updateAccount(1,account.id,{status:'closed',revision:account.revision,reason:'Close the sponsored allocation'});
  app.finance.updateRelationship(1,2,{action:'terminate',revision:app.finance.profitSharing(2).progression.revision,reason:'Formally end the sponsored relationship'});
  app.controls.requestDeletion(2,confirmation);const ledger=app.controls.exportDeletionLedger();
  const relationships=app.db.prepare('SELECT * FROM progressive_relationships').all(),signatures=app.db.prepare('SELECT * FROM contract_signatures WHERE user_id=2').all();
  app.db.prepare("UPDATE users SET email='resurrected-private@example.com',name='Resurrected Private Name',first_name='Resurrected',password='private-resurrected-password' WHERE id=2").run();
  app.db.prepare('INSERT INTO accounts VALUES(2,?)').run(JSON.stringify(createAccount(time)));app.sessions.create(2,'b'.repeat(64));
  assert.equal(applyAccountDeletionLedger(app.db,ledger).replayed,0);
  const user=app.db.prepare('SELECT email,name,password FROM users WHERE id=2').get();assert.equal(user.name,'Deleted account');assert.match(user.email,/@deleted\.invalid$/);assert.match(user.password,/^!deleted:/);
  assert.equal(app.db.prepare('SELECT count(*) n FROM sessions WHERE user_id=2').get().n,0);assert.equal(app.db.prepare('SELECT count(*) n FROM accounts WHERE user_id=2').get().n,0);
  assert.deepEqual(app.db.prepare('SELECT * FROM progressive_relationships').all(),relationships);assert.deepEqual(app.db.prepare('SELECT * FROM contract_signatures WHERE user_id=2').all(),signatures);
  assert.equal(app.db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{app.close();}
});

test('immutable signature snapshots and restricted notes survive closure, while certificate names and mutable profiles are removed',()=>{
 const app=fixture();try{
  const state=createAccount(time);state.balance=11000;state.locked='Profit target achieved';state.tradingDays=['2026-10-01','2026-10-02','2026-10-03'];const certificate=app.certificates.issue(2,state,time);
  const document=app.contracts.publish({content:Buffer.from('Isolated contract fixture.'),format:'text',version:'fixture-v1',now:time});app.contracts.sign(2,{contractId:document.id,contractVersion:document.version,contractHash:document.hash,legalName:'Ada Legal Trader',consent:true},time);
  app.workflows.appendNote(1,2,{text:'Restricted review context',reason:'Record reviewer context'});
  const signed=app.db.prepare('SELECT * FROM contract_signatures WHERE user_id=2').get();const result=app.controls.requestDeletion(2,confirmation);
  assert.ok(result.retained.some(row=>row.category==='signed_agreements'));assert.ok(result.retained.some(row=>row.category==='administration_records'));assert.equal(app.db.prepare('SELECT holder FROM certificates WHERE id=?').get(certificate.id).holder,'Deleted account');assert.deepEqual(app.db.prepare('SELECT * FROM contract_signatures WHERE user_id=2').get(),signed);
  assert.throws(()=>app.db.prepare('DELETE FROM contract_signatures WHERE user_id=2').run(),/immutable/);assert.equal(app.workflows.notes(2).entries[0].text,'Restricted review context');
  assert.ok(!JSON.stringify(result).includes('Ada Legal Trader'));assert.ok(!JSON.stringify(result).includes('Restricted review context'));assert.equal(app.db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{app.close();}
});

test('private agreement exports page only the recipient’s metadata and assignment history, and closure counts unsigned retained records',()=>{
 const app=fixture();try{
  app.contracts.publish({content:Buffer.from('GLOBAL_CONTRACT_BYTES'),format:'text',version:'global-privacy-fixture',title:'Academy agreement',now:app.time()});
  const publish=(userId,version)=>app.contracts.publish({content:Buffer.from(`PRIVATE_RAW_CONTRACT_BYTES_${version}`),format:'text',version,title:`Recipient ${userId} agreement ${version}`,recipientUserId:userId,now:app.time()});
  const first=publish(2,'own-private-v1');app.advance(1);const second=publish(2,'own-private-v2');const other=publish(3,'OTHER_RECIPIENT_PRIVATE_V1');
  const initial=app.controls.exportData(2,{limit:1});
  assert.equal(initial.sections.agreements.total,0,'unsigned assigned documents still belong in the personal export');
  assert.equal(initial.sections.personalAgreementDocuments.total,2);assert.equal(initial.sections.personalAgreementHistory.total,2);
  assert.deepEqual(initial.sections.personalAgreementRequirement.items.map(item=>({...item})),[{contractId:second.id,scope:'personal'}]);
  const following=app.controls.exportData(2,{limit:1,offset:1,fingerprint:initial.fingerprint});
  assert.deepEqual([...initial.sections.personalAgreementDocuments.items,...following.sections.personalAgreementDocuments.items].map(item=>item.id),[first.id,second.id]);
  assert.deepEqual([...initial.sections.personalAgreementHistory.items,...following.sections.personalAgreementHistory.items].map(item=>item.contractId),[first.id,second.id]);
  const exported=initial.sections.personalAgreementDocuments.items[0];assert.equal(exported.title,first.title);assert.equal(exported.hash,first.hash);assert.equal(exported.version,first.version);assert.equal(exported.publishedAt,first.publishedAt);assert.equal(exported.scope,'personal');
  for(const value of ['PRIVATE_RAW_CONTRACT_BYTES','GLOBAL_CONTRACT_BYTES','OTHER_RECIPIENT_PRIVATE',other.id])assert.ok(!JSON.stringify([initial,following]).includes(value),value);
  const otherExport=app.controls.exportData(3);assert.equal(otherExport.sections.personalAgreementDocuments.total,1);assert.equal(otherExport.sections.personalAgreementRequirement.items[0].contractId,other.id);assert.ok(!JSON.stringify(otherExport).includes(first.id));
  publish(3,'OTHER_RECIPIENT_PRIVATE_V2');assert.equal(app.controls.exportData(2,{limit:1,offset:1,fingerprint:initial.fingerprint}).fingerprint,initial.fingerprint);
  const third=publish(2,'own-private-v3');assert.throws(()=>app.controls.exportData(2,{limit:1,offset:1,fingerprint:initial.fingerprint}),error=>error.code==='ACCOUNT_EXPORT_CHANGED');
  const documents=app.db.prepare('SELECT * FROM contract_documents WHERE recipient_user_id=2 ORDER BY published_at,id').all();
  const history=app.db.prepare('SELECT * FROM contract_publication_events WHERE contract_id IN (SELECT id FROM contract_documents WHERE recipient_user_id=2) ORDER BY id').all();
  const pointer=app.db.prepare('SELECT * FROM user_active_contract WHERE user_id=2').get();assert.equal(pointer.contract_id,third.id);
  const closed=app.controls.requestDeletion(2,confirmation);assert.equal(closed.status,'deleted');assert.equal(closed.retained.find(item=>item.category==='personal_agreement_records').recordCount,7);
  assert.match(closed.retentionNotice,/private agreement documents and assignment history/);assert.ok(!JSON.stringify(closed).includes('Recipient 2'));
  app.db.prepare("UPDATE users SET first_name='Restored',name='Restored Person',email='restored@example.com' WHERE id=2").run();applyAccountDeletionLedger(app.db,app.controls.exportDeletionLedger());
  assert.equal(app.db.prepare('SELECT first_name FROM users WHERE id=2').get().first_name,'Deleted');assert.equal(app.db.prepare('SELECT count(*) n FROM sessions WHERE user_id=2').get().n,0);
  assert.deepEqual(app.db.prepare('SELECT * FROM contract_documents WHERE recipient_user_id=2 ORDER BY published_at,id').all(),documents);assert.deepEqual(app.db.prepare('SELECT * FROM contract_publication_events WHERE contract_id IN (SELECT id FROM contract_documents WHERE recipient_user_id=2) ORDER BY id').all(),history);assert.deepEqual(app.db.prepare('SELECT * FROM user_active_contract WHERE user_id=2').get(),pointer);
  assert.equal(app.db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{app.close();}
});

test('closure is atomic with caller security transactions, failed revocation, and failed audit writes',()=>{
 const app=fixture();try{
  app.seedPrivate();const before=app.db.prepare('SELECT email,password FROM users WHERE id=2').get();
  assert.throws(()=>app.controls.requestDeletion(2,confirmation,{onRevoke(){throw new Error('Revocation failed');}}),/Revocation failed/);assert.equal(app.controls.requests().total,0);assert.deepEqual(app.db.prepare('SELECT email,password FROM users WHERE id=2').get(),before);
  assert.throws(()=>app.controls.requestDeletion(2,confirmation,{onRevoke(){return Promise.resolve();}}),/must be synchronous/);assert.equal(app.controls.isDeleted(2),false);
  app.failAudit(true);assert.throws(()=>app.controls.requestDeletion(2,confirmation),/Isolated audit failure/);app.failAudit(false);assert.equal(app.controls.requests().total,0);assert.equal(app.db.prepare('SELECT count(*) n FROM accounts WHERE user_id=2').get().n,1);
  app.db.exec('BEGIN IMMEDIATE');assert.equal(app.controls.requestDeletion(2,confirmation).status,'deleted');app.db.exec('ROLLBACK');assert.equal(app.controls.isDeleted(2),false);assert.deepEqual(app.db.prepare('SELECT email,password FROM users WHERE id=2').get(),before);assert.equal(app.db.prepare('SELECT count(*) n FROM support_messages').get().n,3);
 }finally{app.close();}
});

test('provider performance is exported only for its owner and closure removes observations while disabling the permanent binding',async()=>{
 const app=fixture();let sync;
 try{
  const allocation=app.allocation();
  sync=createSponsoredSync(app.db,{access:app.access,workflows:{requireApproved(){return {...app.approval};}},now:()=>time,apiToken:'',provider:{async fetch(){return{accountInformation:{currency:'USD',balance:10098,equity:10095},complete:true,deals:[{id:'fixture-deal',time:time-3600000,type:'DEAL_TYPE_BUY',entryType:'DEAL_ENTRY_OUT',profit:100,commission:-2,comment:'private-provider-comment',brokerPassword:'private-broker-password'}]};}}});
  sync.linkAccount(1,allocation.id,{providerAccountId:'private-external-account-0001',reason:'Connect isolated provider fixture'});await sync.syncAccount(1,allocation.id);
  const exported=app.controls.exportData(2),other=app.controls.exportData(3),serialized=JSON.stringify(exported);
  assert.equal(exported.sections.sponsoredConnections.items.length,1);assert.equal(exported.sections.sponsoredEquityObservations.items[0].equity,10095);assert.equal(exported.sections.sponsoredDeals.items[0].netProfit,98);assert.equal(exported.sections.sponsoredDealHistory.items[0].payload.netProfit,98);
  assert.equal(other.sections.sponsoredDeals.items.length,0);for(const privateValue of ['private-external-account-0001','provider_id_hash','private-provider-comment','private-broker-password'])assert.ok(!serialized.includes(privateValue),privateValue);
  app.finance.updateAccount(1,allocation.id,{status:'closed',revision:1,reason:'Close the external allocation'});
  const receipt=app.controls.requestDeletion(2,confirmation);assert.equal(receipt.status,'deleted');assert.ok(receipt.retained.some(row=>row.category==='provider_binding_records'));
  const binding=app.db.prepare('SELECT active,provider_account_id,provider_id_hash FROM sponsored_sync_links WHERE account_id=?').get(allocation.id);assert.equal(binding.active,0);assert.equal(binding.provider_account_id,null);assert.equal(binding.provider_id_hash,hash('private-external-account-0001'));
  for(const table of ['sponsored_sync_snapshots','sponsored_sync_deals','sponsored_sync_deal_versions'])assert.equal(app.db.prepare(`SELECT count(*) n FROM ${table} WHERE account_id=?`).get(allocation.id).n,0,table);
  assert.throws(()=>app.db.exec('DELETE FROM sponsored_sync_links'),/cannot be deleted/);assert.equal(app.db.prepare('PRAGMA foreign_key_check').all().length,0);
 }finally{await sync?.close();app.close();}
});

test('recovery replays the latest deletion ledger into an older database, reserves missing user IDs, and rejects another installation',()=>{
 const app=fixture(),restored=fixture();try{
  const installation=app.db.prepare('SELECT installation_id FROM account_control_metadata').get().installation_id;restored.db.prepare('UPDATE account_control_metadata SET installation_id=?').run(installation);
  app.seedPrivate();restored.seedPrivate();app.controls.requestDeletion(2,confirmation);
  app.db.prepare("INSERT INTO users(id,email,name,market,password,created_at) VALUES (5,'recent@example.com','Recent Customer','I trade both','private-recent-hash',?)").run(time);
  app.controls.requestDeletion(5,confirmation);const ledger=app.controls.exportDeletionLedger();
  assert.equal(ledger.entries.length,2);assert.ok(!JSON.stringify(ledger).includes('ada@example.com'));const applied=applyAccountDeletionLedger(restored.db,ledger);assert.equal(applied.replayed,2);assert.equal(restored.controls.isDeleted(2),true);assert.equal(restored.controls.isDeleted(5),true);assert.equal(restored.db.prepare('SELECT count(*) n FROM sessions WHERE user_id=2').get().n,0);assert.equal(restored.db.prepare('SELECT count(*) n FROM accounts WHERE user_id=2').get().n,0);
  const fresh=restored.db.prepare("INSERT INTO users(email,name,market,password,created_at) VALUES ('next@example.com','Next Customer','I trade both','hash',?)").run(time);assert.ok(Number(fresh.lastInsertRowid)>5);
  assert.equal(applyAccountDeletionLedger(restored.db,ledger).replayed,0);assert.equal(restored.db.prepare('PRAGMA foreign_key_check').all().length,0);
  assert.throws(()=>applyAccountDeletionLedger(restored.db,{...ledger,installationId:randomUUID()}),error=>error.code==='DELETION_LEDGER_INSTALLATION_MISMATCH');
  const malformed=[null,{...ledger,entries:[...ledger.entries,ledger.entries[0]]},{...ledger,entries:[{...ledger.entries[0],userId:'2'}]},{...ledger,entries:[{...ledger.entries[0],completedAt:0}]}];for(const value of malformed)assert.throws(()=>applyAccountDeletionLedger(restored.db,value),error=>error.status===400);
 }finally{app.close();restored.close();}
});
