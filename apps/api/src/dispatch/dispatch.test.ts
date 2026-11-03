import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";
import { NominatimGeocoder } from "./geocoder.js";
import { runScheduledTasks } from "./scheduler.js";

let h: Harness;
let owner: string;
let viewer: string;
let d1: string, d2: string;
let d1Token: string;
const DAY = "2026-07-02";

beforeAll(async () => {
  const geocoder = new NominatimGeocoder("http://geo", "t", async (url) => {
    const q = new URL(url).searchParams.get("q") ?? "";
    return new Response(JSON.stringify(q.includes("Nowhere") ? [] : [{ display_name: `${q}, Canada`, lat: "43.70", lon: "-79.40" }]));
  });
  h = await startHarness({ geocoder });
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer");
  viewer = await h.token("view@example.com");
  d1 = await h.addUser(h.orgA, "d1@example.com", "driver", { display_name: "Dana" });
  d2 = await h.addUser(h.orgA, "d2@example.com", "driver", { display_name: "Eli" });
  d1Token = await h.token("d1@example.com");
}, 60_000);
afterAll(async () => { await h.close(); });

const mkJob = async (o: Record<string, unknown> = {}) =>
  (await h.call("post", "/r/jobs", owner, { title: "Job", lat: 43.7, lng: -79.4, scheduledDate: DAY, ...o })).body.id as string;
const getJob = async (id: string) => (await h.call("get", `/jobs/${id}`, owner)).body;

describe("job flow", () => {
  it("assigns, reassigns live, and tracks status through the stop", async () => {
    const id = await mkJob({ title: "Parcel 1", type: "delivery" });
    const a = await h.call("post", `/jobs/${id}/assign`, owner, { driverId: d1 });
    expect(a.status).toBe(201);
    expect((await getJob(id)).job).toMatchObject({ status: "assigned", driver_id: d1 });
    // reassign to another driver: the stop moves routes
    const b = await h.call("post", `/jobs/${id}/assign`, owner, { driverId: d2 });
    expect(b.body.driverId).toBe(d2);
    const board = await h.call("get", `/jobs/board?date=${DAY}`, owner);
    const lanes = board.body.routes.filter((r: { stops: unknown[] }) => r.stops.length);
    expect(lanes).toHaveLength(1);
    expect(lanes[0].driverId).toBe(d2);
    // the driver finishes the stop in the driver app: the job follows
    const dTok = await h.token("d2@example.com");
    const route = lanes[0];
    const done = await h.call("post", `/driver/stops/${route.stops[0].id}/status`, dTok, { status: "done" });
    expect(done.status).toBe(201);
    const after = await getJob(id);
    expect(after.job.status).toBe("done");
    expect(after.events.map((e: { kind: string }) => e.kind)).toEqual(expect.arrayContaining(["assigned", "status"]));
    // finished work cannot be reassigned
    expect((await h.call("post", `/jobs/${id}/assign`, owner, { driverId: d1 })).status).toBe(409);
  });

  it("follows the allowed status flow with reasons", async () => {
    const id = await mkJob({ title: "Flow" });
    expect((await h.call("post", `/jobs/${id}/status`, owner, { status: "done" })).status).toBe(409);
    await h.call("post", `/jobs/${id}/assign`, owner, { driverId: d1 });
    expect((await h.call("post", `/jobs/${id}/status`, owner, { status: "started" })).body.status).toBe("started");
    expect((await h.call("post", `/jobs/${id}/status`, owner, { status: "failed" })).status).toBe(400);
    const failed = await h.call("post", `/jobs/${id}/status`, owner, { status: "failed", reasonCode: "not_home", note: "Door locked" });
    expect(failed.body).toMatchObject({ status: "failed", reason_code: "not_home" });
  });

  it("cancels and reschedules with reason codes", async () => {
    const id = await mkJob({ title: "Cancel me" });
    await h.call("post", `/jobs/${id}/assign`, owner, { driverId: d1 });
    expect((await h.call("post", `/jobs/${id}/cancel`, owner, { reasonCode: "bogus" })).status).toBe(400);
    const c = await h.call("post", `/jobs/${id}/cancel`, owner, { reasonCode: "customer_cancelled" });
    expect(c.body.status).toBe("cancelled");
    expect(c.body.stop_id).toBeNull();

    const id2 = await mkJob({ title: "Move me" });
    await h.call("post", `/jobs/${id2}/assign`, owner, { driverId: d1 });
    const r = await h.call("post", `/jobs/${id2}/reschedule`, owner, { date: "2026-07-03", reasonCode: "customer_request" });
    expect(r.body).toMatchObject({ status: "unassigned", scheduled_date: "2026-07-03" });
    expect((await getJob(id2)).events.map((e: { kind: string }) => e.kind)).toContain("rescheduled");
  });

  it("only dispatchers can dispatch", async () => {
    const id = await mkJob({ title: "Perm" });
    expect((await h.call("post", `/jobs/${id}/assign`, viewer, { driverId: d1 })).status).toBe(403);
    expect((await h.call("get", `/jobs/board?date=${DAY}`, viewer)).status).toBe(200);
  });
});

