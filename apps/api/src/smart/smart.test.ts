import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";
import type { Providers } from "../notify/notifier.js";
import { todayIn } from "./ai.controller.js";
import { lastPeriod } from "./safety.controller.js";
import { EVALUATORS } from "../alerts/engine.js";

let h: Harness, owner: string, viewer: string, sam: string, alex: string, samTok: string, tz: string, today: string, depot: string, veh: string;
const calls: { url: string; body: string }[] = [];
let aiReply = '{"type":"briefing"}';
const stub: Providers = {
  fetch: (async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), body: String(init?.body ?? "") });
    if (String(url).startsWith("https://ai.test")) return new Response(JSON.stringify({ content: [{ type: "text", text: aiReply }] }), { status: 200 });
    return new Response("ok");
  }) as typeof fetch,
  email: { apiKey: "k", from: "x@example.com", url: "https://email.test/send" }, sms: null,
};
const job = async (o: Record<string, unknown> = {}) => (await h.call("post", "/r/jobs", owner, { title: "Parcel", lat: 43.7, lng: -79.4, customerName: "Acme", customerEmail: "c@example.com", scheduledDate: today, ...o })).body.id as string;
const mkRoute = async (driver: string, name: string, stops: { lat: number; lng: number; job?: string; status?: string; svc?: number; window_end?: string }[], extra: Record<string, unknown> = {}) => {
  const r = (await h.admin.query("INSERT INTO routes (org_id, name, route_date, driver_id, vehicle_id, status, depot_id) VALUES ($1,$2,$3,$4,$5,'planned',$6) RETURNING id", [h.orgA, name, today, driver, extra.vehicle ?? null, extra.depot ?? null])).rows[0].id as string;
  const ids: string[] = [];
  for (const [i, s] of stops.entries()) {
    const st = (await h.admin.query("INSERT INTO stops (org_id, route_id, sequence, name, lat, lng, job_id, status, service_min, window_end) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id", [h.orgA, r, i + 1, `${name} ${i + 1}`, s.lat, s.lng, s.job ?? null, s.status ?? "pending", s.svc ?? 5, s.window_end ?? null])).rows[0].id as string;
    ids.push(st);
    if (s.job) await h.admin.query("UPDATE jobs SET route_id = $2, stop_id = $3, driver_id = $4, status = 'assigned' WHERE id = $1", [s.job, r, st, driver]);
  }
  return { id: r, stops: ids };
};
const reset = async () => { await h.admin.query("DELETE FROM customer_notifications; DELETE FROM automation_events; DELETE FROM job_links; DELETE FROM jobs; DELETE FROM routes; DELETE FROM help_requests; DELETE FROM alerts; DELETE FROM checkins; DELETE FROM territories; DELETE FROM shifts; DELETE FROM driver_profiles"); calls.length = 0; };

beforeAll(async () => {
  h = await startHarness({ notify: stub });
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer"); viewer = await h.token("view@example.com");
  sam = await h.addUser(h.orgA, "sam@example.com", "driver", { display_name: "Sam Singh" }); samTok = await h.token("sam@example.com");
  alex = await h.addUser(h.orgA, "alex@example.com", "driver", { display_name: "Alex Roy" });
  tz = (await h.admin.query("SELECT timezone FROM organizations WHERE id = $1", [h.orgA])).rows[0].timezone;
  today = todayIn(tz);
  depot = (await h.admin.query("INSERT INTO depots (org_id, name, lat, lng) VALUES ($1,'Main',43.65,-79.38) RETURNING id", [h.orgA])).rows[0].id;
  veh = (await h.call("post", "/r/vehicles", owner, { name: "Van 1", kind: "van", capacityKg: 500, depotId: depot, odometerKm: 350_000, year: 2012 })).body.id;
  process.env.ANTHROPIC_API_KEY = "";
}, 90_000);
afterAll(async () => { delete process.env.ANTHROPIC_API_KEY; delete process.env.AI_API_URL; await h.close(); });
beforeEach(reset);

describe("briefing and permissions", () => {
  it("puts calls for help first, then waiting jobs", async () => {
    await job({ title: "Waiting" });
    await h.admin.query("INSERT INTO help_requests (org_id, driver_id, kind) VALUES ($1,$2,'flat_tire')", [h.orgA, sam]);
    const r = await h.call("get", "/ai/briefing", viewer);
    expect(r.status).toBe(200);
    expect(r.body.items.map((i: { key: string }) => i.key).slice(0, 2)).toEqual(["help", "unassigned"]);
    expect(r.body.items[0].examples[0]).toContain("flat tire");
  });
  it("is closed to drivers and other organizations", async () => {
    expect((await h.call("get", "/ai/briefing", samTok)).status).toBe(403);
    expect((await h.call("get", "/ai/briefing")).status).toBe(401);
    expect((await h.call("post", "/ai/assistant/run", viewer, { intent: { type: "reassign" } })).status).toBe(403);
  });
});

