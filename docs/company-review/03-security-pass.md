# RouteNorth: manual security pass (report only)

Date: 2026-11-12 | Branch: `claude/project-thread-h7vqx4` | Reviewed code: `e6d6af5` (application code unchanged since `0e6e28c`) | **No application code was changed.**

This is the follow-up to `docs/company-review/02-eng-security-review.md`. It looks at what Phase 2 did not cover, and lists only what is **new**. The Phase 2 findings (ingest fail-open, localStorage token and no CSP, no login throttle, `ENCRYPTION_KEY` fallback, webhook SSRF guard, `erase_organization`, dependency advisories, session revocation) are not repeated; some are already being fixed on a separate branch.

## Tooling status (what was tried first)

| Step | Result |
| --- | --- |
| `/gstack-upgrade` | Already current: gstack 1.99.2.0 equals `origin/main` (0 commits behind, `git fetch` run). Nothing upgraded. |
| `/cso` helper build | **Not possible on this machine.** The helper `gstack-cso-launcher` is missing, and `scripts/build-cso-windows.ps1` needs Visual Studio 2022 Build Tools with the "Desktop development with C++" workload. `vswhere.exe` is absent, so those tools are not installed. As instructed, I did not install them and stopped that path. `/cso` was therefore **not assessed**. |
| This document | A manual pass by one reviewer, static read plus `grep` and small scripts. No specialist agents, no live testing. Treat it as incomplete coverage, not a clean bill of health. |

## What was covered and what was not

Covered: authorization patterns across the API controllers (sampled, see limits), proof and attachment upload and download, the public customer routes, the public invite flow, the password change path, CSV export, web link handling and redirects, GitHub workflow and supply-chain files.

**Limits, stated plainly:**

- The API has 47 guarded controller files and about 800 route handlers. An automated scan for "handler contains a permission check" was **inconclusive**: it flagged 310 handlers, but most use private helper methods (`this.view(req)`, `requirePlanner(req)`, `canSee(...)`) that the scan could not follow, so it was noise. I instead read these handlers in full: `routes/routes.controller.ts` (create, delete), `driver/driver.controller.ts` (scans, proofs, download), `portal/finance.controller.ts` (earnings, expenses), `portal/pay.controller.ts` (approve), `business/team.controller.ts` (invites). All checked ones were correctly protected. **The rest were covered by a second, better scan: see "Continuation" at the end of this document, which supersedes the count of unread handlers.**
- Not read: `apps/web/src/components/ui/chart.tsx` (one `dangerouslySetInnerHTML`), the Samsara request code, PDF generation, email templates, the feeds dataset scope rules, and the report share-link scope enforcement.

## Findings (new only), ranked

### N1. [MEDIUM] (confidence 8/10) Changing your password does not sign out other sessions, and the password rules are weaker than at sign-up

- **Where:** `apps/api/src/me/me.controller.ts:77-87` (`POST /me/password`): checks only `length 10 to 200` (`:80`), verifies the current password, then runs one `UPDATE users SET password_hash` (`:85`). It never touches `user_sessions`. The same length-only rule is used when accepting an invitation (`apps/api/src/business/team.controller.ts`, `accept`, "password must be 10 to 200 characters"). Sign-up and reset use `passwordProblem(...)` from `packages/shared/src/password.ts:21` (common-password, repeated and personal-detail checks) at `auth/account.controller.ts:51` and `:106`.
- **Attacker scenario:** Someone who stole a session token (see Phase 2 finding 2) is not cut off when the victim changes their password. The stolen token stays valid until it expires (default 12 hours) or someone revokes the session by hand. Separately, a user can choose a password like `password12345` through "change password" or an invite, which sign-up would have refused.
- **Counterevidence:** The reset flow does sign out other sessions (documented in `docs/INDUSTRY_READY_STATUS.md:11`), and the current-password check is required. The gap is only this path.
- **Fix:** Call `passwordProblem` in both places; after a successful change, set `revoked_at` on every session of that user except the current `sid`. Add a test that an old token stops working after a password change.
- **Effort:** human ~3 hours / CC ~30 min.

### N2. [MEDIUM] (confidence 8/10) No `trust proxy` setting, so every IP-based control depends on a deployment detail that is not set

- **Where:** a search of `apps/api/src` finds no `trust proxy` configuration (only two `x-forwarded-*` header reads in `platform/feeds.controller.ts:119-120`). IP is used by: public rate limits (`customer/public.controller.ts:41`, key `job:${action}:${req.ip}`; `fleet/live-extras.controller.ts:76`, `limit(req.ip, 90)`), the organization IP allow list (`auth/auth.controller.ts:45`, `ipAllowed(req.ip, ...)`), and the audit log IP (`auth.controller.ts:38`).
- **Attacker or failure scenario:** Behind any reverse proxy or load balancer (which every hosted deployment has), `req.ip` is the proxy's address for every visitor. Then: (a) the public limiters become one shared bucket, so one abuser can lock every customer out of tracking and booking links; (b) an IP allow list cannot work (it either sees only the proxy's address or lets everyone in if the proxy range is listed); (c) audit log IPs are wrong. The opposite mistake, setting `trust proxy` to `true`, lets anyone forge `X-Forwarded-For` and bypass per-IP limits and the allow list.
- **Fix:** Set the Express `trust proxy` value to the exact number of proxy hops (or CIDR ranges) of the chosen host; add tests that a forged `X-Forwarded-For` does not change the limiter key. This depends on the open hosting decision (D6 in the CEO review).
- **Effort:** human ~2 hours / CC ~20 min, once the host is chosen.

