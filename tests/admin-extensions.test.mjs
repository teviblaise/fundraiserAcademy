import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdminExtensions,performanceFilters,currencyAmount} from '../public/admin-extensions.js';

const accountId='11111111-1111-4111-8111-111111111111';
class Element{
  constructor(tag,text=''){this.tag=tag;this.textContent=text;this.children=[];this.listeners={};this.attributes={};this.disabled=false;}
  append(...items){this.children.push(...items);}
  setAttribute(name,value){this.attributes[name]=String(value);}
  addEventListener(name,listener){this.listeners[name]=listener;}
  set innerHTML(_){throw new Error('Private data must not become HTML');}
  reportValidity(){return true;}
}
function flatten(element){return element instanceof Element?[element,...element.children.flatMap(flatten)]:[];}
function textOf(element){return element instanceof Element?[element.textContent,...element.children.map(textOf)].join(' '):String(element??'');}
function fixture({responses={},query={},permissions=['finance.write','traders.manage','system.read'],current=true}={}){
  const content=new Element('main'),calls=[],posts=[],actions=[],notices=[];let page={...query},reloads=0,unlocks=0;
  const context={content,api:async endpoint=>{calls.push(endpoint);const key=endpoint.split('?')[0];if(!(key in responses))throw new Error('Unexpected request '+endpoint);return structuredClone(typeof responses[key]==='function'?responses[key](endpoint):responses[key]);},post:async(endpoint,data)=>{posts.push({endpoint,data});return responses.post||{};},
    can:permission=>permissions.includes(permission),node:(tag,classes='',value='')=>{const element=new Element(tag,value===null?'':String(value));element.className=classes;return element;},
    card:(title,description)=>{const element=new Element('section',title||'');if(description)element.append(new Element('p',description));return element;},
    table:(columns,rows)=>{const element=new Element('table');for(const row of rows){const tr=new Element('tr');for(const column of columns)tr.append(column.value(row));element.append(tr);}return element;},
    detailGrid:values=>{const element=new Element('dl');for(const [key,value]of values)element.append(new Element('dt',key),new Element('dd',value));return element;},
    button:(label,handler)=>{const button=new Element('button',label);button.click=handler;return button;},
    openAction:config=>{actions.push(config);},notify:message=>notices.push(message),isCurrent:()=>current,getQuery:()=>({...page}),setQuery:values=>{page={...values};},reload:async()=>{reloads++;},ensureUnlocked:async()=>{unlocks++;},date:value=>typeof value==='number'?`time:${value}`:'Not recorded',percent:value=>typeof value==='number'?`${value}%`:'Not recorded'};
  const ui=createAdminExtensions(context);
  return {ui,content,calls,posts,actions,notices,get reloads(){return reloads;},get unlocks(){return unlocks;},get query(){return page;},find:label=>flatten(content).find(element=>element.tag==='button'&&element.textContent===label)};
}

test('performance filters distinguish demo and sponsored results, reject invalid dates, and never pass unrelated filters',()=>{
  assert.deepEqual(performanceFilters({userId:'42',source:'assessment',accountId:'stale-account-filter',offset:25,from:'2026-02-01',to:'2026-02-28'}),{userId:42,source:'assessment',from:'2026-02-01',to:'2026-02-28'});
  assert.deepEqual(performanceFilters({userId:42,source:'sponsored',accountId}),{userId:42,source:'sponsored',accountId});
  for(const value of [{userId:'0'},{userId:'1 OR 1=1'},{userId:1,source:'mixed'},{userId:1,source:'sponsored',accountId:'invalid'},{userId:1,from:'2026-02-30'},{userId:1,from:'2026-03-01',to:'2026-02-01'}])assert.throws(()=>performanceFilters(value));
  assert.match(currencyAmount(12.34,'EUR'),/12[.,]34/);assert.match(currencyAmount(12,'bad'),/currency unavailable/);assert.match(currencyAmount(12),/currency unavailable/);assert.equal(currencyAmount(Infinity,'USD'),'Not recorded');
});

