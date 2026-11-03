import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";
import { AnalyticsService } from "../analytics/analytics.service.js";
import { evaluateOrg } from "../alerts/engine.js";
import type { Providers } from "../notify/notifier.js";

let h: Harness;
let owner: string, ownerB: string, viewer: string, dispatcher: string, manager: string, driverTok: string;
let driverId: string, dispatcherId: string, managerId: string;
const day = new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10);
const ok = (r: { status: number; body: unknown }, code = 200) => { expect(r.status, JSON.stringify(r.body)).toBe(code); return r.body as Record<string, any>; };

beforeAll(async () => {
  h = await startHarness();
  owner = await h.token("a@example.com");
  await h.addUser(h.orgB, "ownerb@example.com", "owner"); ownerB = await h.token("ownerb@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer"); viewer = await h.token("view@example.com");
  dispatcherId = await h.addUser(h.orgA, "dana.lee@example.com", "dispatcher", { display_name: "Dana Lee" }); dispatcher = await h.token("dana.lee@example.com");
  managerId = await h.addUser(h.orgA, "mo@example.com", "manager", { display_name: "Mo" }); manager = await h.token("mo@example.com");
  driverId = await h.addUser(h.orgA, "drew@example.com", "driver", { display_name: "Drew" }); driverTok = await h.token("drew@example.com");
});
afterAll(async () => { await h.close(); });

describe("teams", () => {
  it("creates teams, sets members and tags vehicles and jobs", async () => {
    const t = ok(await h.call("post", "/teams", owner, { name: "East region", kind: "region", color: "#112233" }), 201);
    ok(await h.call("put", `/teams/${t.id}/members`, owner, { userIds: [driverId, dispatcherId] }));
    const v = ok(await h.call("post", "/r/vehicles", owner, { name: "Truck 1", teamId: t.id }), 201);
    ok(await h.call("post", "/r/jobs", owner, { title: "Drop", teamId: t.id }), 201);
    const list = ok(await h.call("get", "/teams", owner)) as unknown as Record<string, any>[];
    expect(list[0]).toMatchObject({ name: "East region", vehicleCount: 1, openJobs: 1 });
    expect(list[0]!.members.map((m: { name: string }) => m.name).sort()).toEqual(["Dana Lee", "Drew"]);
    expect((await h.call("get", `/r/vehicles?teamId=${t.id}`, owner)).body).toHaveLength(1);
    expect(v.teamId).toBe(t.id);
  });
  it("rejects duplicates, bad colors and unknown people", async () => {
    expect((await h.call("post", "/teams", owner, { name: "East region" })).status).toBe(409);
    expect((await h.call("post", "/teams", owner, { name: "X", color: "red" })).status).toBe(400);
    const t = (await h.call("get", "/teams", owner)).body[0].id;
    expect((await h.call("put", `/teams/${t}/members`, owner, { userIds: ["00000000-0000-0000-0000-000000000000"] })).status).toBe(400);
  });
  it("is limited by permission and by organization", async () => {
    expect((await h.call("post", "/teams", dispatcher, { name: "Mine" })).status).toBe(403);
    expect((await h.call("get", "/teams", viewer)).status).toBe(200);
    expect((await h.call("get", "/teams", ownerB)).body).toEqual([]);
    const t = (await h.call("get", "/teams", owner)).body[0].id;
    expect((await h.call("delete", `/teams/${t}`, ownerB)).status).toBe(404);
  });
  it("deleting a team keeps its vehicles", async () => {
    const t = ok(await h.call("post", "/teams", owner, { name: "Temp" }), 201);
    const v = ok(await h.call("post", "/r/vehicles", owner, { name: "Van T", teamId: t.id }), 201);
    ok(await h.call("delete", `/teams/${t.id}`, owner));
    expect((await h.call("get", `/r/vehicles/${v.id}`, owner)).body.teamId).toBeNull();
  });
});

