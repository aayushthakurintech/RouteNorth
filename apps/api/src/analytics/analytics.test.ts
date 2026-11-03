import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";

let h: Harness;
let owner: string, viewer: string, driverTok: string, orgBadmin: string;
let drvA: string, drvB: string, veh: string, dev: string, vehB: string, devB: string;
const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
const at = (hhmm: string) => `${day}T${hhmm}:00Z`;

async function route(name: string, driver: string, vehicle: string, stops: { win?: string; arrived?: string; status: string; reason?: string; lat: number; lng: number; w?: number }[]) {
  const r = (await h.admin.query("INSERT INTO routes (org_id, name, route_date, vehicle_id, driver_id, status) VALUES ($1,$2,$3,$4,$5,'completed') RETURNING id", [h.orgA, name, day, vehicle, driver])).rows[0].id;
  for (const [i, s] of stops.entries()) {
    await h.admin.query(
      `INSERT INTO stops (org_id, route_id, sequence, name, lat, lng, window_end, arrived_at, departed_at, status, failure_reason, weight_kg) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11)`,
      [h.orgA, r, i + 1, `Stop ${i + 1}`, s.lat, s.lng, s.win ? at(s.win) : null, s.arrived ? at(s.arrived) : null, s.status, s.reason ?? null, s.w ?? 0]);
  }
  return r as string;
}

/** A vehicle drives north along a line for 20 minutes at the given speeds, one fix every 5 seconds. */
async function drive(deviceId: string, startHHMM: string, speeds: number[], lat0 = 43.7) {
  let lat = lat0;
  let t = Date.parse(at(startHHMM));
  let odo = 0;
  for (const v of speeds) {
    lat += (v / 3.6) * 5 / 111_320; odo += (v / 3.6) * 5; t += 5000;
    await h.admin.query("INSERT INTO positions (time, org_id, device_id, lat, lng, speed, ignition, odometer) VALUES ($1,$2,$3,$4,-79.4,$5,true,$6)", [new Date(t), h.orgA, deviceId, lat, v, odo]);
  }
}

beforeAll(async () => {
  h = await startHarness({});
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer");
  viewer = await h.token("view@example.com");
  drvA = await h.addUser(h.orgA, "ann@example.com", "driver", { display_name: "Ann" });
  drvB = await h.addUser(h.orgA, "bob@example.com", "driver", { display_name: "Bob" });
  driverTok = await h.token("ann@example.com");
  await h.addUser(h.orgB, "adminb@example.com", "admin");
  orgBadmin = await h.token("adminb@example.com");
  veh = (await h.call("post", "/r/vehicles", owner, { name: "Truck A", capacityKg: 1000 })).body.id;
  vehB = (await h.call("post", "/r/vehicles", owner, { name: "Truck B", capacityKg: 1000 })).body.id;
  dev = (await h.admin.query("INSERT INTO devices (org_id, vehicle_id, source, external_id) VALUES ($1,$2,'simulator','a-1') RETURNING id", [h.orgA, veh])).rows[0].id;
  devB = (await h.admin.query("INSERT INTO devices (org_id, vehicle_id, source, external_id) VALUES ($1,$2,'simulator','b-1') RETURNING id", [h.orgA, vehB])).rows[0].id;

  // Ann: 4 stops, 3 done (one late by 20 minutes), 1 failed. Bob: 2 done on time.
  await route("North loop", drvA, veh, [
    { win: "10:00", arrived: "09:50", status: "done", lat: 43.71, lng: -79.4, w: 300 },
    { win: "11:00", arrived: "11:20", status: "done", lat: 43.72, lng: -79.4, w: 300 },
    { win: "12:00", arrived: "11:30", status: "done", lat: 43.73, lng: -79.4, w: 300 },
    { win: "13:00", arrived: "12:50", status: "failed", reason: "Nobody home", lat: 43.74, lng: -79.4 },
  ]);
  await route("South loop", drvB, vehB, [
    { win: "10:00", arrived: "09:00", status: "done", lat: 43.6, lng: -79.4 },
    { win: "11:00", arrived: "10:30", status: "done", lat: 43.61, lng: -79.4 },
  ]);
  // Ann drives: cruise, a speeding stretch (130 km/h for 60 s), then a hard stop. Bob drives calmly.
  await drive(dev, "09:00", [...Array(60).fill(60), ...Array(12).fill(130), 130, 60, 60, 60]);
  await drive(devB, "09:00", Array(100).fill(50), 43.6);
  await h.admin.query("INSERT INTO fuel_logs (org_id, vehicle_id, driver_id, filled_on, litres, cost, odometer_km) VALUES ($1,$2,$3,$4,50,75,1000),($1,$2,$3,$5,40,60,1400)", [h.orgA, veh, drvA, day, day]);
  await h.admin.query("INSERT INTO maintenance_logs (org_id, vehicle_id, task, done_on, cost, downtime_hours) VALUES ($1,$2,'Brakes',$3,400,6)", [h.orgA, vehB, day]);
  await h.admin.query("INSERT INTO feedback (org_id, driver_id, csat, nps, source, created_at) VALUES ($1,$2,5,10,'link',$3),($1,$2,3,5,'link',$3)", [h.orgA, drvA, at("12:00")]);
  await h.admin.query("INSERT INTO driver_profiles (user_id, org_id, hourly_rate) VALUES ($1,$2,30)", [drvA, h.orgA]);
}, 90_000);
afterAll(async () => { await h.close(); });

