import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";
import { OpenMeteo } from "../weather/provider.js";

let h: Harness;
let owner: string, viewer: string, driverTok: string, otherAdmin: string;
let driverId: string;
let veh: string, dev: string;

beforeAll(async () => {
  const weather = new OpenMeteo("http://wx", async () => {
    const time = Array.from({ length: 96 }, (_, i) => new Date(Date.UTC(2020, 0, 1) + i * 3600_000).toISOString().slice(0, 16));
    const now = Date.now();
    // forecast for the next days around now
    const t2 = Array.from({ length: 96 }, (_, i) => new Date(Math.floor(now / 3600_000) * 3600_000 + (i - 24) * 3600_000).toISOString().slice(0, 16));
    void time;
    return new Response(JSON.stringify({ hourly: { time: t2, temperature_2m: t2.map(() => -5), precipitation: t2.map(() => 4), precipitation_probability: t2.map(() => 90), wind_speed_10m: t2.map(() => 20), weather_code: t2.map(() => 73) } }));
  });
  h = await startHarness({ weather });
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer");
  viewer = await h.token("view@example.com");
  driverId = await h.addUser(h.orgA, "drv@example.com", "driver", { display_name: "Dee" });
  driverTok = await h.token("drv@example.com");
  await h.addUser(h.orgB, "adminb@example.com", "admin");
  otherAdmin = await h.token("adminb@example.com");
  veh = (await h.call("post", "/r/vehicles", owner, { name: "Truck 1", plate: "ABC 123", odometerKm: 10000 })).body.id;
  dev = (await h.admin.query("INSERT INTO devices (org_id, vehicle_id, source, external_id) VALUES ($1,$2,'simulator','sim-1') RETURNING id", [h.orgA, veh])).rows[0].id;
}, 60_000);
afterAll(async () => { await h.close(); });

describe("reminders and maintenance", () => {
  it("lists expiring documents, licences and maintenance due by km or date", async () => {
    const soon = new Date(Date.now() + 10 * 86400_000).toISOString().slice(0, 10);
    const past = new Date(Date.now() - 5 * 86400_000).toISOString().slice(0, 10);
    await h.call("post", "/r/documents", owner, { ownerKind: "vehicle", ownerId: veh, kind: "Insurance", expiresOn: soon });
    await h.call("post", "/r/documents", owner, { ownerKind: "vehicle", ownerId: veh, kind: "Safety inspection", expiresOn: past });
    await h.call("post", "/r/documents", owner, { ownerKind: "vehicle", ownerId: veh, kind: "Registration", expiresOn: "2099-01-01" });
    await h.call("put", `/fleet/drivers/${driverId}`, owner, { licenseNo: "D123", licenseExpiry: soon, skills: ["hazmat"] });
    const plan = await h.call("post", "/r/maintenance-plans", owner, { vehicleId: veh, task: "Oil change", everyKm: 5000, lastDoneKm: 4000 });
    const r = await h.call("get", "/fleet/reminders", owner);
    const titles = r.body.items.map((i: { title: string; state: string }) => `${i.title}:${i.state}`);
    expect(titles).toEqual(expect.arrayContaining(["Insurance:due_soon", "Safety inspection:overdue", "licence:due_soon", "Oil change:overdue"]));
    expect(titles.some((t: string) => t.startsWith("Registration"))).toBe(false);
    expect(r.body.items[0].state).toBe("overdue");
    // completing the task resets its clock
    const done = await h.call("post", `/fleet/maintenance/${plan.body.id}/complete`, owner, { odometerKm: 10050, cost: 120, vendor: "QuickLube" });
    expect(done.status).toBe(201);
    const m = await h.call("get", "/fleet/maintenance", owner);
    expect(m.body.find((x: { task: string }) => x.task === "Oil change")).toMatchObject({ dueKm: 15050, state: "ok" });
    expect((await h.call("get", "/r/maintenance-logs", owner)).body[0]).toMatchObject({ task: "Oil change", cost: 120 });
    expect((await h.call("post", `/fleet/maintenance/${plan.body.id}/complete`, viewer, {})).status).toBe(403);
  });
});

