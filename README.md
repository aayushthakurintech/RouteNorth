# RouteNorth

Hardware-agnostic, Canadian-hosted, bilingual (EN/FR) fleet tracking for trucks and buses.

## Layout

- `apps/` – web, api, workers (added in later steps)
- `packages/shared` – types and logic shared by every app
- `infra/` – database init and Traccar config for local dev

## Local development

```bash
pnpm install
pnpm infra:up   # Postgres+PostGIS+TimescaleDB, Redis, Traccar
pnpm test
```
