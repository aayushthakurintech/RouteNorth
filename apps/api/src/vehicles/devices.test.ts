import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";

let h: Harness;
let owner: string, ownerB: string, viewer: string;
let vehicleA = "", vehicleB = "";
const ok = (r: { status: number; body: unknown }, code = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(code); return r.body as any; };

beforeAll(async () => {
  h = await startHarness();
  owner = await h.token("a@example.com");
  await h.addUser(h.orgB, "ownerb@example.com", "owner"); ownerB = await h.token("ownerb@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer"); viewer = await h.token("view@example.com");
  vehicleA = (await h.admin.query("INSERT INTO vehicles (org_id, name) VALUES ($1,'Truck 1') RETURNING id", [h.orgA])).rows[0].id;
  vehicleB = (await h.admin.query("INSERT INTO vehicles (org_id, name) VALUES ($1,'Their truck') RETURNING id", [h.orgB])).rows[0].id;
});
afterAll(async () => { await h.close(); });

describe("trackers", () => {
  it("registers a tracker, rejects bad ids and duplicates", async () => {
    const r = ok(await h.call("post", "/devices", owner, { externalId: "352093080000001", vehicleId: vehicleA, label: "Cab unit" }), 201);
    expect(r.id).toBeTruthy();
    expect((await h.call("post", "/devices", owner, { externalId: "x" })).status).toBe(400);
    expect((await h.call("post", "/devices", owner, { externalId: "has space" })).status).toBe(400);
    expect((await h.call("post", "/devices", owner, { externalId: "352093080000001" })).status).toBe(409);
    expect((await h.call("post", "/devices", owner, { externalId: "sim-b", source: "samsara" })).status).toBe(400);
  });
  it("cannot attach a tracker to another company's vehicle", async () => {
    expect((await h.call("post", "/devices", owner, { externalId: "352093080000002", vehicleId: vehicleB })).status).toBe(404);
    const id = (await h.call("post", "/devices", owner, { externalId: "352093080000003" })).body.id;
    expect((await h.call("patch", `/devices/${id}`, owner, { vehicleId: vehicleB })).status).toBe(404);
    ok(await h.call("patch", `/devices/${id}`, owner, { vehicleId: vehicleA }));
  });
  it("enforces the same rule in the database", async () => {
    await expect(h.admin.query("INSERT INTO devices (org_id, vehicle_id, source, external_id) VALUES ($1,$2,'traccar','sneaky-1')", [h.orgA, vehicleB])).rejects.toThrow();
  });
  it("only fleet managers change trackers; viewers can look", async () => {
    expect((await h.call("post", "/devices", viewer, { externalId: "352093080000009" })).status).toBe(403);
    expect(ok(await h.call("get", "/devices", viewer)).length).toBeGreaterThan(0);
  });
  it("hides other companies' trackers", async () => {
    expect(ok(await h.call("get", "/devices", ownerB))).toHaveLength(0);
  });
  it("reports health from what the tracker last sent", async () => {
    const dev = (await h.admin.query("SELECT id FROM devices WHERE external_id = '352093080000001'")).rows[0].id;
    await h.admin.query(
      `INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed, ignition, satellites, battery_pct, ext_voltage, fuel_level_pct, signal)
       VALUES ($1,$2, now(), 43.6, -79.4, 50, true, 3, 12, 13.8, 64, 4)`, [dev, h.orgA]);
    const list = ok(await h.call("get", "/devices", owner));
    const d = list.find((x: any) => x.externalId === "352093080000001");
    expect(d).toMatchObject({ health: "attention", issues: ["low_battery", "weak_gps"], fuelLevelPct: 64, vehicleName: "Truck 1" });
    const never = list.find((x: any) => x.externalId === "352093080000003");
    expect(never.health).toBe("never_reported");
  });
  it("exposes telemetry on the live list", async () => {
    const live = ok(await h.call("get", "/vehicles/live", owner));
    expect(live[0].telemetry).toMatchObject({ satellites: 3, batteryPct: 12, extVoltage: 13.8, fuelLevelPct: 64, signal: 4 });
  });
  it("will not delete a tracker that has history, but removes an unused one", async () => {
    const dev = (await h.admin.query("SELECT id FROM devices WHERE external_id = '352093080000001'")).rows[0].id;
    await h.admin.query("INSERT INTO positions (time, org_id, device_id, lat, lng) VALUES (now(), $1, $2, 43.6, -79.4)", [h.orgA, dev]);
    expect((await h.call("delete", `/devices/${dev}`, owner)).status).toBe(409);
    const unused = (await h.admin.query("SELECT id FROM devices WHERE external_id = '352093080000003'")).rows[0].id;
    ok(await h.call("delete", `/devices/${unused}`, owner));
  });
  it("summarises data quality and device alarms", async () => {
    await h.admin.query("INSERT INTO ingest_counters (org_id, day, outcome, n) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, 'stored', 90), ($1, (now() AT TIME ZONE 'UTC')::date, 'rejected:position_jump', 6), ($1, (now() AT TIME ZONE 'UTC')::date, 'duplicate', 4)", [h.orgA]);
    const q = ok(await h.call("get", "/devices/quality", owner));
    expect(q).toMatchObject({ total: 100, accepted: 90, rejected: 6, duplicates: 4, acceptedPct: 90 });
    const dev = (await h.admin.query("SELECT id FROM devices WHERE external_id = '352093080000001'")).rows[0].id;
    await h.admin.query("INSERT INTO device_events (org_id, device_id, time, kind, severity) VALUES ($1,$2,now(),'sos',3), ($1,$2,now(),'ignition_on',1)", [h.orgA, dev]);
    const ev = ok(await h.call("get", "/devices/events", owner));
    expect(ev).toHaveLength(1);
    expect(ev[0]).toMatchObject({ kind: "sos", name: "Truck 1" });
    expect(ok(await h.call("get", "/devices/events", ownerB))).toHaveLength(0);
  });
});