describe("assistant", () => {
  it("moves a driver's stops to another driver and tells the customers", async () => {
    const j1 = await job({ title: "One" }), j2 = await job({ title: "Two", customerEmail: null });
    const route = await mkRoute(sam, "Sam route", [{ lat: 43.7, lng: -79.4, job: j1 }, { lat: 43.71, lng: -79.4, job: j2 }]);
    const ask = await h.call("post", "/ai/assistant", owner, { text: "Move all of Sam's stops to Alex and tell the customers" });
    expect(ask.status).toBe(200);
    expect(ask.body.intent).toMatchObject({ type: "reassign", fromId: sam, toId: alex, notify: true });
    expect(ask.body.preview).toMatchObject({ from: "Sam Singh", to: "Alex Roy", count: 2, customers: 1 });
    const run = await h.call("post", "/ai/assistant/run", owner, { intent: ask.body.intent });
    expect(run.status).toBe(200);
    expect(run.body).toMatchObject({ moved: 2, notified: 1 });
    expect((await h.admin.query("SELECT driver_id FROM jobs WHERE id = ANY($1)", [[j1, j2]])).rows.every((r) => r.driver_id === alex)).toBe(true);
    expect((await h.admin.query("SELECT count(*)::int AS n FROM stops WHERE route_id = $1", [route.id])).rows[0].n).toBe(0);
    expect((await h.admin.query("SELECT 1 FROM routes WHERE id = $1", [route.id])).rowCount).toBe(0);
    expect((await h.admin.query("SELECT status FROM customer_notifications WHERE job_id = $1", [j1])).rows.map((r) => r.status)).toContain("sent");
    expect((await h.admin.query("SELECT 1 FROM automation_events WHERE kind = 'job.assigned' AND subject_id = $1 AND payload->>'via' = 'assistant'", [j1])).rowCount).toBe(1);
  });
  it("asks again instead of guessing", async () => {
    const r = await h.call("post", "/ai/assistant", owner, { text: "move Sam's stops to Zed" });
    expect(r.body.intent).toEqual({ type: "unknown", reason: "driver_not_found", name: "Zed" });
    expect((await h.call("post", "/ai/assistant", owner, { text: "" })).status).toBe(400);
    expect((await h.call("post", "/ai/assistant/run", owner, { intent: { type: "reassign", fromId: sam, toId: sam, date: today, notify: false } })).status).toBe(400);
  });
  it("builds a report from a description and the report runs", async () => {
    const r = await h.call("post", "/ai/assistant", owner, { text: "Show me a driver report for last 30 days" });
    expect(r.body.intent).toMatchObject({ type: "report", template: "driverScorecard", range: "last30" });
    expect(r.body.preview.spec).toMatchObject({ dataset: "scorecard.driver", range: { preset: "last30" } });
    expect((await h.call("post", "/reports/run", owner, { spec: r.body.preview.spec })).status).toBe(200);
    const by = await h.call("post", "/ai/assistant", owner, { text: "fuel report last month by vehicle" });
    expect(by.body.preview.spec.range).toEqual({ preset: "lastMonth" });
  });
  it("uses the AI service only for sentences the rules cannot read, and checks its answer", async () => {
    process.env.ANTHROPIC_API_KEY = "test"; process.env.AI_API_URL = "https://ai.test/v1/messages";
    try {
      aiReply = '{"type":"briefing"}';
      const a = await h.call("post", "/ai/assistant", owner, { text: "give me the lay of the land" });
      expect(a.body).toMatchObject({ source: "ai", intent: { type: "briefing" } });
      aiReply = `{"type":"reassign","fromId":"${sam}","toId":"00000000-0000-4000-8000-000000000000","date":"${today}","notify":false}`;
      const bad = await h.call("post", "/ai/assistant", owner, { text: "give me the lay of the land" });
      expect(bad.body).toMatchObject({ source: "rules", intent: { type: "unknown" } });
      aiReply = '{"fields": 1, "customerName":"Acme Ltd","address":"1 Main St","reference":"PO-9"}';
      const png = "data:image/png;base64,iVBORw0KGgo=";
      const doc = await h.call("post", "/ai/read-document", owner, { image: png, kind: "delivery_note" });
      expect(doc.status).toBe(200);
      expect(doc.body.fields.customerName).toBe("Acme Ltd");
      expect(calls.some((c) => c.url.startsWith("https://ai.test") && c.body.includes("base64"))).toBe(true);
      expect((await h.call("post", "/ai/read-document", owner, { image: "data:text/html;base64,AAAA" })).status).toBe(400);
    } finally { process.env.ANTHROPIC_API_KEY = ""; }
  });
  it("says plainly that reading photos needs an AI key", async () => {
    const r = await h.call("post", "/ai/read-document", owner, { image: "data:image/png;base64,iVBORw0KGgo=" });
    expect(r.status).toBe(503);
    expect((await h.call("get", "/ai/status", owner)).body).toMatchObject({ assistant: { rules: true, ai: false } });
  });
});

