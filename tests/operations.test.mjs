import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,mkdtemp,readFile,readdir,rm,stat,symlink,writeFile} from 'node:fs/promises';
import {spawn} from 'node:child_process';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import webPush from 'web-push';
import {createOperations} from '../operations.mjs';
import {createTwoFactor,generateTotpCode} from '../two-factor.mjs';
import {createAccountControls} from '../account-controls.mjs';

async function fixture({factor=true,environmentFactorKey=false,options={}}={}){
 const folder=await mkdtemp(path.join(tmpdir(),'academy-operations-'));
 const database=path.join(folder,'academy.sqlite');
 const db=new DatabaseSync(database);db.exec(`PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;
  CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE NOT NULL,name TEXT NOT NULL,market TEXT NOT NULL,password TEXT NOT NULL,created_at INTEGER NOT NULL,first_name TEXT NOT NULL DEFAULT '',other_names TEXT NOT NULL DEFAULT '',session_version INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE accounts(user_id INTEGER PRIMARY KEY REFERENCES users(id),state TEXT NOT NULL);
  CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),expires INTEGER NOT NULL);
  CREATE TABLE notification_preferences(user_id INTEGER PRIMARY KEY REFERENCES users(id),verified INTEGER,email_enabled INTEGER);
  CREATE TABLE notification_outbox(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),channel TEXT,status TEXT,payload TEXT);
  CREATE TABLE push_subscriptions(endpoint TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),subscription TEXT);
  CREATE TABLE email_verifications(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires INTEGER);
  CREATE TABLE password_resets(token TEXT PRIMARY KEY,user_id INTEGER REFERENCES users(id),expires INTEGER,created_at INTEGER);
  CREATE TABLE events(id INTEGER PRIMARY KEY,user_id INTEGER REFERENCES users(id),kind TEXT,detail TEXT,created_at INTEGER);
  INSERT INTO users(id,email,name,market,password,created_at) VALUES(1,'private-owner@example.com','Private Owner','forex','private-original-password-hash',1000);
  INSERT INTO accounts VALUES(1,'{"initial":10000,"balance":11000}');
  INSERT INTO sessions VALUES('private-old-session-hash',1,9999999999999);
  INSERT INTO notification_preferences VALUES(1,1,0);
  INSERT INTO notification_outbox VALUES(1,1,'password-reset','pending','{"token":"private-old-reset-link"}');
  INSERT INTO push_subscriptions VALUES('https://private-push.example/device',1,'private-subscription');
  INSERT INTO email_verifications VALUES('private-old-email-token',1,9999999999999);
  INSERT INTO password_resets VALUES('private-old-password-token',1,9999999999999,1000);`);
 let clock=Date.UTC(2026,9,22,12);
 const factorKey=environmentFactorKey?randomBytes(32).toString('base64'):undefined;
 const twoFactor=createTwoFactor(db,database,{now:()=>clock,encryptionKey:factorKey||''});
 if(factor){const expected=twoFactor.snapshot(1),setup=twoFactor.beginEnrollment(1,expected);twoFactor.confirmEnrollment(1,expected,generateTotpCode(setup.secret,{time:clock}));}
 const vapid=webPush.generateVAPIDKeys();await writeFile(path.join(folder,'vapid.json'),JSON.stringify(vapid),{mode:0o600});
 const controls=createAccountControls(db,{now:()=>clock});
 const settings={now:()=>clock,encryptionKey:'',twoFactorEncryptionKey:factorKey||'',initialDelayMs:10,...options};
 let operations=createOperations(db,database,settings);
 const app={folder,database,db,controls,settings,twoFactor,
  get operations(){return operations;},
  advance(ms){clock+=ms;},
  time(){return clock;},
  async replaceOperations(changes={}){await operations.close();operations=createOperations(db,database,{...settings,...changes});return operations;},
  async close(){await operations.close();db.close();await rm(folder,{recursive:true,force:true});}
 };
 return app;
}

