# Pilot readiness and the legal side (Canada)

Written 2026-11-14. Part 1 comes from reading the code. Part 3 is a **research summary, not legal advice**. A Canadian privacy and employment lawyer must review the terms, the privacy policy, the data processing agreement and the way drivers are told about tracking before any paying or pilot client's drivers are tracked. Facts checked against an official or law-firm page on the date above carry a link; everything else is marked "to confirm".

---

## 1. What really happens when a client adds an IMEI or a provider login

### Wired end to end (works in tests, in a browser, and with the simulator)

| Step | What the code does |
| --- | --- |
| Owner enters an IMEI on Add vehicle | The ID is cleaned and checked (15 digits, IMEI check digit). The API checks whether another company holds it. The vehicle and a `devices` row (`source = traccar`) are saved in one transaction. |
| A position for that ID arrives at the ingest service | Ingest looks the ID up, drops it if nobody registered it, otherwise converts units, applies the quality checks, stores it, updates the vehicle's latest position and pushes it to the live map. |
| The screen | Within 15 minutes of a first position the vehicle shows Connected. Before that it shows Waiting for first position, with what to check. A vehicle with an old last position shows Quiet. |
| Geotab or Samsara | The owner saves a login on Connect your GPS (stored encrypted). Add vehicle lists the provider's own vehicles for the owner to pick. The ingest service polls each saved login on a timer (the loop ticks every 15 s; each login has its own schedule and back-off on errors) and stores the readings under the vehicle. |
| A company's own GPS provider or Traccar | The company gets a key and posts to `/ingest/feed` (JSON) or points Traccar's forward at `/ingest/feed/traccar?key=`. Unknown devices are created for that company. |

### Not wired, or needs someone to set up, before a real tracker shows up

1. **There is no production Traccar server.** The repo only has a development one (`docker-compose.yml`, `infra/traccar/traccar.xml`): an embedded test database, and only two protocol ports open (OsmAnd 5055, Teltonika 5027). A client with Queclink, Concox, Ruptela or anything else needs that protocol's port enabled in `traccar.xml` **and** published and opened in the firewall, on a host with a public IP or DNS name. Trackers speak plain TCP or UDP to that port; there is no TLS between tracker and server.
2. **RouteNorth does not register devices inside Traccar.** In the dev file `database.registerUnknown` is `true`, so Traccar accepts any device and RouteNorth then drops the ones nobody added. `docs/GO_LIVE.md` tells operators to set it to `false` for production. Do that and Traccar will refuse every tracker nobody registered **in Traccar's own database**, which nothing in RouteNorth does today, so a newly added IMEI would never get through. Until a "register in Traccar" step is built, production must keep `true` (accepting internet junk into Traccar's database) or an operator must add each device by hand. This is the biggest gap in the tracker path and `GO_LIVE.md` should be corrected.
3. **The ingest shared secret.** With `INGEST_TOKEN` unset, the ingest service accepts unauthenticated posts (the log says so). In production it must be set, and Traccar's `forward.url` must carry it. Otherwise anyone who can reach the ingest port can post positions for any registered ID.
4. **Operator settings for the screens.** `TRACCAR_PUBLIC_HOST`, `TRACCAR_PORTS` (for example `Teltonika:5027,OsmAnd:5055`) and `INGEST_PUBLIC_URL` must be set, otherwise the Add vehicle flow says the tracker method is not set up on this server.
5. **Configuring the tracker itself is manual.** Someone must put a data SIM in it, set the APN, the server address and the port (vendor tool or SMS command), and power it with a view of the sky. RouteNorth cannot send those commands.
6. **Hosting.** Nothing is deployed anywhere public yet (the Vercel hosting thread is separate and the API, ingest, Traccar, Postgres and Redis need a host that allows long-running processes and open TCP ports).
7. **Pull providers are untested against real accounts.** Geotab needs the database name, user and password of an account allowed to read device data; Samsara needs an API token with read scope for vehicle locations. We read GPS positions only. Engine faults, fuel and driver ID are not pulled today. Provider rate limits and per-integration fees are not accounted for.
8. **What the panel's "check" proves:** the ID format, who holds it, that a saved provider login can list vehicles, and whether we have heard from that ID. It cannot prove that the physical device is sending.
9. **Known security gap:** an IMEI is the only proof of ownership when claiming a tracker (open finding in [PREMIUM_AND_ONBOARDING_STATUS.md](PREMIUM_AND_ONBOARDING_STATUS.md)).
10. **Not built:** an ELD or hours-of-service record, SMS or email delivery to real people, accounting sync, fuel and toll feeds.

