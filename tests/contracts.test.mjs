import { testDeliveryOptions, confirmRegistration } from './helpers/email-fixture.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { createContracts, publishContractFile, contractConsentStatement } from '../contracts.mjs';
import { createCertificates } from '../certificates.mjs';
import { createAccount } from '../public/simulator.js';
import { createBackend } from '../backend.mjs';

function fixture(database=':memory:') {
  const db=new DatabaseSync(database);
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL);
    CREATE TABLE events(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);
    INSERT INTO users VALUES (1,'Registered Name','qualified@example.com'),(2,'Second Trader','other@example.com');`);
  const certificates=createCertificates(db);
  const contracts=createContracts(db);
  function qualify(id=1) {
    const state=createAccount();state.balance=11000;state.positions=[];state.locked='Profit target achieved';state.tradingDays=['2026-10-09','2026-10-10','2026-10-11'];
    return certificates.issue(id,state);
  }
  return {db,certificates,contracts,qualify};
}
const terms=Buffer.from('Contract terms supplied by the academy operator for testing.');
const publication=(version='v1')=>({content:terms,format:'text',version,title:'Trader agreement'});
const signature=(contract,extra={})=>({contractId:contract.id,contractVersion:contract.version,contractHash:contract.hash,legalName:'Legal Full Name',consent:true,...extra});

test('contract qualification is server certificate based, signing binds exact document, and mandatory versions retain history', () => {
  const {db,contracts,qualify,certificates}=fixture();
  try {
    assert.equal(contracts.status(1).status,'assessment_required');
    assert.equal(contracts.status(1).contract,null);
    assert.throws(()=>contracts.sign(1,{}),error=>error.status===403);
    const certificate=qualify();
    assert.equal(contracts.status(1).status,'awaiting_contract');
    assert.throws(()=>contracts.sign(1,{}),error=>error.status===409);
    const first=contracts.publish(publication());
    const ready=contracts.status(1);
    assert.equal(ready.status,'signature_required');assert.equal(ready.canProceedToFundingReview,false);assert.equal(ready.fundingApproved,false);
    assert.equal(ready.assessment.certificateId,certificate.id);
    assert.equal(contracts.status(2).contract,null);
    assert.throws(()=>contracts.document(2,first.id),error=>error.status===403);
    for(const tamper of [{contractId:'incorrect'},{contractVersion:'v2'},{contractHash:'0'.repeat(64)}]) assert.throws(()=>contracts.sign(1,signature(first,tamper)),error=>error.status===409);
    assert.throws(()=>contracts.sign(1,signature(first,{consent:false})),error=>error.status===400);
    assert.throws(()=>contracts.sign(1,signature(first,{legalName:''})),error=>error.status===400);
    assert.throws(()=>contracts.sign(1,signature(first,{legalName:'Legal\nName'})),error=>error.status===400);
    certificates.setPreferences(1,{mode:'nickname',nickname:'Trader Nickname'});
    const signed=contracts.sign(1,signature(first));
    assert.equal(signed.status,'signed');assert.equal(signed.signature.legalName,'Legal Full Name');
    assert.equal(signed.signature.consentStatement,contractConsentStatement);
    assert.equal(signed.canProceedToFundingReview,true);assert.equal(signed.fundingApproved,false);
    assert.deepEqual(contracts.document(1,first.id).content,terms);
    assert.equal(contracts.sign(1,signature(first)).signature.id,signed.signature.id);
    assert.equal(db.prepare('SELECT count(*) AS n FROM contract_signatures').get().n,1);
    assert.equal(db.prepare("SELECT count(*) AS n FROM events WHERE kind='contract-signed'").get().n,1);
    assert.throws(()=>contracts.sign(1,signature(first,{legalName:'Different Legal Name'})),error=>error.status===409);
    const second=contracts.publish({...publication('v2'),content:Buffer.from('Updated operator-provided terms.')});
    assert.equal(contracts.status(1).status,'signature_required');assert.equal(contracts.status(1).history.length,1);
    assert.throws(()=>contracts.sign(1,signature(first)),error=>error.status===409);
    assert.equal(contracts.publish(publication()).active,false,'an old startup configuration cannot reactivate a superseded version');
    assert.equal(contracts.status(1).contract.id,second.id);
    assert.deepEqual(contracts.document(1,first.id).content,terms,'the signer retains access to the exact old document');
    qualify(2);
    assert.throws(()=>contracts.document(2,first.id),error=>error.status===404,'other qualified users cannot retrieve retired unsigned documents');
    const renewed=contracts.sign(1,signature(second));
    assert.equal(renewed.status,'signed');assert.equal(renewed.history.length,2);
    assert.throws(()=>db.prepare('UPDATE contract_documents SET content=? WHERE id=?').run(Buffer.from('tampered'),first.id),/immutable/);
    assert.throws(()=>db.prepare('DELETE FROM contract_signatures WHERE user_id=1').run(),/immutable/);
  } finally {db.close();}
});

test('operator publications validate document format, preserve immutable versions, and persist after restart', async () => {
  const folder=await mkdtemp(path.join(tmpdir(),'fa-contracts-'));
  const database=path.join(folder,'academy.sqlite');
  let db;
  let publicFolder;
  try {
    let setup=fixture(database);db=setup.db;
    const {contracts,qualify}=setup;qualify();
    for(const invalid of [
      {...publication(),content:Buffer.alloc(0)},
      {...publication(),content:Buffer.from('<html>'),format:'pdf'},
      {...publication(),content:Buffer.from([0xff])},
      {...publication(),version:'unsafe version'},
      {...publication(),content:Buffer.from('bad\u0000text')}
    ])assert.throws(()=>contracts.publish(invalid),error=>error.status===400);
    const contract=contracts.publish(publication());
    assert.equal(contracts.publish(publication()).id,contract.id);
    assert.throws(()=>contracts.publish({...publication(),content:Buffer.from('Different terms')}),error=>error.status===409);
    const signed=contracts.sign(1,signature(contract));
    db.close();db=new DatabaseSync(database);
    const restarted=createContracts(db);
    assert.equal(restarted.status(1).status,'signed');
    assert.equal(restarted.status(1).signature.id,signed.signature.id);
    assert.deepEqual(restarted.document(1,contract.id).content,terms);
    const file=path.join(folder,'provided-contract.pdf');
    const pdf=Buffer.from('%PDF-1.4\noperator provided test bytes\n%%EOF');await writeFile(file,pdf);
    publicFolder=await mkdtemp(path.join(path.resolve(import.meta.dirname,'../public'),'contract-boundary-test-'));
    const publicLink=path.join(publicFolder,'linked.pdf');await symlink(file,publicLink);
    assert.throws(()=>publishContractFile(restarted,{file:publicLink,version:'public-link'}),/outside public/);
    const published=publishContractFile(restarted,{file,version:'pdf-v1',title:'Provided PDF'});
    assert.equal(published.format,'pdf');assert.equal(published.fileName,'provided-contract.pdf');
    assert.deepEqual(restarted.document(1,published.id).content,pdf);
    const cli=spawnSync(process.execPath,['contracts.mjs','publish','--database',database,'--file',file,'--version','pdf-v2','--title','Provided PDF'],{cwd:path.resolve(import.meta.dirname,'..'),encoding:'utf8'});
    assert.equal(cli.status,0,cli.stderr);assert.equal(JSON.parse(cli.stdout).version,'pdf-v2');
    assert.equal(restarted.status(1).contract.version,'pdf-v2');
  } finally {db?.close();if(publicFolder)await rm(publicFolder,{recursive:true,force:true});await rm(folder,{recursive:true,force:true});}
});

test('contract HTTP endpoints enforce login, qualification, consent, exact version, and durable signatures after practice reset', async () => {
  const folder=await mkdtemp(path.join(tmpdir(),'fa-contract-api-'));
  const database=path.join(folder,'academy.sqlite');
  let backend=createBackend(database,{autoTick:false,deliveryOptions:testDeliveryOptions});
  const server=http.createServer((req,res)=>backend.handle(req,res,new URL(req.url,'http://localhost').pathname));
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const origin=`http://127.0.0.1:${server.address().port}`;
  async function request(endpoint,data,cookie,extra={}) {
    const response=await fetch(origin+endpoint,{method:data===undefined?'GET':'POST',headers:{'Content-Type':'application/json','X-Requested-With':'FundraiserAcademy',...(cookie?{Cookie:cookie}:{}),...extra},...(data===undefined?{}:{body:JSON.stringify(data)})});
    return {status:response.status,body:await response.json(),cookie:response.headers.get('set-cookie')?.split(';')[0]};
  }
  let privateDb;
  try {
    const first=await request('/api/register',{name:'Legal Trader',email:'contract-trader@example.com',password:'a-long-test-password-contract',market:'I trade forex',consent:true});
    const second=await request('/api/register',{name:'Other Trader',email:'contract-other@example.com',password:'a-long-test-password-contract',market:'I trade forex',consent:true});
    await confirmRegistration(database,request,first);
    await confirmRegistration(database,request,second);
    assert.equal((await request('/api/contract')).status,401);
    assert.equal((await request('/api/contract',undefined,first.cookie)).body.status,'assessment_required');
    privateDb=new DatabaseSync(database);
    const contracts=createContracts(privateDb);
    const published=contracts.publish(publication());
    assert.equal((await request('/api/contract/sign',signature(published,{assessmentPassed:true,balance:11000}),first.cookie)).status,403);
    assert.equal((await fetch(origin+published.documentUrl)).status,401);
    assert.equal((await fetch(origin+published.documentUrl,{headers:{Cookie:first.cookie}})).status,403);
    const state=JSON.parse(privateDb.prepare('SELECT state FROM accounts WHERE user_id=?').get(first.body.user.id).state);
    state.balance=11000;state.positions=[];state.locked='Profit target achieved';state.tradingDays=['2026-10-09','2026-10-10','2026-10-11'];
    privateDb.prepare('UPDATE accounts SET state=? WHERE user_id=?').run(JSON.stringify(state),first.body.user.id);
    await backend.close();backend=createBackend(database,{autoTick:false,deliveryOptions:testDeliveryOptions});
    const ready=await request('/api/contract',undefined,first.cookie);
    assert.equal(ready.body.status,'signature_required');
    const document=await fetch(origin+published.documentUrl,{headers:{Cookie:first.cookie}});
    assert.equal(document.status,200);assert.match(document.headers.get('content-type'),/^text\/plain/);assert.equal(document.headers.get('cache-control'),'no-store');assert.equal(document.headers.get('x-contract-sha256'),published.hash);assert.equal(await document.text(),terms.toString());
    assert.equal((await request('/api/contract/sign',signature(published),first.cookie,{Origin:'https://untrusted.example'})).status,403);
    assert.equal((await request('/api/contract/sign',signature(published,{consent:false}),first.cookie)).status,400);
    assert.equal((await request('/api/contract/sign',signature(published,{contractHash:'bad'}),first.cookie)).status,409);
    const signed=await request('/api/contract/sign',signature(published),first.cookie);
    assert.equal(signed.status,200);assert.equal(signed.body.status,'signed');
    assert.equal((await request('/api/contract/sign',signature(published),second.cookie)).status,403);
    await request('/api/account/reset',{},first.cookie);
    await backend.close();backend=createBackend(database,{autoTick:false,deliveryOptions:testDeliveryOptions});
    const afterReset=await request('/api/contract',undefined,first.cookie);
    assert.equal(afterReset.body.status,'signed');assert.equal(afterReset.body.signature.id,signed.body.signature.id);
    assert.equal(afterReset.body.fundingApproved,false);
    assert.equal((await request('/api/contract',undefined,second.cookie)).body.history.length,0);
    contracts.publish({...publication('v2'),content:Buffer.from('Updated terms supplied by operator')});
    assert.equal((await request('/api/contract',undefined,first.cookie)).body.status,'signature_required');
    assert.equal((await request('/api/contract/sign',signature(published),first.cookie)).status,409);
  } finally {await new Promise(resolve=>server.close(resolve));await backend.close();privateDb?.close();await rm(folder,{recursive:true,force:true});}
});
