import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SECRET, startHarness, type Harness } from "../test-harness.js";
import type { Providers } from "../notify/notifier.js";
import { runAutomationOrg } from "../automation/processor.js";
import { linkToken } from "./links.js";
import { resetLimits } from "./public.controller.js";
import { estimateQuote } from "./invoices.js";
import { renderCustomerMessage } from "./templates.js";
import { customerOptions } from "./settings.js";

let h: Harness, owner: string, viewer: string, drvTok: string, drv: string, cust: string, other: string;
const calls: { url: string; init: RequestInit }[] = [];
const stub: Providers = { fetch: (async (url: string, init: RequestInit) => { calls.push({ url: String(url), init }); return new Response("ok"); }) as typeof fetch, email: { apiKey: "k", from: "x@example.com", url: "https://email.test/send" }, sms: null };
const tick = () => runAutomationOrg(h.app, { providers: stub, secret: SECRET }, h.orgA);
const job = async (o: Record<string, unknown> = {}) => (await h.call("post", "/r/jobs", owner, { title: "Parcel", lat: 43.7, lng: -79.4, customerName: "Marie Tremblay", customerEmail: "marie@example.com", ...o })).body.id as string;
const tokenFor = async (jobId: string) => { await tick(); const id = (await h.admin.query("SELECT id FROM job_links WHERE job_id = $1", [jobId])).rows[0]?.id; return id ? linkToken(SECRET, id) : null; };
const linkOf = async (jobId: string) => { const { ensureJobLink } = await import("./links.js"); const c = await h.app.connect(); try { await c.query("BEGIN"); await c.query("SELECT set_config('app.org_id',$1,true)", [h.orgA]); const l = await ensureJobLink(c, h.orgA, jobId, SECRET); await c.query("COMMIT"); return l.token; } finally { c.release(); } };
const get = (t: string) => h.call("get", `/public/job/${t}`);
const reset = async () => { await h.admin.query("DELETE FROM customer_requests; DELETE FROM feedback; DELETE FROM messages; DELETE FROM job_links; DELETE FROM customer_notifications; DELETE FROM automation_events; DELETE FROM invoices; DELETE FROM jobs; DELETE FROM routes; DELETE FROM alerts"); calls.length = 0; resetLimits(); };
const setOrg = async (settings: Record<string, unknown>) => expect((await h.call("put", "/org", owner, { settings })).status).toBe(200);

beforeAll(async () => {
  h = await startHarness({ notify: stub });
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer"); viewer = await h.token("view@example.com");
  drv = await h.addUser(h.orgA, "ann@example.com", "driver", { display_name: "Ann Lee" }); drvTok = await h.token("ann@example.com");
  await h.addUser(h.orgA, "marie@example.com", "customer", { display_name: "Marie" }); cust = await h.token("marie@example.com");
  await h.addUser(h.orgA, "bob@example.com", "customer"); other = await h.token("bob@example.com");
  await h.admin.query("INSERT INTO depots (org_id, name, lat, lng) VALUES ($1,'Main',43.65,-79.38)", [h.orgA]);
}, 90_000);
afterAll(async () => { await h.close(); });

describe("pure helpers", () => {
  it("prices from the organization's own rates, with a minimum and a rush surcharge", () => {
    const b = { enabled: true, baseFee: 15, perKm: 1, perKg: 0.1, rushPct: 50, minimum: 20, requirePhone: false };
    const q = estimateQuote(b, "CAD", { from: { lat: 43.65, lng: -79.38 }, to: { lat: 43.75, lng: -79.38 }, weightKg: 10 });
    expect(q.distanceKm).toBeGreaterThan(14); expect(q.distanceKm).toBeLessThan(15.5);
    expect(q.total).toBeCloseTo(15 + q.distance + 1, 1);
    expect(estimateQuote(b, "CAD", { to: { lat: 0, lng: 0 }, weightKg: 0 }).total).toBe(20);
    expect(estimateQuote(b, "CAD", { to: { lat: 0, lng: 0 }, rush: true }).total).toBe(30);
  });
  it("writes messages in both languages, escapes names, and brands the email", () => {
    const vars = { customer: "<b>Marie</b>", org: "Nord", ref: "A1", title: "Colis", link: "https://x.test/j/abc", window: "", reason: "", driverWith: "" };
    const fr = renderCustomerMessage("delivered", "fr", vars, { name: "Nord", color: "#aa0000" });
    expect(fr.subject).toBe("Livré : Colis");
    expect(fr.html).toContain("&lt;b&gt;Marie&lt;/b&gt;");
    expect(fr.html).toContain("#aa0000");
    expect(fr.sms).toContain("https://x.test/j/abc");
    const custom = renderCustomerMessage("delivered", "en", vars, { name: "Nord", color: null }, { sms: { body: "Hi {{customer}}!" } });
    expect(custom.sms).toBe("Hi <b>Marie</b>!");
  });
  it("reads customer options with defaults", () => {
    const o = customerOptions({});
    expect(o.notify.events.minutes_away).toBe(true); expect(o.notify.events.stops_away).toBe(false);
    expect(o.portal.showDriver).toBe(false); expect(o.booking.enabled).toBe(false); expect(o.portal.slots).toHaveLength(3);
  });
});

