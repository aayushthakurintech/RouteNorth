import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { dayNumber, parseCents, type Permission } from "@routenorth/shared";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard.js";
import { auditChange } from "../audit/domain-audit.js";
import { PG_POOL } from "../tokens.js";
import { body as asBody, cents, companyFormat, dateOnly, oneOf, onlyKeys, regionScope, requireAny, str, uuid } from "./common.js";
import { loadDrivers, loadSettings } from "./drivers.service.js";
import { BUDGET_CATEGORIES, EXPENSE_CATEGORIES, actualFor, companyMoney, moneySeries, previousRange, scopedVehicleIds, upcomingBills } from "./finance.service.js";
import { bounds, shiftDay, vehicleMoney, type Range } from "./money-rules.js";
import { loadVehicles, todayIn } from "./vehicles.service.js";

const can = (req: AuthedRequest, ...p: Permission[]) => p.some((x) => req.perms?.has(x));
const rangeOf = (q: Record<string, string | undefined>, today: string, days = 30): Range => {
  const to = dateOnly(q.to, "to") ?? today;
  const from = dateOnly(q.from, "from") ?? shiftDay(to, -(days - 1));
  if (to < from) throw new BadRequestException("to cannot be before from");
  if (dayNumber(to) - dayNumber(from) > 800) throw new BadRequestException("ask for at most about two years at a time");
  return { from, to };
};
const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);

