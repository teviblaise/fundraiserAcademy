# Fundraiser Academy launch pack

## Brand

**Positioning:** Company-sponsored prop accounts for skilled traders who lack capital.

**Tagline:** Your skill. Our backing.

**One-line pitch:** Demonstrate your trading ability, qualify for a sponsored third-party prop account with no participation fee, and share profits while Fundraiser Academy bears covered trading losses.

**Identity:** Forest green (#183c31), soft lime (#d5edb2), cream (#fafbf6).
The FA monogram represents the academy and its backing. Use `public/logo.svg`
for the full wordmark and `public/logo-mark.svg` for avatars and the favicon.
Keep generous clear space. Avoid stretching or placing the mark on busy backgrounds.

**Voice:** Clear, confident, realistic. Lead with existing trading skill and access
to backing. Avoid guaranteed returns, guaranteed selection, or claims that a
third-party firm endorses the academy without its permission.

## Suggested public copy

**Social bio:** Skilled trader, limited capital? Qualify for a sponsored prop account.
No participation fee. Shared profits. Company-covered trading losses under agreed
terms. Program launch details coming soon.

**Launch announcement draft:** Your skill deserves a pathway to backing.
Fundraiser Academy is building a free qualification program for traders who can
already trade but need capital to scale. Selected traders will receive accounts
from third-party prop firms, sponsored by us. Profits will be shared under a
written agreement, and we will bear covered trading losses. Qualification criteria,
profit-sharing terms, and application dates will be announced before enrollment.

## Proposed operating workflow

1. Publish final eligibility, qualification rules, supported markets, and terms.
2. Collect applications securely, with a privacy notice and explicit consent.
3. Review applicants' trading history and risk process with consistent scoring.
4. Run a documented qualification phase; use simulated trading until the approved
   program explicitly provides an account. Do not require personal trading deposits.
5. Select candidates using the published rubric; record reasons and communicate results.
6. Confirm the chosen firm's written rules permit sponsorship and the proposed
   account ownership/access arrangement. Do not share logins or circumvent KYC.
7. Execute the trader agreement and complete identity checks through approved channels.
8. Purchase/provision the approved account, then monitor drawdown and rule compliance.
9. Reconcile actual third-party payouts, calculate the agreed split, pay each share,
   and maintain a payout ledger. Never promise payment from unrealized trading profits.

These are proposed processes, not claims of an already operating program.

## Qualification rubric to finalize

Assess verified trading history, repeatable strategy, drawdown control, position
sizing, consistency, and rule compliance. Define the observation period, minimum
sample size, permissible instruments, risk per trade, daily and overall loss limits,
prohibited practices, and review/appeal process before accepting applicants.
No numerical thresholds have been selected in this draft.

## Trader agreement brief

Have the final agreement specify:

- Legal company identity and trader eligibility/jurisdiction.
- Selected prop firm, account type, ownership, permitted access, and applicable rules.
- No participation fee and which costs Fundraiser Academy pays.
- Exact profit split, whether it applies before or after firm deductions,
  payout schedule, currency, withdrawal conditions, and applicable taxes.
- Covered trading losses borne by the company, account closure triggers,
  treatment of rule violations, and any replacement-account policy.
- Data handling, reporting obligations, dispute process, and termination.

Do not present this brief as a signed or legally reviewed contract.

## Launch decisions still needed

- Qualification duration and objective pass/fail thresholds.
- Profit split and payout mechanics.
- Partner firm(s), permitted sponsorship arrangements, account sizes, and markets.
- Eligibility regions/age, available sponsorship budget, and cohort capacity.
- Company contact details, legal identity, privacy policy, and final trader agreement.
- Application backend, secure data storage, notification service, and domain/hosting.

## Application and administration requirements

Initial application: name, email, country of residence, age eligibility confirmation,
market, experience duration, strategy summary, and optional trading-history evidence.
Keep identity documents out of the initial form; use an approved verification service
at the appropriate stage. Restrict trading statements to authorized reviewers.

Admin records: application status, qualification observations, reviewer decision,
agreement status, sponsor account reference, risk incidents, actual payout received,
trader share, company share, and payment status. Log changes and restrict access.

The website has backend registration/login followed by a server-controlled simulator.
Profiles, hashed passwords, sessions, trading state, and audit events use SQLite.
Each user has a separate account. The challenge has a 10% realized-profit target,
10% static total drawdown from starting balance, and 5% daily drawdown from
UTC day-start equity. Passing requires no open positions and fills on at least 3 distinct UTC trading days. These practice outcomes
do not approve funding. Notification email opt-in verification is implemented; password recovery, reviewer workflows,
account deletion/retention, production operations, and payout integration remain
unfinished. Prices are synthetic and do not establish real-market ability.

Passed practice attempts earn completion certificates, with a registered-name or nickname display preference. This does not authorize funding. Email and background push are implemented but need verified sender credentials, network access, and HTTPS hosting for live validation.
