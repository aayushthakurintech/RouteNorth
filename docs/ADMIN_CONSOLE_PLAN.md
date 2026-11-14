# Admin console: plan and design

Written 2026-11-14. The status of what is built, and what is not tested, is in [ADMIN_CONSOLE_STATUS.md](ADMIN_CONSOLE_STATUS.md).

## 0. The honest answer to "had you thought it through?"

No. Before this work RouteNorth had one kind of account: a person who belongs to a client company, with a role (owner, manager, dispatcher, viewer, driver, customer) that decides what they may do. There was **no RouteNorth staff account, no way to choose which parts of the product a client has, no way to suspend a client, and no way for us to see how clients are doing** other than the database. "Admin" in the code meant a client's own administrator. This document is the plan that replaces that gap.

## 1. What the product needs, in one page

| Need | Answer |
| --- | --- |
| Same login page | `/login` is unchanged. The API looks the email up in the staff table first; if it is staff, a code from an authenticator app is always required and the browser lands on `/admin`. Otherwise the normal client sign-in carries on. |
| A different interface for staff | `/admin` is its own shell (own sidebar, amber rule, an "Admin" tag in the brand) so nobody mistakes it for a client's screen. Clients never see it and cannot load it. |
| Choose what each client can see | Ten **sections** (tracking, fleet care, dispatch, drivers, finance, reports, alerts, customer portal, API and integrations, AI assistant), switched per client in the console. |
| "Only one section plus the basics" | A fixed list of **core features** is always on for every client (sign in, profile and two-factor, company settings, users and roles, the company's own audit log, notifications, support, seeing its own plan). Staff cannot turn core off. |
| See details of clients and monitor them | Overview with health, a client list with filters, and per-client pages (usage, people, how trackers connect, plan, staff activity). |
| Security | See sections 4 to 8. |

## 2. Two separate ideas: permissions and entitlements

* A **permission** belongs to a **person**: what their role lets them do (`finance.view`, `fleet.manage`). Client owners already edit these.
* An **entitlement** belongs to a **company**: which sections it has bought. Staff edit these; client owners cannot see an edit control for them.

A request must pass **both**. Entitlements never grant a permission; they only take sections away. So a client limited to Tracking has an owner who is still only an owner of Tracking: they cannot reach Finance by editing their own role.

### Section catalogue

Each section is a bundle of API route prefixes and web pages (see `packages/shared/src/entitlements.ts`):

| Section | Contains |
| --- | --- |
| tracking | Live map, trackers and connections, vehicles, trips and history, geofences, shared tracking links |
| fleet_care | Maintenance, documents, fuel logs, inspections, incidents, equipment, depots |
| dispatch | Routes, stops, jobs, dispatch board, planning and optimisation, tasks, schedules |
| drivers | Driver profiles and app, timesheets, expenses, safety scores, messages, approvals |
| finance | Driver pay, payouts, invoices, quotes, rate cards, budgets, contracts, profit |
| reports | Owner dashboard, report catalogue and builder, goals, scheduled reports, exports |
| alerts | Alert rules, notifications to Slack, Teams and email, workflows, webhooks |
| customers | Customer-facing orders, tracking pages, templates, feedback |
| integrations | API keys, data feeds, inbound email, custom fields and statuses |
| assistant | Briefings, questions, forecasts |

Presets in the console only fill in checkboxes (Tracking only, Tracking and reports, Operations, Everything). Nothing in the API looks at a preset's name.

### Defaults ("basic permissions")

Always on, for every client, whatever the sections: sign-in and sign-out, own profile, password and two-factor, company settings and branding, users, roles and invitations, the company's own audit log, notifications, search (within the sections the company has), support, and seeing its own plan and sections. The console says this on the Access tab, and the API ignores any attempt to remove them.

### Limits

Staff can set **hard limits** on vehicles and people per client. These stop an add with a clear message. The plan's own limits stay **soft** (a warning), as before.

## 3. Enforcement: server first, screen second

The rule is that hiding a menu item is courtesy and the API is the lock.

1. **One central check.** `AuthGuard` classifies every request path against `API_ROUTE_RULES` and refuses it with `403 section_not_included` when the company does not have that section. The same guard refuses everything for a suspended company (`403 account_suspended`).
2. **Fail closed.** A route nobody classified is refused for a restricted company. A coverage test walks the Nest controller metadata, so a new controller that is not classified fails the test suite.
3. **Other doors are covered too:** API-key and feed routes that bypass the guard (they check section and suspension themselves), the live WebSocket stream (tracking section and not suspended), global search (only results from sections the company has), and the schema endpoint.
4. **Effect on the next request.** Entitlements are read per request, not baked into the login token, so a change applies on the client's very next click and a downgrade cannot be dodged by keeping an old token.
5. **The web app** hides menu items and replaces a disallowed page with a plain "not part of your plan" page. This is courtesy only.
6. **Tests** prove a restricted client is denied for reads, writes, API keys, search, schema and the live stream, and that suspension and limits work (`apps/api/src/admin/admin.test.ts`, `coverage.test.ts`).

## 4. Tenant isolation (unchanged, and used again)

Client data stays behind Postgres row-level security keyed on `app.org_id`. The staff tables use a **different** policy that checks `app.platform = 'on'`, set only by `withPlatform()`, which only staff code paths call. A client's database session cannot read staff tables even if a query is mistaken. Staff reading a client's own tables does not use a staff backdoor: it goes through the same `withOrg` path as the client, and only for the small amount the console shows (people, tracker counts). Anything deeper is only reachable through a logged "view as client".

## 5. Staff identity and sign-in

* **Separate table, token and key.** Staff are in `platform_admins`; their token has its own audience and is never accepted as a client token and vice versa. A client owner is never staff and staff have no company.
* **Always two-factor** (authenticator app, replay-safe: each 30-second code works once). Ten recovery codes, each once.
* **Uniform failure.** Unknown email, wrong password, locked, disabled and a blocked network all return the same `401 invalid credentials`, so the form cannot be used to find out who is staff.
* **Lockout.** Five wrong answers in a row lock the account for 15 minutes (a wrong code at step-up also ends the session).
* **Sessions.** Idle 30 minutes, absolute 8 hours, one active sign-in per person (a new one ends the old). The guideline source is NIST SP 800-63B-4 session management; ASVS 4.3.1 asks for step-up for sensitive actions, which is why they exist here.
* **Step-up.** Creating a client, changing access, suspending, opening a view as a client and every staff-account change need a fresh code from the last 10 minutes. The console asks for it in a dialog and repeats the action.
* **Optional network allow-list per person.** The API reads the caller's address as Express gives it, so behind a load balancer it only works once the proxy setting from PR #12 is in (see the status doc).
* **New accounts.** A super admin creates them in the console or an operator runs `pnpm --filter @routenorth/api admin:create` for the very first one. They get a temporary password and an authenticator secret shown once, and must choose a 14+ character password at first sign-in.
* **Password rule:** 14 characters minimum, common and personal passwords refused.

## 6. Staff roles (least privilege)

| Role | Can do |
| --- | --- |
| Super admin | Everything, including staff accounts. There must always be one active super admin; you cannot demote or disable yourself. |
| Account manager | Create and edit clients, choose their sections and limits, suspend and reinstate, monitor, read the audit log. Cannot view inside an account or manage staff. |
| Support | View clients, monitor, and open a read-only "view as client". Cannot change anything about a client. |
| Auditor | Read clients, monitor, and the audit log. Nothing else. |

Permissions are server-checked on every `/admin` route (`requireAdminPerm`); the console only hides what a role cannot use.

## 7. "View as client" (impersonation)

Needed for support, risky for privacy, so it is narrow:

* Needs the `impersonate.view` permission, a fresh step-up code and a **written reason** (10+ characters, optional ticket number).
* **Read-only.** Every non-GET request is refused and counted. Sensitive permissions are removed even from the person being viewed (driver bank and tax details, API keys, billing, users and roles, payouts, finance management). Credential pages, privacy exports and bulk exports are blocked by path.
* **30 minutes**, one tab (`sessionStorage`), never replaces the staff member's own sign-in, and the token travels in the URL fragment so it is not sent to any server or written to logs.
* **Visible.** An amber banner is shown on every page with the staff person's name and the minutes left, and cannot be hidden. The client's own audit log gets an entry, and every path opened is recorded against the session.
* **Client control.** A client owner can switch staff views off in Settings, Security, Privacy. The default is **on** because support cannot help otherwise; for government or other strict clients we recommend turning it off at onboarding and working from screen shares (see section 10).
* The live stream does not accept a view-as token, so the live map in a staff view shows the last known positions but no live updates.

## 8. Audit

* **Staff audit** (`platform_audit`): append-only (a database trigger refuses any update or delete; a database owner could still drop the trigger, so ship the log to storage outside the database before real clients), records every sign-in, failure, step-up, view of a client, change and lookup with the staff email, IP, reason and detail.
* **Client audit**: staff actions that affect a client (plan, access, suspend, view started) are also written to the client's own audit log with the label "RouteNorth staff (name)", so the client can see what we did.
* The console shows both: the global Audit log, a per-client Staff activity tab, and a Staff views page with requests made and writes refused.

## 9. Client lifecycle and monitoring

* **Create:** name, owner, plan, sections. No email is sent (email delivery is not connected), so the console shows a one-time setup link (valid 7 days) to pass to the owner.
* **Change:** plan, trial end, internal notes (staff-only), sections and hard limits.
* **Suspend and reinstate:** with a reason. A suspended company's people are refused at their next request and cannot sign in (a clear "account is paused" message); data and incoming trackers are kept. Reinstating restores everything.
* **Health:** one summary per client with reasons, computed from usage numbers (`clientHealth`): vehicles with no tracker, no tracker reporting in 24 hours, some trackers silent, nobody ever signed in, no sign-in for 14 days, trial ending or ended, over its vehicle or people limit. Suspended clients show as off.
* **Overview:** totals (clients, trackers reporting, vehicles, staff views open), a "needs a look" list sorted by severity.
* **Tracker lookup** (disputes): who holds a tracker ID, with no positions shown. It exists because an IMEI is the only proof of ownership when a client claims a tracker (the open finding from [PREMIUM_AND_ONBOARDING_STATUS.md](PREMIUM_AND_ONBOARDING_STATUS.md)). The console lets staff **settle** a dispute by reading who holds it; it does not fix the claim problem itself (see status doc).

## 10. Canadian privacy (not legal advice)

* The Office of the Privacy Commissioner's safeguards guidance expects access to personal information to be limited to those who need it, with logging and controls proportionate to the sensitivity. Here: least-privilege roles, a written reason for every look inside an account, a log the client can read, and a client switch.
* Staff by default see **metadata** (counts, sign-in times, who the people are) but not content (positions, trips, pay, customer data) without a logged view.
* Driver location is personal information. A client's drivers are the client's employees; RouteNorth acts as the client's service provider. Government clients may require Canadian data residency and may refuse any vendor access; turn staff views off for them and say so in the data processing agreement.
* A staff account taken over is a breach risk: this is why two-factor is mandatory, why sessions are short and why step-up exists. The incident steps should be written into `docs/OPERATIONS.md` before real clients: revoke staff sessions (disable the account), check the staff audit log, tell affected clients.
* A lawyer must review the terms, privacy policy and DPA before pilots ([PILOT_AND_LEGAL.md](PILOT_AND_LEGAL.md)).

## 11. Design of the console

Same bones as the product (sidebar, top bar, breadcrumbs, cards, tables, framer-motion page transitions and count-up numbers), with an amber top rule and an "Admin" tag so it is never confused with a client's screen. Dark and light modes. Pages:

| Page | Purpose |
| --- | --- |
| Overview | The numbers that matter and the clients that need a look |
| Clients | Search and filter; open a client; New client |
| Client page | Tabs: Overview, People, Access, Account, Staff activity; View as client |
| Staff views | Every view as a client, open or finished, with end-now |
| Audit log | Filterable, expandable details, older entries |
| Staff accounts | Create, change role, reset credentials, unlock, disable (super admin only) |
| My account | Change password; how the account is protected |

Words are plain English with no jargon in the screens. The console is English only; the client product keeps its translations.

## 12. Sources

* OWASP ASVS 4.3.1 on step-up authentication for sensitive actions.
* NIST SP 800-63B-4, session management.
* WorkOS and Pigment write-ups of impersonation (consent, banner, read-only, time limits).
* Stigg's guide to entitlements (plans grant entitlements, permissions are separate).
* Office of the Privacy Commissioner of Canada, safeguards bulletin.
