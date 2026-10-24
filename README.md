# fundraiserAcademy
We are building a suitable platform for anyone wanting to scale their earning through forex/crypto trading but doesn't have the capital.

## Website development

The website uses the supplied black, gold, and white FA identity. Wordmarks,
monograms, favicon, social avatar, and brand board are in `public/`; the About
page includes asset downloads. Completion certificates use the black logo on
white with gold accents.

For a temporary Render preview, connect this repository and use its Blueprint
on the `preview/fundraiser-academy` branch. See DEPLOYMENT.md for the exact steps
and the difference between free preview storage and persistent live records.

Requires Node.js 24 or newer (uses built-in SQLite). Styling uses Tailwind CSS v4 and its local CLI.

```sh
npm ci
npm start
```

## Preview on your laptop

Install the current Node.js 24 LTS release, extract the release ZIP, and open a
terminal in the extracted `fundraiserAcademy` folder. Run `npm ci`, then `npm start`.
Open `http://localhost:3000` in your browser. Keep the terminal running; Ctrl+C
stops the server. These commands also work in Windows PowerShell. VS Code Live
Server does not run the backend; use `npm start`.

Public pages and pending registration profiles work without email credentials. New users, records, and
VAPID keys are created privately in the extracted folder's `data/` directory.
The release does not include cloud-instance user data or credentials. Email delivery
needs provider settings; background push needs permissions and network access.

The development server listens on port 3000. Set `PORT` to use another port.
`npm start` compiles CSS before launching. Run `npm run dev` in a second terminal
to watch for styling changes. Run `npm run check` to check JavaScript syntax and
compile Tailwind CSS. `npm run build` creates minified `public/styles.css` from
`src/styles.css` and the HTML templates. Edit the source CSS rather than the
generated stylesheet. Pages use Tailwind utilities and shared component styles
defined with `@apply`; brand colors and fonts are defined with `@theme`.

The responsive website lives in `public/`. It explains free qualification for
experienced traders, company-sponsored third-party prop accounts, shared profits,
and company-covered trading losses under agreed terms. It includes FAQs and an
demo registration and a simulated trading dashboard.

Pages: home (`index.html`), funding model (`program.html`), qualification
(`qualification.html`), academy mission (`about.html`), questions (`faq.html`),
demo registration (`contact.html`), privacy notice (`privacy.html`), trading
simulator (`dashboard.html`), client overview (`client.html`), account controls and
payout requests (`account-tools.html`), and performance reports (`performance.html`). Registration
collects first name, optional other names, and email, then opens the client
dashboard. New users must confirm the one-time email link before assessment
access. The client dashboard shows saved profile details, email status, current
assessment progress, certificates, and the required agreement step. Users can
update their names and preferred market; email remains read-only. Returning users
log in at `login.html`. Each user has a separate practice account. Registration and trading data persist in SQLite.

## Backend

### Admin dashboard

The staff console at `/admin.html` includes an overview, searchable traders and
assessment records, certificates, company agreement publication, sponsorship
reviews, sponsored-account records, MetaTrader connections, profit statements,
payout records, performance analysis, account-closure requests, backup/error
operations, support, bounded CSV reports, staff permissions, audit history, and system
configuration status. The client dashboard shows the trader's own review message and recorded
sponsored accounts and payouts. Internal reviewer notes and evidence references
are not included in the client view.

Admin access is explicit: registration never creates an administrator. Set
`ADMIN_OWNER_EMAILS` on the application server to the exact initial owner's
registered email address, or provision an existing staff account using the
trusted-server CLI below. Every admin-console account must have a confirmed
email, enabled authenticator 2FA, and active account status. Configure the verified
Resend sender before confirming a new owner's email, then enroll the authenticator
from Security. A configured email alone does not activate admin access.

Roles are `owner`, `admin`, `reviewer`, and `support`. Owners manage staff roles;
admins manage academy operations and financial records; reviewers inspect trader,
assessment, agreement, and certificate records and make review decisions; support
staff use the support queue and a limited overview. Sensitive changes and CSV
exports additionally require the signed-in staff member's password and a fresh
authenticator or unused recovery code. The resulting privilege lasts five minutes,
is tied to that session and current security/role state, and stores no raw proof.

On the trusted application server, using its existing `DATABASE_PATH`:

```sh
npm run admin:staff -- list
npm run admin:staff -- grant --email registered-owner@your-domain.example --role owner --reason "Initial owner provisioning."
npm run admin:staff -- grant --email registered-reviewer@your-domain.example --role reviewer --reason "Assign assessment reviews."
npm run admin:staff -- revoke --email registered-reviewer@your-domain.example --reason "Remove reviewer access."
```

Run the current server once before using the CLI so the database/security schema
exists. Grants require registered, email-verified users with 2FA already enabled;
the command cannot bypass these prerequisites. Role changes revoke existing
sessions and pending authentication challenges. Owners listed in
`ADMIN_OWNER_EMAILS` are managed through that environment setting and a server
restart, not through web or CLI revocation. Self-removal, self-suspension, and
removal of the last eligible owner are restricted. The older
`SUPPORT_STAFF_EMAILS`/`support:staff` grants independently control the legacy
support inbox; removing an admin role does not remove a separate support grant.

