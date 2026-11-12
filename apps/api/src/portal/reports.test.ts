import { unzipSync } from "fflate";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CATALOG } from "../reports/catalog.js";
import { draftFromText, previousPeriod, sameLastYear } from "../reports/report-utils.js";
import { startHarness, type Harness } from "../test-harness.js";

let h: Harness, owner: string, admin: string, acct: string, mgr: string, disp: string, viewer: string, orgB: string, ann: string, car: string, car2: string, team: string;
const post = (p: string, t: string, b?: unknown) => h.call("post", p, t, b);
const get = (p: string, t: string) => h.call("get", p, t);
const patch = (p: string, t: string, b?: unknown) => h.call("patch", p, t, b);

let tz = "America/Toronto";
const dayOf = (offset: number) => new Intl.DateTimeFormat("en-CA", { timeZone: tz }).format(new Date(Date.now() + offset * 86_400_000));
const at = (offset: number) => `${dayOf(offset)}T17:00:00Z`;
const range = () => `from=${dayOf(-6)}&to=${dayOf(0)}`;
const run = (t: string, body: Record<string, unknown>) => post("/portal/reports/run", t, { from: dayOf(-6), to: dayOf(0), ...body });

beforeAll(async () => {
  h = await startHarness();
  owner = await h.token("a@example.com");
  tz = (await h.admin.query("SELECT timezone FROM organizations WHERE id = $1", [h.orgA])).rows[0].timezone;
  await h.addUser(h.orgA, "admin@example.com", "admin"); admin = await h.token("admin@example.com");
  await h.addUser(h.orgA, "acct@example.com", "accountant"); acct = await h.token("acct@example.com");
  await h.addUser(h.orgA, "mgr@example.com", "manager"); mgr = await h.token("mgr@example.com");
  await h.addUser(h.orgA, "disp@example.com", "dispatcher"); disp = await h.token("disp@example.com");
  await h.addUser(h.orgA, "view@example.com", "viewer"); viewer = await h.token("view@example.com");
  ann = await h.addUser(h.orgA, "ann@example.com", "driver", { display_name: "Ann Driver" });
  await h.addUser(h.orgB, "adminb@example.com", "admin"); orgB = await h.token("adminb@example.com");
  car = (await post("/portal/vehicles", owner, { name: "Truck 1", kind: "truck", financePaymentCents: 36_500, financeInterval: "monthly" })).body.id;
  car2 = (await post("/portal/vehicles", owner, { name: "Truck 2", kind: "truck" })).body.id;
  const trip = (offset: number, extra: Record<string, unknown> = {}) => post("/portal/trips", owner, { startedAt: at(offset), distanceKm: 20, durationMin: 30, vehicleId: car, driverId: ann, revenueCents: 10_000, customerName: "Acme", rating: 5, ...extra });
  expect((await trip(-2)).status).toBe(201);
  expect((await trip(-1, { revenueCents: 5_000, customerName: "Beta" })).status).toBe(201);
  expect((await trip(-3, { vehicleId: car2, revenueCents: 2_000, customerName: "Beta" })).status).toBe(201);
  await post("/portal/finance/expenses", owner, { spentOn: dayOf(-1), category: "fuel", amountCents: 12_345, vendor: "Petro", vehicleId: car });
  await post("/portal/finance/expenses", owner, { spentOn: dayOf(-2), category: "software", amountCents: 1_900, vendor: "Maps Inc" });
  team = (await h.admin.query("INSERT INTO teams (org_id, name) VALUES ($1,'West') RETURNING id", [h.orgA])).rows[0].id;
  const mid = (await h.admin.query("SELECT id FROM users WHERE email = 'mgr@example.com'")).rows[0].id;
  await h.admin.query("INSERT INTO team_members (org_id, team_id, user_id) VALUES ($1,$2,$3)", [h.orgA, team, mid]);
}, 90_000);
afterAll(async () => { await h.close(); });

