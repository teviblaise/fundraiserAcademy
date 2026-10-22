import test from 'node:test';
import assert from 'node:assert/strict';
import {createAdminExtensions,performanceFilters,currencyAmount,operationalReport} from '../public/admin-extensions.js';

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
  const content=new Element('main'),calls=[],posts=[],actions=[],notices=[];let page={...query},reloads=0,unlocks=0,active=current;
  const context={content,api:async endpoint=>{calls.push(endpoint);const key=endpoint.split('?')[0];if(!(key in responses))throw new Error('Unexpected request '+endpoint);return structuredClone(typeof responses[key]==='function'?responses[key](endpoint):responses[key]);},post:async(endpoint,data)=>{posts.push({endpoint,data});return typeof responses.post==='function'?responses.post(endpoint,data):responses.post||{};},
    can:permission=>permissions.includes(permission),node:(tag,classes='',value='')=>{const element=new Element(tag,value===null?'':String(value));element.className=classes;return element;},
    card:(title,description)=>{const element=new Element('section',title||'');if(description)element.append(new Element('p',description));return element;},
    table:(columns,rows)=>{const element=new Element('table');for(const row of rows){const tr=new Element('tr');for(const column of columns)tr.append(column.value(row));element.append(tr);}return element;},
    detailGrid:values=>{const element=new Element('dl');for(const [key,value]of values)element.append(new Element('dt',key),new Element('dd',value));return element;},
    button:(label,handler)=>{const button=new Element('button',label);button.click=handler;return button;},
    openAction:config=>{actions.push(config);},notify:message=>notices.push(message),isCurrent:()=>active,getQuery:()=>({...page}),setQuery:values=>{page={...values};},reload:async()=>{reloads++;},ensureUnlocked:async()=>{unlocks++;},date:value=>typeof value==='number'?`time:${value}`:'Not recorded',percent:value=>typeof value==='number'?`${value}%`:'Not recorded'};
  const ui=createAdminExtensions(context);
  return {ui,content,calls,posts,actions,notices,retire(){active=false;},get reloads(){return reloads;},get unlocks(){return unlocks;},get query(){return page;},find:label=>flatten(content).find(element=>element.tag==='button'&&element.textContent===label)};
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

const diagnostic={id:accountId,startedAt:1000,completedAt:2000,state:'critical',database:'ok',integrity:'ok',foreignKeys:'failed',storageWritable:'ok',failureCode:'DIAGNOSTIC_DATABASE_FAILED'};
const operationalResponses=health=>({'/api/admin/operations':{health,backups:[],recentRuns:[],errors:{open:0}},'/api/admin/errors':{items:[],total:0,limit:25,offset:0}});

test('operational health makes current critical findings and remediation visible without HTML injection or provider claims',async()=>{
  const health={checkedAt:3000,overall:'critical',metrics:{uptimeSeconds:90061,rssBytes:1048576,heapUsedBytes:524288,databaseBytes:2048,walBytes:0,storageFreeBytes:1024,storageTotalBytes:1073741824},checks:[{id:'storage',label:'Private storage',state:'critical',summary:'<img src=x onerror=steal()>',action:'Free disk space before writing new records.'}],lastDiagnostic:diagnostic,diagnosticRuns:[diagnostic]};
  const app=fixture({responses:operationalResponses(health)});await app.ui.operations(1);
  const visible=textOf(app.content);assert.match(visible,/Operational health/);assert.match(visible,/Critical/);assert.match(visible,/Free disk space/);assert.match(visible,/<img src=x onerror=steal\(\)>/);assert.match(visible,/1d 1h/);assert.match(visible,/1 MiB/);assert.match(visible,/DIAGNOSTIC_DATABASE_FAILED/);assert.match(visible,/do not confirm provider availability/);assert.match(visible,/No offsite|offsite backups/);
  assert.equal(flatten(app.content).some(item=>item.tag==='img'),false);assert.ok(app.find('Run diagnostics'));assert.ok(app.find('Download readiness report'));
  const healthCard=app.content.children[0],checks=flatten(healthCard).filter(item=>item.tag==='article');assert.equal(checks.length,1);assert.match(textOf(checks[0]),/Private storage.*Critical.*Free disk space/);assert.match(textOf(checks[0]),/Next action/);assert.equal(flatten(healthCard).some(item=>item.tag==='table'),false,'readiness actions use wrapping cards rather than a horizontally scrolling table');
  await app.find('Refresh health checks').click();assert.equal(app.reloads,1);
});

test('readiness remains unavailable with incomplete data and restricted staff cannot start or download diagnostics',async()=>{
  const app=fixture({responses:operationalResponses(null),permissions:[]});await app.ui.operations(1);
  assert.match(textOf(app.content),/Unavailable/);assert.match(textOf(app.content),/No health checks are available/);assert.match(textOf(app.content),/Diagnostics have not been run/);assert.equal(app.find('Run diagnostics'),undefined);assert.equal(app.find('Download readiness report'),undefined);assert.equal(app.find('Create backup & verify'),undefined);
  const retired=fixture({responses:operationalResponses({checkedAt:3000}),current:false});await retired.ui.operations(1);assert.equal(retired.content.children.length,0);
});

