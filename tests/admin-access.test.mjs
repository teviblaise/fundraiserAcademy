import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { createAdminAccess, ADMIN_ROLES } from '../admin-access.mjs';

function fixture({ ownerEmails = '', database = ':memory:' } = {}) {
  const db=new DatabaseSync(database);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,name TEXT,password TEXT,session_version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE notification_preferences(user_id INTEGER PRIMARY KEY REFERENCES users(id),verified INTEGER NOT NULL,email_enabled INTEGER DEFAULT 0);
    CREATE TABLE two_factor(user_id INTEGER PRIMARY KEY REFERENCES users(id),secret TEXT,pending_secret TEXT,pending_expires INTEGER,version INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE two_factor_challenges(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id));
    CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id));
    CREATE TABLE push_subscriptions(endpoint TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id));
    CREATE TABLE notification_outbox(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),channel TEXT,status TEXT,payload TEXT);`);
  const user=(id,{verified=true,factor=true,email=`user${id}@example.com`}={})=>{
    db.prepare('INSERT INTO users(id,email,name,password) VALUES (?,?,?,?)').run(id,email,`Trader ${id}`,'private-password-hash-not-for-api');
    db.prepare('INSERT INTO notification_preferences(user_id,verified) VALUES (?,?)').run(id,verified?1:0);
    db.prepare('INSERT INTO two_factor(user_id,secret) VALUES (?,?)').run(id,factor?'ciphertext-not-for-api':null);
  };
  for(let id=1;id<=8;id++)user(id);
  const access=createAdminAccess(db,{ownerEmails,now:()=>100000});
  return {db,access,user,close:()=>db.close()};
}
const reason='Verified operator role administration.';

test('no registration or first account automatically acquires an administrator role',()=>{
 const app=fixture();try{
  assert.deepEqual(ADMIN_ROLES,['owner','admin','reviewer','support']);
  assert.equal(app.access.staff().length,0);
  for(let id=1;id<=8;id++){const context=app.access.context(id);assert.equal(context.role,null);assert.deepEqual(context.permissions,[]);assert.equal(context.eligible,false);assert.throws(()=>app.access.require(id,'overview.read'),error=>error.status===403);}
  assert.equal(app.access.context(99).active,false);
 }finally{app.close();}
});

test('owner, admin, reviewer and support permissions are distinct and read from current database state',()=>{
 const app=fixture();try{
  app.access.grant(null,1,'owner',reason);
  app.access.grant(1,2,'admin',reason);app.access.grant(1,3,'reviewer',reason);app.access.grant(1,4,'support',reason);
  assert.equal(app.access.require(1,'staff.manage').role,'owner');
  for(const id of [1,2])for(const permission of ['traders.manage','finance.read','finance.write','contracts.publish','reports.export'])assert.ok(app.access.require(id,permission));
  assert.throws(()=>app.access.require(2,'staff.manage'),e=>e.status===403);
  assert.ok(app.access.require(3,'reviews.write'));assert.throws(()=>app.access.require(3,'finance.read'),e=>e.status===403);assert.throws(()=>app.access.require(3,'reports.export'),e=>e.status===403);assert.throws(()=>app.access.require(3,'support.manage'),e=>e.status===403);
  assert.ok(app.access.require(4,'support.manage'));assert.throws(()=>app.access.require(4,'traders.read'),e=>e.status===403);assert.throws(()=>app.access.require(4,'reports.export'),e=>e.status===403);
  app.db.prepare('DELETE FROM admin_roles WHERE user_id=4').run();assert.throws(()=>app.access.require(4,'support.manage'),e=>e.status===403);
 }finally{app.close();}
});

test('staff grants require registered active accounts with proven email and an enrolled factor',()=>{
 const app=fixture();try{
  app.access.grant(null,1,'owner',reason);
  app.db.prepare('UPDATE notification_preferences SET verified=0 WHERE user_id=2').run();
  app.db.prepare('UPDATE two_factor SET secret=NULL WHERE user_id=3').run();
  app.db.prepare("INSERT INTO admin_account_status VALUES (4,'suspended','Under review',1,100000)").run();
  for(const id of [2,3,4])assert.throws(()=>app.access.grant(1,id,'admin',reason),e=>e.status===409);
  assert.throws(()=>app.access.grant(1,999,'admin',reason),e=>e.status===404);
  assert.throws(()=>app.access.grant(1,5,'superuser',reason),e=>e.status===400);
  assert.equal(app.access.staff().length,1);
 }finally{app.close();}
});

test('configured owners still require email, factor and active-account proof and are visibly environment managed',()=>{
 const app=fixture({ownerEmails:' USER2@EXAMPLE.COM, invalid-email '});try{
  const owner=app.access.context(2);assert.equal(owner.role,'owner');assert.equal(owner.environmentManaged,true);assert.ok(owner.eligible);assert.equal(app.db.prepare('SELECT count(*) n FROM admin_roles').get().n,0);
  app.db.prepare('UPDATE notification_preferences SET verified=0 WHERE user_id=2').run();assert.equal(app.access.context(2).eligible,false);assert.throws(()=>app.access.require(2,'overview.read'),e=>e.status===403);
  app.db.prepare('UPDATE notification_preferences SET verified=1 WHERE user_id=2').run();app.db.prepare('UPDATE two_factor SET secret=NULL WHERE user_id=2').run();assert.equal(app.access.context(2).eligible,false);
  app.db.prepare("UPDATE two_factor SET secret='ciphertext' WHERE user_id=2").run();app.db.prepare("INSERT INTO admin_account_status VALUES(2,'suspended','Review hold',NULL,100000)").run();assert.equal(app.access.context(2).eligible,false);
  assert.equal(app.access.staff()[0].environmentManaged,true);
 }finally{app.close();}
});

test('dashboard or local role mutations cannot override an environment owner',()=>{
 const app=fixture({ownerEmails:'user1@example.com'});try{
  assert.throws(()=>app.access.revoke(null,1,reason),e=>e.status===409&&/ADMIN_OWNER_EMAILS/.test(e.message));
  assert.throws(()=>app.access.grant(null,1,'admin',reason),e=>e.status===409);
  assert.equal(app.access.context(1).role,'owner');
 }finally{app.close();}
});

test('ordinary users and subordinate admins cannot grant privileges, while owners cannot demote themselves',()=>{
 const app=fixture();try{
  app.access.grant(null,1,'owner',reason);app.access.grant(1,2,'admin',reason);
  for(const id of [2,3]){assert.throws(()=>app.access.grant(id,4,'owner',reason),e=>e.status===403);assert.throws(()=>app.access.revoke(id,1,reason),e=>e.status===403);}
  assert.throws(()=>app.access.revoke(1,1,reason),e=>e.status===409);
  assert.throws(()=>app.access.grant(1,1,'admin',reason),e=>e.status===409);
 }finally{app.close();}
});

test('last-owner protections apply to demotion and suspension, including unavailable backup owners',()=>{
 const app=fixture();try{
  app.access.grant(null,1,'owner',reason);
  assert.throws(()=>app.access.revoke(null,1,reason),e=>e.status===409);
  assert.throws(()=>app.access.assertAccountChange(null,1,'suspended'),e=>e.status===409);
  app.access.grant(1,2,'owner',reason);app.access.grant(1,3,'admin',reason);
  assert.throws(()=>app.access.assertAccountChange(3,1,'suspended'),e=>e.status===403);
  assert.throws(()=>app.access.assertAccountChange(1,1,'suspended'),e=>e.status===409);
  assert.doesNotThrow(()=>app.access.assertAccountChange(1,2,'suspended'));
  app.db.prepare('UPDATE two_factor SET secret=NULL WHERE user_id=2').run();
  assert.throws(()=>app.access.revoke(null,1,reason),e=>e.status===409);
  app.db.prepare("UPDATE two_factor SET secret='ciphertext' WHERE user_id=2").run();
  app.access.revoke(2,1,reason);assert.equal(app.access.context(1).role,null);
 }finally{app.close();}
});

test('roles immediately stop authorizing when email, factor, or suspension changes',()=>{
 const app=fixture();try{
  app.access.grant(null,1,'owner',reason);app.access.grant(1,2,'reviewer',reason);
  for(const mutate of [()=>app.db.prepare('UPDATE notification_preferences SET verified=0 WHERE user_id=2').run(),()=>app.db.prepare('UPDATE two_factor SET secret=NULL WHERE user_id=2').run(),()=>app.db.prepare("INSERT INTO admin_account_status VALUES(2,'suspended','Review',1,100000)").run()]){
   mutate();assert.throws(()=>app.access.require(2,'traders.read'),e=>e.status===403);
  }
  assert.equal(app.access.isSuspended(2),true);assert.equal(app.access.accountStatus(2).reason,'Review');assert.equal(app.access.accountStatus(3).status,'active');
 }finally{app.close();}
});

test('audit metadata is allowlisted, bounded and append-only without exposing authentication material',()=>{
 const app=fixture();try{
  app.access.grant(null,1,'owner',reason);
  app.access.audit(1,'finance.statement-created',{targetId:2,reason,detail:{statementId:'statement-id',amountCents:12000,currency:'USD',externalReference:'ref-123'}});
  for(const detail of [{password:'secret'},{secret:'otp'},{token:'cookie'},{payload:{password:'secret'}},{role:'x'.repeat(513)}])assert.throws(()=>app.access.audit(1,'test.action',{reason,detail}),e=>e.status===400);
  assert.throws(()=>app.access.audit(1,'test.action',{reason:'a\npassword',detail:{}}),e=>e.status===400);
  const data=app.access.auditList({limit:100});assert.equal(data.total,2);assert.equal(data.entries.find(row=>row.action==='finance.statement-created').detail.amountCents,12000);
  assert.ok(!JSON.stringify(data).includes('private-password-hash'));assert.ok(!JSON.stringify(data).includes('ciphertext-not-for-api'));
  assert.throws(()=>app.db.prepare("UPDATE admin_audit SET reason='tampered'").run(),/immutable/);assert.throws(()=>app.db.prepare('DELETE FROM admin_audit').run(),/immutable/);
 }finally{app.close();}
});

test('role changes and their audit rows roll back with the caller transaction',()=>{
 const app=fixture();try{
  app.access.grant(null,1,'owner',reason);app.db.exec('BEGIN IMMEDIATE');app.access.grant(1,2,'admin',reason);app.db.exec('ROLLBACK');
  assert.equal(app.access.context(2).role,null);assert.equal(app.access.auditList().total,1);
 }finally{app.close();}
});

test('audit paging, filtering and staff output stay bounded and exclude credential records',()=>{
 const app=fixture();try{
  app.access.grant(null,1,'owner',reason);app.access.grant(1,2,'reviewer',reason);
  for(let i=0;i<6;i++)app.access.audit(1,'trader.reviewed',{targetId:i%2?2:3,reason,detail:{count:i}});
  const filtered=app.access.auditList({action:'trader.reviewed',targetId:2,limit:2,offset:1});assert.equal(filtered.total,3);assert.equal(filtered.entries.length,2);assert.ok(filtered.entries.every(row=>row.targetId===2));
  for(const bad of [{limit:101},{offset:-1},{actorId:'1 OR 1=1'},{action:'x; DROP TABLE users'}])assert.throws(()=>app.access.auditList(bad),e=>e.status===400);
  const staff=app.access.staff();assert.equal(staff.length,2);assert.ok(staff.every(row=>!Object.hasOwn(row,'password')&&!Object.hasOwn(row,'secret')));
 }finally{app.close();}
});

async function cli(database,args,extra={}) {
 return new Promise((resolve,reject)=>{
  const processHandle=spawn(process.execPath,['admin-cli.mjs',...args],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,DATABASE_PATH:database,ADMIN_OWNER_EMAILS:'',...extra}});
  let out='',err='';processHandle.stdout.on('data',data=>out+=data);processHandle.stderr.on('data',data=>err+=data);processHandle.once('error',reject);processHandle.once('close',code=>resolve({code,out,err}));
 });
}

test('local CLI bootstraps an eligible owner, audits it, and revokes existing sessions and challenge generations',async()=>{
 const folder=await mkdtemp('/tmp/fa-admin-cli-'),database=folder+'/academy.sqlite';const app=fixture({database});
 try{
  app.db.prepare("INSERT INTO sessions VALUES('private-cookie-hash',1)").run();app.db.prepare("INSERT INTO two_factor_challenges VALUES('private-challenge-hash',1)").run();app.db.prepare("INSERT INTO push_subscriptions VALUES('https://private-push.example',1)").run();app.db.prepare("INSERT INTO notification_outbox VALUES(1,1,'push','pending','private message')").run();
  const result=await cli(database,['grant','--email','user1@example.com','--role','owner']);assert.equal(result.code,0,result.err);const output=JSON.parse(result.out);assert.equal(output.role,'owner');assert.equal(output.sessionsRevoked,true);
  assert.equal(app.db.prepare('SELECT count(*) n FROM sessions').get().n,0);assert.equal(app.db.prepare('SELECT count(*) n FROM two_factor_challenges').get().n,0);assert.equal(app.db.prepare('SELECT session_version FROM users WHERE id=1').get().session_version,1);assert.equal(app.db.prepare('SELECT secret FROM two_factor WHERE user_id=1').get().secret,'ciphertext-not-for-api');
  assert.ok(!result.out.includes('private-cookie-hash'));assert.equal(app.access.auditList().total,1);
  const listing=await cli(database,['list']);assert.equal(listing.code,0);assert.equal(JSON.parse(listing.out)[0].role,'owner');
  const last=await cli(database,['revoke','--email','user1@example.com']);assert.equal(last.code,1);assert.match(last.err,/at least one/);assert.equal(app.access.context(1).role,'owner');
 }finally{app.close();await rm(folder,{recursive:true,force:true});}
});

test('CLI refuses absent databases, malformed commands, and unverified staff rather than creating a backdoor',async()=>{
 const folder=await mkdtemp('/tmp/fa-admin-cli-denied-'),database=folder+'/academy.sqlite';const app=fixture({database});
 try{
  assert.equal((await cli(folder+'/missing.sqlite',['list'])).code,1);
  assert.equal((await cli(database,['grant','--email','user1@example.com','--role','superuser'])).code,1);
  app.db.prepare('UPDATE notification_preferences SET verified=0 WHERE user_id=2').run();assert.equal((await cli(database,['grant','--email','user2@example.com','--role','owner'])).code,1);assert.equal(app.access.staff().length,0);
 }finally{app.close();await rm(folder,{recursive:true,force:true});}
});
