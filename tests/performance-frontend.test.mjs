import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {performanceMoney,performanceChartModel,validatePerformanceReport,initializePerformancePage} from '../public/performance.js';

const html=readFileSync(new URL('../public/performance.html',import.meta.url),'utf8');
const time=Date.UTC(2026,9,22,10),accountId='c858542d-c420-4272-b29e-e1b574026639';
function report(){return{generatedAt:time,source:'assessment',account:{currency:'USD',label:'Current assessment',attempt:'current'},range:{from:null,to:time+1},
 summary:{closedTradeCount:2,winningTrades:1,losingTrades:1,netProfit:50,grossProfit:100,grossLoss:50,winRate:50,expectancy:25,profitFactor:2,profitFactorStatus:'finite',cashFlows:0},
 monthly:[{month:'2026-10',netProfit:50,cashFlows:0,closedTradeCount:2,winRate:50}],daily:[{date:'2026-10-21',netProfit:50,cashFlows:0,closedTradeCount:2,winRate:50}],
 consistency:{recordedTradingDays:1,positiveDays:1,negativeDays:0,flatDays:0,profitableDaySharePercent:100,bestDay:'2026-10-21',bestDayProfit:50,bestDayShareOfPositiveProfitPercent:100,largestWinningFillSharePercent:100,explanation:'Descriptive only, not a pass rule.'},
 drawdown:{observedEquity:{observations:2,maxAmount:75,maxPercent:0.75},cashFlowAdjustedEquity:{observations:2,maxAmount:75,maxPercent:0.75},realizedBalance:{observations:2,maxAmount:50,maxPercent:0.5},cashFlowAdjustment:'External flows are excluded.'},
 equityCurve:{kind:'observed_equity',points:[{time:time-1000,equity:10000,balance:10000},{time,equity:9925,balance:10050}],totalPoints:2,downsampled:false,description:'Recorded observations only.'},
 balanceCurve:{kind:'realized_balance',points:[{time:time-1000,balance:10100},{time,balance:10050}],totalPoints:2,downsampled:false,description:'Closed-fill balance, not marked equity.'},
 coverage:{status:'available',historyComplete:true,warnings:[],closedFillUnit:'Recorded closed assessment positions.',lastSuccessfulSyncAt:null,stale:false}};}

test('currency display never assumes USD for unverified sponsored currency or invalid money',()=>{
 assert.match(performanceMoney(123.45,'USD'),/123\.45/);assert.match(performanceMoney(3.125,'USDT'),/3\.125 USDT/);
 for(const currency of [null,undefined,'usd','<script>',''])assert.equal(performanceMoney(123,currency),'—');
 for(const value of [NaN,Infinity,'12',null,1e16])assert.equal(performanceMoney(value,'USD'),'—');
});

test('chart geometry uses actual observations in timestamp order without manufacturing intermediate equity',()=>{
 const input=[{time:time+1000,equity:105},{time:time-1000,equity:100},{time,equity:90}],snapshot=structuredClone(input);
 const model=performanceChartModel(input,'equity');assert.equal(model.points.length,3);assert.equal(model.points[0].value,100);assert.equal(model.points[1].value,90);assert.equal(model.points[2].value,105);assert.equal(model.minimum,90);assert.equal(model.maximum,105);assert.deepEqual(input,snapshot);
 assert.equal(model.path.match(/[ML]/g).length,3);assert.ok(model.points.every(point=>Number.isFinite(point.x)&&Number.isFinite(point.y)));
 const single=performanceChartModel([{time,balance:10000}],'balance');assert.equal(single.points.length,1);assert.equal(single.points[0].x,360);assert.equal(single.points[0].y,130);assert.equal(performanceChartModel([],'equity').points.length,0);
 for(const points of [[{time,equity:NaN}],[{time:-1,equity:1}],[null],Array(2001).fill({time,equity:1})])assert.throws(()=>performanceChartModel(points,'equity'));
});

