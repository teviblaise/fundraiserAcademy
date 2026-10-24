import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createOperationalHealth} from '../operational-health.mjs';

async function fixture(options={}){
  const folder=await mkdtemp(path.join(tmpdir(),'academy-health-')),database=path.join(folder,'private-academy.sqlite');
  const db=new DatabaseSync(database);db.exec(`PRAGMA journal_mode=WAL;PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT,password TEXT);
    INSERT INTO users VALUES(1,'private-person@example.com','private-password-hash');
    CREATE TABLE account_details(user_id INTEGER REFERENCES users(id),private_note TEXT);
    INSERT INTO account_details VALUES(1,'private-trading-record');
    CREATE TABLE notification_outbox(id INTEGER PRIMARY KEY,status TEXT,next_at INTEGER,target TEXT,payload TEXT);
    CREATE TABLE sponsored_sync_links(account_id TEXT PRIMARY KEY,active INTEGER,linked_at INTEGER,last_success_at INTEGER,error_code TEXT);`);
  let clock=Date.UTC(2026,9,22,12),op={enabled:true,automaticBackups:true,backupIntervalHours:24,offsiteConfigured:false,backups:[{id:randomUUID(),createdAt:clock-60000,verifiedAt:clock-30000,state:'verified'}],recentRuns:[{status:'completed'}],errors:{open:0}},provider={configured:true,automaticSync:true,intervalSeconds:60},config={emailAvailable:true,forexConfigured:true};
  const settings={now:()=>clock,operations:{status:()=>op},sponsored:{status:()=>provider},configuration:()=>config,storageStats:()=>({blocks:1024*1024,bavail:512*1024,bsize:4096}),...options};
  const instances=[];
  function create(extra={}){const health=createOperationalHealth(db,database,{...settings,...extra});instances.push(health);return health;}
  const health=create();
  return{folder,database,db,health,create,op,provider,config,time:()=>clock,advance:value=>{clock+=value;},async script(code){const filename=path.join(folder,randomUUID()+'.mjs');await writeFile(filename,code,{mode:0o600});return filename;},async close(){for(const item of instances)await item.close();try{db.close();}catch{}await rm(folder,{recursive:true,force:true});}};
}
const check=(status,id)=>status.checks.find(item=>item.id===id);

test('cleared-funds initiation health tracks receipt obligations independently of withdrawal requests and hides private ledger details',async()=>{
  const payments={overdueReceipts:0,uninitiatedTraderShareCents:0,overdueTraderShareCents:0};
  const app=await fixture({paymentProcessing:()=>payments});try{
    assert.equal(check(app.health.status(),'payout-processing').state,'ok');
    payments.uninitiatedTraderShareCents=50000;
    assert.equal(check(app.health.status(),'payout-processing').state,'warning');
    payments.overdueReceipts=1;payments.overdueTraderShareCents=25000;payments.privateEvidence='private-payout-reference';
    const report=app.health.status(),finding=check(report,'payout-processing');
    assert.equal(finding.state,'critical');assert.match(finding.summary,/USD 250\.00 is overdue/);assert.match(finding.action,/withdrawal request or approval does not satisfy/);assert.doesNotMatch(JSON.stringify(report),/private-payout-reference/);
    payments.overdueReceipts=-1;assert.equal(check(app.health.status(),'payout-processing').state,'warning');
  }finally{await app.close();}
});

test('live readiness uses current truthful configuration and finite aggregate metrics without exposing identities or paths',async()=>{
  const app=await fixture();try{
    const report=app.health.status();assert.equal(report.overall,'attention');assert.equal(check(report,'database').state,'ok');assert.equal(check(report,'backup-freshness').state,'ok');assert.equal(check(report,'offsite-backups').state,'warning');assert.equal(check(report,'persistent-storage').state,'warning');assert.equal(check(report,'email').state,'ok');assert.match(check(report,'email').summary,/not probed/);assert.equal(report.lastDiagnostic,null);
    for(const value of Object.values(report.metrics))assert.ok(value===null||Number.isFinite(value)&&value>=0&&value<=Number.MAX_SAFE_INTEGER);
    assert.ok(report.metrics.databaseBytes>0);assert.ok(report.metrics.rssBytes>0);assert.equal(report.metrics.storageFreeBytes,2*1024**3);
    app.config.emailAvailable=false;app.config.forexConfigured=false;
    const changed=app.health.status();assert.equal(check(changed,'email').state,'warning');assert.equal(check(changed,'forex').state,'warning');
    assert.doesNotMatch(JSON.stringify(changed),/private-person|password-hash|trading-record|private-academy|\/tmp\/|resend_[a-z0-9]+/);
  }finally{await app.close();}
});

