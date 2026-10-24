import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createAdminProfitSharing,lagosTimestamp,reinstatementDocument} from '../public/admin-profit-sharing.js';

const accountId='9322adb6-a557-4d7c-b8cc-0bd41c9974f4',time=Date.UTC(2026,9,23,10);
class Element{
 constructor(tag='div',value=''){this.tag=tag;this.textContent=value;this.children=[];this.listeners={};}
 append(...items){this.children.push(...items);}
  click(){this.clicked=true;}
  remove(){}
 set innerHTML(_){throw new Error('Unsafe HTML rendering');}
}
const flatten=element=>element instanceof Element?[element,...element.children.flatMap(flatten)]:[];
const textOf=element=>element instanceof Element?[element.textContent,...element.children.map(textOf)].join(' '):String(element??'');
function fixture({permissions=['finance.read','finance.write'],current=true,response={}}={}){
 const actions=[],posts=[],calls=[],content=new Element('main');
 const ctx={can:permission=>permissions.includes(permission),api:async endpoint=>{calls.push(endpoint);return response;},post:async(endpoint,data)=>{posts.push({endpoint,data});return response;},content,isCurrent:()=>current,
 node:(tag,classes='',value='')=>new Element(tag,value),card:(title,description='')=>{const result=new Element('section',title);result.append(new Element('p',description));return result;},
 table:(columns,rows)=>{const result=new Element('table');for(const row of rows){const tr=new Element('tr');for(const column of columns)tr.append(column.value(row));result.append(tr);}return result;},detailGrid:entries=>{const result=new Element('dl');for(const[key,value]of entries)result.append(new Element('dt',key),new Element('dd',value));return result;},
 button:(label,handler)=>{const result=new Element('button',label);result.click=handler;return result;},openAction:config=>{actions.push(config);return config;},cents:value=>Number.isSafeInteger(value)?`$${(value/100).toFixed(2)}`:'Not recorded',percent:value=>Number.isFinite(value)?`${value}%`:'Not recorded'};
 const ui=createAdminProfitSharing(ctx);return{ui,actions,posts,calls,content,find:(root,label)=>flatten(root).find(item=>item.tag==='button'&&item.textContent===label)};
}
const form=values=>new Map(Object.entries(values));
const progression={id:'8c558604-926d-49cf-a5bd-f1bd8334268e',status:'active',revision:4,currentTraderShareBps:6000,currentCompanyShareBps:4000,cumulativeQualifyingNetPayoutsCents:1000000,nextThresholdCents:2500000,nextTraderShareBps:7000,startedAt:time,terminatedAt:null,contractVersion:'progressive-profit-sharing-v1'};

test('administrative receipt timestamps are interpreted in Africa/Lagos rather than the browser timezone',()=>{
 assert.equal(lagosTimestamp('2026-10-23T11:00'),time);assert.equal(lagosTimestamp('2026-10-23T11:00:59'),time+59000);
 for(const input of ['2026-02-30T11:00','2026-10-23','2026-10-23T11:00Z','2026-10-23T25:00','2026-10-23T11:60',null,{}])assert.throws(()=>lagosTimestamp(input),/Africa\/Lagos/);
});

test('new progressive account entry derives its tier on the server and never posts an arbitrary fixed split',async()=>{
 const app=fixture();app.ui.createAccountAction();const action=app.actions[0];assert.equal(action.fields.some(field=>field.name==='traderShare'||field.name==='traderShareBps'),false);
 await action.execute(form({userId:'17',firmName:'Approved firm',label:'New account',accountSize:'10000.00',evidence:'External allocation evidence',reason:'Record approved allocation'}));
 assert.deepEqual(app.posts,[{endpoint:'/api/admin/accounts',data:{userId:17,firmName:'Approved firm',label:'New account',accountSizeCents:1000000,profitSharingPolicy:'progressive_cleared',evidence:'External allocation evidence',reason:'Record approved allocation'}}]);
 const readonly=fixture({permissions:['finance.read']});readonly.ui.createAccountAction();assert.equal(readonly.actions.length,0);
});

