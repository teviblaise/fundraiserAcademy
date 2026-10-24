import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';

export const PROVIDED_AGREEMENT_VERSION='progressive-profit-sharing-v1';
const content=readFileSync(new URL('./agreements/progressive-profit-sharing-v1.txt',import.meta.url));

// These are the company-provided section's exact bytes. The contract service
// stores and hashes an immutable authenticated copy; this file is not public/.
export const providedAgreement=Object.freeze({
  version:PROVIDED_AGREEMENT_VERSION,
  title:'Progressive Profit Sharing and Tier Retention',
  format:'text',
  fileName:'progressive-profit-sharing-v1.txt',
  hash:createHash('sha256').update(content).digest('hex')
});

export function installProvidedAgreement(contracts,{now=Date.now()}={}){
  if(typeof contracts?.publish!=='function')throw new TypeError('Provide the academy contract publication service.');
  if(!Number.isSafeInteger(now)||now<0)throw new TypeError('Provide a valid agreement publication timestamp.');
  // publish() reuses the immutable version without reactivating a later version.
  // The user must independently read and sign; publication creates no consent.
  return contracts.publish({...providedAgreement,content:Buffer.from(content),now});
}