Administrative writes require a reason and append an immutable audit record.
Suspension revokes sessions and blocks new sign-ins, while preserving records and
background protection of open simulated exposure. Restoring access requires a new
sign-in. Review approval requires the current qualifying assessment certificate
and signature on the exact active agreement. A changed agreement or certificate
invalidates a stale review basis; a certificate or approval does not issue an
external prop account.

Sponsored-account allocations, cleared payout receipts, and payment confirmations
are **records of external activity**. Approved traders who sign the supplied
`progressive-profit-sharing-v1` section use the standard progressive model:

| Cumulative qualifying net payouts before the next receipt | Trader | Company |
| --- | --- | --- |
| Below $10,000 | 50% | 50% |
| $10,000 to below $25,000 | 60% | 40% |
| $25,000 and above | 70% | 30% |

A qualifying receipt is an eligible prop-firm payout actually received and cleared
by the company, attributable to the trader, after the firm's deductions and agreed
third-party transaction charges, before the trader/company split. It is recorded
in USD cents with reconciliation evidence and a cleared-funds date. MetaApi
observations, paper results, unrealized profits, and unsettled statements do not
credit earnings or advance a tier.

The threshold-crossing receipt uses the tier earned **before that receipt**. A
first $10,000 qualifying receipt therefore allocates $5,000 to the trader and
$5,000 to the company; the next eligible receipt uses 60%. Posted distributions are
immutable and are not recalculated. Qualifying net receipts aggregate across all
eligible sponsored accounts in the continuous contractual relationship. Earned
tiers are retained across new accounts, approved firm changes, ordinary losses,
and evaluation failures. Closing an account does not close that relationship.

The company calculates entitlement and must initiate payment within three business
days after cleared receipt. Operational deadlines count Monday–Friday in
Africa/Lagos. Statements show the received qualifying amount, applied tier,
trader/company entitlements, and updated cumulative qualifying net payouts.
Payment initiation and final external payment are distinct recorded events. The
website does not purchase prop accounts, initiate a bank transfer, or independently
prove that staff evidence is genuine.

Existing fixed-share sponsored records remain bound to their original signed
terms. Legacy `cumulative_high_water` and `settled_period` statements remain
immutable; they are not converted into cleared progressive receipts or silently
recalculated. A new agreement never supplies a trader's signature. Higher earned
tiers cannot be unilaterally reduced in an active relationship. Termination leaves
accrued unpaid entitlements payable; reinstatement or new sponsorship after
termination needs an express written tier determination before it begins.

The admin can prepare a reinstatement document containing the exact supplied
section plus the previous relationship, written reference, selected 50%/60%/70%
starting tier, and an explicit new-relationship cumulative total. Preparation is
not publication or consent. Publish that version **privately to the named
Fundraiser**, obtain their personal electronic signature, approve that exact
version, then record reinstatement. A staff checkbox alone cannot substitute for
that signature. Personal versions never replace the standard agreement for other
members, and mismatched or missing recipients are rejected. The automated model
supports the standard tiers; nonstandard written exceptions require a separately
reviewed implementation and are never silently converted.

Your private Academy title is your registered **first name + Fundraiser**;
compound first names remain intact. Public rankings retain the public alias you
chose to share, followed by Fundraiser. Registration, legal signatures, and
certificate-name choices are stored independently from these display titles.

Requested and approved payouts reserve available recorded trader earnings;
rejection releases the reservation. Recording external payment requires its real
reference. Keep settled evidence and the private database on durable storage.
See `/profit-sharing.html` for the public summary and DEPLOYMENT.md for operation.

### Personal account controls and payout requests

`/account-tools.html` lets a signed-in client export their personal records,
request account deletion, and request a payout from their available recorded
earnings. Each action first requires the current password and, when enabled, a
fresh authenticator or unused recovery code. The resulting five-minute privilege
is bound to that session and action purpose; an export confirmation cannot
authorize a deletion or payout.

The JSON personal-data export includes the client's profile and preferences,
assessment history, certificates, signed agreement records, support conversations,
financial records, and captured performance observations. It excludes passwords,
authentication tokens and seeds, internal reviewer notes, staff identities, other
clients, and private provider credentials. The browser collects all bounded pages
and checks the export fingerprint before downloading a complete file. If the
records change during collection, the request must be retried; partial results
are not presented as a complete export. Browser collection is limited to 50 MB.

Deletion requires typing `DELETE MY ACCOUNT`. Completed closure removes mutable
operational personal data, replaces the usable profile with a non-login tombstone,
revokes sessions and authentication material, disconnects the MetaApi link, and
removes mutable trading, support, notification, and performance observations. The
receipt lists restricted immutable agreements, financial records, review history,
and administrative records retained for operator retention review. Earlier backup
copies may remain until backup rotation removes them. This is account closure and
operational-data deletion, not a claim that every personal datum has been erased;
the company must still finalize and apply its retention policy.

