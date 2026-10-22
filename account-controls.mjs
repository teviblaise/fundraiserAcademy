import { createHash, randomBytes, randomUUID } from 'node:crypto';

export class AccountControlError extends Error {
  constructor(status, message, code) { super(message); this.status = status; if (code) this.code = code; }
}
const fail = (status, message, code) => { throw new AccountControlError(status, message, code); };
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const validId = value => Number.isSafeInteger(value) && value > 0;
const exists = (db, table) => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name));
const digest = value => createHash('sha256').update(value).digest('hex');
const retentionNotice = 'Account closure removes the mutable profile, trading data, authentication and delivery data, and customer support conversations. Immutable signed agreements, financial records, review history and administrative records remain restricted to authorized staff for retention review. Existing backups may contain earlier data until the configured backup retention expires. This is not a claim that all personal data has been erased.';
function pageInteger(value, fallback, minimum, maximum) {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) fail(400,'Choose valid account-control pagination.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) fail(400,'Choose valid account-control pagination.');
  return parsed;
}

function transaction(db, work) {
  const owns = !db.isTransaction;
  if (owns) db.exec('BEGIN IMMEDIATE');
  try { const result = work(); if (result?.then) throw new TypeError('Account-control transactions must be synchronous.'); if (owns) db.exec('COMMIT'); return result; }
  catch (error) { if (owns) db.exec('ROLLBACK'); throw error; }
}
function initialize(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS account_control_metadata (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), installation_id TEXT NOT NULL UNIQUE);
    CREATE TABLE IF NOT EXISTS account_deletions (
    user_id INTEGER PRIMARY KEY REFERENCES users(id), request_id TEXT UNIQUE NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending_closure','deleted')),
    requested_at INTEGER NOT NULL, completed_at INTEGER, receipt TEXT NOT NULL);
    CREATE TRIGGER IF NOT EXISTS account_deletion_completed_no_update BEFORE UPDATE ON account_deletions
    WHEN OLD.status='deleted' BEGIN SELECT RAISE(ABORT,'Completed account deletions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS account_deletion_completed_no_delete BEFORE DELETE ON account_deletions
    WHEN OLD.status='deleted' BEGIN SELECT RAISE(ABORT,'Completed account deletions are immutable'); END;`);
  db.prepare('INSERT INTO account_control_metadata(singleton,installation_id) VALUES (1,?) ON CONFLICT(singleton) DO NOTHING').run(randomUUID());
}
function requireUser(db, userId) {
  if (!validId(userId)) fail(400, 'Select a valid account.');
  const row = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  if (!row) fail(404, 'Account not found.');
  return row;
}
function count(db, table, where, ...parameters) { return exists(db, table) ? db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${where}`).get(...parameters).n : 0; }

function retainedRecords(db, userId) {
  const items = [
    ['signed_agreements','Signed agreements and recorded legal signature details',count(db,'contract_signatures','user_id=?',userId)],
    ['financial_records','Sponsored-account, profit-statement and payout records',count(db,'sponsored_accounts','user_id=?',userId)+count(db,'sponsored_statements','user_id=?',userId)+count(db,'sponsored_payouts','user_id=?',userId)+count(db,'sponsored_client_payout_requests','user_id=?',userId)],
    ['review_history','Immutable sponsorship-review history',count(db,'sponsorship_review_history','user_id=?',userId)],
    ['administration_records','Restricted administrative notes and audit records',count(db,'admin_notes','user_id=? OR actor_user_id=?',userId,userId)+count(db,'admin_audit','target_user_id=? OR actor_user_id=?',userId,userId)],
    ['certificate_records','Certificate results with the display name removed',count(db,'certificates','user_id=?',userId)],
    ['provider_binding_records','Restricted hashed external-account ownership bindings',count(db,'sponsored_sync_links','account_id IN (SELECT id FROM sponsored_accounts WHERE user_id=?)',userId)],
  ];
  return items.filter(item=>item[2]>0).map(([category,label,recordCount])=>({category,label,recordCount}));
}