test('malformed or unbounded server charts cannot be shown as a successful report',()=>{
 assert.equal(validatePerformanceReport(report()).source,'assessment');
 const invalid=[null,{}, {...report(),coverage:{status:'synthetic'}},{...report(),equityCurve:{points:null,totalPoints:1}},{...report(),balanceCurve:{points:[{time,balance:100}],totalPoints:0}},{...report(),monthly:[{month:'<img>',netProfit:1}]},{...report(),daily:[{date:'2026-10-22',netProfit:Infinity}]}];
 for(const value of invalid)assert.throws(()=>validatePerformanceReport(value),/could not be read/);
});

class Element{
 constructor(tag='div',id=''){this.tagName=tag;this.id=id;this.value='';this.hidden=false;this.disabled=false;this.required=false;this.children=[];this.listeners=new Map();this.attributes=new Map();this._text='';}
 set textContent(value){this._text=String(value);this.children=[];}
 get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
 set innerHTML(_){throw new Error('Unsafe HTML rendering');}
 append(...children){this.children.push(...children);}
 replaceChildren(...children){this._text='';this.children=children;}
 addEventListener(name,callback){this.listeners.set(name,callback);}
 async event(name,data={}){return this.listeners.get(name)?.({preventDefault(){},...data});}
 setAttribute(name,value){this.attributes.set(name,String(value));}
 descendants(tag){return this.children.flatMap(child=>[...(child.tagName===tag?[child]:[]),...child.descendants(tag)]);}
}
function fixture(handler=()=>null,{search=''}={}){
 const nodes=new Map();for(const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)){const node=new Element(match[1],match[3]);node.hidden=/\bhidden(?:\s|$|=)/.test(match[2]);nodes.set(node.id,node);}nodes.get('performance-source').value='assessment';
 const calls=[],events=new Map(),redirects=[];
 const api=initializePerformancePage({document:{getElementById:id=>nodes.get(id),createElement:tag=>new Element(tag),createElementNS:(_,tag)=>new Element(tag)},window:{location:{search,assign:value=>redirects.push(value)},addEventListener:(name,callback)=>events.set(name,callback)},fetchFn:async(endpoint,options)=>{calls.push({endpoint,options});const response=await handler(endpoint);const value=response??{status:200,body:endpoint==='/api/sponsorship'?{funding:{accounts:[{id:accountId,label:'Funded allocation'}]}}:report()};return{status:value.status,ok:value.status>=200&&value.status<300,json:async()=>value.body};}});
 return{nodes,calls,redirects,api,async settle(){for(let i=0;i<60;i++)await Promise.resolve();},async pagehide(){await events.get('pagehide')({});},async pageshow(){await events.get('pageshow')({persisted:true});}};
}

test('performance page renders real observed equity, distinct realized balance, costs and descriptive consistency',async()=>{
 const page=fixture();await page.settle();assert.equal(page.nodes.get('performance-report').hidden,false);
 assert.match(page.nodes.get('performance-summary').textContent,/\$50\.00/);assert.match(page.nodes.get('performance-summary').textContent,/Closing fill win rate/);assert.match(page.nodes.get('performance-summary').textContent,/Recorded closed assessment positions/);
 assert.equal(page.nodes.get('performance-equity-chart').descendants('svg').length,1);assert.equal(page.nodes.get('performance-equity-chart').descendants('path').length,1);assert.match(page.nodes.get('performance-balance-description').textContent,/not marked equity/);assert.equal(page.nodes.get('performance-balance-heading').textContent,'Realized balance');assert.match(page.nodes.get('performance-consistency-note').textContent,/not a pass rule/);
 const request=page.calls.find(call=>call.endpoint.startsWith('/api/performance'));assert.equal(request.options.credentials,'same-origin');assert.equal(request.options.cache,'no-store');assert.equal(request.options.referrerPolicy,'no-referrer');assert.ok(request.options.signal instanceof AbortSignal);
});

