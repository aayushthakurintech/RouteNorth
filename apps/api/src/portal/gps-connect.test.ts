import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";

let h: Harness, owner: string, driver: string, orgB: string;
const get = (p: string, t: string) => h.call("get", p, t);
const post = (p: string, t: string, b?: unknown) => h.call("post", p, t, b);
const sql = (q: string, p: unknown[] = []) => h.admin.query(q, p);

beforeAll(async () => {
  h = await startHarness();
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "drv@example.com", "driver"); driver = await h.token("drv@example.com");
  await h.addUser(h.orgB, "adminb@example.com", "admin"); orgB = await h.token("adminb@example.com");
});
afterAll(async () => { await h.close(); });

describe("connect your GPS", () => {
  it("starts empty and says what the server still needs", async () => {
    delete process.env.INGEST_PUBLIC_URL;
    const r = await get("/portal/gps-connect", owner);
    expect(r.status).toBe(200);
    expect(r.body.keys).toEqual([]);
    expect(r.body.ingestUrl).toBeNull();
    expect(r.body.needs.join(" ")).toContain("INGEST_PUBLIC_URL");
    process.env.INGEST_PUBLIC_URL = "https://ingest.example.ca/";
    expect((await get("/portal/gps-connect", owner)).body.ingestUrl).toBe("https://ingest.example.ca");
  });

  it("makes a key that is shown once, and never lists the secret", async () => {
    const made = await post("/portal/gps-connect/keys", owner, { name: "Acme GPS" });
    expect(made.status).toBe(201);
    expect(made.body.key).toMatch(/^rn_gps_[A-Za-z0-9_-]{32,}$/);
    const list = (await get("/portal/gps-connect", owner)).body.keys;
    expect(list).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(made.body.key);
    expect(JSON.stringify(list)).not.toContain("key_hash");
    expect((await sql("SELECT key_hash FROM api_keys WHERE id = $1", [made.body.id])).rows[0].key_hash).not.toBe(made.body.key);
    expect((await post("/portal/gps-connect/keys", owner, { name: " " })).status).toBe(400);
  });

  it("is for people who run the account, and each company sees only its own keys", async () => {
    expect((await get("/portal/gps-connect", driver)).status).toBe(403);
    expect((await post("/portal/gps-connect/keys", driver, { name: "x" })).status).toBe(403);
    expect((await get("/portal/gps-connect", orgB)).body.keys).toEqual([]);
    const keyId = (await get("/portal/gps-connect", owner)).body.keys[0].id;
    expect((await h.call("delete", `/portal/gps-connect/keys/${keyId}`, orgB)).status).toBe(404);
  });

  it("a GPS key cannot be used as an API key to read data", async () => {
    const made = await post("/portal/gps-connect/keys", owner, { name: "second" });
    const r = await h.call("get", "/vehicles", made.body.key);
    expect(r.status).toBe(401);
  });

  it("revokes a key", async () => {
    const keyId = (await get("/portal/gps-connect", owner)).body.keys[0].id;
    expect((await h.call("delete", `/portal/gps-connect/keys/${keyId}`, owner)).status).toBe(200);
    expect((await get("/portal/gps-connect", owner)).body.keys.find((k: { id: string }) => k.id === keyId)).toBeUndefined();
    expect((await h.call("delete", `/portal/gps-connect/keys/${keyId}`, owner)).status).toBe(404);
  });

  it("lists devices that arrived through a feed and makes vehicles for them", async () => {
    await sql("INSERT INTO devices (org_id, source, external_id) VALUES ($1,'feed','truck-1'), ($1,'feed','truck-2'), ($1,'traccar','867000000000002'), ($2,'feed','other-co')", [h.orgA, h.orgB]);
    const o = (await get("/portal/gps-connect", owner)).body;
    expect(o.devices.total).toBe(2);
    expect(o.devices.waiting.map((d: { externalId: string }) => d.externalId).sort()).toEqual(["truck-1", "truck-2"]);
    const r = await post("/portal/gps-connect/create-vehicles", owner, { kind: "bus" });
    expect(r.body).toEqual({ created: 2 });
    const veh = (await sql("SELECT v.name, v.kind FROM vehicles v JOIN devices d ON d.vehicle_id = v.id WHERE d.source = 'feed' AND d.org_id = $1 ORDER BY v.name", [h.orgA])).rows;
    expect(veh).toEqual([{ name: "truck-1", kind: "bus" }, { name: "truck-2", kind: "bus" }]);
    expect((await get("/portal/gps-connect", owner)).body.devices.waiting).toEqual([]);
    expect((await post("/portal/gps-connect/create-vehicles", owner, {})).body).toEqual({ created: 0 }); // nothing left, so no duplicates
    expect((await sql("SELECT 1 FROM devices WHERE external_id = 'other-co' AND vehicle_id IS NULL")).rowCount).toBe(1); // the other company is untouched
    expect((await post("/portal/gps-connect/create-vehicles", owner, { kind: "boat" })).status).toBe(400);
  });

  it("shows up on the data sources page", async () => {
    const s = (await get("/portal/data-sources", owner)).body.sources.find((x: { id: string }) => x.id === "gps-feed");
    expect(s).toBeTruthy();
    expect(["quiet", "live", "problem", "not_connected"]).toContain(s.state);
    expect(s.next.href).toBe("/owner/settings/connect-gps");
    const trackers = (await get("/portal/data-sources", owner)).body.sources.find((x: { id: string }) => x.id === "trackers");
    expect(trackers.summary).toMatch(/1 tracker/); // feed devices are counted on their own line, not as hardware trackers
  });
});