test('error monitoring aggregates sanitized incidents, bounds pages, and never stores error bodies or private route segments',async()=>{
 const app=await fixture();try{
  const secret='customer-name-token-123';
  const first=app.operations.capture(Object.assign(new Error('email=private@example.com password=do-not-log'),{code:'SQLITE_BUSY',stack:'private-stack-token'}),{route:`/api/admin/traders/42/${secret}?token=hidden`,method:'POST',status:500});
  app.advance(1000);const repeated=app.operations.capture({message:'another-private-message',code:'SQLITE_BUSY'},{route:'/api/admin/traders/91/another-private-segment',method:'POST',status:503});
  assert.equal(first.id,repeated.id);assert.equal(app.operations.errors().items[0].count,2);
  const serialized=JSON.stringify(app.operations.errors());assert.doesNotMatch(serialized,/private|password|hidden|token|customer-name|do-not-log|stack/);assert.match(serialized,/:id\/:value/);
  assert.equal(app.operations.capture(new Error('ignored'),{status:400}),null);
  assert.equal(app.operations.resolveError(first.id).state,'resolved');assert.equal(app.operations.errors().total,0);assert.equal(app.operations.errors({state:'all'}).total,1);
  for(const query of [{limit:101},{limit:true},{offset:-1},{offset:[]},{state:'private'}])assert.throws(()=>app.operations.errors(query),e=>e.status===400);
  assert.throws(()=>app.operations.resolveError('../private'),e=>e.status===400);
 }finally{await app.close();}
});