### N3. [LOW to MEDIUM] (confidence 6/10) A shared route link exposes every stop on that route

- **Where:** `apps/api/src/fleet/live-extras.controller.ts:70-96` (`PublicTrackController`, `GET /public/track/:token`, route at `:75`). When the link was made for a route, the response includes `stops` for the whole route: name, latitude, longitude, status, ETA, sequence (`live-extras.controller.ts:89`, `SELECT name, lat, lng, status, eta, sequence FROM stops WHERE route_id = $1`), plus the vehicle's live position and a 90-minute trail.
- **Scenario:** A dispatcher shares a route link with one customer; that customer (or anyone the link is forwarded to) sees the other customers' stop names and locations on the route. Personal information under PIPEDA and Quebec Law 25.
- **Counterevidence:** The token is long, stored only as a SHA-256 hash (`resolve_share(sha(token))`, `:78`), links expire (`expires_at`), are revocable, and the endpoint is rate-limited (but see N2). The docs say the page shows no driver name or plate. Whether sharing a whole multi-customer route is an intended use was not confirmed.
- **Fix:** For route shares, return only the stop that belongs to the recipient (or hide names and coordinates of all other stops, showing only the countdown); or restrict route shares to a single-customer job link, which already exists (`customer/public.controller.ts` `job/:token`).
- **Effort:** human ~1 day / CC ~1 hour.

### N4. [LOW] (confidence 7/10) CI and repository hygiene gaps

- **Where:** `.github/workflows/ci.yml` (the only workflow): no top-level `permissions:` block (so the token gets the repository default), third-party actions pinned by mutable tag (`actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4`), no dependency audit step. Also absent: `.github/dependabot.yml` and `.github/CODEOWNERS`.
- **Scenario:** A compromised or retagged action runs with a broader token than needed; nobody is automatically asked to review changes to auth, migrations or CI; known-vulnerable dependencies (see Phase 2 finding 7) are not surfaced until someone runs an audit by hand.
- **Counterevidence:** The workflow triggers on `push` to `main` and `pull_request` only (no `pull_request_target`), uses no repository secrets, installs with `--frozen-lockfile` (`ci.yml:29`), and pins the package manager (`packageManager: pnpm@10.28.0`). So this is hygiene, not an active hole.
- **Fix:** Add `permissions: contents: read` at the top; pin actions by commit SHA; add `dependabot.yml` for npm and GitHub Actions; add `CODEOWNERS` covering `apps/api/src/auth`, `packages/db`, `.github`; add `pnpm audit --prod --audit-level=high` as a step.
- **Effort:** human ~2 hours / CC ~20 min.

### N5. [INFO] (confidence 6/10) Invite creation role list was not fully read

`business/team.controller.ts` checks a whitelist (`INVITE_ROLES`) and requires an owner to invite an `admin`. The contents of `INVITE_ROLES` were not read, so confirm it does not contain `owner` and that a custom role cannot be granted more than the inviter holds.

## Checked and held up

| Control | Evidence |
| --- | --- |
| Routes are protected by a purpose-built permission helper, and writes need the write permission | `routes/routes.controller.ts:36` (`requirePerm(req, "routes.write")`), used by create and delete (`requirePlanner`); finance uses `view`/`write` helpers (`portal/finance.controller.ts:148-153`, `:186`, `:199`) |
| Drivers cannot read other drivers' proofs or scans | `driver/driver.controller.ts:292-298` (`canSee`: a driver only sees their own stops), applied to list, scans and download (`:304`, `:313`, `:327`); scan and upload check ownership (`:226`) |
| Uploads are validated by content, not only by header | Content-type allow-list and 6 MB cap (`configure.ts:7-14`), file signature check (`driver/driver.controller.ts:206`, `:255`; `dispatch/dispatch.controller.ts:373`, `:414`, PDF must start with `%PDF-`) |
| Proofs are served safely | `X-Content-Type-Options: nosniff` and private cache header on download (`driver/driver.controller.ts:323-326`); type limited to the allow-list |
| CSV exports neutralise spreadsheet formulas | `reports/export.ts:10-14` and `audit/audit.controller.ts:8-11` prefix cells starting with `=`, `+`, `-`, `@` |
| Public links are hashed, validated and limited | Token pattern check and SHA-256 lookup (`customer/links.ts:7`, `customer/public.controller.ts:40-48`); per-action rate limit |
| Invitations are single-use and role-limited | Accept runs `UPDATE invites ... WHERE accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()` first, so a double submit cannot make two accounts (`business/team.controller.ts`, `accept`); creating one needs `users.manage`, and only an owner may invite an admin |
| Dash-cam clip links cannot be `javascript:` URLs | Server requires `https://` addresses (`smart/safety.controller.ts:267`) before the UI renders them as links |
| Web links | Every `target="_blank"` link found has `rel="noreferrer"` (or `noopener`); no `next`/`redirect`/`returnTo` parameters found in the web app (no open-redirect source) |
| CI trigger and secrets | No `pull_request_target`, no secrets in the workflow, frozen lockfile |
| Unguarded controllers are the intended public ones | Mixed files hold public controllers on purpose: `PublicTrackController`, `PublicFeedbackController` (`fleet/live-extras.controller.ts:70`, `:100`), `PublicInviteController` (`team.controller.ts:173`), `feeds.controller.ts` (key check at `:21-23`) |

