import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";
import { OsrmProvider, ValhallaProvider, providerFromEnv } from "./providers.js";
import { zonedToEpoch } from "./time.js";

describe("time zones", () => {
  it("converts local time to the right instant, summer and winter", () => {
    expect(new Date(zonedToEpoch("2026-07-01", "08:00", "America/Toronto")).toISOString()).toBe("2026-07-01T12:00:00.000Z");
    expect(new Date(zonedToEpoch("2026-01-15", "08:00", "America/Toronto")).toISOString()).toBe("2026-01-15T13:00:00.000Z");
    expect(new Date(zonedToEpoch("2026-03-08", "08:00", "America/Vancouver")).toISOString()).toBe("2026-03-08T15:00:00.000Z");
  });
});

describe("routing providers", () => {
  it("OSRM: builds the table request and reads durations and distances", async () => {
    let seen = "";
    const p = new OsrmProvider("http://osrm/", async (url) => {
      seen = url;
      return new Response(JSON.stringify({ code: "Ok", durations: [[0, 60], [70, 0]], distances: [[0, 1000], [1100, null]] }));
    });
    const m = await p.matrix([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }], { avoid: ["tolls", "ferries"] });
    expect(seen).toContain("/table/v1/driving/2,1;4,3");
    expect(seen).toContain("exclude=toll,ferry");
    expect(m.seconds[0]![1]).toBe(60);
    expect(m.metres[1]![1]).toBe(1e7);
  });
  it("Valhalla: uses truck costing with limits for heavy vehicles", async () => {
    let body: any;
    const p = new ValhallaProvider("http://v", async (_u, init) => {
      body = JSON.parse(String(init?.body));
      return new Response(JSON.stringify({ sources_to_targets: [[{ distance: 0, time: 0 }, { distance: 2, time: 120 }], [{ distance: 2, time: 130 }, { distance: 0, time: 0 }]] }));
    });
    const m = await p.matrix([{ lat: 1, lng: 2 }, { lat: 3, lng: 4 }], { avoid: ["highways"], truck: { heightM: 4.1, weightKg: 18000, hazmat: true } });
    expect(body.costing).toBe("truck");
    expect(body.costing_options.truck).toMatchObject({ height: 4.1, weight: 18, hazmat: true, use_highways: 0 });
    expect(m.metres[0]![1]).toBe(2000);
  });
  it("is chosen from the environment, or not at all", () => {
    expect(providerFromEnv({})).toBeNull();
    expect(providerFromEnv({ ROUTING_PROVIDER: "osrm", ROUTING_URL: "http://x" })?.name).toBe("osrm");
  });
});

let h: Harness;
let owner: string;
let viewer: string;
beforeAll(async () => {
  // A fake routing server: every trip takes 10 minutes and 5 km.
  const fake = { name: "fake", matrix: async (pts: unknown[]) => ({ seconds: pts.map(() => pts.map(() => 600)), metres: pts.map(() => pts.map(() => 5000)) }) };
  h = await startHarness({ routing: fake });
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "v@example.com", "viewer");
  viewer = await h.token("v@example.com");
}, 60_000);
afterAll(async () => { await h.close(); });

const stops = [
  { id: "far", name: "Far", lat: 43.9, lng: -79.4, windowStart: "2026-07-01T13:00:00Z", windowEnd: "2026-07-01T15:00:00Z" },
  { id: "near", name: "Near", lat: 43.66, lng: -79.39, weightKg: 100 },
  { id: "mid", name: "Mid", lat: 43.75, lng: -79.4 },
];

