self.addEventListener('push',event=>{
  event.waitUntil((async()=>{
    let payload;
    try {payload=event.data.json();}catch{return;}
    if(typeof payload.title!=='string'||typeof payload.text!=='string')return;
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    const visible=clients.filter(client=>client.visibilityState==='visible' && new URL(client.url).pathname==='/dashboard.html');
    if(visible.length){for(const client of visible)client.postMessage({type:'FA_NOTIFICATION',notice:payload});return;}
    await self.registration.showNotification(payload.title,{body:payload.text,icon:'/favicon.svg',badge:'/favicon.svg',tag:payload.key,data:{url:'/dashboard.html'}});
  })());
});
self.addEventListener('notificationclick',event=>{
  event.notification.close();
  event.waitUntil((async()=>{
    const clients=await self.clients.matchAll({type:'window',includeUncontrolled:true});
    for(const client of clients)if(new URL(client.url).pathname==='/dashboard.html'){await client.focus();return;}
    await self.clients.openWindow('/dashboard.html');
  })());
});
self.addEventListener('activate',event=>event.waitUntil(self.clients.claim()));