describe("invites", () => {
  let link = "", token = "";
  it("makes a link and stores only its hash", async () => {
    expect((await h.call("post", "/invites", manager, { email: "New.Person@example.com", role: "dispatcher" })).status).toBe(403);
    const inv = ok(await h.call("post", "/invites", owner, { email: "new.person@example.com", role: "dispatcher" }), 201);
    link = inv.link; token = link.split("/invite/")[1]!;
    expect(token.length).toBeGreaterThan(30);
    const stored = (await h.admin.query("SELECT token_hash FROM invites WHERE id = $1", [inv.id])).rows[0].token_hash;
    expect(stored).not.toContain(token);
    expect(JSON.stringify((await h.call("get", "/invites", owner)).body)).not.toContain(token);
  });
  it("only an owner can invite an admin, and existing accounts are refused", async () => {
    expect((await h.call("post", "/invites", owner, { email: "adm@example.com", role: "owner" })).status).toBe(400);
    expect((await h.call("post", "/invites", owner, { email: "view@example.com", role: "viewer" })).status).toBe(409);
    expect((await h.call("post", "/invites", owner, { email: "nope", role: "viewer" })).status).toBe(400);
  });
  it("shows the invitation without signing in, then lets the person join once", async () => {
    const peek = await request(h.nest.getHttpServer()).get(`/public/invite/${token}`);
    expect(peek.status).toBe(200);
    expect(peek.body).toMatchObject({ email: "new.person@example.com", role: "dispatcher" });
    const weak = await request(h.nest.getHttpServer()).post(`/public/invite/${token}/accept`).send({ password: "short" });
    expect(weak.status).toBe(400);
    const done = await request(h.nest.getHttpServer()).post(`/public/invite/${token}/accept`).send({ password: "a-long-password-1", displayName: "Nia" });
    expect(done.status).toBe(200);
    expect(done.body.user.role).toBe("dispatcher");
    expect((await h.call("get", "/me", done.body.token)).status).toBe(200);
    expect((await request(h.nest.getHttpServer()).post(`/public/invite/${token}/accept`).send({ password: "a-long-password-1" })).status).toBe(404);
    expect((await request(h.nest.getHttpServer()).get(`/public/invite/${token}`)).status).toBe(404);
    const login = await request(h.nest.getHttpServer()).post("/auth/login").send({ email: "new.person@example.com", password: "a-long-password-1" });
    expect(login.status).toBe(200);
  });
  it("puts the new person in the chosen team, and tells the owners", async () => {
    const t = (await h.call("get", "/teams", owner)).body[0].id;
    const inv = ok(await h.call("post", "/invites", owner, { email: "second@example.com", role: "driver", teamId: t }), 201);
    const tok = inv.link.split("/invite/")[1];
    ok(await request(h.nest.getHttpServer()).post(`/public/invite/${tok}/accept`).send({ password: "another-long-pass" }));
    const members = (await h.call("get", "/teams", owner)).body.find((x: { id: string }) => x.id === t).members;
    expect(members.some((m: { name: string }) => m.name === "second@example.com")).toBe(true);
    const note = (await h.call("get", "/notifications", owner)).body as { title: string }[];
    expect(note.some((n) => n.title.includes("accepted the invitation"))).toBe(true);
  });
  it("can be revoked and expires", async () => {
    const inv = ok(await h.call("post", "/invites", owner, { email: "gone@example.com", role: "viewer" }), 201);
    const tok = inv.link.split("/invite/")[1];
    ok(await h.call("delete", `/invites/${inv.id}`, owner));
    expect((await request(h.nest.getHttpServer()).get(`/public/invite/${tok}`)).status).toBe(404);
    const inv2 = ok(await h.call("post", "/invites", owner, { email: "late@example.com", role: "viewer" }), 201);
    await h.admin.query("UPDATE invites SET expires_at = now() - interval '1 minute' WHERE id = $1", [inv2.id]);
    expect((await request(h.nest.getHttpServer()).get(`/public/invite/${inv2.link.split("/invite/")[1]}`)).status).toBe(404);
    expect((await request(h.nest.getHttpServer()).get("/public/invite/not-a-real-token-at-all-xx")).status).toBe(404);
  });
  it("a new invite replaces the open one for the same address", async () => {
    const a = ok(await h.call("post", "/invites", owner, { email: "twice@example.com", role: "viewer" }), 201);
    const b = ok(await h.call("post", "/invites", owner, { email: "twice@example.com", role: "viewer" }), 201);
    expect((await request(h.nest.getHttpServer()).get(`/public/invite/${a.link.split("/invite/")[1]}`)).status).toBe(404);
    expect((await request(h.nest.getHttpServer()).get(`/public/invite/${b.link.split("/invite/")[1]}`)).status).toBe(200);
  });
});

