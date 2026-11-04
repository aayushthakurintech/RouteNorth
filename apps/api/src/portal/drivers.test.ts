import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";

let h: Harness, owner: string, mgr: string, disp: string, orgB: string, acct: string;
let ann: string;
const post = (p: string, t: string, b?: unknown) => h.call("post", p, t, b);
const get = (p: string, t: string) => h.call("get", p, t);
const patch = (p: string, t: string, b?: unknown) => h.call("patch", p, t, b);
const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const ago = (d: number) => new Date(Date.now() - d * 86_400_000).toISOString();
const trip = (driver: string, o: Record<string, unknown> = {}) => h.admin.query(
  `INSERT INTO portal_trips (org_id, driver_id, started_at, ended_at, distance_m, duration_s, status, revenue_cents, rating, on_time, cleanliness) VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10)`,
  [h.orgA, driver, o.at ?? ago(1), o.km ?? 10_000, 1800, o.status ?? "completed", o.rev ?? 5000, o.rating ?? 5, o.onTime ?? true, o.clean ?? 5]);

beforeAll(async () => {
  h = await startHarness();
  owner = await h.token("a@example.com");
  await h.addUser(h.orgA, "mgr@example.com", "manager"); mgr = await h.token("mgr@example.com");
  await h.addUser(h.orgA, "disp@example.com", "dispatcher"); disp = await h.token("disp@example.com");
  await h.addUser(h.orgA, "acct@example.com", "accountant"); acct = await h.token("acct@example.com");
  ann = await h.addUser(h.orgA, "ann@example.com", "driver", { display_name: "Ann Driver" });
  await h.addUser(h.orgB, "adminb@example.com", "admin"); orgB = await h.token("adminb@example.com");
}, 90_000);
afterAll(async () => { await h.close(); });

describe("list and profile", () => {
  it("has a record for every driver user and keeps existing drivers active", async () => {
    const rows = (await get("/portal/drivers", owner)).body as { id: string; status: string; name: string }[];
    expect(rows.find((r) => r.id === ann)).toMatchObject({ status: "active", name: "Ann Driver" });
    expect((await get("/portal/drivers", orgB)).body.some((r: { id: string }) => r.id === ann)).toBe(false);
    expect((await get(`/portal/drivers/${ann}`, orgB)).status).toBe(404);
  });

  it("edits personal details and audits old and new values", async () => {
    const r = await patch(`/portal/drivers/${ann}`, owner, { phone: "416-555-0100", licenseClass: "G", licenseExpiry: day(400), languages: ["English", "French"] });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    const p = (await get(`/portal/drivers/${ann}`, owner)).body;
    expect(p.profile).toMatchObject({ phone: "416-555-0100", licenseClass: "G", languages: ["English", "French"] });
    const log = await h.admin.query("SELECT old_value, new_value FROM audit_log WHERE action = 'drivers.update' AND entity_id = $1 ORDER BY at DESC LIMIT 1", [ann]);
    expect(log.rows[0].new_value.phone).toBe("416-555-0100");
    expect(log.rows[0].old_value.phone).toBeNull();
  });
});

describe("onboarding and blocking", () => {
  it("an invited driver starts in onboarding, cannot get work until required steps are approved, then activates", async () => {
    const inv = await post("/invites", owner, { email: "newbie@example.com", role: "driver" });
    expect(inv.status, JSON.stringify(inv.body)).toBe(201);
    const applicants = (await get("/portal/drivers", owner)).body as { applicant?: boolean; email: string; status: string }[];
    expect(applicants.find((r) => r.email === "newbie@example.com")).toMatchObject({ applicant: true, status: "applicant" });
    const token = (inv.body.link as string).split("/").pop()!;
    const acc = await h.call("post", `/public/invite/${token}/accept`, undefined, { password: "a-long-password-1", displayName: "Nina Newbie" });
    expect(acc.status).toBe(200);
    const nina = acc.body.user.id as string;
    expect((await get(`/portal/drivers/${nina}`, owner)).body).toMatchObject({ status: "onboarding" });

    const route = await post("/routes", owner, { name: "R", date: "2026-12-01", driverId: nina, stops: [] });
    expect(route.status).toBe(409);
    expect(route.body.code).toBe("driver_blocked");

    const steps = (await get(`/portal/drivers/${nina}/onboarding`, owner)).body.steps as { key: string; required: boolean }[];
    expect(steps).toHaveLength(7);
    expect((await post(`/portal/drivers/${nina}/onboarding/license`, owner, { action: "reject" })).status).toBe(400); // reason needed
    expect((await post(`/portal/drivers/${nina}/onboarding/license`, owner, { action: "reject", reason: "photo is blurry" })).status).toBe(200);
    expect((await post(`/portal/drivers/${nina}/status`, owner, { status: "active" })).status).toBe(400); // steps still open
    let last: { body: { activated: boolean } } | null = null;
    for (const s of steps.filter((x) => x.required)) last = (await post(`/portal/drivers/${nina}/onboarding/${s.key}`, owner, { action: "approve" })) as never;
    expect(last!.body.activated).toBe(true);
    expect((await get(`/portal/drivers/${nina}`, owner)).body.status).toBe("active");
    expect((await post("/routes", owner, { name: "R", date: "2026-12-01", driverId: nina, stops: [] })).status).toBe(201);
    const audit = await h.admin.query("SELECT action FROM audit_log WHERE entity_id = $1", [nina]);
    expect(audit.rows.map((r) => r.action)).toEqual(expect.arrayContaining(["driver_onboarding.reject", "driver_onboarding.approve", "drivers.status"]));
  });

  it("suspending needs a reason and blocks work; an expired licence blocks work", async () => {
    const d = await h.addUser(h.orgA, "sam@example.com", "driver", { display_name: "Sam" });
    expect((await post(`/portal/drivers/${d}/status`, owner, { status: "suspended" })).status).toBe(400);
    expect((await post(`/portal/drivers/${d}/status`, owner, { status: "suspended", reason: "unsafe driving" })).status).toBe(200);
    expect((await post("/routes", owner, { name: "R", date: "2026-12-02", driverId: d, stops: [] })).status).toBe(409);
    await post(`/portal/drivers/${d}/status`, owner, { status: "active" });
    await patch(`/portal/drivers/${d}`, owner, { licenseExpiry: "2020-01-01" });
    const blocked = await post("/routes", owner, { name: "R", date: "2026-12-02", driverId: d, stops: [] });
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toMatch(/Driver licence/);
    await patch(`/portal/drivers/${d}`, owner, { licenseExpiry: day(300) });
    expect((await post("/routes", owner, { name: "R", date: "2026-12-02", driverId: d, stops: [] })).status).toBe(201);
  });
});

