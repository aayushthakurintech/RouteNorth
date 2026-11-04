import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { DRIVER_LEGAL_DOC, applyDeductions, centsToPlain, evaluateBonus, type Permission } from "@routenorth/shared";
import type { Response } from "express";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { auditChange } from "../audit/domain-audit.js";
import { addNotification } from "../business/notifications.js";
import { emit } from "../automation/events.js";
import { PG_POOL } from "../tokens.js";
import { body as asBody, cents, companyFormat, dateOnly, oneOf, onlyKeys, requireAny, sendRows, str, uuid, type ExportColumn } from "./common.js";
import { specSummary } from "./pay-spec.js";
import { activeBonusRules, assertSecondPerson, paySettings, periodStats, recomputePayout, resolveForTrip, type PaySettings } from "./pay.service.js";
import { todayIn } from "./vehicles.service.js";

const can = (req: AuthedRequest, ...p: Permission[]) => p.some((x) => req.perms?.has(x));
const CYCLES = ["daily", "weekly", "biweekly", "monthly", "custom"] as const;
const dollars = (c: number) => Number((c / 100).toFixed(2));
const shift = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const daysIn = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;

const PAYOUT_COLS = `p.id, p.run_id AS "runId", p.driver_id AS "driverId", coalesce(u.display_name, u.email) AS "driverName", p.from_date::text AS "from", p.to_date::text AS "to", p.status,
  p.earnings_cents::float8 AS "earningsCents", p.bonus_cents::float8 AS "bonusCents", p.tips_cents::float8 AS "tipsCents", p.deduction_cents::float8 AS "deductionCents", p.net_cents::float8 AS "netCents",
  p.hold_reason AS "holdReason", p.employment_type AS "employmentType", p.approved_at AS "approvedAt", p.sent_at AS "sentAt", p.paid_at AS "paidAt", p.method, p.payment_ref AS "paymentRef", p.failure_note AS "failureNote",
  (SELECT count(DISTINCT trip_id) FROM portal_pay_lines l WHERE l.payout_id = p.id AND l.trip_id IS NOT NULL AND l.archived_at IS NULL)::int AS trips`;

