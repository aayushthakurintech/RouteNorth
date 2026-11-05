import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";

let h: Harness, owner: string, admin: string, acct: string, mgr: string, disp: string, orgB: string, annTok: string;
let ann: string, bob: string, cardDriver: string, cardCust: string, v1: string;
const post = (p: string, t: string, b?: unknown) => h.call("post", p, t, b);
const get = (p: string, t: string) => h.call("get", p, t);
const patch = (p: string, t: string, b?: unknown) => h.call("patch", p, t, b);
const put = (p: string, t: string, b?: unknown) => h.call("put", p, t, b);

let tz = "America/Toronto";
// Calendar arithmetic, not "now minus N x 24 hours": a daylight-saving change inside the window would otherwise make a 7-day span count as 6.
const dayOf = (offset: number) => {
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date());
  return new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
};
const at = (offset: number) => `${dayOf(offset)}T17:00:00Z`;
const WORKED = { startedAt: at(-1), distanceKm: 25, durationMin: 40, waitingMin: 10, stops: 1, tipCents: 500, conditions: { peak: true } };
const SPEC = { type: "base_distance_time", baseCents: 400, perKmCents: 120, perMinCents: 30, waiting: { freeMin: 5, perMinCents: 50 }, peakPct: 20 };

beforeAll(async () => {
  h = await startHarness();
  owner = await h.token("a@example.com");
  tz = (await h.admin.query("SELECT timezone FROM organizations WHERE id = $1", [h.orgA])).rows[0].timezone;
  await h.addUser(h.orgA, "admin@example.com", "admin"); admin = await h.token("admin@example.com");
  await h.addUser(h.orgA, "acct@example.com", "accountant"); acct = await h.token("acct@example.com");
  await h.addUser(h.orgA, "mgr@example.com", "manager"); mgr = await h.token("mgr@example.com");
  await h.addUser(h.orgA, "disp@example.com", "dispatcher"); disp = await h.token("disp@example.com");
  ann = await h.addUser(h.orgA, "ann@example.com", "driver", { display_name: "Ann Driver" }); annTok = await h.token("ann@example.com");
  bob = await h.addUser(h.orgA, "bob@example.com", "driver", { display_name: "Bob Driver" });
  await h.addUser(h.orgB, "adminb@example.com", "admin"); orgB = await h.token("adminb@example.com");
}, 90_000);
afterAll(async () => { await h.close(); });

