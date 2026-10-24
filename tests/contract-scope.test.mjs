import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createContracts,contractConsentStatement,requiredContractDocument,publishContractFile} from '../contracts.mjs';
import {createCertificates} from '../certificates.mjs';
import {createLeaderboard} from '../leaderboard.mjs';
import {createAccount} from '../public/simulator.js';
import {buildReinstatementAgreement} from '../progressive-finance.mjs';

const document=(version,extra={})=>({version,title:'Company authorized agreement',content:Buffer.from(`Company agreement ${version}.`),format:'text',now:2000,...extra});
const signature=doc=>({contractId:doc.id,contractVersion:doc.version,contractHash:doc.hash,legalName:'Private Legal Name',consent:true});
function fixture(filename=':memory:'){
 const db=new DatabaseSync(filename);
 db.exec(`PRAGMA foreign_keys=ON;
  CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL);
  CREATE TABLE events(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);`);
 const certificates=createCertificates(db);
 for(let id=1;id<=3;id++){
  db.prepare('INSERT INTO users(id,name,email) VALUES(?,?,?)').run(id,`Private User ${id}`,`private-user-${id}@example.com`);
  const state=createAccount();Object.assign(state,{balance:11000,positions:[],locked:'Profit target achieved',tradingDays:['2026-10-19','2026-10-20','2026-10-21']});
  certificates.issue(id,state,1000);
 }
 const contracts=createContracts(db),leaderboard=createLeaderboard(db,{now:()=>10000});
 return{db,contracts,leaderboard};
}

test('a personal agreement changes only its recipient requirement and never exposes their document or interrupts another public ranking',()=>{
 const {db,contracts,leaderboard}=fixture();try{
  const base=contracts.publish(document('global-v1'));
  for(const id of [1,2]){contracts.sign(id,signature(base),2500);leaderboard.setPreferences(id,{enabled:true,alias:`Public Alias ${id}`});}
  const before=leaderboard.page();assert.equal(before.total,2);
  const personal=contracts.publish(document('private-v1',{recipientUserId:1,now:3000,content:Buffer.from('Private amendment reference FOR-ONE-ONLY.')}));
  assert.equal(personal.scope,'personal');assert.equal(personal.recipientUserId,1);
  assert.equal(requiredContractDocument(db,1).id,personal.id);assert.equal(requiredContractDocument(db,2).id,base.id);
  assert.equal(contracts.status(1).status,'signature_required');assert.equal(contracts.status(2).status,'signed');
  assert.equal(contracts.status(2).contract.scope,'global');assert.equal(contracts.status(2).contract.recipientUserId,null);
  assert.equal(leaderboard.page().total,1);assert.equal(leaderboard.page().entries[0].displayAlias,'Public Alias 2');
  assert.throws(()=>contracts.document(2,personal.id),error=>error.status===404);
  assert.throws(()=>contracts.sign(2,signature(personal),3500),error=>error.status===409);
  assert.equal(contracts.document(1,personal.id).content.toString(),'Private amendment reference FOR-ONE-ONLY.');
  assert.doesNotMatch(JSON.stringify(contracts.status(2)),/FOR-ONE-ONLY|private-v1/);
  assert.doesNotMatch(JSON.stringify(leaderboard.page()),/FOR-ONE-ONLY|private-v1|recipientUserId|contractId|userId/);
  contracts.sign(1,signature(personal),3500);assert.equal(leaderboard.page().total,2);
 }finally{db.close();}
});

