import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {closeSync, constants, existsSync, fsyncSync, lstatSync, openSync, statfsSync, statSync, unlinkSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fork} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isMainThread,parentPort,Worker,workerData} from 'node:worker_threads';

const failure=(status,code,message)=>Object.assign(new Error(message),{status,code});
const alive=pid=>{if(!Number.isSafeInteger(pid)||pid<1)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}};
const number=value=>typeof value==='number'&&Number.isFinite(value)&&value>=0?Math.min(value,Number.MAX_SAFE_INTEGER):null;
const integer=value=>Number.isSafeInteger(value)&&value>=0?value:0;
const states=new Set(['ok','warning','critical','running']);
const databaseStates=new Set(['ok','failed','unavailable']);
const checkStates=new Set(['ok','failed','not_checked']);
const codes=new Set(['DIAGNOSTIC_TIMEOUT','DIAGNOSTIC_DATABASE_FAILED','DIAGNOSTIC_INTEGRITY_FAILED','DIAGNOSTIC_FOREIGN_KEYS_FAILED','DIAGNOSTIC_STORAGE_FAILED','DIAGNOSTIC_WORKER_FAILED','DIAGNOSTIC_INTERRUPTED']);
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const emptyResult=()=>({database:'unavailable',integrity:'not_checked',foreignKeys:'not_checked',storageWritable:'not_checked'});

function inspect({databasePath,probePath}){
  const result=emptyResult();let db,fd;
  try{
    db=new DatabaseSync(databasePath,{readOnly:true});
    db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000; BEGIN;');
    db.prepare('SELECT 1').get();result.database='ok';
    result.integrity=db.prepare('PRAGMA quick_check(1)').all().every(row=>row.quick_check==='ok')?'ok':'failed';
    result.foreignKeys=db.prepare('SELECT EXISTS(SELECT 1 FROM pragma_foreign_key_check LIMIT 1) failed').get().failed?'failed':'ok';
  }catch{result.database='failed';}finally{try{if(db?.isTransaction)db.exec('ROLLBACK');db?.close();}catch{}}
  try{
    fd=openSync(probePath,constants.O_CREAT|constants.O_EXCL|constants.O_WRONLY|(constants.O_NOFOLLOW||0),0o600);
    writeFileSync(fd,'Fundraiser Academy storage check\n');fsyncSync(fd);closeSync(fd);fd=undefined;
    unlinkSync(probePath);result.storageWritable='ok';
  }catch{result.storageWritable='failed';}finally{if(fd!==undefined)try{closeSync(fd);}catch{}}
  return result;
}

if(!isMainThread&&workerData?.task==='academy-operational-inspection'){
  parentPort.postMessage(inspect(workerData));
}else if(isMainThread&&process.argv.includes('--academy-operational-diagnostic')&&typeof process.send==='function'){
  const kill=()=>process.kill(process.pid,'SIGKILL');
  process.once('message',input=>{
    if(input?.task!=='academy-operational-diagnostic'||typeof input.inspectionScript!=='string'||!path.isAbsolute(input.inspectionScript)||!Number.isSafeInteger(input.timeoutMs)||input.timeoutMs<10||input.timeoutMs>30000)kill();
    // Keep the supervisor event loop responsive even while SQLite is in native code.
    // Parent loss and the independent deadline terminate the complete process.
    setTimeout(kill,input.timeoutMs).unref();
    const inspection=new Worker(input.inspectionScript,{workerData:{task:'academy-operational-inspection',databasePath:input.databasePath,probePath:input.probePath},stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:64}});
    inspection.stdout.resume();inspection.stderr.resume();
    inspection.once('message',result=>process.send(result,error=>{if(error)kill();}));
    inspection.once('error',kill);
  });
  process.once('disconnect',kill);
}

