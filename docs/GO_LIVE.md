# Going live with real data

The product runs end to end on the demo (`pnpm seed`, `pnpm demo`). This page is the short path from demo data to one real vehicle, one real email and real road times. **Nothing here was run against real hardware or real accounts**; each step says how to tell it worked, and the owner's **Data sources** page (`/owner/settings/data-sources`) shows the same checks live.

Order matters: do 1 and 2 first. Steps 3 to 5 each stand alone.

## 1. Run it somewhere real

Host the database, API, ingest service and Traccar in a Canadian region (data residency is a selling point; see `docs/COMPLIANCE_PLAN.md`). Backups and the settings that matter in production are in `docs/OPERATIONS.md`.

| Service | Setting | Notes |
| --- | --- | --- |
| API | `APP_DATABASE_URL` (or `DATABASE_URL`), `JWT_SECRET` (32+ characters), **`ENCRYPTION_KEY`** (32+ characters, different from `JWT_SECRET`), `PORT` | Required. In production the API refuses to start without its own `ENCRYPTION_KEY`; it protects stored two-factor seeds and GPS provider logins. To rotate it, move the old value to `ENCRYPTION_KEY_PREVIOUS` and set the new one; old values keep reading. Before this release, values were protected with `JWT_SECRET`: set `ENCRYPTION_KEY_PREVIOUS` to the old `JWT_SECRET` once so they still read, or have people re-enter them. |
| API | `PUBLIC_WEB_URL`, `WEB_ORIGIN` | Used for links in emails and for cross-origin access. |
| Ingest | `APP_DATABASE_URL`, `REDIS_URL`, `PORT`, **`INGEST_TOKEN`**, `ENCRYPTION_KEY` (same value as the API) | With `NODE_ENV=production` the ingest service refuses to start without `INGEST_TOKEN`. Outside production, without it, it accepts unauthenticated requests and the JSON batch endpoint is off. GPS provider pulls need `ENCRYPTION_KEY` in production. |
| Web | the API address used by `apps/web/src/lib/session.ts` | Set before building. |

Worked when: **Data sources** loads and every row has an honest state (most will say "not connected" or "needs setup").

## 2a. Customers who already have a GPS provider (the usual case)

RouteNorth is software, not hardware: a customer keeps its trackers and its provider.

1. Set `INGEST_PUBLIC_URL` on the API to the public HTTPS address of the ingest service, so the Connect page shows the right address.
2. The owner opens **Settings > Connect your GPS** and makes a key for the provider.
3. The owner (or the provider) sends positions to the address shown: a JSON push to `/ingest/feed`, or Traccar's forward feature pointed at `/ingest/feed/traccar?key=...`.
4. Each device appears on the Connect page on its first position. **Make a vehicle for each** creates vehicles named after the device ids, or the Trackers page matches devices to vehicles the customer already has.

Worked when: the page lists the device with a recent position, Data sources shows "Your existing GPS provider" as Live, and the vehicle is on the live map. Not verified: any real provider. If a provider has only its own API and cannot forward, nothing works yet; that connector has to be built.

## 2. One real tracker (the step that matters most)

Path: tracker, then your Traccar server, then `POST /ingest/traccar` on the ingest service. Details of everything the ingest service checks on the way are in `docs/DATA_PIPELINE.md`.

1. **Add the vehicle** in the owner portal (Vehicles, Add vehicle).
2. **Register the tracker** on the Trackers page (`/devices`): enter its ID (the IMEI) and pick the vehicle. A tracker nobody registered is counted and ignored; that is how one company is kept from landing in another.
3. **Configure Traccar** (`infra/traccar/traccar.xml` is the development example):
   - Enable only the protocol port your tracker uses (the example opens `osmand` 5055 and `teltonika` 5027).
   - Forward to the ingest service with the shared secret: `forward.url` = `https://<your-ingest-host>/ingest/traccar?token=<INGEST_TOKEN>`, with `forward.json` = `true`.
   - In production set `database.registerUnknown` to `false`. It is `true` in the example so demo devices work without registration.
4. **Point the tracker** at the Traccar host and port (done on the tracker with its vendor's tool or SMS commands).

Worked when, within a few minutes: the vehicle appears on the live map, **Data sources** shows "GPS trackers: Live", and the Data quality card on the Trackers page shows readings accepted. If it says "problem", the page shows how long since the last position; if readings are refused, the Trackers page lists the reason (bad satellites, impossible jump, and so on).

Not verified: real Traccar forwarding, real tracker protocols. Only the simulator and recorded payload shapes were used.

## 3. Real email

Set `RESEND_API_KEY` and `EMAIL_FROM` on the API (a sender address on a domain you have verified with the provider). Optionally `SUPPORT_EMAIL` for help messages.

Worked when: **Data sources**, row "Email", says "quiet" instead of "needs setup", and **Send me a test** puts a message in your inbox. This also switches on alert emails, the morning digest, driver and report emails, invites and password-reset links.

## 4. Real road times and address search

- **Routing**: run an OSRM or Valhalla server and set `ROUTING_URL` and `ROUTING_PROVIDER` (`osrm` or `valhalla`) on the API. Without them ETAs use straight-line distance times 1.3 at 40 km/h plus 5 minutes per stop. Truck limits (height, weight, hazmat) are sent only to Valhalla.
- **Address search**: set `GEOCODER_URL` (a Nominatim-compatible service) and `GEOCODER_CONTACT` on the API. Without it stops need coordinates.

Worked when: the rows "Road routing and ETAs" and "Address search" on **Data sources** say "Live". Both were tested only against stand-in servers.

## 5. Drivers' phones

The driver app is a web app (installable) at `/driver`. It shares position only while it is open, and works offline for stop updates and proof photos. Invite a driver from Drivers; when they start a shift, **Data sources** shows "Driver app: Live".

Not verified: any real phone. A native app is needed for background tracking; it is not built.

## 6. Partner feeds (not built)

These need contracts or accounts outside this repository, so they are listed on **Data sources** as "Not built" rather than faked:

- **Certified ELD** for official hours of service (through a certified provider). The hours screens are estimates until then.
- **Fuel-card and toll feeds.** Statement CSV import works today.
- **Live accounting sync** (QuickBooks, Xero, Sage). CSV exports work today.
- **Card payments** (Stripe or PayPal) for billing.

Order should follow what the first pilot customers ask for.

## Known dependency advisories

`pnpm audit` still lists advisories in `vitest` and its `tinypool` and `@vitest/mocker` dependencies. They are test-only tools and never ship to a server or browser. The runtime advisories (multer, postcss, maplibre-gl) are fixed: maplibre-gl is on 6.x, and multer and postcss are pinned through `pnpm.overrides` in the root `package.json`.
