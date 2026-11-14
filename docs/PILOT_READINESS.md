# Pilot readiness: is the app ready for a real client, and how to get one running

Checked on 2026-11-14 against `main` at `dfc1f5b` (plus the grant fix in this change). Written for Aayush. It answers three questions: is the app compatible with what a pilot client needs, who could be asked to test it, and the exact steps to host it and give a client access.

## 1. Verdict

**The app is ready for a supervised pilot with one friendly client who already has GPS data. It is not ready for a municipality's formal evaluation, and it has no features specific to garbage trucks or snow plows yet.**

What that means in plain terms:

- **The core runs.** Typecheck, all tests (991 across the packages) and the production build pass. I ran the real API, ingest service and web server against a fresh Postgres and walked the pilot path by hand: sign up a company, make a GPS key, push positions, see the devices appear.
- **One real bug blocked that path and is fixed in this change.** On a database set up the documented way (`pnpm seed`), sign-up, GPS feed keys, API keys, invites and password reset all answered `500 permission denied for function`. The tests did not catch it because the test harness grants itself the permissions. See section 2.
- **Nothing was tried with a real provider, real tracker, real phone or real email.** `docs/GO_LIVE.md` already says this; it is still true.
- **Hosting does not exist yet.** The web app was deployed once on Vercel and is paused. The API, Postgres and Redis have no host, and the repo has no Dockerfiles. Section 5 is the way to host them.
- **Government-specific features are absent.** A search of the code finds nothing for waste collection, missed-collection handling, snow plow or spreader data, lift or tipper sensors, GTFS-realtime, SSO or CAN bus data. What exists is the commercial trucking and bus product: live map, trips, routes and stops, planned versus actual, reports, alerts, driver app, finance.

### Compatibility by kind of client

| Client has | Works today? | Notes |
| --- | --- | --- |
| A tracker that Traccar supports, or their own Traccar server | **Yes, as built** | Forward to `/ingest/feed/traccar?key=...`. Tested with a stand-in payload only. |
| A GPS provider that can send JSON or a webhook | **Yes, as built** | `POST /ingest/feed` with a per-company key. Tested by hand here (2 positions stored). |
| Geotab | **Built, untested with a real account** | Pull connector signs in with a MyGeotab user. Positions arrive under the Geotab device id (for example `geotab:b123`), not the vehicle's name, so an owner must match devices to vehicles by hand. Provider device names are not built. If the Geotab user has two-step sign-in turned on, the API sign-in will probably be refused; use a dedicated read-only user without it (to confirm with Geotab). |
| Samsara | **Built, untested with a real account** | Needs an API token with read access to vehicle statistics. Same device-name gap. |
| Telus (Skyhawk, FOCUS), Verizon Connect, Motive, Fleet Complete, others | **No** | Only works if the provider can forward to a web address. A pull connector per provider is not built. |
| Municipal bus CAD/AVL or GTFS-realtime | **No** | Not built, and not a good first target. |
| Waste or snow data (lift sensors, spreader rate, cameras) | **No** | Those arrive through the provider's own system. Without a connector there is nowhere to send them. |

### What a first client would still find missing

1. **Waste:** proof of service per stop, missed-collection complaints, contractor scorecards. Routes and stops with planned-versus-actual arrival is the nearest existing feature, and could stand in for a pilot if the client has stop lists.
2. **Winter maintenance:** a record of which road was serviced when, to defend claims. Trip history and replay exist; plow-specific records do not.
3. **SSO, certification, an independent accessibility report, a signed privacy agreement.** See `docs/COMPLIANCE_PLAN.md` and `docs/GOVERNMENT_MARKET_RESEARCH.md` section 7.
4. **Email.** Invites and password reset need `RESEND_API_KEY`. Without it a client who forgets a password is stuck.
5. **Self-hosted map tiles.** The map uses CARTO's free tiles, which have usage limits. Fine for a few users; set `NEXT_PUBLIC_TILE_URL` or use MapTiler for more.

## 2. The bug found and fixed

`pnpm seed` created the low-privilege `routenorth_app` role after the migrations ran. The migrations only grant execute on the lookup functions "if the role exists", so on a new database six functions were left ungranted: `find_api_key`, `find_invite`, `erase_organization`, `signup_organization`, `start_password_reset`, `finish_password_reset`. `pnpm seed` itself granted four others but not these.

Seen here before the fix: pushing positions with a valid GPS key returned an empty reply and ingest logged `permission denied for function find_api_key`; `POST /auth/signup` returned 500.

Fixed by a shared helper (`packages/db/src/app-role.ts`) that creates the role and grants execute on every function in the schema. `pnpm seed` uses it, and a new `pnpm provision` command does the same on an empty production database without adding demo users. A new test (`packages/db/src/app-role.test.ts`) starts from the new-server state and fails without the fix (checked) and passes with it. After the fix, the same push stored both positions and sign-up returned a session.

If a database was already set up with an older `pnpm seed`, running `pnpm seed` (demo) or `pnpm provision` (real) again applies the grants.

## 3. Who could be asked to test it

