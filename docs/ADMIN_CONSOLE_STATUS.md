# Admin console: status

Written 2026-11-14. Design and reasons: [ADMIN_CONSOLE_PLAN.md](ADMIN_CONSOLE_PLAN.md). This work **stacks on PR #13** (it is built on top of that branch, so merge #13 first).

## What exists and what was checked

| Area | State | Checked how |
| --- | --- | --- |
| Section catalogue, route and page rules, platform roles, health logic (`packages/shared`) | Built | 22 unit tests |
| Migration `031_platform_admin.sql`: `platform_admins`, `platform_sessions`, `platform_impersonations`, `platform_audit` (append-only trigger), `org_entitlements`, suspension columns, tracker-holder lookup, gated usage function | Built | Applied to a throwaway Postgres in tests and in the browser run |
| Staff sign-in on the shared `/auth/login`: uniform failure, mandatory authenticator code, replay-safe codes, recovery codes, lockout, optional network allow-list, forced password change | Built | 53 API tests |
| Staff session rules: idle 30 min, 8 h absolute, one sign-in at a time, step-up 10 min | Built | API tests (expiry, step-up) |
| Central enforcement of sections and suspension in `AuthGuard`, plus API keys and feeds, search, schema, live stream | Built | Tests show a restricted client is refused for reads, writes, keys, search, schema and the live stream, and that a change applies to the same token on its next request |
| Coverage test: every controller route is classified | Built | 5 tests; a new unclassified controller fails the suite |
| Hard limits on vehicles and people | Built | API tests |
| View as client: reason, read-only, hidden permissions, blocked paths, 30 min, per-session path log, client switch, client audit entry | Built | API tests; and once in a real browser (banner showed, token removed from the address bar, End view returned to sign-in) |
| Staff console (Overview, Clients, Client page with Access / Account / People / Staff activity, Staff views, Audit log, Staff accounts, My account) | Built | Typecheck, production build, and a scripted Chromium run against a real API and database (below) |
| Client side: menu hides sections the plan lacks, "not part of your plan" page, "account is paused" state and login message, staff-view banner, Privacy toggle for staff access | Built | Typecheck, build, 5 new web tests, and the browser run |

Full suites on the final code: API 550 passed (one run, tests run one file at a time against a throwaway database), shared 22 in its own file, web 174 passed. `pnpm --filter @routenorth/web typecheck` and the production build pass.

### The browser run (what it did and did not cover)

A scripted Chromium session ran against a freshly migrated and seeded database with the real API and the production web build. It covered: staff sign-in with a computed authenticator code, forced password change, Overview, Clients, creating a client with a recovery code as the step-up, the Access tab, limiting the demo company to Tracking and then signing in as the demo owner (the menu showed only the tracking pages and settings), restoring it, opening a view as the client (banner, read-only), ending the view, and the audit log. I looked at screenshots of these. It did **not** cover: phone-width layouts of the console, dark mode, keyboard-only use or a screen reader, suspend and reinstate in the browser (covered in API tests only), staff-account creation in the browser, the French client product with the new banner and pages, or any browser other than Chromium.

## What is not done, not tested, or a known limit

1. **Merge and numbering.** PRs #11 and #12 may also add migrations. Mine is `031` (028 and 029 exist and 030 is skipped on this branch). If #11 or #12 use 030 or 031, renumber before merging.
2. **No email.** Setting up a client or a staff member shows a one-time link or password on screen to pass on by hand. Nothing is emailed.
3. **Secrets.** The staff authenticator secret is encrypted with `JWT_SECRET`. PR #12 introduces a separate `ENCRYPTION_KEY`; move it there when #12 merges, with a re-encrypt step.
4. **Network allow-list behind a proxy.** The allow-list checks the address Express reports. Behind a load balancer that is the balancer's address until the proxy setting from PR #12 is in. Until then do not rely on the allow-list in production.
5. **Ingest ignores sections.** Trackers keep sending positions for suspended or restricted clients and the data is stored (so reinstating loses nothing). The cost is stored data for clients who are not paying. A "stop ingesting for suspended clients" rule is not built.
6. **Plan limits stay soft.** Only the limits staff set in the console are hard stops.
7. **Staff view and the live map.** The live stream refuses staff view tokens, so a staff view shows last known positions and the map says "Reconnecting".
8. **Staff access default is on.** New clients allow staff views unless their owner switches it off. For government and similarly strict clients, switch it off at onboarding and record that in the contract.
9. **Staff audit is in the same database.** A database owner can drop the append-only trigger. Ship the log to separate storage before real clients. There is no alerting on suspicious staff behaviour (many views, off-hours sign-ins).
10. **No staff session list or "sign everyone out" button** beyond disabling the account or resetting credentials.
11. **Scale.** The client list and Overview compute everything per request over all clients (fine for dozens, not for thousands). Add paging and cached stats before the client count is large.
12. **Tracker claim gap (from PR #13).** The lookup lets staff see who holds an ID and settle a dispute. **Not built:** proof of ownership at claim time, releasing or transferring a claimed tracker, or a dispute workflow. An IMEI is still the only proof today.
13. **Billing.** Plans are labels with limits. Nothing charges anyone, and plan changes do not change sections automatically.
14. **Console is English only**, and the new client-side messages (not part of your plan, account paused, staff-view banner, staff access toggle) are English text, not yet in the translation files.
15. **Session storage of the token.** The console and the product keep the token in browser storage, the same as before; a cross-site scripting bug would expose it. A strict content security policy is not part of this work.
16. **Not certified.** No SOC 2, ISO 27001 or penetration test. Staff security here follows common guidance (ASVS, NIST) but has had no outside review.
17. **gstack.** The repository asks for gstack for AI work. It is not installed in this cloud environment (only one unrelated skill was available), so none of its skills were run. Run its review on this branch on your machine before merging.

## How to try it

```bash
pnpm install && pnpm build
pnpm infra:up && pnpm seed
# first staff account (prints a temporary password, an authenticator key and recovery codes, once)
JWT_SECRET=<same as the API> DATABASE_URL=<superuser url> pnpm --filter @routenorth/api admin:create --email you@company.ca --name "Your Name"
pnpm demo
```

Sign in at `/login` with that email and the temporary password, enter the code from your authenticator app, choose a new password (14+ characters), and you land in the console at `/admin`. Create more staff in Staff accounts; the first one can only be made on the command line.