describe("fuel", () => {
  it("imports fuel card rows once and reports economy", async () => {
    const csv = "date,vehicle,litres,cost,odometer_km,station,card_last4\n2026-06-01,ABC 123,60,90,1000,Esso,1234\n2026-06-05,Truck 1,50,75,1500,Shell,1234\n2026-06-09,abc 123,45,69,2000,Esso,1234\n2026-06-10,Ghost,10,15,,X,\n2026-06-11,ABC 123,-5,1,,X,";
    const a = await h.call("post", "/fleet/fuel/import", owner, { csv });
    expect(a.body.created).toBe(3);
    expect(a.body.errors.map((e: { row: number }) => e.row)).toEqual([5, 6]);
    expect((await h.call("post", "/fleet/fuel/import", owner, { csv })).body).toMatchObject({ created: 0, duplicates: 3 });
    const s = await h.call("get", "/fleet/fuel/summary", owner);
    expect(s.body[0]).toMatchObject({ name: "Truck 1", fills: 3, km: 1000, lPer100: 9.5 });
  });
});

describe("trip logs", () => {
  it("builds a mileage log, tags purposes and exports CSV", async () => {
    const t0 = Date.UTC(2026, 6, 1, 12, 0);
    for (let i = 0; i <= 20; i++) {
      await h.admin.query("INSERT INTO positions (time, org_id, device_id, lat, lng, speed, ignition) VALUES ($1,$2,$3,$4,$5,50,true)",
        [new Date(t0 + i * 60_000), h.orgA, dev, 43.65 + i * 0.004, -79.38]);
    }
    const q = "from=2026-07-01T00:00:00Z&to=2026-07-02T00:00:00Z";
    const log = await h.call("get", `/fleet/trip-log?${q}`, owner);
    expect(log.body.trips).toHaveLength(1);
    expect(log.body.trips[0].km).toBeGreaterThan(8);
    expect(log.body.totals.untagged).toBe(1);
    const start = log.body.trips[0].start;
    expect((await h.call("put", "/fleet/trip-log/purpose", owner, { deviceId: dev, start, purpose: "business", note: "Client visit" })).status).toBe(200);
    const again = await h.call("get", `/fleet/trip-log?${q}`, owner);
    expect(again.body.totals).toMatchObject({ untagged: 0, business: again.body.totals.km });
    const csv = await h.call("get", `/fleet/trip-log?${q}&format=csv`, owner);
    expect(csv.text).toContain("business");
    expect((await h.call("get", `/fleet/trip-log?${q}&format=csv`, viewer)).status).toBe(403);
    expect((await h.call("get", `/fleet/trip-log?${q}`, otherAdmin)).body.trips).toEqual([]);
  });
});

describe("depots and drivers", () => {
  it("counts vehicles parked in a depot against its spots", async () => {
    const d = await h.call("post", "/r/depots", owner, { name: "Main yard", lat: 43.65, lng: -79.38, radiusM: 200, spots: 1 });
    await h.admin.query(
      "INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed, heading) VALUES ($1,$2,now(),43.6501,-79.3801,0,0) ON CONFLICT (device_id) DO UPDATE SET time = now(), lat = 43.6501, lng = -79.3801", [dev, h.orgA]);
    const occ = await h.call("get", "/fleet/depots/occupancy", owner);
    expect(occ.body.find((x: { id: string }) => x.id === d.body.id)).toMatchObject({ occupied: 1, free: 0, vehicles: ["Truck 1"] });
  });

  it("stores driver profiles and validates them", async () => {
    expect((await h.call("put", `/fleet/drivers/${driverId}`, owner, { licenseExpiry: "tomorrow" })).status).toBe(400);
    expect((await h.call("put", `/fleet/drivers/${driverId}`, viewer, {})).status).toBe(403);
    const list = await h.call("get", "/fleet/drivers", owner);
    expect(list.body.find((x: { id: string }) => x.id === driverId)).toMatchObject({ licenseNo: "D123", skills: ["hazmat"], maxShiftMin: 600 });
  });
});

