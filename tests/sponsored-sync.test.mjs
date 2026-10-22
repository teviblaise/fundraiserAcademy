import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createSponsoredSync,fetchMetaApiReadOnly} from '../sponsored-sync.mjs';

const first='11111111-1111-4111-8111-111111111111',second='22222222-2222-4222-8222-222222222222';
const explanation='Assign the approved existing prop account.';
const defer=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function fixture(options={}){
  const db=new DatabaseSync(':memory:');db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT);
    INSERT INTO users VALUES(1,'Owner','owner@example.com'),(2,'Trader','trader@example.com'),(3,'Other','other@example.com');
    CREATE TABLE sponsored_accounts(id TEXT PRIMARY KEY,user_id INTEGER,status TEXT,label TEXT,created_at INTEGER);
    CREATE TABLE sync_test_audit(id INTEGER PRIMARY KEY,actor INTEGER,action TEXT,detail TEXT);
    CREATE TABLE account_deletions(user_id INTEGER PRIMARY KEY,status TEXT);
  `);
  db.prepare('INSERT INTO sponsored_accounts VALUES (?,?,?,?,?)').run(first,2,'active','Sponsored one',1);
  db.prepare('INSERT INTO sponsored_accounts VALUES (?,?,?,?,?)').run(second,3,'active','Sponsored two',2);
  let clock=Date.UTC(2026,9,21,12),authorized=true,approved=true,body;
  const calls=[];
  const access={require(actor,permission){if(actor!==1||!authorized||permission!=='finance.write')throw Object.assign(new Error('Access denied'),{status:403});},audit(actor,action,input){db.prepare('INSERT INTO sync_test_audit(actor,action,detail) VALUES (?,?,?)').run(actor,action,JSON.stringify(input));}};
  const workflows={requireApproved(){if(!approved)throw Object.assign(new Error('Approved sponsorship required'),{status:409});return {};}};
  const provider={async fetch(accountId,query){calls.push({accountId,query});return typeof body==='function'?body(accountId,query):body??result();},async close(){}};
  const result=(patch={})=>({accountInformation:{currency:'USD',balance:10000,equity:10050},deals:[],complete:true,nextOffset:0,...patch});
  const api=createSponsoredSync(db,{access,workflows,now:()=>clock,provider,...options});
  return {db,api,calls,result,access,set(value){body=value;},advance(ms){clock+=ms;},time:()=>clock,authorize(value){authorized=value;},approve(value){approved=value;},
    link(accountId=first,patch={}){return api.linkAccount(1,accountId,{providerAccountId:accountId,historyFrom:'2026-10-01',reason:explanation,...patch});},
    deal(patch={}){return {id:'10001',type:'DEAL_TYPE_BUY',entryType:'DEAL_ENTRY_OUT',time:new Date(clock-60000),profit:100,commission:-4,swap:-1,...patch};},
    async close(){await api.close();db.close();}};
}

test('linking requires an active approved record, explicit permissions, safe ID and bounded history date',async()=>{
 const f=fixture();try{
  assert.throws(()=>f.api.linkAccount(2,first,{providerAccountId:first,reason:explanation}),e=>e.status===403);
  for(const patch of [{providerAccountId:'https://untrusted.example/account'},{providerAccountId:'../private'},{historyFrom:'2026-02-30'},{historyFrom:'2027-01-01'},{reason:'no'},{password:'never-accepted'}])assert.throws(()=>f.link(first,patch),e=>e.status===400);
  f.approve(false);assert.throws(()=>f.link(),e=>e.status===409);f.approve(true);
  f.db.prepare("UPDATE sponsored_accounts SET status='closed' WHERE id=?").run(first);assert.throws(()=>f.link(),e=>e.status===409);
  f.db.prepare("UPDATE sponsored_accounts SET status='active' WHERE id=?").run(first);
  const linked=f.link();assert.equal(linked.active,true);assert.equal(linked.revision,1);assert.equal(linked.historyFrom,Date.UTC(2026,9,1));assert.equal(f.calls.length,0);assert.equal(f.db.prepare('SELECT count(*) n FROM sync_test_audit').get().n,1);
 }finally{await f.close();}
});

test('external account bindings cannot be reassigned, silently replaced, or deleted',async()=>{
 const f=fixture();try{
  f.link();assert.throws(()=>f.link(second,{providerAccountId:first}),e=>e.status===409);
  assert.throws(()=>f.link(first,{providerAccountId:second}),e=>e.status===409);
  assert.throws(()=>f.link(first,{historyFrom:'2026-10-02'}),e=>e.status===409);
  assert.throws(()=>f.api.unlinkAccount(1,first,{revision:0,reason:explanation}),e=>e.status===409);
  assert.equal(f.api.unlinkAccount(1,first,{revision:1,reason:explanation}).status,'disconnected');
  assert.equal(f.link(first,{expectedRevision:2}).revision,3);
  assert.throws(()=>f.db.prepare('DELETE FROM sponsored_sync_links').run(),/cannot be deleted/);
  assert.throws(()=>f.db.prepare('UPDATE sponsored_sync_links SET provider_id_hash=?').run('tampered'),/immutable/);
 }finally{await f.close();}
});

test('synchronization normalizes actual trades, costs and cashflows without creating financial credits',async()=>{
 const f=fixture();try{
  f.link();f.set(f.result({deals:[f.deal(),f.deal({id:'2',type:'DEAL_TYPE_BALANCE',profit:5000,commission:0,swap:0}),f.deal({id:'3',type:'DEAL_TYPE_COMMISSION',profit:-2,commission:0,swap:0}),f.deal({id:'4',type:'DEAL_TYPE_CORRECTION',profit:4,commission:0,swap:0})],nextOffset:4}));
  const synced=await f.api.syncAccount(1,first);assert.equal(synced.status,'synchronized');assert.equal(synced.latest.equity,10050);assert.equal(synced.historyComplete,true);
  const data=f.api.performanceData(first);assert.equal(data.currency,'USD');assert.equal(data.snapshots.length,1);
  assert.equal(data.deals.find(x=>x.id==='10001').netProfit,95);assert.equal(data.deals.find(x=>x.id==='10001').isClosing,true);
  assert.equal(data.deals.find(x=>x.id==='2').classification,'cashflow');assert.equal(data.deals.find(x=>x.id==='2').cashFlow,5000);
  assert.equal(data.deals.find(x=>x.id==='3').classification,'trading_cost');assert.equal(data.deals.find(x=>x.id==='4').classification,'adjustment');
  assert.equal(f.db.prepare("SELECT count(*) n FROM sqlite_master WHERE name IN ('sponsored_statements','sponsored_payouts')").get().n,0);
  assert.equal(synced.transfersMoney,false);assert.equal(synced.controlsTrades,false);
 }finally{await f.close();}
});

test('repeated history is idempotent and provider corrections are versioned rather than double counted',async()=>{
 const f=fixture();try{
  f.link();f.set(f.result({deals:[f.deal()],nextOffset:1}));await f.api.syncAccount(1,first);f.advance(60000);await f.api.syncAccount(1,first);
  assert.equal(f.api.performanceData(first).deals.length,1);assert.equal(f.db.prepare('SELECT count(*) n FROM sponsored_sync_deal_versions').get().n,1);
  f.advance(60000);f.set(f.result({deals:[f.deal({profit:120})],nextOffset:1}));await f.api.syncAccount(1,first);
  assert.equal(f.api.performanceData(first).deals[0].netProfit,115);assert.equal(f.db.prepare('SELECT count(*) n FROM sponsored_sync_deal_versions').get().n,2);
  assert.equal(f.db.prepare('SELECT revision FROM sponsored_sync_deals').get().revision,2);assert.equal(f.api.performanceData(first).snapshots.length,3);
 }finally{await f.close();}
});

test('incomplete history resumes a fixed interval then overlaps recent history after coverage completes',async()=>{
 const f=fixture();try{
  f.link();f.set(f.result({deals:[f.deal()],complete:false,nextOffset:1}));await f.api.syncAccount(1,first);assert.equal(f.api.readAccount(first).historyComplete,false);
  const firstQuery=f.calls[0].query;f.advance(60000);f.set(f.result({deals:[f.deal({id:'2'})],nextOffset:2}));await f.api.syncAccount(1,first);
  assert.equal(f.calls[1].query.from,firstQuery.from);assert.equal(f.calls[1].query.to,firstQuery.to);assert.equal(f.calls[1].query.offset,1);
  assert.equal(f.api.readAccount(first).historyThrough,firstQuery.to);assert.equal(f.api.readAccount(first).historyComplete,true);
  f.advance(60000);f.set(f.result());await f.api.syncAccount(1,first);assert.equal(f.calls[2].query.from,firstQuery.to-7*86400000);assert.equal(f.calls[2].query.offset,0);
 }finally{await f.close();}
});

test('provider errors retain last successful observations and never reveal raw secrets',async()=>{
 const f=fixture();try{
  f.link();await f.api.syncAccount(1,first);const before=f.api.performanceData(first);f.advance(60000);
  f.set(()=>{throw new Error('auth-token PRIVATE_KEY name secret@example.com');});await assert.rejects(f.api.syncAccount(1,first),e=>e.status===503&&!e.message.includes('PRIVATE_KEY'));
  const connection=f.api.readAccount(first);assert.equal(connection.status,'error');assert.equal(connection.lastSuccessAt,before.connection.lastSuccessAt);assert.equal(f.api.performanceData(first).snapshots.length,1);
  assert.doesNotMatch(JSON.stringify(connection),/PRIVATE_KEY|secret@example/);
  f.advance(180001);assert.equal(f.api.readAccount(first).stale,true);
 }finally{await f.close();}
});

test('invalid, conflicting, future or currency-mismatched batches do not partially persist',async()=>{
 const f=fixture();try{
  f.link();await f.api.syncAccount(1,first);f.advance(60000);
  for(const response of [f.result({accountInformation:{currency:'USD',balance:NaN,equity:1}}),f.result({deals:[f.deal({profit:NaN})],nextOffset:1}),f.result({deals:[f.deal({time:new Date(f.time()+10000)})],nextOffset:1}),f.result({deals:[f.deal(),f.deal({profit:200})],nextOffset:2}),f.result({deals:[f.deal()],nextOffset:20})]){
   f.set(response);await assert.rejects(f.api.syncAccount(1,first),e=>e.status===502);assert.equal(f.api.performanceData(first).deals.length,0);assert.equal(f.api.performanceData(first).snapshots.length,1);
  }
  f.set(f.result({accountInformation:{currency:'EUR',balance:100,equity:100}}));await assert.rejects(f.api.syncAccount(1,first),e=>e.code==='METAAPI_CURRENCY_CHANGED');assert.equal(f.api.performanceData(first).currency,'USD');assert.equal(f.api.readAccount(first).error.code,'METAAPI_CURRENCY_CHANGED');
 }finally{await f.close();}
});

test('assignment revisions, deletion and revoked actor permissions prevent stale in-flight writes',async()=>{
 for(const change of ['unlink','delete','permissions','guard']){
  const f=fixture(),waiting=defer();try{
   f.link();f.set(()=>waiting.promise);let permitted=true;const work=f.api.syncAccount(1,first,{guard(){if(!permitted)throw Object.assign(new Error('Session revoked'),{status:401});}});
   await new Promise(resolve=>setImmediate(resolve));
   if(change==='unlink')f.api.unlinkAccount(1,first,{revision:1,reason:explanation});
   if(change==='delete')f.db.prepare("INSERT INTO account_deletions VALUES(2,'deleted')").run();
   if(change==='permissions')f.authorize(false);if(change==='guard')permitted=false;
   waiting.resolve(f.result());await assert.rejects(work,e=>[401,403,409].includes(e.status));assert.equal(f.db.prepare('SELECT count(*) n FROM sponsored_sync_snapshots').get().n,0);
  }finally{waiting.resolve(f.result());await f.close();}
 }
});

test('global concurrency is bounded and repeated requests for one account share a single fetch',async()=>{
 const f=fixture(),waiting=defer();try{
  f.link();f.link(second);f.set(()=>waiting.promise);const firstCall=f.api.syncAccount(1,first),secondCall=f.api.syncAccount(1,first);
  await assert.rejects(f.api.syncAccount(1,second),e=>e.code==='METAAPI_SYNC_BUSY');assert.equal(f.calls.length,1);
  waiting.resolve(f.result());await Promise.all([firstCall,secondCall]);assert.equal(f.api.performanceData(first).snapshots.length,1);
 }finally{waiting.resolve(f.result());await f.close();}
});

test('client views remain owner scoped and omit external IDs and private provider details',async()=>{
 const f=fixture();try{
  f.link();await f.api.syncAccount(1,first);
  assert.equal(f.api.clientView(2).accounts.length,1);assert.equal(f.api.clientView(3).accounts[0].linked,false);
  assert.doesNotMatch(JSON.stringify(f.api.clientView(2)),/providerAccountId|provider_id_hash|owner@example|auth-token/);
  assert.equal(f.api.readAccount(first).providerAccountId,first);assert.throws(()=>f.api.clientView('2 OR 1=1'),e=>e.status===400);
 }finally{await f.close();}
});

test('missing token is explicit, does not load the SDK or fabricate data, and close is bounded during a hung provider',async()=>{
 const absent=fixture({provider:undefined,apiToken:''});try{absent.link();assert.equal(absent.api.status().configured,false);await assert.rejects(absent.api.syncAccount(1,first),e=>e.code==='METAAPI_NOT_CONFIGURED');assert.equal(absent.api.performanceData(first),null);}finally{await absent.close();}
 const f=fixture(),waiting=defer();try{
  f.link();f.set(()=>waiting.promise);const work=f.api.syncAccount(1,first);const rejection=assert.rejects(work,e=>e.status===409);await f.api.close();await rejection;assert.equal(f.db.prepare('SELECT count(*) n FROM sponsored_sync_snapshots').get().n,0);
 }finally{waiting.resolve(f.result());await f.close();}
});

test('actual external IDs can be erased during account deletion while permanent hash binding remains',async()=>{
 const f=fixture();try{
  f.link();await f.api.syncAccount(1,first);f.db.prepare('UPDATE sponsored_sync_links SET active=0,provider_account_id=NULL,revision=revision+1 WHERE account_id=?').run(first);
  for(const name of ['sponsored_sync_deal_versions','sponsored_sync_deals','sponsored_sync_snapshots'])f.db.prepare(`DELETE FROM ${name} WHERE account_id=?`).run(first);
  assert.equal(f.api.readAccount(first).providerAccountId,null);assert.equal(f.api.performanceData(first).deals.length,0);assert.throws(()=>f.link(second,{providerAccountId:first}),e=>e.status===409);
 }finally{await f.close();}
});

test('official SDK adapter uses the Node entry and only existing-account read calls, closing every connection',async()=>{
 const calls=[];let deployed=true;
 class SDK{
  static enableLog4jsLogging(){calls.push('safe-logger');}
  constructor(token,options){assert.equal(token,'test-only-not-a-provider-key');assert.equal(options.packetLogger.enabled,false);calls.push('constructor');this.metatraderAccountApi={getAccount:async accountId=>{assert.equal(accountId,first);calls.push('get-account');return{id:first,state:deployed?'DEPLOYED':'UNDEPLOYED',getRPCConnection:()=>({
   async connect(){calls.push('connect');},async waitSynchronized(seconds){assert.equal(seconds,10);calls.push('synchronized');},
   async getAccountInformation(){calls.push('account-information');return{currency:'EUR',balance:1200,equity:1210,name:'Never exported',login:987654};},
   async getDealsByTimeRange(from,to,offset,limit){assert.ok(from instanceof Date&&to instanceof Date);assert.equal(offset,0);assert.equal(limit,1000);calls.push('history');return{deals:[],synchronizing:false};},
   async close(){calls.push('connection-close');}
  })};}};}
  close(){calls.push('sdk-close');}
 }
 const input={token:'test-only-not-a-provider-key',accountId:first,from:Date.UTC(2026,9,1),to:Date.UTC(2026,9,21),offset:0};
 const result=await fetchMetaApiReadOnly(input,{loadSdk:async()=>({default:{default:SDK}})});
 assert.deepEqual(calls,['safe-logger','constructor','get-account','connect','synchronized','account-information','history','connection-close','sdk-close']);
 assert.equal(result.accountInformation.currency,'EUR');assert.equal(result.complete,true);assert.doesNotMatch(JSON.stringify(result),/Never exported|987654|test-only-not/);
 calls.length=0;deployed=false;await assert.rejects(fetchMetaApiReadOnly(input,{loadSdk:async()=>({default:SDK})}),/not deployed/);assert.deepEqual(calls,['safe-logger','constructor','get-account','sdk-close']);
});