describe("the catalog", () => {
  it("has the 56 reports of the spec, each id once, and every group is filled", () => {
    const want = [...Array.from({ length: 12 }, (_, i) => `V${i + 1}`), ...Array.from({ length: 12 }, (_, i) => `D${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `P${i + 1}`), ...Array.from({ length: 7 }, (_, i) => `T${i + 1}`), ...Array.from({ length: 8 }, (_, i) => `F${i + 1}`), ...Array.from({ length: 5 }, (_, i) => `C${i + 1}`), ...Array.from({ length: 4 }, (_, i) => `X${i + 1}`)];
    expect(CATALOG.map((r) => r.id).sort()).toEqual([...want].sort());
    expect(CATALOG).toHaveLength(56);
    for (const r of CATALOG) { expect(r.name, r.id).toBeTruthy(); expect(r.question, r.id).toBeTruthy(); if (r.status === "partial") expect(r.note, `${r.id} is partial and must say why`).toBeTruthy(); }
  });

  it("every ready-made report runs for the owner, with and without compare, and gives columns, a date and the filters used", async () => {
    for (const r of CATALOG) {
      const res = await run(owner, { id: r.id });
      expect(res.status, `${r.id}: ${JSON.stringify(res.body).slice(0, 300)}`).toBe(200);
      expect(Array.isArray(res.body.columns) && Array.isArray(res.body.rows), r.id).toBe(true);
      expect(res.body.generatedAt, r.id).toBeTruthy(); expect(res.body.currency).toBe("CAD");
      expect(res.body.range.from).toBe(dayOf(-6));
      const cmp = await run(owner, { id: r.id, compare: true });
      expect(cmp.status, `${r.id} compare`).toBe(200);
      if (!r.fixedRange) expect(cmp.body.previous?.range.to, r.id).toBe(dayOf(-7));
    }
  }, 120_000);

  it("the catalog list marks what each person may open", async () => {
    const o = (await get("/portal/reports/catalog", owner)).body;
    expect(o.reports).toHaveLength(56); expect(o.reports.every((r: { available: boolean }) => r.available)).toBe(true);
    const d = (await get("/portal/reports/catalog", disp)).body.reports as { id: string; available: boolean }[];
    expect(d.find((r) => r.id === "F1")!.available).toBe(false);
    expect(d.find((r) => r.id === "C5")!.available).toBe(false);
    expect(d.find((r) => r.id === "V1")!.available).toBe(true);
  });
});

describe("report totals equal the dashboard and finance pages", () => {
  it("profit and loss, vehicle profit, cost breakdown, monthly growth and driver profit all agree with the dashboard", async () => {
    const dash = (await get(`/portal/dashboard?${range()}&tab=money`, owner)).body;
    const rev = dash.overview.revenueCents as number, profit = dash.overview.profitCents as number;
    const cost = rev - profit;
    expect(rev).toBe(17_000);

    const f1 = (await run(owner, { id: "F1" })).body;
    const line = (n: string) => f1.rows.find((r: { line: string }) => r.line === n).amount as number;
    expect(line("Revenue")).toBe(rev); expect(line("Profit")).toBe(profit);
    expect(f1.rows.slice(0, 7).reduce((a: number, r: { amount: number }) => a + r.amount, 0)).toBe(profit);

    const v2 = (await run(owner, { id: "V2" })).body;
    expect(v2.totals.revenue).toBe(rev); expect(v2.totals.profit).toBe(profit); expect(v2.totals.cost ?? cost).toBe(cost);

    const f3 = (await run(owner, { id: "F3" })).body;
    expect(f3.totals.amount).toBe(cost);

    const d3 = (await run(owner, { id: "D3" })).body;
    expect(d3.totals.revenue).toBe(rev);

    const t1 = (await run(owner, { id: "T1" })).body;
    expect(t1.totals.price).toBe(rev);
    const x1 = (await run(owner, { id: "X1" })).body;
    expect(x1.totals.revenue).toBe(rev);

    const x3 = (await post("/portal/reports/run", owner, { id: "X3", from: dayOf(-6).slice(0, 8) + "01", to: dayOf(0) })).body;
    const monthSum = x3.rows.reduce((a: number, r: { revenue: number }) => a + r.revenue, 0);
    const monthDash = (await get(`/portal/dashboard?from=${dayOf(-6).slice(0, 8)}01&to=${dayOf(0)}`, owner)).body.overview.revenueCents;
    expect(monthSum).toBe(monthDash);
  });

  it("the budget and tax reports use the same figures as their finance pages", async () => {
    await patch("/portal/finance/budget", owner, {}); // not a route: ignored
    await h.call("put", "/portal/finance/budget", owner, { category: "fuel", amountCents: 50_000 });
    const m = dayOf(0).slice(0, 7);
    const page = (await get(`/portal/finance/budget?month=${m}`, owner)).body.rows.find((r: { category: string }) => r.category === "fuel");
    const f6 = (await run(owner, { id: "F6" })).body.rows.find((r: { category: string }) => r.category === "fuel");
    expect(f6).toMatchObject({ budget: page.budgetCents, actual: page.actualCents, state: page.state });
    expect(f6.difference).toBe(page.budgetCents - page.actualCents);
    await h.call("put", "/portal/finance/budget", owner, { category: "fuel", amountCents: null });
    const tax = (await get(`/portal/finance/tax?${range()}`, owner)).body.totals;
    const f7 = (await run(owner, { id: "F7" })).body;
    expect(f7.totals.netOwed ?? 0).toBe(tax.netOwedCents);
  });

  it("clicking a grouped car opens the trips behind it, and they add up to the same number", async () => {
    const v2 = (await run(owner, { id: "V2" })).body;
    const row = v2.rows.find((r: { vehicle: string }) => r.vehicle === "Truck 1");
    const cat = CATALOG.find((r) => r.id === "V2")!;
    const drill = (await run(owner, { spec: { dataset: cat.drill!.dataset, filters: [{ key: cat.drill!.map.vehicle, op: "eq", value: row.vehicle }] } })).body;
    expect(drill.rows).toHaveLength(2);
    expect(drill.totals.price).toBe(row.revenue);
  });

  it("compare gives the previous period's totals, matched to each group", async () => {
    const c = (await run(owner, { id: "V2", compare: true })).body;
    expect(c.previous.range).toEqual(previousPeriod({ from: dayOf(-6), to: dayOf(0) }));
    expect(c.previous.totals.revenue).toBe(0);
    const y = (await run(owner, { id: "V2", compare: "year" })).body;
    expect(y.previous.range).toEqual(sameLastYear({ from: dayOf(-6), to: dayOf(0) }));
    expect(y.previous.kind).toBe("same period last year");
  });
});

describe("grouping and filters on the screen", () => {
  it("a ready-made report can be grouped another allowed way, and refuses others", async () => {
    const t = CATALOG.find((r) => r.groupBy?.includes("driver") && r.groupBy.length > 2)!;
    const byDriver = await post("/portal/reports/run", owner, { id: t.id, groupBy: "driver" });
    expect(byDriver.status).toBe(200);
    expect(byDriver.body.spec.groupBy).toEqual(["driver"]);
    expect((await post("/portal/reports/run", owner, { id: t.id, groupBy: "nonsense" })).status).toBe(400);
  });
  it("extra filters narrow the rows and are listed in the filters used", async () => {
    const all = (await run(owner, { id: "V2" })).body;
    const one = (await post("/portal/reports/run", owner, { id: "V2", filters: [{ key: "vehicle", op: "eq", value: "Truck 1" }] })).body;
    expect(one.rows.map((r: { vehicle: string }) => r.vehicle)).toEqual(["Truck 1"]);
    expect(one.rows.length).toBeLessThan(all.rows.length);
    expect(one.filters.join(" ")).toMatch(/Truck 1/);
  });
});

describe("who may see what", () => {
  it("money, pay, audit and people reports are refused to roles without that access", async () => {
    expect((await run(disp, { id: "F1" })).status).toBe(403);
    expect((await run(viewer, { id: "V2" })).status).toBe(403);
    expect((await run(mgr, { id: "P1" })).status).toBe(200); // a manager has pay.view
    expect((await run(mgr, { id: "F1" })).status).toBe(200); // and vehicle costs
    expect((await run(mgr, { id: "C5" })).status).toBe(403); // but not the audit log
    expect((await run(admin, { id: "C5" })).status).toBe(200);
    expect((await run(disp, { id: "V1" })).status).toBe(200);
    expect((await run(acct, { id: "F5" })).status).toBe(200);
    expect((await run(acct, { id: "P2" })).status).toBe(200);
    expect((await run(orgB, { id: "V1" })).body.rows).toEqual([]);
    expect((await run(orgB, { id: "V2" })).body.totals.revenue ?? 0).toBe(0);
  });

  it("the builder lists only the data a person may use, and refuses the rest", async () => {
    const ds = (await get("/portal/reports/datasets", disp)).body as { key: string }[];
    expect(ds.some((d) => d.key === "vehicles")).toBe(true);
    expect(ds.some((d) => d.key === "payouts")).toBe(false);
    expect((await post("/portal/reports/run", disp, { spec: { dataset: "payouts" } })).status).toBe(403);
    expect((await post("/reports/run", disp, { spec: { dataset: "payouts" } })).status).toBe(403); // the older builder endpoint too
    expect((await post("/reports/saved", disp, { name: "x", spec: { dataset: "payouts" } })).status).toBe(403);
  });

  it("a manager in a region only gets that region's cars, and saved copies keep the limit", async () => {
    await h.admin.query("UPDATE vehicles SET team_id = $1 WHERE id = $2", [team, car2]);
    const v1 = (await run(mgr, { id: "V1" })).body;
    expect(v1.region).toBe(true);
    expect(v1.rows.map((r: { vehicle: string }) => r.vehicle)).toEqual(["Truck 2"]);
    const v2 = (await run(mgr, { id: "V2" })).body;
    expect(v2.rows.map((r: { vehicle: string }) => r.vehicle)).toEqual(["Truck 2"]);
    expect(v2.totals.revenue).toBe(2_000);
    const ownerV2 = (await run(owner, { id: "V2" })).body;
    expect(ownerV2.totals.revenue).toBe(17_000);
    const saved = await post("/reports/saved", mgr, { name: "My cars", spec: { dataset: "vehicles" } });
    expect(saved.status).toBe(201);
    const stored = (await h.admin.query("SELECT spec FROM report_defs WHERE id = $1", [saved.body.id])).rows[0].spec;
    expect(stored.scope.teamIds).toEqual([team]);
    expect((await get("/portal/reports/export-all", mgr)).status).toBe(403);
    await h.admin.query("UPDATE vehicles SET team_id = NULL WHERE id = $1", [car2]);
  });
});

describe("exports", () => {
  it("CSV shows money as dollars with the currency in the heading", async () => {
    const r = await h.call("post", "/portal/reports/export?format=csv", owner, { id: "V2", from: dayOf(-6), to: dayOf(0) });
    expect(r.status).toBe(200);
    const text = r.text as string;
    expect(text).toContain("Revenue (CAD)");
    const row = text.split("\r\n").find((l) => l.includes("Truck 1"))!;
    expect(row).toContain("150"); // 15000 cents of revenue for Truck 1 is 150 dollars
    expect(text).not.toContain("15000");
  });

  it("Excel and PDF files come back with the right type, and refuse people who cannot export", async () => {
    const x = await h.call("post", "/portal/reports/export?format=xlsx", owner, { id: "T1", from: dayOf(-6), to: dayOf(0) });
    expect(x.status).toBe(200); expect(String(x.headers["content-type"])).toContain("spreadsheetml");
    const p = await h.call("post", "/portal/reports/export?format=pdf", owner, { id: "F1", from: dayOf(-6), to: dayOf(0) });
    expect(p.status).toBe(200); expect(String(p.headers["content-type"])).toContain("pdf");
    expect((await h.call("post", "/portal/reports/export?format=csv", viewer, { id: "V1" })).status).toBe(403);
    expect((await h.call("post", "/portal/reports/export?format=doc", owner, { id: "V1" })).status).toBe(400);
  });

  it("every report is also a URL for other tools, as JSON or CSV", async () => {
    const j = await get(`/portal/reports/V2/data?${range()}`, owner);
    expect(j.status).toBe(200); expect(j.body.totals.revenue).toBe(17_000);
    const c = await get(`/portal/reports/V2/data?${range()}&format=csv`, owner);
    expect(c.status).toBe(200); expect(c.text as string).toContain("Revenue (CAD)");
    expect((await get("/portal/reports/NOPE/data", owner)).status).toBe(404);
  });

  it("the full company export is one zip, only for people who can see everything, and is audited", async () => {
    const r = await h.call("get", "/portal/reports/export-all", owner).buffer(true).parse((res, cb) => { const chunks: Buffer[] = []; res.on("data", (d: Buffer) => chunks.push(d)); res.on("end", () => cb(null, Buffer.concat(chunks))); });
    expect(r.status).toBe(200);
    const files = unzipSync(new Uint8Array(r.body as Buffer));
    expect(Object.keys(files)).toEqual(expect.arrayContaining(["vehicles.csv", "drivers.csv", "trips.csv", "pay-lines.csv", "payouts.csv", "README.txt"]));
    expect(Buffer.from(files["trips.csv"]!).toString("utf8")).toContain("Acme");
    expect((await h.admin.query("SELECT 1 FROM audit_log WHERE action = 'reports.export_all'")).rowCount).toBe(1);
    expect((await get("/portal/reports/export-all", acct)).status).toBe(403);
    expect((await get("/portal/reports/export-all", disp)).status).toBe(403);
  });
});

describe("favourites, pins, comments, folders and drafts", () => {
  it("favourites, recent and pins are per person", async () => {
    expect((await post("/portal/reports/prefs", owner, { ref: "V2", favorite: true, pinned: true })).status).toBe(200);
    expect((await post("/portal/reports/open/v2", owner)).status).toBe(200);
    expect((await post("/portal/reports/prefs", owner, { ref: "NOPE", favorite: true })).status).toBe(400);
    const mine = (await get("/portal/reports/catalog", owner)).body.reports.find((r: { id: string }) => r.id === "V2");
    expect(mine).toMatchObject({ favorite: true, pinned: true }); expect(mine.lastOpenedAt).toBeTruthy();
    const other = (await get("/portal/reports/catalog", admin)).body.reports.find((r: { id: string }) => r.id === "V2");
    expect(other).toMatchObject({ favorite: false, pinned: false });
    const pins = (await get(`/portal/reports/pinned?${range()}`, owner)).body;
    expect(pins).toHaveLength(1); expect(pins[0]).toMatchObject({ ref: "V2", name: "Vehicle profit and loss" });
    expect(pins[0].totals.revenue).toBe(17_000);
    expect((await get("/portal/reports/pinned", admin)).body).toEqual([]);
  });

  it("comments can tag a teammate, and a tag must be a real person", async () => {
    const adminId = (await h.admin.query("SELECT id FROM users WHERE email = 'admin@example.com'")).rows[0].id;
    expect((await post("/portal/reports/comments/V2", owner, { body: "Why is Truck 2 so low?", mentions: [adminId] })).status).toBe(201);
    expect((await post("/portal/reports/comments/V2", owner, { body: "x", mentions: ["00000000-0000-4000-8000-000000000000"] })).status).toBe(400);
    expect((await post("/portal/reports/comments/V2", owner, { body: "" })).status).toBe(400);
    const list = (await get("/portal/reports/comments/V2", admin)).body;
    expect(list).toHaveLength(1); expect(list[0].mentionNames).toEqual(["admin@example.com"]);
    expect((await get("/portal/reports/comments/V2", orgB)).body).toEqual([]);
  });

  it("a saved report can be put in a folder, only by its owner, with the move logged", async () => {
    const s = await post("/reports/saved", owner, { name: "Copy of V2", spec: { dataset: "carMoney" }, shared: true });
    expect(s.status).toBe(201);
    expect((await patch(`/portal/reports/saved/${s.body.id}`, owner, { folder: "Finance team" })).status).toBe(200);
    expect((await patch(`/portal/reports/saved/${s.body.id}`, mgr, { folder: "Mine" })).status).toBe(403);
    const cat = (await get("/portal/reports/catalog", admin)).body.saved.find((x: { id: string }) => x.id === s.body.id);
    expect(cat).toMatchObject({ folder: "Finance team", shared: true });
    expect((await h.admin.query("SELECT 1 FROM audit_log WHERE action = 'reports.folder'")).rowCount).toBe(1);
    const again = await run(owner, { id: s.body.id });
    expect(again.status).toBe(200); expect(again.body.name).toBe("Copy of V2");
  });

  it("plain words become a draft report that says what it understood", async () => {
    const r = await post("/portal/reports/ask", owner, { text: "profit per car last quarter" });
    expect(r.body.found).toBe(true);
    expect(r.body.spec.dataset).toBe("carMoney");
    expect(r.body.spec.range.from < r.body.spec.range.to).toBe(true);
    expect(r.body.understood.join(" ")).toContain("last quarter");
    const run1 = await post("/portal/reports/run", owner, { spec: r.body.spec });
    expect(run1.status, JSON.stringify(run1.body).slice(0, 300)).toBe(200);
    expect((await post("/portal/reports/ask", owner, { text: "banana" })).body.found).toBe(false);
    expect((await post("/portal/reports/ask", disp, { text: "payouts last month" })).status).toBe(403);
    expect(draftFromText("top 5 customers this year", "2026-11-04")!.spec).toMatchObject({ dataset: "customers", limit: 5 });
  });
});