// The tombstone preserves numeric foreign keys without leaving a usable profile.
// Immutable agreement/financial/audit tables are never modified or bypassed.
function eraseMutable(db, userId, requestedAt) {
  let user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  const tombstone = { email:`deleted.${randomUUID()}@deleted.invalid`, name:'Deleted account', password:`!deleted:${randomBytes(48).toString('hex')}` };
  if (!user) {
    db.prepare('INSERT INTO users(id,email,name,market,password,created_at) VALUES (?,?,?,?,?,?)').run(userId,tombstone.email,tombstone.name,'',tombstone.password,requestedAt);
    user = db.prepare('SELECT * FROM users WHERE id=?').get(userId);
  }
  if (exists(db,'support_conversations')) {
    const conversations=db.prepare('SELECT id FROM support_conversations WHERE owner_user_id=?').all(userId);
    for (const row of conversations) {
      // Self-referencing replies must be detached before removing the transcript.
      db.prepare('UPDATE support_messages SET reply_to_message_id=NULL WHERE reply_to_message_id IN (SELECT id FROM support_messages WHERE conversation_id=?)').run(row.id);
      if(exists(db,'support_audit'))db.prepare('DELETE FROM support_audit WHERE conversation_id=?').run(row.id);
      db.prepare('DELETE FROM support_messages WHERE conversation_id=?').run(row.id);
      db.prepare('DELETE FROM support_conversations WHERE id=?').run(row.id);
    }
    db.prepare("UPDATE support_messages SET content='Message removed after author account closure',client_message_id=NULL,reply_to_message_id=NULL WHERE author_user_id=?").run(userId);
    db.prepare('UPDATE support_conversations SET assigned_agent_id=NULL,status=CASE WHEN status=\'assigned\' THEN \'waiting\' ELSE status END WHERE assigned_agent_id=?').run(userId);
    if(exists(db,'support_audit'))db.prepare('DELETE FROM support_audit WHERE actor_user_id=?').run(userId);
  }
  if(exists(db,'sponsored_sync_links'))db.prepare('UPDATE sponsored_sync_links SET active=0,provider_account_id=NULL,revision=revision+1 WHERE account_id IN (SELECT id FROM sponsored_accounts WHERE user_id=?)').run(userId);
  for(const table of ['sponsored_sync_deal_versions','sponsored_sync_deals','sponsored_sync_snapshots'])if(exists(db,table))db.prepare(`DELETE FROM ${table} WHERE account_id IN (SELECT id FROM sponsored_accounts WHERE user_id=?)`).run(userId);
  for (const table of ['account_tool_privileges','admin_step_up','sessions','two_factor_recovery_codes','two_factor_challenges','two_factor','password_resets','email_verifications','push_subscriptions','notification_outbox','notification_preferences','leaderboard_profiles','support_roles','admin_roles','performance_assessment_snapshots','accounts','events','sponsorship_reviews']) {
    if(exists(db,table))db.prepare(`DELETE FROM ${table} WHERE user_id=?`).run(userId);
  }
  if(exists(db,'password_reset_requests'))db.prepare('DELETE FROM password_reset_requests WHERE email_hash=?').run(digest(user.email));
  if(exists(db,'certificates'))db.prepare("UPDATE certificates SET holder='Deleted account' WHERE user_id=?").run(userId);
  const available=columns(db,'users');
  const updates={email:tombstone.email,name:tombstone.name,password:tombstone.password,market:'',first_name:'Deleted',other_names:'',certificate_mode:'name',certificate_nickname:'',email_confirmation_required:1};
  const fields=Object.keys(updates).filter(key=>available.has(key));
  db.prepare(`UPDATE users SET ${fields.map(key=>key+'=?').join(',')}${available.has('session_version')?',session_version=session_version+1':''} WHERE id=?`).run(...fields.map(key=>updates[key]),userId);
  if(exists(db,'admin_account_status'))db.prepare(`INSERT INTO admin_account_status(user_id,status,reason,updated_by,updated_at) VALUES (?,'suspended','Account closed by its owner',NULL,?) ON CONFLICT(user_id) DO UPDATE SET status='suspended',reason=excluded.reason,updated_by=NULL,updated_at=excluded.updated_at`).run(userId,requestedAt);
}

