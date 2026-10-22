# Fundraiser Academy launch pack

## Brand

**Positioning:** Company-sponsored prop accounts for skilled traders who lack capital.

**Tagline:** Your skill. Our backing.

**One-line pitch:** Demonstrate your trading ability, qualify for a sponsored third-party prop account with no participation fee, and share profits while Fundraiser Academy bears covered trading losses.

**Identity:** Black (#0b0b0b), gold (#ffd700), white (#ffffff).
The supplied angular FA monogram and rising bars represent trading and growth.
Use `public/logo.svg` for the white/gold wordmark on dark backgrounds,
`public/logo-dark.svg` for the black wordmark on white documents,
`public/logo-mark.svg` for the standalone mark, and `public/favicon.svg`
for the browser icon. The current brand board and social avatar are in `public/assets/`.
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
The implemented simulator uses a 10% realized-profit target, 10% static total
drawdown from starting balance, 5% daily drawdown from UTC day-start equity,
and fills on at least 3 distinct UTC trading days. Passing requires no open
positions. These assessment rules do not set a sponsored firm's account rules.

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

- Final qualification rubric, prohibited practices, and review/appeal procedure.
- Profit split and payout mechanics.
- Partner firm(s), permitted sponsorship arrangements, account sizes, and markets.
- Eligibility regions/age, available sponsorship budget, and cohort capacity.
- Company contact details, legal identity, privacy policy, and final trader agreement.
- Production storage/backups, verified email sender, domain, and hosted service configuration.

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
do not approve funding. Email confirmation, notification opt-in verification,
password recovery, authenticator security, admin reviews, account closure and
personal-data export, client payout requests, MetaApi performance reads, advanced
reports, and encrypted local backups with isolated recovery checks are implemented.
Company privacy/retention rules, permitted provider configuration, durable/offsite
storage, and actual payment execution remain operator requirements. Paper trades fill at verified market-reference prices without
an added spread. Stale or unavailable quotes pause execution; this still does not
establish live account performance. Intraday forex requires Twelve Data
configuration; daily ECB closes are display-only. Earlier price-model attempts
are retained until an explicit reset.

Passed practice attempts earn completion certificates, with a registered-name or nickname display preference. This does not authorize funding. Challengers must next sign the company-provided trader agreement with their full legal name before sponsorship review can proceed. Until the document is supplied, the agreement remains pending. Each signature records the exact document version and hash; new versions require fresh signatures and preserve history. Email and background push are implemented but need verified sender credentials, network access, and HTTPS hosting for live validation.

### Account security

Clients can enable authenticator-app 2FA from Security and keep single-use
recovery codes privately. Password recovery preserves the second factor. Never
ask clients to send passwords, app setup keys, or recovery codes in support.
Loss of both factors needs manual account review; no automated bypass exists.
Clients can review and revoke their active sessions. Security changes require
password confirmation and an unused factor when 2FA is enabled.

Operators must retain the private authenticator encryption key with the SQLite
database. The local QR generator does not contact third-party QR services.

### Admin operating controls

The admin console at `/admin.html` provides trader search and details, assessment
and certificate inspection, agreement publication, sponsorship reviews, manual
sponsored-account statements and payouts, support, reports, staff permissions,
audit records, and system status. Initial owners are explicitly configured with
`ADMIN_OWNER_EMAILS`; other roles are assigned by an owner or trusted-server CLI.
Every admin-console user must have verified email, an enabled authenticator, and
an active account. New-owner email confirmation requires the configured verified
Resend sender. The environment setting does not create an account or bypass
verification. Server/Render configuration must be applied separately from Codex.

Owner, admin, reviewer, and support roles expose only their assigned permissions.
Staff changes, reviews, financial entries, and exports require a recent password
and fresh-factor confirmation tied to the current session for five minutes.
Changes require reasons and append audit records. Role changes and suspension
revoke sessions; suspension also blocks new sign-ins while retaining history and
background protection of open simulated exposure. The website does not provide a
support workflow to bypass email ownership or 2FA.

Reviewers can keep internal notes and choose pending review, needs information,
approved, or rejected, with a separate client-facing message. Approval requires
a valid current assessment certificate and signature on the current published
company agreement. Decisions are bound to those records and checked against
concurrent revisions. New document versions or changed qualifying records
require a fresh review; a passed challenge or signed agreement alone does not
approve funding. Publish the actual company agreement, never substitute test
terms or an assistant-written contract for it.

External sponsored-account records require a current approved review. Enter
verified firm/account evidence, account size, exact trader share, and the actual
agreement's profit-sharing policy. Cumulative-high-water sharing allocates only
new cumulative profit highs after losses are recovered. Settled-period sharing
allocates positive externally settled periods independently and requires an
explicit settlement confirmation with nonoverlapping period dates. Losses never
create a negative trader share. Account terms and posted statements are immutable;
do not use either policy until its treatment matches the signed agreement.

Payout requests and approvals reserve available recorded trader earnings;
rejection releases the reservation. An approved payout can be marked paid only
with an external payment reference. Staff still need to verify and carry out the
external transaction and reconcile evidence. No prop-firm purchase, bank transfer,
or independent evidence verification is supplied. Authorized MetaApi connections
can import existing account performance separately from the settlement ledger.
Clients see only their own review message and financial records. Internal notes
and evidence references remain restricted to authorized staff.

Before using real records, configure persistent storage and protected SQLite-aware
backups, retain authentication and push keys, review staff grants, and finalize
privacy, retention, and deletion procedures. Free Render preview storage is
temporary and unsuitable for lasting signatures or financial records. Immutable
application audit tables do not replace an operator-controlled backup process.


### Customer data and account closure

Use Account controls at /account-tools.html for personal-data export, account
closure, and client payout requests. Export/deletion/payout confirmations are
separate session-bound privileges lasting five minutes after password and, when
enabled, a fresh second factor. The full export follows all bounded pages and
checks a stable fingerprint; a changed or partial dataset must be retried rather
than presented as complete. Authentication secrets, other users, staff identities,
private provider credentials, and internal reviewer notes are excluded.

An owner-requested closure stays pending while staff/support access, an open
sponsored allocation, pending payout, or unpaid earned share remains. Keep the
client able to resolve those obligations and allow cancellation. Staff can finish
a prior requested closure after blockers are cleared, using the audited console.
The confirmation removes mutable operational personal data and the usable
profile, revokes authentication, disconnects provider access, and returns a receipt.
Immutable signed agreements, financial records, review/audit history, and older
backups may remain as disclosed. Define a real retention policy and review retained
records; do not advertise complete erasure or an invented statutory retention term.

### MetaApi monitoring and reconciliation

Confirm the selected prop firm's rules permit MetaApi access. Configure the actual
MetaApi token privately on the application server and keep broker credentials out
of forms, support, Git, and chat. Link an existing deployed MetaTrader 4/5 account
only to the academy allocation backed by a current approved review. Choose the
history start deliberately; the default is the preceding 30 days. The connector
reads account information and deal history, normally around once per minute while
the server runs. It does not provision/deploy an account, trade, purchase accounts,
or execute withdrawals/payments. Check missing-key, stale, and incomplete-history
statuses before relying on displayed data.

Reconcile native-currency deals, trading fees, and cash flows with the provider.
Deposits and withdrawals are not profit; unexplained adjustments and history gaps
must be reviewed. Provider equity does not automatically become available earnings
in the USD-cent ledger. Post actual settlement statements using the signed share
and sharing policy, then handle client payout requests against unreserved earned
amounts. Idempotent request keys prevent duplicate holds after uncertain retries.
Approve or reject requests, carry out approved payments through the chosen external
channel, record references, and reconcile the status history. A recorded paid label
is evidence entered by staff, not independent proof that the bank paid.

Private performance reports show observed equity, separately labeled realized
balance where reconciliation permits it, UTC monthly results, drawdown, and daily
profit concentration. Historical equity is not manufactured. MetaTrader closing
execution records can include partial closes, so fill win rate is not a round-trip
position win rate; standalone fees can affect profit without belonging to a
particular closing fill. Read coverage, currency, and staleness notes. Consistency
analysis describes past records and does not create extra assessment rules.

### Operational monitoring and recovery

Assign an operator to **Admin → Operations & recovery**. Refresh its health report
to review database/storage availability, backup freshness, notification queue
failures/overdue sends, email/forex configuration, and stale active MetaApi feeds.
Download the sanitized aggregate report when a review needs a portable record.
Recipients, account IDs, paths, and secrets are excluded. A configured sender is
not proof of inbox delivery, and free space is not proof of persistent or offsite
storage.

Run diagnostics with a reason and fresh staff authentication when investigating
an issue. It uses bounded read-only SQLite quick_check/foreign-key checks in an
isolated subprocess and a temporary private-storage write probe. It records safe
results without changing customer records, contacting providers, sending email,
repairing data, or replacing the live database. For a failed check, preserve the
installation and investigate the fixed failure code before planning recovery.
Use the deployment runbook for delivery failures, stale connections, low storage,
and failed/old backups. Do not ask customers to send credentials or copy private
records into an incident reason.

Review sanitized server-error fingerprints, counts, failed jobs, encrypted backup
history, and isolated recovery results from Operations & recovery. The local error
view does not contain raw request bodies, exception text, or credentials. Assign
staff responsibility for checking it; external alert delivery is not configured.

The running server schedules SQLite-consistent AES-256-GCM local backups. Defaults
are an initial run after about 30 seconds, a 24-hour interval, and seven retained
artifacts by count. Artifacts include required authenticator/push keys and are
verified in an isolated copy. Store them privately on persistent storage and keep a
separate secure copy of BACKUP_ENCRYPTION_KEY or the generated backup-key.json.
That decryption key is deliberately outside the encrypted artifact.

Recovery checks reapply the current completed-deletion ledger to prevent an older
backup from resurrecting erased profiles or reusing deleted user IDs. CLI restore
requires the healthy current database/latest ledger and creates a new private
folder only; it never replaces a live or existing target. It is fresh-copy recovery
and verification, not a complete lost-host or lost-database disaster-recovery path.
Restored old sessions, tokens, queued delivery jobs, and recovery codes are revoked;
accounts require a fresh password reset and retain enabled authenticator protection
with the original key. Plan working recovery-email delivery and authenticator access
before activating a recovered copy.

No offsite destination is configured. An ephemeral Render instance can lose its
database, local backup artifacts, and keys together. Establish persistent storage,
a protected offsite backup/latest-deletion-ledger process, a separately preserved
key, and an independently tested disaster-recovery procedure before relying on
lasting company records. Finalize retention/deletion rules and access reviews.
See DEPLOYMENT.md for the exact supported commands and current limitations.
