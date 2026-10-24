import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {amountToCents,collectPersonalData} from '../public/account-tools.js';
import {createProfitSharingView,payoutStatement,payoutProcessingText} from '../public/profit-sharing-view.js';

const html=readFileSync(new URL('../public/account-tools.html',import.meta.url),'utf8');
const script=readFileSync(new URL('../public/account-tools.js',import.meta.url),'utf8').replace(/^import .*;\s*$/gm,'').replace(/^export /gm,'');
const time=Date.UTC(2026,9,22,10);
const profile={id:7,name:'Trader',email:'trader@example.com'};
function exportPage(offset=0,limit=2){
 const rows=[{id:1},{id:2},{id:3}];
 return {formatVersion:1,fingerprint:'a'.repeat(64),generatedAt:time+offset,profile,preferences:{notifications:{emailEnabled:false}},assessment:{balance:10000},accountControls:{status:'active'},offset,limit,
  sections:{trades:{items:rows.slice(offset,offset+limit),total:rows.length,offset,limit,nextOffset:offset+limit<rows.length?offset+limit:null},agreements:{items:[],total:0,offset,limit,nextOffset:null}},
  complete:offset+limit>=rows.length,nextOffset:offset+limit<rows.length?offset+limit:null,notice:'Private export'};
}

test('payout money conversion preserves exact cents without rounding, exponents, overflow, or zero requests',()=>{
 for(const [raw,cents]of[['0.01',1],['12.30',1230],['10000000000.00',1000000000000],[' 001.20 ',120]])assert.equal(amountToCents(raw),cents);
 for(const raw of ['',0,'0.00','-1','1.001','1e3','.5','1.','NaN','Infinity','10000000000.01','9'.repeat(33),{},null])assert.throws(()=>amountToCents(raw));
});

test('personal export follows every dataset page and preserves preferences instead of downloading a partial page',async()=>{
 const calls=[],progress=[];
 const result=await collectPersonalData(async(endpoint,input)=>{calls.push({endpoint,...input});return exportPage(input.offset,input.limit);},{limit:2,onProgress:value=>progress.push(value)});
 assert.deepEqual(calls,[{endpoint:'/api/account/export',offset:0,limit:2},{endpoint:'/api/account/export',offset:2,limit:2,fingerprint:'a'.repeat(64)}]);
 assert.deepEqual(result.sections.trades.items,[{id:1},{id:2},{id:3}]);assert.equal(result.sections.trades.total,3);assert.equal(result.complete,true);
 assert.deepEqual(result.preferences,{notifications:{emailEnabled:false}});assert.deepEqual(result.assessment,{balance:10000});assert.equal(result.generatedAt,time);assert.equal(result.completedAt,time+2);assert.equal(progress.at(-1).records,3);
});

test('incomplete, repeated, or changing export pages fail without returning a complete export',async()=>{
 const mutations=[
  page=>{page.sections.trades.items.pop();},page=>{page.nextOffset=0;},page=>{page.complete=true;},page=>{page.sections.trades.nextOffset=null;},
  page=>{page.offset=99;},page=>{page.sections['unsafe-name']=page.sections.trades;},page=>{page.sections.trades.total=Infinity;},page=>{delete page.fingerprint;},
 ];
 for(const change of mutations)await assert.rejects(collectPersonalData(async()=>{const page=exportPage();change(page);return page;},{limit:2}),/export|dataset|records/i);
 for(const change of [page=>{page.profile={...profile,name:'Changed'};},page=>{page.preferences={notifications:{emailEnabled:true}};},page=>{page.assessment={balance:11000};},page=>{page.sections.trades.total=4;},page=>{page.fingerprint='b'.repeat(64);}]){
  await assert.rejects(collectPersonalData(async(_,input)=>{const page=exportPage(input.offset,input.limit);if(input.offset)change(page);return page;},{limit:2}),/changed|incomplete/i);
 }
 await assert.rejects(collectPersonalData(async(_,input)=>exportPage(input.offset,input.limit),{limit:2,maxBytes:10}),/50 MB/);
});

