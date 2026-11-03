import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";
import type { Providers } from "../notify/notifier.js";
import { AnalyticsService } from "../analytics/analytics.service.js";
import { runDueReports } from "../reports/scheduler.js";
import { evaluateOrg, sendDigest } from "./engine.js";

let h: Harness, owner: string, viewer: string, orgBadmin: string;
let veh: string, dev: string, drv: string;
const sent: { url: string; body: string }[] = [];
const stub: Providers = { fetch: (async (url: string, init: RequestInit) => { sent.push({ url: String(url), body: String(init.body) }); return new Response("ok"); }) as typeof fetch, email: null, sms: null };
const SLACK = "https://hooks.slack.com/services/T0/B0/abc";
let endpoint: string;

const rule = async (body: Record<string, unknown>) => { const r = await h.call("post", "/r/alert-rules", owner, { severity: "warn", endpointIds: [endpoint], ...body }); expect(r.status).toBe(201); return r.body.id as string; };
const tick = (now = new Date()) => evaluateOrg(h.app, h.nest.get(AnalyticsService), stub, h.orgA, now);
const fix = (agoSec: number, speed: number, lat = 43.7, ignition = true) => h.admin.query("INSERT INTO positions (time, org_id, device_id, lat, lng, speed, ignition) VALUES (now() - make_interval(secs => $1), $2, $3, $4, -79.4, $5, $6)", [agoSec, h.orgA, dev, lat, speed, ignition]);
const reset = async () => { await h.admin.query("DELETE FROM alerts; DELETE FROM alert_rules; DELETE FROM positions; DELETE FROM latest_positions"); sent.length = 0; };

beforeAll(async () => {
  h = await startHarness({ notify: stub });
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer");
  viewer = await h.token("view@example.com");
  drv = await h.addUser(h.orgA, "ann@example.com", "driver", { display_name: "Ann" });
  await h.addUser(h.orgB, "adminb@example.com", "admin");
  orgBadmin = await h.token("adminb@example.com");
  veh = (await h.call("post", "/r/vehicles", owner, { name: "Truck A", capacityKg: 1000 })).body.id;
  dev = (await h.admin.query("INSERT INTO devices (org_id, vehicle_id, source, external_id) VALUES ($1,$2,'simulator','a-1') RETURNING id", [h.orgA, veh])).rows[0].id;
  endpoint = (await h.call("post", "/r/notification-endpoints", owner, { kind: "slack", target: SLACK, label: "Ops" })).body.id;
}, 90_000);
afterAll(async () => { await h.close(); });

