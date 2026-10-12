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

Registration and trading work without email credentials. New users, records, and
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
demo registration (`contact.html`), privacy notice (`privacy.html`), and trading
simulator (`dashboard.html`). Registration leads directly to the dashboard.
Registration creates an account in the backend, establishes a session, and opens
its trading dashboard. Returning users log in at `login.html`. Each user has a
separate practice account. Registration and trading data persist in SQLite.

## Backend

### Required trader agreement

After a server-confirmed assessment pass, the dashboard and certificates page
show the required next step at `contract.html`. Returning passed challengers
who have not signed are directed there after login. Until the company supplies
an agreement, the page shows **Agreement pending** and signing is unavailable.

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

The contract terms have not been supplied. This workflow records typed electronic
signatures; it does not use an external identity-verification or signing provider.

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
single-server development backend, not a complete public-launch system. Email
verification, password recovery, admin/reviewer tools, account deletion, retention
policy, operational backups, and funding/payout integrations still need implementation.
Formal program terms and legal/privacy information must be finalized before launch.

API endpoints: POST `/api/register`, `/api/login`, `/api/logout`, `/api/trades`,
`/api/trades/close`, `/api/account/reset`; GET `/api/me`, `/api/account`, `/api/journal`.
Mutations require JSON and `X-Requested-With: FundraiserAcademy`. All trading endpoints
require a valid session and always operate on that session's account. Client prices,
balances, and profit values are never accepted as execution authority.

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

One-time price alerts watch synthetic mid prices at/above or at/below a target on
the next server quote. Alerts and orders belong to each authenticated account and
persist in SQLite. A saved notification inbox contains the latest 100 messages for
fills, closes, protection edits, limit-order events, risk breaches, and price alerts.
Messages support mark-all-read and foreground popup notifications. Web Push uses a
registered service worker to display OS/browser notifications when the dashboard
is closed or hidden. In a visible dashboard it sends a popup message instead.
Permission and browser/OS support are required; delivery is not guaranteed.

Email uses Resend, with user opt-in and a confirmation link before alerts are sent.
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

The simulator starts with $10,000 and synthetic EUR/USD, GBP/USD, BTC/USD, and
ETH/USD quotes. It supports long/short market trades, margin checks, bid/ask spreads,
optional stop-loss/take-profit levels, manual closes, and a JSON journal export.
The risk monitor displays equity, floating P&L, win rate, and maximum drawdown.
Challenge rules are 10% realized profit to pass, 5% daily loss from day-start equity,
and 10% total loss from initial balance. Total drawdown is static, not trailing;
for a $10,000 account, the equity floor is $9,000. Passing requires no open positions
and fills on at least 3 distinct UTC trading days. Multiple fills on one day count
once; unfilled orders and merely holding a position do not add trading days.
A breach liquidates positions and locks new trades. Daily locks clear on the next
UTC day; total-loss locks require reset. Prices advance on the server while the user has an active session, even if the
display is paused or closed. After server downtime there is no price catch-up.
Commissions and financing are not modeled.

Run `npm test` for backend and trading-engine tests. Browser validation covers
registration/login, orders, saved records, challenge thresholds, reset, logout, and
desktop/mobile layouts. Records are server-controlled but prices are synthetic;
practice passing does not approve real funding. A real qualification program needs
approved market pricing, reviewer tools, and finalized evaluation terms.

Brand assets include `public/logo.svg`, `public/logo-mark.svg`, and the visual
identity presentation in `brand/identity-concept.png`. The SVG assets are a simple
web-ready FA monogram variation; the presentation explores a more detailed mark.
`ACADEMY_PLAYBOOK.md` contains positioning, social copy, operating workflow,
qualification criteria to finalize, and a trader agreement brief.

Profit splits, qualification thresholds, partner firms, account sizes, and launch
dates remain to be finalized. The website is not a live funding platform.

## Completion certificates

`certificates.html` lists all of the authenticated trader's completion certificates.
The server issues one certificate per passed attempt after the 10% realized-profit
and 3-trading-day requirements are met with no open positions. Certificates survive
account resets. They can be previewed, downloaded as SVG, or printed/saved as PDF.
The certificate recognizes synthetic practice only, not professional accreditation
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
Only email confirmation is token-authorized without an existing login.