describe("predictions and learning", () => {
  it("lists stops likely to miss their window", async () => {
    const r = await mkRoute(sam, "Live", [{ lat: 43.7, lng: -79.4 }, { lat: 43.71, lng: -79.4 }]);
    await h.admin.query("UPDATE routes SET status = 'in_progress' WHERE id = $1", [r.id]);
    await h.admin.query("UPDATE stops SET eta = now() + interval '30 minutes', window_end = now() + interval '5 minutes' WHERE id = $1", [r.stops[0]]);
    await h.admin.query("UPDATE stops SET eta = now() + interval '30 minutes', window_end = now() + interval '3 hours' WHERE id = $1", [r.stops[1]]);
    const l = await h.call("get", "/ai/late", owner);
    expect(l.body.stops[0]).toMatchObject({ id: r.stops[0], level: "high", driver: "Sam Singh" });
    expect(l.body.stops[1].level).toBe("low");
  });
  it("explains a late route from what was recorded", async () => {
    const r = await mkRoute(sam, "Late one", [{ lat: 43.7, lng: -79.4 }]);
    await h.admin.query("UPDATE stops SET status = 'done', window_end = now() - interval '2 hours', arrived_at = now() - interval '90 minutes', departed_at = now() - interval '60 minutes', service_min = 5 WHERE id = $1", [r.stops[0]]);
    const x = await h.call("get", `/ai/explain?routeId=${r.id}`, owner);
    expect(x.status).toBe(200);
    expect(x.body.worstLateMin).toBe(30);
    expect(x.body.causes[0]).toMatchObject({ kind: "long_stop", minutes: 25 });
    expect(x.body.trafficMeasured).toBe(false);
    const list = await h.call("get", `/ai/explain/routes?date=${today}`, owner);
    expect(list.body.routes[0]).toMatchObject({ id: r.id, lateMin: 30 });
    expect((await h.call("get", "/ai/explain?routeId=00000000-0000-4000-8000-000000000000", owner)).status).toBe(404);
  });
  it("scores vehicle health and says why", async () => {
    await h.admin.query("INSERT INTO maintenance_plans (org_id, vehicle_id, task, every_km, every_days, last_done_km, last_done_on) VALUES ($1,$2,'Oil',10000,180,330000,$3::date - 400)", [h.orgA, veh, today]);
    await h.admin.query("INSERT INTO inspections (org_id, vehicle_id, kind, defects) VALUES ($1,$2,'check_out',true)", [h.orgA, veh]);
    const r = await h.call("get", "/ai/breakdown", owner);
    expect(r.body.vehicles[0]).toMatchObject({ name: "Van 1" });
    expect(r.body.vehicles[0].score).toBeGreaterThanOrEqual(55);
    expect(r.body.vehicles[0].reasons.map((x: { key: string }) => x.key)).toEqual(expect.arrayContaining(["service_km", "service_days", "open_defects", "age", "mileage"]));
  });
  it("suggests drivers by skill, preferences and closeness", async () => {
    await h.admin.query("INSERT INTO driver_profiles (user_id, org_id, skills) VALUES ($1,$2,'{cold}') ON CONFLICT (user_id) DO UPDATE SET skills = '{cold}'", [sam, h.orgA]);
    const j = await job({ skills: ["cold"], customerName: "Acme" });
    const s = await h.call("post", "/ai/suggest-driver", owner, { jobId: j });
    expect(s.status).toBe(200);
    expect(s.body.suggestions[0]).toMatchObject({ driverId: sam, blocked: null });
    expect(s.body.suggestions.find((x: { driverId: string }) => x.driverId === alex).blocked).toBe("skills");
    expect((await h.call("put", `/optimize/preferences/${sam}`, owner, { avoidCustomers: ["acme"], daysOff: [] })).status).toBe(200);
    expect((await h.call("post", "/ai/suggest-driver", owner, { jobId: j })).body.suggestions.find((x: { driverId: string }) => x.driverId === sam).blocked).toBe("avoids_customer");
    await h.call("put", `/optimize/preferences/${sam}`, owner, { daysOff: [today] });
    expect((await h.call("post", "/ai/suggest-driver", owner, { jobId: j })).body.suggestions.find((x: { driverId: string }) => x.driverId === sam).blocked).toBe("off_today");
    expect((await h.call("put", `/optimize/preferences/${sam}`, owner, { maxStops: 0 })).status).toBe(400);
    expect((await h.call("put", `/optimize/preferences/${sam}`, viewer, { maxStops: 5 })).status).toBe(403);
  });
  it("learns real time at a customer and can apply it to coming jobs", async () => {
    const r = await mkRoute(sam, "History", [1, 2, 3, 4].map((i) => ({ lat: 43.7 + i / 1000, lng: -79.4 })));
    for (const [i, sid] of r.stops.entries()) {
      const j = await job({ title: `Past ${i}`, customerName: "Slow Customer" });
      await h.admin.query("UPDATE stops SET status = 'done', job_id = $2, arrived_at = now() - interval '5 hours', departed_at = now() - interval '5 hours' + interval '12 minutes' WHERE id = $1", [sid, j]);
    }
    const open = await job({ title: "Coming", customerName: "Slow Customer" });
    const l = await h.call("get", "/ai/learned/stop-times", owner);
    expect(l.body.customers[0]).toMatchObject({ key: "Slow Customer", samples: 4, medianMin: 12, plannedMin: 5, diffMin: 7 });
    const a = await h.call("post", "/ai/learned/stop-times/apply", owner, { customer: "Slow Customer", minutes: 12 });
    expect(a.body.jobs).toBeGreaterThanOrEqual(1);
    expect((await h.admin.query("SELECT service_min FROM jobs WHERE id = $1", [open])).rows[0].service_min).toBe(12);
    expect((await h.call("post", "/ai/learned/stop-times/apply", viewer, { customer: "x", minutes: 5 })).status).toBe(403);
    expect((await h.call("post", "/ai/learned/stop-times/apply", owner, { customer: "x", minutes: 0 })).status).toBe(400);
  });
  it("learns speeds by hour and by driver from GPS", async () => {
    const dev = (await h.admin.query("INSERT INTO devices (org_id, vehicle_id, source, external_id) VALUES ($1,$2,'simulator','spd-1') RETURNING id", [h.orgA, veh])).rows[0].id;
    await mkRoute(sam, "Speedy", [{ lat: 43.7, lng: -79.4 }], { vehicle: veh });
    for (let i = 0; i < 30; i++) await h.admin.query("INSERT INTO positions (time, org_id, device_id, lat, lng, speed, ignition) VALUES (now() - make_interval(secs => $4), $1,$2,43.7,-79.4,$3,true)", [h.orgA, dev, 40 + (i % 3), i * 5]);
    const r = await h.call("get", "/ai/learned/speeds", owner);
    expect(r.body.byHour.length).toBeGreaterThan(0);
    expect(r.body.byDriver[0]).toMatchObject({ name: "Sam Singh" });
    expect(r.body.byDriver[0].avgKmh).toBeGreaterThan(39);
  });
  it("forecasts jobs and drivers from the weekday pattern", async () => {
    for (let w = 1; w <= 6; w++) for (const dd of [0, 1, 2]) {
      const d = new Date(Date.parse(`${today}T12:00:00Z`) - (7 * w - dd) * 86_400_000).toISOString().slice(0, 10);
      for (let k = 0; k < 8; k++) await job({ title: `h${w}${dd}${k}`, scheduledDate: d });
    }
    const r = await h.call("get", "/ai/forecast?days=7", owner);
    expect(r.status).toBe(200);
    expect(r.body.days).toHaveLength(7);
    expect(r.body.drivers).toBe(2);
    expect(r.body.days.some((d: { jobs: number }) => d.jobs >= 6)).toBe(true);
    expect(r.body.enoughHistory).toBe(true);
    expect((await h.call("get", "/ai/forecast", samTok)).status).toBe(403);
  });
  it("tidies an address and finds saved matches", async () => {
    await job({ address: "22 Elm Avenue, Ottawa, ON K1A 0B1" });
    const r = await h.call("post", "/ai/fix-address", owner, { text: "5 - 22 elm ave, ottawa ON k1a0b1" });
    expect(r.body.text).toBe("22 Elm Avenue, Ottawa ON K1A 0B1, Unit 5");
    expect(r.body.changes).toEqual(expect.arrayContaining(["unit_order"]));
    expect(r.body.hits[0]).toMatchObject({ source: "saved" });
    expect((await h.call("post", "/ai/fix-address", owner, { text: "x" })).status).toBe(400);
  });
});

