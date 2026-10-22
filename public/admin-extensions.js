import {positiveInteger,queryString,pageRows} from './admin-api.js';

const reasonField={name:'reason',label:'Reason for this administrative action',type:'textarea',maxLength:500,help:'Recorded in the audit trail. Do not enter passwords, tokens, or authentication codes.'};
const text=value=>typeof value==='string'?value:'';
const rows=value=>Array.isArray(value)?value:[];
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const stateLabel=value=>text(value).replace(/_/g,' ')||'Not recorded';
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const count=value=>Number.isSafeInteger(value)&&value>=0?value.toLocaleString():'Not recorded';
const healthStates={ok:'OK',warning:'Needs attention',critical:'Critical',disabled:'Not enabled'};
const diagnosticStates={ok:'Passed',warning:'Needs attention',critical:'Failed',running:'Running'};
const timestamp=value=>Number.isSafeInteger(value)&&value>=0?value:null;
const boundedText=value=>text(value).slice(0,1000);

// A downloaded readiness report contains only the displayed aggregate fields.
// Ignore unexpected response properties, including private provider/storage data.
export function operationalReport(value){
  const health=object(value)?value:{},metrics=object(health.metrics)?health.metrics:{};
  const diagnostic=value=>{
    if(!object(value))return null;
    const field=(name,allowed)=>allowed.includes(value[name])?value[name]:'not_checked';
    const failureCodes=['DIAGNOSTIC_TIMEOUT','DIAGNOSTIC_DATABASE_FAILED','DIAGNOSTIC_INTEGRITY_FAILED','DIAGNOSTIC_FOREIGN_KEYS_FAILED','DIAGNOSTIC_STORAGE_FAILED','DIAGNOSTIC_WORKER_FAILED','DIAGNOSTIC_INTERRUPTED'];
    return {id:/^[a-f0-9-]{36}$/i.test(text(value.id))?value.id:null,startedAt:timestamp(value.startedAt),completedAt:timestamp(value.completedAt),state:Object.hasOwn(diagnosticStates,value.state)?value.state:'warning',database:field('database',['ok','failed','unavailable']),integrity:field('integrity',['ok','failed','not_checked']),foreignKeys:field('foreignKeys',['ok','failed','not_checked']),storageWritable:field('storageWritable',['ok','failed','not_checked']),failureCode:failureCodes.includes(value.failureCode)?value.failureCode:null};
  };
  return {
    version:1,checkedAt:timestamp(health.checkedAt),overall:['healthy','attention','critical'].includes(health.overall)?health.overall:'attention',
    notice:'Local readiness and configuration checks do not confirm provider availability, inbox receipt, persistent storage, or offsite recovery.',
    checks:rows(health.checks).filter(object).slice(0,100).map(item=>({id:/^[a-z0-9_-]{1,80}$/.test(text(item.id))?item.id:'check',label:boundedText(item.label),state:Object.hasOwn(healthStates,item.state)?item.state:'warning',summary:boundedText(item.summary),action:boundedText(item.action)})),
    metrics:Object.fromEntries(['uptimeSeconds','rssBytes','heapUsedBytes','databaseBytes','walBytes','storageFreeBytes','storageTotalBytes'].map(key=>[key,finite(metrics[key])&&metrics[key]>=0?metrics[key]:null])),
    diagnosticRunning:health.diagnosticRunning===true,lastDiagnostic:diagnostic(health.lastDiagnostic),diagnosticRuns:rows(health.diagnosticRuns).slice(0,10).map(diagnostic).filter(Boolean)
  };
}

function bytes(value){
  if(!finite(value)||value<0)return 'Not recorded';
  const units=['B','KiB','MiB','GiB','TiB'];let index=0;
  while(value>=1024&&index<units.length-1){value/=1024;index++;}
  return `${value.toLocaleString(undefined,{maximumFractionDigits:index?1:0})} ${units[index]}`;
}
function uptime(value){
  if(!finite(value)||value<0)return 'Not recorded';
  const minutes=Math.floor(value/60),hours=Math.floor(minutes/60),days=Math.floor(hours/24);
  return days?`${days}d ${hours%24}h`:hours?`${hours}h ${minutes%60}m`:`${minutes}m`;
}

