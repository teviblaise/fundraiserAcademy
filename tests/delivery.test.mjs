import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import webPush from 'web-push';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {createDelivery,validateSubscription} from '../delivery.mjs';
import {createAccount,notify} from '../public/simulator.js';

test('verified email and web push use a persistent deduplicated queue with opt-out and expired-subscription cleanup',async()=>{
  const folder=await mkdtemp(path.join(tmpdir(),'fa-delivery-'));
  const db=new DatabaseSync(path.join(folder,'test.sqlite'));
  db.exec("CREATE TABLE users(id INTEGER PRIMARY KEY,email TEXT);INSERT INTO users VALUES(1,'test@example.com'),(2,'other@example.com')");
  const emails=[],pushes=[];let expired=false;
  const delivery=createDelivery(db,path.join(folder,'test.sqlite'),{autoFlush:false,config:{APP_ORIGIN:'https://academy.example.com',EMAIL_FROM:'academy@example.com',RESEND_API_KEY:'test-only-not-sent'},sendEmail:async(job,payload)=>emails.push({job,payload}),sendPush:async(subscription,payload)=>{if(expired){const error=new Error();error.statusCode=410;throw error;}pushes.push({subscription,payload});}});
  try {
    assert.throws(()=>delivery.setEmail(1,true),/Verify/);
    await delivery.requestVerification(1);await delivery.flush();assert.equal(emails.length,1);
    const token=/token=([a-f0-9]{64})/.exec(emails[0].payload.text)[1];
    assert.equal(delivery.verify(token),1);assert.throws(()=>delivery.verify(token),/expired/);
    assert.equal(delivery.status(1).emailEnabled,true);
    const publicKey=webPush.generateVAPIDKeys().publicKey;
    const subscription={endpoint:'https://fcm.googleapis.com/fa-test-only',keys:{p256dh:publicKey,auth:Buffer.alloc(16,1).toString('base64url')}};
    assert.throws(()=>validateSubscription({...subscription,endpoint:'https://127.0.0.1/private'}),/Unsupported/);
    assert.throws(()=>validateSubscription({...subscription,endpoint:'https://fcm.googleapis.com.attacker.example/private'}),/Unsupported/);
    delivery.subscribe(1,subscription);
    const account=createAccount();notify(account,'Trade filled','A simulated trade filled.');
    delivery.enqueue(1,account,account.notifications);delivery.enqueue(1,account,account.notifications);
    await delivery.flush();assert.equal(emails.length,2);assert.equal(pushes.length,1);
    assert.equal(delivery.status(2).pushSubscriptions,0);
    assert.equal(delivery.status(1).pending,0);
    delivery.setEmail(1,false);
    notify(account,'Price alert','A price target was hit.');expired=true;
    delivery.enqueue(1,account,[account.notifications[0]]);await delivery.flush();
    assert.equal(delivery.status(1).pushSubscriptions,0);assert.equal(delivery.status(1).failed,1);assert.equal(emails.length,2);
  }finally{delivery.close();db.close();await rm(folder,{recursive:true,force:true});}
});

test('service worker sends visible popups, background notifications, and focuses dashboard on click',async()=>{
  const handlers={};const shown=[],posted=[],opened=[];let visible=true;
  const client={url:'https://academy.example.com/dashboard.html',visibilityState:'visible',postMessage:data=>posted.push(data),focus:async()=>opened.push('focus')};
  const self={addEventListener:(name,fn)=>handlers[name]=fn,clients:{matchAll:async()=>visible?[client]:[],openWindow:async url=>opened.push(url),claim:async()=>{}},registration:{showNotification:async(title,options)=>shown.push({title,options})}};
  vm.runInNewContext(await readFile(new URL('../public/sw.js',import.meta.url),'utf8'),{self,URL});
  const payload={title:'Price alert',text:'EURUSD reached its target.',key:'test-event'};
  async function push(){let done;handlers.push({data:{json:()=>payload},waitUntil:p=>done=p});await done;}
  await push();assert.equal(posted.length,1);assert.equal(shown.length,0);
  visible=false;await push();assert.equal(shown.length,1);assert.equal(shown[0].options.tag,'test-event');
  let done;handlers.notificationclick({notification:{close(){}},waitUntil:p=>done=p});await done;assert.equal(opened[0],'/dashboard.html');
  visible=true;handlers.notificationclick({notification:{close(){}},waitUntil:p=>done=p});await done;assert.equal(opened[1],'focus');
});