So, to the direct question: yes, the code path exists, and if a Traccar server is reachable with the right port, the tracker is pointed at it and the IMEI is registered, the position will arrive and display. No real tracker has done this yet. Do the pilot in Part 2 to find out what breaks.

---

## 2. What to ask a pilot client for

**About the fleet**
- Which vehicles go in the pilot (3 to 10 is plenty): type, plate, and who normally drives each.
- Whether any driver is covered by a union or collective agreement, and which province(s) they drive in (interprovincial or cross-border changes the privacy and ELD rules, see Part 3).

**About their current tracking** (pick the one that applies)
- *They already pay a GPS provider:* which one; whether they can give read-only API access (Geotab: database, a dedicated user; Samsara: a read-only token) or can forward data to us; their contract's rules about third-party access.
- *They run their own Traccar server:* its address, and whether they can add a forward to our ingest URL.
- *They have bare trackers:* make and model of each (Teltonika, Queclink, Concox and so on), the IMEI printed on each, whether a data SIM is fitted and who the carrier is, and who can change its server setting (installer, vendor, the client).

**To make a hardware test meaningful**
- At least one tracker in a vehicle that is driven daily, with permission to watch the first week.
- A named person at the client who can reach the installer or the vendor the same day.
- Agreement that drivers are told about tracking before it starts (Part 3).

**On our side before the pilot starts**
- A host with the Traccar ports open and `INGEST_TOKEN` set, a registered sender domain if email alerts are wanted, and a written pilot agreement (Part 3).

**What to record**: time from power-on to first position, positions lost per day, cases where the vehicle shows Quiet while parked, the provider's delay, and every point at which the client had to ask for help.

---

## 3. The legal side in Canada