test('global and personal publication histories are immutable and superseded startup versions cannot reactivate either scope',()=>{
 const {db,contracts}=fixture();try{
  const base=contracts.publish(document('global-v1'));contracts.sign(1,signature(base),2500);
  const first=contracts.publish(document('private-v1',{recipientUserId:1,now:3000}));contracts.sign(1,signature(first),3500);
  const second=contracts.publish(document('private-v2',{recipientUserId:1,now:4000}));
  const currentGlobal=contracts.publish(document('global-v2',{now:4500}));
  assert.equal(contracts.status(1).contract.id,second.id);assert.equal(contracts.status(2).contract.id,currentGlobal.id);
  assert.equal(contracts.publish(document('private-v1',{recipientUserId:1,now:5000})).active,false);
  assert.equal(contracts.publish(document('global-v1',{now:5000})).active,false);
  assert.equal(contracts.status(1).contract.id,second.id);assert.equal(contracts.status(2).contract.id,currentGlobal.id);
  assert.equal(contracts.status(1).history.length,2);assert.equal(contracts.document(1,first.id).content.toString(),'Company agreement private-v1.');
  assert.equal(contracts.document(1,base.id).content.toString(),'Company agreement global-v1.');
  assert.throws(()=>contracts.document(2,first.id),error=>error.status===404);
  assert.throws(()=>contracts.publish(document('private-v1',{recipientUserId:2})),error=>error.status===409);
  assert.throws(()=>contracts.publish(document('private-v1')),error=>error.status===409);
  assert.throws(()=>db.prepare('UPDATE contract_documents SET recipient_user_id=2 WHERE id=?').run(first.id),/immutable/);
  assert.throws(()=>db.prepare('UPDATE active_contract SET contract_id=? WHERE singleton=1').run(first.id),/global agreement/);
  assert.throws(()=>db.prepare('INSERT INTO user_active_contract VALUES(?,?)').run(2,first.id),/assigned recipient/);
 }finally{db.close();}
});

test('generated reinstatement documents require the actual previous-relationship owner even when renamed before upload',()=>{
 const {db,contracts}=fixture();try{
  const base=contracts.publish(document('global-v1'));
  db.exec('CREATE TABLE progressive_relationships(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id));');
  const previous=randomUUID();db.prepare('INSERT INTO progressive_relationships VALUES(?,?)').run(previous,1);
  const prepared=buildReinstatementAgreement({previousRelationshipId:previous,writtenAgreementReference:'Private written reference',startingTraderShareBps:6000});
  assert.throws(()=>contracts.publish(prepared),error=>error.status===400);
  assert.throws(()=>contracts.publish({...prepared,recipientUserId:2}),error=>error.status===400);
  assert.throws(()=>contracts.publish({...prepared,version:'renamed-upload'}),error=>error.status===400);
  assert.throws(()=>contracts.publish({...prepared,version:'renamed-upload',recipientUserId:2}),error=>error.status===400);
  assert.throws(()=>contracts.publish({...prepared,recipientUserId:1,content:Buffer.from(prepared.content.toString().replace(previous,randomUUID()))}),error=>error.status===400);
  const published=contracts.publish({...prepared,recipientUserId:1});
  assert.equal(published.recipientUserId,1);assert.equal(published.scope,'personal');assert.equal(contracts.status(2).contract.id,base.id);
  assert.equal(db.prepare('SELECT count(*) n FROM contract_documents').get().n,2);
 }finally{db.close();}
});

test('personal publication validates recipient identity and rolls back assignment and document when audit callback fails',()=>{
 const {db,contracts}=fixture();try{
  const base=contracts.publish(document('global-v1'));
  for(const recipientUserId of [0,-1,1.5,true,'1',999])assert.throws(()=>contracts.publish(document('bad-recipient',{recipientUserId})),error=>error.status===400);
  assert.throws(()=>contracts.publish(document('audit-fails',{recipientUserId:1,onPublish(){throw new Error('fixture audit failure');}})),/fixture audit failure/);
  assert.equal(contracts.status(1).contract.id,base.id);assert.equal(db.prepare('SELECT count(*) n FROM user_active_contract').get().n,0);
  assert.equal(db.prepare('SELECT count(*) n FROM contract_documents').get().n,1);assert.equal(db.prepare('SELECT count(*) n FROM contract_publication_events').get().n,1);
 }finally{db.close();}
});