test('MetaApi connection page honors explicit unlinked state, sends only identifiers, and binds writes to the visible revision',async()=>{
  const app=fixture({responses:{'/api/admin/connections':{accounts:[{id:accountId,userId:7,traderName:'<img onerror=steal()>',label:'Allocation A',firmName:'Test firm',connection:{linked:false,active:false,revision:0,status:'not_connected',latest:null}}],total:1,limit:25,offset:0,provider:{configured:false,automaticSync:false,synchronizing:0}}}});
  await app.ui.connections(1);assert.match(textOf(app.content),/<img onerror=steal\(\)>/);assert.match(textOf(app.content),/Server token not configured/);assert.ok(app.find('Link MetaApi account'));assert.equal(app.find('Synchronize now'),undefined);
  await app.find('Link MetaApi account').click();const action=app.actions[0];assert.ok(!action.fields.some(field=>/password|token|secret/i.test(field.name)));
  await action.execute(new Map([['providerAccountId',' broker-account-id '],['historyFrom','2026-01-01'],['reason','Assign existing approved allocation']]));
  assert.deepEqual(app.posts,[{endpoint:`/api/admin/connections/${accountId}/link`,data:{providerAccountId:'broker-account-id',historyFrom:'2026-01-01',expectedRevision:0,reason:'Assign existing approved allocation'}}]);
});

test('connection synchronization requires privileged confirmation and disconnected assignments offer reconnection rather than silent reassignment',async()=>{
  const response=connection=>({accounts:[{id:accountId,userId:1,label:'A',connection}],total:1,limit:25,offset:0,provider:{configured:true}});
  const app=fixture({responses:{'/api/admin/connections':response({linked:true,active:true,revision:2,status:'synchronized',latest:{equity:10500,currency:'USD'},lastSuccessAt:42})}});
  await app.ui.connections(1);await app.find('Synchronize now').click();assert.equal(app.unlocks,1);assert.equal(app.reloads,1);assert.deepEqual(app.posts,[{endpoint:`/api/admin/connections/${accountId}/sync`,data:{}}]);
  await app.find('Disconnect').click();await app.actions[0].execute(new Map([['reason','Company allocation closed']]));assert.equal(app.posts[1].data.revision,2);
  const disconnected=fixture({responses:{'/api/admin/connections':response({linked:true,active:false,revision:3,status:'disconnected',providerAccountId:'original-account'})}});
  await disconnected.ui.connections(1);assert.ok(disconnected.find('Reconnect existing account'));assert.equal(disconnected.find('Synchronize now'),undefined);
  await disconnected.find('Reconnect existing account').click();assert.equal(disconnected.actions[0].fields[0].value,'original-account');
});

test('connection views expose no mutation buttons for read-only staff and discard retired requests',async()=>{
  const responses={'/api/admin/connections':{accounts:[{id:accountId,connection:{linked:false,revision:0}}],total:1,provider:{configured:true}}};
  const readOnly=fixture({responses,permissions:[]});await readOnly.ui.connections(1);assert.equal(readOnly.find('Link MetaApi account'),undefined);
  const retired=fixture({responses,current:false});await retired.ui.connections(1);assert.equal(retired.content.children.length,0);
});

test('operations separates local backup durability, safe error metadata, and isolated checks from actual live restore',async()=>{
  const app=fixture({query:{errorState:'all',offset:25},responses:{'/api/admin/operations':{automaticBackups:true,encrypted:true,backupIntervalHours:24,retentionCount:7,nextBackupAt:100,offsiteConfigured:false,errors:{open:1},backupKeyNotice:'Copy the private backup key separately.',recoveryNotice:'No live database replacement.',backups:[{id:accountId,createdAt:90,bytes:2048,verifiedAt:91,state:'verified'}],recentRuns:[]},'/api/admin/errors':{items:[{code:'INTERNAL_ERROR',method:'GET',route:'/api/private/:id',description:'An application request failed.',count:3,firstSeen:1,lastSeen:2}],total:26,limit:25,offset:25},post:{verified:true}}});
  await app.ui.operations(1);assert.ok(app.calls.some(url=>url.includes('state=all')&&url.includes('offset=25')));assert.match(textOf(app.content),/Not configured/);assert.equal(app.find('Restore live database'),undefined);assert.match(textOf(app.content),/INTERNAL_ERROR/);
  await app.find('Create backup & verify').click();const result=await app.actions[0].execute(new Map([['reason','Verify scheduled recovery controls']]));assert.match(result.message,/verification passed/);assert.equal(app.posts[0].endpoint,'/api/admin/operations/backup');
  await app.find('Verify recovery').click();await app.actions[1].execute(new Map([['backupId',accountId],['reason','Verify selected encrypted artifact']]));assert.deepEqual(app.posts[1],{endpoint:'/api/admin/operations/check',data:{backupId:accountId,reason:'Verify selected encrypted artifact'}});
});