describe("optimization tools", () => {
  it("suggests even areas, and saves, edits and removes them", async () => {
    for (let i = 0; i < 12; i++) await h.admin.query("INSERT INTO jobs (org_id, title, lat, lng, status) VALUES ($1,'p',$2,$3,'unassigned')", [h.orgA, 43.6 + (i % 6) * 0.002, (i < 6 ? -79.9 : -79.0) + (i % 2) * 0.005]);
    const s = await h.call("post", "/optimize/territories/suggest", owner, { count: 2 });
    expect(s.body.areas).toHaveLength(2);
    expect(s.body.areas.map((a: { stops: number }) => a.stops)).toEqual([6, 6]);
    const created = await h.call("post", "/optimize/territories", owner, { name: s.body.areas[0].name, polygon: s.body.areas[0].polygon, driverId: sam, color: "#ff0000" });
    expect(created.status).toBe(201);
    expect((await h.call("get", "/optimize/territories", viewer)).body[0]).toMatchObject({ name: "Area 1", driverName: "Sam Singh", color: "#ff0000" });
    expect((await h.call("patch", `/optimize/territories/${created.body.id}`, owner, { name: "West", driverId: null })).status).toBe(200);
    expect((await h.call("post", "/optimize/territories", owner, { name: "Bad", polygon: [[1, 1]] })).status).toBe(400);
    expect((await h.call("post", "/optimize/territories", viewer, { name: "No", polygon: s.body.areas[0].polygon })).status).toBe(403);
    expect((await h.call("delete", `/optimize/territories/${created.body.id}`, owner)).status).toBe(200);
  });
  it("measures the balance of the day and moves stops to even it out", async () => {
    const stops = Array.from({ length: 8 }, (_, i) => ({ lat: 43.7 + i * 0.002, lng: -79.4, svc: 30 }));
    const route = await mkRoute(sam, "Heavy", stops);
    const b = await h.call("get", `/optimize/balance?date=${today}`, owner);
    expect(b.body.overloaded).toEqual([sam]); expect(b.body.underloaded).toEqual([alex]); expect(b.body.fair).toBe(false);
    expect(b.body.moves.length).toBeGreaterThan(0);
    const ap = await h.call("post", "/optimize/balance/apply", owner, { date: today, moves: b.body.moves.map((m: { stopId: string; toId: string }) => ({ stopId: m.stopId, toId: m.toId })) });
    expect(ap.body.moved).toBe(b.body.moves.length);
    const after = await h.call("get", `/optimize/balance?date=${today}`, owner);
    expect(after.body.spreadPct).toBeLessThan(b.body.spreadPct);
    expect(route.id).toBeTruthy();
    expect((await h.call("post", "/optimize/balance/apply", viewer, { date: today, moves: [] })).status).toBe(403);
  });
  it("compares the current, fastest and shortest order with cost and CO2, and applies one", async () => {
    const pts = [[43.9, -79.4], [43.7, -79.4], [43.85, -79.4], [43.75, -79.4], [43.8, -79.4]];
    const r = await mkRoute(sam, "Mixed", pts.map(([lat, lng]) => ({ lat: lat!, lng: lng! })), { vehicle: veh, depot });
    const c = await h.call("get", `/optimize/compare?routeId=${r.id}`, owner);
    expect(c.status).toBe(200);
    expect(c.body.options.map((o: { id: string }) => o.id)).toEqual(["current", "time", "distance"]);
    const cur = c.body.options[0], best = c.body.options.find((o: { id: string }) => o.id === c.body.cheapest);
    expect(best.cost.total).toBeLessThan(cur.cost.total);
    expect(cur.cost.total).toBeCloseTo(cur.cost.fuel + cur.cost.wages + cur.cost.wear + cur.cost.tolls, 1);
    expect(cur.cost.co2Kg).toBeGreaterThan(0);
    expect(c.body.vehicles[0]).toHaveProperty("co2Kg");
    expect((await h.call("post", "/optimize/compare/apply", owner, { routeId: r.id, option: "distance" })).status).toBe(200);
    const seq = (await h.admin.query("SELECT lat FROM stops WHERE route_id = $1 ORDER BY sequence", [r.id])).rows.map((x) => x.lat);
    expect(seq).toEqual([...seq].sort((a, b) => a - b));
    expect((await h.call("post", "/optimize/compare/apply", owner, { routeId: r.id, option: "cheap" })).status).toBe(400);
  });
  it("plans each depot with its own drivers", async () => {
    await h.admin.query("INSERT INTO depots (org_id, name, lat, lng) VALUES ($1,'North',44.4,-79.4)", [h.orgA]);
    const north = (await h.admin.query("SELECT id FROM depots WHERE name = 'North'")).rows[0].id;
    await h.admin.query("INSERT INTO driver_profiles (user_id, org_id, home_depot_id) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET home_depot_id = $3", [sam, h.orgA, depot]);
    await h.admin.query("INSERT INTO driver_profiles (user_id, org_id, home_depot_id) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET home_depot_id = $3", [alex, h.orgA, north]);
    const near = await job({ title: "Near main", lat: 43.66 }), far = await job({ title: "Near north", lat: 44.39 });
    const p = await h.call("post", "/optimize/multi-depot", owner, { date: today });
    expect(p.body.depots.find((d: { name: string }) => d.name === "Main").proposals[0]).toMatchObject({ jobId: near, driverId: sam });
    expect(p.body.depots.find((d: { name: string }) => d.name === "North").proposals[0]).toMatchObject({ jobId: far, driverId: alex });
    expect(p.body.applied).toBe(false);
    const ap = await h.call("post", "/optimize/multi-depot", owner, { date: today, apply: true });
    expect(ap.body.applied).toBe(true);
    expect((await h.admin.query("SELECT driver_id FROM jobs WHERE id = $1", [far])).rows[0].driver_id).toBe(alex);
    await h.admin.query("DELETE FROM depots WHERE name = 'North'");
  });
  it("finds return loads, groups shared rides and fixes pickup-delivery pairs", async () => {
    const r = await mkRoute(sam, "Out and back", [{ lat: 43.9, lng: -79.38 }], { vehicle: veh, depot });
    const onWay = await job({ title: "On the way home", type: "pickup", lat: 43.78, lng: -79.38, weightKg: 10, scheduledDate: today });
    await job({ title: "Too far", type: "pickup", lat: 43.78, lng: -78.0, scheduledDate: today });
    const bh = await h.call("get", `/optimize/backhaul?routeId=${r.id}`, owner);
    expect(bh.body.candidates.map((c: { id: string }) => c.id)).toEqual([onWay]);
    expect(bh.body.spareKg).toBe(500);

    for (const [i, lat] of [43.65, 43.651, 43.0].entries()) {
      const p = await job({ title: `Ride ${i}`, type: "pickup", tags: ["ride"], lat, items: 1 });
      await h.admin.query("INSERT INTO jobs (org_id, title, type, lat, lng, parent_job_id, scheduled_date) VALUES ($1,'drop','delivery',43.9,-79.4,$2,$3)", [h.orgA, p, today]);
    }
    const rides = await h.call("post", "/optimize/rides", owner, { date: today, seats: 4 });
    expect(rides.body).toMatchObject({ requests: 3, vehiclesSaved: 1 });
    expect(rides.body.groups.map((g: { ids: string[] }) => g.ids.length).sort()).toEqual([1, 2]);

    const pick = await job({ title: "Pick", type: "pickup", lat: 43.7 }), drop = await job({ title: "Drop", type: "delivery", lat: 43.72 });
    await h.admin.query("UPDATE jobs SET parent_job_id = $1 WHERE id = $2", [pick, drop]);
    await mkRoute(sam, "Pick route", [{ lat: 43.7, lng: -79.4, job: pick }]);
    await mkRoute(alex, "Drop route", [{ lat: 43.72, lng: -79.4, job: drop }]);
    const pairs = await h.call("get", `/optimize/pairs?date=${today}`, owner);
    expect(pairs.body.pairs.find((p: { pickupId: string }) => p.pickupId === pick).state).toBe("different_driver");
    expect((await h.call("post", "/optimize/pairs/fix", owner, { date: today })).body.fixed).toBe(1);
    const fixed = await h.call("get", `/optimize/pairs?date=${today}`, owner);
    expect(fixed.body.pairs.find((p: { pickupId: string }) => p.pickupId === pick).state).toBe("ok");
  });
  it("simulates a change before spending money", async () => {
    await h.call("post", "/r/vehicles", owner, { name: "Van 2", kind: "van", capacityKg: 100, depotId: depot });
    for (let i = 0; i < 8; i++) await job({ title: `S${i}`, lat: 43.65 + i * 0.01, weightKg: 200 });
    const r = await h.call("post", "/optimize/simulate", owner, { date: today, addVehicles: 2, capacityKg: 500 });
    expect(r.status).toBe(200);
    expect(r.body.baseline.vehicles).toBe(2); expect(r.body.scenario.vehicles).toBe(4);
    expect(r.body.scenario.unserved).toBeLessThanOrEqual(r.body.baseline.unserved);
    expect(r.body.baseline.unserved).toBeGreaterThan(0);
    const none = await h.call("post", "/optimize/simulate", owner, { date: "2020-01-01" });
    expect(none.body).toMatchObject({ jobs: 0, baseline: null });
    expect((await h.call("post", "/optimize/simulate", owner, { date: today, depot: { lat: 500, lng: 0 } })).status).toBe(400);
  });
});

