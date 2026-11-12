# RouteNorth: engineering and security review (gstack `/review`, whole codebase)

Date: 2026-11-12 | Branch: `claude/project-thread-h7vqx4` | Code reviewed at: `64809f4` (same application code as `0e6e28c`) | Report only, **no application code changed**

## What this is, and what it is not

`/review` is built to read a branch diff, run specialist reviewers and an adversarial reviewer, and apply fixes. This run was asked to be a **whole-codebase, report-only** review, so it was adapted:

- No fixes were applied.
- **The specialist and adversarial reviewer agents were not dispatched.** This session was not asked to start them. Everything below is one reviewer's static read plus a few commands. The skill's own completion contract for `/review` is therefore **not met**, and this report should be treated as INCOMPLETE under that contract. It is still a real read of the code named in each finding.
- Evidence kinds: static read of source (with file:line), `grep`/`ls` counts, a script over the SQL migrations, and `pnpm audit --prod` run on this machine on 2026-11-12. **Nothing was exploited or run against a live service.**
- `/cso` was named as unavailable in the brief; it appears in this session's skill list, so it can be tried in the next phase.

Finding format: `[SEVERITY] (confidence N/10) file:line, problem`. Confidence 5 to 6 means "could be a false positive, verify".

## Scope covered and not covered

Read in full or in the relevant part: `apps/ingest/src/server.ts`, `feed.ts`; `apps/api/src/main.ts`, `configure.ts`, `auth/auth.guard.ts`, `auth/jwt.ts`, `auth/auth.controller.ts`, `live/live.gateway.ts`, `notify/notifier.ts`, `passwords.ts`; `packages/db/src/index.ts`, `secrets.ts`; all 28 SQL migrations (by script) for row-level security and function grants; `apps/web/src/lib/session.ts`, `next.config.mjs`; `packages/shared/src/connectors.ts`.

**Not reviewed:** per-endpoint authorization and object-reference checks in the other 47 guarded controllers, the public customer endpoints (15 routes in `customer/public.controller.ts`) beyond a token-entropy grep, upload handling, the driver PWA, most of the web app for XSS sinks (only `dangerouslySetInnerHTML` was grepped: 2 uses, `layout.tsx:23` a static theme script and `components/ui/chart.tsx:94`, not read in detail), and the Geotab and Samsara request code paths. A clean result in those areas must not be inferred.

## Summary

| # | Severity | Finding | Fix effort (human / CC) |
| --- | --- | --- | --- |
| 1 | HIGH | Ingest accepts unauthenticated fixes and metrics when `INGEST_TOKEN` is unset | S / S |
| 2 | HIGH | Session token in `localStorage`, with no CSP or security headers on web or API | M / M |
| 3 | HIGH | No throttle on password login (only the 2FA step has a lockout) | S to M / S |
| 4 | HIGH | One secret does three jobs: `ENCRYPTION_KEY` silently falls back to `JWT_SECRET`, and the ingest service is handed `JWT_SECRET` | S / S |
| 5 | MEDIUM | Webhook SSRF guard checks hostnames only, follows redirects, misses some address forms | M / M |
| 6 | MEDIUM | `erase_organization(uuid)` can be called by the app role for any organization | S / S |
| 7 | MEDIUM | Dependency advisories: 1 critical, 3 high, 2 moderate (reachability low for most) | S / S |
| 8 | MEDIUM | Revoked sessions: tokens without `sid` skip revocation; WebSocket never checks it | S to M / S |
| 9 | LOW | Secrets passed in URL query strings (`?token=`, `?key=`, WebSocket `?token=`) | S / S |
| 10 | LOW | Rate limits and lockout counters live in process memory | M / S |
| 11 | LOW | Authentication is opt-in per controller (47 of 51), not default-deny | M / S |
| 12 | INFO | Defaults a production deploy could inherit (seed password, compose password, localhost CORS) | S / S |

Positive results (verified, listed at the end) matter as much as the findings: the tenant isolation design is sound.

## Findings, ranked

### 1. [HIGH] (confidence 9/10) Ingest fails open without `INGEST_TOKEN`