describe("rules", () => {
  it("long idle raises one alert, groups repeats, and resolves when the vehicle moves", async () => {
    await reset();
    const id = await rule({ name: "Idle", kind: "long_idle", params: { minutes: 10 }, groupMinutes: 60 });
    for (let s = 14 * 60; s >= 0; s -= 60) await fix(s, 0);
    const a = await tick();
    expect(a).toMatchObject({ raised: 1, sent: 1 });
    expect(JSON.parse(sent[0]!.body).text).toContain("Truck A");
    const b = await tick();
    expect(b).toMatchObject({ raised: 0, bumped: 1, sent: 0 }); // same problem, inside the grouping window
    const list = (await h.call("get", "/alerts?status=open", owner)).body;
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ kind: "long_idle", count: 2, rule: "Idle" });
    await fix(0, 50);
    expect(await tick()).toMatchObject({ resolved: 1 });
    expect((await h.call("get", "/alerts/summary", owner)).body.open).toBe(0);
    void id;
  });

  it("speeding, offline and geofence rules", async () => {
    await reset();
    await rule({ name: "Fast", kind: "speeding", params: { kmh: 100, fixes: 2 } });
    await rule({ name: "Gone", kind: "offline", params: { minutes: 30 } });
    await fix(60, 130); await fix(30, 135);
    expect((await tick()).raised).toBe(1);
    // the vehicle last reported an hour ago
    await h.admin.query("DELETE FROM positions; DELETE FROM latest_positions");
    await h.admin.query("INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed) VALUES ($1,$2, now() - interval '2 hours', 43.7, -79.4, 0)", [dev, h.orgA]);
    const r = await tick();
    expect(r.raised).toBe(1);
    expect(r.resolved).toBe(1); // the speeding alert has gone
    const gf = (await h.admin.query("INSERT INTO geofences (org_id, name, lat, lng, radius_m) VALUES ($1,'Yard',43.7,-79.4,200) RETURNING id", [h.orgA])).rows[0].id;
    await h.admin.query("INSERT INTO geofence_events (org_id, geofence_id, device_id, kind, at) VALUES ($1,$2,$3,'enter', now())", [h.orgA, gf, dev]);
    await rule({ name: "Yard", kind: "geofence", params: { event: "enter" } });
    expect((await tick()).raised).toBe(1);
    expect((await tick()).raised).toBe(0); // the same event never alerts twice
  });

  it("late risk, off route and document expiry", async () => {
    await reset();
    const route = (await h.admin.query("INSERT INTO routes (org_id, name, route_date, vehicle_id, driver_id, status) VALUES ($1,'R1',current_date,$2,$3,'in_progress') RETURNING id", [h.orgA, veh, drv])).rows[0].id;
    await h.admin.query("INSERT INTO stops (org_id, route_id, sequence, name, lat, lng, window_end, status) VALUES ($1,$2,1,'Dock',43.70,-79.40, now() + interval '5 minutes','pending'), ($1,$2,2,'Far',43.72,-79.40, now() + interval '5 hours','pending')", [h.orgA, route]);
    await h.admin.query("INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed) VALUES ($1,$2, now(), 43.80, -79.40, 40)", [dev, h.orgA]);
    await h.admin.query("INSERT INTO documents (org_id, owner_kind, owner_id, kind, expires_on) VALUES ($1,'vehicle',$2,'Insurance', current_date + 3)", [h.orgA, veh]);
    await rule({ name: "Late", kind: "late_risk", params: { minutes: 15 } });
    await rule({ name: "Lost", kind: "off_route", params: { meters: 2000 } });
    await rule({ name: "Docs", kind: "document_expiry", params: { days: 14 } });
    const r = await tick();
    expect(r.raised).toBe(3);
    const titles = (await h.call("get", "/alerts?status=open", owner)).body.map((a: { title: string }) => a.title).join("|");
    expect(titles).toContain("Dock may miss");
    expect(titles).toContain("off its route");
    expect(titles).toMatch(/Insurance expires in [34] day/);
  });

  it("custom metric and maintenance rules", async () => {
    await reset();
    await h.admin.query("INSERT INTO maintenance_plans (org_id, vehicle_id, task, every_days, last_done_on) VALUES ($1,$2,'Oil change',30, current_date - 40)", [h.orgA, veh]);
    await rule({ name: "Service", kind: "maintenance_due" });
    await rule({ name: "Stops", kind: "custom_metric", params: { metric: "failedStops", op: "gte", value: 1, period: "today" } });
    const r = await tick();
    expect(r.raised).toBe(1); // no failed stops today yet
    const prev = (await h.call("post", "/alerts/preview", owner, { kind: "maintenance_due", params: {} })).body;
    expect(prev.count).toBe(1);
  });

  it("holds alerts during quiet hours and sends them in the morning summary; critical alerts still go out", async () => {
    await reset();
    const allDay = { quietStart: "00:00", quietEnd: "23:59" };
    await rule({ name: "Idle quiet", kind: "long_idle", params: { minutes: 10 }, ...allDay });
    for (let s = 14 * 60; s >= 0; s -= 60) await fix(s, 0);
    expect(await tick()).toMatchObject({ raised: 1, sent: 0 });
    expect(sent).toHaveLength(0);
    const d = await sendDigest(h.app, stub, h.orgA);
    expect(d).toMatchObject({ alerts: 1, sent: 1 });
    expect(JSON.parse(sent[0]!.body).text).toContain("Daily alert summary");
    expect((await sendDigest(h.app, stub, h.orgA)).alerts).toBe(0);
    await reset();
    await rule({ name: "Idle crit", kind: "long_idle", params: { minutes: 10 }, severity: "critical", ...allDay });
    for (let s = 14 * 60; s >= 0; s -= 60) await fix(s, 0);
    expect(await tick()).toMatchObject({ raised: 1, sent: 1 });
  });

  it("does not stop on a failing destination", async () => {
    await reset();
    const bad: Providers = { fetch: (async () => new Response("no", { status: 500 })) as typeof fetch };
    await rule({ name: "Idle", kind: "long_idle", params: { minutes: 10 } });
    for (let s = 14 * 60; s >= 0; s -= 60) await fix(s, 0);
    const r = await evaluateOrg(h.app, h.nest.get(AnalyticsService), bad, h.orgA);
    expect(r).toMatchObject({ raised: 1, sent: 0, failed: 1 });
  });
});

describe("inbox", () => {
  it("acknowledges, resolves, and keeps organizations apart", async () => {
    await reset();
    await rule({ name: "Idle", kind: "long_idle", params: { minutes: 10 } });
    for (let s = 14 * 60; s >= 0; s -= 60) await fix(s, 0);
    await tick();
    const [a] = (await h.call("get", "/alerts?status=open", owner)).body;
    expect((await h.call("post", `/alerts/${a.id}/acknowledge`, viewer)).status).toBe(200);
    expect((await h.call("post", `/alerts/${a.id}/acknowledge`, owner)).status).toBe(404); // already acknowledged
    expect((await h.call("get", "/alerts?status=active", owner)).body).toHaveLength(1);
    expect((await tick()).raised).toBe(0); // an acknowledged alert is not raised again while the problem lasts
    expect((await h.call("post", `/alerts/${a.id}/resolve`, owner)).status).toBe(200);
    expect((await h.call("get", "/alerts", orgBadmin)).body).toHaveLength(0);
    expect((await h.call("post", `/alerts/${a.id}/resolve`, orgBadmin)).status).toBe(404);
    expect((await h.call("get", "/alerts?status=bogus", owner)).status).toBe(400);
    expect((await h.call("post", "/alerts/evaluate", viewer)).status).toBe(403);
    expect((await h.call("post", "/alerts/preview", owner, { kind: "nope" })).status).toBe(400);
    expect((await h.call("post", "/r/alert-rules", viewer, { name: "x", kind: "offline" })).status).toBe(403);
  });
});