export function performanceFilters(input={}){
  const result={userId:positiveInteger(input.userId,'client ID'),source:input.source||'assessment'};
  if(!['assessment','sponsored'].includes(result.source))throw new Error('Choose assessment or sponsored-account performance.');
  if(result.source==='sponsored'){
    if(typeof input.accountId!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(input.accountId))throw new Error('Enter the sponsored account ID.');
    result.accountId=input.accountId;
  }
  for(const name of ['from','to'])if(input[name]){
    const raw=String(input[name]);const date=new Date(raw+'T00:00:00Z');
    if(!/^\d{4}-\d{2}-\d{2}$/.test(raw)||!Number.isFinite(date.getTime())||date.toISOString().slice(0,10)!==raw)throw new Error('Choose valid UTC report dates.');
    result[name]=raw;
  }
  if(result.from&&result.to&&result.from>result.to)throw new Error('The report start must not follow its end.');
  return result;
}

export function currencyAmount(value,currency){
  if(!finite(value))return 'Not recorded';
  if(typeof currency!=='string'||!/^[A-Z]{3}$/.test(currency))return `${value.toLocaleString()} (currency unavailable)`;
  try{return new Intl.NumberFormat(undefined,{style:'currency',currency,maximumFractionDigits:2}).format(value);}catch{return `${value.toLocaleString()} ${currency}`;}
}

function connectionState(value){
  const data=object(value)?value:{};
  const link=object(data.link)?data.link:object(data.connection)?data.connection:data;
  return {data,link,linked:typeof data.linked==='boolean'?data.linked:Boolean(link.providerAccountId)||Boolean(link.providerAccountIdMasked)||Boolean(link.connected===true)||Boolean(link.linked===true),revision:link.revision??data.revision};
}

