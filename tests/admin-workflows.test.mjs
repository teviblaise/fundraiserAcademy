import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createAdminAccess} from '../admin-access.mjs';
import {createAdminWorkflows} from '../admin-workflows.mjs';
import {createCertificates} from '../certificates.mjs';
import {createContracts,contractConsentStatement} from '../contracts.mjs';
import {createLeaderboard} from '../leaderboard.mjs';
import {createAccount} from '../public/simulator.js';

const terms=Buffer.from('Isolated company-provided test agreement.');
function fixture(){
 const db=new DatabaseSync(':memory:');
 db.exec(`PRAGMA foreign_keys=ON;
 CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT,password TEXT,session_version INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE notification_preferences(user_id INTEGER PRIMARY KEY,verified INTEGER);
 CREATE TABLE two_factor(user_id INTEGER PRIMARY KEY,secret TEXT);
 CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER,expires INTEGER);
 CREATE TABLE accounts(user_id INTEGER PRIMARY KEY,state TEXT);
 CREATE TABLE events(id INTEGER PRIMARY KEY,user_id INTEGER,kind TEXT,detail TEXT,created_at INTEGER);
 INSERT INTO users(id,name,email,password) VALUES(1,'Owner','owner@example.com','private-hash'),(2,'Reviewer','reviewer@example.com','private-hash'),(3,'Trader','trader@example.com','private-hash'),(4,'Other','other@example.com','private-hash');
 INSERT INTO notification_preferences VALUES(1,1),(2,1),(3,1),(4,1);INSERT INTO two_factor VALUES(1,'encrypted-secret'),(2,'encrypted-secret');`);
 let clock=Date.now();
 const access=createAdminAccess(db,{now:()=>clock,ownerEmails:'owner@example.com'});
 access.grant(1,2,'reviewer','Assign review responsibilities');
 const certificates=createCertificates(db),contracts=createContracts(db),leaderboard=createLeaderboard(db,{now:()=>clock});
 const work=createAdminWorkflows(db,{access,contracts,leaderboard,now:()=>clock});
 const publish=(version='v1')=>contracts.publish({content:terms,format:'text',version,now:clock});
 function qualify(userId=3){
  const account=createAccount(clock);account.balance=11000;account.locked='Profit target achieved';account.positions=[];account.tradingDays=['2026-10-01','2026-10-02','2026-10-03'];
  const cert=certificates.issue(userId,account,clock);
  db.prepare('INSERT OR REPLACE INTO accounts VALUES (?,?)').run(userId,JSON.stringify(account));
  return cert;
 }
 function sign(userId=3,document){const active=document??publish();return contracts.sign(userId,{contractId:active.id,contractVersion:active.version,contractHash:active.hash,consent:true,legalName:'Legal Trader Name'},clock);}
 const revoke=({userId})=>{const count=db.prepare('DELETE FROM sessions WHERE user_id=?').run(userId).changes;db.prepare('UPDATE users SET session_version=session_version+1 WHERE id=?').run(userId);return {count};};
 return {db,access,certificates,contracts,leaderboard,work,publish,qualify,sign,revoke,decision(status='approved',expectedRevision=0){const basis=work.review(3);return {status,expectedRevision,expectedContractId:basis.contractId,expectedCertificateId:basis.certificateId,reason:'Reviewed verified assessment and current signed agreement',clientMessage:'Your company review has been completed.'};},advance(ms){clock+=ms;},close(){db.close();}};
}