describe("auto-assign and urgent jobs", () => {
  it("proposes drivers by location and applies the plan", async () => {
    const north = [0, 1].map((i) => ({ title: `N${i}`, lat: 43.9 + i * 0.01, lng: -79.4, scheduledDate: "2026-07-05" }));
    const south = [0, 1].map((i) => ({ title: `S${i}`, lat: 43.4 - i * 0.01, lng: -79.4, scheduledDate: "2026-07-05" }));
    const ids = [];
    for (const j of [...north, ...south]) ids.push(await mkJob(j));
    const dry = await h.call("post", "/jobs/auto-assign", owner, { date: "2026-07-05", jobIds: ids });
    expect(dry.body.proposals).toHaveLength(4);
    expect(dry.body.applied).toBe(false);
    const byDriver = new Map<string, number>();
    for (const p of dry.body.proposals) byDriver.set(p.driverId, (byDriver.get(p.driverId) ?? 0) + 1);
    expect([...byDriver.values()].sort()).toEqual([2, 2]);
    const applied = await h.call("post", "/jobs/auto-assign", owner, { date: "2026-07-05", jobIds: ids, apply: true });
    expect(applied.body.applied).toBe(true);
    for (const id of ids) expect((await getJob(id)).job.status).toBe("assigned");
  });

  it("slots an urgent job into the best route and reports the effect", async () => {
    const a = await mkJob({ title: "A", lat: 43.7, lng: -79.4, scheduledDate: "2026-07-06" });
    const b = await mkJob({ title: "B", lat: 43.75, lng: -79.4, scheduledDate: "2026-07-06" });
    await h.call("post", `/jobs/${a}/assign`, owner, { driverId: d1 });
    await h.call("post", `/jobs/${b}/assign`, owner, { driverId: d1 });
    const u = await mkJob({ title: "Rush", lat: 43.72, lng: -79.4, scheduledDate: "2026-07-06" });
    const r = await h.call("post", `/jobs/${u}/urgent`, owner, {});
    expect(r.status).toBe(201);
    expect(r.body.driverId).toBe(d1);
    expect(r.body.sequence).toBe(2); // between A and B
    expect((await getJob(u)).job.priority).toBe("urgent");
  });
});

describe("import, attachments, scans", () => {
  it("imports jobs from CSV, geocoding missing coordinates", async () => {
    const csv = "title,address,type,priority,tags,scheduled_date\nBox,123 Main St Toronto ON,pickup,high,fragile;cold,2026-07-07\nFar,1 Nowhere Rd,delivery,normal,,2026-07-07\n,no title,delivery,,,\nBad,2 X St,teleport,,,";
    const r = await h.call("post", "/jobs/import", owner, { csv });
    expect(r.body.created).toBe(2);
    expect(r.body.needLocation).toEqual([3]);
    expect(r.body.errors.map((e: { row: number }) => e.row)).toEqual([4, 5]);
    const list = await h.call("get", "/r/jobs?q=Box", owner);
    expect(list.body[0]).toMatchObject({ lat: 43.7, tags: ["fragile", "cold"], priority: "high" });
  });

  it("stores and serves attachments, rejecting mismatched files", async () => {
    const id = await mkJob({ title: "With files" });
    const pdf = Buffer.from("%PDF-1.4 test");
    const up = await h.call("put", `/jobs/${id}/attachments?name=slip.pdf`, owner).set("Content-Type", "application/pdf").send(pdf);
    expect(up.status).toBe(200);
    const bad = await h.call("put", `/jobs/${id}/attachments?name=x.pdf`, owner).set("Content-Type", "application/pdf").send(Buffer.from("not a pdf"));
    expect(bad.status).toBe(400);
    const got = await h.call("get", `/attachments/${up.body.id}`, owner);
    expect(got.status).toBe(200);
    expect(got.headers["content-type"]).toContain("application/pdf");
    expect((await getJob(id)).attachments).toHaveLength(1);
    expect((await h.call("delete", `/attachments/${up.body.id}`, owner)).status).toBe(204);
  });

  it("records barcode scans at a stop, once per clientId", async () => {
    const id = await mkJob({ title: "Scan", scheduledDate: "2026-07-08" });
    await h.call("post", `/jobs/${id}/assign`, owner, { driverId: d1 });
    const stopId = (await getJob(id)).job.stop_id as string;
    const cid = "11111111-1111-4111-8111-111111111111";
    const one = await h.call("post", `/driver/stops/${stopId}/scans`, d1Token, { code: "PKG-123", clientId: cid });
    const two = await h.call("post", `/driver/stops/${stopId}/scans`, d1Token, { code: "PKG-123", clientId: cid });
    expect(one.body.duplicate).toBe(false);
    expect(two.body.duplicate).toBe(true);
    expect((await h.call("get", `/stops/${stopId}/scans`, owner)).body).toHaveLength(1);
    // another driver cannot scan at this stop
    const other = await h.token("d2@example.com");
    expect((await h.call("post", `/driver/stops/${stopId}/scans`, other, { code: "X" })).status).toBe(404);
  });
});