test('cleared receipt entry requires actual cash acknowledgement, agreed charges and exact cents',async()=>{
 const app=fixture(),account={id:accountId,sharingModel:'progressive_cleared'};app.ui.receiptAction(account);const action=app.actions[0];
 const valid={amountReceived:'10010.25',thirdPartyCharges:'10.25',chargesAgreementReference:'Agreed fee reference',externalReference:'PROP-CLEARED-123',clearedAt:'2026-10-23T11:00',evidence:'Actual cleared bank evidence',clearedConfirmed:'on',reason:'Reconcile actual receipt'};
 assert.throws(()=>action.execute(form({...valid,clearedConfirmed:''})),/actually|cleared/);
 assert.throws(()=>action.execute(form({...valid,chargesAgreementReference:''})),/agreement reference/);
 assert.throws(()=>action.execute(form({...valid,thirdPartyCharges:'10010.26'})),/cannot exceed/);
 await action.execute(form(valid));assert.deepEqual(app.posts[0],{endpoint:`/api/admin/accounts/${accountId}/receipts`,data:{amountReceivedCents:1001025,thirdPartyChargesCents:1025,externalReference:'PROP-CLEARED-123',clearedAt:time,evidence:'Actual cleared bank evidence',chargesAgreementReference:'Agreed fee reference',reason:'Reconcile actual receipt'}});
 await action.execute(form({...valid,amountReceived:'10.25',thirdPartyCharges:'10.25'}));assert.equal(app.posts[1].data.amountReceivedCents,1025);assert.equal(app.posts[1].data.thirdPartyChargesCents,1025,'a fully charged actual receipt can be recorded with zero qualifying entitlement');
 const legacy=fixture();legacy.ui.receiptAction({id:accountId,sharingModel:'legacy_fixed'});assert.equal(legacy.actions.length,0);
});

test('receipt and retained-tier cards show the previous applied share, next share and outstanding initiation',()=>{
 const app=fixture();const card=app.ui.receiptsCard([{id:'receipt',externalReference:'<img onerror=steal()>',amountReceivedCents:1000000,thirdPartyChargesCents:0,qualifyingNetPayoutCents:1000000,appliedTraderShareBps:5000,traderShareCents:500000,companyShareCents:500000,cumulativeBeforeCents:0,cumulativeAfterCents:1000000,nextTraderShareBps:6000,clearedAt:time,initiationDueAt:time+5*86400000,outstandingCents:500000,overdue:true}]);
 const value=textOf(card);assert.match(value,/Applied fundraiser share 50%/);assert.match(value,/next receipt 60%/);assert.match(value,/Initiation outstanding \$5000.00/);assert.match(value,/overdue/);assert.ok(value.includes('<img onerror=steal()>'));assert.equal(flatten(card).some(item=>item.tag==='img'),false);
 const tier=app.ui.progressionCard(progression,17);assert.match(textOf(tier),/60% \/ 40%/);assert.match(textOf(tier),/\$15000.00/);assert.match(textOf(tier),/previous tier/);
});

test('payment initiation is an explicit approved external action with a revision, reference and immutable receipt deadline',async()=>{
 const app=fixture(),item={id:accountId,status:'approved',revision:3,amountCents:500000,initiationDueAt:time+5*86400000};
 const button=app.ui.initiationControl(item);assert.ok(button);button.click();const action=app.actions[0];
 assert.throws(()=>action.execute(form({externalInitiationReference:'BANK-123',reason:'Record actual payment'})),/actually initiated/);
 assert.throws(()=>action.execute(form({initiationConfirmed:'on',externalInitiationReference:' ',reason:'Record actual payment'})),/actual external initiation reference/);
 await action.execute(form({initiationConfirmed:'on',externalInitiationReference:' BANK-123 ',initiatedAt:'2026-10-23T11:00',reason:'Record actual payment'}));
 assert.deepEqual(app.posts[0],{endpoint:`/api/admin/payouts/${accountId}/initiate`,data:{revision:3,externalInitiationReference:'BANK-123',initiatedAt:time,reason:'Record actual payment'}});
 for(const row of [{...item,status:'requested'},{...item,initiatedAt:time},{...item,status:'paid'}])assert.equal(app.ui.initiationControl(row),null);
 assert.match(app.ui.payoutTiming({...item,overdue:true}),/Not initiated.*OVERDUE/);assert.match(app.ui.payoutTiming({...item,initiatedAt:time}),/Initiated/);
});