describe("destinations", () => {
  it("sends a test message", async () => {
    sent.length = 0;
    expect((await h.call("post", `/alerts/endpoints/${endpoint}/test`, owner)).body).toEqual({ ok: true });
    expect(sent).toHaveLength(1);
    expect((await h.call("post", `/alerts/endpoints/${endpoint}/test`, viewer)).status).toBe(403);
    expect((await h.call("post", `/alerts/endpoints/${endpoint}/test`, orgBadmin)).status).toBe(404);
  });
});

describe("scheduled reports", () => {
  it("sends a report once a day at its hour in the organization's time zone", async () => {
    await reset();
    await h.admin.query("UPDATE organizations SET timezone = 'America/Toronto' WHERE id = $1", [h.orgA]);
    const def = (await h.call("post", "/reports/saved", owner, { name: "Daily", spec: { dataset: "stops", range: { preset: "last7" } } })).body.id;
    const sch = await h.call("post", "/r/report-schedules", owner, { reportId: def, freq: "daily", hour: 7, format: "csv", endpointIds: [endpoint] });
    expect(sch.status).toBe(201);
    const svc = h.nest.get(AnalyticsService);
    const at = (iso: string) => new Date(iso);
    expect(await runDueReports(h.app, svc, stub, undefined, at("2026-03-10T10:00:00Z"))).toBe(0); // 06:00 in Toronto: too early
    expect(await runDueReports(h.app, svc, stub, undefined, at("2026-03-10T11:30:00Z"))).toBe(1); // 07:30
    expect(await runDueReports(h.app, svc, stub, undefined, at("2026-03-10T15:00:00Z"))).toBe(0); // already sent today
    expect(await runDueReports(h.app, svc, stub, undefined, at("2026-03-11T11:30:00Z"))).toBe(1); // next day
    expect(sent.filter((s) => s.url === SLACK)).toHaveLength(2);
    expect((await h.admin.query("SELECT last_status FROM report_schedules WHERE id = $1", [sch.body.id])).rows[0].last_status).toBe("ok");
  });
  it("only runs weekly schedules on their weekday", async () => {
    await h.admin.query("DELETE FROM report_schedules");
    sent.length = 0;
    const def = (await h.admin.query("SELECT id FROM report_defs LIMIT 1")).rows[0].id;
    await h.call("post", "/r/report-schedules", owner, { reportId: def, freq: "weekly", weekday: 3, hour: 7, endpointIds: [endpoint] }); // Wednesday
    const svc = h.nest.get(AnalyticsService);
    expect(await runDueReports(h.app, svc, stub, undefined, new Date("2026-03-10T12:00:00Z"))).toBe(0); // Tuesday
    expect(await runDueReports(h.app, svc, stub, undefined, new Date("2026-03-11T12:00:00Z"))).toBe(1);
  });
});

describe("customer feedback", () => {
  it("takes a rating from the tracking page and attributes it to the driver", async () => {
    const route = (await h.admin.query("INSERT INTO routes (org_id, name, route_date, vehicle_id, driver_id, status) VALUES ($1,'FB',current_date,$2,$3,'in_progress') RETURNING id", [h.orgA, veh, drv])).rows[0].id;
    const link = await h.call("post", "/share", owner, { routeId: route, hours: 2 });
    expect(link.status).toBe(201);
    const token = link.body.token as string;
    const ok = await h.call("post", `/public/track/${token}/feedback`, undefined, { csat: 5, nps: 9, comment: "Great driver" });
    expect(ok.status).toBe(201);
    const row = (await h.admin.query("SELECT csat, nps, driver_id, route_id, source FROM feedback WHERE comment = 'Great driver'")).rows[0];
    expect(row).toMatchObject({ csat: 5, nps: 9, driver_id: drv, route_id: route, source: "link" });
    expect((await h.call("post", `/public/track/${token}/feedback`, undefined, { csat: 9 })).status).toBe(400);
    expect((await h.call("post", `/public/track/${token}/feedback`, undefined, {})).status).toBe(400);
    expect((await h.call("post", "/public/track/not-a-real-token-aaaaaaaaaaaaaa/feedback", undefined, { csat: 3 })).status).toBe(404);
  });
  it("lets the office enter feedback", async () => {
    expect((await h.call("post", "/r/feedback", owner, { csat: 4, driverId: drv, source: "office" })).status).toBe(201);
    expect((await h.call("post", "/r/feedback", owner, { comment: "x" })).status).toBe(400);
  });
});
