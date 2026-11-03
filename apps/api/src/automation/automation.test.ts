import { createHmac } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECRET, startHarness, type Harness } from "../test-harness.js";
import type { Providers } from "../notify/notifier.js";
import { runAutomationOrg } from "./processor.js";
import { conditionsHold, render, validateWorkflow } from "./spec.js";

describe("workflow rules (pure)", () => {
  it("accepts a good workflow and rejects bad ones with a plain message", () => {
    const ok = validateWorkflow({ trigger: { kind: "job.unassigned_for", minutes: 15 }, actions: [{ type: "set_job", params: { priority: "urgent" } }] });
    expect(ok.trigger.minutes).toBe(15);
    expect(() => validateWorkflow({ trigger: { kind: "nope" }, actions: [] })).toThrow(/trigger kind/);
    expect(() => validateWorkflow({ trigger: { kind: "job.unassigned_for" }, actions: [{ type: "set_job", params: { priority: "urgent" } }] })).toThrow(/minutes/);
    expect(() => validateWorkflow({ trigger: { kind: "job.done" }, actions: [] })).toThrow(/between 1 and 10/);
    expect(() => validateWorkflow({ trigger: { kind: "job.done" }, actions: [{ type: "launch_rocket", params: {} }] })).toThrow(/type must be/);
    expect(() => validateWorkflow({ trigger: { kind: "job.done" }, conditions: [{ field: "job.priority", op: "sort-of", value: 1 }], actions: [{ type: "create_invoice" , params: {} }] })).toThrow(/operator/);
    expect(() => validateWorkflow({ trigger: { kind: "shift.ended" }, actions: [{ type: "create_invoice", params: {} }] })).toThrow(/involves a job/);
  });
  it("evaluates conditions and fills placeholders", () => {
    const data = { job: { priority: "Urgent", tags: ["cold", "fragile"], weight_kg: 120, title: "Pizza" }, feedback: { csat: 2 } };
    expect(conditionsHold([{ field: "job.priority", op: "eq", value: "urgent" }], "all", data)).toBe(true);
    expect(conditionsHold([{ field: "job.tags", op: "contains", value: "cold" }, { field: "job.weight_kg", op: "gt", value: 100 }], "all", data)).toBe(true);
    expect(conditionsHold([{ field: "job.tags", op: "contains", value: "heavy" }, { field: "feedback.csat", op: "lte", value: 2 }], "any", data)).toBe(true);
    expect(conditionsHold([{ field: "job.tags", op: "contains", value: "heavy" }], "all", data)).toBe(false);
    expect(conditionsHold([{ field: "job.missing", op: "eq", value: 1 }], "all", data)).toBe(false);
    expect(render("Order {{job.title}} {{job.nothing}}!", data)).toBe("Order Pizza !");
  });
});

let h: Harness, owner: string, viewer: string, orgBadmin: string, drv: string;
const calls: { url: string; init: RequestInit }[] = [];
let receiverStatus = 200;
const stub: Providers = {
  fetch: (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return new Response("ok", { status: String(url).includes("hooks.example.com") ? receiverStatus : 200 }); }) as typeof fetch,
  email: { apiKey: "k", from: "RouteNorth <hi@example.com>", url: "https://email.test/send" }, sms: null,
};
const deps = () => ({ providers: stub, secret: SECRET });
const tick = (now = new Date()) => runAutomationOrg(h.app, deps(), h.orgA, now);
const job = async (o: Record<string, unknown> = {}) => (await h.call("post", "/r/jobs", owner, { title: "Parcel", lat: 43.7, lng: -79.4, ...o })).body.id as string;
const wf = async (body: Record<string, unknown>) => { const r = await h.call("post", "/r/workflows", owner, body); expect(r.status, JSON.stringify(r.body)).toBe(201); return r.body.id as string; };
const reset = async () => { await h.admin.query("DELETE FROM workflow_runs; DELETE FROM workflows; DELETE FROM webhook_deliveries; DELETE FROM webhook_subscriptions; DELETE FROM approvals; DELETE FROM invoices; DELETE FROM customer_notifications; DELETE FROM alerts; DELETE FROM automation_events; DELETE FROM jobs; DELETE FROM routes"); calls.length = 0; receiverStatus = 200; await tick(); };

beforeAll(async () => {
  h = await startHarness({ notify: stub });
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer");
  viewer = await h.token("view@example.com");
  drv = await h.addUser(h.orgA, "ann@example.com", "driver", { display_name: "Ann Lee" });
  await h.addUser(h.orgB, "adminb@example.com", "admin");
  orgBadmin = await h.token("adminb@example.com");
}, 90_000);
afterAll(async () => { await h.close(); });

