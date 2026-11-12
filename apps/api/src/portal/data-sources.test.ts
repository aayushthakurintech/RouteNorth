import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Providers } from "../notify/notifier.js";
import { startHarness, type Harness } from "../test-harness.js";

let h: Harness, owner: string, driver: string, orgB: string;
const sent: { url: string; body: string }[] = [];
let emailOn = false;
const stub = (): Providers => ({
  fetch: (async (url: string, init: RequestInit) => { sent.push({ url: String(url), body: String(init.body) }); return new Response("{}"); }) as typeof fetch,
  email: emailOn ? { apiKey: "k", from: "RouteNorth <a@b.ca>", url: "https://mail.test/send" } : null, sms: null,
});
const get = (p: string, t: string) => h.call("get", p, t);
const sql = (q: string, p: unknown[] = []) => h.admin.query(q, p);
const src = async (id: string, token = owner) => ((await get("/portal/data-sources", token)).body.sources as { id: string; state: string; summary: string; needs: string[]; next: { href: string } | null; lastDataAt: string | null; canTest: boolean }[]).find((s) => s.id === id)!;

beforeAll(async () => {
  h = await startHarness({ notify: stub() });
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "drv@example.com", "driver"); driver = await h.token("drv@example.com");
  await h.addUser(h.orgB, "adminb@example.com", "admin"); orgB = await h.token("adminb@example.com");
});
afterAll(async () => { await h.close(); });

describe("data sources page", () => {
  it("says nothing is connected on a fresh company, with what to do next", async () => {
    const r = await get("/portal/data-sources", owner);
    expect(r.status).toBe(200);
    expect(r.body.sources.map((s: { id: string }) => s.id)).toEqual(expect.arrayContaining(["trackers", "phone-feed", "driver-app", "orders-booking", "orders-email", "orders-store", "files", "routing", "geocoder", "email", "sms", "webhooks", "eld", "fuel-cards", "accounting"]));
    const t = await src("trackers");
    expect(t.state).toBe("not_connected");
    expect(t.next?.href).toBe("/devices");
    expect((await src("email")).state).toBe("needs_setup");
    expect((await src("email")).needs.join(" ")).toContain("RESEND_API_KEY");
    expect((await src("eld")).state).toBe("not_built");
    expect((await src("files")).state).toBe("not_connected");
    expect(r.body.totals).toEqual(expect.objectContaining({ vehicles: expect.any(Number), drivers: expect.any(Number), orders: expect.any(Number) }));
  });

  it("is only for people who run the account, and only about their own company", async () => {
    expect((await get("/portal/data-sources", driver)).status).toBe(403);
    expect((await get("/portal/data-sources", "")).status).toBe(401);
    const veh = (await sql("INSERT INTO vehicles (org_id, name, kind) VALUES ($1,'T9','truck') RETURNING id", [h.orgA])).rows[0].id;
    const dev = (await sql("INSERT INTO devices (org_id, vehicle_id, source, external_id) VALUES ($1,$2,'traccar','imei-1') RETURNING id", [h.orgA, veh])).rows[0].id;
    await sql("INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed, ignition, satellites) VALUES ($1,$2, now(), 43.7, -79.4, 40, true, 9)", [dev, h.orgA]);
    expect((await src("trackers", orgB)).state).toBe("not_connected");
    const mine = await src("trackers");
    expect(mine.state).toBe("live");
    expect(mine.summary).toMatch(/1 tracker/);
    expect(mine.lastDataAt).toBeTruthy();
  });

  it("calls a tracker that stopped reporting a problem, and demo vehicles are not real trackers", async () => {
    await sql("UPDATE latest_positions SET time = now() - interval '3 hours'");
    expect((await src("trackers")).state).toBe("problem");
    expect((await get("/portal/data-sources", owner)).body.needsAttention).toBeGreaterThanOrEqual(1);
    await sql("DELETE FROM latest_positions"); await sql("DELETE FROM devices");
    const veh = (await sql("SELECT id FROM vehicles LIMIT 1")).rows[0].id;
    const dev = (await sql("INSERT INTO devices (org_id, vehicle_id, source, external_id) VALUES ($1,$2,'simulator','sim-1') RETURNING id", [h.orgA, veh])).rows[0].id;
    await sql("INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed) VALUES ($1,$2, now(), 43.7, -79.4, 40)", [dev, h.orgA]);
    const t = await src("trackers");
    expect(t.state).toBe("not_connected");
    expect(t.summary).toMatch(/demo/i);
  });

  it("counts orders by where they came from and notices imports", async () => {
    await sql("INSERT INTO jobs (org_id, title, source) VALUES ($1,'Booked','booking'), ($1,'Sent by API','api')", [h.orgA]);
    expect((await src("orders-booking")).state).toBe("live");
    expect((await src("orders-booking")).summary).toMatch(/1 order/);
    expect((await src("orders-store")).state).toBe("live");
    expect((await src("orders-email")).state).toBe("not_connected");
    await sql("INSERT INTO jobs (org_id, title, source) VALUES ($1,'From a file','import')", [h.orgA]);
    expect((await src("files")).state).toBe("live");
  });

  it("shows failing webhooks and the driver app", async () => {
    const sub = (await sql("INSERT INTO webhook_subscriptions (org_id, label, url, secret, events, active) VALUES ($1,'Hook','https://x.test/hook','s','{*}',true) RETURNING id", [h.orgA])).rows[0];
    await sql("INSERT INTO webhook_deliveries (org_id, subscription_id, kind, payload, status) VALUES ($1,$2,'ping','{}','failed')", [h.orgA, sub.id]);
    expect((await src("webhooks")).state).toBe("problem");
    const drv = (await sql("SELECT id FROM users WHERE email = 'drv@example.com'")).rows[0].id;
    await sql("INSERT INTO shifts (org_id, driver_id, started_at) VALUES ($1,$2, now() - interval '1 hour')", [h.orgA, drv]);
    const d = await src("driver-app");
    expect(d.state).toBe("live");
    expect(d.summary).toMatch(/1 shift/);
  });

  it("test email: refuses when email is not set up, sends to the person who asked when it is", async () => {
    expect((await src("email")).canTest).toBe(false);
    const no = await h.call("post", "/portal/data-sources/test-email", owner);
    expect(no.body.ok).toBe(false);
    expect(no.body.error).toContain("RESEND_API_KEY");
    expect((await h.call("post", "/portal/data-sources/test-email", driver)).status).toBe(403);
  });
});

describe("data sources page with email set up", () => {
  let h2: Harness, t2: string;
  beforeAll(async () => { emailOn = true; h2 = await startHarness({ notify: stub() }); t2 = await h2.token("a@example.com"); });
  afterAll(async () => { await h2.close(); emailOn = false; });
  it("offers a test button and sends the test to the person who asked", async () => {
    sent.length = 0;
    const list = (await h2.call("get", "/portal/data-sources", t2)).body.sources as { id: string; state: string; canTest: boolean }[];
    const email = list.find((x) => x.id === "email")!;
    expect(email.canTest).toBe(true);
    expect(email.state).toBe("quiet");
    const r = await h2.call("post", "/portal/data-sources/test-email", t2);
    expect(r.body).toEqual({ ok: true, to: "a@example.com" });
    expect(sent.some((m) => m.body.includes("a@example.com") && m.body.includes("RouteNorth test email"))).toBe(true);
  });
});
