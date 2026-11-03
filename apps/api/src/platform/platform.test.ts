import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";

let h: Harness, owner: string, viewer: string, ownerB: string;
const mk = async (token: string, body: Record<string, unknown>) => (await h.call("post", "/platform/keys", token, body)).body as { id: string; key: string; prefix: string };
const raw = (path: string) => request(h.nest.getHttpServer()).get(path);

beforeAll(async () => {
  h = await startHarness();
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer"); viewer = await h.token("view@example.com");
  await h.addUser(h.orgB, "adminb@example.com", "owner"); ownerB = await h.token("adminb@example.com");
});
afterAll(async () => { await h.close(); });

describe("API keys", () => {
  it("shows the key once and stores only a hash", async () => {
    const k = await mk(owner, { name: "Zapier", scope: "read" });
    expect(k.key).toMatch(/^rn_api_/);
    const list = (await h.call("get", "/platform/keys", owner)).body as Record<string, unknown>[];
    expect(JSON.stringify(list)).not.toContain(k.key);
    expect(list.find((x) => x.id === k.id)).toMatchObject({ name: "Zapier", prefix: k.prefix, scope: "read" });
    const stored = (await h.admin.query("SELECT key_hash FROM api_keys WHERE id = $1", [k.id])).rows[0].key_hash;
    expect(stored).toMatch(/^[0-9a-f]{64}$/);
  });
  it("only people who manage the API can make or list keys", async () => {
    expect((await h.call("post", "/platform/keys", viewer, { name: "x" })).status).toBe(403);
    expect((await h.call("get", "/platform/keys", viewer)).status).toBe(403);
  });
  it("a read key reads but cannot write", async () => {
    const k = await mk(owner, { name: "reader", scope: "read" });
    expect((await h.call("get", "/vehicles/live", k.key)).status).toBe(200);
    expect((await h.call("get", "/r/vehicles", k.key)).status).toBe(200);
    expect((await h.call("post", "/r/vehicles", k.key, { name: "Van 1" })).status).toBe(403);
  });
  it("a write key acts like a dispatcher, never an administrator", async () => {
    const k = await mk(owner, { name: "writer", scope: "write" });
    const made = await h.call("post", "/r/vehicles", k.key, { name: "Van 2" });
    expect(made.status).toBe(201);
    expect((await h.call("get", "/platform/keys", k.key)).status).toBe(403);
    expect((await h.call("put", "/org", k.key, { name: "Hijacked" })).status).toBe(403);
    expect((await h.call("get", "/users", k.key)).status).toBeLessThan(500);
  });
  it("a revoked or expired key stops working at once", async () => {
    const k = await mk(owner, { name: "temp" });
    expect((await h.call("get", "/r/vehicles", k.key)).status).toBe(200);
    expect((await h.call("delete", `/platform/keys/${k.id}`, owner)).status).toBe(200);
    expect((await h.call("get", "/r/vehicles", k.key)).status).toBe(401);
    const e = await mk(owner, { name: "old", expiresInDays: 1 });
    await h.admin.query("UPDATE api_keys SET expires_at = now() - interval '1 minute' WHERE id = $1", [e.id]);
    expect((await h.call("get", "/r/vehicles", e.key)).status).toBe(401);
  });
  it("a made-up key is refused and feed or inbound keys do not open the API", async () => {
    expect((await h.call("get", "/r/vehicles", "rn_api_" + "a".repeat(40))).status).toBe(401);
    const f = await mk(owner, { name: "sheet", kind: "feed" });
    expect((await h.call("get", "/r/vehicles", f.key)).status).toBe(401);
  });
  it("a key only sees its own company", async () => {
    await h.admin.query("INSERT INTO vehicles (org_id, name) VALUES ($1,'A-only-vehicle'), ($2,'B-only-vehicle')", [h.orgA, h.orgB]);
    const k = await mk(ownerB, { name: "b key" });
    const rows = (await h.call("get", "/r/vehicles", k.key)).body as { name: string }[];
    expect(rows.map((r) => r.name)).toContain("B-only-vehicle");
    expect(rows.map((r) => r.name)).not.toContain("A-only-vehicle");
  });
  it("validates the request", async () => {
    expect((await h.call("post", "/platform/keys", owner, { name: "" })).status).toBe(400);
    expect((await h.call("post", "/platform/keys", owner, { name: "x", kind: "nope" })).status).toBe(400);
    expect((await h.call("post", "/platform/keys", owner, { name: "x", scope: "admin" })).status).toBe(400);
    expect((await h.call("post", "/platform/keys", owner, { name: "x", expiresInDays: 0 })).status).toBe(400);
  });
});