describe("settings", () => {
  it("validates the customer options and keeps other switches when one changes", async () => {
    expect((await h.call("put", "/org", owner, { settings: { customerNotify: { minutesAway: 500 } } })).status).toBe(400);
    expect((await h.call("put", "/org", owner, { settings: { customerNotify: { events: { bogus: true } } } })).status).toBe(400);
    expect((await h.call("put", "/org", owner, { settings: { customerPortal: { slots: [{ label: "x", start: "10:00", end: "09:00" }] } } })).status).toBe(400);
    await setOrg({ customerNotify: { minutesAway: 15 } });
    await setOrg({ customerNotify: { stopsAway: 2 } });
    const s = (await h.admin.query("SELECT settings FROM organizations WHERE id = $1", [h.orgA])).rows[0].settings.customerNotify;
    expect(s).toMatchObject({ minutesAway: 15, stopsAway: 2 });
    await setOrg({ customerNotify: { minutesAway: 10, stopsAway: 3 } });
  });
});

describe("customer job page", () => {
  it("shows status without sign-in, hides the driver until the company opts in, and refuses bad links", async () => {
    await reset();
    const id = await job({ title: "Sofa" });
    await h.call("post", `/jobs/${id}/assign`, owner, { driverId: drv });
    const t = (await tokenFor(id))!;
    expect(t).toMatch(/^[A-Za-z0-9_-]{32}$/);
    const page = (await get(t)).body;
    expect(page.job).toMatchObject({ title: "Sofa", status: "assigned", customer: "Marie" });
    expect(page.driver).toBeNull();
    expect(JSON.stringify(page)).not.toContain("marie@example.com");
    await setOrg({ customerPortal: { showDriver: true } });
    expect((await get(t)).body.driver).toMatchObject({ name: "Ann" });
    await setOrg({ customerPortal: { showDriver: false } });
    expect((await get("x".repeat(32))).status).toBe(404);
    expect((await get("short")).status).toBe(404);
    await h.admin.query("UPDATE job_links SET revoked_at = now()");
    expect((await get(t)).status).toBe(404);
  });

  it("lets the customer leave instructions that reach the driver", async () => {
    await reset();
    const id = await job({ title: "Box" });
    await h.call("post", `/jobs/${id}/assign`, owner, { driverId: drv });
    const t = await linkOf(id);
    const r = await h.call("put", `/public/job/${t}/instructions`, undefined, { text: "Gate code 4521, leave at the door" });
    expect(r.status).toBe(200);
    const routes = (await h.call("get", "/driver/routes?date=" + new Date().toISOString().slice(0, 10), drvTok)).body;
    const all = (await h.admin.query("SELECT customer_instructions FROM jobs WHERE id = $1", [id])).rows[0];
    expect(all.customer_instructions).toContain("4521");
    void routes;
    const msgs = (await h.call("get", "/driver/messages", drvTok)).body;
    expect(msgs.some((m: { body: string }) => m.body.includes("Gate code 4521"))).toBe(true);
    expect((await h.call("put", `/public/job/${t}/instructions`, undefined, { text: "x".repeat(600) })).status).toBe(400);
  });

  it("reschedules into a free window, refuses full windows and late changes, and cancels", async () => {
    await reset();
    const id = await job({ title: "Table", scheduledDate: "2099-01-05" });
    await h.call("post", `/jobs/${id}/assign`, owner, { driverId: drv });
    const t = await linkOf(id);
    const slots = (await h.call("get", `/public/job/${t}/slots`)).body;
    expect(slots.length).toBeGreaterThan(5);
    const day = slots.find((d: { slots: unknown[] }) => d.slots.length)!.date;
    expect((await h.call("post", `/public/job/${t}/reschedule`, undefined, { date: "2000-01-01", slot: 0 })).status).toBe(400);
    await setOrg({ customerPortal: { slotCapacity: 1 } });
    const r = await h.call("post", `/public/job/${t}/reschedule`, undefined, { date: day, slot: 1 });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const j = (await h.admin.query("SELECT status, scheduled_date::text AS d, driver_id, reason_code FROM jobs WHERE id = $1", [id])).rows[0];
    expect(j).toMatchObject({ status: "unassigned", d: day, driver_id: null, reason_code: "customer_request" });
    // the window is now full for someone else
    const id2 = await job({ title: "Chair" });
    const t2 = await linkOf(id2);
    const full = await h.call("post", `/public/job/${t2}/reschedule`, undefined, { date: day, slot: 1 });
    expect(full.status).toBe(409);
    await setOrg({ customerPortal: { slotCapacity: 20 } });
    // too close to the window: refused
    await h.admin.query("UPDATE jobs SET window_start = now() + interval '20 minutes', window_end = now() + interval '2 hours' WHERE id = $1", [id2]);
    const late = await h.call("post", `/public/job/${t2}/reschedule`, undefined, { date: day, slot: 0 });
    expect(late.status).toBe(409);
    expect(late.body.message).toMatch(/too close/);
    await h.admin.query("UPDATE jobs SET window_start = NULL, window_end = NULL WHERE id = $1", [id2]);
    expect((await h.call("post", `/public/job/${t2}/cancel`, undefined, { note: "changed my mind" })).status).toBe(201);
    expect((await h.admin.query("SELECT status, reason_code FROM jobs WHERE id = $1", [id2])).rows[0]).toMatchObject({ status: "cancelled", reason_code: "customer_cancelled" });
    expect((await h.call("post", `/public/job/${t2}/cancel`, undefined, {})).status).toBe(409);
    const alerts = (await h.call("get", "/alerts?status=open", owner)).body;
    expect(alerts.some((a: { title: string }) => a.title.includes("cancelled"))).toBe(true);
  });

  it("shows the proof of delivery, takes a rating once delivered, and a return request", async () => {
    await reset();
    const id = await job({ title: "Lamp", customerPhone: "+14165550123" });
    await h.call("post", `/jobs/${id}/assign`, owner, { driverId: drv });
    const t = await linkOf(id);
    expect((await h.call("post", `/public/job/${t}/feedback`, undefined, { csat: 5 })).status).toBe(409);
    expect((await h.call("post", `/public/job/${t}/return`, undefined, { kind: "return" })).status).toBe(409);
    const stop = (await h.call("get", `/jobs/${id}`, owner)).body.job.stop_id;
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==", "base64");
    expect((await h.admin.query("INSERT INTO proofs (org_id, stop_id, kind, content_type, size_bytes, data, taken_at, client_id) VALUES ($1,$2,'photo','image/png',$3,$4,now(),gen_random_uuid()) RETURNING id", [h.orgA, stop, png.length, png])).rowCount).toBe(1);
    await h.call("post", `/jobs/${id}/status`, owner, { status: "started" });
    await h.call("post", `/jobs/${id}/status`, owner, { status: "arrived" });
    await h.call("post", `/jobs/${id}/status`, owner, { status: "done" });
    const page = (await get(t)).body;
    expect(page.proofs).toHaveLength(1);
    const img = await h.call("get", `/public/job/${t}/proof/${page.proofs[0].id}`);
    expect(img.status).toBe(200);
    expect(img.headers["content-type"]).toContain("image/png");
    // someone else's link cannot read it
    const id2 = await job({ title: "Other" });
    const t2 = await linkOf(id2);
    expect((await h.call("get", `/public/job/${t2}/proof/${page.proofs[0].id}`)).status).toBe(404);
    expect((await h.call("post", `/public/job/${t}/feedback`, undefined, { csat: 9 })).status).toBe(400);
    expect((await h.call("post", `/public/job/${t}/feedback`, undefined, { csat: 5, nps: 10, comment: "great" })).status).toBe(201);
    await h.call("post", `/public/job/${t}/feedback`, undefined, { csat: 4 });
    expect((await h.admin.query("SELECT csat, job_id FROM feedback")).rows).toEqual([{ csat: 4, job_id: id }]);
    const ret = await h.call("post", `/public/job/${t}/return`, undefined, { kind: "return", note: "too big" });
    expect(ret.status, JSON.stringify(ret.body)).toBe(201);
    expect((await h.admin.query("SELECT type, title, source, parent_job_id, status FROM jobs WHERE parent_job_id = $1", [id])).rows[0]).toMatchObject({ type: "pickup", title: "Return: Lamp", source: "return", status: "unassigned" });
    expect((await h.call("post", `/public/job/${t}/return`, undefined, { kind: "return" })).status).toBe(409);
  });

  it("chats with the office and honours notification preferences", async () => {
    await reset();
    const id = await job({ title: "Desk" });
    const t = await linkOf(id);
    expect((await h.call("post", `/public/job/${t}/message`, undefined, { body: "Can you come after 3?" })).status).toBe(201);
    const threads = (await h.call("get", "/messages/threads?kind=customer", owner)).body;
    expect(threads[0]).toMatchObject({ id, unread: 1 });
    expect((await h.call("get", "/messages/unread", owner)).body.customers).toBe(1);
    expect((await h.call("post", `/messages/thread/customer/${id}`, viewer, { body: "no" })).status).toBe(403);
    const reply = await h.call("post", `/messages/thread/customer/${id}`, owner, { body: "Yes, we will arrive after 3pm." });
    expect(reply.status).toBe(201);
    expect(reply.body.customer).toContain("email: sent");
    expect(calls.some((c) => c.url === "https://email.test/send" && String(c.init.body).includes("after 3pm"))).toBe(true);
    expect((await get(t)).body.messages.map((m: { from: string }) => m.from)).toEqual(["customer", "dispatch"]);
    expect((await h.call("get", `/messages/thread/customer/${id}`, owner)).body).toHaveLength(2);
    expect((await h.call("get", "/messages/unread", owner)).body.customers).toBe(0);
    expect((await h.call("put", `/public/job/${t}/prefs`, undefined, { emailOn: false, mutedEvents: ["arrived"], locale: "fr" })).status).toBe(200);
    expect((await get(t)).body.prefs).toMatchObject({ emailOn: false, mutedEvents: ["arrived"], locale: "fr" });
  });
});

