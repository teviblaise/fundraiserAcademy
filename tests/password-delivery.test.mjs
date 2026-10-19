import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import webPush from 'web-push';
import { createDelivery } from '../delivery.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
async function setup({sendEmail,config}={}) {
  const directory=await mkdtemp(path.join(tmpdir(),'fa-password-email-'));
  const databasePath=path.join(directory,'test.sqlite');
  const db=new DatabaseSync(databasePath);
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT); INSERT INTO users VALUES (1,'client@example.com'),(2,'other@example.com'); CREATE TABLE password_resets(token TEXT PRIMARY KEY,user_id INTEGER NOT NULL,expires INTEGER NOT NULL,created_at INTEGER NOT NULL)");
  let clock=Date.now();
  const sent=[];
  const delivery=createDelivery(db,databasePath,{autoFlush:false,now:()=>clock,config:config??{APP_ORIGIN:'https://academy.example.com',EMAIL_FROM:'academy@example.com',RESEND_API_KEY:'test-only-no-network'},sendEmail:sendEmail??(async(job,payload)=>sent.push({job,payload}))});
  function queue(id=1,{token=randomBytes(32).toString('hex'),expiresAt=clock+20*60000}={}) {
    db.prepare('DELETE FROM password_resets WHERE user_id=?').run(id);
    const tokenHash=hash(token);
    db.prepare('INSERT INTO password_resets VALUES (?,?,?,?)').run(tokenHash,id,expiresAt,clock);
    return {token,expiresAt,result:delivery.queuePasswordReset(id,{token,digest:tokenHash,expiresAt})};
  }
  const jobs=channel=>db.prepare('SELECT * FROM notification_outbox WHERE channel=? ORDER BY id').all(channel??'password-reset');
  return {db,delivery,sent,queue,jobs,advance:milliseconds=>clock+=milliseconds,close:async()=>{delivery.close();db.close();await rm(directory,{recursive:true,force:true});}};
}

test('recovery email is queued without a provider request, contains a fragment link, and bypasses notification opt-in',async()=>{
  const fixture=await setup();
  try {
    const queued=fixture.queue();
    assert.deepEqual(queued.result,{status:'queued'});
    assert.equal(JSON.stringify(queued.result).includes(queued.token),false);
    assert.equal(fixture.sent.length,0);
    assert.equal(fixture.delivery.status(1).emailEnabled,false);
    assert.equal(fixture.delivery.status(1).emailVerified,false);
    assert.equal(fixture.jobs()[0].notice_key,`password-reset:${hash(queued.token)}`);
    assert.equal(fixture.db.prepare('SELECT token FROM password_resets').get().token,hash(queued.token));
    await fixture.delivery.flush();
    assert.equal(fixture.sent.length,1);
    assert.equal(fixture.sent[0].job.target,'client@example.com');
    assert.match(fixture.sent[0].payload.html,/FUNDRAISER ACADEMY/);
    assert.match(fixture.sent[0].payload.text,/20 minutes/);
    assert.equal(fixture.sent[0].payload.text.includes(`https://academy.example.com/reset-password.html#token=${queued.token}`),true);
    assert.equal(fixture.jobs()[0].status,'sent');
    assert.equal(fixture.jobs()[0].payload.includes(queued.token),false);
    assert.equal(fixture.delivery.status(1).emailVerified,false);
  } finally {await fixture.close();}
});

test('missing delivery configuration cannot queue reset links and never blocks a password-change notice call',async()=>{
  const fixture=await setup({config:{APP_ORIGIN:'https://academy.example.com'}});
  try {
    assert.throws(()=>fixture.queue(),/not configured/);
    assert.deepEqual(fixture.delivery.queuePasswordChanged(1),{status:'unavailable'});
    assert.equal(fixture.jobs().length,0);
    await fixture.delivery.flush();
    assert.equal(fixture.sent.length,0);
  } finally {await fixture.close();}
});

