# Hosting the web app on Vercel

What runs where:

| Part | Where | Notes |
| --- | --- | --- |
| Web app (`apps/web`, Next.js) | Vercel | Landing page, legal pages, sign-in screens, Owner Portal screens. |
| API (`apps/api`, NestJS, WebSockets) | A host that runs a long-lived Node process | Vercel functions cannot hold WebSocket connections open. |
| Ingest, Postgres (PostGIS/Timescale), Redis | Same place as the API | For the Canadian-hosting promise, pick a Canadian region. |

Without a reachable API the landing, pricing and legal pages work, but sign-in, the live map and every data screen show an error.

## Project settings

The repository has `apps/web/vercel.json`. In the Vercel project:

- **Root Directory:** `apps/web`
- **Include source files outside of the Root Directory:** on (default) so `packages/shared` is available.
- Install and build commands come from `vercel.json` (pnpm install at the repo root, then `turbo run build --filter=@routenorth/web`, which builds `@routenorth/shared` first).

## Environment variables

| Name | Value |
| --- | --- |
| `NEXT_PUBLIC_API_URL` | Public HTTPS URL of the API, for example `https://api.example.ca` |
| `NEXT_PUBLIC_SITE_URL` | The site's own URL (used for the sitemap and share image) |
| `NEXT_PUBLIC_COMPANY_NAME`, `NEXT_PUBLIC_PRIVACY_EMAIL`, `NEXT_PUBLIC_SUPPORT_EMAIL`, `NEXT_PUBLIC_GOVERNING_PROVINCE` | Legal pages |
| `NEXT_PUBLIC_TILE_URL`, `NEXT_PUBLIC_TILE_URL_DARK`, `NEXT_PUBLIC_TILE_URL_SATELLITE`, `NEXT_PUBLIC_GLYPHS_URL` | Map tiles. The default is the public OSM server, which is for development only. |

`NEXT_PUBLIC_*` values are baked in at build time: change one, then redeploy.

The API must allow the Vercel URL as a browser origin (CORS) and use HTTPS, since a page served over HTTPS cannot call a plain-HTTP API.

## Checked

`pnpm turbo run build --filter=@routenorth/web` passes from a clean install. Plain `next build` inside `apps/web` fails until `@routenorth/shared` is built, which is why `vercel.json` goes through turbo.