class Element{
 constructor(tag='div',id=''){this.tagName=tag;this.id=id;this.hidden=false;this.disabled=false;this.required=false;this.checked=false;this.value='';this.children=[];this.listeners=new Map();this.attributes=new Map();this._text='';this.open=false;}
 get firstChild(){return this.children[0];}
 set textContent(value){this._text=String(value);this.children=[];}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
 set innerHTML(_){throw new Error('Unsafe HTML rendering');}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this._text='';this.children=children;}
 addEventListener(name,callback){this.listeners.set(name,callback);}
 async event(name,data={}){return this.listeners.get(name)?.({preventDefault(){},...data});}
 setAttribute(name,value){this.attributes.set(name,String(value));}
 removeAttribute(name){this.attributes.delete(name);}
 focus(){this.focused=true;}
 reset(){this.resetFields?.();}
 showModal(){this.open=true;}
 close(){this.open=false;}
 remove(){}
 click(){this.clicked=true;}
}
const controls={status:'active',blockers:[],retained:[{category:'agreements',label:'Signed agreement',recordCount:1}],retentionNotice:'Signed agreements remain restricted.'};
const funding={accounts:[{id:'e8036b5f-e69b-447f-a8c7-72c2a1176018',label:'Allocation <script>',firmName:'Firm',traderShareBps:7000,availableCents:12345,reservedCents:100,paidCents:200}],payouts:[],payoutsTotal:0};
function fixture(handler=()=>null,{factor=true,storage=new Map()}={}){
 const nodes=new Map();for(const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){const node=new Element(match[1],match[3]);node.hidden=/\bhidden(?:\s|$|=)/.test(match[2]);nodes.set(node.id,node);}
 nodes.get('tools-auth-form').resetFields=()=>{nodes.get('tools-auth-password').value='';nodes.get('tools-auth-code').value='';};
 const events=new Map(),calls=[],downloads=[];
 const defaults=endpoint=>endpoint==='/api/me'?{user:profile}:endpoint==='/api/security'?{twoFactor:{enabled:factor}}:endpoint==='/api/account/status'?controls:endpoint==='/api/payouts'?funding:null;
 vm.runInNewContext(script,{document:{getElementById:id=>nodes.get(id),createElement:tag=>new Element(tag),body:new Element('body')},window:{addEventListener:(name,callback)=>events.set(name,callback)},
  fetch:async(endpoint,options={})=>{const data=options.body?JSON.parse(options.body):undefined;calls.push({endpoint,data,options});const override=await handler(endpoint,data);const value=override??{status:200,body:defaults(endpoint)};return {status:value.status,ok:value.status>=200&&value.status<300,json:async()=>value.body};},
  sessionStorage:{getItem:key=>storage.get(key)||null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},crypto:{randomUUID:()=> '64e0751f-22ca-4353-89dc-b73c7b4bd3d7'},
  AbortSignal,TextEncoder,Blob,URL:{createObjectURL:blob=>{downloads.push(blob);return'blob:private';},revokeObjectURL(){}},setTimeout:()=>0,
  createProfitSharingView,payoutStatement,payoutProcessingText,
 });
 return {nodes,calls,storage,downloads,async settle(){for(let i=0;i<70;i++)await Promise.resolve();},async click(id){await nodes.get(id).event('click');},async submit(id){await nodes.get(id).event('submit');},async pagehide(){await events.get('pagehide')({});},async pageshow(){await events.get('pageshow')({persisted:true});}};
}

test('account controls load owner records privately and require fresh purpose-specific credentials before requesting a payout',async()=>{
 const page=fixture((endpoint)=>endpoint==='/api/account/authorize'?{status:200,body:{expiresAt:Date.now()+300000}}:endpoint==='/api/payouts/request'?{status:200,body:{payout:{id:'recorded-payout'},reused:false}}:null);await page.settle();
 assert.equal(page.nodes.get('tools-main').hidden,false);assert.match(page.nodes.get('payout-balances').textContent,/\$123\.45/);assert.equal(page.nodes.get('tools-auth-dialog').open,false);
 page.nodes.get('payout-account').value=funding.accounts[0].id;page.nodes.get('payout-amount').value='12.34';await page.submit('payout-request-form');await page.settle();
 assert.equal(page.calls.some(call=>call.endpoint==='/api/payouts/request'),false);assert.equal(page.nodes.get('tools-auth-dialog').open,true);assert.equal(page.nodes.get('tools-auth-code').required,true);
 page.nodes.get('tools-auth-password').value='Private password';page.nodes.get('tools-auth-code').value='123456';await page.submit('tools-auth-form');await page.settle();
 const auth=page.calls.find(call=>call.endpoint==='/api/account/authorize'),request=page.calls.find(call=>call.endpoint==='/api/payouts/request');assert.deepEqual(auth.data,{purpose:'payout',password:'Private password',code:'123456'});
 assert.equal(request.data.amountCents,1234);assert.equal(request.data.accountId,funding.accounts[0].id);assert.equal(request.data.idempotencyKey,'64e0751f-22ca-4353-89dc-b73c7b4bd3d7');assert.equal(Object.hasOwn(request.data,'password'),false);
 assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.cache,'no-store');assert.equal(request.options.headers['X-Requested-With'],'FundraiserAcademy');assert.equal(page.storage.size,0);assert.equal(page.nodes.get('tools-auth-password').value,'');
});

