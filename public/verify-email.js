const token=new URLSearchParams(location.hash.slice(1)).get('token');
// Keep the token only in this page's memory; never in browser history or later navigation.
history.replaceState(null,'',location.pathname+location.search);
const form=document.getElementById('verify-email-form');
const status=document.getElementById('verification-status');
if(!token||!/^[a-f0-9]{64}$/.test(token)){status.textContent='This confirmation link is incomplete or invalid. Sign in to your client dashboard to request a new email.';form.hidden=true;}
form.addEventListener('submit',async event=>{
  event.preventDefault();form.querySelector('button').disabled=true;
  try {
    const response=await fetch('/api/email/verify',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'FundraiserAcademy'},body:JSON.stringify({token})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error);
    status.textContent=result.message||'Your email address is confirmed. You can continue to your client dashboard.';form.hidden=true;
  }catch(error){status.textContent=error.message;form.querySelector('button').disabled=false;}
});