describe("comments, mentions and notifications", () => {
  let jobId = "";
  it("mentions someone by handle and notifies them", async () => {
    jobId = ok(await h.call("post", "/r/jobs", owner, { title: "Pallet to dock 4" }), 201).id;
    const r = ok(await h.call("post", "/comments", owner, { entity: "job", entityId: jobId, body: "@dana.lee can you move this up? cc @nobody" }), 201);
    expect(r.mentions).toBe(1);
    const list = ok(await h.call("get", `/comments?entity=job&entityId=${jobId}`, owner)) as unknown as Record<string, any>[];
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ author: "a@example.com", mentions: [dispatcherId] });
    const mine = (await h.call("get", "/notifications?unread=1", dispatcher)).body as { id: string; kind: string; link: string }[];
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ kind: "mention", link: `/jobs?open=${jobId}` });
    expect((await h.call("get", "/notifications/count", dispatcher)).body.unread).toBe(1);
    expect((await h.call("get", "/notifications", owner)).body.some((n: { kind: string }) => n.kind === "mention")).toBe(false);
  });
  it("marks notifications read, and only your own", async () => {
    const mine = (await h.call("get", "/notifications", dispatcher)).body as { id: string }[];
    expect((await h.call("post", "/notifications/read", owner, { ids: [mine[0]!.id] })).body.marked).toBe(0);
    expect((await h.call("post", "/notifications/read", dispatcher, { ids: [mine[0]!.id] })).body.marked).toBe(1);
    expect((await h.call("get", "/notifications/count", dispatcher)).body.unread).toBe(0);
    expect((await h.call("post", "/notifications/read", dispatcher, {})).status).toBe(400);
  });
  it("checks permissions, length and that the record exists", async () => {
    expect((await h.call("post", "/comments", viewer, { entity: "job", entityId: jobId, body: "hi" })).status).toBe(403);
    expect((await h.call("post", "/comments", owner, { entity: "job", entityId: jobId, body: "  " })).status).toBe(400);
    expect((await h.call("post", "/comments", owner, { entity: "job", entityId: jobId, body: "x".repeat(2001) })).status).toBe(400);
    expect((await h.call("post", "/comments", owner, { entity: "job", entityId: "00000000-0000-0000-0000-000000000000", body: "hi" })).status).toBe(404);
    expect((await h.call("post", "/comments", owner, { entity: "planet", entityId: jobId, body: "hi" })).status).toBe(400);
    expect((await h.call("get", `/comments?entity=job&entityId=${jobId}`, ownerB)).body).toEqual([]);
    expect((await h.call("post", "/comments", ownerB, { entity: "job", entityId: jobId, body: "hi" })).status).toBe(404);
  });
  it("lets people delete their own comments, and owners any", async () => {
    const c = ok(await h.call("post", "/comments", dispatcher, { entity: "job", entityId: jobId, body: "mine" }), 201);
    expect((await h.call("delete", `/comments/${c.id}`, manager)).status).toBe(403);
    expect((await h.call("delete", `/comments/${c.id}`, dispatcher)).status).toBe(200);
    const c2 = ok(await h.call("post", "/comments", dispatcher, { entity: "job", entityId: jobId, body: "again" }), 201);
    expect((await h.call("delete", `/comments/${c2.id}`, owner)).status).toBe(200);
  });
  it("lists people to mention", async () => {
    const p = (await h.call("get", "/comments/people", dispatcher)).body as { handle: string }[];
    expect(p.map((x) => x.handle)).toContain("dana.lee");
  });
});

describe("tasks", () => {
  it("creates, assigns, completes and notifies", async () => {
    const t = ok(await h.call("post", "/tasks", owner, { title: "Call the depot", dueOn: day, assigneeId: dispatcherId, priority: "high" }), 201);
    expect((await h.call("get", "/notifications?unread=1", dispatcher)).body.some((n: { title: string }) => n.title.includes("Call the depot"))).toBe(true);
    const mine = (await h.call("get", "/tasks?mine=1", dispatcher)).body as { id: string; overdue: boolean }[];
    expect(mine.map((x) => x.id)).toContain(t.id);
    expect(mine.find((x) => x.id === t.id)!.overdue).toBe(true);
    ok(await h.call("patch", `/tasks/${t.id}`, dispatcher, { status: "done" }));
    const after = (await h.call("get", "/tasks?status=done", owner)).body as { id: string; doneAt: string; overdue: boolean }[];
    expect(after.find((x) => x.id === t.id)).toMatchObject({ overdue: false });
    expect(after.find((x) => x.id === t.id)!.doneAt).toBeTruthy();
    ok(await h.call("patch", `/tasks/${t.id}`, dispatcher, { status: "todo" }));
    expect((await h.call("get", "/tasks?status=todo", owner)).body.find((x: { id: string }) => x.id === t.id).doneAt).toBeNull();
  });
  it("validates and is tenant-isolated", async () => {
    expect((await h.call("post", "/tasks", owner, { title: "" })).status).toBe(400);
    expect((await h.call("post", "/tasks", owner, { title: "x", dueOn: "soon" })).status).toBe(400);
    expect((await h.call("post", "/tasks", owner, { title: "x", assigneeId: "00000000-0000-0000-0000-000000000000" })).status).toBe(400);
    expect((await h.call("post", "/tasks", viewer, { title: "x" })).status).toBe(403);
    expect((await h.call("get", "/tasks", ownerB)).body).toEqual([]);
  });
});

