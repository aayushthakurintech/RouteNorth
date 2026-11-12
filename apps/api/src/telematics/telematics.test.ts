import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";

let h: Harness;
let owner: string, ownerB: string, viewer: string;
let vehicle = "", device = "", driver = "";
const ok = (r: { status: number; body: unknown }, code = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(code); return r.body as any; };
/** Minutes before "now": keeps the data inside the default 24 hour range whatever time the test runs. */
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

async function pos(t: string, lat: number, speed: number, ignition: boolean, fuel: number | null = null) {
  await h.admin.query("INSERT INTO positions (time, org_id, device_id, lat, lng, speed, ignition, fuel_level_pct) VALUES ($1,$2,$3,$4,-79.4,$5,$6,$7)", [t, h.orgA, device, lat, speed, ignition, fuel]);
}

beforeAll(async () => {
  h = await startHarness();
  owner = await h.token("a@example.com");
  await h.addUser(h.orgB, "ownerb@example.com", "owner"); ownerB = await h.token("ownerb@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer"); viewer = await h.token("view@example.com");
  driver = await h.addUser(h.orgA, "dee@example.com", "driver", { display_name: "Dee" });
  vehicle = (await h.admin.query("INSERT INTO vehicles (org_id, name, kind, tank_litres) VALUES ($1,'Truck 7','truck',400) RETURNING id", [h.orgA])).rows[0].id;
  device = (await h.admin.query("INSERT INTO devices (org_id, vehicle_id, source, external_id) VALUES ($1,$2,'traccar','T7') RETURNING id", [h.orgA, vehicle])).rows[0].id;
  // 40 min ago: driving; then 12 minutes idling (engine on, stopped); then driving again; each fix 60 s apart.
  let lat = 43.6, m = 60;
  for (; m > 48; m--) { await pos(ago(m), lat, 60, true); lat += 0.0085; }
  for (; m > 36; m--) await pos(ago(m), lat, 0, true);
  for (; m > 20; m--) { await pos(ago(m), lat, 60, true); lat += 0.0085; }
});
afterAll(async () => { await h.close(); });

describe("idling report", () => {
  it("finds the engine-on stop, and prices it with the fuel price from settings", async () => {
    await h.admin.query(`UPDATE organizations SET settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{costing}', '{"fuelPricePerL": 2}'::jsonb) WHERE id = $1`, [h.orgA]);
    const r = ok(await h.call("get", "/telematics/idling", owner));
    expect(r.vehicles).toHaveLength(1);
    const v = r.vehicles[0];
    expect(v.name).toBe("Truck 7");
    expect(v.episodes).toHaveLength(1);
    expect(v.episodes[0].durationS).toBeGreaterThanOrEqual(11 * 60);
    expect(v.episodes[0].durationS).toBeLessThanOrEqual(13 * 60);
    expect(v.cost.litres).toBeGreaterThan(0.6); // about 12 min x 3.8 L/h
    expect(v.cost.cost).toBeCloseTo(v.cost.litres * 2, 1);
    expect(r.totals.episodes).toBe(1);
    expect(r.basis).toMatch(/estimate/);
  });
  it("is private to the company and needs report access", async () => {
    expect(ok(await h.call("get", "/telematics/idling", ownerB)).vehicles).toHaveLength(0);
    expect((await h.call("get", "/telematics/idling", viewer)).status).toBe(200); // viewers have reports.view
    expect((await h.call("get", "/telematics/idling?from=nope", owner)).status).toBe(400);
  });
});

describe("utilization", () => {
  it("counts days used against the range, so a vehicle that sat is visible", async () => {
    const from = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const r = ok(await h.call("get", `/telematics/utilization?from=${from}`, owner));
    expect(r.vehicles[0]).toMatchObject({ name: "Truck 7", daysTracked: 3 });
    expect(r.vehicles[0].daysUsed).toBe(1);
    expect(r.summary).toMatchObject({ vehicles: 1, used: 1 });
    expect((await h.call("get", "/telematics/utilization?workday=99", owner)).status).toBe(400);
  });
});

describe("fuel events", () => {
  it("detects a refuel from the fuel sensor", async () => {
    // 3 hours ago, stopped: 30 % -> 80 % over 10 minutes
    const base = Date.now() - 180 * 60_000;
    for (let i = 0; i < 12; i++) await pos(new Date(base + i * 60_000).toISOString(), 43.9, 0, false, i < 3 ? 30 : i < 8 ? 30 + (i - 2) * 10 : 80);
    const r = ok(await h.call("get", "/telematics/fuel-events", owner));
    const v = r.vehicles.find((x: any) => x.name === "Truck 7");
    expect(v.tankKnown).toBe(true);
    const refuel = v.events.find((e: any) => e.kind === "refuel");
    expect(refuel).toBeTruthy();
    expect(refuel.litres).toBeGreaterThan(150);
    expect(r.note).toMatch(/not proof/);
  });
});

describe("hours of service", () => {
  it("builds clocks from the shift, a break and the vehicle's driving", async () => {
    const shiftStart = ago(300);
    const sid = (await h.admin.query("INSERT INTO shifts (org_id, driver_id, started_at) VALUES ($1,$2,$3) RETURNING id", [h.orgA, driver, shiftStart])).rows[0].id;
    await h.admin.query("INSERT INTO shift_breaks (org_id, shift_id, kind, started_at, ended_at) VALUES ($1,$2,'break',$3,$4)", [h.orgA, sid, ago(100), ago(70)]);
    await h.admin.query("INSERT INTO routes (org_id, name, route_date, driver_id, vehicle_id) VALUES ($1,'R', (now() AT TIME ZONE 'UTC')::date, $2, $3)", [h.orgA, driver, vehicle]);
    const r = ok(await h.call("get", "/telematics/hos", owner));
    expect(r.note).toMatch(/Not a certified/);
    const d = r.drivers.find((x: any) => x.name === "Dee");
    expect(d).toBeTruthy();
    expect(d.status.currentStatus).toBe("on");
    expect(d.status.canDrive).toBe(true);
    expect(d.status.window.usedH).toBeGreaterThan(3.5); // 5 h shift minus the 30 min break
    expect(d.status.window.usedH).toBeLessThan(4.7);
    // two drives of about 11 and 15 minutes from the vehicle's positions
    expect(d.hasVehicleData).toBe(true);
    expect(d.status.driving.usedH).toBeGreaterThan(0.3);
    expect(d.status.driving.usedH).toBeLessThan(0.6);
    expect(r.drivers.every((x: any) => x.name !== undefined)).toBe(true);
  });
  it("rejects an unknown rule set and keeps other companies out", async () => {
    expect((await h.call("get", "/telematics/hos?rule=mars", owner)).status).toBe(400);
    expect(ok(await h.call("get", "/telematics/hos?rule=us_70_8", ownerB)).drivers).toHaveLength(0);
  });
});
