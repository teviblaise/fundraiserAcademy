import test from 'node:test';
import assert from 'node:assert/strict';
import {createProfitSharingView,payoutStatement,payoutProcessingText,financialDate} from '../public/profit-sharing-view.js';

const time=Date.UTC(2026,9,23,10),due=Date.UTC(2026,9,28,10);
const id='e8036b5f-e69b-447f-a8c7-72c2a1176018';
const accountId='9322adb6-a557-4d7c-b8cc-0bd41c9974f4';
const relationshipId='8c558604-926d-49cf-a5bd-f1bd8334268e';
const receipt=()=>({id,accountId,relationshipId,amountReceivedCents:1001000,thirdPartyChargesCents:1000,qualifyingNetPayoutCents:1000000,appliedTraderShareBps:5000,traderShareCents:500000,companyShareCents:500000,cumulativeBeforeCents:0,cumulativeAfterCents:1000000,nextTraderShareBps:6000,clearedAt:time,initiationDueAt:due,initiatedCents:200000,outstandingCents:300000,overdue:true});
const progression=()=>({id:relationshipId,status:'active',currentTraderShareBps:6000,currentCompanyShareBps:4000,cumulativeQualifyingNetPayoutsCents:1000000,nextThresholdCents:2500000,nextTraderShareBps:7000});
class Element{
  constructor(tag){this.tagName=tag;this.children=[];this.listeners={};this.attributes={};this._text='';}
  append(...items){this.children.push(...items);}
  replaceChildren(...items){this.children=items;this._text='';}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join(' ');}
  set innerHTML(_){throw new Error('Unsafe HTML');}
  setAttribute(name,value){this.attributes[name]=String(value);}
  addEventListener(name,listener){this.listeners[name]=listener;}
}
const flatten=element=>[element,...element.children.flatMap(flatten)];
const fixture=()=>{const target=new Element('section'),downloads=[];const view=createProfitSharingView({document:{createElement:tag=>new Element(tag)},onDownload:item=>downloads.push(item)});return{target,downloads,view};};

test('client progress uses the next retained tier while a threshold receipt keeps the earlier applied split',()=>{
  const app=fixture(),data=receipt();app.view.render(app.target,{progressions:[progression()],receipts:[data],receiptsTotal:1,accounts:[{id:accountId,label:'Allocation one'}]});
  const text=app.target.textContent;for(const value of ['Your retained profit-sharing tier','60%','40%','$15,000.00','$25,000.00','Applied fundraiser share','50%','$5,000.00','Share on next eligible payout','Payment initiation is overdue'])assert.ok(text.includes(value),value);
  assert.match(text,/payout that reaches a threshold uses its existing tier/);assert.match(text,/Account closures, evaluation failures.*do not reset/);
  const button=flatten(app.target).find(item=>item.tagName==='button');button.listeners.click();assert.equal(app.downloads[0],data);
});

test('a downloadable statement reconciles exact cents, preserves pre-receipt tier and excludes unexpected private fields',()=>{
  const source={...receipt(),email:'private@example.com',evidence:'private staff reconciliation',externalReference:'private-bank-reference',createdBy:98,secret:'private-provider-token',userId:12};
  const result=payoutStatement(source);assert.equal(result.appliedTraderShareBps,5000);assert.equal(result.nextTraderShareBps,6000);assert.equal(result.qualifyingNetPayoutCents,1000000);assert.equal(result.thirdPartyChargesCents,1000);assert.equal(result.traderShareCents+result.companyShareCents,result.qualifyingNetPayoutCents);assert.equal(result.initiatedCents+result.outstandingCents,result.traderShareCents);
  assert.deepEqual(result.businessCalendar,{businessDays:'Monday–Friday',timeZone:'Africa/Lagos',paymentAction:'initiation'});assert.doesNotMatch(JSON.stringify(result),/private@example|private staff|private-bank|private-provider|createdBy|userId/);
  const large={...receipt(),amountReceivedCents:3000000,thirdPartyChargesCents:0,qualifyingNetPayoutCents:3000000,traderShareCents:1500000,companyShareCents:1500000,cumulativeAfterCents:3000000,nextTraderShareBps:7000,initiatedCents:0,outstandingCents:1500000};
  assert.equal(payoutStatement(large).appliedTraderShareBps,5000);assert.equal(payoutStatement(large).nextTraderShareBps,7000);
});

test('incomplete, forged, inconsistent or unsafe statement values fail before a financial download is prepared',()=>{
  for(const change of [item=>{delete item.clearedAt;},item=>{item.id='-'.repeat(36);},item=>{item.traderShareCents++;},item=>{item.qualifyingNetPayoutCents++;},item=>{item.cumulativeAfterCents++;},item=>{item.outstandingCents++;},item=>{item.appliedTraderShareBps=9999;},item=>{item.nextTraderShareBps=5000;},item=>{item.initiationDueAt=item.clearedAt;},item=>{item.amountReceivedCents=Infinity;},item=>{item.companyShareCents=-1;}]){
    const source=receipt();change(source);assert.throws(()=>payoutStatement(source),/statement/i);
  }
});

test('payment wording distinguishes a request, external initiation, completion and rejection without erasing earned entitlement',()=>{
  assert.match(payoutProcessingText({status:'approved',initiationDueAt:due,overdue:true}),/initiation is overdue.*Initiation due/s);
  assert.doesNotMatch(payoutProcessingText({status:'approved',initiationDueAt:due}),/recorded as completed|initiation recorded/);
  assert.match(payoutProcessingText({status:'approved',initiatedAt:time}),/initiation recorded.*Completion has not yet/s);
  assert.match(payoutProcessingText({status:'paid',initiatedAt:time}),/completed outside/);
  assert.match(payoutProcessingText({status:'rejected'}),/underlying earned entitlement is not erased/);
  assert.equal(payoutProcessingText(null),'');assert.equal(financialDate(Infinity),'Not recorded');assert.match(financialDate(time),/11:00.*WAT/);
});

test('ended and empty relationships explain written reinstatement and do not invent funding or qualifying receipts',()=>{
  const app=fixture();app.view.render(app.target,{progressions:[{...progression(),status:'terminated'}],receipts:[],receiptsTotal:0,accounts:[]});
  assert.match(app.target.textContent,/Accrued unpaid entitlements remain payable/);assert.match(app.target.textContent,/reinstatement must be expressly agreed in writing/);assert.match(app.target.textContent,/No cleared payout statements/);assert.match(app.target.textContent,/Demo profits and live account equity do not count/);
  app.view.render(app.target,{accounts:[{id:accountId,profitSharingPolicy:'cumulative_high_water',traderShareBps:3750}]});assert.match(app.target.textContent,/No progressive profit-sharing relationship/);assert.match(app.target.textContent,/Existing account terms/);assert.equal(flatten(app.target).some(item=>item.tagName==='progress'),false);
});

test('untrusted account labels and ignored staff fields stay text and source updates replace old financial cards',()=>{
  const app=fixture(),attack='<img src=x onerror=steal()>',source={...receipt(),evidence:'private note must stay private'};
  app.view.render(app.target,{progressions:[progression()],receipts:[source],accounts:[{id:accountId,label:attack}]});assert.ok(app.target.textContent.includes(attack));assert.doesNotMatch(app.target.textContent,/private note must/);assert.equal(flatten(app.target).some(item=>item.tagName==='img'),false);
  app.view.render(app.target,{progressions:[],receipts:[],receiptsTotal:0,accounts:[]});assert.equal(app.target.textContent.includes(attack),false);assert.equal(flatten(app.target).filter(item=>item.tagName==='button').length,0);
});
