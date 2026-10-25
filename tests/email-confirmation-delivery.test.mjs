import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createHash } from 'node:crypto';
import { createDelivery } from '../delivery.mjs';

async function setup({sendEmail,legacy=false}={}) {
  const directory=await mkdtemp(path.join(tmpdir(),'fa-confirm-email-'));
  const databasePath=path.join(directory,'test.sqlite');
  const db=new DatabaseSync(databasePath);
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT);INSERT INTO users VALUES(1,'client@example.com'),(2,'other@example.com')");
  if(legacy) db.exec('CREATE TABLE email_verifications(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires INTEGER NOT NULL)');
  let clock=Date.now();
  const sent=[];
  const delivery=createDelivery(db,databasePath,{autoFlush:false,now:()=>clock,config:{APP_ORIGIN:'https://academy.example.com',EMAIL_FROM:'academy@example.com',RESEND_API_KEY:'test-only-no-network'},sendEmail:sendEmail??(async(job,payload)=>sent.push({job,payload}))});
  const jobs=()=>db.prepare("SELECT * FROM notification_outbox WHERE channel='verify' ORDER BY id").all();
  const token=()=>/token=([a-f0-9]{64})/.exec(JSON.parse(jobs().at(-1).payload).text)[1];
  return {db,delivery,sent,jobs,token,advance:milliseconds=>clock+=milliseconds,close:async()=>{delivery.close();db.close();await rm(directory,{recursive:true,force:true});}};
}

test('signup confirmation proves ownership without opting into notifications or exposing its token',async()=>{
  const fixture=await setup();
  try {
    const queued=await fixture.delivery.requestVerification(1,{purpose:'account'});
    const token=fixture.token();
    assert.equal(queued.status,'queued');
    assert.equal(queued.cooldownUntil,queued.expiresAt-29*60000);
    assert.equal(JSON.stringify(queued).includes(token),false);
    assert.equal(fixture.delivery.status(1).emailVerified,false);
    assert.equal(fixture.delivery.status(1).verificationStatus,'pending');
    const stored=fixture.db.prepare('SELECT * FROM email_verifications').get();
    assert.equal(stored.token,createHash('sha256').update(token).digest('hex'));
    assert.equal(stored.purpose,'account');
    await fixture.delivery.flush();
    assert.equal(fixture.sent.length,1);
    assert.match(fixture.sent[0].payload.text,/Welcome to Fundraiser Academy/);
    assert.match(fixture.sent[0].payload.html,/FUNDRAISER ACADEMY/);
    assert.equal(fixture.sent[0].payload.html.includes(token),true);
    assert.equal(fixture.delivery.status(1).verificationStatus,'sent');
    assert.equal(fixture.delivery.verify(token),1);
    assert.equal(fixture.delivery.status(1).emailVerified,true);
    assert.equal(fixture.delivery.status(1).emailEnabled,false);
    assert.equal(fixture.delivery.status(2).emailVerified,false);
    assert.throws(()=>fixture.delivery.verify(token),/expired or was already used/);
    assert.equal(fixture.jobs().some(job=>job.payload.includes(token)),false);
  } finally {await fixture.close();}
});

test('account confirmations preserve existing opt-in while notification confirmations explicitly enable it',async()=>{
  const fixture=await setup();
  try {
    fixture.db.prepare('INSERT INTO notification_preferences VALUES (1,1,0)').run();
    await fixture.delivery.requestVerification(1,{purpose:'account'});
    fixture.delivery.verify(fixture.token());
    assert.equal(fixture.delivery.status(1).emailEnabled,true);
    await fixture.delivery.requestVerification(2,{purpose:'notifications'});
    const token=fixture.token();
    fixture.delivery.verify(token);
    assert.equal(fixture.delivery.status(2).emailEnabled,true);
    assert.equal(fixture.delivery.status(2).emailVerified,true);
    assert.equal(fixture.jobs().at(-1).status,'cancelled');
    assert.equal(fixture.jobs().at(-1).payload.includes(token),false);
    await fixture.delivery.flush();
    assert.equal(fixture.sent.length,0);
  } finally {await fixture.close();}
});

test('resending enforces cooldown, cancels and scrubs previous links, and sends only the newest token',async()=>{
  const fixture=await setup();
  try {
    await fixture.delivery.requestVerification(1,{purpose:'account'});
    const previous=fixture.token();
    await assert.rejects(fixture.delivery.requestVerification(1,{purpose:'account'}),/wait one minute/);
    fixture.advance(60000);
    await fixture.delivery.requestVerification(1,{purpose:'account'});
    const current=fixture.token();
    assert.notEqual(current,previous);
    assert.throws(()=>fixture.delivery.verify(previous),/expired or was already used/);
    const oldJob=fixture.jobs()[0];
    assert.equal(oldJob.status,'cancelled');
    assert.equal(oldJob.payload.includes(previous),false);
    await fixture.delivery.flush();
    assert.equal(fixture.sent.length,1);
    assert.equal(fixture.sent[0].payload.text.includes(current),true);
    assert.equal(fixture.delivery.verify(current),1);
  } finally {await fixture.close();}
});