test('suspension is audited and atomically revokes sessions without changing assessment, certificates, or signatures',()=>{
 const f=fixture();try{
  f.qualify();f.sign();const before={account:f.db.prepare('SELECT state FROM accounts WHERE user_id=3').get().state,certs:f.certificates.list(3),signature:f.contracts.status(3).signature};
  f.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run('private-session-hash',3,Date.now()+10000);
  assert.throws(()=>f.work.updateStatus(1,3,{status:'suspended',reason:'Trading review required'}),/requires synchronous/);
  const value=f.work.updateStatus(1,3,{status:'suspended',reason:'Trading review required'},{onRevoke:f.revoke});
  assert.equal(value.status,'suspended');assert.equal(value.sessionsRevoked,1);assert.equal(f.db.prepare('SELECT count(*) n FROM sessions').get().n,0);assert.equal(f.access.isSuspended(3),true);
  assert.equal(f.db.prepare('SELECT state FROM accounts WHERE user_id=3').get().state,before.account);assert.deepEqual(f.certificates.list(3),before.certs);assert.deepEqual(f.contracts.status(3).signature,before.signature);
  const audit=f.access.auditList({action:'trader.status-changed'}).entries[0];assert.equal(audit.targetId,3);assert.equal(audit.detail.previousStatus,'active');assert.equal(audit.detail.sessionsRevoked,true);
  assert.equal(f.work.updateStatus(1,3,{status:'active',reason:'Review completed'}).status,'active');
 }finally{f.close();}
});

test('suspension permission, self-protection and callback rollback prevent partial administrative state',()=>{
 const f=fixture();try{
  assert.throws(()=>f.work.updateStatus(2,3,{status:'suspended',reason:'Review account'},{onRevoke:f.revoke}),e=>e.status===403);
  assert.throws(()=>f.work.updateStatus(1,1,{status:'suspended',reason:'Review account'},{onRevoke:f.revoke}),e=>e.status===409);
  const before=f.access.auditList().total;
  assert.throws(()=>f.work.updateStatus(1,3,{status:'suspended',reason:'Review account'},{onRevoke(){throw new Error('revoke failed');}}),/revoke failed/);
  assert.equal(f.access.isSuspended(3),false);assert.equal(f.access.auditList().total,before);
  for(const reason of ['', 'no', 'bad\nreason'])assert.throws(()=>f.work.updateStatus(1,3,{status:'suspended',reason},{onRevoke:f.revoke}),e=>e.status===400);
 }finally{f.close();}
});

test('workflow writes join the credential-proof transaction and roll back together',()=>{
 const f=fixture();try{
  f.db.exec('BEGIN IMMEDIATE');f.work.updateStatus(1,3,{status:'suspended',reason:'Review account'},{onRevoke:f.revoke});f.work.appendNote(1,3,{text:'Internal reviewer note',reason:'Record review context'});f.db.exec('ROLLBACK');
  assert.equal(f.access.isSuspended(3),false);assert.equal(f.work.notes(3).total,0);assert.equal(f.access.auditList({action:'trader.status-changed'}).total,0);
 }finally{f.close();}
});

test('session revocation requires real revocation and records only bounded non-secret metadata',()=>{
 const f=fixture();try{
  f.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run('private-session-hash',3,Date.now()+10000);
  assert.throws(()=>f.work.revokeSessions(1,3,{reason:'Account security review'}),/requires a synchronous/);
  assert.deepEqual(f.work.revokeSessions(1,3,{reason:'Account security review'},{onRevoke:f.revoke}),{userId:3,revokedCount:1});
  assert.equal(f.db.prepare('SELECT session_version FROM users WHERE id=3').get().session_version,1);assert.ok(!JSON.stringify(f.access.auditList()).includes('private-session-hash'));
 }finally{f.close();}
});

test('notes are append-only, bounded, private to administrative read models and absent from client review',()=>{
 const f=fixture();try{
  const note=f.work.appendNote(1,3,{text:'  Internal-only adjudication context  ',reason:'Record reviewer context'});assert.equal(note.text,'Internal-only adjudication context');assert.equal(note.actorName,'Owner');assert.equal(f.work.notes(3).total,1);
  assert.throws(()=>f.db.prepare('UPDATE admin_notes SET text=? WHERE id=?').run('changed',note.id),/append-only/);assert.throws(()=>f.db.prepare('DELETE FROM admin_notes WHERE id=?').run(note.id),/append-only/);
  assert.ok(!JSON.stringify(f.work.clientView(3)).includes('Internal-only'));
  assert.equal(f.work.appendNote(2,3,{text:'Reviewer follow-up',reason:'Review context'}).actorName,'Reviewer');
  f.access.grant(1,2,'support','Restrict account to support duties');
  assert.throws(()=>f.work.appendNote(2,3,{text:'note',reason:'Review context'}),e=>e.status===403);
  assert.throws(()=>f.work.appendNote(1,3,{text:'x'.repeat(2001),reason:'Review context'}),e=>e.status===400);assert.throws(()=>f.work.notes(3,{limit:101}),e=>e.status===400);
 }finally{f.close();}
});

