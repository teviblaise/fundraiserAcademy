import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccount, applyReferenceQuotes, openTrade } from '../public/simulator.js';
import { assessmentSummary, guidedNextStep } from '../public/client-summary.js';

const now = Date.UTC(2026, 9, 13, 10);

test('a reached profit target does not claim an assessment pass before the server confirms it', () => {
  const account = createAccount(now);
  account.balance = 11000;
  account.tradingDays = ['2026-10-13'];
  const summary = assessmentSummary(account, now);
  assert.equal(summary.passed, false);
  assert.equal(summary.status, 'Profit target reached');
  assert.equal(summary.targetProgress, 100);
  assert.equal(summary.days, 1);
  assert.equal(guidedNextStep(account, { status: 'assessment_required' }).href, '/dashboard.html');
});

test('missing position valuations stay unavailable rather than becoming zero loss or zero equity', () => {
  const account = createAccount(now);
  account.positions.push({ id: 1, symbol: 'BTCUSD', side: 'buy', quantity: .01, entry: 50000, marginUsd: 250 });
  const summary = assessmentSummary(account, now);
  assert.equal(summary.equity, null);
  assert.equal(summary.dailyLoss, null);
  assert.equal(summary.totalLoss, null);
  assert.equal(summary.valuationLabel, 'Waiting for reference valuations');
  assert.equal(summary.balance, 10000);
});

test('stale open-position quotes retain the labeled last valuation without claiming current risk totals', () => {
  const account = createAccount(now);
  applyReferenceQuotes(account, [{ symbol: 'BTCUSD', price: 50000, source: 'Fixture', asOf: now / 1000, fetchedAt: now, executable: true }], now);
  openTrade(account, { symbol: 'BTCUSD', side: 'buy', lots: .01 }, now);
  const summary = assessmentSummary(account, now + 31000);
  assert.equal(summary.equity, 10000);
  assert.equal(summary.dailyLoss, null);
  assert.equal(summary.totalLoss, null);
  assert.equal(summary.valuationLabel, 'Last reference valuation · prices need refreshing');
});

test('previous-price attempts are read only and distinct trading days are counted once', () => {
  const account = createAccount(now);
  account.executionMode = 'legacy';
  account.tradingDays = ['2026-10-12', '2026-10-12', '2026-10-13'];
  const summary = assessmentSummary(account, now);
  assert.equal(summary.status, 'Previous attempt · reset required');
  assert.equal(summary.days, 2);
  assert.equal(summary.equity, null);
  assert.equal(summary.passed, false);
});

test('required agreements remain reachable after an assessment reset and never claim funding approval', () => {
  const account = createAccount(now);
  const required = guidedNextStep(account, { status: 'signature_required' });
  assert.equal(required.href, '/contract.html');
  assert.equal(required.label, 'Sign your trader agreement');
  const signed = guidedNextStep(account, { status: 'signed', fundingApproved: false });
  assert.equal(signed.href, '/contract.html');
  assert.match(signed.detail, /subject to eligibility, company review/);
  assert.equal(guidedNextStep(account, { status: 'awaiting_contract' }).href, '/certificates.html');
});