/** Payout runs for the owner, accountant and (read only) managers; statements, disputes, exports and year-end summaries. */
@Controller("portal/payouts")
@UseGuards(AuthGuard)
export class PortalPayoutsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}
  private view(req: AuthedRequest) { return requireAny(req, "pay.view", "pay.manage", "payouts.approve"); }
  private manage(req: AuthedRequest) { return requireAny(req, "pay.manage", "payouts.approve"); }
  private approver(req: AuthedRequest) { return requireAny(req, "payouts.approve"); }
  private async tz(c: pg.PoolClient) { return (await companyFormat(c)).timezone; }

  // ---- build a run -----------------------------------------------------------------------------------------------------------
  /** Everything that goes into one driver's payout for the period; runs inside the run's transaction. */
  private async buildPayout(c: pg.PoolClient, orgId: string, runId: string, driverId: string, from: string, to: string, tz: string, st: PaySettings, actor: string | null) {
    const prof = (await c.query(`SELECT employment_type FROM driver_profiles WHERE user_id = $1`, [driverId])).rows[0];
    const p = (await c.query(`INSERT INTO portal_payouts (org_id, run_id, driver_id, from_date, to_date, employment_type) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [orgId, runId, driverId, from, to, prof?.employment_type ?? null])).rows[0];
    // 1. trip pay and approved adjustments that are not paid yet
    await c.query(`UPDATE portal_pay_lines SET payout_id = $2 WHERE driver_id = $1 AND payout_id IS NULL AND archived_at IS NULL AND approval = 'approved' AND line_date <= $3::date`, [driverId, p.id, to]);
    // 2. salary
    const res = await resolveForTrip(c, "driver", { driverId, day: to });
    if (res.version?.spec.type === "salary" && res.version.spec.salaryCents) {
      const s = res.version.spec; const sal = s.salaryCents ?? 0; const days = daysIn(from, to);
      const exists = (await c.query(`SELECT 1 FROM portal_pay_lines WHERE driver_id = $1 AND key = 'salary' AND archived_at IS NULL AND line_date BETWEEN $2::date AND $3::date`, [driverId, from, to])).rowCount;
      if (!exists) {
        const amount = s.salaryPeriod === "day" ? sal * days : Math.round((sal * days) / 7);
        await c.query(`INSERT INTO portal_pay_lines (org_id, driver_id, payout_id, kind, key, label, amount_cents, rate_version_id, line_date, source, created_by) VALUES ($1,$2,$3,'earning','salary',$4,$5,$6,$7,'rate',$8)`,
          [orgId, driverId, p.id, `Salary ${centsToPlain(sal)} per ${s.salaryPeriod ?? "week"} × ${days} day${days === 1 ? "" : "s"}`, amount, res.version.id, to, actor]);
      }
    }
    // 3. bonus rules (a weekly rule needs a run of at least a week; a monthly one at least 28 days)
    const span = daysIn(from, to);
    const stats = await periodStats(c, driverId, from, to, tz);
    for (const r of await activeBonusRules(c)) {
      if (r.kind === "manual" || r.kind === "referral") continue;
      if ((r.period === "week" && span < 7) || (r.period === "month" && span < 28)) continue;
      const e = evaluateBonus(r, stats);
      if (e.earnedCents <= 0) continue;
      if ((await c.query(`SELECT 1 FROM portal_pay_lines WHERE driver_id = $1 AND ref_id = $2 AND source = 'bonus' AND archived_at IS NULL AND line_date BETWEEN $3::date AND $4::date`, [driverId, r.id, from, to])).rowCount) continue;
      await c.query(`INSERT INTO portal_pay_lines (org_id, driver_id, payout_id, kind, key, label, amount_cents, line_date, source, ref_id, reason, created_by) VALUES ($1,$2,$3,'bonus','bonus',$4,$5,$6,'bonus',$7,$8,$9)`,
        [orgId, driverId, p.id, `Bonus: ${r.name}`, e.earnedCents, to, r.id, e.label.slice(0, 500), actor]);
    }
    // 4. deductions, never taking more than the cap share of what the driver earned
    const gross = Number((await c.query(`SELECT coalesce(sum(amount_cents) FILTER (WHERE amount_cents > 0),0)::float8 AS g FROM portal_pay_lines WHERE payout_id = $1 AND archived_at IS NULL`, [p.id])).rows[0].g);
    const ds = (await c.query(`SELECT id, label, total_cents::float8 AS total, per_payout_cents::float8 AS per, taken_cents::float8 AS taken, recurring FROM portal_deductions WHERE driver_id = $1 AND status = 'active' AND archived_at IS NULL ORDER BY created_at`, [driverId])).rows;
    const want = ds.map((d) => ({ id: d.id as string, wantCents: Math.max(0, d.recurring ? d.per : Math.min(d.per, d.total - d.taken)) })).filter((x) => x.wantCents > 0);
    for (const t of applyDeductions(gross, want, st.deductionCapPct)) {
      const d = ds.find((x) => x.id === t.id)!; const wanted = want.find((x) => x.id === t.id)!.wantCents;
      if (t.takeCents <= 0) continue;
      const after = d.taken + t.takeCents;
      await c.query(`INSERT INTO portal_pay_lines (org_id, driver_id, payout_id, kind, key, label, amount_cents, line_date, source, ref_id, reason, created_by) VALUES ($1,$2,$3,'deduction','deduction',$4,$5,$6,'deduction',$7,$8,$9)`,
        [orgId, driverId, p.id, `${d.label}${d.recurring ? "" : ` (${centsToPlain(after)} of ${centsToPlain(d.total)})`}${t.takeCents < wanted ? " — limited by the deduction cap" : ""}`.slice(0, 300), -t.takeCents, to, d.id,
          (await c.query(`SELECT reason FROM portal_deductions WHERE id = $1`, [d.id])).rows[0].reason, actor]);
      await c.query(`UPDATE portal_deductions SET taken_cents = taken_cents + $2, status = CASE WHEN NOT recurring AND taken_cents + $2 >= total_cents THEN 'done' ELSE status END, updated_at = now() WHERE id = $1`, [d.id, t.takeCents]);
    }
    const sums = await recomputePayout(c, p.id);
    // 5. holds
    const holds: string[] = [];
    if (st.holdOnExpiredDocs) {
      const day = todayIn(tz);
      const docs = (await c.query(`SELECT kind FROM documents WHERE owner_kind = 'driver' AND owner_id = $1 AND archived_at IS NULL AND expires_on IS NOT NULL AND expires_on < $2::date`, [driverId, day])).rows.map((r) => r.kind as string).filter((k) => DRIVER_LEGAL_DOC.test(k));
      const lic = (await c.query(`SELECT 1 FROM driver_profiles WHERE user_id = $1 AND license_expiry IS NOT NULL AND license_expiry < $2::date`, [driverId, day])).rowCount;
      if (docs.length || lic) holds.push(`Expired document: ${[...new Set([...docs, ...(lic ? ["Driver licence"] : [])])].join(", ")}`);
    }
    if (st.holdOnOpenIncident && (await c.query(`SELECT 1 FROM incidents WHERE driver_id = $1 AND status IN ('open','investigating') LIMIT 1`, [driverId])).rowCount) holds.push("An incident involving this driver is still open");
    if (sums.net < 0) holds.push("Net pay is below zero");
    if (holds.length) await c.query(`UPDATE portal_payouts SET hold_reason = $2 WHERE id = $1`, [p.id, holds.join("; ")]);
    return p.id as string;
  }

  async build(c: pg.PoolClient, orgId: string, actor: string | null, runId: string, from: string, to: string) {
    const tz = await this.tz(c); const st = await paySettings(c);
    const ids = new Set<string>();
    for (const r of (await c.query(`SELECT DISTINCT driver_id FROM portal_pay_lines WHERE payout_id IS NULL AND archived_at IS NULL AND approval = 'approved' AND line_date <= $1::date`, [to])).rows) ids.add(r.driver_id);
    // Drivers on a salary card are paid even with no trips.
    for (const d of (await c.query(`SELECT u.id FROM users u JOIN driver_profiles p ON p.user_id = u.id WHERE u.role = 'driver' AND u.disabled_at IS NULL AND p.status IN ('active','onboarding') AND NOT EXISTS (SELECT 1 FROM portal_pay_lines l WHERE l.driver_id = u.id AND l.key = 'salary' AND l.archived_at IS NULL AND l.line_date BETWEEN $1::date AND $2::date)`, [from, to])).rows) {
      if (ids.has(d.id)) continue;
      const r = await resolveForTrip(c, "driver", { driverId: d.id, day: to });
      if (r.version?.spec.type === "salary") ids.add(d.id);
    }
    const out: string[] = [];
    for (const id of ids) out.push(await this.buildPayout(c, orgId, runId, id, from, to, tz, st, actor));
    return out;
  }

  /** Put the run's pay lines back to "unpaid" and give back deduction instalments. Used when a draft run is cancelled or rebuilt. */
  private async unbuild(c: pg.PoolClient, runId: string) {
    const ps = (await c.query(`SELECT id FROM portal_payouts WHERE run_id = $1`, [runId])).rows.map((r) => r.id as string);
    if (!ps.length) return;
    for (const d of (await c.query(`SELECT ref_id, -sum(amount_cents)::float8 AS back FROM portal_pay_lines WHERE payout_id = ANY($1::uuid[]) AND source = 'deduction' AND archived_at IS NULL GROUP BY ref_id`, [ps])).rows) {
      await c.query(`UPDATE portal_deductions SET taken_cents = greatest(0, taken_cents - $2), status = CASE WHEN status = 'done' THEN 'active' ELSE status END, updated_at = now() WHERE id = $1`, [d.ref_id, d.back]);
    }
    await c.query(`DELETE FROM portal_pay_lines WHERE payout_id = ANY($1::uuid[]) AND source IN ('bonus','deduction') AND NOT EXISTS (SELECT 1 FROM portal_disputes x WHERE x.line_id = portal_pay_lines.id)`, [ps]);
    await c.query(`DELETE FROM portal_pay_lines WHERE payout_id = ANY($1::uuid[]) AND key = 'salary'`, [ps]);
    await c.query(`UPDATE portal_pay_lines SET payout_id = NULL WHERE payout_id = ANY($1::uuid[])`, [ps]);
    await c.query(`DELETE FROM portal_payouts WHERE run_id = $1`, [runId]);
  }

  private async syncRun(c: pg.PoolClient, runId: string) {
    const r = (await c.query(`SELECT count(*)::int AS n, count(*) FILTER (WHERE status = 'draft')::int AS draft, count(*) FILTER (WHERE status = 'paid')::int AS paid FROM portal_payouts WHERE run_id = $1`, [runId])).rows[0];
    const status = r.n && r.paid === r.n ? "paid" : r.draft === 0 && r.n ? "approved" : "draft";
    await c.query(`UPDATE portal_payout_runs SET status = $2 WHERE id = $1 AND status <> 'cancelled'`, [runId, status]);
    return status;
  }

  // ---- runs ------------------------------------------------------------------------------------------------------------------
  @Get("runs")
  async runs(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => (await c.query(
      `SELECT r.id, r.cycle, r.from_date::text AS "from", r.to_date::text AS "to", r.status, r.created_at AS "createdAt", coalesce(u.display_name, u.email) AS "createdBy",
              count(p.id)::int AS payouts, coalesce(sum(p.net_cents),0)::float8 AS "netCents", count(p.id) FILTER (WHERE p.hold_reason IS NOT NULL)::int AS held,
              count(p.id) FILTER (WHERE p.status = 'disputed')::int AS disputed, count(p.id) FILTER (WHERE p.status = 'failed')::int AS failed
       FROM portal_payout_runs r LEFT JOIN portal_payouts p ON p.run_id = r.id LEFT JOIN users u ON u.id = r.created_by GROUP BY r.id, u.display_name, u.email ORDER BY r.from_date DESC, r.created_at DESC LIMIT 100`)).rows);
  }

  /** Start a run without a person at the keyboard (the pay-day automation). Returns null when there is nothing to pay. */
  async startRun(c: pg.PoolClient, orgId: string, actor: string | null, cycle: (typeof CYCLES)[number], from: string, to: string): Promise<{ id: string; payouts: number; netCents: number } | null> {
    if ((await c.query(`SELECT 1 FROM portal_payout_runs WHERE status = 'draft' AND from_date = $1 AND to_date = $2`, [from, to])).rowCount) return null;
    const run = (await c.query(`INSERT INTO portal_payout_runs (org_id, cycle, from_date, to_date, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [orgId, cycle, from, to, actor])).rows[0];
    const made = await this.build(c, orgId, actor, run.id, from, to);
    if (!made.length) { await c.query(`DELETE FROM portal_payout_runs WHERE id = $1`, [run.id]); return null; }
    const net = Number((await c.query(`SELECT coalesce(sum(net_cents),0)::float8 AS n FROM portal_payouts WHERE run_id = $1`, [run.id])).rows[0].n);
    await emit(c, orgId, "payout.run_created", "payout_run", run.id, { from, to, payouts: made.length, netCents: net });
    return { id: run.id, payouts: made.length, netCents: net };
  }

  @Post("runs")
  async createRun(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    onlyKeys(b, ["cycle", "from", "to"]);
    const cycle = oneOf(b.cycle ?? "weekly", "cycle", CYCLES, { required: true })!;
    const from = dateOnly(b.from, "from", true)!, to = dateOnly(b.to, "to", true)!;
    if (to < from) throw new BadRequestException("to cannot be before from");
    if (daysIn(from, to) > 93) throw new BadRequestException("a run covers at most 93 days");
    return withOrg(this.pool, orgId, async (c) => {
      if ((await c.query(`SELECT 1 FROM portal_payout_runs WHERE status IN ('draft') AND from_date = $1 AND to_date = $2`, [from, to])).rowCount) throw new ConflictException("There is already a draft run for these dates");
      const run = (await c.query(`INSERT INTO portal_payout_runs (org_id, cycle, from_date, to_date, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [orgId, cycle, from, to, req.session!.userId])).rows[0];
      const made = await this.build(c, orgId, req.session!.userId, run.id, from, to);
      if (!made.length) throw new BadRequestException("Nothing to pay for these dates: no unpaid trips, bonuses or salaries.");
      const net = (await c.query(`SELECT coalesce(sum(net_cents),0)::float8 AS n FROM portal_payouts WHERE run_id = $1`, [run.id])).rows[0].n;
      await auditChange(c, req, { action: "payout_runs.create", entity: "payout_runs", entityId: run.id, label: `Payout run ${from} to ${to}`, old: null, next: { cycle, from, to, payouts: made.length, netCents: net }, sensitive: true });
      return { id: run.id, payouts: made.length, netCents: net };
    });
  }

  @Get("runs/:id")
  async run(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`SELECT id, cycle, from_date::text AS "from", to_date::text AS "to", status, created_at AS "createdAt", created_by AS "createdById" FROM portal_payout_runs WHERE id = $1`, [uuid(id)])).rows[0];
      if (!r) throw new NotFoundException();
      const payouts = (await c.query(`SELECT ${PAYOUT_COLS} FROM portal_payouts p JOIN users u ON u.id = p.driver_id WHERE p.run_id = $1 ORDER BY lower(coalesce(u.display_name, u.email))`, [id])).rows;
      const sum = (k: string) => payouts.reduce((a, p) => a + p[k], 0);
      return { ...r, payouts, totals: { earningsCents: sum("earningsCents"), bonusCents: sum("bonusCents"), tipsCents: sum("tipsCents"), deductionCents: sum("deductionCents"), netCents: sum("netCents") }, canApprove: can(req, "payouts.approve") };
    });
  }

  @Post("runs/:id/rebuild")
  @HttpCode(200)
  async rebuild(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.manage(req);
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`SELECT from_date::text AS f, to_date::text AS t, status FROM portal_payout_runs WHERE id = $1 FOR UPDATE`, [uuid(id)])).rows[0];
      if (!r) throw new NotFoundException();
      if ((await c.query(`SELECT 1 FROM portal_payouts WHERE run_id = $1 AND status <> 'draft'`, [id])).rowCount || r.status !== "draft") throw new ConflictException("Only a run where nothing is approved yet can be rebuilt");
      await this.unbuild(c, id);
      const made = await this.build(c, orgId, req.session!.userId, id, r.f, r.t);
      await auditChange(c, req, { action: "payout_runs.rebuild", entity: "payout_runs", entityId: id, label: `Payout run ${r.f} to ${r.t}`, old: null, next: { payouts: made.length }, sensitive: true });
      return { payouts: made.length };
    });
  }

  @Post("runs/:id/cancel")
  @HttpCode(200)
  async cancel(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.manage(req);
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`SELECT from_date::text AS f, to_date::text AS t, status FROM portal_payout_runs WHERE id = $1 FOR UPDATE`, [uuid(id)])).rows[0];
      if (!r) throw new NotFoundException();
      if (r.status !== "draft" || (await c.query(`SELECT 1 FROM portal_payouts WHERE run_id = $1 AND status <> 'draft'`, [id])).rowCount) throw new ConflictException("Only a run where nothing is approved yet can be cancelled");
      await this.unbuild(c, id);
      await c.query(`UPDATE portal_payout_runs SET status = 'cancelled' WHERE id = $1`, [id]);
      await auditChange(c, req, { action: "payout_runs.cancel", entity: "payout_runs", entityId: id, label: `Payout run ${r.f} to ${r.t}`, old: { status: "draft" }, next: { status: "cancelled" }, sensitive: true });
      return { ok: true };
    });
  }

  @Post("runs/:id/approve")
  @HttpCode(200)
  async approveRun(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.approver(req);
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`SELECT from_date::text AS f, to_date::text AS t, created_by, status FROM portal_payout_runs WHERE id = $1 FOR UPDATE`, [uuid(id)])).rows[0];
      if (!r || r.status === "cancelled") throw new NotFoundException();
      assertSecondPerson(await paySettings(c), r.created_by, req.session!.userId, "this payout run");
      const ps = (await c.query(`UPDATE portal_payouts SET status = 'approved', approved_by = $2, approved_at = now(), updated_at = now() WHERE run_id = $1 AND status = 'draft' AND hold_reason IS NULL RETURNING id, net_cents::float8 AS net`, [id, req.session!.userId])).rows;
      await this.syncRun(c, id);
      await auditChange(c, req, { action: "payouts.approve", entity: "payout_runs", entityId: id, label: `Payout run ${r.f} to ${r.t}`, old: { status: "draft" }, next: { status: "approved", payouts: ps.length, netCents: ps.reduce((a, p) => a + p.net, 0), heldBack: (await c.query(`SELECT count(*)::int AS n FROM portal_payouts WHERE run_id = $1 AND hold_reason IS NOT NULL AND status = 'draft'`, [id])).rows[0].n }, sensitive: true });
      return { approved: ps.length };
    });
  }

  @Get("runs/:id/export")
  async exportRun(@Req() req: AuthedRequest, @Res() res: Response, @Param("id") id: string, @Query("format") format?: string) {
    const orgId = this.view(req);
    const f = oneOf(format ?? "csv", "format", ["csv", "xlsx", "quickbooks", "xero"] as const, { required: true })!;
    const data = await withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`SELECT from_date::text AS f, to_date::text AS t FROM portal_payout_runs WHERE id = $1`, [uuid(id)])).rows[0];
      if (!r) throw new NotFoundException();
      const rows = (await c.query(`SELECT ${PAYOUT_COLS}, u.email FROM portal_payouts p JOIN users u ON u.id = p.driver_id WHERE p.run_id = $1 ORDER BY lower(coalesce(u.display_name, u.email))`, [id])).rows;
      await auditChange(c, req, { action: "payout_runs.export", entity: "payout_runs", entityId: id, label: `Payout run ${r.f} to ${r.t} (${f})`, old: null, next: { format: f, rows: rows.length }, sensitive: true });
      return { r, rows, currency: (await companyFormat(c)).currency };
    });
    const name = `payouts_${data.r.f}_${data.r.t}`;
    if (f === "quickbooks") {
      const cols: ExportColumn[] = [{ key: "date", label: "Date", type: "text" }, { key: "name", label: "Name", type: "text" }, { key: "memo", label: "Memo", type: "text" }, { key: "account", label: "Account", type: "text" }, { key: "amount", label: "Amount", type: "num" }];
      return sendRows(res, "csv", `${name}_quickbooks`, cols, data.rows.map((p) => ({ date: data.r.t, name: p.driverName, memo: `Driver pay ${data.r.f} to ${data.r.t} (${p.employmentType === "contractor" ? "contractor" : "employee"})`, account: p.employmentType === "contractor" ? "Contract labour" : "Payroll expenses", amount: dollars(p.netCents) })));
    }
    if (f === "xero") {
      const cols: ExportColumn[] = ["ContactName", "EmailAddress", "InvoiceNumber", "InvoiceDate", "DueDate", "Description", "Quantity", "UnitAmount", "AccountCode", "Currency"].map((k) => ({ key: k, label: k, type: k === "Quantity" || k === "UnitAmount" ? "num" : "text" }));
      return sendRows(res, "csv", `${name}_xero`, cols, data.rows.map((p) => ({ ContactName: p.driverName, EmailAddress: p.email, InvoiceNumber: `PAY-${data.r.t}-${p.id.slice(0, 6)}`, InvoiceDate: data.r.t, DueDate: data.r.t, Description: `Driver pay ${data.r.f} to ${data.r.t}`, Quantity: 1, UnitAmount: dollars(p.netCents), AccountCode: "", Currency: data.currency })));
    }
    const cols: ExportColumn[] = [
      { key: "driver", label: "Driver", type: "text" }, { key: "type", label: "Employment type", type: "text" }, { key: "from", label: "From", type: "date" }, { key: "to", label: "To", type: "date" }, { key: "trips", label: "Trips", type: "num" },
      { key: "earnings", label: "Earnings", type: "num" }, { key: "bonus", label: "Bonuses", type: "num" }, { key: "tips", label: "Tips", type: "num" }, { key: "deductions", label: "Deductions", type: "num" }, { key: "net", label: "Net pay", type: "num" },
      { key: "status", label: "Status", type: "text" }, { key: "hold", label: "Hold", type: "text" },
    ];
    sendRows(res, f, name, cols, data.rows.map((p) => ({ driver: p.driverName, type: p.employmentType ?? "", from: p.from, to: p.to, trips: p.trips, earnings: dollars(p.earningsCents), bonus: dollars(p.bonusCents), tips: dollars(p.tipsCents), deductions: dollars(p.deductionCents), net: dollars(p.netCents), status: p.status, hold: p.holdReason ?? "" })));
  }

  // ---- disputes and year-end (before ":id" so the names are not read as ids) -------------------------------------------------------
  @Get("disputes")
  async disputes(@Req() req: AuthedRequest, @Query("status") status?: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => (await c.query(
      `SELECT d.id, d.payout_id AS "payoutId", d.line_id AS "lineId", d.driver_id AS "driverId", coalesce(u.display_name, u.email) AS driver, d.message, d.status, d.reply, d.created_at AS "createdAt", d.resolved_at AS "resolvedAt",
              d.fix_line_id AS "fixLineId", l.label AS "lineLabel", l.amount_cents::float8 AS "lineCents", p.from_date::text AS "from", p.to_date::text AS "to"
       FROM portal_disputes d JOIN users u ON u.id = d.driver_id JOIN portal_payouts p ON p.id = d.payout_id LEFT JOIN portal_pay_lines l ON l.id = d.line_id
       WHERE ($1::text IS NULL OR d.status = $1) ORDER BY d.created_at DESC LIMIT 200`, [status ?? null])).rows);
  }

  @Post("disputes/:id/resolve")
  @HttpCode(200)
  async resolveDispute(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    onlyKeys(b, ["reply", "reject", "fixCents", "fixReason"]);
    const reply = str(b.reply, "reply", { required: true, max: 1000 })!;
    return withOrg(this.pool, orgId, async (c) => {
      const d = (await c.query(`SELECT * FROM portal_disputes WHERE id = $1 FOR UPDATE`, [uuid(id)])).rows[0];
      if (!d) throw new NotFoundException();
      if (d.status !== "open") throw new ConflictException(`This dispute is already ${d.status}`);
      let fixId: string | null = null;
      if (b.fixCents != null && b.reject !== true) {
        const amt = cents(b.fixCents, "fixCents", { min: -100_000_000 })!;
        if (amt === 0) throw new BadRequestException("fixCents cannot be zero");
        const reason = str(b.fixReason, "fixReason", { max: 500 }) ?? `Dispute fix: ${reply}`.slice(0, 500);
        const day = todayIn(await this.tz(c));
        // The fix goes into the next payout; the paid one is never rewritten.
        fixId = (await c.query(`INSERT INTO portal_pay_lines (org_id, driver_id, kind, key, label, amount_cents, line_date, source, reason, approval, created_by) VALUES ($1,$2,'adjustment','dispute','Fix after your question',$3,$4,'dispute',$5,'approved',$6) RETURNING id`,
          [orgId, d.driver_id, amt, day, reason, req.session!.userId])).rows[0].id;
      }
      await c.query(`UPDATE portal_disputes SET status = $2, reply = $3, fix_line_id = $4, resolved_by = $5, resolved_at = now() WHERE id = $1`, [id, b.reject === true ? "rejected" : "resolved", reply, fixId, req.session!.userId]);
      if (!(await c.query(`SELECT 1 FROM portal_disputes WHERE payout_id = $1 AND status = 'open'`, [d.payout_id])).rowCount) {
        await c.query(`UPDATE portal_payouts SET status = CASE WHEN paid_at IS NOT NULL THEN 'paid' WHEN sent_at IS NOT NULL THEN 'sent' ELSE 'approved' END, updated_at = now() WHERE id = $1 AND status = 'disputed'`, [d.payout_id]);
      }
      await auditChange(c, req, { action: "disputes.resolve", entity: "payout_disputes", entityId: id, label: "Pay dispute", old: { status: "open" }, next: { status: b.reject === true ? "rejected" : "resolved", reply, fixCents: b.fixCents ?? null }, sensitive: true });
      await addNotification(c, orgId, d.driver_id, "system", `Your pay question was answered: ${reply}`.slice(0, 200), "/driver/pay");
      return { status: b.reject === true ? "rejected" : "resolved", fixLineId: fixId };
    });
  }

  /** Totals per driver for a calendar year, for tax time. A summary to hand to the accountant, not a government form. */
  @Get("year-end")
  async yearEnd(@Req() req: AuthedRequest, @Res() res: Response, @Query("year") year?: string, @Query("format") format?: string) {
    const orgId = this.view(req);
    const y = Number(year ?? new Date().getUTCFullYear());
    if (!Number.isInteger(y) || y < 2000 || y > 2100) throw new BadRequestException("year must be like 2026");
    const rows = await withOrg(this.pool, orgId, async (c) => (await c.query(
      `SELECT p.driver_id AS "driverId", coalesce(u.display_name, u.email) AS driver, u.email, coalesce(dp.employment_type, 'employee') AS "employmentType", dp.tax_form AS "taxForm", (dp.tax_form_received_on IS NOT NULL) AS "taxFormReceived",
              count(*)::int AS payouts, sum(p.earnings_cents)::float8 AS "earningsCents", sum(p.bonus_cents)::float8 AS "bonusCents", sum(p.tips_cents)::float8 AS "tipsCents", sum(p.deduction_cents)::float8 AS "deductionCents", sum(p.net_cents)::float8 AS "netCents"
       FROM portal_payouts p JOIN users u ON u.id = p.driver_id LEFT JOIN driver_profiles dp ON dp.user_id = p.driver_id
       WHERE p.status = 'paid' AND extract(year FROM p.to_date) = $1 GROUP BY 1, 2, 3, 4, 5, 6 ORDER BY 2`, [y])).rows);
    const f = oneOf(format ?? "json", "format", ["json", "csv", "xlsx"] as const, { required: true })!;
    if (f === "json") return res.json({ year: y, rows, note: "A summary of paid payouts for your accountant. It is not an official tax slip: employees and contractors have different paperwork, so check local labour and tax rules." });
    const cols: ExportColumn[] = [{ key: "driver", label: "Driver", type: "text" }, { key: "type", label: "Employee or contractor", type: "text" }, { key: "form", label: "Tax form", type: "text" }, { key: "received", label: "Form received", type: "text" }, { key: "payouts", label: "Payouts", type: "num" },
      { key: "earnings", label: "Earnings", type: "num" }, { key: "bonus", label: "Bonuses", type: "num" }, { key: "tips", label: "Tips", type: "num" }, { key: "deductions", label: "Deductions", type: "num" }, { key: "net", label: "Net paid", type: "num" }];
    sendRows(res, f, `year_end_${y}`, cols, rows.map((r) => ({ driver: r.driver, type: r.employmentType, form: r.taxForm ?? "", received: r.taxFormReceived ? "Yes" : "No", payouts: r.payouts, earnings: dollars(r.earningsCents), bonus: dollars(r.bonusCents), tips: dollars(r.tipsCents), deductions: dollars(r.deductionCents), net: dollars(r.netCents) })));
  }

  // ---- one payout ------------------------------------------------------------------------------------------------------------
  @Get(":id")
  async statement(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, (c) => payoutStatement(c, uuid(id)));
  }

  @Patch(":id/hold")
  async hold(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    onlyKeys(b, ["reason", "release", "overrideNote"]);
    return withOrg(this.pool, orgId, async (c) => {
      const p = (await c.query(`SELECT status, hold_reason FROM portal_payouts WHERE id = $1 FOR UPDATE`, [uuid(id)])).rows[0];
      if (!p) throw new NotFoundException();
      if (p.status !== "draft") throw new ConflictException("Only a draft payout can be held or released");
      let next: string | null;
      if (b.release === true) {
        if (!can(req, "payouts.approve")) throw new ForbiddenException("Only someone who can approve payouts can release a hold");
        next = null; str(b.overrideNote, "overrideNote", { required: true, max: 300 });
      } else next = str(b.reason, "reason", { required: true, max: 500 });
      await c.query(`UPDATE portal_payouts SET hold_reason = $2, updated_at = now() WHERE id = $1`, [id, next]);
      await auditChange(c, req, { action: b.release === true ? "payouts.release_hold" : "payouts.hold", entity: "payouts", entityId: id, label: "Payout hold", old: { holdReason: p.hold_reason }, next: { holdReason: next, note: b.overrideNote ?? null }, sensitive: true });
      return { holdReason: next };
    });
  }

  private async move(req: AuthedRequest, id: string, to: "approved" | "sent" | "paid" | "failed", b: Record<string, unknown>) {
    const orgId = to === "approved" ? this.approver(req) : this.manage(req);
    return withOrg(this.pool, orgId, async (c) => {
      const p = (await c.query(`SELECT p.*, r.created_by AS run_by, coalesce(u.display_name, u.email) AS dname FROM portal_payouts p JOIN portal_payout_runs r ON r.id = p.run_id JOIN users u ON u.id = p.driver_id WHERE p.id = $1 FOR UPDATE OF p`, [uuid(id)])).rows[0];
      if (!p) throw new NotFoundException();
      const allowed: Record<string, string[]> = { approved: ["draft"], sent: ["approved", "failed"], paid: ["sent", "approved", "failed"], failed: ["sent", "approved"] };
      if (!allowed[to]!.includes(p.status)) throw new ConflictException({ message: `A payout that is ${p.status} cannot be marked ${to}`, code: "bad_status" });
      if (to === "approved") {
        if (p.hold_reason) throw new ConflictException({ message: `This payout is on hold: ${p.hold_reason}`, code: "payout_held" });
        assertSecondPerson(await paySettings(c), p.run_by, req.session!.userId, "this payout");
        if (Number(p.net_cents) < 0) throw new ConflictException("Net pay is below zero");
      }
      const method = b.method != null ? str(b.method, "method", { max: 40 }) : p.method;
      const ref = b.paymentRef != null ? str(b.paymentRef, "paymentRef", { max: 200 }) : p.payment_ref;
      const note = to === "failed" ? str(b.note, "note", { required: true, max: 500 }) : null;
      await c.query(
        `UPDATE portal_payouts SET status = $2, method = $3, payment_ref = $4, failure_note = $5, updated_at = now(),
                approved_by = CASE WHEN $2 = 'approved' THEN $6::uuid ELSE approved_by END, approved_at = CASE WHEN $2 = 'approved' THEN now() ELSE approved_at END,
                sent_at = CASE WHEN $2 = 'sent' THEN now() ELSE sent_at END, paid_at = CASE WHEN $2 = 'paid' THEN now() ELSE paid_at END WHERE id = $1`, [id, to, method, ref, note, req.session!.userId]);
      await this.syncRun(c, p.run_id);
      await auditChange(c, req, { action: `payouts.${to}`, entity: "payouts", entityId: id, label: `Payout for ${p.dname}`, old: { status: p.status }, next: { status: to, netCents: Number(p.net_cents), method, paymentRef: ref, note }, sensitive: true });
      await emit(c, p.org_id, `payout.${to}`, "payout", id, { driverId: p.driver_id, netCents: Number(p.net_cents), status: to });
      if (to === "paid") await addNotification(c, p.org_id, p.driver_id, "system", `Your pay of ${centsToPlain(Number(p.net_cents))} was paid. Your statement is ready.`, "/driver/pay");
      return { status: to };
    });
  }
  @Post(":id/approve") @HttpCode(200) approve(@Req() req: AuthedRequest, @Param("id") id: string) { return this.move(req, id, "approved", {}); }
  @Post(":id/send") @HttpCode(200) send(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) { return this.move(req, id, "sent", asBody(raw ?? {})); }
  @Post(":id/paid") @HttpCode(200) paid(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) { return this.move(req, id, "paid", asBody(raw ?? {})); }
  @Post(":id/failed") @HttpCode(200) failed(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) { return this.move(req, id, "failed", asBody(raw ?? {})); }
}

/** The driver's statement: every trip with the rate used, bonuses, deductions with their reasons, tips and the net. */
export async function payoutStatement(c: pg.PoolClient, payoutId: string, o: { driverId?: string } = {}) {
  const p = (await c.query(`SELECT ${PAYOUT_COLS} FROM portal_payouts p JOIN users u ON u.id = p.driver_id WHERE p.id = $1 ${o.driverId ? "AND p.driver_id = $2 AND p.status <> 'draft'" : ""}`, o.driverId ? [payoutId, o.driverId] : [payoutId])).rows[0];
  if (!p) throw new NotFoundException();
  const lines = (await c.query(
    `SELECT l.id, l.trip_id AS "tripId", l.kind, l.key, l.label, l.amount_cents::float8 AS cents, l.source, l.reason, l.line_date::text AS date, l.rate_version_id AS "versionId",
            t.title, t.customer_name AS customer, t.started_at AS "startedAt", t.distance_m / 1000.0 AS "distanceKm", t.zone, t.tip_cents::float8 AS "tipCents"
     FROM portal_pay_lines l LEFT JOIN portal_trips t ON t.id = l.trip_id WHERE l.payout_id = $1 AND l.archived_at IS NULL ORDER BY coalesce(t.started_at, l.line_date::timestamptz), l.created_at`, [payoutId])).rows;
  const trips = new Map<string, { tripId: string; date: string; title: string | null; customer: string | null; distanceKm: number; zone: string | null; lines: typeof lines; totalCents: number }>();
  const other: typeof lines = [];
  for (const l of lines) {
    if (l.tripId) {
      const t = trips.get(l.tripId) ?? trips.set(l.tripId, { tripId: l.tripId, date: new Date(l.startedAt).toISOString(), title: l.title, customer: l.customer, distanceKm: Math.round(l.distanceKm * 100) / 100, zone: l.zone, lines: [], totalCents: 0 }).get(l.tripId)!;
      t.lines.push(l); t.totalCents += l.cents;
    } else other.push(l);
  }
  const vids = [...new Set(lines.map((l) => l.versionId).filter(Boolean))];
  const cards = vids.length ? (await c.query(`SELECT k.name, v.version, v.spec FROM portal_rate_versions v JOIN portal_rate_cards k ON k.id = v.card_id WHERE v.id = ANY($1::uuid[])`, [vids])).rows : [];
  return {
    payout: p, trips: [...trips.values()], bonuses: other.filter((l) => l.kind === "bonus"), deductions: other.filter((l) => l.kind === "deduction"), adjustments: other.filter((l) => l.kind === "adjustment"), otherLines: other.filter((l) => !["bonus", "deduction", "adjustment"].includes(l.kind)),
    ratesUsed: cards.map((r) => ({ name: r.name, version: r.version, summary: specSummary(r.spec) })),
    disputes: (await c.query(`SELECT id, line_id AS "lineId", message, status, reply, created_at AS "createdAt", resolved_at AS "resolvedAt" FROM portal_disputes WHERE payout_id = $1 ORDER BY created_at`, [payoutId])).rows,
    totalsCheck: { sumOfLinesCents: lines.reduce((a, l) => a + l.cents, 0), netCents: p.netCents },
  };
}

/** What a driver sees of their own pay: this period so far, bonus progress, every deduction with its reason, past payouts and statements, and the "this looks wrong" button. */
@Controller("portal/me/pay")
@UseGuards(AuthGuard)
export class PortalMyPayController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get()
  async mine(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "driver.app");
    const me = req.session!.userId;
    return withOrg(this.pool, orgId, async (c) => {
      const tz = await this.tzOf(c); const today = todayIn(tz);
      const from = shift(today, -6);
      const res = await resolveForTrip(c, "driver", { driverId: me, day: today });
      const stats = await periodStats(c, me, from, today, tz);
      const unpaid = (await c.query(`SELECT coalesce(sum(amount_cents),0)::float8 AS cents, count(DISTINCT trip_id)::int AS trips FROM portal_pay_lines WHERE driver_id = $1 AND payout_id IS NULL AND archived_at IS NULL AND approval = 'approved'`, [me])).rows[0];
      return {
        rateCard: res.version ? { name: res.version.cardName, summary: specSummary(res.version.spec) } : null,
        unpaidCents: unpaid.cents, unpaidTrips: unpaid.trips, window: { from, to: today },
        bonusProgress: (await activeBonusRules(c)).map((r) => ({ id: r.id, name: r.name, ...evaluateBonus(r, stats) })),
        deductions: (await c.query(`SELECT id, kind, label, reason, total_cents::float8 AS "totalCents", per_payout_cents::float8 AS "perPayoutCents", taken_cents::float8 AS "takenCents", recurring, status FROM portal_deductions WHERE driver_id = $1 AND archived_at IS NULL AND status IN ('active','done') ORDER BY created_at DESC`, [me])).rows,
        payouts: (await c.query(`SELECT ${PAYOUT_COLS} FROM portal_payouts p JOIN users u ON u.id = p.driver_id WHERE p.driver_id = $1 AND p.status <> 'draft' ORDER BY p.to_date DESC LIMIT 50`, [me])).rows.map(({ holdReason: _h, ...r }) => r),
      };
    });
  }
  private async tzOf(c: pg.PoolClient) { return (await companyFormat(c)).timezone; }

  @Get("payouts/:id")
  async statement(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "driver.app");
    return withOrg(this.pool, orgId, async (c) => {
      const s = await payoutStatement(c, uuid(id), { driverId: req.session!.userId });
      const { holdReason: _h, ...payout } = s.payout; return { ...s, payout };
    });
  }

  @Post("disputes")
  async dispute(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = requirePerm(req, "driver.app");
    const b = asBody(raw);
    onlyKeys(b, ["payoutId", "lineId", "message"]);
    const message = str(b.message, "message", { required: true, max: 1000 })!;
    return withOrg(this.pool, orgId, async (c) => {
      const p = (await c.query(`SELECT id, status FROM portal_payouts WHERE id = $1 AND driver_id = $2 AND status <> 'draft' FOR UPDATE`, [uuid(b.payoutId, "payoutId"), req.session!.userId])).rows[0];
      if (!p) throw new NotFoundException();
      if (b.lineId != null && !(await c.query(`SELECT 1 FROM portal_pay_lines WHERE id = $1 AND payout_id = $2`, [uuid(b.lineId, "lineId"), p.id])).rowCount) throw new BadRequestException("that line is not on this payout");
      const d = (await c.query(`INSERT INTO portal_disputes (org_id, payout_id, line_id, driver_id, message) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [orgId, p.id, b.lineId ?? null, req.session!.userId, message])).rows[0];
      await c.query(`UPDATE portal_payouts SET status = 'disputed', updated_at = now() WHERE id = $1 AND status IN ('approved','sent','paid')`, [p.id]);
      await auditChange(c, req, { action: "disputes.create", entity: "payout_disputes", entityId: d.id, label: "Pay dispute", old: null, next: { payoutId: p.id, lineId: b.lineId ?? null, message }, sensitive: true });
      for (const u of (await c.query(`SELECT id FROM users WHERE role IN ('owner','accountant') AND disabled_at IS NULL`)).rows) await addNotification(c, orgId, u.id, "system", `A driver questioned a payout: ${message}`.slice(0, 200), "/owner/pay-rates");
      return { id: d.id };
    });
  }
}
