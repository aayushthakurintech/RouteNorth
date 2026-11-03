import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";
import { AnalyticsService } from "../analytics/analytics.service.js";
import { evaluateOrg } from "../alerts/engine.js";
import type { Providers } from "../notify/notifier.js";
import { minutesSinceBreak, workedMinutes } from "./shifts.js";

let h: Harness, owner: string, viewer: string, ann: string, annTok: string, bobTok: string, veh: string;
const sent: string[] = [];
const stub: Providers = { fetch: (async (_u: string, init: RequestInit) => { sent.push(String(init.body)); return new Response("ok"); }) as typeof fetch, email: null, sms: null };
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();
const reset = async () => { await h.admin.query("DELETE FROM approvals; DELETE FROM shift_breaks; DELETE FROM shifts; DELETE FROM expenses; DELETE FROM fuel_logs; DELETE FROM messages; DELETE FROM help_requests; DELETE FROM alerts; DELETE FROM alert_rules; DELETE FROM jobs; DELETE FROM routes"); sent.length = 0; };

beforeAll(async () => {
  h = await startHarness({ notify: stub });
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer"); viewer = await h.token("view@example.com");
  ann = await h.addUser(h.orgA, "ann@example.com", "driver", { display_name: "Ann Lee" }); annTok = await h.token("ann@example.com");
  await h.addUser(h.orgA, "bob@example.com", "driver", { display_name: "Bob" }); bobTok = await h.token("bob@example.com");
  veh = (await h.call("post", "/r/vehicles", owner, { name: "Truck A" })).body.id;
}, 90_000);
afterAll(async () => { await h.close(); });

describe("shift maths", () => {
  const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 8, m));
  it("subtracts breaks from worked time and counts time since the last break", () => {
    const s = { startedAt: t(0), endedAt: t(480), breaks: [{ startedAt: t(240), endedAt: t(270) }] };
    expect(workedMinutes(s)).toBe(450);
    expect(minutesSinceBreak({ startedAt: t(0), breaks: [{ startedAt: t(240), endedAt: t(270) }] }, t(330))).toBe(60);
    expect(minutesSinceBreak({ startedAt: t(0), breaks: [{ startedAt: t(240), endedAt: null }] }, t(330))).toBe(0);
    expect(minutesSinceBreak({ startedAt: t(0), breaks: [] }, t(310))).toBe(310);
  });
});

describe("chat", () => {
  it("passes messages both ways, stores a retried message once, and counts unread", async () => {
    await reset();
    const clientId = randomUUID();
    expect((await h.call("post", "/driver/messages", annTok, { body: "Running 10 minutes late", quickKey: "late_10", clientId })).body.duplicate).toBe(false);
    expect((await h.call("post", "/driver/messages", annTok, { body: "Running 10 minutes late", quickKey: "late_10", clientId })).body.duplicate).toBe(true);
    expect((await h.call("post", "/driver/messages", annTok, { body: "" })).status).toBe(400);
    expect((await h.call("post", "/driver/messages", annTok, { audioDataUrl: "data:text/html;base64,AAAA" })).status).toBe(400);
    expect((await h.call("post", "/driver/messages", annTok, { audioDataUrl: "data:audio/webm;codecs=opus;base64,GkXfowEAAAAA" })).status).toBe(201);
    const threads = (await h.call("get", "/messages/threads?kind=driver", owner)).body;
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({ id: ann, name: "Ann Lee", unread: 2 });
    expect((await h.call("get", "/messages/threads", viewer)).status).toBe(403);
    const msgs = (await h.call("get", `/messages/thread/driver/${ann}`, owner)).body;
    expect(msgs).toHaveLength(2);
    expect(msgs[1].audio).toMatch(/^data:audio\/webm/);
    expect((await h.call("post", `/messages/thread/driver/${ann}`, owner, { body: "OK, thanks" })).status).toBe(201);
    const u = (await h.call("get", "/driver/updates?since=" + encodeURIComponent(ago(1)), annTok)).body;
    expect(u).toMatchObject({ messages: 1, unread: 1, latest: "OK, thanks" });
    expect((await h.call("get", "/driver/messages", annTok)).body.map((m: { from: string }) => m.from)).toEqual(["driver", "driver", "dispatch"]);
    expect((await h.call("get", "/driver/updates", annTok)).body.unread).toBe(0);
    // another driver sees none of it
    expect((await h.call("get", "/driver/messages", bobTok)).body).toEqual([]);
    expect((await h.call("post", "/messages/broadcast", owner, { body: "Snow today, drive safe" })).body.sent).toBe(2);
    expect((await h.call("get", "/driver/messages", bobTok)).body.at(-1).body).toBe("Snow today, drive safe");
  });
});