### 3.1 Who is responsible for what
- The **fleet company (the client)** decides why drivers are tracked, so it is normally the organization that answers to privacy law. RouteNorth is the service provider that handles that data for it, and is also responsible for its own account data (names, emails, sign-in records). Where RouteNorth is the service provider, the contract must say so (to confirm with counsel: Quebec's Act requires a written agreement with the provider).
- **Location tied to an identifiable driver is personal information.** The Privacy Commissioner of Canada has dealt with employer GPS in work vehicles: it was accepted for dispatch, safety and asset protection, and using GPS data for routine performance management was treated as an intrusion that needs exceptional circumstances ([PIPEDA Findings 2006-351](https://priv.gc.ca/en/opc-actions-and-decisions/investigations/investigations-into-businesses/2006/pipeda-2006-351)). Design and marketing should stay on dispatch, safety, maintenance and asset protection, not on watching individuals.

### 3.2 Which law applies (to confirm with counsel)
| Where | Law | Notes |
| --- | --- | --- |
| Federal, and every province without its own law | PIPEDA | Covers commercial activity. Employee information is covered only for federally regulated employers, which includes interprovincial and cross-border trucking and bus lines (to confirm). |
| Quebec | Act respecting the protection of personal information in the private sector, as changed by Law 25 | Covers employees too. Most obligations in force since 22 Sep 2023 ([McCarthy](https://www.mccarthy.ca/en/insights/blogs/techlex/sweeping-privacy-reform-comes-force-quebec)). |
| Alberta, British Columbia | PIPA (each has its own) | Both cover employee information of provincial private-sector employers (to confirm). |
| Ontario | No general private-sector privacy law for employee data (to confirm) | But employers with 25 or more employees must have a written electronic monitoring policy, which names GPS as an example, says how and why monitoring happens, and goes to employees within 30 days; policies are kept three years after they end ([Ontario ESA guide](https://www.ontario.ca/document/your-guide-employment-standards-act-0/written-policy-electronic-monitoring-employees)). |

### 3.3 Quebec Law 25 points that touch this product
From the [McCarthy summary](https://www.mccarthy.ca/en/insights/blogs/techlex/sweeping-privacy-reform-comes-force-quebec) (Oct 2023):
- A technology that locates, identifies or profiles a person requires telling that person about it and how to activate it (art. 8.1). How this applies to employer-issued vehicle trackers is a question for counsel.
- Before communicating personal information of people in Quebec **outside Quebec**, a privacy impact assessment is required, and the written agreement must reflect it (art. 17). Hosting in Canada outside Quebec still counts as outside Quebec.
- Fines: administrative penalties up to the greater of CAD 10 million or 2% of worldwide turnover; penal fines up to the greater of CAD 25 million or 4%, doubled for repeat offences.
- Policies with roles, retention and a complaints process (art. 3.3). A person must be named as responsible for privacy (already planned in [COMPLIANCE_PLAN.md](COMPLIANCE_PLAN.md); not re-verified here).
- The driver safety score is shown with its formula and is meant to inform a person; keep it that way (it is in the draft privacy notice).

### 3.4 What a client must do about its drivers (and our contract should say so)
- Tell drivers in advance what is tracked, why, and how long it is kept; get consent where the law requires it. Written notice, not a hallway announcement.
- Ontario, 25+ employees: the written monitoring policy above.
- Limit tracking to working time (the product has a setting to track only during shifts), and agree what happens to personal use of a vehicle.
- Check collective agreements: some limit monitoring.
- Product features that help: tracking only during shifts, retention in days, person export and erase, organization delete, audit log ([COMPLIANCE_PLAN.md](COMPLIANCE_PLAN.md)). They help the client comply; they do not make the client compliant.

### 3.5 Data residency
- No general Canadian rule requiring private-sector data to stay in Canada was found in this pass (to confirm). Quebec needs the assessment above; public-sector clients (school boards and transit agencies are typical bus customers) often require Canadian hosting by contract or policy (to confirm per client).
- Practical choice: host the database and backups in a Canadian region, list every sub-processor (hosting, email provider, map tiles, error tracking) and where each runs, and say it in the privacy policy. Counsel should confirm the cross-border wording.

### 3.6 Documents to have before a pilot
1. **Terms of service** and **privacy policy** (drafts exist at `/terms` and `/privacy`, marked as drafts; the company name, privacy contact and governing province must be set).
2. **Data processing agreement** with each client: purposes, sub-processors, location, security measures, breach notice time, return or deletion at the end, audit rights.
3. **Pilot agreement:** scope, duration, no uptime promise, data deleted at the end, limit of liability, client's duties toward its drivers.
4. **Sub-processor list** and an **incident response plan** (below).
5. French versions for Quebec customers (Charter of the French Language; to confirm which documents).
6. Insurance: cyber and errors-and-omissions (ask a broker).

### 3.7 Breach reporting (checked against [McCarthy, May 2026](https://www.mccarthy.ca/en/insights/publications/navigating-the-legislative-landscape-on-data-breaches-2026-data-breach-insights-part-3))
| Law | Report and notify when | Records |
| --- | --- | --- |
| PIPEDA | "Real risk of significant harm": report to the Privacy Commissioner and notify the people | Keep a record of every breach for 24 months |
| Alberta PIPA | Same kind of test: report to the commissioner. Individuals are told when the commissioner directs, though notifying together is usual | Not covered in the source |
| BC PIPA | Not mandatory at the time of that article (voluntary) | Not covered |
| Quebec | "Risk of serious injury": report to the Commission and notify the people (in force since 22 Sep 2022) | Register of all incidents, 5 years |

The client is usually the one who must report; the service provider's contract should make us tell the client fast (set a number of hours) and keep our own log.

### 3.8 ELD and hours of service
- Electronic logging devices became mandatory in Canada on 12 June 2021 for federally regulated drivers who keep a record of duty status; enforcement without penalty until 1 Jan 2023; enforcement is a provincial and territorial job. Devices must be tested and certified by a certification body accredited by Transport Canada ([Transport Canada](https://tc.canada.ca/en/road-transportation/electronic-logging-devices/eld-handout-motor-carriers-drivers)). Some exemptions apply (for example local operation within 160 km of the home terminal with a daily return, and model years before 2000).
- RouteNorth is **not** an ELD and must not be described as one or as "hours-of-service compliant". The plan stays: connect to a certified ELD provider (a later phase), not build one.

### 3.9 CASL (email and text)
- Messages that are marketing need consent, identification and a working unsubscribe. Service messages (alerts a client switches on, invites, password resets) are different, but where the line falls for messages from an employer to drivers is a question for counsel. The draft privacy notice already says no marketing email is sent today and marketing needs the opt-in box. Penalties are large (to confirm the current figures). Email, SMS, Slack and Teams delivery still never runs for real.

### 3.10 Provider and software terms
- **Geotab and Samsara:** read their developer or partner terms before connecting a client's account with a stored login. Many contracts restrict third-party access or require a marketplace or partner agreement, and may charge for it. Not reviewed in this pass.
- **Traccar** is open source (Apache 2.0 per the project's README, as cited in [MARKET_AND_CONNECTION_PLAN.md](MARKET_AND_CONNECTION_PLAN.md)). Keep its notices. Map tiles and address search have their own usage and attribution terms.

### 3.11 What to take to a lawyer
Terms, privacy policy and DPA drafts; the pilot agreement; the wording for telling drivers; the Quebec impact assessment for hosting outside Quebec; whether the client or RouteNorth must name a privacy officer; how art. 8.1 applies; CASL treatment of alerts to drivers; French-language obligations; and limits of liability.