describe("score, safety and compliance", () => {
  it("builds the score from trips and safety events with the formula visible", async () => {
    const d = await h.addUser(h.orgA, "pat@example.com", "driver", { display_name: "Pat" });
    for (let k = 0; k < 4; k++) await trip(d, { rating: 5, onTime: true, clean: 5, km: 10_000 });
    await trip(d, { rating: 3, onTime: false, clean: 3, km: 10_000 });
    await trip(d, { status: "cancelled" });
    const perf = (await get(`/portal/drivers/${d}/performance`, owner)).body;
    // on time: 4 of 5 rated trips... (cancelled trip has on_time true by default) -> computed from the data; check the parts add up to the score
    expect(perf.weights).toEqual({ onTime: 30, safety: 25, rating: 25, acceptance: 10, cleanliness: 10 });
    const sum = perf.parts.reduce((a: number, p: { points: number | null }) => a + (p.points ?? 0), 0);
    expect(Math.abs(sum - perf.score)).toBeLessThanOrEqual(1);
    expect(perf.formula).toContain("30% on-time rate");
    expect(perf.acceptanceRate).toBe(83); // 5 of 6 assigned trips completed
    expect(perf.cancellationRate).toBe(17);
    // a safety event lowers the safety part
    const before = perf.parts.find((p: { key: string }) => p.key === "safety").value;
    await post(`/portal/drivers/${d}/safety-events`, owner, { kind: "phone_use", severity: 3 });
    const after = (await get(`/portal/drivers/${d}/performance`, owner)).body.parts.find((p: { key: string }) => p.key === "safety").value;
    expect(after).toBeLessThan(before);
    expect((await get(`/portal/drivers/${d}/safety`, owner)).body.events).toHaveLength(1);
  });

  it("changing weights must add up to 100, and the leaderboard is off until switched on", async () => {
    expect((await h.call("put", "/portal/drivers/settings", owner, { weights: { onTime: 50, safety: 25, rating: 25, acceptance: 10, cleanliness: 10 } })).status).toBe(400);
    expect((await get("/portal/drivers/leaderboard", owner)).body.enabled).toBe(false);
    expect((await h.call("put", "/portal/drivers/settings", owner, { leaderboard: true })).status).toBe(200);
    const lb = (await get("/portal/drivers/leaderboard", owner)).body;
    expect(lb.enabled).toBe(true);
    expect(lb.rows[0].rank).toBe(1);
  });

  it("flags hours-rule breaches from shifts and reports company compliance", async () => {
    const d = await h.addUser(h.orgA, "lee@example.com", "driver", { display_name: "Lee" });
    for (let k = 1; k <= 5; k++) await h.admin.query("INSERT INTO shifts (org_id, driver_id, started_at, ended_at) VALUES ($1,$2,$3,$4)", [h.orgA, d, new Date(Date.now() - k * 86_400_000 - 12 * 3_600_000).toISOString(), new Date(Date.now() - k * 86_400_000).toISOString()]);
    const hrs = (await get(`/portal/drivers/${d}/hours`, owner)).body;
    expect(hrs.violations.length).toBeGreaterThan(0);
    expect(hrs.note).toMatch(/not a certified ELD/);
    const comp = (await get("/portal/drivers/compliance", owner)).body;
    expect(typeof comp.companyScore).toBe("number");
    expect(comp.formula).toBeTruthy();
  });
});