describe("booking, status and help pages", () => {
  const slug = async () => (await h.admin.query("SELECT slug FROM organizations WHERE id = $1", [h.orgA])).rows[0].slug as string;
  it("gives every organization its own address, even with the same name", async () => {
    const a = await h.admin.query("INSERT INTO organizations (name) VALUES ('Acme Trucking') RETURNING slug");
    const b = await h.admin.query("INSERT INTO organizations (name) VALUES ('Acme Trucking') RETURNING slug");
    expect(a.rows[0].slug).toBe("acme-trucking");
    expect(b.rows[0].slug).toMatch(/^acme-trucking-[0-9a-f]{4}$/);
  });
  it("keeps booking switched off until the company enables it, then quotes and books", async () => {
    await reset();
    const s = await slug();
    expect((await h.call("post", `/public/org/${s}/quote`, undefined, { address: "1 Main St", lat: 43.75, lng: -79.38 })).status).toBe(404);
    expect((await h.call("get", "/public/org/nope-nope")).status).toBe(404);
    expect((await h.call("get", `/public/org/${s}`)).body.booking).toEqual({ enabled: false });
    await setOrg({ booking: { enabled: true, baseFee: 10, perKm: 1, perKg: 0, rushPct: 50, minimum: 12 } });
    const q = await h.call("post", `/public/org/${s}/quote`, undefined, { address: "1 Main St", lat: 43.75, lng: -79.38 });
    expect(q.status).toBe(201);
    expect(q.body).toMatchObject({ estimated: true, distanceKnown: true, currency: "CAD" });
    expect(q.body.total).toBeGreaterThan(20);
    expect(q.body.totalWithTax).toBeCloseTo(q.body.total * 1.13, 1);
    const rush = await h.call("post", `/public/org/${s}/quote`, undefined, { address: "1 Main St", lat: 43.75, lng: -79.38, rush: true });
    expect(rush.body.total).toBeCloseTo(q.body.total * 1.5, 1);
    const bad = await h.call("post", `/public/org/${s}/book`, undefined, { name: "Sam", address: "1 Main St", description: "Chair" });
    expect(bad.status).toBe(400);
    expect((await h.call("post", `/public/org/${s}/book`, undefined, { name: "Sam", email: "sam@example.com", address: "1 Main St", description: "Chair", website: "http://spam" })).body).toEqual({ ok: true });
    expect((await h.admin.query("SELECT count(*)::int AS n FROM jobs")).rows[0].n).toBe(0);
    const ok = await h.call("post", `/public/org/${s}/book`, undefined, { name: "Sam Lee", email: "sam@example.com", address: "1 Main St", lat: 43.75, lng: -79.38, description: "Chair", weightKg: 8, date: new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10), slot: 0 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(ok.body.track).toMatch(/^\/j\//);
    const j = (await h.admin.query("SELECT source, status, price::float AS price, ref, window_start FROM jobs")).rows[0];
    expect(j).toMatchObject({ source: "booking", status: "unassigned", ref: expect.stringMatching(/^WEB-\d{4}$/) });
    expect(j.price).toBeCloseTo(ok.body.price, 2);
    expect(j.window_start).not.toBeNull();
    // the customer gets a "we received it" email with their link
    await tick();
    const mail = calls.filter((c) => c.url === "https://email.test/send").map((c) => JSON.parse(String(c.init.body)));
    expect(mail[0].subject).toBe("We received your order");
    expect(mail[0].text).toContain(ok.body.track);
    const page = await h.call("get", `/public${ok.body.track.replace("/j/", "/job/")}`);
    expect(page.body.job.status).toBe("unassigned");
    await setOrg({ booking: { enabled: false } });
  });
  it("publishes service health, notices and the FAQ", async () => {
    await reset();
    const s = await slug();
    const st = (await h.call("get", `/public/org/${s}/status`)).body;
    expect(st.level).toBe("operational");
    await h.call("post", "/r/status-notices", owner, { level: "major", title: "Snow delays", body: "Expect delays today" });
    expect((await h.call("get", `/public/org/${s}/status`)).body.level).toBe("major");
    expect((await h.call("post", "/r/status-notices", viewer, { level: "info", title: "x" })).status).toBe(403);
    await h.call("post", "/r/faq-items", owner, { question: "When do you deliver?", answer: "8 to 8", lang: "en" });
    await h.call("post", "/r/faq-items", owner, { question: "Quand livrez-vous ?", answer: "8 h à 20 h", lang: "fr" });
    await h.call("post", "/r/faq-items", owner, { question: "Hidden", answer: "no", published: false });
    expect((await h.call("get", `/public/org/${s}/faq?lang=fr`)).body.map((x: { question: string }) => x.question)).toEqual(["Quand livrez-vous ?"]);
    expect((await h.call("get", `/public/org/${s}/faq`)).body).toHaveLength(2);
    await setOrg({ publicStatus: false });
    expect((await h.call("get", `/public/org/${s}/status`)).status).toBe(404);
    await setOrg({ publicStatus: true });
  });
});

describe("customer portal and invoices", () => {
  it("shows a customer only their own orders and invoices", async () => {
    await reset();
    await job({ title: "Mine", price: 50 });
    await job({ title: "Not mine", customerEmail: "someone@else.com" });
    const orders = (await h.call("get", "/portal/orders", cust)).body;
    expect(orders.orders.map((o: { title: string }) => o.title)).toEqual(["Mine"]);
    expect(orders.orders[0].track).toMatch(/^\/j\//);
    expect((await h.call("get", "/portal/orders", other)).body.orders).toEqual([]);
    expect((await h.call("get", "/portal/orders", viewer)).status).toBe(403);
    const id = (await h.admin.query("SELECT id FROM jobs WHERE title = 'Mine'")).rows[0].id;
    const inv = await h.call("post", `/invoices/for-job/${id}`, owner);
    expect(inv.status).toBe(201);
    expect((await h.call("post", `/invoices/for-job/${id}`, owner)).body.existing).toBe(true);
    expect((await h.call("get", "/portal/invoices", cust)).body).toHaveLength(1); // a sent invoice
    expect((await h.call("get", "/portal/invoices", other)).body).toEqual([]);
    const pdf = await h.call("get", `/portal/invoices/${inv.body.id}/pdf`, cust).buffer(true).parse((res, cb) => { const d: Buffer[] = []; res.on("data", (x: Buffer) => d.push(x)); res.on("end", () => cb(null, Buffer.concat(d))); });
    expect(pdf.status).toBe(200);
    expect((pdf.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
    expect((await h.call("get", `/portal/invoices/${inv.body.id}/pdf`, other)).status).toBe(404);
    const list = (await h.call("get", "/invoices", owner)).body;
    expect(list.items).toHaveLength(1); expect(list.totals.outstanding).toBeCloseTo(56.5, 1);
    expect((await h.call("patch", `/invoices/${inv.body.id}`, owner, { status: "paid" })).body.status).toBe("paid");
    expect((await h.call("get", "/invoices", owner)).body.totals).toMatchObject({ outstanding: 0, paid: 56.5 });
    expect((await h.call("get", "/invoices", cust)).status).toBe(403);
    expect((await h.call("post", "/portal/support", cust, { body: "Where is my order?", jobId: id })).status).toBe(201);
    expect((await h.call("get", `/portal/support?jobId=${id}`, cust)).body).toHaveLength(1);
    expect((await h.call("post", "/portal/support", other, { body: "hi", jobId: id })).status).toBe(404);
  });
});
