# Pilot prospects in Ontario: small IT companies and startups

Written 2026-11-15. **Nobody on this list has been contacted, and nobody has said they would test RouteNorth.** These are leads found in public pages, ranked by how well they fit. Each fact says which page it came from; anything a page did not say is marked "not stated". Company websites change, so check each one before you write to anyone.

## What "ready to test" should mean

You said "local" means small IT companies and startups in Ontario. RouteNorth is software that sits on top of GPS data a company already has, so the best testers are companies that either **run vehicles and already have a GPS provider**, or **sell and support GPS to fleets** and could put RouteNorth in front of their own customers. Plain IT-support firms with no vehicles and no fleet customers cannot test a fleet product, so they rank last.

A good first tester has:

1. 5 to 30 vehicles, or a few customers with that many.
2. A GPS provider RouteNorth can read: Geotab or Samsara through the connector, or any provider that can push JSON or forward from Traccar (see `docs/PILOT_READINESS.md`).
3. One person who will spend about 20 minutes a week for 60 days and say what is missing.
4. Willingness to sign the pilot terms in `docs/PILOT_AND_LEGAL.md`.

## Ranked leads

### A. Geotab resellers in Ontario (best fit: they already have fleet customers on Geotab)

RouteNorth's Geotab connector reads a customer's vehicles, so a reseller can try it with one of its own customers in an afternoon.

| Lead | What the page says | Not stated | Source |
| --- | --- | --- | --- |
| **Zenduit** | Fleet telematics and IoT; GPS tracking, AI video, analytics. Authorized Geotab reseller with Supply Ontario Vendor of Record status. Founded 2015. Page claims 10,000+ customers and 40,000+ connected vehicles. Serves municipal, education, logistics, construction and agri-food fleets. | City (the only address on the page is the incubator's, in Markham), team size. | ventureLAB portfolio page for Zenduit |
| **Astreon** | IoT aggregator and service provider in the Greater Toronto Area, "VAR-focused" with partners worldwide; sells white-labelled and own-brand IoT solutions. | Exact city, team size. | Geotab Marketplace partner page for Astreon |
| **Trackingme** | Telematics provider: fleet management, asset tracking, fuel sensors, dashcams, Geotab integration; says it serves "fleets of all sizes". | City and province (the page says only Canada), team size. | Geotab Marketplace partner page for Trackingme |

How to pitch a reseller: RouteNorth is **a reporting and owner-dashboard layer on the customer's existing Geotab data**, not a competing tracker. Ask for one small customer (or their own demo fleet) for a 60-day free pilot. Be honest that the first version reads Geotab and Samsara only, and that no real Geotab account has been connected yet (`docs/PILOT_READINESS.md`, compatibility table). A reseller may also see you as a threat to its own reports, so say up front that you are not selling devices.

### B. Ontario startups that run or manage vehicles (they might become direct pilot customers)

The StartupBlink Ontario transportation list gave one-line descriptions only: no city, size or website for any entry. Everything below needs its own check.

| Lead | One-line description | Why it might fit | Caution |
| --- | --- | --- | --- |
| **Driverseat** (Owen Sound) | Passenger transport and micro-transit | Runs vehicles and drivers; shows Owen Sound as its city | Unknown tracking setup and size |
| **GoFor** (Ottawa) | On-demand delivery for construction, cars, vans and heavy trucks, contracted drivers | Vehicle-based service; Ottawa per a 2019 article | The article is stale; it uses contracted drivers, so it may not own a fleet; current status unverified |
| **Tyltgo** | Courier and logistics for businesses | Delivery fleet or contractors | Nothing else stated |
| **Envoi** | Same-day delivery for retailers | Delivery fleet or contractors | Nothing else stated |
| **Flott** | AI last-mile delivery for Canadian households and businesses | Delivery fleet | May build its own tracking |
| **Upper** | Routes, real-time tracking and faster deliveries | Possible competitor more than a customer | Check before writing |
| **Mosaic** | Free cloud transportation management software for shippers | Possible partner or competitor | Check before writing |

Also listed but a poor fit: Fiix (mobile auto repair; fleet service not stated), RideAlike and Drop Mobility (vehicle sharing and micro-mobility, not trucks or buses), and an unnamed startup seeking financing for tractor trailers.

### C. Small managed IT firms (lowest fit)

The Clutch list of Ontario managed-service providers showed **no firm that mentions field service, vehicles, IoT or telematics**. The nearest small ones are Nuformat (Markham, 2 to 9 employees), ITS Canada (2 to 9), Genieall (10 to 49; a "GPS, Navigation & GIS" tag appears in its reviews), CGTechnologies (10 to 49) and CloudVanguard IT (Ajax, 2 to 9; a summary, not the page text, says it has a transportation and logistics client). Use them only as a way to reach a fleet customer: "do any of your clients run vehicles?" Do not expect them to test it themselves.

### Not a lead, but useful

Geotab itself is headquartered in Oakville, Ontario (Invest Ontario success story, undated). Its marketplace is where the resellers above are listed and is the likely place to list RouteNorth later; that takes an application and was not researched.

## What was not done

- No person, email address or phone number was collected, and nothing was sent.
- The Clutch page was partial and the StartupBlink list covered page 1 of 10, so these are samples, not the whole market.
- Fleet sizes, GPS providers and willingness to pilot are unknown for every lead except the three resellers' own descriptions above.
- No search was made of LinkedIn, local founder groups or incubators (ventureLAB, Communitech, MaRS, Invest Ottawa). Those are the next places to look, and a warm introduction from any of them is worth more than a cold email.

## Suggested next steps for you

1. Pick five leads: the three resellers plus the two startups that look most like fleet owners after you check their sites.
2. Find a named person for each on the company's own site or LinkedIn. Send the short pitch in `docs/PILOT_READINESS.md` (outreach template), changed to say you are an Ontario software company and the pilot is free for 60 days.
3. Ask each one three things before the call: how many vehicles, which GPS provider, and what report they cannot get today.
4. Run the pilot on the hosted environment in `docs/DEPLOY_CANADA.md`, one company per organization, and keep notes of what is missing. That list becomes the next build plan.
