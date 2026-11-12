import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";

let h: Harness;
let owner: string, ownerB: string, viewer: string, dispatcher: string;
const ok = (r: { status: number; body: unknown }, code = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(code); return r.body as Record<string, any>; };

beforeAll(async () => {
  h = await startHarness();
  owner = await h.token("a@example.com");
  await h.addUser(h.orgB, "ownerb@example.com", "owner"); ownerB = await h.token("ownerb@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer"); viewer = await h.token("view@example.com");
  await h.addUser(h.orgA, "disp@example.com", "dispatcher"); dispatcher = await h.token("disp@example.com");
});
afterAll(async () => { await h.close(); });

describe("support and the roadmap", () => {
  it("stores a message, shows people their own and managers everyone's", async () => {
    const r = ok(await h.call("post", "/support/requests", viewer, { kind: "bug", subject: "Map is slow", body: "It takes ten seconds", page: "/" }), 201);
    expect(r).toMatchObject({ kind: "bug", status: "open", emailed: false });
    ok(await h.call("post", "/support/requests", dispatcher, { kind: "idea", body: "Dark map please" }), 201);
    expect(ok(await h.call("get", "/support/requests", viewer))).toHaveLength(1);
    const all = ok(await h.call("get", "/support/requests", owner)) as unknown as { from: string }[];
    expect(all.map((x) => x.from).sort()).toEqual(["disp@example.com", "view@example.com"]);
    expect((await h.call("get", "/support/requests", ownerB)).body).toHaveLength(0);
    expect((await h.call("post", "/support/requests", viewer, { kind: "bug", body: "" })).status).toBe(400);
    expect((await h.call("post", "/support/requests", viewer, { kind: "rant", body: "x" })).status).toBe(400);
    expect((await h.call("post", "/support/requests", viewer, { body: "x".repeat(4001) })).status).toBe(400);
  });
  it("lets each person vote once, counts across organizations, and refuses shipped items", async () => {
    const list = ok(await h.call("get", "/support/roadmap", owner)) as unknown as { id: string; voted: boolean; votes: number; status: string }[];
    expect(list.length).toBeGreaterThan(4);
    expect(list[list.length - 1]!.status).toBe("shipped");
    expect(ok(await h.call("post", "/support/roadmap/sso/vote", owner)).voted).toBe(true);
    ok(await h.call("post", "/support/roadmap/sso/vote", ownerB));
    const after = ok(await h.call("get", "/support/roadmap", owner)) as unknown as { id: string; voted: boolean; votes: number }[];
    expect(after.find((i) => i.id === "sso")).toMatchObject({ voted: true, votes: 2 });
    expect((await h.call("get", "/support/roadmap", ownerB)).body.find((i: { id: string }) => i.id === "sso").voted).toBe(true);
    expect(ok(await h.call("post", "/support/roadmap/sso/vote", owner)).voted).toBe(false);
    expect((await h.call("post", "/support/roadmap/driver-app/vote", owner)).status).toBe(400);
    expect((await h.call("post", "/support/roadmap/nope/vote", owner)).status).toBe(404);
  });
  it("publishes the roadmap and the service status without signing in", async () => {
    const rm = await request(h.nest.getHttpServer()).get("/public/roadmap");
    expect(rm.status).toBe(200);
    expect(rm.body.find((i: { id: string }) => i.id === "sso").votes).toBe(1);
    expect(JSON.stringify(rm.body)).not.toContain("org_id");
    const st = await request(h.nest.getHttpServer()).get("/public/system-status");
    expect(st.body).toMatchObject({ level: "operational" });
    expect(st.body.components.find((c: { id: string }) => c.id === "database").ok).toBe(true);
    await h.admin.query("INSERT INTO service_incidents (title, level, status) VALUES ('Map tiles slow', 'minor', 'investigating')");
    expect((await request(h.nest.getHttpServer()).get("/public/system-status")).body.level).toBe("degraded");
    await h.admin.query("UPDATE service_incidents SET status = 'resolved', resolved_at = now()");
    const done = (await request(h.nest.getHttpServer()).get("/public/system-status")).body;
    expect(done.level).toBe("operational");
    expect(done.incidents[0].title).toBe("Map tiles slow");
  });
});