- **Where:** `apps/ingest/src/server.ts:24` (`if (!token) return true;`), used by `/ingest/traccar` (`:97-104`) and `/metrics` (`:59-60`); startup only prints a warning at `:156`.
- **What happens:** If `INGEST_TOKEN` is missing from the production environment (one forgotten variable), anyone who can reach the service can POST fixes to `/ingest/traccar` for any registered tracker ID and read `/metrics`. The service starts normally and says nothing a customer or operator would notice. Fake positions would appear on a customer's live map and in history, trip reports and driver-hours estimates.
- **What limits it:** The per-company feed endpoints (`/ingest/feed`, `/ingest/feed/traccar`) are separate and key-authenticated (`:66-95`, `feed.ts:30-41`); the JSON batch endpoint is already off without a token (`:109`). So the open surface is the Traccar-forward path plus metrics. A fix still has to name a registered device ID (the IMEIs are not secret).
- **Fix:** Refuse to start when `NODE_ENV=production` (or whenever not in an explicit `INGEST_ALLOW_OPEN=1` dev mode) and `INGEST_TOKEN` is empty; require the token on `/metrics`; add a unit test that the process exits (or `authorized()` returns false) without a token in production mode. Move Traccar to the per-company key path and retire the shared-token route later.
- **Effort:** human ~1 hour / CC ~15 min, plus the test.

### 2. [HIGH] (confidence 9/10) Session token in `localStorage`, no CSP, no security headers

- **Where:** `apps/web/src/lib/session.ts:16` (`localStorage.getItem`) and `:25` (`setItem`); `apps/web/next.config.mjs:2-5` has no `headers()`; the API has no `helmet` (no match in `apps/api/package.json` or source); `apps/api/src/main.ts:38` only enables CORS.
- **What happens:** Any script that runs on the web origin can read the bearer token and call the API as that person for up to 12 hours (`jwt.ts:13`). With no Content-Security-Policy there is no second line of defence. The app holds GPS history of named drivers, so a stolen owner token is a privacy incident under PIPEDA and Quebec Law 25, not only a security one. No XSS sink was found in the small sample read (see scope), which lowers likelihood, not impact.
- **Fix:** Issue the session as an `HttpOnly; Secure; SameSite=Lax` cookie from the API (or a thin same-origin proxy); keep CORS credentials off cross-site origins; add a strict CSP, `X-Content-Type-Options`, `Referrer-Policy` and frame protection through `next.config.mjs` `headers()`, and `helmet` on the API; replace the WebSocket `?token=` with a short-lived single-use ticket (see finding 9). Moving to cookies introduces CSRF exposure, so add SameSite and a CSRF token on state-changing routes in the same change.
- **Effort:** human ~2 to 3 days / CC ~2 to 3 hours (touches login, logout, WebSocket and every fetch in the web app).

### 3. [HIGH] (confidence 8/10) No throttle on password login

- **Where:** `apps/api/src/auth/auth.controller.ts:26-48`. The only lockout is for the 2FA code (`:62-63`, `this.fails`, 5 tries; the map is set at `:83`). A repo grep for rate limits found limiters only on public customer endpoints, reports and feeds.
- **What happens:** Unlimited password guesses per account and per IP, so credential stuffing is open. Each attempt also costs a scrypt derivation (`passwords.ts:5-8`, `:23`), so an unauthenticated flood is a CPU denial of service. The dummy hash keeps timing uniform (good), but it also means unknown emails cost the same as real ones.
- **What limits it:** Failed attempts for real users are audited (`:38`), scrypt is slow per guess, and 2FA is available and can be required org-wide.
- **Fix:** Throttle by email and by IP with exponential back-off (counters in Redis so they survive restarts and more than one instance, see finding 10); return the same 401 for locked and wrong; alert on bursts of `auth.login.failed`. Add a test for the 6th rapid failure.
- **Effort:** human ~1 to 2 days / CC ~1 hour.

### 4. [HIGH] (confidence 9/10) One secret, three jobs, silent fallback

- **Where:** `packages/db/src/secrets.ts:6` (`process.env.ENCRYPTION_KEY || secret`, where `secret` is `JWT_SECRET`); `apps/api/src/main.ts:23` (JWT secret length is the only check); `apps/ingest/src/server.ts:137` (ingest reads `JWT_SECRET` to decrypt saved provider logins).
- **What happens:** `JWT_SECRET` signs every session, can forge a session for any known user and organization id (`jwt.ts:13-20`), and, unless `ENCRYPTION_KEY` is set, also decrypts the 2FA seeds and the stored Geotab and Samsara credentials. The ingest service, which faces trackers and the internet, is given that same secret to run the connectors. One leak of ingest's environment therefore yields both forged sessions and every stored provider login. `ENCRYPTION_KEY` is only advised in docs (`docs/OPERATIONS.md:10`), never required.
- **Related gaps:** the ciphertext format has no key id (`v1.<iv>.<tag>.<body>`, `secrets.ts:12`), so the key cannot be rotated without a flag day; losing the key also loses the stored Geotab and Samsara logins, which `docs/OPERATIONS.md:10` does not mention (it only mentions 2FA). The key is a plain SHA-256 of the secret with no KDF; acceptable for a long random value, weak for a short one (the only length rule is 32 characters, `main.ts:23`).
- **Fix:** Require `ENCRYPTION_KEY` in production and refuse to start if it is missing or equal to `JWT_SECRET`; give ingest only `ENCRYPTION_KEY`, never `JWT_SECRET`; add a key id to the ciphertext (`v2.<kid>...`) and a re-encrypt script for rotation; document that provider logins are lost with the key; store both secrets in the host's secret manager.
- **Effort:** human ~1 day / CC ~45 min.

