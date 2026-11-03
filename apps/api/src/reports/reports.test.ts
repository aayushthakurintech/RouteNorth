import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { startHarness, type Harness } from "../test-harness.js";
import { checkTarget, deliver, isSafeWebhookUrl, type Providers } from "../notify/notifier.js";
import { evalFormula } from "@routenorth/shared";

let h: Harness;
let owner: string, viewer: string, orgBadmin: string;
let drvA: string, drvB: string, veh: string;
const sent: { url: string; init: RequestInit }[] = [];
const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
const at = (hhmm: string) => `${day}T${hhmm}:00Z`;
const range = { from: day, to: day };

const stub: Providers = {
  fetch: (async (url: string, init: RequestInit) => { sent.push({ url: String(url), init }); return new Response("ok", { status: 200 }); }) as typeof fetch,
  email: { apiKey: "k", from: "r@example.com", url: "https://mail.test/send" },
  sms: null,
};

async function route(name: string, driver: string, vehicle: string, stops: { win?: string; arrived?: string; status: string; reason?: string; customer?: string }[]) {
  const r = (await h.admin.query("INSERT INTO routes (org_id, name, route_date, vehicle_id, driver_id, status) VALUES ($1,$2,$3,$4,$5,'completed') RETURNING id", [h.orgA, name, day, vehicle, driver])).rows[0].id;
  for (const [i, s] of stops.entries()) {
    const job = (await h.admin.query("INSERT INTO jobs (org_id, title, customer_name) VALUES ($1,$2,$3) RETURNING id", [h.orgA, `Job ${name} ${i}`, s.customer ?? null])).rows[0].id;
    await h.admin.query(
      `INSERT INTO stops (org_id, route_id, sequence, name, lat, lng, window_end, arrived_at, departed_at, status, failure_reason, job_id) VALUES ($1,$2,$3,$4,43.7,-79.4,$5,$6,$6,$7,$8,$9)`,
      [h.orgA, r, i + 1, `Stop ${i + 1}`, s.win ? at(s.win) : null, s.arrived ? at(s.arrived) : null, s.status, s.reason ?? null, job]);
  }
}

beforeAll(async () => {
  h = await startHarness({ notify: stub });
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer");
  viewer = await h.token("view@example.com");
  drvA = await h.addUser(h.orgA, "ann@example.com", "driver", { display_name: "Ann" });
  drvB = await h.addUser(h.orgA, "bob@example.com", "driver", { display_name: "Bob" });
  await h.addUser(h.orgB, "adminb@example.com", "admin");
  orgBadmin = await h.token("adminb@example.com");
  veh = (await h.call("post", "/r/vehicles", owner, { name: "Truck A", capacityKg: 1000 })).body.id;
  await route("North loop", drvA, veh, [
    { win: "10:00", arrived: "09:50", status: "done", customer: "Acme" },
    { win: "11:00", arrived: "11:20", status: "done", customer: "Acme" },
    { win: "13:00", arrived: "12:50", status: "failed", reason: "Nobody home", customer: "Bolt" },
  ]);
  await route("South loop", drvB, veh, [{ win: "10:00", arrived: "09:00", status: "done", customer: "Bolt" }]);
}, 90_000);
afterAll(async () => { await h.close(); });

const spec = (extra: Record<string, unknown> = {}) => ({ dataset: "stops", range, ...extra });
const run = (s: unknown, tok = owner) => h.call("post", "/reports/run", tok, { spec: s });

describe("running reports", () => {
  it("lists datasets and templates", async () => {
    const d = (await h.call("get", "/reports/datasets", owner)).body;
    expect(d.map((x: { key: string }) => x.key)).toContain("stops");
    const t = (await h.call("get", "/reports/templates", owner)).body;
    expect(t.length).toBeGreaterThan(10);
  });

  it("returns rows with filters and sorting", async () => {
    const r = await run(spec({ columns: [{ key: "customer" }, { key: "status" }], filters: [{ key: "status", op: "eq", value: "done" }], sort: { key: "customer", dir: "desc" } }));
    expect(r.status).toBe(200);
    expect(r.body.total).toBe(3);
    expect(r.body.rows[0].customer).toBe("Bolt");
  });

  it("groups and totals", async () => {
    const r = await run(spec({ groupBy: ["customer"], columns: [{ key: "customer" }, { key: "done" }, { key: "failed" }], sort: { key: "customer", dir: "asc" } }));
    expect(r.body.rows).toMatchObject([{ customer: "Acme", done: 2, failed: 0 }, { customer: "Bolt", done: 1, failed: 1 }]);
    expect(r.body.totals.done).toBe(3);
  });

  it("adds calculated fields and rejects unsafe formulas", async () => {
    const ok = await run(spec({ groupBy: ["customer"], columns: [{ key: "customer" }, { key: "done" }], calc: [{ key: "amount", formula: "done * 10 + 1" }], sort: { key: "amount", dir: "asc" } }));
    expect(ok.body.rows.map((x: { amount: number }) => x.amount)).toEqual([11, 21]);
    for (const formula of ["process.exit()", "done; 1", "done +", "a.b"]) {
      expect((await run(spec({ calc: [{ key: "x", formula }] }))).status).toBe(400);
    }
    expect(evalFormula("1 + 2 * 3", {})).toBe(7);
    expect(evalFormula("a / 0", { a: 4 })).toBeNull();
    expect(evalFormula("constructor + 1", {})).toBeNull();
  });

  it("builds a pivot", async () => {
    const r = await run(spec({ pivot: { row: "customer", col: "status", value: "count" } }));
    expect(r.status).toBe(200);
    expect(r.body.pivot).toBeTruthy();
  });

  it("validates input", async () => {
    expect((await run({ dataset: "nope" })).status).toBe(400);
    expect((await run(spec({ columns: [{ key: "bogus" }] }))).status).toBe(400);
    expect((await run(spec({ filters: [{ key: "status", op: "sql", value: 1 }] }))).status).toBe(400);
    expect((await run(spec({ limit: 0 }))).status).toBe(400);
    expect((await run("nope")).status).toBe(400);
  });

  it("ignores a scope sent from the browser", async () => {
    const r = await run(spec({ scope: { driverId: drvA } }));
    expect(r.body.total).toBe(4);
  });

  it("keeps each organization's data apart", async () => {
    expect((await run(spec(), orgBadmin)).body.total).toBe(0);
  });
});

