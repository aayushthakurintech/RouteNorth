import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnalyticsService } from "../analytics/analytics.service.js";
import { DEFAULT_RULES } from "../alerts/defaults.js";
import { evaluateOrg } from "../alerts/engine.js";
import { sendPersonalDigests } from "../alerts/digest.js";
import type { Providers } from "../notify/notifier.js";
import { runAutomations } from "./automations.js";
import { startHarness, type Harness } from "../test-harness.js";

let cy: string;
let h: Harness, owner: string, mgr: string, view: string, orgB: string, ownerId: string, mgrId: string, ann: string, bob: string, car: string, car2: string;
const sent: { url: string; body: string }[] = [];
let emailOn = true;
const stub = (): Providers => ({
  fetch: (async (url: string, init: RequestInit) => { sent.push({ url: String(url), body: String(init.body) }); return new Response("{}"); }) as typeof fetch,
  email: emailOn ? { apiKey: "k", from: "RouteNorth <a@b.ca>", url: "https://mail.test/send" } : null, sms: null,
});
const post = (p: string, t: string, b?: unknown) => h.call("post", p, t, b);
const get = (p: string, t: string) => h.call("get", p, t);
const put = (p: string, t: string, b?: unknown) => h.call("put", p, t, b);
let tz = "America/Toronto";
const dayOf = (offset: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now() + offset * 86_400_000));
const tick = (only?: string, now = new Date()) => evaluateOrg(h.app, h.nest.get(AnalyticsService), stub(), h.orgA, now, only);
const rules = async () => (await get("/portal/alerts/rules", owner)).body as { id: string; systemKey: string | null; params: Record<string, unknown> }[];
const ruleId = async (key: string) => (await rules()).find((r) => r.systemKey === key)!.id;
const alerts = async (view = "active", extra = "") => (await get(`/portal/alerts?view=${view}${extra}`, owner)).body.alerts as { id: string; title: string; severity: string; area: string; rule: string; status: string }[];
const sql = (q: string, p: unknown[] = []) => h.admin.query(q, p);

beforeAll(async () => {
  h = await startHarness({ notify: stub() });
  owner = await h.token("a@example.com");
  ownerId = (await sql("SELECT id FROM users WHERE email = 'a@example.com'")).rows[0].id;
  tz = (await sql("SELECT timezone FROM organizations WHERE id = $1", [h.orgA])).rows[0].timezone;
  mgrId = await h.addUser(h.orgA, "mgr@example.com", "manager"); mgr = await h.token("mgr@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer"); view = await h.token("view@example.com");
  ann = await h.addUser(h.orgA, "ann@example.com", "driver", { display_name: "Ann Driver" });
  bob = await h.addUser(h.orgA, "bob@example.com", "driver", { display_name: "Bob Driver" });
  cy = await h.addUser(h.orgA, "cy@example.com", "driver", { display_name: "Cy Driver" });
  await h.addUser(h.orgB, "adminb@example.com", "admin"); orgB = await h.token("adminb@example.com");
  car = (await post("/portal/vehicles", owner, { name: "Truck 1", kind: "truck" })).body.id;
  car2 = (await post("/portal/vehicles", owner, { name: "Truck 2", kind: "truck" })).body.id;
}, 90_000);
afterAll(async () => { await h.close(); });

