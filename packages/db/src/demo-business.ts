/**
 * Demo business: a handful of extra vehicles in every connection state, four more drivers, and thirty days of
 * trips, fuel and expenses, so the owner dashboard and the Connections page show a working company instead of
 * zeros. Deterministic (no randomness). Safe to run twice: it does nothing once "Truck 21" exists.
 * Not used outside the demo and the tests.
 */
import type { pg } from "./index.js";

/** A 15-digit IMEI whose last digit is the Luhn check digit, so the format check in the Add vehicle flow accepts it. */
export function demoImei(body14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i++) {
    let d = Number(body14[13 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return body14 + String((10 - (sum % 10)) % 10);
}

function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
}

export async function seedDemoBusiness(pool: pg.Pool, orgId: string, passwordHash: string, now = new Date()): Promise<boolean> {
  const q = (text: string, params: unknown[] = []) => pool.query(text, params);
  if ((await q("SELECT 1 FROM vehicles WHERE org_id = $1 AND name = 'Truck 21'", [orgId])).rowCount) return false;
  const rnd = lcg(20261114);
  const minutesAgo = (m: number) => new Date(now.getTime() - m * 60_000).toISOString();

  // ---- vehicles and their trackers: one in every connection state -------------------------------------------------------
  type V = { name: string; kind: string; plate: string; device?: { source: string; id: string; method: string; model?: string }; lastSeenMin?: number; at?: [number, number]; speed?: number };
  const specs: V[] = [
    { name: "Truck 21", kind: "truck", plate: "CLRK 842", device: { source: "traccar", id: demoImei("86406105521437"), method: "traccar", model: "Teltonika FMB920" }, lastSeenMin: 1, at: [43.7315, -79.7624], speed: 62 },
    { name: "Truck 15", kind: "truck", plate: "BXNT 311", device: { source: "traccar", id: demoImei("35206708813902"), method: "traccar", model: "Queclink GV350" }, lastSeenMin: 190, at: [43.4516, -80.4925], speed: 0 },
    { name: "Van 2", kind: "van", plate: "AZ4 7719", device: { source: "feed", id: "van-2-gateway", method: "feed" }, lastSeenMin: 3, at: [43.5448, -80.2482], speed: 41 },
    { name: "Bus 8", kind: "bus", plate: "TRN 5520", device: { source: "traccar", id: demoImei("86712304456619"), method: "traccar", model: "Concox GT06N" } },
    { name: "Truck 30", kind: "truck", plate: "HRT 0087" },
  ];
  const vehicleIds: Record<string, string> = {};
  for (const s of specs) {
    const v = (await q("INSERT INTO vehicles (org_id, name, kind, plate) VALUES ($1,$2,$3,$4) RETURNING id", [orgId, s.name, s.kind, s.plate])).rows[0].id as string;
    vehicleIds[s.name] = v;
    if (!s.device) continue;
    const d = (await q(
      "INSERT INTO devices (org_id, vehicle_id, source, external_id, model, connection_method) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [orgId, v, s.device.source, s.device.id, s.device.model ?? null, s.device.method])).rows[0].id as string;
    if (s.lastSeenMin !== undefined && s.at) {
      await q(
        "INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed, heading, ignition) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
        [d, orgId, minutesAgo(s.lastSeenMin), s.at[0], s.at[1], s.speed ?? 0, 90, (s.speed ?? 0) > 0]);
    }
  }
  const allVehicles = (await q("SELECT id, name FROM vehicles WHERE org_id = $1 ORDER BY name", [orgId])).rows as { id: string; name: string }[];

  // ---- drivers ---------------------------------------------------------------------------------------------------------
  const driverNames: [string, string][] = [["amrit@demo.ca", "Amrit Gill"], ["marc@demo.ca", "Marc Tremblay"], ["priya@demo.ca", "Priya Nair"], ["jordan@demo.ca", "Jordan Whitehorse"]];
  const driverIds: string[] = [];
  for (const [email, name] of driverNames) {
    const id = (await q("INSERT INTO users (org_id, email, password_hash, role, display_name) VALUES ($1,$2,$3,'driver',$4) RETURNING id", [orgId, email, passwordHash, name])).rows[0].id as string;
    driverIds.push(id);
  }
  const demoDriver = (await q("SELECT id FROM users WHERE org_id = $1 AND email = 'driver@demo.ca'", [orgId])).rows[0]?.id as string | undefined;
  if (demoDriver) driverIds.push(demoDriver);

  // Plates for the three original demo vehicles, and a permanent driver for each vehicle that earns.
  await q("UPDATE vehicles SET plate = CASE name WHEN 'Truck 7' THEN 'CKTR 407' WHEN 'Truck 12' THEN 'BZMP 125' WHEN 'Bus 3' THEN 'TRN 3303' END WHERE org_id = $1 AND plate IS NULL AND name IN ('Truck 7','Truck 12','Bus 3')", [orgId]);
  for (const [i, v] of allVehicles.filter((x) => x.name !== "Truck 30").entries()) {
    await q("INSERT INTO vehicle_assignments (org_id, vehicle_id, driver_id, kind, start_at) VALUES ($1,$2,$3,'permanent',$4)", [orgId, v.id, driverIds[i % driverIds.length], minutesAgo(60 * 24 * 40)]);
  }

  // ---- thirty days of trips ---------------------------------------------------------------------------------------------
  const customers = ["Maple Leaf Foods", "Brampton Transit", "Northern Lumber", "Great Lakes Produce", "Metro Courier", "Halton Building Supply", "Lakeshore Dairy"];
  const lanes = [["Toronto to Hamilton", 70, 57_000], ["Mississauga to Guelph", 62, 49_000], ["Brampton to Barrie", 78, 68_000], ["Toronto to Kingston", 262, 179_000], ["Downtown deliveries", 24, 29_000], ["Oakville to London", 168, 126_000]] as const;
  const earning = allVehicles.filter((v) => v.name !== "Truck 30");
  const tripRows: unknown[][] = [];
  for (let day = 29; day >= 0; day--) {
    const date = new Date(now.getTime() - day * 86_400_000);
    const dow = date.getUTCDay();
    if (dow === 0) continue; // Sundays off
    earning.forEach((v, vi) => {
      if (rnd() < (dow === 6 ? 0.55 : 0.12)) return; // some idle days
      const lane = lanes[Math.floor(rnd() * lanes.length)]!;
      const driver = driverIds[(vi + day) % driverIds.length];
      const started = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 11 + Math.floor(rnd() * 3), Math.floor(rnd() * 60)));
      if (started > now) return;
      const km = lane[1] * (0.95 + rnd() * 0.15);
      const durS = Math.round((km / (lane[1] > 100 ? 78 : 36)) * 3600 + 900);
      const revenue = Math.round(lane[2] * (0.9 + rnd() * 0.25));
      const ended = new Date(Math.min(now.getTime(), started.getTime() + durS * 1000));
      tripRows.push(
        [orgId, v.id, driver, customers[Math.floor(rnd() * customers.length)], lane[0], started.toISOString(), ended.toISOString(), Math.round(km * 1000), durS,
          1 + Math.floor(rnd() * 5), Math.round(2000 + rnd() * 9000), lane[1] > 100 ? "Highway" : "GTA", revenue, lane[1] > 100 ? Math.round(rnd() * 1800) : 0]);
    });
  }
  for (const row of tripRows) {
    await q(
      `INSERT INTO portal_trips (org_id, vehicle_id, driver_id, customer_name, title, started_at, ended_at, distance_m, duration_s, stops, weight_kg, zone, status, revenue_cents, toll_cents, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'completed',$13,$14,'import')`, row);
  }
  const trips = tripRows.length;

  // ---- fuel and expenses ------------------------------------------------------------------------------------------------
  for (const v of earning) {
    for (let w = 3; w >= 0; w--) {
      const litres = 180 + Math.round(rnd() * 120);
      const day = new Date(now.getTime() - (w * 7 + Math.floor(rnd() * 3)) * 86_400_000).toISOString().slice(0, 10);
      const cost = Math.round(litres * (1.72 + rnd() * 0.12) * 100) / 100;
      await q("INSERT INTO fuel_logs (org_id, vehicle_id, filled_on, litres, cost, odometer_km, station, source) VALUES ($1,$2,$3,$4,$5,$6,$7,'import')",
        [orgId, v.id, day, litres, cost, 120000 + Math.round(rnd() * 50000), ["Petro-Canada Milton", "Esso 401 Westbound", "Husky Cambridge", "Pioneer Barrie"][Math.floor(rnd() * 4)]]);
      await q("INSERT INTO finance_expenses (org_id, spent_on, category, amount_cents, tax_cents, vendor, vehicle_id, source) VALUES ($1,$2,'fuel',$3,$4,'Fuel card',$5,'import')",
        [orgId, day, Math.round(cost * 100), Math.round(cost * 13), v.id]);
    }
  }
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
  for (const [category, vendor, cents] of [["insurance", "Intact Commercial", 842_000], ["finance", "RBC Equipment Finance", 615_000], ["software", "RouteNorth", 29_900], ["tires", "Kal Tire", 186_400], ["maintenance", "Fleet Service Centre", 124_800]] as const) {
    await q("INSERT INTO finance_expenses (org_id, spent_on, category, amount_cents, tax_cents, vendor, source) VALUES ($1,$2,$3,$4,$5,$6,'import')", [orgId, monthStart, category, cents, Math.round(cents * 0.13), vendor]);
  }
  await q("INSERT INTO maintenance_logs (org_id, vehicle_id, task, done_on, cost, vendor) VALUES ($1,$2,'Oil and filter service',$3,$4,'Fleet Service Centre')",
    [orgId, vehicleIds["Truck 21"], new Date(now.getTime() - 9 * 86_400_000).toISOString().slice(0, 10), 412.5]);
  console.log(`created ${trips} demo trips, fuel fills, expenses and 5 extra vehicles in every connection state`);
  return true;
}