describe("usage analytics", () => {
  it("counts pages and features by day and role, with no ids, and ignores junk", async () => {
    await h.call("post", "/ops/usage", dispatcher, { events: [
      { kind: "page", name: "/jobs" }, { kind: "page", name: "/jobs" }, { kind: "page", name: "/routes/3f2b1c9e-1111-4222-8333-444455556666" },
      { kind: "feature", name: "export.csv" }, { kind: "bogus", name: "x" }, { kind: "page", name: "<script>" }, { kind: "page" },
    ] }).expect(204);
    await h.call("post", "/ops/usage", owner, { events: [{ kind: "page", name: "/jobs" }] }).expect(204);
    const u = ok(await h.call("get", "/ops/usage?days=7", owner));
    expect(u.pages).toEqual(expect.arrayContaining([{ name: "/jobs", n: 3 }, { name: "/routes/:id", n: 1 }]));
    expect(u.features).toEqual([{ name: "export.csv", n: 1 }]);
    expect(u.byRole).toEqual(expect.arrayContaining([{ role: "dispatcher", n: 3 }, { role: "owner", n: 1 }]));
    expect((await h.call("get", "/ops/usage", dispatcher)).status).toBe(403);
    expect(ok(await h.call("get", "/ops/usage", ownerB)).pages).toEqual([]);
    expect((await h.call("post", "/ops/usage", owner, { events: "x" })).status).toBe(400);
  });
  it("stops counting when the organization opts out or the flag is off", async () => {
    ok(await h.call("put", "/org", owner, { settings: { platform: { analyticsOptOut: true } } }));
    await h.call("post", "/ops/usage", owner, { events: [{ kind: "page", name: "/after-opt-out" }] }).expect(204);
    expect(ok(await h.call("get", "/ops/usage", owner)).pages.map((p: { name: string }) => p.name)).not.toContain("/after-opt-out");
    ok(await h.call("put", "/org", owner, { settings: { platform: { analyticsOptOut: false } } }));
    ok(await h.call("put", "/ops/flags/usageAnalytics", owner, { enabled: false }));
    await h.call("post", "/ops/usage", owner, { events: [{ kind: "page", name: "/flag-off" }] }).expect(204);
    expect(ok(await h.call("get", "/ops/usage", owner)).pages.map((p: { name: string }) => p.name)).not.toContain("/flag-off");
    ok(await h.call("put", "/ops/flags/usageAnalytics", owner, { enabled: null }));
  });
});

describe("feature flags", () => {
  it("lists flags, switches one for this organization only, and shows it in /me", async () => {
    const before = ok(await h.call("get", "/ops/flags", owner)) as unknown as { key: string; enabled: boolean; overridden: boolean }[];
    expect(before.find((f) => f.key === "compactTables")).toMatchObject({ enabled: false, overridden: false });
    const after = ok(await h.call("put", "/ops/flags/compactTables", owner, { enabled: true })) as unknown as { key: string; enabled: boolean; overridden: boolean }[];
    expect(after.find((f) => f.key === "compactTables")).toMatchObject({ enabled: true, overridden: true });
    expect(ok(await h.call("get", "/me", viewer)).flags.compactTables).toBe(true);
    expect(ok(await h.call("get", "/me", ownerB)).flags.compactTables).toBe(false);
    ok(await h.call("put", "/ops/flags/compactTables", owner, { enabled: null }));
    expect(ok(await h.call("get", "/me", viewer)).flags.compactTables).toBe(false);
    expect((await h.call("put", "/ops/flags/nope", owner, { enabled: true })).status).toBe(400);
    expect((await h.call("put", "/ops/flags/compactTables", owner, { enabled: "yes" })).status).toBe(400);
    expect((await h.call("put", "/ops/flags/compactTables", dispatcher, { enabled: true })).status).toBe(403);
  });
});