describe("schedule and time off", () => {
  const at = (d: string, hh: string) => `${d}T${hh}:00:00Z`;
  const next = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
  it("plans shifts and flags overlaps", async () => {
    ok(await h.call("post", "/r/shift-plans", owner, { driverId, startsAt: at(next, "08"), endsAt: at(next, "16") }), 201);
    ok(await h.call("post", "/r/shift-plans", owner, { driverId, startsAt: at(next, "15"), endsAt: at(next, "20") }), 201);
    expect((await h.call("post", "/r/shift-plans", owner, { driverId, startsAt: at(next, "10"), endsAt: at(next, "09") })).status).toBe(400);
    const s = ok(await h.call("get", `/schedule?from=${next}&to=${next}`, dispatcher));
    expect(s.plans).toHaveLength(2);
    expect(s.conflicts.filter((c: { kind: string }) => c.kind === "overlap")).toHaveLength(2);
    expect(s.drivers.map((d: { name: string }) => d.name)).toContain("Drew");
    expect((await h.call("get", `/schedule?from=${next}&to=2099-01-01`, dispatcher)).status).toBe(400);
    expect((await h.call("post", "/r/shift-plans", viewer, { driverId, startsAt: at(next, "08"), endsAt: at(next, "09") })).status).toBe(403);
  });
  it("a driver asks for time off and a manager decides", async () => {
    const r = ok(await h.call("post", "/time-off", driverTok, { startsOn: next, endsOn: next, kind: "sick", note: "flu" }), 201);
    expect(r.status).toBe("pending");
    expect((await h.call("get", "/notifications?unread=1", manager)).body.some((n: { title: string }) => n.title.includes("asks for time off"))).toBe(true);
    expect((await h.call("post", `/time-off/${r.id}/decide`, driverTok, { decision: "approved" })).status).toBe(403);
    expect((await h.call("get", "/time-off", driverTok)).body).toHaveLength(1);
    ok(await h.call("post", `/time-off/${r.id}/decide`, manager, { decision: "approved" }));
    expect((await h.call("post", `/time-off/${r.id}/decide`, manager, { decision: "rejected" })).status).toBe(404);
    expect((await h.call("get", "/notifications?unread=1", driverTok)).body.some((n: { title: string }) => n.title.includes("was approved"))).toBe(true);
    const s = ok(await h.call("get", `/schedule?from=${next}&to=${next}`, dispatcher));
    expect(s.conflicts.filter((c: { kind: string }) => c.kind === "time_off").length).toBeGreaterThan(0);
  });
  it("dispatch books time off directly; others cannot book for someone else", async () => {
    const d2 = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
    expect(ok(await h.call("post", "/time-off", dispatcher, { userId: driverId, startsOn: d2, endsOn: d2 }), 201).status).toBe("approved");
    expect((await h.call("post", "/time-off", driverTok, { userId: dispatcherId, startsOn: d2, endsOn: d2 })).status).toBe(403);
    expect((await h.call("post", "/time-off", driverTok, { startsOn: d2, endsOn: "2000-01-01" })).status).toBe(400);
    expect((await h.call("get", "/time-off", ownerB)).body).toEqual([]);
  });
  it("withdraws your own pending request only", async () => {
    const d3 = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    const r = ok(await h.call("post", "/time-off", driverTok, { startsOn: d3, endsOn: d3 }), 201);
    expect((await h.call("delete", `/time-off/${r.id}`, dispatcher)).status).toBe(403);
    expect((await h.call("delete", `/time-off/${r.id}`, driverTok)).status).toBe(200);
  });
});

describe("approvals by request", () => {
  it("anyone who can dispatch asks, a manager answers, the asker hears", async () => {
    const a = ok(await h.call("post", "/approvals", dispatcher, { title: "Buy a second pallet jack", detail: "about 400" }), 201);
    expect((await h.call("get", "/notifications?unread=1", manager)).body.some((n: { title: string }) => n.title.includes("pallet jack"))).toBe(true);
    ok(await h.call("post", `/approvals/${a.id}/decide`, manager, { decision: "approved" }));
    expect((await h.call("get", "/notifications?unread=1", dispatcher)).body.some((n: { title: string }) => n.title.includes("was approved"))).toBe(true);
    expect((await h.call("post", "/approvals", viewer, { title: "x" })).status).toBe(403);
    expect((await h.call("post", "/approvals", dispatcher, { title: "" })).status).toBe(400);
  });
});