test('only previously requested, unblocked account closures can open the completion action',async()=>{
  const app=fixture({responses:{'/api/admin/privacy':{items:[{userId:11,name:'Ready',email:'ready@example.com',status:'pending_closure',requestedAt:1,blockers:[],retained:[{category:'signed agreements',count:1}]},{userId:12,name:'Unsettled',status:'pending_closure',blockers:[{code:'PAYOUT_PENDING',message:'Resolve payout first'}]},{userId:13,name:'Deleted account',status:'deleted',blockers:[]}],total:3,limit:25,offset:0}}});
  await app.ui.privacy(1);assert.match(textOf(app.content),/Resolve payout first/);assert.match(textOf(app.content),/signed agreements: 1 records/);
  const actions=flatten(app.content).filter(item=>item.tag==='button'&&item.textContent==='Complete requested deletion');assert.equal(actions.length,1);
  await actions[0].click();assert.match(app.actions[0].description,/already requested account closure/);await app.actions[0].execute(new Map([['reason','All obligations reconciled']]));assert.deepEqual(app.posts,[{endpoint:'/api/admin/privacy/11/complete',data:{reason:'All obligations reconciled'}}]);
});

test('incident resolution requires an auditable privileged action and preserves the sanitized group identifier',async()=>{
  const id='a'.repeat(64),responses={'/api/admin/operations':{backups:[],recentRuns:[],errors:{open:1}},'/api/admin/errors':{items:[{id,state:'open',category:'application',code:'INTERNAL_ERROR',route:'/api/:value',method:'GET',description:'An application request failed.',count:2}],total:1,limit:25,offset:0}};
  const app=fixture({responses});await app.ui.operations(1);assert.ok(app.find('Resolve incident'));
  await app.find('Resolve incident').click();assert.match(app.actions[0].description,/history is preserved/);assert.deepEqual(app.actions[0].fields.map(field=>field.name),['reason']);
  await app.actions[0].execute(new Map([['reason','Reviewed and corrected the underlying error']]));assert.deepEqual(app.posts,[{endpoint:`/api/admin/errors/${id}/resolve`,data:{reason:'Reviewed and corrected the underlying error'}}]);
  const readOnly=fixture({responses,permissions:[]});await readOnly.ui.operations(1);assert.equal(readOnly.find('Resolve incident'),undefined);
});

test('advanced reports show actual recorded curves and native currency, with incomplete coverage distinguished from a full history',async()=>{
  const saved=globalThis.document;globalThis.document={createElementNS:(_,tag)=>new Element(tag)};
  try{
    const app=fixture({query:{userId:'7',source:'sponsored',accountId,from:'2026-01-01'},responses:{'/api/admin/performance':{account:{id:accountId,label:'Real allocation',currency:'EUR'},summary:{netProfit:125,closedTradeCount:2,winRate:50,expectancy:62.5,profitFactor:2},coverage:{historyComplete:false,status:'partial',warnings:['Only synchronized records are available.'],closedFillUnit:'Closing executions; partial closes are separate fills.'},drawdown:{observedEquity:{maxAmount:40},realizedBalance:{maxAmount:20}},equityCurve:{kind:'observed_equity',points:[{time:10,equity:1000,balance:1000},{time:20,equity:1125,balance:1125}],totalPoints:2},balanceCurve:{kind:'observed_balance',points:[],totalPoints:0},monthly:[{month:'2026-01',netProfit:125,cashFlows:500,closedTradeCount:2,winRate:50}],consistency:{positiveDays:1,negativeDays:1,flatDays:0,bestDayShareOfPositiveProfitPercent:100,appliesQualificationRule:false}}}});
    await app.ui.performance(1);assert.ok(app.calls[0].includes('source=sponsored'));assert.match(textOf(app.content),/EUR/);assert.match(textOf(app.content),/history is incomplete/);assert.match(textOf(app.content),/No recorded observations/);assert.match(textOf(app.content),/Closing fill win rate/);assert.equal(flatten(app.content).filter(item=>item.tag==='polyline').length,1);
    const blank=fixture();await blank.ui.performance(1);assert.equal(blank.calls.length,0);assert.match(textOf(blank.content),/No example performance is shown/);
  }finally{globalThis.document=saved;}
});
