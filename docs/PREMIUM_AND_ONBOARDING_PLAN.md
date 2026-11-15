# Premium look, one shell, and tracker-ID onboarding: the plan

Written 2026-11-14. Branch `claude/project-thread-2n48nh`. Status of each phase is kept in `docs/PREMIUM_AND_ONBOARDING_STATUS.md` as work lands.

Aayush's findings this plan answers:

1. An owner cannot add a vehicle together with its tracker. There is no field for a tracking number, and nothing in the app says how a vehicle's data gets connected.
2. The owner needs a manual connection panel in the UI: pick the provider or protocol, enter the device ID or credentials, test it, and see the state.
3. The look is simple and generic. The landing page is the quality bar; the app should feel like the same company.
4. Research the competitors, say how RouteNorth is sold as a service, and explain how the app really connects to a vehicle.

## What is wrong today (from reading the code and screenshots)

| Finding | Evidence |
| --- | --- |
| **Two shells.** Owner Portal (`/owner/*`) uses a shadcn sidebar; everything else (`/live`, `/dispatch`, `/devices`, 40 pages) uses the older `AppShell`. Moving between them changes the whole frame, the menu and even the logo treatment. | `components/portal/OwnerShell.tsx`, `components/shell/AppShell.tsx`, two layouts |
| **Two design systems.** `tokens.css` + `ui.css` (606 lines, hand-written) for old pages, shadcn + Tailwind for the portal, a third look on the landing page (`landing.css`: ink navy, amber, big Manrope numerals, north-arrow motif). The app uses none of the landing page's colour or type character. | `app/ui.css`, `app/shadcn.css`, `components/landing/landing.css` |
| **No tracker on the vehicle form.** `VEHICLE_FIELDS` has 40 fields, none is a tracker. A tracker is registered on a different page (`/devices`) by a different action, and the vehicle page says "Add a device under Settings". | `apps/api/src/portal/vehicles.defs.ts`, `apps/web/src/app/owner/vehicles/[id]/page.tsx:310` |
| **No connection status per vehicle.** `devices.health` exists, but nothing explains "waiting for first ping" or what to do when a tracker stays silent. A tracker ID that was never registered is dropped silently by ingest (counted by source only). | `apps/ingest/src/store.ts`, `apps/api/src/vehicles/devices.controller.ts` |
| **Providers are not selectable per vehicle.** Geotab and Samsara pull connections exist (`provider_connections`) but a pulled device lands as an anonymous `feed` device named after the provider's id; the owner has to find it and attach a vehicle by hand. | `apps/ingest/src/connectors.ts`, `gps-connect.controller.ts` |
| Wide tables on phones, a vehicle list headed "Car" for a truck and bus company, an empty-looking dashboard for the demo company. | screenshots in `docs/design/before/` |

How data flows today is written up in `docs/INTERNALS.md`.

## Design direction: "North" (the landing page, carried into the app)

Reference: the landing page (ink navy `#0a2540`, one blue `#0f5fa8`, amber `#f2a900`, off-white `#f7f8fa`, Manrope display type with tight tracking, big numerals, flat filled tiles, 6 px corners, the north arrow as the one motif). Craft references used for structure, not copied: shadcn/ui (primitives we already ship), Linear and Vercel (quiet density, keyboard-first, hairline borders, motion that explains rather than decorates), Cal.com and Plane (settings and onboarding patterns), Tremor (KPI and chart layout). The `design-md-library` skill's Linear, Vercel and Stripe design systems and the `design-taste` skill's anti-slop rules are the checklist.

Rules we hold ourselves to:

- One token set. Landing and app read the same CSS variables, so a change moves both.
- Ink sidebar (dark navy) with the north arrow mark, amber used for exactly three things: live status, the active indicator, and the single most important number on a page. Blue is the action colour.
- Numbers are the hero. KPI tiles use Manrope numerals, count up once, and say what changed.
- No purple gradients, no glass cards, no emoji icons, no decorative blobs, no identical card grids. Empty states say what to do next and have an action.
- Motion with framer-motion: page transitions, staggered list entry, shared-layout sidebar indicator, number count-up, animated connection steps, spring dialogs. All of it respects the reduced-motion setting the app already has (`data-motion`).

## Phases

Each phase ends with typecheck, tests, a build, and screenshots of the running app (desktop 1440 and phone 390). gstack reviews (`/plan-design-review`, `/review`, `/design-review`, `/qa`, `/cso`) run at the phase boundaries where they apply; their findings are recorded in the status doc.

### Phase 0: Foundation and plan (this document)
- Deep analysis of internals (`docs/INTERNALS.md`).
- Research: competitors, pricing, selling, how the connection really works (`docs/MARKET_AND_CONNECTION_PLAN.md`).

