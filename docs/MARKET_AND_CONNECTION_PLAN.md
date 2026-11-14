# RouteNorth: Market, Pricing and Vehicle Connection Plan

Research date: 2026-11-14. Author: research analyst pass (desk research only).

**Read this first.**
- Nothing in this document has been tested against real hardware, a real Traccar server, or a real provider account. Every "how it works" statement in section 5 comes from public documentation and must be proven in the checks listed in section 6.
- Competitor prices come mostly from third-party review sites (ExpertMarket, CostBench, Subger, GPS Insight's blog), not from vendor price lists. Most vendors do not publish prices. Each number below carries its source and date. Where a number could not be verified it says "not verified".
- Numbers marked **PROPOSAL** or **ASSUMPTION** are ours, not market facts.
- Currency: sources often do not say whether "$" is CAD or USD. I say so when the source says so, and "currency not stated" otherwise.

Product direction (fixed): RouteNorth does not sell GPS hardware. Customers keep their existing GPS devices or providers. RouteNorth connects to them (provider API, a Traccar server, data forwarding, or a phone app) and sells owner dashboards, dispatch, driver app and reports as SaaS. ELD is delivered by integrating certified ELD providers, not building one.

---

## 1. Competitor snapshot

### 1.1 Summary table

| Vendor | Sells to | Hardware bundled? | Known price signal (source, date) | Contract | Canada / ELD | Third-party API |
|---|---|---|---|---|---|---|
| Samsara | SMB to enterprise | Yes (gateway + subscription) | From about CA$37/vehicle/month; CA$135-200 per gateway ([ExpertMarket, 24 Sep 2025](https://www.expertmarket.com/ca/fleet-management/best-telematics)). US list tiers $27 / $33 / $50 per vehicle per month, flagged "unverified" ([CostBench, verified 11 Jul 2026](https://www.costbench.com/software/fleet-management/samsara/)) | 3 years minimum per ExpertMarket; CostBench says no auto-renew and a 3-year minimum "to verify" | Canadian ELD certified Dec 2, 2021 via FPInnovations ([Samsara CA blog](https://www.samsara.com/ca/blog/samsara-compliance-solution-now-certified-for-the-canadian-eld-mandate)). Has a CA developer portal region ([Samsara partner support](https://developers.samsara.com/docs/partner-support)) | Yes, open REST API and OAuth 2.0 |
| Geotab | SMB to enterprise via resellers | Yes (GO devices, sold by resellers) | Not published. Reseller-set pricing ([CostBench, 3 Nov 2026](https://costbench.com/software/fleet-management/geotab/)) | Not verified | ELD devices GOELD1-4 listed on [Transport Canada list](https://tc.canada.ca/en/road-transportation/electronic-logging-devices/list-electronic-logging-devices) (query date 11 Nov 2026) | Yes, public MyGeotab SDK |
| Motive | Trucking, construction, field | Yes (ELD/vehicle gateway, AI dashcams sold separately) | Not published. CostBench derives about $35/vehicle/month, hardware $200-500 per vehicle, 12-month minimum, none of it from Motive ([CostBench, 5 Nov 2026](https://www.costbench.com/software/fleet-management/motive/)) | 12 months minimum (CostBench, 1 source) | Listed on Transport Canada ELD list (MOTIV1, MOTIV2) | Yes, but terms restrict competing products (see 1.3) |
| Fleetio | Maintenance and asset management | No hardware | $4 annual / $5 monthly (Essential), $7 (Professional), $10 (Premium) per vehicle per month, currency not stated ([Fleetio pricing page, fetched 14 Nov 2026](https://www.fleetio.com/pricing)) | Monthly on Essential, annual only above | Not an ELD. Integrates telematics through an app directory | Yes. API 50 req/min mid tier, 250 req/min top tier; webhooks 10,000 per 30 days mid tier, unlimited top tier |
| Verizon Connect | SMB to mid | Yes, hardware "included" per CostBench FAQ (conflicting) | From about CA$32/vehicle/month on 3-year term; US$150 hardware service fee per swap ([ExpertMarket, 24 Sep 2025](https://www.expertmarket.com/ca/fleet-management/best-telematics)) | 3 years standard | Canadian presence not verified. Geotab bought Verizon Connect's international commercial operations on 1 Oct 2025 (nine markets listed, none in North America) ([Automotive Fleet](https://www.automotive-fleet.com/news/geotab-buys-verizon-connects-international-commercial-operations)) | Not verified |
| Fleet Complete (now Powerfleet per its API page) | SMB to enterprise | Yes | Third-party quote CAD 30-60/vehicle/month, no separate citation ([Subger, page marked Nov 2026](https://subger.com/en/service/fleet-complete)). Treat as not verified | Not verified | ELD devices (BigRoad and FC models) on Transport Canada list | Yes, APIs "free of charge" to clients, token via api.fleetcomplete.com ([Fleet Complete API page](https://www.fleetcomplete.com/api)) |
| Teletrac Navman (TN360) | Mid-market | Yes | Base about US$25/vehicle/month, roughly CA$35 ([ExpertMarket, 12 Nov 2025](https://www.expertmarket.com/ca/fleet-management/teletrac-navman-review)) | 12 to 60 months, 3 years typical | "TN360 ELD is listed by Transport Canada" per ExpertMarket. I did not find it in the first 100,000 characters of the TC list page | API request form for TN360 or DIRECTOR accounts, aimed at integration partners ([Teletrac Navman](https://www.teletracnavman.com/support/api-request)) |
| GPS Insight | SMB | Yes | Own prices not published. Article gives market ranges: $15-20 entry, $25-45 mid, $50+ premium; OBD from $39.95, hardwired $100-299+ ([GPS Insight blog, updated 13 Oct 2026](https://www.gpsinsight.com/blog/gps-fleet-tracking-pricing-cost-per-vehicle/)) | Month-to-month offered | Canadian presence not verified | Not verified |
| Linxup | US SMB | Yes | $25/vehicle/month; $69 plug-in tracker month-to-month, free on 3-year; ELD $30/vehicle/month plus $99 tablet on 3-year; currency not stated, US-based ([Linxup pricing](https://www.linxup.com/pricing), fetched 14 Nov 2026) | None / 2 / 3 years | Canadian presence not verified | Not verified |
| Azuga | US SMB | Yes | US$25 / $30 / $35 per vehicle per month; CAD$35-48 also quoted ([ExpertMarket, 24 Sep 2025](https://www.expertmarket.com/ca/fleet-management/best-telematics)) | 3 years | Not verified | Developer portal exists ([azuga.com/developers](https://azuga.com/developers)); terms not read |
| RAM Tracking | SMB (appears in ExpertMarket Canada article) | Yes, free install claimed | Example about US$15.99/vehicle/month for software plus dashcam bundle (ExpertMarket, 24 Sep 2025, same article) | "More flexible" per article, no numbers | Canadian presence not verified | Not verified |
| Wialon (Gurtam) | Resellers and integrators; hardware-agnostic | No, platform only | Quote-based; "monthly subscription and average number of connected vehicles"; activation-code billing available ([Wialon pricing](https://wialon.com/en/pricing)) | Monthly or activation codes | Not verified | Yes, API and SDK mentioned; terms not published on that page |
| Traccar (open source) | DIY, resellers | No, server software only | Self-host free (Apache 2.0, [README](https://cdn.jsdelivr.net/gh/traccar/traccar@master/README.md)); hosted account from $9.95/month, dedicated server from $49.95/month, currency not stated ([Traccar pricing](https://www.traccar.org/pricing/)) | 7-day trial | Not applicable | REST API and forwarding built in |
| Zonar (school bus) | School districts, bus contractors | Yes | A bundle "starting at $20 per month" appears in a 2014 article ([STN, 13 Jun 2014](https://stnonline.com/news/zonar-releases-monthly-subscriptions-for-school-bus-telematics-bundling)). Stale, do not use for pricing | Not stated | MyView parent app launched in Canada, data stored on Canadian cloud servers, 13 Mar 2024 ([Zonar](https://www.zonar.com/news-events/press-releases/zonar-expands-myview-school-bus-tracking-app-in-canada)) | Not verified |

Not found or not verified at all in this pass: Pointer (search returned only generic company pages, no Canadian offer confirmed), Trackimo-style consumer-grade trackers (no source read), CarrierFleet-style local resellers (none identified by name with a source), Vontas, Synovia/Tyler and other school-bus routing vendors in Canada (search returned US-centred material only).

### 1.2 What the table tells us

1. **The market norm is hardware-bundled, 3-year, quote-based.** Samsara, Verizon Connect and Azuga are all reported at 3-year minimums (ExpertMarket, 24 Sep 2025). Motive is reported at 12 months (CostBench, 5 Nov 2026). Month-to-month exists mostly at the cheap end (Linxup, GPS Insight).
2. **Hardware-free software is a real and priced category.** Fleetio sells per-vehicle software with no hardware at $4-$10 per vehicle per month (Fleetio pricing page). It is maintenance-focused, so it is a possible partner rather than a direct competitor.
3. **Cheap bundles exist and set a floor.** Reported entry bundles run $15-20 per vehicle per month (GPS Insight article) and about US$15.99 for RAM's software-plus-dashcam example (ExpertMarket). A software-only product has to be cheaper than the software portion of those bundles, not just cheaper than Samsara.
4. **Hardware cost data is weak.** The only Samsara hardware figure in this pass is CA$135-200 per gateway (ExpertMarket) and an unverified Reddit comment of "1500-2500$ per device" quoted by CostBench (Feb 2025). Those two conflict by an order of magnitude. I would not publish either to customers without a written quote.
5. **Canadian ELD certification is third-party.** Devices must be certified by an accredited body (COMDriver Tech, FPInnovations, CSA Group are named) and the Transport Canada list had 117 entries when queried (TC page, 11 Nov 2026). This is why RouteNorth should integrate certified ELD providers rather than certify its own.

### 1.3 API openness: what a third party can actually pull

This matters more than any price, because the "bring your own GPS" product depends on it.

| Provider | How a third party gets access | Rate limits found | Terms that matter to us | Verdict |
|---|---|---|---|---|
| Samsara | Customer admin creates an API token (Settings, API Tokens) with tag access and granular read scopes, one token per integration, shown once ([auth docs](https://developers.samsara.com/docs/authentication)). Partners use OAuth 2.0; the customer approves, access token lasts 1 hour, refresh tokens are single use, scopes `admin:read` / `admin:write` ([OAuth docs](https://developers.samsara.com/docs/oauth-20)) | 150 req/s per token, 200 req/s per organization. Endpoint level, per organization: `fleet/vehicles/locations` 25 req/s, `locations/feed` 50 req/s, `stats` 50 req/s; legacy `v1/fleet/vehicles/locations` 5 req/s. HTTP 429 with `Retry-After` ([rate limits](https://developers.samsara.com/docs/rate-limits)) | Technology Partner Program. Samsara says it "won't block or remove an app from our marketplace just because it competes with our own products" ([program page](https://developers.samsara.com/docs/technology-partner-program)). Integration Partner Terms not read | Most open of the big three. Customer-pasted token works on day one; OAuth listing is the scalable route |
| Geotab | MyGeotab public API (JSON over HTTP). Results reflect the authenticated user's access, so create a dedicated read-only service user per customer ([intro](https://developers.geotab.com/myGeotab/introduction/)). Marketplace and partner program exist | Limits are per method, entity, username and database, multiplied by fleet size tier: x1 up to 1,000 assets, x5 to 10,000, x15 to 25,000, x25 above. Prefer `GetFeed` over `Get`; wait at least 1010 ms between calls if you add waits; exponential backoff on `OverLimitException`; `X-Rate-Limit-*` response headers ([rate limits](https://developers.geotab.com/myGeotab/guides/rateLimits)). Base per-method numbers are in the SDK reference, which I did not read | Partner policies do not set API rules; they point to a Partner Account Manager. Customer data must stay in separate databases ([partner policies](https://support.geotab.com/en-GB/mygeotab/doc/partner-policies)). Geotab sells through authorized resellers, who set their own price (CostBench) | Technically open. Commercial terms for a competing dashboard need confirming with Geotab |
| Motive | OAuth 2.0 authorization code flow only on the page I read. A developer account must first be set up with Motive support. Access token lasts 7,200 s ([OAuth page](https://developer.gomotive.com/reference/authentication-oauth-20)) | Terms say Motive may cap transactions and change limits at any time. The vehicle-locations v3 page notes "10 simultaneous requests at a time" ([endpoint page](https://developer.gomotive.com/reference/vehicle_locationsid-v3)) | API Terms last updated 8 Jul 2025: licence is for "Internal Use" only; Internal Use "explicitly excludes publishing or making available any Developer App"; distributing to third parties needs Motive's prior written authorization at its sole discretion; no creating "a substitute for or substantially similar product or service"; user data only for your own Internal Use ([Motive API Terms](https://gomotive.com/legal/api-terms-of-service/)) | **Highest risk.** A SaaS dashboard for third-party Motive customers likely needs a written agreement. Do not build on Motive data in production until counsel and Motive confirm |
| Fleet Complete / Powerfleet | Token from api.fleetcomplete.com, "free of charge" to clients; separate integration partner form ([API page](https://www.fleetcomplete.com/api)) | Not published on that page | Not published | Open to customers; partner terms unknown |
| Teletrac Navman | Request form for a TN360 or DIRECTOR account; for integration partners ([form](https://www.teletracnavman.com/support/api-request)). Positions described as available for routing partners | Not stated | Not stated | Gated by request. Timeline unknown |
| Verizon Connect, GPS Insight, Linxup | Not verified | Not verified | Not verified | Assume closed until proven otherwise |
| Traccar | Own server, so no third-party gating | You set limits | Apache 2.0 | Fully open, and it is the only source we fully control |

**Key conclusion.** Samsara and Geotab are realistic API sources. Motive is contractually risky. Everyone else is unknown. The universal fallback is a tracker that can send directly to a server we control, which is why Traccar-style ingestion is the foundation rather than an extra.

---

## 2. Where RouteNorth fits

### 2.1 The wedge: "bring your own GPS"

RouteNorth is the software layer. The owner keeps whatever tracker is already in the vehicle, and RouteNorth supplies the owner dashboard, dispatch, driver app, reports and customer tracking links, at a per-vehicle monthly price with no hardware and (proposed) no long lock-in.

Three customer situations, in order of how well the wedge works:

| Situation | Fit | Why |
|---|---|---|
| A. Fleet with cheap standalone trackers (Teltonika, Queclink, Concox/Jimi class) on a basic provider, SIM already active | Best | They pay twice today (a tracker vendor portal plus spreadsheets). We can take the tracker feed directly and replace the portal |
| B. Fleet on a Geotab reseller or Samsara, unhappy with the dashboard, dispatch or price | Medium | We pull via API. They still pay the original provider, so our software is additive cost unless the provider's software fee can be dropped. Many contracts bundle hardware and software, which makes a clean split unlikely (not verified for any named provider) |
| C. Fleet with no tracker | Weak for us directly | They need hardware first. Refer to a hardware partner or installer, not sell it ourselves |

### 2.2 Who it is for

- Small to mid Canadian trucking carriers (about 5 to 100 trucks) that already have a tracker but poor software.
- School-bus contractors and charter or shuttle operators with mixed hardware across depots and acquisitions.
- Owner-operators with a few units who need a simple owner view and driver app, with ELD handled by a certified partner.
- Local installers and GPS resellers who want a white-label front end for trackers they already install.

### 2.3 Honest risks

1. **Data supply depends on competitors' terms.** Motive's API terms (8 Jul 2025) exclude distributing apps to third parties without written approval. Any provider can change rate limits or terms. We must keep a direct-ingest path (our own server) as the primary product, and treat provider APIs as convenience connectors.
2. **We may be paying twice for the customer.** In situation B the customer keeps paying the original provider. Our pitch must be "better workflow", not "cheaper", unless the customer can renegotiate.
3. **Cheap bundles set the floor.** If the all-in bundled price is about CA$20 per vehicle per month or less, we lose on price (worked out in 3.5). Sell workflow, bilingual support, Canadian hosting and no lock-in instead.
4. **Support burden is real.** "Connect your tracker" fails for dull reasons (SIM data, wrong port, wrong protocol). Support cost per vehicle in month one will be high.
5. **No hardware means no install revenue and no lock-in.** Churn can be easier than for hardware vendors. That is also the pitch.
6. **ELD dependence.** The ELD box is often the only GPS source in the truck. If the ELD vendor blocks the feed (Motive-style terms), we cannot see that truck.

---

## 3. Pricing and packaging recommendation (Canadian dollars)

Everything in this section is a **PROPOSAL** to be tested with pilot customers. None of these numbers come from the market.

### 3.1 Tiers

| | Core | Fleet | Pro |
|---|---|---|---|
| Price per vehicle per month, billed annually (PROPOSAL) | CA$8 | CA$14 | CA$20 |
| Price per vehicle per month, billed monthly (PROPOSAL) | CA$10 | CA$17 | CA$24 |
| Live map, trip history, geofences, ignition and speed alerts | Yes | Yes | Yes |
| History retention | 90 days | 12 months | 24 months |
| Owner dashboard and standard reports (mileage, idling, stops) | Basic | Full, scheduled email | Full, scheduled email, API export |
| Dispatch (jobs, assign driver, status) | No | Yes | Yes |
| Driver app seats | 2 per account | Unlimited | Unlimited |
| Maintenance reminders | No | Yes | Yes |
| Customer tracking links (share a live link with a client or parent) | No | Add-on | Included |
| Route and stop schedules, multi-depot, school-bus views | No | No | Yes |
| Support | Email, 1 business day | Email and chat | Chat, onboarding call, bilingual (EN/FR) |

### 3.2 Commercial terms (PROPOSAL)

| Term | Proposal | Reason |
|---|---|---|
| Free trial | 30 days, up to 10 vehicles, no card | Self-serve connect needs time to see real data across a billing cycle |
| Minimum | CA$99 per account per month | Covers fixed support and ingest cost for tiny accounts |
| Annual discount | About 20 percent versus monthly (the annual prices above) | Cash flow, lower churn |
| Contract | Month-to-month or 12-month annual. No 3-year lock-in | Direct contrast with 3-year bundled contracts |
| Setup fee | CA$0 self-serve. Assisted onboarding CA$250 flat per fleet | Matches the "connect in 15 minutes" promise while covering a white-glove option |
| Billable vehicle | A vehicle is billable in a month only if it sent at least one valid position that month (see 5.9) | Customer does not pay for dead trackers. Aligns our price with delivered value |
| Seasonal pause (buses) | Pro bus fleets can pause July and August at CA$0 | School buses sit idle; bundled competitors bill all year (assumed, not verified) |
| Price lock | Held for 12 months, then 60 days written notice of changes | Trust signal |
| Currency and tax | CA$; GST/HST/QST added per province | Canadian buyers expect this |

### 3.3 Add-ons (PROPOSAL)

| Add-on | How it is priced | Note |
|---|---|---|
| ELD via certified partner | Pass-through of the partner's price. Our margin or referral fee: not verified, depends on partner agreement | Reference points only: Linxup lists ELD at $30 per vehicle per month plus a $99 tablet on a 3-year term, currency not stated ([Linxup](https://www.linxup.com/pricing)). Partner must appear on the [Transport Canada ELD list](https://tc.canada.ca/en/road-transportation/electronic-logging-devices/list-electronic-logging-devices) |
| Extra driver app seats (Core only) | CA$2 per seat per month | Fleet and Pro already unlimited |
| Customer tracking links on Fleet | CA$2 per vehicle per month | Included on Pro |
| Historical retention extension | CA$1 per vehicle per month per extra 12 months | Only if storage cost justifies |
| Assisted onboarding | CA$250 flat | See 3.2 |
| Managed Traccar endpoint (we host your device ingest) | Included on every tier | It is our product, not an add-on |
| Hardware introductions | Referral only, no resale | Keeps the "no hardware" promise |

### 3.4 How to pitch against hardware-bundled competitors

1. "Keep the trackers you already own. We replace the software, not the hardware."
2. "No 3-year contract. Cancel with 30 days' notice on monthly, or at the end of your annual term."
3. "You only pay for vehicles that actually reported this month."
4. "Canadian company, Canadian hosting, English and French."
5. "Your data comes out whenever you want it" (CSV and API export on Pro).
6. Do not claim to be cheaper than every bundle. Show the 36-month total cost table in 3.5 and let the buyer enter their own competitor quote.

### 3.5 Worked example: 36 months, RouteNorth versus a bundled competitor

**Competitor assumptions (ASSUMPTION, illustrative, use a real written quote in sales):**
- Software: CA$37 per vehicle per month. This is Samsara's "from" price in Canada (ExpertMarket, 24 Sep 2025). It is a "from" price, not a quote.
- Hardware: CA$200 per vehicle. This is the top of the CA$135-200 gateway range (same source).
- Install: CA$100 per vehicle (hardwired install "about $100", [ExpertMarket 2023 article](https://www.expertmarket.com/ca/fleet-management/costs), currency not stated).
- 3-year term, billed all 36 months. ELD, dashcams and taxes excluded on both sides.

**RouteNorth assumptions (ASSUMPTION for the parts that are not our price):**
- Customer buys its own tracker: CA$120 per vehicle (assumed; real OBD trackers vary. For scale, GPS Insight lists OBD devices from $39.95 and hardwired $100-299+, currency not stated).
- Self-install, CA$0.
- SIM data plan: CA$10 per vehicle per month for 36 months (assumed placeholder, not verified, replace with a real Canadian IoT SIM quote).
- RouteNorth software at PROPOSAL annual prices: Fleet CA$14 for trucks, Pro CA$20 for buses. Assisted onboarding CA$250 flat.

**10-truck fleet, 36 months**

| Line | Bundled competitor (assumed) | RouteNorth + own trackers |
|---|---|---|
| Software | 37 x 10 x 36 = CA$13,320 | 14 x 10 x 36 = CA$5,040 |
| Hardware | 200 x 10 = CA$2,000 | 120 x 10 = CA$1,200 |
| Install | 100 x 10 = CA$1,000 | CA$0 |
| SIM data | Included in bundle (assumed) | 10 x 10 x 36 = CA$3,600 |
| Onboarding | CA$0 | CA$250 |
| **Total** | **CA$16,320** | **CA$10,090** |
| Difference | | Saves CA$6,230 (about 38 percent) |

**40-bus fleet, 36 months**

| Line | Bundled competitor (assumed) | RouteNorth Pro + own trackers | RouteNorth Pro with Jul/Aug pause |
|---|---|---|---|
| Software | 37 x 40 x 36 = CA$53,280 | 20 x 40 x 36 = CA$28,800 | 20 x 40 x 30 = CA$24,000 |
| Hardware | 200 x 40 = CA$8,000 | 120 x 40 = CA$4,800 | CA$4,800 |
| Install | 100 x 40 = CA$4,000 | CA$0 | CA$0 |
| SIM data | Included (assumed) | 10 x 40 x 36 = CA$14,400 | CA$14,400 (SIM kept active, assumed) |
| Onboarding | CA$0 | CA$250 | CA$250 |
| **Total** | **CA$65,280** | **CA$48,250** | **CA$43,450** |
| Difference | | Saves CA$17,030 (about 26 percent) | Saves CA$21,830 (about 33 percent) |

**Break-even (10 trucks).** Our all-in cost per vehicle is (10,090 / 10) = CA$1,009 over 36 months. The competitor all-in is P x 36 + 300 (hardware plus install). Break-even P = (1,009 - 300) / 36 = about CA$19.70 per vehicle per month. If a bundled competitor's all-in rate is at or below roughly CA$20, RouteNorth plus own trackers is not cheaper. Entry bundles reported at $15-20 (GPS Insight article) are in that zone, so price alone will not win those deals.

**Case where the customer keeps an existing provider (situation B in 2.1).** Our software is additive: 10 trucks at Fleet tier is CA$5,040 over 36 months (CA$14 x 10 x 36), on top of whatever they already pay the provider. We must win on workflow, not price. Do not present this as a saving.

---

## 4. How to sell it as SaaS

### 4.1 Ideal customer profile

| Attribute | Target |
|---|---|
| Fleet size | 5 to 100 vehicles. Under 5 is not worth support cost at the CA$99 minimum. Over 100 needs a sales-led process |
| Segments | Regional trucking carriers, school-bus contractors, charter and shuttle, construction and trades with trucks |
| Existing tracking | Already has trackers or a reseller portal they dislike |
| Buyer | Owner or operations manager, not an IT department |
| Triggers | Contract renewal coming up, new vehicles being added, hardware 3G sunset forcing replacement (Bell plans nationwide 3G shutdown in early 2027, Manitoba 31 Dec 2025 per [iPhone in Canada, 14 Oct 2025](https://www.iphoneincanada.ca/2025/10/14/bell-pushes-back-its-3g-shutdown-heres-the-new-timeline/); Telus and Rogers dates not stated in that article), an audit or incident, a customer or school board asking for live tracking |
| Disqualifiers | Fleet entirely on a locked provider with no API and no way to redirect the tracker; buyer wants hardware supplied |

### 4.2 Channels

| Channel | How it works | Status |
|---|---|---|
| GPS installers and local resellers | They already install Teltonika/Queclink/Concox-class trackers and run a portal. We give them a white-label or referral-priced dashboard. They keep install and SIM revenue, we take software | Partner terms to design. No named reseller verified |
| Trucking associations | Webinars, member discounts, ELD and compliance education. Provincial associations exist (e.g. Ontario Trucking Association, Alberta Motor Transport Association, Association du camionnage du Québec) but I did not verify any partnership programs | Not verified |
| School-bus contractors and associations | Contractors serve districts under contract and want parent-facing tracking. Zonar's Canadian MyView launch (Mar 2024) shows demand for parent apps | Pursue pilots, sell Pro tier |
| ELD partners | Co-sell: ELD partner provides certified logs, we provide dispatch and owner views | Partner agreements needed |
| Direct self-serve | Website, 30-day trial, connect in 15 minutes | Core motion for situation A fleets |
| Fleetio and similar | Maintenance software integrates with telematics; possible two-way integration | Not verified, explore |

### 4.3 Sales motion

1. Prospect lands on site and starts a trial (no card).
2. In-app "Add vehicle" asks for tracker IMEI or provider account (section 5.8). Goal: first ping within 15 minutes of signup.
3. Day 1 and day 3 automated emails with "your vehicle has not reported yet" fixes (section 5.7).
4. Day 7 check-in call offered (bilingual).
5. Day 21 usage review: how many vehicles reporting, which reports used, what is missing.
6. Day 30 convert to annual (20 percent off) or monthly.

**Onboarding promise (PROPOSAL):** "Your first vehicle on the map within 15 minutes, or a human helps you for free." Define success as a first ping (5.9). If the customer cannot get one in 15 minutes, a human reaches them within one business day.

### 4.4 Pilot plan

| Item | Plan |
|---|---|
| Target | 3 to 5 pilot fleets: 2 trucking, 2 school-bus/charter, 1 reseller |
| Duration | 60 days, free |
| Mix | At least one fleet on Traccar-compatible trackers, one on a Geotab reseller, one on Samsara, and one using only phones |
| Success criteria (PROPOSAL) | 90 percent of enrolled vehicles with a first ping within 24 hours; median position age under 60 s while moving; owner uses dashboard weekly; at least 3 of 5 convert to paid |
| What we learn | Which tracker models and protocols appear, real failure causes, provider API behaviour, support minutes per vehicle |
| Exit | Pilot fleets get 6 months at 50 percent off if they convert |

### 4.5 Objections and answers

| Objection | Answer |
|---|---|
| "My provider already gives me a dashboard." | Ask what they cannot do today (dispatch, driver app, customer links, French, reports). If the answer is "nothing", this is the wrong customer |
| "Will my provider block you?" | Honest answer: Samsara and Geotab expose public APIs. Some providers restrict third-party use. For trackers sending data directly (no provider portal), nobody can block it, because it goes to a server you point it at |
| "What if you shut down?" | Data export any time. Trackers keep working with the original provider or any Traccar-compatible server. No hardware tied to us |
| "I have no tracker." | We do not sell hardware. We introduce installers. Be clear and quick |
| "Is it cheaper?" | Show the 36-month table. Concede that cheap bundles around CA$20 all-in are hard to beat on price |
| "What about ELD?" | We integrate certified providers and do not build our own. Canada requires third-party certification (Transport Canada list) |
| "Where is my data?" | Canadian region hosting (PROPOSAL, section 4.6) |
| "How do I know it works?" | 30-day trial, first-ping check, human help |

### 4.6 Compliance asks Canadian buyers raise

| Ask | What we know | Our stance (PROPOSAL) |
|---|---|---|
| Data residency | Competitors market it: Zonar says Canadian users' MyView data is stored on cloud servers in Canada (Zonar, 13 Mar 2024). Samsara has a CA region for developers (partner support page) | Host primary data in a Canadian cloud region and state it in the DPA. Provider not chosen in this doc |
| PIPEDA and employee tracking | OPC finding PIPEDA Case Summary #2006-351 (9 Nov 2006): GPS for dispatch, safety and asset protection was acceptable; "employee management" use was acceptable only in limited and defined circumstances; consent required, implied consent acceptable for expected purposes; notice should come before rollout; warned against function creep ([OPC](https://priv.gc.ca/en/opc-actions-and-decisions/investigations/investigations-into-businesses/2006/pipeda-2006-351)). Alberta, BC and Quebec have their own private-sector laws (not researched in detail) | Ship a driver notice template and a "purpose" setting per fleet. Do not build features that encourage continuous driver scoring without policy. Get a lawyer to review |
| Quebec Law 25 | One secondary source says a privacy impact assessment is required before communicating personal information outside Quebec, and that it does not by itself mandate storage in Canada or Quebec; storing in Quebec avoids a transfer ([HiloTech summary](https://hilotech.ca/en/wiki/law-25/cross-border-transfers)). This is a vendor blog, not the statute or legal advice | Publish a PIA-ready data map (what we store, where, sub-processors). Verify with Quebec counsel before claiming compliance |
| Bilingual | Quebec buyers will expect French. Whether French is a legal requirement for our product is **not verified**. School boards and unionized drivers often require it in practice | EN/FR UI, driver app, notices and support from launch for Pro tier. Machine translation reviewed by a native speaker |
| Security | Samsara requires TLS 1.2+ and server-side-only token use (auth docs) as a baseline | TLS, encrypted secrets at rest for provider tokens, per-fleet isolation, audit log, role-based access |
| Retention and deletion | Not researched | Configurable retention per tier, delete-on-request process |
| Driver privacy | OPC finding above | Per-driver privacy mode off-duty (e.g. no tracking when personal use is permitted), configurable per fleet |

---

## 5. How the connection between app and vehicle works

### 5.1 Plain-language version (for the owner)

Each vehicle has a small box with a GPS chip and a SIM card, like a tiny phone. The box knows where it is and, every few seconds, sends a short message over the cellular network to a server: "I am device number 123456789012345 and I am here." RouteNorth listens at that server (or asks your tracking company's server for the same information), matches the device number to the vehicle you named in the app, and draws it on your map.

So there are only three things that must be true for a vehicle to show up:
1. The box is powered and has cellular data.
2. The box is told the correct server address and port.
3. RouteNorth knows which vehicle the box's number belongs to.

That is why adding a vehicle in RouteNorth asks for a tracking number (the device ID, usually the IMEI) and not a registration plate.

### 5.2 Engineer version: the chain

```
GPS tracker (SIM + GPS + modem)
   |  cellular data (LTE/4G; check network support, see 5.5)
   v
Protocol on a TCP/UDP port  (Teltonika Codec 8/8E, GT06, Queclink @Track, H02, OsmAnd, Ruptela ...)
   v
GPS server that decodes that protocol   (Traccar, run by us, or by the customer, or by a provider)
   v                      v                       v
RouteNorth ingest      Traccar REST/WebSocket   Provider API (Samsara/Geotab/Motive ...)
   |                      |                       |
   +----------------------+-----------------------+
                          v
              Normalised position store
              (device_id, lat, lon, speed, heading, ignition, ts, source)
                          v
        Owner dashboard / dispatch / driver app / reports / tracking links
```

Four connection modes (the same position record comes out of each):

| Mode | Who runs the server the tracker talks to | Customer does | We do | Risk |
|---|---|---|---|---|
| A. Direct to RouteNorth | Us (managed Traccar-class ingest on a Canadian host) | Enters device ID in app, points tracker to our host and port (or an installer does) | Decode, map ID to vehicle, store | Support load; our ingest must be reliable |
| B. Customer's own Traccar | Customer or their installer | Gives us the Traccar URL and an API token, or sets up forwarding to us | Pull via REST or receive forwarded positions | Customer's server uptime and exposure |
| C. Provider API | The tracking provider | Gives us credentials (see 5.4) | Poll or subscribe, normalise | Provider terms, rate limits, outages |
| D. Phone as tracker | None (phone talks to us) | Driver installs RouteNorth driver app, or Traccar Client | Receive OsmAnd-style HTTP posts or app posts | Battery, permissions, drivers closing the app |

### 5.3 Tracker brands and protocols

The table lists protocols Traccar documents. Whether each tracker model works with our ingest must be tested (section 6).

| Brand family (examples) | Typical use | Protocol name in Traccar | Source / status |
|---|---|---|---|
| Teltonika (FMB, FMC, FMM series) | Hardwired and OBD trackers, widely used worldwide | `teltonika` (Codec 8 / 8 Extended, Codec 12 for commands) | Codec details from [Teltonika wiki](https://wiki.teltonika-gps.com/view/Teltonika_Data_Sending_Protocols). Popularity in Canada not verified |
| Queclink (GV, GL, GB series) | Vehicle and asset trackers | `gl200` decoder handles Queclink `@Track` messages | A Traccar maintainer pointed a Queclink user to the "GL200" protocol and port ([forum thread](https://www.traccar.org/forums/topic/queclink-gv57mg-support-with-gl200-track-protocol/)). Model-by-model support not verified |
| Concox / Jimi IoT (GT06 family, JM-VL series) | Low-cost OBD and hardwired trackers | `gt06` (17 documents listed on the Traccar protocols page, [source](https://www.traccar.org/protocols/)) | Model coverage not verified |
| H02 / Sinotrack style | Very low-cost trackers | `h02` | Listed on Traccar protocols page |
| Ruptela | Hardwired fleet trackers | `ruptela` | Listed |
| Meitrack, Suntech, TK103 | Various | `meitrack`, `suntech`, `tk103` | Listed |
| CalAmp | Hardwired, many North American fleets | Not on the protocols page I read | CalAmp filed for bankruptcy in June 2024 to complete a lender-backed restructuring ([SFNet](https://www.sfnet.com/home/chapters/canada/news-detail/2024/06/03/calamp-files-bankruptcy-to-complete-lender-backed-restructuring)); current status and Traccar support not verified |
| Geotab GO (GO9 etc.) | Plug-in or hardwired, proprietary | Not Traccar. Data goes to Geotab cloud only. Use the MyGeotab API | GO9+ uses LTE on AT&T, TELUS and Rogers and holds up to 80,000 logs offline ([Geotab GO9+ document](https://support.geotab.com/help/go-devices/go9/go9-support-document)) |
| Samsara VG / Motive vehicle gateway | Proprietary | Not Traccar. Use provider API | Subject to API terms in 1.3 |
| Phone (Android/iOS) | Fallback | OsmAnd-style HTTP via Traccar Client, or our own driver app | See 5.6 |

Traccar's own claim: its server supports "more than 200 GPS protocols and 2000+ models of GPS tracking devices out of the box", Apache 2.0 licence ([README](https://cdn.jsdelivr.net/gh/traccar/traccar@master/README.md)). The Traccar protocols page I fetched listed 91 protocols, so the exact count is **not verified**; treat "200+" as a vendor claim.

**Protocol facts we can rely on from documentation:**

- **Teltonika Codec 8 over TCP.** The tracker connects and sends its IMEI first, prefixed by a 2-byte length. The server replies one byte: `0x01` to accept or `0x00` to reject. The tracker then sends the AVL data packet and the server replies with a 4-byte count of records received; if the count does not match, the tracker resends. Codec 8 Extended (0x8E) widens some length fields and allows variable-size IO elements. Codec 12 is a command channel, not a data upload format ([Teltonika wiki](https://wiki.teltonika-gps.com/view/Teltonika_Data_Sending_Protocols)). Consequence: if the server does not know the IMEI, an unknown device is rejected, which is exactly the "device not registered" failure in 5.7.
- **OsmAnd protocol (phones).** HTTP request with query parameters: `id` (mandatory unique device identifier), `lat`, `lon`, `timestamp`, `speed` (knots by default) ([Traccar OsmAnd page](https://www.traccar.org/osmand/)). The examples on that page use port 5055.
- **Default ports.** Traccar's `default.xml` assigns one port per protocol. A forum user's config shows GT06 5023, H02 5013, OsmAnd 5055, Suntech 5011, GPS103 5001, TK103 5002 ([forum](https://www.traccar.org/forums/reply/103507)), but that is a user's file, not documentation. Teltonika and Queclink default ports were **not verified**. Read our own deployed `traccar.xml` and publish the actual list in the app.

### 5.4 Traccar's role

Traccar is the open-source GPS server that does the unglamorous part: it listens on many TCP/UDP ports, decodes each tracker brand's protocol, and stores positions.

| Capability | Detail | Source |
|---|---|---|
| Protocol decoding | One listener port per protocol, 200+ claimed | README |
| REST API | Sessions, devices, positions, events, reports, notifications, server administration | [API reference](https://www.traccar.org/api-reference/) (only the description was readable; endpoint detail not verified) |
| Forwarding of decoded positions | `forward.url` (global or per device); `forward.type` is `url`, `json`, `amqp`, `kafka`, `mqtt`, `redis` or `wialon`; optional headers, retry with `forward.retry.*` | [Traccar forwarding](https://www.traccar.org/forward/) |
| Forwarding of events | `event.forward.url`; type `json`, `amqp`, `kafka` or `mqtt` | same |
| Raw forwarding | `server.forward` mirrors the original TCP/UDP packets to another listener, per protocol port | same |
| Hosted option | Shared account from $9.95/month; dedicated server from $49.95/month; currency not stated; 7-day trial | [Traccar pricing](https://www.traccar.org/pricing/), [managed vs self-hosted](https://www.traccar.org/managed-vs-self-hosted/) |

Design choices for RouteNorth:
1. **We run our own Traccar-class ingest** (mode A). Trackers connect to our host and port. A small adapter maps `uniqueId` (the device ID) to a RouteNorth vehicle and fleet. Source of truth for "device registered" is our database, not Traccar's.
2. **For customers with their own Traccar** (mode B), prefer position forwarding with `forward.type=json` and a per-fleet secret in a header, to our endpoint. Fall back to REST polling if the customer cannot change config.
3. **Raw forwarding** (`server.forward`) is useful for installers and resellers who want to keep their existing server and give us a copy of the stream without changing tracker settings.

### 5.5 Provider-API pull (mode C)

| Provider | Credentials the customer gives us | Scopes | Polling or push | Limits and notes |
|---|---|---|---|---|
| Samsara | An API token created in the customer's dashboard, or OAuth consent | Granular read scopes; default new token has read scopes for Drivers, Vehicles, Webhooks; read-only is sufficient for tracking | Polling with the feed endpoints; webhooks are mentioned in the program page | 150 req/s per token, 200 req/s per org, locations endpoint 25 req/s per org; 429 with `Retry-After`; OAuth access token 1 hour, refresh token single-use ([rate limits](https://developers.samsara.com/docs/rate-limits), [OAuth](https://developers.samsara.com/docs/oauth-20)) |
| Geotab | Database name, a dedicated service user and password (or equivalent); we call `Authenticate` then API methods | Results follow the user's security clearance; create the user with read-only clearance | `GetFeed` is the recommended continuous-sync method; `Get` for bounded current-state | Per-method, per-user, per-database limits scaled by fleet size tier; wait at least 1010 ms if adding waits; backoff on `OverLimitException`; response headers `X-Rate-Limit-*` ([rate limits](https://developers.geotab.com/myGeotab/guides/rateLimits)). **Not verified:** which exact entity gives latest position and its base limit |
| Motive | OAuth 2.0 authorization by the customer; scopes such as `vehicles.manage`, `hos_logs.logs` are listed (use the narrowest read scope) | Must match the app definition | Polling. No webhook mention on the page I read | Access token 2 hours; "10 simultaneous requests" on the locations endpoint. **Terms restrict distributing apps without Motive's written authorization** (1.3) |
| Fleet Complete / Powerfleet | Token from api.fleetcomplete.com | Not stated | Not stated | Free for clients per their API page |
| Teletrac Navman | Login created after API request form | Not stated | Not stated | Gated |
| Others | Not verified | | | Mark "connector unavailable" in the UI until verified |

Engineering requirements for any provider connector:
1. Store tokens encrypted. Never display them again after entry.
2. Per-customer rate budgeting and exponential backoff; respect `Retry-After`.
3. Position age is determined by the provider's own refresh. We cannot make it faster. Show "last updated" and "source" on every vehicle.
4. Connector health page per fleet: last success, last error, vehicles matched.
5. Revocation path: customer revokes token, we show "disconnected" and stop.
6. Match provider vehicles to RouteNorth vehicles by provider vehicle ID, then let the owner rename or merge.

### 5.6 Forwarding, webhooks, OBD versus hardwired, ELD, phone fallback

**Forwarding and webhooks.** Use push (Traccar forwarding, provider webhooks) where available because it gives lower latency and fewer wasted requests. Poll otherwise. Every push endpoint needs a per-fleet shared secret, replay protection, and idempotent writes (a position keyed by device_id + timestamp).

**OBD plug-in versus hardwired.**

| | OBD-II plug-in | Hardwired |
|---|---|---|
| Install | Plug into port, no tools | Wired to power, ground, ignition |
| Typical cost reference | OBD devices "from $39.95" (GPS Insight article); Linxup $69 plug-in | "$100 to $299+" hardwired devices; about $100 installation (GPS Insight article, ExpertMarket 2023); currency not stated |
| Risk | Easy to unplug; some heavy trucks and buses lack a usable OBD-II port (many use J1939 connectors; not verified for specific models) | Needs competent installer; harder to remove |
| Anti-tamper | Weak | Better |
| Good for | Light-duty, trial, rented vehicles | Trucks, buses, permanent installs |

**ELD interplay.**
- An ELD box is a certified recording device that also reads engine data and usually has GPS. The ELD vendor controls its data. Some ELD vendors sell GPS tracking from the same box.
- RouteNorth does not replace the ELD box. If the customer runs ELD on Samsara or Motive, tracking data flows through that vendor's API (mode C), subject to its terms.
- ELD devices in Canada must be third-party certified; Motive, Geotab and Fleet Complete devices appear on the Transport Canada list (TC page, 11 Nov 2026), and Samsara announced certification on 2 Dec 2021 (Samsara CA blog).
- Practical split: the ELD handles hours-of-service. A separate tracker (or the same vendor's API) supplies positions to RouteNorth. Whether a certified ELD vendor will license us positions for resale is **not verified**.

**Phone as tracker (mode D).** Use when a vehicle has no tracker, for a driver pilot, or as a backup. The Traccar Client app sends OsmAnd-style requests; RouteNorth's driver app can send the same data. Limits: needs location permission "always", battery optimisation exclusions, driver has to carry and start the phone, accuracy and refresh depend on OS power management (not verified for current iOS and Android versions). Treat phone positions as "lower trust" and label the source in the UI.

### 5.7 Data refresh and failure causes

**Refresh rate.** Real refresh depends on how each tracker is configured (distance, time and angle triggers) and on the provider. I did not verify a single typical interval. Zonar's release mentions a ping rate every 10 seconds in its integration, without naming the hardware ([Zonar](https://www.zonar.com/news-events/press-releases/zonar-expands-myview-school-bus-tracking-app-in-canada)). Geotab describes curve-based logging, which records fewer, more accurate points, and no fixed default interval was stated ([GO9+ document](https://support.geotab.com/help/go-devices/go9/go9-support-document)).

PROPOSAL design targets: moving vehicle every 10 to 30 seconds, stopped vehicle heartbeat every 5 to 15 minutes, ignition on/off as immediate events. Provider-API sources are as fresh as the provider allows. The UI must always show last-reported time and source.

**Failure causes and plain-language fixes.**

| Symptom (what the owner sees) | Likely cause | Plain-language fix | How RouteNorth should detect it |
|---|---|---|---|
| Vehicle added, never appears on map | Device ID typed wrongly (IMEI digit swap), or vehicle added before the device is powered | Re-check the 15-digit number printed on the tracker or in the vendor portal, re-enter it | Unknown-device log: show "we heard from IMEI X, which is not registered" with a one-click "assign to vehicle" |
| Tracker light is off | Not powered: unplugged OBD, loose wire, battery disconnect | Re-seat the plug or ask the installer to check power and ground | No data plus ignition never seen; ask owner to confirm power |
| Tracker light on but nothing arrives | SIM has no data plan, is not activated, or data is blocked | Confirm the SIM is active and has a data plan with your carrier or SIM vendor | Device connects to nobody; check the other side: SIM status via vendor if available |
| Works on bench, not in vehicle | Poor signal or hardware mounted behind metal; or no GPS fix | Move antenna or box, park outside for a few minutes | Position with low satellite count or no fix flag |
| Tracker is sending but our server rejects it | Wrong server address or wrong port | Re-send the setup message with the exact host and port shown in the app | Show the expected host:port per protocol in the add-vehicle wizard; log connection attempts by port if possible |
| Data arrives, shows nonsense | Wrong protocol selected on the tracker for the port used (e.g. device set to one protocol, port listens for another) | Match the tracker's protocol setting to the port in the wizard | Decoder errors per port; flag "received bytes that did not decode" |
| Tracker never connects over mobile data | APN not set or wrong | Enter the carrier's APN for the SIM in the tracker settings; ask the SIM vendor for the correct APN | Cannot see directly; hint after N minutes of silence |
| Tracker worked, then stopped | SIM data expired, vehicle battery disconnected for service, network shutdown of the technology the tracker uses | Check SIM status and vehicle power; replace old 2G/3G-only trackers | Last seen timestamp and "silent for X hours" alert. See below on network shutdowns |
| Vehicle shows old position | Tracker in sleep mode or deep sleep when parked; or provider API lag | Expected while parked. If it persists while driving, check power and signal | Compare last position age to ignition state |
| Provider connection says "disconnected" | Customer revoked or regenerated token (Samsara tokens stop immediately when regenerated), user password changed, access removed | Create a new token or reauthorize and paste it again | Connector health check, error codes surfaced plainly |
| Provider connection works but some vehicles missing | Token scoped by tag or group; vehicle filter | Widen the token's tag access to all vehicles | Compare provider vehicle count versus matched count |

**Network shutdown risk.** Teltonika's FMB series lists only 2G bands in the Teltonika frequency table; several FMC models list EU-centred bands with no B4, B12 or B13 (Canadian-relevant), so tracker SKUs bought outside Canada may not work on Canadian LTE ([Teltonika Frequency Bands](https://wiki.teltonika-gps.com/view/Frequency_Bands)). That page does not mention Canada, so each model must be confirmed with the vendor. Canadian 3G retirement is under way: Bell plans nationwide 3G shutdown in early 2027 (Manitoba 31 Dec 2025), and the 14 Oct 2025 article gives no date for Telus or Rogers ([iPhone in Canada](https://www.iphoneincanada.ca/2025/10/14/bell-pushes-back-its-3g-shutdown-heres-the-new-timeline/)). 2G status in Canada: not verified. Ask owners for the tracker model and check LTE band support before onboarding.

### 5.8 Onboarding flow

This is the flow the "Add vehicle" panel should implement.

1. **Choose how this vehicle reports.** Four options: "I have a GPS tracker", "I use a tracking company (Samsara, Geotab, ...)", "I run my own Traccar server", "Use a phone".
2. **Name the vehicle.** Nickname, plate, type (truck, bus, van), assigned driver (optional), fleet and depot.
3. **Tracker path.**
   1. Enter the tracker's **device ID** (the IMEI, 15 digits, or the serial the vendor uses). Validate length and checksum for IMEI (Luhn). Allow other IDs for non-IMEI devices.
   2. Pick brand/protocol (or "I do not know", which falls back to guessing by the first packet).
   3. App shows the exact **server host and port** and, where the tracker supports it, a copy-paste setup message for the installer or vendor.
   4. App starts listening and shows "Waiting for first ping" with a countdown and live checklist (device seen? decoded? position valid?).
4. **Provider path.** Pick provider, follow its guided steps to create a token or approve access (Samsara token or OAuth, Geotab service user, others when verified). App tests the connection, lists vehicles it sees, and the owner ticks which to import and matches names.
5. **Own Traccar path.** Give server URL and token, or copy the forwarding configuration (`forward.url`, `forward.type=json`, header) from the app. App shows "Waiting for forwarded positions".
6. **Phone path.** App sends the driver an invite link or QR code. Driver installs the app and grants always-on location. App shows "Waiting for phone".
7. **First ping.** When the first valid position arrives, show the vehicle on the map and mark "Connected".
8. **Health setup.** Offer alerts: "tell me if this vehicle stops reporting for more than 1 hour while ignition is on".
9. **Invite drivers and set geofences** (Fleet tier and up).
10. **Day 1 and day 3 follow-up** if still no ping, with the failure table in 5.7 as the checklist.

**Definition: first ping.** A first ping is the first position record for a registered vehicle that meets all of these:
- Arrived from a source mapped to that vehicle (device ID or provider vehicle ID matched).
- Valid coordinates inside Earth bounds and not (0, 0).
- GPS fix flag valid, or provider-marked valid.
- Timestamp not more than 10 minutes in the future and not older than 24 hours (PROPOSAL thresholds, so that a buffered historical upload from a tracker that was offline does not count as "live").
- At least one more ping within the next 15 minutes while the vehicle is moving, for a "healthy" state. Otherwise mark "connected, low activity".

### 5.9 Per-vehicle pricing implications

| Question | Proposal |
|---|---|
| When does billing start? | Trial vehicles are free for 30 days. After conversion, a vehicle becomes billable in a month if it had at least one valid position that month |
| Vehicles that never connect | Free. They do not count toward minimum fleet size but count toward a seat cap for support (5 unconnected vehicles max) |
| Vehicles that sit idle in a month | Free in a month with no valid position. Marked "dormant". Reduces disputes and aligns with seasonal buses |
| Phone-as-tracker vehicles | Same price as any vehicle on the tier. Alternative: half price for phone-only, but test first |
| Provider-API vehicles | Same price. Risk: provider-side rate limits grow with fleet size (Geotab multiplies limits by fleet tier; Samsara limits are per organization) |
| Direct-ingest vehicles | Same price. Our costs: ingest infrastructure, SIM is paid by customer |
| Rogue devices | If an unregistered device ID connects, we log it, never bill it, and offer to assign it |
| Duplicate sources | One vehicle with two sources (tracker plus phone) is billed once; choose a "primary source" |
| Monthly minimum | CA$99 applies to accounts with fewer than about 10 Core vehicles (CA$99 / CA$10 monthly price is about 10) |

Support-cost warning: every vehicle that fails to connect costs human time. The first-ping metric (5.8) should drive both the free-trial funnel and the support queue.

---

## 6. Risks, unknowns and what to verify next

**Nothing in this document has been tested against real hardware, a real Traccar server, or a real provider account.** The following checklist converts documentation claims into facts.

### 6.1 Hardware and protocol verification (bench plus in-vehicle)

| # | Test | Pass criterion |
|---|---|---|
| 1 | Buy or borrow one each: Teltonika FMC-class (Canada-ready LTE band set), Queclink GV-class, Concox/Jimi GT06-class OBD tracker | Devices in hand with Canadian-compatible LTE bands confirmed in writing |
| 2 | Point each at our test ingest (Traccar-class server on a Canadian host). Record host, port and setup commands that actually worked | First ping within 15 minutes using only the app's instructions |
| 3 | Confirm real default ports for Teltonika, Queclink, Ruptela on our deployed Traccar version | Published in the wizard |
| 4 | Unknown IMEI behaviour: confirm the server rejects (Teltonika `0x00`) and we log the attempt | Unknown-device UI works |
| 5 | Offline buffering: unplug tracker network, drive, reconnect | Buffered points arrive, are stored with correct timestamps, are not counted as first ping |
| 6 | Refresh rates in moving and parked states with factory defaults and with tuned settings | Documented per model |
| 7 | OBD versus hardwired on a real heavy truck and a real school bus (including J1939 connectors) | Compatibility list |
| 8 | SIM and APN matrix: two or three Canadian carriers or IoT SIM vendors, with working APN settings | Documented fixes |
| 9 | Phone fallback: Android and iOS driver app background behaviour over a full shift | Battery and gap statistics |
| 10 | 2G/3G retirement: ask each vendor for LTE band lists for the SKUs sold in Canada | Model compatibility list |

### 6.2 Provider account verification

| # | Test | What to learn |
|---|---|---|
| 1 | Create a Samsara trial or partner sandbox, issue a read-only token, pull live vehicle locations using feed endpoints | Actual freshness, error codes, count per call, CA region base URL |
| 2 | Same for Geotab demo database with read-only service user and `GetFeed` | Which entity gives positions, base limits, delay |
| 3 | Read Samsara Integration Partner Terms and Geotab marketplace and partner terms in full | Whether a third-party dashboard for customer data is permitted, any fees or revenue share |
| 4 | Contact Motive: request written permission for third-party distribution under API Terms 2.3 and clarify "substantially similar product" (3.3.13) | Go or no-go for Motive data |
| 5 | Request Fleet Complete and Teletrac Navman API access via their forms | Terms, limits, response times |
| 6 | Ask a Canadian Geotab reseller how they price software versus hardware | Whether a customer can drop the reseller's software fee |
| 7 | Evaluate whether certified ELD vendors will license positions or sell through us | ELD partner terms and fee model |

### 6.3 Business and legal unknowns

| Unknown | Why it matters | Next step |
|---|---|---|
| Real competitor prices (Samsara, Geotab, Motive, Verizon Connect, Fleet Complete) | The 36-month example uses third-party "from" prices | Get three written quotes in Canada |
| Hardware and install costs in Canada | Conflicting figures (CA$135-200 versus "1500-2500") | Same quotes |
| Whether cheap bundles under about CA$20 all-in exist in Canada | Sets our price ceiling | Survey 10 Canadian reseller sites |
| Law 25 transfer duties and any language requirement | Quebec sales | Counsel review. The only source used was a vendor blog |
| PIPEDA and provincial rules (Alberta, BC) on driver monitoring | Product features such as scoring and off-duty privacy | Counsel review. The OPC finding is from 2006 |
| Our support cost per connected vehicle | Pricing floor | Track in pilot |
| Canadian cloud region and sub-processor list | Data-residency claims | Choose provider and document |
| School-bus competitor field in Canada | We found only Zonar MyView in Canada; Vontas, Synovia and others not verified | Interview 5 contractors |
| Reseller and installer appetite | Channel assumption | Interview 10 installers |
| Traccar scale and our operational capacity | Direct ingest is the primary path | Load test: thousands of devices at 10 s reporting, with failover |
| Teltonika, Queclink, Concox popularity in Canadian fleets | Brand priority list | Ask installers which they actually sell |

### 6.4 Claims in this document I could not verify

1. Traccar "200+ protocols" (vendor claim; the page I fetched listed 91).
2. Default Traccar ports for Teltonika and Queclink.
3. Any Canadian presence or API terms for Verizon Connect, GPS Insight, Linxup, Pointer, Azuga, RAM beyond what the cited articles state.
4. Samsara hardware price (two conflicting figures) and Motive, Geotab and Verizon prices (none published by the vendor).
5. Fleet Complete pricing (single third-party source, no citation behind it).
6. Teletrac Navman presence on the Transport Canada list (reported by ExpertMarket; not seen in the portion of the TC list I read).
7. Samsara presence on the Transport Canada list page (certified per Samsara's own blog; not seen in the portion read).
8. Whether Geotab, Fleet Complete or Teletrac Navman allow resale of positions inside a competing dashboard.
9. Law 25 transfer rules (secondary source only), any French-language legal requirement, Alberta and BC rules.
10. School-bus vendors in Canada other than Zonar MyView.
11. Geotab's headquarters and Canadian origin (general knowledge, not re-verified in this pass).
12. Samsara "Integration Partner Terms", Geotab SDK terms of use, and Samsara refresh intervals (not read).

### 6.5 Recommended order of work

1. Bench test with three tracker families plus one phone (6.1, tests 1 to 5). This decides whether the "direct ingest" product works.
2. Samsara and Geotab sandbox connections (6.2, tests 1 to 3).
3. Written Motive question (6.2, test 4). Do not ship a Motive connector before it.
4. Three real Canadian quotes from competitors, then re-run the 36-month tables in 3.5.
5. Pilot with 3 to 5 fleets (4.4).
6. Counsel review of PIPEDA and Law 25 positioning, then publish the DPA and data map.

---

## Appendix: source list

- Samsara: [rate limits](https://developers.samsara.com/docs/rate-limits), [authentication](https://developers.samsara.com/docs/authentication), [OAuth 2.0](https://developers.samsara.com/docs/oauth-20), [Technology Partner Program](https://developers.samsara.com/docs/technology-partner-program), [partner support](https://developers.samsara.com/docs/partner-support), [Canadian ELD certification](https://www.samsara.com/ca/blog/samsara-compliance-solution-now-certified-for-the-canadian-eld-mandate)
- Geotab: [rate limits](https://developers.geotab.com/myGeotab/guides/rateLimits), [introduction](https://developers.geotab.com/myGeotab/introduction/), [partner policies](https://support.geotab.com/en-GB/mygeotab/doc/partner-policies), [GO9+ document](https://support.geotab.com/help/go-devices/go9/go9-support-document), [Verizon Connect international acquisition](https://www.automotive-fleet.com/news/geotab-buys-verizon-connects-international-commercial-operations)
- Motive: [API Terms of Service](https://gomotive.com/legal/api-terms-of-service/), [OAuth 2.0](https://developer.gomotive.com/reference/authentication-oauth-20), [vehicle locations v3](https://developer.gomotive.com/reference/vehicle_locationsid-v3)
- Fleet Complete: [API page](https://www.fleetcomplete.com/api). Teletrac Navman: [API request](https://www.teletracnavman.com/support/api-request)
- Traccar: [README](https://cdn.jsdelivr.net/gh/traccar/traccar@master/README.md), [forwarding](https://www.traccar.org/forward/), [OsmAnd](https://www.traccar.org/osmand/), [protocols](https://www.traccar.org/protocols/), [pricing](https://www.traccar.org/pricing/), [managed vs self-hosted](https://www.traccar.org/managed-vs-self-hosted/), [API reference](https://www.traccar.org/api-reference/)
- Teltonika: [data sending protocols](https://wiki.teltonika-gps.com/view/Teltonika_Data_Sending_Protocols), [frequency bands](https://wiki.teltonika-gps.com/view/Frequency_Bands)
- Pricing signals (third party): [ExpertMarket telematics Canada, 24 Sep 2025](https://www.expertmarket.com/ca/fleet-management/best-telematics), [ExpertMarket Teletrac Navman, 12 Nov 2025](https://www.expertmarket.com/ca/fleet-management/teletrac-navman-review), [ExpertMarket costs, 30 Mar 2023](https://www.expertmarket.com/ca/fleet-management/costs), [CostBench Samsara](https://www.costbench.com/software/fleet-management/samsara/), [CostBench Motive](https://www.costbench.com/software/fleet-management/motive/), [CostBench Geotab](https://costbench.com/software/fleet-management/geotab/), [CostBench Verizon Connect](https://www.costbench.com/software/fleet-management/verizon-connect/), [Subger Fleet Complete](https://subger.com/en/service/fleet-complete), [Fleetio pricing](https://www.fleetio.com/pricing), [Linxup pricing](https://www.linxup.com/pricing), [GPS Insight blog](https://www.gpsinsight.com/blog/gps-fleet-tracking-pricing-cost-per-vehicle/)
- Canada regulation and market: [Transport Canada ELD list](https://tc.canada.ca/en/road-transportation/electronic-logging-devices/list-electronic-logging-devices), [OPC PIPEDA #2006-351](https://priv.gc.ca/en/opc-actions-and-decisions/investigations/investigations-into-businesses/2006/pipeda-2006-351), [HiloTech Law 25 transfers](https://hilotech.ca/en/wiki/law-25/cross-border-transfers), [Zonar MyView Canada](https://www.zonar.com/news-events/press-releases/zonar-expands-myview-school-bus-tracking-app-in-canada), [Bell 3G shutdown](https://www.iphoneincanada.ca/2025/10/14/bell-pushes-back-its-3g-shutdown-heres-the-new-timeline/), [CalAmp bankruptcy](https://www.sfnet.com/home/chapters/canada/news-detail/2024/06/03/calamp-files-bankruptcy-to-complete-lender-backed-restructuring)
