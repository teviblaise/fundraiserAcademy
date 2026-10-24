import test from 'node:test';
import assert from 'node:assert/strict';
import {fundraiserName,publicFundraiserName} from '../public/fundraiser-name.js';
import {initializeClientPage} from '../public/client.js';
import {createAccount} from '../public/simulator.js';
import {initializeLeaderboardPage} from '../public/leaderboard.js';

test('private titles use the registered first name only and preserve compound first names',()=>{
  const user={firstName:'Ana Maria',otherNames:'Jones',name:'Ana Maria Jones',nickname:'PrivateNickname'};
  const original=structuredClone(user);
  assert.equal(fundraiserName(user),'Ana Maria Fundraiser');
  assert.equal(fundraiserName('  Chidiebere  '),'Chidiebere Fundraiser');
  assert.equal(fundraiserName({firstName:'Élodie'}),'Élodie Fundraiser');
  assert.deepEqual(user,original);
  for(const value of [undefined,null,{},42,{name:'A Full Registered Name'},'',{firstName:''},{firstName:7}])assert.equal(fundraiserName(value),'Fundraiser');
});

test('titles normalize the display suffix once without seeding example names or exposing private identity',()=>{
  for(const name of ['Ada Fundraiser','Ada fundraiser','Ada Fundraiser Fundraiser'])assert.equal(fundraiserName(name),'Ada Fundraiser');
  assert.equal(fundraiserName('Fundraiser'),'Fundraiser');
  assert.equal(publicFundraiserName('Chosen Alias'),'Chosen Alias Fundraiser');
  assert.equal(publicFundraiserName({firstName:'Never Publish This',name:'Private Legal Name'}),'Fundraiser');
  for(const value of ['Ada\nPrivate','Ada\u202eSecret'])assert.equal(fundraiserName(value),'Fundraiser');
});

class Element {
  constructor(){this._text='';this.children=[];this.hidden=false;this.disabled=false;this.value='';this.attributes=new Map();this.dataset={};this.listeners=new Map();}
  set textContent(value){this._text=String(value);this.children=[];}
  get textContent(){return this._text+this.children.map(child=>child.textContent).join('');}
  set innerHTML(_){throw new Error('Names must remain text, never HTML.');}
  setAttribute(name,value){this.attributes.set(name,String(value));}
  getAttribute(name){return this.attributes.get(name)??null;}
  removeAttribute(name){this.attributes.delete(name);}
  addEventListener(name,listener){this.listeners.set(name,listener);}
  setCustomValidity(value){this.validityMessage=value;}
  reportValidity(){return true;}
  async event(name){await this.listeners.get(name)?.({preventDefault(){},currentTarget:this});}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this._text='';this.children=children;}
}

function pageFixture({firstName='Ana Maria',confirmed=false}={}){
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const link=new Element();link.setAttribute('href','/dashboard.html');
  const document={getElementById:node,querySelector:selector=>node(selector),querySelectorAll:()=>[link]};
  const redirects=[],posts=[];
  let user={id:7,firstName,otherNames:'Jones',name:'Ana Maria Jones',email:'isolated@example.com',market:'I trade forex',createdAt:Date.UTC(2026,9,24),assessmentAccess:confirmed,emailConfirmationRequired:true,emailVerified:confirmed};
  const original=structuredClone(user),holder='Exact Certificate Nickname';
  const fetchFn=async(endpoint,options={})=>{
    let body;
    if(endpoint==='/api/me')body={user:structuredClone(user)};
    else if(endpoint==='/api/profile'){
      const input=JSON.parse(options.body);posts.push(input);
      user={...user,...input,name:[input.firstName,input.otherNames].filter(Boolean).join(' ')};
      body={user:structuredClone(user)};
    }else if(endpoint==='/api/registration-status')body={emailConfirmationAvailable:false};
    else if(endpoint==='/api/notification-settings')body={emailAvailable:false,emailVerified:confirmed,pushSubscriptions:0};
    else if(endpoint==='/api/account?symbol=BTCUSD')body={account:createAccount(Date.UTC(2026,9,24))};
    else if(endpoint==='/api/certificates')body={certificates:[{id:'17fd7b14-d093-4347-a388-d84fba16d1e5',holder,issuedAt:Date.UTC(2026,9,24)}]};
    else if(endpoint==='/api/contract')body={status:'signature_required'};
    else throw new Error(`Unexpected request ${endpoint}`);
    return{status:200,ok:true,json:async()=>body};
  };
  const page=initializeClientPage({document,window:{location:{replace:value=>redirects.push(value)}},fetchFn});
  return{page,node,nodes,posts,original,holder,redirects,link,get user(){return user;},async settle(){await page.ready;for(let n=0;n<4;n++)await new Promise(resolve=>setImmediate(resolve));}};
}