test('encrypted backups include matching local authentication keys and automatically verify a consistent isolated recovery',async()=>{
 const app=await fixture();try{
  const oldSecret=app.db.prepare('SELECT secret FROM two_factor WHERE user_id=1').get().secret;
  const result=await app.operations.backup();assert.equal(result.encrypted,true);assert.equal(result.verified,true);assert.equal(result.recovery.integrity,'ok');assert.equal(result.recovery.schema,'verified');assert.equal(result.recovery.authenticatorRecordsChecked,1);assert.equal(result.recovery.pushKeyChecked,true);assert.equal(result.recovery.productionModified,false);
  const file=path.join(app.folder,'backups',result.backupId+'.fabackup');const bytes=await readFile(file);assert.equal(bytes.subarray(0,8).toString(),'FADBKP01');assert.ok(!bytes.includes(Buffer.from('private-owner@example.com')));assert.ok(!bytes.includes(Buffer.from(oldSecret)));assert.ok(!bytes.includes(Buffer.from('SQLite format 3')));
  for(const target of [file,path.join(app.folder,'backup-key.json')])if(process.platform!=='win32')assert.equal((await stat(target)).mode&0o777,0o600);
  if(process.platform!=='win32')assert.equal((await stat(path.join(app.folder,'backups'))).mode&0o777,0o700);
  assert.equal(app.db.prepare('SELECT count(*) n FROM sessions').get().n,1);assert.equal(app.db.prepare('SELECT count(*) n FROM two_factor_recovery_codes').get().n,10);assert.equal(app.db.prepare('SELECT recovery_required FROM users').get().recovery_required,0);assert.equal(app.db.prepare('SELECT secret FROM two_factor').get().secret,oldSecret);
  const status=app.operations.status();assert.equal(status.offsiteConfigured,false);assert.equal(status.persistentStorageRequired,true);assert.equal(status.keyCopyRequired,true);assert.equal(status.backups.length,1);assert.doesNotMatch(JSON.stringify(status),/private-owner|original-password|private-old|base64|\.sqlite|\/tmp\//);
 }finally{await app.close();}
});

test('direct environment authenticator keys are carried inside encrypted recovery artifacts without copying them into status',async()=>{
 const app=await fixture({environmentFactorKey:true});try{
  assert.equal((await readdir(app.folder)).includes('two-factor-key.json'),false);
  const result=await app.operations.backup();assert.equal(result.recovery.authenticatorRecordsChecked,1);assert.ok(result.authenticationKeysIncluded.includes('two-factor-key.json'));assert.ok(!JSON.stringify(result).includes(app.settings.twoFactorEncryptionKey));
  const target=path.join(app.folder,'restored');await app.operations.restoreToDirectory(result.backupId,{targetDirectory:target,confirmation:'RESTORE TO NEW DIRECTORY'});
  const stored=JSON.parse(await readFile(path.join(target,'two-factor-key.json'),'utf8'));assert.equal(stored.key,app.settings.twoFactorEncryptionKey);
 }finally{await app.close();}
});

test('recovery creates a fresh private directory, revokes restored authentication, and never mutates the live installation',async()=>{
 const app=await fixture();try{
  const result=await app.operations.backup(),target=path.join(app.folder,'recovered');
  const restored=await app.operations.restoreToDirectory(result.backupId,{targetDirectory:target,confirmation:'RESTORE TO NEW DIRECTORY'});assert.equal(restored.restoredToNewDirectory,true);assert.equal(restored.requiresPasswordResets,true);
  const check=new DatabaseSync(path.join(target,'academy.sqlite'));try{
   assert.equal(check.prepare('SELECT recovery_required FROM users WHERE id=1').get().recovery_required,1);assert.equal(check.prepare('SELECT session_version FROM users WHERE id=1').get().session_version,1);
   for(const table of ['sessions','two_factor_recovery_codes','two_factor_challenges','password_resets','email_verifications','push_subscriptions'])assert.equal(check.prepare(`SELECT count(*) n FROM ${table}`).get().n,0);
   assert.ok(check.prepare('SELECT secret FROM two_factor WHERE user_id=1').get().secret);assert.equal(check.prepare('SELECT status FROM notification_outbox').get().status,'cancelled');assert.equal(check.prepare('SELECT payload FROM notification_outbox').get().payload,'{}');
  }finally{check.close();}
  assert.equal(app.db.prepare('SELECT count(*) n FROM sessions').get().n,1);assert.equal(app.db.prepare('SELECT recovery_required FROM users').get().recovery_required,0);
  await assert.rejects(app.operations.restoreToDirectory(result.backupId,{targetDirectory:target,confirmation:'RESTORE TO NEW DIRECTORY'}),e=>e.code==='RECOVERY_TARGET_EXISTS');
  await assert.rejects(app.operations.restoreToDirectory(result.backupId,{targetDirectory:path.join(app.folder,'other'),confirmation:'yes'}),e=>e.code==='RECOVERY_CONFIRMATION_REQUIRED');
  await assert.rejects(app.operations.checkRecovery('../private'),e=>e.status===400);
 }finally{await app.close();}
});

test('a newer deletion ledger removes resurrected profiles and reserves deleted IDs missing from the older backup',async()=>{
 const app=await fixture();try{
  const original=await app.operations.backup();
  app.advance(1000);const receipt=app.controls.requestDeletion(1,{confirmation:'DELETE MY ACCOUNT'});assert.equal(receipt.status,'deleted');
  app.db.prepare("INSERT INTO users(id,email,name,market,password,created_at) VALUES(2,'new-private@example.com','New Private','forex','private-new-hash',?)").run(app.time());
  app.db.prepare("INSERT INTO accounts VALUES(2,'{}')").run();app.advance(1000);assert.equal(app.controls.requestDeletion(2,{confirmation:'DELETE MY ACCOUNT'}).status,'deleted');
  const target=path.join(app.folder,'after-deletion');const restored=await app.operations.restoreToDirectory(original.backupId,{targetDirectory:target,confirmation:'RESTORE TO NEW DIRECTORY'});assert.equal(restored.deletionsReapplied,2);
  const check=new DatabaseSync(path.join(target,'academy.sqlite'));try{for(const id of [1,2]){const user=check.prepare('SELECT email,name,password FROM users WHERE id=?').get(id);assert.match(user.email,/@deleted\.invalid$/);assert.equal(user.name,'Deleted account');assert.match(user.password,/^!deleted:/);assert.equal(check.prepare("SELECT status FROM account_deletions WHERE user_id=?").get(id).status,'deleted');}assert.equal(check.prepare('SELECT count(*) n FROM accounts').get().n,0);assert.equal(check.prepare('SELECT count(*) n FROM two_factor').get().n,0);}finally{check.close();}
 }finally{await app.close();}
});

test('ciphertext corruption and wrong keys fail recovery closed without changing live data or leaving output directories',async()=>{
 const app=await fixture();try{
  const result=await app.operations.backup(),file=path.join(app.folder,'backups',result.backupId+'.fabackup'),original=await readFile(file);
  const bad=Buffer.from(original);bad[Math.floor(bad.length/2)]^=1;await writeFile(file,bad,{mode:0o600});
  await assert.rejects(app.operations.checkRecovery(result.backupId),e=>e.status===503);assert.equal(app.operations.status().backups[0].state,'verification_failed');assert.equal(app.db.prepare('SELECT name FROM users').get().name,'Private Owner');assert.ok(!(await readdir(path.join(app.folder,'backups'))).some(x=>x.startsWith('.academy-recovery-')));
  await writeFile(file,original,{mode:0o600});await app.replaceOperations({encryptionKey:randomBytes(32).toString('base64')});const target=path.join(app.folder,'wrong-key');await assert.rejects(app.operations.restoreToDirectory(result.backupId,{targetDirectory:target,confirmation:'RESTORE TO NEW DIRECTORY'}),e=>e.status===503);assert.ok(!(await readdir(app.folder)).includes('wrong-key'));
 }finally{await app.close();}
});

test('recovery refuses to publish a target when a deletion completes while its worker is reading the backup',async()=>{
 const app=await fixture({factor:false});try{
  const original=await app.operations.backup();let armed=false;
  await app.replaceOperations({deletionLedger(){
   const ledger=app.controls.exportDeletionLedger();
   if(armed){armed=false;queueMicrotask(()=>app.controls.requestDeletion(1,{confirmation:'DELETE MY ACCOUNT'}));}
   return ledger;
  }});
  armed=true;const target=path.join(app.folder,'stale-deletion-target');
  await assert.rejects(app.operations.restoreToDirectory(original.backupId,{targetDirectory:target,confirmation:'RESTORE TO NEW DIRECTORY'}),e=>e.code==='RECOVERY_LEDGER_CHANGED');
  assert.ok(!(await readdir(app.folder)).includes('stale-deletion-target'));assert.equal(app.controls.isDeleted(1),true);
  const restored=await app.operations.restoreToDirectory(original.backupId,{targetDirectory:target,confirmation:'RESTORE TO NEW DIRECTORY'});assert.equal(restored.deletionsReapplied,1);
 }finally{await app.close();}
});

test('recovery preserves archived deletion records even when the supplied current ledger omits them',async()=>{
 const app=await fixture({factor:false});try{
  app.controls.requestDeletion(1,{confirmation:'DELETE MY ACCOUNT'});
  // A corrupted source profile must never override its completed deletion record.
  app.db.prepare("UPDATE users SET name='Corrupted private profile',email='corrupted-private@example.com' WHERE id=1").run();
  const result=await app.operations.backup();const current=app.controls.exportDeletionLedger();
  await app.replaceOperations({deletionLedger:()=>({...current,entries:[]})});
  const target=path.join(app.folder,'merged-ledger');await app.operations.restoreToDirectory(result.backupId,{targetDirectory:target,confirmation:'RESTORE TO NEW DIRECTORY'});
  const check=new DatabaseSync(path.join(target,'academy.sqlite'));try{assert.equal(check.prepare('SELECT name FROM users WHERE id=1').get().name,'Deleted account');assert.equal(check.prepare("SELECT status FROM account_deletions WHERE user_id=1").get().status,'deleted');}finally{check.close();}
 }finally{await app.close();}
});

test('a database relationship failure prevents a backup from being advertised as recoverable',async()=>{
 const app=await fixture({factor:false});try{
  app.db.exec('PRAGMA foreign_keys=OFF');app.db.prepare('INSERT INTO accounts VALUES (?,?)').run(404,'{}');app.db.exec('PRAGMA foreign_keys=ON');
  await assert.rejects(app.operations.backup(),e=>e.code==='RECOVERY_DATABASE_FAILED');
  assert.equal(app.operations.status().backups.length,0);assert.deepEqual((await readdir(path.join(app.folder,'backups'))).filter(name=>name!=='.academy-owner.json'),[]);
 }finally{await app.close();}
});

test('a mismatched authenticator key prevents a new verified backup and cleans failed artifacts',async()=>{
 const app=await fixture();try{
  await writeFile(path.join(app.folder,'two-factor-key.json'),JSON.stringify({version:1,key:randomBytes(32).toString('base64')}),{mode:0o600});
  await assert.rejects(app.operations.backup(),e=>e.code==='RECOVERY_AUTH_KEY_FAILED');assert.equal(app.operations.status().backups.length,0);assert.equal(app.operations.status().recentRuns[0].status,'failed');assert.ok(app.operations.status().errors.open>0);assert.deepEqual((await readdir(path.join(app.folder,'backups'))).filter(name=>name!=='.academy-owner.json'),[]);
 }finally{await app.close();}
});

test('scheduled jobs do not overlap, enforce rotation, and stop cleanly',async()=>{
 const app=await fixture({factor:false,options:{backupIntervalMs:60000,backupRetention:2}});try{
  assert.equal(await app.operations.runScheduled(),null);app.advance(11);
  const first=app.operations.runScheduled();await assert.rejects(app.operations.backup(),e=>e.code==='OPERATIONS_BUSY');await first;
  for(let i=0;i<3;i++){app.advance(60001);await app.operations.runScheduled();}
  assert.equal(app.operations.status().backups.length,2);assert.equal((await readdir(path.join(app.folder,'backups'))).filter(x=>x.endsWith('.fabackup')).length,2);
  app.operations.start();assert.equal(app.operations.status().automaticBackups,true);await app.operations.close();assert.equal(app.operations.status().automaticBackups,false);assert.equal(await app.operations.runScheduled(),null);await assert.rejects(app.operations.backup(),e=>e.code==='OPERATIONS_STOPPED');
 }finally{await app.close();}
});

test('separate SQLite writers share a job lease and observing status cannot mark an active backup failed',async()=>{
 const app=await fixture({factor:false});let other,otherDb;
 try{
  const pending=app.operations.backup();
  otherDb=new DatabaseSync(app.database);otherDb.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');
  other=createOperations(otherDb,app.database,app.settings);
  assert.equal(other.status().running,true);assert.equal(other.status().recentRuns[0].status,'running');
  await assert.rejects(other.backup(),e=>e.code==='OPERATIONS_BUSY');
  const result=await pending;assert.equal(result.verified,true);assert.equal(other.status().running,false);assert.equal(other.status().recentRuns[0].status,'completed');
  assert.equal((await other.backup()).verified,true);
  const target=path.join(app.folder,'lease-free-restore');await other.restoreToDirectory(result.backupId,{targetDirectory:target,confirmation:'RESTORE TO NEW DIRECTORY'});
  const restored=new DatabaseSync(path.join(target,'academy.sqlite'));try{assert.equal(restored.prepare('SELECT count(*) n FROM operations_job_lease').get().n,0);}finally{restored.close();}
 }finally{await other?.close();otherDb?.close();await app.close();}
});

test('dead operational workers cannot leave a permanent running job after restart',async()=>{
 const app=await fixture({factor:false});try{
  const runId='b6524b55-913e-4f29-bbe5-cc85f6f4ef93',owner='d673c9de-e2c7-4859-a606-d4c4bfb3b622';
  app.db.prepare("INSERT INTO operations_runs(id,kind,status,started_at) VALUES(?,'backup','running',?)").run(runId,app.time());
  app.db.prepare('INSERT INTO operations_job_lease VALUES(1,?,?,?,?)').run(owner,2147483647,runId,app.time()+600000);
  assert.equal(app.operations.status().running,false);
  await app.replaceOperations();assert.equal(app.operations.status().recentRuns[0].failureCode,'PROCESS_RESTARTED');assert.equal((await app.operations.backup()).verified,true);
 }finally{await app.close();}
});

test('backup paths reject public storage, symbolic links, invalid settings, and missing original keys',async()=>{
 const app=await fixture();try{
  assert.throws(()=>createOperations(app.db,app.database,{backupDirectory:path.resolve(import.meta.dirname,'../public/private-backups')}),e=>e.code==='BACKUP_PATH_UNSAFE');
  const linked=path.join(app.folder,'linked');await symlink(path.join(app.folder,'backups'),linked);assert.throws(()=>createOperations(app.db,app.database,{backupDirectory:linked}),e=>e.code==='BACKUP_PATH_UNSAFE');
  for(const options of [{backupRetention:0},{backupRetention:91},{backupIntervalMs:10},{maxBackupBytes:1},{encryptionKey:'secret'}])assert.throws(()=>createOperations(app.db,app.database,options));
  await app.operations.backup();await app.operations.close();await rm(path.join(app.folder,'backup-key.json'));assert.throws(()=>createOperations(app.db,app.database,{encryptionKey:''}),e=>e.code==='BACKUP_KEY_MISSING');
 }finally{await app.close();}
});

async function cli(database,args){return new Promise((resolve,reject)=>{const child=spawn(process.execPath,['operations-cli.mjs',...args],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,DATABASE_PATH:database,BACKUP_DIRECTORY:path.join(path.dirname(database),'backups'),BACKUP_ENCRYPTION_KEY:'',TWO_FACTOR_ENCRYPTION_KEY:''}});let out='',err='';child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);child.once('error',reject);child.once('close',code=>resolve({code,out,err}));});}
test('operational CLI validates commands and only restores into a new destination with explicit confirmation',async()=>{
 const app=await fixture();try{
  const backup=await app.operations.backup();
  const status=await cli(app.database,['status']);assert.equal(status.code,0,status.err);assert.equal(JSON.parse(status.out).encrypted,true);
  const verified=await cli(app.database,['verify','--backup',backup.backupId]);assert.equal(verified.code,0,verified.err);assert.equal(JSON.parse(verified.out).productionModified,false);
  for(const args of [['restore','--backup',backup.backupId,'--target',app.folder],['status','--backup',backup.backupId],['verify','--target','bad']])assert.equal((await cli(app.database,args)).code,1);
  const target=path.join(app.folder,'cli-recovery');const result=await cli(app.database,['restore','--backup',backup.backupId,'--target',target,'--confirmation','RESTORE TO NEW DIRECTORY']);assert.equal(result.code,0,result.err);assert.equal(JSON.parse(result.out).restoredToNewDirectory,true);
  assert.equal((await cli(path.join(app.folder,'missing.sqlite'),['status'])).code,1);assert.equal(app.db.prepare('SELECT recovery_required FROM users').get().recovery_required,0);
 }finally{await app.close();}
});