test('existing eight-column contract installations migrate additively and preserve previously signed bytes',()=>{
 const db=new DatabaseSync(':memory:');try{
  db.exec(`PRAGMA foreign_keys=ON;
   CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT,email TEXT);
   CREATE TABLE events(id INTEGER PRIMARY KEY,user_id INTEGER,kind TEXT,detail TEXT,created_at INTEGER);
   INSERT INTO users VALUES(1,'Private Legacy Name','private-legacy@example.com');
   CREATE TABLE contract_documents(id TEXT PRIMARY KEY,version TEXT UNIQUE NOT NULL,title TEXT NOT NULL,hash TEXT NOT NULL,format TEXT NOT NULL,file_name TEXT NOT NULL,content BLOB NOT NULL,published_at INTEGER NOT NULL);
   CREATE TABLE active_contract(singleton INTEGER PRIMARY KEY,contract_id TEXT NOT NULL REFERENCES contract_documents(id));`);
  const certificates=createCertificates(db),state=createAccount();Object.assign(state,{balance:11000,positions:[],locked:'Profit target achieved',tradingDays:['2026-10-19','2026-10-20','2026-10-21']});const certificate=certificates.issue(1,state,1000);
  const id=randomUUID(),bytes=Buffer.from('Original legacy signed bytes.'),hash=createHash('sha256').update(bytes).digest('hex');
  db.prepare('INSERT INTO contract_documents VALUES(?,?,?,?,?,?,?,?)').run(id,'legacy-v1','Legacy terms',hash,'text','legacy.txt',bytes,1500);db.prepare('INSERT INTO active_contract VALUES(1,?)').run(id);
  db.exec(`CREATE TABLE contract_signatures(id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),contract_id TEXT NOT NULL REFERENCES contract_documents(id),contract_version TEXT NOT NULL,contract_hash TEXT NOT NULL,certificate_id TEXT NOT NULL REFERENCES certificates(id),legal_name TEXT NOT NULL,registered_name TEXT NOT NULL,email TEXT NOT NULL,consent_statement TEXT NOT NULL,signed_at INTEGER NOT NULL,UNIQUE(user_id,contract_id));`);
  db.prepare('INSERT INTO contract_signatures VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),1,id,'legacy-v1',hash,certificate.id,'Private Legal Name','Private Legacy Name','private-legacy@example.com',contractConsentStatement,2000);
  const original=db.prepare('SELECT * FROM contract_signatures').get();
  const contracts=createContracts(db);assert.equal(contracts.status(1).status,'signed');assert.equal(contracts.status(1).contract.scope,'global');assert.deepEqual(contracts.document(1,id).content,bytes);
  assert.deepEqual(db.prepare('SELECT * FROM contract_signatures').get(),original);assert.equal(db.prepare('PRAGMA table_info(contract_documents)').all().length,9);
  createContracts(db);assert.deepEqual(db.prepare('SELECT * FROM contract_signatures').get(),original);assert.equal(db.prepare('SELECT count(*) n FROM contract_documents').get().n,1);
 }finally{db.close();}
});

test('trusted-file and CLI publication carry the explicit recipient without changing the global agreement',async()=>{
 const folder=await mkdtemp(path.join(tmpdir(),'academy-private-contract-')),database=path.join(folder,'academy.sqlite');
 const {db,contracts}=fixture(database);try{
  const base=contracts.publish(document('global-v1')),filename=path.join(folder,'private.txt');await writeFile(filename,'Private recipient terms.',{mode:0o600});
  const direct=publishContractFile(contracts,{file:filename,version:'private-file-v1',recipientUserId:1});assert.equal(direct.recipientUserId,1);assert.equal(contracts.status(2).contract.id,base.id);
  const result=spawnSync(process.execPath,['contracts.mjs','publish','--database',database,'--file',filename,'--version','private-cli-v2','--recipient-user-id','1'],{cwd:path.resolve(import.meta.dirname,'..'),env:{NODE_NO_WARNINGS:'1'},encoding:'utf8',timeout:10000});
  assert.equal(result.status,0,result.stderr);const published=JSON.parse(result.stdout);assert.equal(published.scope,'personal');assert.equal(published.recipientUserId,1);assert.equal(contracts.status(1).contract.id,published.id);assert.equal(contracts.status(2).contract.id,base.id);
  const invalid=spawnSync(process.execPath,['contracts.mjs','publish','--database',database,'--file',filename,'--version','bad-cli','--recipient-user-id','1.5'],{cwd:path.resolve(import.meta.dirname,'..'),env:{NODE_NO_WARNINGS:'1'},encoding:'utf8',timeout:10000});assert.equal(invalid.status,1);assert.match(invalid.stderr,/positive registered user ID/);
 }finally{db.close();await rm(folder,{recursive:true,force:true});}
});