describe("plan, trial and usage", () => {
  it("starts on a trial with soft limits", async () => {
    const p = ok(await h.call("get", "/billing/plan", owner));
    expect(p.plan).toBe("trial");
    expect(p.trialDaysLeft).toBeGreaterThan(25);
    expect(p.usage.find((u: { metric: string }) => u.metric === "vehicles").used).toBeGreaterThan(0);
    expect(p.plans.map((x: { id: string }) => x.id)).toEqual(["trial", "starter", "pro", "enterprise"]);
  });
  it("only the owner changes plan, and a trial cannot be picked again", async () => {
    expect((await h.call("get", "/billing/plan", dispatcher)).status).toBe(403);
    await h.addUser(h.orgA, "adm@example.com", "admin");
    const adm = await h.token("adm@example.com");
    expect((await h.call("get", "/billing/plan", adm)).status).toBe(200);
    expect((await h.call("put", "/billing/plan", adm, { plan: "pro" })).status).toBe(403);
    expect((await h.call("put", "/billing/plan", owner, { plan: "trial" })).status).toBe(400);
    expect((await h.call("put", "/billing/plan", owner, { plan: "gold" })).status).toBe(400);
    ok(await h.call("put", "/billing/plan", owner, { plan: "starter" }));
    const p = ok(await h.call("get", "/billing/plan", owner));
    expect(p).toMatchObject({ plan: "starter", trialDaysLeft: null });
    expect(p.usage.find((u: { metric: string }) => u.metric === "users").state).toBe("over");
    expect((await h.call("get", "/billing/plan", ownerB)).body.plan).toBe("trial");
  });
});

describe("rate cards, quotes and invoices", () => {
  let cardId = "";
  it("stores a rate card, checks its bands and prices a trip", async () => {
    expect((await h.call("post", "/r/rate-cards", owner, { name: "Bad", basis: "distance", tiers: [] })).status).toBe(400);
    expect((await h.call("post", "/r/rate-cards", owner, { name: "Bad2", basis: "zone", zones: [] })).status).toBe(400);
    const c = ok(await h.call("post", "/r/rate-cards", owner, { name: "City runs", basis: "distance", base: 10, minimum: 25, tiers: [{ upTo: 10, rate: 2 }, { upTo: null, rate: 1 }] }), 201);
    cardId = c.id;
    expect(ok(await h.call("post", `/billing/rate-cards/${cardId}/price`, owner, { km: 30 })).amount).toBe(10 + 20 + 20);
    expect(ok(await h.call("post", `/billing/rate-cards/${cardId}/price`, owner, { km: 1 })).amount).toBe(25);
    expect((await h.call("post", `/billing/rate-cards/${cardId}/price`, owner, { km: -4 })).status).toBe(400);
    expect((await h.call("post", "/r/rate-cards", dispatcher, { name: "X", basis: "weight", tiers: [{ upTo: null, rate: 1 }] })).status).toBe(201);
    expect((await h.call("post", "/r/rate-cards", viewer, { name: "X", basis: "weight", tiers: [{ upTo: null, rate: 1 }] })).status).toBe(403);
    expect((await h.call("get", "/r/rate-cards", ownerB)).body).toEqual([]);
  });
  it("prices a zone card", async () => {
    const z = ok(await h.call("post", "/r/rate-cards", owner, { name: "Zones", basis: "zone", zones: [{ name: "Core", price: 9 }, { name: "Far", price: 19 }] }), 201);
    expect(ok(await h.call("post", `/billing/rate-cards/${z.id}/price`, owner, { zone: "far" })).amount).toBe(19);
    expect((await h.call("post", `/billing/rate-cards/${z.id}/price`, owner, { zone: "moon" })).status).toBe(400);
  });
  it("builds a quote from a rate card with province tax, and converts it once", async () => {
    const q = ok(await h.call("post", "/billing/quotes", owner, { customerName: "Acme Ltd", customerEmail: "ap@acme.ca", rateCard: { id: cardId, km: 30 } }), 201);
    expect(q.number).toMatch(/^Q-\d{4}-0001$/);
    expect(q.total).toBe(56.5); // 50 + 13% HST
    const list = ok(await h.call("get", "/billing/quotes", owner)).items as Record<string, any>[];
    expect(list[0]).toMatchObject({ status: "draft", subtotal: 50, tax: 6.5, taxLines: [{ code: "HST", rate: 13, amount: 6.5 }], expired: false });
    ok(await h.call("patch", `/billing/quotes/${q.id}`, owner, { status: "sent" }));
    const inv = ok(await h.call("post", `/billing/quotes/${q.id}/convert`, owner));
    expect(inv.number).toMatch(/^INV-/);
    expect((await h.call("post", `/billing/quotes/${q.id}/convert`, owner)).status).toBe(409);
    expect((await h.call("patch", `/billing/quotes/${q.id}`, owner, { status: "draft" })).status).toBe(404);
    const invoices = ok(await h.call("get", "/invoices", owner)).items as Record<string, any>[];
    expect(invoices.find((i) => i.id === inv.invoiceId)).toMatchObject({ status: "draft", subtotal: 50, tax: 6.5, total: 56.5, customerName: "Acme Ltd" });
    expect((await h.call("get", `/invoices/${inv.invoiceId}/pdf`, owner)).status).toBe(200);
  });
  it("builds quotes by hand and rejects bad lines", async () => {
    expect((await h.call("post", "/billing/quotes", owner, { customerName: "X", lines: [] })).status).toBe(400);
    expect((await h.call("post", "/billing/quotes", owner, { customerName: "X", lines: [{ description: "a", qty: 0, unitPrice: 1 }] })).status).toBe(400);
    expect((await h.call("post", "/billing/quotes", owner, { lines: [{ description: "a", unitPrice: 1 }] })).status).toBe(400);
    expect((await h.call("post", "/billing/quotes", viewer, { customerName: "X", lines: [{ description: "a", unitPrice: 1 }] })).status).toBe(403);
    const q = ok(await h.call("post", "/billing/quotes", owner, { customerName: "Exempt Co", taxExempt: true, lines: [{ description: "Haul", qty: 2, unitPrice: 100 }] }), 201);
    expect(q.total).toBe(200);
    await h.admin.query("UPDATE quotes SET valid_until = current_date - 1 WHERE id = $1", [q.id]);
    expect((await h.call("get", "/billing/quotes", owner)).body.items.find((x: { id: string }) => x.id === q.id).expired).toBe(true);
    expect((await h.call("get", "/billing/quotes", ownerB)).body.items).toEqual([]);
  });
  it("builds invoices with the tax of the chosen province", async () => {
    ok(await h.call("put", "/org", owner, { settings: { billing: { province: "QC" } } }));
    const i = ok(await h.call("post", "/invoices", owner, { customerName: "Québec Inc", currency: "CAD", lines: [{ description: "Livraison", qty: 1, unitPrice: 100 }] }), 201);
    const row = (await h.admin.query("SELECT subtotal::float, tax::float, total::float, tax_lines, status FROM invoices WHERE id = $1", [i.id])).rows[0];
    expect(row).toMatchObject({ subtotal: 100, tax: 14.98, total: 114.98, status: "draft" });
    expect(row.tax_lines.map((t: { code: string }) => t.code)).toEqual(["GST", "QST"]);
    ok(await h.call("put", "/org", owner, { settings: { billing: { province: "ON" } } }));
    expect((await h.call("post", "/invoices", owner, { customerName: "X", lines: [{ description: "a", unitPrice: 1 }], currency: "cad" })).status).toBe(400);
    expect((await h.call("post", "/invoices", viewer, { customerName: "X", lines: [{ description: "a", unitPrice: 1 }] })).status).toBe(403);
  });
  it("a flat tax rate overrides the province", async () => {
    ok(await h.call("put", "/org", owner, { settings: { billing: { taxMode: "custom" }, taxRatePct: 8 } }));
    const i = ok(await h.call("post", "/invoices", owner, { customerName: "Flat", lines: [{ description: "a", unitPrice: 100 }] }), 201);
    expect(i.total).toBe(108);
    ok(await h.call("put", "/org", owner, { settings: { billing: { taxMode: "province" }, taxRatePct: 13 } }));
  });
});

