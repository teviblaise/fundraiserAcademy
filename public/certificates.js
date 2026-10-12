import {showContractNextStep} from './contract-status.js';
const list=document.getElementById('certificate-list');
const status=document.getElementById('certificate-status');
let namePreferences;
function namePreview(){const nickname=document.getElementById('certificate-nickname');const mode=document.getElementById('certificate-mode').value;nickname.disabled=mode!=='nickname';nickname.required=mode==='nickname';document.getElementById('name-preview').textContent=`Certificate preview name: ${mode==='nickname'?nickname.value.trim()||'Your nickname':namePreferences?.name||''}`;}
document.getElementById('certificate-mode').addEventListener('change',namePreview);
document.getElementById('certificate-nickname').addEventListener('input',namePreview);
document.getElementById('certificate-name-form').addEventListener('submit',async event=>{
  event.preventDefault();const button=event.target.querySelector('button[type="submit"]');button.disabled=true;
  try{const response=await fetch('/api/certificate-preferences',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'FundraiserAcademy'},body:JSON.stringify({mode:document.getElementById('certificate-mode').value,nickname:document.getElementById('certificate-nickname').value,applyExisting:document.getElementById('apply-existing').checked})});const result=await response.json();if(!response.ok)throw new Error(result.error);namePreferences=result;document.getElementById('name-status').textContent=`Saved. Your certificates will show “${result.displayName}”.`;if(document.getElementById('apply-existing').checked)location.reload();}catch(error){document.getElementById('name-status').textContent=error.message;}finally{button.disabled=false;}
});
function preview(certificate){document.getElementById('certificate-preview').hidden=false;document.getElementById('certificate-image').src=`/api/certificates/${certificate.id}.svg`;document.getElementById('certificate-preview').scrollIntoView({behavior:'smooth',block:'start'});}
try {
  const response=await fetch('/api/certificates');
  if(response.status===401){location.replace('/login.html');await new Promise(()=>{});}
  if(!response.ok)throw new Error('Could not load your certificates. Please try again.');
  const result=await response.json();document.querySelector('main').hidden=false;
  await showContractNextStep(document.getElementById('contract-next-step'));
  const preferencesResponse=await fetch('/api/certificate-preferences');if(!preferencesResponse.ok)throw new Error('Could not load certificate name settings.');namePreferences=await preferencesResponse.json();document.getElementById('certificate-mode').value=namePreferences.mode;document.getElementById('certificate-nickname').value=namePreferences.nickname;namePreview();
  if(!result.certificates.length){status.textContent='No certificates yet. Pass the practice challenge over at least 3 trading days with all positions closed to earn your first certificate.';}
  for(const certificate of result.certificates){
    const card=document.createElement('article');card.className='desk-card';
    const label=document.createElement('p');label.className='eyebrow mb-3';label.textContent=certificate.priceMode==='reference'?'REFERENCE-PRICED CHALLENGE COMPLETED':'EARLIER DEMO CHALLENGE COMPLETED';
    const heading=document.createElement('h3');heading.className='mb-3';heading.textContent=certificate.holder;
    const detail=document.createElement('p');detail.className='mb-3 text-sm text-muted';detail.textContent=`Issued ${new Date(certificate.issuedAt).toLocaleDateString()} · ${certificate.tradingDays} trading days · Realized return ${certificate.profitPercent.toFixed(2)}%`;
    const id=document.createElement('p');id.className='mb-5 break-all text-[10px] text-muted';id.textContent=`Certificate ID: ${certificate.id}`;
    const actions=document.createElement('div');actions.className='flex flex-wrap gap-3';
    const view=document.createElement('button');view.className='desk-action';view.textContent='View certificate';view.addEventListener('click',()=>preview(certificate));
    const download=document.createElement('a');download.className='desk-action';download.textContent='Download SVG';download.href=`/api/certificates/${certificate.id}.svg`;download.download=`Fundraiser-Academy-${certificate.id}.svg`;
    actions.append(view,download);card.append(label,heading,detail,id,actions);list.append(card);
  }
  if(result.certificates.length)preview(result.certificates[0]);
}catch(error){document.querySelector('main').hidden=false;status.textContent=error.message;}
document.getElementById('print-certificate').addEventListener('click',()=>window.print());