test('backup failures, overdue age, stopped schedulers, and open incidents produce actionable distinct health checks',async()=>{
  const app=await fixture();try{
    app.advance(26*3600000);assert.equal(check(app.health.status(),'backup-freshness').state,'warning');
    app.advance(24*3600000);assert.equal(check(app.health.status(),'backup-freshness').state,'critical');
    app.op.backups[0].state='verification_failed';app.op.automaticBackups=false;app.op.recentRuns=[{status:'failed',failureCode:'private-exception'}];app.op.errors.open=3;
    const result=app.health.status();assert.equal(result.overall,'critical');assert.equal(check(result,'backup-integrity').state,'critical');assert.equal(check(result,'backup-scheduler').state,'warning');assert.equal(check(result,'backup-jobs').state,'warning');assert.equal(check(result,'incidents').state,'warning');assert.doesNotMatch(JSON.stringify(result),/private-exception/);
    const observer=app.create({observer:true});assert.equal(check(observer.status(),'backup-scheduler').state,'disabled');
  }finally{await app.close();}
});

test('storage thresholds distinguish low, critical, and unavailable capacity without exposing filesystem errors',async()=>{
  const app=await fixture();try{
    for(const [free,expected] of [[256*1024*1024,'ok'],[32*1024*1024,'warning'],[8*1024*1024,'critical']]){
      const health=app.create({storageStats:()=>({blocks:1024*1024,bavail:free/4096,bsize:4096})});
      assert.equal(check(health.status(),'storage-capacity').state,expected);
    }
    const unavailable=app.create({storageStats:()=>{throw new Error('secret-host-private-volume');}}).status();assert.equal(unavailable.metrics.storageFreeBytes,null);assert.equal(check(unavailable,'storage-capacity').state,'warning');assert.doesNotMatch(JSON.stringify(unavailable),/secret-host-private-volume/);
  }finally{await app.close();}
});

test('queue health counts overdue scheduled attempts honestly and never returns delivery targets or payloads',async()=>{
  const app=await fixture();try{
    const insert=app.db.prepare('INSERT INTO notification_outbox(status,next_at,target,payload) VALUES(?,?,?,?)');
    insert.run('pending',app.time()-300001,'secret-recipient@example.com','private-reset-token');
    insert.run('pending',app.time()+60000,'secret-other@example.com','private-queue');
    insert.run('failed',app.time(),'secret-failed@example.com','private-delivery');
    insert.run('sent',app.time()-999999,'secret-sent@example.com','private-delivered');
    const report=app.health.status(),queue=check(report,'delivery-queue');assert.equal(queue.state,'warning');assert.match(queue.summary,/1 pending deliveries.*scheduled attempt; 1 deliveries have failed/);assert.doesNotMatch(JSON.stringify(report),/secret-recipient|secret-other|private-reset-token|private-queue|private-delivery/);
  }finally{await app.close();}
});

test('active MetaApi links report missing configuration, first observations, stale data and errors without broker IDs',async()=>{
  const app=await fixture();try{
    app.db.prepare('INSERT INTO sponsored_sync_links VALUES(?,?,?,?,?)').run('private-provider-account-id',1,app.time()-1000,null,null);
    assert.equal(check(app.health.status(),'metaapi').state,'warning');
    app.provider.configured=false;assert.equal(check(app.health.status(),'metaapi').state,'critical');app.provider.configured=true;
    app.advance(301000);assert.equal(check(app.health.status(),'metaapi').state,'critical');
    app.db.prepare('UPDATE sponsored_sync_links SET last_success_at=?,error_code=?').run(app.time(),'private-provider-error');assert.equal(check(app.health.status(),'metaapi').state,'warning');
    app.db.exec('UPDATE sponsored_sync_links SET error_code=NULL');assert.equal(check(app.health.status(),'metaapi').state,'ok');
    app.provider.automaticSync=false;assert.equal(check(app.health.status(),'metaapi').state,'warning');assert.equal(check(app.create({observer:true}).status(),'metaapi').state,'ok');assert.doesNotMatch(JSON.stringify(app.health.status()),/private-provider-account-id|private-provider-error/);
  }finally{await app.close();}
});

