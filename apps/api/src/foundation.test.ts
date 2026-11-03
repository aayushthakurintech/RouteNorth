import { withOrg } from "@routenorth/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ipAllowed } from "./auth/auth.controller.js";
import { describeRequest } from "./audit/audit.interceptor.js";
import { summarizeBody } from "./audit/audit.service.js";
import { ADMIN_URL, startHarness, type Harness } from "./test-harness.js";

describe("audit helpers", () => {
  it("describes requests", () => {
    expect(describeRequest("POST", "/routes")).toEqual({ action: "routes.create", entity: "routes", entityId: null });
    const id = "11111111-1111-4111-8111-111111111111";
    expect(describeRequest("PATCH", `/users/${id}`)).toEqual({ action: "users.update", entity: "users", entityId: id });
    expect(describeRequest("DELETE", `/routes/${id}/stops/22222222-2222-4222-8222-222222222222`).action).toBe("routes.stops.delete");
  });
  it("hides secrets and bounds size", () => {
    const out = summarizeBody({ email: "x@y.ca", password: "hunter2", nested: { apiKey: "k", ok: 1 }, list: Array(30).fill(1) }) as Record<string, any>;
    expect(out.password).toBe("[hidden]");
    expect(out.nested.apiKey).toBe("[hidden]");
    expect(out.nested.ok).toBe(1);
    expect(out.list).toHaveLength(21);
  });
  it("matches IP allow lists", () => {
    expect(ipAllowed("::ffff:10.0.0.5", ["10.0.0.0/24"])).toBe(true);
    expect(ipAllowed("10.0.1.5", ["10.0.0.0/24"])).toBe(false);
    expect(ipAllowed("203.0.113.9", ["203.0.113.9"])).toBe(true);
    expect(ipAllowed("1.2.3.4", ["bad/xx"])).toBe(false);
  });
});

const suite = ADMIN_URL ? describe : describe.skip;