### 5. [MEDIUM] (confidence 8/10) Webhook SSRF guard is hostname-only

- **Where:** `apps/api/src/notify/notifier.ts:37-41` (`PRIVATE` regex and `isSafeWebhookUrl`), used by `checkTarget` (`:42-50`); delivery at `apps/api/src/automation/processor.ts:177` and `notifier.ts:61-67`.
- **What happens:** Customers set webhook addresses and the server POSTs to them. The check tests the typed hostname against a list; it does not resolve DNS, and no `redirect` option is set anywhere in the delivery code (grep found none), so `fetch` follows redirects. A public https address that redirects (or resolves) to an internal address passes. The list also has no entry for IPv4-mapped IPv6 such as `[::ffff:7f00:1]` or the carrier-grade range `100.64.0.0/10`.
- **Impact:** The attacker controls where the POST goes but not most of the body (a signed JSON event). It is a blind SSRF against whatever the hosting network exposes (metadata services, internal admin ports). Medium until a host is chosen; re-rate once the deployment network is known.
- **Fix:** Resolve the hostname and reject private, loopback, link-local, CGNAT and mapped addresses at connect time (a custom `undici` dispatcher or lookup hook); set `redirect: "error"`; keep the https-only and no-credentials rules; add tests for each bypass string above.
- **Effort:** human ~1 day / CC ~1 hour.

### 6. [MEDIUM] (confidence 8/10) `erase_organization` is callable for any tenant by the app role

- **Where:** `packages/db/migrations/017_security_quality.sql:115-121` (`SECURITY DEFINER`, no check of `p_org` against `app.org_id`) and `:138` (`GRANT EXECUTE ... TO routenorth_app`); caller `apps/api/src/security/security.controller.ts:237`.
- **What happens:** The function also sets `routenorth.audit_purge`, which is the one switch that lets the append-only audit log be deleted. Any SQL injection or logic bug in the API (which runs as the app role) could erase any customer, including its audit trail, in one statement. Today the API caller is owner-only with password confirmation, per the docs, and 0 interpolated SQL strings were found (see positives), so this is defence in depth, not a live exploit.
- **Same pattern, lower risk:** `all_org_ids()` (`010_dispatch.sql:40-43`) lets the app role list every organization id; needed by the scheduler, but worth knowing.
- **Fix:** In the function body, raise unless `p_org = current_setting('app.org_id', true)::uuid`, or call it through the admin connection (`ADMIN_DATABASE_URL`) and revoke the app-role grant. Add a tenant-isolation test that org A cannot erase org B.
- **Effort:** human ~2 hours / CC ~20 min.

### 7. [MEDIUM] (confidence 9/10 that the advisories exist; reachability low) Dependency advisories

`pnpm audit --prod` (run today, 6 found: 1 critical, 3 high, 2 moderate):

| Package | Severity | Advisory | Path | Reachable here? |
| --- | --- | --- | --- | --- |
| `maplibre-gl` ≤6.4.0 (fix ≥6.4.1) | CRITICAL | GHSA-jrc7-96c5-q579, XSS sanitizer bypass | `apps/web` direct | Probably not: no `setHTML` or `Popup(` use in `apps/web/src` (grep). Upgrade anyway: it is a direct dependency. |
| `multer` 2.0.0 to <2.5.0 (fix ≥2.5.0) | HIGH | GHSA-q7qp-rjg7-q26m, DoS | `@nestjs/platform-express` | Probably not: no `FileInterceptor` use in `apps/api/src`; uploads use `express.raw` (`configure.ts:14`). |
| `postcss` ≤8.5.17 and ≤8.5.11 (fix ≥8.5.18 / 8.5.12) | HIGH x2 | GHSA-r28c-9q8g-f849, GHSA-6g55-p6wh-862q, source-map file read | `apps/web > next` | Build-time CSS processing; low runtime exposure. |
| `postcss` ≤8.5.22 and <8.5.10 | MODERATE x2 | GHSA-fxqj-rqcc-2cmp, GHSA-qx2v-qp2m-jg93 | `apps/web > next` | Same. |