test('real diagnostic checks read-only integrity and foreign keys and cleans its private probe without mutating user data',async()=>{
  const app=await fixture();try{
    const users=app.db.prepare('SELECT * FROM users').all(),records=app.db.prepare('SELECT * FROM account_details').all();
    const result=await app.health.diagnose();assert.equal(result.state,'ok');assert.equal(result.database,'ok');assert.equal(result.integrity,'ok');assert.equal(result.foreignKeys,'ok');assert.equal(result.storageWritable,'ok');assert.equal(result.failureCode,null);assert.ok(result.completedAt>=result.startedAt);
    assert.deepEqual(app.db.prepare('SELECT * FROM users').all(),users);assert.deepEqual(app.db.prepare('SELECT * FROM account_details').all(),records);assert.equal(app.db.prepare('SELECT count(*) count FROM operations_diagnostic_lease').get().count,0);assert.ok(!(await readdir(app.folder)).some(name=>name.startsWith('.academy-health-')));
    const status=app.health.status();assert.equal(status.lastDiagnostic.id,result.id);assert.equal(status.diagnosticRuns.length,1);assert.equal(check(status,'diagnostics').state,'ok');assert.doesNotMatch(JSON.stringify(result),/private|\.sqlite|\/tmp\//);
  }finally{await app.close();}
});

test('foreign-key violations fail diagnostics with a fixed safe code and leave the original records intact',async()=>{
  const app=await fixture();try{
    app.db.exec("PRAGMA foreign_keys=OFF;INSERT INTO account_details VALUES(99,'private-corrupt-record');PRAGMA foreign_keys=ON;");
    const result=await app.health.diagnose();assert.equal(result.database,'ok');assert.equal(result.integrity,'ok');assert.equal(result.foreignKeys,'failed');assert.equal(result.state,'critical');assert.equal(result.failureCode,'DIAGNOSTIC_FOREIGN_KEYS_FAILED');assert.equal(app.db.prepare('SELECT count(*) n FROM account_details WHERE user_id=99').get().n,1);assert.equal(check(app.health.status(),'diagnostics').state,'critical');assert.doesNotMatch(JSON.stringify(result),/account_details|private-corrupt/);
  }finally{await app.close();}
});

test('separate health instances share a diagnostic lease and close waits for bounded work',async()=>{
  const app=await fixture();try{
    const second=app.create();const pending=app.health.diagnose();assert.equal(app.health.status().diagnosticRunning,true);
    await assert.rejects(app.health.diagnose(),error=>error.status===409&&error.code==='OPERATIONS_DIAGNOSTIC_BUSY');
    await assert.rejects(second.diagnose(),error=>error.status===409&&error.code==='OPERATIONS_DIAGNOSTIC_BUSY');
    await app.health.close();assert.equal((await pending).state,'ok');await assert.rejects(app.health.diagnose(),error=>error.status===503);
    assert.equal((await second.diagnose()).state,'ok');
  }finally{await app.close();}
});

test('timeouts kill a stuck diagnostic process, remove its writable probe and release the lease for a later diagnostic',async()=>{
  const app=await fixture();try{
    const diagnosticScript=await app.script("import {writeFileSync} from 'node:fs';process.once('message',input=>{writeFileSync(input.probePath,'private-probe',{mode:0o600,flag:'wx'});setInterval(()=>{},1000);});");
    const stuck=app.create({diagnosticTimeoutMs:300,diagnosticScript});
    const started=Date.now(),result=await stuck.diagnose();assert.ok(Date.now()-started<3000);assert.equal(result.state,'critical');assert.equal(result.failureCode,'DIAGNOSTIC_TIMEOUT');assert.ok(!(await readdir(app.folder)).some(name=>name.startsWith('.academy-health-')));assert.equal(app.db.prepare('SELECT count(*) n FROM operations_diagnostic_lease').get().n,0);
    assert.equal((await app.health.diagnose()).state,'ok');
  }finally{await app.close();}
});

test('native synchronous SQLite work is forcibly terminated at the deadline before cleanup and lease release',async()=>{
  const app=await fixture();try{
    const diagnosticScript=await app.script("import {DatabaseSync} from 'node:sqlite';import {writeFileSync} from 'node:fs';process.once('message',input=>{const db=new DatabaseSync(input.databasePath,{readOnly:true});writeFileSync(input.probePath,'private-probe',{mode:0o600,flag:'wx'});writeFileSync(input.databasePath+'.native-started',String(process.pid),{mode:0o600,flag:'wx'});db.prepare('WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<200000000) SELECT sum(n) FROM c').get();process.send({database:'ok',integrity:'ok',foreignKeys:'ok',storageWritable:'ok'});});");
    const health=app.create({diagnosticTimeoutMs:2000,diagnosticScript});const started=Date.now();const result=await health.diagnose();
    const pid=Number(await readFile(app.database+'.native-started','utf8'));assert.ok(Number.isSafeInteger(pid)&&pid>0);assert.ok(Date.now()-started<6000,'native SQLite work must not defer timeout completion');assert.equal(result.failureCode,'DIAGNOSTIC_TIMEOUT');assert.throws(()=>process.kill(pid,0),error=>error.code==='ESRCH');assert.ok(!(await readdir(app.folder)).some(name=>name.startsWith('.academy-health-')));assert.equal(app.db.prepare('SELECT count(*) n FROM operations_diagnostic_lease').get().n,0);assert.equal((await app.health.diagnose()).state,'ok');
  }finally{await app.close();}
});

test('the diagnostic supervisor kills native SQLite work immediately when its parent disconnects',async()=>{
  const app=await fixture();let child,exited;
  try{
    const diagnosticWorkerScript=await app.script("import {DatabaseSync} from 'node:sqlite';import {writeFileSync} from 'node:fs';import {workerData} from 'node:worker_threads';const db=new DatabaseSync(workerData.databasePath,{readOnly:true});writeFileSync(workerData.probePath+'.started',String(process.pid),{mode:0o600,flag:'wx'});db.prepare('WITH RECURSIVE c(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM c WHERE n<200000000) SELECT sum(n) FROM c').get();");
    const probe=path.join(app.folder,'parent-disconnect-probe');
    child=fork(fileURLToPath(new URL('../operational-health.mjs',import.meta.url)),['--academy-operational-diagnostic'],{execArgv:['--max-old-space-size=64'],env:{},stdio:['ignore','ignore','ignore','ipc']});
    exited=new Promise(resolve=>{child.once('exit',(code,signal)=>resolve({code,signal}));child.once('error',error=>resolve({error}));});
    child.send({task:'academy-operational-diagnostic',databasePath:app.database,probePath:probe,inspectionScript:diagnosticWorkerScript,timeoutMs:10000});
    const deadline=Date.now()+5000;let started=false;
    while(Date.now()<deadline){try{await readFile(probe+'.started');started=true;break;}catch{await delay(20);}}
    assert.equal(started,true,'the native SQLite statement must start before the parent disconnects');
    const at=Date.now();child.disconnect();const result=await exited;assert.equal(result.signal,'SIGKILL');assert.ok(Date.now()-at<2000,'parent loss must not wait for the native query to return');assert.throws(()=>process.kill(child.pid,0),error=>error.code==='ESRCH');
  }finally{if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');if(exited)await exited;await app.close();}
});

test('unexpected child-process/SQL errors and output fields are sanitized into bounded diagnostic history',async()=>{
  const app=await fixture();try{
    const broken=app.create({diagnosticScript:await app.script("throw new Error('private-person@example.com /private/database.sqlite SQL=password');")});
    const failed=await broken.diagnose();assert.equal(failed.failureCode,'DIAGNOSTIC_WORKER_FAILED');assert.doesNotMatch(JSON.stringify(failed),/private-person|database.sqlite|password/);
    const output=app.create({diagnosticScript:await app.script("process.once('message',()=>process.send({database:'private-SQL-error',integrity:'ok',foreignKeys:'ok',storageWritable:'failed',secret:'private-secret-token'}));")});
    const safe=await output.diagnose();assert.equal(safe.database,'unavailable');assert.equal(safe.failureCode,'DIAGNOSTIC_DATABASE_FAILED');assert.doesNotMatch(JSON.stringify(safe),/private-SQL|private-secret/);
    app.db.exec('DROP TABLE notification_outbox;CREATE TABLE notification_outbox(private_schema TEXT);');const status=app.health.status();assert.equal(check(status,'delivery-queue').state,'warning');assert.doesNotMatch(JSON.stringify(status),/private_schema|no such column/);
  }finally{await app.close();}
});

test('diagnostic retention removes old runs and bounds persisted completed history while returning only ten reports',async()=>{
  const app=await fixture();try{
    const insert=app.db.prepare("INSERT INTO operations_diagnostic_runs(id,started_at,completed_at,state) VALUES(?,?,?,'ok')");
    for(let index=0;index<105;index++)insert.run(randomUUID(),app.time()-index*1000,app.time()-index*1000);
    insert.run(randomUUID(),app.time()-31*86400000,app.time()-31*86400000);
    const health=app.create();assert.equal(health.status().diagnosticRuns.length,10);assert.equal(app.db.prepare('SELECT count(*) n FROM operations_diagnostic_runs').get().n,100);assert.equal(app.db.prepare('SELECT count(*) n FROM operations_diagnostic_runs WHERE completed_at<?').get(app.time()-30*86400000).n,0);
    await health.diagnose();assert.equal(app.db.prepare('SELECT count(*) n FROM operations_diagnostic_runs').get().n,100);
  }finally{await app.close();}
});

test('dead-process diagnostics are interrupted on restart and the next check can run',async()=>{
  const app=await fixture();try{
    const id=randomUUID();app.db.prepare("INSERT INTO operations_diagnostic_runs(id,started_at,state) VALUES(?,?,'running')").run(id,app.time());app.db.prepare('INSERT INTO operations_diagnostic_lease VALUES(1,?,?,?,?)').run(randomUUID(),2147483647,id,app.time()+60000);
    const restarted=app.create();assert.equal(restarted.status().lastDiagnostic.failureCode,'DIAGNOSTIC_INTERRUPTED');assert.equal(restarted.status().diagnosticRunning,false);assert.equal((await restarted.diagnose()).state,'ok');
  }finally{await app.close();}
});

test('a successful diagnostic becomes stale after 24 hours without losing its original timestamp',async()=>{
  const app=await fixture();try{
    const result=await app.health.diagnose();app.advance(86400000);assert.equal(check(app.health.status(),'diagnostics').state,'ok');app.advance(1);
    const status=app.health.status();assert.equal(check(status,'diagnostics').state,'warning');assert.match(check(status,'diagnostics').summary,/more than 24 hours old/);assert.equal(status.lastDiagnostic.completedAt,result.completedAt);
  }finally{await app.close();}
});

test('read-only diagnostics report a missing database path safely without creating a replacement file',async()=>{
  const app=await fixture();try{
    const missing=path.join(app.folder,'private-missing.sqlite'),health=createOperationalHealth(app.db,missing,{now:app.time,operations:{status:()=>app.op},diagnosticTimeoutMs:10000});
    try{const result=await health.diagnose();assert.equal(result.database,'failed');assert.equal(result.failureCode,'DIAGNOSTIC_DATABASE_FAILED');assert.equal(result.storageWritable,'ok');assert.equal((await readdir(app.folder)).includes('private-missing.sqlite'),false);assert.doesNotMatch(JSON.stringify(result),/private-missing|CANTOPEN|unable to open/);}finally{await health.close();}
  }finally{await app.close();}
});