test('the actual client dashboard greets a Fundraiser by first name and keeps registration fields untouched',async()=>{
  const app=pageFixture({confirmed:true});await app.settle();
  assert.equal(app.node('welcome-name').textContent,'Ana Maria Fundraiser.');
  assert.equal(app.node('profile-name').textContent,'Ana Maria Fundraiser');
  assert.equal(app.node('profile-first-name').value,'Ana Maria');
  assert.equal(app.node('profile-other-names').value,'Jones');
  assert.equal(app.user.name,'Ana Maria Jones');
  assert.equal(app.node('profile-initials').textContent,'A');
  assert.match(app.node('certificate-detail').textContent,new RegExp(app.holder));
  assert.doesNotMatch(app.node('certificate-detail').textContent,/Exact Certificate Nickname Fundraiser/);
  assert.deepEqual(app.redirects,[]);
});

test('saving a profile regenerates the first-name title without posting it as registration or legal data',async()=>{
  const app=pageFixture();await app.settle();
  app.node('profile-first-name').value='Chinwe';app.node('profile-other-names').value='Okafor';
  await app.node('profile-form').event('submit');
  assert.equal(app.node('welcome-name').textContent,'Chinwe Fundraiser.');
  assert.equal(app.node('profile-name').textContent,'Chinwe Fundraiser');
  assert.deepEqual(app.posts,[{firstName:'Chinwe',otherNames:'Okafor',market:'I trade forex'}]);
  assert.equal(app.user.name,'Chinwe Okafor');
  assert.equal(app.node('confirmation-email').textContent,'isolated@example.com');
  assert.equal(app.link.attributes.has('href'),false,'pending email remains assessment gated');
});

test('missing first names have a neutral title and markup-like names are rendered as inert text',async()=>{
  const missing=pageFixture({firstName:null});await missing.settle();
  assert.equal(missing.node('welcome-name').textContent,'Fundraiser.');
  const literal=pageFixture({firstName:'<img src=x onerror=alert(1)>'});await literal.settle();
  assert.equal(literal.node('profile-name').textContent,'<img src=x onerror=alert(1)> Fundraiser');
  assert.equal(literal.node('profile-first-name').value,'<img src=x onerror=alert(1)>');
});

test('the public leaderboard titles only the chosen alias and saves the alias without rewriting it',async()=>{
  const nodes=new Map(),node=id=>{if(!nodes.has(id))nodes.set(id,new Element());return nodes.get(id);};
  const alias='Patient One',entry={rank:1,displayAlias:alias,returnPercent:10,realizedProfit:1000,tradingDays:3,completedAt:Date.UTC(2026,9,24),firstName:'HiddenFirstName',registeredName:'Hidden Full Name'};
  const entries={entries:[entry],total:1,offset:0,nextOffset:null,updatedAt:Date.UTC(2026,9,24)};
  const preferences={enabled:true,alias,eligibility:{eligible:true,status:'eligible'},entry};
  const posted=[];
  const page=initializeLeaderboardPage({document:{getElementById:node,createElement:()=>new Element()},fetchFn:async(endpoint,options={})=>{
    if(options.body)posted.push(JSON.parse(options.body));
    return{status:200,ok:true,json:async()=>structuredClone(endpoint.startsWith('/api/leaderboard?')?entries:preferences)};
  }});
  await page.ready;
  assert.match(node('rankings-body').textContent,/Patient One Fundraiser/);
  assert.doesNotMatch(node('rankings-body').textContent,/HiddenFirstName|Hidden Full Name/);
  assert.equal(node('your-rank').textContent,'#1 · Patient One Fundraiser');
  assert.equal(node('public-alias').value,alias);
  assert.equal(preferences.alias,alias);
  node('participation-enabled').checked=true;
  await node('participation-form').event('submit');
  assert.deepEqual(posted,[{enabled:true,alias}]);
  assert.equal(entry.displayAlias,alias);
});