test('an unknown payout outcome keeps one idempotency key and safely retries without creating a different reservation',async()=>{
 let attempts=0;const page=fixture((endpoint)=>{if(endpoint==='/api/account/authorize')return{status:200,body:{expiresAt:Date.now()+300000}};if(endpoint==='/api/payouts/request'){attempts++;if(attempts===1)throw new Error('Network interrupted');return{status:200,body:{payout:{id:'same-payout'},reused:true}};}return null;},{factor:false});await page.settle();
 page.nodes.get('payout-account').value=funding.accounts[0].id;page.nodes.get('payout-amount').value='10';await page.submit('payout-request-form');await page.settle();assert.equal(page.nodes.get('tools-auth-factor').hidden,true);
 page.nodes.get('tools-auth-password').value='Password';await page.submit('tools-auth-form');await page.settle();assert.equal(page.storage.size,1);assert.equal(page.nodes.get('payout-pending-panel').hidden,false);
 assert.doesNotMatch([...page.storage.values()][0],/Password|password|code/);await page.click('payout-retry-pending');await page.settle();
 const requests=page.calls.filter(call=>call.endpoint==='/api/payouts/request');assert.equal(requests.length,2);assert.deepEqual(requests[0].data,requests[1].data);assert.equal(page.storage.size,0);assert.match(page.nodes.get('tools-status').textContent,/already recorded/);
});

test('closure requires explicit text and acknowledgement, then preserves the signed-out receipt for download',async()=>{
 const receipt={accountDeleted:true,signedOut:true,status:'deleted',requestId:'private-request',retained:[{category:'agreements',recordCount:1}],message:'Closed with restricted agreement retained.'};
 const page=fixture(endpoint=>endpoint==='/api/account/authorize'?{status:200,body:{expiresAt:Date.now()+300000}}:endpoint==='/api/account/delete'?{status:200,body:receipt}:null);await page.settle();
 await page.submit('closure-form');assert.equal(page.calls.some(call=>call.endpoint==='/api/account/authorize'),false);
 page.nodes.get('closure-confirmation').value='DELETE MY ACCOUNT';page.nodes.get('closure-understood').checked=true;await page.submit('closure-form');await page.settle();page.nodes.get('tools-auth-password').value='Password';page.nodes.get('tools-auth-code').value='234567';await page.submit('tools-auth-form');await page.settle();
 assert.equal(page.nodes.get('tools-main').hidden,true);assert.equal(page.nodes.get('closure-complete').hidden,false);assert.match(page.nodes.get('closure-complete-message').textContent,/restricted agreement/);await page.click('closure-download-receipt');assert.equal(page.downloads.length,1);assert.deepEqual(JSON.parse(await page.downloads[0].text()),receipt);
});

test('a later suspension cannot discard the idempotency reference of an earlier unconfirmed payout',async()=>{
 let attempts=0;const page=fixture(endpoint=>{if(endpoint==='/api/account/authorize')return{status:200,body:{expiresAt:Date.now()+300000}};if(endpoint==='/api/payouts/request'){attempts++;if(attempts===1)throw new Error('Unknown network outcome');return{status:403,body:{error:'Account suspended.',code:'ACCOUNT_SUSPENDED'}};}return null;});await page.settle();
 page.nodes.get('payout-account').value=funding.accounts[0].id;page.nodes.get('payout-amount').value='1';await page.submit('payout-request-form');page.nodes.get('tools-auth-password').value='Password';page.nodes.get('tools-auth-code').value='345678';await page.submit('tools-auth-form');await page.settle();
 const saved=[...page.storage.values()][0];assert.ok(saved);await page.click('payout-retry-pending');await page.settle();assert.equal(page.storage.size,1);assert.equal([...page.storage.values()][0],saved);assert.equal(page.nodes.get('tools-main').hidden,true);
});