- **Fix:** bump `maplibre-gl` to ≥6.4.1; update `next` and `@nestjs/platform-express` or add `pnpm.overrides` for `postcss` ≥8.5.23 and `multer` ≥2.5.0; add `pnpm audit --prod --audit-level=high` to `.github/workflows/ci.yml` so this stays visible. Dev-only advisories were not checked (`--prod`).
- **Effort:** human ~2 hours / CC ~20 min (plus a build and test run to confirm nothing broke).

### 8. [MEDIUM] (confidence 7/10) Revocation gaps in sessions and the live stream

- **Where:** `apps/api/src/auth/auth.guard.ts:54` (`if (session.sid && user.sid_ok !== true)`): a token with no `sid` is never checked against revoked sessions (`jwt.ts` comment: "Older tokens have none"). `apps/api/src/live/live.gateway.ts:26-40` checks the token and disabled state once at connect and never checks `sid`; the socket then stays open until it closes.
- **What happens:** "Sign out everywhere" or removing a person's session does not cut an existing live-map socket, or any sid-less token, until it expires (12 hours, `jwt.ts:13`; the org can shorten this with `sessionHours`).
- **Fix:** Require `sid` on every token after one release (reject sid-less); verify `sid` in the WebSocket handshake and re-check on a timer or on a revoke event; close sockets when a session is revoked. Test: revoke, then confirm the socket closes within one interval.
- **Effort:** human ~1 day / CC ~1 hour.

### 9. [LOW] (confidence 8/10) Secrets in query strings

- **Where:** ingest shared token `server.ts:25` (`?token=`, and `docs/GO_LIVE.md:39` tells operators to configure Traccar with it); feed keys `feed.ts:17-21` (`?key=`); WebSocket `live.gateway.ts:26` (`?token=<jwt>`).
- **What happens:** URLs are written to proxy, load-balancer and access logs and may appear in referrers. A logged feed key lets someone push fake positions for that company until revoked (keys can be revoked; the 30-second key cache is in `feed.ts`).
- **Fix:** Prefer `Authorization` headers; where Traccar cannot set one, keep the per-company key (revocable, one company) instead of the global ingest token; redact `token` and `key` parameters in the access-log configuration of whichever host is chosen; use a WebSocket ticket (finding 2).
- **Effort:** human ~2 hours / CC ~20 min plus host log configuration.

### 10. [LOW] (confidence 8/10) Throttling state is in process memory

- **Where:** `apps/ingest/src/feed.ts:38-46` (per-key limit, comment says "In memory, per ingest process"); `auth.controller.ts:63` (`this.fails`); limiters in `customer/public.controller.ts:23`, `fleet/live-extras.controller.ts:66`, `reports/reports.controller.ts:22`.
- **What happens:** Limits reset on every restart and multiply with each instance. Fine for one process, wrong once hosting runs two or more.
- **Fix:** Move counters to Redis (already a dependency) behind one small helper.
- **Effort:** human ~1 day / CC ~1 hour.

### 11. [LOW] (confidence 8/10) Authentication is opt-in per controller

- **Where:** 47 of 51 controller files carry `@UseGuards(AuthGuard)` at class level; there is no global `APP_GUARD`. The 4 without it are expected: `auth/account.controller.ts`, `auth/auth.controller.ts`, `customer/public.controller.ts` (15 routes), `platform/feeds.controller.ts` (own key check at `:21-23`).
- **What happens:** A new controller that forgets the decorator is silently public. No such controller exists today; this is a trap for the future.
- **Fix:** Register `AuthGuard` as a global guard and mark the public controllers with a `@Public()` decorator; add a test that lists every route and fails when an unmarked route answers 200 without a token.
- **Effort:** human ~1 day / CC ~1 hour.

### 12. [INFO] (confidence 6/10) Defaults a production deploy could inherit

- `packages/db/src/seed.ts:12-16` defaults the demo password to `routenorth-demo` and the app role password to `routenorth_app`; no `production` guard was found in the file. `docker-compose.yml:7` sets `POSTGRES_PASSWORD: routenorth`. `apps/api/src/main.ts:38` allows `http://localhost:3000` and `http://127.0.0.1:3000` when `WEB_ORIGIN` is unset. All are fine for local development; the risk is a pipeline that runs `pnpm seed` against a real database.
- **Fix:** Make `pnpm seed` refuse `NODE_ENV=production` unless a flag is passed; require `WEB_ORIGIN` in production; document that compose is development-only.
- **Effort:** human ~1 hour / CC ~15 min.

## Engineering quality notes (not defects)

