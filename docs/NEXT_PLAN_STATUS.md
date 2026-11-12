# Data and experience plan: what is built and what is not

Built and tested in the repository (API tests, shared tests, a desktop and 390 px browser pass against the seeded demo):

| Item | State |
| --- | --- |
| Data sources health page (`/owner/settings/data-sources`, `GET /portal/data-sources`) | Built. Live, quiet, needs setup, not connected, problem or not built for each source, with the next step and the server setting that is missing. |
| "Send me a test" email | Built. Sends only to the person who asks. Works only once `RESEND_API_KEY` is set. |
| Guided start (`/owner/start`) | Built. Three paths (trackers, drivers' phones, spreadsheets) whose steps tick themselves off from real data. |
| Freshness line on the dashboard | Built. Says plainly when positions are demo-only or stale. |
| Empty states with a next step | Built on trips, finance, invoices, payouts, margin. Reports has a "Start here" row. |
| Role homes | Built. Owners land on `/owner`; dispatchers and drivers keep their own homes. |
| Shared menu entries | Built. Owner Portal has Live map, Dispatch and Get started; the older menu has an Owner Portal entry. |
| Phone header overflow in the Owner Portal | Fixed (the top bar overflowed by about 70 px on a phone). |
| `docs/GO_LIVE.md` | Written. |

## Not done, and why

- **One real tracker, one real email, real road times, real phones.** These need hardware, accounts or servers outside this repository. Nothing was run against them. `docs/GO_LIVE.md` says how to do each and how to tell it worked.
- **A single shell.** The Owner Portal and the older app are still two shells. They are linked by shared menu entries and role homes, not merged.
- **Phone pass on every Owner Portal table.** Checked on 2026-11-12: every Owner Portal list page plus the vehicle, driver and report-builder pages, signed in as the demo owner at 390 px, have no page-level sideways scroll (lists switch to cards on phones). Detail tabs, pay-run pages and dialogs were not each opened, and no real phone was used.
- **Partner feeds** (certified ELD, fuel-card and toll feeds, live accounting sync, card payments) are listed as "Not built" on the Data sources page, not faked.
- **Pilot owners** to try the guided start: none identified.

## Added after the "software, not hardware" direction

| Item | State |
| --- | --- |
| Per-company GPS keys and feed endpoints (`/ingest/feed`, `/ingest/feed/traccar`) | Built and tested (ingest 31, API 475 tests) and checked end to end against a running ingest service with a stand-in sender. Not tried with a real provider. |
| Connect your GPS page (`/owner/settings/connect-gps`) | Built. Make and switch off keys, copy-paste setup for a web push and for Traccar, new devices, one click to make vehicles. Checked in a browser at 390 px and desktop. |
| Geotab and Samsara pull connectors (`provider_connections`, migration 028; `/portal/provider-connections`; ingest worker) | Built (Phase 3). An owner signs in to their own Geotab or Samsara account on the Connect your GPS page; the login is checked with the provider, stored encrypted (AES-256-GCM) and the ingest service pulls new positions every minute from where it last stopped, with back-off on errors and an hour's wait after a refused login. Tested against recorded response shapes and a fake provider (shared 12, ingest 4, API 4 new tests), **not against a real customer account**. Geotab servers are limited to `*.geotab.com`. Needs `JWT_SECRET` (or `ENCRYPTION_KEY`) on the ingest service, the same as the API. |
| Other provider API connectors (Motive, Verizon Connect and similar) | Not built. |