/** The owner's dashboard: every number comes from the same money rules as the vehicle pages, finance pages and reports. */
@Controller("portal/dashboard")
@UseGuards(AuthGuard)
export class PortalDashboardController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get()
  async dashboard(@Req() req: AuthedRequest, @Query() q: Record<string, string | undefined>) {
    const orgId = requireAny(req, "finance.view", "reports.view", "fleet.view", "vehicles.manage", "drivers.view");
    return withOrg(this.pool, orgId, async (c) => {
      const f = await companyFormat(c); const today = todayIn(f.timezone);
      const range = rangeOf(q, today); const prev = previousRange(range);
      const teamIds = await regionScope(c, req);
      const scope = await scopedVehicleIds(c, teamIds);
      const money = can(req, "finance.view", "vehicles.costs");
      const fleet = can(req, "fleet.view", "vehicles.manage", "vehicles.costs");
      const drivers = can(req, "drivers.view", "drivers.manage");
      const ctx = { today, tz: f.timezone, now: new Date() };
      const vehicles = fleet || money ? await loadVehicles(c, ctx, { teamIds }) : [];
      const driverRows = drivers ? await loadDrivers(c, ctx, { applicants: false, teamIds }) : [];

      const out: Record<string, unknown> = { range, previous: prev, today, currency: f.currency, access: { money, fleet, drivers } };
      const now = money ? await companyMoney(c, range, f.timezone, scope) : null;
      const before = money && q.compare === "1" ? await companyMoney(c, prev, f.timezone, scope) : null;
      const ontime = async (r: Range) => (await c.query(
        `SELECT 100.0 * count(*) FILTER (WHERE on_time) / nullif(count(*) FILTER (WHERE on_time IS NOT NULL),0) AS p FROM portal_trips WHERE archived_at IS NULL AND status = 'completed' AND started_at >= ($1::timestamp AT TIME ZONE $3) AND started_at < ($2::timestamp AT TIME ZONE $3)`,
        [bounds(r).fromTs, bounds(r).toTs, f.timezone])).rows[0].p as number | null;
      const card = (m: typeof now) => m && ({ revenueCents: m.revenueCents, driverPayCents: m.driverPayCents, vehicleCostsCents: m.costCents - m.driverPayCents, profitCents: m.profitCents, marginPct: pct(m.profitCents, m.revenueCents), trips: m.trips });
      const onTime = fleet || money ? await ontime(range) : null;
      out.overview = {
        ...card(now), onTimePct: onTime == null ? null : Math.round(Number(onTime)),
        activeCars: vehicles.filter((v) => v.status === "active" || v.status === "on_trip").length, activeDrivers: driverRows.filter((d) => d.status === "active" || d.status === "on_trip").length,
        previous: before ? { ...card(before), onTimePct: (await ontime(prev)) == null ? null : Math.round(Number(await ontime(prev))) } : null,
      };

      const tab = q.tab ?? "overview";
      if (tab === "money" && money && now) {
        out.money = {
          series: await moneySeries(c, range, f.timezone, scope),
          costSplit: [["Driver pay", now.driverPayCents], ["Fuel", now.fuelCents], ["Repairs and service", now.maintenanceCents], ["Insurance", now.insuranceCents], ["Loan and lease", now.financeCents], ["Tires, fines and other", now.tiresCents + now.ticketsCents + now.otherCents]].map(([label, cents]) => ({ label, cents })),
          unpaidPayoutsCents: Number((await c.query(`SELECT coalesce(sum(net_cents) FILTER (WHERE status <> 'paid'),0)::float8 + (SELECT coalesce(sum(amount_cents),0) FROM portal_pay_lines WHERE payout_id IS NULL AND archived_at IS NULL AND approval = 'approved')::float8 AS n FROM portal_payouts`)).rows[0].n),
          upcomingBills: (await upcomingBills(c, today, 30)).slice(0, 12),
        };
      }
      if (tab === "fleet" && fleet) {
        const per = await vehicleMoney(c, range, f.timezone, { vehicleIds: vehicles.map((v) => v.id) });
        const byStatus: Record<string, number> = {}; for (const v of vehicles) byStatus[v.status] = (byStatus[v.status] ?? 0) + 1;
        const inService = vehicles.filter((v) => ["active", "on_trip", "idle"].includes(v.status)).length;
        const m = [...per.entries()].filter(([id]) => id).map(([id, x]) => ({ id: id as string, name: vehicles.find((v) => v.id === id)?.name ?? "—", profitCents: x.profitCents, revenueCents: x.revenueCents })).sort((a, b) => b.profitCents - a.profitCents);
        const tot = [...per.values()].reduce((a, x) => ({ dur: a.dur + x.durationS, dist: a.dist + x.distanceM, cost: a.cost + x.costCents - x.driverPayCents }), { dur: 0, dist: 0, cost: 0 });
        const days = dayNumber(range.to) - dayNumber(range.from) + 1;
        out.fleet = {
          byStatus, total: vehicles.length, utilizationPct: inService ? Math.min(100, Math.round((100 * tot.dur) / 3600 / (inService * days * 8))) : null,
          utilizationFormula: "Hours driven on trips divided by (cars in service × days × an 8-hour working day).",
          dueForService: vehicles.filter((v) => v.service.state === "overdue" || v.service.state === "due_soon").length, overdueService: vehicles.filter((v) => v.service.state === "overdue").length,
          expiringDocuments: vehicles.reduce((a, v) => a + v.docs.expired + v.docs.expiring, 0), costPerKmCents: tot.dist > 0 ? Math.round(tot.cost / (tot.dist / 1000)) : null,
          top: m.slice(0, 5), bottom: m.length > 5 ? m.slice(-5).reverse() : [],
        };
      }
      if (tab === "drivers" && drivers) {
        const byStatus: Record<string, number> = {}; for (const d of driverRows) byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
        const scored = driverRows.filter((d) => d.score != null).sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
        const hours = (await c.query(`SELECT coalesce(sum(extract(epoch FROM (coalesce(ended_at, now()) - started_at))),0)::float8 / 3600 AS h, coalesce(sum(overtime_minutes) FILTER (WHERE overtime_status IN ('pending','approved')),0)::float8 / 60 AS ot FROM shifts WHERE started_at >= ($1::timestamp AT TIME ZONE $3) AND started_at < ($2::timestamp AT TIME ZONE $3)`, [bounds(range).fromTs, bounds(range).toTs, f.timezone])).rows[0];
        out.drivers = {
          byStatus, averageScore: scored.length ? Math.round(scored.reduce((a, d) => a + (d.score ?? 0), 0) / scored.length) : null,
          top: scored.slice(0, 5).map((d) => ({ id: d.id, name: d.name, score: d.score })), bottom: scored.length > 5 ? scored.slice(-5).reverse().map((d) => ({ id: d.id, name: d.name, score: d.score })) : [],
          hoursWorked: Math.round(Number(hours.h) * 10) / 10, overtimeHours: Math.round(Number(hours.ot) * 10) / 10, expiringDocuments: driverRows.reduce((a, d) => a + d.docs.expired + d.docs.expiring, 0),
          openDisputes: (await c.query(`SELECT count(*)::int AS n FROM portal_disputes WHERE status = 'open'`)).rows[0].n,
        };
      }
      if (tab === "live") {
        const lp = (await c.query(`SELECT count(*) FILTER (WHERE lp.time > now() - interval '10 minutes' AND lp.speed > 3)::int AS moving, count(*) FILTER (WHERE lp.time > now() - interval '10 minutes' AND lp.speed <= 3)::int AS parked, count(*) FILTER (WHERE lp.time <= now() - interval '10 minutes')::int AS offline FROM latest_positions lp`)).rows[0];
        out.live = {
          ...lp, idleCars: vehicles.filter((v) => v.status === "idle").length, onTrip: vehicles.filter((v) => v.status === "on_trip").length,
          lateTrips: (await c.query(`SELECT count(*)::int AS n FROM jobs WHERE status IN ('assigned','started','arrived') AND window_end IS NOT NULL AND window_end < now()`)).rows[0].n,
          activeAlerts: (await c.query(`SELECT count(*)::int AS n FROM alerts WHERE status = 'open'`)).rows[0].n,
        };
      }
      out.attention = await this.attention(c, req, ctx, vehicles, driverRows, scope);
      return out;
    });
  }

  /** The needs-attention list, most urgent first, each with a button that opens the place to fix it. */
  private async attention(c: pg.PoolClient, req: AuthedRequest, ctx: { today: string; tz: string }, vehicles: Awaited<ReturnType<typeof loadVehicles>>, drivers: Awaited<ReturnType<typeof loadDrivers>>, scope: string[] | undefined) {
    const items: { key: string; severity: 1 | 2 | 3; title: string; count: number; href: string; action: string }[] = [];
    const add = (key: string, severity: 1 | 2 | 3, title: string, count: number, href: string, action: string) => { if (count > 0) items.push({ key, severity, title, count, href, action }); };
    const soon = shiftDay(ctx.today, 14);
    const docs = (await c.query(`SELECT owner_kind, count(*)::int AS n FROM documents WHERE archived_at IS NULL AND expires_on IS NOT NULL AND expires_on <= $1::date AND owner_kind IN ('vehicle','driver') GROUP BY 1`, [soon])).rows;
    const vd = docs.find((r) => r.owner_kind === "vehicle")?.n ?? 0, dd = docs.find((r) => r.owner_kind === "driver")?.n ?? 0;
    add("docs_cars", 1, "Car documents expiring in 14 days or already expired", vd, "/owner/vehicles?view=docs", "Open cars");
    add("docs_drivers", 1, "Driver documents expiring in 14 days or already expired", dd, "/owner/drivers?view=docs", "Open drivers");
    add("service", 1, "Services overdue", vehicles.filter((v) => v.service.state === "overdue").length, "/owner/vehicles?view=service", "Open cars");
    if (can(req, "payouts.approve", "pay.view", "pay.manage")) {
      add("payouts", 2, "Payouts waiting for approval", (await c.query(`SELECT count(*)::int AS n FROM portal_payouts WHERE status = 'draft' AND hold_reason IS NULL`)).rows[0].n, "/owner/pay-rates", "Review payouts");
      add("held", 2, "Payouts on hold", (await c.query(`SELECT count(*)::int AS n FROM portal_payouts WHERE status = 'draft' AND hold_reason IS NOT NULL`)).rows[0].n, "/owner/pay-rates", "Review holds");
      add("disputes", 1, "Pay questions waiting for a reply", (await c.query(`SELECT count(*)::int AS n FROM portal_disputes WHERE status = 'open'`)).rows[0].n, "/owner/pay-rates", "Reply");
      add("rate_cards", 2, "Rate card changes waiting for approval", (await c.query(`SELECT count(*)::int AS n FROM change_requests WHERE status = 'pending' AND entity = 'rate_versions'`)).rows[0].n, "/owner/pay-rates", "Approve or send back");
    }
    add("inspections", 1, "Failed inspections not signed off", (await c.query(`SELECT count(DISTINCT vehicle_id)::int AS n FROM inspections WHERE archived_at IS NULL AND defects AND signed_off_at IS NULL`)).rows[0].n, "/owner/vehicles?view=failed-inspection", "Open cars");
    const stuckDays = (await loadSettings(c)).stuckOnboardingDays;
    add("onboarding", 3, `Drivers stuck in onboarding for ${stuckDays}+ days`, drivers.filter((d) => d.status === "onboarding" && Date.now() - Date.parse(d.createdAt) > stuckDays * 86_400_000).length, "/owner/drivers?view=onboarding", "Open drivers");
    if (can(req, "finance.view", "vehicles.costs")) {
      const monthStart = `${ctx.today.slice(0, 8)}01`;
      const per = await vehicleMoney(c, { from: monthStart, to: ctx.today }, ctx.tz, { vehicleIds: scope });
      add("losing_cars", 2, "Cars losing money this month", [...per.entries()].filter(([id, m]) => id && m.profitCents < 0 && (m.revenueCents > 0 || m.costCents > 0)).length, "/owner/vehicles?view=losing", "Open cars");
      const losing = (await c.query(
        `SELECT count(*)::int AS n FROM (SELECT t.driver_id, sum(t.revenue_cents) - coalesce(sum(p.pay),0) AS margin FROM portal_trips t
           LEFT JOIN LATERAL (SELECT sum(amount_cents) AS pay FROM portal_pay_lines l WHERE l.trip_id = t.id AND l.archived_at IS NULL AND l.approval = 'approved' AND l.kind IN ('earning','addon')) p ON true
         WHERE t.archived_at IS NULL AND t.status = 'completed' AND t.driver_id IS NOT NULL AND (t.started_at AT TIME ZONE $2)::date >= $1::date GROUP BY t.driver_id) x WHERE margin < 0`, [monthStart, ctx.tz])).rows[0].n;
      add("losing_drivers", 3, "Drivers paid more than their trips earned this month", losing, "/owner/finance/margin", "See margins");
    }
    return items.sort((a, b) => a.severity - b.severity || b.count - a.count);
  }
}