Staff/support assignments, open or paused sponsored allocations, outstanding
payouts, and unsettled earned shares hold the request in `pending_closure`.
Pending clients retain access to resolve payouts and can cancel the request. Staff
can complete a previously requested deletion only after its blockers are resolved;
the admin screen does not provide an arbitrary delete-user action.

Client payout requests reserve only the owned account's unreserved earned share.
Amounts use exact USD cents and retries use an idempotency key, preventing a
duplicate request from reserving the same earnings twice. Staff approve or reject
requests and record an external payment reference when a payment is made. Clients
can inspect the resulting status history. A requested or approved payment has not
been sent, and a recorded paid status does not independently verify a bank transfer.

### MetaTrader account synchronization

The MetaTrader connections section uses the official MetaApi SDK to read existing
MetaTrader 4/5 accounts. Configure `METAAPI_API_TOKEN` privately on the application
server, create and deploy the account through MetaApi under the prop firm's
permitted arrangements, then link its MetaApi account ID to an academy sponsored
record backed by the current approved review. No broker password or API token is
entered into the website's connection form. This connector does not provision or
deploy a prop account, place trades, purchase accounts, or transfer money.

Choose the history start at assignment; the default is the previous 30 days.
An external account and history start stay bound to that sponsored record, so
history cannot be reassigned to a different trader. The server synchronizes active
links approximately every 60 seconds, within bounded jobs and provider limits.
Manual sync is also available. The interface distinguishes last successful sync,
stale data, unavailable configuration, and incomplete history. Deal IDs and
correction history prevent duplicate imported results. Only synchronized history
is reported; recent overlap can detect corrections, while older records outside
that coverage still require reconciliation.

Provider balances, equity, deals, fees, and cash flows keep the broker account's
native currency. Deposits and withdrawals are not treated as trading profit.
These read-only observations do not automatically post a profit statement, select
a profit split, or create available payout earnings. Staff must reconcile the
actual agreed settlement before posting to the separate USD-cent ledger. Live
provider access requires a real configured token and authorized account; mocked
integration tests alone do not establish that a particular prop firm permits or
supports the connection.

### Advanced performance reports

Clients use `/performance.html`; authorized admins use Performance analysis to
inspect a selected trader. Reports include UTC monthly and daily results,
closing-fill counts and win rates, expectancy, profit factor, recorded drawdown,
and profit concentration across days. Consistency measures are descriptive and do
not introduce new qualification rules or promise future returns.

Observed equity curves contain actual captured reference valuations or broker
snapshots. Historical marked equity is not invented. A separately labeled realized
balance curve can be reconstructed only when recorded closed assessment fills
reconcile to the saved balance. Gaps and lines between observations do not recover
unrecorded market moves. Sponsored reports preserve native currency and disclose
history limits, omitted or unclassified records, fees, cash flows, and staleness.
MetaTrader partial closes can be separate closing fills; their win rate is not a
round-trip-position win rate. Standalone costs affect net results without being
assigned to an invented winning or losing position.

### Operational health, error monitoring, and recovery

Open **Admin → Operations & recovery** for an actionable health report. It flags
unavailable database/storage checks, low disk space, old or failed backups,
notification delivery problems, missing email/forex configuration, and stale
active MetaApi connections. Numeric metrics show runtime memory, database/WAL
size, and available storage. Refresh to collect current local observations or
download the sanitized health report for an operator review.

**Run diagnostics** requires a reason and fresh staff authentication. It checks
the live database with bounded, read-only SQLite `quick_check` and foreign-key checks
in an isolated subprocess, and probes private storage with a temporary file that is
removed afterward. The result and recent diagnostic history contain fixed status
fields and safe failure codes, without customer records, provider account IDs,
paths, secret values, or raw SQL errors. It does not repair data, send messages,
contact providers, or restore the live database. Email configuration does not
prove inbox delivery; storage capacity does not prove persistence or an offsite
copy. Review those requirements separately even when local checks pass.

Operations & recovery shows bounded server-error fingerprints, occurrence counts,
sanitized routes, backup history, and recovery-check results. Raw request bodies,
credentials, and exception text are not stored in the monitoring view. Monitoring
is local to this installation; no external alerting service is configured.

The running server schedules encrypted, SQLite-consistent local backups. Defaults
are one backup every 24 hours, seven retained artifacts, and an initial job after
about 30 seconds. `BACKUP_DIRECTORY`, `BACKUP_INTERVAL_HOURS`, and
`BACKUP_RETENTION_COUNT` configure storage and rotation. Artifacts include the
database and required authenticator/push keys, verify integrity in an isolated
copy, and are never served from `public/`. Each recovery check reapplies the
current account-deletion ledger without modifying the running application.

Backups use AES-256-GCM. Preserve a separate secure copy of the stable
`BACKUP_ENCRYPTION_KEY`, if directly configured, or the generated private
`backup-key.json` beside the database. This encryption key is deliberately not
included inside the backup it decrypts. Losing it prevents recovery. Keep the
database, backups, and their necessary keys on persistent storage; local backups
on the same ephemeral Render instance do not protect against instance loss.
Offsite backup storage is not configured.

Trusted operators can use the existing private `DATABASE_PATH`:

```sh
npm run operations -- status
npm run operations -- health
npm run operations -- diagnose
npm run operations -- backup
npm run operations -- verify
npm run operations -- verify --backup BACKUP_UUID
npm run operations -- restore --backup BACKUP_UUID --target /secure/new-academy-recovery --confirmation "RESTORE TO NEW DIRECTORY"
```

`health` returns the same sanitized aggregate checks; exit code 0 means
`healthy`, and 2 means `attention` or `critical`. `diagnose` returns a recorded
diagnostic result; exit code 0 means `ok`, and 2 means `warning` or `critical`.
Both use exit code 1 for a command/usage failure. These commands perform no
external delivery or provider request. The standalone CLI does not start the
application's background schedulers.

The CLI requires a healthy current database and its latest deletion ledger. It
creates a new private directory and refuses to replace an existing target or live
database. These tools provide tested backup checks and fresh-copy recovery, not
complete recovery after losing the current database/deletion ledger or the host.
An operator still needs a separate offsite disaster-recovery procedure.

A recovered copy revokes old sessions, pending authentication/email/reset tokens,
push subscriptions, queued delivery jobs, and recovery-code hashes. Accounts must
complete password recovery before signing in; enabled authenticator secrets stay
enabled and must use the restored original encryption key. Generate replacement
recovery codes after regaining access. See DEPLOYMENT.md before activating any
recovered copy.

### Required trader agreement

After a server-confirmed assessment pass, the dashboard and certificates page
show the required next step at `contract.html`. Returning passed challengers
who have not signed are directed there after login. The company-provided revised
section is included in `agreements/progressive-profit-sharing-v1.txt` and published
idempotently on startup as `progressive-profit-sharing-v1`. It contains the exact
supplied ten clauses; it is a section rather than invented additional contract
terms. An existing later active publication is not reactivated by repeated startup.
New versions require explicit trader consent and never alter previous signatures.

An operator can publish the company-provided PDF or UTF-8 `.txt` file, up to
10 MB, after the server has initialized its database:

```sh
npm run contract:publish -- --file /private/trader-agreement.pdf --version v1
```

Use `--database /path/to/academy.sqlite` for a different database and `--title`
for the document title. Alternatively set `CONTRACT_FILE`, `CONTRACT_VERSION`,
and optional `CONTRACT_TITLE` before startup. Keep the source outside `public/`;
`private/` is ignored by Git. Do not include completed personal contracts in
release downloads. Published bytes are retained in the private database.

Signing requires a persisted assessment certificate, a typed full legal name,
explicit consent, and the exact active document ID, version, and SHA-256 hash.
Certificate nicknames do not set the contract signature. Signature records and
document versions are immutable and remain after a practice reset. Publishing a
new version requires a new signature and keeps previous signed agreements
accessible. Only signed challengers have `canProceedToFundingReview: true`;
funding approval and account provisioning still need the company's review.

The supplied progressive profit-sharing section is the authorized source for this
release. Other company legal details and any additional agreement provisions still
need company authorization. This workflow records typed electronic signatures;
it does not use an external identity-verification or signing provider.

The Node.js HTTP server serves the website and JSON API. `backend.mjs` implements
registration/login/logout, salted scrypt password hashes, hashed session tokens,
HttpOnly SameSite cookies, mutation origin/header checks, basic IP rate limiting,
and per-user server-side trading execution. The default database is
`data/academy.sqlite` (ignored by Git). Keep the entire data directory private and
on persistent storage; back it up with a SQLite-aware backup process. Never serve
this directory publicly. Resetting a practice account archives its earlier state
in the audit record.

Configuration:

- `PORT`: default 3000.
- `DATABASE_PATH`: optional absolute path to the SQLite database.
- `APP_ORIGIN`: public origin, such as `https://academy.example.com`.
- `COOKIE_SECURE=true`: secure cookies; enable with HTTPS for deployment.

Deploy behind HTTPS and set `APP_ORIGIN` and `COOKIE_SECURE=true`. This is a working
single-server development backend. Account controls, MetaApi performance reads,
payout requests, advanced reports, and encrypted local backup/recovery checks are
implemented. A finalized retention policy, offsite disaster-recovery storage, real
provider configuration, and payment execution still need operator setup or an
additional integration. Manual payment records do not send funds.
Formal program terms and legal/privacy information must be finalized before launch.

API endpoints: POST `/api/register`, `/api/login`, `/api/logout`, `/api/trades`,
`/api/trades/close`, `/api/account/reset`; GET `/api/me`, `/api/account`, `/api/journal`.
Mutations require JSON and `X-Requested-With: FundraiserAcademy`. All trading endpoints
require a valid session and always operate on that session's account. Client prices,
balances, and profit values are never accepted as execution authority.

### Real market references and chart history

The trading desk uses the **Market reference** chart and verified execution quotes. Coinbase Exchange
provides BTC/USD and ETH/USD last-trade prices and genuine OHLC candles, with
1-minute, 5-minute, 15-minute, hourly, and daily intervals. Traders can switch
between candle and line views, inspect OHLC values, and browse older price windows.
Pattern labels identify candle shapes in returned data; they do not predict the
next price. Chart preferences are remembered on that device per signed-in user.