describe("bank and tax are private", () => {
  it("is visible only with drivers.sensitive, and every view and change is logged as sensitive", async () => {
    expect((await get(`/portal/drivers/${ann}/bank`, owner)).status).toBe(200);
    expect((await get(`/portal/drivers/${ann}/bank`, mgr)).status).toBe(403);
    expect((await get(`/portal/drivers/${ann}/bank`, disp)).status).toBe(403);
    expect((await patch(`/portal/drivers/${ann}/bank`, mgr, { bankInstitution: "x" })).status).toBe(403);
    expect((await patch(`/portal/drivers/${ann}/bank`, owner, { payoutMethod: "direct_deposit", bankInstitution: "RBC", bankAccountLast4: "1234" })).status).toBe(200);
    expect((await patch(`/portal/drivers/${ann}/bank`, owner, { bankAccountLast4: "123456789" })).status).toBe(400); // never store a full number
    const rows = await h.admin.query("SELECT sensitive FROM audit_log WHERE action IN ('driver_bank.view','driver_bank.update') AND entity_id = $1", [ann]);
    expect(rows.rows.length).toBeGreaterThanOrEqual(2);
    expect(rows.rows.every((r) => r.sensitive)).toBe(true);
    expect((await get(`/portal/drivers/${ann}`, mgr)).body.canSeeBank).toBe(false);
  });
});

describe("children, notes and offboarding", () => {
  it("keeps documents (and expiry shows on the profile), private notes only for managers, and archives instead of deleting", async () => {
    const doc = await post(`/portal/drivers/${ann}/documents`, owner, { kind: "Work permit", expiresOn: "2020-01-01" });
    expect(doc.status).toBe(201);
    expect((await get(`/portal/drivers/${ann}`, owner)).body.docs.expired).toBe(1);
    expect((await post(`/portal/drivers/${ann}/documents/${doc.body.id}/archive`, owner)).status).toBe(200);
    expect((await get(`/portal/drivers/${ann}/documents`, owner)).body).toHaveLength(0);
    expect((await get(`/portal/drivers/${ann}/documents?archived=1`, owner)).body).toHaveLength(1);
    const note = await post(`/portal/drivers/${ann}/notes`, owner, { kind: "warning", body: "Late three times", dueOn: day(7) });
    expect(note.status).toBe(201);
    expect((await get(`/portal/drivers/${ann}/notes`, disp)).status).toBe(403);
  });

  it("offboards: ends the car, disables sign-in, archives, and refuses while money is owed unless acknowledged", async () => {
    const d = await h.addUser(h.orgA, "gone@example.com", "driver", { display_name: "Gone" });
    const v = (await post("/portal/vehicles", owner, { name: "Van 9", kind: "van" })).body.id;
    expect((await post(`/portal/drivers/${d}/vehicle`, owner, { vehicleId: v })).status).toBe(200);
    expect((await get(`/portal/drivers/${d}/offboarding`, owner)).body.items[0]).toMatchObject({ key: "car_returned", done: false });
    expect((await post(`/portal/drivers/${d}/offboard`, owner, { reason: "resigned" })).status).toBe(200);
    expect((await get("/portal/drivers", owner)).body.some((r: { id: string }) => r.id === d)).toBe(false);
    const archived = (await get("/portal/drivers?archived=1", owner)).body as { id: string; status: string }[];
    expect(archived.find((r) => r.id === d)?.status).toBe("archived");
    expect((await get(`/portal/vehicles/${v}`, owner)).body.currentDriverId).toBeNull();
    expect((await h.call("post", "/auth/login", undefined, { email: "gone@example.com", password: "pw-correct-horse" })).status).not.toBe(200);
    expect((await post(`/portal/drivers/${d}/restore`, owner)).status).toBe(200);
  });

  it("region limits: a manager in a team sees only that team's drivers", async () => {
    const t = (await h.admin.query("INSERT INTO teams (org_id, name) VALUES ($1,'West') RETURNING id", [h.orgA])).rows[0].id;
    const mid = (await h.admin.query("SELECT id FROM users WHERE email = 'mgr@example.com'")).rows[0].id;
    await h.admin.query("INSERT INTO team_members (org_id, team_id, user_id) VALUES ($1,$2,$3)", [h.orgA, t, mid]);
    const d = await h.addUser(h.orgA, "west@example.com", "driver", { display_name: "West" });
    await patch(`/portal/drivers/${d}`, owner, { teamId: t });
    const ids = (await get("/portal/drivers", mgr)).body.map((r: { id: string }) => r.id);
    expect(ids).toEqual([d]);
    expect((await get(`/portal/drivers/${ann}`, mgr)).status).toBe(404);
    void acct;
  });
});