test('active diagnostic jobs stay marked as running and disable duplicate requests',async()=>{
  const app=fixture({responses:operationalResponses({checkedAt:3000,diagnosticRunning:true,diagnosticRuns:[{...diagnostic,state:'running',completedAt:null,integrity:'not_checked',foreignKeys:'not_checked',storageWritable:'not_checked',failureCode:null}]})});await app.ui.operations(1);
  assert.match(textOf(app.content),/diagnostic is running/);assert.match(textOf(app.content),/Running/);assert.equal(app.find('Run diagnostics').disabled,true);await app.find('Run diagnostics').click();assert.equal(app.actions.length,0);assert.equal(operationalReport({diagnosticRunning:true,diagnosticRuns:[{state:'running'}]}).diagnosticRuns[0].state,'running');
});

test('manual diagnostics use an audited action and distinguish local success, recorded failure, and request failure',async()=>{
  for(const state of ['ok','critical','warning']){
    const app=fixture({responses:{...operationalResponses({checkedAt:3000}),post:{...diagnostic,state}}});await app.ui.operations(1);await app.find('Run diagnostics').click();
    const action=app.actions[0];assert.deepEqual(action.fields.map(field=>field.name),['reason']);assert.match(action.description,/Check database integrity and relationships/);const result=await action.execute(new Map([['reason','Investigate the current storage warning']]));
    assert.deepEqual(app.posts,[{endpoint:'/api/admin/operations/diagnose',data:{reason:'Investigate the current storage warning'}}]);assert.match(result.message,state==='ok'?/diagnostics passed/:state==='critical'?/found a problem/:/need attention/);
  }
  const failure=fixture({responses:{...operationalResponses({checkedAt:3000}),post:()=>{throw new Error('A diagnostic is already running.');}}});await failure.ui.operations(1);await failure.find('Run diagnostics').click();await assert.rejects(failure.actions[0].execute(new Map([['reason','Investigate safely']])),/already running/);
});

test('readiness JSON is an explicit bounded allowlist, excluding private server fields and invalid diagnostic details',()=>{
  const report=operationalReport({checkedAt:3000,overall:'healthy',apiKey:'private-api-key',path:'/private/database',metrics:{rssBytes:1024,heapUsedBytes:Infinity,storageFreeBytes:-1,key:'private-metric-secret'},checks:[null,{id:'email',label:'Email',state:'ok',summary:'Configured',action:'Confirm inbox delivery',token:'private-token'}],lastDiagnostic:{...diagnostic,message:'private-error-body',providerAccountId:'private-provider-id'},diagnosticRuns:[{...diagnostic,failureCode:'private-error-token'}]});
  const json=JSON.stringify(report);assert.doesNotMatch(json,/private-|\/private/);assert.equal(report.metrics.rssBytes,1024);assert.equal(report.metrics.heapUsedBytes,null);assert.equal(report.metrics.storageFreeBytes,null);assert.equal(report.lastDiagnostic.foreignKeys,'failed');assert.equal(report.diagnosticRuns[0].failureCode,null);
  assert.equal(operationalReport({checks:Array(200).fill({id:'x',label:'x',summary:'x'.repeat(2000)})}).checks.length,100);assert.equal(operationalReport({checks:[{summary:'x'.repeat(2000)}]}).checks[0].summary.length,1000);assert.equal(operationalReport({}).checkedAt,null);
});

test('readiness report downloads safe JSON, cleans browser URLs, and ignores retired page controls',async()=>{
  const savedDocument=globalThis.document,savedCreate=URL.createObjectURL,savedRevoke=URL.revokeObjectURL,savedTimeout=globalThis.setTimeout;
  const blobs=[],anchors=[],revoked=[];let appended=0,removed=0;
  URL.createObjectURL=blob=>{blobs.push(blob);return 'blob:readiness';};URL.revokeObjectURL=url=>revoked.push(url);globalThis.setTimeout=callback=>{callback();return 0;};
  globalThis.document={createElement:tag=>{assert.equal(tag,'a');const anchor={click(){this.clicked=true;},remove(){removed++;}};anchors.push(anchor);return anchor;},body:{append(){appended++;}}};
  try{
    const app=fixture({responses:operationalResponses({checkedAt:Date.UTC(2026,9,22),overall:'attention',metrics:{rssBytes:2048},apiToken:'private-token'})});await app.ui.operations(1);const trigger=app.find('Download readiness report');await trigger.click();
    assert.equal(blobs.length,1);assert.equal(blobs[0].type,'application/json');assert.doesNotMatch(await blobs[0].text(),/private-token/);assert.equal(anchors[0].download,'fundraiser-academy-operations-2026-10-22.json');assert.equal(anchors[0].clicked,true);assert.equal(appended,1);assert.equal(removed,1);assert.deepEqual(revoked,['blob:readiness']);
    app.retire();await trigger.click();await app.find('Refresh health checks').click();await app.find('Run diagnostics').click();assert.equal(blobs.length,1);assert.equal(app.reloads,0);assert.equal(app.actions.length,0);
    const broken=fixture({responses:operationalResponses({checkedAt:3000})});await broken.ui.operations(1);URL.createObjectURL=()=>{throw new Error('private browser exception');};await broken.find('Download readiness report').click();assert.match(broken.notices[0],/could not be downloaded/);assert.doesNotMatch(broken.notices[0],/private/);
  }finally{globalThis.document=savedDocument;URL.createObjectURL=savedCreate;URL.revokeObjectURL=savedRevoke;globalThis.setTimeout=savedTimeout;}
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
