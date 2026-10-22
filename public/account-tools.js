export function amountToCents(value) {
  const raw = String(value ?? '').trim();
  if (raw.length > 32 || !/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new Error('Enter a USD amount with at most two decimal places.');
  const [whole, fraction = ''] = raw.split('.');
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (result < 1n || result > 1000000000000n) throw new Error('Enter an amount from $0.01 to $10,000,000,000.00.');
  return Number(result);
}

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export async function collectPersonalData(request, { limit = 500, maxBytes = 50 * 1024 * 1024, onProgress = () => {} } = {}) {
  let offset = 0, pages = 0, bytes = 0, first = null;
  const sections = Object.create(null);
  while (true) {
    const page = await request('/api/account/export', { offset, limit, ...(first ? { fingerprint:first.fingerprint } : {}) });
    if (!object(page) || !object(page.profile) || !object(page.sections) || page.offset !== offset || page.limit !== limit || typeof page.complete !== 'boolean' || typeof page.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(page.fingerprint)) throw new Error('The export response was incomplete. No partial export was downloaded.');
    if (++pages > 20000) throw new Error('This export needs staff assistance. No partial export was downloaded.');
    if (!first) first = page;
    else if (page.fingerprint !== first.fingerprint || JSON.stringify([page.profile,page.preferences,page.assessment,page.accountControls]) !== JSON.stringify([first.profile,first.preferences,first.assessment,first.accountControls]) || Object.keys(page.sections).sort().join('|') !== Object.keys(first.sections).sort().join('|')) throw new Error('Your account changed while the export was prepared. Retry to prepare a complete export.');
    bytes += new TextEncoder().encode(JSON.stringify(page)).byteLength;
    if (bytes > maxBytes) throw new Error('Your export exceeds the 50 MB browser limit. Contact support for a complete export. No partial export was downloaded.');
    for (const [name, section] of Object.entries(page.sections)) {
      if (!/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(name) || !object(section) || !Array.isArray(section.items) || !Number.isSafeInteger(section.total) || section.total < 0 || section.offset !== offset || section.limit !== limit || section.items.length !== Math.min(limit, Math.max(0, section.total - offset))) throw new Error('An export dataset was incomplete. No partial export was downloaded.');
      if (!Object.hasOwn(sections, name)) sections[name] = { items: [], total: section.total };
      if (sections[name].total !== section.total) throw new Error('Your records changed during the export. Retry to prepare a complete export.');
      const next = offset + section.items.length < section.total ? offset + section.items.length : null;
      if (section.nextOffset !== next) throw new Error('The export page sequence could not be verified. No partial export was downloaded.');
      sections[name].items.push(...section.items);
    }
    onProgress({ pages, records: Object.values(sections).reduce((sum, section) => sum + section.items.length, 0), bytes });
    const complete = Object.values(sections).every(section => section.items.length === section.total);
    if (page.complete) {
      if (!complete || page.nextOffset !== null) throw new Error('The export ended before all records were received. No partial export was downloaded.');
      return { formatVersion: first.formatVersion ?? 1, fingerprint:first.fingerprint, generatedAt: first.generatedAt, completedAt: page.generatedAt, profile: first.profile, preferences: first.preferences, assessment: first.assessment, accountControls: first.accountControls, sections, complete: true, notice: first.notice };
    }
    if (complete || page.nextOffset !== offset + limit) throw new Error('The export page sequence could not be verified. No partial export was downloaded.');
    offset = page.nextOffset;
  }
}

if (typeof document !== 'undefined' && document.getElementById('tools-main')) void initializeAccountTools();
async function initializeAccountTools() {
  const byId = id => document.getElementById(id);
  const state = { userId: null, security: null, controls: null, funding: null, busy: false, loading: false, ended: false, epoch: 0, lifecycle: 0, grants: {}, action: null, pending: null, receipt: null };
  const statuses = { requested: 'Requested', approved: 'Approved for payment', paid: 'Recorded as paid', rejected: 'Rejected' };
  const money = value => Number.isSafeInteger(value) ? new Intl.NumberFormat('en-US', { style:'currency',currency:'USD' }).format(value/100) : '—';
  const when = value => Number.isSafeInteger(value) && value > 0 && value <= 8640000000000000 ? new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short'}) : 'Time unavailable';
  const node = (tag, className, text) => { const item=document.createElement(tag); if(className)item.className=className;if(text!==undefined)item.textContent=text;return item; };
  function announce(text) { byId('tools-status').textContent=text; }
  function setBusy(value) { state.busy=value; for(const id of ['payout-submit','payout-retry-pending','tools-export','closure-submit','closure-cancel','tools-refresh'])byId(id).disabled=value; }
  async function api(endpoint, data) {
    const lifecycle=state.lifecycle;
    if(state.ended)throw Object.assign(new Error('This page is no longer active.'),{code:'PAGE_INACTIVE'});
    const response=await fetch(endpoint,{method:data===undefined?'GET':'POST',credentials:'same-origin',cache:'no-store',referrerPolicy:'no-referrer',signal:AbortSignal.timeout(30000),headers:data===undefined?{}:{'Content-Type':'application/json','X-Requested-With':'FundraiserAcademy'},...(data===undefined?{}:{body:JSON.stringify(data)})});
    let value;try{value=await response.json();}catch{throw Object.assign(new Error('The server response could not be read. Try again.'),{status:response.status});}
    if(state.ended||lifecycle!==state.lifecycle)throw Object.assign(new Error('This page is no longer active.'),{code:'PAGE_INACTIVE'});
    if(!response.ok)throw Object.assign(new Error(typeof value.error==='string'?value.error:'Your request could not be completed.'),{status:response.status,code:value.code});
    if(!object(value))throw new Error('The server returned an invalid response.');
    return value;
  }
  function clearPrivate() { byId('tools-main').hidden=true;for(const id of ['payout-balances','payout-history','closure-blockers','closure-retained'])byId(id).replaceChildren();byId('payout-account').replaceChildren();state.funding=null;state.controls=null;state.grants={}; }
  function failure(error) {
    if(state.ended||error.code==='PAGE_INACTIVE')return;
    if(error.status===401||error.status===403&&['ACCOUNT_SUSPENDED','ACCOUNT_DELETED'].includes(error.code)){
      clearPrivate();byId('tools-loading').hidden=false;byId('tools-loading-message').textContent=error.status===401?'Please log in again to use account controls.':error.message;byId('tools-login').hidden=error.status!==401;
    }else announce(error.message||'We could not complete this request. Try again.');
    if(error.code==='ACCOUNT_REAUTH_REQUIRED'||error.code==='ACCOUNT_AUTH_REQUIRED')state.grants={};
  }
  function pendingStorage() { return `fa.pending-payout.${state.userId}`; }
  function savePending(value) {state.pending=value;try{if(value)sessionStorage.setItem(pendingStorage(),JSON.stringify(value));else sessionStorage.removeItem(pendingStorage());}catch{}renderPending();}
  function readPending() {
    try{const value=JSON.parse(sessionStorage.getItem(pendingStorage())||'null');if(object(value)&&typeof value.key==='string'&&/^[A-Za-z0-9._:-]{16,128}$/.test(value.key)&&typeof value.accountId==='string'&&value.accountId.length<=100&&Number.isSafeInteger(value.amountCents)&&value.amountCents>0&&value.amountCents<=1000000000000)state.pending=value;}catch{}
  }
  function renderPending() {const pending=state.pending;byId('payout-pending-panel').hidden=!pending;if(pending)byId('payout-pending-message').textContent=`The result of your ${money(pending.amountCents)} request is not yet confirmed. Retry with the same request reference to avoid reserving it twice.`;}
  function renderPayouts(funding) {
    if(!Array.isArray(funding.accounts)||!Array.isArray(funding.payouts)||funding.accounts.some(x=>!object(x))||funding.payouts.some(x=>!object(x)))throw new Error('Your payout records could not be read.');
    const metrics=byId('payout-balances');metrics.replaceChildren();
    for(const [title,key]of[['Unreserved earned share','availableCents'],['Reserved for requests','reservedCents'],['Recorded paid','paidCents']]){const box=node('div','rounded-lg border border-line p-4');const amounts=funding.accounts.map(account=>account[key]);const total=amounts.every(Number.isSafeInteger)?amounts.reduce((sum,n)=>sum+n,0):null;box.append(node('p','metric-label',title),node('p','text-2xl font-semibold tracking-tight',money(total)));metrics.append(box);}
    const select=byId('payout-account'),selected=select.value;select.replaceChildren(node('option','', 'Choose an account'));select.firstChild.value='';
    for(const account of funding.accounts){const option=node('option','',`${account.label||'Sponsored account'} · ${money(account.availableCents)} available`);option.value=account.id;select.append(option);}if(funding.accounts.some(x=>x.id===selected))select.value=selected;
    byId('payout-empty').hidden=funding.accounts.length>0;byId('payout-request-form').hidden=!funding.accounts.length;accountChanged();
    const history=byId('payout-history');history.replaceChildren();
    for(const payout of funding.payouts){const card=node('article','rounded-xl border border-line p-5');const top=node('div','flex flex-wrap items-center justify-between gap-3');top.append(node('h3','text-lg',money(payout.amountCents)),node('span','rounded-full border border-line px-3 py-1 text-xs',statuses[payout.status]||'Status unavailable'));card.append(top,node('p','mt-3 break-words text-sm',payout.label||'Sponsored account'),node('p','mt-1 text-xs text-muted',`${payout.requestOrigin==='trader'?'Requested by you':'Recorded by the academy'} · ${when(payout.createdAt)}`));
      if(Array.isArray(payout.history)&&payout.history.length){const list=node('ol','mt-4 space-y-2 border-t border-line pt-4');for(const event of payout.history){if(!object(event))continue;list.append(node('li','text-xs text-muted',`${statuses[event.status]||'Status update'} · ${when(event.createdAt)}`));}card.append(list);}if(payout.status==='paid')card.append(node('p','mt-3 text-xs text-muted',`Payment recorded outside this website · ${when(payout.paidAt)}`));history.append(card);}
    if(!funding.payouts.length)history.append(node('p','rounded-lg border border-line p-4 text-sm text-muted','No payout requests or payments have been recorded yet.'));
    byId('payout-history-summary').textContent=`${Number.isSafeInteger(funding.payoutsTotal)?funding.payoutsTotal:funding.payouts.length} requests recorded. Showing the ${funding.payouts.length} most recent.`;renderPending();
  }
  function accountChanged(){const account=state.funding?.accounts.find(x=>x.id===byId('payout-account').value);byId('payout-account-detail').textContent=account?`${account.firmName||'Prop firm'} · ${Number.isSafeInteger(account.traderShareBps)?account.traderShareBps/100:'—'}% agreed trader share · ${money(account.availableCents)} unreserved.`:'';if(account&&Number.isSafeInteger(account.availableCents))byId('payout-amount').max=String(account.availableCents/100);else byId('payout-amount').removeAttribute('max');}
  function renderControls(controls){
    if(typeof controls.status!=='string'||!Array.isArray(controls.blockers)||!Array.isArray(controls.retained))throw new Error('Your account-closure status could not be read.');
    byId('closure-notice').textContent=typeof controls.retentionNotice==='string'?controls.retentionNotice:'Closure removes your operational profile. Restricted signed agreements, financial and administrative records may remain for retention review.';
    byId('closure-current-status').textContent=controls.status==='pending_closure'?'Your closure request is pending. Resolve the requirements below, then confirm closure again.':'No account-closure request is pending.';
    byId('closure-blockers').replaceChildren(...controls.blockers.map(item=>node('li','',item.message||'Contact support to resolve this account requirement.')));
    byId('closure-retained-panel').hidden=!controls.retained.length;byId('closure-retained').replaceChildren(...controls.retained.map(item=>node('li','',`${item.label||item.category||'Restricted record'} · ${item.recordCount??'record count unavailable'}`)));
    byId('closure-cancel').hidden=controls.status!=='pending_closure';
  }
  async function load({preserveMessage=false}={}){
    if(state.loading||state.ended||state.receipt)return;state.loading=true;const epoch=++state.epoch;byId('tools-retry').hidden=true;
    try{const [me,security,controls,funding]=await Promise.all([api('/api/me'),api('/api/security'),api('/api/account/status'),api('/api/payouts')]);if(state.ended||epoch!==state.epoch)return;if(!Number.isSafeInteger(me.user?.id)||!object(security.twoFactor))throw new Error('Your account information could not be read.');
      if(state.userId!==me.user.id){clearPrivate();state.userId=me.user.id;state.pending=null;readPending();}state.security=security;state.controls=controls;state.funding=funding;renderPayouts(funding);renderControls(controls);byId('tools-loading').hidden=true;byId('tools-main').hidden=false;if(!preserveMessage)announce('Your account records are up to date.');
    }catch(error){if(state.ended||epoch!==state.epoch)return;if(!state.funding){byId('tools-loading').hidden=false;byId('tools-loading-message').textContent=error.status===401?'Please log in to use your account controls.':'Account controls could not be loaded. Try again.';byId('tools-login').hidden=error.status!==401;byId('tools-retry').hidden=false;}failure(error);}finally{state.loading=false;}
  }
  function resetAuth(){byId('tools-auth-form').reset();byId('tools-auth-status').textContent='';}
  async function authorized(purpose,execute){if(state.busy||state.ended)return;const lifecycle=state.lifecycle;setBusy(true);if((state.grants[purpose]||0)>Date.now()+1000){try{await execute();}catch(error){failure(error);}finally{if(!state.ended&&lifecycle===state.lifecycle)setBusy(false);}return;}
    state.action={purpose,execute,lifecycle};resetAuth();const factor=Boolean(state.security?.twoFactor?.enabled);byId('tools-auth-factor').hidden=!factor;byId('tools-auth-code').required=factor;byId('tools-auth-detail').textContent=`Confirm your password${factor?' and a fresh second factor':''} to ${purpose==='export'?'prepare your personal-data export':purpose==='delete'?'manage account closure':'request your recorded earned payout'}. This authorization lasts five minutes and applies only to this action type.`;byId('tools-auth-dialog').showModal();byId('tools-auth-password').focus();
  }
  function cancelAuth(){if(byId('tools-auth-submit').disabled)return;state.action=null;resetAuth();byId('tools-auth-dialog').close();setBusy(false);}
  byId('tools-auth-cancel').addEventListener('click',cancelAuth);byId('tools-auth-dialog').addEventListener('cancel',event=>{event.preventDefault();cancelAuth();});
  byId('tools-auth-form').addEventListener('submit',async event=>{event.preventDefault();if(!state.action||byId('tools-auth-submit').disabled)return;const action=state.action;if(action.lifecycle!==state.lifecycle)return;byId('tools-auth-submit').disabled=true;try{
      const grant=await api('/api/account/authorize',{purpose:action.purpose,password:byId('tools-auth-password').value,...(state.security?.twoFactor?.enabled?{code:byId('tools-auth-code').value}:{})});if(!Number.isFinite(grant.expiresAt))throw new Error('Authorization could not be confirmed.');state.grants[action.purpose]=grant.expiresAt;state.action=null;resetAuth();byId('tools-auth-dialog').close();try{await action.execute();}catch(error){failure(error);}finally{if(!state.ended&&action.lifecycle===state.lifecycle)setBusy(false);}
    }catch(error){if(state.ended||action.lifecycle!==state.lifecycle)return;byId('tools-auth-status').textContent=error.message;byId('tools-auth-password').value='';byId('tools-auth-code').value='';}finally{if(!state.ended&&action.lifecycle===state.lifecycle)byId('tools-auth-submit').disabled=false;}});
  async function sendPayout(input){let pending=state.pending;if(pending&&(pending.accountId!==input.accountId||pending.amountCents!==input.amountCents))throw new Error('Safely retry the previous unconfirmed request before starting another payout request.');if(!pending){pending={...input,key:crypto.randomUUID()};savePending(pending);}
    try{const result=await api('/api/payouts/request',{accountId:pending.accountId,amountCents:pending.amountCents,idempotencyKey:pending.key});if(!object(result.payout)||typeof result.payout.id!=='string')throw new Error('The request result could not be verified. Safely retry the same request.');savePending(null);byId('payout-amount').value='';announce(result.reused?'Your earlier request is already recorded. The history below shows its current status.':'Your payout request is recorded for academy approval. No money was transferred by this request.');await load({preserveMessage:true});
    }catch(error){if(error.code==='PAYOUT_BALANCE_EXCEEDED')savePending(null);throw error;}
  }
  byId('payout-account').addEventListener('change',accountChanged);
  byId('payout-request-form').addEventListener('submit',event=>{event.preventDefault();try{const accountId=byId('payout-account').value,amountCents=amountToCents(byId('payout-amount').value);const account=state.funding?.accounts.find(x=>x.id===accountId);if(!account)throw new Error('Choose one of your sponsored accounts.');if(amountCents>account.availableCents)throw new Error('That amount exceeds your unreserved earned share.');void authorized('payout',()=>sendPayout({accountId,amountCents}));}catch(error){announce(error.message);}});
  byId('payout-retry-pending').addEventListener('click',()=>{if(state.pending)void authorized('payout',()=>sendPayout({accountId:state.pending.accountId,amountCents:state.pending.amountCents}));});
  function download(value,fileName){if(state.ended)return;const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=node('a');link.href=url;link.download=fileName;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
  byId('tools-export').addEventListener('click',()=>void authorized('export',async()=>{byId('export-progress').textContent='Preparing your complete export…';try{const result=await collectPersonalData(api,{onProgress:progress=>{byId('export-progress').textContent=`Received ${progress.records.toLocaleString()} records across ${progress.pages} export pages…`;}});download(result,'fundraiser-academy-personal-data.json');byId('export-progress').textContent='Your complete personal-data export is ready. Keep the downloaded file private.';}catch(error){byId('export-progress').textContent='No partial export was downloaded.';throw error;}}));
  byId('closure-form').addEventListener('submit',event=>{event.preventDefault();if(byId('closure-confirmation').value!=='DELETE MY ACCOUNT'||!byId('closure-understood').checked){announce('Type DELETE MY ACCOUNT and confirm you understand the retained records.');return;}void authorized('delete',async()=>{const result=await api('/api/account/delete',{confirmation:'DELETE MY ACCOUNT'});if(result.accountDeleted===true&&result.signedOut===true){state.receipt=result;clearPrivate();byId('tools-loading').hidden=true;byId('closure-complete').hidden=false;byId('closure-complete-message').textContent=result.message||'Your account is closed. Keep your receipt for details about restricted retained records.';byId('closure-complete-heading').focus();}else if(result.status==='pending_closure'){state.controls=result;renderControls(result);byId('closure-confirmation').value='';byId('closure-understood').checked=false;announce(result.message||'Your closure request is pending until the listed requirements are resolved.');}else throw new Error('The closure result could not be verified. Refresh your account status before continuing.');});});
  byId('closure-cancel').addEventListener('click',()=>void authorized('delete',async()=>{const controls=await api('/api/account/delete/cancel',{});state.controls=controls;renderControls(controls);announce('Your pending closure request has been cancelled.');}));
  byId('closure-download-receipt').addEventListener('click',()=>{if(state.receipt)download(state.receipt,'fundraiser-academy-closure-receipt.json');});
  for(const id of ['tools-refresh','tools-retry'])byId(id).addEventListener('click',()=>void load());
  window.addEventListener('pagehide',()=>{state.ended=true;state.epoch++;state.lifecycle++;resetAuth();byId('tools-auth-submit').disabled=false;if(byId('tools-auth-dialog').open)byId('tools-auth-dialog').close();state.action=null;clearPrivate();});
  window.addEventListener('pageshow',event=>{if(event.persisted){state.ended=false;state.loading=false;setBusy(false);if(!state.receipt)void load();}});
  await load();
}