describe("exports", () => {
  const exp = (format: string, tok = owner) => h.call("post", `/reports/export?format=${format}`, tok, { spec: spec({ columns: [{ key: "customer" }, { key: "status" }] }), title: "Daily stops" })
    .buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });

  it("makes a CSV", async () => {
    const r = await exp("csv");
    expect(r.status).toBe(200);
    expect(r.headers["content-disposition"]).toContain("Daily-stops");
    const text = (r.body as Buffer).toString("utf8");
    expect(text.split("\n")[0]).toContain("customer");
    expect(text).toContain("Acme");
  });
  it("makes an Excel file", async () => {
    const r = await exp("xlsx");
    expect(r.status).toBe(200);
    const files = unzipSync(new Uint8Array(r.body as Buffer));
    expect(Object.keys(files)).toContain("xl/workbook.xml");
    const sheet = strFromU8(files["xl/worksheets/sheet1.xml"]!);
    expect(sheet).toContain("Acme");
  });
  it("makes a PDF", async () => {
    const r = await exp("pdf");
    expect(r.status).toBe(200);
    expect((r.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });
  it("makes the executive summary", async () => {
    const r = await h.call("get", `/reports/executive.pdf?from=${day}&to=${day}`, owner).buffer(true).parse((res, cb) => { const c: Buffer[] = []; res.on("data", (d: Buffer) => c.push(d)); res.on("end", () => cb(null, Buffer.concat(c))); });
    expect(r.status).toBe(200);
    expect((r.body as Buffer).subarray(0, 5).toString()).toBe("%PDF-");
  });
  it("rejects unknown formats and people without export permission", async () => {
    expect((await h.call("post", "/reports/export?format=doc", owner, { spec: spec() })).status).toBe(400);
    expect((await exp("csv", viewer)).status).toBe(403);
  });
});

