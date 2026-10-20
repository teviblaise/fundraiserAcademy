import test from 'node:test';
import assert from 'node:assert/strict';
import { createAdminApi, AdminRequestError, administrativePermissions, pageRows, decimalToUnits, positiveInteger, queryString, csvDownloadName } from '../public/admin-api.js';

const response = (status, result) => ({ status, ok: status >= 200 && status < 300, json: async () => result });

test('admin requests stay same-origin, disable caching/referrers, and encode mutations as website JSON',async()=>{
  const calls=[];
  const request=createAdminApi({fetchFn:async(...args)=>{calls.push(args);return response(200,{saved:true});}});
  const body={status:'suspended',reason:'Account review requested'};
  assert.deepEqual(await request('/api/admin/traders/42/status',body),{saved:true});
  assert.equal(calls[0][0],'/api/admin/traders/42/status');
  const options=calls[0][1];assert.equal(options.method,'POST');assert.equal(options.credentials,'same-origin');assert.equal(options.cache,'no-store');assert.equal(options.referrerPolicy,'no-referrer');assert.equal(options.headers['X-Requested-With'],'FundraiserAcademy');assert.equal(options.headers['Content-Type'],'application/json');assert.deepEqual(JSON.parse(options.body),body);assert.ok(options.signal instanceof AbortSignal);
  await request('/api/admin/traders?limit=25');assert.equal(calls[1][1].method,'GET');assert.equal('body'in calls[1][1],false);
});

test('API errors preserve access and step-up decisions rather than inventing empty data',async()=>{
  for(const [status,code]of[[401,'AUTH_REQUIRED'],[403,'ADMIN_PERMISSION_REQUIRED'],[403,'ADMIN_REAUTH_REQUIRED'],[409,'ADMIN_REVIEW_BASIS_CHANGED']]){
    const request=createAdminApi({fetchFn:async()=>response(status,{error:'Administrative action denied.',code})});
    await assert.rejects(request('/api/admin/overview'),error=>error instanceof AdminRequestError&&error.status===status&&error.code===code&&error.message==='Administrative action denied.');
  }
});

test('unreadable or malformed admin responses cannot become a successful dashboard snapshot',async()=>{
  const unreadable=createAdminApi({fetchFn:async()=>({status:503,ok:false,json:async()=>{throw new Error('Private proxy body not for users');}})});
  await assert.rejects(unreadable('/api/admin/overview'),error=>error.status===503&&/unreadable/.test(error.message)&&!error.message.includes('proxy body'));
  for(const body of [null,[],false,'not-json']){
    const request=createAdminApi({fetchFn:async()=>response(200,body)});
    await assert.rejects(request('/api/admin/overview'),/invalid administrative response/);
  }
});

test('an administrative request cannot be redirected to another origin or public API',async()=>{
  let calls=0;const request=createAdminApi({fetchFn:async()=>{calls++;return response(200,{});}});
  for(const endpoint of ['https://untrusted.example/collect','//untrusted.example/collect','/api/login','/api/admin/https://untrusted.example'])await assert.rejects(request(endpoint),/Invalid administrative endpoint/);
  assert.equal(calls,0);
});

test('money and basis-point conversion stays exact and rejects truncation, exponents, overflows, and unexpected negatives',()=>{
  for(const [raw,expected]of[['0.01',1],['1.10',110],['10000',1000000],[' 25.50 ',2550],['9999999999.99',999999999999]])assert.equal(decimalToUnits(raw),expected);
  assert.equal(decimalToUnits('-123.45',{allowNegative:true}),-12345);
  assert.equal(decimalToUnits('37.25',{maximum:10000}),3725);
  for(const raw of ['1.001','1e5','Infinity','NaN','-1','+1','.5','1.','',null,'10000000000.01'])assert.throws(()=>decimalToUnits(raw));
  assert.throws(()=>decimalToUnits('100.01',{maximum:10000}));
});

test('client identifiers require safe positive integers',()=>{
  assert.equal(positiveInteger('42'),42);assert.equal(positiveInteger(1),1);
  for(const id of ['0','-1','1.5','1e2','9007199254740992','',null,{},' 2 OR 1=1 '])assert.throws(()=>positiveInteger(id));
});

test('permissions fail closed and list metadata never disguises malformed lists or missing records',()=>{
  assert.equal(administrativePermissions({role:'owner'}).size,0);
  assert.deepEqual([...administrativePermissions({permissions:['overview.read',null,'finance.read']})],['overview.read','finance.read']);
  assert.deepEqual(pageRows({items:[{id:1}],total:2,limit:1,offset:0,nextOffset:1}),{items:[{id:1}],total:2,limit:1,offset:0,nextOffset:1});
  assert.deepEqual(pageRows({accounts:[],total:0,limit:25,offset:0},'accounts'),{items:[],total:0,limit:25,offset:0,nextOffset:null});
  for(const data of [{},{items:null},{items:[1,2],total:1},{items:[],total:-1}])assert.throws(()=>pageRows(data));
});

test('filter URLs encode user input and exported filenames do not accept paths or formula strings',()=>{
  const query=queryString({search:'Ada & Co / =1+1',status:'',offset:0,userId:null});
  const parsed=new URLSearchParams(query);assert.equal(parsed.get('search'),'Ada & Co / =1+1');assert.equal(parsed.get('offset'),'0');assert.equal(parsed.has('status'),false);assert.equal(queryString({}), '');
  const now=new Date('2026-10-20T12:00:00Z');assert.equal(csvDownloadName('traders',now),'fundraiser-academy-traders-2026-10-20.csv');assert.equal(csvDownloadName('../../=bad',now),'fundraiser-academy-report-2026-10-20.csv');
});