describe("help requests", () => {
  it("raises an alert, tells the driver when someone is on it, and closes", async () => {
    await reset();
    const clientId = randomUUID();
    const r = await h.call("post", "/driver/help", annTok, { kind: "flat_tire", note: "Rear left", lat: 43.7, lng: -79.4, clientId });
    expect(r.status).toBe(201);
    expect((await h.call("post", "/driver/help", annTok, { kind: "flat_tire", clientId })).body.duplicate).toBe(true);
    expect((await h.call("post", "/driver/help", annTok, { kind: "ufo" })).status).toBe(400);
    expect((await h.call("post", "/driver/help", owner, { kind: "flat_tire" })).status).toBe(201); // an owner holds every permission, including driver.app
    const alerts = (await h.call("get", "/alerts?status=open", owner)).body;
    expect(alerts.some((a: { title: string; severity: string }) => a.title.includes("Ann Lee needs help: flat tire") && a.severity === "warn")).toBe(true);
    const list = (await h.call("get", "/help-requests?status=open", owner)).body;
    expect(list.find((x: { driver: string }) => x.driver === "Ann Lee")).toMatchObject({ kind: "flat_tire", note: "Rear left" });
    const id = list.find((x: { driver: string }) => x.driver === "Ann Lee").id;
    expect((await h.call("post", `/help-requests/${id}/acknowledge`, viewer)).status).toBe(403);
    expect((await h.call("post", `/help-requests/${id}/acknowledge`, owner)).status).toBe(200);
    expect((await h.call("post", `/help-requests/${id}/acknowledge`, owner)).status).toBe(404);
    expect((await h.call("post", `/help-requests/${id}/resolve`, owner, { resolution: "Tow truck sent" })).status).toBe(200);
    const msgs = (await h.call("get", "/driver/messages", annTok)).body.map((m: { body: string }) => m.body);
    expect(msgs[0]).toContain("HELP: flat tire");
    expect(msgs.some((m: string) => m.includes("on it"))).toBe(true);
    expect(msgs.some((m: string) => m.includes("Tow truck sent"))).toBe(true);
    const crit = await h.call("post", "/driver/help", bobTok, { kind: "accident" });
    expect(crit.status).toBe(201);
    expect((await h.call("get", "/alerts?status=open", owner)).body.some((a: { severity: string }) => a.severity === "critical")).toBe(true);
  });
});