describe("driver inspections and incidents", () => {
  it("records a check-out with a defect and an incident with a photo", async () => {
    const insp = await h.call("post", "/driver/inspections", driverTok, { vehicleId: veh, kind: "check_out", odometerKm: 10100, items: [{ key: "tires", ok: true }, { key: "lights", ok: false, note: "left tail light out" }] });
    expect(insp.status).toBe(201);
    expect(insp.body.defects).toBe(true);
    const rem = await h.call("get", "/fleet/reminders", owner);
    expect(rem.body.items.some((i: { type: string }) => i.type === "defect")).toBe(true);
    // a clean check-in clears the defect reminder
    await h.call("post", "/driver/inspections", driverTok, { vehicleId: veh, kind: "check_in", items: [{ key: "lights", ok: true }] });
    expect((await h.call("get", "/fleet/reminders", owner)).body.items.some((i: { type: string }) => i.type === "defect")).toBe(false);

    const inc = await h.call("post", "/driver/incidents", driverTok, { vehicleId: veh, kind: "damage", severity: "minor", description: "Scraped a pole", injuries: false });
    expect(inc.status).toBe(201);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(20)]);
    const photo = await h.call("put", `/driver/incidents/${inc.body.id}/photos?name=pole.png`, driverTok).set("Content-Type", "image/png").send(png);
    expect(photo.status).toBe(200);
    const files = await h.call("get", `/attachments/of/incident/${inc.body.id}`, owner);
    expect(files.body).toHaveLength(1);
    // managers can add documents to a vehicle; viewers cannot
    const pdf = await h.call("put", `/attachments/for/vehicle/${veh}?name=reg.pdf`, owner).set("Content-Type", "application/pdf").send(Buffer.from("%PDF-1.4 x"));
    expect(pdf.status).toBe(200);
    expect((await h.call("put", `/attachments/for/vehicle/${veh}`, viewer).set("Content-Type", "application/pdf").send(Buffer.from("%PDF-1.4 x"))).status).toBe(403);
    expect((await h.call("post", "/driver/incidents", driverTok, { description: "" })).status).toBe(400);
  });
});

describe("share links", () => {
  it("lets anyone with the link see one vehicle until it expires or is revoked", async () => {
    const link = await h.call("post", "/share", owner, { deviceId: dev, hours: 2, label: "Delivery to Acme" });
    expect(link.status).toBe(201);
    const token = link.body.token as string;
    const pub = await h.call("get", `/public/track/${token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.vehicle).toMatchObject({ name: "Truck 1" });
    expect(JSON.stringify(pub.body)).not.toContain("ABC 123"); // no plate, driver or ids on the public page
    expect(pub.body.label).toBe("Delivery to Acme");
    expect((await h.call("get", "/public/track/not-a-real-token-at-all-0000")).status).toBe(404);
    expect((await h.call("post", "/share", viewer, { deviceId: dev })).status).toBe(403);
    expect((await h.call("post", "/share", owner, { deviceId: dev, hours: 500 })).status).toBe(400);
    // another organization cannot revoke it
    expect((await h.call("delete", `/share/${link.body.id}`, otherAdmin)).status).toBe(404);
    expect((await h.call("delete", `/share/${link.body.id}`, owner)).status).toBe(204);
    expect((await h.call("get", `/public/track/${token}`)).status).toBe(404);
    // expiry
    const l2 = await h.call("post", "/share", owner, { deviceId: dev, hours: 1 });
    await h.admin.query("UPDATE share_links SET expires_at = now() - interval '1 minute' WHERE id = $1", [l2.body.id]);
    expect((await h.call("get", `/public/track/${l2.body.token}`)).status).toBe(404);
  });
});

describe("heat layers and weather", () => {
  it("aggregates stops and speeding into grid cells", async () => {
    const t = Date.UTC(2026, 6, 3, 12);
    for (let i = 0; i < 5; i++) {
      await h.admin.query("INSERT INTO positions (time, org_id, device_id, lat, lng, speed, ignition) VALUES ($1,$2,$3,43.7,-79.4,0,true)", [new Date(t + i * 1000), h.orgA, dev]);
      await h.admin.query("INSERT INTO positions (time, org_id, device_id, lat, lng, speed, ignition) VALUES ($1,$2,$3,43.8,-79.4,130,true)", [new Date(t + 100_000 + i * 1000), h.orgA, dev]);
    }
    const q = "from=2026-07-03T00:00:00Z&to=2026-07-04T00:00:00Z";
    const stops = await h.call("get", `/heat?kind=stops&${q}`, owner);
    expect(stops.body[0]).toMatchObject({ weight: 5 });
    const speeding = await h.call("get", `/heat?kind=speeding&${q}`, owner);
    expect(speeding.body[0].lat).toBeCloseTo(43.8, 2);
    expect((await h.call("get", `/heat?kind=bogus&${q}`, owner)).status).toBe(400);
  });

  it("reports weather and warns about snow along a route", async () => {
    const w = await h.call("get", "/weather?lat=43.7&lng=-79.4", owner);
    expect(w.body).toMatchObject({ available: true, level: "severe", reason: "snow" });
    const route = await h.call("post", "/routes", owner, { name: "Snowy", date: "2026-07-01", stops: [{ name: "A", lat: 43.7, lng: -79.4 }] });
    const wr = await h.call("get", `/weather/route/${route.body.id}`, owner);
    expect(wr.body).toMatchObject({ available: true, worst: "severe" });
    expect(wr.body.stops).toHaveLength(1);
  });
});
