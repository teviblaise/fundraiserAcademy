import {createHash,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {providedAgreement} from './agreement.mjs';

export const progressiveAgreementVersion='progressive-profit-sharing-v1';
export const progressivePolicy='progressive_cleared';
export const progressionTiers=Object.freeze([{thresholdCents:0,traderShareBps:5000},{thresholdCents:1000000,traderShareBps:6000},{thresholdCents:2500000,traderShareBps:7000}]);
const max=Number.MAX_SAFE_INTEGER;
const safe=(value,label)=>{if(value>BigInt(max)||value<0n)throw Object.assign(new Error(`${label} exceeds the supported accounting limit.`),{status:409});return Number(value);};
const tier=amount=>amount>=2500000?7000:amount>=1000000?6000:5000;
const share=(amount,bps)=>safe((BigInt(amount)*BigInt(bps)+5000n)/10000n,'Trader share');
const fail=(status,message,code)=>{throw Object.assign(new Error(message),{status,code});};
const money=(value,label,min=0)=>{if(!Number.isSafeInteger(value)||value<min||value>1000000000000)fail(400,`${label} must be whole USD cents in the supported range.`);return value;};
const words=(value,label,limit=2000)=>{if(typeof value!=='string'||/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value)||!value.trim()||value.trim().length>limit)fail(400,`Provide a valid ${label}.`);return value.normalize('NFKC').trim();};
const referenceKey=value=>words(value,'external reference',120).toLowerCase();
const allowed=(input,keys)=>{if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!keys.includes(key)))fail(400,'The finance request contains unsupported fields.');};
const positiveId=value=>{if(!Number.isSafeInteger(value)||value<1)fail(400,'Choose a valid trader.');return value;};
const has=(db,table)=>Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
const agreementContent=readFileSync(new URL('./agreements/progressive-profit-sharing-v1.txt',import.meta.url));
const hash=value=>createHash('sha256').update(value).digest('hex');
const relationshipId=value=>{if(typeof value!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(value))fail(400,'Choose a valid previous contractual relationship.');return value.toLowerCase();};

// Preparing a document grants no consent. It must be published through the
// authorized agreement flow, read and signed by the customer, and reviewed.
export function buildReinstatementAgreement({previousRelationshipId,writtenAgreementReference,startingTraderShareBps}={}){
 const previous=relationshipId(previousRelationshipId),reference=words(writtenAgreementReference,'written reinstatement agreement reference',500);
 if(![5000,6000,7000].includes(startingTraderShareBps))fail(400,'Choose an explicit starting tier of 50%, 60%, or 70%.');
 const trader=startingTraderShareBps/100,company=100-trader;
 const addendum=`\n\nFUNDRAISER ACADEMY\n\nREINSTATEMENT ADDENDUM\n\nPrevious contractual relationship: ${previous}\nWritten agreement reference: ${reference}\n\nThe Company and the Fundraiser expressly agree that the new contractual relationship shall begin at a profit-sharing tier of ${trader}% to the Fundraiser and ${company}% to the Company. This starting tier replaces any entitlement to automatically carry a different tier from the terminated relationship.\n\nCumulative Qualifying Net Payouts for the new relationship shall begin at USD 0.00. The stated starting tier shall be retained as the minimum tier during that relationship, with further advancement under the Progressive Profit Sharing and Tier Retention section above.\n\nPreviously accrued and unpaid entitlements remain payable. Earlier receipts, distributions, and signed records shall not be recalculated or erased.\n\nThe Company authorizes these written reinstatement terms through its authorized publication of this agreement. The Fundraiser accepts them only by personally reading and electronically signing this document before new sponsorship begins.\n`;
 const content=Buffer.concat([agreementContent,Buffer.from(addendum,'utf8')]),digest=hash(content);
 const version=`reinstatement-${previous}-${digest.slice(0,16)}`;
 return{content,contentBase64:content.toString('base64'),format:'text',version,title:`Fundraiser Academy Reinstatement — ${trader}% Profit Share`,fileName:`fundraiser-academy-${version}.txt`,hash:digest};
}