describe("workflows", () => {
  it("only managers can build them, and a bad one is refused", async () => {
    const body = { name: "x", trigger: { kind: "job.done" }, actions: [{ type: "create_invoice", params: {} }] };
    expect((await h.call("post", "/r/workflows", viewer, body)).status).toBe(403);
    const bad = await h.call("post", "/r/workflows", owner, { ...body, trigger: { kind: "bogus" } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toMatch(/trigger kind/);
  });

  it("escalates a job nobody picks up, once", async () => {
    await reset();
    const tpl = await h.call("post", "/automation/templates/escalate-unpicked/use", owner);
    expect(tpl.status).toBe(201);
    const fresh = await job({ title: "Fresh" });
    const old = await job({ title: "Forgotten" });
    await h.admin.query("UPDATE jobs SET created_at = now() - interval '20 minutes' WHERE id = $1", [old]);
    expect((await tick()).workflowRuns).toBe(1);
    const j = (await h.call("get", `/jobs/${old}`, owner)).body.job;
    expect(j).toMatchObject({ priority: "urgent" });
    expect(j.tags).toContain("escalated");
    expect((await h.call("get", `/jobs/${fresh}`, owner)).body.job.priority).toBe("normal");
    const alerts = (await h.call("get", "/alerts?status=open", owner)).body;
    expect(alerts.some((a: { title: string }) => a.title.includes("Forgotten"))).toBe(true);
    // a second pass does nothing more
    expect((await tick()).workflowRuns).toBe(0);
    const runs = (await h.call("get", "/automation/runs", owner)).body;
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ status: "ok" });
  });

  it("creates one invoice when a job is done, whatever number of times it runs", async () => {
    await reset();
    await h.call("post", "/automation/templates/invoice-on-done/use", owner);
    const id = await job({ title: "Pallet", customerName: "Acme", customerEmail: "ap@acme.example", price: 100 });
    await h.call("post", `/jobs/${id}/assign`, owner, { driverId: drv });
    await h.call("post", `/jobs/${id}/status`, owner, { status: "started" });
    await h.call("post", `/jobs/${id}/status`, owner, { status: "arrived" });
    await h.call("post", `/jobs/${id}/status`, owner, { status: "done" });
    await tick(); await tick();
    const inv = (await h.admin.query("SELECT number, subtotal, tax, total, status, customer_email FROM invoices WHERE job_id = $1", [id])).rows;
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ subtotal: "100.00", tax: "13.00", total: "113.00", status: "sent", customer_email: "ap@acme.example" });
    expect(inv[0].number).toMatch(/^INV-\d{4}-0001$/);
  });

  it("asks for approval when the conditions match, and a manager decides", async () => {
    await reset();
    await h.call("post", "/automation/templates/approve-urgent/use", owner);
    await job({ title: "Normal one" });
    const u = await job({ title: "Rush one", priority: "urgent" });
    await tick();
    const list = (await h.call("get", "/approvals?status=pending", owner)).body;
    expect(list).toHaveLength(1);
    expect(list[0].title).toContain("Rush one");
    expect((await h.call("post", `/approvals/${list[0].id}/decide`, viewer, { decision: "approved" })).status).toBe(403);
    expect((await h.call("post", `/approvals/${list[0].id}/decide`, owner, { decision: "approved", note: "ok" })).status).toBe(200);
    expect((await h.call("post", `/approvals/${list[0].id}/decide`, owner, { decision: "rejected" })).status).toBe(404);
    expect((await h.call("get", "/approvals/count", owner)).body.pending).toBe(0);
    void u;
  });

  it("re-plans a route when a stop is cancelled", async () => {
    await reset();
    const seen: string[] = [];
    await h.call("post", "/automation/templates/replan-on-removal/use", owner);
    const a = await job({ title: "A" }), b = await job({ title: "B", lat: 43.71 });
    await h.call("post", `/jobs/${a}/assign`, owner, { driverId: drv });
    await h.call("post", `/jobs/${b}/assign`, owner, { driverId: drv });
    await tick();
    await h.call("post", `/jobs/${a}/cancel`, owner, { reasonCode: "customer_cancelled" });
    const r = await runAutomationOrg(h.app, { ...deps(), replan: async (_c, _o, routeId) => { seen.push(routeId); } }, h.orgA);
    expect(r.workflowRuns).toBe(0); // event workflows are counted as events
    expect(r.events).toBeGreaterThan(0);
    expect(seen).toHaveLength(1);
  });

  it("a dry run shows what a workflow would do without doing it", async () => {
    await reset();
    const id = await wf({ name: "Tell driver", trigger: { kind: "job.assigned" }, conditions: [{ field: "job.priority", op: "eq", value: "urgent" }], actions: [{ type: "notify_driver", params: { text: "Urgent: {{job.title}}" } }] });
    const j = await job({ title: "Hot", priority: "urgent" });
    const t = await h.call("post", `/automation/workflows/${id}/test`, owner, { jobId: j });
    expect(t.status).toBe(200);
    expect(t.body).toMatchObject({ matches: true });
    expect(t.body.wouldDo[0].preview).toBe("Urgent: Hot");
    expect((await h.admin.query("SELECT count(*)::int AS n FROM messages")).rows[0].n).toBe(0);
  });
});