describe("health", () => {
  it("reports each check, notices a silent GPS feed and failed webhooks, and records server errors", async () => {
    const h0 = ok(await h.call("get", "/ops/health", owner));
    const by = (r: Record<string, any>) => Object.fromEntries((r.checks as { id: string; status: string }[]).map((c) => [c.id, c.status]));
    expect(by(h0)).toMatchObject({ database: "ok", gpsFeed: "off", email: "off", errors: "ok", webhooks: "ok" });
    const veh = (await h.admin.query("INSERT INTO vehicles (org_id, name) VALUES ($1,'Quiet van') RETURNING id", [h.orgA])).rows[0].id;
    const dev = (await h.admin.query("INSERT INTO devices (org_id, external_id, vehicle_id) VALUES ($1,'imei-q',$2) RETURNING id", [h.orgA, veh])).rows[0].id;
    await h.admin.query("INSERT INTO latest_positions (device_id, org_id, time, lat, lng) VALUES ($1,$2, now() - interval '3 hours', 43, -79)", [dev, h.orgA]);
    expect(by(ok(await h.call("get", "/ops/health", owner)))).toMatchObject({ gpsFeed: "fail", silentDevices: "ok" });
    await h.admin.query("UPDATE latest_positions SET time = now() - interval '30 hours'");
    expect(by(ok(await h.call("get", "/ops/health", owner)))).toMatchObject({ silentDevices: "warn" });
    await h.admin.query("UPDATE latest_positions SET time = now() - interval '20 minutes'");
    expect(by(ok(await h.call("get", "/ops/health", owner))).gpsFeed).toBe("warn");
    await h.admin.query("UPDATE latest_positions SET time = now()");
    expect(by(ok(await h.call("get", "/ops/health", owner))).gpsFeed).toBe("ok");
    // a server error is recorded without its query string
    await h.admin.query("ALTER TABLE tasks RENAME TO tasks_hidden");
    const bad = await h.call("get", "/tasks?secret=abc", owner);
    await h.admin.query("ALTER TABLE tasks_hidden RENAME TO tasks");
    expect(bad.status).toBe(500);
    await new Promise((r) => setTimeout(r, 200));
    const errs = ok(await h.call("get", "/ops/errors", owner)) as unknown as { status: number; path: string }[];
    expect(errs[0]).toMatchObject({ status: 500, path: "/tasks" });
    expect(by(ok(await h.call("get", "/ops/health", owner))).errors).toBe("warn");
    expect(ok(await h.call("get", "/ops/errors", ownerB))).toHaveLength(0);
    expect((await h.call("get", "/ops/health", dispatcher)).status).toBe(403);
  });
});

describe("getting started and sample data", () => {
  it("counts what is set up, adds sample jobs once, and removes only the untouched ones", async () => {
    const s0 = ok(await h.call("get", "/ops/onboarding", owner));
    expect(s0).toMatchObject({ jobs: 0, sampleJobs: 0, drivers: 0, twoFactor: false });
    expect(ok(await h.call("post", "/ops/sample", owner)).added).toBe(6);
    expect((await h.call("post", "/ops/sample", owner)).status).toBe(400);
    expect(ok(await h.call("get", "/ops/onboarding", owner))).toMatchObject({ jobs: 0, sampleJobs: 6 });
    expect((await h.call("get", "/r/jobs", owner)).body.length).toBe(6);
    await h.admin.query("UPDATE jobs SET status = 'started' WHERE id = (SELECT id FROM jobs WHERE org_id = $1 LIMIT 1)", [h.orgA]);
    expect(ok(await h.call("delete", "/ops/sample", owner))).toEqual({ removed: 5, left: 1 });
    expect((await h.call("post", "/ops/sample", viewer)).status).toBe(403);
    expect(ok(await h.call("get", "/ops/onboarding", ownerB)).sampleJobs).toBe(0);
  });
});
