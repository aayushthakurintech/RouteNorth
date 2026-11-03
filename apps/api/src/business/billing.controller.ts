import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Put, Query, Req, Res, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import {
  buildLines, computePay, daysUntil, monthlyEstimate, parseFx, PLAN_IDS, PLANS, planUsage, priceFromRateCard, round2, slaState, toHome, trialDaysLeft, type PlanId, type RateCardLike,
} from "@routenorth/shared";
import type { Response } from "express";
import { AnalyticsService, breakdown, checkRange } from "../analytics/analytics.service.js";
import { AuthGuard, requireAny, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { emit } from "../automation/events.js";
import { parseUuid } from "../history/range.js";
import { withDefaults } from "../org/settings.js";
import { csvEscape } from "../resources/engine.js";
import { PG_POOL } from "../tokens.js";
import { workedMinutes } from "../driver/shifts.js";
import { budgetRows, orgTax } from "./money.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const uuidOrNull = (v: string) => (/^[0-9a-f-]{36}$/.test(v) ? v : null);
const text = (v: unknown, name: string, max: number, required = false): string | null => {
  if (v === undefined || v === null || v === "") { if (required) throw new BadRequestException(`${name} is required`); return null; }
  if (typeof v !== "string" || v.length > max) throw new BadRequestException(`${name} must be up to ${max} characters`);
  return v.trim();
};
const currencyOf = (v: unknown, dflt: string) => {
  if (v === undefined || v === null || v === "") return dflt;
  if (typeof v !== "string" || !/^[A-Z]{3}$/.test(v)) throw new BadRequestException("currency must be a 3-letter code such as CAD");
  return v;
};

/** Plans and usage, quotes, rate cards, budgets, contracts, driver pay and profit. */
@Controller("billing")
@UseGuards(AuthGuard)
export class BillingController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(AnalyticsService) private readonly svc: AnalyticsService) {}

  // ---- plan, trial and usage ----
  @Get("plan")
  async plan(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "billing.manage", "settings.manage");
    return withOrg(this.pool, orgId, async (c) => {
      const org = (await c.query("SELECT plan, trial_ends_at AS \"trialEndsAt\" FROM organizations WHERE id = $1", [orgId])).rows[0];
      const one = async (sql: string) => Number((await c.query(sql)).rows[0].n);
      const used = {
        vehicles: await one("SELECT count(*) AS n FROM vehicles WHERE status <> 'retired'"),
        users: await one("SELECT count(*) AS n FROM users WHERE disabled_at IS NULL AND role NOT IN ('customer')"),
        jobs: await one("SELECT count(*) AS n FROM jobs WHERE created_at >= date_trunc('month', now())"),
      };
      const plan = org.plan as PlanId;
      const left = trialDaysLeft(org.trialEndsAt);
      return {
        plan, trialEndsAt: org.trialEndsAt, trialDaysLeft: plan === "trial" ? left : null, trialExpired: plan === "trial" && left === 0,
        usage: planUsage(plan, used), estimate: monthlyEstimate(plan, used.vehicles), currency: "CAD",
        plans: PLAN_IDS.map((id) => PLANS[id]), canChange: !!req.perms?.has("billing.manage"),
        payments: "external",
      };
    });
  }

  /** Change plan. Limits are soft: nothing is switched off when usage is above them. No card is charged; payments are not connected. */
  @Put("plan")
  async setPlan(@Req() req: AuthedRequest, @Body() b: { plan?: unknown }) {
    const orgId = requirePerm(req, "billing.manage");
    if (!(PLAN_IDS as readonly unknown[]).includes(b?.plan)) throw new BadRequestException(`plan must be one of ${PLAN_IDS.join(", ")}`);
    if (b.plan === "trial") throw new BadRequestException("a trial cannot be chosen again");
    await withOrg(this.pool, orgId, (c) => c.query("UPDATE organizations SET plan = $2 WHERE id = $1", [orgId, b.plan]));
    return { plan: b.plan };
  }

  // ---- quotes ----
  @Get("quotes")
  async quotes(@Req() req: AuthedRequest, @Query("status") status?: string) {
    const orgId = requirePerm(req, "customers.view");
    if (status && !["draft", "sent", "accepted", "declined", "expired"].includes(status)) throw new BadRequestException("unknown status");
    const rows = (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT id, number, customer_name AS "customerName", customer_email AS "customerEmail", customer_address AS "customerAddress", status, issued_on::text AS "issuedOn", valid_until::text AS "validUntil", currency, lines,
              subtotal::float AS subtotal, tax::float AS tax, tax_lines AS "taxLines", total::float AS total, notes, invoice_id AS "invoiceId",
              (status IN ('draft','sent') AND valid_until < current_date) AS expired
       FROM quotes WHERE ($1::text IS NULL OR status = $1) ORDER BY issued_on DESC, number DESC LIMIT 300`, [status ?? null]))).rows;
    return { items: rows };
  }

  @Post("quotes")
  async createQuote(@Req() req: AuthedRequest, @Body() b: Record<string, unknown>) {
    const orgId = requirePerm(req, "customers.manage");
    const customerName = text(b?.customerName, "customerName", 120, true)!;
    return withOrg(this.pool, orgId, async (c) => {
      const org = (await c.query("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0];
      const s = withDefaults(org.settings);
      let rawLines = b?.lines;
      if (!rawLines && b?.rateCard) {
        const rc = b.rateCard as Record<string, unknown>;
        const card = (await c.query("SELECT name, basis, base::float, minimum::float, tiers, zones FROM rate_cards WHERE id = $1", [parseUuid(String(rc.id))])).rows[0];
        if (!card) throw new BadRequestException("unknown rate card");
        let price;
        try { price = priceFromRateCard(card as RateCardLike, { km: Number(rc.km), kg: Number(rc.kg), minutes: Number(rc.minutes), zone: rc.zone as string | undefined }); }
        catch (e) { throw new BadRequestException((e as Error).message); }
        rawLines = [{ description: text(rc.description, "description", 200) ?? `${customerName}: ${card.name}`, qty: 1, unitPrice: price.amount }];
      }
      let built;
      try { built = buildLines(rawLines); } catch (e) { throw new BadRequestException((e as Error).message); }
      const tax = orgTax(org.settings, built.subtotal, b?.taxExempt === true);
      const days = b?.validDays === undefined ? s.billing.quoteValidDays : Number(b.validDays);
      if (!Number.isInteger(days) || days < 1 || days > 365) throw new BadRequestException("validDays must be 1 to 365");
      const n = (await c.query<{ n: number }>("SELECT next_counter($1, 'quote') AS n", [orgId])).rows[0]!.n;
      const number = `Q-${new Date().getUTCFullYear()}-${String(n).padStart(4, "0")}`;
      return (await c.query(
        `INSERT INTO quotes (org_id, number, customer_name, customer_email, customer_address, valid_until, currency, lines, subtotal, tax, tax_lines, total, notes, created_by)
         VALUES ($1,$2,$3,$4,$5, current_date + $6::int, $7,$8,$9,$10,$11,$12,$13,$14) RETURNING id, number, total::float AS total`,
        [orgId, number, customerName, text(b?.customerEmail, "customerEmail", 200), text(b?.customerAddress, "customerAddress", 300), days, currencyOf(b?.currency, s.currency), JSON.stringify(built.lines),
          built.subtotal, tax.total, JSON.stringify(tax.lines), round2(built.subtotal + tax.total), text(b?.notes, "notes", 1000), uuidOrNull(req.session!.userId)])).rows[0];
    });
  }

  @Patch("quotes/:id")
  async updateQuote(@Req() req: AuthedRequest, @Param("id") id: string, @Body() b: { status?: unknown; notes?: unknown }) {
    const orgId = requirePerm(req, "customers.manage");
    const status = b?.status === undefined ? null : String(b.status);
    if (status !== null && !["draft", "sent", "accepted", "declined"].includes(status)) throw new BadRequestException("status must be draft, sent, accepted or declined");
    const notes = b?.notes === undefined ? null : text(b.notes, "notes", 1000);
    const r = await withOrg(this.pool, orgId, (c) => c.query("UPDATE quotes SET status = coalesce($2, status), notes = coalesce($3, notes) WHERE id = $1 AND invoice_id IS NULL RETURNING id, status", [parseUuid(id), status, notes]));
    if (!r.rowCount) throw new NotFoundException("quote not found, or it already became an invoice");
    return r.rows[0];
  }

  /** Turn an accepted quote into a draft invoice. */
  @Post("quotes/:id/convert")
  @HttpCode(200)
  async convertQuote(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "customers.manage");
    return withOrg(this.pool, orgId, async (c) => {
      const q = (await c.query("SELECT * FROM quotes WHERE id = $1 FOR UPDATE", [parseUuid(id)])).rows[0];
      if (!q) throw new NotFoundException();
      if (q.invoice_id) throw new ConflictException("this quote already became an invoice");
      if (q.status === "declined") throw new ConflictException("a declined quote cannot become an invoice");
      const s = withDefaults((await c.query("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0].settings);
      const n = (await c.query<{ n: number }>("SELECT next_counter($1, 'invoice') AS n", [orgId])).rows[0]!.n;
      const number = `INV-${new Date().getUTCFullYear()}-${String(n).padStart(4, "0")}`;
      const inv = (await c.query(
        `INSERT INTO invoices (org_id, number, customer_name, customer_email, customer_address, status, due_on, currency, lines, subtotal, tax, tax_lines, total, notes, quote_id, created_by)
         VALUES ($1,$2,$3,$4,$5,'draft', current_date + $6::int, $7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id, number`,
        [orgId, number, q.customer_name, q.customer_email, q.customer_address, s.billing.paymentTermsDays, q.currency, JSON.stringify(q.lines), q.subtotal, q.tax, JSON.stringify(q.tax_lines), q.total, q.notes, q.id, uuidOrNull(req.session!.userId)])).rows[0];
      await c.query("UPDATE quotes SET invoice_id = $2, status = 'accepted' WHERE id = $1", [q.id, inv.id]);
      await emit(c, orgId, "invoice.created", "invoice", inv.id, { invoiceId: inv.id, number: inv.number, total: Number(q.total), quoteId: q.id });
      return { invoiceId: inv.id, number: inv.number };
    });
  }

  // ---- rate cards ----
  @Post("rate-cards/:id/price")
  @HttpCode(200)
  async price(@Req() req: AuthedRequest, @Param("id") id: string, @Body() b: { km?: unknown; kg?: unknown; minutes?: unknown; zone?: unknown }) {
    const orgId = requireAny(req, "reports.view", "customers.view");
    const card = (await withOrg(this.pool, orgId, (c) => c.query("SELECT name, basis, base::float, minimum::float, tiers, zones FROM rate_cards WHERE id = $1", [parseUuid(id)]))).rows[0];
    if (!card) throw new NotFoundException();
    const num = (v: unknown, name: string) => { if (v === undefined || v === null || v === "") return undefined; const n = Number(v); if (!Number.isFinite(n) || n < 0 || n > 1e7) throw new BadRequestException(`${name} must be 0 or more`); return n; };
    try { return priceFromRateCard(card as RateCardLike, { km: num(b?.km, "km"), kg: num(b?.kg, "kg"), minutes: num(b?.minutes, "minutes"), zone: typeof b?.zone === "string" ? b.zone : undefined }); }
    catch (e) { throw new BadRequestException((e as Error).message); }
  }

  // ---- budgets ----
  @Get("budgets")
  async budgets(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "reports.view");
    return withOrg(this.pool, orgId, async (c) => {
      const s = withDefaults((await c.query("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0].settings);
      return { alertPct: s.billing.budgetAlertPct, items: await budgetRows(c, s.billing.budgetAlertPct) };
    });
  }

  // ---- contracts and service levels ----
  @Get("contracts")
  async contracts(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "reports.view", "customers.view");
    return withOrg(this.pool, orgId, async (c) => {
      const rows = (await c.query(
        `SELECT k.id, k.customer_name AS "customerName", k.title, k.starts_on::text AS "startsOn", k.ends_on::text AS "endsOn", k.value::float AS value, k.on_time_target_pct::float AS target,
                k.auto_renew AS "autoRenew", k.status, rc.name AS "rateCardName"
         FROM contracts k LEFT JOIN rate_cards rc ON rc.id = k.rate_card_id AND rc.org_id = k.org_id ORDER BY k.customer_name, k.starts_on DESC`)).rows;
      const today = new Date();
      const out = [];
      for (const k of rows) {
        // Service level over the contract window, looking back at most 90 days.
        const from = new Date(Math.max(Date.parse(k.startsOn), today.getTime() - 90 * 86_400_000)).toISOString().slice(0, 10);
        const to = k.endsOn && k.endsOn < today.toISOString().slice(0, 10) ? k.endsOn : today.toISOString().slice(0, 10);
        const m = (await c.query(
          `SELECT count(*) FILTER (WHERE s.status = 'done')::int AS done,
                  count(*) FILTER (WHERE s.status = 'done' AND (s.window_end IS NULL OR s.arrived_at IS NULL OR s.arrived_at <= s.window_end))::int AS "onTime",
                  count(*) FILTER (WHERE s.status = 'failed')::int AS failed
           FROM stops s JOIN jobs j ON j.id = s.job_id AND j.org_id = s.org_id
           WHERE lower(j.customer_name) = lower($1) AND s.arrived_at >= $2::date AND s.arrived_at < $3::date + 1`, [k.customerName, from, to])).rows[0];
        const pct = m.done > 0 ? Math.round((m.onTime / m.done) * 1000) / 10 : null;
        const left = k.endsOn ? daysUntil(k.endsOn, today) : null;
        out.push({ ...k, done: m.done, failed: m.failed, onTimePct: pct, sla: k.status === "active" ? slaState(pct, k.target) : "no_data", daysLeft: left, expiringSoon: k.status === "active" && left != null && left >= 0 && left <= 60, ended: k.status === "active" && left != null && left < 0, windowFrom: from, windowTo: to });
      }
      return { items: out };
    });
  }

  // ---- driver pay ----
  private async payroll(req: AuthedRequest, from?: string, to?: string) {
    const orgId = requirePerm(req, "reports.view");
    const range = checkRange(from, to);
    const b = await this.svc.load(orgId, range);
    const perDriver = new Map(breakdown(b, "driver").map((r) => [r.key, r.metrics]));
    return withOrg(this.pool, orgId, async (c) => {
      const org = (await c.query("SELECT timezone, settings FROM organizations WHERE id = $1", [orgId])).rows[0];
      const s = withDefaults(org.settings);
      const shifts = (await c.query(
        `SELECT s.id, s.driver_id AS "driverId", s.started_at, s.ended_at, s.overtime_minutes AS ot, s.overtime_status AS "otStatus"
         FROM shifts s WHERE s.ended_at IS NOT NULL AND (s.started_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date LIMIT 5000`, [range.from, range.to, org.timezone])).rows;
      const ids = shifts.map((x) => x.id);
      const brk = ids.length ? (await c.query("SELECT shift_id, started_at, ended_at FROM shift_breaks WHERE shift_id = ANY($1::uuid[])", [ids])).rows : [];
      const people = (await c.query(`SELECT u.id, coalesce(u.display_name, u.email) AS name, dp.hourly_rate::float AS rate FROM users u LEFT JOIN driver_profiles dp ON dp.user_id = u.id WHERE u.role = 'driver' ORDER BY name`)).rows;
      const reimb = new Map((await c.query(
        `SELECT user_id, sum(amount)::float AS n FROM expenses WHERE status = 'approved' AND spent_on BETWEEN $1::date AND $2::date GROUP BY user_id`, [range.from, range.to])).rows.map((r) => [r.user_id, r.n]));
      const rows = people.map((p) => {
        const mine = shifts.filter((x) => x.driverId === p.id);
        let worked = 0, ot = 0, otPending = 0, regularMin = 0;
        for (const sh of mine) {
          const w = workedMinutes({ startedAt: sh.started_at, endedAt: sh.ended_at, breaks: brk.filter((x) => x.shift_id === sh.id).map((x) => ({ startedAt: x.started_at, endedAt: x.ended_at })) });
          worked += w;
          const o = Math.min(w, sh.ot);
          regularMin += w - o; // overtime that is not approved is not paid
          if (sh.otStatus === "approved") ot += o; else if (sh.otStatus === "pending") otPending += o;
        }
        const m = perDriver.get(p.id) ?? {};
        const pay = computePay({
          regularHours: regularMin / 60, overtimeHours: ot / 60, stops: Number(m.stopsDone ?? 0), km: Number(m.distanceKm ?? 0),
          hourlyRate: p.rate ?? 0, payPerStop: s.billing.payPerStop, payPerKm: s.billing.payPerKm, overtimeMultiplier: s.billing.overtimeMultiplier,
        });
        const reimbursable = round2(reimb.get(p.id) ?? 0);
        return {
          driverId: p.id, name: p.name, hourlyRate: p.rate, shifts: mine.length, workedH: round2(worked / 60), regularH: round2(regularMin / 60), overtimeH: round2(ot / 60), pendingOvertimeH: round2(otPending / 60),
          stops: Number(m.stopsDone ?? 0), km: Number(m.distanceKm ?? 0), ...pay, reimbursable, total: round2(pay.gross + reimbursable), missingRate: p.rate == null && worked > 0,
        };
      }).filter((r) => r.shifts > 0 || r.stops > 0);
      const sum = (f: (r: (typeof rows)[number]) => number) => round2(rows.reduce((a, r) => a + f(r), 0));
      return { from: range.from, to: range.to, currency: s.currency, multiplier: s.billing.overtimeMultiplier, payPerStop: s.billing.payPerStop, payPerKm: s.billing.payPerKm, rows, totals: { gross: sum((r) => r.gross), reimbursable: sum((r) => r.reimbursable), total: sum((r) => r.total) } };
    });
  }

  @Get("payroll")
  getPayroll(@Req() req: AuthedRequest, @Query("from") from?: string, @Query("to") to?: string) { return this.payroll(req, from, to); }

  @Get("payroll.csv")
  async payrollCsv(@Req() req: AuthedRequest, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    requirePerm(req, "reports.export");
    const p = await this.payroll(req, from, to);
    const head = ["Driver", "Shifts", "Worked (h)", "Regular (h)", "Overtime (h)", "Stops", "Km", "Hourly rate", "Regular pay", "Overtime pay", "Per-stop pay", "Per-km pay", "Gross", "Expenses to reimburse", "Total"];
    const lines = [head.join(",")];
    for (const r of p.rows) lines.push([r.name, r.shifts, r.workedH, r.regularH, r.overtimeH, r.stops, r.km, r.hourlyRate ?? "", r.regular, r.overtime, r.perStop, r.perKm, r.gross, r.reimbursable, r.total].map(csvEscape).join(","));
    res.type("text/csv").setHeader("Content-Disposition", `attachment; filename="payroll-${p.from}-${p.to}.csv"`);
    res.send(lines.join("\n"));
  }

  // ---- profit ----
  @Get("profit")
  async profit(@Req() req: AuthedRequest, @Query("from") from?: string, @Query("to") to?: string, @Query("by") by = "customer") {
    const orgId = requirePerm(req, "reports.view");
    if (!["job", "customer", "route"].includes(by)) throw new BadRequestException("by must be job, customer or route");
    const range = checkRange(from, to);
    const b = await this.svc.load(orgId, range);
    const routeCost = new Map(breakdown(b, "route").map((r) => [r.key, Number(r.metrics.costTotal ?? 0)]));
    return withOrg(this.pool, orgId, async (c) => {
      const s = withDefaults((await c.query("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0].settings);
      const fx = parseFx(s.billing.fxRates);
      const stops = b.stops;
      const jobIds = [...new Set(stops.map((x) => x.jobId).filter((x): x is string => !!x))];
      const jobs = jobIds.length ? (await c.query(
        `SELECT j.id, j.title, j.customer_name AS customer, j.price::float AS price, j.status, i.subtotal::float AS invoiced, i.currency FROM jobs j LEFT JOIN invoices i ON i.job_id = j.id AND i.status <> 'void' WHERE j.id = ANY($1::uuid[])`, [jobIds])).rows : [];
      const jobRevenue = new Map<string, number>();
      let missingFx = 0;
      for (const j of jobs) {
        let rev = 0;
        if (j.invoiced != null) { const h = toHome(j.invoiced, j.currency, s.currency, fx); if (h == null) missingFx++; else rev = h; }
        else if (j.status === "done" && j.price != null) rev = j.price;
        jobRevenue.set(j.id, rev);
      }
      const stopsPerJob = new Map<string, number>(), stopsPerRoute = new Map<string, number>();
      for (const x of stops) { if (x.jobId) stopsPerJob.set(x.jobId, (stopsPerJob.get(x.jobId) ?? 0) + 1); stopsPerRoute.set(x.routeId, (stopsPerRoute.get(x.routeId) ?? 0) + 1); }
      const jobInfo = new Map(jobs.map((j) => [j.id, j]));
      const acc = new Map<string, { key: string; name: string; revenue: number; cost: number; stops: number }>();
      const at = (key: string, name: string) => acc.get(key) ?? (acc.set(key, { key, name, revenue: 0, cost: 0, stops: 0 }), acc.get(key)!);
      for (const x of stops) {
        const cost = (routeCost.get(x.routeId) ?? 0) / (stopsPerRoute.get(x.routeId) ?? 1);
        const rev = x.jobId ? (jobRevenue.get(x.jobId) ?? 0) / (stopsPerJob.get(x.jobId) ?? 1) : 0;
        const j = x.jobId ? jobInfo.get(x.jobId) : undefined;
        if (by === "route") { const r = at(x.routeId, b.names.route.get(x.routeId) ?? x.routeId); r.revenue += rev; r.cost += cost; r.stops++; }
        else if (by === "job") { if (!x.jobId) continue; const r = at(x.jobId, j?.title ?? x.jobId); r.revenue += rev; r.cost += cost; r.stops++; }
        else { const name = j?.customer ?? x.customer ?? ""; const r = at(name.toLowerCase(), name || "-"); r.revenue += rev; r.cost += cost; r.stops++; }
      }
      // Invoices written by hand for a customer count as revenue for that customer.
      if (by === "customer") {
        const manual = (await c.query(
          `SELECT lower(customer_name) AS k, customer_name AS name, subtotal::float AS subtotal, currency FROM invoices WHERE job_id IS NULL AND status <> 'void' AND customer_name IS NOT NULL AND issued_on BETWEEN $1::date AND $2::date`, [range.from, range.to])).rows;
        for (const m of manual) { const h = toHome(m.subtotal, m.currency, s.currency, fx); if (h == null) { missingFx++; continue; } at(m.k, m.name).revenue += h; }
      }
      const rows = [...acc.values()].map((r) => {
        const revenue = round2(r.revenue), cost = round2(r.cost), profit = round2(revenue - cost);
        return { ...r, revenue, cost, profit, marginPct: revenue > 0 ? Math.round((profit / revenue) * 1000) / 10 : null };
      }).sort((x, y) => y.profit - x.profit);
      const revenue = round2(rows.reduce((a, r) => a + r.revenue, 0)), cost = round2(rows.reduce((a, r) => a + r.cost, 0));
      return { from: range.from, to: range.to, by, currency: s.currency, rows, totals: { revenue, cost, profit: round2(revenue - cost), marginPct: revenue > 0 ? Math.round(((revenue - cost) / revenue) * 1000) / 10 : null }, missingFx, note: "estimate" };
    });
  }
}
