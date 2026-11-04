import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { startHarness, type Harness } from "../test-harness.js";

let h: Harness, owner: string, acct: string, mgr: string, disp: string, orgB: string, ann: string, car: string, car2: string;
const post = (p: string, t: string, b?: unknown) => h.call("post", p, t, b);
const get = (p: string, t: string) => h.call("get", p, t);
const patch = (p: string, t: string, b?: unknown) => h.call("patch", p, t, b);
const put = (p: string, t: string, b?: unknown) => h.call("put", p, t, b);

let tz = "America/Toronto";
const dayOf = (offset: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now() + offset * 86_400_000));
const at = (offset: number) => `${dayOf(offset)}T17:00:00Z`;
const trip = (offset: number, extra: Record<string, unknown> = {}) => post("/portal/trips", owner, { startedAt: at(offset), distanceKm: 20, durationMin: 30, vehicleId: car, driverId: ann, revenueCents: 10_000, customerName: "Acme", ...extra });

beforeAll(async () => {
  h = await startHarness();
  owner = await h.token("a@example.com");
  tz = (await h.admin.query("SELECT timezone FROM organizations WHERE id = $1", [h.orgA])).rows[0].timezone;
  await h.addUser(h.orgA, "acct@example.com", "accountant"); acct = await h.token("acct@example.com");
  await h.addUser(h.orgA, "mgr@example.com", "manager"); mgr = await h.token("mgr@example.com");
  await h.addUser(h.orgA, "disp@example.com", "dispatcher"); disp = await h.token("disp@example.com");
  ann = await h.addUser(h.orgA, "ann@example.com", "driver", { display_name: "Ann Driver" });
  await h.addUser(h.orgB, "adminb@example.com", "admin"); orgB = await h.token("adminb@example.com");
  car = (await post("/portal/vehicles", owner, { name: "Truck 1", kind: "truck", financePaymentCents: 36_500, financeInterval: "monthly" })).body.id;
  car2 = (await post("/portal/vehicles", owner, { name: "Truck 2", kind: "truck" })).body.id;
  expect((await trip(-2)).status).toBe(201);
  expect((await trip(-1, { revenueCents: 5_000, customerName: "Beta" })).status).toBe(201);
  expect((await trip(-3, { vehicleId: car2, revenueCents: 2_000, customerName: "Beta" })).status).toBe(201);
}, 90_000);
afterAll(async () => { await h.close(); });

const range = () => `from=${dayOf(-6)}&to=${dayOf(0)}`;

