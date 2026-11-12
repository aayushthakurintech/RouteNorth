# RouteNorth: CEO review (gstack `/plan-ceo-review`)

Date: 2026-11-12 | Branch: `claude/project-thread-h7vqx4` | Commit reviewed: `0e6e28c` | gstack 1.99.2.0
Mode: **HOLD SCOPE** | Depth: strategy-only (capability level, no implementation contracts)
Evidence kinds used: static read of repo and docs, `grep`/`ls` on the checkout, two standard web searches (vendor blogs and trade press, so treat market numbers as rough). **Nothing was run against real hardware, real providers or a real host.** No application code was changed.

## How this review was run

Aayush asked for gstack's agents to be used as a "company environment" that takes RouteNorth from a working demo to company-ready, phase by phase. This is Phase 1: the CEO/founder view of the whole product. Questions gstack would normally put to the founder were answered from the repo docs plus the direction supplied for this phase:

- Software only. Customers keep their GPS hardware and their provider (bring your own GPS).
- Canadian-hosted, English and French, trucks and buses.
- Integrate certified ELD providers. Do not build an ELD.
- No hosting chosen. Vercel is paused.
- No application code changes in this phase.

Mode choice: the repo is a built product, not a new idea, and this review plans one doc file. By the mode rules that is HOLD SCOPE: keep what exists, find what blocks a real company, rank the work. The sharpest finding below (stop building features, go find customers) is a scope reduction in spirit, but it is recorded as a recommendation for Aayush, not applied.

Outside voice: **unavailable**. Codex CLI is not installed on this machine, and the native fallback needs a background reviewer agent that this session was not asked to start. No second-model opinion exists for this review. Treat the findings as one reviewer's view.

## Pre-review system audit

| Check | Result | Receipt |
| --- | --- | --- |
| Size of the branch vs `main` | 576 files, 75,614 insertions | `git diff main --stat` [measured] |
| Test files | 80 `*.test.ts` files; docs claim API 475, ingest 31, shared 274, web 169 tests passing | `find apps packages -name "*.test.ts"` [measured]; test counts from `docs/NEXT_PLAN_STATUS.md:29` and `docs/INDUSTRY_READY_STATUS.md:18` [claimed, not re-run] |
| Playbook status | 234 done, 69 partly built, 15 need outside accounts or hardware, 2 not built by choice, 0 not started | `docs/FEATURE_PLAYBOOK_STATUS.md:5-13` |
| TODO/FIXME debt | None in source (only `pnpm-lock.yaml` matches) | `grep` audit |
| `TODOS.md` | Does not exist | `ls TODOS.md` |
| Design doc from `/office-hours` | None found | `gstack-design-doc-find` |
| Stashes | None | `git stash list` |
| Unstaged change | `scripts/dev.mjs` (left untouched, per instruction) | `git status` |
| CI | One workflow (`.github/workflows/ci.yml`) with Postgres 16 service | file read |
| Deploy artifacts | No Dockerfiles for any app; only `apps/web/vercel.json` and `infra/` (db, traccar) | `ls apps/*/Dockerfile infra` |
| Most-churned files (30 days) | `apps/api/src/app.module.ts` (32 edits), `packages/shared/src/index.ts` (21), `apps/web/src/app/ui.css` (15) | `git log --name-only` [measured] |
| Brain/learnings | No prior learnings, brain unreachable | `gstack-learnings-search`, `gstack-brain-cache` |

Retrospective check: the last 30 commits are all feature or polish passes (playbook phases, owner portal, landing, auth, connectors). No review refactors or reverts. One test fix for a daylight-saving date bug (`21388a9`), which is a sign of tests written against wall-clock time. No recurring architectural problem yet, but `app.module.ts` touched 32 times says every feature adds a module to one file.

## Step 0: Premise challenge

**What is the real problem?** Small and mid-size Canadian trucking and bus operators run their fleet across a tracker vendor's portal, a dispatch spreadsheet, a pay and invoicing tool, and phone calls. RouteNorth's bet is one back-office and customer-facing layer on top of whatever GPS they already own. That is a good bet because it avoids the hardware fight with Geotab, Samsara and Motive and sells on workflow.

**Does the plan solve it directly?** The product solves it at feature level. It does not yet solve it at customer level: no one outside the repo has used it.

**Do-nothing cost:** the repo keeps growing in value on paper and stays at zero in practice. Every extra week without a pilot is a week of untested assumptions piling up (see premise table).

### Reality rows

Premise table. Verdict `unverified` means there is no file receipt behind the claim.

