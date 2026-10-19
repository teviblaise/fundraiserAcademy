import webPush from 'web-push';
import { randomBytes, createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const digest = value => createHash('sha256').update(value).digest('hex');
const escapeHtml = value => String(value).replace(/[&<>"']/g,character=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[character]));
const accountEmail = ({title,introduction,action,url,footnote}) => `<!doctype html><html lang="en"><body style="margin:0;background:#0b0b0b;color:#ffffff;font-family:Arial,sans-serif"><div style="max-width:560px;margin:32px auto;padding:32px;background:#151515;border:1px solid #303030;border-radius:12px"><p style="margin:0 0 24px;color:#ffd700;font-weight:bold;letter-spacing:2px">FUNDRAISER ACADEMY</p><h1 style="font-size:26px;line-height:1.25">${escapeHtml(title)}</h1><p style="line-height:1.6;color:#dddddd">${escapeHtml(introduction)}</p><p style="margin:28px 0"><a href="${escapeHtml(url)}" style="display:inline-block;padding:14px 20px;background:#ffd700;color:#0b0b0b;text-decoration:none;font-weight:bold;border-radius:6px">${escapeHtml(action)}</a></p><p style="font-size:14px;line-height:1.6;color:#bbbbbb">${escapeHtml(footnote)}</p><p style="font-size:13px;color:#bbbbbb">Your skill. Our backing.</p></div></body></html>`;
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
  const now=options.now??Date.now;
  const origin=config.APP_ORIGIN && /^https:\/\//.test(config.APP_ORIGIN) ? new URL(config.APP_ORIGIN).origin : null;
  const emailAvailable=Boolean(origin && config.RESEND_API_KEY && config.EMAIL_FROM);
  const keysPath=path.join(path.dirname(databasePath),'vapid.json');
  let keys;
  try { keys=JSON.parse(readFileSync(keysPath,'utf8')); }
  catch(error) { if(error.code!=='ENOENT') throw error; keys=webPush.generateVAPIDKeys(); writeFileSync(keysPath,JSON.stringify(keys),{mode:0o600,flag:'wx'}); }
  db.exec(`CREATE TABLE IF NOT EXISTS notification_preferences (user_id INTEGER PRIMARY KEY REFERENCES users(id), email_enabled INTEGER NOT NULL DEFAULT 0, verified INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS push_subscriptions (endpoint TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), subscription TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS email_verifications (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL, purpose TEXT NOT NULL DEFAULT 'notifications');
    CREATE TABLE IF NOT EXISTS notification_outbox (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), notice_key TEXT NOT NULL, channel TEXT NOT NULL, target TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending', attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL, UNIQUE(user_id,notice_key,channel,target));`);
  // Existing links were requested expressly for notification delivery.
  if(!db.prepare('PRAGMA table_info(email_verifications)').all().some(column=>column.name==='purpose')) db.exec("ALTER TABLE email_verifications ADD COLUMN purpose TEXT NOT NULL DEFAULT 'notifications'");
  // In-flight work is retried after restart. Email provider idempotency keys suppress duplicate sends.
  db.exec("UPDATE notification_outbox SET status='pending' WHERE status='sending'");
  const preferences=id=>db.prepare('SELECT email_enabled,verified FROM notification_preferences WHERE user_id=?').get(id)??{email_enabled:0,verified:0};
  const addJob=(id,key,channel,target,payload)=>db.prepare('INSERT OR IGNORE INTO notification_outbox(user_id,notice_key,channel,target,payload,next_at) VALUES (?,?,?,?,?,?)').run(id,key,channel,target,JSON.stringify(payload),now());
  function scrubVerificationJob(job,cancel=false) {
    const payload=JSON.parse(job.payload);
    db.prepare("UPDATE notification_outbox SET payload=?,status=CASE WHEN ? THEN 'cancelled' ELSE status END WHERE id=?").run(JSON.stringify({title:payload.title,key:payload.key,purpose:payload.purpose}),cancel?1:0,job.id);
  }
  function cancelVerificationJobs(id) {
    for(const job of db.prepare("SELECT id,payload,status FROM notification_outbox WHERE user_id=? AND channel='verify'").all(id)) scrubVerificationJob(job,job.status!=='sent');
  }
  function scrubPasswordResetJob(job,cancel=false) {
    const payload=JSON.parse(job.payload);
    db.prepare("UPDATE notification_outbox SET payload=?,status=CASE WHEN ? THEN 'cancelled' ELSE status END WHERE id=?").run(JSON.stringify({title:payload.title,key:payload.key,expiresAt:payload.expiresAt}),cancel?1:0,job.id);
  }
  function cancelPasswordResets(id) {
    for(const job of db.prepare("SELECT id,payload,status FROM notification_outbox WHERE user_id=? AND channel='password-reset'").all(id)) scrubPasswordResetJob(job,job.status!=='sent');
  }
  // The recovery service owns token creation and wraps these synchronous writes in
  // its transaction. No provider request is made on the recovery HTTP request.
  function queuePasswordReset(id,{token,digest:tokenHash,expiresAt}={}) {
    if(!emailAvailable) throw new Error('Email delivery is not configured.');
    if(typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token) || tokenHash!==digest(token) || !Number.isSafeInteger(expiresAt) || expiresAt<=now()) throw new Error('Invalid password recovery token.');
    const row=db.prepare('SELECT email FROM users WHERE id=?').get(id);
    const active=db.prepare('SELECT token FROM password_resets WHERE token=? AND user_id=? AND expires=?').get(tokenHash,id,expiresAt);
    if(!row || !active) throw new Error('Invalid password recovery token.');
    const title='Reset your password';
    const introduction='You requested a password reset for your Fundraiser Academy account. Choose a new password using the secure link below.';
    const resetUrl=`${origin}/reset-password.html#token=${token}`;
    const footnote='This single-use link expires in 20 minutes. If you did not request a reset, ignore this email. Your password will stay the same.';
    const key=`password-reset:${tokenHash}`;
    cancelPasswordResets(id);
    addJob(id,key,'password-reset',row.email,{title,text:`${introduction}\n\nReset your password within 20 minutes:\n${resetUrl}\n\n${footnote}`,html:accountEmail({title,introduction,action:'Choose a new password',url:resetUrl,footnote}),key,expiresAt});
    return {status:'queued'};
  }
  function queuePasswordChanged(id) {
    if(!emailAvailable) return {status:'unavailable'};
    const row=db.prepare('SELECT email FROM users WHERE id=?').get(id);
    if(!row) return {status:'unavailable'};
    const title='Your password was changed';
    const introduction='Your Fundraiser Academy password was changed. All existing sign-ins and background push subscriptions have been signed out.';
    const loginUrl=`${origin}/login.html`;
    const footnote='If you did not make this change, use Forgot password on the sign-in page immediately to secure your account, and contact academy support. Fundraiser Academy will never ask you to send your password by email.';
    const key=`password-changed:${randomBytes(16).toString('hex')}`;
    addJob(id,key,'password-changed',row.email,{title,text:`${introduction}\n\nSign in with your new password:\n${loginUrl}\n\n${footnote}`,html:accountEmail({title,introduction,action:'Go to sign in',url:loginUrl,footnote}),key});
    return {status:'queued'};
  }
  function revokeDeviceNotifications(id) {
    db.prepare('DELETE FROM push_subscriptions WHERE user_id=?').run(id);
    db.prepare("UPDATE notification_outbox SET status='cancelled',payload='{}' WHERE user_id=? AND channel='push' AND status IN ('pending','sending')").run(id);
  }
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
    const verification=db.prepare("SELECT o.status,v.expires FROM email_verifications v JOIN notification_outbox o ON o.user_id=v.user_id AND o.notice_key='verify:'||v.token AND o.channel='verify' WHERE v.user_id=? AND v.expires>? ORDER BY o.id DESC LIMIT 1").get(id,now());
    return {emailAvailable,emailEnabled:Boolean(prefs.email_enabled),emailVerified:Boolean(prefs.verified),verificationStatus:verification?.status??null,verificationExpiresAt:verification?.expires??null,publicKey:keys.publicKey,pushSubscriptions:db.prepare('SELECT COUNT(*) AS count FROM push_subscriptions WHERE user_id=?').get(id).count,pending,failed};
  }
  async function requestVerification(id,{purpose='notifications'}={}) {
    if(!['account','notifications'].includes(purpose)) throw new Error('Invalid email verification purpose.');
    if(!emailAvailable) throw new Error('Email delivery needs RESEND_API_KEY, EMAIL_FROM, and a public HTTPS APP_ORIGIN configured by the operator.');
    const row=db.prepare('SELECT email FROM users WHERE id=?').get(id);
    if(!row) throw new Error('This account could not be found.');
    const requestedAt=now();
    const recent=db.prepare('SELECT expires FROM email_verifications WHERE user_id=? AND expires>?').get(id,requestedAt+29*60000);
    if(recent) throw new Error('A verification email was recently requested. Check your inbox or wait one minute.');
    const token=randomBytes(32).toString('hex');
    const expiresAt=requestedAt+30*60000;
    const title=purpose==='account'?'Confirm your email address':'Confirm your email alerts';
    const introduction=purpose==='account'?'Welcome to Fundraiser Academy. Confirm your email address to access your client dashboard and begin your simulated qualification challenge.':'You requested trading and price-alert emails from Fundraiser Academy. Confirm your address to enable these notifications.';
    const confirmationUrl=`${origin}/verify-email.html#token=${token}`;
    const html=`<!doctype html><html lang="en"><body style="margin:0;background:#0b0b0b;color:#ffffff;font-family:Arial,sans-serif"><div style="max-width:560px;margin:32px auto;padding:32px;background:#151515;border:1px solid #303030;border-radius:12px"><p style="margin:0 0 24px;color:#ffd700;font-weight:bold;letter-spacing:2px">FUNDRAISER ACADEMY</p><h1 style="font-size:26px;line-height:1.25">${title}</h1><p style="line-height:1.6;color:#dddddd">${introduction}</p><p style="margin:28px 0"><a href="${confirmationUrl}" style="display:inline-block;padding:14px 20px;background:#ffd700;color:#0b0b0b;text-decoration:none;font-weight:bold;border-radius:6px">Confirm email address</a></p><p style="font-size:14px;line-height:1.6;color:#bbbbbb">This link expires in 30 minutes. If you did not request this, you can ignore this email.</p><p style="font-size:13px;color:#bbbbbb">Your skill. Our backing.</p></div></body></html>`;
    db.exec('BEGIN');
    try {
      cancelVerificationJobs(id);
      db.prepare('DELETE FROM email_verifications WHERE user_id=?').run(id);
      db.prepare('INSERT INTO email_verifications(token,user_id,expires,purpose) VALUES (?,?,?,?)').run(digest(token),id,expiresAt,purpose);
      addJob(id,`verify:${digest(token)}`,'verify',row.email,{title,text:`${introduction}\n\nConfirm your address within 30 minutes:\n${confirmationUrl}\n\nIf you did not request this, ignore this email.`,html,key:`verify:${digest(token)}`,purpose});
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    return {status:'queued',expiresAt,cooldownUntil:requestedAt+60000};
  }
  function verify(token) {
    if(typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid verification link.');
    const row=db.prepare('SELECT user_id,purpose FROM email_verifications WHERE token=? AND expires>?').get(digest(token),now());
    if(!row) throw new Error('This verification link has expired or was already used. Request a new email from your client dashboard.');
    db.exec('BEGIN');
    try {
      const enabled=row.purpose==='notifications'?1:preferences(row.user_id).email_enabled;
      db.prepare('INSERT INTO notification_preferences(user_id,email_enabled,verified) VALUES (?,?,1) ON CONFLICT(user_id) DO UPDATE SET email_enabled=excluded.email_enabled,verified=1').run(row.user_id,enabled);
      cancelVerificationJobs(row.user_id);
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
    const response=await fetch('https://api.resend.com/emails',{method:'POST',headers:{Authorization:`Bearer ${config.RESEND_API_KEY}`,'Content-Type':'application/json','Idempotency-Key':`fa-${digest(`${job.user_id}:${job.notice_key}`)}`},body:JSON.stringify({from:config.EMAIL_FROM,to:[job.target],subject:`Fundraiser Academy: ${payload.title}`,text:payload.text+(payload.url?`\n\nView your account and manage email preferences: ${payload.url}\nSimulation only; no real money is involved.`:''),...(payload.html?{html:payload.html}:{})}),signal:AbortSignal.timeout(10000)});
    if(!response.ok) {const error=new Error(`Email provider returned HTTP ${response.status}`);error.statusCode=response.status;throw error;}
  });
  const sendPush=options.sendPush??((subscription,payload)=>webPush.sendNotification(subscription,JSON.stringify(payload),{TTL:300,timeout:10000,...(config.HTTPS_PROXY||config.https_proxy?{proxy:config.HTTPS_PROXY||config.https_proxy}:{}),vapidDetails:{subject:config.VAPID_SUBJECT||origin||'https://localhost',publicKey:keys.publicKey,privateKey:keys.privateKey}}));
  let busy=false,stopped=false;
  async function flush() {
    if(busy || stopped)return;busy=true;
    try {
      // Expired links are scrubbed even when retry backoff is still running.
      for(const job of db.prepare("SELECT id,user_id,notice_key,payload FROM notification_outbox WHERE channel='password-reset' AND status='pending'").all()) {
        if(!db.prepare('SELECT token FROM password_resets WHERE token=? AND user_id=? AND expires>?').get(job.notice_key.slice('password-reset:'.length),job.user_id,now())) scrubPasswordResetJob(job,true);
      }
      const jobs=db.prepare("SELECT * FROM notification_outbox WHERE status='pending' AND next_at<=? ORDER BY id LIMIT 10").all(now());
      for(const job of jobs) {
        if(stopped)break;
        // A previous send can yield while another request cancels this batch.
        if(db.prepare('SELECT status FROM notification_outbox WHERE id=?').get(job.id)?.status!=='pending')continue;
        // A resend, successful confirmation, or expired token must never deliver an obsolete link.
        if(job.channel==='verify' && !db.prepare('SELECT token FROM email_verifications WHERE token=? AND user_id=? AND expires>?').get(job.notice_key.slice(7),job.user_id,now())) {scrubVerificationJob(job,true);continue;}
        if(job.channel==='password-reset' && !db.prepare('SELECT token FROM password_resets WHERE token=? AND user_id=? AND expires>?').get(job.notice_key.slice('password-reset:'.length),job.user_id,now())) {scrubPasswordResetJob(job,true);continue;}
        if(job.channel!=='push' && !emailAvailable)continue;
        const payload=JSON.parse(job.payload);
        const sub=job.channel==='push'?db.prepare('SELECT subscription FROM push_subscriptions WHERE endpoint=? AND user_id=?').get(job.target,job.user_id):null;
        if(job.channel==='push'&&!sub || job.channel==='email'&&!preferences(job.user_id).email_enabled) {db.prepare("UPDATE notification_outbox SET status='cancelled' WHERE id=?").run(job.id);continue;}
        db.prepare("UPDATE notification_outbox SET status='sending' WHERE id=?").run(job.id);
        try {
          if(sub) await sendPush(JSON.parse(sub.subscription),payload); else await sendEmail(job,payload);
          if(stopped)break;
          db.prepare("UPDATE notification_outbox SET status='sent',attempts=attempts+1 WHERE id=? AND status='sending'").run(job.id);
          if(job.channel==='verify')scrubVerificationJob(job);
          if(job.channel==='password-reset')scrubPasswordResetJob(job);
        } catch(error) {
          if(stopped)break;
          const permanent=job.channel==='push'&&[404,410].includes(error.statusCode);
          if(permanent)unsubscribe(job.user_id,job.target);
          const attempts=job.attempts+1;
          const failed=permanent||attempts>=5;
          db.prepare("UPDATE notification_outbox SET status=?,attempts=?,next_at=? WHERE id=? AND status='sending'").run(failed?'failed':'pending',attempts,now()+Math.min(3600000,30000*2**attempts),job.id);
          if(job.channel==='verify'&&failed)scrubVerificationJob(job);
          if(job.channel==='password-reset'&&failed)scrubPasswordResetJob(job);
          // Log status only; provider errors may otherwise contain credentials or subscription URLs.
          console.error(`Notification delivery failed (${job.channel}, HTTP ${Number(error.statusCode)||'unknown'}); ${permanent||attempts>=5?'stopped':'retry scheduled'}.`);
        }
      }
    } finally {busy=false;}
  }
  const timer=options.autoFlush===false?null:setInterval(()=>void flush().catch(()=>console.error('Notification queue processing failed.')),2000);
  timer?.unref();
  return {enqueue,status,requestVerification,verify,queuePasswordReset,cancelPasswordResets,queuePasswordChanged,revokeDeviceNotifications,setEmail,subscribe,unsubscribe,flush,close(){stopped=true;if(timer)clearInterval(timer);}};
}