test('sponsorship requires the exact current signed reference assessment and never changes funding or trading results',()=>{
 const f=fixture();try{
  assert.throws(()=>f.work.decideReview(2,3,f.decision()),e=>e.status===409);
  f.qualify();const doc=f.publish();assert.throws(()=>f.work.decideReview(2,3,f.decision()),e=>e.status===409);f.sign(3,doc);
  const before=f.db.prepare('SELECT state FROM accounts WHERE user_id=3').get().state;
  const row=f.work.decideReview(2,3,f.decision());assert.equal(row.status,'approved');assert.equal(row.revision,1);assert.equal(row.eligibility.eligible,true);assert.equal(row.history.length,1);
  const approved=f.work.requireApproved(3);assert.equal(approved.reviewId,row.id);assert.equal(approved.reviewRevision,1);assert.equal(approved.contractId,doc.id);assert.equal(approved.contractVersion,'v1');assert.equal(approved.contractHash,doc.hash);assert.ok(approved.certificateId);assert.ok(approved.signatureId);
  const client=f.work.clientView(3);assert.equal(client.status,'approved');assert.equal(client.fundingApproved,false);assert.match(client.message,/external account arrangements/);assert.ok(!JSON.stringify(client).includes('Reviewed verified assessment'));
  assert.equal(f.db.prepare('SELECT state FROM accounts WHERE user_id=3').get().state,before);
 }finally{f.close();}
});

test('client sponsorship status requires assessment completion before mentioning an unpublished agreement',()=>{
 const f=fixture();try{
  assert.equal(f.work.clientView(3).status,'assessment_required');
  f.qualify();assert.equal(f.work.clientView(3).status,'awaiting_contract');
  f.db.prepare("UPDATE certificates SET price_mode='synthetic' WHERE user_id=3").run();assert.equal(f.work.clientView(3).status,'assessment_required');
 }finally{f.close();}
});

test('review revision protects competing decisions and preserves immutable history',()=>{
 const f=fixture();try{
  f.qualify();f.sign();const first=f.work.decideReview(2,3,f.decision('needs_information'));assert.equal(first.revision,1);
  assert.throws(()=>f.work.decideReview(1,3,f.decision('approved',0)),e=>e.code==='ADMIN_REVIEW_CONFLICT');
  const second=f.work.decideReview(1,3,f.decision('approved',1));assert.equal(second.revision,2);assert.equal(second.history.length,2);assert.equal(second.history[1].status,'needs_information');
  assert.throws(()=>f.db.prepare('UPDATE sponsorship_review_history SET reason=?').run('changed'),/immutable/);assert.throws(()=>f.db.prepare('DELETE FROM sponsorship_review_history').run(),/immutable/);
 }finally{f.close();}
});

test('a newly required contract version stales approval until exact new signature and a new review decision',()=>{
 const f=fixture();try{
  f.qualify();f.sign();f.work.decideReview(1,3,f.decision());const next=f.publish('v2');
  let review=f.work.review(3);assert.equal(review.stale,true);assert.equal(review.status,'signature_required');assert.equal(review.clientMessage,'');assert.throws(()=>f.work.requireApproved(3),e=>e.code==='SPONSORSHIP_APPROVAL_REQUIRED');
  f.sign(3,next);review=f.work.review(3);assert.equal(review.status,'pending_review');assert.equal(review.stale,true);
  const updated=f.work.decideReview(1,3,f.decision('approved',1));assert.equal(updated.stale,false);assert.equal(updated.contractVersion,'v2');assert.equal(f.work.requireApproved(3).reviewRevision,2);
 }finally{f.close();}
});