The ten forex pairs use Frankfurter daily central-bank reference closes. These
are daily data, not intraday prices, and are never turned into invented candles.
TradingView's external candlestick chart supports forex and crypto instruments,
interval controls, zoom, and historical navigation. Its availability and data
delays depend on the chart provider. Provider attribution remains visible.

The authenticated `/api/market-reference` endpoint validates provider data and
uses a bounded shared cache and request timeouts. Quotes show their source,
as-of time, and freshness. Source failures display unavailable or explicitly stale
cached data. Generated prices are never substituted into references or executions. Crypto
reference endpoints and daily forex history do not require an API key. Intraday
forex execution requires TWELVE_DATA_API_KEY and a supporting Twelve Data plan.

Challenge orders fill exactly at the **server-verified reference price** shown
in the order ticket, without an added spread. P&L, stops, limits, risk checks, and
price alerts use the same reference feed. Source quotes must be at most 120
seconds old and retrieved within 30 seconds. Stale, unavailable, and closed-market
quotes pause execution. Last valid marks can remain visible with a stale label;
they cannot open or close a trade. Client-supplied prices are ignored.

Daily forex closes and external TradingView charts are display-only. For executable
quotes for all forex pairs, configure TWELVE_DATA_API_KEY via secure hosting
settings; the server uses Twelve Data intraday quotes from api.twelvedata.com.
Requests explicitly select one-minute intervals and UTC. Quote freshness uses
the provider's `last_quote_at` observation time when present; the interval
`timestamp` is used only when that field is absent. Invalid or stale observation
times pause fills rather than borrowing another timestamp or the server clock.
Crypto execution uses the Coinbase ticker even if historical candles are unavailable.

The dashboard receives authenticated live account updates approximately once per
second. Crypto references use Coinbase's public WebSocket ticker feed, with REST
polling when the stream is unavailable. Prices, order estimates, open P&L, and the
reference-price headline use the same server snapshots. The feed label distinguishes
streaming observations from periodic quotes. Twelve Data Basic forex references
remain periodic REST quotes, cached for up to 30 seconds; Basic does not include
forex WebSocket streaming. No fabricated ticks are inserted between observations.
Source age and retrieval time remain visible, and unavailable quotes pause fills.
Hidden tabs disconnect their live account stream; open trades still receive server
risk checks. Live updates and order responses carry a revision so delayed responses
cannot restore an older account or quote after a trade or reset.

Order volume is entered in lots. For this demo, one forex lot is 100,000 units of
the base currency, and one crypto lot is one coin. Forex volumes start at 0.01 lot
in 0.01 increments; crypto starts at 0.001 lot in 0.001 increments. Margin and
P&L use the corresponding contract quantity and USD conversion. Existing trades
retain their original quantities and results; the interface displays their lot
equivalent. Actual sponsored firms may use different contract specifications.

The account is denominated in USD. Forex prices retain their native quote currency:
JPY pairs show three decimal places, and other forex pairs show five. Margin,
P&L, and risk limits convert to USD using fresh server references. EUR/JPY and
GBP/JPY require USD/JPY; EUR/GBP requires GBP/USD. USD/JPY, USD/CHF, and USD/CAD
use their own inverse rate. Entry margin is fixed in USD, and each fill records
the conversion rate and its source timestamp. An unavailable conversion pauses
execution; missing valuations display a dash rather than fabricated account values.

Earlier attempts retain their original prices, positions, and results in a
read-only state. Traders explicitly reset to start a reference-priced attempt;
reset archives their earlier account and preserves certificates and signed agreements.
Account polling, market updates, orders, and resets are serialized per user to
prevent an awaited provider request from overwriting a concurrent trade.

Allow server access to `api.exchange.coinbase.com`, `api.frankfurter.dev`, and
`api.twelvedata.com` when intraday forex is configured.
The browser-hosted chart needs `s3.tradingview.com` and TradingView subdomains.
During cloud development these providers may be blocked by the environment's
network policy; review/save/publish the added network settings before verifying
live responses. Mocked transport and browser tests do not prove live data receipt.

### Trader controls and notifications

The dashboard supports pending buy/sell limit-entry orders and editing stop-loss /
take-profit prices on open positions. Limit orders execute at the next eligible
server quote at the requested price or better. They do not reserve margin; execution
can be rejected if margin, stops, or personal/challenge risk checks no longer permit
the trade. Risk breaches cancel pending orders.

Traders can set a stricter personal daily dollar-loss cap, maximum planned dollar
risk per trade (requires a stop loss), and maximum open positions (1–20). Caps cannot
weaken challenge rules. Per-trade risk applies to new orders and stop edits, not
retroactively to existing positions. Gaps may exceed planned loss. Personal daily
locks remain until the next UTC day even if settings are later raised or removed.

