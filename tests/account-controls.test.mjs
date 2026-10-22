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

const time=Date.UTC(2026,9,22,10),confirmation={confirmation:'DELETE MY ACCOUNT'};
const hash=value=>createHash('sha256').update(value).digest('hex');
function fixture(){
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
 const sessions=createSessions(db,{now:()=>time});
 createTwoFactor(db,'/tmp/unused-controls.sqlite',{now:()=>time,encryptionKey:Buffer.alloc(32,7).toString('base64')});
 for(const id of [1,2,3,4])db.prepare('INSERT INTO two_factor(user_id,secret,enabled_at) VALUES (?,?,?)').run(id,`private-factor-secret-${id}`,time);
 const certificates=createCertificates(db),contracts=createContracts(db),leaderboard=createLeaderboard(db,{now:()=>time});
 initializeSupportSchema(db);
 const access=createAdminAccess(db,{now:()=>time,ownerEmails:'owner@example.com'});
 const workflows=createAdminWorkflows(db,{access,contracts,leaderboard,now:()=>time});
 const approval={userId:2,reviewId:randomUUID(),reviewRevision:1,certificateId:randomUUID(),contractId:randomUUID(),contractVersion:'fixture-v1',contractHash:'a'.repeat(64),signatureId:randomUUID()};
 const finance=createAdminFinance(db,{access,now:()=>time,workflows:{requireApproved(id){assert.equal(id,2);return {...approval};}}});
 createPerformanceReports(db,{now:()=>time});
 let failClosedAudit=false;
 const guarded={context:access.context,audit(...args){if(failClosedAudit&&args[1]==='account.closed')throw new Error('Isolated audit failure');return access.audit(...args);}};
 const controls=createAccountControls(db,{access:guarded,now:()=>time});
 for(const id of [1,2,3,4])db.prepare('INSERT INTO accounts(user_id,state) VALUES (?,?)').run(id,JSON.stringify(createAccount(time)));
 function allocation(){return finance.createAccount(1,{userId:2,firmName:'Fixture Prop Firm',label:'Fixture external allocation',accountSizeCents:1000000,traderShareBps:7000,profitSharingPolicy:'cumulative_high_water',evidence:'Isolated external receipt reference',reason:'Record an isolated allocation'}).account;}
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
 return {db,access,workflows,controls,finance,certificates,contracts,sessions,allocation,seedPrivate,approval,failAudit(value){failClosedAudit=value;},close(){db.close();}};
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