describe("expenses", () => {
  it("adds, edits, archives and restores an expense, and audits each step", async () => {
    const r = await post("/portal/finance/expenses", owner, { spentOn: dayOf(-1), category: "fuel", amountCents: 12_345, taxCents: 1_000, vendor: "Petro", vehicleId: car });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    const id = r.body.id as string;
    expect((await patch(`/portal/finance/expenses/${id}`, owner, { amountCents: 20_000 })).status).toBe(200);
    expect((await patch(`/portal/finance/expenses/${id}`, owner, { amountCents: 12.5 })).status).toBe(400);
    expect((await post(`/portal/finance/expenses/${id}/archive`, owner)).status).toBe(200);
    const listed = (await get(`/portal/finance/expenses?${range()}`, owner)).body;
    expect(listed.rows.find((x: { id: string }) => x.id === id)).toBeUndefined();
    expect((await get(`/portal/finance/expenses?${range()}&archived=1`, owner)).body.rows.find((x: { id: string }) => x.id === id).archivedAt).toBeTruthy();
    expect((await post(`/portal/finance/expenses/${id}/restore`, owner)).status).toBe(200);
    const log = (await h.admin.query("SELECT action, old_value, new_value FROM audit_log WHERE entity = 'expenses' AND entity_id = $1 ORDER BY at", [id])).rows;
    expect(log.map((x) => x.action)).toEqual(["expenses.create", "expenses.update", "expenses.archive", "expenses.restore"]);
    expect(log[1].old_value.amount_cents).toBe(12_345); expect(log[1].new_value.amount_cents).toBe(20_000);
  });

  it("refuses bad input and wrong people", async () => {
    const ok = { spentOn: dayOf(-1), category: "fuel", amountCents: 100 };
    expect((await post("/portal/finance/expenses", owner, { ...ok, category: "snacks" })).status).toBe(400);
    expect((await post("/portal/finance/expenses", owner, { ...ok, amountCents: -1 })).status).toBe(400);
    expect((await post("/portal/finance/expenses", owner, { ...ok, vehicleId: "00000000-0000-4000-8000-000000000000" })).status).toBe(400);
    expect((await post("/portal/finance/expenses", owner, { ...ok, nonsense: 1 })).status).toBe(400);
    expect((await post("/portal/finance/expenses", mgr, ok)).status).toBe(403);
    expect((await post("/portal/finance/expenses", disp, ok)).status).toBe(403);
    expect((await get("/portal/finance/expenses", mgr)).status).toBe(403);
    expect((await post("/portal/finance/expenses", acct, ok)).status).toBe(201);
  });

  it("imports with a preview, skips lines already in the books, and refuses a file with a bad line", async () => {
    const rows = [
      { date: dayOf(-2), category: "fuel", amount: "$1,234.50", vendor: "Shell", ref: "BANK-1", vehicle: "Truck 2" },
      { date: dayOf(-2), category: "tolls", amount: "18.00", ref: "BANK-2" },
    ];
    const dry = await post("/portal/finance/expenses/import", owner, { rows });
    expect(dry.body).toMatchObject({ dryRun: true, created: 0, ok: true });
    expect((await h.admin.query("SELECT 1 FROM finance_expenses WHERE external_ref LIKE 'BANK-%'")).rowCount).toBe(0);
    const real = await post("/portal/finance/expenses/import", owner, { rows, dryRun: false });
    expect(real.body).toMatchObject({ dryRun: false, created: 2 });
    const stored = (await h.admin.query("SELECT amount_cents::int AS a, source FROM finance_expenses WHERE external_ref = 'BANK-1'")).rows[0];
    expect(stored).toEqual({ a: 123_450, source: "import" });
    const again = await post("/portal/finance/expenses/import", owner, { rows, dryRun: false });
    expect(again.body).toMatchObject({ created: 0, skippedDuplicates: 2 });
    const bad = await post("/portal/finance/expenses/import", owner, { rows: [{ date: dayOf(-2), category: "fuel", amount: "5", ref: "BANK-3" }, { date: "nope", category: "fuel", amount: "5" }, { date: dayOf(-2), category: "fuel", amount: "5", vehicle: "Ghost car" }], dryRun: false });
    expect(bad.body).toMatchObject({ created: 0, ok: false });
    expect(bad.body.report.map((x: { ok: boolean }) => x.ok)).toEqual([true, false, false]);
    expect((await h.admin.query("SELECT 1 FROM finance_expenses WHERE external_ref = 'BANK-3'")).rowCount).toBe(0);
  });
});