One-time price alerts watch verified reference prices at/above or at/below a target on
the next server quote. Alerts and orders belong to each authenticated account and
persist in SQLite. A saved notification inbox contains the latest 100 messages for
fills, closes, protection edits, limit-order events, risk breaches, and price alerts.
Messages support mark-all-read and foreground popup notifications. Web Push uses a
registered service worker to display OS/browser notifications when the dashboard
is closed or hidden. In a visible dashboard it sends a popup message instead.
Permission and browser/OS support are required; delivery is not guaranteed.

New signups require an email confirmation link delivered through Resend. Links
expire after 30 minutes, are single-use, and can be resent after one minute.
Assessment access is enforced on the server: an unconfirmed new user can manage
their profile and request another confirmation email, but cannot trade, reset,
stream market data, or enter qualification steps. Accounts created before this
requirement retain their existing assessment access and records; their actual
email-verification status remains visible. If delivery is not configured, the
account remains pending and the dashboard explains that confirmation email
is unavailable. Queued or provider-accepted mail is not proof of inbox receipt.

Confirming an account email does not enable optional trading alerts. Notification
emails use a separate explicit opt-in and ownership verification.
Configure `RESEND_API_KEY`, `EMAIL_FROM` (a verified sender), and `APP_ORIGIN` (the
public HTTPS origin). Users can disable email and unsubscribe this browser from
push. Logout removes this device's push endpoint; closing the page leaves it active.
Email opt-in alone does not verify identity for funding or complete registration KYC.

Delivery uses a persistent SQLite outbox, provider idempotency for email, retries
with backoff, and removal of expired push endpoints. A generated VAPID key pair is
stored privately in `data/vapid.json` alongside the database (or the custom database
directory); preserve and back up this file, never commit or disclose the private key.
`VAPID_SUBJECT` can override the application origin for push identification.
The server must remain running, and quotes only advance while a session is active.
The server honors environment HTTPS proxy configuration for notification services.
Required destinations: `api.resend.com`, `fcm.googleapis.com`,
`*.push.services.mozilla.com`, and `web.push.apple.com`.

Live email and push have not been validated without sender credentials and public
HTTPS deployment. Automated tests use mocked delivery transports, and service-worker
behavior is tested with simulated push events. Foreground popups and worker
registration were verified in Chromium. Notification queue counts show pending
and failed deliveries; provider acceptance does not prove receipt by the recipient.

Locked challenges stop quote advancement until unlocked/reset, so price alerts
also stop evaluating during that period. Display pause leaves notifications polling.

Additional authenticated POST endpoints: `/api/limits`, `/api/trades/protection`,
`/api/orders`, `/api/orders/cancel`, `/api/alerts`, `/api/alerts/remove`,
`/api/notifications/read`. Old account state initializes these tools additively.

## Trading demo

The simulator starts with $10,000 in demo funds. Forex markets are EUR/USD,
GBP/USD, AUD/USD, NZD/USD, USD/JPY, USD/CHF, USD/CAD, EUR/GBP, EUR/JPY, and GBP/JPY.
Crypto markets are BTC/USD and ETH/USD. It supports long/short market trades, margin checks, exact reference-price fills,
optional stop-loss/take-profit levels, manual closes, and a JSON journal export.
The risk monitor displays equity, floating P&L, win rate, and maximum drawdown.
Challenge rules are 10% realized profit to pass, 5% daily loss from day-start equity,
and 10% total loss from initial balance. Total drawdown is static, not trailing;
for a $10,000 account, the equity floor is $9,000. Passing requires no open positions
and fills on at least 3 distinct UTC trading days. Multiple fills on one day count
once; unfilled orders and merely holding a position do not add trading days.
A breach liquidates positions and locks new trades. Daily locks clear on the next
UTC day; total-loss locks require reset. Open positions, pending orders, and active alerts receive server-side reference
checks even after logout. Source outages pause execution. On recovery, stops fill
at the next observed reference, so gaps can exceed the requested stop.
Commissions and financing are not modeled.

Run `npm test` for backend and trading-engine tests. Browser validation covers
registration/login, orders, saved records, challenge thresholds, reset, logout, and
desktop/mobile layouts. Records and reference-price execution are server-controlled;
practice passing does not approve real funding. A real qualification program needs
reviewer tools and finalized evaluation terms.

Public profit-sharing terms and examples are available at `/profit-sharing.html`.

Brand assets include `public/logo.svg`, `public/logo-mark.svg`, gold and print
variants, plus the official black/gold identity board and social avatar in
`public/assets/`.
`ACADEMY_PLAYBOOK.md` contains positioning, social copy, operating workflow,
qualification criteria to finalize, and a trader agreement brief.

The revised progressive profit-sharing terms and simulator thresholds are
published. Partner firms, account sizes, eligible regions, formal intake details,
and launch dates still need company decisions. The website records sponsored
operations; it does not itself issue accounts or transfer funds.

## Completion certificates

`certificates.html` lists all of the authenticated trader's completion certificates.
The server issues one certificate per passed attempt after the 10% realized-profit
and 3-trading-day requirements are met with no open positions. Certificates survive
account resets. They can be previewed, downloaded as SVG, or printed/saved as PDF.
The certificate recognizes paper-trading completion only, not professional accreditation
or automatic funding approval.