describe("shifts and timesheets", () => {
  it("runs a shift with a break, flags overtime for approval, and totals the pay", async () => {
    await reset();
    await h.admin.query("INSERT INTO driver_profiles (user_id, org_id, hourly_rate) VALUES ($1,$2,20) ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20", [ann, h.orgA]);
    expect((await h.call("get", "/driver/shift", annTok)).body.active).toBe(false);
    expect((await h.call("post", "/driver/shift/break", annTok, { action: "start" })).status).toBe(409);
    expect((await h.call("post", "/driver/shift/start", annTok, { occurredAt: ago(10 * 60) })).body).toMatchObject({ active: true, onBreak: false });
    expect((await h.call("post", "/driver/shift/start", annTok, {})).status).toBe(201); // a second start changes nothing
    expect((await h.admin.query("SELECT count(*)::int AS n FROM shifts")).rows[0].n).toBe(1);
    expect((await h.call("post", "/driver/shift/break", annTok, { action: "start", kind: "lunch", occurredAt: ago(6 * 60) })).body).toMatchObject({ onBreak: true, breakKind: "lunch" });
    expect((await h.call("post", "/driver/shift/break", annTok, { action: "end", occurredAt: ago(5.5 * 60) })).body.onBreak).toBe(false);
    const end = await h.call("post", "/driver/shift/end", annTok, {});
    expect(end.status).toBe(201);
    expect(end.body.workedMin).toBeGreaterThan(9 * 60 + 25); // 10 hours minus a 30 minute break
    expect(end.body.workedMin).toBeLessThan(9 * 60 + 35);
    expect(end.body.overtimeMin).toBe(end.body.workedMin - 480);
    expect((await h.call("post", "/driver/shift/end", annTok, {})).status).toBe(409);
    const pend = (await h.call("get", "/approvals?status=pending", owner)).body;
    expect(pend).toHaveLength(1);
    expect(pend[0]).toMatchObject({ kind: "overtime" });
    const sheet = (await h.call("get", "/timesheets", owner)).body;
    const row = sheet.drivers.find((d: { name: string }) => d.name === "Ann Lee");
    expect(row).toMatchObject({ shifts: 1, pendingOvertimeMin: end.body.overtimeMin });
    const regularPay = (480 / 60) * 20;
    expect(row.pay).toBeCloseTo(regularPay, 0); // overtime is paid once a manager approves it
    await h.call("post", `/approvals/${pend[0].id}/decide`, owner, { decision: "approved" });
    expect((await h.call("get", "/timesheets", owner)).body.drivers.find((d: { name: string }) => d.name === "Ann Lee").pay).toBeCloseTo(regularPay + (end.body.overtimeMin / 60) * 30, 0);
    expect((await h.call("get", "/timesheets", annTok)).status).toBe(403);
    const mine = (await h.call("get", "/driver/shifts", annTok)).body;
    expect(mine).toHaveLength(1); expect(mine[0].overtimeStatus).toBe("approved");
    const csv = await h.call("get", "/timesheets/export.csv", owner);
    expect(csv.text.split("\n")[0]).toContain("Overtime status");
    expect(csv.text).toContain("Ann Lee");
  });

  it("lets a manager correct a shift, which re-works the overtime", async () => {
    await reset();
    const s = (await h.call("post", "/timesheets/shifts", owner, { driverId: ann, startedAt: ago(30 * 60), endedAt: ago(20 * 60), note: "forgot to clock" })).body;
    expect(s.overtimeMin).toBe(120);
    const list = (await h.call("get", "/timesheets", owner)).body.shifts;
    expect(list[0]).toMatchObject({ source: "edited", overtimeStatus: "pending" });
    const fixed = await h.call("patch", `/timesheets/shifts/${s.id}`, owner, { endedAt: ago(22 * 60) });
    expect(fixed.body.overtimeMin).toBe(0);
    expect((await h.call("patch", `/timesheets/shifts/${s.id}`, owner, { endedAt: ago(40 * 60) })).status).toBe(400);
    expect((await h.call("patch", `/timesheets/shifts/${s.id}`, viewer, { note: "x" })).status).toBe(403);
  });

  it("starts the shift by itself when the driver starts work, and ends it when the last route is done", async () => {
    await reset();
    const id = (await h.call("post", "/r/jobs", owner, { title: "Drop", lat: 43.7, lng: -79.4 })).body.id;
    await h.call("post", `/jobs/${id}/assign`, owner, { driverId: ann });
    const stop = (await h.call("get", `/jobs/${id}`, owner)).body.job.stop_id;
    expect((await h.call("get", "/driver/shift", annTok)).body.active).toBe(false);
    await h.call("post", `/driver/stops/${stop}/status`, annTok, { status: "arrived" });
    expect((await h.call("get", "/driver/shift", annTok)).body).toMatchObject({ active: true, source: "auto" });
    await h.call("post", `/driver/stops/${stop}/status`, annTok, { status: "done" });
    const s = await h.call("get", "/driver/shift", annTok);
    expect(s.body.active).toBe(false);
    expect((await h.call("get", "/driver/shifts", annTok)).body[0].source).toBe("auto");
  });

  it("raises a 'needs a break' alert after 5 hours and clears it when the driver takes one", async () => {
    await reset();
    const analytics = h.nest.get(AnalyticsService);
    const rule = (await h.call("post", "/r/alert-rules", owner, { name: "Breaks", kind: "needs_break", params: { afterHours: 5 }, severity: "warn" })).body.id;
    await h.call("post", "/driver/shift/start", annTok, { occurredAt: ago(4 * 60) });
    expect((await evaluateOrg(h.app, analytics, stub, h.orgA)).raised).toBe(0);
    await h.admin.query("UPDATE shifts SET started_at = now() - interval '6 hours'");
    expect((await evaluateOrg(h.app, analytics, stub, h.orgA)).raised).toBe(1);
    expect((await h.call("get", "/alerts?status=open", owner)).body[0].title).toMatch(/Ann Lee has worked 6\.0 hours without a break/);
    await h.call("post", "/driver/shift/break", annTok, { action: "start" });
    expect((await evaluateOrg(h.app, analytics, stub, h.orgA)).resolved).toBe(1);
    void rule;
  });
});

