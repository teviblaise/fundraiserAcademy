import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import webPush from 'web-push';
import {createHash} from 'node:crypto';
import {createDelivery,validateSubscription} from '../delivery.mjs';

async function setup(options={}) {
  const directory=await mkdtemp(path.join(tmpdir(),'fa-delivery-security-'));
  const databasePath=path.join(directory,'test.sqlite');
  const db=new DatabaseSync(databasePath);
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT);INSERT INTO users VALUES(1,'one@example.invalid'),(2,'two@example.invalid');CREATE TABLE password_resets(token TEXT PRIMARY KEY,user_id INTEGER,expires INTEGER)");
  let clock=Date.now();const sent=[];
  const config={APP_ORIGIN:'https://academy.example.invalid',EMAIL_FROM:'test@example.invalid',RESEND_API_KEY:'test-only-never-sent'};
  const settings={autoFlush:false,config,now:()=>clock,sendEmail:async job=>sent.push(job.channel),sendPush:async subscription=>sent.push(subscription.endpoint),...options};
  let delivery=createDelivery(db,databasePath,settings);
  const key=webPush.generateVAPIDKeys().publicKey;
  const subscription=id=>({endpoint:`https://fcm.googleapis.com/local-test-${String(id).padStart(3,'0')}`,keys:{p256dh:key,auth:Buffer.alloc(16,1).toString('base64url')}});
  const notices=count=>Array.from({length:count},(_,id)=>({id:id+1,title:'Local test',text:'No network request.',createdAt:clock}));
  return {db,get delivery(){return delivery;},sent,subscription,notices,advance:ms=>clock+=ms,
    restart(){delivery.close();delivery=createDelivery(db,databasePath,settings);},
    async close(){delivery.close();db.close();await rm(directory,{recursive:true,force:true});}};
}

test('push device cap allows refresh and rejects a transfer before changing its owner or cancelling their queue',async()=>{
  const app=await setup();
  try {
    for(let id=0;id<10;id++)app.delivery.subscribe(1,app.subscription(id));
    app.delivery.subscribe(1,app.subscription(0));
    app.delivery.subscribe(2,app.subscription(20));
    app.delivery.enqueue(2,{notificationEpoch:'owner'},app.notices(1));
    assert.throws(()=>app.delivery.subscribe(1,app.subscription(20)),/10 devices/);
    assert.throws(()=>app.delivery.subscribe(1,app.subscription(21)),/10 devices/);
    assert.equal(app.delivery.status(1).pushSubscriptions,10);
    assert.equal(app.db.prepare('SELECT user_id FROM push_subscriptions WHERE endpoint=?').get(app.subscription(20).endpoint).user_id,2);
    assert.equal(app.db.prepare("SELECT status FROM notification_outbox WHERE user_id=2").get().status,'pending');
    app.delivery.unsubscribe(1,app.subscription(0).endpoint);
    app.delivery.subscribe(1,app.subscription(20));
    assert.equal(app.delivery.status(1).pushSubscriptions,10);
    assert.equal(app.delivery.status(2).pushSubscriptions,0);
    assert.equal(app.db.prepare("SELECT status FROM notification_outbox WHERE user_id=2").get().status,'cancelled');
  } finally {await app.close();}
});

test('a failed subscription write rolls back ownership transfer and pending-job cancellation',async()=>{
  const app=await setup();
  try {
    app.delivery.subscribe(2,app.subscription(1));
    app.delivery.enqueue(2,{notificationEpoch:'owner'},app.notices(1));
    app.db.exec("CREATE TRIGGER reject_transfer BEFORE UPDATE ON push_subscriptions BEGIN SELECT RAISE(ABORT,'local write failure'); END");
    assert.throws(()=>app.delivery.subscribe(1,app.subscription(1)),/local write failure/);
    assert.equal(app.db.prepare('SELECT user_id FROM push_subscriptions').get().user_id,2);
    assert.equal(app.db.prepare('SELECT status FROM notification_outbox').get().status,'pending');
  } finally {await app.close();}
});