describe("budgets and cost alerts", () => {
  it("compares spending with each budget", async () => {
    const v = ok(await h.call("post", "/r/vehicles", owner, { name: "Budget van" }), 201);
    const today = new Date().toISOString().slice(0, 10);
    await h.admin.query("INSERT INTO fuel_logs (org_id, vehicle_id, filled_on, litres, cost) VALUES ($1,$2,$3,50,95),($1,$2,$3,40,20)", [h.orgA, v.id, today]);
    await h.admin.query("INSERT INTO maintenance_logs (org_id, vehicle_id, task, done_on, cost) VALUES ($1,$2,'Oil',$3,300)", [h.orgA, v.id, today]);
    ok(await h.call("post", "/r/budgets", owner, { name: "Fuel (van)", category: "fuel", period: "month", amount: 100, vehicleId: v.id }), 201);
    ok(await h.call("post", "/r/budgets", owner, { name: "Everything", category: "total", period: "year", amount: 100000 }), 201);
    expect((await h.call("post", "/r/budgets", owner, { name: "Zero", category: "fuel", amount: 0 })).status).toBe(400);
    const b = ok(await h.call("get", "/billing/budgets", owner)).items as Record<string, any>[];
    const fuel = b.find((x) => x.name === "Fuel (van)")!;
    expect(fuel).toMatchObject({ spent: 115, pct: 115, state: "over" });
    expect(b.find((x) => x.name === "Everything")).toMatchObject({ state: "ok" });
    expect((await h.call("get", "/billing/budgets", ownerB)).body.items).toEqual([]);
  });
  it("raises an alert when a budget is over", async () => {
    ok(await h.call("post", "/r/alert-rules", owner, { name: "Budgets", kind: "budget", severity: "warn" }), 201);
    const r = await evaluateOrg(h.app, h.nest.get(AnalyticsService), { fetch } as Providers, h.orgA);
    expect(r.raised).toBe(1);
    const titles = (await h.call("get", "/alerts?status=open", owner)).body.map((a: { title: string }) => a.title);
    expect(titles.some((t: string) => t.includes("Fuel (van) is over budget"))).toBe(true);
    expect(titles.some((t: string) => t.includes("Everything"))).toBe(false);
  });
});