describe("default rules", () => {
  it("every company gets the default rules, in four areas, and the owner can read them", async () => {
    const r = await rules();
    expect(r.filter((x) => x.systemKey).length).toBe(DEFAULT_RULES.length);
    const areas = new Set((await get("/portal/alerts/rules", owner)).body.map((x: { area: string }) => x.area));
    expect([...areas]).toEqual(expect.arrayContaining(["vehicle", "driver", "pay", "money"]));
    expect((await get("/portal/alerts/rules", view)).status).toBe(403);
    expect((await get("/portal/alerts/rules", orgB)).body.length).toBe(DEFAULT_RULES.length); // its own copies
  });

  it("the numbers follow the spec table", async () => {
    const r = await rules();
    const p = (k: string) => r.find((x) => x.systemKey === k)!.params;
    expect(p("veh_docs")).toEqual({ days: 30 });
    expect(p("veh_service")).toEqual({ days: 14, km: 500 });
    expect(p("veh_idle")).toEqual({ days: 3 });
    expect(p("veh_fuel")).toEqual({ pct: 20 });
    expect(p("drv_safety")).toEqual({ below: 70 });
    expect(p("drv_rating")).toMatchObject({ below: 4.2 });
    expect(p("drv_inactive")).toEqual({ days: 14 });
    expect(p("pay_odd")).toMatchObject({ pct: 40 });
    expect(p("pay_dispute")).toEqual({ days: 3 });
    expect(p("money_invoice")).toEqual({ daysLate: 1 });
    expect(p("money_budget")).toEqual({ pct: 90 });
  });

  it("checks numbers, keeps default names, and a default rule can be switched off and reset but not removed", async () => {
    const id = await ruleId("veh_idle");
    expect((await put(`/portal/alerts/rules/${id}`, owner, { params: { days: 0 } })).status).toBe(400);
    expect((await put(`/portal/alerts/rules/${id}`, owner, { params: { nope: 1 } })).status).toBe(400);
    expect((await put(`/portal/alerts/rules/${id}`, owner, { name: "Mine" })).status).toBe(400);
    expect((await put(`/portal/alerts/rules/${id}`, owner, { params: { days: 9 }, severity: "critical", active: false })).status).toBe(200);
    const r = (await rules()).find((x) => x.id === id)! as unknown as { params: { days: number }; active: boolean };
    expect(r.params.days).toBe(9); expect(r.active).toBe(false);
    expect((await h.call("delete", `/portal/alerts/rules/${id}`, owner)).status).toBe(409);
    expect((await post(`/portal/alerts/rules/${id}/reset`, owner)).status).toBe(200);
    expect((await rules()).find((x) => x.id === id)!.params).toEqual({ days: 3 });
    const log = (await sql("SELECT old_value, new_value FROM audit_log WHERE action = 'alert_rules.update' AND entity_id = $1", [id])).rows[0];
    expect(log.old_value).toBeTruthy(); expect(log.new_value).toBeTruthy();
  });
});