test('reset delivery requires a matching active hashed token and escapes HTML links',async()=>{
  const fixture=await setup({config:{APP_ORIGIN:"https://academy'.example.com",EMAIL_FROM:'academy@example.com',RESEND_API_KEY:'test-only-no-network'}});
  try {
    const token='a'.repeat(64),expiresAt=Date.now()+20*60000;
    assert.throws(()=>fixture.delivery.queuePasswordReset(1,{token,digest:'b'.repeat(64),expiresAt}),/Invalid/);
    assert.throws(()=>fixture.delivery.queuePasswordReset(1,{token,digest:hash(token),expiresAt}),/Invalid/);
    fixture.queue();
    await fixture.delivery.flush();
    assert.match(fixture.sent[0].payload.html,/https:\/\/academy&#39;\.example\.com\/reset-password\.html#token=/);
    assert.equal(fixture.sent[0].payload.html.includes("href=\"https://academy'.example.com"),false);
  } finally {await fixture.close();}
});

test('requesting a replacement cancels and scrubs obsolete reset links before any send',async()=>{
  const fixture=await setup();
  try {
    const previous=fixture.queue();
    const current=fixture.queue();
    assert.equal(fixture.jobs()[0].status,'cancelled');
    assert.equal(fixture.jobs()[0].payload.includes(previous.token),false);
    await fixture.delivery.flush();
    assert.equal(fixture.sent.length,1);
    assert.equal(fixture.sent[0].payload.text.includes(current.token),true);
    assert.equal(fixture.sent[0].payload.text.includes(previous.token),false);
  } finally {await fixture.close();}
});

test('expired links are scrubbed before delivery, even if their retry is not due',async()=>{
  const fixture=await setup();
  try {
    const queued=fixture.queue();
    fixture.db.prepare('UPDATE notification_outbox SET next_at=?').run(queued.expiresAt+3600000);
    fixture.advance(20*60000);
    await fixture.delivery.flush();
    assert.equal(fixture.sent.length,0);
    assert.equal(fixture.jobs()[0].status,'cancelled');
    assert.equal(fixture.jobs()[0].payload.includes(queued.token),false);
  } finally {await fixture.close();}
});

test('reset success cancels and scrubs a reset link during an in-flight provider send',async()=>{
  let started,release;
  const sending=new Promise(resolve=>started=resolve);
  const pending=new Promise(resolve=>release=resolve);
  const fixture=await setup({sendEmail:async()=>{started();await pending;}});
  try {
    const queued=fixture.queue();
    const flushing=fixture.delivery.flush();
    await sending;
    fixture.db.prepare('DELETE FROM password_resets WHERE user_id=1').run();
    fixture.delivery.cancelPasswordResets(1);
    release();await flushing;
    assert.equal(fixture.jobs()[0].status,'cancelled');
    assert.equal(fixture.jobs()[0].payload.includes(queued.token),false);
  } finally {release();await fixture.close();}
});

test('failed providers retry without leaking links, then scrub raw tokens on final failure',async()=>{
  let attempts=0;
  const logged=[],originalError=console.error;
  const fixture=await setup({sendEmail:async(job,payload)=>{attempts++;const error=new Error(`Do not log a private provider body: ${payload.text}`);error.statusCode=503;throw error;}});
  try {
    console.error=message=>logged.push(message);
    const queued=fixture.queue();
    for(let attempt=1;attempt<=5;attempt++) {
      await fixture.delivery.flush();
      assert.equal(attempts,attempt);
      if(attempt<5) {
        assert.equal(fixture.jobs()[0].status,'pending');
        fixture.advance(60000*2**(attempt-1));
      }
    }
    assert.equal(fixture.jobs()[0].status,'failed');
    assert.equal(fixture.jobs()[0].payload.includes(queued.token),false);
    assert.equal(logged.length,5);
    assert.equal(logged.some(message=>message.includes(queued.token)),false);
    assert.equal(logged.some(message=>message.includes('client@example.com')),false);
  } finally {console.error=originalError;await fixture.close();}
});

test('a cancelled second job in an already selected batch is never delivered',async()=>{
  let started,release,sends=0;
  const sending=new Promise(resolve=>started=resolve);
  const pending=new Promise(resolve=>release=resolve);
  const fixture=await setup({sendEmail:async()=>{sends++;started();await pending;}});
  try {
    fixture.delivery.queuePasswordChanged(1);
    const queued=fixture.queue();
    const flushing=fixture.delivery.flush();
    await sending;
    fixture.delivery.cancelPasswordResets(1);
    release();await flushing;
    assert.equal(sends,1);
    assert.equal(fixture.jobs()[0].status,'cancelled');
    assert.equal(fixture.jobs()[0].payload.includes(queued.token),false);
  } finally {release();await fixture.close();}
});

test('password-change security emails are transactional and contain no credential or recovery token',async()=>{
  const fixture=await setup();
  try {
    assert.deepEqual(fixture.delivery.queuePasswordChanged(1),{status:'queued'});
    assert.equal(fixture.sent.length,0);
    await fixture.delivery.flush();
    assert.equal(fixture.sent.length,1);
    const notice=fixture.sent[0];
    assert.equal(notice.job.channel,'password-changed');
    assert.match(notice.payload.text,/All existing sign-ins/);
    assert.match(notice.payload.text,/If you did not make this change/);
    assert.match(notice.payload.html,/login\.html/);
    assert.doesNotMatch(JSON.stringify(notice.payload),/#token=|password=|scrypt|salt/i);
    assert.equal(fixture.delivery.status(1).emailEnabled,false);
  } finally {await fixture.close();}
});

test('reset device revocation removes subscriptions and cancels queued private push notifications',async()=>{
  const fixture=await setup();
  try {
    fixture.delivery.subscribe(1,{endpoint:'https://fcm.googleapis.com/test-only-device',keys:{p256dh:webPush.generateVAPIDKeys().publicKey,auth:Buffer.alloc(16,1).toString('base64url')}});
    fixture.delivery.enqueue(1,{notificationEpoch:'test-epoch'},[{id:1,title:'Private trade',text:'Private account detail'}]);
    fixture.db.prepare("UPDATE notification_outbox SET status='sending' WHERE channel='push'").run();
    fixture.delivery.revokeDeviceNotifications(1);
    assert.equal(fixture.delivery.status(1).pushSubscriptions,0);
    assert.equal(fixture.jobs('push')[0].status,'cancelled');
    assert.equal(fixture.jobs('push')[0].payload,'{}');
  } finally {await fixture.close();}
});
