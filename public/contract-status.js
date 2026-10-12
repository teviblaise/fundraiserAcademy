export async function loadContractStatus() {
  const response=await fetch('/api/contract');
  if(response.status===401){location.replace('/login.html');throw new Error('Please log in.');}
  const result=await response.json();
  if(!response.ok)throw new Error(result.error||'Could not load your agreement status.');
  return result;
}
export async function showContractNextStep(container) {
  try {
    const result=await loadContractStatus();
    if(result.status==='assessment_required'){container.hidden=true;return result;}
    const heading=container.querySelector('[data-contract-heading]');
    const detail=container.querySelector('[data-contract-detail]');
    const link=container.querySelector('a');
    heading.textContent=result.status==='signed'?'Trader agreement signed':'Your next required step: trader agreement';
    detail.textContent=result.status==='awaiting_contract'?'You passed the assessment. Your agreement will appear here when the company provides it. Signing is required before sponsorship review.':result.status==='signature_required'?'Your agreement is ready. Read and sign it to complete the required step before sponsorship review.':'Your signature is recorded. Sponsorship remains subject to company review and eligibility checks.';
    link.textContent=result.status==='signed'?'View signed agreement':'View trader agreement';
    container.hidden=false;return result;
  } catch(error) {
    container.querySelector('[data-contract-heading]').textContent='Check your trader agreement';
    container.querySelector('[data-contract-detail]').textContent=error.message;
    container.hidden=false;
  }
}