const q = (extra = "") => `from=${day}&to=${day}${extra}`;

describe("summary", () => {
  it("computes the headline numbers", async () => {
    const r = await h.call("get", `/analytics/summary?${q()}`, owner);
    expect(r.status).toBe(200);
    const m = r.body.metrics;
    expect(m.stops).toBe(6);
    expect(m.stopsDone).toBe(5);
    expect(m.failedStops).toBe(1);
    expect(m.onTimeRate).toBe(80); // 4 of 5 done stops on time
    expect(m.firstAttemptRate).toBe(83.3);
    expect(m.avgDelayMin).toBe(20);
    expect(m.worstDelayMin).toBe(20);
    expect(m.missedWindows).toBe(1);
    expect(m.fuelLitres).toBe(90);
    expect(m.fuelCost).toBe(135);
    expect(m.repairCost).toBe(400);
    expect(m.downtimeH).toBe(6);
    expect(m.csat).toBe(4);
    expect(m.nps).toBe(0); // one promoter, one detractor
    expect(m.distanceKm).toBeGreaterThan(2);
    expect(m.speedingEvents).toBe(1);
    expect(m.harshBrakes).toBe(1);
    expect(m.costTotal).toBeGreaterThan(0);
  });

  it("filters by driver and compares with an earlier period", async () => {
    const ann = (await h.call("get", `/analytics/summary?${q(`&driverId=${drvA}`)}`, owner)).body.metrics;
    expect(ann.stops).toBe(4);
    expect(ann.onTimeRate).toBe(66.7);
    expect(ann.speedingEvents).toBe(1);
    const bob = (await h.call("get", `/analytics/summary?${q(`&driverId=${drvB}`)}`, owner)).body.metrics;
    expect(bob.onTimeRate).toBe(100);
    expect(bob.speedingEvents).toBe(0);
    const cmp = (await h.call("get", `/analytics/summary?${q("&compare=prev")}`, owner)).body;
    expect(cmp.previous.stops).toBe(0);
    expect(cmp.deltas.stops).toMatchObject({ abs: 6 });
  });

  it("rejects bad input and enforces permissions and tenant isolation", async () => {
    expect((await h.call("get", "/analytics/summary?from=nope", owner)).status).toBe(400);
    expect((await h.call("get", "/analytics/summary?from=2026-01-01&to=2026-06-01", owner)).status).toBe(400);
    expect((await h.call("get", `/analytics/summary?${q("&driverId=not-a-uuid")}`, owner)).status).toBe(400);
    expect((await h.call("get", `/analytics/summary?${q()}`, driverTok)).status).toBe(403);
    expect((await h.call("get", `/analytics/summary?${q()}`, viewer)).status).toBe(200);
    expect((await h.call("get", `/analytics/summary?${q()}`, orgBadmin)).body.metrics.stops).toBe(0);
  });
});