**Honest limit:** nobody has been identified who has said they would test it, and I have not contacted anyone. The list below is people to ask, chosen from public information about who has the problem the app solves. Nothing here says they are interested.

I also do not know where "local" is for you. This list is Ontario-wide; tell me your city and I will narrow it.

### Best first asks

1. **A small or mid-size contractor that plows snow or collects waste for a municipality.** Reason: they answer to a municipal contract, have no public tender to run, and can say yes themselves. Toronto's auditor found in 2025 that the city's snow-plow GPS dashboard has reliability problems and staff compare routes by hand, and that about 70% of snow clearing there is done by private companies. Contractors are the ones asked to prove their work ([CBC](https://www.cbc.ca/lite/story/1.7577692)). To find them: municipal council reports that award waste collection or winter maintenance contracts, and the member directory of the Ontario Waste Management Association (for example [Miller Waste's entry](https://www.owma.org/companies/miller-waste-systems-inc); Miller is large, look for the small ones).
2. **A fleet or public works manager in a small or mid-size municipality that already uses Geotab.** Public Geotab case studies name [Wellington County](https://www.geotab.com/case-study/wellington-county) (60 vehicles), [City of Port Colborne](https://geotab.com/case-study/city-of-port-colborne) (300+ pieces of equipment) and [King Township](https://www.geotab.com/case-study/king-township-public-works-transformation/) (130+ vehicles). They are examples of the right size and tooling, not leads: they are also happy Geotab reference customers who may feel well served.
3. **Geotab resellers who serve municipalities.** The case studies name Dican and Optisolve. Ask whether they want a reporting add-on to offer. They hold the customer relationship, so one conversation can reach many municipalities.

### Not first

Large cities and regions, transit agencies, school bus consortia, provincial ministries. Reasons are in `docs/GOVERNMENT_MARKET_RESEARCH.md`.

### What to ask for

A 60 to 90 day trial, 10 to 25 vehicles, read-only, one measurable pain (route proof of service, claims investigation time, or missed-stop complaints). Offer it free. Ask for a named reference at the end. Do not promise waste or plow features that do not exist yet; say what the pilot will show and what it will not.

### Short message to send (edit before sending)

> Hi [name], I'm building fleet reporting software in Ontario that works on top of the GPS you already have, so there's nothing to install. I'm looking for one [municipality / contractor] to try it free for 60 to 90 days on [10 to 25 trucks]. You'd get live position, route and stop history, and reports on [proof of service / idling / planned versus actual]. I'd ask for weekly feedback and, if it helps, a short reference at the end. Could I show you a 15 minute demo?

## 4. Decisions needed before going live

| Decision | Recommendation |
| --- | --- |
| Where to host | A Canadian region. For example AWS Montréal (`ca-central-1`), Azure Canada Central (Toronto) or Google Cloud Toronto (`northamerica-northeast2`) [general knowledge, check current region names and prices]. |
| Managed Postgres or one server | Managed Postgres 16 if the budget allows (backups and point-in-time recovery). For a first pilot, one small server running Postgres is acceptable if backups run nightly and are copied off the server. |
| Domain | One domain with three names: `app.` (web), `api.` (API), `ingest.` (positions). |
| Email provider | Resend, with a verified sender domain. |
| Who owns the pilot organization | Create the client's company yourself with their agreement, or let them sign up at `/signup`. Either way they accept the terms; the legal pages are drafts that need a lawyer's review before a real client signs. |

## 5. Steps: host it and give a client access

Tested in this review: steps 3 to 6 and the checks in step 8, run on one machine against local Postgres 16 and Redis (no PostGIS or Timescale needed). Not tested: any cloud host, Caddy, systemd, email, TLS, and the invite flow.

### Step 1. Create the servers

- **Postgres 16** with an empty database and an admin user that owns it. PostGIS and TimescaleDB are optional: the migrations use them only when available.
- **Redis 7.**
- **One server for the app** (2 vCPU and 4 GB is enough for a pilot) with Node 22 and pnpm 10.28 (`corepack enable`).
- Open ports 80 and 443 to the app server only. Keep Postgres and Redis private.

### Step 2. Get the code

```bash
git clone https://github.com/aayushthakurintech/RouteNorth.git
cd RouteNorth
pnpm install --frozen-lockfile
```

### Step 3. Write the settings file

Create `/etc/routenorth.env` (not in git). Generate secrets with `openssl rand -base64 48`.

```bash
APP_DATABASE_URL=postgres://routenorth_app:<APP_DB_PASSWORD>@<db-host>:5432/routenorth
ADMIN_DATABASE_URL=postgres://<admin-user>:<admin-password>@<db-host>:5432/routenorth
REDIS_URL=redis://<redis-host>:6379
JWT_SECRET=<48+ random characters>
ENCRYPTION_KEY=<another random value; keep a copy somewhere safe>
INGEST_TOKEN=<random value>
WEB_ORIGIN=https://app.<your-domain>
PUBLIC_WEB_URL=https://app.<your-domain>
INGEST_PUBLIC_URL=https://ingest.<your-domain>
RESEND_API_KEY=<from Resend>
EMAIL_FROM=RouteNorth <no-reply@<your-domain>>
NODE_ENV=production
```

The API and ingest must have the same `JWT_SECRET` and `ENCRYPTION_KEY`, because ingest decrypts the provider logins that the API stores. Losing `ENCRYPTION_KEY` forces everyone with two-factor on to reset it.

### Step 4. Prepare the database

```bash
DATABASE_URL=<admin url> APP_DB_PASSWORD=<same password as above> pnpm provision
```

This applies the migrations and creates the `routenorth_app` role with the right grants. Run it again after every upgrade.

**Do not run `pnpm seed` on the real server.** It creates demo users with a published password.

### Step 5. Build

```bash
NEXT_PUBLIC_API_URL=https://api.<your-domain> pnpm build
```

`NEXT_PUBLIC_API_URL` is baked into the web build, so build with the final address. For map tiles beyond a handful of users, also set `NEXT_PUBLIC_TILE_URL` (see README).

### Step 6. Run the three services

Run each under systemd (or pm2) so they restart, all reading `/etc/routenorth.env`:

| Service | Command | Port |
| --- | --- | --- |
| API | `node apps/api/dist/main.js` | `PORT=4000` |
| Ingest | `node apps/ingest/dist/server.js` | `PORT=4100` |
| Web | `pnpm --filter @routenorth/web start` | 3000 |

### Step 7. Put HTTPS in front

Caddy (automatic certificates) is the shortest route:

```
app.<your-domain>     { reverse_proxy localhost:3000 }
api.<your-domain>     { reverse_proxy localhost:4000 }
ingest.<your-domain>  { reverse_proxy localhost:4100 }
```

### Step 8. Check it

```bash
curl https://api.<your-domain>/public/system-status      # {"level":"operational", ...}
curl https://ingest.<your-domain>/health                  # ok
```

Open `https://app.<your-domain>/signup`, create your own test company, then open **Owner Portal, Settings, Data sources**. Email should say "quiet" once `RESEND_API_KEY` is set; use **Send me a test**.

### Step 9. Backups and monitoring

Schedule `pnpm backup` nightly, copy the file off the server and test a restore once (`docs/OPERATIONS.md`). Point an outside uptime check at `/public/system-status`.

### Step 10. Give the client access

1. Create their company: they sign up at `/signup`, or you sign up for them and invite them from **Users** (needs email).
2. Add their vehicles (Owner Portal, Vehicles), or let item 4 below create them from devices.
3. **Connect their GPS**, by whichever route fits (Owner Portal, Settings, Connect your GPS):
   - **They have Geotab or Samsara:** choose Connect an account. For Geotab enter server (usually `my.geotab.com`), database, a dedicated user name and password. For Samsara paste an API token with read access to vehicle statistics. Positions start arriving within a minute or two. Devices appear named by provider id; match each to a vehicle on the Trackers page.
   - **Their provider can forward or push:** make a key named after the provider. Give them the address and key the page shows (`https://ingest.<your-domain>/ingest/feed` with the key as a bearer token, or `/ingest/feed/traccar?key=...` for Traccar's forward setting).
   - **Raw trackers and no provider:** run a Traccar server (`infra/traccar/traccar.xml`), enable only the protocol the tracker uses, forward to `/ingest/feed/traccar?key=...`.
4. On the Connect page, use **Make a vehicle for each** for any device that has no vehicle yet, then rename the vehicles.
5. Invite the client's users from **Users** with the right role (owner, dispatcher, manager, viewer, driver). Drivers open `/driver` on a phone and add it to the home screen.
6. Agree how you will check in: a weekly 15 minute call, and a short list of the reports they will judge it by.

**How to tell it worked:** Data sources shows "GPS feed" or "Your existing GPS provider" as Live, the vehicles move on the live map, and the Trackers page data quality card shows readings accepted.

### If something fails

| Symptom | Likely cause |
| --- | --- |
| Sign-up, invites or GPS keys answer 500 | The app role lacks grants. Run `pnpm provision` again. |
| Web page loads, sign-in fails | `NEXT_PUBLIC_API_URL` was wrong at build time (rebuild), or `WEB_ORIGIN` does not match the web address. |
| Positions rejected with 401 | Wrong or revoked key, or ingest cannot reach the database. |
| Provider connection says login refused | Wrong database or user name, two-step sign-in on the user, or a token without the needed read access. Retries wait an hour after a refused login. |
| Devices appear but not on the map | The device is not matched to a vehicle yet (Trackers page). |
| No emails | `RESEND_API_KEY` or `EMAIL_FROM` unset or the sender domain not verified. |

## 6. What to do next, in order

1. Pick a Canadian host and stand the app up with steps 1 to 9. Create your own test company and run the checks.
2. Get one friendly client (section 3) to agree to a trial.
3. Before they connect a real provider account, try the Geotab or Samsara connector yourself against a demo or test account if you can get one, and fix what breaks. Nothing has run against a real account.
4. Build provider device names (so vehicles show their real names) and the first government feature the pilot needs: a stop-completion view for waste, or a service record per route for winter work.
5. Have the legal pages reviewed before the client signs, and get cyber and professional liability insurance in place.