function validateLedger(ledger) {
  if (!ledger || ledger.version!==1 || typeof ledger.installationId!=='string' || !uuid.test(ledger.installationId) || !Array.isArray(ledger.entries) || ledger.entries.length>100000) fail(400,'Provide a valid account-deletion recovery ledger.');
  const seen=new Set();
  for(const item of ledger.entries){
    if(!item || !validId(item.userId) || typeof item.requestId!=='string' || !uuid.test(item.requestId) || item.status!=='deleted' || !Number.isSafeInteger(item.requestedAt) || item.requestedAt<=0 || !Number.isSafeInteger(item.completedAt) || item.completedAt<item.requestedAt || seen.has(item.userId))fail(400,'The account-deletion recovery ledger contains invalid or duplicate entries.');
    seen.add(item.userId);
  }
}

// Trusted recovery-only primitive. Never expose it as a customer HTTP endpoint.
export function applyAccountDeletionLedger(db, ledger) {
  validateLedger(ledger);
  const installation=exists(db,'account_control_metadata')?db.prepare('SELECT installation_id AS id FROM account_control_metadata WHERE singleton=1').get():null;
  if(!installation || installation.id!==ledger.installationId)fail(409,'The backup does not match this installation\'s account-deletion ledger. Restore must not continue.','DELETION_LEDGER_INSTALLATION_MISMATCH');
  return transaction(db,()=>{
    initialize(db);let replayed=0;
    for(const item of ledger.entries){
      const current=db.prepare('SELECT status,request_id FROM account_deletions WHERE user_id=?').get(item.userId);
      if(current?.status==='deleted'){
        if(current.request_id!==item.requestId)fail(409,'A completed deletion conflicts with the recovery ledger.');
        // Reapply mutable erasure even if a backup was tampered with after closure.
        eraseMutable(db,item.userId,item.completedAt);continue;
      }
      eraseMutable(db,item.userId,item.completedAt);
      const receipt={requestId:item.requestId,status:'deleted',requestedAt:item.requestedAt,completedAt:item.completedAt,accountDeleted:true,signedOut:true,retained:retainedRecords(db,item.userId),retentionNotice,recoveredDeletion:true};
      db.prepare(`INSERT INTO account_deletions(user_id,request_id,status,requested_at,completed_at,receipt) VALUES (?,?,'deleted',?,?,?) ON CONFLICT(user_id) DO UPDATE SET request_id=excluded.request_id,status='deleted',requested_at=excluded.requested_at,completed_at=excluded.completed_at,receipt=excluded.receipt`).run(item.userId,item.requestId,item.requestedAt,item.completedAt,JSON.stringify(receipt));
      replayed++;
    }
    return {replayed,verified:ledger.entries.length,installationId:ledger.installationId};
  });
}

const accountKeys = ['version','executionMode','initial','balance','dailyStart','day','peak','worstDrawdown','locked','ticks','nextId','limits','notificationEpoch','nextNotice','nextAlert','tradingDays','migrationRequired','revision'];
const privateKey = /password|secret|token|credential|api.?key|code_hash|session|fingerprint|subscription|endpoint|recovery|request_key_hash/i;
function clean(value,depth=0){
  if(depth>12)return null;
  if(value===null || typeof value==='boolean' || typeof value==='string' || typeof value==='number'&&Number.isFinite(value))return value;
  if(Array.isArray(value))return value.map(item=>clean(item,depth+1));
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key])=>!privateKey.test(key)&&key!=='__proto__'&&key!=='constructor').map(([key,item])=>[key,clean(item,depth+1)]));
  return null;
}
function json(value){try{return clean(JSON.parse(value));}catch{return null;}}
function accountSummary(value){const state=typeof value==='string'?json(value):value;return state&&typeof state==='object'?Object.fromEntries(accountKeys.filter(key=>Object.hasOwn(state,key)).map(key=>[key,clean(state[key])])):null;}