test('restart removes abandoned plaintext and partial backup paths, including registered external recovery copies',async()=>{
 const app=await fixture({factor:false});try{
  const directory=path.join(app.folder,'backups'),snapshot=path.join(directory,'.academy-snapshot-abandoned'),recovery=path.join(directory,'.academy-recovery-abandoned'),external=path.join(app.folder,'.academy-recovery-external'),pending=path.join(directory,randomUUID()+'.pending');
  for(const target of [snapshot,recovery,external]){await mkdir(target,{mode:0o700});await writeFile(path.join(target,'academy.sqlite'),'abandoned private user data',{mode:0o600});}
  await writeFile(pending,'partial encrypted artifact',{mode:0o600});
  app.db.prepare('INSERT INTO operations_temporary_paths VALUES (?,?,?,?)').run(external,'recovery',randomUUID(),2147483647);
  const unrelated=path.join(directory,'operator-notes');await mkdir(unrelated);await writeFile(path.join(unrelated,'keep.txt'),'operator managed');
  const target=path.join(app.folder,'unrelated-target');await mkdir(target);await writeFile(path.join(target,'keep.txt'),'must survive');
  const linked=path.join(directory,'.academy-recovery-link');await symlink(target,linked);
  await app.replaceOperations();
  for(const target of [snapshot,recovery,external,pending])await assert.rejects(stat(target),error=>error.code==='ENOENT');
  assert.equal(await readFile(path.join(unrelated,'keep.txt'),'utf8'),'operator managed');assert.equal(await readFile(path.join(target,'keep.txt'),'utf8'),'must survive');
  assert.equal(app.db.prepare('SELECT count(*) n FROM operations_temporary_paths').get().n,0);
 }finally{await app.close();}
});