## Suggested order

1. N1 with Phase 2 finding 8 (session revocation): one change touching sessions and passwords.
2. N2 as soon as the host is chosen, since the right value depends on it, and before any customer relies on the IP allow list or public-page limits.
3. N4: small, safe, no application code.
4. N3: decide whether route-level share links are a supported feature, then restrict.
5. Re-run `/cso` after the Windows build tools are installed (or in CI on a Linux runner) for the scanner-backed pass, and extend this manual pass over the unread ~790 handlers.

## Verification limits

Static only; nothing was exploited or run against a live service. Counts come from `grep` and a text-splitting script, so they are approximate. Severity ratings are the reviewer's and depend on the undecided hosting setup (N2) and on how share links are used (N3).

---

## Continuation (same day): handler coverage closed, one more finding

**Handler coverage.** The first scan was too noisy. A better scan follows one-line helper methods (`private manage(req) { return requireAny(...) }`) and module-level helpers (`requirePlanner`). Result: **541 route handlers** in the 47 guarded controller files; **39 had no recognised permission check**. I read those, and all are acceptable: the payout state changes go through `move()` with the `payouts.approve` permission for approval, a second-person rule (`assertSecondPerson`) and a fixed list of allowed status transitions (`portal/payouts.controller.ts:343-352`); alert actions go through `act()` with `alerts.manage` and a visibility filter (`portal/alerts.controller.ts:446-451`); vehicle archive and restore go through `setArchived()` with the write permission (`portal/vehicles.controller.ts:176-177`); the rest are personal settings, notification counters, a static checklist, usage counters, the public invite and public tracking routes (covered above). This corrects the earlier "about 790 handlers unread" statement: every handler now has a recognised check or is self-service or public by design. **That does not prove each check names the right permission or the right scope.** I read the role matrix (`packages/shared/src/permissions.ts:31-48`): it is a sensible least-privilege set (a driver holds only `driver.app`, a customer only `customer.portal`, a viewer read-only).

### N6. [MEDIUM to HIGH] (confidence 9/10 for the behaviour; impact depends on how far an organization trusts its admins) An admin can give themselves, or anyone, every permission the admin role is deliberately denied

- **Where:** `apps/api/src/roles/roles.controller.ts:39-62` (`POST /roles` and `PUT /roles/:id`, guarded only by `roles.manage`; `parseRoleBody` at `:8-14` checks that each permission is a *valid name*, not that the caller holds it); `apps/api/src/users/users.controller.ts:97` (`customRoleId` can be set on any non-owner user with only `users.manage`); `packages/shared/src/permissions.ts:55-58` (`effectivePermissions`: a custom role **replaces** the built-in role's permissions entirely).
- **Why it matters:** the `admin` role holds `roles.manage` and `users.manage` but is intentionally denied `billing.manage`, `drivers.sensitive` (driver bank and tax details), `payouts.approve` and `finance.manage` (`permissions.ts:33`). An admin can create a custom role containing all four, then assign it to themselves: the self-protection rule at `users.controller.ts:84-86` blocks changing your own built-in `role` or disabling yourself, but not setting your own `custom_role_id`.
- **Attacker scenario:** a disgruntled or compromised admin (or a stolen admin session, see Phase 2 finding 2) creates "Super admin" with every permission, assigns it to their own user (or a colluding account), then approves payouts prepared by someone else, reads driver bank details and edits finance data. The payout second-person rule (`assertSecondPerson`) still applies, so they need a second account, which a custom role on a second user supplies.
- **Counterevidence:** owners are protected (`users.controller.ts:85`), only owners can make admins, role changes are audited by the generic audit log, and this needs an already-privileged insider. It defeats the separation of duties the product describes; it does not let an outsider in.
- **Fix:** in create and update of a custom role, and when assigning one, require that the caller (unless an owner) already holds every permission in it; treat `billing.manage`, `drivers.sensitive`, `payouts.approve` and `finance.manage` as owner-only to grant; refuse a user changing their own `customRoleId`; add tests for each of those three.
- **Effort:** human ~3 hours / CC ~30 min.

Suggested placement in the order of work: N6 with N1, in the same change as the Phase 2 session-revocation fix, since both are "who can do what" rules in the API.