### Phase 1: Design system "North"
- New tokens in `tokens.css` that match the landing page; shadcn variables point at them; dark mode kept; high-contrast mode kept.
- `framer-motion` added; a small `components/motion` kit: `PageTransition`, `Stagger`, `CountUp`, `Reveal`, `Pulse`, all reduced-motion aware.
- Restyled primitives: Button, Card, Badge, Tabs, Table, Dialog, Sheet, Input, Select, Sidebar, Skeleton, Sonner toasts.
- New composed parts: `PageHeader`, `KpiTile`, `StatusDot`, `EmptyState` (with action), `NorthMark` (logo).
- The older `ui.css` classes are re-skinned from the same tokens so unmigrated pages do not look like a different product.

### Phase 2: One shell
- One `AppFrame` (sidebar, top bar, command menu, notifications, phone bottom bar and "More" sheet) used by both layouts. One navigation tree, grouped: Overview, Operate, Fleet, People, Money, Reports, Setup.
- The old shell's features are kept (shortcuts, onboarding tour, what's new, favourites, locale switch, language), moved into the frame rather than dropped.
- Wide tables on phones: horizontal scroll inside the card with a visible edge fade and a card layout for the vehicle, device and driver lists.

### Phase 3: Vehicle onboarding and the connection panel (backend + UI)
Backend (API + ingest, one migration):
- `POST /portal/vehicles/onboard`: creates a vehicle and registers its tracker in one transaction. Input: vehicle basics plus `{ method, trackerId, providerConnectionId? }`.
- A **connection resolver** (`@routenorth/shared`, pure, tested) turns "method + ID" into: a device source and normalised external ID (IMEI check digit validation, Samsara/Geotab id shapes, Traccar unique id), a plain-language setup instruction set, and the expected data path.
- Methods: `traccar` (tracker points at RouteNorth's Traccar host, or the customer's own Traccar forwards), `feed` (customer key, provider or gateway pushes), `geotab` and `samsara` (pull with the saved login, the vehicle's provider id selected from the provider's own device list), `phone` (driver app as the tracker).
- `POST /portal/connections/check`: checks ID format, whether it is already claimed (by this company or, without saying who, another), provider login and device list for pull providers, whether the server operator has configured the public ingest and Traccar addresses, and whether RouteNorth has heard from that ID recently even though it was not registered (new `ingest_unknown_ids`, exact-ID lookup only, no listing).
- `GET /portal/connections/vehicle/:id`: one status per vehicle: `not_connected`, `waiting_first_ping`, `connected`, `quiet` (reported before, silent now), `error`, each with a plain-language reason and the one next step.
- A claim rule so one company cannot take another's tracker ID, and a company can move a tracker between its own vehicles.

UI:
- **Add vehicle** becomes a three-step flow: the vehicle (name, type, plate), the tracker (method cards, ID field with live format check, where to find the number), and a live connection step that animates through "registered, listening, first ping" and tells the owner exactly what to do if nothing arrives.
- **Connection panel** on every vehicle page and a fleet-wide **Connections** page: method, ID, credentials, a Test button, status history, and a fix list in plain language.
- Vehicles list gets a Connection column and a "needs a tracker" view.

### Phase 4: Premium pass over the pages owners use daily
Dashboard, Vehicles list and detail, Live map shell and panel, Dispatch, Drivers, Finance, Reports, Settings, Connect GPS, Data sources, Get started, Login and sign-up. Demo data is enriched so screenshots show a working business instead of zeros.

### Phase 5: Verify and review
- `pnpm typecheck`, `pnpm test`, `pnpm build`, a Playwright pass over the main flows at 1440 and 390, light and dark.
- gstack `/review` on the diff, `/design-review` on screenshots, `/cso` on the new endpoints, `/qa` on the add-vehicle flow.
- Honest status doc: what is done, what is untested, what needs real hardware.

## Constraints and honesty

- Nothing here is tested against a real tracker, a real Traccar host, or a real Geotab/Samsara account. The connection panel's "Test" proves our side of the chain (format, claim, credentials, reachability), not that a physical device is sending.
- RouteNorth does not run a public Traccar server yet. The panel shows the Traccar address only when the operator sets `TRACCAR_PUBLIC_HOST`; otherwise it says "not set up on this server" and offers the feed or provider methods.
- No hardware is sold or recommended as a product. The doc lists common trackers only so owners know what they can bring.
- Competitor prices in the market doc are cited with sources and dates; anything unverified says so.

## Not in this plan

SSO, certified ELD, payments, native store apps, fuel and toll feeds, accounting sync, SOC 2. They stay "not built" as in the existing status docs.