describe("safety", () => {
  const drive = async (dev: string, rows: [number, number, number, number | null][]) => { for (const [secs, lat, speed, heading] of rows) await h.admin.query("INSERT INTO positions (time, org_id, device_id, lat, lng, speed, heading, ignition) VALUES ($5::timestamptz + make_interval(secs => $4), $1,$2,$3,-79.4,$6,$7,true)", [h.orgA, dev, lat, secs, new Date(Date.now() - 3600_000).toISOString(), speed, heading]); };
  it("scores drivers, counts hard corners and shows events with their dash cam clip", async () => {
    const dev = (await h.admin.query("INSERT INTO devices (org_id, vehicle_id, source, external_id) VALUES ($1,$2,'simulator','sf-1') RETURNING id", [h.orgA, veh])).rows[0].id;
    await mkRoute(sam, "Safety", [{ lat: 43.7, lng: -79.4 }], { vehicle: veh });
    const base = Array.from({ length: 40 }, (_, i): [number, number, number, number | null] => [i * 5, 43.7 + i * 0.0006, 60, 0]);
    await drive(dev, [...base, [201, 43.7245, 60, 0], [203, 43.7246, 60, 45]]);
    const s = await h.call("get", "/safety/scores", owner);
    expect(s.status).toBe(200);
    expect(s.body.cornering).toBe(true);
    const row = s.body.drivers.find((d: { driverId: string }) => d.driverId === sam);
    expect(row.corners).toBeGreaterThanOrEqual(1);
    expect((await h.call("get", "/safety/scores", samTok)).status).toBe(403);
    const t = new Date(Date.now() - 3600_000 + 310_000).toISOString();
    await drive(dev, [[300, 43.73, 140, 0], [305, 43.7305, 140, 0], [310, 43.731, 140, 0], [315, 43.7315, 140, 0], [320, 43.732, 140, 0]]);
    const clip = await h.call("post", "/safety/clips", owner, { vehicleId: veh, eventKind: "speeding", eventAt: t, url: "https://cam.example/clip/1", note: "front camera" });
    expect(clip.status).toBe(201);
    expect((await h.call("post", "/safety/clips", owner, { vehicleId: veh, eventKind: "speeding", eventAt: t, url: "http://insecure.example/x" })).status).toBe(400);
    expect((await h.call("post", "/safety/clips", viewer, { eventAt: t, url: "https://cam.example/2" })).status).toBe(403);
    const ev = await h.call("get", "/safety/events", owner);
    expect(ev.body.events.some((e: { kind: string; clips: unknown[] }) => e.kind === "speeding" && e.clips.length === 1)).toBe(true);
    expect((await h.call("get", "/safety/clips", viewer)).body).toHaveLength(1);
    expect((await h.call("delete", `/safety/clips/${clip.body.id}`, owner)).status).toBe(200);
  });
  it("gives each driver a tip and keeps the leaderboard optional and fair", async () => {
    const t = await h.call("get", "/safety/my-tips", samTok);
    expect(t.status).toBe(200); expect(t.body.enabled).toBe(true);
    await h.call("put", "/org", owner, { settings: { safety: { coaching: false } } });
    expect((await h.call("get", "/safety/my-tips", samTok)).body).toEqual({ enabled: false, tips: [] });
    await h.call("put", "/org", owner, { settings: { safety: { coaching: true } } });
    expect((await h.call("get", "/safety/leaderboard", samTok)).body).toMatchObject({ enabled: false, rows: [] });
    expect((await h.call("put", "/org", owner, { settings: { safety: { leaderboard: true, bogus: 1 } } })).status).toBe(400);
    expect((await h.call("put", "/org", owner, { settings: { safety: { leaderboard: true, anonymous: true } } })).status).toBe(200);
    const lb = await h.call("get", "/safety/leaderboard", samTok);
    expect(lb.body.enabled).toBe(true);
    expect(lb.body.rows.every((r: { you: boolean; name: string | null }) => r.you || r.name === null)).toBe(true);
    await h.call("put", "/org", owner, { settings: { safety: { leaderboard: false } } });
  });
  it("tracks rewards: a rule, a calculation that runs once, payment and the driver's own view", async () => {
    const rule = await h.call("post", "/safety/reward-rules", owner, { name: "Calm month", metric: "stopsDone", op: "gte", target: 1, bonus: 50, period: "week" });
    expect(rule.status).toBe(201);
    expect((await h.call("post", "/safety/reward-rules", owner, { name: "x", metric: "nonsense", target: 1, bonus: 1 })).status).toBe(400);
    const wk = lastPeriod(today, "week");
    const r = await mkRoute(sam, "Reward route", [{ lat: 43.7, lng: -79.4 }]);
    await h.admin.query("UPDATE routes SET route_date = $2, status = 'completed' WHERE id = $1", [r.id, wk.from]);
    await h.admin.query("UPDATE stops SET status = 'done', arrived_at = $2, departed_at = $2 WHERE id = $1", [r.stops[0], `${wk.from}T15:00:00Z`]);
    const first = await h.call("post", "/safety/rewards/run", owner, {});
    expect(first.body.earned).toBe(1);
    expect((await h.call("post", "/safety/rewards/run", owner, {})).body.earned).toBe(0);
    const list = await h.call("get", "/safety/rewards", owner);
    expect(list.body[0]).toMatchObject({ driverName: "Sam Singh", rule: "Calm month", amount: 50, status: "earned" });
    expect((await h.call("get", "/safety/my-rewards", samTok)).body).toMatchObject({ total: 50 });
    expect((await h.call("patch", `/safety/rewards/${list.body[0].id}`, owner, { status: "paid" })).status).toBe(200);
    expect((await h.call("patch", `/safety/rewards/${list.body[0].id}`, owner, { status: "nope" })).status).toBe(400);
    expect((await h.call("post", "/safety/rewards/run", viewer, {})).status).toBe(403);
    expect((await h.call("patch", `/safety/reward-rules/${rule.body.id}`, owner, { active: false })).status).toBe(200);
    expect((await h.call("delete", `/safety/reward-rules/${rule.body.id}`, owner)).status).toBe(200);
  });
  it("works out finished weeks and months", () => {
    expect(lastPeriod("2026-03-04", "week")).toEqual({ from: "2026-02-23", to: "2026-03-01" });
    expect(lastPeriod("2026-03-04", "month")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
  });
  it("warns about long hours and raises an alert", async () => {
    await h.admin.query("INSERT INTO shifts (org_id, driver_id, started_at) VALUES ($1,$2, now() - interval '5 hours 30 minutes')", [h.orgA, sam]);
    const f = await h.call("get", "/safety/fatigue", owner);
    expect(f.body.drivers[0]).toMatchObject({ name: "Sam Singh", level: "now" });
    expect((await h.call("get", "/safety/my-fatigue", samTok)).body).toMatchObject({ onShift: true, level: "now" });
    const p = await h.call("post", "/alerts/preview", owner, { kind: "fatigue", params: {} });
    expect(p.body.candidates?.[0]?.title ?? p.body[0]?.title ?? JSON.stringify(p.body)).toContain("Sam Singh");
    await h.call("put", "/org", owner, { settings: { safety: { fatigueWarnMin: 400, fatigueStopMin: 500 } } });
    expect((await h.call("get", "/safety/fatigue", owner)).body.drivers[0].level).toBe("ok");
    await h.call("put", "/org", owner, { settings: { safety: { fatigueWarnMin: 240, fatigueStopMin: 300 } } });
  });
  it("turns an SOS or a possible crash into a critical call for help the office sees at once", async () => {
    const sos = await h.call("post", "/driver/help", samTok, { kind: "sos", note: "panic button" });
    expect(sos.status).toBe(201);
    expect((await h.admin.query("SELECT severity FROM alerts WHERE kind = 'help_request'")).rows[0].severity).toBe("critical");
    const id = "11111111-1111-4111-8111-111111111111";
    const c1 = await h.call("post", "/safety/crash", samTok, { lat: 43.7, lng: -79.4, source: "phone", kmh: 70, clientId: id });
    expect(c1.status).toBe(200); expect(c1.body.duplicate).toBe(false);
    expect((await h.call("post", "/safety/crash", samTok, { lat: 43.7, lng: -79.4, clientId: id })).body.duplicate).toBe(true);
    expect((await h.admin.query("SELECT count(*)::int AS n FROM help_requests WHERE kind = 'crash'")).rows[0].n).toBe(1);
    expect((await h.admin.query("SELECT 1 FROM automation_events WHERE kind = 'help.requested'")).rowCount).toBe(2);
    expect((await h.call("post", "/safety/crash", viewer, {})).status).toBe(403);
    expect((await h.call("post", "/safety/crash", samTok, { lat: 999 })).status).toBe(400);
  });
  it("notices a GPS track that ends in a sudden stop", async () => {
    const dev = (await h.admin.query("INSERT INTO devices (org_id, vehicle_id, source, external_id) VALUES ($1,$2,'simulator','crash-1') RETURNING id", [h.orgA, veh])).rows[0].id;
    const t0 = Date.now() - 5 * 60_000;
    const rows: [number, number][] = [[0, 80], [2, 1], [20, 0], [40, 0], [70, 0]];
    for (const [s, sp] of rows) await h.admin.query("INSERT INTO positions (time, org_id, device_id, lat, lng, speed, ignition) VALUES ($1,$2,$3,43.7,-79.4,$4,true)", [new Date(t0 + s * 1000), h.orgA, dev, sp]);
    const c = await h.app.connect();
    try {
      await c.query("BEGIN"); await c.query("SELECT set_config('app.org_id',$1,true)", [h.orgA]);
      const out = await EVALUATORS.crash.run(c, {}, { orgId: h.orgA, today, svc: undefined as never, now: new Date() });
      await c.query("COMMIT");
      expect(out).toHaveLength(1);
      expect(out[0]!.title).toContain("80 km/h");
    } finally { c.release(); }
  });
  it("runs lone-worker check-ins: start, say OK, miss one, end", async () => {
    const s = await h.call("post", "/safety/checkins/start", samTok, { everyMin: 15, note: "alone at depot" });
    expect(s.status).toBe(200);
    expect((await h.call("post", "/safety/checkins/start", samTok, { everyMin: 1 })).status).toBe(400);
    expect((await h.call("get", "/safety/checkins/mine", samTok)).body.active).toMatchObject({ everyMin: 15 });
    expect((await h.call("get", "/safety/checkins", viewer)).body.active[0]).toMatchObject({ name: "Sam Singh", missed: false });
    await h.admin.query("UPDATE checkins SET last_ok_at = now() - interval '40 minutes'");
    expect((await h.call("get", "/safety/checkins", owner)).body.active[0].missed).toBe(true);
    const p = await h.call("post", "/alerts/preview", owner, { kind: "checkin_missed", params: {} });
    expect(JSON.stringify(p.body)).toContain("missed a safety check-in");
    expect((await h.call("post", "/safety/checkins/ok", samTok, {})).status).toBe(200);
    expect((await h.call("get", "/safety/checkins", owner)).body.active[0].missed).toBe(false);
    await h.call("post", "/safety/checkins/end", samTok);
    expect((await h.call("get", "/safety/checkins/mine", samTok)).body.active).toBeNull();
    expect((await h.call("post", "/safety/checkins/ok", samTok, {})).status).toBe(404);
  });
});

describe("auto-assign uses areas, pairs and days off", () => {
  it("keeps each driver to their own area, pairs a pickup with its delivery, and skips a driver who is off", async () => {
    await h.admin.query("DELETE FROM territories; DELETE FROM driver_profiles");
    const west = [[43.5, -80.2], [43.5, -79.8], [43.9, -79.8], [43.9, -80.2]], east = [[43.5, -79.2], [43.5, -78.8], [43.9, -78.8], [43.9, -79.2]];
    await h.call("post", "/optimize/territories", owner, { name: "West", polygon: west, driverId: sam });
    await h.call("post", "/optimize/territories", owner, { name: "East", polygon: east, driverId: alex });
    const w = await job({ title: "West job", lat: 43.7, lng: -80.0 }), e = await job({ title: "East job", lat: 43.7, lng: -79.0 });
    const r = await h.call("post", "/jobs/auto-assign", owner, { date: today, apply: true });
    expect(r.status).toBe(201);
    const who = Object.fromEntries(r.body.proposals.map((p: { jobId: string; driverId: string }) => [p.jobId, p.driverId]));
    expect(who[w]).toBe(sam); expect(who[e]).toBe(alex);

    await reset(); await h.admin.query("DELETE FROM territories");
    await h.admin.query("INSERT INTO driver_profiles (user_id, org_id, preferences) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET preferences = $3", [sam, h.orgA, JSON.stringify({ daysOff: [today] })]);
    const pick = await job({ title: "Pick", type: "pickup", lat: 43.7, lng: -79.4 }), drop = await job({ title: "Drop", lat: 43.75, lng: -79.4 });
    await h.admin.query("UPDATE jobs SET parent_job_id = $1 WHERE id = $2", [pick, drop]);
    const r2 = await h.call("post", "/jobs/auto-assign", owner, { date: today });
    const ps = r2.body.proposals as { jobId: string; driverId: string; position: number }[];
    expect(ps.every((p) => p.driverId === alex)).toBe(true);
    expect(ps.find((p) => p.jobId === pick)!.position).toBeLessThan(ps.find((p) => p.jobId === drop)!.position);
  });
});