export function summarizeProgressiveProcessing(db,{now=Date.now}={}){
 const at=typeof now==='function'?now():now;
 if(!Number.isSafeInteger(at)||at<0)throw new TypeError('Provide a valid operational snapshot time.');
 const base={overdueReceipts:0,uninitiatedTraderShareCents:0,overdueTraderShareCents:0,closedRecipientReceipts:0,currency:'USD',businessDayCalendar:'Monday–Friday, Africa/Lagos'};
 if(!['progressive_receipts','progressive_payout_allocations','progressive_payout_initiations'].every(table=>has(db,table)))return base;
 const closed=has(db,'account_deletions')?"EXISTS(SELECT 1 FROM account_deletions d WHERE d.user_id=r.user_id AND d.status='deleted')":'0';
 const statement=db.prepare(`WITH outstanding AS (
  SELECT r.trader_share_cents-coalesce(i.amount,0) amount,r.initiation_due_at due,${closed} closed FROM progressive_receipts r
  LEFT JOIN (SELECT a.receipt_id,sum(a.amount_cents) amount FROM progressive_payout_allocations a JOIN progressive_payout_initiations p ON p.payout_id=a.payout_id GROUP BY a.receipt_id) i ON i.receipt_id=r.id
 ) SELECT coalesce(sum(amount),0) uninitiated,coalesce(sum(CASE WHEN amount>0 AND due<? THEN amount ELSE 0 END),0) overdue,
  coalesce(sum(CASE WHEN amount>0 AND due<? THEN 1 ELSE 0 END),0) receipts,
  coalesce(sum(CASE WHEN amount>0 AND closed THEN 1 ELSE 0 END),0) closed,
  coalesce(sum(CASE WHEN amount<0 THEN 1 ELSE 0 END),0) conflicts FROM outstanding`);
 statement.setReadBigInts(true);
 const row=statement.get(at,at);
 if(row.conflicts)fail(409,'Receipt initiation allocations exceed recorded entitlements.');
 return{...base,overdueReceipts:safe(row.receipts,'Overdue receipts'),uninitiatedTraderShareCents:safe(row.uninitiated,'Uninitiated entitlement'),overdueTraderShareCents:safe(row.overdue,'Overdue entitlement'),closedRecipientReceipts:safe(row.closed,'Closed recipient receipts')};
}

// Lagos has UTC+1 year-round. Business days here mean Monday–Friday; no holiday
// calendar has been supplied. The deadline preserves the local receipt time.
export function payoutInitiationDeadline(timestamp){
 if(!Number.isSafeInteger(timestamp)||timestamp<0||timestamp>8640000000000000-7*86400000)fail(400,'Provide a valid cleared-funds time.');
 const local=new Date(timestamp+3600000);let count=0;
 while(count<3){local.setUTCDate(local.getUTCDate()+1);if(local.getUTCDay()!==0&&local.getUTCDay()!==6)count++;}
 return local.getTime()-3600000;
}