test('routine push fan-out is bounded and replay cannot resurrect discarded notices',async()=>{
  const app=await setup();
  try {
    for(let id=0;id<10;id++)app.delivery.subscribe(1,app.subscription(id));
    const notices=app.notices(20).reverse();
    app.delivery.enqueue(1,{notificationEpoch:'bounded'},notices);
    assert.equal(app.delivery.status(1).pending,100);
    assert.ok(app.db.prepare("SELECT payload FROM notification_outbox WHERE status='pending'").all().every(row=>JSON.parse(row.payload).id>=11));
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE status='cancelled' AND payload='{}'").get().n,100);
    app.delivery.enqueue(1,{notificationEpoch:'bounded'},notices);
    assert.equal(app.delivery.status(1).pending,100);
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM notification_outbox').get().n,200);
    await app.delivery.requestVerification(2,{purpose:'account'});
    app.delivery.queuePasswordChanged(2);
    app.db.exec('INSERT INTO notification_preferences(user_id,verified) VALUES (2,1)');
    app.delivery.queueSecurityNotice(2,'two-factor-enabled');
    const token='1'.repeat(64),digest=createHash('sha256').update(token).digest('hex'),expiresAt=Date.now()+60000;
    app.db.prepare('INSERT INTO password_resets VALUES (?,?,?)').run(digest,2,expiresAt);
    app.delivery.queuePasswordReset(2,{token,digest,expiresAt});
    await app.delivery.flush();
    assert.deepEqual(app.sent.slice(0,4),['verify','password-changed','security','password-reset']);
    assert.equal(app.sent.length,10);
    assert.equal(app.delivery.status(2).pending,0);
  } finally {await app.close();}
});

test('confirmation arriving during a push send takes priority over the remaining batch',async()=>{
  let started,release;const sending=new Promise(resolve=>started=resolve),blocked=new Promise(resolve=>release=resolve);
  const order=[];let first=true;
  const app=await setup({sendEmail:async job=>order.push(job.channel),sendPush:async()=>{order.push('push');if(first){first=false;started();await blocked;}}});
  try {
    for(let id=0;id<10;id++)app.delivery.subscribe(1,app.subscription(id));
    app.delivery.enqueue(1,{notificationEpoch:'priority'},app.notices(1));
    const flushing=app.delivery.flush();await sending;
    await app.delivery.requestVerification(2,{purpose:'account'});
    release();await flushing;
    assert.deepEqual(order.slice(0,2),['push','verify']);
    assert.equal(order.length,10);
  } finally {release();await app.close();}
});

test('expired routine alerts are discarded and cannot be requeued by rereading account history',async()=>{
  const app=await setup();
  try {
    app.delivery.subscribe(1,app.subscription(1));
    const old=app.notices(1);
    app.delivery.enqueue(1,{notificationEpoch:'expiry'},old);
    app.advance(5*60000+1);
    await app.delivery.flush();
    assert.equal(app.sent.length,0);
    assert.deepEqual({...app.db.prepare('SELECT status,payload FROM notification_outbox').get()},{status:'cancelled',payload:'{}'});
    app.delivery.enqueue(1,{notificationEpoch:'expiry'},old);
    assert.equal(app.delivery.status(1).pending,0);
    app.delivery.enqueue(1,{notificationEpoch:'fresh'},app.notices(1));
    await app.delivery.flush();
    assert.equal(app.sent.length,1);
  } finally {await app.close();}
});

test('restart bounds old subscriptions and queued fan-out, and revalidates persisted network destinations',async()=>{
  const app=await setup();
  try {
    const insertSub=app.db.prepare('INSERT INTO push_subscriptions VALUES (?,?,?)');
    for(let id=0;id<25;id++) {const sub=app.subscription(id);insertSub.run(sub.endpoint,1,JSON.stringify(sub));}
    const malicious={...app.subscription(50),endpoint:'https://127.0.0.1/private'};
    insertSub.run(malicious.endpoint,1,JSON.stringify(malicious));
    const insertJob=app.db.prepare("INSERT INTO notification_outbox(user_id,notice_key,channel,target,payload,next_at) VALUES (1,?,'push',?,?,?)");
    for(let id=0;id<150;id++)insertJob.run(`old:${id}`,app.subscription(0).endpoint,JSON.stringify({title:'Old job',expiresAt:Date.now()+60000}),Date.now());
    insertJob.run('malicious',malicious.endpoint,JSON.stringify({title:'Unsafe old job',expiresAt:Date.now()+60000}),Date.now());
    app.restart();
    assert.equal(app.delivery.status(1).pushSubscriptions,10);
    assert.equal(app.delivery.status(1).pending,100);
    app.advance(100);
    await app.delivery.requestVerification(2,{purpose:'account'});
    for(let iteration=0;iteration<11;iteration++)await app.delivery.flush();
    assert.equal(app.sent[0],'verify');
    assert.ok(app.sent.slice(1).every(endpoint=>endpoint.startsWith('https://fcm.googleapis.com/')));
    assert.equal(app.db.prepare("SELECT status FROM notification_outbox WHERE notice_key='malicious'").get().status,'cancelled');
    assert.equal(app.db.prepare('SELECT COUNT(*) n FROM push_subscriptions WHERE endpoint=?').get(malicious.endpoint).n,0);
  } finally {await app.close();}
});