- **Test coverage of the security rules is thin where the risk is:** `packages/db/src/tenant-isolation.test.ts` exists and proves isolation; nothing was found that tests ingest in production mode, the SSRF bypass strings, login throttling or session revocation. Each finding above lists the test to add.
- **One long request handler:** `apps/ingest/src/server.ts` routes, authenticates and processes in one callback of about 100 lines, with the three ingest paths repeating the same read, normalize, store, after-ingest steps. Not a bug; extract a small route table when finding 1 is fixed. Batch size is capped at 500 positions (`generic.ts:13`, `:20`), which is a good control.
- **Hotspot files:** `apps/api/src/app.module.ts` (32 edits in 30 days) registers every feature; with 31 API folders it will keep conflicting. Unchanged from the CEO review.

## What was checked and held up (positive results)

| Control | Evidence |
| --- | --- |
| Row-level security everywhere it matters | Script over all migrations: 127 tables created, 126 with `ENABLE ROW LEVEL SECURITY`; 29 `FORCE ROW LEVEL SECURITY` statements, many covering arrays of tables. The one table without it, `ingest_unknown` (`025_telemetry.sql:71`), holds only global counts by day and source, no tenant data. [measured, regex-based; run `\d+`/`pg_class.relrowsecurity` on a real database to confirm] |
| Tenant scoping mechanism | `withOrg` sets `app.org_id` per transaction with `set_config(..., true)` and rolls back on error (`packages/db/src/index.ts:44-64`) |
| Security-definer functions are narrow and locked down | Each is `SET search_path = public` and `REVOKE ALL ... FROM PUBLIC` then granted to the app role (for example `find_login`, `find_api_key`, `resolve_device`), see `003`, `004`, `015`, `026` |
| SQL injection | 0 matches for `.query(` calls with `${}` template interpolation in `apps` and `packages` (excluding tests and build output) [measured] |
| Token verification | HS256 pinned (`jwt.ts:25`, `:40`); expiry required; 2FA challenge tokens cannot be used as sessions (`:26`) |
| Authorization data is fresh | Role, disabled state and custom role come from the database on every request (`auth.guard.ts:38-53`), so role changes apply at once |
| Password handling | scrypt with random salt, constant-time compare, dummy hash for unknown emails (`passwords.ts:5-25`, `auth.controller.ts:28-38`) |
| Secret storage | AES-256-GCM with random IV and auth tag (`secrets.ts:8-14`); API and feed keys stored as SHA-256 hashes and compared in the database (`feed.ts:9`, `auth.guard.ts:71`) |
| API keys cannot become owners | `auth.guard.ts:73` maps scope to `dispatcher` or `viewer` only |
| Geotab server allow-list | `^([a-z0-9-]+\.)*geotab\.com$` is anchored; `evilgeotab.com` and `my.geotab.com.evil.com` do not match (`packages/shared/src/connectors.ts:53`); the server named in the login reply is checked the same way (`:95`) |
| No committed secrets | `git ls-files` finds no `.env` or key files (the two hits are source files named `secrets.ts`); no hard-coded 16+ character secret literals in source [grep] |
| Reset links not logged in production | `account.controller.ts:95` logs only when `NODE_ENV !== "production"` |
| Webhook signing | HMAC signature with timestamp on every delivery (`processor.ts:177`) |
| Ingest input limits | 64 KB and 1 MB body caps with 413 (`server.ts:72-110`), 500-position batch cap, per-key rate limit of 600 per minute (`feed.ts:41`) |

## Suggested order of work (next phase, still needs your go-ahead)

1. Findings 1, 4, 6 and 12 together: one small PR of startup checks and one migration. About half a day with Claude. Highest risk reduction per hour.
2. Finding 3 (login throttle) and finding 7 (dependency bumps plus CI audit step). Same day.
3. Finding 2 (cookie session, CSP, headers, WebSocket ticket) with finding 8 (revocation). One focused change, plus a browser pass.
4. Finding 5 (SSRF) once the hosting network is chosen, so the allowed ranges can be set for it.
5. Findings 9, 10, 11 with the move to a hosted, multi-instance deployment.

Then re-run `/review` on that diff (a real diff review with specialists), and `/cso` or a third-party test before any real customer data.

## Verification limits

- Static only. No finding was reproduced on a running service.
- `pnpm audit` reads the public advisory database at run time; re-run before acting.
- The RLS count comes from a regex over migration text. It would miss a table created dynamically or an `ENABLE` that was later reverted.
- The 4 unguarded controllers were identified by file, not by every route.
- Severity ratings are the reviewer's. Likelihood for findings 2, 3 and 5 depends on where and how the service is hosted, which is not yet decided.
