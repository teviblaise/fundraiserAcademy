# Live server deployment

## Temporary Render preview

Connect GitHub to Render, choose **New → Blueprint**, select this repository,
and select the `preview/fundraiser-academy` branch. Render reads `render.yaml`
and creates a free Node.js web service. Alternatively, create a Web Service
from that branch with build command `npm ci --include=dev && npm run build`,
start command `npm run start:prod`, and environment variables `NODE_VERSION=24.19.0`
and `COOKIE_SECURE=true`.

After Render assigns the HTTPS URL, set `APP_ORIGIN` to that exact URL without
a trailing slash if using a custom domain. The server automatically uses
Render's `RENDER_EXTERNAL_URL` for its default public origin. Registration, simulated
trading, certificates, and popup notifications can be tried without email keys.
Email requires a verified Resend sender and securely configured provider settings.

Crypto reference execution and daily forex history need no API keys: allow outbound HTTPS to
`api.exchange.coinbase.com` and `api.frankfurter.dev`. Intraday forex execution
requires `TWELVE_DATA_API_KEY`, configured securely in Render's Environment settings,
and access to `api.twelvedata.com`. Daily ECB references cannot fill forex trades.
All ten forex pairs need provider-plan coverage. Yen crosses additionally fetch
USD/JPY and EUR/GBP fetches GBP/USD to convert account values into USD; include
that traffic when choosing a quote allowance. Conversion outages pause fills.
TradingView charts load in
the visitor's browser and require its script/iframe domains to be accessible.
After deployment, check a crypto reference quote/candles and a forex daily quote
and chart; confirm source times and that source failures are visibly marked.
Challenge fills, stops, limits, P&L, and price alerts use fresh server-verified
reference prices. No generated feed or added spread is used. Missing, stale, or
closed-market quotes pause execution; never enable a fallback for challenge fills.

The Blueprint explicitly deploys `preview/fundraiser-academy` and checks
`/healthz` before routing requests to the service. Render supplies the `PORT`;
the server listens on that port on all interfaces. The build installs the locked
dependencies and compiles Tailwind, and the runtime starts the Node.js backend.

This free preview uses temporary storage: accounts, certificates, and push keys
can disappear on restarts or redeploys. Free services may sleep when idle. Use
disposable test accounts. For lasting records, use a paid service with a persistent
disk and set `DATABASE_PATH` to a file on that disk. Delete the service in Render
when the preview is no longer needed.

The laptop ZIP is in `downloads/fundraiserAcademy-laptop.zip`; it includes the
website and backend but excludes user databases and credentials.

The agreement page is ready, but no contract has been supplied. When the company
provides it, publish the PDF or UTF-8 text privately using the command in README.md.
For services without an interactive shell, set `CONTRACT_FILE` to a private file
included in the deployment, plus `CONTRACT_VERSION` and optional `CONTRACT_TITLE`.
Keep personal completed contracts out of Git and out of `public/`. Free preview
storage cannot preserve signatures reliably; use a persistent disk for real signing.

This app needs a Node.js backend. Static hosting and the VS Code Live Server
extension cannot run registration, saved trading records, certificates, or delivery.
Use Node.js 24+ on a persistent server or a Docker-capable hosting service.

## Deploy with Node.js

Extract the release package into a private application directory, then run:

```sh
npm ci --include=dev
npm run build
npm prune --omit=dev
npm run start:prod
```

Use a process manager to restart the app after server reboots. Expose it through
an HTTPS reverse proxy; the Node server defaults to port 3000. Do not expose the
data directory as web content. Supply secrets using the host's environment settings.

## Deploy with Docker

```sh
docker build -t fundraiser-academy .
docker volume create fundraiser-academy-data
docker run -d --name fundraiser-academy --restart unless-stopped \
  -p 127.0.0.1:3000:3000 \
  --env-file /secure/path/fundraiser-academy.env \
  --mount source=fundraiser-academy-data,target=/app/data \
  fundraiser-academy
```

Create that environment file privately, with permissions restricted to the operator.
Use the fields in `.env.example` as a reference. Never commit real credentials.
Place an HTTPS reverse proxy in front of port 3000 and configure your actual domain.
The image runs as an unprivileged user. For a host bind mount instead of a named
volume, ensure the data directory is writable by container UID 1000.

## Required production settings

- `APP_ORIGIN`: the exact public HTTPS origin, with no trailing slash/path.
- `COOKIE_SECURE=true`: session cookies must use HTTPS.
- `DATABASE_PATH`: a file on persistent storage, not a temporary build directory.
- `RESEND_API_KEY` and `EMAIL_FROM`: required for opted-in verified email delivery.

Preserve both the SQLite database and `vapid.json` in its directory. Replacing the
VAPID key pair invalidates existing browser push subscriptions. Back up SQLite
using a SQLite-aware process and restrict access to database and backup files.

## Verify after deployment

Visit registration, create a disposable test account, and confirm the dashboard
opens. Test login/logout, a simulated trade, price alert, and popup. Confirm records
persist across a server restart. My certificates should be accessible only after
login. Use the automated tests to verify certificate rules without forging a live
candidate result. Test a real email confirmation and an opted-in push notification
with the browser page closed on a supported device.

Email and push delivery require network access to `api.resend.com`,
`fcm.googleapis.com`, `*.push.services.mozilla.com`, and `web.push.apple.com`.
Browsers may block notifications or restrict background delivery. Check the dashboard
queue status and provider logs without exposing API keys or subscription URLs.

## Release contents and limitations

The release archive includes source, compiled CSS, lockfile, tests, brand assets,
and deployment instructions. It excludes live databases, VAPID private keys,
credentials, Git metadata, and installed dependencies. Deploying this archive
starts with no users; migrating existing records requires a separate protected
database/key backup and restore.

Email verification for notifications is implemented. Account recovery, reviewer
administration, complete privacy/retention policies, and funding operations remain
unfinished; review README.md and ACADEMY_PLAYBOOK.md before public enrollment.