export function createAdminExtensions(ctx){
  const {api,post,can,node,card,table,detailGrid,button,openAction,notify,content,isCurrent,getQuery,setQuery,reload,ensureUnlocked,date,percent}=ctx;
  const append=(...items)=>content.append(...items);
  function group(...items){const element=node('div','flex flex-wrap items-center gap-3');element.append(...items);return element;}
  function note(value){return node('p','mt-4 whitespace-pre-wrap break-words text-xs text-muted',value);}
  function messages(items){return rows(items).map(item=>typeof item==='string'?item:text(item?.message)||stateLabel(item?.code)).filter(Boolean).join(' ');}
  function retention(items){return rows(items).map(item=>typeof item==='string'?item:[text(item?.label)||stateLabel(item?.category)||text(item?.type)||text(item?.name),Number.isSafeInteger(item?.recordCount??item?.count)?`${item.recordCount??item.count} records`:''].filter(Boolean).join(': ')).filter(Boolean).join('; ');}
  function navigation(page){
    const area=group(node('p','text-xs text-muted',`${count(page.total)} records · showing ${page.items.length}`));
    if(page.offset>0)area.append(button('Previous',()=>{setQuery({...getQuery(),offset:Math.max(0,page.offset-page.limit)});reload();}));
    const next=page.nextOffset??(page.offset+page.items.length<page.total?page.offset+page.items.length:null);
    if(next!==null)area.append(button('Next',()=>{setQuery({...getQuery(),offset:next});reload();}));
    return area;
  }
  function filters(specs,values,submit){
    const form=node('form','mb-5 grid items-end gap-3 sm:grid-cols-2 xl:grid-cols-4');
    for(const spec of specs){
      const holder=node('div','min-w-0'),id=`admin-extension-${spec.name}`;
      const label=node('label','mb-2 block text-xs font-semibold',spec.label);label.htmlFor=id;
      const input=node(spec.choices?'select':'input','mb-0');input.id=id;input.name=spec.name;
      if(spec.choices){for(const [value,label]of spec.choices){const option=node('option','',label);option.value=value;input.append(option);}input.value=values[spec.name]??spec.choices[0][0];}
      else{input.type=spec.type||'text';input.value=values[spec.name]??'';input.maxLength=254;if(spec.min!==undefined)input.min=String(spec.min);}
      input.required=spec.required===true;holder.append(label,input);form.append(holder);
    }
    const apply=node('button','desk-action min-h-11','Apply filters');apply.type='submit';form.append(apply);
    form.addEventListener('submit',event=>{event.preventDefault();if(!form.reportValidity())return;try{submit(Object.fromEntries(new FormData(form)));}catch(error){notify(error.message,true);}});
    return form;
  }
  function linkAction(account){
    const current=connectionState(account.connection);
    return openAction({title:'Link an existing MetaApi account',description:'Assign an existing MetaTrader account already connected in your company MetaApi workspace. The server token stays in hosting settings. This does not buy, provision, or trade a prop account.',fields:[{name:'providerAccountId',label:'Existing MetaApi account ID',maxLength:100,value:current.link.providerAccountId||'',help:'Use the MetaApi account identifier, not a MetaTrader password or API token.'},{name:'historyFrom',label:'History start (UTC date)',type:'date',required:false,help:'Leave blank to use the connector’s documented bounded history window.'},reasonField],submit:'Link sponsored account',execute:form=>post(`/api/admin/connections/${account.id}/link`,{providerAccountId:text(form.get('providerAccountId')).trim(),historyFrom:form.get('historyFrom')||undefined,...(Number.isSafeInteger(current.revision)?{expectedRevision:current.revision}:{}),reason:form.get('reason')})});
  }
  function unlinkAction(account){
    const current=connectionState(account.connection);
    if(!Number.isSafeInteger(current.revision)){notify('The connection revision is unavailable. Refresh before changing it.');return;}
    return openAction({title:'Disconnect sponsored-account synchronization',description:'Stop new synchronization for this assignment. Recorded performance and financial records are preserved. A provider account cannot be reassigned to a different trader.',fields:[reasonField],submit:'Disconnect performance feed',execute:form=>post(`/api/admin/connections/${account.id}/unlink`,{revision:current.revision,reason:form.get('reason')})});
  }
  async function synchronize(account,trigger){
    if(trigger.disabled)return;trigger.disabled=true;
    try{await ensureUnlocked();await post(`/api/admin/connections/${account.id}/sync`,{});notify('The server completed the performance synchronization request. Check the latest observation and coverage below.');await reload();}
    catch(error){notify(error.message||'Performance synchronization could not finish.');}
    finally{trigger.disabled=false;}
  }
  async function connections(epoch){
    const query=getQuery();const data=await api('/api/admin/connections'+queryString({limit:25,offset:query.offset||0,search:query.search||''}));if(!isCurrent(epoch))return;
    const page=pageRows(data,'accounts'),area=card('MetaTrader performance connections','Link company-sponsored allocations to existing MetaApi accounts. Provider observations stay separate from the profit-share and payment ledger.');
    area.append(detailGrid([['Provider','MetaApi · MetaTrader 4/5'],['Configuration',data.provider?.configured?'Server token configured':'Server token not configured'],['Automatic synchronization',data.provider?.automaticSync?'Scheduled':'Not running'],['Accounts synchronizing',count(data.provider?.synchronizing)]]));
    if(!data.provider?.configured)area.append(note('Enter METAAPI_API_TOKEN securely in the application server settings before live synchronization. This page never collects provider passwords or tokens.'));
    area.append(filters([{name:'search',label:'Find account or trader'}],query,values=>{setQuery({...values,offset:0});reload();}));
    area.append(table([
      {title:'Trader / allocation',value:row=>`${row.traderName||'Client #'+row.userId} · ${row.label||row.id}`},
      {title:'Firm',value:row=>row.firmName},
      {title:'Connection',value:row=>{const state=connectionState(row.connection);return stateLabel(state.link.status||state.data.status||(state.linked?'linked':'not_linked'))+(state.data.stale&&state.linked?' · stale observations':'');}},
      {title:'Last successful sync',value:row=>{const state=connectionState(row.connection);return date(state.link.lastSuccessAt??state.link.lastSyncedAt??state.data.lastSuccessAt);}},
      {title:'Latest observation',value:row=>{const state=connectionState(row.connection),sample=state.data.latestSnapshot||state.data.latest||state.data.snapshot;return object(sample)?`${currencyAmount(sample.equity,sample.currency)} equity${state.data.stale?' · stale':''}`:'No observation recorded';}},
      {title:'Actions',value:row=>{const state=connectionState(row.connection);const actions=group();if(can('finance.write')){if(!state.linked)actions.append(button('Link MetaApi account',()=>linkAction(row)));else if(state.link.active===false)actions.append(button('Reconnect existing account',()=>linkAction(row)));else{const sync=button('Synchronize now',()=>synchronize(row,sync));actions.append(sync,button('Disconnect',()=>unlinkAction(row)));}}return actions;}}
    ],page.items),navigation(page));
    area.append(note('MetaApi observations can include balance deposits or withdrawals. They do not automatically become distributable profit, change the signed split, approve payouts, or send money. Review imported history coverage and recorded statements before settlement.'));append(area);
  }
  function lineChart(curve,key,title,currency){
    const area=card(title,'Only recorded observations are plotted. Lines connect samples; values between samples were not measured.');
    const points=rows(curve?.points).filter(point=>finite(point?.time)&&finite(point?.[key]));
    if(!points.length){area.append(note('No recorded observations in this range. Historical intraday equity is not reconstructed from closing profits.'));return area;}
    const values=points.map(point=>point[key]);const minimum=Math.min(...values),maximum=Math.max(...values);const first=points[0].time,last=points.at(-1).time;
    const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('viewBox','0 0 720 220');svg.setAttribute('role','img');svg.setAttribute('aria-label',`${title}: ${points.length} recorded samples`);svg.setAttribute('class','my-4 block h-auto w-full rounded-lg border border-line bg-[#101010]');
    const path=document.createElementNS('http://www.w3.org/2000/svg','polyline');path.setAttribute('points',points.map(point=>`${24+(point.time-first)/Math.max(1,last-first)*672},${196-(point[key]-minimum)/Math.max(1e-12,maximum-minimum)*172}`).join(' '));path.setAttribute('fill','none');path.setAttribute('stroke','#ffd700');path.setAttribute('stroke-width','2');svg.append(path);area.append(svg);
    area.append(detailGrid([['First sample',date(first)],['Latest sample',date(last)],['Recorded range',`${currencyAmount(minimum,currency)} – ${currencyAmount(maximum,currency)}`],['Observations',count(curve.totalPoints??points.length)]]));
    if(curve.downsampled)area.append(note('The display keeps a bounded selection of actual samples. Drawdown statistics use the report’s underlying recorded observations.'));return area;
  }
  async function performance(epoch){
    const query=getQuery(),area=card('Advanced performance report','Choose the trader and source. Assessment demo results and sponsored provider-account results are reported separately in their recorded currency.');
    area.append(filters([{name:'userId',label:'Trader client ID',type:'number',min:1,required:true},{name:'source',label:'Report source',choices:[['assessment','Assessment demo'],['sponsored','Sponsored MetaApi account']]},{name:'accountId',label:'Sponsored account ID (sponsored source)'},{name:'from',label:'From (UTC)',type:'date'},{name:'to',label:'Through (UTC)',type:'date'}],query,values=>{setQuery(performanceFilters(values));reload();}));append(area);
    if(!query.userId){area.append(note('Enter a trader client ID to load recorded results. No example performance is shown.'));return;}
    const selected=performanceFilters(query);const report=await api('/api/admin/performance'+queryString(selected));if(!isCurrent(epoch))return;
    const summary=report.summary||{},currency=report.account?.currency;
    area.append(detailGrid([['Account',report.account?.label||report.account?.id||'Assessment'],['Currency',currency||'Not recorded'],['Recorded net result',currencyAmount(summary.netProfit,currency)],['Closing fills',count(summary.closedTradeCount)],['Closing fill win rate',percent(summary.winRate)],['Expectancy per closing fill',currencyAmount(summary.expectancy,currency)],['Profit factor',finite(summary.profitFactor)?String(summary.profitFactor):stateLabel(summary.profitFactorStatus)],['Observed equity drawdown',currencyAmount(report.drawdown?.observedEquity?.maxAmount,currency)],['Realized balance drawdown',currencyAmount(report.drawdown?.realizedBalance?.maxAmount,currency)]]));
    const coverage=report.coverage||{};area.append(note([text(coverage.notice),text(coverage.closedFillUnit),text(coverage.explanation),...rows(coverage.warnings).map(text),coverage.historyComplete===false||coverage.complete===false||coverage.status==='partial'?'The imported history is incomplete. Statistics cover the recorded subset.':'',text(report.consistency?.explanation)].filter(Boolean).join(' ')));
    const charts=node('div','grid min-w-0 gap-6 xl:grid-cols-2');charts.append(lineChart(report.equityCurve,'equity','Observed equity',currency),lineChart(report.balanceCurve,'balance',report.balanceCurve?.kind==='realized_balance'?'Realized balance':'Observed balance',currency));append(charts);
    const monthly=card('Monthly results','UTC months from recorded closing fills and trading costs. Deposits and withdrawals are shown as cash flows, not trading profit.');monthly.append(table([{title:'UTC month',value:item=>item.month},{title:'Net trading result',value:item=>currencyAmount(item.netProfit,currency)},{title:'Cash flows',value:item=>currencyAmount(item.cashFlows,currency)},{title:'Closing fills',value:item=>count(item.closedTradeCount)},{title:'Fill win rate',value:item=>percent(item.winRate)}],rows(report.monthly)));append(monthly);
    const consistency=report.consistency||{},analysis=card('Consistency analysis','Descriptive concentration measures do not introduce a new qualification rule.');analysis.append(detailGrid([['Positive days',count(consistency.positiveDays)],['Negative days',count(consistency.negativeDays)],['Flat days',count(consistency.flatDays)],['Best day',consistency.bestDay||'Not recorded'],['Best day’s share of positive profit',percent(consistency.bestDayShareOfPositiveProfitPercent)],['Largest winning fill concentration',percent(consistency.largestWinningFillSharePercent)]]));append(analysis);
  }
  function backupAction(){return openAction({title:'Create an encrypted backup',description:'Create a consistent private database and authentication-key backup, then verify recovery in an isolated temporary directory. The backup encryption key must be kept separately. This does not replace the running database.',fields:[reasonField],submit:'Back up and verify',execute:async form=>{const result=await post('/api/admin/operations/backup',{reason:form.get('reason')});return{...result,message:result.verified===true?'Encrypted backup created and isolated recovery verification passed.':'The backup operation returned. Inspect its recorded status.'};}});}
  function checkAction(backups,selected){return openAction({title:'Check recovery in isolation',description:'Decrypt the selected backup into a temporary directory, verify database integrity and keys, reapply current deletions, and check authentication recovery. Production records are not replaced.',fields:[{name:'backupId',label:'Backup to verify',choices:[['','Latest backup'],...backups.map(item=>[item.id,`${date(item.createdAt)} · ${item.id}`])],value:selected||'',required:false},reasonField],submit:'Run recovery check',execute:async form=>{const result=await post('/api/admin/operations/check',{backupId:form.get('backupId')||undefined,reason:form.get('reason')});return{...result,message:result.integrity==='ok'&&result.productionModified===false?'Isolated recovery verification passed. Production was not modified.':'The recovery check returned. Inspect its recorded result.'};}});}
  function diagnosticAction(){return openAction({title:'Run database & storage diagnostics',description:'Check database integrity and relationships, and test private storage access. This does not repair records or contact email or trading providers.',fields:[reasonField],submit:'Run diagnostics',execute:async form=>{
    const result=await post('/api/admin/operations/diagnose',{reason:form.get('reason')});
    return {...result,message:result.state==='ok'?'Database and storage diagnostics passed. Review the separate readiness warnings.':result.state==='critical'?'Diagnostics found a problem. Review the recorded result and follow the readiness actions.':'Diagnostics need attention. Review the recorded result before proceeding.'};
  }});}
  function downloadHealth(health,epoch){
    if(!isCurrent(epoch))return;
    let url,anchor;
    try{
      const report=operationalReport(health);
      if(report.checkedAt===null)throw new Error('Refresh the health checks before downloading a report.');
      url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)+'\n'],{type:'application/json'}));
      anchor=document.createElement('a');anchor.href=url;anchor.download=`fundraiser-academy-operations-${new Date(report.checkedAt).toISOString().slice(0,10)}.json`;
      document.body.append(anchor);anchor.click();
      notify('The readiness report download started. Keep operational reports private.');
    }catch{notify('The readiness report could not be downloaded. Refresh the checks and try again.',true);}
    finally{anchor?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),1000);}
  }
  function operationalHealth(health,epoch){
    const data=operationalReport(health),metrics=data.metrics;
    const area=card('Operational health','Current local checks and configuration, with actions for issues that need staff attention. Refresh to collect a new snapshot.');
    area.append(detailGrid([['Overall status',data.checkedAt===null?'Unavailable':({healthy:'Healthy',attention:'Needs attention',critical:'Critical'})[data.overall]],['Checked',date(data.checkedAt)],['Server uptime',uptime(metrics.uptimeSeconds)],['Process memory',bytes(metrics.rssBytes)],['Heap in use',bytes(metrics.heapUsedBytes)],['Database size',bytes(metrics.databaseBytes)],['Write-ahead log',bytes(metrics.walBytes)],['Storage available',`${bytes(metrics.storageFreeBytes)} of ${bytes(metrics.storageTotalBytes)}`]]));
    if(data.checks.length){
      const checks=node('div','mt-5 grid min-w-0 gap-3 lg:grid-cols-2');checks.setAttribute('aria-label','Operational readiness checks');
      for(const item of data.checks){
        const check=node('article','min-w-0 rounded-xl border border-line bg-[#101010] p-4');
        const heading=node('div','flex flex-wrap items-start justify-between gap-2');
        const label=node('h3','min-w-0 break-words text-sm font-semibold',item.label||'Readiness check');
        const severity=item.state==='critical'?'bg-rose-400/10 text-rose-300':item.state==='warning'?'bg-amber-300/10 text-amber-300':'bg-white/5 text-muted';
        heading.append(label,node('span',`shrink-0 rounded-full px-2 py-1 text-xs font-semibold ${severity}`,healthStates[item.state]));
        const action=node('div','mt-3 border-t border-line pt-3');
        action.append(node('p','text-xs font-semibold','Next action'),node('p','mt-1 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted',item.action||'No action recorded'));
        check.append(heading,node('p','mt-3 whitespace-pre-wrap break-words text-sm leading-relaxed text-muted',item.summary||'Not recorded'),action);checks.append(check);
      }
      area.append(checks);
    }else area.append(note('No health checks are available yet. Refresh after the application update finishes.'));
    area.append(note(data.notice));
    const actions=group(button('Refresh health checks',async()=>{if(!isCurrent(epoch))return;try{await reload();}catch{notify('The health checks could not be refreshed. Try again.',true);}}));
    if(can('system.read')){
      const run=button('Run diagnostics',()=>{if(isCurrent(epoch)&&!data.diagnosticRunning)return diagnosticAction();});run.disabled=data.diagnosticRunning;actions.append(run);
      if(data.checkedAt!==null)actions.append(button('Download readiness report',()=>downloadHealth(data,epoch)));
    }
    area.append(actions);append(area);
    const diagnostics=card('Database & storage diagnostics','Read-only database checks and a private storage-access probe. A passing check does not verify offsite backups or external services.');
    if(data.diagnosticRunning)diagnostics.append(note('A database and storage diagnostic is running. Refresh health checks to see its completed result.'));
    if(data.lastDiagnostic)diagnostics.append(detailGrid([['Latest result',diagnosticStates[data.lastDiagnostic.state]],['Completed',date(data.lastDiagnostic.completedAt)],['Database access',stateLabel(data.lastDiagnostic.database)],['Integrity',stateLabel(data.lastDiagnostic.integrity)],['Foreign keys',stateLabel(data.lastDiagnostic.foreignKeys)],['Private storage access',stateLabel(data.lastDiagnostic.storageWritable)],['Failure code',data.lastDiagnostic.failureCode||'None recorded']]));
    else diagnostics.append(note('Diagnostics have not been run. Use Run diagnostics to check the current database and storage.'));
    if(data.diagnosticRuns.length)diagnostics.append(table([{title:'Started',value:item=>date(item.startedAt)},{title:'Completed',value:item=>date(item.completedAt)},{title:'Result',value:item=>diagnosticStates[item.state]},{title:'Integrity',value:item=>stateLabel(item.integrity)},{title:'Foreign keys',value:item=>stateLabel(item.foreignKeys)},{title:'Storage access',value:item=>stateLabel(item.storageWritable)},{title:'Failure code',value:item=>item.failureCode||'—'}],data.diagnosticRuns));
    append(diagnostics);
  }
  function resolveIncident(item){return openAction({title:'Resolve an operational incident',description:'Mark this sanitized error group as reviewed. Its history is preserved, and a new occurrence will reopen it.',fields:[reasonField],submit:'Mark incident resolved',execute:form=>post(`/api/admin/errors/${item.id}/resolve`,{reason:form.get('reason')})});}
  async function operations(epoch){
    const query=getQuery();const [status,errors]=await Promise.all([api('/api/admin/operations'),api('/api/admin/errors'+queryString({limit:25,offset:query.offset||0,state:query.errorState||'open'}))]);if(!isCurrent(epoch))return;
    operationalHealth(status.health,epoch);
    const area=card('Backups & recovery','Consistent encrypted backups and automatic isolated recovery verification. Local backups still need durable storage and an independent offsite copy.');
    area.append(detailGrid([['Automatic backups',status.automaticBackups?'Scheduled':'Not running'],['Encryption',status.encrypted?'Enabled':'Not available'],['Interval',finite(status.backupIntervalHours)?`${status.backupIntervalHours} hours`:'Not recorded'],['Retention',Number.isSafeInteger(status.retentionCount)?`${status.retentionCount} backups`:'Not recorded'],['Next scheduled backup',date(status.nextBackupAt)],['Operation',status.running?'Running':'Idle'],['Offsite copy',status.offsiteConfigured?'Configured':'Not configured'],['Open error groups',count(status.errors?.open)]]));
    area.append(note(text(status.backupKeyNotice)),note(text(status.recoveryNotice)));
    if(can('system.read'))area.append(group(button('Create backup & verify',backupAction),button('Check latest recovery',()=>checkAction(rows(status.backups)))));
    append(area);
    const backups=card('Private backup history','Artifacts remain outside the public website. Backup bytes and keys are not returned to this browser.');backups.append(table([{title:'Created',value:item=>date(item.createdAt)},{title:'Backup ID',value:item=>item.id},{title:'Encrypted size',value:item=>Number.isSafeInteger(item.bytes)?`${item.bytes.toLocaleString()} bytes`:'Not recorded'},{title:'State',value:item=>stateLabel(item.state)},{title:'Verified',value:item=>date(item.verifiedAt)},{title:'Action',value:item=>can('system.read')?button('Verify recovery',()=>checkAction(rows(status.backups),item.id)):'Privileged access required'}],rows(status.backups)));append(backups);
    const runs=card('Operational runs','Completed verification results describe an isolated copy, never an automatic restore over the live database.');runs.append(table([{title:'Started',value:item=>date(item.startedAt)},{title:'Kind',value:item=>stateLabel(item.kind)},{title:'Status',value:item=>stateLabel(item.status)},{title:'Failure code',value:item=>item.failureCode||'—'},{title:'Result',value:item=>{const result=item.result?.recovery||item.result||{};return result.integrity==='ok'?`Integrity OK · ${count(result.deletionsReapplied)} deletion records reapplied · ${count(result.passwordResetsRequired)} accounts require password recovery`:item.status==='completed'?'Completed':'Not completed';}}],rows(status.recentRuns)));append(runs);
    const errorPage=pageRows(errors),monitor=card('Error monitoring','Server-side incidents are grouped by sanitized route and error code. Request bodies, credentials, private exception text, and full stacks are not shown.');
    monitor.append(filters([{name:'errorState',label:'Incident state',choices:[['open','Open'],['resolved','Resolved'],['all','All recorded']]}],query,values=>{setQuery({...values,offset:0});reload();}),table([{title:'Category',value:item=>stateLabel(item.category)},{title:'Code',value:item=>item.code},{title:'Route',value:item=>`${item.method} ${item.route}`},{title:'Description',value:item=>item.description},{title:'Occurrences',value:item=>count(item.count)},{title:'First seen',value:item=>date(item.firstSeen)},{title:'Latest',value:item=>date(item.lastSeen)},{title:'Review',value:item=>item.state==='open'&&can('system.read')&&typeof item.id==='string'&&/^[a-f0-9]{64}$/.test(item.id)?button('Resolve incident',()=>resolveIncident(item)):stateLabel(item.state)}],errorPage.items),navigation(errorPage));append(monitor);
  }
  async function privacy(epoch){
    const query=getQuery();const data=await api('/api/admin/privacy'+queryString({limit:25,offset:query.offset||0,status:query.status||'pending_closure'}));if(!isCurrent(epoch))return;
    const page=pageRows(data),area=card('Account deletion requests','Only the account owner can initiate deletion. Complete a pending request after staff access, sponsored allocations, and earned payments are resolved. Immutable legal and financial records remain listed in the receipt.');
    area.append(filters([{name:'status',label:'Deletion request state',choices:[['pending_closure','Pending closure'],['deleted','Completed'],['all','All requests']]}],query,values=>{setQuery({...values,offset:0});reload();}),table([{title:'Client',value:item=>`${item.name||'Deleted account'} · #${item.userId}`},{title:'Email',value:item=>item.email},{title:'Requested',value:item=>date(item.requestedAt)},{title:'State',value:item=>stateLabel(item.status)},{title:'Blockers',value:item=>messages(item.blockers)||'None recorded'},{title:'Retained categories',value:item=>retention(item.retained)||'None recorded'},{title:'Action',value:item=>{
      if(item.status!=='pending_closure')return 'Completed receipt';
      if(rows(item.blockers).length)return 'Resolve listed obligations first';
      if(!can('traders.manage'))return 'Owner / admin required';
      return button('Complete requested deletion',()=>openAction({title:'Complete a customer’s deletion request',description:`Client #${item.userId} already requested account closure. This signs out the customer, removes mutable operational personal data, and retains the categories disclosed in their receipt. This action cannot be undone from the website.`,fields:[reasonField],submit:'Complete requested account deletion',execute:form=>post(`/api/admin/privacy/${positiveInteger(item.userId,'client ID')}/complete`,{reason:form.get('reason')})}));
    }}],page.items),navigation(page));append(area);
  }
  return {connections,performance,operations,privacy};
}