test('an old admin screen cannot approve a replacement agreement even when the case revision stayed unchanged',()=>{
 const f=fixture();try{
  f.qualify();f.sign();const outdated=f.decision();const next=f.publish('v2');f.sign(3,next);
  assert.throws(()=>f.work.decideReview(1,3,outdated),e=>e.code==='ADMIN_REVIEW_BASIS_CHANGED');
  assert.throws(()=>f.work.decideReview(1,3,{...f.decision(),expectedCertificateId:'different'}),e=>e.code==='ADMIN_REVIEW_BASIS_CHANGED');
  assert.equal(f.work.decideReview(1,3,f.decision()).contractId,next.id);
 }finally{f.close();}
});

test('review overview counts use current eligibility instead of stale stored approvals',()=>{
 const f=fixture();try{
  f.qualify();f.sign();assert.equal(f.work.summary().counts.pending_review,1);f.work.decideReview(1,3,f.decision());assert.equal(f.work.summary().counts.approved,1);
  f.publish('v2');const counts=f.work.summary().counts;assert.equal(counts.approved,0);assert.equal(counts.stale,1);assert.equal(counts.signature_required,1);assert.equal(counts.total,1);
 }finally{f.close();}
});

test('synthetic, mismatched-owner, tampered or insufficient certificate snapshots cannot receive approval',()=>{
 for(const patch of ["price_mode='synthetic'","trading_days=2","profit_percent=99","final_balance=10001","user_id=4"]){
  const f=fixture();try{f.qualify();f.sign();f.db.exec(`UPDATE certificates SET ${patch} WHERE user_id=3`);assert.equal(f.work.eligibility(3).eligible,false,patch);assert.throws(()=>f.work.decideReview(1,3,f.decision()),e=>e.code==='SPONSORSHIP_NOT_ELIGIBLE');}finally{f.close();}
 }
});

test('suspended traders cannot receive a review or satisfy a previous sponsorship approval',()=>{
 const f=fixture();try{f.qualify();f.sign();f.work.decideReview(1,3,f.decision());f.work.updateStatus(1,3,{status:'suspended',reason:'Security investigation'},{onRevoke:f.revoke});assert.equal(f.work.eligibility(3).status,'account_suspended');assert.throws(()=>f.work.requireApproved(3),e=>e.status===409);assert.throws(()=>f.work.decideReview(1,3,f.decision('approved',1)),e=>e.status===409);}finally{f.close();}
});

test('unverified legacy signers may receive information requests but cannot be approved for funding',()=>{
 const f=fixture();try{
  f.qualify();f.sign();f.db.prepare('UPDATE notification_preferences SET verified=0 WHERE user_id=3').run();
  assert.equal(f.work.eligibility(3).status,'email_confirmation_required');
  assert.throws(()=>f.work.decideReview(1,3,f.decision()),e=>e.code==='SPONSORSHIP_NOT_ELIGIBLE');
  const request=f.work.decideReview(1,3,{...f.decision('needs_information'),clientMessage:'Please confirm your account email.'});assert.equal(request.status,'needs_information');assert.equal(request.stale,false);assert.equal(f.work.clientView(3).review.clientMessage,'Please confirm your account email.');
  assert.throws(()=>f.work.requireApproved(3),e=>e.code==='SPONSORSHIP_APPROVAL_REQUIRED');
  f.db.prepare('UPDATE notification_preferences SET verified=1 WHERE user_id=3').run();f.work.decideReview(1,3,f.decision('approved',1));assert.ok(f.work.requireApproved(3));
  f.db.prepare('UPDATE notification_preferences SET verified=0 WHERE user_id=3').run();assert.equal(f.work.review(3).stale,true);assert.throws(()=>f.work.requireApproved(3),e=>e.code==='SPONSORSHIP_APPROVAL_REQUIRED');
 }finally{f.close();}
});

