const token=new URLSearchParams(location.hash.slice(1)).get('token');
const form=document.getElementById('verify-email-form');
const status=document.getElementById('verification-status');
if(!token){status.textContent='This link is missing its verification token. Request a new email from your dashboard.';form.hidden=true;}
form.addEventListener('submit',async event=>{
  event.preventDefault();form.querySelector('button').disabled=true;
  try {
    const response=await fetch('/api/email/verify',{method:'POST',headers:{'Content-Type':'application/json','X-Requested-With':'FundraiserAcademy'},body:JSON.stringify({token})});
    const result=await response.json();
    if(!response.ok)throw new Error(result.error);
    history.replaceState(null,'',location.pathname);status.textContent=result.message;form.hidden=true;
  }catch(error){status.textContent=error.message;form.querySelector('button').disabled=false;}
});
