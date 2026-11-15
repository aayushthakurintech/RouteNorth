# How RouteNorth works inside

Written 2026-11-14 after reading the code. This is the map: what runs, how the web app is put together, how a tenant is kept apart from the others, and how a vehicle's data finds its way into a company's account. The exact path of one GPS position (checks, storage, screens) is in [DATA_PIPELINE.md](DATA_PIPELINE.md); this file does not repeat it.

## 1. What runs

| Part | Where | What it is |
| --- | --- | --- |
| Web app | `apps/web` | Next.js 15, React 19, Tailwind 4 with shadcn/radix primitives, MapLibre, recharts, framer-motion. Talks to the API only. |
| API | `apps/api` | NestJS. REST under `/…`, a WebSocket for the live map. Every request carries a signed token; every database call runs inside `withOrg(pool, orgId, …)`. |
| Ingest | `apps/ingest` | A small plain Node HTTP service. Accepts positions (Traccar forward, per-company feed, JSON batch) and pulls from Geotab and Samsara on a timer. Holds no business logic: it turns each source into one reading and hands it to the shared pipeline. |
| Simulator | `apps/simulator` | Drives the three demo vehicles. Demo and tests only. |
| Database | Postgres (PostGIS and Timescale when installed) | One database, every table carries `org_id`. |
| Redis | pub/sub | Fans live positions out to the API's WebSocket. |
| Shared | `packages/shared` | Pure TypeScript: connection rules, connector parsing, money, i18n, health scoring. No I/O, so it is tested without a database. |
| DB package | `packages/db` | SQL migrations (`migrations/001` to `029`), `withOrg`, secret encryption, the demo seed. |

## 2. How one company is kept apart from another

- Every tenant table has `org_id` and Row-Level Security with `FORCE`: the policy reads `app.org_id`, which `withOrg` sets for the connection. The API connects as a low-privilege role (`routenorth_app`), so a bug in a query cannot read another company's rows.
- The few places that must look across companies are `SECURITY DEFINER` functions that answer one narrow question: `resolve_device(source, id)` for ingest, `find_login(email)` for sign-in, `device_claim_state(source, id, org)` and `heard_from_unregistered(source, id)` for the Connections feature. None of them can list rows; each needs an exact ID.
- Permissions are checked in the controller with `requirePerm` / `requireAny` (roles: owner, admin, dispatcher, driver, viewer, plus custom roles).

## 3. The web app

- **One shell.** `components/shell/AppShell.tsx` is the only frame: ink sidebar with the north-arrow mark, top bar with the date range, search (Ctrl K), notifications, the phone drawer, the shortcuts, the onboarding tour and the "what's new" panel. The navigation tree is in `lib/nav.ts`. `/owner/*` and every other page use it. (Before this change the Owner Portal had its own shell and the other ~40 pages another.)
- **One token set.** `app/tokens.css` holds the colours and type that the landing page uses (ink, one blue, amber, Manrope). `app/shadcn.css` maps shadcn's variables onto them, so dark mode, high contrast and the company brand colour flow into both the older class-based pages (`app/ui.css`) and the shadcn pages. Amber is used for live status, the active nav marker and the single most important number on a page.
- **Motion.** `components/motion` wraps framer-motion: page transition, staggered lists, count-up numbers, a pulsing live dot. All of it stops when the user's reduced-motion setting (the app's `data-motion`) is on.
- **Two page styles still exist.** Pages under `app/(app)` use the older `.card` / `.btn` classes from `ui.css`; pages under `app/owner` use shadcn components. They share tokens and the shell, so they look like one product, but the old pages have not been rebuilt one by one. Wide tables scroll inside their card on a phone; the Vehicles and Connections lists switch to cards (the Devices page and the other older tables only scroll sideways inside their card).
- **i18n.** Older pages use typed message keys (`en`, `fr`, `pa`, `ar`). The owner pages and the new connection screens are English only for now.

## 4. How a vehicle's data reaches an account

A vehicle is linked to its data by a **device row**: `(source, external_id)` plus the vehicle it belongs to. Ingest looks the incoming ID up in `devices`; if there is no row, the message is dropped (and, new in 029, remembered by exact ID so the Add vehicle flow can say "we heard from that ID 4 minutes ago, it is not registered").

| Method (what the owner picks) | `devices.source` | How data arrives | Who can claim an ID |
| --- | --- | --- | --- |
| Tracker to RouteNorth (`traccar`) | `traccar` | Tracker points at the operator's Traccar host; Traccar forwards to `POST /ingest/traccar` with the shared `INGEST_TOKEN` | Globally unique. A second company trying the same ID is told it is taken, never who has it. |
| My GPS company sends it (`feed`) | `feed` | Company's own `rn_gps_…` key on `/ingest/feed` or `/ingest/feed/traccar?key=` | Unique per company. |
| Geotab account (`geotab`) | `feed` | Ingest pulls with the saved login (`provider_connections`, secret encrypted at rest); readings are tagged `geotab:<id>` | Per company. |
| Samsara account (`samsara`) | `feed` | Same, tagged `samsara:<id>` | Per company. |

`packages/shared/src/connections.ts` holds the pure rules for this: normalising and validating an ID per method (IMEI check digit), the device key (`deviceExternalId`), the plain-language setup steps, and `connectionStatus`, which turns "registered? last position? how long ago?" into one of `not_connected`, `waiting_first_ping`, `connected` (position within 15 minutes), `quiet`, `error`, each with the reason and the next step.

`apps/api/src/portal/connections.service.ts` applies those rules against the database in one transaction (create the vehicle, claim the ID, link the provider account). `POST /portal/vehicles` accepts an optional `tracker`; `POST /portal/connections/check` is the dry run the form calls as the owner types; `GET /portal/connections/overview` and `/vehicle/:id` feed the Connections page and the vehicle's Tracker tab; `/vehicle/:id/connect` and `/disconnect` move a tracker between vehicles of the same company.

## 5. What the demo seed gives you

`pnpm seed` creates "Demo Fleet Co": the original three simulator vehicles, then (`packages/db/src/demo-business.ts`) five more in every connection state (connected, quiet, waiting for first position, a feed gateway, no tracker), four more drivers, and 30 days of trips, fuel and expenses so the dashboard shows a working business. It is deterministic and does nothing the second time. Hosts shown in the Add vehicle flow come from `TRACCAR_PUBLIC_HOST`, `TRACCAR_PORTS` and `INGEST_PUBLIC_URL`; when they are not set the screen says "not set up on this server".

## 6. What is not tested against the real world

Everything above is verified with the unit and integration tests and in a browser against the simulator. None of it has run against a physical tracker, a real Traccar server, or a real Geotab or Samsara account. See [PREMIUM_AND_ONBOARDING_STATUS.md](PREMIUM_AND_ONBOARDING_STATUS.md).