test('lifecycle controls distinguish termination, proposed reinstatement document and recorded mutual terms',async()=>{
 const app=fixture(),active=app.ui.progressionCard(progression,17);app.find(active,'Record relationship termination').click();let action=app.actions[0];
 assert.throws(()=>action.execute(form({reason:'Ended agreement'})),/actual relationship termination/);await action.execute(form({terminationConfirmed:'on',reason:'Ended agreement'}));assert.deepEqual(app.posts[0],{endpoint:'/api/admin/traders/17/profit-sharing',data:{action:'terminate',revision:4,reason:'Ended agreement'}});
 const ended=app.ui.progressionCard({...progression,status:'terminated',terminatedAt:time},17);assert.ok(app.find(ended,'Prepare reinstatement agreement'));app.find(ended,'Record written reinstatement terms').click();action=app.actions[1];
 assert.match(action.description,/fresh signature and current sponsorship approval/);assert.throws(()=>action.execute(form({startingTraderShareBps:'6000',writtenAgreementReference:'New mutual agreement',reason:'Reinstate'})),/written agreement of both/);
 await action.execute(form({startingTraderShareBps:'6000',writtenAgreementReference:'New mutual agreement',traderConsentConfirmed:'on',reason:'Reinstate'}));assert.equal(app.posts[1].data.startingTraderShareBps,6000);assert.equal(app.posts[1].data.traderConsentConfirmed,true);assert.equal(app.posts[1].data.revision,4);
 const readonly=fixture({permissions:['finance.read']});assert.equal(flatten(readonly.ui.progressionCard(progression,17)).some(item=>item.tag==='button'),false);
});

test('prepared reinstatement downloads require exact document bytes and hash before normal publication and fundraiser consent',async()=>{
 const content='Authorized agreement with actual written reinstatement terms.';const document={format:'text',version:'reinstatement-v1',fileName:'reinstatement-v1.txt',contentBase64:Buffer.from(content).toString('base64'),hash:createHash('sha256').update(content).digest('hex')};
 assert.deepEqual(await reinstatementDocument({document}),{content,fileName:'reinstatement-v1.txt',version:'reinstatement-v1',hash:document.hash});
 for(const change of [{hash:'a'.repeat(64)},{fileName:'../../private.txt'},{contentBase64:'broken!'},{format:'pdf'}])await assert.rejects(reinstatementDocument({document:{...document,...change}}),/agreement|hash/i);
});

test('private trader progression ignores stale navigation responses and remains unavailable without finance permission',async()=>{
 const stale=fixture({current:false,response:{progression,relationships:[progression]}});await stale.ui.traderProgression(1,17);assert.equal(stale.calls.length,1);assert.equal(stale.content.children.length,0);
 const denied=fixture({permissions:[]});await denied.ui.traderProgression(1,17);assert.equal(denied.calls.length,0);
 const current=fixture({response:{progression,relationships:[progression]}});await current.ui.traderProgression(1,17);assert.match(textOf(current.content),/60% \/ 40%/);
});

test('a prepared private agreement is published only after a separate authorization and only to its bound recipient',async()=>{
 const originalDocument=globalThis.document;globalThis.document={body:new Element('body'),createElement:tag=>new Element(tag)};
 try{
  const content='Exact personal reinstatement agreement';const document={format:'text',version:'reinstatement-v1',title:'Personal reinstatement',fileName:'reinstatement-v1.txt',contentBase64:Buffer.from(content).toString('base64'),hash:createHash('sha256').update(content).digest('hex')};
  const ended={...progression,status:'terminated'},result={document,recipientUserId:17,previousRelationshipId:progression.id};
  const app=fixture({permissions:['finance.read','finance.write','contracts.publish'],response:result});app.ui.prepareReinstatementAction(ended,17);
  const prepared=await app.actions[0].execute(form({startingTraderShareBps:'6000',writtenAgreementReference:'Mutual written reference',reason:'Prepare proposed terms'}));assert.match(prepared.message,/Personal agreement.*Fundraiser #17/);assert.equal(app.posts.length,1,'preparation must not publish');
  assert.equal(app.find(app.ui.progressionCard(ended,99),'Publish prepared personal agreement'),undefined);
  const button=app.find(app.ui.progressionCard(ended,17),'Publish prepared personal agreement');assert.ok(button);button.click();const action=app.actions[1];
  await assert.rejects(action.execute(form({reason:'Publish reviewed terms'})),/authorization/);assert.equal(app.posts.length,1);
  await action.execute(form({authorized:'on',reason:'Publish reviewed terms'}));assert.deepEqual(app.posts[1],{endpoint:'/api/admin/contracts',data:{contentBase64:document.contentBase64,format:'text',version:'reinstatement-v1',title:'Personal reinstatement',fileName:'reinstatement-v1.txt',recipientUserId:17,reason:'Publish reviewed terms'}});
  assert.equal(app.find(app.ui.progressionCard(ended,17),'Publish prepared personal agreement'),undefined,'the cached document clears after publication');
  const wrong=fixture({response:{...result,recipientUserId:99}});wrong.ui.prepareReinstatementAction(ended,17);await assert.rejects(wrong.actions[0].execute(form({startingTraderShareBps:'6000',writtenAgreementReference:'Ref',reason:'Prepare'})),/does not match/);
 }finally{globalThis.document=originalDocument;}
});
