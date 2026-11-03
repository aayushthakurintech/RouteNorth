import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";
import { parseBody, csvEscape } from "./engine.js";
import { BY_NAME } from "./defs.js";

let h: Harness;
let owner: string;
let viewer: string;
let other: string;
beforeAll(async () => {
  h = await startHarness();
  owner = await h.token("a@example.com");
  other = await h.token("b@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer");
  viewer = await h.token("view@example.com");
}, 60_000);
afterAll(async () => { await h.close(); });

describe("resource engine validation", () => {
  const vehicles = BY_NAME.get("vehicles")!;
  it("rejects unknown fields, bad numbers and bad enums", () => {
    expect(() => parseBody(vehicles, { name: "T", evil: 1 }, true)).toThrow(/unknown field/);
    expect(() => parseBody(vehicles, { name: "T", year: 1800 }, true)).toThrow(/at least/);
    expect(() => parseBody(vehicles, { name: "T", kind: "boat" }, true)).toThrow(/one of/);
    expect(() => parseBody(vehicles, {}, true)).toThrow(/name is required/);
  });
  it("keeps good values and clears with null", () => {
    expect(parseBody(vehicles, { name: " T ", year: "2020", hazmat: true, plate: null }, true)).toEqual({ name: "T", year: 2020, hazmat: true, plate: null });
  });
  it("neutralises spreadsheet formulas in CSV", () => {
    expect(csvEscape("=SUM(A1)")).toBe("'=SUM(A1)");
    expect(csvEscape("a,b")).toBe('"a,b"');
    expect(csvEscape(-5)).toBe("-5");
  });
});

describe("resources API", () => {
  it("creates, lists, filters, updates and deletes a vehicle with full profile", async () => {
    const created = await h.call("post", "/r/vehicles", owner, { name: "Truck 9", plate: "ABC 123", capacityKg: 8000, heightM: 3.9, hazmat: false });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const list = await h.call("get", "/r/vehicles?q=truck", owner);
    expect(list.body.map((v: { id: string }) => v.id)).toContain(id);
    const upd = await h.call("patch", `/r/vehicles/${id}`, owner, { odometerKm: 120000.5, status: "in_shop" });
    expect(upd.body).toMatchObject({ odometerKm: 120000.5, status: "in_shop", capacityKg: 8000 });
    expect((await h.call("get", "/r/vehicles?status=active", owner)).body.map((v: { id: string }) => v.id)).not.toContain(id);
    expect((await h.call("delete", `/r/vehicles/${id}`, owner)).status).toBe(204);
    expect((await h.call("get", `/r/vehicles/${id}`, owner)).status).toBe(404);
  });

  it("enforces permissions and tenant isolation", async () => {
    const v = (await h.call("post", "/r/vehicles", owner, { name: "Secret" })).body.id as string;
    expect((await h.call("post", "/r/vehicles", viewer, { name: "No" })).status).toBe(403);
    expect((await h.call("get", "/r/vehicles", viewer)).status).toBe(200);
    expect((await h.call("get", `/r/vehicles/${v}`, other)).status).toBe(404);
    expect((await h.call("patch", `/r/vehicles/${v}`, other, { name: "Hijack" })).status).toBeGreaterThanOrEqual(403);
    // a reference to another organization's vehicle is refused
    await h.addUser(h.orgB, "adminb@example.com", "admin");
    const adminB = await h.token("adminb@example.com");
    const bad = await h.call("post", "/r/fuel-logs", adminB, { vehicleId: v, filledOn: "2026-01-01", litres: 40 });
    expect(bad.status).toBe(400);
    expect((await h.call("get", "/r/nope", owner)).status).toBe(404);
  });

  it("validates references, documents owners and cross-field rules", async () => {
    const v = (await h.call("post", "/r/vehicles", owner, { name: "Van 1" })).body.id as string;
    const doc = await h.call("post", "/r/documents", owner, { ownerKind: "vehicle", ownerId: v, kind: "Insurance", expiresOn: "2027-01-31" });
    expect(doc.status).toBe(201);
    expect(doc.body.expiresOn).toBe("2027-01-31");
    const ghost = await h.call("post", "/r/documents", owner, { ownerKind: "driver", ownerId: v, kind: "Licence" });
    expect(ghost.status).toBe(400);
    expect((await h.call("post", "/r/maintenance-plans", owner, { vehicleId: v, task: "Oil" })).status).toBe(400);
    expect((await h.call("post", "/r/maintenance-plans", owner, { vehicleId: v, task: "Oil", everyKm: 10000 })).status).toBe(201);
    expect((await h.call("post", "/r/geofences", owner, { name: "G", shape: "polygon", polygon: [[0, 0]] })).status).toBe(400);
    expect((await h.call("post", "/r/geofences", owner, { name: "G", lat: 43.6, lng: -79.4, radiusM: 500 })).status).toBe(201);
    // deleting a vehicle removes its documents and plans
    await h.call("delete", `/r/vehicles/${v}`, owner);
    expect((await h.call("get", `/r/documents?ownerId=${v}`, owner)).body).toEqual([]);
  });

  it("exports CSV only to people who may export", async () => {
    await h.call("post", "/r/depots", owner, { name: "=Evil", lat: 43, lng: -79 });
    const ok = await h.call("get", "/r/depots?format=csv", owner);
    expect(ok.status).toBe(200);
    expect(ok.text).toContain("'=Evil");
    expect((await h.call("get", "/r/depots?format=csv", viewer)).status).toBe(403);
  });

  it("describes the resources a person can see", async () => {
    const s = await h.call("get", "/r/_schema", owner);
    expect(s.body.map((r: { name: string }) => r.name)).toContain("jobs");
    const sv = await h.call("get", "/r/_schema", viewer);
    expect(sv.body.find((r: { name: string }) => r.name === "vehicles").canWrite).toBe(false);
  });
});