Traders choose their registered name or a nickname (up to 60 characters) with a
preview in My certificates. Saved preferences apply to future awards. An explicit
checkbox also applies the display choice to existing certificates, preserving their
IDs, issue dates, and recorded results; the change is recorded in the audit log.
Certificates and preferences are restricted to the authenticated owner.

Endpoints: GET `/api/certificates`, `/api/certificates/:id`,
`/api/certificates/:id.svg`, `/api/certificate-preferences`; POST
`/api/certificate-preferences`. Notification endpoints: GET
`/api/notification-settings`; POST `/api/push/subscribe`, `/api/push/unsubscribe`,
`/api/email/request-verification`, `/api/email/preferences`, `/api/email/verify`.
Email confirmation and password recovery use their own one-time tokens without an existing login.


### Password recovery

Choose **Forgot password** on `login.html`, or open `forgot-password.html`.
`POST /api/password/forgot` accepts `{ "email": "..." }` and always returns the
same accepted response, including for unknown accounts, unavailable email, and
request cooldowns. A response does not confirm an account exists or mail arrived.
Recovery uses the existing Resend configuration: `RESEND_API_KEY`, a verified
`EMAIL_FROM`, and a public HTTPS `APP_ORIGIN` reaching this server. Render derives
its origin automatically. No additional provider or credential is required.

The most recent email contains a random single-use reset link valid for 20 minutes.
Only its SHA-256 digest is stored in the token table; the raw link is held privately
in queued mail and scrubbed after delivery, cancellation, expiry, or final failure.
The link uses a URL fragment removed immediately by the reset page. Opening it does
not consume it: the user explicitly submits a new password with
`POST /api/password/reset`. Request limits include an account/email cooldown and
IP limits. Responses never expose reset tokens or delivery details.

New reset passwords must contain 15–128 characters. Use a unique passphrase or
a password manager; pasting and long passwords are supported. A successful reset
atomically changes the salted scrypt password hash, consumes outstanding reset
links, revokes every session and background push subscription, and ends active
account streams. A password-changed security email is queued independently of
optional alert preferences. Sign in again afterwards; there is no automatic login.
Resetting a password preserves profiles, assessment history, certificates,
contracts, email confirmation status, and optional email preferences. It does not
reset the trading challenge. Obvious common passwords and predictable repetitions
are rejected without requiring arbitrary mixtures of symbols, numbers, or case.
Reset hashes use a versioned scrypt format with N=32768, r=8, p=3 and a fresh
random salt. Legacy password hashes remain valid for existing sign-ins. Hashing
work is bounded to two concurrent operations with a limited waiting queue, so
expensive authentication requests cannot allocate unlimited memory. Old passwords cannot create a session after a reset
even when a login was already in flight. Email outages never expose a recovery
link through a browser, API, or logs; restore delivery rather than bypass ownership.


### Two-factor authentication and sessions

Open **Security** from the client dashboard, or visit `security.html`. Add Google
Authenticator, Microsoft Authenticator, 1Password, or another standards-compatible
TOTP app. Confirm ownership of your account email before enrollment, including
older accounts that already have assessment access. Security offers a confirmation
email button for unverified accounts. Setup then requires the current password,
a locally generated QR or manual
setup key, and a correct six-digit app code before protection is enabled.
The setup expires after ten minutes. No external QR service receives the secret.

Enabling 2FA shows ten random, single-use recovery codes once. Copy or download
them and keep them in a password manager or another private location separate
from the authenticator. Passwords, setup keys, and displayed codes are cleared
when the Security page is hidden; codes are not stored in browser storage.
After entering the password, sign-in requires a fresh authenticator code or an
unused recovery code. Sign-in challenges expire after five minutes, cannot be
replayed, and have persisted attempt limits. Only full authentication creates a
normal session. Codes use a 30-second period with limited clock drift allowance.
A code already used for login or a security change cannot be used again: wait
for the next code in the app or use a different recovery code.

Disabling 2FA, replacing recovery codes, or revoking sessions requires the current
password and, when enabled, a fresh authenticator or unused recovery code. Factor
changes invalidate earlier sign-ins and challenges, rotate the current cookie,
and remove device push subscriptions. Replacement codes invalidate the entire
previous set. Password recovery changes the password and signs out all devices
but preserves 2FA and remaining recovery codes; email access alone cannot remove
the second factor. To replace a lost app, use recovery codes to sign in, disable
2FA with a fresh proof, then enroll the new app. Losing both app and codes requires
a manual account review; no automated support or email bypass is implemented.

The session list shows your current browser, approximate browser/device labels,
last activity, creation time when recorded, and expiry. Labels are user-agent
hints, not verified identities or locations. Public session IDs are independent
random UUIDs; auth cookie values and hashes never appear in the list. You can
sign out a selected device, every other device, or all devices. Sessions last
at most seven days and expire after 24 hours without session activity. Passive
SSE messages do not renew the idle deadline. Revocation ends the corresponding
active account streams immediately and blocks requests already waiting on network
or password work. Automatic trading risk checks continue after logout.
Existing valid sessions migrate without inventing their original creation date.