describe("expenses", () => {
  it("approves small ones at once, holds large ones for a manager, and logs fuel", async () => {
    await reset();
    const png = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==";
    const small = await h.call("post", "/driver/expenses", annTok, { kind: "parking", amount: 12.5, vendor: "Green P", receiptDataUrl: png, clientId: randomUUID() });
    expect(small.body).toMatchObject({ status: "approved", needsApproval: false });
    expect((await h.call("post", "/driver/expenses", annTok, { kind: "parking", amount: 0 })).status).toBe(400);
    expect((await h.call("post", "/driver/expenses", annTok, { kind: "parking", amount: 5, receiptDataUrl: "data:text/html;base64,AAAA" })).status).toBe(400);
    const cid = randomUUID();
    const big = await h.call("post", "/driver/expenses", annTok, { kind: "fuel", amount: 180, tax: 20, litres: 100, vehicleId: veh, odometerKm: 12000, vendor: "Shell", clientId: cid });
    expect(big.body).toMatchObject({ status: "submitted", needsApproval: true });
    expect((await h.call("post", "/driver/expenses", annTok, { kind: "fuel", amount: 180, clientId: cid })).body.duplicate).toBe(true);
    expect((await h.admin.query("SELECT litres::float AS l, cost FROM fuel_logs")).rows).toEqual([{ l: 100, cost: 180 }]);
    const pend = (await h.call("get", "/approvals?status=pending", owner)).body;
    expect(pend).toHaveLength(1);
    await h.call("post", `/approvals/${pend[0].id}/decide`, owner, { decision: "approved" });
    const all = (await h.call("get", "/expenses", owner)).body;
    expect(all.items).toHaveLength(2);
    expect(all.items.every((e: { status: string }) => e.status === "approved")).toBe(true);
    expect(all.total).toBeCloseTo(192.5, 1); expect(all.totals).toMatchObject({ fuel: 180, parking: 12.5 });
    const receipt = await h.call("get", `/expenses/${all.items.find((e: { kind: string }) => e.kind === "parking").id}/receipt`, owner);
    expect(receipt.body.url).toBe(png);
    expect((await h.call("post", `/expenses/${all.items[0].id}/reimburse`, owner)).status).toBe(200);
    expect((await h.call("get", "/expenses", annTok)).status).toBe(403);
    expect((await h.call("get", "/driver/expenses", annTok)).body).toHaveLength(2);
    expect((await h.call("get", "/driver/expenses", bobTok)).body).toEqual([]);
    expect((await h.call("get", "/expenses/export.csv", owner)).text).toContain("Shell");
    const rej = await h.call("post", "/driver/expenses", bobTok, { kind: "meal", amount: 500 });
    const p2 = (await h.call("get", "/approvals?status=pending", owner)).body[0];
    await h.call("post", `/approvals/${p2.id}/decide`, owner, { decision: "rejected", note: "over policy" });
    expect((await h.call("get", "/driver/expenses", bobTok)).body[0]).toMatchObject({ status: "rejected", decisionNote: "over policy" });
    void rej;
  });
});

describe("tips", () => {
  it("shows drivers the active tips in their language", async () => {
    await h.admin.query("DELETE FROM training_items");
    await h.call("post", "/r/training-items", owner, { title: "Lifting", body: "Bend your knees", lang: "en" });
    await h.call("post", "/r/training-items", owner, { title: "Soulever", body: "Pliez les genoux", lang: "fr" });
    await h.call("post", "/r/training-items", owner, { title: "Old", active: false });
    expect((await h.call("post", "/r/training-items", owner, { title: "Bad", videoUrl: "http://x.test/v" })).status).toBe(400);
    expect((await h.call("get", "/driver/training?lang=fr", annTok)).body.map((x: { title: string }) => x.title)).toEqual(["Soulever"]);
    expect((await h.call("get", "/driver/training", annTok)).body).toHaveLength(2);
  });
});
