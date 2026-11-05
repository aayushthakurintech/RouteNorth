# How GPS data gets from the vehicle to the screen

This is the path one position takes, what is checked on the way, where each value is stored, and which screen shows it. It describes what the code does today; things that are not built are listed at the end.

## 1. Where data comes from

| Source | How it arrives | Notes |
| --- | --- | --- |
| Hardware trackers (Teltonika, Queclink, Concox and the other 200+ protocols Traccar decodes) | Tracker → Traccar server → `POST /ingest/traccar` on the ingest service (Traccar's "forward" feature) | Traccar owns the radio protocols and keeps a raw copy. The device is registered in RouteNorth under its IMEI (Trackers page). |
| Phone apps, vendor APIs, gateways | `POST /ingest/positions` with a JSON batch | Needs `INGEST_TOKEN` (Bearer header). Devices are registered with source `api`. |
| Driver phone (PWA) | Reports through the API while a shift or route is active | Foreground only; browsers do not allow reliable background tracking. A native app is not built. |
| Simulator | Same JSON as Traccar's forward | For demos and tests only. |

The ingest service holds no vehicle logic. It turns each source into one `Reading` and hands it to the shared pipeline.

## 2. What happens to one reading

1. **Normalize** (`apps/ingest/src/traccar.ts`, `generic.ts`). Units become metres, km/h and ISO time (Traccar speed is in knots). Sensor attributes (ignition, odometer, battery, external voltage, fuel level, RPM, engine hours, signal, satellites, HDOP) are mapped to named fields. Unusable payloads are counted and dropped, never stored.
2. **Resolve the device** to an organization through the `resolve_device()` SQL function. A tracker nobody registered is counted in `ingest_unknown` so the owner can see it on the Trackers page, and its data is not kept.
3. **Quality gate** (`assessReading`, `packages/shared/src/telemetry.ts`). Each reading gets one verdict:
   - refused: coordinates out of range or 0,0, time too far in the future or older than 30 days, fewer than 3 satellites, HDOP above 12, or a jump implying more than 250 km/h from the last accepted point;
   - accepted but flagged: HDOP above 5, a late fix (stored as history only so "latest position" never moves backwards);
   - compressed: a parked vehicle (under 1.5 km/h, within 25 m) is kept as "latest only", with a history row at most every 5 minutes;
   - rebaselined: three mutually consistent "impossible" jumps mean the old baseline was wrong, so the new place is accepted.
   Duplicates (same device and time) are dropped by the primary key.
4. **Events.** Harsh braking and acceleration are graded from speed change per second (moderate, severe, extreme); tracker alarms (SOS, tow, jamming, low battery, power cut) become `device_events`. A GPS-derived and a tracker-raised event within 15 seconds are merged into one.
5. **Persist.** Accepted history goes to `positions` (a Timescale hypertable when the extension is present, a plain table otherwise, PostGIS geography when present). `latest_positions` holds one row per device for the live map. Everything is scoped by `org_id` and protected by row-level security.
6. **Count.** Every outcome (stored, parked, duplicate, each refusal reason) is tallied per organization per day in `ingest_counters`, flushed in batches. This feeds the Data quality card.

## 3. Calculations on stored data

All in `packages/shared`, pure functions with tests, so the same rule is used by the API, the reports and the screens.

| Calculation | Rule in short | File |
| --- | --- | --- |
| Trips | A trip starts when the vehicle moves and ends after a stop longer than the organization's threshold. | `trips.ts` |
| Idling | Engine on and not moving for at least the idle threshold (default 5 minutes). Fuel is an estimate from typical litres per hour for the vehicle type; cost needs a fuel price in Settings; CO₂ uses 2.68 kg per litre of diesel and 2.31 for gasoline. | `telematics.ts` |
| Utilization | Share of days with real driving, and share of the workday spent moving. Days with no data count as unused. | `telematics.ts` |
| Fuel events | Median-smoothed fuel level; a rise is a refuel, a fall while parked is a possible drain. Idle burn is subtracted so slow idling is not called theft. Needs a fuel sensor. | `telematics.ts` |
| Track display | Douglas–Peucker simplification (5 m default) so a day's drive draws quickly. | `telematics.ts` |
| Driver safety score | 100 minus 5 per penalty point per 1,000 km; formula shown on screen. | `driver-logic.ts` |
| Hours of service | Clocks for driving, on-duty window, elapsed time, 30-minute break (US) and cycle, for Canada federal cycles 1 and 2 and for US 60/70 hour rules. Built from shifts, breaks and when the assigned vehicle was moving. **Estimates only. This is not a certified ELD and not the driver's official log.** | `hos.ts` |

## 4. Where each value is shown

| Value | Screen |
| --- | --- |
| Latest position, heading, speed, status | Live map and vehicle list |
| Trail for the last hours | Live map (selected vehicle) |
| Satellites, backup battery, vehicle voltage, fuel level, RPM, engine hours, signal | Live map vehicle card ("Tracker data"), Trackers page |
| Tracker health (healthy, needs attention, not reporting) | Trackers page |
| Refused, parked and duplicate readings | Trackers page, Data quality card |
| Tracker alarms | Trackers page, Alerts |
| Distance per day, moving and idle time | Reports → Distance |
| Idle stops, fuel burned, cost, CO₂ | Reports → Idling |
| Days used, moving share, light or unused vehicles | Reports → Utilization |
| Refuels and possible drains | Reports → Fuel |
| Hours-of-service clocks | Safety → Hours of service |
| Past trips with replay | Trip log and History |

## 5. Retention and privacy

Positions are personal information when they can be tied to a driver. Retention is set per organization; export and delete requests are handled under the privacy pages. See `docs/COMPLIANCE_PLAN.md`.

## 6. Not built, or not verified

- Real trackers and a real Traccar server have not been connected in testing; only the simulator and recorded payload shapes were.
- Timescale compression and PostGIS branches are written but were not run in the development sandbox.
- A certified ELD (Canada and US) is integrated through a certified provider in a later phase, not built here.
- Background GPS on phones needs a native app.
- Map tiles come from a third-party provider; no key is set in development.