test('expired queued confirmations are cancelled and their raw links scrubbed before provider delivery',async()=>{
  const fixture=await setup();
  try {
    await fixture.delivery.requestVerification(1,{purpose:'account'});
    const token=fixture.token();
    fixture.advance(30*60000);
    await fixture.delivery.flush();
    assert.equal(fixture.sent.length,0);
    assert.equal(fixture.jobs()[0].status,'cancelled');
    assert.equal(fixture.jobs()[0].payload.includes(token),false);
    assert.throws(()=>fixture.delivery.verify(token),/expired/);
    assert.equal(fixture.delivery.status(1).emailVerified,false);
    assert.equal(fixture.delivery.status(1).verificationStatus,null);
  } finally {await fixture.close();}
});

test('resending during an in-flight send never resurrects its cancelled job or old token',async()=>{
  let started,release;
  const isSending=new Promise(resolve=>started=resolve);
  const finishSend=new Promise(resolve=>release=resolve);
  const fixture=await setup({sendEmail:async()=>{started();await finishSend;}});
  try {
    await fixture.delivery.requestVerification(1,{purpose:'account'});
    const oldToken=fixture.token();
    const flushing=fixture.delivery.flush();
    await isSending;
    fixture.advance(60000);
    await fixture.delivery.requestVerification(1,{purpose:'account'});
    release();await flushing;
    assert.equal(fixture.jobs()[0].status,'cancelled');
    assert.equal(fixture.jobs()[0].payload.includes(oldToken),false);
    // Newly queued authentication mail is prioritized during the same flush.
    assert.equal(fixture.jobs()[1].status,'sent');
    assert.throws(()=>fixture.delivery.verify(oldToken),/expired/);
  } finally {release();await fixture.close();}
});

test('provider failures remain queued for retry, but expiry cancels a retry before another send',async()=>{
  let attempts=0;
  const fixture=await setup({sendEmail:async()=>{attempts++;const error=new Error('Provider unavailable');error.statusCode=503;throw error;}});
  try {
    await fixture.delivery.requestVerification(1,{purpose:'account'});
    const token=fixture.token();
    await fixture.delivery.flush();
    assert.equal(attempts,1);
    assert.equal(fixture.jobs()[0].status,'pending');
    assert.equal(fixture.jobs()[0].attempts,1);
    assert.equal(fixture.delivery.status(1).verificationStatus,'pending');
    assert.equal(fixture.delivery.status(1).emailVerified,false);
    fixture.advance(30*60000);
    await fixture.delivery.flush();
    assert.equal(attempts,1);
    assert.equal(fixture.jobs()[0].status,'cancelled');
    assert.equal(fixture.jobs()[0].payload.includes(token),false);
  } finally {await fixture.close();}
});

test('legacy token migration retains the explicitly requested notification purpose',async()=>{
  const fixture=await setup({legacy:true});
  try {
    const token='a'.repeat(64);
    const hash=createHash('sha256').update(token).digest('hex');
    fixture.db.prepare('INSERT INTO email_verifications(token,user_id,expires) VALUES (?,?,?)').run(hash,1,Date.now()+60000);
    assert.equal(fixture.db.prepare('SELECT purpose FROM email_verifications').get().purpose,'notifications');
    assert.equal(fixture.delivery.verify(token),1);
    assert.equal(fixture.delivery.status(1).emailEnabled,true);
  } finally {await fixture.close();}
});

test('confirmation page removes the fragment immediately and verifies only after an explicit click',async()=>{
  const token='b'.repeat(64),historyWrites=[],requests=[];
  let submit;
  const button={disabled:false};
  const form={hidden:false,querySelector:()=>button,addEventListener:(name,handler)=>{if(name==='submit')submit=handler;}};
  const status={textContent:''};
  const context={URLSearchParams,location:{hash:`#token=${token}`,pathname:'/verify-email.html',search:''},history:{replaceState:(state,title,url)=>historyWrites.push(url)},document:{getElementById:id=>id==='verify-email-form'?form:status},fetch:async(url,options)=>{requests.push({url,options});return {ok:true,json:async()=>({message:'Your email address is confirmed.'})};}};
  vm.runInNewContext(await readFile(new URL('../public/verify-email.js',import.meta.url),'utf8'),context);
  assert.deepEqual(historyWrites,['/verify-email.html']);
  assert.equal(requests.length,0);
  await submit({preventDefault(){}});
  assert.equal(requests.length,1);
  assert.equal(requests[0].options.method,'POST');
  assert.equal(JSON.parse(requests[0].options.body).token,token);
  assert.equal(form.hidden,true);
  assert.match(status.textContent,/address is confirmed/);
});
