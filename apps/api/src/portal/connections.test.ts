import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { FetchLike } from "@routenorth/shared";
import { startHarness, type Harness } from "../test-harness.js";
import { PortalConnectionsController } from "./connections.controller.js";
import { PortalProviderConnectionsController } from "./provider-connections.controller.js";

let h: Harness, owner: string, driver: string, orgB: string;
const get = (p: string, t: string) => h.call("get", p, t);
const post = (p: string, t: string, b?: unknown) => h.call("post", p, t, b);
const sql = (q: string, p: unknown[] = []) => h.admin.query(q, p);

/** A fake Samsara with two vehicles; token "good" is accepted. */
const fakeFetch: FetchLike = async (_url, init) => {
  const ok = init.headers.authorization === "Bearer good";
  return { ok, status: ok ? 200 : 401, json: async () => ({ data: [{ id: "2120149180", name: "Bus 3", serial: "G7", vin: null, licensePlate: "BUS3" }, { id: "2120149181", name: "Bus 4" }], pagination: { hasNextPage: false } }) };
};

// 356307042441013 passes the IMEI check digit; the second one is made up to pass it too.
const IMEI = "356307042441013";
const IMEI2 = "490154203237518";

beforeAll(async () => {
  PortalProviderConnectionsController.fetchFn = fakeFetch;
  PortalConnectionsController.fetchFn = fakeFetch;
  h = await startHarness();
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "drv@example.com", "driver"); driver = await h.token("drv@example.com");
  await h.addUser(h.orgB, "adminb@example.com", "admin"); orgB = await h.token("adminb@example.com");
});
afterAll(async () => { await h.close(); });

describe("connection methods and the dry-run check", () => {
  it("lists the methods and says what this install still needs, without making up addresses", async () => {
    delete process.env.TRACCAR_PUBLIC_HOST; delete process.env.INGEST_PUBLIC_URL; delete process.env.TRACCAR_PORTS;
    const m = (await get("/portal/connections/meta", owner)).body;
    expect(m.methods.map((x: { id: string }) => x.id)).toEqual(["traccar", "feed", "geotab", "samsara"]);
    expect(m.traccarHost).toBeNull();
    expect(m.methods[0].setup.ready).toBe(false);
    expect(m.methods[0].setup.missing[0]).toContain("TRACCAR_PUBLIC_HOST");
    process.env.TRACCAR_PUBLIC_HOST = "track.example.ca"; process.env.TRACCAR_PORTS = "Teltonika:5027, OsmAnd:5055, junk";
    const m2 = (await get("/portal/connections/meta", owner)).body;
    expect(m2.traccarHost).toBe("track.example.ca");
    expect(m2.traccarPorts).toEqual([{ protocol: "Teltonika", port: 5027 }, { protocol: "OsmAnd", port: 5055 }]);
    expect(m2.methods[0].setup.ready).toBe(true);
  });

  it("is for people who manage the fleet", async () => {
    expect((await get("/portal/connections/meta", driver)).status).toBe(403);
    expect((await post("/portal/connections/check", driver, { method: "traccar", trackerId: IMEI })).status).toBe(403);
    expect((await get("/portal/connections/overview", driver)).status).toBe(403);
  });

  it("explains a mistyped IMEI, accepts a good one, and writes nothing", async () => {
    const bad = (await post("/portal/connections/check", owner, { method: "traccar", trackerId: "356307042441014" })).body;
    expect(bad.canRegister).toBe(false);
    expect(bad.problems[0]).toMatch(/IMEI check/);
    const ok = (await post("/portal/connections/check", owner, { method: "traccar", trackerId: "356 307 042 441 013" })).body;
    expect(ok).toMatchObject({ canRegister: true, trackerId: IMEI, source: "traccar", claim: "free", heard: null });
    expect((await sql("SELECT count(*)::int AS n FROM devices")).rows[0].n).toBe(0);
    expect((await post("/portal/connections/check", owner, { method: "nope", trackerId: IMEI })).status).toBe(400);
  });

  it("tells the owner when a tracker with this ID has already reached us unregistered", async () => {
    await sql("INSERT INTO ingest_unknown_ids (source, external_id, n) VALUES ('traccar', $1, 12)", [IMEI2]);
    const r = (await post("/portal/connections/check", owner, { method: "traccar", trackerId: IMEI2 })).body;
    expect(r.canRegister).toBe(true);
    expect(r.heard.messages).toBe(12);
    expect(new Date(r.heard.lastSeen).getTime()).toBeGreaterThan(Date.now() - 60_000);
  });

  it("keeps the list of unregistered IDs closed: the application role can only record one and ask about one exact ID", async () => {
    await h.app.query("SELECT record_unregistered('traccar', $1, 3)", [IMEI]);
    expect((await sql("SELECT n FROM ingest_unknown_ids WHERE external_id = $1", [IMEI])).rows[0].n).toBe("3");
    expect((await h.app.query("SELECT * FROM ingest_unknown_ids")).rowCount).toBe(0); // row-level security, no policy
    await expect(h.app.query("INSERT INTO ingest_unknown_ids (source, external_id) VALUES ('traccar', 'x')")).rejects.toThrow();
  });
});

