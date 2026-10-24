const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' ? value : '';
const money = value => integer(value) ? new Intl.NumberFormat('en-US', {style:'currency',currency:'USD'}).format(value / 100) : 'Not recorded';
const share = value => integer(value) && value <= 10000 ? `${value / 100}%` : 'Not recorded';
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const tiers = [5000,6000,7000];
export function financialDate(value) {
  if (!integer(value) || value < 1 || value > 8640000000000000) return 'Not recorded';
  return new Intl.DateTimeFormat(undefined, {dateStyle:'medium',timeStyle:'short',timeZone:'Africa/Lagos'}).format(value) + ' WAT';
}

// The server supplies an own-trader statement. Keep the downloaded copy limited
// to its financial fields, even if future API responses include staff metadata.
export function payoutStatement(value) {
  if (!object(value) || !uuid.test(text(value.id))) throw new Error('The payout statement could not be verified. Refresh your records before downloading.');
  const result = {academy:'Fundraiser Academy',recordType:'cleared-prop-payout-statement',currency:'USD',id:value.id};
  for (const name of ['accountId','relationshipId']) if (uuid.test(text(value[name]))) result[name] = value[name];
  for (const name of ['amountReceivedCents','thirdPartyChargesCents','qualifyingNetPayoutCents','appliedTraderShareBps','traderShareCents','companyShareCents','cumulativeBeforeCents','cumulativeAfterCents','nextTraderShareBps','clearedAt','initiationDueAt','initiatedCents','outstandingCents']) {
    if (!integer(value[name])) throw new Error('The payout statement is incomplete. Refresh your records before downloading.');
    result[name] = value[name];
  }
  const expectedShare=(BigInt(result.qualifyingNetPayoutCents)*BigInt(result.appliedTraderShareBps)+5000n)/10000n;
  const nextTier=Math.max(result.appliedTraderShareBps,result.cumulativeAfterCents>=2500000?7000:result.cumulativeAfterCents>=1000000?6000:5000);
  if (!tiers.includes(result.appliedTraderShareBps) || result.nextTraderShareBps!==nextTier || result.thirdPartyChargesCents>result.amountReceivedCents || BigInt(result.qualifyingNetPayoutCents)!==BigInt(result.amountReceivedCents)-BigInt(result.thirdPartyChargesCents) || BigInt(result.traderShareCents)+BigInt(result.companyShareCents)!==BigInt(result.qualifyingNetPayoutCents) || BigInt(result.cumulativeAfterCents)-BigInt(result.cumulativeBeforeCents)!==BigInt(result.qualifyingNetPayoutCents) || BigInt(result.traderShareCents)!==expectedShare || BigInt(result.initiatedCents)+BigInt(result.outstandingCents)!==BigInt(result.traderShareCents) || result.clearedAt<1 || result.initiationDueAt<=result.clearedAt || result.initiationDueAt>8640000000000000) throw new Error('The payout statement totals could not be verified. Refresh your records before downloading.');
  result.overdue = value.overdue === true;
  result.businessCalendar = {businessDays:'Monday–Friday',timeZone:'Africa/Lagos',paymentAction:'initiation'};
  result.notice = 'This statement records cleared funds received by the academy and your entitlement. Payment initiation and payment completion are separate. Payments are executed outside this website.';
  return result;
}

export function payoutProcessingText(value) {
  if (!object(value)) return '';
  if (value.status === 'paid' || value.processingState === 'paid') return 'Payment recorded as completed outside this website.';
  if (value.status === 'rejected' || value.processingState === 'rejected') return 'This request was rejected; your underlying earned entitlement is not erased.';
  if (integer(value.initiatedAt) && value.initiatedAt > 0 || value.processingState === 'initiated') return `Payment initiation recorded${integer(value.initiatedAt) && value.initiatedAt > 0 ? ` · ${financialDate(value.initiatedAt)}` : ''}.${value.initiationWasLate===true?' Initiation was after the recorded deadline.':''} Completion has not yet been recorded.`;
  if (integer(value.initiationDueAt) && value.initiationDueAt > 0) return `${value.overdue === true ? 'Payment initiation is overdue. ' : ''}Initiation due by ${financialDate(value.initiationDueAt)}.`;
  return '';
}

