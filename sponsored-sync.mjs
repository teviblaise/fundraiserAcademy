import {createHash,randomUUID} from 'node:crypto';
import {Worker,isMainThread,parentPort,workerData} from 'node:worker_threads';

export class SponsoredSyncError extends Error {
  constructor(status,message,code){super(message);this.status=status;if(code)this.code=code;}
}
const fail=(status,message,code)=>{throw new SponsoredSyncError(status,message,code);};
const hash=value=>createHash('sha256').update(value).digest('hex');
const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const externalId=/^[A-Za-z0-9][A-Za-z0-9_-]{7,127}$/;
const currencyCode=/^[A-Z][A-Z0-9]{1,11}$/;
const maximumRows=50000, pageSize=1000, maximumPages=10, overlap=7*86400000;
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e15;
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const at=value=>value instanceof Date?value.getTime():typeof value==='string'&&/^\d{4}-\d{2}-\d{2}T/.test(value)?Date.parse(value):value;
const validTime=value=>Number.isSafeInteger(value)&&value>=0&&value<=8640000000000000;
function date(value,now){
  if(value===undefined)return Math.max(0,now-30*86400000);
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))fail(400,'Enter history start as YYYY-MM-DD.');
  const result=Date.parse(value+'T00:00:00.000Z');
  if(!validTime(result)||new Date(result).toISOString().slice(0,10)!==value||result>now)fail(400,'Choose a real history start date that is not in the future.');
  return result;
}
function reason(value){if(typeof value!=='string'||value.trim().length<3||value.trim().length>500||/[\p{Cc}\p{Cf}]/u.test(value))fail(400,'Provide a reason of 3–500 characters without control characters.');return value.trim();}
function fields(value,allowed){if(!object(value)||Object.keys(value).some(key=>!allowed.includes(key)))fail(400,'The connection request contains unsupported fields.');}
function id(value){if(typeof value!=='string'||!uuid.test(value))fail(400,'Select a valid sponsored account.');return value.toLowerCase();}

// Only the official SDK's read methods execute in this bounded worker. It never
// deploys an account, changes trading permissions, or sends a trade instruction.
export async function fetchMetaApiReadOnly(input,{loadSdk=()=>import('metaapi.cloud-sdk/dist/metaApi/metaApi')}={}){
  let api,connection;
  try{
    const imported=await loadSdk();
    const MetaApi=typeof imported.default==='function'?imported.default:imported.default?.default;
    if(typeof MetaApi!=='function')throw new Error('SDK unavailable');
    MetaApi.enableLog4jsLogging();
    api=new MetaApi(input.token,{application:'FundraiserAcademy',requestTimeout:10,connectTimeout:8,retryOpts:{retries:0},packetLogger:{enabled:false}});
    const account=await api.metatraderAccountApi.getAccount(input.accountId);
    if(account.id!==input.accountId||account.state!=='DEPLOYED')throw new Error('Existing account is not deployed or does not match');
    connection=account.getRPCConnection();await connection.connect();await connection.waitSynchronized(10);
    const info=await connection.getAccountInformation({refreshTerminalState:true});
    const deals=[];let offset=input.offset,complete=false,synchronizing=false;
    for(let page=0;page<maximumPages;page++){
      const result=await connection.getDealsByTimeRange(new Date(input.from),new Date(input.to),offset,pageSize);
      if(!Array.isArray(result?.deals)||result.deals.length>pageSize)throw new Error('Invalid history response');
      deals.push(...result.deals);offset+=result.deals.length;synchronizing=result.synchronizing===true;
      if(result.deals.length<pageSize){complete=!synchronizing;break;}
    }
    return {accountInformation:{currency:info.currency,balance:info.balance,equity:info.equity},deals,complete,synchronizing,nextOffset:offset};
  }finally{try{await connection?.close();}finally{api?.close();}}
}
if(!isMainThread&&workerData?.fundraiserSponsoredSync===true){
  fetchMetaApiReadOnly(workerData).then(result=>parentPort.postMessage({result}),()=>parentPort.postMessage({failed:true}));
}

