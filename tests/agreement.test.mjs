import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createContracts} from '../contracts.mjs';
import {createCertificates} from '../certificates.mjs';
import {createAccount} from '../public/simulator.js';
import {PROVIDED_AGREEMENT_VERSION,providedAgreement,installProvidedAgreement} from '../agreement.mjs';

function fixture(){
  const db=new DatabaseSync(':memory:');
  db.exec(`PRAGMA foreign_keys=ON;
    CREATE TABLE users(id INTEGER PRIMARY KEY,name TEXT NOT NULL,email TEXT NOT NULL);
    CREATE TABLE events(id INTEGER PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),kind TEXT NOT NULL,detail TEXT NOT NULL,created_at INTEGER NOT NULL);
    INSERT INTO users VALUES(1,'Qualified Fixture Trader','fixture@example.com');`);
  const certificates=createCertificates(db),contracts=createContracts(db);
  const state=createAccount();state.balance=11000;state.positions=[];state.locked='Profit target achieved';state.tradingDays=['2026-10-19','2026-10-20','2026-10-21'];
  certificates.issue(1,state,1000);
  return{db,contracts};
}
const signature=contract=>({contractId:contract.id,contractVersion:contract.version,contractHash:contract.hash,legalName:'Qualified Fixture Trader',consent:true});
const publishOther=(contracts,version,now=1000)=>contracts.publish({version,now,title:'Other provided terms',format:'text',content:Buffer.from('Other company-provided terms for an isolated test.')});

test('the provided private section preserves the approved ten clauses, tier thresholds, and exact document bytes',()=>{
  const content=readFileSync(new URL('../agreements/progressive-profit-sharing-v1.txt',import.meta.url)),text=content.toString('utf8');
  assert.equal(PROVIDED_AGREEMENT_VERSION,'progressive-profit-sharing-v1');
  assert.equal(providedAgreement.title,'Progressive Profit Sharing and Tier Retention');
  assert.equal(createHash('sha256').update(content).digest('hex'),'ddce9cf22a2c0e298f8e9609d9697026c035bb53a02f34c58e6a0ecef6a31ae3');
  assert.equal(providedAgreement.hash,'ddce9cf22a2c0e298f8e9609d9697026c035bb53a02f34c58e6a0ecef6a31ae3');
  assert.deepEqual([...text.matchAll(/^(\d+)\. ([^\n]+)$/gm)].map(match=>[Number(match[1]),match[2]]),[
    [1,'Initial Profit-Sharing Arrangement'],[2,'Progressive Profit-Sharing Structure'],[3,'Tier Advancement'],
    [4,'Permanent Tier Retention Across Sponsored Accounts'],[5,'Maximum Profit-Sharing Tier'],
    [6,'Sponsorship Costs and Trading Losses'],[7,'Payout Processing'],[8,'Account Compliance'],
    [9,'Termination and Reinstatement'],[10,'Amendments']
  ]);
  assert.match(text,/\| Below \$10,000\s+\| 50%\s+\| 50%/);
  assert.match(text,/\| \$10,000 to below \$25,000\s+\| 60%\s+\| 40%/);
  assert.match(text,/\| \$25,000 and above\s+\| 70%\s+\| 30%/);
  assert.ok(Object.isFrozen(providedAgreement));
});

test('installing the company section requires new explicit consent and preserves earlier signed bytes and entitlements evidence',()=>{
  const {db,contracts}=fixture();try{
    const old=publishOther(contracts,'previous-agreement');contracts.sign(1,signature(old),1500);
    const oldSignature=db.prepare('SELECT * FROM contract_signatures WHERE user_id=1').get();
    const oldDocument=db.prepare('SELECT * FROM contract_documents WHERE id=?').get(old.id);
    const result=installProvidedAgreement(contracts,{now:2000});
    assert.equal(result.active,true);assert.equal(result.reused,false);assert.equal(result.publishedAt,2000);
    assert.equal(result.hash,providedAgreement.hash);assert.equal(result.version,PROVIDED_AGREEMENT_VERSION);
    const status=contracts.status(1);assert.equal(status.status,'signature_required');assert.equal(status.signature,null);assert.equal(status.history.length,1);
    assert.equal(status.canProceedToFundingReview,false);assert.equal(db.prepare('SELECT count(*) n FROM contract_signatures').get().n,1);
    assert.deepEqual(db.prepare('SELECT * FROM contract_signatures WHERE id=?').get(oldSignature.id),oldSignature);
    assert.deepEqual(db.prepare('SELECT * FROM contract_documents WHERE id=?').get(old.id),oldDocument);
    assert.deepEqual(contracts.document(1,result.id).content,readFileSync(new URL('../agreements/progressive-profit-sharing-v1.txt',import.meta.url)));
    const signed=contracts.sign(1,signature(result),2500);assert.equal(signed.status,'signed');assert.equal(signed.history.length,2);
    const repeated=installProvidedAgreement(contracts,{now:3000});assert.equal(repeated.id,result.id);assert.equal(repeated.reused,true);assert.equal(repeated.publishedAt,2000);
    assert.equal(db.prepare('SELECT count(*) n FROM contract_documents').get().n,2);
    assert.equal(db.prepare('SELECT count(*) n FROM contract_signatures').get().n,2);
    assert.equal(db.prepare('SELECT count(*) n FROM contract_publication_events').get().n,2);
  }finally{db.close();}
});

test('startup installation cannot reactivate the provided section after a newer agreement is published',()=>{
  const {db,contracts}=fixture();try{
    const provided=installProvidedAgreement(contracts,{now:2000});contracts.sign(1,signature(provided),2500);
    const later=publishOther(contracts,'later-written-amendment',3000);
    const repeated=installProvidedAgreement(contracts,{now:4000});assert.equal(repeated.id,provided.id);assert.equal(repeated.active,false);
    assert.equal(contracts.status(1).contract.id,later.id);assert.equal(contracts.status(1).status,'signature_required');
    assert.deepEqual(contracts.document(1,provided.id).content,readFileSync(new URL('../agreements/progressive-profit-sharing-v1.txt',import.meta.url)));
    assert.equal(db.prepare('SELECT count(*) n FROM contract_signatures').get().n,1);
  }finally{db.close();}
});

test('conflicting bytes under the provided version fail closed rather than replace or activate a different legal section',()=>{
  const {db,contracts}=fixture();try{
    const conflict=publishOther(contracts,PROVIDED_AGREEMENT_VERSION,1000);
    assert.throws(()=>installProvidedAgreement(contracts,{now:2000}),error=>error.status===409);
    assert.equal(contracts.status(1).contract.id,conflict.id);
    assert.equal(db.prepare('SELECT count(*) n FROM contract_documents').get().n,1);
    assert.equal(db.prepare('SELECT count(*) n FROM contract_signatures').get().n,0);
  }finally{db.close();}
});