describe("dashboard numbers match the vehicle and finance pages", () => {
  it("overview totals equal the sum of the cars and the profit and loss month", async () => {
    const d = (await get(`/portal/dashboard?${range()}&tab=money`, owner)).body;
    expect(d.overview.revenueCents).toBe(17_000);
    expect(d.overview.trips).toBe(3);
    // profit = revenue - all costs, and it is the same figure the cars add up to
    const a = (await get(`/portal/vehicles/${car}/financials?${range()}`, owner)).body.periods.range;
    const b = (await get(`/portal/vehicles/${car2}/financials?${range()}`, owner)).body.periods.range;
    expect(d.overview.revenueCents).toBe(a.revenueCents + b.revenueCents);
    // expenses not tied to a car (a toll line, a card payment) count for the company but belong to no car
    const loose = Number((await h.admin.query("SELECT coalesce(sum(amount_cents),0)::float8 AS n FROM finance_expenses WHERE vehicle_id IS NULL AND archived_at IS NULL AND spent_on BETWEEN $1 AND $2", [dayOf(-6), dayOf(0)])).rows[0].n);
    expect(loose).toBeGreaterThan(0);
    expect(d.overview.profitCents).toBe(a.profitCents + b.profitCents - loose);
    expect(d.overview.profitCents).toBe(d.overview.revenueCents - d.overview.driverPayCents - d.overview.vehicleCostsCents);
    expect(d.overview.marginPct).toBe(Math.round((d.overview.profitCents / d.overview.revenueCents) * 1000) / 10);
    // the daily line adds up to the period
    const sum = (k: string) => d.money.series.reduce((x: number, p: Record<string, number>) => x + p[k], 0);
    expect(sum("revenueCents")).toBe(d.overview.revenueCents);
    expect(sum("costCents")).toBe(d.overview.revenueCents - d.overview.profitCents);
    expect(sum("profitCents")).toBe(d.overview.profitCents);
    // the cost split adds up to the costs
    expect(d.money.costSplit.reduce((x: number, p: { cents: number }) => x + p.cents, 0)).toBe(d.overview.revenueCents - d.overview.profitCents);
    // the finance cost is the loan payment spread over the days, and a split range gives the same total
    const first = (await get(`/portal/vehicles/${car}/financials?from=${dayOf(-6)}&to=${dayOf(-3)}`, owner)).body.periods.range;
    const second = (await get(`/portal/vehicles/${car}/financials?from=${dayOf(-2)}&to=${dayOf(0)}`, owner)).body.periods.range;
    expect(first.financeCents + second.financeCents).toBe(a.financeCents);
  });

  it("compare turns on the previous period", async () => {
    const d = (await get(`/portal/dashboard?${range()}&compare=1`, owner)).body;
    expect(d.previous.to).toBe(dayOf(-7));
    expect(d.overview.previous).toMatchObject({ revenueCents: 0, trips: 0 });
    expect((await get(`/portal/dashboard?${range()}`, owner)).body.overview.previous).toBeNull();
  });

  it("each tab answers, and the attention list is sorted by urgency", async () => {
    for (const tab of ["fleet", "drivers", "live"]) {
      const r = await get(`/portal/dashboard?${range()}&tab=${tab}`, owner);
      expect(r.status, tab).toBe(200); expect(r.body[tab]).toBeTruthy();
    }
    const f = (await get(`/portal/dashboard?${range()}&tab=fleet`, owner)).body.fleet;
    expect(f.total).toBe(2);
    const att = (await get(`/portal/dashboard?${range()}`, owner)).body.attention as { severity: number }[];
    expect(att.map((x) => x.severity)).toEqual([...att.map((x) => x.severity)].sort((x, y) => x - y));
    expect((await get("/portal/dashboard?from=2026-02-01&to=2026-01-01", owner)).status).toBe(400);
    expect((await get("/portal/dashboard?from=bad", owner)).status).toBe(400);
  });

  it("people only see the tabs their role allows, and other companies see nothing of ours", async () => {
    expect((await get(`/portal/dashboard?${range()}&tab=money`, mgr)).status).toBe(200);
    const dsp = await get(`/portal/dashboard?${range()}&tab=money`, disp);
    expect(dsp.status).toBe(200);
    expect(dsp.body.money).toBeUndefined();
    expect(dsp.body.access.money).toBe(false);
    expect(dsp.body.overview.revenueCents).toBeUndefined();
    const b = await get(`/portal/dashboard?${range()}`, orgB);
    expect(b.body.overview.revenueCents ?? 0).toBe(0);
    expect((await get(`/portal/finance/expenses?${range()}`, orgB)).body.rows).toEqual([]);
  });
});