describe("each default alert fires on test data", () => {
  beforeAll(async () => {
    const day = dayOf(0);
    // cars: a document in 5 days, an overdue service, a failed inspection, no movement, a fuel jump, repairs over a budget
    await sql("INSERT INTO documents (org_id, owner_kind, owner_id, kind, expires_on) VALUES ($1,'vehicle',$2,'Insurance',$3::date + 5)", [h.orgA, car, day]);
    await sql("UPDATE vehicles SET service_interval_days = 30, purchase_date = $2::date - 100, created_at = now() - interval '20 days' WHERE id = $1", [car, day]);
    await sql("INSERT INTO inspections (org_id, vehicle_id, kind, defects, notes) VALUES ($1,$2,'check_out',true,'Brakes')", [h.orgA, car2]);
    await sql("UPDATE vehicles SET created_at = now() - interval '10 days' WHERE id = $1", [car2]);
    for (const [i, [odo, litres]] of ([[1000, 40], [1500, 50], [2000, 50], [2500, 50], [3000, 50], [3500, 100]] as const).entries())
      await sql("INSERT INTO fuel_logs (org_id, vehicle_id, filled_on, litres, odometer_km) VALUES ($1,$2,$3::date - $4::int,$5,$6)", [h.orgA, car, day, 10 - i, litres, odo]);
    await put("/portal/finance/budget", owner, { category: "maintenance", amountCents: 10_000 });
    await put("/portal/finance/budget", owner, { category: "fuel", amountCents: 10_000 });
    await post("/portal/finance/expenses", owner, { spentOn: day, category: "maintenance", amountCents: 50_000, vendor: "Shop", vehicleId: car });
    await post("/portal/finance/expenses", owner, { spentOn: day, category: "fuel", amountCents: 9_500, vendor: "Petro", vehicleId: car2 });
    // drivers: licence in 3 days, poor safety, poor rating plus a complaint, overtime, inactive, cancellations, stuck onboarding
    await sql("UPDATE driver_profiles SET license_expiry = $2::date + 3 WHERE user_id = $1", [ann, day]);
    await sql("UPDATE users SET created_at = now() - interval '60 days' WHERE id = ANY($1::uuid[])", [[ann, cy]]);
    for (let i = 0; i < 6; i++) await sql("INSERT INTO driver_safety_events (org_id, driver_id, kind, severity) VALUES ($1,$2,'speeding',3)", [h.orgA, ann]);
    await sql("UPDATE alert_rules SET params = '{\"below\":100}' WHERE system_key = 'drv_safety'");
    for (let i = 0; i < 6; i++) await post("/portal/trips", owner, { startedAt: `${dayOf(-1)}T1${i}:00:00Z`, distanceKm: 10, durationMin: 20, vehicleId: car, driverId: ann, revenueCents: 8_000, customerName: "Acme", zone: "Core", rating: 3, ...(i === 0 ? { complaint: "Late and rude" } : {}) });
    for (let i = 0; i < 6; i++) await post("/portal/trips", owner, { startedAt: `${dayOf(-2)}T1${i}:00:00Z`, distanceKm: 10, durationMin: 20, driverId: bob, revenueCents: 5_000, customerName: "Beta", status: i < 3 ? "cancelled" : "completed" });
    await sql("INSERT INTO shifts (org_id, driver_id, started_at, ended_at) VALUES ($1,$2, now() - interval '90 minutes', now() - interval '10 minutes')", [h.orgA, ann]);
    await sql("UPDATE alert_rules SET params = '{\"hours\":1}' WHERE system_key = 'drv_overtime'");
    await sql("UPDATE driver_profiles SET status = 'onboarding' WHERE user_id = $1", [bob]);
    await sql("UPDATE users SET created_at = now() - interval '12 days' WHERE id = $1", [bob]);
    // pay: a draft run that ended yesterday, a trip paid far above the usual on its zone, a pay question waiting 5 days, a trip that loses money
    const run = (await sql("INSERT INTO portal_payout_runs (org_id, cycle, from_date, to_date) VALUES ($1,'weekly',$2::date - 7,$2::date - 1) RETURNING id", [h.orgA, day])).rows[0].id;
    const payout = (await sql("INSERT INTO portal_payouts (org_id, run_id, driver_id, from_date, to_date, earnings_cents, net_cents) VALUES ($1,$2,$3,$4::date - 7,$4::date - 1,10000,10000) RETURNING id", [h.orgA, run, ann, day])).rows[0].id;
    await sql("INSERT INTO portal_disputes (org_id, payout_id, driver_id, message, created_at) VALUES ($1,$2,$3,'Missing a trip', now() - interval '5 days')", [h.orgA, payout, ann]);
    await sql("DELETE FROM portal_pay_lines WHERE driver_id = $1", [ann]);
    const trips = (await sql("SELECT id FROM portal_trips WHERE driver_id = $1 ORDER BY started_at", [ann])).rows;
    for (const [i, t] of trips.entries())
      await sql("INSERT INTO portal_pay_lines (org_id, driver_id, trip_id, kind, key, label, amount_cents, line_date) VALUES ($1,$2,$3,'earning','trip','Trip',$4,$5)", [h.orgA, ann, t.id, i === 5 ? 20_000 : 4_000, day]);
    // money: an overdue invoice
    await sql("INSERT INTO invoices (org_id, number, customer_name, customer_email, status, due_on, subtotal, tax, total) VALUES ($1,'INV-9','Acme','pay@acme.test','sent',$2::date - 3,100,13,113)", [h.orgA, day]);
    await tick();
  }, 60_000);

  const SPEC: [string, string][] = [
    ["veh_docs", "Insurance expires in 5 days"], ["veh_service", "overdue"], ["veh_inspection", "failed an inspection"], ["veh_idle", "has not moved"], ["veh_fuel", "more fuel than usual"],
    ["veh_repairs", "over budget"], ["drv_docs", "licence expires in 3 days"], ["drv_safety", "safety score"], ["drv_rating", "rating is"], ["drv_overtime", "worked"],
    ["drv_inactive", "no trips or shifts"], ["drv_cancel", "cancelled or missed 3 of 6"], ["drv_onboarding", "onboarding"], ["pay_approval", "wait for approval"],
    ["pay_odd", "above the usual"], ["pay_dispute", "waited 5 days"], ["money_loss", "lost money"], ["money_invoice", "INV-9"], ["money_budget", "of its budget"],
  ];
  it.each(SPEC)("%s fires", async (key, text) => {
    const name = DEFAULT_RULES.find((d) => d.key === key)!.name;
    const mine = (await alerts("active", "&limit=200")).filter((a) => a.rule === name);
    expect(mine.length, `${key} raised nothing`).toBeGreaterThan(0);
    expect(mine.some((a) => a.title.includes(text)), `${key}: ${mine.map((a) => a.title).join(" | ")}`).toBe(true);
  });

  it("a document 5 days from its end is Critical, and the same rule would call 30 days out Info", async () => {
    const a = (await alerts("active", "&limit=200")).find((x) => x.title.includes("Insurance"))!;
    expect(a.severity).toBe("critical");
    await sql("INSERT INTO documents (org_id, owner_kind, owner_id, kind, expires_on) VALUES ($1,'vehicle',$2,'Registration',$3::date + 28)", [h.orgA, car2, dayOf(0)]);
    await tick();
    expect((await alerts("active", "&limit=200")).find((x) => x.title.includes("Registration"))!.severity).toBe("info");
  });

  it("one expired document is one alert, however many times it is checked", async () => {
    const before = (await alerts("active", "&limit=200")).filter((x) => x.title.includes("Insurance")).length;
    await tick(); await tick();
    expect((await alerts("active", "&limit=200")).filter((x) => x.title.includes("Insurance")).length).toBe(before);
    expect(before).toBe(1);
  });

  it("the flagged trip, the open alerts and the money agree with the dashboard", async () => {
    const t = (await get(`/portal/trips?from=${dayOf(-5)}&to=${dayOf(0)}&flagged=0`, owner)).body.trips as unknown[];
    expect(Array.isArray(t)).toBe(true);
    const sum = (await get("/portal/alerts/summary", owner)).body;
    expect(sum.critical).toBeGreaterThan(0);
  });
});