describe("webhooks", () => {
  const URL_OK = "https://hooks.example.com/routenorth";
  it("refuses private or non-https addresses and keeps the secret out of lists", async () => {
    expect((await h.call("post", "/webhooks", owner, { label: "x", url: "http://hooks.example.com/a" })).status).toBe(400);
    expect((await h.call("post", "/webhooks", owner, { label: "x", url: "https://localhost/a" })).status).toBe(400);
    expect((await h.call("post", "/webhooks", viewer, { label: "x", url: URL_OK })).status).toBe(403);
    const r = await h.call("post", "/webhooks", owner, { label: "ERP", url: URL_OK, events: ["job.done"] });
    expect(r.status).toBe(201);
    expect(r.body.secret).toMatch(/^whsec_/);
    const list = (await h.call("get", "/webhooks", owner)).body;
    expect(JSON.stringify(list)).not.toContain("whsec_");
    expect((await h.call("get", "/webhooks", orgBadmin)).body).toHaveLength(0);
  });

  it("sends a signed call for the chosen events only, and retries failures with a delay", async () => {
    await reset();
    await h.admin.query("DELETE FROM webhook_subscriptions");
    const sub = (await h.call("post", "/webhooks", owner, { label: "ERP", url: URL_OK, events: ["job.done"] })).body;
    const id = await job({ title: "Crate" });
    await h.call("post", `/jobs/${id}/assign`, owner, { driverId: drv });
    await h.call("post", `/jobs/${id}/status`, owner, { status: "started" });
    await h.call("post", `/jobs/${id}/status`, owner, { status: "arrived" });
    await tick();
    expect(calls.filter((c) => c.url === URL_OK)).toHaveLength(0); // nothing subscribed to yet
    receiverStatus = 500;
    await h.call("post", `/jobs/${id}/status`, owner, { status: "done" });
    const t0 = new Date();
    const r1 = await tick(t0);
    expect(r1.webhooks).toMatchObject({ failed: 1 });
    const sent = calls.filter((c) => c.url === URL_OK);
    expect(sent).toHaveLength(1);
    const body = String(sent[0]!.init.body);
    const headers = sent[0]!.init.headers as Record<string, string>;
    const m = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(headers["routenorth-signature"]!);
    expect(m).toBeTruthy();
    expect(createHmac("sha256", sub.secret).update(`${m![1]}.${body}`).digest("hex")).toBe(m![2]);
    expect(JSON.parse(body)).toMatchObject({ kind: "job.done", data: { job: { title: "Crate", status: "done" } } });
    // not due again right away
    expect((await tick(new Date(t0.getTime() + 30_000))).webhooks).toEqual({ ok: 0, failed: 0 });
    // the receiver recovers; the retry after a minute succeeds
    receiverStatus = 200;
    expect((await tick(new Date(t0.getTime() + 61_000))).webhooks).toEqual({ ok: 1, failed: 0 });
    const d = (await h.call("get", `/webhooks/${sub.id}/deliveries`, owner)).body;
    expect(d[0]).toMatchObject({ status: "ok", attempts: 2 });
  });

  it("gives up after the last retry and lets an admin retry by hand", async () => {
    await reset();
    await h.admin.query("DELETE FROM webhook_subscriptions");
    const sub = (await h.call("post", "/webhooks", owner, { label: "ERP", url: URL_OK })).body;
    receiverStatus = 500;
    await job({ title: "Z" });
    let at = Date.now();
    for (let i = 0; i < 8; i++) { await tick(new Date(at)); at += 13 * 3_600_000; }
    const d = (await h.call("get", `/webhooks/${sub.id}/deliveries`, owner)).body;
    expect(d.every((x: { status: string }) => x.status === "failed")).toBe(true);
    expect(d[0].attempts).toBe(6);
    receiverStatus = 200;
    expect((await h.call("post", `/webhooks/deliveries/${d[0].id}/retry`, owner)).status).toBe(200);
    expect((await h.call("get", `/webhooks/${sub.id}/deliveries`, owner)).body.find((x: { id: string }) => x.id === d[0].id).status).toBe("ok");
    const ping = await h.call("post", `/webhooks/${sub.id}/test`, owner);
    expect(ping.body).toMatchObject({ status: "ok" });
  });
});