describe("rate cards: checks, versions and the second-person rule", () => {
  it("refuses a card with bad numbers", async () => {
    const bad = (spec: unknown) => post("/portal/pay/cards", owner, { name: "Bad", kind: "driver", startsOn: dayOf(-30), spec });
    expect((await bad({ type: "flat", flatCents: 12.5 })).status).toBe(400); // fractions of a cent in a fee
    expect((await bad({ type: "flat", flatCents: -5 })).status).toBe(400);
    expect((await bad({ type: "flat" })).status).toBe(400);
    expect((await bad({ type: "nonsense" })).status).toBe(400);
    expect((await bad({ type: "flat", flatCents: 100, secret: 1 })).status).toBe(400);
    expect((await bad({ type: "commission", commissionPct: 150 })).status).toBe(400);
  });

  it("a new card waits for a second person, who cannot be the one who asked", async () => {
    const r = await post("/portal/pay/cards", owner, { name: "Standard driver pay", kind: "driver", startsOn: dayOf(-30), spec: SPEC });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    cardDriver = r.body.id; v1 = r.body.versionId;
    const c = await post("/portal/pay/cards", owner, { name: "Standard customer price", kind: "customer", startsOn: dayOf(-30), spec: { type: "base_distance_time", baseCents: 800, perKmCents: 200, perMinCents: 50 } });
    cardCust = c.body.id;
    expect((await post(`/portal/pay/versions/${v1}/submit`, owner)).body).toMatchObject({ status: "pending", needsApproval: true });
    const self = await post(`/portal/pay/versions/${v1}/approve`, owner);
    expect(self.status).toBe(409);
    expect(self.body.code).toBe("second_person_required");
    expect((await post(`/portal/pay/versions/${v1}/approve`, mgr)).status).toBe(403); // a manager cannot manage pay
    expect((await post(`/portal/pay/versions/${v1}/approve`, admin)).status).toBe(200);
    // the customer card goes live the same way
    const cd = await get(`/portal/pay/cards/${cardCust}`, owner); expect(cd.status, JSON.stringify(cd.body)).toBe(200);
    const cv = cd.body.versions[0].id;
    await post(`/portal/pay/versions/${cv}/submit`, owner); await post(`/portal/pay/versions/${cv}/approve`, admin);
    const list = (await get("/portal/pay/cards", owner)).body as { id: string; state: string }[];
    expect(list.find((x) => x.id === cardDriver)!.state).toBe("active");
    const log = await h.admin.query("SELECT action, sensitive, new_value FROM audit_log WHERE entity IN ('rate_cards','rate_versions') ORDER BY at");
    expect(log.rows.map((x) => x.action)).toEqual(expect.arrayContaining(["rate_cards.create", "rate_versions.submit", "rate_versions.activate"]));
    expect(log.rows.every((x) => x.sensitive)).toBe(true);
  });

  it("people without pay rights cannot see or change cards, and another company sees none", async () => {
    expect((await get("/portal/pay/cards", disp)).status).toBe(403);
    expect((await get("/portal/pay/cards", mgr)).status).toBe(200); // view only
    expect((await post("/portal/pay/cards", mgr, { name: "X", kind: "driver", startsOn: dayOf(0), spec: SPEC })).status).toBe(403);
    expect((await get("/portal/pay/cards", orgB)).body).toEqual([]);
    expect((await get(`/portal/pay/cards/${cardDriver}`, orgB)).status).toBe(404);
  });
});

describe("assignments: which card wins", () => {
  it("assign to everyone, then a driver-specific card beats the company default", async () => {
    expect((await post("/portal/pay/assignments", owner, { cardId: cardDriver, kind: "all", startsOn: dayOf(-30) })).status).toBe(201);
    expect((await post("/portal/pay/assignments", owner, { cardId: cardCust, kind: "all", startsOn: dayOf(-30) })).status).toBe(201);
    expect((await get(`/portal/pay/resolve?kind=driver&driverId=${ann}`, owner)).body.version.name).toBe("Standard driver pay");
    // a richer card for Bob only
    const r = await post("/portal/pay/cards", owner, { name: "Bob special", kind: "driver", startsOn: dayOf(-30), spec: { type: "flat", flatCents: 2500 } });
    const vid = (await get(`/portal/pay/cards/${r.body.id}`, owner)).body.versions[0].id;
    await post(`/portal/pay/versions/${vid}/submit`, owner); await post(`/portal/pay/versions/${vid}/approve`, admin);
    expect((await post("/portal/pay/assignments", owner, { cardId: r.body.id, kind: "driver", target: bob, startsOn: dayOf(-30) })).status).toBe(201);
    const res = (await get(`/portal/pay/resolve?kind=driver&driverId=${bob}`, owner)).body;
    expect(res.version.name).toBe("Bob special");
    expect(res.winner.kind).toBe("driver");
    expect(res.considered.filter((x: { matches: boolean }) => x.matches)).toHaveLength(2); // both apply, the driver one wins
    expect((await get(`/portal/pay/resolve?kind=driver&driverId=${ann}`, owner)).body.version.name).toBe("Standard driver pay");
    expect((await post("/portal/pay/assignments", owner, { cardId: r.body.id, kind: "driver", target: "not-an-id" })).status).toBe(400);
    // the driver list shows each driver's card
    const rows = (await get("/portal/drivers", owner)).body as { id: string; rateCardName: string }[];
    expect(rows.find((x) => x.id === bob)!.rateCardName).toBe("Bob special");
    expect(rows.find((x) => x.id === ann)!.rateCardName).toMatch(/Standard driver pay/);
  });
});

