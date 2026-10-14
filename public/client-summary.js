import { metrics } from './simulator.js';

export function assessmentSummary(account, now = Date.now()) {
  if (!account) return null;
  const value = metrics(account, now);
  const legacy = account.migrationRequired || account.executionMode !== 'reference';
  const passed = !legacy && account.locked === 'Profit target achieved';
  const realized = account.balance - account.initial;
  const target = account.initial * .1;
  const days = new Set(account.tradingDays || []).size;
  const currentValuation = !legacy && value.valuationComplete && value.executionReady;
  let status = 'Assessment in progress';
  let detail = 'Reach 10% realized profit, trade on at least 3 distinct UTC days, and close all positions to pass.';
  if (legacy) {
    status = 'Previous attempt · reset required';
    detail = 'Open the trading desk and reset this previous attempt to start a reference-priced assessment. Earlier results and certificates remain saved.';
  } else if (passed) {
    status = 'Assessment passed';
    detail = 'Your assessment is complete. View your certificate and check the required trader agreement before sponsorship review.';
  } else if (account.locked) {
    status = 'Trading currently locked';
    detail = account.locked + '. Open the trading desk to review the limit and available next steps.';
  } else if (realized >= target) {
    status = 'Profit target reached';
    detail = 'Complete at least 3 distinct UTC trading days and close every position. The server confirms the pass when all requirements are met.';
  }
  return {
    status, detail, legacy, passed, realized, target, days,
    targetProgress: Math.min(100, Math.max(0, realized / target * 100)),
    balance: account.balance,
    equity: legacy ? null : value.equity,
    floating: legacy ? null : value.floating,
    freeMargin: legacy ? null : value.freeMargin,
    dailyLoss: currentValuation ? value.dailyLoss : null,
    totalLoss: currentValuation ? value.totalLoss : null,
    dailyCap: account.dailyStart * .05,
    totalCap: account.initial * .1,
    valuationLabel: legacy ? 'Previous attempt · read only' : !value.valuationComplete ? 'Waiting for reference valuations' : !value.executionReady ? 'Last reference valuation · prices need refreshing' : 'Reference valuation at last refresh',
    positions: account.positions.length,
    closedTrades: account.history.length,
    pendingOrders: (account.pending || []).length,
    dailyDate: account.day,
  };
}

export function guidedNextStep(account, contract) {
  if (contract?.status === 'signature_required') return {
    label: 'Sign your trader agreement', href: '/contract.html',
    heading: 'Your agreement is ready',
    detail: 'You completed an assessment. Review and sign the company agreement to complete the required step before sponsorship review.',
  };
  if (contract?.status === 'signed') return {
    label: 'View signed agreement', href: '/contract.html',
    heading: 'Your signature is recorded',
    detail: 'Your agreement is signed. Sponsorship remains subject to eligibility, company review, partner rules, and available capacity.',
  };
  if (contract?.status === 'awaiting_contract') return {
    label: 'View your certificates', href: '/certificates.html',
    heading: 'Your assessment is complete',
    detail: 'Your certificate is available. The company must provide your trader agreement before you can sign and continue to sponsorship review.',
  };
  if (account && !account.migrationRequired && account.executionMode === 'reference' && account.locked === 'Profit target achieved') return {
    label: 'View your certificates', href: '/certificates.html',
    heading: 'Your assessment is complete',
    detail: 'View your completion certificate and check the required trader agreement. Completion does not automatically approve sponsorship.',
  };
  return {
    label: 'Continue assessment', href: '/dashboard.html',
    heading: 'Your next trading chapter starts here',
    detail: 'Open your practice desk to demonstrate your strategy with a $10,000 demo account. Your trades and challenge progress are saved on the server.',
  };
}