export function createProfitSharingView({document,onDownload = () => {}}) {
  const node = (tag,className,value) => {const item=document.createElement(tag);if(className)item.className=className;if(value !== undefined)item.textContent=value;return item;};
  const metric = (label,value) => {const item=node('div','min-w-0');item.append(node('dt','metric-label mb-1',label),node('dd','break-words text-sm',value));return item;};
  function progressionCard(progression) {
    const area=node('article','rounded-xl border border-line bg-[#101010] p-5');
    area.append(node('h4','text-lg font-semibold',progression.status === 'terminated' ? 'Retained tier · ended relationship' : 'Your retained profit-sharing tier'));
    const metrics=node('dl','mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3');
    metrics.append(metric('Your share on the next eligible payout',share(progression.currentTraderShareBps)),metric('Academy share',share(progression.currentCompanyShareBps)),metric('Cumulative qualifying net payouts',money(progression.cumulativeQualifyingNetPayoutsCents)));
    area.append(metrics);
    if (progression.status === 'terminated') area.append(node('p','mt-4 text-sm text-muted','Accrued unpaid entitlements remain payable. A tier for any reinstatement must be expressly agreed in writing before new sponsorship.'));
    else if (integer(progression.nextThresholdCents) && integer(progression.cumulativeQualifyingNetPayoutsCents) && progression.nextThresholdCents > progression.cumulativeQualifyingNetPayoutsCents) {
      const remaining=progression.nextThresholdCents-progression.cumulativeQualifyingNetPayoutsCents;
      area.append(node('p','mt-4 text-sm',`${money(remaining)} in further qualifying net payouts to reach the ${share(progression.nextTraderShareBps)} tier at ${money(progression.nextThresholdCents)} total.`));
      const progress=node('progress','mt-3 h-2 w-full accent-lime');progress.max=progression.nextThresholdCents;progress.value=progression.cumulativeQualifyingNetPayoutsCents;progress.setAttribute('aria-label',`Progress to ${money(progression.nextThresholdCents)} in cumulative qualifying net payouts`);area.append(progress);
    } else if (progression.currentTraderShareBps >= 7000) area.append(node('p','mt-4 text-sm text-lime','Maximum standard tier applies. Any different entitlement requires a written agreement by both parties.'));
    area.append(node('p','mt-4 text-xs leading-relaxed text-muted','All eligible sponsored accounts in this contractual relationship contribute to the same total. Account closures, evaluation failures, and permitted trading losses do not reset your earned tier. The payout that reaches a threshold uses its existing tier; the increased share starts with the next eligible payout.'));
    return area;
  }
  function receiptCard(receipt,accounts) {
    const area=node('article','rounded-xl border border-line p-5');
    const account=accounts.find(account=>account.id === receipt.accountId);
    area.append(node('h4','break-words text-lg font-semibold',`Payout statement · ${financialDate(receipt.clearedAt)}`),node('p','mt-1 break-words text-xs text-muted',text(account?.label)||'Sponsored account'));
    const metrics=node('dl','mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3');
    for (const [label,value] of [['Cleared amount received',money(receipt.amountReceivedCents)],['Agreed third-party charges',money(receipt.thirdPartyChargesCents)],['Qualifying net payout',money(receipt.qualifyingNetPayoutCents)],['Applied fundraiser share',share(receipt.appliedTraderShareBps)],['Your entitlement',money(receipt.traderShareCents)],['Academy entitlement',money(receipt.companyShareCents)],['Updated cumulative qualifying payouts',money(receipt.cumulativeAfterCents)],['Share on next eligible payout',share(receipt.nextTraderShareBps)],['Payment initiation due',financialDate(receipt.initiationDueAt)],['Payment initiation recorded',money(receipt.initiatedCents)],['Awaiting initiation',money(receipt.outstandingCents)]]) metrics.append(metric(label,value));
    area.append(metrics);
    if (receipt.overdue === true && receipt.outstandingCents > 0) area.append(node('p','mt-4 text-sm text-amber-300','Payment initiation is overdue for the outstanding entitlement. Contact academy support for an update.'));
    const download=node('button','desk-action mt-4','Download payout statement');download.type='button';
    download.addEventListener('click',()=>onDownload(receipt));area.append(download);
    return area;
  }
  function render(target,funding) {
    const progressions=Array.isArray(funding?.progressions)?funding.progressions.filter(object).slice(0,100):[];
    const receipts=Array.isArray(funding?.receipts)?funding.receipts.filter(object).slice(0,100):[];
    const accounts=Array.isArray(funding?.accounts)?funding.accounts.filter(object):[];
    target.replaceChildren();
    const heading=node('div','flex flex-wrap items-start justify-between gap-3');heading.append(node('h3','text-xl tracking-tight','Profit-sharing progress'));
    const guide=node('a','desk-action','How profit sharing works');guide.href='/profit-sharing.html';heading.append(guide);target.append(heading);
    target.append(node('p','mt-3 max-w-3xl text-sm text-muted','The revised agreement starts newly admitted fundraisers at 50%, advances to 60% at $10,000 and 70% at $25,000 in cumulative qualifying net payouts, and retains earned tiers across eligible sponsored accounts during a continuous contractual relationship.'));
    const tiers=node('div','mt-5 space-y-4');
    if (progressions.length) tiers.append(...progressions.map(progressionCard));
    else tiers.append(node('p','rounded-lg border border-line p-4 text-sm text-muted','No progressive profit-sharing relationship has been recorded for you yet. Existing account terms remain shown with your account records.'));
    target.append(tiers);
    const statements=node('div','mt-7');statements.append(node('h3','mb-3 text-lg','Cleared payout statements'));
    const total=integer(funding?.receiptsTotal)?funding.receiptsTotal:receipts.length;
    statements.append(node('p','mb-4 text-xs text-muted',`${total} statements recorded. Showing ${receipts.length}${receipts.length < total ? ' most recent; contact support for older statements' : ''}. Only actually received and cleared prop-firm payouts count toward progression.`));
    const list=node('div','space-y-4');if (receipts.length) list.append(...receipts.map(receipt=>receiptCard(receipt,accounts)));else list.append(node('p','rounded-lg border border-line p-4 text-sm text-muted','No cleared payout statements have been recorded yet. Demo profits and live account equity do not count as cleared payouts.'));
    statements.append(list,node('p','mt-4 text-xs leading-relaxed text-muted','Payment must be initiated within three business days after the academy receives cleared funds. Business days use Monday–Friday in Africa/Lagos. Initiation is separate from completed payment, which is handled outside this website.'));target.append(statements);
  }
  return {render};
}