describe("simulator and trips: the spec's worked example", () => {
  it("the simulator gives $58.20 earned and $55.20 net after the $8 fee", async () => {
    const r = await post("/portal/pay/simulate", owner, { driverCardId: cardDriver, customerCardId: cardCust, trip: { distanceKm: 25, durationMin: 40, waitingMin: 10, tipCents: 500, conditions: { peak: true } }, carCostPerKmCents: 20 });
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.driver.payCents).toBe(5820);
    expect(r.body.driver.totalCents).toBe(6320); // with the tip
    expect(r.body.driver.payCents + 500 - 800).toBe(5520);
    expect(r.body.customer.subtotalCents).toBe(800 + 5000 + 2000); // 8 + 25 x 2.00 + 40 x 0.50
    expect(r.body.carCost.totalCents).toBe(500);
    expect(r.body.marginCents).toBe(7800 - 5820 - 500);
  });

  it("a trip is priced from the cards in force that day and stores which versions it used", async () => {
    const t = await post("/portal/trips", owner, { ...WORKED, driverId: ann, customerName: "Acme", title: "Worked example" });
    expect(t.status, JSON.stringify(t.body)).toBe(201);
    const d = (await get(`/portal/trips/${t.body.id}`, owner)).body;
    expect(d.driverPayCents).toBe(5820);
    expect(d.revenueCents).toBe(7800);
    expect(d.driverLines.map((l: { key: string }) => l.key)).toEqual(expect.arrayContaining(["base", "distance", "time", "waiting", "peak", "tip"]));
    expect(d.driverCard).toMatchObject({ name: "Standard driver pay", version: 1 });
    expect(d.customerCard.name).toBe("Standard customer price");
    expect(d.marginCents).toBe(7800 - 5820 - (d.vehicleCostCents ?? 0));
    expect(d.driverLines.every((l: { cents: number }) => Number.isInteger(l.cents))).toBe(true);
  });

  it("a price typed by hand wins over the card, and money must be whole cents", async () => {
    const t = await post("/portal/trips", owner, { ...WORKED, startedAt: at(-2), driverId: ann, revenueCents: 9000 });
    expect((await get(`/portal/trips/${t.body.id}`, owner)).body.revenueCents).toBe(9000);
    expect((await post("/portal/trips", owner, { ...WORKED, driverId: ann, revenueCents: 90.5 })).status).toBe(400);
    expect((await post("/portal/trips", owner, { ...WORKED, driverId: ann, tipCents: "5" })).status).toBe(400);
    expect((await post("/portal/trips", mgr, { ...WORKED, driverId: ann })).status).toBe(403);
  });

  it("an old trip keeps the old rate when the card changes", async () => {
    // a small change (under 10 percent) goes live at once; it starts today
    const r = await post(`/portal/pay/cards/${cardDriver}/versions`, owner, { spec: { ...SPEC, perKmCents: 125 }, startsOn: dayOf(0), changeNote: "Fuel went up" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body.bigChange).toBe(false);
    expect((await post(`/portal/pay/versions/${r.body.id}/submit`, owner)).body.status).toBe("active");
    // a version cannot start before the one in force
    expect((await post(`/portal/pay/cards/${cardDriver}/versions`, owner, { spec: SPEC, startsOn: dayOf(-40) })).status).toBe(400);
    const today = await post("/portal/trips", owner, { ...WORKED, startedAt: at(0), driverId: ann, title: "Today" });
    expect((await get(`/portal/trips/${today.body.id}`, owner)).body.driverCard.version).toBe(2);
    expect((await get(`/portal/trips/${today.body.id}`, owner)).body.driverPayCents).toBe(5970); // 25 km x 5 cents more, plus 20% peak on it
    // yesterday's trip is recalculated on request and still prices at version 1
    const old = (await get("/portal/trips?limit=50", owner)).body.trips.find((x: { title: string }) => x.title === "Worked example");
    await post(`/portal/trips/${old.id}/recalculate`, owner);
    const again = (await get(`/portal/trips/${old.id}`, owner)).body;
    expect(again.driverPayCents).toBe(5820);
    expect(again.driverCard.version).toBe(1);
  });

  it("a big change (over 10 percent) needs a second person", async () => {
    const r = await post(`/portal/pay/cards/${cardDriver}/versions`, owner, { spec: { ...SPEC, perKmCents: 160 }, startsOn: dayOf(5) });
    expect(r.body.bigChange).toBe(true);
    expect((await post(`/portal/pay/versions/${r.body.id}/submit`, owner)).body.status).toBe("pending");
    expect((await get("/portal/pay/approvals", admin)).body.rateCards).toHaveLength(1);
    expect((await post(`/portal/pay/versions/${r.body.id}/reject`, admin, { note: "too high" })).status).toBe(200);
    expect((await get(`/portal/pay/cards/${cardDriver}`, owner)).body.versions[0].status).toBe("draft");
    expect((await h.call("delete", `/portal/pay/versions/${r.body.id}`, owner)).status).toBe(200);
  });
});