describe("saved reports", () => {
  let id: string;
  it("saves, versions and restores", async () => {
    const c = await h.call("post", "/reports/saved", owner, { name: "Stops", spec: spec(), shared: true });
    expect(c.status).toBe(201);
    id = c.body.id;
    expect(c.body.version).toBe(1);
    const u = await h.call("put", `/reports/saved/${id}`, owner, { name: "Stops v2", spec: spec({ limit: 5 }), note: "smaller" });
    expect(u.body.version).toBe(2);
    expect((await h.call("put", `/reports/saved/${id}`, owner, { shared: true })).body.version).toBe(2); // no change, no new version
    const v = (await h.call("get", `/reports/saved/${id}/versions`, owner)).body;
    expect(v.map((x: { version: number }) => x.version)).toEqual([2, 1]);
    const r = await h.call("post", `/reports/saved/${id}/restore/1`, owner);
    expect(r.body.version).toBe(3);
    const list = (await h.call("get", "/reports/saved", owner)).body;
    expect(list[0]).toMatchObject({ name: "Stops", version: 3 });
    expect((await h.call("post", `/reports/saved/${id}/restore/9`, owner)).status).toBe(404);
  });
  it("lets viewers read shared reports but not change them, and hides them from other organizations", async () => {
    expect((await h.call("get", "/reports/saved", viewer)).body).toHaveLength(1);
    expect((await h.call("put", `/reports/saved/${id}`, viewer, { name: "x" })).status).toBe(403);
    expect((await h.call("get", "/reports/saved", orgBadmin)).body).toHaveLength(0);
    expect((await h.call("delete", `/reports/saved/${id}`, orgBadmin)).status).toBe(404);
  });
  it("shares a link that works without signing in, can be limited to one driver, and can be revoked", async () => {
    const s = await h.call("post", `/reports/saved/${id}/share`, owner, { days: 3, scope: { driverId: drvA } });
    expect(s.status).toBe(201);
    const pub = await h.call("get", `/public/report/${s.body.token}`);
    expect(pub.status).toBe(200);
    expect(pub.body.result.total).toBe(3);
    expect(pub.body.result.spec.scope).toBeUndefined();
    const csv = await h.call("get", `/public/report/${s.body.token}?format=csv`);
    expect(csv.text).toContain("Acme");
    expect((await h.call("get", "/public/report/not-a-real-token-aaaaaaaaaaaa")).status).toBe(404);
    expect((await h.call("post", `/reports/saved/${id}/share`, owner, { days: 400 })).status).toBe(400);
    expect((await h.call("post", `/reports/saved/${id}/share`, viewer, {})).status).toBe(403);
    expect((await h.call("delete", `/reports/shares/${s.body.id}`, owner)).status).toBe(204);
    expect((await h.call("get", `/public/report/${s.body.token}`)).status).toBe(404);
    const stored = (await h.admin.query("SELECT token_hash FROM report_shares WHERE id = $1", [s.body.id])).rows[0].token_hash;
    expect(stored).not.toContain(s.body.token);
  });
  it("sends a saved report to destinations", async () => {
    sent.length = 0;
    const slack = (await h.call("post", "/r/notification-endpoints", owner, { kind: "slack", target: "https://hooks.slack.com/services/T0/B0/xyz", label: "Ops" }));
    const mail = (await h.call("post", "/r/notification-endpoints", owner, { kind: "email", target: "boss@example.com", label: "Boss" }));
    expect(slack.status).toBe(201);
    expect(mail.status).toBe(201);
    const r = await h.call("post", `/reports/saved/${id}/send`, owner, { endpointIds: [slack.body.id, mail.body.id], format: "csv" });
    expect(r.status).toBe(200);
    expect(r.body.results.every((x: { ok: boolean }) => x.ok)).toBe(true);
    expect(sent.map((s) => s.url).sort()).toEqual(["https://hooks.slack.com/services/T0/B0/xyz", "https://mail.test/send"]);
    const mailBody = JSON.parse(String(sent.find((s) => s.url.includes("mail.test"))!.init.body));
    expect(mailBody.to).toEqual(["boss@example.com"]);
    expect(mailBody.attachments[0].filename).toMatch(/\.csv$/);
    expect((await h.call("post", `/reports/saved/${id}/send`, owner, { endpointIds: [] })).status).toBe(400);
    expect((await h.call("post", "/r/notification-endpoints", owner, { kind: "webhook", target: "http://10.0.0.1/hook", label: "bad" })).status).toBe(400);
  });
  it("deletes", async () => {
    expect((await h.call("delete", `/reports/saved/${id}`, owner)).status).toBe(204);
  });
});

describe("notifier", () => {
  it("checks addresses", () => {
    expect(isSafeWebhookUrl("https://example.com/x")).toBe(true);
    for (const u of ["http://example.com", "https://localhost/x", "https://192.168.1.4/x", "https://169.254.169.254/", "https://a:b@example.com/", "nope"]) expect(isSafeWebhookUrl(u)).toBe(false);
    expect(checkTarget("sms", "+14165550123")).toBeNull();
    expect(checkTarget("sms", "4165550123")).not.toBeNull();
    expect(checkTarget("email", "a@b")).not.toBeNull();
  });
  it("says so when email or SMS is not set up", async () => {
    const r = await deliver({ id: "1", kind: "sms", target: "+14165550123", label: "x" }, { subject: "s", text: "t" }, { fetch: stub.fetch });
    expect(r.ok).toBe(false);
    const e = await deliver({ id: "1", kind: "email", target: "a@b.co", label: "x" }, { subject: "s", text: "t" }, { fetch: stub.fetch });
    expect(e.ok).toBe(false);
  });
  it("reports a failing service", async () => {
    const r = await deliver({ id: "1", kind: "webhook", target: "https://example.com/h", label: "x" }, { subject: "s", text: "t" }, { fetch: (async () => new Response("no", { status: 500 })) as typeof fetch });
    expect(r).toEqual({ ok: false, error: "the service answered 500" });
    const t = await deliver({ id: "1", kind: "webhook", target: "https://example.com/h", label: "x" }, { subject: "s", text: "t" }, { fetch: (async () => { throw new Error("boom"); }) as typeof fetch });
    expect(t).toEqual({ ok: false, error: "boom" });
  });
  it("sends the SMS to Twilio's format", async () => {
    sent.length = 0;
    await deliver({ id: "1", kind: "sms", target: "+14165550123", label: "x" }, { subject: "Late", text: "Truck A" }, { fetch: stub.fetch, sms: { accountSid: "AC1", authToken: "tok", from: "+15550001111", url: "https://sms.test/m" } });
    expect(String(sent[0]!.init.body)).toContain("To=%2B14165550123");
  });
});
