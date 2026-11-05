/**
 * Demo history: fourteen days of believable driving for the three demo vehicles, so reports, charts and the
 * replay page have something to show before a real tracker is connected. Deterministic (no randomness), so
 * screenshots and tests are stable. Not used outside the demo and the tests.
 */
import type { pg } from "./index.js";

interface Pt { lat: number; lng: number }
const EARTH = 6371000;
const rad = (d: number) => (d * Math.PI) / 180;
function dist(a: Pt, b: Pt): number {
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH * Math.asin(Math.sqrt(h));
}
function bearing(a: Pt, b: Pt): number {
  const y = Math.sin(rad(b.lng - a.lng)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lng - a.lng));
  return (((Math.atan2(y, x) * 180) / Math.PI) + 360) % 360;
}

interface Plan { device: string; route: Pt[]; kmh: number; dwellMin: number[]; startHourUtc: number; loops: number; tankL: number; lPer100: number; hasFuelSensor: boolean }

const PLANS: Plan[] = [
  { device: "sim-truck-1", kmh: 38, dwellMin: [1, 4, 2, 8, 1], startHourUtc: 12.5, loops: 8, tankL: 300, lPer100: 33, hasFuelSensor: true,
    route: [{ lat: 43.6532, lng: -79.3832 }, { lat: 43.6629, lng: -79.3957 }, { lat: 43.6677, lng: -79.4046 }, { lat: 43.6455, lng: -79.402 }, { lat: 43.6426, lng: -79.3871 }] },
  { device: "sim-bus-1", kmh: 34, dwellMin: [1, 2, 1, 3], startHourUtc: 11, loops: 14, tankL: 220, lPer100: 29, hasFuelSensor: true,
    route: [{ lat: 43.589, lng: -79.6441 }, { lat: 43.596, lng: -79.63 }, { lat: 43.605, lng: -79.635 }, { lat: 43.6, lng: -79.652 }] },
  { device: "sim-truck-2", kmh: 96, dwellMin: [14, 9], startHourUtc: 11.5, loops: 2, tankL: 450, lPer100: 36, hasFuelSensor: false,
    route: [{ lat: 43.7001, lng: -79.4163 }, { lat: 43.8561, lng: -79.0204 }, { lat: 43.9, lng: -78.86 }, { lat: 44.0, lng: -78.6 }] },
];

/** The demo driver works the first truck's days: a shift around each, a half-hour break, a route that ties them together, and one shift still open today. */
async function seedDriverShifts(admin: pg.Pool, orgId: string, vehicleId: string, spans: { start: number; end: number }[], now: Date): Promise<void> {
  const driver = (await admin.query("SELECT id FROM users WHERE org_id = $1 AND email = 'driver@demo.ca'", [orgId])).rows[0]?.id as string | undefined;
  if (!driver) return;
  if ((await admin.query("SELECT 1 FROM shifts WHERE org_id = $1 AND driver_id = $2 LIMIT 1", [orgId, driver])).rowCount) return;
  const iso = (ms: number) => new Date(ms).toISOString();
  for (const sp of spans) {
    const start = sp.start - 20 * 60_000, end = sp.end + 20 * 60_000, mid = start + (end - start) / 2;
    const id = (await admin.query("INSERT INTO shifts (org_id, driver_id, started_at, ended_at, source) VALUES ($1,$2,$3,$4,'manual') RETURNING id", [orgId, driver, iso(start), iso(end)])).rows[0].id as string;
    await admin.query("INSERT INTO shift_breaks (org_id, shift_id, kind, started_at, ended_at) VALUES ($1,$2,'break',$3,$4)", [orgId, id, iso(mid), iso(mid + 30 * 60_000)]);
    await admin.query(
      `INSERT INTO routes (org_id, name, route_date, vehicle_id, driver_id)
       SELECT $1, 'Downtown deliveries', $2::timestamptz::date, $3, $4 WHERE NOT EXISTS (SELECT 1 FROM routes WHERE org_id = $1 AND route_date = $2::timestamptz::date AND vehicle_id = $3)`,
      [orgId, iso(sp.start), vehicleId, driver]);
  }
  // Today's shift is still open, but only once the working day has actually begun (the truck leaves around 12:30 UTC).
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const todayStart = midnight + 12.2 * 3_600_000;
  if (now.getTime() > todayStart + 3_600_000) await admin.query("INSERT INTO shifts (org_id, driver_id, started_at, source) VALUES ($1,$2,$3,'manual')", [orgId, driver, iso(todayStart)]);
}

export interface HistoryResult { positions: number; events: number }