function officialProvider(token,{timeoutMs=20000}={}){
  const workers=new Set();let closing=false;
  return {
    fetch(accountId,query){
      if(closing||workers.size>=1)return Promise.reject(new Error('Connector stopped or busy'));
      return new Promise((resolve,reject)=>{
        const worker=new Worker(new URL(import.meta.url),{workerData:{fundraiserSponsoredSync:true,token,accountId,...query},stdout:true,stderr:true,resourceLimits:{maxOldGenerationSizeMb:256}});
        workers.add(worker);worker.stdout.resume();worker.stderr.resume();let settled=false;
        const finish=async(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);await worker.terminate().catch(()=>{});workers.delete(worker);error?reject(error):resolve(result);};
        const timer=setTimeout(()=>finish(new Error('Provider timeout')),timeoutMs);timer.unref();
        worker.once('message',message=>message?.result?finish(null,message.result):finish(new Error('Provider unavailable')));
        worker.once('error',()=>finish(new Error('Provider unavailable')));
        worker.once('exit',()=>finish(new Error('Provider stopped')));
      });
    },
    async close(){closing=true;await Promise.allSettled([...workers].map(worker=>worker.terminate()));workers.clear();}
  };
}

function normalizeDeal(raw,currency,through){
  if(!object(raw)||typeof raw.id!=='string'||!/^[A-Za-z0-9_.:-]{1,128}$/.test(raw.id)||typeof raw.type!=='string'||!/^[A-Z_]{1,80}$/.test(raw.type))throw new Error('Invalid provider deal');
  const time=at(raw.time);if(!validTime(time)||time>through+5000)throw new Error('Invalid provider time');
  if(raw.currency!==undefined&&raw.currency!==currency)throw new Error('Mixed currencies');
  const amounts=['profit','commission','swap','fee'].map((name,index)=>raw[name]===undefined&&index>0?0:raw[name]);
  if(!amounts.every(finite))throw new Error('Invalid provider amount');
  const [profit,commission,swap,fee]=amounts,net=profit+commission+swap+fee;
  if(!finite(net))throw new Error('Invalid net profit');
  const closingEntries=['DEAL_ENTRY_OUT','DEAL_ENTRY_OUT_BY','DEAL_ENTRY_INOUT'];
  const entryType=typeof raw.entryType==='string'&&/^DEAL_ENTRY_[A-Z_]{1,32}$/.test(raw.entryType)?raw.entryType:null;
  const trade=['DEAL_TYPE_BUY','DEAL_TYPE_SELL'].includes(raw.type);
  // Balance/credit/bonus operations change capital; they are never earnings.
  const flow=['DEAL_TYPE_BALANCE','DEAL_TYPE_CREDIT','DEAL_TYPE_BONUS'].includes(raw.type);
  const cost=['DEAL_TYPE_CHARGE','DEAL_TYPE_COMMISSION','DEAL_TYPE_COMMISSION_DAILY','DEAL_TYPE_COMMISSION_MONTHLY','DEAL_TYPE_COMMISSION_AGENT_DAILY','DEAL_TYPE_COMMISSION_AGENT_MONTHLY','DEAL_TYPE_INTEREST','DEAL_TYPE_TAX','DEAL_TAX'].includes(raw.type);
  const classification=trade?'trade':flow?'cashflow':cost?'trading_cost':'adjustment';
  return {id:raw.id,time,currency,type:raw.type,entryType,classification,profit,commission,swap,fee,netProfit:net,cashFlow:flow?net:null,isClosing:trade&&entryType!==null?closingEntries.includes(entryType):null};
}

