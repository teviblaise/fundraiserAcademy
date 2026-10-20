import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createAdminData, adminCsvCell } from '../admin-data.mjs';
import { createAccount, applyReferenceQuotes, openTrade, closeTrade } from '../public/simulator.js';
import { createCertificates } from '../certificates.mjs';
import { createContracts } from '../contracts.mjs';

const time=Date.UTC(2026,9,20,12);
function fixture() {
  const db=new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT UNIQUE,name TEXT,market TEXT,password TEXT,created_at INTEGER,first_name TEXT,other_names TEXT,email_confirmation_required INTEGER DEFAULT1);
    CREATE TABLE accounts(user_id INTEGER PRIMARY KEY REFERENCES users(id),state TEXT);
    CREATE TABLE events(id INTEGER PRIMARY KEY,user_id INTEGER,kind TEXT,detail TEXT,created_at INTEGER);
    CREATE TABLE notification_preferences(user_id INTEGER PRIMARY KEY,verified INTEGER,email_enabled INTEGER);
    CREATE TABLE two_factor(user_id INTEGER PRIMARY KEY,secret TEXT);
    CREATE TABLE sessions(token TEXT PRIMARY KEY,user_id INTEGER,expires INTEGER,last_seen INTEGER);
    CREATE TABLE admin_account_status(user_id INTEGER PRIMARY KEY,status TEXT,reason TEXT,updated_by INTEGER,updated_at INTEGER);
    CREATE TABLE admin_notes(id INTEGER PRIMARY KEY,user_id INTEGER,actor_user_id INTEGER,text TEXT,created_at INTEGER);
    CREATE TABLE sponsorship_review_history(id INTEGER PRIMARY KEY,user_id INTEGER,revision INTEGER,status TEXT,contract_id TEXT,contract_hash TEXT,certificate_id TEXT,reason TEXT,client_message TEXT,actor_user_id INTEGER,created_at INTEGER);
    CREATE TABLE sponsorship_reviews(user_id INTEGER PRIMARY KEY,status TEXT);
    CREATE TABLE support_conversations(id TEXT PRIMARY KEY,status TEXT);`);
  const certificates=createCertificates(db),contracts=createContracts(db);
  for(let id=1;id<=6;id++) {
    db.prepare('INSERT INTO users(id,email,name,market,password,created_at,first_name,other_names,email_confirmation_required)VALUES(?,?,?,?,?,?,?,?,?)').run(id,`user${id}@example.com`,`Trader ${id}`,'I trade forex','private-password-never-export',time-id*86400000,`Trader`,`${id}`,1);
    db.prepare('INSERT INTO notification_preferences VALUES(?,?,0)').run(id,id===2?0:1);
    db.prepare('INSERT INTO accounts VALUES(?,?)').run(id,JSON.stringify(createAccount(time)));
  }
  db.exec("INSERT INTO admin_account_status VALUES(2,'suspended','Private reason',1,123); INSERT INTO two_factor VALUES(1,'encrypted-seed-never-export'); INSERT INTO sessions VALUES('private-cookie-hash',1,9999999999999,9999999999999); INSERT INTO support_conversations VALUES('private-conversation','waiting'); INSERT INTO sponsorship_reviews VALUES(3,'needs_information');");
  const data=createAdminData(db,{now:()=>time});
  const write=(id,state)=>db.prepare('UPDATE accounts SET state=? WHERE user_id=?').run(typeof state==='string'?state:JSON.stringify(state),id);
  const qualify=(id=1,extra={})=>{const account=createAccount(time);Object.assign(account,{balance:11500,locked:'Profit target achieved',tradingDays:['2026-10-10','2026-10-11','2026-10-12'],...extra});write(id,account);return certificates.issue(id,account,time-86400000*2);};
  return {db,data,write,qualify,contracts,certificates,close:()=>db.close()};
}

test('overview uses real persisted counts and UTC daily events without exposing any trader PII',()=>{
 const app=fixture();try{
  app.qualify(1);const daily=createAccount(time);daily.locked='Daily loss limit';app.write(2,daily);const failed=createAccount(time);failed.locked='Total loss limit';app.write(3,failed);app.write(4,{...createAccount(time),executionMode:'legacy'});
  const overview=app.data.overview({days:'7'});assert.equal(overview.metrics.totalTraders,6);assert.equal(overview.metrics.confirmedEmails,5);assert.equal(overview.metrics.unconfirmedEmails,1);assert.equal(overview.metrics.passedAssessments,1);assert.equal(overview.metrics.lockedAssessments,1);assert.equal(overview.metrics.failedAssessments,1);assert.equal(overview.metrics.legacyAssessments,1);assert.equal(overview.metrics.activeAssessments,2);assert.equal(overview.metrics.qualifiedTraders,1);assert.equal(overview.daily.length,7);assert.equal(overview.daily.reduce((sum,row)=>sum+row.registrations,0),6);assert.equal(overview.daily.reduce((sum,row)=>sum+row.qualifiedAssessments,0),1);assert.equal(overview.support.waiting,1);assert.equal(overview.reviews.needs_information,1);assert.doesNotMatch(JSON.stringify(overview),/user1@|Trader 1|private-cookie|private-password|encrypted-seed|conversation/);
 }finally{app.close();}
});

test('trader searches are literal, parameterized, bounded and combine suspension/email/assessment filters',()=>{
 const app=fixture();try{
  app.db.prepare('UPDATE users SET name=? WHERE id=5').run('100%_Trader');const result=app.data.traders({search:'%',limit:'1'});assert.equal(result.total,1);assert.equal(result.items[0].id,5);assert.equal(app.data.traders({search:"' OR 1=1 --"}).total,0);const suspended=app.data.traders({status:'suspended',emailStatus:'pending'});assert.equal(suspended.total,1);assert.equal(suspended.items[0].id,2);assert.equal(suspended.items[0].emailVerified,false);assert.equal(suspended.items[0].assessmentAccess,false);
  const first=app.data.traders({limit:2});assert.equal(first.items.length,2);assert.equal(first.nextOffset,2);assert.equal(app.data.traders({limit:2,offset:5}).items.length,1);assert.equal(app.data.traders({limit:2,offset:5}).nextOffset,null);
  for(const query of [{limit:0},{limit:101},{limit:'1.5'},{offset:-1},{status:'banned'},{emailStatus:'injected'},{assessmentStatus:'fake'},{search:'x'.repeat(151)}])assert.throws(()=>app.data.traders(query),error=>error.status===400);
 }finally{app.close();}
});

test('daily locks, failed attempts, historical modes and invalid data are reported truthfully without mutating accounts',()=>{
 const app=fixture();try{
  const daily=createAccount(time);daily.locked='Daily loss limit';app.write(1,daily);const total=createAccount(time);total.locked='Total loss limit';app.write(2,total);app.write(3,{...createAccount(time),executionMode:'synthetic'});app.write(4,'{malformed');const before=app.db.prepare('SELECT state FROM accounts ORDER BY user_id').all();
  assert.equal(app.data.traders({assessmentStatus:'locked'}).items[0].id,1);assert.equal(app.data.traders({assessmentStatus:'failed'}).items[0].id,2);assert.equal(app.data.traders({assessmentStatus:'legacy'}).items[0].id,3);assert.equal(app.data.traders({assessmentStatus:'unavailable'}).items[0].id,4);assert.equal(app.data.trader(4).assessment.balance,null);assert.deepEqual(app.db.prepare('SELECT state FROM accounts ORDER BY user_id').all(),before);
 }finally{app.close();}
});

test('passed labels require server lock, realized target, three distinct filled days and no open positions',()=>{
 const app=fixture();try{
  const state=createAccount(time);state.balance=11500;state.tradingDays=['2026-10-10','2026-10-11','2026-10-12'];app.write(1,state);assert.equal(app.data.trader(1).assessment.status,'running');state.locked='Profit target achieved';state.tradingDays=['2026-10-10','2026-10-10','2026-10-10'];app.write(1,state);assert.equal(app.data.trader(1).assessment.status,'locked');state.tradingDays=['2026-10-10','2026-10-11','2026-10-12'];app.write(1,state);assert.equal(app.data.trader(1).assessment.status,'passed');assert.equal(app.data.traders({assessmentStatus:'passed'}).total,1);
 }finally{app.close();}
});

test('trade detail exposes allowlisted reference snapshots, paginates history and never fetches or publishes secrets',()=>{
 const app=fixture();try{
  const state=createAccount(time);applyReferenceQuotes(state,[{symbol:'EURUSD',price:1.1,asOf:time/1000,fetchedAt:time,source:'Fixture reference',executable:true}],time);const trade=openTrade(state,{symbol:'EURUSD',side:'buy',lots:.01},time);closeTrade(state,trade.id,'Manual close',time+1);state.history[0].privateApiKey='do-not-export-this-value';state.prices.EURUSD.privateToken='do-not-export-price-value';app.write(1,state);app.db.prepare('INSERT INTO admin_notes VALUES(1,1,2,?,?)').run('Private staff note',time);const detail=app.data.trader(1,{tradeLimit:1});assert.equal(detail.tradeHistory.total,1);assert.equal(detail.tradeHistory.items[0].entrySource,'Fixture reference');assert.equal(detail.tradeHistory.items[0].lots,.01);assert.equal(detail.sessionCount,1);assert.equal(detail.notes[0].text,'Private staff note');assert.equal(detail.twoFactorEnabled,true);assert.equal(detail.assessment.valuationMode,'persisted_reference');assert.doesNotMatch(JSON.stringify(detail),/private-password|private-cookie|encrypted-seed|privateApiKey|privateToken|do-not-export/);assert.throws(()=>app.data.trader(999),error=>error.status===404);assert.throws(()=>app.data.trader('1 OR 1=1'),error=>error.status===400);
 }finally{app.close();}
});

test('certificate and contract pages distinguish verified certificates and exact current signatures after version changes',()=>{
 const app=fixture();try{
  const document=app.contracts.publish({content:Buffer.from('Private operator test agreement'),format:'text',version:'v1',now:time-86400000*3});const certificate=app.qualify(1);app.contracts.sign(1,{contractId:document.id,contractHash:document.hash,contractVersion:document.version,legalName:'Trader Legal Name',consent:true},time-86400000);assert.equal(app.data.trader(1).contractStatus,'signed');assert.equal(app.data.overview().metrics.currentSignatures,1);const certPage=app.data.certificatesPage({userId:1});assert.equal(certPage.items[0].qualified,true);assert.equal(certPage.items[0].downloadUrl,`/api/admin/certificates/${certificate.id}.svg`);const page=app.data.contractsPage();assert.equal(page.items[0].signatureCount,1);assert.equal(page.active.id,document.id);assert.equal(page.signatures.items[0].legalName,'Trader Legal Name');assert.doesNotMatch(JSON.stringify(page),/Private operator test agreement|"content"/);
  app.contracts.publish({content:Buffer.from('Private newer operator agreement'),format:'text',version:'v2',now:time});assert.equal(app.data.trader(1).contractStatus,'signature_required');assert.equal(app.data.overview().metrics.currentSignatures,0);assert.equal(app.data.contractsPage().signatures.total,1);
 }finally{app.close();}
});

test('legacy, short or inconsistent certificate results do not count as qualification',()=>{
 const app=fixture();try{const certificate=app.qualify(1);app.db.prepare('UPDATE certificates SET profit_percent=99 WHERE id=?').run(certificate.id);assert.equal(app.data.certificatesPage().items[0].qualified,false);assert.equal(app.data.overview().metrics.qualifiedTraders,0);assert.equal(app.data.trader(1).contractStatus,'assessment_required');}finally{app.close();}
});

test('CSV export protects spreadsheet formula cells, quotes text, preserves bounded report totals and excludes secrets',()=>{
 const app=fixture();try{
  app.db.prepare('UPDATE users SET name=? WHERE id=1').run('  =HYPERLINK("unsafe")');const result=app.data.report({type:'traders',limit:1});assert.equal(result.total,6);assert.equal(result.returned,1);assert.equal(result.truncated,true);assert.match(result.csv,/'  =HYPERLINK\(""unsafe""\)/);assert.doesNotMatch(result.csv,/private-password|encrypted-seed|private-cookie/);assert.equal(adminCsvCell('   +SUM(1,2)'),`"'   +SUM(1,2)"`);assert.equal(adminCsvCell('\tplain'),`"'\tplain"`);assert.equal(adminCsvCell('a,"b"'),`"a,""b"""`);
  assert.equal(app.data.report({from:'2026-10-19',to:'2026-10-19'}).total,1);assert.equal(app.data.report({userId:2}).total,1);for(const query of [{type:'passwords'},{limit:5001},{from:'2026-02-30'},{from:'2026-10-20',to:'2026-10-19'},{userId:'bad'}])assert.throws(()=>app.data.report(query),error=>error.status===400);
 }finally{app.close();}
});

test('trade reports read only closed fill history, respect UTC date filters, and use allowlisted columns',()=>{
 const app=fixture();try{
  const state=createAccount(time);applyReferenceQuotes(state,[{symbol:'EURUSD',price:1.1,asOf:time/1000,fetchedAt:time,source:'Fixture',executable:true}],time);const opened=openTrade(state,{symbol:'EURUSD',side:'buy',lots:.01},time);closeTrade(state,opened.id,'Manual close',time);state.history[0].recoveryCode='sensitive';app.write(1,state);const result=app.data.report({type:'trades',from:'2026-10-20',to:'2026-10-20'});assert.equal(result.total,1);assert.equal(result.rows[0][4],'EURUSD');assert.equal(result.rows[0][6],.01);assert.doesNotMatch(result.csv,/recoveryCode|sensitive/);assert.equal(app.data.report({type:'trades',from:'2026-10-19',to:'2026-10-19'}).total,0);
 }finally{app.close();}
});

test('malformed object shapes and malformed history entries cannot break admin reports or fabricate passes',()=>{
 const app=fixture();try{
  app.write(1,'[]');app.write(2,{executionMode:'reference',locked:'Profit target achieved'});app.write(3,'{bad json');const state=createAccount(time);state.history=['not an object',null,1,{id:7,symbol:'EURUSD',side:'buy',quantity:1000,entry:1.1,exit:1.2,profit:100,openedAt:time-1,closedAt:time}];app.write(4,state);
  assert.equal(app.data.trader(1).assessment.status,'unavailable');assert.equal(app.data.traders({assessmentStatus:'unavailable'}).total,3);assert.equal(app.data.report({type:'trades'}).total,1);assert.equal(app.data.report({type:'trades',from:'2026-10-20',to:'2026-10-20'}).rows[0][3],7);
 }finally{app.close();}
});

test('out-of-range timestamps cannot crash reports and pagination never treats invalid query values as authorization',()=>{
 const app=fixture();try{
  app.db.prepare('UPDATE users SET created_at=? WHERE id=1').run(8640000000000001);assert.equal(app.data.report({userId:1}).rows[0][3],'');assert.throws(()=>app.data.report({to:8640000000000001}),error=>error.status===400);assert.throws(()=>app.data.trader(1,{tradeOffset:Infinity}),error=>error.status===400);assert.throws(()=>app.data.overview({days:91}),error=>error.status===400);
 }finally{app.close();}
});

test('dynamic workflow summaries do not count stale approval as a current approval and corrupted trade entries cannot trap paging',()=>{
 const app=fixture();try{
  const state=createAccount(time);state.history=[null,'bad',{id:1,symbol:'EURUSD',side:'buy',closedAt:time},{id:2,symbol:'EURUSD',side:'sell',closedAt:time}];app.write(1,state);const first=app.data.trader(1,{tradeLimit:1});assert.equal(first.tradeHistory.total,2);assert.equal(first.tradeHistory.nextOffset,1);assert.equal(app.data.trader(1,{tradeLimit:1,tradeOffset:1}).tradeHistory.nextOffset,null);
  const data=createAdminData(app.db,{now:()=>time,workflows:{summary:()=>({counts:{approved:0,stale:1,pending_review:2},total:3})}});assert.equal(data.overview().reviews.approved,0);assert.equal(data.overview().reviews.stale,1);assert.equal(data.overview().reviews.pending_review,2);assert.equal(data.overview().reviews.total,3);
 }finally{app.close();}
});