/** Writes history for the demo organization if it has none older than a day. Returns how much was written. */
export async function seedHistory(admin: pg.Pool, orgId: string, days = 14, now = new Date()): Promise<HistoryResult> {
  const has = await admin.query("SELECT 1 FROM positions WHERE org_id = $1 AND time < $2 LIMIT 1", [orgId, new Date(now.getTime() - 86_400_000)]);
  if (has.rowCount) return { positions: 0, events: 0 };
  const devices = (await admin.query("SELECT id, external_id, vehicle_id FROM devices WHERE org_id = $1", [orgId])).rows as { id: string; external_id: string; vehicle_id: string | null }[];
  const midnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  let positions = 0, events = 0;

  for (const plan of PLANS) {
    const dev = devices.find((d) => d.external_id === plan.device);
    if (!dev) continue;
    let odo = 48_000_000, fuel = 82, hours = 3200;
    const rows: unknown[][] = [];
    const evs: unknown[][] = [];
    const spans: { start: number; end: number }[] = [];

    for (let day = days; day >= 1; day--) {
      const dow = new Date(midnight - day * 86_400_000).getUTCDay();
      if (dow === 0 || (dow === 6 && plan.device !== "sim-bus-1")) continue; // Sundays off; on Saturdays only the bus runs
      if (plan.device === "sim-truck-2" && day % 4 === 0) continue; // the long-haul truck sits some days, so utilization has something to show
      let t = midnight - day * 86_400_000 + (plan.startHourUtc + (day % 3) * 0.17) * 3_600_000;
      const push = (p: Pt, speed: number, ign: boolean, heading: number) => {
        const sats = 9 + (Math.round(p.lat * 1000) % 4), hdop = 0.9 + (Math.round(p.lng * 1000) % 5) / 10;
        rows.push([new Date(t).toISOString(), orgId, dev.id, p.lat, p.lng, speed, heading, ign, odo, "traccar", sats, hdop, 96, ign ? 13.8 : 12.6,
          plan.hasFuelSensor ? Math.round(fuel * 10) / 10 : null, ign ? Math.round(900 + speed * 14) : null, Math.round(hours * 10) / 10, 4]);
      };
      const stepS = 30;
      const dayStart = t;
      for (let loop = 0; loop < plan.loops; loop++) {
        for (let i = 0; i < plan.route.length; i++) {
          const a = plan.route[i]!, b = plan.route[(i + 1) % plan.route.length]!;
          const len = dist(a, b), n = Math.max(1, Math.round(len / ((plan.kmh / 3.6) * stepS)));
          const hd = bearing(a, b);
          for (let k = 0; k < n; k++) {
            const f = k / n;
            const speed = plan.kmh * (0.8 + 0.4 * Math.abs(Math.sin((i + k) * 1.7)));
            const p = { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f };
            const step = (speed / 3.6) * stepS;
            odo += step; fuel -= ((step / 1000) * plan.lPer100) / plan.tankL; hours += stepS / 3600;
            push(p, Math.round(speed * 10) / 10, true, hd);
            // A harsh event now and then, as the tracker's own accelerometer would raise it
            if ((day * 7 + i * 3 + k) % 53 === 0) evs.push([orgId, dev.id, new Date(t).toISOString(), (day + i) % 4 === 0 ? "harsh_accel" : "harsh_brake", 2, p.lat, p.lng]);
            t += stepS * 1000;
          }
          // Dwell at the stop with the engine on: the planned minutes, plus extra idling on some days
          const dwell = (plan.dwellMin[i % plan.dwellMin.length] ?? 3) + (day % 5 === 0 && i === 3 ? 18 : 0);
          for (let m = 0; m < dwell * 2; m++) { hours += stepS / 3600; fuel -= (3.8 * (stepS / 3600) * 100) / plan.tankL; push(b, 0, true, hd); t += stepS * 1000; }
        }
      }
      push(plan.route[0]!, 0, false, 0); // engine off at the yard
      t += 60_000;
      if (fuel < 28) { // refuel on the way home: the level jumps up while parked
        for (let m = 0; m < 6; m++) { fuel = Math.min(97, fuel + 12); push(plan.route[0]!, 0, false, 0); t += 60_000; }
      }
      spans.push({ start: dayStart, end: t });
    }
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const width = chunk[0]!.length;
      const params: unknown[] = [];
      const values = chunk.map((_, j) => `(${Array.from({ length: width }, (_, k) => `$${j * width + k + 1}`).join(",")})`).join(",");
      for (const r of chunk) params.push(...r);
      await admin.query(
        `INSERT INTO positions (time, org_id, device_id, lat, lng, speed, heading, ignition, odometer, source, satellites, hdop, battery_pct, ext_voltage, fuel_level_pct, rpm, engine_hours, signal)
         VALUES ${values} ON CONFLICT DO NOTHING`, params);
    }
    for (const e of evs) await admin.query("INSERT INTO device_events (org_id, device_id, time, kind, severity, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING", e);
    positions += rows.length; events += evs.length;
    if (plan.device === "sim-truck-1" && dev.vehicle_id) await seedDriverShifts(admin, orgId, dev.vehicle_id, spans, now);
    // The newest fix becomes the vehicle's latest position (the live simulator overwrites it when it runs).
    const last = rows[rows.length - 1];
    if (last) {
      await admin.query(
        `INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed, heading, ignition, odometer, satellites, hdop, battery_pct, ext_voltage, fuel_level_pct, rpm, engine_hours, signal)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) ON CONFLICT (device_id) DO NOTHING`,
        [dev.id, orgId, last[0], last[3], last[4], last[5], last[6], last[7], last[8], last[10], last[11], last[12], last[13], last[14], last[15], last[16], last[17]]);
    }
  }
  return { positions, events };
}