describe("feeds", () => {
  let feed: string, api: string;
  beforeAll(async () => {
    feed = (await mk(owner, { name: "sheet", kind: "feed" })).key;
    api = (await mk(owner, { name: "bi", kind: "api" })).key;
    await h.admin.query("DELETE FROM jobs");
    await h.admin.query("INSERT INTO jobs (org_id, title, scheduled_date, status) VALUES ($1,'Feed job, one', current_date, 'unassigned')", [h.orgA]);
  });
  it("needs a feed key, from the link or a header", async () => {
    expect((await raw("/feeds/data/jobs")).status).toBe(401);
    expect((await raw("/feeds/data/jobs?key=nope")).status).toBe(401);
    expect((await raw(`/feeds/data/jobs?key=${feed}`)).status).toBe(200);
    expect((await raw("/feeds/data/jobs").set("Authorization", `Bearer ${api}`)).status).toBe(200);
  });
  it("gives CSV, JSON and one-record-per-line files", async () => {
    const csv = await raw(`/feeds/data/jobs?key=${feed}`);
    expect(csv.headers["content-type"]).toContain("text/csv");
    expect(csv.text).toContain("Feed job, one");
    const js = await raw(`/feeds/data/jobs?key=${feed}&format=json`);
    expect(js.body.rows.some((r: { title: string }) => r.title === "Feed job, one")).toBe(true);
    const nd = await raw(`/feeds/data/jobs?key=${feed}&format=ndjson`);
    expect(nd.headers["content-type"]).toContain("x-ndjson");
    for (const l of nd.text.trim().split("\n")) expect(() => JSON.parse(l)).not.toThrow();
  });
  it("rejects unknown datasets, formats and dates", async () => {
    expect((await raw(`/feeds/data/secrets?key=${feed}`)).status).toBe(400);
    expect((await raw(`/feeds/data/jobs?key=${feed}&format=xml`)).status).toBe(400);
    expect((await raw(`/feeds/data/jobs?key=${feed}&from=x&to=y`)).status).toBe(400);
    expect((await raw(`/feeds/data/jobs?key=${feed}&from=2020-01-01&to=2026-01-01`)).status).toBe(400);
  });
  it("never shows another company's rows", async () => {
    await h.admin.query("INSERT INTO jobs (org_id, title, scheduled_date, status) VALUES ($1,'B secret job', current_date, 'unassigned')", [h.orgB]);
    expect((await raw(`/feeds/data/jobs?key=${feed}`)).text).not.toContain("B secret job");
  });
  it("a calendar feed lists routes", async () => {
    await h.admin.query("DELETE FROM stops; DELETE FROM routes");
    await h.admin.query("INSERT INTO routes (org_id, name, route_date, status) VALUES ($1,'Morning, west', current_date, 'planned')", [h.orgA]);
    const r = await raw(`/feeds/calendar.ics?key=${feed}`);
    expect(r.headers["content-type"]).toContain("text/calendar");
    expect(r.text).toContain("BEGIN:VEVENT");
    expect(r.text).toContain("Morning\\, west");
    expect((await raw("/feeds/calendar.ics")).status).toBe(401);
  });
  it("lists the datasets", async () => {
    const r = await raw(`/feeds/datasets?key=${feed}`);
    expect(r.body.map((d: { key: string }) => d.key)).toContain("jobs");
  });
});

describe("email to job", () => {
  let inbound: string;
  beforeAll(async () => { inbound = (await mk(owner, { name: "mailbox", kind: "inbound" })).key; });
  const post = (key: string, body: object) => request(h.nest.getHttpServer()).post(`/inbound/email/${key}`).send(body);
  it("turns an email into a job in the right company", async () => {
    const r = await post(inbound, { from: "Pat Lee <pat@shop.ca>", subject: "Fwd: Delivery for 2031-05-02", text: "Deliver to: 22 Elm Ave, Ottawa ON\nCall 613-555-0199" });
    expect(r.status).toBe(201);
    const row = (await h.admin.query("SELECT * FROM jobs WHERE id = $1", [r.body.id])).rows[0];
    expect(row).toMatchObject({ org_id: h.orgA, source: "email", customer_name: "Pat Lee", customer_email: "pat@shop.ca", customer_phone: "613-555-0199", address: "22 Elm Ave, Ottawa ON", title: "Delivery for 2031-05-02" });
    expect(String(row.scheduled_date)).toContain("2031");
    expect((await h.admin.query("SELECT 1 FROM job_events WHERE job_id = $1", [r.body.id])).rowCount).toBe(1);
  });
  it("accepts form posts with another service's field names", async () => {
    const r = await request(h.nest.getHttpServer()).post(`/inbound/email/${inbound}`).type("form").send({ sender: "x@y.ca", subject: "Pickup", "body-plain": "450 King Street West" });
    expect(r.status).toBe(201);
    expect(r.body.address).toBe("450 King Street West");
  });
  it("refuses wrong keys and empty emails", async () => {
    expect((await post("rn_in_" + "z".repeat(40), { subject: "x" })).status).toBe(401);
    const api = (await mk(owner, { name: "api" })).key;
    expect((await post(api, { subject: "x" })).status).toBe(401);
    expect((await post(inbound, {})).status).toBe(400);
  });
});