describe("geocoding", () => {
  it("suggests fixes and finds coordinates", async () => {
    const r = await h.call("get", "/geocode?q=" + encodeURIComponent("123 MAIN STREET TORONTO ONTARIO m5v2t6"), owner);
    expect(r.body.check.postalCode).toBe("M5V 2T6");
    expect(r.body.results.some((x: { source: string }) => x.source === "geocoder")).toBe(true);
    const batch = await h.call("post", "/geocode/batch", owner, { addresses: ["1 Nowhere Rd", "5 Real St Toronto ON"] });
    expect(batch.body.map((b: { found: boolean }) => b.found)).toEqual([false, true]);
    expect((await h.call("get", "/geocode?q=ab", owner)).body.results).toEqual([]);
  });
});

describe("templates, recurring routes, split and merge", () => {
  it("builds a route from a template on matching days only, once", async () => {
    const route = await h.call("post", "/routes", owner, { name: "Weekly milk run", date: "2026-07-13", stops: [
      { name: "Dairy", lat: 43.7, lng: -79.4, windowStart: "2026-07-13T13:00:00Z", windowEnd: "2026-07-13T15:00:00Z" }, { name: "Cafe", lat: 43.71, lng: -79.41 }] });
    const tpl = await h.call("post", `/route-templates/from-route/${route.body.id}`, owner, { recurrence: { every: "week", days: [1], from: "2026-07-06" } });
    expect(tpl.status).toBe(201);
    const next = await h.call("get", `/route-templates/${tpl.body.id}/upcoming?after=2026-07-06`, owner);
    expect(next.body.dates.slice(0, 3)).toEqual(["2026-07-06", "2026-07-13", "2026-07-20"]);
    const tue = await h.call("post", "/route-templates/run", owner, { date: "2026-07-14" });
    expect(tue.body.created).toHaveLength(0);
    const mon = await h.call("post", "/route-templates/run", owner, { date: "2026-07-20" });
    expect(mon.body.created).toHaveLength(1);
    expect((await h.call("post", "/route-templates/run", owner, { date: "2026-07-20" })).body.created).toHaveLength(0);
    const made = await h.call("get", `/routes/${mon.body.created[0].routeId}`, owner);
    expect(made.body.stops).toHaveLength(2);
    // time-of-day windows follow the new date (08:00 Toronto in July = 12:00Z... window 09:00 local = 13:00Z)
    expect(new Date(made.body.stops[0].windowStart).toISOString()).toBe("2026-07-20T13:00:00.000Z");
    // the background job does the same for every organization
    expect(await runScheduledTasks(h.app)).toBeGreaterThanOrEqual(0);
    // generate on demand
    const gen = await h.call("post", `/route-templates/${tpl.body.id}/generate`, owner, { date: "2026-08-01" });
    expect(gen.status).toBe(201);
  });

  it("splits a route in two and merges it back", async () => {
    const r = await h.call("post", "/routes", owner, { name: "Big", date: "2026-07-09", stops: ["a", "b", "c", "d"].map((n, i) => ({ name: n, lat: 43.7 + i * 0.01, lng: -79.4 })) });
    const stops = r.body.stops as { id: string }[];
    const split = await h.call("post", `/dispatch/routes/${r.body.id}/split`, owner, { stopIds: [stops[2]!.id, stops[3]!.id], driverId: d2 });
    expect(split.body.moved).toBe(2);
    const second = await h.call("get", `/routes/${split.body.created}`, owner);
    expect(second.body.stops.map((s: { name: string; sequence: number }) => [s.name, s.sequence])).toEqual([["c", 1], ["d", 2]]);
    expect((await h.call("get", `/routes/${r.body.id}`, owner)).body.stops).toHaveLength(2);
    expect((await h.call("post", `/dispatch/routes/${r.body.id}/split`, owner, { stopIds: [stops[0]!.id, stops[1]!.id] })).status).toBe(400);
    const merged = await h.call("post", `/dispatch/routes/${r.body.id}/merge`, owner, { fromId: split.body.created });
    expect(merged.body.merged).toBe(2);
    const whole = await h.call("get", `/routes/${r.body.id}`, owner);
    expect(whole.body.stops.map((s: { name: string }) => s.name)).toEqual(["a", "b", "c", "d"]);
    expect((await h.call("get", `/routes/${split.body.created}`, owner)).status).toBe(404);
  });
});