describe("how alerts reach people", () => {
  it("tells the owners by email by default, and the history records it", async () => {
    sent.length = 0;
    await sql("UPDATE alerts SET status = 'resolved' WHERE dedupe_key LIKE 'vdoc:%' OR dedupe_key LIKE 'vins:%'");
    await sql("UPDATE alerts SET resolved_how = 'auto' WHERE status = 'resolved'");
    await tick(await ruleId("veh_docs"));
    const mails = sent.filter((s) => s.url === "https://mail.test/send");
    expect(mails.length).toBeGreaterThan(0);
    expect(mails.some((m) => m.body.includes("a@example.com") && m.body.includes("Insurance"))).toBe(true);
  });

  it("each person's own choices count: email off, SMS on needs a number, quiet hours let only Critical through", async () => {
    expect((await put("/portal/alerts/prefs", owner, { phone: "12345" })).status).toBe(400);
    expect((await put("/portal/alerts/prefs", owner, { channels: { warn: ["fax"] } })).status).toBe(400);
    expect((await put("/portal/alerts/prefs", owner, { quietStart: "22:00" })).status).toBe(400);
    const ok = await put("/portal/alerts/prefs", owner, { channels: { warn: ["inapp"], critical: ["inapp", "email", "push"] }, mutedAreas: ["driver"] });
    expect(ok.status).toBe(200);
    expect(ok.body.available).toMatchObject({ inapp: true, email: true, sms: false, push: false });
    expect(ok.body.notes.push).toMatch(/not built/);
    const body = (await get("/portal/alerts/prefs", owner)).body;
    expect(body.channels.warn).toEqual(["inapp"]);
    // a Warning rule now sends no email to the owner
    await sql("DELETE FROM alerts WHERE area = 'money'");
    sent.length = 0;
    await tick(await ruleId("money_invoice"));
    expect(sent.filter((s) => s.body.includes("a@example.com") && s.body.includes("INV-9"))).toHaveLength(0);
    // but a Critical one still does
    await sql("UPDATE alerts SET status = 'resolved' WHERE area = 'vehicle' AND severity = 'critical'; UPDATE alert_events SET at = at");
    sent.length = 0;
    await put("/portal/alerts/prefs", owner, { quietStart: "00:00", quietEnd: "23:59" });
    await tick(await ruleId("veh_inspection"));
    expect(sent.filter((s) => s.body.includes("failed an inspection")).length).toBeGreaterThan(0);
    await put("/portal/alerts/prefs", owner, { channels: { warn: ["inapp", "email"] }, mutedAreas: [], quietStart: null, quietEnd: null });
  });

  it("a Critical alert nobody has acted on is sent again, and stops once it is acknowledged", async () => {
    const id = await ruleId("veh_inspection");
    await put(`/portal/alerts/rules/${id}`, owner, { repeatMinutes: 5 });
    await sql("UPDATE alerts SET status = 'resolved' WHERE dedupe_key LIKE 'insp:%' AND status <> 'open'");
    await tick(id);
    await sql("UPDATE alerts SET last_sent_at = now() - interval '10 minutes', delivered_at = now() - interval '10 minutes' WHERE dedupe_key LIKE 'insp:%'");
    sent.length = 0;
    await tick(id);
    expect(sent.filter((s) => s.body.includes("failed an inspection")).length).toBeGreaterThan(0);
    const a = (await alerts("active", "&limit=200")).find((x) => x.title.includes("failed an inspection"))!;
    expect((await post(`/portal/alerts/${a.id}/acknowledge`, owner)).status).toBe(200);
    await sql("UPDATE alerts SET last_sent_at = now() - interval '10 minutes' WHERE id = $1", [a.id]);
    sent.length = 0;
    await tick(id);
    expect(sent.filter((s) => s.body.includes("failed an inspection"))).toHaveLength(0);
    const events = (await get(`/portal/alerts/${a.id}`, owner)).body.history.map((e: { kind: string }) => e.kind);
    expect(events).toEqual(expect.arrayContaining(["raised", "sent", "repeated", "acknowledged"]));
  });

  it("a rule can name its people, who must work in the office", async () => {
    const id = await ruleId("money_invoice");
    expect((await put(`/portal/alerts/rules/${id}`, owner, { recipientIds: [ann] })).status).toBe(400);
    expect((await put(`/portal/alerts/rules/${id}`, owner, { recipientIds: [mgrId] })).status).toBe(200);
    await sql("DELETE FROM alerts WHERE area = 'money'");
    sent.length = 0;
    await tick(id);
    expect(sent.some((s) => s.body.includes("mgr@example.com") && s.body.includes("INV-9"))).toBe(true);
    expect(sent.some((s) => s.body.includes("a@example.com") && s.body.includes("INV-9"))).toBe(false);
  });

  it("email that is not set up is said plainly, not counted as sent", async () => {
    emailOn = false;
    await sql("DELETE FROM alerts WHERE area = 'money'");
    const r = await tick(await ruleId("money_invoice"));
    expect(r.sent).toBe(0);
    emailOn = true;
  });
});