test('leaving during reauthentication clears private records and prevents a late authorization from submitting a payout',async()=>{
 let resolveAuth;const page=fixture(endpoint=>endpoint==='/api/account/authorize'?new Promise(resolve=>{resolveAuth=resolve;}):null);await page.settle();
 page.nodes.get('payout-account').value=funding.accounts[0].id;page.nodes.get('payout-amount').value='1';await page.submit('payout-request-form');page.nodes.get('tools-auth-password').value='Password';page.nodes.get('tools-auth-code').value='345678';const submission=page.submit('tools-auth-form');await page.settle();await page.pagehide();
 assert.equal(page.nodes.get('tools-main').hidden,true);assert.equal(page.nodes.get('payout-history').children.length,0);assert.equal(page.nodes.get('tools-auth-password').value,'');
 await page.pageshow();await page.settle();resolveAuth({status:200,body:{expiresAt:Date.now()+300000}});await submission;await page.settle();assert.equal(page.calls.some(call=>call.endpoint==='/api/payouts/request'),false);
});

test('account controls show retained progression and download a verified own payout statement without staff metadata',async()=>{
 const receipt={id:'3b2fb4e4-4b55-44bb-9ce4-d4bbb2066347',accountId:funding.accounts[0].id,relationshipId:'64e0751f-22ca-4353-89dc-b73c7b4bd3d7',amountReceivedCents:1000000,thirdPartyChargesCents:0,qualifyingNetPayoutCents:1000000,appliedTraderShareBps:5000,traderShareCents:500000,companyShareCents:500000,cumulativeBeforeCents:0,cumulativeAfterCents:1000000,nextTraderShareBps:6000,clearedAt:time,initiationDueAt:time+5*86400000,initiatedCents:0,outstandingCents:500000,overdue:false,evidence:'PRIVATE STAFF EVIDENCE',email:'private-other@example.com'};
 const details={...funding,progressions:[{id:receipt.relationshipId,status:'active',currentTraderShareBps:6000,currentCompanyShareBps:4000,cumulativeQualifyingNetPayoutsCents:1000000,nextThresholdCents:2500000,nextTraderShareBps:7000}],receipts:[receipt],receiptsTotal:1,accounts:[{...funding.accounts[0],sharingModel:'progressive_cleared',traderShareBps:6000}],payouts:[{id:'recorded',label:'Allocation',status:'approved',amountCents:1000,createdAt:time,initiationDueAt:time+5*86400000,overdue:false}]};
 const page=fixture(endpoint=>endpoint==='/api/payouts'?{status:200,body:details}:null);await page.settle();
 const panel=page.nodes.get('payout-profit-sharing');assert.match(panel.textContent,/60%/);assert.match(panel.textContent,/Applied fundraiser share50%/);assert.doesNotMatch(panel.textContent,/PRIVATE STAFF|private-other/);assert.match(page.nodes.get('payout-history').textContent,/Initiation due/);
 page.nodes.get('payout-account').value=details.accounts[0].id;await page.nodes.get('payout-account').event('change');assert.match(page.nodes.get('payout-account-detail').textContent,/60% on your next eligible cleared payout/);
 const all=element=>[element,...element.children.flatMap(all)];const button=all(panel).find(item=>item.tagName==='button');await button.event('click');assert.equal(page.downloads.length,1);const downloaded=JSON.parse(await page.downloads[0].text());assert.equal(downloaded.appliedTraderShareBps,5000);assert.equal(downloaded.nextTraderShareBps,6000);assert.doesNotMatch(JSON.stringify(downloaded),/PRIVATE STAFF|private-other|evidence/);
 await page.pagehide();assert.equal(panel.children.length,0,'private receipt cards clear when the page is hidden');
});
