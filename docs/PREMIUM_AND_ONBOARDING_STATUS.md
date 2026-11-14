# Premium look, one shell, tracker onboarding: status

Updated 2026-11-14. Plan: [PREMIUM_AND_ONBOARDING_PLAN.md](PREMIUM_AND_ONBOARDING_PLAN.md). Research: [MARKET_AND_CONNECTION_PLAN.md](MARKET_AND_CONNECTION_PLAN.md). How it works: [INTERNALS.md](INTERNALS.md).

## What is done

| Area | State | How it was checked |
| --- | --- | --- |
| Add a vehicle with its tracker | Done. Three-step flow (vehicle, tracker, connect). Four methods: tracker to RouteNorth (IMEI), your GPS company sends it (feed key), Geotab account, Samsara account. The ID is checked as the owner types (IMEI check digit, already registered, taken by someone else). | API tests, and the flow driven in a real browser against the running API at 1440 and 390 wide |
| Connection status per vehicle | Done. `not_connected`, `waiting_first_ping`, `connected` (position in the last 15 minutes), `quiet`, `error`, each with the reason and the next step. On the vehicle's Tracker tab and on a fleet-wide Connections page. | Shared unit tests (every state and method), API tests, screenshots of every state with seeded vehicles |
| Claim rule | Done. An ID registered by one company cannot be registered by another, and the second company is never told who has it. A company can move a tracker between its own vehicles. | API tests with two organizations |
| "We heard from that ID" | Done. Ingest remembers IDs nobody registered (exact-ID lookup only, nothing can list them, purged after 7 days or 20,000 rows) so the flow can say a tracker is reaching us but is not registered. | Ingest and API tests |
| Provider vehicles | Done in code. For Geotab and Samsara the owner picks the vehicle from the provider's own device list instead of typing an ID. | Unit test with a faked provider response only |
| One shell | Done. The Owner Portal shell is gone; every page uses `AppShell` with the same navigation, top bar, search, phone drawer, shortcuts, tour and what's-new. | Screenshots; 22 pages checked at 390 wide for page-level sideways scrolling (none) |
| "North" design | Done for the shell, tokens, buttons, cards, dialogs, the dashboard overview, Vehicles, Connections, Add vehicle. Landing and app read the same colours and type. One hero tile per page (ink, amber rule). Numbers count up once; motion respects the reduced-motion setting. | Screenshots at 1440 and 390 |
| Demo data | Done. Eight vehicles in every connection state, five drivers, 30 days of trips, fuel and expenses, so the dashboard is not zeros. | `pnpm seed` run twice (second run changes nothing) |
| Dashboard "Needs your attention" | New items for trackers that stopped reporting and vehicles with no tracker, linking to Connections. | Screenshot |

## What is not done

- **Older pages are re-skinned, not rebuilt.** The 40 pages under `app/(app)` (Live, Dispatch, Devices, Jobs, Routes and so on) pick up the new tokens, shell and fonts through `ui.css`, but their layouts are the old ones. They are readable on a phone (no sideways page scroll) but tables only scroll inside their card; they are not redesigned as cards.
- **Date range is hidden on phones.** The top-bar date-range picker is not shown below 860 px, so a phone user cannot change the dashboard range.
- **Owner pages and the new connection screens are English only.** The older pages are translated (en, fr, pa, ar).
- **Dark mode and high contrast** use the same tokens but were only spot-checked, not reviewed page by page.
- **Competitor prices** in the market doc come mostly from third-party review sites; the doc lists what was not verified.

## Security review of the new endpoints (gstack /cso, static, scoped to five files)

Complete coverage was not possible: the review was limited to the connections controller and service, the vehicle create path, migration 029 and the ingest store. The auth guard, the connector HTTP client and the ingest HTTP handlers were not read, and no scanner or runtime check ran (offline, no Docker). Three findings, none rated high:

| Finding | Severity | State |
| --- | --- | --- |
| A tracker ID is claimed first-come with only its IMEI (printed on the device, not secret) as proof, and the new "we heard from that ID" hint tells a caller when an unregistered ID is live. A company that knows a victim's IMEI could register it first and receive its positions. The first-come claim was already possible before this branch; the hint makes it easier to time. | Medium | **Open.** Needs a proof-of-possession step (for example a one-time code the tracker must send) or operator approval of a claim on an ID seen unregistered. Decide before real customers share one Traccar host. |
| `ingest_unknown_ids` was readable by the application role although the design says it cannot be listed. | Low | **Fixed** in this branch: the table has row-level security with no policy; ingest writes through `record_unregistered()` and the API asks through `heard_from_unregistered()`. A test checks the application role cannot read or write the table. |
| `/check` and `/connect` tell a caller whether an ID is taken by another company, and each call may use the company's provider API quota, with no limit. | Low | **Fixed in part:** 60 checks a minute per user, answered 429 after that (in memory, per API process). The "taken" answer is kept on purpose so an owner can tell a typo from a clash. |

Not assessed, worth a follow-up: whether the Geotab server setting an owner enters can point the API's outbound request at an internal address (the new vehicle-list call reuses it).

## What has not been tested against the real world

- No physical tracker has been connected. No real Traccar server has forwarded to the ingest service. No real Geotab or Samsara account has been called. The "Connect" step proves our side of the chain (ID format, ownership, saved login, reachability of our addresses); it cannot prove that a device in a vehicle is sending.
- RouteNorth does not run a public Traccar server. The tracker-to-RouteNorth method shows setup steps only when the operator sets `TRACCAR_PUBLIC_HOST` (and optionally `TRACCAR_PORTS`, `INGEST_PUBLIC_URL`); otherwise it says it is not set up on this server and points to the other methods. The hosts in the demo screenshots are placeholders.
- Email, SMS, Slack, Teams and VIN decoding still never run for real, as before.

## Checks run on this branch

- `pnpm typecheck`: clean.
- `pnpm test`: shared 304, sdk 9, db 5, simulator 4, ingest 36, web 169, api 495, all passing. Note: the API tests reset the `public` schema of whatever `DATABASE_URL` points to, so run them against a throwaway database, not the demo one.
- `pnpm build`: passes (7 packages).
- Browser checks with Chromium (Playwright): dashboard, Vehicles, Connections and the Add vehicle flow at 1440 and 390 wide; sideways-overflow scan of 22 pages at 390.

## Still to do before a paying customer

Real-hardware test with at least one Teltonika or Queclink tracker through a Traccar host; a Geotab demo database and a Samsara sandbox token to test the pull path; a redesign of the Live map and Dispatch screens; phone date-range control; translations of the owner pages; the items in [GO_LIVE.md](GO_LIVE.md) (hosting, backups, monitoring) that are still open.
