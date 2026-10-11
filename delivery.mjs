import webPush from 'web-push';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
export function validateSubscription(subscription) {
  if (!subscription || typeof subscription.endpoint !== 'string' || subscription.endpoint.length > 2048) throw new Error('Invalid push subscription.');
  const url=new URL(subscription.endpoint);
  const host=url.hostname;
  if(url.protocol!=='https:' || url.username || url.password || (url.port && url.port!=='443') || !['fcm.googleapis.com','web.push.apple.com'].includes(host) && host!=='updates.push.services.mozilla.com' && !host.endsWith('.push.services.mozilla.com')) throw new Error('Unsupported push service.');
  for(const [key,size] of [['p256dh',65],['auth',16]]) if(typeof subscription.keys?.[key]!=='string' || !/^[A-Za-z0-9_-]+={0,2}$/.test(subscription.keys[key]) || Buffer.from(subscription.keys[key],'base64url').length!==size) throw new Error('Invalid push subscription keys.');
  return {endpoint:subscription.endpoint,keys:{p256dh:subscription.keys.p256dh,auth:subscription.keys.auth}};
}

export function createDelivery(db, databasePath, options={}) {
  const config=options.config??process.env;
  const origin=config.APP_ORIGIN && /^https:\/\//.test(config.APP_ORIGIN) ? new URL(config.APP_ORIGIN).origin : null;
  const emailAvailable=Boolean(origin && config.RESEND_API_KEY && config.EMAIL_FROM);
  const keysPath=path.join(path.dirname(databasePath),'vapid.json');
  let keys;
  try { keys=JSON.parse(readFileSync(keysPath,'utf8')); }
  catch(error) { if(error.code!=='ENOENT') throw error; keys=webPush.generateVAPIDKeys(); writeFileSync(keysPath,JSON.stringify(keys),{mode:0o600,flag:'wx'}); }
  db.exec(`CREATE TABLE IF NOT EXISTS notification_preferences (user_id INTEGER PRIMARY KEY REFERENCES users(id), email_enabled INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), subscription TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_verifications (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS notification_outbox (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), notice_key TEXT NOT NULL, channel TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, UNIQUE(user_id,notice_key,channel,target));`);
  // In-flight work is retried after restart. Email provider idempotency keys suppress duplicate sends.
  db.exec("UPDATE notification_outbox SET status='pending' WHERE status='sending'");
  const preferences=id=>db.prepare('SELECT email_enabled,verified FROM notification_preferences WHERE user_id=?').get(id)??{email_enabled:0,verified:0};
  const addJob=(id,key,channel,target,payload)=>db.prepare('INSERT OR IGNORE INTO notification_outbox(user_id,notice_key,channel,target,payload,next_at) VALUES (?,?,?,?,?,?)').run(id,key,channel,target,JSON.stringify(payload),Date.now());
  function enqueue(id,state,notices) {
    const prefs=preferences(id);
    const subscriptions=db.prepare('SELECT endpoint FROM push_subscriptions WHERE user_id=?').all(id);
    const email=db.prepare('SELECT email FROM users WHERE id=?').get(id).email;
    for(const notice of notices) {
      const key=`${state.notificationEpoch}:${notice.id}`;
      // Retained jobs deduplicate state saves; only settings opt-in controls delivery.
      if(prefs.email_enabled && prefs.verified && emailAvailable) addJob(id,key,'email',email,{...notice,key,url:`${origin}/dashboard.html`});
      for(const sub of subscriptions) addJob(id,key,'push',sub.endpoint,{...notice,key,url:'/dashboard.html'});
    }
  }
  function status(id) {
    const prefs=preferences(id);
    const pending=db.prepare("SELECT COUNT(*) AS count FROM notification_outbox WHERE user_id=? AND status IN ('pending','sending')").get(id).count;
    const failed=db.prepare("SELECT COUNT(*) AS count FROM notification_outbox WHERE user_id=? AND status='failed'").get(id).count;
    return {emailAvailable,emailEnabled:Boolean(prefs.email_enabled),emailVerified:Boolean(prefs.verified),publicKey:keys.publicKey,pushSubscriptions:db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id=?').get(id).count,pending,failed};
  }
  async function requestVerification(id) {
    if(!emailAvailable) throw new Error('Email delivery needs RESEND_API_KEY, EMAIL_FROM, and a public HTTPS APP_ORIGIN configured by the operator.');
    const row=db.prepare('SELECT email FROM users WHERE id=?').get(id);
    const recent=db.prepare('SELECT expires FROM email_verifications WHERE user_id=? AND expires>?').get(id,Date.now()+29*60000);
    if(recent) throw new Error('A verification email was recently requested. Check your inbox or wait one minute.');
    const token=randomBytes(32).toString('hex');
    db.prepare('DELETE FROM email_verifications WHERE user_id=?').run(id);
    db.prepare('INSERT INTO email_verifications VALUES (?,?,?)').run(digest(token),id,Date.now()+30*60000);
    addJob(id,`verify:${digest(token)}`,'verify',row.email,{title:'Confirm Fundraiser Academy email alerts',text:`You requested trading and price-alert emails. Confirm your address within 30 minutes: ${origin}/verify-email.html#token=${token}\n\nIf you did not request this, ignore this email.`,key:`verify:${digest(token)}`});
  }
  function verify(token) {
    if(typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid verification link.');
    const row=db.prepare('SELECT user_id FROM email_verifications WHERE token=? AND expires>?').get(digest(token),Date.now());
    if(!row) throw new Error('This verification link has expired or was already used. Request a new email from the dashboard.');
    db.exec('BEGIN');
    try {
      db.prepare('INSERT INTO notification_preferences(user_id,email_enabled,verified) VALUES (?,1,1) ON CONFLICT(user_id) DO UPDATE SET email_enabled=1,verified=1').run(row.user_id);
      db.prepare('DELETE FROM email_verifications WHERE user_id=?').run(row.user_id);
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    return row.user_id;
  }
  function setEmail(id,enabled) {
    const prefs=preferences(id);
    if(enabled && (!prefs.verified || !emailAvailable)) throw new Error('Verify your email address and configure email delivery first.');
    db.prepare('INSERT INTO notification_preferences(user_id,email_enabled,verified) VALUES (?,?,?) ON CONFLICT(user_id) DO UPDATE SET email_enabled=excluded.email_enabled').run(id,enabled?1:0,prefs.verified);
    if(!enabled) db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE user_id=? AND channel='email' AND status='pending'").run(id);
  }
  function subscribe(id,subscription) {
    const clean=validateSubscription(subscription);
    db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE target=? AND channel='push' AND status='pending'").run(clean.endpoint);
    db.prepare('INSERT INTO push_subscriptions VALUES (?,?,?) ON CONFLICT(endpoint) DO UPDATE SET user_id=excluded.user_id,subscription=excluded.subscription').run(clean.endpoint,id,JSON.stringify(clean));
  }
  function unsubscribe(id,endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id=? AND endpoint=?').run(id,endpoint);
    db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE user_id=? AND channel='push' AND target=? AND status='pending'").run(id,endpoint);
  }
  const sendEmail=options.sendEmail??(async(job,payload)=>{
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${config.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`fa-${digest(`${job.user_id}:${job.notice_key}`)}`},body:JSON.stringify({from:config.EMAIL_FROM,to:[job.target],subject:`Fundraiser Academy: ${payload.title}`,text:payload.text+(payload.url?`\n\nView your account and manage email preferences: ${payload.url}\nSimulation only; no real money is involved.`:'')}),signal:AbortSignal.timeout(10000)});
    if(!response.ok) {const error=new Error(`Email provider returned HTTP ${response.status}`);error.statusCode=response.status;throw error;}
  });
  const sendPush=options.sendPush??((subscription,payload)=>webPush.sendNotification(subscription,JSON.stringify(payload),{TTL:300,timeout:10000,...(config.HTTPS_PROXY||config.https_proxy?{proxy:config.HTTPS_PROXY||config.https_proxy}:{}),vapidDetails:{subject:config.VAPID_SUBJECT||origin||'https://localhost',publicKey:keys.publicKey,privateKey:keys.privateKey}}));
  let busy=false,stopped=false;
  async function flush() {
    if(busy || stopped)return;busy=true;
    try {
      const jobs=db.prepare("SELECT * FROM notification_outbox WHERE status='pending' AND next_at<=? ORDER BY id LIMIT 10").all(Date.now());
      for(const job of jobs) {
        if(stopped)break;
        if(job.channel!=='push' && !emailAvailable)continue;
        const payload=JSON.parse(job.payload);
        const sub=job.channel==='push'?db.prepare('SELECT subscription FROM push_subscriptions WHERE endpoint=? AND user_id=?').get(job.target,job.user_id):null;
        if(job.channel==='push'&&!sub || job.channel==='email'&&!preferences(job.user_id).email_enabled) {db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE id=?").run(job.id);continue;}
        db.prepare("UPDATE notification_outbox SET status='sending' WHERE id=?").run(job.id);
        try {
          if(sub) await sendPush(JSON.parse(sub.subscription),payload); else await sendEmail(job,payload);
          if(stopped)break;
          db.prepare("UPDATE notification_outbox SET status='sent',attempts=attempts+1 WHERE id=?").run(job.id);
          if(job.channel==='verify')db.prepare('UPDATE notification_outbox SET payload=? WHERE id=?').run(JSON.stringify({title:payload.title,key:payload.key}),job.id);
        } catch(error) {
          if(stopped)break;
          const permanent=job.channel==='push'&&[404,410].includes(error.statusCode);
          if(permanent)unsubscribe(job.user_id,job.target);
          const attempts=job.attempts+1;
          db.prepare('UPDATE notification_outbox SET status=?,attempts=?,next_at=? WHERE id=?').run(permanent||attempts>=5?'failed':'pending',attempts,Date.now()+Math.min(3600000,30000*2**attempts),job.id);
          // Log status only; provider errors may otherwise contain credentials or subscription URLs.
          console.error(`Notification delivery failed (${job.channel}, HTTP ${Number(error.statusCode)||'unknown'}); ${permanent||attempts>=5?'stopped':'retry scheduled'}.`);
        }
      }
    } finally {busy=false;}
  }
  const timer=options.autoFlush===false?null:setInterval(()=>void flush().catch(()=>console.error('Notification queue processing failed.')),2000);
  timer?.unref();
  return {enqueue,status,requestVerification,verify,setEmail,subscribe,unsubscribe,flush,close(){stopped=true;if(timer)clearInterval(timer);}};
}
