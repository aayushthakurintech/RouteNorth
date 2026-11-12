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
- **Phone pass on every Owner Portal table.** Only the shell and the new pages were checked at 390 px; wide tables were not turned into cards.
- **Partner feeds** (certified ELD, fuel-card and toll feeds, live accounting sync, card payments) are listed as "Not built" on the Data sources page, not faked.
- **Pilot owners** to try the guided start: none identified.