describe("a vehicle with its tracker, in one step", () => {
  let vehicleId = "";

  it("creates the vehicle and registers the tracker together, and the connection waits for a first position", async () => {
    const r = await post("/portal/vehicles", owner, { name: "Truck 21", kind: "truck", plate: "ABC 123", tracker: { method: "traccar", trackerId: IMEI } });
    expect(r.status).toBe(201);
    vehicleId = r.body.id;
    const dev = (await sql("SELECT source, external_id, connection_method, vehicle_id FROM devices")).rows;
    expect(dev).toEqual([{ source: "traccar", external_id: IMEI, connection_method: "traccar", vehicle_id: vehicleId }]);
    const c = (await get(`/portal/connections/vehicle/${vehicleId}`, owner)).body;
    expect(c.status.state).toBe("waiting_first_ping");
    expect(c.device.trackerId).toBe(IMEI);
    expect(c.setup.ready).toBe(true);
  });

  it("becomes connected when the first position arrives, then quiet when it is old", async () => {
    const dev = (await sql("SELECT id FROM devices WHERE external_id = $1", [IMEI])).rows[0].id;
    await sql("INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed, heading, ignition) VALUES ($1,$2, now() - interval '2 minutes', 43.7, -79.4, 62, 90, true)", [dev, h.orgA]);
    const c = (await get(`/portal/connections/vehicle/${vehicleId}`, owner)).body;
    expect(c.status.state).toBe("connected");
    expect(c.lastPosition).toMatchObject({ speedKmh: 62, ignition: true });
    await sql("UPDATE latest_positions SET time = now() - interval '3 hours' WHERE device_id = $1", [dev]);
    const q = (await get(`/portal/connections/vehicle/${vehicleId}`, owner)).body;
    expect(q.status.state).toBe("quiet");
    expect(q.status.fixes.length).toBeGreaterThan(0);
  });

  it("saves nothing when the tracker is refused", async () => {
    const before = (await sql("SELECT count(*)::int AS n FROM vehicles")).rows[0].n;
    const r = await post("/portal/vehicles", owner, { name: "Truck 22", kind: "truck", tracker: { method: "traccar", trackerId: "356307042441014" } });
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/IMEI check/);
    expect((await sql("SELECT count(*)::int AS n FROM vehicles")).rows[0].n).toBe(before);
    const dup = await post("/portal/vehicles", owner, { name: "Truck 23", kind: "truck", tracker: { method: "traccar", trackerId: IMEI } });
    expect(dup.status).toBe(400);
    expect(dup.body.message).toMatch(/already on Truck 21/);
    expect((await sql("SELECT count(*)::int AS n FROM vehicles")).rows[0].n).toBe(before);
  });

  it("a vehicle can still be created without a tracker, and shows as not connected", async () => {
    const r = await post("/portal/vehicles", owner, { name: "Van 1", kind: "van" });
    expect(r.status).toBe(201);
    const c = (await get(`/portal/connections/vehicle/${r.body.id}`, owner)).body;
    expect(c.status.state).toBe("not_connected");
    expect(c.setup).toBeNull();
  });

  it("another company cannot take the same tracker ID and is not told who has it", async () => {
    const r = (await post("/portal/connections/check", orgB, { method: "traccar", trackerId: IMEI })).body;
    expect(r.claim).toBe("taken");
    expect(r.canRegister).toBe(false);
    expect(r.problems[0]).toMatch(/another company/);
    expect(JSON.stringify(r)).not.toContain(h.orgA);
    const made = await post("/portal/vehicles", orgB, { name: "B truck", kind: "truck", tracker: { method: "traccar", trackerId: IMEI } });
    expect(made.status).toBe(400);
    expect((await get("/portal/connections/overview", orgB)).body.vehicles.every((v: { device: unknown }) => v.device === null)).toBe(true);
  });

  it("links, replaces and unlinks a tracker on an existing vehicle", async () => {
    const van = (await sql("SELECT id FROM vehicles WHERE name = 'Van 1'")).rows[0].id;
    const taken = await post(`/portal/connections/vehicle/${van}/connect`, owner, { tracker: { method: "traccar", trackerId: IMEI } });
    expect(taken.status).toBe(400);
    expect(taken.body.message).toMatch(/already on Truck 21/);
    const ok = await post(`/portal/connections/vehicle/${van}/connect`, owner, { tracker: { method: "traccar", trackerId: IMEI2 } });
    expect(ok.status).toBe(201);
    expect(ok.body.heard.messages).toBe(12);
    expect(ok.body.connection.device.trackerId).toBe(IMEI2);
    const again = await post(`/portal/connections/vehicle/${van}/connect`, owner, { tracker: { method: "feed", trackerId: "van-1" } });
    expect(again.status).toBe(409);
    const swapped = await post(`/portal/connections/vehicle/${van}/connect`, owner, { tracker: { method: "feed", trackerId: "van-1" }, replace: true });
    expect(swapped.status).toBe(201);
    expect((await sql("SELECT vehicle_id FROM devices WHERE external_id = $1", [IMEI2])).rows[0].vehicle_id).toBeNull();
    const off = await post(`/portal/connections/vehicle/${van}/disconnect`, owner);
    expect(off.body).toEqual({ ok: true, unlinked: 1 });
    expect((await get(`/portal/connections/vehicle/${van}`, owner)).body.status.state).toBe("not_connected");
    expect((await post(`/portal/connections/vehicle/${van}/disconnect`, orgB)).status).toBe(404);
  });

  it("writes the link into the audit log", async () => {
    const rows = (await sql("SELECT action FROM audit_log WHERE action LIKE 'vehicles.%tracker' ORDER BY at")).rows.map((r) => r.action);
    expect(rows).toContain("vehicles.connect_tracker");
    expect(rows).toContain("vehicles.disconnect_tracker");
  });

  it("counts every vehicle by connection state", async () => {
    const o = (await get("/portal/connections/overview", owner)).body;
    expect(o.vehicles.length).toBeGreaterThanOrEqual(2);
    expect(Object.values(o.counts).reduce((a: number, b) => a + (b as number), 0)).toBe(o.vehicles.length);
    expect(o.counts.quiet).toBe(1);
    expect(o.counts.not_connected).toBeGreaterThanOrEqual(1);
  });
});