const MARGIN_GROUPS = ["vehicle", "driver", "customer", "route", "zone", "day_of_week", "hour", "rate_card"] as const;
const EARNING_GROUPS = ["day", "customer", "vehicle", "driver", "route", "zone"] as const;
const DOW = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** Finance pages: earnings, expenses, payouts, invoices, profit and loss, cash flow, budget, tax summary and the margin explorer. */
@Controller("portal/finance")
@UseGuards(AuthGuard)
export class PortalFinanceController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}
  private view(req: AuthedRequest) { return requireAny(req, "finance.view"); }
  private write(req: AuthedRequest) { return requireAny(req, "finance.manage"); }

  @Get("earnings")
  async earnings(@Req() req: AuthedRequest, @Query() q: Record<string, string | undefined>) {
    const orgId = this.view(req);
    const by = oneOf(q.by ?? "day", "by", EARNING_GROUPS, { required: true })!;
    return withOrg(this.pool, orgId, async (c) => {
      const f = await companyFormat(c); const r = rangeOf(q, todayIn(f.timezone)); const b = bounds(r);
      const key = { day: "(t.started_at AT TIME ZONE $3)::date::text", customer: "coalesce(t.customer_name, '(no customer)')", vehicle: "coalesce(v.name, '(no car)')", driver: "coalesce(u.display_name, u.email, '(no driver)')", route: "coalesce(r.name, '(no route)')", zone: "coalesce(t.zone, '(no zone)')" }[by];
      const rows = (await c.query(
        `SELECT ${key} AS label, count(*)::int AS trips, sum(t.revenue_cents)::float8 AS "revenueCents", sum(t.tip_cents)::float8 AS "tipsCents", coalesce(sum(t.distance_m),0)::float8 / 1000 AS km
         FROM portal_trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id LEFT JOIN users u ON u.id = t.driver_id LEFT JOIN routes r ON r.id = t.route_id
         WHERE t.archived_at IS NULL AND t.status = 'completed' AND t.started_at >= ($1::timestamp AT TIME ZONE $3) AND t.started_at < ($2::timestamp AT TIME ZONE $3) GROUP BY 1 ORDER BY ${by === "day" ? "1" : `"revenueCents" DESC`}`, [b.fromTs, b.toTs, f.timezone])).rows;
      return { ...r, by, rows, totals: { trips: rows.reduce((a, x) => a + x.trips, 0), revenueCents: rows.reduce((a, x) => a + x.revenueCents, 0), tipsCents: rows.reduce((a, x) => a + x.tipsCents, 0) } };
    });
  }

  // ---- expenses --------------------------------------------------------------------------------------------------------------
  private expenseBody(b: Record<string, unknown>, creating: boolean) {
    onlyKeys(b, ["spentOn", "category", "amountCents", "taxCents", "vendor", "description", "vehicleId", "driverId", "externalRef"]);
    const o: Record<string, unknown> = {};
    if (creating || b.spentOn !== undefined) o.spent_on = dateOnly(b.spentOn, "spentOn", true);
    if (creating || b.category !== undefined) o.category = oneOf(b.category, "category", EXPENSE_CATEGORIES, { required: true });
    if (creating || b.amountCents !== undefined) o.amount_cents = cents(b.amountCents, "amountCents", { required: true });
    if (b.taxCents !== undefined) o.tax_cents = cents(b.taxCents, "taxCents") ?? 0;
    if (b.vendor !== undefined) o.vendor = str(b.vendor, "vendor", { max: 200 });
    if (b.description !== undefined) o.description = str(b.description, "description", { max: 500 });
    if (b.vehicleId !== undefined) o.vehicle_id = b.vehicleId ? uuid(b.vehicleId, "vehicleId") : null;
    if (b.driverId !== undefined) o.driver_id = b.driverId ? uuid(b.driverId, "driverId") : null;
    if (b.externalRef !== undefined) o.external_ref = str(b.externalRef, "externalRef", { max: 120 });
    return o;
  }
  private static readonly EXP = `e.id, e.spent_on::text AS "spentOn", e.category, e.amount_cents::float8 AS "amountCents", e.tax_cents::float8 AS "taxCents", e.vendor, e.description, e.vehicle_id AS "vehicleId", v.name AS "vehicleName", e.driver_id AS "driverId",
    coalesce(u.display_name, u.email) AS "driverName", e.source, e.external_ref AS "externalRef", e.created_at AS "createdAt", e.archived_at AS "archivedAt"`;

  @Get("expenses")
  async expenses(@Req() req: AuthedRequest, @Query() q: Record<string, string | undefined>) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const f = await companyFormat(c); const r = rangeOf(q, todayIn(f.timezone));
      const rows = (await c.query(
        `SELECT ${PortalFinanceController.EXP} FROM finance_expenses e LEFT JOIN vehicles v ON v.id = e.vehicle_id LEFT JOIN users u ON u.id = e.driver_id
         WHERE e.spent_on BETWEEN $1::date AND $2::date AND ($3::boolean OR e.archived_at IS NULL) AND ($4::text IS NULL OR e.category = $4) ORDER BY e.spent_on DESC, e.created_at DESC LIMIT 2000`, [r.from, r.to, q.archived === "1", q.category ?? null])).rows;
      const byCat: Record<string, number> = {}; for (const x of rows) if (!x.archivedAt) byCat[x.category] = (byCat[x.category] ?? 0) + x.amountCents;
      return { ...r, rows, byCategory: byCat, totalCents: Object.values(byCat).reduce((a, b) => a + b, 0) };
    });
  }

  @Post("expenses")
  async addExpense(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.write(req);
    const v = this.expenseBody(asBody(raw), true);
    return withOrg(this.pool, orgId, async (c) => {
      await this.checkRefs(c, v);
      const cols = Object.keys(v);
      const r = (await c.query(`INSERT INTO finance_expenses (org_id, source, created_by, ${cols.join(",")}) VALUES ($1,'manual',$2,${cols.map((_, i) => `$${i + 3}`).join(",")}) RETURNING id`, [orgId, req.session!.userId, ...cols.map((k) => v[k])])).rows[0];
      await auditChange(c, req, { action: "expenses.create", entity: "expenses", entityId: r.id, label: `${v.category} ${(Number(v.amount_cents) / 100).toFixed(2)}`, old: null, next: v });
      return { id: r.id };
    });
  }

  private async checkRefs(c: pg.PoolClient, v: Record<string, unknown>) {
    if (v.vehicle_id && !(await c.query(`SELECT 1 FROM vehicles WHERE id = $1`, [v.vehicle_id])).rowCount) throw new BadRequestException("vehicle not found");
    if (v.driver_id && !(await c.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'driver'`, [v.driver_id])).rowCount) throw new BadRequestException("driver not found");
    if (v.external_ref && (await c.query(`SELECT 1 FROM finance_expenses WHERE external_ref = $1 AND archived_at IS NULL`, [v.external_ref])).rowCount) throw new ConflictException(`An expense with reference ${v.external_ref} already exists`);
  }

  @Patch("expenses/:id")
  async editExpense(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.write(req);
    const v = this.expenseBody(asBody(raw), false);
    return withOrg(this.pool, orgId, async (c) => {
      const old = (await c.query(`SELECT spent_on::text AS spent_on, category, amount_cents::float8 AS amount_cents, tax_cents::float8 AS tax_cents, vendor, description, vehicle_id, driver_id FROM finance_expenses WHERE id = $1 AND archived_at IS NULL FOR UPDATE`, [uuid(id)])).rows[0];
      if (!old) throw new NotFoundException();
      await this.checkRefs(c, { ...v, external_ref: undefined });
      const cols = Object.keys(v);
      if (cols.length) await c.query(`UPDATE finance_expenses SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [id, ...cols.map((k) => v[k])]);
      await auditChange(c, req, { action: "expenses.update", entity: "expenses", entityId: id, label: `${old.category}`, old, next: { ...old, ...v } });
      return { ok: true };
    });
  }

  @Post("expenses/:id/:what")
  @HttpCode(200)
  async archiveExpense(@Req() req: AuthedRequest, @Param("id") id: string, @Param("what") what: string) {
    const orgId = this.write(req);
    if (what !== "archive" && what !== "restore") throw new NotFoundException();
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`UPDATE finance_expenses SET archived_at = ${what === "archive" ? "now()" : "NULL"}, updated_at = now() WHERE id = $1 AND (archived_at IS NULL) = $2 RETURNING category`, [uuid(id), what === "archive"])).rows[0];
      if (!r) throw new NotFoundException();
      await auditChange(c, req, { action: `expenses.${what}`, entity: "expenses", entityId: id, label: r.category, old: { archived: what === "restore" }, next: { archived: what === "archive" } });
      return { ok: true };
    });
  }

  /** Import a bank or card file (already read into rows). Each line is checked first; lines with a reference already in the books are skipped, not doubled. */
  @Post("expenses/import")
  @HttpCode(200)
  async importExpenses(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.write(req);
    const b = asBody(raw);
    const rows = Array.isArray(b.rows) ? (b.rows as Record<string, unknown>[]) : [];
    if (!rows.length || rows.length > 1000) throw new BadRequestException("rows must be 1 to 1000 lines");
    const dry = b.dryRun !== false;
    return withOrg(this.pool, orgId, async (c) => {
      const report: { line: number; ok: boolean; duplicate?: boolean; errors: string[] }[] = []; const todo: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      for (const [k, r] of rows.entries()) {
        const errors: string[] = []; let v: Record<string, unknown> = {}; let dup = false;
        try {
          const money = (x: unknown) => (x == null || x === "" ? 0 : parseCents(String(x).replace(/[$,\s]/g, "").replace(/^-/, "")));
          const plate = String(r.vehicle ?? "").trim();
          const veh = plate ? (await c.query(`SELECT id FROM vehicles WHERE lower(plate) = lower($1) OR lower(name) = lower($1) LIMIT 1`, [plate])).rows[0] : null;
          if (plate && !veh) errors.push(`no vehicle called ${plate}`);
          v = this.expenseBody({ spentOn: r.date, category: String(r.category ?? "other").toLowerCase(), amountCents: money(r.amount), taxCents: money(r.tax), vendor: r.vendor, description: r.description, vehicleId: veh?.id, externalRef: r.ref || undefined }, true);
          v.source = "import";
          const ref = v.external_ref as string | undefined;
          if (ref && (seen.has(ref) || (await c.query(`SELECT 1 FROM finance_expenses WHERE external_ref = $1 AND archived_at IS NULL`, [ref])).rowCount)) { dup = true; }
          if (ref) seen.add(ref);
        } catch (x) { errors.push(x instanceof Error ? x.message : "invalid line"); }
        report.push({ line: k + 1, ok: !errors.length, duplicate: dup || undefined, errors });
        if (!errors.length && !dup) todo.push(v);
      }
      const bad = report.filter((r) => !r.ok).length;
      if (dry || bad) return { dryRun: true, created: 0, skippedDuplicates: report.filter((r) => r.duplicate).length, ok: bad === 0, report };
      for (const v of todo) {
        const cols = Object.keys(v);
        await c.query(`INSERT INTO finance_expenses (org_id, created_by, ${cols.join(",")}) VALUES ($1,$2,${cols.map((_, i) => `$${i + 3}`).join(",")})`, [orgId, req.session!.userId, ...cols.map((k) => v[k])]);
      }
      await auditChange(c, req, { action: "expenses.import", entity: "expenses", entityId: null, label: `Imported ${todo.length} expenses`, old: null, next: { created: todo.length } });
      return { dryRun: false, created: todo.length, skippedDuplicates: report.filter((r) => r.duplicate).length, ok: true, report };
    });
  }

  // ---- payouts and invoices (read) -------------------------------------------------------------------------------------------
  @Get("payouts")
  async payouts(@Req() req: AuthedRequest, @Query() q: Record<string, string | undefined>) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const f = await companyFormat(c); const r = rangeOf(q, todayIn(f.timezone), 90);
      const rows = (await c.query(
        `SELECT p.id, p.run_id AS "runId", coalesce(u.display_name, u.email) AS driver, p.from_date::text AS "from", p.to_date::text AS "to", p.status, p.net_cents::float8 AS "netCents", p.hold_reason AS "holdReason", p.paid_at AS "paidAt"
         FROM portal_payouts p JOIN users u ON u.id = p.driver_id WHERE p.to_date >= $1::date AND p.from_date <= $2::date ORDER BY p.to_date DESC, 3`, [r.from, r.to])).rows;
      const sum = (s: string[]) => rows.filter((x) => s.includes(x.status)).reduce((a, x) => a + x.netCents, 0);
      return { ...r, rows, totals: { paidCents: sum(["paid"]), waitingCents: sum(["draft", "approved", "sent", "disputed", "failed"]), unbuiltCents: Number((await c.query(`SELECT coalesce(sum(amount_cents),0)::float8 AS n FROM portal_pay_lines WHERE payout_id IS NULL AND archived_at IS NULL AND approval = 'approved'`)).rows[0].n) } };
    });
  }

  @Get("invoices")
  async invoices(@Req() req: AuthedRequest, @Query() q: Record<string, string | undefined>) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const f = await companyFormat(c); const today = todayIn(f.timezone);
      const rows = (await c.query(
        `SELECT id, number, customer_name AS customer, customer_email AS email, status, issued_on::text AS "issuedOn", due_on::text AS "dueOn", round(subtotal * 100)::float8 AS "subtotalCents", round(tax * 100)::float8 AS "taxCents", round(total * 100)::float8 AS "totalCents", paid_at AS "paidAt",
                (status = 'sent' AND due_on IS NOT NULL AND due_on < $1::date) AS overdue, CASE WHEN status = 'sent' AND due_on < $1::date THEN ($1::date - due_on) END AS "daysOverdue"
         FROM invoices WHERE status <> 'void' ORDER BY issued_on DESC, number DESC LIMIT 1000`, [today])).rows;
      const sum = (fn: (x: (typeof rows)[number]) => boolean) => rows.filter(fn).reduce((a, x) => a + x.totalCents, 0);
      return { today, rows, totals: { openCents: sum((x) => x.status === "sent"), overdueCents: sum((x) => x.overdue), paidCents: sum((x) => x.status === "paid"), draftCents: sum((x) => x.status === "draft") } };
    });
  }

  // ---- profit and loss, cash flow, budget, tax -------------------------------------------------------------------------------
  @Get("profit-loss")
  async profitLoss(@Req() req: AuthedRequest, @Query("year") year?: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const f = await companyFormat(c); const today = todayIn(f.timezone);
      const y = Number(year ?? today.slice(0, 4));
      if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new BadRequestException("year must be like 2026");
      const months: Record<string, unknown>[] = [];
      for (let m = 1; m <= 12; m++) {
        const from = `${y}-${String(m).padStart(2, "0")}-01`; const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
        if (from > today) { months.push({ month: from.slice(0, 7), future: true }); continue; }
        const x = await companyMoney(c, { from, to: to > today ? today : to }, f.timezone);
        months.push({ month: from.slice(0, 7), revenueCents: x.revenueCents, driverPayCents: x.driverPayCents, fuelCents: x.fuelCents, maintenanceCents: x.maintenanceCents, insuranceCents: x.insuranceCents, financeCents: x.financeCents, otherCents: x.tiresCents + x.ticketsCents + x.otherCents, costCents: x.costCents, profitCents: x.profitCents });
      }
      const keys = ["revenueCents", "driverPayCents", "fuelCents", "maintenanceCents", "insuranceCents", "financeCents", "otherCents", "costCents", "profitCents"] as const;
      const total = Object.fromEntries(keys.map((k) => [k, months.reduce((a, m) => a + ((m[k] as number | undefined) ?? 0), 0)]));
      return { year: y, months, total, definition: "Revenue is the price of completed trips. Costs are fuel, repairs and service, insurance, loan and lease, tires, fines, other expenses and driver pay. Purchase prices are not counted." };
    });
  }

  @Get("cash-flow")
  async cashFlow(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const f = await companyFormat(c); const today = todayIn(f.timezone);
      const invoices = (await c.query(`SELECT number, customer_name AS customer, due_on::text AS due, round(total * 100)::float8 AS cents FROM invoices WHERE status = 'sent'`)).rows;
      const bills = await upcomingBills(c, today, 90);
      const owed = Number((await c.query(`SELECT coalesce(sum(amount_cents),0)::float8 AS n FROM portal_pay_lines WHERE payout_id IS NULL AND archived_at IS NULL AND approval = 'approved'`)).rows[0].n)
        + Number((await c.query(`SELECT coalesce(sum(net_cents),0)::float8 AS n FROM portal_payouts WHERE status IN ('draft','approved','sent','failed','disputed')`)).rows[0].n);
      const past = await companyMoney(c, { from: shiftDay(today, -89), to: today }, f.timezone);
      const usualDaily = Math.round((past.fuelCents + past.maintenanceCents + past.tiresCents + past.ticketsCents + past.otherCents) / 90);
      const windows = [30, 60, 90].map((d) => {
        const end = shiftDay(today, d);
        const inv = invoices.filter((i) => (i.due ?? today) <= end); const bl = bills.filter((b) => b.date <= end);
        const moneyIn = inv.reduce((a, i) => a + i.cents, 0);
        const known = bl.reduce((a, b) => a + (b.amountCents ?? 0), 0);
        const out = known + owed + usualDaily * d;
        return { days: d, inCents: moneyIn, outCents: out, netCents: moneyIn - out, parts: { invoicesCents: moneyIn, billsCents: known, driverPayOwedCents: owed, usualRunningCostsCents: usualDaily * d } };
      });
      return {
        today, windows, invoices: invoices.map((i) => ({ ...i, overdue: !!i.due && i.due < today })), bills: bills.slice(0, 40),
        note: "Money in is sent invoices that are not paid yet, counted by their due date (overdue ones now). Money out is loan and lease payments, driver pay already earned and not yet paid, and the usual running costs from the last 90 days (an estimate).",
      };
    });
  }

  @Get("budget")
  async budget(@Req() req: AuthedRequest, @Query("month") month?: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const f = await companyFormat(c); const today = todayIn(f.timezone);
      const m = month ?? today.slice(0, 7);
      if (!/^\d{4}-\d{2}$/.test(m)) throw new BadRequestException("month must be like 2026-11");
      const from = `${m}-01`; const to = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).toISOString().slice(0, 10);
      const actual = await companyMoney(c, { from, to: to > today ? today : to }, f.timezone);
      const set = (await c.query(`SELECT category, month::text AS month, amount_cents::float8 AS cents FROM portal_budgets WHERE month IS NULL OR month = $1::date`, [from])).rows;
      const rows = BUDGET_CATEGORIES.map((cat) => {
        const own = set.find((x) => x.category === cat && x.month === from), dflt = set.find((x) => x.category === cat && x.month == null);
        const budgetCents = (own ?? dflt)?.cents ?? null; const spent = actualFor(actual, cat);
        const used = budgetCents ? Math.round((spent / budgetCents) * 1000) / 10 : null;
        return { category: cat, budgetCents, appliesTo: own ? "this month" : dflt ? "every month" : null, actualCents: spent, usedPct: used, state: used == null ? "none" : used >= 100 ? "over" : used >= 80 ? "warning" : "ok" };
      });
      return { month: m, rows };
    });
  }

  @Put("budget")
  async setBudget(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.write(req);
    const b = asBody(raw);
    onlyKeys(b, ["category", "month", "amountCents"]);
    const category = oneOf(b.category, "category", BUDGET_CATEGORIES, { required: true })!;
    let month: string | null = null;
    if (b.month != null && b.month !== "") { if (typeof b.month !== "string" || !/^\d{4}-\d{2}$/.test(b.month)) throw new BadRequestException("month must be like 2026-11"); month = `${b.month}-01`; }
    const amount = b.amountCents == null ? null : cents(b.amountCents, "amountCents", { min: 1 });
    return withOrg(this.pool, orgId, async (c) => {
      const old = (await c.query(`SELECT amount_cents::float8 AS "amountCents" FROM portal_budgets WHERE category = $1 AND month IS NOT DISTINCT FROM $2::date`, [category, month])).rows[0] ?? null;
      if (amount == null) await c.query(`DELETE FROM portal_budgets WHERE category = $1 AND month IS NOT DISTINCT FROM $2::date`, [category, month]);
      else await c.query(`INSERT INTO portal_budgets (org_id, category, month, amount_cents, created_by) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id, category, month) DO UPDATE SET amount_cents = $4, updated_at = now()`, [orgId, category, month, amount, req.session!.userId]);
      await auditChange(c, req, { action: "budget.set", entity: "budget", entityId: null, label: `${category} ${month?.slice(0, 7) ?? "every month"}`, old, next: { amountCents: amount } });
      return { ok: true };
    });
  }

  @Get("tax")
  async tax(@Req() req: AuthedRequest, @Query() q: Record<string, string | undefined>) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const f = await companyFormat(c); const r = rangeOf(q, todayIn(f.timezone), 90);
      const collected = (await c.query(`SELECT to_char(issued_on, 'YYYY-MM') AS month, round(sum(tax) * 100)::float8 AS cents, round(sum(subtotal) * 100)::float8 AS sales FROM invoices WHERE status IN ('sent','paid') AND issued_on BETWEEN $1::date AND $2::date GROUP BY 1`, [r.from, r.to])).rows;
      const paid = (await c.query(`SELECT to_char(spent_on, 'YYYY-MM') AS month, sum(tax_cents)::float8 AS cents, sum(amount_cents)::float8 AS spend FROM finance_expenses WHERE archived_at IS NULL AND spent_on BETWEEN $1::date AND $2::date GROUP BY 1`, [r.from, r.to])).rows;
      const months = [...new Set([...collected.map((x) => x.month), ...paid.map((x) => x.month)])].sort().map((m) => {
        const a = collected.find((x) => x.month === m), p = paid.find((x) => x.month === m);
        return { month: m, salesCents: a?.sales ?? 0, taxCollectedCents: a?.cents ?? 0, spendCents: p?.spend ?? 0, taxPaidCents: p?.cents ?? 0, netOwedCents: (a?.cents ?? 0) - (p?.cents ?? 0) };
      });
      const sum = (k: "salesCents" | "taxCollectedCents" | "spendCents" | "taxPaidCents" | "netOwedCents") => months.reduce((a, m) => a + m[k], 0);
      const contractors = (await c.query(`SELECT coalesce(dp.employment_type, 'employee') AS type, sum(p.net_cents)::float8 AS cents FROM portal_payouts p LEFT JOIN driver_profiles dp ON dp.user_id = p.driver_id WHERE p.status = 'paid' AND p.paid_at >= ($1::timestamp AT TIME ZONE $3) AND p.paid_at < ($2::timestamp AT TIME ZONE $3) GROUP BY 1`, [bounds(r).fromTs, bounds(r).toTs, f.timezone])).rows;
      return { ...r, months, totals: { salesCents: sum("salesCents"), taxCollectedCents: sum("taxCollectedCents"), spendCents: sum("spendCents"), taxPaidCents: sum("taxPaidCents"), netOwedCents: sum("netOwedCents") }, driverPaidByType: contractors,
        note: "A summary for your accountant: tax on invoices you issued, and tax you recorded on expenses. It is not a filing. Check the rules for your region." };
    });
  }

  /** Revenue, cost and margin by car, driver, customer, route, zone, day of week, hour or rate card. Worst margin first by default. */
  @Get("margin")
  async margin(@Req() req: AuthedRequest, @Query() q: Record<string, string | undefined>) {
    const orgId = requireAny(req, "finance.view");
    const by = oneOf(q.by ?? "vehicle", "by", MARGIN_GROUPS, { required: true })!;
    return withOrg(this.pool, orgId, async (c) => {
      const f = await companyFormat(c); const r = rangeOf(q, todayIn(f.timezone)); const b = bounds(r);
      const key = {
        vehicle: "coalesce(v.name, '(no car)')", driver: "coalesce(u.display_name, u.email, '(no driver)')", customer: "coalesce(t.customer_name, '(no customer)')", route: "coalesce(rt.name, '(no route)')", zone: "coalesce(t.zone, '(no zone)')",
        day_of_week: "extract(dow FROM t.started_at AT TIME ZONE $3)::int::text", hour: "lpad(extract(hour FROM t.started_at AT TIME ZONE $3)::int::text, 2, '0')", rate_card: "coalesce(rc.name || ' v' || rv.version, '(no rate card)')",
      }[by];
      const rows = (await c.query(
        `SELECT ${key} AS label, count(*)::int AS trips, sum(t.revenue_cents)::float8 AS "revenueCents", sum(coalesce(p.pay,0))::float8 AS "driverPayCents", sum(coalesce(t.vehicle_cost_cents,0))::float8 AS "carCostCents"
         FROM portal_trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id LEFT JOIN users u ON u.id = t.driver_id LEFT JOIN routes rt ON rt.id = t.route_id
              LEFT JOIN portal_rate_versions rv ON rv.id = t.driver_rate_version_id LEFT JOIN portal_rate_cards rc ON rc.id = rv.card_id
              LEFT JOIN LATERAL (SELECT sum(amount_cents) AS pay FROM portal_pay_lines l WHERE l.trip_id = t.id AND l.archived_at IS NULL AND l.approval = 'approved' AND l.kind IN ('earning','addon')) p ON true
         WHERE t.archived_at IS NULL AND t.status = 'completed' AND t.started_at >= ($1::timestamp AT TIME ZONE $3) AND t.started_at < ($2::timestamp AT TIME ZONE $3) GROUP BY 1`, [b.fromTs, b.toTs, f.timezone])).rows
        .map((x) => ({ ...x, label: by === "day_of_week" ? DOW[Number(x.label)] : by === "hour" ? `${x.label}:00` : x.label, marginCents: x.revenueCents - x.driverPayCents - x.carCostCents, marginPct: pct(x.revenueCents - x.driverPayCents - x.carCostCents, x.revenueCents) }))
        .sort((a, z) => a.marginCents - z.marginCents);
      return { ...r, by, rows, definition: "Margin per trip = the price of the trip − what the driver earned on it (without tips) − the car's running cost for the distance. Overheads such as insurance and loan payments are left out here; the profit and loss page includes them.",
        totals: { revenueCents: rows.reduce((a, x) => a + x.revenueCents, 0), marginCents: rows.reduce((a, x) => a + x.marginCents, 0) } };
    });
  }
}