describe("breakdown and drill-down", () => {
  it("ranks drivers", async () => {
    const r = await h.call("get", `/analytics/breakdown?${q("&by=driver")}`, owner);
    const rows = r.body.rows as { name: string; metrics: Record<string, number | null> }[];
    expect(rows.map((x) => x.name)).toEqual(["Ann", "Bob"]);
    expect(rows[0]!.metrics.avgDelayMin).toBe(20);
    expect(rows[1]!.metrics.onTimeRate).toBe(100);
    expect(rows[0]!.metrics.driverScore).toBeLessThan(rows[1]!.metrics.driverScore ?? 101);
  });
  it("breaks down by route, vehicle and day, and lists failure reasons", async () => {
    const byRoute = (await h.call("get", `/analytics/breakdown?${q("&by=route")}`, owner)).body.rows;
    expect(byRoute.map((x: { name: string }) => x.name).sort()).toEqual(["North loop", "South loop"]);
    expect((await h.call("get", `/analytics/breakdown?${q("&by=vehicle")}`, owner)).body.rows).toHaveLength(2);
    expect((await h.call("get", `/analytics/breakdown?${q("&by=day")}`, owner)).body.rows[0].key).toBe(day);
    expect((await h.call("get", `/analytics/breakdown?${q("&by=nope")}`, owner)).status).toBe(400);
    expect((await h.call("get", `/analytics/reasons?${q()}`, owner)).body).toEqual([{ reason: "Nobody home", count: 1 }]);
    const s = await h.call("get", `/analytics/series?${q("&metric=stops")}`, owner);
    expect(s.body.days).toEqual([{ date: day, value: 6 }]);
  });
  it("lists the driving events behind the safety numbers", async () => {
    const r = (await h.call("get", `/analytics/safety?${q()}`, owner)).body;
    expect(r.totals).toMatchObject({ speeding: 1, harshBrake: 1 });
    expect(r.events[0]).toMatchObject({ driver: "Ann", vehicle: "Truck A" });
  });
});

describe("benchmarks, goals, ask and the driver's own page", () => {
  it("compares drivers against the group median", async () => {
    const r = (await h.call("get", `/analytics/benchmarks?${q("&by=driver&metrics=onTimeRate,avgDelayMin")}`, owner)).body;
    const ann = r.rows.find((x: { name: string }) => x.name === "Ann");
    expect(ann.values.onTimeRate).toMatchObject({ value: 66.7, rank: 2, of: 2 });
    expect(r.stats.onTimeRate.best).toBe(100);
  });
  it("tracks goals", async () => {
    await h.call("post", "/r/goals", owner, { name: "Be on time", metric: "onTimeRate", target: 95, direction: "up", period: "month" });
    expect((await h.call("post", "/r/goals", viewer, { name: "x", metric: "onTimeRate", target: 1 })).status).toBe(403);
    const g = (await h.call("get", "/analytics/goals", owner)).body;
    expect(g[0]).toMatchObject({ name: "Be on time", target: 95 });
  });
  it("answers a question in plain words", async () => {
    const r = await h.call("post", "/analytics/ask", owner, { q: "which driver had the most delays this month" });
    expect(r.body.understood).toBe(true);
    expect(r.body).toMatchObject({ metric: "avgDelayMin", by: "driver" });
    expect((await h.call("post", "/analytics/ask", owner, { q: "meaning of life" })).body.understood).toBe(false);
    expect((await h.call("post", "/analytics/ask", owner, { q: "" })).status).toBe(400);
  });
  it("shows a driver their own score and an earnings estimate", async () => {
    const r = await h.call("get", `/analytics/me?${q()}`, driverTok);
    expect(r.status).toBe(200);
    expect(r.body.metrics.stops).toBe(4);
    expect(r.body.earnings).toMatchObject({ rate: 30 });
    // a driver cannot ask for someone else's numbers
    const other = await h.call("get", `/analytics/me?${q(`&driverId=${drvB}`)}`, driverTok);
    expect(other.body.metrics.stops).toBe(4);
  });
  it("gives live operations and plain-language insights", async () => {
    expect((await h.call("get", "/analytics/live", owner)).body).toMatchObject({ jobs: expect.any(Array), lateStops: expect.any(Array), idleVehicles: expect.any(Array) });
    expect(Array.isArray((await h.call("get", "/analytics/insights", owner)).body)).toBe(true);
    expect((await h.call("get", "/analytics/forecast", owner)).status).toBe(200);
    expect((await h.call("get", `/analytics/savings?${q()}`, owner)).body).toMatchObject({ optimizedRoutes: 0, kmSaved: 0 });
  });
});