describe("contracts and service levels", () => {
  it("measures on-time delivery against the contract", async () => {
    const r = (await h.admin.query("INSERT INTO routes (org_id, name, route_date, status) VALUES ($1,'SLA',$2,'completed') RETURNING id", [h.orgA, day])).rows[0].id;
    const mkJob = async (n: number) => (await h.admin.query("INSERT INTO jobs (org_id, title, customer_name, status) VALUES ($1,$2,'Acme Ltd','done') RETURNING id", [h.orgA, `J${n}`])).rows[0].id;
    const t = (hh: string) => `${day}T${hh}:00Z`;
    const stops = [["10:00", "09:50"], ["11:00", "11:30"], ["12:00", "11:45"], ["13:00", "12:00"]];
    for (const [i, [win, arr]] of stops.entries()) {
      await h.admin.query("INSERT INTO stops (org_id, route_id, sequence, name, lat, lng, job_id, window_end, arrived_at, status) VALUES ($1,$2,$3,$4,43.7,-79.4,$5,$6,$7,'done')", [h.orgA, r, i + 1, `S${i}`, await mkJob(i), t(win!), t(arr!)]);
    }
    const start = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
    ok(await h.call("post", "/r/contracts", owner, { customerName: "acme ltd", title: "2026 delivery", startsOn: start, endsOn: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10), onTimeTargetPct: 90, value: 50000 }), 201);
    expect((await h.call("post", "/r/contracts", owner, { customerName: "X", title: "bad", startsOn: "2026-05-01", endsOn: "2026-04-01" })).status).toBe(400);
    const c = ok(await h.call("get", "/billing/contracts", owner)).items[0];
    expect(c).toMatchObject({ done: 4, onTimePct: 75, sla: "breached", expiringSoon: true });
    expect(c.daysLeft).toBeGreaterThanOrEqual(29);
    expect((await h.call("get", "/billing/contracts", ownerB)).body.items).toEqual([]);
    expect((await h.call("post", "/r/contracts", dispatcher, { customerName: "Y", title: "t", startsOn: start })).status).toBe(201);
  });
});

describe("driver pay", () => {
  it("adds hours, approved overtime, stops and expenses", async () => {
    await h.admin.query("INSERT INTO driver_profiles (user_id, org_id, hourly_rate) VALUES ($1,$2,20) ON CONFLICT (user_id) DO UPDATE SET hourly_rate = 20", [driverId, h.orgA]);
    const s = (hh: number) => new Date(`${day}T${String(hh).padStart(2, "0")}:00:00Z`);
    await h.admin.query("INSERT INTO shifts (org_id, driver_id, started_at, ended_at, overtime_minutes, overtime_status) VALUES ($1,$2,$3,$4,60,'approved')", [h.orgA, driverId, s(6), s(15)]);
    await h.admin.query("INSERT INTO expenses (org_id, user_id, kind, amount, spent_on, status) VALUES ($1,$2,'parking',12.5,$3,'approved')", [h.orgA, driverId, day]);
    ok(await h.call("put", "/org", owner, { settings: { billing: { payPerStop: 1, payPerKm: 0.1, overtimeMultiplier: 2 } } }));
    const p = ok(await h.call("get", `/billing/payroll?from=${day}&to=${day}`, owner));
    const row = p.rows.find((r: { driverId: string }) => r.driverId === driverId);
    expect(row).toMatchObject({ workedH: 9, regularH: 8, overtimeH: 1, regular: 160, overtime: 40, reimbursable: 12.5, shifts: 1 });
    expect(row.gross).toBe(200 + row.perStop + row.perKm);
    expect(row.total).toBe(row.gross + 12.5);
    const csv = await h.call("get", `/billing/payroll.csv?from=${day}&to=${day}`, owner);
    expect(csv.status).toBe(200);
    expect(csv.text.split("\n")[0]).toContain("Overtime pay");
    expect(csv.text).toContain("Drew");
  });
  it("does not pay overtime that was not approved, and warns about a missing rate", async () => {
    const d2 = await h.addUser(h.orgA, "norate@example.com", "driver", { display_name: "No Rate" });
    await h.admin.query("INSERT INTO shifts (org_id, driver_id, started_at, ended_at, overtime_minutes, overtime_status) VALUES ($1,$2,$3,$4,60,'pending')", [h.orgA, d2, `${day}T06:00:00Z`, `${day}T15:00:00Z`]);
    const p = ok(await h.call("get", `/billing/payroll?from=${day}&to=${day}`, owner));
    const row = p.rows.find((r: { driverId: string }) => r.driverId === d2);
    expect(row).toMatchObject({ overtime: 0, pendingOvertimeH: 1, missingRate: true });
  });
  it("is private to those who may see reports", async () => {
    expect((await h.call("get", `/billing/payroll?from=${day}&to=${day}`, driverTok)).status).toBe(403);
    expect((await h.call("get", `/billing/payroll.csv?from=${day}&to=${day}`, manager)).status).toBe(200);
    expect((await h.call("get", `/billing/payroll?from=${day}&to=2000-01-01`, owner)).status).toBe(400);
  });
});