/** Private, aggregate readiness checks. No provider request or user-data repair is performed. */
export function createOperationalHealth(db,databasePath,{now=Date.now,operations,sponsored,configuration=()=>({emailAvailable:false,forexConfigured:false}),observer=false,diagnosticTimeoutMs=10000,storageStats=statfsSync,diagnosticScript=fileURLToPath(import.meta.url),diagnosticWorkerScript=fileURLToPath(import.meta.url)}={}){
  if(typeof now!=='function'||!operations?.status||typeof configuration!=='function'||typeof storageStats!=='function'||!Number.isSafeInteger(diagnosticTimeoutMs)||diagnosticTimeoutMs<10||diagnosticTimeoutMs>30000||[diagnosticScript,diagnosticWorkerScript].some(script=>typeof script!=='string'||!path.isAbsolute(script)))throw new TypeError('Provide operational status services, local diagnostic scripts, and a timeout of 10–30000 milliseconds.');
  const source=path.resolve(databasePath),directory=path.dirname(source);
  db.exec(`CREATE TABLE IF NOT EXISTS operations_diagnostic_runs (
    id TEXT PRIMARY KEY,started_at INTEGER NOT NULL,completed_at INTEGER,
    state TEXT NOT NULL CHECK(state IN ('running','ok','warning','critical')),
    database_state TEXT NOT NULL DEFAULT 'unavailable',integrity_state TEXT NOT NULL DEFAULT 'not_checked',
    foreign_keys_state TEXT NOT NULL DEFAULT 'not_checked',storage_writable_state TEXT NOT NULL DEFAULT 'not_checked',failure_code TEXT);
    CREATE INDEX IF NOT EXISTS operations_diagnostic_started ON operations_diagnostic_runs(started_at DESC);
    CREATE TABLE IF NOT EXISTS operations_diagnostic_lease (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),owner TEXT NOT NULL,process_id INTEGER NOT NULL,run_id TEXT NOT NULL,expires_at INTEGER NOT NULL);`);
  let active=null,closed=false;
  function trim(){
    db.prepare("DELETE FROM operations_diagnostic_runs WHERE state<>'running' AND completed_at<?").run(now()-30*86400000);
    db.prepare("DELETE FROM operations_diagnostic_runs WHERE id IN (SELECT id FROM operations_diagnostic_runs WHERE state<>'running' ORDER BY started_at DESC,rowid DESC LIMIT -1 OFFSET 100)").run();
  }
  function interrupted(lease){
    db.prepare("UPDATE operations_diagnostic_runs SET state='critical',completed_at=?,failure_code='DIAGNOSTIC_INTERRUPTED' WHERE id=? AND state='running'").run(now(),lease.run_id);
    db.prepare('DELETE FROM operations_diagnostic_lease WHERE owner=?').run(lease.owner);
  }
  const previous=db.prepare('SELECT * FROM operations_diagnostic_lease WHERE singleton=1').get();
  if(previous&&!alive(previous.process_id))interrupted(previous);
  trim();
  function runView(row){
    if(typeof row.id!=='string'||!uuid.test(row.id))return null;
    return{id:row.id,startedAt:integer(row.started_at),completedAt:row.completed_at===null?null:integer(row.completed_at),state:states.has(row.state)?row.state:'critical',
      database:databaseStates.has(row.database_state)?row.database_state:'unavailable',integrity:checkStates.has(row.integrity_state)?row.integrity_state:'not_checked',
      foreignKeys:checkStates.has(row.foreign_keys_state)?row.foreign_keys_state:'not_checked',storageWritable:checkStates.has(row.storage_writable_state)?row.storage_writable_state:'not_checked',
      failureCode:codes.has(row.failure_code)?row.failure_code:null};
  }
  function runs(){try{return db.prepare('SELECT * FROM operations_diagnostic_runs ORDER BY started_at DESC,rowid DESC LIMIT 10').all().map(runView).filter(Boolean);}catch{return[];}}
  function status(){
    const checkedAt=now(),checks=[];
    const add=(id,label,state,summary,action='No action needed.')=>checks.push({id,label,state,summary,action});
    let available=true;try{db.prepare('SELECT 1').get();add('database','Database connection','ok','The application database answered a local query.');}catch{available=false;add('database','Database connection','critical','The application database could not be queried.','Inspect private database storage and server errors.');}
    let disk;try{disk=storageStats(directory);}catch{}
    const total=number(Number(disk?.blocks)*Number(disk?.bsize)),free=number(Number(disk?.bavail)*Number(disk?.bsize));
    if(total===null||free===null||total===0)add('storage-capacity','Storage capacity','warning','Private-storage capacity could not be measured.','Check storage availability and available disk space on the application host.');
    else if(free<16*1024*1024)add('storage-capacity','Storage capacity','critical','Less than 16 MiB is available on the database filesystem.','Free storage or expand the private persistent volume before writes fail.');
    else if(free<64*1024*1024||free/total<0.05)add('storage-capacity','Storage capacity','warning','Available database-filesystem space is below 64 MiB or 5%.','Plan additional private persistent storage and review backup retention.');
    else add('storage-capacity','Storage capacity','ok','The database filesystem has capacity above the warning thresholds.');
    let op;try{op=operations.status();}catch{}
    if(!op)add('backups','Encrypted backups','critical','The backup service status is unavailable.','Inspect the private backup directory, encryption key, and database.');
    else{
      const backups=Array.isArray(op.backups)?op.backups:[],latest=backups[0],verified=backups.filter(item=>item.state==='verified'&&Number.isSafeInteger(item.createdAt)&&item.createdAt<=checkedAt).sort((a,b)=>b.createdAt-a.createdAt)[0];
      const interval=number(op.backupIntervalHours)>0?op.backupIntervalHours*3600000:86400000;
      if(!verified)add('backup-freshness','Backup freshness','warning','No successfully verified backup is recorded.','Create an encrypted backup and complete an isolated recovery check.');
      else if(checkedAt-verified.createdAt>2*interval)add('backup-freshness','Backup freshness','critical','The latest verified backup is older than two configured backup intervals.','Create and verify a new backup; inspect the scheduler and recent failures.');
      else if(checkedAt-verified.createdAt>interval+Math.min(interval/4,3600000))add('backup-freshness','Backup freshness','warning','The latest verified backup is overdue for the configured interval.','Inspect the scheduler and create a current verified backup.');
      else add('backup-freshness','Backup freshness','ok','A verified backup is within the configured freshness interval.');
      if(latest?.state==='verification_failed')add('backup-integrity','Backup verification','critical','The newest backup failed its most recent recovery verification.','Investigate storage and keys, then create and verify a new encrypted backup.');
      else if(latest&&latest.state!=='verified')add('backup-integrity','Backup verification','warning','The newest backup does not have a successful recovery verification.','Run an isolated recovery check before relying on this artifact.');
      else if(latest)add('backup-integrity','Backup verification','ok','The newest backup passed its recorded isolated recovery check.');
      if(observer)add('backup-scheduler','Backup scheduler','disabled','This observer command does not run or inspect the web process scheduler.','Review scheduler status in the running admin dashboard.');
      else add('backup-scheduler','Backup scheduler',op.automaticBackups?'ok':'warning',op.automaticBackups?'Automatic backup scheduling is running.':'Automatic backup scheduling is not running.',op.automaticBackups?'No action needed.':'Start or inspect the application backup scheduler.');
      const failed=Array.isArray(op.recentRuns)&&op.recentRuns[0]?.status==='failed';
      add('backup-jobs','Latest backup or recovery job',failed?'warning':'ok',failed?'The latest recorded operational job failed.':'No failure is recorded on the latest operational job.',failed?'Review the safe failure code and rerun the affected backup or recovery check.':'No action needed.');
      add('offsite-backups','Offsite backup copy',op.offsiteConfigured?'ok':'warning',op.offsiteConfigured?'An offsite destination is configured.':'Automated offsite backup storage is not configured.','Keep independent encrypted offsite copies and the decryption key separately.');
    }
    add('persistent-storage','Storage durability','warning','Persistent storage and a separate encryption-key copy have not been verified by this application.','Verify the host uses durable private storage and test your independent recovery procedure.');
    let config={};try{config=configuration()||{};}catch{}
    add('email','Transactional email',config.emailAvailable===true?'ok':'warning',config.emailAvailable===true?'Email credentials, sender, and public origin are configured; delivery was not probed.':'Email configuration is incomplete for signup confirmation and password recovery.',config.emailAvailable===true?'Verify real delivery with your email provider when changing configuration.':'Configure the public HTTPS origin, Resend key, and verified sender on the running server.');
    add('forex','Forex reference prices',config.forexConfigured===true?'ok':'warning',config.forexConfigured===true?'The forex reference provider is configured; its availability was not probed.':'The forex reference provider is not configured.',config.forexConfigured===true?'Review live quote freshness if traders report unavailable prices.':'Configure the Twelve Data key on the running server.');
    let provider={};try{provider=sponsored?.status?.()||{};}catch{}
    if(available){
      try{
        const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notification_outbox'").get();
        if(table){
          const delivery=db.prepare("SELECT sum(CASE WHEN status='failed' THEN 1 ELSE 0 END) failed,sum(CASE WHEN status='pending' AND next_at<? THEN 1 ELSE 0 END) overdue FROM notification_outbox").get(checkedAt-300000);
          const failed=integer(delivery.failed),overdue=integer(delivery.overdue);
          add('delivery-queue','Notification delivery queue',failed||overdue?'warning':'ok',`${overdue} pending deliveries are over five minutes past their scheduled attempt; ${failed} deliveries have failed.`,failed||overdue?'Review email/push provider status. Users should request fresh authentication links; do not resend expired tokens.':'No action needed.');
        }else add('delivery-queue','Notification delivery queue','disabled','No notification delivery queue is available in this installation.','Initialize the full application before checking delivery health.');
      }catch{add('delivery-queue','Notification delivery queue','warning','Delivery totals could not be queried.','Inspect application schema and database health.');}
      try{
        const table=db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='sponsored_sync_links'").get();
        const threshold=Math.max(300000,(number(provider.intervalSeconds)||60)*3000);
        const links=table?db.prepare("SELECT count(*) linked,sum(CASE WHEN error_code IS NOT NULL THEN 1 ELSE 0 END) failed,sum(CASE WHEN coalesce(last_success_at,linked_at)<? THEN 1 ELSE 0 END) stale,sum(CASE WHEN last_success_at IS NULL THEN 1 ELSE 0 END) awaiting FROM sponsored_sync_links WHERE active=1").get(checkedAt-threshold):{};
        const linked=integer(links.linked),failed=integer(links.failed),stale=integer(links.stale),awaiting=integer(links.awaiting);
        if(!linked)add('metaapi','Sponsored-account synchronization','disabled','No active MetaApi connections are linked.','Link approved existing prop accounts when ready to synchronize.');
        else if(provider.configured!==true)add('metaapi','Sponsored-account synchronization','critical',`${linked} active connections have no configured MetaApi provider.`,'Configure the actual MetaApi token on the running server.');
        else if(stale||failed||awaiting)add('metaapi','Sponsored-account synchronization',stale===linked?'critical':'warning',`${stale} connections are stale, ${failed} have recorded errors, and ${awaiting} await their first successful observation.`,'Review MetaTrader connection status and provider availability; no provider request was made by this check.');
        else if(!observer&&provider.automaticSync!==true)add('metaapi','Sponsored-account synchronization','warning',`${linked} active connections have current observations, but automatic synchronization is not running.`,'Inspect the running synchronization scheduler.');
        else add('metaapi','Sponsored-account synchronization','ok',`${linked} active connections have recent successful observations and no recorded errors.`);
      }catch{add('metaapi','Sponsored-account synchronization','warning','Sponsored-account synchronization totals are unavailable.','Inspect application schema and database health.');}
    }
    const open=integer(op?.errors?.open);if(op)add('incidents','Unresolved server incidents',open?'warning':'ok',`${open} sanitized server-error groups are open.`,open?'Review the incident list and resolve groups after investigating the cause.':'No action needed.');else add('incidents','Unresolved server incidents','warning','The current incident count is unavailable.','Inspect the incident service and database health.');
    const diagnosticRuns=runs(),lastDiagnostic=diagnosticRuns.find(item=>item.state!=='running')||null;
    if(lastDiagnostic?.state==='critical')add('diagnostics','Latest integrity diagnostic','critical','The latest completed integrity or writable-storage check failed.','Review its fixed failure code, correct the underlying issue, and run diagnostics again.');
    else if(lastDiagnostic&&checkedAt-lastDiagnostic.completedAt>86400000)add('diagnostics','Latest integrity diagnostic','warning','The latest completed local integrity and writable-storage diagnostic is more than 24 hours old.','Run a fresh diagnostic; an earlier success does not establish current integrity.');
    else if(lastDiagnostic)add('diagnostics','Latest integrity diagnostic',lastDiagnostic.state==='ok'?'ok':'warning','The latest recorded local diagnostic completed within the last 24 hours.','Run a fresh diagnostic after storage or deployment changes.');
    else add('diagnostics','Latest integrity diagnostic','warning','No completed local integrity and writable-storage diagnostic is recorded.','Run diagnostics to check the database and private storage.');
    const metrics={uptimeSeconds:number(Math.floor(process.uptime())),rssBytes:number(process.memoryUsage().rss),heapUsedBytes:number(process.memoryUsage().heapUsed),databaseBytes:null,walBytes:0,storageFreeBytes:free,storageTotalBytes:total};
    try{metrics.databaseBytes=number(statSync(source).size);}catch{}
    try{metrics.walBytes=number(statSync(source+'-wal').size);}catch(error){if(error.code!=='ENOENT')metrics.walBytes=null;}
    let diagnosticRunning=Boolean(active);try{const lease=db.prepare('SELECT process_id,expires_at FROM operations_diagnostic_lease WHERE singleton=1').get();diagnosticRunning||=Boolean(lease&&lease.expires_at>checkedAt&&alive(lease.process_id));}catch{}
    return{checkedAt,overall:checks.some(item=>item.state==='critical')?'critical':checks.some(item=>item.state==='warning')?'attention':'healthy',checks,metrics,lastDiagnostic,diagnosticRuns,diagnosticRunning};
  }
  function diagnose(){
    if(closed)return Promise.reject(failure(503,'OPERATIONS_DIAGNOSTIC_STOPPED','Operational diagnostics are stopping.'));
    if(active||db.isTransaction)return Promise.reject(failure(409,'OPERATIONS_DIAGNOSTIC_BUSY','A diagnostic or database transaction is already running.'));
    const id=randomUUID(),owner=randomUUID(),startedAt=now(),probe=path.join(directory,'.academy-health-'+id+'.tmp');
    try{
      db.exec('BEGIN IMMEDIATE');
      const lease=db.prepare('SELECT * FROM operations_diagnostic_lease WHERE singleton=1').get();
      if(lease&&alive(lease.process_id)&&lease.expires_at>startedAt)throw failure(409,'OPERATIONS_DIAGNOSTIC_BUSY','Another operational diagnostic is already running.');
      if(lease)interrupted(lease);
      db.prepare("INSERT INTO operations_diagnostic_runs(id,started_at,state) VALUES(?,?,'running')").run(id,startedAt);
      db.prepare('INSERT INTO operations_diagnostic_lease VALUES(1,?,?,?,?)').run(owner,process.pid,id,startedAt+diagnosticTimeoutMs+30000);
      db.exec('COMMIT');
    }catch(error){if(db.isTransaction)db.exec('ROLLBACK');if(error?.code==='OPERATIONS_DIAGNOSTIC_BUSY')return Promise.reject(error);return Promise.reject(failure(503,'OPERATIONS_DIAGNOSTIC_UNAVAILABLE','Diagnostic status could not be recorded in the application database.'));}
    active=(async()=>{
      let child,exited,timer,result=emptyResult(),failureCode=null;
      try{
        result=await new Promise(resolve=>{
          let settled=false;const done=(value,code)=>{if(settled)return;settled=true;failureCode=code||null;resolve(value);};
          try{
            child=fork(diagnosticScript,['--academy-operational-diagnostic'],{execArgv:['--max-old-space-size=64'],env:process.platform==='win32'&&process.env.SystemRoot?{SystemRoot:process.env.SystemRoot}:{},stdio:['ignore','ignore','ignore','ipc']});
            exited=new Promise(resolveExit=>{child.once('exit',resolveExit);child.once('error',resolveExit);});
            child.once('message',value=>done(value));child.once('error',()=>done(emptyResult(),'DIAGNOSTIC_WORKER_FAILED'));
            child.once('exit',()=>done(emptyResult(),'DIAGNOSTIC_WORKER_FAILED'));
            child.send({task:'academy-operational-diagnostic',databasePath:source,probePath:probe,inspectionScript:diagnosticWorkerScript,timeoutMs:diagnosticTimeoutMs},error=>{if(error)done(emptyResult(),'DIAGNOSTIC_WORKER_FAILED');});
            timer=setTimeout(()=>done(emptyResult(),'DIAGNOSTIC_TIMEOUT'),diagnosticTimeoutMs);timer.unref();
          }catch{done(emptyResult(),'DIAGNOSTIC_WORKER_FAILED');}
        });
      }finally{
        clearTimeout(timer);if(child&&child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');if(exited)await exited;
        try{if(existsSync(probe)&&!lstatSync(probe).isDirectory())unlinkSync(probe);}catch{}
      }
      const safe={database:databaseStates.has(result?.database)?result.database:'unavailable',integrity:checkStates.has(result?.integrity)?result.integrity:'not_checked',foreignKeys:checkStates.has(result?.foreignKeys)?result.foreignKeys:'not_checked',storageWritable:checkStates.has(result?.storageWritable)?result.storageWritable:'not_checked'};
      failureCode||=safe.database!=='ok'?'DIAGNOSTIC_DATABASE_FAILED':safe.integrity!=='ok'?'DIAGNOSTIC_INTEGRITY_FAILED':safe.foreignKeys!=='ok'?'DIAGNOSTIC_FOREIGN_KEYS_FAILED':safe.storageWritable!=='ok'?'DIAGNOSTIC_STORAGE_FAILED':null;
      const state=failureCode?'critical':'ok',completedAt=now();
      try{
        const lease=db.prepare('SELECT owner FROM operations_diagnostic_lease WHERE singleton=1').get();
        if(lease?.owner!==owner)throw failure(409,'OPERATIONS_DIAGNOSTIC_BUSY','This diagnostic was replaced by another operational worker.');
        db.prepare('UPDATE operations_diagnostic_runs SET completed_at=?,state=?,database_state=?,integrity_state=?,foreign_keys_state=?,storage_writable_state=?,failure_code=? WHERE id=?').run(completedAt,state,safe.database,safe.integrity,safe.foreignKeys,safe.storageWritable,failureCode,id);
        trim();return{id,startedAt,completedAt,state,...safe,failureCode};
      }catch(error){if(error?.code==='OPERATIONS_DIAGNOSTIC_BUSY')throw error;throw failure(503,'OPERATIONS_DIAGNOSTIC_UNAVAILABLE','Diagnostic results could not be recorded in the application database.');}
      finally{try{db.prepare('DELETE FROM operations_diagnostic_lease WHERE owner=?').run(owner);}catch{}}
    })().finally(()=>{active=null;});
    return active;
  }
  async function close(){closed=true;if(active)await active.catch(()=>{});}
  return{status,diagnose,close};
}