describe("compare, what-if and bonuses", () => {
  it("compares two cards and replays recent trips without saving anything", async () => {
    const before = (await h.admin.query("SELECT count(*)::int AS n FROM portal_pay_lines")).rows[0].n;
    const w = await post("/portal/pay/what-if", owner, { spec: { ...SPEC, perKmCents: 200 }, from: dayOf(-10), to: dayOf(0) });
    expect(w.status, JSON.stringify(w.body)).toBe(200);
    expect(w.body.trips).toBeGreaterThanOrEqual(3);
    expect(w.body.costChangeCents).toBeGreaterThan(0);
    expect(w.body.marginChangeCents).toBe(-w.body.costChangeCents);
    const cmp = await post("/portal/pay/compare", owner, { kind: "driver", aSpec: SPEC, bSpec: { ...SPEC, perKmCents: 200 }, from: dayOf(-10), to: dayOf(0) });
    expect(cmp.body.differenceAverageCents).toBeGreaterThan(0);
    expect((await h.admin.query("SELECT count(*)::int AS n FROM portal_pay_lines")).rows[0].n).toBe(before);
  });

  it("bonus rules show progress and validate their numbers", async () => {
    expect((await post("/portal/pay/bonuses", owner, { name: "Bad", kind: "trip_count", amountCents: 12.5 })).status).toBe(400);
    const r = await post("/portal/pay/bonuses", owner, { name: "3 trips a week", kind: "trip_count", amountCents: 7500, params: { minTrips: 3 }, period: "week" });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const p = (await get(`/portal/pay/bonuses/preview?driverId=${ann}&from=${dayOf(-6)}&to=${dayOf(0)}`, owner)).body;
    expect(p.rules[0]).toMatchObject({ name: "3 trips a week", earnedCents: 7500, current: 3, target: 3 });
    const drv = (await get(`/portal/pay/drivers/${ann}`, owner)).body;
    expect(drv.rateCard.name).toBe("Standard driver pay");
    expect(drv.bonusProgress[0].name).toBe("3 trips a week");
  });
});