export function createSponsoredSync(db,{access,workflows,now=Date.now,provider,apiToken=process.env.METAAPI_API_TOKEN,intervalMs=60000,syncTimeoutMs=20000}={}){
  if(!access?.require||!access?.audit||!workflows?.requireApproved||typeof now!=='function'||!Number.isSafeInteger(intervalMs)||intervalMs<1000||intervalMs>86400000||!Number.isSafeInteger(syncTimeoutMs)||syncTimeoutMs<10||syncTimeoutMs>120000)throw new TypeError('Provide sponsored synchronization services and bounded intervals.');
  const configured=Boolean(provider||typeof apiToken==='string'&&apiToken.trim());
  const source=provider??(configured?officialProvider(apiToken):null);
  if(source&&typeof source.fetch!=='function')throw new TypeError('The provider must implement fetch(accountId,query).');
  db.exec(`CREATE TABLE IF NOT EXISTS sponsored_sync_links (
    account_id TEXT PRIMARY KEY REFERENCES sponsored_accounts(id),provider_account_id TEXT,provider_id_hash TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL CHECK(active IN(0,1)),revision INTEGER NOT NULL,history_from INTEGER NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),updated_by INTEGER NOT NULL REFERENCES users(id),linked_at INTEGER NOT NULL,updated_at INTEGER NOT NULL,
    last_attempt_at INTEGER,last_success_at INTEGER,history_through INTEGER,history_complete INTEGER NOT NULL DEFAULT 0,
    currency TEXT,error_code TEXT,error_message TEXT,cursor_from INTEGER,cursor_to INTEGER,cursor_offset INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS sponsored_sync_snapshots (
    id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES sponsored_accounts(id),at INTEGER NOT NULL,currency TEXT NOT NULL,
    balance REAL NOT NULL,equity REAL NOT NULL,UNIQUE(account_id,at));
    CREATE INDEX IF NOT EXISTS sponsored_sync_snapshots_account ON sponsored_sync_snapshots(account_id,at DESC);
    CREATE TABLE IF NOT EXISTS sponsored_sync_deals (
    account_id TEXT NOT NULL REFERENCES sponsored_accounts(id),id TEXT NOT NULL,time INTEGER NOT NULL,currency TEXT NOT NULL,
    type TEXT NOT NULL,entry_type TEXT,classification TEXT NOT NULL,profit REAL NOT NULL,commission REAL NOT NULL,swap REAL NOT NULL,fee REAL NOT NULL,
    net_profit REAL NOT NULL,cash_flow REAL,is_closing INTEGER,payload_hash TEXT NOT NULL,revision INTEGER NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(account_id,id));
    CREATE INDEX IF NOT EXISTS sponsored_sync_deals_account ON sponsored_sync_deals(account_id,time DESC);
    CREATE TABLE IF NOT EXISTS sponsored_sync_deal_versions (
    id TEXT PRIMARY KEY,account_id TEXT NOT NULL REFERENCES sponsored_accounts(id),deal_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,recorded_at INTEGER NOT NULL,UNIQUE(account_id,deal_id,revision));
    CREATE TRIGGER IF NOT EXISTS sponsored_sync_binding_immutable BEFORE UPDATE ON sponsored_sync_links
      WHEN NEW.account_id IS NOT OLD.account_id OR NEW.provider_id_hash IS NOT OLD.provider_id_hash OR NEW.history_from IS NOT OLD.history_from
      BEGIN SELECT RAISE(ABORT,'External account bindings and history origin are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS sponsored_sync_binding_no_delete BEFORE DELETE ON sponsored_sync_links
      BEGIN SELECT RAISE(ABORT,'External binding hashes cannot be deleted or reassigned'); END;`);
  const inFlight=new Map();let timer=null,closing=false,sweepRunning=false,stopWaiting;
  const stopped=new Promise((_,reject)=>{stopWaiting=()=>reject(new SponsoredSyncError(503,'The connector is stopping.','METAAPI_STOPPING'));});
  stopped.catch(()=>{});
  const row=accountId=>db.prepare('SELECT l.*,a.user_id,a.status AS account_status FROM sponsored_sync_links l JOIN sponsored_accounts a ON a.id=l.account_id WHERE l.account_id=?').get(accountId);
  function account(accountId){const value=db.prepare('SELECT id,user_id,status FROM sponsored_accounts WHERE id=?').get(id(accountId));if(!value)fail(404,'Sponsored account not found.');return value;}
  function deleted(userId){return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='account_deletions'").get()&&db.prepare("SELECT 1 FROM account_deletions WHERE user_id=? AND status='deleted'").get(userId));}
  function transaction(work){const owns=!db.isTransaction;if(owns)db.exec('BEGIN IMMEDIATE');try{const value=work();if(owns)db.exec('COMMIT');return value;}catch(error){if(owns)db.exec('ROLLBACK');throw error;}}
  function linkAccount(actor,accountId,input){
    fields(input,['providerAccountId','historyFrom','reason','expectedRevision']);const explanation=reason(input.reason);
    if(typeof input.providerAccountId!=='string'||!externalId.test(input.providerAccountId))fail(400,'Enter the existing MetaApi account ID, without credentials or a URL.');
    return transaction(()=>{
      access.require(actor,'finance.write');const target=account(accountId);if(target.status!=='active'||deleted(target.user_id))fail(409,'Only an active sponsored account can be connected.');workflows.requireApproved(target.user_id);
      const previous=row(target.id),fingerprint=hash(input.providerAccountId),start=date(input.historyFrom,now());
      if(input.expectedRevision!==undefined&&(!Number.isSafeInteger(input.expectedRevision)||input.expectedRevision!==(previous?.revision??0)))fail(409,'The connection changed. Refresh before editing.','SPONSORED_CONNECTION_CHANGED');
      if(previous&&(previous.provider_id_hash!==fingerprint||(input.historyFrom!==undefined&&previous.history_from!==start)))fail(409,'This sponsored record is permanently bound to its original external account and history start. Create a separate approved record for a different account.');
      if(db.prepare('SELECT account_id FROM sponsored_sync_links WHERE provider_id_hash=? AND account_id!=?').get(fingerprint,target.id))fail(409,'That external account is already assigned to another sponsored record.');
      if(previous)db.prepare('UPDATE sponsored_sync_links SET provider_account_id=?,active=1,revision=revision+1,updated_by=?,updated_at=?,error_code=NULL,error_message=NULL WHERE account_id=?').run(input.providerAccountId,actor,now(),target.id);
      else db.prepare('INSERT INTO sponsored_sync_links(account_id,provider_account_id,provider_id_hash,active,revision,history_from,created_by,updated_by,linked_at,updated_at) VALUES (?,?,?,1,1,?,?,?,?,?)').run(target.id,input.providerAccountId,fingerprint,start,actor,actor,now(),now());
      access.audit(actor,'sponsored.connection-linked',{targetId:target.user_id,reason:explanation,detail:{accountId:target.id,source:'MetaApi',revision:(previous?.revision??0)+1}});
      return readAccount(target.id);
    });
  }
  function unlinkAccount(actor,accountId,input){
    fields(input,['revision','reason']);const explanation=reason(input.reason);
    return transaction(()=>{access.require(actor,'finance.write');const target=account(accountId),previous=row(target.id);if(!previous)fail(404,'No connection is assigned.');if(input.revision!==previous.revision)fail(409,'The connection changed. Refresh before editing.','SPONSORED_CONNECTION_CHANGED');
      db.prepare('UPDATE sponsored_sync_links SET active=0,revision=revision+1,updated_by=?,updated_at=? WHERE account_id=?').run(actor,now(),target.id);
      access.audit(actor,'sponsored.connection-unlinked',{targetId:target.user_id,reason:explanation,detail:{accountId:target.id,source:'MetaApi',revision:previous.revision+1}});return readAccount(target.id);});
  }
  function view(value,{client=false}={}){
    if(!value)return {provider:'MetaApi',configured,linked:false,active:false,status:'not_connected',stale:true,historyComplete:false,revision:0};
    const stale=!value.last_success_at||now()-value.last_success_at>Math.max(180000,intervalMs*3);
    const latest=db.prepare('SELECT at,currency,balance,equity FROM sponsored_sync_snapshots WHERE account_id=? ORDER BY at DESC LIMIT 1').get(value.account_id)??null;
    const result={accountId:value.account_id,provider:'MetaApi',configured,linked:true,active:Boolean(value.active),revision:value.revision,
      status:!value.active?'disconnected':!configured?'not_configured':inFlight.has(value.account_id)?'syncing':value.error_code?'error':value.last_success_at?'synchronized':'awaiting_sync',stale,
      currency:value.currency,historyFrom:value.history_from,historyThrough:value.history_through,historyComplete:Boolean(value.history_complete),
      lastAttemptAt:value.last_attempt_at,lastSuccessAt:value.last_success_at,latest,
      snapshotCount:db.prepare('SELECT count(*) n FROM sponsored_sync_snapshots WHERE account_id=?').get(value.account_id).n,
      dealCount:db.prepare('SELECT count(*) n FROM sponsored_sync_deals WHERE account_id=?').get(value.account_id).n,
      error:value.error_code?{code:value.error_code,message:value.error_message}:null,
      source:'metaapi_observations',transfersMoney:false,controlsTrades:false};
    if(!client)result.providerAccountId=value.provider_account_id;
    return result;
  }
  function readAccount(accountId,options={}){account(accountId);return view(row(accountId.toLowerCase()),options);}
  function clientView(userId){if(!Number.isSafeInteger(userId)||userId<1)fail(400,'Choose a valid account.');return {provider:'MetaApi',configured,accounts:db.prepare('SELECT id FROM sponsored_accounts WHERE user_id=? ORDER BY created_at DESC LIMIT 100').all(userId).map(item=>({...view(row(item.id),{client:true}),accountId:item.id})),historyLimit:100};}
  function ensureCurrent(value,original){if(!value||!value.active||value.revision!==original.revision||value.provider_id_hash!==original.provider_id_hash||value.account_status!=='active'||deleted(value.user_id)||closing)fail(409,'The account connection changed while synchronization was running.','SPONSORED_CONNECTION_CHANGED');}
  async function performCore(actor,accountId,guard){
    if(!configured)fail(503,'Configure the MetaApi server token before synchronizing an account.','METAAPI_NOT_CONFIGURED');
    const original=row(accountId);if(!original)fail(404,'No MetaApi account is connected.');ensureCurrent(original,original);
    if(actor!==null)access.require(actor,'finance.write');guard?.();
    const started=now(),from=original.cursor_from??Math.max(original.history_from,(original.history_through??original.history_from)-overlap),to=original.cursor_to??started,offset=original.cursor_to===null?0:original.cursor_offset;
    db.prepare('UPDATE sponsored_sync_links SET last_attempt_at=? WHERE account_id=? AND revision=?').run(started,accountId,original.revision);
    let response;
    let deadline;
    try{response=await Promise.race([source.fetch(original.provider_account_id,{from,to,offset,limit:pageSize,maxPages:maximumPages}),stopped,new Promise((_,reject)=>{deadline=setTimeout(()=>reject(new Error('Provider timeout')),syncTimeoutMs);})]);}
    catch{ensureCurrent(row(accountId),original);if(actor!==null)access.require(actor,'finance.write');guard?.();db.prepare('UPDATE sponsored_sync_links SET error_code=?,error_message=? WHERE account_id=? AND revision=?').run('METAAPI_SYNC_FAILED','MetaApi could not synchronize this account. Check provider access, deployment, and connectivity.',accountId,original.revision);fail(503,'MetaApi synchronization is unavailable. Existing records remain unchanged.','METAAPI_SYNC_FAILED');}
    finally{clearTimeout(deadline);}
    guard?.();if(actor!==null)access.require(actor,'finance.write');ensureCurrent(row(accountId),original);
    const info=response?.accountInformation;
    if(!object(info)||!currencyCode.test(info.currency)||!finite(info.balance)||!finite(info.equity)||!Array.isArray(response.deals)||response.deals.length>pageSize*maximumPages)fail(502,'MetaApi returned invalid account information.','METAAPI_INVALID_RESPONSE');
    if(original.currency&&original.currency!==info.currency)fail(409,'The broker account currency changed. Review the connection before combining performance.','METAAPI_CURRENCY_CHANGED');
    let deals;try{deals=response.deals.map(raw=>normalizeDeal(raw,info.currency,started));}catch{fail(502,'MetaApi returned invalid deal history. No partial results were saved.','METAAPI_INVALID_RESPONSE');}
    if(deals.some(deal=>deal.time<from||deal.time>to+5000))fail(502,'MetaApi returned history outside the requested interval.','METAAPI_INVALID_RESPONSE');
    const unique=new Map();for(const deal of deals){const previous=unique.get(deal.id);if(previous&&JSON.stringify(previous)!==JSON.stringify(deal))fail(502,'MetaApi returned conflicting deal identifiers.','METAAPI_INVALID_RESPONSE');unique.set(deal.id,deal);}
    const complete=response.complete===true&&response.synchronizing!==true,nextOffset=response.nextOffset??offset+deals.length;
    if(!Number.isSafeInteger(nextOffset)||nextOffset!==offset+deals.length||(!complete&&nextOffset===offset&&response.synchronizing!==true))fail(502,'MetaApi history pagination did not advance.','METAAPI_INVALID_RESPONSE');
    return transaction(()=>{
      guard?.();if(actor!==null)access.require(actor,'finance.write');ensureCurrent(row(accountId),original);const captured=now();
      for(const deal of unique.values()){
        const payload=JSON.stringify(deal),fingerprint=hash(payload),old=db.prepare('SELECT payload_hash,revision FROM sponsored_sync_deals WHERE account_id=? AND id=?').get(accountId,deal.id);
        if(old?.payload_hash===fingerprint)continue;const revision=(old?.revision??0)+1;
        db.prepare(`INSERT INTO sponsored_sync_deals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET time=excluded.time,currency=excluded.currency,type=excluded.type,entry_type=excluded.entry_type,classification=excluded.classification,profit=excluded.profit,commission=excluded.commission,swap=excluded.swap,fee=excluded.fee,net_profit=excluded.net_profit,cash_flow=excluded.cash_flow,is_closing=excluded.is_closing,payload_hash=excluded.payload_hash,revision=excluded.revision,updated_at=excluded.updated_at`)
          .run(accountId,deal.id,deal.time,deal.currency,deal.type,deal.entryType,deal.classification,deal.profit,deal.commission,deal.swap,deal.fee,deal.netProfit,deal.cashFlow,deal.isClosing===null?null:Number(deal.isClosing),fingerprint,revision,captured);
        db.prepare('INSERT INTO sponsored_sync_deal_versions VALUES (?,?,?,?,?,?)').run(randomUUID(),accountId,deal.id,revision,payload,captured);
      }
      db.prepare('INSERT INTO sponsored_sync_snapshots VALUES (?,?,?,?,?,?) ON CONFLICT(account_id,at) DO NOTHING').run(randomUUID(),accountId,captured,info.currency,info.balance,info.equity);
      db.prepare('DELETE FROM sponsored_sync_snapshots WHERE account_id=? AND id IN (SELECT id FROM sponsored_sync_snapshots WHERE account_id=? ORDER BY at DESC LIMIT -1 OFFSET ?)').run(accountId,accountId,maximumRows);
      db.prepare('UPDATE sponsored_sync_links SET currency=?,last_success_at=?,error_code=NULL,error_message=NULL,history_through=?,history_complete=?,cursor_from=?,cursor_to=?,cursor_offset=? WHERE account_id=? AND revision=?')
        .run(info.currency,captured,complete?to:original.history_through,Number(complete),complete?null:from,complete?null:to,complete?0:nextOffset,accountId,original.revision);
      if(actor!==null)access.audit(actor,'sponsored.performance-synchronized',{targetId:original.user_id,reason:'Synchronized read-only MetaApi performance observations.',detail:{accountId,source:'MetaApi',count:unique.size}});
      return readAccount(accountId);
    });
  }
  async function perform(actor,accountId,guard){
    const original=row(accountId);
    try{return await performCore(actor,accountId,guard);}
    catch(error){
      const current=row(accountId);
      if(original&&current?.active&&current.revision===original.revision&&!closing&&(error.status>=500||error.code==='METAAPI_CURRENCY_CHANGED')){
        const code=['METAAPI_NOT_CONFIGURED','METAAPI_CURRENCY_CHANGED','METAAPI_INVALID_RESPONSE'].includes(error.code)?error.code:'METAAPI_SYNC_FAILED';
        db.prepare('UPDATE sponsored_sync_links SET error_code=?,error_message=? WHERE account_id=? AND revision=?').run(code,code==='METAAPI_CURRENCY_CHANGED'?'The broker account currency changed; historical amounts were not combined.':'MetaApi synchronization needs attention. Existing successful observations remain available.',accountId,original.revision);
      }
      throw error;
    }
  }
  async function syncAccount(actor,accountId,{guard}={}){
    accountId=id(accountId);access.require(actor,'finance.write');guard?.();
    if(!inFlight.has(accountId)){if(inFlight.size>=1)fail(409,'Another account is synchronizing. Wait for it to finish before trying again.','METAAPI_SYNC_BUSY');const task=perform(actor,accountId,guard).finally(()=>inFlight.delete(accountId));inFlight.set(accountId,task);}
    const result=await inFlight.get(accountId);access.require(actor,'finance.write');guard?.();return {...result,status:result.error?'error':'synchronized'};
  }
  function performanceData(accountId){
    accountId=id(accountId);const value=row(accountId);if(!value?.currency)return null;
    const raw=db.prepare('SELECT * FROM sponsored_sync_deals WHERE account_id=? ORDER BY time DESC,id DESC LIMIT ?').all(accountId,maximumRows+1);
    const marks=db.prepare('SELECT at,currency,balance,equity FROM sponsored_sync_snapshots WHERE account_id=? ORDER BY at DESC LIMIT ?').all(accountId,maximumRows+1);
    return {currency:value.currency,connection:view(value,{client:true}),deals:raw.slice(0,maximumRows).reverse().map(deal=>({id:deal.id,time:deal.time,currency:deal.currency,type:deal.type,entryType:deal.entry_type,classification:deal.classification,netProfit:deal.net_profit,cashFlow:deal.cash_flow,isClosing:deal.is_closing===null?null:Boolean(deal.is_closing)})),snapshots:marks.slice(0,maximumRows).reverse(),truncated:raw.length>maximumRows||marks.length>maximumRows};
  }
  function status(){return {provider:'MetaApi',configured,automaticSync:timer!==null,intervalSeconds:intervalMs/1000,synchronizing:inFlight.size,linkedAccounts:db.prepare('SELECT count(*) n FROM sponsored_sync_links WHERE active=1').get().n,readOnly:true,transfersMoney:false};}
  async function sweep(){if(sweepRunning||closing||!configured)return;sweepRunning=true;try{
    const candidates=db.prepare("SELECT l.account_id FROM sponsored_sync_links l JOIN sponsored_accounts a ON a.id=l.account_id WHERE l.active=1 AND a.status='active' ORDER BY COALESCE(l.last_attempt_at,0),l.account_id LIMIT 10").all();
    for(const item of candidates){if(closing||inFlight.size>=1)break;if(inFlight.has(item.account_id))continue;const task=perform(null,item.account_id).catch(()=>null).finally(()=>inFlight.delete(item.account_id));inFlight.set(item.account_id,task);await task;}
  }finally{sweepRunning=false;}}
  function start(){if(timer||closing||!configured)return;timer=setInterval(()=>{void sweep();},intervalMs);timer.unref();}
  async function close(){if(closing)return;closing=true;stopWaiting();if(timer)clearInterval(timer);timer=null;await source?.close?.();await Promise.allSettled([...inFlight.values()]);}
  return {linkAccount,unlinkAccount,syncAccount,readAccount,clientView,performanceData,status,start,close};
}