describe("custom fields", () => {
  let jobId: string;
  beforeAll(async () => { jobId = (await h.admin.query("INSERT INTO jobs (org_id, title) VALUES ($1,'Custom') RETURNING id", [h.orgA])).rows[0].id; });
  it("defines fields and stores checked values", async () => {
    expect((await h.call("post", "/platform/custom-fields", owner, { entity: "job", key: "po", label: "PO number", type: "text", required: true })).status).toBe(201);
    expect((await h.call("post", "/platform/custom-fields", owner, { entity: "job", key: "gate", label: "Gate", labelFr: "Porte", type: "select", options: ["A", "B"] })).status).toBe(201);
    expect((await h.call("post", "/platform/custom-fields", owner, { entity: "job", key: "pallets", label: "Pallets", type: "number" })).status).toBe(201);
    const ok = await h.call("put", "/platform/custom", owner, { entity: "job", recordId: jobId, values: { po: "PO-7", gate: "B", pallets: "3" } });
    expect(ok.status).toBe(200);
    expect(ok.body.values).toEqual({ po: "PO-7", gate: "B", pallets: 3 });
    const got = (await h.call("get", `/platform/custom?entity=job&recordId=${jobId}`, owner)).body;
    expect(got.values.pallets).toBe(3);
    expect(got.fields.map((f: { key: string }) => f.key).sort()).toEqual(["gate", "pallets", "po"]);
  });
  it("rejects bad values", async () => {
    const put = (values: object) => h.call("put", "/platform/custom", owner, { entity: "job", recordId: jobId, values });
    expect((await put({ nope: 1 })).status).toBe(400);
    expect((await put({ gate: "Z" })).status).toBe(400);
    expect((await put({ pallets: "lots" })).status).toBe(400);
    expect((await put({ po: "" })).status).toBe(400);
  });
  it("merges and clears single values", async () => {
    const r = await h.call("put", "/platform/custom", owner, { entity: "job", recordId: jobId, values: { pallets: null } });
    expect(r.body.values).toEqual({ po: "PO-7", gate: "B" });
  });
  it("validates definitions and respects permissions", async () => {
    expect((await h.call("post", "/platform/custom-fields", owner, { entity: "job", key: "po", label: "Dup", type: "text" })).status).toBe(400);
    expect((await h.call("post", "/platform/custom-fields", owner, { entity: "job", key: "Bad Key", label: "x", type: "text" })).status).toBe(400);
    expect((await h.call("post", "/platform/custom-fields", owner, { entity: "job", key: "c", label: "x", type: "select" })).status).toBe(400);
    expect((await h.call("post", "/platform/custom-fields", owner, { entity: "boat", key: "c", label: "x", type: "text" })).status).toBe(400);
    expect((await h.call("post", "/platform/custom-fields", viewer, { entity: "job", key: "zz", label: "x", type: "text" })).status).toBe(403);
    expect((await h.call("put", "/platform/custom", viewer, { entity: "job", recordId: jobId, values: { po: "x" } })).status).toBe(403);
    expect((await h.call("get", `/platform/custom?entity=job&recordId=${jobId}`, viewer)).status).toBe(200);
  });
  it("keeps companies apart", async () => {
    expect((await h.call("get", "/platform/custom-fields?entity=job", ownerB)).body).toEqual([]);
    expect((await h.call("put", "/platform/custom", ownerB, { entity: "job", recordId: jobId, values: {} })).status).toBe(404);
  });
  it("an inactive field is not offered or accepted", async () => {
    const id = (await h.call("get", "/platform/custom-fields?entity=job", owner)).body.find((f: { key: string }) => f.key === "pallets").id;
    expect((await h.call("patch", `/platform/custom-fields/${id}`, owner, { active: false })).status).toBe(200);
    expect((await h.call("get", `/platform/custom?entity=job&recordId=${jobId}`, owner)).body.fields.map((f: { key: string }) => f.key)).not.toContain("pallets");
    expect((await h.call("put", "/platform/custom", owner, { entity: "job", recordId: jobId, values: { pallets: 2 } })).status).toBe(400);
    expect((await h.call("delete", `/platform/custom-fields/${id}`, owner)).status).toBe(200);
  });
});