describe("adjustments and deductions need a second person", () => {
  it("a bonus typed by hand needs a reason and an approval", async () => {
    expect((await post("/portal/pay/adjustments", owner, { driverId: ann, kind: "bonus", amountCents: 2000 })).status).toBe(400); // reason
    const r = await post("/portal/pay/adjustments", owner, { driverId: ann, kind: "bonus", amountCents: 2000, reason: "Covered a night shift" });
    expect(r.body.approval).toBe("pending");
    // not counted yet
    const before = (await get(`/portal/pay/drivers/${ann}`, owner)).body.unpaidCents;
    expect((await post(`/portal/pay/adjustments/${r.body.id}/approve`, owner)).status).toBe(409);
    expect((await post(`/portal/pay/adjustments/${r.body.id}/approve`, admin)).status).toBe(200);
    expect((await get(`/portal/pay/drivers/${ann}`, owner)).body.unpaidCents).toBe(before + 2000);
    const neg = await post("/portal/pay/adjustments", owner, { driverId: ann, kind: "adjustment", amountCents: -300, reason: "Overpaid last week" });
    expect((await post(`/portal/pay/adjustments/${neg.body.id}/reject`, admin)).body.approval).toBe("rejected");
    expect((await get(`/portal/pay/drivers/${ann}`, owner)).body.unpaidCents).toBe(before + 2000);
  });

  it("a deduction needs a reason, an approval and is visible to the driver", async () => {
    expect((await post("/portal/pay/deductions", owner, { driverId: ann, kind: "fine", label: "Parking ticket", totalCents: 5000, perPayoutCents: 2000 })).status).toBe(400);
    const d = await post("/portal/pay/deductions", owner, { driverId: ann, kind: "fine", label: "Parking ticket", reason: "Ticket 4411 on Main St", totalCents: 5000, perPayoutCents: 2000 });
    expect(d.body.status).toBe("pending_approval");
    expect(((await get("/portal/me/pay", annTok)).body.deductions as unknown[]).length).toBe(0); // not visible until active
    expect((await post(`/portal/pay/deductions/${d.body.id}/approve`, owner)).status).toBe(409);
    expect((await post(`/portal/pay/deductions/${d.body.id}/approve`, admin)).status).toBe(200);
    const mine = (await get("/portal/me/pay", annTok)).body;
    expect(mine.deductions[0]).toMatchObject({ label: "Parking ticket", reason: "Ticket 4411 on Main St", totalCents: 5000 });
  });
});