export function createAccountControls(db,{access,now=Date.now}={}){
  initialize(db);
  const isDeleted=userId=>validId(userId)&&Boolean(db.prepare("SELECT 1 FROM account_deletions WHERE user_id=? AND status='deleted'").get(userId));
  function blockers(userId){
    const user=requireUser(db,userId),items=[];
    if(isDeleted(userId))return items;
    const role=access?.context?.(userId);
    if(role?.role)items.push({code:'STAFF_ACCESS_ASSIGNED',message:'An owner must transfer or remove your staff role before account closure.'});
    const legacy=(process.env.SUPPORT_STAFF_EMAILS||'').split(',').map(value=>value.trim().toLowerCase());
    if(legacy.includes(user.email)||count(db,'support_roles','user_id=?',userId))items.push({code:'SUPPORT_ACCESS_ASSIGNED',message:'An operator must remove your support-staff assignment before account closure.'});
    if(count(db,'sponsored_accounts',"user_id=? AND status!='closed'",userId))items.push({code:'SPONSORED_ACCOUNT_OPEN',message:'The academy must close your sponsored-account allocations before account closure.'});
    if(count(db,'sponsored_payouts',"user_id=? AND status IN ('requested','approved')",userId))items.push({code:'PAYOUT_PENDING',message:'Requested or approved payouts must be resolved before account closure.'});
    if(exists(db,'sponsored_statements')){
      const earned=db.prepare('SELECT trader_share_cents AS amount FROM sponsored_statements WHERE user_id=?').all(userId).reduce((total,row)=>total+BigInt(row.amount),0n);
      const paid=exists(db,'sponsored_payouts')?db.prepare("SELECT amount_cents AS amount FROM sponsored_payouts WHERE user_id=? AND status='paid'").all(userId).reduce((total,row)=>total+BigInt(row.amount),0n):0n;
      if(earned>paid)items.push({code:'EARNED_SHARE_UNSETTLED',message:'The academy must settle your earned profit share before account closure.'});
    }
    return items;
  }
  function status(userId){
    requireUser(db,userId);const row=db.prepare('SELECT * FROM account_deletions WHERE user_id=?').get(userId);const blocked=blockers(userId);
    return {status:row?.status||'active',requestId:row?.request_id||null,requestedAt:row?.requested_at||null,completedAt:row?.completed_at||null,canDelete:!isDeleted(userId)&&!blocked.length,blockers:blocked,retained:retainedRecords(db,userId),retentionNotice,accountDeleted:isDeleted(userId),...(row?.status==='deleted'?{receipt:JSON.parse(row.receipt)}:{})};
  }
  function completeDeletion(userId,{onRevoke}={}){
    return transaction(db,()=>{
      requireUser(db,userId);const row=db.prepare('SELECT * FROM account_deletions WHERE user_id=?').get(userId);
      if(row?.status==='deleted')return JSON.parse(row.receipt);
      if(!row)fail(409,'A confirmed account-deletion request is required.','DELETION_REQUEST_REQUIRED');
      const blocked=blockers(userId);if(blocked.length)return {...status(userId),signedOut:false,message:'Your deletion request is pending. Resolve the listed account or payment obligations first.'};
      if(onRevoke){const result=onRevoke({userId});if(result?.then)throw new TypeError('Account revocation must be synchronous.');}
      const time=now();eraseMutable(db,userId,time);
      access?.audit?.(userId,'account.closed',{targetId:userId,reason:'Account owner confirmed account closure and mutable personal-data deletion.',detail:{source:'self-service'}});
      const receipt={requestId:row.request_id,status:'deleted',requestedAt:row.requested_at,completedAt:time,accountDeleted:true,signedOut:true,retained:retainedRecords(db,userId),retentionNotice,message:'Your account is closed, all sessions are signed out, and mutable operational personal data has been removed. Keep this receipt for the listed retained records.'};
      db.prepare("UPDATE account_deletions SET status='deleted',completed_at=?,receipt=? WHERE user_id=? AND status='pending_closure'").run(time,JSON.stringify(receipt),userId);
      return receipt;
    });
  }
  function requestDeletion(userId,data,{onRevoke}={}){
    if(!data||data.confirmation!=='DELETE MY ACCOUNT')fail(400,'Type DELETE MY ACCOUNT to confirm account closure.');
    return transaction(db,()=>{
      requireUser(db,userId);const existing=db.prepare('SELECT status FROM account_deletions WHERE user_id=?').get(userId);
      if(existing?.status==='deleted')return status(userId).receipt;
      const requestId=randomUUID(),time=now();
      if(!existing){db.prepare("INSERT INTO account_deletions(user_id,request_id,status,requested_at,completed_at,receipt) VALUES (?,?,'pending_closure',?,NULL,'{}')").run(userId,requestId,time);access?.audit?.(userId,'account.deletion-requested',{targetId:userId,reason:'Account owner requested account closure and mutable personal-data deletion.',detail:{source:'self-service'}});}
      return completeDeletion(userId,{onRevoke});
    });
  }
  function cancelDeletion(userId){return transaction(db,()=>{requireUser(db,userId);if(isDeleted(userId))fail(409,'A completed account deletion cannot be cancelled.');const result=db.prepare("DELETE FROM account_deletions WHERE user_id=? AND status='pending_closure'").run(userId);if(result.changes)access?.audit?.(userId,'account.deletion-cancelled',{targetId:userId,reason:'Account owner cancelled a pending closure request.',detail:{source:'self-service'}});return status(userId);});}
  function requests({status:filter='pending_closure',limit=25,offset=0}={}){
    limit=pageInteger(limit,25,1,100);offset=pageInteger(offset,0,0,1000000);
    if(!['pending_closure','deleted','all'].includes(filter))fail(400,'Choose a valid deletion-request filter and page.');
    const where=filter==='all'?'':'WHERE d.status=?',parameters=filter==='all'?[]:[filter];
    const total=db.prepare(`SELECT count(*) n FROM account_deletions d ${where}`).get(...parameters).n;
    const items=db.prepare(`SELECT d.user_id AS userId,d.request_id AS requestId,d.status,d.requested_at AS requestedAt,d.completed_at AS completedAt,u.name,u.email FROM account_deletions d JOIN users u ON u.id=d.user_id ${where} ORDER BY d.requested_at,d.user_id LIMIT ? OFFSET ?`).all(...parameters,limit,offset).map(row=>({...row,blockers:row.status==='pending_closure'?blockers(row.userId):[],retained:retainedRecords(db,row.userId)}));
    return {items,total,limit,offset,nextOffset:offset+items.length<total?offset+items.length:null};
  }
  function exportData(userId,options={}){
    const owns=!db.isTransaction;
    if(owns)db.exec('BEGIN');
    try{const result=exportSnapshot(userId,options);if(owns)db.exec('COMMIT');return result;}
    catch(error){if(owns)db.exec('ROLLBACK');throw error;}
  }
  function exportSnapshot(userId,{limit=500,offset=0,fingerprint:expectedFingerprint}={}){
    const user=requireUser(db,userId);if(isDeleted(userId))fail(410,'This account has been closed.','ACCOUNT_DELETED');
    limit=pageInteger(limit,500,1,1000);offset=pageInteger(offset,0,0,10000000);
    if(expectedFingerprint!==undefined&&(typeof expectedFingerprint!=='string'||!/^[a-f0-9]{64}$/.test(expectedFingerprint)))fail(400,'Provide a valid export fingerprint.');
    const sections={};
    const fingerprintHash=createHash('sha256');let hashedBytes=0,hashedRecords=0;
    function hashValue(name,value){
      const serialized=JSON.stringify([name,value]);hashedBytes+=Buffer.byteLength(serialized);hashedRecords++;
      if(hashedBytes>64*1024*1024||hashedRecords>200000)fail(413,'Your account exceeds the self-service export size. Contact support for a complete assisted export.','SELF_SERVICE_EXPORT_TOO_LARGE');
      fingerprintHash.update(serialized);fingerprintHash.update('\n');
    }
    function page(name,items,total){sections[name]={items,total,limit,offset,nextOffset:offset+items.length<total?offset+items.length:null};}
    function rows(name,table,fields,where='user_id=?',parameters=[userId],order='rowid',map=row=>row){
      if(!exists(db,table)){page(name,[],0);hashValue(name,{total:0});return;}
      const total=count(db,table,where,...parameters);hashValue(name,{total});
      const items=db.prepare(`SELECT ${fields} FROM ${table} WHERE ${where} ORDER BY ${order} LIMIT ? OFFSET ?`).all(...parameters,limit,offset).map(map);page(name,items,total);
      for(const row of db.prepare(`SELECT ${fields} FROM ${table} WHERE ${where} ORDER BY ${order}`).iterate(...parameters)){
        const item=map(row);if(name==='sessions'){const {lastSeenAt:ignored,...stable}=item;hashValue(name,stable);}else hashValue(name,item);
      }
    }
    function array(name,items){const list=Array.isArray(items)?items:[];page(name,list.slice(offset,offset+limit).map(item=>clean(item)),list.length);hashValue(name,{total:list.length});for(const item of list)hashValue(name,clean(item));}
    const state=exists(db,'accounts')?json(db.prepare('SELECT state FROM accounts WHERE user_id=?').get(userId)?.state):null;
    for(const [name,key]of[['assessmentTrades','history'],['assessmentPositions','positions'],['assessmentPendingOrders','pending'],['assessmentAlerts','alerts'],['assessmentNotifications','notifications'],['assessmentTradingDays','tradingDays']])array(name,state?.[key]);
    rows('events','events','id,kind,detail,created_at AS createdAt','user_id=?',[userId],'id',row=>({...row,detail:row.kind==='reset-archive'?accountSummary(row.detail):json(row.detail)}));
    rows('archivedAssessments','events','id,created_at AS archivedAt,detail','user_id=? AND kind=\'reset-archive\'',[userId],'id',row=>({id:row.id,archivedAt:row.archivedAt,assessment:accountSummary(row.detail)}));
    if(exists(db,'events')){
      for(const [name,key]of[['archivedTrades','history'],['archivedPositions','positions'],['archivedPendingOrders','pending'],['archivedAlerts','alerts'],['archivedNotifications','notifications']]){
        const base=`FROM events e,json_each(CASE WHEN json_valid(e.detail) THEN e.detail ELSE '{}' END,'$.${key}') item WHERE e.user_id=? AND e.kind='reset-archive'`;
        const total=db.prepare(`SELECT count(*) n ${base}`).get(userId).n;
        const items=db.prepare(`SELECT e.id AS archiveId,e.created_at AS archivedAt,item.value AS detail ${base} ORDER BY e.id,CAST(item.key AS INTEGER) LIMIT ? OFFSET ?`).all(userId,limit,offset).map(row=>({archiveId:row.archiveId,archivedAt:row.archivedAt,record:json(row.detail)}));page(name,items,total);hashValue(name,{total});
        for(const row of db.prepare(`SELECT e.id AS archiveId,e.created_at AS archivedAt,item.value AS detail ${base} ORDER BY e.id,CAST(item.key AS INTEGER)`).iterate(userId))hashValue(name,{archiveId:row.archiveId,archivedAt:row.archivedAt,record:json(row.detail)});
      }
    }
    rows('certificates','certificates','id,holder,issued_at AS issuedAt,initial_balance AS initialBalance,final_balance AS finalBalance,profit_percent AS profitPercent,trading_days AS tradingDays,price_mode AS priceMode');
    rows('agreements','contract_signatures','id,contract_id AS contractId,contract_version AS contractVersion,contract_hash AS contractHash,certificate_id AS certificateId,legal_name AS legalName,registered_name AS registeredName,email,consent_statement AS consentStatement,signed_at AS signedAt');
    rows('supportConversations','support_conversations','id,status,created_at AS createdAt,updated_at AS updatedAt','owner_user_id=?');
    if(exists(db,'support_messages'))rows('supportMessages','support_messages','id,conversation_id AS conversationId,role,content,source,created_at AS createdAt','conversation_id IN (SELECT id FROM support_conversations WHERE owner_user_id=?)',[userId],'id');
    rows('sponsoredAccounts','sponsored_accounts','id,firm_name AS firmName,label,account_size_cents AS accountSizeCents,trader_share_bps AS traderShareBps,profit_sharing_policy AS profitSharingPolicy,currency,status,contract_version AS contractVersion,created_at AS createdAt,updated_at AS updatedAt');
    rows('profitStatements','sponsored_statements','id,account_id AS accountId,net_profit_cents AS netProfitCents,trader_share_cents AS traderShareCents,company_share_cents AS companyShareCents,cumulative_net_profit_cents AS cumulativeNetProfitCents,period_start AS periodStart,period_end AS periodEnd,created_at AS createdAt');
    rows('payouts','sponsored_payouts','id,account_id AS accountId,amount_cents AS amountCents,currency,status,paid_at AS paidAt,created_at AS createdAt,updated_at AS updatedAt');
    rows('payoutHistory','sponsored_payout_events','id,payout_id AS payoutId,previous_status AS previousStatus,status,created_at AS createdAt','payout_id IN (SELECT id FROM sponsored_payouts WHERE user_id=?)');
    rows('sponsorshipReviewHistory','sponsorship_review_history','id,revision,status,contract_version AS contractVersion,certificate_id AS certificateId,client_message AS clientMessage,created_at AS createdAt');
    rows('assessmentEquityObservations','performance_assessment_snapshots','attempt,bucket_at AS bucketAt,first_sample AS firstSample,last_sample AS lastSample,low_sample AS lowSample,high_sample AS highSample','user_id=?',[userId],'bucket_at,attempt',row=>({...row,firstSample:json(row.firstSample),lastSample:json(row.lastSample),lowSample:json(row.lowSample),highSample:json(row.highSample)}));
    rows('sponsoredConnections','sponsored_sync_links','account_id AS accountId,active,revision,history_from AS historyFrom,linked_at AS linkedAt,updated_at AS updatedAt,last_attempt_at AS lastAttemptAt,last_success_at AS lastSuccessAt,history_through AS historyThrough,history_complete AS historyComplete,currency,error_code AS errorCode','account_id IN (SELECT id FROM sponsored_accounts WHERE user_id=?)',[userId],'account_id');
    rows('sponsoredEquityObservations','sponsored_sync_snapshots','id,account_id AS accountId,at,currency,balance,equity','account_id IN (SELECT id FROM sponsored_accounts WHERE user_id=?)',[userId],'at,id');
    rows('sponsoredDeals','sponsored_sync_deals','id,account_id AS accountId,time,currency,type,entry_type AS entryType,classification,profit,commission,swap,fee,net_profit AS netProfit,cash_flow AS cashFlow,is_closing AS isClosing,revision,updated_at AS updatedAt','account_id IN (SELECT id FROM sponsored_accounts WHERE user_id=?)',[userId],'time,account_id,id');
    rows('sponsoredDealHistory','sponsored_sync_deal_versions','id,account_id AS accountId,deal_id AS dealId,revision,payload,recorded_at AS recordedAt','account_id IN (SELECT id FROM sponsored_accounts WHERE user_id=?)',[userId],'recorded_at,id',row=>({...row,payload:json(row.payload)}));
    if(exists(db,'sessions')){
      const available=columns(db,'sessions');const fields=['public_id AS id','created_at AS createdAt','last_seen AS lastSeenAt','expires AS expiresAt','user_agent AS browserMetadata'].filter(field=>available.has(field.split(' ')[0]));
      if(fields.length)rows('sessions','sessions',fields.join(','));
    }
    rows('notificationDelivery','notification_outbox','id,channel,status,attempts,next_at AS nextAttemptAt');
    const preferences={};
    if(exists(db,'notification_preferences')){const row=db.prepare('SELECT email_enabled,verified FROM notification_preferences WHERE user_id=?').get(userId);preferences.notifications={emailEnabled:Boolean(row?.email_enabled),emailVerified:Boolean(row?.verified)};}
    if(exists(db,'leaderboard_profiles'))preferences.leaderboard=db.prepare('SELECT public_id AS publicId,enabled,alias,updated_at AS updatedAt FROM leaderboard_profiles WHERE user_id=?').get(userId)||null;
    if(exists(db,'two_factor')){const row=db.prepare('SELECT secret IS NOT NULL AS enabled,enabled_at AS enabledAt FROM two_factor WHERE user_id=?').get(userId);preferences.security={twoFactorEnabled:Boolean(row?.enabled),enabledAt:row?.enabledAt||null};}
    const profile=Object.fromEntries(['id','email','name','first_name','other_names','market','created_at','certificate_mode','certificate_nickname','email_confirmation_required'].filter(key=>Object.hasOwn(user,key)).map(key=>[key,user[key]]));
    const result={formatVersion:1,generatedAt:now(),profile,preferences,assessment:accountSummary(state),accountControls:status(userId),sections,limit,offset,complete:Object.values(sections).every(section=>section.nextOffset===null),nextOffset:Object.values(sections).some(section=>section.nextOffset!==null)?offset+limit:null,notice:'This export contains your customer profile, assessment records, signed agreements, support conversations and financial records. Authentication secrets, internal review notes, other customers and staff identities, and private provider credentials are excluded. Follow nextOffset until complete is true for the full export.'};
    hashValue('metadata',{formatVersion:result.formatVersion,profile,preferences,assessment:result.assessment,accountControls:result.accountControls});
    result.fingerprint=fingerprintHash.digest('hex');
    if(expectedFingerprint!==undefined&&expectedFingerprint!==result.fingerprint)fail(409,'Your account records changed during export. Discard the partial download and try again when your account records stop changing.','ACCOUNT_EXPORT_CHANGED');
    if(Buffer.byteLength(JSON.stringify(result))>16*1024*1024)fail(413,'This export page is too large. Retry with a smaller page size.');
    return result;
  }
  function exportDeletionLedger(){return{version:1,installationId:db.prepare('SELECT installation_id AS id FROM account_control_metadata WHERE singleton=1').get().id,generatedAt:now(),entries:db.prepare("SELECT user_id AS userId,request_id AS requestId,status,requested_at AS requestedAt,completed_at AS completedAt FROM account_deletions WHERE status='deleted' ORDER BY user_id").all()};}
  return {status,isDeleted,exportData,requestDeletion,completeDeletion,cancelDeletion,requests,exportDeletionLedger,applyDeletionLedger:ledger=>applyAccountDeletionLedger(db,ledger)};
}