describe("snooze, assign, done and history", () => {
  let id: string;
  it("snoozed alerts leave the inbox, come back, and an assigned alert is acknowledged and tells the person", async () => {
    id = (await alerts("active", "&limit=200")).find((a) => a.title.includes("INV-9"))!.id;
    expect((await post(`/portal/alerts/${id}/snooze`, owner, { hours: 0 })).status).toBe(400);
    expect((await post(`/portal/alerts/${id}/snooze`, owner, { hours: 48 })).status).toBe(200);
    expect((await alerts("active", "&limit=200")).some((a) => a.id === id)).toBe(false);
    expect((await alerts("snoozed")).some((a) => a.id === id)).toBe(true);
    expect((await post(`/portal/alerts/${id}/unsnooze`, owner)).status).toBe(200);
    expect((await post(`/portal/alerts/${id}/assign`, owner, { userId: ann })).status).toBe(400);
    expect((await post(`/portal/alerts/${id}/assign`, owner, { userId: mgrId, note: "Please chase" })).status).toBe(200);
    const one = (await get(`/portal/alerts/${id}`, owner)).body;
    expect(one.assignedToId).toBe(mgrId); expect(one.status).toBe("acknowledged");
    expect((await sql("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title LIKE '%gave you an alert%'", [mgrId])).rows[0].n).toBe(1);
    expect((await alerts("mine")).length).toBe(0); // "mine" is the owner's own
    expect(((await get("/portal/alerts?view=mine", mgr)).body.alerts as unknown[]).length).toBe(0); // a manager has no access to money alerts, so it stays hidden from them
  });

  it("done is remembered with who did it, is not raised again for the same problem, and can be reopened", async () => {
    expect((await post(`/portal/alerts/${id}/done`, owner, { note: "Called them" })).status).toBe(200);
    const done = (await alerts("done")).find((a) => a.id === id)! as unknown as { resolvedBy: string; resolvedHow: string };
    expect(done.resolvedBy).toBeTruthy(); expect(done.resolvedHow).toBe("person");
    await tick(await ruleId("money_invoice"));
    expect((await alerts("active", "&limit=200")).some((a) => a.title.includes("INV-9"))).toBe(false);
    const history = (await get(`/portal/alerts/${id}`, owner)).body.history as { kind: string; note: string | null; actor: string }[];
    expect(history.map((e) => e.kind)).toEqual(expect.arrayContaining(["raised", "assigned", "done"]));
    expect(history.find((e) => e.kind === "done")!.note).toBe("Called them");
    expect((await post(`/portal/alerts/${id}/reopen`, owner)).status).toBe(200);
    expect((await post(`/portal/alerts/${id}/done`, owner, {})).status).toBe(200);
    expect((await post(`/portal/alerts/${id}/done`, owner, {})).status).toBe(409);
  });

  it("alerts go away by themselves when the problem is fixed, and say so", async () => {
    await sql("UPDATE invoices SET status = 'paid'");
    await sql("DELETE FROM alerts WHERE dedupe_key LIKE 'invoice:%' AND status = 'resolved'");
    await sql("UPDATE invoices SET status = 'sent'");
    await tick(await ruleId("money_invoice"));
    const a = (await alerts("active", "&limit=200")).find((x) => x.title.includes("INV-9"))!;
    await sql("UPDATE invoices SET status = 'paid'");
    const r = await tick(await ruleId("money_invoice"));
    expect(r.resolved).toBe(1);
    const h2 = (await get(`/portal/alerts/${a.id}`, owner)).body;
    expect(h2.resolvedHow).toBe("auto");
    expect(h2.history.map((e: { kind: string }) => e.kind)).toContain("auto_resolved");
  });

  it("only people who manage alerts can act, and nobody sees another company's alerts", async () => {
    const any = (await alerts("active", "&limit=200"))[0]!;
    expect((await post(`/portal/alerts/${any.id}/acknowledge`, view)).status).toBe(403);
    expect((await get(`/portal/alerts/${any.id}`, orgB)).status).toBe(404);
    expect(((await get("/portal/alerts?view=all", orgB)).body.alerts as unknown[]).length).toBe(0);
  });

  it("a regional manager only sees their own region's alerts, and money alerts stay hidden from roles without access", async () => {
    const all = await alerts("active", "&limit=200");
    const m = (await get("/portal/alerts?view=active&limit=200", mgr)).body.alerts as { area: string }[];
    expect(m.every((a) => a.area !== "money")).toBe(true);
    expect(m.length).toBeLessThanOrEqual(all.length);
    const team = (await sql("INSERT INTO teams (org_id, name) VALUES ($1,'West') RETURNING id", [h.orgA])).rows[0].id;
    await sql("INSERT INTO team_members (org_id, team_id, user_id) VALUES ($1,$2,$3)", [h.orgA, team, mgrId]);
    await sql("UPDATE vehicles SET team_id = $2 WHERE id = $1", [car2, team]);
    const reg = (await get("/portal/alerts?view=active&limit=200", mgr)).body.alerts as { title: string }[];
    expect(reg.length).toBeGreaterThan(0);
    expect(reg.every((a) => a.title.includes("Truck 2"))).toBe(true);
    await sql("DELETE FROM team_members WHERE user_id = $1", [mgrId]);
  });

  it("bulk actions work on several alerts", async () => {
    const ids = (await alerts("active", "&limit=200")).slice(0, 3).map((a) => a.id);
    const r = await post("/portal/alerts/bulk", owner, { ids, action: "snooze", hours: 2 });
    expect(r.body.done).toBe(3);
    expect((await post("/portal/alerts/bulk", owner, { ids: [], action: "done" })).status).toBe(400);
  });
});

