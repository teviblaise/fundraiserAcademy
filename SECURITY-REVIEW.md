# Network security review — 25 October 2026

This targeted review covered the application's HTTP server, API authentication
and origin checks, outbound requests, dependency advisories, and deployment
packaging. Safe, anonymous requests checked the public Render preview; adversarial
reproductions ran against isolated local databases and injected transports.
No production accounts, messages, trades, or payouts were created or changed.
This is not a complete penetration test of Render's managed infrastructure.

## Findings and changes

| Finding | Assessment | Result |
| --- | --- | --- |
| Unbounded push devices and routine queue could delay other users' confirmation and password-recovery emails | Medium availability issue, reproduced locally | Limited devices and pending pushes per user; routine pushes expire; account-security emails take priority, including arrivals during a send. Retried pushes reapply the cap. |
| IP rate limits use the socket peer behind a reverse proxy | Medium availability/configuration issue, reproduced with different forwarded clients behind one local proxy | Added strict, opt-in trusted-hop parsing. **Runtime proxy configuration still needs verification on Render.** Default ignores forwarded headers. |
| Several pages and error responses lacked frame/referrer protections; HTTPS responses lacked HSTS | Browser hardening gaps confirmed on the public preview | Applied consistent response protections and HTTPS-origin HSTS. Preserved the private agreement viewer's same-origin iframe. No demonstrated XSS or account takeover was inferred from missing headers alone. |
| Private environment-file variants could be accidentally tracked | Preventive repository protection | Ignore `.env.*` while keeping the blank `.env.example` template. No tracked secret was found. |

Push destinations remain restricted to supported HTTPS push providers. Persisted
subscriptions are validated again immediately before sending. No attacker-controlled
SSRF destination or TLS-verification bypass was identified in the inspected paths.
Market and support integrations use fixed provider destinations; MetaApi uses
validated account IDs and the official read-only adapter.

Both production and full dependency audits found **zero critical, high, or
moderate advisories**. One low advisory,
[GHSA-848j-6mx2-7j84](https://github.com/advisories/GHSA-848j-6mx2-7j84), appears
as five affected package entries through MetaApi's browser crypto dependencies.
The actual unbundled server SDK import did not load those affected modules; no
reachable exploitation path was demonstrated. The advisory remains in the lockfile.
No forced or unsupported dependency upgrade was applied.

## Checks and remaining operator work

- Anonymous private profile, admin connections, contract, and export API requests
  returned 401. Cross-origin preflight did not grant CORS access.
- `.env`, SQLite database, backup-directory, and Git configuration URLs returned
  404. Static paths also have traversal and symlink checks in the server.
- Regression tests exercise quota bypasses, ownership-transfer rollback, retry
  races, delivery prioritization, expired alerts, persisted destinations, and
  trusted-proxy address spoofing and isolation.
- Validation: `npm run check` passed; the complete test suite passed **611/611**.
  An independent local review passed **23 checks**, including native Chromium
  same-origin PDF framing and cross-origin framing rejection using mock content.
- Confirm the real proxy chain and set `TRUST_PROXY_HOPS` only as described in
  `DEPLOYMENT.md`. Restrict direct access to the Node port. Merely publishing code
  does not activate this setting on an existing Render service.
- Keep `COOKIE_SECURE=true` and the exact public HTTPS `APP_ORIGIN`. Resend sender
  configuration is still required for actual confirmation and recovery delivery;
  a priority queue does not configure an email provider.
- The free Render blueprint uses temporary storage. Real financial and personal
  records require persistent storage and separately protected offsite backups.

The review did not authenticate to Render's private control plane, scan shared
hosting ports, perform load/denial-of-service tests against the public service,
or validate MetaTrader provider credentials. TLS termination and host/firewall
configuration remain within the hosting operator's scope. The HTTP-to-HTTPS
redirect check was inconclusive because the execution network closed that request.