describe("a vehicle in a Geotab or Samsara account", () => {
  let accountId = "";
  it("needs a saved account, finds the vehicle in the provider's list, and uses the tagged id", async () => {
    const acc = await post("/portal/provider-connections", owner, { provider: "samsara", name: "Samsara main", settings: { region: "us" }, secret: "good" });
    accountId = acc.body.id;
    const none = (await post("/portal/connections/check", owner, { method: "samsara", trackerId: "2120149180" })).body;
    expect(none.canRegister).toBe(false);
    expect(none.problems[0]).toMatch(/Choose which Samsara account/);
    const found = (await post("/portal/connections/check", owner, { method: "samsara", trackerId: "2120149180", providerConnectionId: accountId })).body;
    expect(found).toMatchObject({ canRegister: true, externalId: "samsara:2120149180", source: "feed" });
    expect(found.provider.found).toMatchObject({ name: "Bus 3", plate: "BUS3" });
    const missing = (await post("/portal/connections/check", owner, { method: "samsara", trackerId: "999999999999", providerConnectionId: accountId })).body;
    expect(missing.canRegister).toBe(false);
    expect(missing.problems[0]).toMatch(/did not list a vehicle with ID 999999999999/);
    expect((await post("/portal/connections/check", owner, { method: "geotab", trackerId: "b12", providerConnectionId: accountId })).body.problems[0]).toMatch(/is Samsara, not Geotab/);
    expect((await post("/portal/connections/check", orgB, { method: "samsara", trackerId: "2120149180", providerConnectionId: accountId })).body.problems[0]).toMatch(/not found/);
  });

  it("lists the provider's vehicles for picking, and reuses a device the pull already made", async () => {
    const list = (await get(`/portal/connections/provider/${accountId}/vehicles`, owner)).body;
    expect(list.vehicles.map((v: { id: string }) => v.id)).toEqual(["2120149180", "2120149181"]);
    expect(list.vehicles[0].linked).toBe(false);
    expect((await get(`/portal/connections/provider/${accountId}/vehicles`, orgB)).status).toBe(404);
    // the pull worker had already created this device, with positions
    const dev = (await sql("INSERT INTO devices (org_id, source, external_id) VALUES ($1,'feed','samsara:2120149180') RETURNING id", [h.orgA])).rows[0].id;
    await sql("INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed, heading, ignition) VALUES ($1,$2, now(), 44, -80, 10, 0, true)", [dev, h.orgA]);
    const r = await post("/portal/vehicles", owner, { name: "Bus 3", kind: "bus", tracker: { method: "samsara", trackerId: "2120149180", providerConnectionId: accountId } });
    expect(r.status).toBe(201);
    const rows = (await sql("SELECT id, vehicle_id, connection_method, provider_connection_id FROM devices WHERE external_id = 'samsara:2120149180'")).rows;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: dev, vehicle_id: r.body.id, connection_method: "samsara", provider_connection_id: accountId });
    const c = (await get(`/portal/connections/vehicle/${r.body.id}`, owner)).body;
    expect(c.status.state).toBe("connected");
    expect(c.device.trackerId).toBe("2120149180");
    expect(c.provider).toMatchObject({ name: "Samsara main", provider: "samsara" });
    expect((await get(`/portal/connections/provider/${accountId}/vehicles`, owner)).body.vehicles[0].linked).toBe(true);
  });

  it("shows a failing provider login as an error with the provider's own words", async () => {
    await sql("UPDATE provider_connections SET status = 'error', last_error = 'Samsara refused the API token: check it has read access to vehicles'");
    const bus = (await sql("SELECT id FROM vehicles WHERE name = 'Bus 3'")).rows[0].id;
    const c = (await get(`/portal/connections/vehicle/${bus}`, owner)).body;
    expect(c.status.state).toBe("error");
    expect(c.status.detail).toMatch(/refused the API token/);
  });
});