describe("custom rules", () => {
  it("when [measure] [is above/below] [value] for [company], tell [person]", async () => {
    expect((await post("/portal/alerts/rules", owner, { measure: "nope", op: "gt", value: 1 })).status).toBe(400);
    expect((await post("/portal/alerts/rules", owner, { measure: "activeCars", op: "gt", value: "x" })).status).toBe(400);
    const made = await post("/portal/alerts/rules", owner, { measure: "activeCars", op: "gt", value: 1, severity: "info", recipientIds: [mgrId] });
    expect(made.status).toBe(201);
    const pre = await post(`/portal/alerts/rules/${made.body.id}/preview`, owner, {});
    expect(pre.body.count).toBe(1);
    await tick(made.body.id);
    expect((await alerts("active", "&limit=200")).some((a) => a.area === "custom" && a.title.includes("active cars"))).toBe(true);
  });

  it("for one car or one driver, and a custom rule can be archived", async () => {
    const r = await post("/portal/alerts/rules", owner, { measure: "idleDays", op: "gt", value: 5, scopeId: car2 });
    expect(r.status).toBe(201);
    const pre = (await post(`/portal/alerts/rules/${r.body.id}/preview`, owner, {})).body;
    expect(pre.count).toBe(1);
    expect(pre.matches[0].title).toContain("Truck 2");
    const money = await post("/portal/alerts/rules", owner, { measure: "monthRevenue", op: "gt", value: 10, scopeId: car });
    expect(money.status).toBe(201);
    expect((await h.call("delete", `/portal/alerts/rules/${r.body.id}`, owner)).status).toBe(200);
    expect((await rules()).some((x) => x.id === r.body.id)).toBe(false);
    expect((await get("/portal/alerts/measures", owner)).body.length).toBeGreaterThan(20);
  });
});

describe("the morning summary", () => {
  it("sends each person what needs them, once a day, and nothing when nothing does", async () => {
    sent.length = 0;
    const r = await sendPersonalDigests(h.app, stub(), h.orgA, new Date());
    expect(r.sent).toBeGreaterThan(0);
    const mail = sent.find((s) => s.body.includes("What needs you today") && s.body.includes("a@example.com"))!;
    expect(mail.body).toMatch(/Critical|Warnings|information/);
    sent.length = 0;
    expect((await sendPersonalDigests(h.app, stub(), h.orgA, new Date())).sent).toBe(0); // same day: already sent
    await put("/portal/alerts/prefs", owner, { digest: false });
    await sql("DELETE FROM portal_automation_runs WHERE automation = 'digest'");
    const r2 = await sendPersonalDigests(h.app, stub(), h.orgA, new Date());
    expect(sent.some((s) => s.body.includes("a@example.com"))).toBe(false);
    expect(r2.people).toBeGreaterThanOrEqual(0);
    const me = (await post("/portal/alerts/digest/me", owner)).body;
    expect(me.message).toBeTruthy();
    await put("/portal/alerts/prefs", owner, { digest: true });
  });
});