test('private destinations, lookalike hosts, credentials and nonstandard ports never become push subscriptions',async()=>{
  const app=await setup();
  try {
    for(const endpoint of ['https://127.0.0.1/private','https://169.254.169.254/latest/meta-data/','http://fcm.googleapis.com/private','https://fcm.googleapis.com.attacker.invalid/private','https://attacker.invalid@fcm.googleapis.com/private','https://fcm.googleapis.com:8443/private','https://[::1]/private','https://evil.push.services.mozilla.com.attacker.invalid/private']) {
      assert.throws(()=>validateSubscription({...app.subscription(1),endpoint}),/Unsupported/);
      assert.throws(()=>app.delivery.subscribe(1,{...app.subscription(1),endpoint}),/Unsupported/);
    }
    assert.equal(app.delivery.status(1).pushSubscriptions,0);
    assert.equal(app.sent.length,0);
  } finally {await app.close();}
});

test('a failed in-flight push cannot exceed the pending cap after concurrent notification fan-out',async()=>{
  let firstStarted,releaseFirst,secondStarted,releaseSecond;
  const firstSending=new Promise(resolve=>firstStarted=resolve),firstBlocked=new Promise(resolve=>releaseFirst=resolve);
  const secondSending=new Promise(resolve=>secondStarted=resolve),secondBlocked=new Promise(resolve=>releaseSecond=resolve);
  let sends=0,flushing;
  const app=await setup({sendPush:async()=>{
    if(++sends===1) {firstStarted();await firstBlocked;throw new Error('Local provider failure.');}
    if(sends===2) {secondStarted();await secondBlocked;}
  }});
  try {
    app.delivery.subscribe(1,app.subscription(1));
    app.delivery.enqueue(1,{notificationEpoch:'old'},app.notices(1));
    flushing=app.delivery.flush();await firstSending;
    app.delivery.enqueue(1,{notificationEpoch:'new'},app.notices(100));
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE status='pending'").get().n,100);
    releaseFirst();await secondSending;
    assert.equal(app.db.prepare("SELECT COUNT(*) n FROM notification_outbox WHERE status IN ('pending','sending')").get().n,100);
    assert.deepEqual({...app.db.prepare("SELECT status,payload FROM notification_outbox WHERE notice_key='old:1'").get()},{status:'cancelled',payload:'{}'});
    releaseSecond();await flushing;
  } finally {releaseFirst();releaseSecond();await flushing;await app.close();}
});

test('unavailable email delivery cannot let older email jobs block usable background push',async()=>{
  const app=await setup({config:{}});
  try {
    const insert=app.db.prepare("INSERT INTO notification_outbox(user_id,notice_key,channel,target,payload,next_at) VALUES (2,?,'email','two@example.invalid','{}',?)");
    for(let id=0;id<11;id++)insert.run(`old-email:${id}`,Date.now());
    app.advance(100);
    app.delivery.subscribe(1,app.subscription(1));
    app.delivery.enqueue(1,{notificationEpoch:'push-only'},app.notices(1));
    await app.delivery.flush();
    assert.deepEqual(app.sent,[app.subscription(1).endpoint]);
    assert.equal(app.delivery.status(1).pending,0);
    assert.equal(app.delivery.status(2).pending,11);
  } finally {await app.close();}
});
