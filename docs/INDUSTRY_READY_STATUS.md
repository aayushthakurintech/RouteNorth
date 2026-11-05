# Industry-ready pass: what was done and what is not verified

Seven phases on top of the playbook and owner-portal branches. This page is written so a reviewer can tell what was run from what was only written.

## Built

| Area | What changed |
| --- | --- |
| Data path | `docs/DATA_PIPELINE.md`: how a GPS fix goes from tracker to screen, every check on the way, where each value is shown. Demo history now includes driver shifts, breaks and routes so the hours-of-service screens have data. |
| Charts and reports | Charts draw at their real pixel width, have a table view, tooltip and crosshair, and use a palette validated for colour-blind separation. New StatTile, BarList and Meter parts. Reports in tabs (Distance, Idling, Utilization, Fuel); Hours of service tab under Safety. |
| Auth | Redesigned login, sign-up (company, consent, password strength), forgot and reset password (links expire in 60 minutes, reset signs out other sessions, the response never says whether an email exists), branded 404 and error pages. Server: rate limit on sign-up, consent version recorded. |
| Landing page | `/` is now the marketing page (English and French): hero, features, product showcase, how it starts, sample reviews, pricing with a vehicle-count estimate, FAQ, call to action, footer. The live map moved to `/live`; every link and redirect was updated. Share image, robots and sitemap added. |
| Legal | `/terms`, `/privacy`, `/accessibility` in English and French, linked from sign-up and the footer. See `docs/COMPLIANCE_PLAN.md`. |

## Checks that were run

- Typecheck and lint on all packages; production build of all apps.
- Unit tests: shared 274, web 169, sdk 9, db 5, simulator 4. API 458 of 461 pass (see below).
- axe-core accessibility scan: no violations on the landing, auth, legal, Devices, Reports and Safety pages at 390 px and 1280 px widths, light and dark (the sweep over the signed-in pages was run in earlier phases; the landing and legal pages were re-run after the last change).
- Screenshots reviewed by eye at 390 px and 1440 px, English and French, light and dark, for the landing page.

## Known failure

`apps/api/src/portal/pay.test.ts` has three failing tests. They are in the owner-portal pay code from the earlier branch, not in this work. They depend on the weekday: today is a Thursday and the tests build a "last seven days" run that straddles two calendar weeks, so a weekly bonus rule does not match. Fix the test dates or the rule window before merging.

## Not verified or not built

- **Prices are placeholders** (Starter $9 per vehicle, Pro $49 plus $15 per vehicle, Enterprise $199 plus $12 per vehicle). Payments and billing are not built; the free trial needs no card.
- **Reviews are samples**, labelled "Sample review" on the page. Replace them with real ones as customers write them.
- **Legal text is a draft** and needs a lawyer. The company name, privacy officer and support emails and governing province come from environment variables and show a placeholder until set.
- **No email provider was exercised.** With none configured, a reset link is only logged by the server in development.
- Real trackers, a real Traccar server, real phones and live map tiles were not connected; only the simulator and recorded payload shapes were.
- Browser checks were automated and visual; no one clicked through every form, and no assistive-technology user or independent audit has tested the pages.
- SSO, a certified ELD, native store apps and SOC 2 / ISO certification are not built or held.
- The share image was drawn in code, not with Canva; the Canva connector was not needed for this.