describe("payout run: sums, holds, approval, statement, dispute and exports", () => {
  let runId: string, payoutId: string;

  it("builds a run whose payouts add up to the cent and takes deductions in parts", async () => {
    await h.admin.query("UPDATE driver_profiles SET employment_type = 'contractor' WHERE user_id = $1", [bob]);
    // Bob has a trip too, but an expired licence holds his payout
    await post("/portal/trips", owner, { ...WORKED, startedAt: at(-3), driverId: bob, title: "Bob trip" });
    await h.admin.query("UPDATE driver_profiles SET license_expiry = '2020-01-01' WHERE user_id = $1", [bob]);
    const r = await post("/portal/payouts/runs", owner, { cycle: "weekly", from: dayOf(-6), to: dayOf(0) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    runId = r.body.id;
    const run = (await get(`/portal/payouts/runs/${runId}`, owner)).body;
    expect(run.payouts).toHaveLength(2);
    for (const p of run.payouts) {
      const sum = (await h.admin.query("SELECT coalesce(sum(amount_cents),0)::int AS s FROM portal_pay_lines WHERE payout_id = $1 AND archived_at IS NULL", [p.id])).rows[0].s;
      expect(p.netCents).toBe(sum); // no drift
      expect(p.netCents).toBe(p.earningsCents + p.bonusCents + p.tipsCents - p.deductionCents);
    }
    const a = run.payouts.find((p: { driverName: string }) => p.driverName === "Ann Driver");
    payoutId = a.id;
    expect(a.bonusCents).toBe(7500 + 2000); // the rule bonus and the approved one-time bonus
    expect(a.deductionCents).toBe(2000); // 2000 of the 5000 this time
    expect(a.status).toBe("draft");
    const b = run.payouts.find((p: { driverName: string }) => p.driverName === "Bob Driver");
    expect(b.holdReason).toMatch(/Expired document/);
    expect(run.totals.netCents).toBe(a.netCents + b.netCents);
    // an empty period has nothing to pay
    expect((await post("/portal/payouts/runs", owner, { from: dayOf(-60), to: dayOf(-50) })).status).toBe(400);
    expect((await post("/portal/payouts/runs", owner, { from: dayOf(-6), to: dayOf(0) })).status).toBe(409);
  });

  it("a trip in a payout is locked, and the deduction cap is respected on the next run", async () => {
    const t = (await get("/portal/trips?limit=50", owner)).body.trips.find((x: { title: string }) => x.title === "Worked example");
    const r = await post(`/portal/trips/${t.id}/recalculate`, owner);
    expect(r.status).toBe(409);
    expect(r.body.code).toBe("trip_locked");
    expect((await patch(`/portal/trips/${t.id}`, owner, { distanceKm: 30 })).status).toBe(409);
    expect((await patch(`/portal/trips/${t.id}`, owner, { note: "checked" })).status).toBe(200); // notes are fine
    expect((await post(`/portal/trips/${t.id}/archive`, owner)).status).toBe(409);
  });

  it("the person who built the run cannot approve it; an accountant can; held payouts wait", async () => {
    expect((await post(`/portal/payouts/runs/${runId}/approve`, owner)).status).toBe(409);
    expect((await post(`/portal/payouts/runs/${runId}/approve`, admin)).status).toBe(403); // admins cannot approve payouts
    expect((await post(`/portal/payouts/runs/${runId}/approve`, mgr)).status).toBe(403);
    const ok = await post(`/portal/payouts/runs/${runId}/approve`, acct);
    expect(ok.body.approved).toBe(1);
    const run = (await get(`/portal/payouts/runs/${runId}`, owner)).body;
    expect(run.payouts.find((p: { driverName: string }) => p.driverName === "Bob Driver").status).toBe("draft");
    const b = run.payouts.find((p: { driverName: string }) => p.driverName === "Bob Driver");
    expect((await post(`/portal/payouts/${b.id}/approve`, acct)).body.code).toBe("payout_held");
    // clearing the cause and releasing with a note
    expect((await patch(`/portal/payouts/${b.id}/hold`, acct, { release: true })).status).toBe(400);
    expect((await patch(`/portal/payouts/${b.id}/hold`, acct, { release: true, overrideNote: "Renewal received by email" })).status).toBe(200);
    expect((await post(`/portal/payouts/${b.id}/approve`, acct)).status).toBe(200);
    const log = await h.admin.query("SELECT sensitive FROM audit_log WHERE action IN ('payouts.approve','payouts.approved')");
    expect(log.rows.length).toBeGreaterThanOrEqual(2);
    expect(log.rows.every((x) => x.sensitive)).toBe(true);
  });

  it("goes sent, then failed, then paid, and the driver sees the statement", async () => {
    expect((await post(`/portal/payouts/${payoutId}/paid`, acct, {})).status).toBe(200); // approved -> paid is allowed
    expect((await post(`/portal/payouts/${payoutId}/approve`, acct)).status).toBe(409); // cannot go backwards
    const s = (await get(`/portal/me/pay/payouts/${payoutId}`, annTok)).body;
    expect(s.payout.status).toBe("paid");
    expect(s.trips.length).toBe(3);
    expect(s.bonuses.map((b: { label: string }) => b.label).join()).toMatch(/3 trips a week/);
    expect(s.deductions[0]).toMatchObject({ cents: -2000 });
    expect(s.deductions[0].reason).toMatch(/Ticket 4411/);
    expect(s.ratesUsed.map((r: { name: string }) => r.name)).toContain("Standard driver pay");
    expect(s.totalsCheck.sumOfLinesCents).toBe(s.totalsCheck.netCents);
    expect((await get(`/portal/me/pay/payouts/${payoutId}`, await h.token("bob@example.com"))).status).toBe(404); // not someone else's
    const note = await h.admin.query("SELECT title FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1", [ann]);
    expect(note.rows[0].title).toMatch(/was paid/);
    const bobP = (await get(`/portal/payouts/runs/${runId}`, owner)).body.payouts.find((p: { driverName: string }) => p.driverName === "Bob Driver");
    expect((await post(`/portal/payouts/${bobP.id}/failed`, acct, {})).status).toBe(400); // needs a note
    expect((await post(`/portal/payouts/${bobP.id}/failed`, acct, { note: "Bank rejected the transfer" })).status).toBe(200);
    expect((await post(`/portal/payouts/${bobP.id}/send`, acct, { method: "etransfer" })).status).toBe(200);
    expect((await post(`/portal/payouts/${bobP.id}/paid`, acct, { paymentRef: "ET-1234" })).status).toBe(200);
    expect((await get(`/portal/payouts/runs/${runId}`, owner)).body.status).toBe("paid");
  });

  it("the driver questions a line, the owner replies with a fix, and the paid payout is not rewritten", async () => {
    const s = (await get(`/portal/me/pay/payouts/${payoutId}`, annTok)).body;
    const line = s.trips[0].lines[0].id;
    expect((await post("/portal/me/pay/disputes", annTok, { payoutId, lineId: line, message: "" })).status).toBe(400);
    const d = await post("/portal/me/pay/disputes", annTok, { payoutId, lineId: line, message: "I waited longer than that" });
    expect(d.status, JSON.stringify(d.body)).toBe(201);
    expect((await get(`/portal/payouts/${payoutId}`, owner)).body.payout.status).toBe("disputed");
    const netBefore = (await get(`/portal/payouts/${payoutId}`, owner)).body.payout.netCents;
    const res = await post(`/portal/payouts/disputes/${d.body.id}/resolve`, owner, { reply: "You are right, added 5 minutes of waiting", fixCents: 250, fixReason: "Waiting time correction" });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = (await get(`/portal/payouts/${payoutId}`, owner)).body;
    expect(after.payout.status).toBe("paid"); // back to what it was
    expect(after.payout.netCents).toBe(netBefore); // old money does not move
    const fix = await h.admin.query("SELECT amount_cents::int AS c, payout_id, approval FROM portal_pay_lines WHERE id = $1", [res.body.fixLineId]);
    expect(fix.rows[0]).toMatchObject({ c: 250, payout_id: null, approval: "approved" }); // goes into the next payout
    expect((await post(`/portal/payouts/disputes/${d.body.id}/resolve`, owner, { reply: "again" })).status).toBe(409);
    expect((await h.admin.query("SELECT 1 FROM audit_log WHERE action = 'disputes.resolve' AND sensitive")).rowCount).toBe(1);
  });

  it("exports match the run and year-end totals add up", async () => {
    const run = (await get(`/portal/payouts/runs/${runId}`, owner)).body;
    const csv = await h.call("get", `/portal/payouts/runs/${runId}/export?format=csv`, owner);
    expect(csv.status).toBe(200);
    const lines = (csv.text as string).replace(/^﻿/, "").split(/\r\n/);
    expect(lines).toHaveLength(1 + run.payouts.length);
    expect(lines.join("\n")).toContain(String(run.payouts[0].netCents / 100));
    const qb = await h.call("get", `/portal/payouts/runs/${runId}/export?format=quickbooks`, owner);
    expect(qb.text).toContain("Contract labour"); // Bob is a contractor
    expect((await h.call("get", `/portal/payouts/runs/${runId}/export?format=xero`, owner)).text).toContain("ContactName");
    expect((await h.call("get", `/portal/payouts/runs/${runId}/export?format=xlsx`, owner)).status).toBe(200);
    expect((await h.call("get", `/portal/payouts/runs/${runId}/export?format=pdf`, owner)).status).toBe(400);
    expect((await h.call("get", `/portal/payouts/runs/${runId}/export?format=csv`, disp)).status).toBe(403);
    const ye = (await get(`/portal/payouts/year-end?year=${dayOf(0).slice(0, 4)}`, owner)).body;
    expect(ye.rows).toHaveLength(2);
    expect(ye.rows.reduce((a: number, r: { netCents: number }) => a + r.netCents, 0)).toBe(run.totals.netCents);
    expect(ye.rows.find((r: { driver: string }) => r.driver === "Bob Driver").employmentType).toBe("contractor");
  });

  it("the dispute fix is paid in the next run, and a run can be cancelled and rebuilt before approval", async () => {
    const r = await post("/portal/payouts/runs", owner, { from: dayOf(-6), to: dayOf(0) });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const run = (await get(`/portal/payouts/runs/${r.body.id}`, owner)).body;
    expect(run.payouts).toHaveLength(1);
    expect(run.payouts[0]).toMatchObject({ earningsCents: 250, deductionCents: 125, netCents: 125 }); // 250 fix; only 50% of it can be taken for the ticket
    const dTaken = (await h.admin.query("SELECT taken_cents::int AS t FROM portal_deductions WHERE driver_id = $1", [ann])).rows[0].t;
    expect(dTaken).toBe(2000 + run.payouts[0].deductionCents);
    expect((await post(`/portal/payouts/runs/${r.body.id}/cancel`, owner)).status).toBe(200);
    expect((await h.admin.query("SELECT taken_cents::int AS t FROM portal_deductions WHERE driver_id = $1", [ann])).rows[0].t).toBe(2000); // given back
    expect((await h.admin.query("SELECT 1 FROM portal_pay_lines WHERE driver_id = $1 AND payout_id IS NULL AND source = 'dispute'", [ann])).rowCount).toBe(1);
  });
});

describe("archive, import and settings", () => {
  it("archives a card instead of deleting it; the old trips still show its name", async () => {
    const k = await post("/portal/pay/cards/" + cardCust + "/clone", owner, { name: "Copy of customer" });
    expect(k.status).toBe(201);
    expect((await post(`/portal/pay/cards/${k.body.id}/archive`, owner)).status).toBe(200);
    expect(((await get("/portal/pay/cards", owner)).body as { id: string }[]).some((x) => x.id === k.body.id)).toBe(false);
    expect(((await get("/portal/pay/cards?archived=1", owner)).body as { id: string }[]).some((x) => x.id === k.body.id)).toBe(true);
    expect((await h.admin.query("SELECT 1 FROM portal_rate_cards WHERE id = $1", [k.body.id])).rowCount).toBe(1);
  });

  it("imports trips after checking every line", async () => {
    const rows = [{ startedAt: at(-1), driverEmail: "ann@example.com", distanceKm: "12", durationMin: "20", price: "30.50", tip: "2" }, { startedAt: "not a date", driverEmail: "nobody@example.com" }];
    const dry = await post("/portal/trips/import", owner, { rows });
    expect(dry.body.ok).toBe(false);
    expect(dry.body.report[1].errors.length).toBeGreaterThan(0);
    expect((await post("/portal/trips/import", owner, { rows, dryRun: false })).body.created).toBe(0); // nothing is saved when any line is bad
    const ok = await post("/portal/trips/import", owner, { rows: [rows[0]], dryRun: false });
    expect(ok.body.created).toBe(1);
    const t = (await get("/portal/trips?limit=100", owner)).body.trips.find((x: { revenueCents: number; tipCents: number }) => x.revenueCents === 3050 && x.tipCents === 200);
    expect(t).toBeTruthy();
  });

  it("only an owner can turn the second-person rule off, and then approvals are immediate", async () => {
    expect((await put("/portal/pay/settings", admin, { secondApprover: false })).status).toBe(403);
    expect((await put("/portal/pay/settings", owner, { deductionCapPct: 120 })).status).toBe(400);
    expect((await put("/portal/pay/settings", owner, { secondApprover: false })).status).toBe(200);
    const r = await post("/portal/pay/adjustments", owner, { driverId: ann, kind: "bonus", amountCents: 100, reason: "Thanks" });
    expect(r.body.approval).toBe("approved");
    await put("/portal/pay/settings", owner, { secondApprover: true });
  });
});