export function createProgressiveFinance(db,{access,workflows,now=Date.now,transaction,accountRow,accountView,payoutRow,payoutView}={}){
 db.exec(`CREATE TABLE IF NOT EXISTS progressive_relationships(
  id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),status TEXT NOT NULL CHECK(status IN('active','terminated')),
  initial_tier_bps INTEGER NOT NULL CHECK(initial_tier_bps IN(5000,6000,7000)),current_tier_bps INTEGER NOT NULL CHECK(current_tier_bps IN(5000,6000,7000)),
  cumulative_qualifying_cents INTEGER NOT NULL DEFAULT 0 CHECK(cumulative_qualifying_cents>=0),started_at INTEGER NOT NULL,terminated_at INTEGER,
  revision INTEGER NOT NULL DEFAULT 1,contract_id TEXT NOT NULL,contract_version TEXT NOT NULL,contract_hash TEXT NOT NULL,signature_id TEXT NOT NULL,
  previous_relationship_id TEXT REFERENCES progressive_relationships(id),written_agreement_reference TEXT,created_by INTEGER NOT NULL REFERENCES users(id));
 CREATE UNIQUE INDEX IF NOT EXISTS progressive_one_active ON progressive_relationships(user_id) WHERE status='active';
 CREATE TABLE IF NOT EXISTS progressive_account_links(account_id TEXT PRIMARY KEY REFERENCES sponsored_accounts(id),relationship_id TEXT NOT NULL REFERENCES progressive_relationships(id));
 CREATE TABLE IF NOT EXISTS progressive_receipts(
  sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,account_id TEXT NOT NULL REFERENCES sponsored_accounts(id),user_id INTEGER NOT NULL REFERENCES users(id),relationship_id TEXT NOT NULL REFERENCES progressive_relationships(id),
  amount_received_cents INTEGER NOT NULL,third_party_charges_cents INTEGER NOT NULL,qualifying_net_payout_cents INTEGER NOT NULL,applied_trader_share_bps INTEGER NOT NULL,
  trader_share_cents INTEGER NOT NULL,company_share_cents INTEGER NOT NULL,cumulative_before_cents INTEGER NOT NULL,cumulative_after_cents INTEGER NOT NULL,next_trader_share_bps INTEGER NOT NULL,
  external_reference TEXT NOT NULL,reference_key TEXT NOT NULL,evidence TEXT NOT NULL,charges_agreement_reference TEXT,
  cleared_at INTEGER NOT NULL,initiation_due_at INTEGER NOT NULL,created_at INTEGER NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id),UNIQUE(user_id,reference_key));
 CREATE INDEX IF NOT EXISTS progressive_receipts_account ON progressive_receipts(account_id,sequence);
 CREATE INDEX IF NOT EXISTS progressive_receipts_relationship ON progressive_receipts(relationship_id,sequence);
 CREATE TABLE IF NOT EXISTS progressive_payout_allocations(payout_id TEXT NOT NULL REFERENCES sponsored_payouts(id),receipt_id TEXT NOT NULL REFERENCES progressive_receipts(id),amount_cents INTEGER NOT NULL CHECK(amount_cents>0),PRIMARY KEY(payout_id,receipt_id));
 CREATE INDEX IF NOT EXISTS progressive_allocations_receipt ON progressive_payout_allocations(receipt_id);
 CREATE TABLE IF NOT EXISTS progressive_payout_initiations(payout_id TEXT PRIMARY KEY REFERENCES sponsored_payouts(id),external_reference TEXT NOT NULL,reference_key TEXT NOT NULL UNIQUE,initiated_at INTEGER NOT NULL,created_at INTEGER NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id));
 CREATE TABLE IF NOT EXISTS progressive_relationship_events(id TEXT PRIMARY KEY,relationship_id TEXT NOT NULL REFERENCES progressive_relationships(id),action TEXT NOT NULL,previous_status TEXT,status TEXT NOT NULL,reason TEXT NOT NULL,written_agreement_reference TEXT,trader_consent_confirmed INTEGER NOT NULL DEFAULT 0,created_at INTEGER NOT NULL,created_by INTEGER NOT NULL REFERENCES users(id));
 CREATE TRIGGER IF NOT EXISTS progressive_relationship_protect BEFORE UPDATE ON progressive_relationships
 WHEN NEW.id IS NOT OLD.id OR NEW.user_id IS NOT OLD.user_id OR NEW.initial_tier_bps IS NOT OLD.initial_tier_bps OR NEW.started_at IS NOT OLD.started_at OR NEW.contract_id IS NOT OLD.contract_id OR NEW.contract_version IS NOT OLD.contract_version OR NEW.contract_hash IS NOT OLD.contract_hash OR NEW.signature_id IS NOT OLD.signature_id OR NEW.previous_relationship_id IS NOT OLD.previous_relationship_id OR NEW.written_agreement_reference IS NOT OLD.written_agreement_reference OR NEW.created_by IS NOT OLD.created_by OR NEW.cumulative_qualifying_cents<OLD.cumulative_qualifying_cents OR NEW.current_tier_bps<OLD.current_tier_bps OR OLD.status='terminated' AND NEW.status<>'terminated'
 BEGIN SELECT RAISE(ABORT,'Earned progression and contractual relationship records are immutable'); END;
 CREATE TRIGGER IF NOT EXISTS progressive_relationship_no_delete BEFORE DELETE ON progressive_relationships BEGIN SELECT RAISE(ABORT,'Financial relationship records are immutable'); END;`);
 for(const table of ['progressive_account_links','progressive_receipts','progressive_payout_allocations','progressive_payout_initiations','progressive_relationship_events'])for(const mutation of ['UPDATE','DELETE'])db.exec(`CREATE TRIGGER IF NOT EXISTS ${table}_no_${mutation.toLowerCase()} BEFORE ${mutation} ON ${table} BEGIN SELECT RAISE(ABORT,'Progressive financial records are immutable'); END;`);
 const active=userId=>db.prepare("SELECT * FROM progressive_relationships WHERE user_id=? AND status='active'").get(userId);
 const latest=userId=>db.prepare('SELECT * FROM progressive_relationships WHERE user_id=? ORDER BY started_at DESC,rowid DESC LIMIT 1').get(userId);
 const relationshipFor=accountId=>db.prepare('SELECT r.* FROM progressive_relationships r JOIN progressive_account_links l ON l.relationship_id=r.id WHERE l.account_id=?').get(accountId);
 function progressionView(row,{client=false}={}){
  if(!row)return null;
  const next=row.current_tier_bps>=7000?null:row.current_tier_bps>=6000?2500000:1000000;
  const result={id:row.id,userId:row.user_id,status:row.status,revision:row.revision,currentTraderShareBps:row.current_tier_bps,currentCompanyShareBps:10000-row.current_tier_bps,cumulativeQualifyingNetPayoutsCents:row.cumulative_qualifying_cents,nextThresholdCents:next,nextTraderShareBps:next===null?null:next===1000000?6000:7000,startedAt:row.started_at,terminatedAt:row.terminated_at,contractVersion:row.contract_version,previousRelationshipId:row.previous_relationship_id,currency:'USD',businessDayCalendar:'Monday–Friday, Africa/Lagos; no public-holiday calendar configured'};
  if(!client)Object.assign(result,{signatureId:row.signature_id,contractId:row.contract_id,contractHash:row.contract_hash,writtenAgreementReference:row.written_agreement_reference});
  return result;
 }
 function insertRelationship(actorId,userId,approved,{initialTier=5000,previous=null,writtenReference=null}={}){
  const id=randomUUID(),time=now();
  db.prepare("INSERT INTO progressive_relationships(id,user_id,status,initial_tier_bps,current_tier_bps,started_at,contract_id,contract_version,contract_hash,signature_id,previous_relationship_id,written_agreement_reference,created_by) VALUES(?,?,'active',?,?,?,?,?,?,?,?,?,?)").run(id,userId,initialTier,initialTier,time,approved.contractId,approved.contractVersion,approved.contractHash,approved.signatureId,previous?.id??null,writtenReference,actorId);
  return active(userId);
 }
 function prepareAccount(actorId,userId,approved,policy,bps){
  const current=active(userId),isRevised=approved.contractVersion===progressiveAgreementVersion;
  if(isRevised&&approved.contractHash!==providedAgreement.hash)fail(409,'The approved agreement does not match the company-provided progressive terms.');
  if(!current&&latest(userId))fail(409,'Record a privately signed written reinstatement and its agreed starting tier before any new sponsored account.','RELATIONSHIP_REINSTATEMENT_REQUIRED');
  if(!isRevised&&!current&&policy!==progressivePolicy)return null;
  if(policy!==progressivePolicy)fail(400,'The signed progressive agreement requires cleared-payout profit sharing.','PROGRESSIVE_POLICY_REQUIRED');
  if(!current&&!isRevised)fail(409,'Initial adoption requires the exact company-provided progressive agreement and its current signed approval.','PROGRESSIVE_AGREEMENT_REQUIRED');
  if(current&&(approved.contractId!==current.contract_id||approved.contractHash!==current.contract_hash||approved.signatureId!==current.signature_id||approved.contractVersion!==current.contract_version))fail(409,'The approved agreement differs from this active relationship. A separate mutually signed amendment is required before new sponsorship.','PROGRESSIVE_AGREEMENT_CHANGED');
  let relationship=current;
  if(!relationship){
   // Existing legacy financial terms are preserved; they are never silently
   // converted or counted as cleared qualifying receipts for a new scheme.
   const legacy=db.prepare('SELECT trader_share_bps FROM sponsored_accounts WHERE user_id=? AND id NOT IN(SELECT account_id FROM progressive_account_links)').all(userId);
   if(legacy.some(row=>![5000,6000,7000].includes(row.trader_share_bps)))fail(409,'Existing nonstandard written shares require an explicit mutually signed amendment before adopting this progressive schedule.','PROGRESSIVE_LEGACY_AMENDMENT_REQUIRED');
   const initialTier=Math.max(5000,...legacy.map(row=>row.trader_share_bps));
   relationship=insertRelationship(actorId,userId,approved,{initialTier});
  }
  if(bps!==undefined&&bps!==relationship.current_tier_bps)fail(400,'The trader share is determined by the retained progressive tier.','PROGRESSIVE_TIER_FIXED');
  return relationship;
 }
 function linkAccount(accountId,relationship){if(relationship)db.prepare('INSERT INTO progressive_account_links VALUES(?,?)').run(accountId,relationship.id);}
 function accountTerms(accountId,{client=false}={}){const row=relationshipFor(accountId);return row?{sharingModel:progressivePolicy,profitSharingPolicy:progressivePolicy,traderShareBps:row.current_tier_bps,progression:progressionView(row,{client})}:{sharingModel:'legacy_fixed'};}
 function earnings(accountId){let earned=0n,net=0n;for(const row of db.prepare('SELECT trader_share_cents,qualifying_net_payout_cents FROM progressive_receipts WHERE account_id=?').all(accountId)){earned+=BigInt(row.trader_share_cents);net+=BigInt(row.qualifying_net_payout_cents);}return{earned:safe(earned,'Earned share'),net:safe(net,'Qualifying payouts')};}
 function allocationRows(payoutId){return db.prepare('SELECT a.receipt_id receiptId,a.amount_cents amountCents,r.initiation_due_at initiationDueAt FROM progressive_payout_allocations a JOIN progressive_receipts r ON r.id=a.receipt_id WHERE a.payout_id=? ORDER BY r.sequence').all(payoutId);}
 function payoutTerms(row,{client=false}={}){
  const initiation=db.prepare('SELECT * FROM progressive_payout_initiations WHERE payout_id=?').get(row.id),allocations=allocationRows(row.id),due=allocations.length?Math.min(...allocations.map(item=>item.initiationDueAt)):null;
  const result={initiatedAt:initiation?.initiated_at??null,processingState:row.status==='paid'?'paid':row.status==='rejected'?'rejected':initiation?'initiated':'not_initiated',initiationDueAt:due,overdue:due!==null&&now()>due&&!initiation&&!['paid','rejected'].includes(row.status),receiptAllocations:allocations};
  result.initiationWasLate=Boolean(initiation&&due!==null&&initiation.initiated_at>due);
  if(!client)result.externalInitiationReference=initiation?.external_reference??null;
  return result;
 }
 function receiptView(row,{client=false}={}){
  const initiated=db.prepare("SELECT a.amount_cents FROM progressive_payout_allocations a JOIN progressive_payout_initiations i ON i.payout_id=a.payout_id WHERE a.receipt_id=?").all(row.id).reduce((total,item)=>total+BigInt(item.amount_cents),0n);
  const initiatedCents=safe(initiated,'Initiated payments');
  const result={id:row.id,accountId:row.account_id,userId:row.user_id,relationshipId:row.relationship_id,amountReceivedCents:row.amount_received_cents,thirdPartyChargesCents:row.third_party_charges_cents,qualifyingNetPayoutCents:row.qualifying_net_payout_cents,appliedTraderShareBps:row.applied_trader_share_bps,traderShareCents:row.trader_share_cents,companyShareCents:row.company_share_cents,cumulativeBeforeCents:row.cumulative_before_cents,cumulativeAfterCents:row.cumulative_after_cents,nextTraderShareBps:row.next_trader_share_bps,clearedAt:row.cleared_at,initiationDueAt:row.initiation_due_at,initiatedCents,outstandingCents:row.trader_share_cents-initiatedCents,overdue:now()>row.initiation_due_at&&initiatedCents<row.trader_share_cents,currency:'USD',createdAt:row.created_at};
  if(!client)Object.assign(result,{externalReference:row.external_reference,evidence:row.evidence,chargesAgreementReference:row.charges_agreement_reference,recipientAccountDeleted:has(db,'account_deletions')&&Boolean(db.prepare("SELECT 1 FROM account_deletions WHERE user_id=? AND status='deleted'").get(row.user_id))});
  return result;
 }
 function recordClearedReceipt(actorId,accountId,data){
  allowed(data,['amountReceivedCents','thirdPartyChargesCents','externalReference','clearedAt','evidence','chargesAgreementReference','reason']);
  const received=money(data.amountReceivedCents,'Received amount',1),charges=money(data.thirdPartyChargesCents??0,'Third-party charges');if(charges>received)fail(400,'Agreed charges cannot exceed the cleared funds received.');
  const reference=words(data.externalReference,'external payout receipt reference',120),key=referenceKey(reference),evidence=words(data.evidence,'cleared receipt evidence'),why=words(data.reason,'administrative reason',500);
  const agreement=data.chargesAgreementReference?words(data.chargesAgreementReference,'agreed charges reference',500):null;if(charges&&!agreement)fail(400,'Record the written agreement for third-party transaction charges.');
  const cleared=data.clearedAt;if(!Number.isSafeInteger(cleared)||cleared<0||cleared>now())fail(400,'Cleared funds time must be an actual past or current timestamp.');
  return transaction(actorId,()=>{
   const account=accountRow(accountId),relationship=relationshipFor(account.id);if(!relationship)fail(409,'Record legacy statements using this account’s existing fixed policy; it is not a progressive account.');
   if(cleared<relationship.started_at)fail(400,'Cleared funds must fall within or after this recorded contractual relationship.');
   const existing=db.prepare('SELECT * FROM progressive_receipts WHERE user_id=? AND reference_key=?').get(account.user_id,key);
   if(existing){if(existing.account_id!==account.id||existing.amount_received_cents!==received||existing.third_party_charges_cents!==charges||existing.cleared_at!==cleared||existing.evidence!==evidence||existing.charges_agreement_reference!==agreement)fail(409,'This external payout reference already records different details.','CLEARED_RECEIPT_CONFLICT');return{receipt:receiptView(existing),account:accountView(account),progression:progressionView(relationship),reused:true};}
   const latest=db.prepare('SELECT cleared_at FROM progressive_receipts WHERE relationship_id=? ORDER BY sequence DESC LIMIT 1').get(relationship.id);
   if(latest&&cleared<latest.cleared_at)fail(409,'Record cleared payouts in receipt-time order. Earlier omitted receipts require reconciliation before later tiers can be trusted.','CLEARED_RECEIPT_OUT_OF_ORDER');
   const qualifying=received-charges,before=relationship.cumulative_qualifying_cents,after=safe(BigInt(before)+BigInt(qualifying),'Cumulative qualifying payouts');
   const bps=relationship.current_tier_bps,trader=share(qualifying,bps),company=qualifying-trader,next=Math.max(bps,tier(after)),receiptId=randomUUID(),due=payoutInitiationDeadline(cleared);
   db.prepare('INSERT INTO progressive_receipts(id,account_id,user_id,relationship_id,amount_received_cents,third_party_charges_cents,qualifying_net_payout_cents,applied_trader_share_bps,trader_share_cents,company_share_cents,cumulative_before_cents,cumulative_after_cents,next_trader_share_bps,external_reference,reference_key,evidence,charges_agreement_reference,cleared_at,initiation_due_at,created_at,created_by) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(receiptId,account.id,account.user_id,relationship.id,received,charges,qualifying,bps,trader,company,before,after,next,reference,key,evidence,agreement,cleared,due,now(),actorId);
   db.prepare('UPDATE progressive_relationships SET cumulative_qualifying_cents=?,current_tier_bps=?,revision=revision+1 WHERE id=?').run(after,next,relationship.id);
   access.audit(actorId,'finance.cleared-receipt-recorded',{targetId:account.user_id,reason:why,detail:{accountId:account.id,statementId:receiptId,netProfitCents:qualifying,traderShareCents:trader,companyShareCents:company,traderShareBps:bps,currency:'USD',externalReference:reference}});
   return{receipt:receiptView(db.prepare('SELECT * FROM progressive_receipts WHERE id=?').get(receiptId)),account:accountView(accountRow(account.id)),progression:progressionView(relationshipFor(account.id)),reused:false};
  });
 }
 function allocatePayout(account,payoutId,amount){
  if(!relationshipFor(account.id))return;
  let remaining=amount;
  for(const receipt of db.prepare('SELECT id,trader_share_cents FROM progressive_receipts WHERE account_id=? ORDER BY sequence').all(account.id)){
   const allocated=db.prepare("SELECT a.amount_cents FROM progressive_payout_allocations a JOIN sponsored_payouts p ON p.id=a.payout_id WHERE a.receipt_id=? AND p.status<>'rejected'").all(receipt.id).reduce((total,item)=>total+BigInt(item.amount_cents),0n);
   const available=receipt.trader_share_cents-safe(allocated,'Payout allocations');if(available<0)fail(409,'The receipt has conflicting payout allocations.');
   const selected=Math.min(available,remaining);if(selected){db.prepare('INSERT INTO progressive_payout_allocations VALUES(?,?,?)').run(payoutId,receipt.id,selected);remaining-=selected;}if(!remaining)break;
  }
  if(remaining)fail(409,'The payout exceeds unreserved cleared-receipt entitlements.');
 }
 function initiatePayout(actorId,payoutId,data){
  allowed(data,['revision','externalInitiationReference','initiatedAt','reason']);
  const revision=money(data.revision,'Payout revision',1),reference=words(data.externalInitiationReference,'external initiation reference',120),why=words(data.reason,'administrative reason',500),key=referenceKey(reference);
  return transaction(actorId,()=>{
   const row=payoutRow(payoutId),existing=db.prepare('SELECT * FROM progressive_payout_initiations WHERE payout_id=?').get(row.id);
   if(existing){if(existing.reference_key!==key||data.initiatedAt!==undefined&&existing.initiated_at!==data.initiatedAt)fail(409,'This payout already has different immutable initiation evidence.');return{payout:payoutView(row),account:accountView(accountRow(row.account_id)),reused:true};}
   if(row.status!=='approved'||row.revision!==revision)fail(409,'Only the current approved payout may be marked initiated.');
   const at=data.initiatedAt??now();if(!Number.isSafeInteger(at)||at<row.created_at||at>now())fail(400,'Record an actual initiation time after the payout was requested.');
   db.prepare('INSERT INTO progressive_payout_initiations VALUES(?,?,?,?,?,?)').run(row.id,reference,key,at,now(),actorId);
   db.prepare('UPDATE sponsored_payouts SET revision=revision+1,updated_at=?,updated_by=? WHERE id=? AND revision=?').run(now(),actorId,row.id,revision);
   access.audit(actorId,'finance.payout-initiated',{targetId:row.user_id,reason:why,detail:{payoutId:row.id,accountId:row.account_id,amountCents:row.amount_cents,currency:'USD',externalPaymentReference:reference}});
   return{payout:payoutView(payoutRow(row.id)),account:accountView(accountRow(row.account_id)),reused:false};
  });
 }
 function assertPayoutChange(row,status,paidAt){
  const initiated=db.prepare('SELECT initiated_at FROM progressive_payout_initiations WHERE payout_id=?').get(row.id);
  if(initiated&&status==='rejected')fail(409,'An externally initiated payment cannot release its reservation as rejected. Reconcile its outcome first.');
  if(status==='paid'&&relationshipFor(row.account_id)&&!initiated)fail(409,'Record the actual payment initiation before completion.');
  if(status==='paid'&&initiated&&paidAt<initiated.initiated_at)fail(400,'Payment completion cannot precede initiation.');
 }
 function prepareReinstatement(actorId,userId,data){
  allowed(data,['revision','writtenAgreementReference','startingTraderShareBps','reason']);positiveId(userId);
  const revision=money(data.revision,'Relationship revision',1),why=data.reason===undefined?'Prepared written reinstatement terms for normal publication, personal signature, and sponsorship review.':words(data.reason,'administrative reason',500);
  return transaction(actorId,()=>{
   const previous=latest(userId);if(!previous||previous.status!=='terminated'||previous.revision!==revision)fail(409,'Select the current terminated relationship before preparing reinstatement terms.');
   const document=buildReinstatementAgreement({previousRelationshipId:previous.id,writtenAgreementReference:data.writtenAgreementReference,startingTraderShareBps:data.startingTraderShareBps});
   access.audit(actorId,'finance.reinstatement-prepared',{targetId:userId,reason:why,detail:{documentHash:document.hash,contractVersion:document.version,traderShareBps:data.startingTraderShareBps,status:'awaiting_publication_and_signature'}});
   const {content,...payload}=document;
   return{document:{...payload,recipientUserId:userId},recipientUserId:userId,previousRelationshipId:previous.id,terms:{startingTraderShareBps:data.startingTraderShareBps,writtenAgreementReference:words(data.writtenAgreementReference,'written reinstatement agreement reference',500),cumulativeQualifyingNetPayoutsCents:0},published:false,signed:false};
  });
 }
 function updateRelationship(actorId,userId,data){
  allowed(data,['action','revision','reason','writtenAgreementReference','traderConsentConfirmed','startingTraderShareBps']);positiveId(userId);
  if(!['terminate','reinstate'].includes(data.action))fail(400,'Choose termination or written reinstatement.');
  const why=words(data.reason,'administrative reason',500),revision=money(data.revision,'Relationship revision',1);
  return transaction(actorId,()=>{
   const previous=latest(userId);if(!previous||previous.revision!==revision)fail(409,'The contractual relationship changed. Refresh before continuing.');
   if(data.action==='terminate'){
    if(previous.status!=='active')fail(409,'This relationship is already terminated.');
    if(data.writtenAgreementReference!==undefined||data.traderConsentConfirmed!==undefined||data.startingTraderShareBps!==undefined)fail(400,'Reinstatement terms are not part of termination.');
    if(db.prepare("SELECT 1 FROM progressive_account_links l JOIN sponsored_accounts a ON a.id=l.account_id WHERE l.relationship_id=? AND a.status<>'closed' LIMIT 1").get(previous.id))fail(409,'Close sponsored accounts before ending the contractual relationship.');
    db.prepare("UPDATE progressive_relationships SET status='terminated',terminated_at=?,revision=revision+1 WHERE id=?").run(now(),previous.id);
    db.prepare('INSERT INTO progressive_relationship_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),previous.id,'terminate','active','terminated',why,null,0,now(),actorId);
    access.audit(actorId,'finance.relationship-terminated',{targetId:userId,reason:why,detail:{status:'terminated',revision:revision+1}});
    return{progression:progressionView(latest(userId))};
   }
   if(previous.status!=='terminated')fail(409,'Terminate the prior relationship before recording a new written reinstatement.');
   const agreement=words(data.writtenAgreementReference,'written reinstatement agreement reference',500);if(data.traderConsentConfirmed!==true||![5000,6000,7000].includes(data.startingTraderShareBps))fail(400,'Confirm both parties’ written consent and an explicit starting tier of 50%, 60%, or 70%.');
   const approved=workflows.requireApproved(userId);
   const signed=has(db,'contract_signatures')&&has(db,'contract_documents')?db.prepare('SELECT s.signed_at,s.contract_id,s.contract_hash,d.content,d.format,d.hash,d.version FROM contract_signatures s JOIN contract_documents d ON d.id=s.contract_id WHERE s.id=? AND s.user_id=?').get(approved.signatureId,userId):null;
   const expected=buildReinstatementAgreement({previousRelationshipId:previous.id,writtenAgreementReference:agreement,startingTraderShareBps:data.startingTraderShareBps});
   if(!signed||signed.signed_at<=previous.terminated_at||approved.userId!==userId||signed.contract_id!==approved.contractId||signed.contract_hash!==approved.contractHash||signed.hash!==expected.hash||signed.contract_hash!==expected.hash||hash(Buffer.from(signed.content))!==expected.hash||signed.format!=='text'||signed.version!==expected.version||approved.contractVersion!==expected.version)fail(409,'Publish the prepared reinstatement agreement, obtain the fundraiser’s personal signature after termination, and approve that exact agreement before reinstatement.','REINSTATEMENT_SIGNATURE_REQUIRED');
   const next=insertRelationship(actorId,userId,approved,{initialTier:data.startingTraderShareBps,previous,writtenReference:agreement});
   db.prepare('INSERT INTO progressive_relationship_events VALUES(?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),next.id,'reinstate','terminated','active',why,agreement,1,now(),actorId);
   access.audit(actorId,'finance.relationship-reinstated',{targetId:userId,reason:why,detail:{status:'active',traderShareBps:next.current_tier_bps,contractVersion:approved.contractVersion}});
   return{progression:progressionView(next)};
  });
 }
 function clientData(userId){return{progressions:db.prepare('SELECT * FROM progressive_relationships WHERE user_id=? ORDER BY started_at DESC,rowid DESC LIMIT 100').all(userId).map(row=>progressionView(row,{client:true})),receipts:db.prepare('SELECT * FROM progressive_receipts WHERE user_id=? ORDER BY sequence DESC LIMIT 100').all(userId).map(row=>receiptView(row,{client:true})),progressionsTotal:db.prepare('SELECT count(*) total FROM progressive_relationships WHERE user_id=?').get(userId).total,receiptsTotal:db.prepare('SELECT count(*) total FROM progressive_receipts WHERE user_id=?').get(userId).total};}
 function accountData(accountId){return{progression:progressionView(relationshipFor(accountId)),receipts:db.prepare('SELECT * FROM progressive_receipts WHERE account_id=? ORDER BY sequence DESC LIMIT 200').all(accountId).map(row=>receiptView(row)),receiptsTotal:db.prepare('SELECT count(*) total FROM progressive_receipts WHERE account_id=?').get(accountId).total};}
 function profitSharing(userId){positiveId(userId);if(!db.prepare('SELECT 1 FROM users WHERE id=?').get(userId))fail(404,'Fundraiser not found.');const relationships=db.prepare('SELECT * FROM progressive_relationships WHERE user_id=? ORDER BY started_at DESC,rowid DESC LIMIT 100').all(userId).map(row=>progressionView(row));return{progression:progressionView(active(userId)||latest(userId)),relationships,historyLimit:100,reinstatementRequired:'Prepare the exact written reinstatement agreement, publish it through Agreements, obtain the fundraiser’s personal signature and a new current sponsorship approval, then record reinstatement with the matching reference and starting tier.'};}
 function processingSummary(){return summarizeProgressiveProcessing(db,{now});}
 function portfolio(){let earned=0n,net=0n;for(const row of db.prepare('SELECT trader_share_cents,qualifying_net_payout_cents FROM progressive_receipts').all()){earned+=BigInt(row.trader_share_cents);net+=BigInt(row.qualifying_net_payout_cents);}return{earned:safe(earned,'Progressive earned share'),net:safe(net,'Qualifying cleared payouts')};}
 return{prepareAccount,linkAccount,accountTerms,earnings,recordClearedReceipt,allocatePayout,payoutTerms,assertPayoutChange,initiatePayout,prepareReinstatement,updateRelationship,clientData,accountData,portfolio,profitSharing,processingSummary};
}
