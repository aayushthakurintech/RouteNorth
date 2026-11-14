# Selling RouteNorth to Ontario government fleets

Research date: 2026-11-14. Written for Aayush and anyone who joins the company later.

**Question:** can RouteNorth, a software company that connects fleets' existing GPS devices and providers, sell to Ontario government bodies to track garbage trucks, snow plows, transit and other official vehicles? What do those buyers use and pay today, and how would we sell?

## Bottom line

1. **Yes, but not through the front door.** The big, visible contracts (City of Toronto's telematics award, Brampton and Metrolinx CAD/AVL) are multi-year RFPs worth millions, won by established vendors with certifications and references. A new company will not win those first.
2. **The realistic first buyers are small and mid-size municipalities and counties** (public works fleets that mix snow, waste and general vehicles), **and the private waste and snow contractors who serve municipalities.** Contractors buy faster because they do not run public RFPs.
3. **Most Ontario municipal fleets already run Geotab, Telus or similar hardware, often bought through a reseller or a cooperative contract.** That fits RouteNorth: we are the reporting and operations layer on top of the telematics they already own, not a replacement for the device. We do not sell hardware.
4. **The money in the market is roughly C$18 to C$35 per vehicle per month for hardware plus service** (third-party estimates, weak). A software-only layer has to price well below that. Our own working hypothesis is C$5 to C$10 per vehicle per month; this is a guess to test, not market evidence.
5. **Before anyone signs, RouteNorth must fix the gaps in section 7.** The big ones: Canadian hosting (the API and database have no host yet), provider connectors (Geotab and others are not built), SSO, waste-specific proof of service, and an accessibility conformance report.

**Recommended first move:** run one free or near-free 60 to 90 day pilot with a mid-size Ontario municipality or county that already uses Geotab, focused on a single pain (snow plow or waste route proof of service and complaint handling). In parallel, offer the same to one regional waste or snow contractor. Details in section 6.

## How strong is the evidence

Labels used below:

- **[Source]** read directly on the cited page.
- **[Calc]** our own arithmetic from sourced figures.
- **[Estimate]** third-party or vendor estimate. Weak.
- **[General knowledge]** industry background not checked against a fetched source in this pass. Verify before relying on it.

Honest limits of this research:

- **No per-vehicle prices in any Ontario public document.** Council reports give totals, not unit prices. Per-vehicle figures below are third-party estimates.
- **Several contract examples are old** (Vaughan 2006, Mississauga 2014, Toronto 2017). They show structure, not today's prices.
- **No Ontario waste-truck telematics award was found.** Waste evidence comes from vendor pages, trade press and one Toronto collection contract.
- **Not covered:** TTC specifically, MERX, Biddingo and the Ontario Tenders Portal listings (they need logins or searches we did not run), Geotab Marketplace terms, current school bus consortium counts, bilingual requirements, and insurance minimums. These are listed again in section 8.
- Some documents were only partly readable by the tool (marked below). Treat those points as unverified.

## 1. Who the buyers are

| Segment | What they run | Who buys | Procurement | Realistic for us first? |
| --- | --- | --- | --- | --- |
| Small and mid-size municipalities and counties | Mixed public works fleets: plows, graders, waste, parks, by-law | Fleet or public works manager, finance | Local purchasing by-law, often quotes or invitational below a threshold | **Yes. Best first target.** |
| Waste and snow contractors serving municipalities | Collection trucks, plows | Owner or operations manager | Private purchase, no public RFP | **Yes. Fastest sales cycle.** |
| Large cities and regions (Toronto, York Region) | Thousands of vehicles, enterprise telematics contract | Fleet Services, IT, procurement | Formal RFP, multi-year, fairness monitor | Not first. Needs references and certifications |
| Transit agencies (Brampton Transit, Hamilton Street Railway, Metrolinx/GO) | Buses on CAD/AVL systems | Transit IT, capital programs | Large capital RFPs, partly grant funded | No for core CAD/AVL. Possible only at the edges (see below) |
| School bus consortia and operators | Contracted buses, routing and tracking suites | Consortia (buyers of service), private operators | Consortium contracts, cooperative buying | Hard. Dominated by routing suites like Edulog |
| Provincial ministries and agencies | Provincial fleets | Supply Ontario | Mandatory Vendor of Record for ministries | Not first (see section 5) |

Notes on the evidence:

- **Waste is often contracted out.** Toronto's District 2 curbside collection contract went to GFL Environmental: five years from August 2026 plus two one-year extensions, about C$284 million net of taxes [Source: [Toronto award report](https://www.toronto.ca/legdocs/mmis/2024/gg/bgrd/backgroundfile-248375.pdf)]. When collection is contracted, the contractor owns the trucks and the tracking, and the city needs proof of service from them. That makes contractors a buyer and municipalities a requirer of data.
- **Student transportation:** the 2015 Ministry of Education efficiency review covered 33 consortia that contract bus operators and said GPS was becoming standard province-wide [Source: [Ministry review](https://efis.fma.csc.gov.on.ca/faab/SBBSB_Content/3_Student_Transportation/EE_Review_Final_Report_EN.pdf), partly summarized by the tool]. This is 2015 data. Current numbers were not verified.
- **Small transit:** the Ministry of Transportation's 2023 transit technology toolkit says cost and a lack of right-sized technology are barriers for small and rural transit, and cites Norfolk County publishing GTFS without traditional transit technology [Source: [MTO toolkit](https://files.ontario.ca/mto-transit-technology-toolkit-fr-2023-01-16.pdf), French, only the first part read verbatim]. This suggests a small-transit gap, but the evidence is thin.
- **Number of municipalities:** Ontario has roughly 440 or more municipalities [General knowledge, not verified in this pass]. Most are small.

## 2. What they use today and how it works

### Incumbent systems seen in Ontario public documents

| Buyer | System | Source |
| --- | --- | --- |
| City of Toronto (all divisions) | BSM Technologies telematics, awarded 2017 | [Report](https://www.toronto.ca/legdocs/mmis/2017/gm/bgrd/backgroundfile-103840.pdf) |
| City of Windsor | Telus FOCUS GPS/AVL, agreement from 2016, fourth renewal in 2024 | [CAO approval](https://citywindsor.ca/documents/city-hall/city-council-meetings/CAO_Approvals/CAOP%20150-2024.pdf) |
| York Region | DM&T Services AVL on winter vehicles, 2016, with dash cameras | [Council clause](https://york.ca/media/57226/download) |
| Wellington County | Geotab, 60 vehicles, 28 of them snowplow/spreaders | [Geotab case study](https://www.geotab.com/case-study/wellington-county) |
| City of Port Colborne | Geotab via reseller Dican, 300+ pieces of equipment | [Geotab case study](https://geotab.com/case-study/city-of-port-colborne) |
| King Township | Geotab via reseller Optisolve, 130+ vehicles | [Geotab case study](https://www.geotab.com/case-study/king-township-public-works-transformation/) |
| City of Mississauga | Webtech Wireless GPS/AVL, 2014 | [Automotive Fleet](https://www.automotive-fleet.com/127038/ontario-city-signs-2-1m-telematics-contract) |
| City of Vaughan | Grey Island Systems AVL, 2006 | [Committee report](https://meetingarchives.vaughan.ca/committee_2006/pdf/CWA0116_17.pdf) |
| Brampton Transit | CAD/AVL replacement on 450+ buses | [Mass Transit](https://www.masstransitmag.com/technology/intelligent-transportation-systems/communications-navigation-cad-avl-gps/article/21223210/brampton-transit-to-fund-cad-avl-project-with-nearly-c10-million-funding-commitment) |
| Hamilton Street Railway | Vontas OnRoute CAD/AVL, 2024 | [Metro Magazine](https://www.metro-magazine.com/news/canadas-hamilton-street-railway-taps-vontas-for-cad-avl-solution) |
| Metrolinx (GO bus) | Systrans NAVINEO CAD/AVL, 2026 (replacing an older system) | [Mass Transit](https://www.masstransitmag.com/bus/maintenance/news/55369762/systrans-an-equans-company-metrolinx-partners-with-systrans-for-cad-avl-upgrade) |

Patterns worth noting:

- **Geotab appears most often** in smaller Ontario municipalities, usually through a local reseller (Dican, Optisolve). Geotab's Wellington County page says the data is Canadian-hosted.
- **Telus (including Skyhawk) is a main Canadian alternative.**
- **Vendors vary widely in size.** Wellington is 60 vehicles; Toronto's scope is thousands.
- Samsara and Verizon Connect were in the research brief but did not show up in the Ontario public documents we read. They are common in the private market (see pricing).

### Cooperative contracts municipalities can buy through

- **Canoe Procurement Fleet Management Program** lists 15 suppliers, including Geotab, Telus/Skyhawk, GPS Insight, Vemoco, Global Cloud Fleet, RTA and Advantage One Technology (route management that integrates with Geotab GO devices, with waste and snow operations). Several contracts run to 23 April 2029 [Source: [Canoe](https://canoeprocurement.ca/program/fleet-management-program/)].
- **Canoe Transit and Mobility Technology Program** lists 7 suppliers, including Education Logistics (Edulog) for student transportation with GPS/AVL, Infodev for passenger counting, and Transit Technologies for transit telematics [Source: [Canoe](https://canoeprocurement.ca/program/transit-and-mobility-technology-program/)].
- **Supply Ontario Fleet Management Services Vendor of Record** began 1 February 2026: five-year term plus two optional two-year extensions, with five vendors in the Telematics category (names not on the page). Mandatory for Ontario ministries and agencies; optional for municipalities, school boards, universities and health providers [Source: [Supply Ontario](https://www.supplyontario.ca/?p=3956)].
- **Sourcewell** holds the same Edulog contract number (102924-EDL) [Source: [Sourcewell](https://www.sourcewell-mn.gov/cooperative-purchasing/102924-EDL)].

What this means: an Ontario municipality can often buy Geotab or Telus off an existing contract without running its own RFP. Competing head-on with those is costly. Complementing them is cheaper.

### How the systems work technically

What public documents confirm [Source]:

- **Hardware plus cloud service.** Toronto's award describes "initial purchase and installation of the equipment" as capital and "monthly service charges" as operating cost. York Region's AVL records "vehicle location, speed, plow position, spreader rate, road temperature and dash camera photos" and charges hosting and maintenance separately.
- **Geotab GO devices** plug into the vehicle. Rubicon's waste product used a Geotab GO9 pod plugged under the dashboard, an in-cab tablet app for routing and service verification, and an outward-facing camera ([Waste360, 2020](https://waste360.com/fleet-technology/how-rubiconsmartcity-helps-waste-companies-cut-costs)).
- **Waste route software:** Routeware describes 360-degree cameras, "sensor-based service verification," container tracking and fork scale integration for weights ([Routeware](https://routeware.com/products-smart-truck-automation/)). Sensor types and prices are not stated on the page.
- **Transit CAD/AVL:** Metrolinx's system integrates with the HASTUS scheduling software, uses cellular data (5G), automatic passenger counting from existing infrared sensors and bilingual voice announcements. Brampton's includes more than 131 electronic signs, a data radio network and passenger counters.
- **GTFS-realtime** is the standard feed format for live transit positions. None of the transit articles we read mention it directly; the MTO toolkit discusses it as the publishing standard [Source, partly summarized].

General industry background [General knowledge, not verified in this pass]:

- Heavy trucks expose engine data over the J1939 CAN bus (speed, engine hours, fuel, fault codes). Telematics devices read it through the diagnostic port.
- Waste trucks add lift/tipper arm sensors, PTO (power take-off) sensors, RFID readers on carts, cameras and sometimes scales. Plows add spreader and blade sensors.
- Because these devices already report into Geotab or Telus, a software layer can read that data through the provider's API instead of installing anything. This is what RouteNorth's connect-your-provider direction does, but the provider-API connectors are not built yet.

## 3. What they pay

### What public documents show

| Item | Figure | Notes |
| --- | --- | --- |
| Toronto telematics, BSM Technologies (2017) | Estimated C$15.3 million total over four years plus three two-year options; initial four-year period C$6.46 million net of HST recoveries (C$5.57 million operating, C$0.89 million capital) | Over 475 City vehicles and over 1,400 contracted vehicles had telematics as of December 2016; the City has about 5,200 vehicles. No unit prices. [Source](https://www.toronto.ca/legdocs/mmis/2017/gm/bgrd/backgroundfile-103840.pdf), [funding table](https://www.toronto.ca/legdocs/mmis/2017/gm/bgrd/backgroundfile-103841.pdf) |
| Toronto Solid Waste share of that contract | C$0.89 million initial period, C$1.5 million optional periods | [Calc] from the funding table. Not stated whether it covers collection trucks. |
| Toronto 2021 telematics rollout | 46 devices on sidewalk plows, 614 on City-owned fleet, 1,100 on contracted winter assets | No device prices. "No financial impact" for the audit response. [Source](https://www.toronto.ca/legdocs/mmis/2021/au/bgrd/backgroundfile-172222.pdf) |
| York Region AVL (DM&T) | C$963,810 original; C$1,624,230 after amendment, including C$320,525 for hosting and maintenance | Winter maintenance and roads patrol, not waste. [Source](https://york.ca/media/57226/download) |
| Windsor, Telus FOCUS | Upset limit C$150,000 plus HST for the 2024-25 renewal year | Vehicle count not stated. [Source](https://citywindsor.ca/documents/city-hall/city-council-meetings/CAO_Approvals/CAOP%20150-2024.pdf) |
| Vaughan AVL (2006) | About C$124,568 over three years | RFP asked for capability for up to 60 units. Old. [Source](https://meetingarchives.vaughan.ca/committee_2006/pdf/CWA0116_17.pdf) |
| Mississauga, Webtech (2014) | C$2.1 million extension, five years plus two optional years, 352 to 728 units; about C$500,000 of that was 3G upgrades | Old. [Source](https://www.automotive-fleet.com/127038/ontario-city-signs-2-1m-telematics-contract) |
| Brampton Transit CAD/AVL (2021) | C$9.9 million for 450+ buses, funded C$4M federal, C$3.3M Ontario, C$2.6M City | [Calc] roughly C$22,000 per bus, but that includes signs, radio network and passenger counters. [Source](https://www.masstransitmag.com/technology/intelligent-transportation-systems/communications-navigation-cad-avl-gps/article/21223210/brampton-transit-to-fund-cad-avl-project-with-nearly-c10-million-funding-commitment) |
| Metrolinx/Systrans (2026) | Value not stated; about 500 buses, five-year initial term plus two five-year options, 99.99% uptime SLA | [Source](https://www.masstransitmag.com/bus/maintenance/news/55369762/systrans-an-equans-company-metrolinx-partners-with-systrans-for-cad-avl-upgrade) |

Takeaway: **small and mid-size municipal telematics spend looks like roughly C$100,000 to C$1 million a year, and large-city programs run into the millions.** Windsor's C$150,000 a year line and Wellington's 60 vehicles are the right size for our first customers.

### Per-vehicle prices (third-party estimates only)

| Vendor | Figure | Quality |
| --- | --- | --- |
| Market tiers in Canada | C$18 to C$35 per vehicle per month; hardware free to about C$150; install about C$100; typical three-year contract | [Estimate] Expert Market, page says updated March 2023 with inconsistent dates. [Page](https://www.expertmarket.com/ca/fleet-management/costs) |
| Samsara | US$27 to US$50 per vehicle per month by package; hardware US$1,500 to US$2,500 (low confidence) | [Estimate] Cost aggregator, partly from Vendr deal data. [Page](https://www.costbench.com/compare/samsara-vs-verizon-connect/) |
| Verizon Connect | About US$20 to US$28 per month | [Estimate] Same aggregator |
| Geotab | Not published; "contact sales" | [Estimate] [Page](https://costbench.com/software/fleet-management/geotab/) |
| Waste route software (Routeware, Rubicon) | Not published. Rubicon offered a free pilot of about three months (2020 article) | No number |

Government buyers probably pay less than list through volume and cooperative contracts, and more where cameras, waste sensors or route software are added. Neither effect is quantified anywhere we found.

**How to read the market:** all-in hardware and service is roughly C$20 to C$40 per vehicle per month. A software-only layer competes on the reporting and workflow value above what the customer already pays, so it must cost a fraction of that.

## 4. Why they buy

These are the use cases that appeared in sources; vendor-reported numbers are marked.

- **Winter maintenance liability.** King Township reports that 45 of 45 liability claims were defended using telematics data, and a 30% drop in winter material use per storm (both vendor-reported by Geotab). Port Colborne reports claims resolved in hours rather than days or weeks (vendor-reported).
- **Proof of service for waste.** Photos, GPS and sensors prove a bin was collected; this is the pitch of Routeware and Rubicon.
- **Audit pressure.** Toronto's 2021 audit response committed to an enterprise-wide telematics rollout across City and contracted vehicles.
- **Contractor oversight.** Cities that outsource collection or winter work want data from the contractor's fleet (Toronto's contracted-vehicle rollout is an example).
- **Public complaint handling and service data.** Port Colborne and King Township pair tracking with citizen-facing insights.

## 5. Procurement realities

### Rules that apply

- **Broader Public Sector Procurement Directive (effective 13 April 2026)** applies to hospitals, school boards, universities, colleges, children's aid societies and corporations they control. **Municipalities are not named in the text we read**, so municipalities follow their own purchasing by-laws [Source: [Directive](https://www.ontario.ca/files/2026-03/bps-procurement-directive-en-2026-04-13.pdf)]. Municipal by-law thresholds were not researched; expect quotes or invitational competition for mid-size purchases and open tender above a by-law threshold, and read each target's by-law [General knowledge].
- For BPS bodies (school boards, hospitals, colleges) the directive requires open competitive procurement at **C$139,000 or more** for goods and non-consulting services, invitational (at least three suppliers) from C$10,000 to under C$139,000 as a recommended practice, a posting of at least 15 calendar days for C$139,000 to C$368,000, an award notice, supplier debriefs (request within 60 days), and records kept seven years.
- **Vendor-of-record first.** The directive's centralization appendix says BPS organizations "must use existing VOR arrangements whenever possible and appropriate," and sets a two-year maximum for new contracts and extensions, with a Procurement Rationale Report to the funding ministry 45 days before release for exceptions. The tool read this from an appendix; check the exact scope before relying on it.
- **Municipal Buy Ontario Procurement Directive (in effect from 13 April 2026 for municipalities)** covers fleet vehicles under 4,500 kg (must be Ontario-made where feasible) and capital infrastructure including transit fleet vehicles, with Canadian and Ontario content scoring at C$139,000 and above for goods and services. **It excludes information technology**, and has no general Canadian-supplier preference [Source: [Ontario](https://www.ontario.ca/page/municipal-buy-ontario-procurement-directive)]. So a Canadian SaaS vendor is not directly disadvantaged, but a telematics purchase bundled into a capital project could draw questions about domestic content.
- **Ontario Public Buyers Association and electronic tendering.** Public tenders are posted on electronic systems. Examples seen: Vaughan's 2005 RFP was on ETN and the Ontario Public Buyers Association site. Today's venues (MERX, Biddingo, municipal portals, Ontario Tenders Portal) were not searched.

### Privacy and data residency (MFIPPA)

- The IPC's guidance, as summarized by a law firm, says Ontario's access and privacy acts **do not prohibit outsourcing or storing data outside Ontario or Canada**, but institutions keep "effective control" and must address privacy and security in the contract: limits on use, subcontractors held to the same standard, breach notice, cooperation on access requests, and monitoring. Privacy impact and threat risk assessments are expected where appropriate [Source: [Lerners summary](https://www.lerners.ca/lernx/privacy-access-considerations-when-contracting-with-third-parties-ipc-new-guidance-public-sector/); the IPC document itself was not read].
- **City of Toronto's guideline** says there is no legislated residency rule but "encourages" Canadian storage, prefers a Canadian multi-zone cloud region, requires a risk analysis if data goes abroad, recommends ISO 27001, SOC 2 or CSA STAR, and requires contract terms on jurisdiction limits, audit and cyber insurance. Every cloud purchase goes through an architecture review [Source: [Toronto guideline](https://www.toronto.ca/wp-content/uploads/2023/08/966e-Data-Residency-for-Cloud-Technology-Guidelinev1.0.pdf), tool read about 73% of it verbatim].
- Translation: **host in Canada, document it, and expect a security and privacy review of 4 to 12 weeks.** (The review length is an estimate [General knowledge].)
- GPS history of a named driver is personal information. Camera footage adds more. The existing RouteNorth compliance plan already treats this seriously.

### Accessibility, language, insurance, references

- **AODA:** municipalities are covered. Organizations must include accessibility criteria when buying "where possible," and public websites must be accessible [Source: [Ontario accessibility rules](https://www.ontario.ca/page/accessibility-rules-public-sector-organizations)]. The WCAG level for procurement was not stated on the pages read. Expect buyers to ask for a WCAG 2.1 AA conformance statement or VPAT [General knowledge].
- **Bilingual needs:** Metrolinx's CAD/AVL includes bilingual announcements, but French-service rules for municipal software were not researched. Some designated areas of Ontario require French service. Treat French support as a likely question in eastern and northern Ontario [General knowledge].
- **Insurance:** RFPs typically ask for commercial general liability, errors and omissions, and cyber liability coverage in the millions of dollars. Exact minimums were not researched [General knowledge].
- **References and track record** are scored in nearly every RFP. This is the main reason to land pilots and small contracts first.
- **Security questionnaires** are normal. Our compliance plan says RouteNorth is not SOC 2 or ISO certified and should not claim to be.

## 6. Go-to-market plan

### What to sell

**A fleet operations dashboard and reporting layer on top of the telematics a municipality or contractor already has**, with two government-shaped packages:

1. **Public works package.** Plow, spreader and general fleet reporting: service verification by route, winter patrol records, vehicle utilization, idling, maintenance due, driver behaviour, exportable audit trail for liability claims.
2. **Waste package.** Route and stop completion, missed-collection complaint tracking, photo evidence, contractor scorecards, and a feed or report a city can demand from its collection contractor.

Do **not** pitch to replace CAD/AVL on buses or to replace Geotab. Do not sell devices.

### Who to approach, in order

1. **Mid-size Ontario municipalities and counties** already on Geotab or Telus, 50 to 300 vehicles. Start with fleet or public works managers, not procurement. Counties like Wellington, towns like Port Colborne and townships like King are the right profile (they are Geotab-reference accounts, which also shows they are open to telematics tooling).
2. **Waste and snow contractors** that serve those municipalities. They want to win and keep municipal contracts and need proof-of-service reports.
3. **Resellers and implementers** (such as Dican and Optisolve for Geotab, Advantage One Technology on Canoe). They already hold the customer relationship and the Canoe or VOR paperwork. Offer them a revenue share for adding RouteNorth reporting. Whether Geotab's marketplace or partner terms allow this was not researched.
4. **Later:** large cities and regions, once there are references, SOC 2 progress and SSO. Transit and school buses only after a municipal reference exists.

### Pricing (hypothesis, to test in pilots)

- **Pilot:** free or up to about C$5,000 for 60 to 90 days, 10 to 25 vehicles. Rubicon used a free three-month pilot in 2020, so it is accepted practice. Keep the pilot under any purchasing-by-law threshold by making it a no-cost agreement or a small invoice, but check each by-law.
- **Subscription:** C$5 to C$10 per vehicle per month for the dashboard layer, with a minimum annual fee; add-on pricing for waste proof-of-service and camera/photo storage. This is our guess against the C$20 to C$40 all-in range in section 3.
- **Onboarding and training:** a flat fee, because connectors, data cleanup and driver training are real work.
- **Annual deal size:** 100 vehicles at C$8 is about C$9,600 a year. That is small enough to buy without a formal tender at most municipalities (to be confirmed per by-law) but too small to support a company alone. The business case depends on many small accounts, resellers, or contractors, not one big win.

### Pilot approach

1. Pick one pain with a measurable result (winter route verification, waste complaint resolution time, claims investigation time).
2. Read-only connection to the customer's existing provider account. No install, no hardware.
3. Weekly report to the fleet manager; a written one-page result at the end with numbers.
4. Get a named reference and permission for a case study. Government references are the real prize of the pilot.
5. Convert to a paid annual agreement under the municipality's quote threshold, or ride a cooperative contract through a reseller.

### Partnering with incumbents

- **Device vendors are partners first.** Geotab and Telus are both on Canoe and (probably) the Supply Ontario VOR. Our value is not competing for the device contract.
- **Resellers** can bundle us. Approach them with a demo built on their customers' typical data.
- **Cooperative contracts** (Canoe, Sourcewell) have an "approved supplier" path. The Canoe site links to a "Become an Approved Supplier" page, which we did not read. Check it once there are references, since it is slow and usually requires a prior competitive solicitation.
- **Supply Ontario VOR** has a refresh option annually; the next major window is not known. Not a first-year target.

## 7. What RouteNorth must add to be credible

Based on the repo's own documents (`docs/COMPLIANCE_PLAN.md`, `docs/NEXT_PLAN_STATUS.md`, the owner portal status) and this research. Check each against the code before committing to a date.

| Gap | Why a government buyer cares | Today | Priority |
| --- | --- | --- | --- |
| **Canadian hosting** | Toronto-style guidelines prefer Canadian storage; questionnaires ask. | The Vercel site exists, but the API, Postgres and Redis have no host picked. | **Must do before any pilot with real data** |
| **Provider connectors** (Geotab first, then Telus/Skyhawk, Samsara, Motive) | Our whole pitch is reading the telematics they already have. | Not built. Only the GPS feed and Traccar forwarding exist. Nothing tested with a real provider. | **Must do** |
| **Waste features** | Proof of service, missed-collection handling, route and stop completion, photo evidence, contractor scorecards. | Routes and stops exist in general; waste-specific workflows not confirmed. | High |
| **Winter patrol records** | Liability defence for municipalities. | Not confirmed. | High |
| **SSO** (Microsoft Entra / SAML / OIDC) | Municipal IT usually requires it. | Not built. | High |
| **Audit log and access control** | Security reviews ask for them. | Built: append-only audit log, roles, two-factor, IP allowlist, sessions, retention, export and erase. | Done; document it |
| **Security certification** | Large buyers want SOC 2 or ISO 27001. | Not certified. Compliance plan has a 12-month path. | Medium. Start evidence collection now |
| **Accessibility conformance report** | AODA, municipal purchasing. | A public accessibility page exists; no independent audit. | High before first formal RFP |
| **Privacy pack** (PIA support, data processing terms for MFIPPA, retention settings, subprocessor list) | The IPC expects contract terms and assessments. | Legal pages are drafts needing a lawyer. Retention and export exist. | High |
| **French UI and documents** | Bilingual buyers and drivers. | Legal pages are in French; the rest of the UI not confirmed. | Medium |
| **GTFS-realtime vehicle positions output** | Small transit agencies publishing live data; trip planners consume it. | Not built. | Low until a transit pilot exists |
| **Insurance** (cyber, errors and omissions, general liability) | Standard RFP requirement. | Unknown. | Needed before signing |
| **Support and uptime commitments** | Metrolinx asked for 99.99% uptime; municipalities ask for an SLA. | Public status page exists; no SLA. | Medium |

## 8. What we still do not know (next research)

1. Real municipal purchasing by-law thresholds for three or four target municipalities (read them directly).
2. Tender listings: search MERX, Biddingo, the Ontario Tenders Portal and municipal portals for "GPS", "AVL", "telematics" and "waste collection tracking" awards in Ontario for actual unit prices.
3. TTC and other large transit agencies' current systems and contracts.
4. Geotab Marketplace and partner terms; whether a third-party dashboard can be listed and how revenue works.
5. The Canoe "Become an Approved Supplier" process and Supply Ontario VOR refresh timing.
6. Whether Ontario's Minimum Maintenance Standards for municipal highways make AVL records a defence in claims (commonly said, not verified here) [General knowledge].
7. Current school bus consortium counts, vendors and tracking contracts.
8. Typical insurance minimums and French-language service rules in tenders.
9. A few discovery calls with fleet managers: what they pay per vehicle, what they dislike about their current reports, and who signs.

## Sources

Read in this pass (some PDFs only partly readable, as noted above):

- Ontario BPS Procurement Directive, April 2026: https://www.ontario.ca/files/2026-03/bps-procurement-directive-en-2026-04-13.pdf
- Municipal Buy Ontario Procurement Directive: https://www.ontario.ca/page/municipal-buy-ontario-procurement-directive
- Accessibility rules for public sector organizations: https://www.ontario.ca/page/accessibility-rules-public-sector-organizations and https://www.ontario.ca/page/accessibility-rules-procurement
- Supply Ontario Fleet Management Services VOR: https://www.supplyontario.ca/?p=3956
- Canoe Fleet Management Program: https://canoeprocurement.ca/program/fleet-management-program/
- Canoe Transit and Mobility Technology Program: https://canoeprocurement.ca/program/transit-and-mobility-technology-program/
- Sourcewell Edulog contract: https://www.sourcewell-mn.gov/cooperative-purchasing/102924-EDL
- Toronto telematics award and funding: https://www.toronto.ca/legdocs/mmis/2017/gm/bgrd/backgroundfile-103840.pdf, https://www.toronto.ca/legdocs/mmis/2017/gm/bgrd/backgroundfile-103841.pdf, https://www.toronto.ca/legdocs/mmis/2021/au/bgrd/backgroundfile-172222.pdf
- Toronto District 2 collection award: https://www.toronto.ca/legdocs/mmis/2024/gg/bgrd/backgroundfile-248375.pdf
- Toronto data residency guideline: https://www.toronto.ca/wp-content/uploads/2023/08/966e-Data-Residency-for-Cloud-Technology-Guidelinev1.0.pdf
- York Region AVL: https://york.ca/media/57226/download
- Windsor Telus renewal: https://citywindsor.ca/documents/city-hall/city-council-meetings/CAO_Approvals/CAOP%20150-2024.pdf
- Vaughan AVL RFP: https://meetingarchives.vaughan.ca/committee_2006/pdf/CWA0116_17.pdf
- Mississauga Webtech: https://www.automotive-fleet.com/127038/ontario-city-signs-2-1m-telematics-contract
- Geotab case studies: https://www.geotab.com/case-study/wellington-county, https://geotab.com/case-study/city-of-port-colborne, https://www.geotab.com/case-study/king-township-public-works-transformation/
- Brampton, Hamilton, Metrolinx and GO transit articles (links in section 2), and the MTO transit technology toolkit.
- Ministry of Education student transportation review: https://efis.fma.csc.gov.on.ca/faab/SBBSB_Content/3_Student_Transportation/EE_Review_Final_Report_EN.pdf
- Lerners summary of IPC guidance: https://www.lerners.ca/lernx/privacy-access-considerations-when-contracting-with-third-parties-ipc-new-guidance-public-sector/
- Pricing estimates: https://www.expertmarket.com/ca/fleet-management/costs, https://costbench.com/software/fleet-management/geotab/, https://www.costbench.com/compare/samsara-vs-verizon-connect/
- Waste technology: https://routeware.com/products-smart-truck-automation/, https://routeware.com/municipalities/, https://waste360.com/fleet-technology/how-rubiconsmartcity-helps-waste-companies-cut-costs
