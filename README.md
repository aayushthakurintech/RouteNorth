# RouteNorth

Hardware-agnostic, Canadian-hosted, bilingual (EN/FR) fleet tracking for trucks and buses.

## Layout

- `apps/web` – Next.js live map (MapLibre), English/French
- `apps/api` – NestJS API: login, live vehicles, WebSocket position stream
- `apps/ingest` – receives positions forwarded by Traccar, validates and stores them
- `apps/simulator` – drives fake trucks and buses into Traccar (no hardware needed)
- `packages/shared` – types, vehicle status logic and translations
- `packages/db` – migrations and tenant-scoped query helper (Row-Level Security)
- `apps/web/src/app/owner` – the Owner Portal (vehicles, drivers, pay rates, finance, reports, alerts). Status of every spec item: `docs/owner-portal/STATUS.md`
- Going from demo data to real data (one tracker, email, road times, phones): `docs/GO_LIVE.md`. In the app: Owner Portal, Get started, and Settings, Data sources.
- `infra/` – database init and Traccar config for local dev

## Run it in your browser

You need Node 22, pnpm and Docker (for the database and Redis).

```bash
pnpm install
docker compose up -d db redis     # Postgres + Redis. (`pnpm infra:up` also starts Traccar, not needed for the demo)
pnpm seed                         # migrations, the app database role, and a demo company with users, vehicles and a route
pnpm demo                         # builds, then starts API (4000), ingest (4100), web (3000) and the vehicle simulator
```

Then open **http://localhost:3000** and sign in (password `routenorth-demo` for all three):

| Email | Sees |
| --- | --- |
| `owner@demo.ca` | live map with three moving vehicles, history/replay, reports, routes at `/routes` |
| `driver@demo.ca` | the driver app at `/driver` (today's route, navigation links, photo and signature proof) |

Use `pnpm dev` instead of `pnpm demo` to start the same services without the simulator. Stop with Ctrl-C.
The first start takes a minute because it builds everything and Next.js compiles on first request.

To try the driver app on a phone, open it from the same network at `http://<your-computer-ip>:3000/driver`
and set `NEXT_PUBLIC_API_URL=http://<your-computer-ip>:4000` and `WEB_ORIGIN=http://<your-computer-ip>:3000` before
`pnpm demo`. Offline caching and "add to home screen" only work from a production build (`pnpm --filter @routenorth/web build && start`) served over HTTPS or localhost.

### Real hardware path

`pnpm infra:up` also starts Traccar, which receives trackers (OsmAnd on 5055, Teltonika on 5027) and forwards positions
to the ingest service. Run the simulator without `INGEST_URL` to push fake vehicles through Traccar instead:
`pnpm --filter @routenorth/simulator start`.

## Local development

Each service reads its settings from environment variables (see `src/main.ts` / `src/server.ts`):
the API needs `APP_DATABASE_URL` (or `DATABASE_URL`), `JWT_SECRET` (32+ characters) and `REDIS_URL`; ingest needs the
database and Redis; web uses `NEXT_PUBLIC_API_URL` if the API is elsewhere. Services connect as the low-privilege
`routenorth_app` role so Row-Level Security applies; `pnpm seed` creates it.

### Optional outside services

Everything below is off until you set it; the app still runs without it and shows what is missing.

| Setting | What it turns on |
| --- | --- |
| `PUBLIC_WEB_URL` | Base address used in customer links (tracking, booking, portal). |
| `ROUTING_PROVIDER` (`osrm` or `valhalla`) and `ROUTING_URL` | Road-network routing for planning. |
| `GEOCODER_URL`, `GEOCODER_CONTACT` | Address lookup (Nominatim-compatible). |
| `WEATHER_URL` (`off` disables) | Weather alerts. |
| `RESEND_API_KEY`, `EMAIL_FROM`, `EMAIL_API_URL` | Customer email. |
| `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` | Customer SMS. |
| `ENCRYPTION_KEY` | Separate key for encrypting two-factor secrets (defaults to `JWT_SECRET`). Set it in production. |
| `SUPPORT_EMAIL` | Emails messages from Help and feedback to this address (needs the email settings above). |

`pnpm seed` also re-grants table privileges to `routenorth_app`, so run it after applying new migrations to an existing database.
WhatsApp, masked calling, background push, biometrics and watch/car screens need outside accounts or native apps and are not built;
see `docs/FEATURE_PLAYBOOK_STATUS.md` for the status of every playbook item.

Backups: `pnpm backup` writes a checked dump; `pnpm restore <file>` restores into an empty database named by
`RESTORE_DATABASE_URL`. See `docs/OPERATIONS.md` (backups, incidents, status page, roadmap) and `docs/COMPLIANCE_PLAN.md`
(what exists toward SOC 2 / ISO 27001, which is not certified).

Public pages that need no sign-in: `/status`, `/roadmap`, `/security`.

Tests: `pnpm test`. Set `DATABASE_URL` to a Postgres superuser URL to also run the database
and API tests (they reset the `public` schema, so use a throwaway database).

Map tiles and fonts default to public development servers; set `NEXT_PUBLIC_TILE_URL` and
`NEXT_PUBLIC_GLYPHS_URL` to self-hosted ones for production.