describe("profit", () => {
  it("shows revenue, estimated cost and margin per customer, job and route", async () => {
    const r = (await h.admin.query("INSERT INTO routes (org_id, name, route_date, status) VALUES ($1,'Profit run',$2,'completed') RETURNING id", [h.orgA, day])).rows[0].id;
    for (let i = 0; i < 2; i++) {
      const j = (await h.admin.query("INSERT INTO jobs (org_id, title, customer_name, status, price) VALUES ($1,$2,'Zed Foods','done',100) RETURNING id", [h.orgA, `Z${i}`])).rows[0].id;
      await h.admin.query("INSERT INTO stops (org_id, route_id, sequence, name, lat, lng, job_id, arrived_at, status) VALUES ($1,$2,$3,'S',43.7,-79.4,$4,$5,'done')", [h.orgA, r, i + 1, j, `${day}T10:00:00Z`]);
    }
    await h.call("post", "/billing/quotes", owner, { customerName: "Zed Foods", lines: [{ description: "x", unitPrice: 1 }] });
    await h.admin.query("INSERT INTO invoices (org_id, number, customer_name, status, issued_on, subtotal, tax, total) VALUES ($1,'INV-HAND-1','Zed Foods','sent',$2,50,0,50)", [h.orgA, day]);
    const byCustomer = ok(await h.call("get", `/billing/profit?from=${day}&to=${day}&by=customer`, owner));
    const zed = byCustomer.rows.find((x: { name: string }) => x.name === "Zed Foods");
    expect(zed).toMatchObject({ revenue: 250, stops: 2 });
    expect(zed.profit).toBeCloseTo(zed.revenue - zed.cost, 2);
    const byJob = ok(await h.call("get", `/billing/profit?from=${day}&to=${day}&by=job`, owner));
    expect(byJob.rows.filter((x: { name: string }) => x.name.startsWith("Z"))).toHaveLength(2);
    const byRoute = ok(await h.call("get", `/billing/profit?from=${day}&to=${day}&by=route`, owner));
    expect(byRoute.rows.find((x: { name: string }) => x.name === "Profit run")).toMatchObject({ revenue: 200, stops: 2 });
    expect(byRoute.totals.revenue).toBeGreaterThanOrEqual(200);
    expect((await h.call("get", `/billing/profit?from=${day}&to=${day}&by=moon`, owner)).status).toBe(400);
    expect((await h.call("get", `/billing/profit?from=${day}&to=${day}`, viewer)).status).toBe(200);
    expect((await h.call("get", `/billing/profit?from=${day}&to=${day}`, ownerB)).body.rows).toEqual([]);
  });
  it("converts invoices in other currencies with the rates in settings", async () => {
    const d = "2020-01-02";
    const r = (await h.admin.query("INSERT INTO routes (org_id, name, route_date, status) VALUES ($1,'FX run',$2,'completed') RETURNING id", [h.orgA, d])).rows[0].id;
    const j = (await h.admin.query("INSERT INTO jobs (org_id, title, customer_name, status) VALUES ($1,'FXJ','Yankee Co','done') RETURNING id", [h.orgA])).rows[0].id;
    await h.admin.query("INSERT INTO stops (org_id, route_id, sequence, name, lat, lng, job_id, arrived_at, status) VALUES ($1,$2,1,'S',43.7,-79.4,$3,$4,'done')", [h.orgA, r, j, `${d}T10:00:00Z`]);
    await h.admin.query("INSERT INTO invoices (org_id, number, job_id, customer_name, status, issued_on, currency, subtotal, tax, total) VALUES ($1,'INV-FX-1',$2,'Yankee Co','sent',$3,'USD',100,0,100)", [h.orgA, j, d]);
    const none = ok(await h.call("get", `/billing/profit?from=${d}&to=${d}&by=customer`, owner));
    expect(none.missingFx).toBe(1);
    ok(await h.call("put", "/org", owner, { settings: { billing: { fxRates: "USD=1.4" } } }));
    const withFx = ok(await h.call("get", `/billing/profit?from=${d}&to=${d}&by=customer`, owner));
    expect(withFx.rows.find((x: { name: string }) => x.name === "Yankee Co").revenue).toBe(140);
    expect(withFx.missingFx).toBe(0);
  });
});
