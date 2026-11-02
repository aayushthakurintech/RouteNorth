# RouteNorth

Hardware-agnostic, Canadian-hosted, bilingual (EN/FR) fleet tracking for trucks and buses.

## Layout

- `apps/web` – Next.js live map (MapLibre), English/French
- `apps/api` – NestJS API: login, live vehicles, WebSocket position stream
- `apps/ingest` – receives positions forwarded by Traccar, validates and stores them
- `apps/simulator` – drives fake trucks and buses into Traccar (no hardware needed)
- `packages/shared` – types, vehicle status logic and translations
- `packages/db` – migrations and tenant-scoped query helper (Row-Level Security)
- `infra/` – database init and Traccar config for local dev

## Local development

```bash
pnpm install
pnpm infra:up                       # Postgres+PostGIS+TimescaleDB, Redis, Traccar
pnpm build
DATABASE_URL=postgres://routenorth:routenorth@localhost:5432/routenorth pnpm --filter @routenorth/db migrate
```

Then run each service (see the environment variables each reads in `src/main.ts` / `src/server.ts`):

```bash
# API (port 4000): needs DATABASE_URL, JWT_SECRET (32+ chars), REDIS_URL
# ingest (port 4100): needs DATABASE_URL, REDIS_URL
# web (port 3000): pnpm --filter @routenorth/web dev   (NEXT_PUBLIC_API_URL if the API is elsewhere)
# simulator: pnpm --filter @routenorth/simulator start  (TRACCAR_URL, default http://localhost:5055)
```

Tests: `pnpm test`. Set `DATABASE_URL` to a Postgres superuser URL to also run the database
and API tests (they reset the `public` schema, so use a throwaway database).

Map tiles and fonts default to public development servers; set `NEXT_PUBLIC_TILE_URL` and
`NEXT_PUBLIC_GLYPHS_URL` to self-hosted ones for production.