describe("feed devices stay inside one company", () => {
  it("lets two companies use the same feed id because ids are per company", async () => {
    const a = await post("/portal/vehicles", owner, { name: "Feed A", kind: "truck", tracker: { method: "feed", trackerId: "truck-12" } });
    expect(a.status).toBe(201);
    const b = await post("/portal/vehicles", orgB, { name: "Feed B", kind: "truck", tracker: { method: "feed", trackerId: "truck-12" } });
    expect(b.status).toBe(201);
    expect((await sql("SELECT count(*)::int AS n FROM devices WHERE external_id = 'truck-12'")).rows[0].n).toBe(2);
  });
});

describe("check rate limit", () => {
  it("allows 60 checks a minute per user, then answers 429, and lets the window pass", async () => {
    const { limitChecks } = await import("./connections.controller.js");
    const t0 = 1_000_000;
    for (let i = 0; i < 60; i++) limitChecks("limit-test", 60, 60_000, t0 + i);
    expect(() => limitChecks("limit-test", 60, 60_000, t0 + 100)).toThrow(/Too many/);
    expect(() => limitChecks("other-user", 60, 60_000, t0 + 100)).not.toThrow();
    expect(() => limitChecks("limit-test", 60, 60_000, t0 + 61_000)).not.toThrow();
  });
});