describe("earnings, margin and the other finance pages", () => {
  it("earnings group by customer, car and day and always add up", async () => {
    for (const by of ["day", "customer", "vehicle", "driver", "route", "zone"]) {
      const r = await get(`/portal/finance/earnings?${range()}&by=${by}`, owner);
      expect(r.status, by).toBe(200);
      expect(r.body.totals.revenueCents, by).toBe(17_000);
      expect(r.body.rows.reduce((a: number, x: { revenueCents: number }) => a + x.revenueCents, 0), by).toBe(17_000);
    }
    const cust = (await get(`/portal/finance/earnings?${range()}&by=customer`, owner)).body.rows;
    expect(cust[0]).toMatchObject({ label: "Acme", revenueCents: 10_000 });
    expect((await get(`/portal/finance/earnings?${range()}&by=nope`, owner)).status).toBe(400);
  });

  it("margin explorer lists the worst first and refuses unknown groupings", async () => {
    for (const by of ["vehicle", "driver", "customer", "route", "zone", "day_of_week", "hour", "rate_card"]) {
      const r = await get(`/portal/finance/margin?${range()}&by=${by}`, owner);
      expect(r.status, by).toBe(200);
      const m = r.body.rows.map((x: { marginCents: number }) => x.marginCents);
      expect(m).toEqual([...m].sort((x: number, y: number) => x - y));
      expect(r.body.totals.revenueCents).toBe(17_000);
    }
    expect((await get(`/portal/finance/margin?${range()}&by=nope`, owner)).status).toBe(400);
  });

  it("profit and loss: months add up to the year and match the dashboard for the month", async () => {
    const y = dayOf(0).slice(0, 4);
    const pl = (await get(`/portal/finance/profit-loss?year=${y}`, owner)).body;
    expect(pl.months).toHaveLength(12);
    for (const k of ["revenueCents", "costCents", "profitCents"]) {
      expect(pl.months.reduce((a: number, m: Record<string, number>) => a + (m[k] ?? 0), 0)).toBe(pl.total[k]);
    }
    for (const m of pl.months.filter((x: { future?: boolean }) => !x.future)) expect(m.profitCents).toBe(m.revenueCents - m.costCents);
    expect((await get("/portal/finance/profit-loss?year=1999", owner)).status).toBe(400);
  });

  it("cash flow gives 30, 60 and 90 day windows that only grow", async () => {
    const cf = (await get("/portal/finance/cash-flow", owner)).body;
    expect(cf.windows.map((w: { days: number }) => w.days)).toEqual([30, 60, 90]);
    expect(cf.windows[2].outCents).toBeGreaterThanOrEqual(cf.windows[0].outCents);
    for (const w of cf.windows) expect(w.netCents).toBe(w.inCents - w.outCents);
  });

  it("invoices and tax answer and the accountant can read but the manager cannot", async () => {
    expect((await get("/portal/finance/invoices", owner)).body.totals).toBeTruthy();
    expect((await get("/portal/finance/tax", acct)).status).toBe(200);
    expect((await get("/portal/finance/payouts", acct)).status).toBe(200);
    for (const p of ["invoices", "tax", "payouts", "profit-loss", "cash-flow", "budget", "margin", "earnings"]) expect((await get(`/portal/finance/${p}`, mgr)).status, p).toBe(403);
  });
});

describe("budget", () => {
  it("shows ok, warning at 80% and over at 100%, and a month's own number beats the every-month one", async () => {
    const m = dayOf(0).slice(0, 7);
    const spent = (await get(`/portal/finance/budget?month=${m}`, owner)).body.rows.find((x: { category: string }) => x.category === "fuel").actualCents as number;
    expect(spent).toBeGreaterThan(0);
    const state = async (amount: number | null, month?: string) => {
      expect((await put("/portal/finance/budget", owner, { category: "fuel", month, amountCents: amount })).status).toBe(200);
      return (await get(`/portal/finance/budget?month=${m}`, owner)).body.rows.find((x: { category: string }) => x.category === "fuel");
    };
    expect((await state(null)).state).toBe("none");
    expect(await state(Math.ceil(spent * 10))).toMatchObject({ state: "ok", appliesTo: "every month" });
    expect((await state(Math.ceil(spent / 0.85))).state).toBe("warning");
    expect((await state(spent)).state).toBe("over");
    expect(await state(Math.ceil(spent * 10), m)).toMatchObject({ state: "ok", appliesTo: "this month" });
    expect((await state(null, m)).state).toBe("over"); // back to the every-month number
    await state(null);
    expect((await put("/portal/finance/budget", owner, { category: "fuel", amountCents: 0 })).status).toBe(400);
    expect((await put("/portal/finance/budget", owner, { category: "fuel", amountCents: 10.5 })).status).toBe(400);
    expect((await put("/portal/finance/budget", owner, { category: "snacks", amountCents: 100 })).status).toBe(400);
    expect((await put("/portal/finance/budget", owner, { category: "fuel", month: "soon", amountCents: 100 })).status).toBe(400);
    expect((await put("/portal/finance/budget", mgr, { category: "fuel", amountCents: 100 })).status).toBe(403);
    const log = (await h.admin.query("SELECT 1 FROM audit_log WHERE action = 'budget.set'")).rowCount;
    expect(log).toBeGreaterThan(3);
  });

  it("budgets are private to each company", async () => {
    await put("/portal/finance/budget", owner, { category: "fuel", amountCents: 777 });
    const b = (await get("/portal/finance/budget", orgB)).body.rows.find((x: { category: string }) => x.category === "fuel");
    expect(b.budgetCents).toBeNull();
    await put("/portal/finance/budget", owner, { category: "fuel", amountCents: null });
  });
});
