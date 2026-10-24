import {decimalToUnits,positiveInteger} from './admin-api.js';

const rows=value=>Array.isArray(value)?value:[];
const text=value=>typeof value==='string'?value:'';
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
const revision=value=>{if(!Number.isSafeInteger(value)||value<1)throw new Error('Refresh the current record before changing it.');return value;};
const reasonField={name:'reason',label:'Reason for this administrative change',type:'textarea',maxLength:500,help:'Recorded in the audit trail. Do not include passwords, account credentials, or bank details.'};

export function lagosTimestamp(value){
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value))throw new Error('Enter a valid date and time in Africa/Lagos.');
  const parsed=Date.parse(value+'+01:00');
  if(!Number.isFinite(parsed)||new Date(parsed+3600000).toISOString().slice(0,value.length)!==value)throw new Error('Enter a valid date and time in Africa/Lagos.');
  return parsed;
}

export async function reinstatementDocument(result){
  const document=result?.document;
  if(!object(document)||document.format!=='text'||typeof document.contentBase64!=='string'||!document.contentBase64||document.contentBase64.length>14000000||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(document.contentBase64)||!/^[a-f0-9]{64}$/.test(text(document.hash))||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,179}\.txt$/.test(text(document.fileName))||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(text(document.version)))throw new Error('The prepared agreement could not be verified. Retry before publishing any document.');
  const bytes=Uint8Array.from(atob(document.contentBase64),character=>character.charCodeAt(0));
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
  if(hash!==document.hash)throw new Error('The prepared agreement did not match its document hash. Retry before publishing.');
  const content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  return{content,fileName:document.fileName,version:text(document.version),hash};
}