test('review queue is truthful, filtered and paginated without creating database records on read',()=>{
 const f=fixture();try{
  f.qualify();f.sign();assert.equal(f.work.reviews().total,1);assert.equal(f.db.prepare('SELECT count(*) n FROM sponsorship_reviews').get().n,0);assert.equal(f.work.reviews({status:'pending_review'}).entries[0].revision,0);assert.equal(f.work.reviews({search:'missing'}).total,0);
  f.work.decideReview(1,3,f.decision('rejected'));assert.equal(f.work.reviews({status:'rejected',limit:1}).total,1);assert.equal(f.work.reviews({status:'approved'}).total,0);assert.equal(f.work.reviews({offset:1}).entries.length,0);
  for(const query of [{limit:0},{offset:-1},{status:'funded'},{search:'x'.repeat(255)}])assert.throws(()=>f.work.reviews(query),e=>e.status===400);
 }finally{f.close();}
});

test('contract publication validates actual bytes and atomically audits immutable documents',()=>{
 const f=fixture();try{
  const input={format:'text',version:'v1',title:'Company trader agreement',fileName:'actual-terms.txt',contentBase64:terms.toString('base64'),reason:'Publish company-supplied terms'};
  const result=f.work.publishContract(1,input);assert.equal(result.active,true);assert.deepEqual(f.contracts.document((f.qualify(),3),result.contract.id).content,terms);assert.equal(f.access.auditList({action:'contract.published'}).total,1);
  assert.equal(f.work.publishContract(1,input).reused,true);assert.equal(f.access.auditList({action:'contract.published'}).total,2);
  assert.throws(()=>f.work.publishContract(2,{...input,version:'v2'}),e=>e.status===403);
  for(const data of [{...input,format:'pdf'},{...input,contentBase64:'bad!!'},{...input,contentBase64:''},{...input,reason:'x'}])assert.throws(()=>f.work.publishContract(1,data),e=>e.status===400);
 }finally{f.close();}
});

test('publication callback and outer audit failures roll document publication back',()=>{
 const f=fixture();try{
  assert.throws(()=>f.contracts.publish({content:terms,format:'text',version:'failed',onPublish(){throw new Error('audit failed');}}),/audit failed/);assert.equal(f.db.prepare('SELECT count(*) n FROM contract_documents').get().n,0);
  const audit=f.access.audit;f.access.audit=()=>{throw new Error('storage unavailable');};assert.throws(()=>f.work.publishContract(1,{contentBase64:terms.toString('base64'),format:'text',version:'failed-two',reason:'Publish actual company terms'}),/storage unavailable/);f.access.audit=audit;assert.equal(f.db.prepare('SELECT count(*) n FROM contract_documents').get().n,0);assert.equal(f.db.prepare('SELECT count(*) n FROM contract_publication_events').get().n,0);
  f.db.exec('BEGIN');f.contracts.publish({content:terms,format:'text',version:'outer'});f.db.exec('ROLLBACK');assert.equal(f.db.prepare('SELECT count(*) n FROM contract_documents').get().n,0);
 }finally{f.close();}
});

test('publication accepts the documented 10 MB boundary without a regex stack overflow',()=>{
 const f=fixture();try{
  const content=Buffer.alloc(10*1024*1024,32);content.write('%PDF-1.7\n');
  const published=f.work.publishContract(1,{format:'pdf',version:'large',fileName:'company-agreement.pdf',contentBase64:content.toString('base64'),reason:'Publish complete company document'});
  assert.equal(published.contract.format,'pdf');assert.equal(f.db.prepare('SELECT length(content) size FROM contract_documents WHERE id=?').get(published.contract.id).size,content.length);
  assert.throws(()=>f.work.publishContract(1,{format:'pdf',version:'too-large',contentBase64:Buffer.alloc(content.length+1).toString('base64'),reason:'Publish complete company document'}),e=>e.status===400);
 }finally{f.close();}
});