test('missing sponsored connection displays coverage and empty curves without fabricated earnings or currency',async()=>{
 const payload=report();payload.source='sponsored';payload.account={id:accountId,label:'Awaiting connection',currency:null};payload.coverage={status:'not_connected',warnings:['Connect the assigned account first.']};payload.equityCurve.points=[];payload.equityCurve.totalPoints=0;payload.balanceCurve.points=[];payload.balanceCurve.totalPoints=0;payload.monthly=[];payload.daily=[];
 const page=fixture(endpoint=>endpoint.startsWith('/api/performance')?{status:200,body:payload}:null);await page.settle();assert.equal(page.nodes.get('performance-coverage-badge').textContent,'Awaiting account connection');assert.match(page.nodes.get('performance-report-range').textContent,/Currency not verified/);assert.match(page.nodes.get('performance-warnings').textContent,/Connect/);assert.equal(page.nodes.get('performance-equity-chart').descendants('svg').length,0);assert.doesNotMatch(page.nodes.get('performance-summary').textContent,/\$|50\.00/);
});

test('company labels, provider warnings and explanations stay text rather than executable markup',async()=>{
 const attack='<img src=x onerror=alert(1)>',payload=report();payload.account.label=attack;payload.coverage.warnings=[attack];payload.consistency.explanation=attack;
 const page=fixture(endpoint=>endpoint.startsWith('/api/performance')?{status:200,body:payload}:null);await page.settle();assert.equal(page.nodes.get('performance-report-title').textContent,attack);assert.match(page.nodes.get('performance-warnings').textContent,/<img/);assert.equal(page.nodes.get('performance-warnings').descendants('img').length,0);assert.equal(page.nodes.get('performance-consistency-note').textContent,attack);
});

test('report filters honor owned account links and encode date filters, never arbitrary account IDs',async()=>{
 const page=fixture(()=>null,{search:`?source=sponsored&accountId=${accountId}&from=2026-10-01&to=2026-10-22`});await page.settle();
 assert.equal(page.nodes.get('performance-source').value,'sponsored');assert.equal(page.nodes.get('performance-account-field').hidden,false);assert.equal(page.nodes.get('performance-account').required,true);
 const query=new URL('https://local.test'+page.calls.find(call=>call.endpoint.startsWith('/api/performance')).endpoint).searchParams;assert.equal(query.get('source'),'sponsored');assert.equal(query.get('accountId'),accountId);assert.equal(query.get('from'),'2026-10-01');assert.equal(query.get('to'),'2026-10-22');
 const foreign=fixture(()=>null,{search:'?source=sponsored&accountId=30097831-38a1-4c78-8aa8-72778f0182ab'});await foreign.settle();assert.equal(foreign.calls.some(call=>call.endpoint.startsWith('/api/performance')),false);assert.match(foreign.nodes.get('performance-status').textContent,/Choose one of your sponsored accounts/);
});

test('late requests and expired sessions cannot leave a previous private report on a hidden or restored page',async()=>{
 let mode='ok',resolve;const page=fixture(endpoint=>endpoint.startsWith('/api/performance')?(mode==='late'?new Promise(done=>{resolve=done;}):mode==='denied'?{status:401,body:{error:'Private server diagnostic'}}:null):null);await page.settle();
 mode='late';const old=page.api.loadReport();await page.settle();await page.pagehide();assert.equal(page.nodes.get('performance-report').hidden,true);assert.equal(page.nodes.get('performance-summary').children.length,0);
 mode='denied';await page.pageshow();await page.settle();resolve({status:200,body:report()});await old;assert.equal(page.nodes.get('performance-report').hidden,true);assert.ok(page.redirects.includes('/login.html'));assert.doesNotMatch(page.nodes.get('performance-status').textContent,/diagnostic/);
});