| Premise | Claim | Receipt | Verdict |
| --- | --- | --- | --- |
| P1 | Nothing has run against real hardware, real accounts or real phones | `docs/GO_LIVE.md:3`, `:45`, `:64`; `docs/NEXT_PLAN_STATUS.md:19` | confirmed (authors say so) |
| P2 | No pilot owners identified | `docs/NEXT_PLAN_STATUS.md:24` | confirmed |
| P3 | Geotab and Samsara pull connectors never touched a real customer account | `docs/NEXT_PLAN_STATUS.md:31` | confirmed |
| P4 | Ingest accepts unauthenticated requests when `INGEST_TOKEN` is unset | `apps/ingest/src/server.ts:18`, `:24`, `:156` | confirmed |
| P5 | Browser session is kept in `localStorage` | `apps/web/src/lib/session.ts:16`, `:25` | confirmed |
| P6 | Default map tiles are public OSM, CARTO and MapLibre demo servers | `apps/web/src/components/RouteMap.tsx:8-9`, `apps/web/src/lib/basemap.ts:4-7` (the file's own comment says "for production self-host") | confirmed |
| P7 | Certified ELD is not built and the product says so | `apps/api/src/portal/data-sources.controller.ts:176` | confirmed |
| P8 | Canada requires third-party certified ELDs, tested against the CCMTA technical standard | Transport Canada certification page and trade press found by search, not fetched or read in full | unverified (secondary sources) |
| P9 | "Canadian-hosted" is the headline promise | `README.md:3`, `docs/GO_LIVE.md:9`; no host exists, no Dockerfiles | confirmed gap |
| P10 | Incident posts, roadmap edits and backups are manual | `docs/OPERATIONS.md:35`, `:44-54`, `:58` | confirmed |
| P11 | Pricing is a placeholder, no payment is taken | `docs/INDUSTRY_READY_STATUS.md:32` | confirmed |
| P12 | Competitors: Geotab, Samsara, Fleet Complete (Powerfleet), Verizon Connect, Motive are established in Canada | Search results (Ken Research summary, Motive blog index) | unverified (vendor and market-research sources) |
| P13 | Canadian fleet-management market size | Sources disagree by 5x (US$0.43B telematics-only vs US$1.7B to US$3.4B fleet management) | unverified, do not quote |

`unverified=3` (P8, P12, P13).

REALITY: premise-table finding 3 premises (P8, P12, P13) rest on secondary web sources only docs/company-review/01-ceo-review.md:60
REALITY: already-done pass `git fetch origin` run; `git log origin/main --since=2026-11-01` shows only the three merged PRs already in this branch, none duplicate this review dfc1f5b
REALITY: surface-check pass named routes `/ingest/feed`, `/ingest/feed/traccar`, `/ingest/traccar` exist apps/ingest/src/server.ts:66
REALITY: binding-decisions pass no prior decisions found for this branch; the coordinator note is the only binding input docs/company-review/01-ceo-review.md:75
REALITY: numbers pass figures tagged [measured] or [claimed]; test counts are [claimed, re-measure before gate] docs/NEXT_PLAN_STATUS.md:29
REALITY: deferred-asks pass no linked issue, nothing left out docs/company-review/01-ceo-review.md:1
REALITY: pr-count pass one PR for this review (one doc file) docs/company-review/01-ceo-review.md:1

### Existing code leverage (what already exists)

| Sub-problem | Already built | Reuse? |
| --- | --- | --- |
| Bring-your-own-GPS intake | Per-company feed keys, `/ingest/feed` and `/ingest/feed/traccar`, Connect your GPS page, device-to-vehicle matching | Yes, this is the core wedge |
| Provider pull | Geotab and Samsara connectors, AES-256-GCM stored credentials, 1-minute polling with back-off (`docs/NEXT_PLAN_STATUS.md:31`) | Yes, but unproven live |
| Tenant isolation | Row-Level Security on every org table with a second-org test | Yes, keep |
| Honest status | Data sources page shows live / quiet / needs setup / not built per source | Yes, great trust feature |
| Dispatch, routes, driver app, POD, finance, reports | 234 playbook items done | Yes, but see sprawl finding |
| Compliance evidence | Audit log, 2FA, retention, export/erase, status page | Yes |
| Hosting, deploy, monitoring | Backup and restore scripts only | Gap, see action 3 |

### Dream state mapping

```
  CURRENT STATE                    THIS REVIEW                      12-MONTH IDEAL
  Feature-complete demo,    --->   Pilot-first plan: pick a    --->  5 to 10 paying Canadian fleets
  zero customers, no host,         host, verify one real feed,       on a Canadian-hosted service,
  legal text in draft,             close legal and security          Geotab/Samsara/Motive feeds live,
  nothing run on real data         basics, ship to 3 design          certified-ELD partner integrated,
                                   partners                          SOC 2 work under way, EN/FR
                                                                     support in both languages
```

The plan moves toward the ideal only if the next 8 weeks go to the middle column, not to the other 69 "partly built" playbook items.

### Landscape check (three layers)

- **Layer 1, tried and true:** fleet telematics sold as hardware plus portal by Geotab, Samsara, Motive, Fleet Complete, Verizon Connect. ELD is a compliance wedge in Canada, with third-party certification required. [Source: Transport Canada certification page and trade press found by search; not fully read.]
- **Layer 2, what search says:** the incumbents are certified, bundled and installed; ELD enforcement in Canada has been phased in. Sources I found are vendor blogs, and one source named a "Technical Standard 1.3" transition I could not verify. Confirm current dates on tc.canada.ca before putting any date in a customer-facing page.
- **Layer 3, first principles:** conventional wisdom says a fleet product must own the device. The bring-your-own-GPS premise says the device is a commodity and the buyer's pain is the work around it: dispatch, proof of delivery, pay, billing, customer tracking links. That is a credible contrarian wedge, but it creates a hard dependency: **RouteNorth's data supply depends on the goodwill and API terms of the vendors it is competing with.** Geotab and Samsara API terms, partner programs and rate limits were not reviewed and are not mentioned anywhere in the repo. That is the single largest strategic unknown.

Eureka logged in this review: the repo's honest "Not built" posture (Data sources page) is itself a trust differentiator for small Canadian buyers who have been burned by vendor over-promising. Keep it.

## Decision ledger (6 columns)

Decisions in this phase come from the coordinator's direction for this session, not from a live back-and-forth with Aayush. Where a real choice remains, it is listed as open and goes in the report.

| ID and owner | Contract and evidence | Current | Proposed | Status | Exact approval and scope |
| --- | --- | --- | --- | --- | --- |
| D1 Aayush | Product model: software only, bring your own GPS (`README.md:3`, `docs/GO_LIVE.md:22`) | Settled | none | approved | Coordinator note: "software only, customers keep their GPS hardware/provider" |
| D2 Aayush | Language and region promise: Canadian-hosted, EN/FR, trucks and buses | Settled | none | approved | Coordinator note |
| D3 Aayush | ELD: integrate certified providers, do not build one | Settled | none | approved | Coordinator note |
| D4 Claude | Review mode | HOLD SCOPE | none | approved | Chosen by reviewer under 0E rules (fix/refactor-class work, one planned file) |
| D5 Claude | No application code changes this phase | Settled | none | approved | Coordinator note |
| D6 Aayush | Canadian hosting provider and region | Not chosen | Pick one (see action 3) | unresolved | Coordinator note: "no hosting chosen yet (Vercel paused)" |
| D7 Aayush | Adopt a feature freeze until 3 pilots run | Not decided | Freeze | unresolved | Needs Aayush's answer |
| D8 Aayush | First customer segment and 3 design partners | Not decided | See action 2 | unresolved | Needs Aayush's answer (`docs/NEXT_PLAN_STATUS.md:24`) |
| D9 Aayush | Legal entity, lawyer, named privacy officer | Not decided | See action 5 | unresolved | Needs Aayush's answer (`docs/COMPLIANCE_PLAN.md:25-34`) |
| D10 Aayush | Which certified ELD provider to partner with | Not decided | Decision only, no build | unresolved | Needs Aayush's answer |

Approval readiness: **PASS** for D1 to D5 (cited to the coordinator note and 0E). D6 to D10 are open choices, correctly kept pending and listed in the report. No remedy in this document is applied as code.

## Step 0 scope dispositions (HOLD SCOPE)

HOLD SCOPE checks:

1. **Complexity.** The branch is 576 files and 75k lines for a product with no users. More than 8 files and many services, so the right challenge is "fewer moving parts for the same goal". Recommendation: hold the code, but do not extend it. Records as D7 (open).
2. **Minimum change for the goal.** The goal is company-ready. The minimum is: host, one verified real feed, legal and security basics, three customers. None of those is a feature.
3. **Invariants kept.** Tenant isolation, honest status labels, no faked integrations.

NOT in scope (rejected or deferred in this review):

| Item | Disposition | Why |
| --- | --- | --- |
| Building an ELD | Rejected (D3) | Canada needs third-party certification; partner instead |
| Native iOS and Android apps | Deferred | Web app installs; build native only if pilots need background tracking (`docs/GO_LIVE.md:64`) |
| WhatsApp, masked calling, biometrics, watch and car screens | Deferred | Need outside accounts or native apps (`README.md:71`) |
| Loyalty and referral features | Rejected | Already "chosen not to build" in the playbook |
| SOC 2 or ISO 27001 audit now | Deferred | Foundation work only until there are customers who ask (`docs/COMPLIANCE_PLAN.md:45-53`) |
| More Punjabi and Arabic coverage | Deferred | Drafted without native reviewer (`docs/FEATURE_PLAYBOOK_STATUS.md:102`); not a pilot need |
| New playbook items | Deferred | 69 partly built items already exceed what a pilot will exercise |

## Temporal interrogation (0I)

```
  WEEK 1 (foundations):    Which host? Which 3 customers? Who is the privacy officer?
  WEEKS 2-3 (core):        Real feed ambiguity: do pilots forward from Traccar, use a
                           Geotab/Samsara account, or something else (Motive, Verizon)?
  WEEKS 4-5 (integration): Surprise: customer's provider terms forbid third-party
                           polling; real devices send fields the quality gate rejects.
  WEEKS 6+ (polish):       Wish we had planned: onboarding script, French support
                           inbox, a status process that is not hand-written SQL.
```

Effort labels are on the action list below.

## Review sections

### Section 1: Architecture

Current scope: HOLD SCOPE (D4); approved D1 to D5; open D6 to D10; no expansions accepted.

```
  Customer's GPS devices / provider
     |        |               |
     |        |               +-- Geotab / Samsara API  <--pull every 1 min--+
     |        |                                                           |
     |        +-- Traccar forward --> /ingest/feed/traccar?key=...        |
     +-- JSON push ---------------> /ingest/feed ---+                      |
                                                    v                      |
                              +--------------- ingest (4100) --------------+
                              |  quality gate, device registry, Redis dedupe
                              +--------+----------------------------------+
                                       v
                          Postgres (RLS tenant isolation)  <---- API (NestJS, 4000)
                                       |                          |  WebSocket live stream
                                       v                          v
                                 Redis (pub/sub)           Web (Next.js, 3000) EN/FR
                                                           Driver PWA  /driver
  Outside services (all optional): Resend, Twilio, OSRM/Valhalla, Nominatim, Open-Meteo,
  map tiles (OSM/CARTO), AI key.
```

Findings:

- **WARNING, single host does not exist.** Four services (web, API, ingest, Traccar) plus Postgres and Redis must be hosted together in Canada. There are no Dockerfiles (`ls apps/*/Dockerfile`). First production deploy is an unwritten project.
- **WARNING, data residency is a promise the plan breaks by default.** Email (Resend), SMS (Twilio), weather (Open-Meteo), map tiles and the optional AI key all send data outside Canada. `README.md:3` says "Canadian-hosted". Each is optional, but the privacy page must name each one. Owner: Aayush plus lawyer (action 5).
- **WARNING, upstream dependency risk.** The wedge depends on Geotab, Samsara (and later Motive, Verizon) API terms. Geotab servers are limited to `*.geotab.com` in code (`docs/NEXT_PLAN_STATUS.md:31`), which is a good guard, but there is no review of partner terms. Implementation owner must prove: each provider's API terms allow a third-party app to pull a customer's data on the customer's credentials.
- **WARNING, two shells.** Owner Portal and the older app are linked, not merged (`docs/NEXT_PLAN_STATUS.md:21`). Customers will see two navigation systems.
- **OK, tenant isolation.** RLS on every org table, services connect as low-privilege `routenorth_app` (`README.md:51-53`).
- Single points of failure: one ingest process (positions lost while down unless the provider retries), one Postgres, one Redis, hand-edited incidents.
- Rollback posture: no deploy pipeline exists, so rollback time is unknown. Owner: whoever does action 3.
- Value test for status docs: `docs/*_STATUS.md` and the playbook generator (`scripts/playbook-status.mjs`) are artifacts about the work. Consumer: Aayush's own tracking and the owner's Get started page. Smallest useful version: keep as is, retire the 320-item generator once pilots drive the backlog.

### Section 2: Error and rescue map (capability level)

```
  CAPABILITY / BOUNDARY        | WHAT CAN GO WRONG                     | KNOWN SAFEGUARD                         | VERIFY BEFORE LAUNCH (owner)
  -----------------------------|---------------------------------------|-----------------------------------------|---------------------------------------
  /ingest/feed (push)          | wrong or leaked feed key              | per-company keys, revoke on Connect page| key rotation test (eng)
                               | INGEST_TOKEN unset                    | NONE: accepts all (server.ts:24)        | fail closed in production (eng) GAP
                               | bad coordinates, jumps                | quality gate, reasons listed in UI      | replay real captures (eng)
  Geotab / Samsara pull        | refused login                         | 1 hour back-off                         | live test with real account (eng)
                               | provider rate limit or terms change   | back-off only                           | read partner terms (Aayush)
                               | provider returns new field shape      | recorded-shape tests only               | live contract check (eng)
  Traccar forward              | real tracker protocol quirks          | simulator only                          | one real tracker (eng)
  Email (Resend)               | key unset, domain unverified          | Data sources shows "needs setup"        | real send + bounce handling (eng)
  Road routing and geocoder    | server down, public geocoder blocked  | falls back to straight-line estimate    | self-hosted OSRM/Valhalla (eng)
  Map tiles                    | public tile servers throttle or block | none (defaults are public servers)      | paid or self-hosted tiles (eng) GAP
  Backups                      | no schedule, no off-site copy         | manual script with read-back check      | scheduled + quarterly restore (ops) GAP
  Hours of service screens     | customer treats estimates as legal logs| label says estimate (data-sources:176) | wording review on every HOS screen (Aayush)
  Billing                      | no payment path                       | placeholder prices                      | manual invoices for pilots (Aayush)
  AI features (key optional)   | malformed or refused model output     | rule-based first, answers re-checked    | live test only if the key is enabled (eng)
```

Rule from the skill applied: the CRITICAL GAP rows are the ones with no rescue, no live test and a silent result for the user. Those are marked GAP.

### Section 3: Security and threat model

| Threat | Likelihood | Impact | Mitigated? |
| --- | --- | --- | --- |
| Ingest open without `INGEST_TOKEN` lets anyone push fake positions into the service | Med (easy to forget on first deploy) | High | Partly: JSON batch endpoint is off, but unauthenticated Traccar path accepts (`server.ts:24`, `:109`, `:156`). Needs fail-closed in production. |
| Session token in `localStorage` is readable by any injected script (XSS) | Med | High (account takeover, GPS history of named drivers) | No. `apps/web/src/lib/session.ts:16,25`. Move to httpOnly cookie, or prove strict CSP. Not applied; this is a review finding. |
| `ENCRYPTION_KEY` defaults to `JWT_SECRET`; one leak breaks both | Low | High | Documented warning (`docs/OPERATIONS.md:10`); enforce separate key in production |
| Stored provider credentials (Geotab/Samsara) in database | Med | High | AES-256-GCM, but key shares fate with JWT secret above |
| Cross-tenant data leak | Low | High | RLS plus a second-org test (`docs/COMPLIANCE_PLAN.md:11`) |
| Driver GPS history is personal information (PIPEDA, Law 25) | High (certain) | High | Retention, export, erase, shift-only tracking exist; privacy impact assessment and sub-processor list do not |
| No independent security test | High | Med | None. `/cso` static audit is a cheap first pass; third-party pen test is month 4 to 6 (`docs/COMPLIANCE_PLAN.md:49`) |
| Public pages (`/status`, `/roadmap`, `/j/<token>`) | Low | Low | Rate limits and no driver name or plate on tracking page (`docs/FEATURE_PLAYBOOK_STATUS.md:156`) |
| Dependency risk | Unknown | Unknown | Not audited. Add `pnpm audit` to CI |

### Section 4: Data flow and interaction edge cases

```
  INPUT (fix) -> VALIDATE (quality gate) -> TRANSFORM -> PERSIST (RLS) -> OUTPUT (map, reports)
     |                |                        |              |                |
   nil/empty:      rejected with reason     unit conv?     dup/conflict:    stale: freshness
   counted not     listed on Trackers page  (unknown for   Redis dedupe     line says demo or
   stored          (GO_LIVE:43)             real devices)  (test on real?)  stale (NEXT_PLAN:11)
   too-old/late    out of order batches:    timezones:     lock/timeouts:   empty fleet: empty
   fix: unknown    unknown for real feed    DST bug seen   unknown          state with next step
   (verify live)   (21388a9)                in tests
```

Findings:

- **WARNING, shadow paths are all tested against the simulator and recorded shapes, not real device behavior.** Real trackers send late bursts after a tunnel, duplicate fixes, odd ignition codes. Implementation owner must prove: replay of captured real data through the quality gate.
- Interaction: owners using the phone-width Owner Portal (checked at 390 px, `docs/NEXT_PLAN_STATUS.md:21`), drivers offline (outbox exists). Double-submit and stale-tab behavior is not documented; verify in the `/qa` phase.
- Wall-clock-dependent tests have already failed once (`21388a9`, `25c8753`). Flaky-by-date risk remains in `pay.test.ts` style tests.

### Section 5: Code quality

- `apps/api/src/app.module.ts` is the most-edited file (32 edits in 30 days). A feature-per-module registry growing in one file is a merge-conflict magnet and a sign the API surface is wide (31 top-level folders under `apps/api/src`).
- `packages/shared/src/index.ts` (21 edits) and `ui.css` (15) are similar hotspots.
- No TODO or FIXME debt in source (clean).
- Over-engineering risk is at product level, not code level: 320 playbook ideas, 69 partial. See action 1.
- Complexity per method was not measured (strategy-only depth). Run `/health` as part of Phase 2 to get a score.
- No `LICENSE` file; root `package.json` is `"private": true`. Fine for a closed SaaS, but the code needs an explicit ownership statement before anyone else contributes.

### Section 6: Test review

```
  FLOW                            | TYPE          | EXISTS?                    | GAP
  --------------------------------|---------------|----------------------------|--------------------------
  Tenant isolation                | integration   | yes (second-org test)      | none known
  Ingest quality gate             | unit          | yes (ingest 31)            | real-capture replay
  Provider pull (Geotab/Samsara)  | unit (fakes)  | yes, recorded shapes       | LIVE contract test
  Traccar forward                 | none live     | simulator only             | one real tracker test
  Email, SMS                      | stand-in      | stub server                | one real send
  Browser flows                   | automated     | landing, signup, reset     | full owner + driver journey
  Phone, offline                  | none          | no real phone              | real phone pass
  Load                            | none          | none                       | 1,000 vehicles x 1 fix/10s
  Restore                         | none          | script exists              | quarterly restore test
```

no_claim for the existing green suite: it does not prove provider acceptance, real device behavior or real phones (mocked providers, simulator, stub servers). Test ambition: the 2am-Friday test is "a real tracker moves and the owner sees it within 2 minutes, with a replayed duplicate burst". The hostile-QA test is "push positions for another company's device with a leaked key". The chaos test is "kill ingest mid-batch and confirm no duplicates after restart". Pyramid looks right (many unit, few integration); the e2e layer is thin and tied to the simulator. CI runs on one workflow with Postgres 16; it does not run browser tests.

### Section 7: Performance

- Scale question never answered: how many vehicles per customer at launch (5 to 50 is the guessed segment). 1 fix per 10 seconds per vehicle is 6 writes a minute each; at 500 vehicles, 3,000 writes per minute is easy for Postgres, but history tables with no stated partition plan will grow. Owner: eng, ask when sizing the host.
- Provider polling every minute per connection: with 100 connections that is 100 outbound calls per minute with back-off. Fine, but provider rate limits unknown.
- Public tile servers will fail under real use before the app does (Section 2).
- Files (photos, signatures) live inside Postgres (`docs/OPERATIONS.md:38`, `bytea` in migrations 007 and 009), which bloats backups and restores. Move to object storage once pilot volume shows a trend.

### Section 8: Observability

- Per-company Health page exists (`docs/OPERATIONS.md:66`). **Cross-company monitoring does not**: operators are told to watch `/public/system-status` and logs from outside. There is no alerting, no error tracker, no uptime monitor, no on-call. For a company, day-one needs: uptime check on API, ingest and web; alert on ingest silence for all tenants; error tracking; log retention.
- Incident posts are hand-written SQL (`docs/OPERATIONS.md:44-54`). Fine for the first pilots, an admin form later.
- Debuggability: audit log is strong; request tracing across ingest to API to WebSocket is not mentioned.
- Dashboards day one: ingest fixes per minute, rejected fixes by reason, connection pull success per provider, p95 API latency, WebSocket connected clients.
- Runbooks missing: provider outage, ingest down, restore, key rotation, a customer reports wrong location.

### Section 9: Deployment and rollout

- No host, no pipeline, no staging. Everything below is a plan, none exists.
- Rollout order: migrate first, deploy second (28 migrations; `pnpm seed` re-grants privileges and must run after new migrations, `README.md:70`).
- That last point is a deploy footgun: forgetting `pnpm seed` after a migration breaks the app role's access. Needs to be a pipeline step, not a human memory.
- Feature flags exist (Settings, Features), good for hiding unfinished playbook items from pilots.
- Rollback plan: unknown until a pipeline exists.
- Post-deploy smoke: login, Data sources page loads, one feed push shows on map, one email test.
- Staging: required, use a second Canadian-region environment; never test with production keys.

### Section 10: Long-term trajectory

- Technical debt: operational (manual backups, manual incidents, no monitoring), testing (no live provider tests), documentation (good), legal (draft text).
- Path dependency: choosing a host now fixes the data-residency story. Choosing Vercel for web while data lives elsewhere makes the "Canadian-hosted" line harder to state truthfully for the front end; confirm where web requests terminate before using the phrase.
- Reversibility: **4/5**. Software-only code is portable. One-way doors are the legal entity, public price list, and any customer contract that names a hosting region.
- Knowledge concentration: docs are unusually good (`GO_LIVE`, `OPERATIONS`, `COMPLIANCE_PLAN`, `DATA_PIPELINE`). A new engineer could start. The risk is concentration in one person, Aayush, plus AI assistance.
- The 1-year question: a new engineer would find a wide, well-documented API and two UI shells, and ask which of the 320 features customers actually use. Today nobody knows. Product analytics exist (Settings, Health and usage) but have no users to count.

### Section 11: Design and UX

SKIPPED (no UI scope): this review changes no screens. Two UI-adjacent business risks recorded anyway: the landing page carries labelled sample reviews and placeholder prices (`docs/INDUSTRY_READY_STATUS.md:32-34`); remove or replace both before any public launch. When pilots start, run `/design-review` on the live staging site.

## Error and Rescue Registry

See the table in Section 2 (capability level, strategy-only depth). 12 capability rows, 3 marked GAP (ingest fail-open, public tile defaults, no scheduled backup).

## Failure modes registry

```
  CAPABILITY               | FAILURE MODE                      | RESCUED? | TEST?   | USER SEES?        | LOGGED?
  -------------------------|-----------------------------------|----------|---------|-------------------|--------
  Ingest, no INGEST_TOKEN  | anyone can push positions         | N        | unknown | nothing (silent)  | one console line   CRITICAL GAP
  Map tiles on public srv  | throttled or blocked in production| N        | N       | blank map         | no                 CRITICAL GAP
  Backups                  | never scheduled, never restored   | N        | N       | nothing until loss| no                 CRITICAL GAP
  Cross-tenant monitoring  | ingest silent for all customers   | N        | N       | customers notice  | no                 CRITICAL GAP
  Geotab/Samsara pull      | terms/API change, refused login   | Y (back-off)| fakes only | "problem" on Data sources | yes
  Provider shape change    | parse failure on real response    | unknown  | fakes   | unknown           | unknown
  Real tracker protocol    | rejected or mis-parsed fixes      | Y (reason shown)| sim only | reasons on Trackers page | yes
  Email not verified       | resets/invites not delivered      | Y (needs setup shown)| stub | "needs setup"| yes
  HOS estimates read as legal | compliance exposure for customer| Y (label)| N       | label only        | no
  Session token theft      | XSS reads localStorage            | N        | N       | silent takeover   | audit log only
```

Critical gaps: **4** (rows marked). Session-token storage is a high-severity finding but not counted here because it is a design choice, not a failure path; it is action 6.

## Diagrams produced

1. System architecture (Section 1)
2. Data flow with shadow paths (Section 4)
3. Error flow (Section 2 table)
4. Deployment sequence and rollback flowchart:

```
  commit -> CI (tests, pnpm audit) -> build images -> deploy STAGING (CA region)
        -> migrate -> pnpm seed (re-grant) -> smoke (login, Data sources, 1 feed push)
        -> promote to PROD -> smoke again -> watch 15 min
  ROLLBACK: smoke fails -> redeploy previous image tag -> if migration was applied,
            restore from last backup (restore into EMPTY db, point API at it)
```

5. State machine: none needed, no new stateful object proposed.

Stale diagram audit: no ASCII diagrams exist in the files this review touches (it adds one doc). `docs/DATA_PIPELINE.md` describes the pipeline in prose and was not re-checked against code in this phase.

## Findings summary (ranked)

1. **Zero real-world validation.** 75k lines, 234 playbook features, no real tracker, provider, phone, email or customer (`GO_LIVE.md:3`, `NEXT_PLAN_STATUS.md:19-24`).
2. **Not hostable yet.** No Dockerfiles, no Canadian host chosen, no staging, no pipeline.
3. **Strategic dependency on competitors' APIs, unreviewed.**
4. **Sprawl.** 69 partial features, two UI shells, a 31-folder API, with no usage data.
5. **Legal and privacy text is draft; privacy officer, entity and sub-processor list missing** (`COMPLIANCE_PLAN.md:25-34`).
6. **Security basics open:** ingest fail-open, localStorage tokens, shared encryption key default.
7. **Operations basics open:** no monitoring or alerting, manual backups, hand-written incidents, `pnpm seed` memory step.
8. **ELD gap is correctly labelled** but HOS screens still need wording discipline until a certified partner exists.
9. **Pricing and billing are placeholders;** fine for pilots if invoiced by hand.
10. **French and Quebec:** French text is a careful translation, not a certified legal translation; Quebec buyers will check.

## Top 10 actions (ranked)

Effort uses two scales: human-team time / CC+gstack time. Owner is who must act.

| # | Action | Why (what breaks if skipped) | Effort | Owner |
| --- | --- | --- | --- | --- |
| 1 | **Freeze new features until 3 pilots run.** Hide partial playbook items behind existing feature flags; keep the nav to the pilot workflow. | The product has more surface than any pilot can test; every new feature adds untested risk and delays real feedback. | S / S | Aayush |
| 2 | **Sign 3 design-partner fleets** (Canadian truck and bus operators, roughly 5 to 50 vehicles, already running Geotab, Samsara or a Traccar-compatible tracker). Free pilot for weekly feedback and a named reference. | There is no proof anyone wants this. Nothing else on this list matters if no fleet uses it. Also decides which provider connectors matter first. | M / n.a. (people work) | Aayush |
| 3 | **Choose a Canadian host and stand up staging and production.** Write Dockerfiles, managed Postgres with point-in-time recovery, Redis, TLS, secrets, a CI deploy step that runs migrations then `pnpm seed`. Decide where web requests terminate before using the words "Canadian-hosted". | The headline promise has no host behind it, and there is no way to ship or roll back. | L / M | Aayush picks, then eng |
| 4 | **Verify one real feed end to end:** first a Geotab demo database or a Traccar test tracker, then the first pilot's real provider. Capture real payloads and replay them through the quality gate. | Every provider and tracker path (Geotab, Samsara, Traccar, JSON push) was tested only against stand-ins. A real device is the first moment the wedge is true. | M / M | eng |
| 5 | **Fix the legal and privacy foundation:** confirm the legal entity, hire a Canadian privacy lawyer to review terms and privacy text, name the privacy officer (Law 25), list every sub-processor (email, SMS, tiles, weather, AI), decide what "Canadian-hosted" will and will not mean. Set the four `NEXT_PUBLIC_*` company variables. Read each provider's API terms. | GPS history of named drivers is personal information. Launching on draft text is a legal and sales risk, and Quebec buyers ask for this on day one. | M / S (drafting help only) | Aayush + lawyer |
| 6 | **Close the security basics before any real data:** make ingest refuse to start in production without `INGEST_TOKEN`; move the session token out of `localStorage` (httpOnly cookie) or prove a strict CSP; require a separate `ENCRYPTION_KEY`; add `pnpm audit` to CI; run gstack `/cso` for a static audit. | Fail-open ingest and script-readable tokens are the two most likely first incidents. | M / S | eng |
| 7 | **Stand up production operations:** scheduled backups with off-site copy and a first restore test; uptime checks on web, API and ingest; alert when ingest goes quiet for all tenants; error tracking; replace default public map tiles (and public geocoder) with a paid or self-hosted source; write runbooks for ingest down, provider outage, restore. | Today a failure is only noticed by a customer. Public tile servers will block production traffic. | M / M | eng |
| 8 | **Decide the ELD route and fix the wording:** shortlist 1 to 2 certified ELD partners (decision only, no build); until one is integrated, add the same "estimate, not an official log" label to every hours-of-service screen, report and PDF. Re-confirm current Transport Canada dates before quoting any. | Customers may treat an estimate as a legal record. Canadian carriers needing an ELD will not buy without a certified path. | S / S | Aayush (decision), eng (wording) |
| 9 | **Price it and invoice by hand.** Replace placeholder prices with a pilot price sheet, send manual invoices for the first customers, ask the accountant about GST/HST/QST on subscriptions and the small-supplier threshold, and add Stripe (CAD) only after 3 customers say they will pay. Remove "Sample review" content from the landing page before any public launch. | Building billing before demand is a classic time sink; placeholder reviews and prices hurt trust. | S / S | Aayush |
| 10 | **Run onboarding as a product:** a written 30-minute onboarding script per pilot, time-to-first-vehicle-on-map as the first metric (from product analytics), a monitored support inbox with a verified sending domain, and a native French reader for every customer-facing string before a Quebec customer sees it. | The first 3 customers define the product. Without a measured onboarding path, feedback is anecdotes. | M / S | Aayush + eng |

Next gstack phases suggested (Phase 2 onward): `/autoplan` for the engineering review of actions 3 to 7, then `/cso` for the security audit, `/qa` on staging with a real feed, and `/plan-design-review` once pilots have used the UI. No design review is needed from this phase.

## TODOS.md proposals (HOLD SCOPE: only evidenced gaps)

Not written to a `TODOS.md` file in this phase (no code or file changes beyond this doc). The ten actions above are the proposed backlog; each carries its P-level by rank (1 to 7 are P1, 8 to 10 are P2).

## Implementation tasks (strategy-only: next actions and owners)

- [ ] **T1 (P1, human: ~1h / CC: ~5min)** Aayush: decide the feature freeze (D7). Verify: decision recorded in `docs/company-review/`.
- [ ] **T2 (P1, human: ~3 weeks / CC: n.a.)** Aayush: list 10 candidate fleets and sign 3 (D8). Verify: three written agreements to pilot.
- [ ] **T3 (P1, human: ~2 weeks / CC: ~1 day)** Aayush chooses host (D6); eng writes Dockerfiles, staging, deploy pipeline. Verify: staging `/status` loads over TLS from a Canadian region.
- [ ] **T4 (P1, human: ~1 week / CC: ~2h)** Eng: real feed test against Geotab demo or a real tracker. Verify: vehicle appears on live map; real payloads saved as fixtures.
- [ ] **T5 (P1, human: weeks / CC: ~1h drafting)** Aayush plus lawyer: entity, privacy officer, sub-processor list, provider terms read (D9). Verify: lawyer sign-off on terms and privacy.
- [ ] **T6 (P1, human: ~2d / CC: ~30min)** Eng: ingest fail-closed, cookie session, separate encryption key, `pnpm audit` in CI, run `/cso`. Verify: tests prove ingest refuses to start without a token in production mode.
- [ ] **T7 (P1, human: ~1 week / CC: ~3h)** Eng: scheduled backups, restore test, uptime and ingest-silence alerts, error tracking, replace public tiles. Verify: a deliberate ingest stop triggers an alert; a backup restores into an empty database.
- [ ] **T8 (P2, human: ~2h / CC: ~15min)** Aayush chooses ELD shortlist (D10); eng adds the estimate label everywhere HOS appears. Verify: grep for hours-of-service screens shows the label.
- [ ] **T9 (P2, human: ~1d / CC: ~15min)** Aayush: pilot price sheet, accountant question, remove sample reviews. Verify: landing page has no placeholder pricing or sample reviews.
- [ ] **T10 (P2, human: ~2d / CC: ~1h)** Aayush plus eng: onboarding script, first-vehicle metric, support inbox, French read-through. Verify: a pilot goes from signup to first vehicle on map in under 30 minutes.

## Completion summary

```
  +====================================================================+
  |            MEGA PLAN REVIEW (CEO) - COMPLETION SUMMARY             |
  +====================================================================+
  | Mode selected        | HOLD SCOPE                                  |
  | System Audit         | 576 files changed vs main, no TODO debt,    |
  |                      | no host/Dockerfiles, no TODOS.md            |
  | Step 0               | HOLD SCOPE; D1-D5 approved, D6-D10 open     |
  | Section 1  (Arch)    | 5 issues found                              |
  | Section 2  (Errors)  | 12 capability paths mapped, 3 GAPS          |
  | Section 3  (Security)| 9 issues found, 3 High severity             |
  | Section 4  (Data/UX) | 6 edge cases mapped, 5 unverified live      |
  | Section 5  (Quality) | 4 issues found                              |
  | Section 6  (Tests)   | Diagram produced, 6 gaps                    |
  | Section 7  (Perf)    | 3 issues found                              |
  | Section 8  (Observ)  | 5 gaps found                                |
  | Section 9  (Deploy)  | 5 risks flagged                             |
  | Section 10 (Future)  | Reversibility: 4/5, debt items: 4           |
  | Section 11 (Design)  | SKIPPED (no UI scope)                       |
  +--------------------------------------------------------------------+
  | NOT in scope         | written (7 items)                           |
  | What already exists  | written                                     |
  | Dream state delta    | written                                     |
  | Error/rescue registry| 12 rows, 3 CRITICAL GAPS                    |
  | Failure modes        | 10 total, 4 CRITICAL GAPS                   |
  | TODOS.md updates     | 0 written (10 actions proposed in this doc) |
  | Scope proposals      | 0 proposed, 0 accepted (HOLD SCOPE)         |
  | CEO plan             | skipped by mode                             |
  | Outside voice        | codex: unavailable (not installed)          |
  | Lake Score           | N/A (no scored questions asked)             |
  | Diagrams produced    | 5 (architecture, data flow, error, deploy,  |
  |                      | rollback)                                   |
  | Stale diagrams found | 0                                           |
  | Unresolved decisions | 5 (D6 to D10, listed below)                 |
  | Reality rows         | 7/7 rows, 3 unverified premises             |
  +====================================================================+
```

Evidence and limits: static read and web search only. Not independently verified: all test counts, Transport Canada requirements and dates, competitor positions, market size, any provider's API terms. Learnings: no durable learnings beyond what is in this doc.

## GSTACK REVIEW REPORT

| Review | Trigger | Why | Runs | Status | Findings |
|--------|---------|-----|------|--------|----------|
| CEO Review | `/plan-ceo-review` | Scope & strategy | 1 | ISSUES OPEN | mode: HOLD SCOPE, 4 critical gaps |
| Outside Review | codex (plan-review) | Independent 2nd opinion | 0 | unavailable | no completed external review (Codex not installed) |
| Eng Review | `/autoplan` | Architecture & tests (required) | 0 | not run | eng review required |
| Design Review | `/plan-design-review` | UI/UX gaps | 0 | not run | not applicable this phase |
| DX Review | `/plan-devex-review` | Developer experience gaps | 0 | not run | not applicable this phase |

**OUTSIDE COVERAGE:** codex plan-review, unavailable (CLI not installed); native fallback not run. No cross-model comparison exists.
**VERDICT:** CEO review complete with issues open; Eng review required before implementation.

**UNRESOLVED DECISIONS:**
- D6: Which Canadian hosting provider and region (no host chosen; Vercel paused)
- D7: Adopt a feature freeze until three pilots are running
- D8: First customer segment and the three design-partner fleets
- D9: Legal entity, lawyer and named privacy officer
- D10: Which certified ELD provider to partner with (decision only, no build)
