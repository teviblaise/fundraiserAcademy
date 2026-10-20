import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { createDelivery } from '../delivery.mjs';

async function fixture(config = {APP_ORIGIN:'https://academy.example.com',EMAIL_FROM:'academy@example.com',RESEND_API_KEY:'test-only-never-sent'}) {
  const folder=await mkdtemp('/tmp/fa-security-mail-');
  const db=new DatabaseSync(folder+'/academy.sqlite');
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT); INSERT INTO users VALUES(1,'owner@example.com')");
  const sent=[];
  const delivery=createDelivery(db,folder+'/academy.sqlite',{autoFlush:false,config,sendEmail:async(job,payload)=>sent.push({target:job.target,payload})});
  db.prepare('INSERT INTO notification_preferences(user_id,email_enabled,verified) VALUES (1,0,1)').run();
  return {db,delivery,sent,async close(){delivery.close();db.close();await rm(folder,{recursive:true,force:true});}};
}

test('security notices are transactional, contain no factor secrets, and do not enable optional alerts',async()=>{
  const app=await fixture();
  try {
    for(const action of ['two-factor-enabled','two-factor-disabled','recovery-codes-regenerated','sessions-revoked'])assert.deepEqual(app.delivery.queueSecurityNotice(1,action),{status:'queued'});
    assert.equal(app.sent.length,0);
    assert.equal(app.delivery.status(1).emailEnabled,false);
    assert.equal(app.delivery.status(1).emailVerified,true);
    await app.delivery.flush();
    assert.equal(app.sent.length,4);
    for(const notice of app.sent){assert.equal(notice.target,'owner@example.com');assert.match(notice.payload.text,/https:\/\/academy\.example\.com\/security\.html/);assert.match(notice.payload.html,/FUNDRAISER ACADEMY/);assert.doesNotMatch(JSON.stringify(notice.payload),/otpauth:|#token=|"secret"|"recoveryCodes"/);}
    assert.equal(app.delivery.status(1).emailEnabled,false);
    assert.equal(app.delivery.status(1).emailVerified,true);
  } finally {await app.close();}
});

test('missing email configuration cannot block security changes or expose sender state to an account action',async()=>{
  const app=await fixture({});
  try {assert.deepEqual(app.delivery.queueSecurityNotice(1,'two-factor-enabled'),{status:'unavailable'});await app.delivery.flush();assert.equal(app.sent.length,0);assert.equal(app.db.prepare('SELECT count(*) n FROM notification_outbox').get().n,0);}finally{await app.close();}
});

test('security notice actions are allowlisted and remain atomic with the surrounding credential transaction',async()=>{
  const app=await fixture();
  try {
    assert.throws(()=>app.delivery.queueSecurityNotice(1,'<script>'),/Invalid/);
    app.db.exec('BEGIN');app.delivery.queueSecurityNotice(1,'recovery-codes-regenerated');app.db.exec('ROLLBACK');
    await app.delivery.flush();assert.equal(app.sent.length,0);assert.equal(app.db.prepare('SELECT count(*) n FROM notification_outbox').get().n,0);
  }finally{await app.close();}
});

test('an unconfirmed registration cannot send security notices to someone else’s mailbox',async()=>{
  const app=await fixture();
  try {
    app.db.prepare('UPDATE notification_preferences SET verified=0 WHERE user_id=1').run();
    assert.deepEqual(app.delivery.queueSecurityNotice(1,'sessions-revoked'),{status:'unverified'});
    await app.delivery.flush();
    assert.equal(app.sent.length,0);
    assert.equal(app.db.prepare('SELECT count(*) n FROM notification_outbox').get().n,0);
  }finally{await app.close();}
});