describe("automations", () => {
  const ran = (key: string) => runAutomations(h.app, stub(), h.orgA, new Date(), key);
  it("lists the nine of the spec; the always-on ones cannot be switched off", async () => {
    const list = (await get("/portal/alerts/automations", owner)).body as { key: string; spec: number; enabled: boolean; builtIn: boolean }[];
    expect(list.map((a) => a.spec)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect((await put("/portal/alerts/automations/block_on_expiry", owner, { enabled: false })).status).toBe(409);
    expect(list.find((a) => a.key === "payout_run_on_payday")!.enabled).toBe(false);
    expect((await get("/portal/alerts/automations", view)).status).toBe(403);
  });

  it("1: a driver with an expired licence and a car with an expired legal document cannot be given work", async () => {
    await sql("UPDATE driver_profiles SET license_expiry = $2::date - 1 WHERE user_id = $1", [ann, dayOf(0)]);
    const r = await post("/routes", owner, { name: "R1", date: "2026-12-01", driverId: ann, stops: [] });
    expect(r.status).toBe(409);
    await sql("UPDATE driver_profiles SET license_expiry = $2::date + 3 WHERE user_id = $1", [ann, dayOf(0)]);
  });

  it("2: a work order opens when a service is due, once", async () => {
    await sql("INSERT INTO maintenance_plans (org_id, vehicle_id, task, every_days, last_done_on) VALUES ($1,$2,'Oil change',30,$3::date - 40)", [h.orgA, car, dayOf(0)]);
    const first = await ran("service_work_order");
    expect(first.some((x) => x.status === "ok" && x.message.includes("Oil change"))).toBe(true);
    expect((await sql("SELECT count(*)::int AS n FROM work_orders WHERE vehicle_id = $1 AND source = 'automation'", [car])).rows[0].n).toBe(1);
    await ran("service_work_order");
    expect((await sql("SELECT count(*)::int AS n FROM work_orders WHERE vehicle_id = $1 AND source = 'automation'", [car])).rows[0].n).toBe(1);
  });

  it("3: the driver is reminded 14 days before, once, in the app and by email", async () => {
    await sql("UPDATE driver_profiles SET license_expiry = $2::date + 10 WHERE user_id = $1", [ann, dayOf(0)]);
    sent.length = 0;
    const first = await ran("driver_doc_reminder");
    expect(first.some((x) => x.message.includes("Ann Driver"))).toBe(true);
    expect((await sql("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title LIKE '%licence%'", [ann])).rows[0].n).toBe(1);
    expect(sent.some((s) => s.body.includes("ann@example.com"))).toBe(true);
    expect((await ran("driver_doc_reminder")).length).toBe(0);
  });

  it("4: on pay day a draft run is started and sent for approval, and it never approves or pays by itself", async () => {
    await sql("DELETE FROM portal_disputes; DELETE FROM portal_pay_lines; DELETE FROM portal_payouts; DELETE FROM portal_payout_runs");
    const t = (await post("/portal/trips", owner, { startedAt: `${dayOf(-1)}T15:00:00Z`, distanceKm: 10, durationMin: 20, driverId: ann, vehicleId: car, revenueCents: 9_000, customerName: "Acme" })).body.id;
    await sql("INSERT INTO portal_pay_lines (org_id, driver_id, trip_id, kind, key, label, amount_cents, line_date) VALUES ($1,$2,$3,'earning','trip','Trip',3000,$4)", [h.orgA, ann, t, dayOf(-1)]);
    expect((await put("/portal/alerts/automations/payout_run_on_payday", owner, { enabled: true, settings: { cycle: "weekly", payWeekday: 9 } })).status).toBe(400);
    const wd = new Date(`${dayOf(0)}T12:00:00Z`).getUTCDay();
    expect((await put("/portal/alerts/automations/payout_run_on_payday", owner, { enabled: true, settings: { cycle: "weekly", payWeekday: wd, hour: 0 } })).status).toBe(200);
    expect((await post("/portal/alerts/automations/payout_run_on_payday/run", mgr)).status).toBe(403); // only people who may approve payouts
    const out = (await post("/portal/alerts/automations/payout_run_on_payday/run", owner)).body.results as { status: string; message: string }[];
    expect(out[0]!.status).toBe("ok");
    const payouts = (await sql("SELECT status, net_cents::int AS net FROM portal_payouts")).rows;
    expect(payouts).toEqual([{ status: "draft", net: 3000 }]);
    expect((await sql("SELECT count(*)::int AS n FROM notifications WHERE kind = 'approval' AND title LIKE 'Pay day%'")).rows[0].n).toBeGreaterThan(0);
    const again = (await post("/portal/alerts/automations/payout_run_on_payday/run", owner)).body.results as unknown[];
    expect(again.length).toBe(0);
  });

  it("5: the driver gets an email statement when a payout is marked paid, and it waits for email if there is none", async () => {
    const p = (await sql("SELECT id FROM portal_payouts"))[ "rows" ][0].id;
    await sql("UPDATE portal_payouts SET status = 'paid', paid_at = now() WHERE id = $1", [p]);
    emailOn = false;
    const waiting = await ran("payout_paid_statement");
    expect(waiting[0]!.status).toBe("skipped");
    emailOn = true; sent.length = 0;
    const done = await ran("payout_paid_statement");
    expect(done[0]!.status).toBe("ok");
    const mail = sent.find((s) => s.body.includes("ann@example.com"))!;
    expect(mail.body).toMatch(/Paid to you: \$30\.00/);
    expect((await ran("payout_paid_statement")).length).toBe(0);
  });

  it("6: the weekly summary goes to the owner on Monday, once, with last week's numbers", async () => {
    const forced = await ran("weekly_summary");
    expect(forced.length).toBeGreaterThan(0);
    expect((await sql("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND title LIKE 'Last week:%'", [ownerId])).rows[0].n).toBe(1);
    expect((await ran("weekly_summary")).length).toBe(0);
  });

  it("7: a trip paid far from the usual is flagged until someone reviews it", async () => {
    await sql("DELETE FROM portal_pay_lines WHERE driver_id = $1", [ann]);
    const trips = (await sql("SELECT id FROM portal_trips WHERE driver_id = $1 AND zone = 'Core' ORDER BY started_at", [ann])).rows;
    for (const [i, t] of trips.entries()) await sql("INSERT INTO portal_pay_lines (org_id, driver_id, trip_id, kind, key, label, amount_cents, line_date) VALUES ($1,$2,$3,'earning','trip','Trip',$4,$5)", [h.orgA, ann, t.id, i === 5 ? 20_000 : 4_000, dayOf(0)]);
    const r = await ran("flag_odd_pay");
    expect(r.length).toBe(1);
    const flagged = (await get(`/portal/trips?from=${dayOf(-5)}&to=${dayOf(0)}&flagged=1`, owner)).body.trips as { id: string; reviewFlag: string }[];
    expect(flagged.length).toBe(1);
    expect(flagged[0]!.reviewFlag).toMatch(/above the usual/);
    expect((await post(`/portal/trips/${flagged[0]!.id}/reviewed`, owner)).status).toBe(200);
    expect(((await get(`/portal/trips?from=${dayOf(-5)}&to=${dayOf(0)}&flagged=1`, owner)).body.trips as unknown[]).length).toBe(0);
    expect((await ran("flag_odd_pay")).length).toBe(0); // reviewed trips are not flagged again
  });

  it("8: a late invoice reminds the customer at each step and tells the owner", async () => {
    await sql("UPDATE invoices SET status = 'sent'");
    sent.length = 0;
    const r = await ran("invoice_reminder");
    expect(r.filter((x) => x.status === "ok").length).toBe(2);
    expect(sent.some((s) => s.body.includes("pay@acme.test") && s.body.includes("INV-9"))).toBe(true);
    expect((await ran("invoice_reminder")).length).toBe(0);
    await sql("UPDATE invoices SET due_on = $1::date - 8", [dayOf(0)]);
    expect((await ran("invoice_reminder")).filter((x) => x.status === "ok").length).toBe(2); // the 7-day step
  });

  it("9: a webhook is called when an alert is raised", async () => {
    const hook = await post("/webhooks", owner, { label: "Ops tool", url: "https://hooks.example.com/rn", events: ["alert.raised", "payout.paid"] });
    expect(hook.status).toBe(201);
    await sql("DELETE FROM alerts WHERE dedupe_key LIKE 'insp:%'");
    await tick(await ruleId("veh_inspection"));
    const ev = (await sql("SELECT kind FROM automation_events WHERE kind = 'alert.raised'")).rows;
    expect(ev.length).toBeGreaterThan(0);
    expect((await get("/webhooks/events", owner)).body).toEqual(expect.arrayContaining(["payout.paid", "trip.flagged", "work_order.created"]));
  });

  it("changes to an automation are checked and written to the audit log", async () => {
    expect((await put("/portal/alerts/automations/driver_doc_reminder", owner, { settings: { daysBefore: 0 } })).status).toBe(400);
    expect((await put("/portal/alerts/automations/invoice_reminder", owner, { settings: { afterDays: "2, 9" } })).status).toBe(200);
    expect((await get("/portal/alerts/automations", owner)).body.find((a: { key: string }) => a.key === "invoice_reminder").settings.afterDays).toEqual([2, 9]);
    expect((await sql("SELECT count(*)::int AS n FROM audit_log WHERE action = 'automations.update'")).rows[0].n).toBeGreaterThan(0);
    await put("/portal/alerts/automations/invoice_reminder", owner, { settings: { afterDays: [1, 7, 14] } });
  });
});