test('startup cleanup preserves temporary files while another live process owns the operational lease',async()=>{
 const app=await fixture({factor:false});let other,otherDb;try{
  const owner=randomUUID(),run=randomUUID(),temporary=path.join(app.folder,'backups','.academy-snapshot-live');
  await mkdir(temporary,{mode:0o700});await writeFile(path.join(temporary,'academy.sqlite'),'active worker content',{mode:0o600});
  app.db.prepare("INSERT INTO operations_runs(id,kind,status,started_at) VALUES (?,'backup','running',?)").run(run,app.time());
  app.db.prepare('INSERT INTO operations_job_lease VALUES (1,?,?,?,?)').run(owner,process.pid,run,app.time()+600000);
  app.db.prepare('INSERT INTO operations_temporary_paths VALUES (?,?,?,?)').run(temporary,'snapshot',owner,process.pid);
  otherDb=new DatabaseSync(app.database);otherDb.exec('PRAGMA foreign_keys=ON;PRAGMA busy_timeout=5000;');other=createOperations(otherDb,app.database,app.settings);
  assert.equal(await readFile(path.join(temporary,'academy.sqlite'),'utf8'),'active worker content');assert.equal(other.status().recentRuns[0].status,'running');
  await assert.rejects(other.backup(),error=>error.code==='OPERATIONS_BUSY');
  app.db.prepare('DELETE FROM operations_job_lease').run();app.db.prepare('UPDATE operations_temporary_paths SET process_id=2147483647').run();
  await app.replaceOperations();await assert.rejects(stat(temporary),error=>error.code==='ENOENT');
 }finally{await other?.close();otherDb?.close();await app.close();}
});

test('backup directories cannot be shared by unrelated database installations',async()=>{
 const app=await fixture({factor:false});let otherDb;try{
  const otherFile=path.join(app.folder,'second.sqlite');otherDb=new DatabaseSync(otherFile);otherDb.exec('CREATE TABLE users(id INTEGER PRIMARY KEY);');
  assert.throws(()=>createOperations(otherDb,otherFile,{backupDirectory:path.join(app.folder,'backups')}),error=>error.code==='BACKUP_DIRECTORY_IN_USE');
  assert.equal((await app.operations.backup()).verified,true);
 }finally{otherDb?.close();await app.close();}
});
