import {loadContractStatus} from './contract-status.js';
const $=id=>document.getElementById(id);
let current=null;
let documentLoaded=false;
let refreshing=false;
const date=value=>new Date(value).toLocaleString();
function setVisible(id,visible){$(id).hidden=!visible;}
function addDetail(label,value){const item=document.createElement('div');const term=document.createElement('dt');term.className='metric-label';term.textContent=label;const detail=document.createElement('dd');detail.className='break-all';detail.textContent=value;item.append(term,detail);$('receipt-details').append(item);}
function updateSubmit(){ $('sign-contract').disabled=refreshing||!documentLoaded||current?.status!=='signature_required'||!$('contract-consent').checked||!$('legal-name').checkValidity(); }
async function refresh(){
  if(refreshing)return;
  refreshing=true;documentLoaded=false;updateSubmit();$('refresh-contract').disabled=true;
  try{
    const result=await loadContractStatus();current=result;document.querySelector('main').hidden=false;
    $('assessment-step').textContent=result.assessmentPassed?'Passed':'In progress';
    $('agreement-step').textContent={assessment_required:'Available after passing',awaiting_contract:'Awaiting company agreement',signature_required:'Signature required',signed:'Signed'}[result.status];
    $('review-step').textContent=result.canProceedToFundingReview?'Ready for company review':'Agreement required first';
    $('contract-heading').textContent={assessment_required:'Complete your assessment first',awaiting_contract:'Assessment passed. Agreement pending.',signature_required:'Your agreement is ready to sign',signed:'Your required agreement is signed'}[result.status];
    $('contract-status').textContent={assessment_required:'Reach 10% realized profit over at least 3 distinct trading days, within drawdown limits, with all positions closed. Your agreement becomes available after a server-confirmed pass.',awaiting_contract:'The company has not provided the contract yet. There is nothing to sign today. Return here when it is available; this required step must be completed before sponsorship review.',signature_required:'Review the full company agreement below. If you agree, sign using your full legal name. Your signature is tied to this exact document and version.',signed:'Your signature is saved against the exact agreement you reviewed. You have completed this required step; the company must still review sponsorship eligibility.'}[result.status];
    setVisible('assessment-link',!result.assessmentPassed);setVisible('contract-document',Boolean(result.contract));setVisible('signature-panel',result.status==='signature_required');setVisible('signature-receipt',result.status==='signed');
    $('document-error').textContent='';$('receipt-details').replaceChildren();
    if(result.contract){
      const contract=result.contract;
      $('document-title').textContent=contract.title;$('document-version').textContent=`Version ${contract.version} · Published ${date(contract.publishedAt)}`;
      $('document-hash').textContent=`Document SHA-256: ${contract.hash}`;
      $('document-download').href=contract.documentUrl;
      setVisible('contract-text',contract.format==='text');setVisible('contract-pdf',contract.format==='pdf');
      const response=await fetch(contract.documentUrl);
      if(!response.ok)throw new Error('Could not load the agreement. Please check for updates and try again.');
      if(contract.format==='text')$('contract-text').textContent=await response.text();
      else{$('contract-pdf').src=contract.documentUrl;await response.arrayBuffer();}
      documentLoaded=true;
      $('consent-statement').textContent=result.consentStatement;
      if(!$('legal-name').value)$('legal-name').value=result.registeredName;
    }
    if(result.status==='signed'){
      const signed=result.signature;
      addDetail('Signed by',signed.legalName);addDetail('Signed at',date(signed.signedAt));addDetail('Agreement version',signed.contractVersion);addDetail('Signature ID',signed.id);addDetail('Document hash',signed.contractHash);addDetail('Assessment certificate',signed.certificateId);
    }
    $('history-list').replaceChildren();
    const history=result.history.filter(item=>item.id!==result.signature?.id);
    setVisible('signature-history',Boolean(history.length));
    for(const entry of history){const item=document.createElement('p');item.className='break-words text-sm text-muted';item.textContent=`${entry.legalName} · Version ${entry.contractVersion} · ${date(entry.signedAt)}`;const link=document.createElement('a');link.className='desk-action ml-3 inline-block';link.textContent='View agreement';link.href=`/api/contracts/${entry.contractId}/document`;link.target='_blank';link.rel='noopener';item.append(link);$('history-list').append(item);}
  }catch(error){document.querySelector('main').hidden=false;$('contract-status').textContent=error.message;$('document-error').textContent=error.message;}
  finally{refreshing=false;$('refresh-contract').disabled=false;updateSubmit();}
}
$('refresh-contract').addEventListener('click',()=>{ $('contract-consent').checked=false;void refresh(); });
$('contract-consent').addEventListener('change',updateSubmit);$('legal-name').addEventListener('input',updateSubmit);
$('contract-sign-form').addEventListener('submit',async event=>{
  event.preventDefault();if(!documentLoaded||current?.status!=='signature_required')return;
  $('sign-contract').disabled=true;$('signature-status').textContent='Recording your signature…';
  try{
    const contract=current.contract;
    const response=await fetch('/api/contract/sign',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'FundraiserAcademy'},body:JSON.stringify({contractId:contract.id,contractVersion:contract.version,contractHash:contract.hash,legalName:$('legal-name').value.trim(),consent:$('contract-consent').checked})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Your signature could not be recorded.');
    $('signature-status').textContent='Signature recorded.';await refresh();$('signature-receipt').scrollIntoView({behavior:'smooth',block:'start'});
  }catch(error){$('signature-status').textContent=error.message;updateSubmit();}
});
$('download-receipt').addEventListener('click',()=>{
  if(!current?.signature)return;
  const receipt={academy:'Fundraiser Academy',contract:current.contract,signature:current.signature,consentStatement:current.consentStatement,fundingApproved:false};
  const url=URL.createObjectURL(new Blob([JSON.stringify(receipt,null,2)],{type:'application/json'}));const link=document.createElement('a');link.href=url;link.download=`Fundraiser-Academy-signature-${current.signature.id}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
});
await refresh();