export function createAdminProfitSharing(ctx){
  const {api,post,can,node,card,table,detailGrid,button,openAction,cents,percent,content,isCurrent}=ctx;
  let prepared=null,generation=0;
  function clearPrepared(){prepared=null;generation++;}
  const date=value=>Number.isSafeInteger(value)&&value>0&&value<=8640000000000000?new Date(value).toLocaleString(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Lagos'})+' WAT':'Not recorded';
  const group=(...items)=>{const area=node('div','mt-5 flex flex-wrap gap-3');area.append(...items);return area;};
  const note=value=>node('p','mt-4 whitespace-pre-wrap break-words text-xs leading-relaxed text-muted',value);
  const progressive=account=>account?.sharingModel==='progressive_cleared'||account?.profitSharingPolicy==='progressive_cleared';
  function createAccountAction(){
    if(!can('finance.write'))return;
    return openAction({title:'Record a progressive sponsored account',description:'Record an externally arranged account after the revised agreement is signed and sponsorship approved. A newly admitted fundraiser starts at 50%; earned 60% or 70% tiers remain across additional accounts. The server derives the applicable tier. This does not purchase or issue a prop account.',fields:[
      {name:'userId',label:'Approved fundraiser client ID',type:'number',min:1,step:1},
      {name:'firmName',label:'Prop firm name',maxLength:160},
      {name:'label',label:'Account label',maxLength:160,help:'Use a descriptive label, not a login, password, or API key.'},
      {name:'accountSize',label:'Nominal account size (USD)',type:'number',min:0.01,step:0.01,help:'The allocation size is not a cleared payout and does not advance a tier.'},
      {name:'evidence',label:'Agreement / external account evidence',type:'textarea',maxLength:2000},reasonField
    ],submit:'Save progressive account',execute:form=>post('/api/admin/accounts',{userId:positiveInteger(form.get('userId'),'client ID'),firmName:form.get('firmName'),label:form.get('label'),accountSizeCents:decimalToUnits(form.get('accountSize')),profitSharingPolicy:'progressive_cleared',evidence:form.get('evidence'),reason:form.get('reason')})});
  }
  function relationshipAction(progression,userId){
    if(!can('finance.write'))return;
    const reinstate=progression.status==='terminated';
    const fields=reinstate?[
      {name:'writtenAgreementReference',label:'Written reinstatement / new agreement reference',maxLength:160,help:'Identify the actual writing agreed by both parties before the new sponsorship.'},
      {name:'startingTraderShareBps',label:'Fundraiser tier expressly agreed for reinstatement',choices:[['','Choose the written tier'],['5000','50% fundraiser / 50% academy'],['6000','60% fundraiser / 40% academy'],['7000','70% fundraiser / 30% academy']]},
      {name:'traderConsentConfirmed',label:'Both parties expressly agreed to this reinstatement tier in writing, and the fundraiser signed the required current agreement.',type:'checkbox',required:true},reasonField
    ]:[
      {name:'terminationConfirmed',label:'I am recording an actual termination under the applicable agreement. All sponsored accounts in this relationship are closed.',type:'checkbox',required:true},reasonField
    ];
    return openAction({title:reinstate?'Record written reinstatement terms':'Record contractual relationship termination',description:reinstate?'Reinstatement does not silently reset an earned tier. Record the tier expressly agreed in writing, after a fresh signature and current sponsorship approval. Earlier accrued entitlements remain payable.':'Closing one account does not end the contractual relationship or reduce the earned tier. Record termination only after the relationship has actually ended and all its accounts are closed. Accrued unpaid entitlements remain payable.',fields,submit:reinstate?'Record agreed reinstatement':'Record relationship termination',execute:form=>{
      if(reinstate&&form.get('traderConsentConfirmed')!=='on')throw new Error('Confirm the written agreement of both parties before reinstatement.');
      if(!reinstate&&form.get('terminationConfirmed')!=='on')throw new Error('Confirm the actual relationship termination before recording it.');
      const payload={action:reinstate?'reinstate':'terminate',revision:revision(progression.revision),reason:form.get('reason')};
      if(reinstate){const tier=Number(form.get('startingTraderShareBps'));if(![5000,6000,7000].includes(tier))throw new Error('Choose the tier expressly agreed in writing.');Object.assign(payload,{writtenAgreementReference:form.get('writtenAgreementReference'),traderConsentConfirmed:true,startingTraderShareBps:tier});}
      return post(`/api/admin/traders/${positiveInteger(userId,'client ID')}/profit-sharing`,payload);
    }});
  }
  function prepareReinstatementAction(progression,userId){
    if(!can('finance.write')||progression?.status!=='terminated')return;
    return openAction({title:'Prepare the written reinstatement agreement',description:'Prepare a personal agreement identifying this fundraiser’s ended relationship, the written reference, and the proposed starting tier. Download and review it, then publish it only for this fundraiser. Preparation does not publish a contract, record consent, or reinstate sponsorship.',fields:[
      {name:'writtenAgreementReference',label:'Written reinstatement / new agreement reference',maxLength:160},
      {name:'startingTraderShareBps',label:'Proposed tier for the new written agreement',choices:[['','Choose the tier to propose'],['5000','50% fundraiser / 50% academy'],['6000','60% fundraiser / 40% academy'],['7000','70% fundraiser / 30% academy']]},reasonField
    ],submit:'Prepare and download agreement',execute:async form=>{
      const expectedGeneration=generation;
      const startingTraderShareBps=Number(form.get('startingTraderShareBps'));if(![5000,6000,7000].includes(startingTraderShareBps))throw new Error('Choose the tier to include in the proposed written agreement.');
      const result=await post(`/api/admin/traders/${positiveInteger(userId,'client ID')}/profit-sharing/prepare-reinstatement`,{revision:revision(progression.revision),writtenAgreementReference:form.get('writtenAgreementReference'),startingTraderShareBps,reason:form.get('reason')});
      if(expectedGeneration!==generation)throw new Error('This administrative page is no longer active. Prepare the agreement again after signing in.');
      if(result.recipientUserId!==userId||result.previousRelationshipId!==progression.id)throw new Error('The prepared agreement does not match this fundraiser and relationship. Refresh before preparing it again.');
      const verified=await reinstatementDocument(result);let url,link;
      if(expectedGeneration!==generation)throw new Error('This administrative page is no longer active. Prepare the agreement again after signing in.');
      try{url=URL.createObjectURL(new Blob([verified.content],{type:'text/plain;charset=utf-8'}));link=document.createElement('a');link.href=url;link.download=verified.fileName;document.body.append(link);link.click();}
      finally{link?.remove();if(url)setTimeout(()=>URL.revokeObjectURL(url),1000);}
      prepared={recipientUserId:userId,previousRelationshipId:progression.id,document:result.document};
      return{message:`Personal agreement ${verified.version} prepared for Fundraiser #${userId}. Review the downloaded document, then choose Publish prepared personal agreement here. An authorized publisher can also upload the exact file under Agreements with recipient client ID ${userId}. The fundraiser must personally sign it and receive fresh sponsorship approval before reinstatement.`};
    }});
  }
  function publishPreparedAction(progression,userId){
    if(!can('contracts.publish')||!prepared||prepared.recipientUserId!==userId||prepared.previousRelationshipId!==progression.id)return;
    const selection=prepared;
    return openAction({title:'Publish the personal reinstatement agreement',description:`Publish the reviewed agreement only for Fundraiser #${userId}. Version: ${selection.document.version}. SHA-256: ${selection.document.hash}. Other fundraisers keep their own required agreements. Publication records company authorization; it does not sign for the fundraiser or approve sponsorship.`,fields:[reasonField,{name:'authorized',label:'I reviewed the prepared document and am authorized to publish it only for this fundraiser.',type:'checkbox',required:true}],submit:'Publish personal agreement',execute:async form=>{
      if(form.get('authorized')!=='on')throw new Error('Confirm authorization to publish this personal agreement.');
      const {contentBase64,format,version,title,fileName}=selection.document;
      const result=await post('/api/admin/contracts',{contentBase64,format,version,title,fileName,recipientUserId:selection.recipientUserId,reason:form.get('reason')});
      if(prepared===selection)prepared=null;
      return{...result,message:`Personal agreement published only for Fundraiser #${userId}. The fundraiser must read and sign it from their agreement page before a fresh review and reinstatement.`};
    }});
  }
  function progressionCard(progression,userId,{actions=true}={}){
    const area=card('Progressive profit sharing','One retained tier across eligible accounts and approved prop firms during the continuous contractual relationship.');
    if(!object(progression)){
      area.append(note('No progressive relationship has been recorded. Earlier signed fixed-share terms remain separate. The revised model begins through a properly signed and approved sponsored account.'));
      return area;
    }
    const current=progression.currentTraderShareBps,remaining=Number.isSafeInteger(progression.nextThresholdCents)&&Number.isSafeInteger(progression.cumulativeQualifyingNetPayoutsCents)?Math.max(0,progression.nextThresholdCents-progression.cumulativeQualifyingNetPayoutsCents):null;
    area.append(detailGrid([
      ['Relationship',progression.status==='terminated'?'Terminated — accrued entitlements remain payable':'Active'],
      ['Retained fundraiser / academy tier',`${percent(current/100)} / ${percent(progression.currentCompanyShareBps/100)}`],
      ['Cumulative qualifying net payouts',cents(progression.cumulativeQualifyingNetPayoutsCents)],
      ['Next threshold',progression.nextThresholdCents===null?'Maximum standard tier reached':cents(progression.nextThresholdCents)],
      ['Qualifying net payouts to next tier',remaining===null?'No further standard tier':cents(remaining)],
      ['Next tier',progression.nextTraderShareBps===null?'70% standard maximum':percent(progression.nextTraderShareBps/100)],
      ['Relationship started',date(progression.startedAt)],['Terminated',date(progression.terminatedAt)],['Signed agreement',progression.contractVersion||'Not recorded']
    ]));
    area.append(note('Only actually received and cleared qualifying net prop-firm payouts advance the tier. A threshold-crossing receipt uses the previous tier; the increased percentage starts with the next eligible receipt. Prior distributions are not recalculated. Trading losses and account closures do not lower an earned tier.'));
    if(actions&&can('finance.write')){
      const controls=group();if(progression.status==='terminated')controls.append(button('Prepare reinstatement agreement',()=>prepareReinstatementAction(progression,userId)));
      if(progression.status==='terminated'&&prepared?.recipientUserId===userId&&prepared.previousRelationshipId===progression.id&&can('contracts.publish'))controls.append(button('Publish prepared personal agreement',()=>publishPreparedAction(progression,userId)));
      controls.append(button(progression.status==='terminated'?'Record written reinstatement terms':'Record relationship termination',()=>relationshipAction(progression,userId)));area.append(controls);
    }
    return area;
  }
  async function traderProgression(epoch,userId){
    if(!can('finance.read'))return;
    const result=await api(`/api/admin/traders/${positiveInteger(userId,'client ID')}/profit-sharing`);
    if(!isCurrent(epoch))return;
    content.append(progressionCard(result.progression,userId));
    if(rows(result.relationships).length>1){const history=card('Contractual relationship history','Each terminated relationship retains its earned and unpaid records. A later written reinstatement starts with its expressly recorded tier.');history.append(table([{title:'Status',value:item=>item.status},{title:'Started',value:item=>date(item.startedAt)},{title:'Terminated',value:item=>date(item.terminatedAt)},{title:'Retained fundraiser tier',value:item=>percent(item.currentTraderShareBps/100)},{title:'Qualifying net payouts',value:item=>cents(item.cumulativeQualifyingNetPayoutsCents)},{title:'Agreement',value:item=>item.contractVersion}],result.relationships));content.append(history);}
  }
  function receiptAction(account){
    if(!can('finance.write')||!progressive(account))return;
    return openAction({title:'Record a cleared prop-firm payout',description:'Record funds actually received and cleared by the company after prop-firm deductions. Only agreed third-party charges may be deducted here. This creates an immutable payout statement and fundraiser entitlement; simulated profits, account equity, and uncleared estimates do not qualify.',fields:[
      {name:'amountReceived',label:'Company received after prop-firm deductions (USD)',type:'number',min:0.01,step:0.01},
      {name:'thirdPartyCharges',label:'Agreed third-party charges to deduct (USD)',type:'number',min:0,step:0.01,value:'0'},
      {name:'chargesAgreementReference',label:'Agreement reference for third-party charges',maxLength:160,required:false,help:'Required if charges are greater than zero. Do not deduct the same charges twice.'},
      {name:'externalReference',label:'Unique prop-firm cleared-payout reference',maxLength:120,help:'Reuse the same reference only when retrying the same receipt. It is unique across this fundraiser’s accounts.'},
      {name:'clearedAt',label:'Funds cleared at (Africa/Lagos, UTC+01:00)',type:'datetime-local',step:1,help:'Use the actual cleared-funds receipt time, not the time you enter this record. Receipts must be recorded in receipt-time order.'},
      {name:'evidence',label:'Cleared funds / reconciliation evidence',type:'textarea',maxLength:2000},
      {name:'clearedConfirmed',label:'These funds were actually received and cleared by the company, and any charges are agreed and not already deducted.',type:'checkbox',required:true},reasonField
    ],submit:'Record cleared receipt & statement',execute:form=>{
      if(form.get('clearedConfirmed')!=='on')throw new Error('Confirm actual cleared receipt of the funds before recording an entitlement.');
      const amountReceivedCents=decimalToUnits(form.get('amountReceived')),thirdPartyChargesCents=decimalToUnits(form.get('thirdPartyCharges')||'0');
      if(amountReceivedCents<=0||thirdPartyChargesCents>amountReceivedCents)throw new Error('The received amount must be positive, and agreed charges cannot exceed it.');
      const chargesAgreementReference=text(form.get('chargesAgreementReference')).trim();if(thirdPartyChargesCents&&!chargesAgreementReference)throw new Error('Record the written agreement reference for the third-party charges.');
      return post(`/api/admin/accounts/${account.id}/receipts`,{amountReceivedCents,thirdPartyChargesCents,externalReference:form.get('externalReference'),clearedAt:lagosTimestamp(form.get('clearedAt')),evidence:form.get('evidence'),...(chargesAgreementReference?{chargesAgreementReference}:{}),reason:form.get('reason')});
    }});
  }
  function receiptsCard(receipts){
    const area=card('Cleared payout statements','Each immutable statement records the amount received, charges, applied split, entitlements, and updated fundraiser-wide qualifying total. Payment initiation is due within three business days of cleared funds.');
    if(!rows(receipts).length){area.append(note('No cleared prop-firm payout is recorded for this account. Trading observations and profit/loss reports do not create qualifying receipts.'));return area;}
    for(const item of rows(receipts)){
      const entry=node('article','mb-4 min-w-0 rounded-xl border border-line bg-[#101010] p-4');entry.append(node('h3','mb-4 break-words text-sm font-semibold',item.externalReference||item.id||'Cleared payout statement'));
      entry.append(detailGrid([
        ['Received after firm deductions',cents(item.amountReceivedCents)],['Agreed third-party charges',cents(item.thirdPartyChargesCents)],['Qualifying net payout',cents(item.qualifyingNetPayoutCents)],
        ['Applied fundraiser share',percent(item.appliedTraderShareBps/100)],['Fundraiser entitlement',cents(item.traderShareCents)],['Academy entitlement',cents(item.companyShareCents)],
        ['Cumulative before receipt',cents(item.cumulativeBeforeCents)],['Updated cumulative payouts',cents(item.cumulativeAfterCents)],['Fundraiser share on next receipt',percent(item.nextTraderShareBps/100)],
        ['Funds cleared',date(item.clearedAt)],['Initiate payment by',date(item.initiationDueAt)],['Initiation outstanding',cents(item.outstandingCents)]
      ]));
      if(item.overdue)entry.append(node('p','mt-4 font-semibold text-rose-300','Payment initiation is overdue. Review the outstanding entitlement and record the actual external initiation.'));
      if(item.chargesAgreementReference)entry.append(note('Charges agreement: '+item.chargesAgreementReference));if(item.evidence)entry.append(note('Reconciliation evidence: '+item.evidence));area.append(entry);
    }
    area.append(note('Deadlines use Monday–Friday business days in Africa/Lagos. A recorded initiation documents an external action and does not send money from this website.'));return area;
  }
  function initiationAction(item){
    if(!can('finance.write')||item.status!=='approved'||item.initiatedAt)return;
    return openAction({title:'Record external payment initiation',description:`Record an actual external initiation for ${cents(item.amountCents)}. ${Number.isFinite(item.initiationDueAt)?'Initiation deadline: '+date(item.initiationDueAt)+'. ':''}Approval alone does not meet the three-business-day initiation requirement. This website does not execute a transfer.`,fields:[
      {name:'externalInitiationReference',label:'External payment initiation reference',maxLength:120,help:'Use the actual bank or payment-provider initiation reference. Do not include bank credentials.'},
      {name:'initiatedAt',label:'Initiated at (Africa/Lagos, UTC+01:00)',type:'datetime-local',required:false,help:'Leave blank to record the current server time.'},
      {name:'initiationConfirmed',label:'This payment was actually initiated externally. I am recording the evidence, not requesting the website to transfer funds.',type:'checkbox',required:true},reasonField
    ],submit:'Record external initiation',execute:form=>{
      if(form.get('initiationConfirmed')!=='on')throw new Error('Confirm that the payment was actually initiated externally.');
      const externalInitiationReference=text(form.get('externalInitiationReference')).trim();if(!externalInitiationReference)throw new Error('Enter the actual external initiation reference.');
      const initiatedAt=form.get('initiatedAt');return post(`/api/admin/payouts/${item.id}/initiate`,{revision:revision(item.revision),externalInitiationReference,...(initiatedAt?{initiatedAt:lagosTimestamp(initiatedAt)}:{}),reason:form.get('reason')});
    }});
  }
  function initiationControl(item){
    if(!can('finance.write')||item.status!=='approved'||item.initiatedAt)return null;
    return button('Record external initiation',()=>initiationAction(item));
  }
  function payoutTiming(item){
    const due=Number.isFinite(item.initiationDueAt)?date(item.initiationDueAt):'Not attached to a cleared receipt';
    const initiation=item.initiatedAt?'Initiated '+date(item.initiatedAt):item.processingState==='paid'||item.status==='paid'?'Paid externally':item.processingState==='rejected'||item.status==='rejected'?'Rejected / released':'Not initiated';
    return `${initiation} · Deadline: ${due}${item.overdue?' · OVERDUE':''}${item.initiationWasLate?' · Initiated after deadline':''}`;
  }
  return{progressive,createAccountAction,traderProgression,progressionCard,prepareReinstatementAction,publishPreparedAction,clearPrepared,receiptAction,receiptsCard,initiationAction,initiationControl,payoutTiming};
}