Authenticator secrets use AES-256-GCM encryption with user-bound authenticated
data. The server creates a private `two-factor-key.json` beside `DATABASE_PATH`
when first initialized. **Back up and restore the entire private data directory,
including this key, with the SQLite database.** Keep it outside `public/`, Git,
and release downloads. POSIX keys must have mode 600; on Windows protect the
private folder using account-level file permissions. The optional
`TWO_FACTOR_ENCRYPTION_KEY` accepts a stable base64-encoded 32-byte key provided
directly to the server process. It is a local encryption secret, not a network
API key or proxy placeholder. Do not change it after enrollment without a planned
secret migration. Existing encrypted factors fail closed if their key is missing
or wrong; unused recovery codes still work. A lost key is never silently replaced
while encrypted factors remain.

Authenticator sign-in itself does not use email or SMS. First-time enrollment
requires an email already confirmed through the existing account email service.
Security-change notices use the existing
transactional Resend queue when configured, independently of trade-alert opt-in;
no authenticator or recovery secrets are emailed.

APIs: GET `/api/security`; POST `/api/security/2fa/setup`, `/confirm`, `/cancel`,
`/disable`, `/recovery-codes` under that prefix; POST `/api/login/2fa` and
`/api/login/2fa/cancel`; POST `/api/security/sessions/revoke`, `/revoke-others`,
`/revoke-all`. Security APIs remain available to owners awaiting email confirmation
and do not grant assessment access.


### Customer support and human handoff

A Support button opens the customer conversation from site pages. Public visitors
can read basic company answers; signed-in clients, including clients waiting for
email confirmation, can save a conversation and request an agent. The assistant
covers the published model, assessment limits, registration, certificates, and
required agreement, published 50%/60%/70% profit tiers, next-receipt advancement,
continuous tier retention, qualifying cleared receipts, and the three-business-day
payment-initiation obligation. Unpublished account sizes, partner lists, and
individual sponsorship or payment decisions are referred to staff.

Set `SUPPORT_AI_API_KEY` in secure server settings for generative OpenAI replies.
`SUPPORT_AI_MODEL` defaults to `gpt-4.1-mini`. The key stays on the server; only
bounded chat history and the academy knowledge guide are sent to the provider,
with response storage disabled. Profile, trading, certificate, and agreement
records are not attached. Without a working AI key, answers come from the local
**Academy guide** and are labeled accordingly. Support has no trading, funding,
account-editing, or legal-signing tools.

“Talk to an agent” or a clear request to speak with a person places the conversation
in the human queue and pauses automated replies. Messages and handoff history stay
in SQLite. Authorized agents claim requests and reply in the same conversation at
`support-agent.html`. A queued request does not mean an agent is online or available
immediately; no support hours or response-time promise is configured.

Staff access starts empty and always requires a registered, email-verified user.
An operator can set `SUPPORT_STAFF_EMAILS` to a comma-separated list of verified
staff emails in hosting settings, then restart. This is a server setting, never a
registration field. Alternatively, after the database has initialized, run:

```sh
npm run support:staff -- grant --email staff@your-domain.example
npm run support:staff -- list
npm run support:staff -- revoke --email staff@your-domain.example
```

Use the same `DATABASE_PATH` as the running service. Removing an environment-based
staff grant requires removing that email from `SUPPORT_STAFF_EMAILS` and restarting;
a CLI revoke does not override the environment allowlist. Staff roles grant support
inbox access, not funding reviewer or trading privileges. Keep the database and
support transcripts on private persistent storage. API and browser tests inject
AI and email transports; they do not establish live provider billing or inbox receipt.


### Contract trader leaderboard

`leaderboard.html` is a public ranking of opted-in traders who signed the current
academy contract. It compares the realized return on the reference-priced
qualifying assessment linked to that signature. MetaApi-sponsored performance is
available separately in private performance reports and is not used by these rankings.

A trader must have an owned reference-price certificate showing at least three
trading days and a 10% return, a matching signature for the currently active
contract document, and enabled leaderboard visibility with a public alias.
Participation is private by default. The public API exposes only an opaque entry
ID, alias, qualification return, realized demo profit, trading days, completion
date, and rank. Email, legal name, account IDs, contract details, and certificate
IDs stay private. The owner can update their alias or hide their entry at
`/leaderboard.html`; pending clients can set preferences, but do not become eligible
until qualification and signing are complete.

Rankings use realized percentage return, rounded to two decimals. Equal displayed
returns share a competition rank (for example 1, 1, 3); stable completion-date and
public-ID ordering makes pagination predictable. Rankings use the signed
certificate snapshot rather than current practice balance, so resetting a demo or
renaming a certificate cannot manufacture leaderboard returns. A newly published
contract requires a fresh signature before a trader is eligible again.

GET `/api/leaderboard?limit=20&offset=0` is public, bounded, and does not request
market prices. GET/POST `/api/leaderboard/preferences` is authenticated and owner
bound; updates accept visibility and alias only, never client scores or contract
status. No sample traders or mock performance are published. Until a real contract
is supplied, signed, and participants opt in, the leaderboard has an honest empty
state. A leaderboard position is not a sponsorship approval or a live profit claim.