describe("customer messages", () => {
  it("sends each step once, by email and SMS where available, in the customer's language, and records it", async () => {
    await reset();
    await h.admin.query("UPDATE organizations SET locale = 'fr' WHERE id = $1", [h.orgA]);
    const id = await job({ title: "Colis", customerName: "Marie Tremblay", customerEmail: "marie@example.com", customerPhone: "+14165550123" });
    await h.call("post", `/jobs/${id}/assign`, owner, { driverId: drv });
    await tick(); await tick();
    const email = calls.filter((c) => c.url === "https://email.test/send");
    expect(email).toHaveLength(1);
    const sent = JSON.parse(String(email[0]!.init.body));
    expect(sent.to).toEqual(["marie@example.com"]);
    expect(sent.subject).toBe("Votre livraison est planifiée");
    expect(sent.text).toMatch(/\/j\/[A-Za-z0-9_-]{32}/);
    expect(sent.html).toContain("Ouvrir le suivi");
    const rows = (await h.admin.query("SELECT event, channel, status, error FROM customer_notifications WHERE job_id = $1 ORDER BY channel", [id])).rows;
    expect(rows).toEqual([
      { event: "scheduled", channel: "email", status: "sent", error: null },
      { event: "scheduled", channel: "sms", status: "skipped", error: expect.stringContaining("SMS is not set up") },
    ]);
    await h.admin.query("UPDATE organizations SET locale = 'en' WHERE id = $1", [h.orgA]);
  });

  it("respects a customer who switched messages off, and an organization that switched a step off", async () => {
    await reset();
    await h.admin.query("INSERT INTO customer_prefs (org_id, contact, email_on) VALUES ($1,'quiet@example.com', false)", [h.orgA]);
    const a = await job({ title: "A", customerEmail: "quiet@example.com" });
    await h.call("post", `/jobs/${a}/assign`, owner, { driverId: drv });
    await tick();
    expect(calls.filter((c) => c.url === "https://email.test/send")).toHaveLength(0);
    expect((await h.admin.query("SELECT status, error FROM customer_notifications WHERE job_id = $1", [a])).rows[0]).toMatchObject({ status: "skipped", error: "the customer switched this off" });
    const off = await h.call("put", "/org", owner, { settings: { customerNotify: { events: { scheduled: false } } } });
    expect(off.status).toBe(200);
    const b = await job({ title: "B", customerEmail: "loud@example.com" });
    await h.call("post", `/jobs/${b}/assign`, owner, { driverId: drv });
    await tick();
    expect(calls.filter((c) => c.url === "https://email.test/send")).toHaveLength(0);
    await h.call("put", "/org", owner, { settings: { customerNotify: { events: { scheduled: true } } } });
  });

  it("tells the customer when the driver is 10 minutes away, from the live ETA", async () => {
    await reset();
    const id = await job({ title: "Soon", customerEmail: "near@example.com" });
    const r = await h.call("post", `/jobs/${id}/assign`, owner, { driverId: drv });
    const routeId = r.body.routeId;
    await h.admin.query("UPDATE routes SET status = 'in_progress' WHERE id = $1", [routeId]);
    await h.admin.query("UPDATE stops SET eta = now() + interval '6 minutes' WHERE route_id = $1", [routeId]);
    await tick(); await tick();
    const kinds = (await h.admin.query("SELECT event FROM customer_notifications WHERE job_id = $1 AND channel = 'email' ORDER BY event", [id])).rows.map((x) => x.event);
    expect(kinds).toEqual(["minutes_away", "on_the_way", "scheduled"]);
    const mail = calls.filter((c) => c.url === "https://email.test/send").map((c) => JSON.parse(String(c.init.body)).subject);
    expect(mail).toContain("Your driver is about 6 minutes away");
  });
});

describe("isolation", () => {
  it("other organizations see none of it", async () => {
    await reset();
    await wf({ name: "Mine", trigger: { kind: "job.done" }, actions: [{ type: "create_invoice", params: {} }] });
    expect((await h.call("get", "/r/workflows", orgBadmin)).body.items ?? (await h.call("get", "/r/workflows", orgBadmin)).body).toHaveLength(0);
    expect((await h.call("get", "/automation/events", orgBadmin)).body).toEqual([]);
  });
});