describe("custom job statuses", () => {
  let jobId: string, sid: string;
  beforeAll(async () => {
    jobId = (await h.admin.query("INSERT INTO jobs (org_id, title, status) VALUES ($1,'S','assigned') RETURNING id", [h.orgA])).rows[0].id;
    sid = (await h.call("post", "/platform/statuses", owner, { key: "waiting_parts", label: "Waiting for parts", labelFr: "En attente de pièces", baseStatus: "assigned", color: "#d97706" })).body.id;
  });
  it("applies only while the job is in the matching state", async () => {
    expect((await h.call("put", `/platform/jobs/${jobId}/status`, owner, { key: "waiting_parts" })).body.customStatus).toBe("waiting_parts");
    await h.admin.query("UPDATE jobs SET status = 'started' WHERE id = $1", [jobId]);
    expect((await h.call("put", `/platform/jobs/${jobId}/status`, owner, { key: "waiting_parts" })).status).toBe(400);
    expect((await h.call("put", `/platform/jobs/${jobId}/status`, owner, { key: "nope" })).status).toBe(400);
    expect((await h.call("put", `/platform/jobs/${jobId}/status`, owner, { key: null })).body.customStatus).toBeNull();
  });
  it("validates and protects definitions", async () => {
    expect((await h.call("post", "/platform/statuses", owner, { key: "x", label: "X", baseStatus: "flying" })).status).toBe(400);
    expect((await h.call("post", "/platform/statuses", owner, { key: "waiting_parts", label: "Dup", baseStatus: "assigned" })).status).toBe(400);
    expect((await h.call("post", "/platform/statuses", viewer, { key: "y", label: "Y", baseStatus: "assigned" })).status).toBe(403);
    expect((await h.call("get", "/platform/statuses", ownerB)).body).toEqual([]);
  });
  it("deleting a status clears it from jobs", async () => {
    await h.admin.query("UPDATE jobs SET status = 'assigned', custom_status = 'waiting_parts' WHERE id = $1", [jobId]);
    expect((await h.call("delete", `/platform/statuses/${sid}`, owner)).status).toBe(200);
    expect((await h.admin.query("SELECT custom_status FROM jobs WHERE id = $1", [jobId])).rows[0].custom_status).toBeNull();
  });
});

describe("accounting export and docs", () => {
  it("exports invoices in each program's layout", async () => {
    await h.admin.query("INSERT INTO invoices (org_id, number, customer_name, status, issued_on, due_on, lines, subtotal, tax, total) VALUES ($1,'INV-9','Acme',  'sent', '2026-03-01', '2026-03-31', $2, 100, 13, 113)", [h.orgA, JSON.stringify([{ description: "Delivery", qty: 1, unitPrice: 100 }])]);
    for (const f of ["quickbooks", "xero", "sage"]) {
      const r = await h.call("get", `/platform/export/invoices?format=${f}`, owner);
      expect(r.status).toBe(200);
      expect(r.body.count).toBe(1);
      expect(r.body.csv).toContain("INV-9");
    }
    expect((await h.call("get", "/platform/export/invoices?format=zoho", owner)).status).toBe(400);
    expect((await h.call("get", "/platform/export/invoices?format=xero", viewer)).status).toBe(403);
    expect((await h.call("get", "/platform/export/invoices?format=xero", ownerB)).body.count).toBe(0);
  });
  it("publishes an API description without a login", async () => {
    const r = await raw("/public/openapi.json");
    expect(r.status).toBe(200);
    expect(r.body.openapi).toBe("3.0.3");
    expect(Object.keys(r.body.paths)).toContain("/feeds/data/{dataset}");
    expect(r.body.paths["/r/{resource}"].get.description).toContain("vehicles");
  });
  it("lists the connector catalog for administrators", async () => {
    expect((await h.call("get", "/platform/catalog", owner)).body.length).toBeGreaterThan(20);
    expect((await h.call("get", "/platform/catalog", viewer)).status).toBe(403);
  });
});