describe("planning API", () => {
  it("optimizes a route with real-road matrix when a provider is set", async () => {
    const r = await h.call("post", "/plan/optimize", owner, { date: "2026-07-01", start: { lat: 43.65, lng: -79.38 }, stops });
    expect(r.status).toBe(201);
    expect(r.body.source).toBe("fake");
    expect(r.body.order).toHaveLength(3);
    expect(r.body.stops[0].arriveAt).toBeTruthy();
    expect(r.body.totals.distanceM).toBeGreaterThan(0);
    expect(r.body.violations).toEqual([]);
    expect(r.body.cost).toBeGreaterThan(0);
  });

  it("requires permission and valid input", async () => {
    expect((await h.call("post", "/plan/optimize", viewer, { date: "2026-07-01", stops })).status).toBe(403);
    expect((await h.call("post", "/plan/optimize", owner, { date: "2026-07-01", stops: [] })).status).toBe(400);
    expect((await h.call("post", "/plan/optimize", owner, { date: "2026-07-01", avoid: ["bridges"], stops })).status).toBe(400);
    expect((await h.call("post", "/plan/optimize", owner, { date: "07/01", stops })).status).toBe(400);
  });

  it("uses vehicle capacity and flags overloads", async () => {
    const v = (await h.call("post", "/r/vehicles", owner, { name: "Small van", capacityKg: 150 })).body.id as string;
    const heavy = [{ id: "a", name: "A", lat: 43.7, lng: -79.4, weightKg: 100 }, { id: "b", name: "B", lat: 43.71, lng: -79.4, weightKg: 100 }];
    const r = await h.call("post", "/plan/optimize", owner, { date: "2026-07-01", vehicleId: v, start: { lat: 43.65, lng: -79.38 }, stops: heavy });
    expect(r.body.violations).toContain("capacity");
  });

  it("compares two scenarios and previews a new stop", async () => {
    const base = { date: "2026-07-01", start: { lat: 43.65, lng: -79.38 }, stops };
    const cmp = await h.call("post", "/plan/compare", owner, { a: base, b: { ...base, objective: "distance", avoid: ["tolls"] } });
    expect(cmp.status).toBe(201);
    expect(cmp.body.comparison.winner).toMatch(/a|b|tie/);
    expect(cmp.body.a.totals).toBeTruthy();
    const w = await h.call("post", "/plan/whatif", owner, { plan: base, add: { name: "New", lat: 43.8, lng: -79.4 } });
    expect(w.body.order).toContain("__new");
    // the new stop fits into time the driver would have spent waiting for a window, so the day is no longer
    expect(w.body.addedDistanceM).toBeGreaterThan(0);
    expect(w.body.addedDurationS).toBeGreaterThanOrEqual(0);
  });

  it("splits stops across vehicles", async () => {
    const v1 = (await h.call("post", "/r/vehicles", owner, { name: "F1", capacityKg: 120 })).body.id as string;
    const v2 = (await h.call("post", "/r/vehicles", owner, { name: "F2", capacityKg: 120 })).body.id as string;
    const many = [0, 1, 2, 3].map((i) => ({ id: `m${i}`, name: `M${i}`, lat: 43.7 + i * 0.01, lng: -79.4, weightKg: 100 }));
    const r = await h.call("post", "/plan/fleet", owner, { date: "2026-07-01", start: { lat: 43.65, lng: -79.38 }, vehicleIds: [v1, v2], stops: many });
    expect(r.status).toBe(201);
    expect(r.body.routes.map((x: { order: string[] }) => x.order.length).sort()).toEqual([1, 1]);
    expect(r.body.unassigned).toHaveLength(2);
    expect(r.body.unassigned[0].reason).toBe("capacity");
  });

  it("optimizes and applies an existing route, then gives live ETAs", async () => {
    const route = await h.call("post", "/routes", owner, { name: "R", date: "2026-07-01", stops: [
      { name: "Z", lat: 43.9, lng: -79.4 }, { name: "Y", lat: 43.66, lng: -79.39 }, { name: "X", lat: 43.7, lng: -79.4 }] });
    const id = route.body.id as string;
    const r = await h.call("post", `/plan/routes/${id}/optimize`, owner, { apply: true });
    expect(r.body.applied).toBe(true);
    const after = await h.call("get", `/routes/${id}`, owner);
    expect(after.body.stops.map((s: { id: string }) => s.id)).toEqual(r.body.order);
    expect(after.body.stops.every((s: { eta: string | null }) => s.eta)).toBe(true);
    const eta = await h.call("get", `/plan/routes/${id}/etas`, owner);
    expect(eta.body.available).toBe(false); // no vehicle on this route
    expect((await h.call("get", "/plan/traffic", owner)).body.hourly).toHaveLength(24);
  });
});