suite("foundation API (roles, audit, search, settings)", () => {
  let h: Harness;
  let owner = "";
  beforeAll(async () => {
    h = await startHarness();
    owner = await h.token("a@example.com");
  });
  afterAll(async () => { await h?.close(); });

  it("returns who you are, what you may do and your company branding", async () => {
    const me = (await h.call("get", "/me", owner)).body;
    expect(me.user.email).toBe("a@example.com");
    expect(me.perms).toContain("audit.view");
    expect(me.org.name).toBe("A");
    expect(me.home).toBe("/");
    expect(me.org.settings.idleThresholdMin).toBe(5);
    expect(me.org.settings.ipAllowList).toBeUndefined(); // security settings stay on the server
  });

  it("saves preferences per person", async () => {
    expect((await h.call("put", "/me/prefs", owner, { prefs: { theme: "dark", favorites: [{ href: "/routes" }] } })).status).toBe(200);
    expect((await h.call("get", "/me", owner)).body.prefs.theme).toBe("dark");
    const bTok = await h.token("b@example.com");
    expect((await h.call("get", "/me", bTok)).body.prefs).toEqual({});
    expect((await h.call("put", "/me/prefs", owner, { prefs: [] })).status).toBe(400);
  });

  it("updates branding and settings with validation", async () => {
    const ok = await h.call("put", "/org", owner, { brandName: "North Haul", brandColor: "#0f5fa8", settings: { idleThresholdMin: 10, quietHours: { start: "22:00", end: "06:00" } } });
    expect(ok.status).toBe(200);
    expect(ok.body.brandColor).toBe("#0f5fa8");
    expect(ok.body.settings.idleThresholdMin).toBe(10);
    expect((await h.call("put", "/org", owner, { brandColor: "red" })).status).toBe(400);
    expect((await h.call("put", "/org", owner, { settings: { idleThresholdMin: 0 } })).status).toBe(400);
    expect((await h.call("put", "/org", owner, { logoDataUrl: "data:text/html;base64,AAAA" })).status).toBe(400);
    expect((await h.call("put", "/org", await h.token("b@example.com"), { brandName: "x" })).status).toBe(403);
    const me = (await h.call("get", "/me", owner)).body;
    expect(me.org.brandName).toBe("North Haul");
  });

  it("gives each role the right access", async () => {
    for (const [email, role] of [["dispatch@a.ca", "dispatcher"], ["mgr@a.ca", "manager"], ["drv@a.ca", "driver"], ["cust@a.ca", "customer"], ["ro@a.ca", "viewer"]] as const) {
      await h.addUser(h.orgA, email, role);
    }
    const t = async (e: string) => h.token(e);
    const status = async (e: string, path: string) => (await h.call("get", path, await t(e))).status;
    expect(await status("dispatch@a.ca", "/routes?date=2026-11-03")).toBe(200);
    expect(await status("drv@a.ca", "/routes?date=2026-11-03")).toBe(403);
    expect(await status("cust@a.ca", "/vehicles/live")).toBe(403);
    expect(await status("ro@a.ca", "/vehicles/live")).toBe(200);
    expect(await status("ro@a.ca", "/audit")).toBe(403);
    expect(await status("mgr@a.ca", "/audit")).toBe(200);
    expect(await status("dispatch@a.ca", "/audit")).toBe(403);
    expect((await h.call("get", "/me", await t("cust@a.ca"))).body.home).toBe("/portal");
    expect((await h.call("get", "/me", await t("drv@a.ca"))).body.home).toBe("/driver");
  });

  it("custom roles grant exactly their permissions", async () => {
    const role = (await h.call("post", "/roles", owner, { name: "Safety officer", permissions: ["fleet.view", "audit.view"] })).body;
    expect(role.id).toBeTruthy();
    expect((await h.call("post", "/roles", owner, { name: "Safety officer", permissions: [] })).status).toBe(409);
    expect((await h.call("post", "/roles", owner, { name: "Bad", permissions: ["root.everything"] })).status).toBe(400);
    const id = await h.addUser(h.orgA, "safety@a.ca", "viewer", { custom_role_id: role.id });
    const tok = await h.token("safety@a.ca");
    expect((await h.call("get", "/audit", tok)).status).toBe(200);
    expect((await h.call("get", "/routes?date=2026-11-03", tok)).status).toBe(403); // viewer could, custom role cannot
    // Deleting the role puts the person back on their built-in role immediately.
    expect((await h.call("delete", `/roles/${role.id}`, owner)).status).toBe(204);
    expect((await h.call("get", "/audit", tok)).status).toBe(403);
    expect((await h.call("get", "/routes?date=2026-11-03", tok)).status).toBe(200);
    expect(id).toBeTruthy();
  });

  it("does not let another organization see or use roles", async () => {
    const role = (await h.call("post", "/roles", owner, { name: "Secret", permissions: ["fleet.view"] })).body;
    const bTok = await h.token("b@example.com");
    expect((await h.call("put", `/roles/${role.id}`, bTok, { name: "x", permissions: [] })).status).toBe(403);
    expect((await h.call("get", "/roles", bTok)).status).toBe(403); // read-only people cannot list roles
    expect((await h.call("get", "/roles", owner)).body.custom.map((r: { name: string }) => r.name)).toContain("Secret");
  });

  it("disables people, and a disabled person is locked out at once", async () => {
    const id = await h.addUser(h.orgA, "temp@a.ca", "dispatcher");
    const tok = await h.token("temp@a.ca");
    expect((await h.call("get", "/routes?date=2026-11-03", tok)).status).toBe(200);
    expect((await h.call("patch", `/users/${id}`, owner, { disabled: true })).status).toBe(200);
    expect((await h.call("get", "/routes?date=2026-11-03", tok)).status).toBe(401);
    expect((await h.call("post", "/auth/login", undefined, { email: "temp@a.ca", password: "pw-correct-horse" })).status).toBe(401);
    expect((await h.call("patch", `/users/${id}`, owner, { disabled: false })).status).toBe(200);
    expect((await h.call("get", "/routes?date=2026-11-03", tok)).status).toBe(200);
  });

  it("protects owners and the last owner", async () => {
    const me = (await h.call("get", "/me", owner)).body.user.id;
    expect((await h.call("patch", `/users/${me}`, owner, { disabled: true })).status).toBe(400);
    await h.addUser(h.orgA, "admin@a.ca", "admin");
    const viewerId = (await h.admin.query("SELECT id FROM users WHERE email = 'ro@a.ca'")).rows[0].id;
    const adminTok = await h.token("admin@a.ca");
    expect((await h.call("patch", `/users/${me}`, adminTok, { role: "viewer" })).status).toBe(403);
    expect((await h.call("patch", `/users/${viewerId}`, adminTok, { role: "owner" })).status).toBe(403);
  });

  it("records every change in the audit log, hides secrets, and keeps rows immutable", async () => {
    await h.call("post", "/users", owner, { email: "audited@a.ca", password: "pw-correct-horse", role: "viewer" });
    const log = (await h.call("get", "/audit?q=users.create", owner)).body as Array<Record<string, any>>;
    const row = log.find((r) => r.detail?.email === "audited@a.ca");
    expect(row).toBeTruthy();
    expect(row!.actor).toBe("a@example.com");
    expect(row!.detail.password).toBe("[hidden]");
    expect(JSON.stringify(log)).not.toContain("pw-correct-horse");
    const csv = await h.call("get", "/audit?format=csv", owner);
    expect(csv.text.split("\n")[0]).toContain("time,actor,action");
    // The tenant role cannot rewrite history.
    await expect(withOrg(h.app, h.orgA, (c) => c.query("DELETE FROM audit_log"))).rejects.toThrow(/cannot be changed/);
    await expect(withOrg(h.app, h.orgA, (c) => c.query("UPDATE audit_log SET action = 'x'"))).rejects.toThrow(/cannot be changed/);
    // Each organization only sees its own log.
    const bLog = (await h.call("get", "/audit", await h.token("b@example.com"))).status;
    expect(bLog).toBe(403);
    const logins = (await h.call("get", "/audit?q=auth.login", owner)).body as Array<Record<string, any>>;
    expect(logins.length).toBeGreaterThan(0);
  });

  it("searches only what the caller may see", async () => {
    await h.admin.query("INSERT INTO vehicles (org_id, name, kind, plate) VALUES ($1,'Reefer 21','truck','ABCD123'),($2,'Reefer B','truck',NULL)", [h.orgA, h.orgB]);
    await h.admin.query("INSERT INTO routes (org_id, name, route_date) VALUES ($1,'Reefer run','2026-11-03')", [h.orgA]);
    const hits = (await h.call("get", "/search?q=reefer", owner)).body as Array<{ type: string; title: string }>;
    expect(hits.map((x) => x.title).sort()).toEqual(["Reefer 21", "Reefer run"]);
    expect((await h.call("get", "/search?q=abcd", owner)).body[0].title).toBe("Reefer 21");
    const driverHits = (await h.call("get", "/search?q=reefer", await h.token("drv@a.ca"))).body;
    expect(driverHits).toEqual([]);
    expect((await h.call("get", "/search?q=%25", owner)).body).toEqual([]); // wildcard is escaped
  });

  it("blocks sign-in from addresses outside the allow list", async () => {
    await h.call("put", "/org", owner, { settings: { ipAllowList: ["203.0.113.0/24"] } });
    const res = await h.call("post", "/auth/login", undefined, { email: "a@example.com", password: "pw-correct-horse" });
    expect(res.status).toBe(403);
    await h.admin.query("UPDATE organizations SET settings = settings - 'ipAllowList' WHERE id = $1", [h.orgA]);
    expect((await h.call("post", "/auth/login", undefined, { email: "a@example.com", password: "pw-correct-horse" })).status).toBe(200);
  });
});
