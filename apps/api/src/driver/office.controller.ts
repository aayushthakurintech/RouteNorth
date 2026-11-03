import { BadRequestException, Body, ConflictException, Controller, Get, Header, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import type { Response } from "express";
import { AuthGuard, requireAny, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { notifyCustomer } from "../customer/notify.js";
import { parseRange, parseUuid } from "../history/range.js";
import type { Providers } from "../notify/notifier.js";
import { csvEscape } from "../resources/engine.js";
import { JWT_SECRET, NOTIFY, PG_POOL } from "../tokens.js";
import { settleOvertime, workedMinutes } from "./shifts.js";

const body1 = (v: unknown, max = 2000): string => { if (typeof v !== "string" || !v.trim() || v.length > max) throw new BadRequestException(`write a message up to ${max} characters`); return v.trim(); };

/** The office's side of the chat: one thread per driver and one per customer order. */
@Controller("messages")
@UseGuards(AuthGuard)
export class MessagesController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(NOTIFY) private readonly notify: Providers, @Inject(JWT_SECRET) private readonly secret: string) {}

  private kind(k: string): "driver" | "customer" { if (k !== "driver" && k !== "customer") throw new NotFoundException(); return k; }
  /** Driver chats are for dispatch; customer conversations are for whoever manages customers. */
  private orgFor(req: AuthedRequest, k: "driver" | "customer"): string { return k === "driver" ? requirePerm(req, "routes.dispatch") : requirePerm(req, "customers.manage"); }

  @Get("threads")
  async threads(@Req() req: AuthedRequest, @Query("kind") kind?: string) {
    const k = this.kind(kind ?? "driver");
    const orgId = this.orgFor(req, k);
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT t.thread_id AS id,
              CASE WHEN t.kind = 'driver' THEN (SELECT coalesce(display_name, email) FROM users WHERE id = t.thread_id) ELSE (SELECT coalesce(ref || ' · ', '') || title || coalesce(' · ' || customer_name, '') FROM jobs WHERE id = t.thread_id) END AS name,
              t.last_at AS "lastAt", t.unread::int AS unread,
              (SELECT CASE WHEN audio_data_url IS NOT NULL AND body = '' THEN '(voice note)' ELSE body END FROM messages m WHERE m.thread_kind = t.kind AND m.thread_id = t.thread_id ORDER BY created_at DESC LIMIT 1) AS last
       FROM (SELECT thread_kind AS kind, thread_id, max(created_at) AS last_at, count(*) FILTER (WHERE read_at IS NULL AND sender_kind IN ('driver','customer')) AS unread
             FROM messages WHERE thread_kind = $1 GROUP BY thread_kind, thread_id) t ORDER BY (t.unread > 0) DESC, t.last_at DESC LIMIT 200`, [k]))).rows;
  }

  @Get("unread")
  async unread(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "routes.dispatch", "customers.manage");
    const r = (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT count(*) FILTER (WHERE thread_kind = 'driver')::int AS drivers, count(*) FILTER (WHERE thread_kind = 'customer')::int AS customers,
              (SELECT count(*)::int FROM help_requests WHERE status = 'open') AS help
       FROM messages WHERE read_at IS NULL AND sender_kind IN ('driver','customer')`))).rows[0];
    return r;
  }

  @Get("thread/:kind/:id")
  async thread(@Req() req: AuthedRequest, @Param("kind") kind: string, @Param("id") id: string) {
    const k = this.kind(kind), tid = parseUuid(id);
    const orgId = this.orgFor(req, k);
    return withOrg(this.pool, orgId, async (c) => {
      const rows = (await c.query(
        `SELECT id, sender_kind AS "from", body, quick_key AS "quickKey", audio_data_url AS "audio", created_at AS at, job_id AS "jobId" FROM messages WHERE thread_kind = $1 AND thread_id = $2 ORDER BY created_at LIMIT 500`, [k, tid])).rows;
      await c.query("UPDATE messages SET read_at = now() WHERE thread_kind = $1 AND thread_id = $2 AND sender_kind IN ('driver','customer') AND read_at IS NULL", [k, tid]);
      return rows;
    });
  }

  @Post("thread/:kind/:id")
  async reply(@Req() req: AuthedRequest, @Param("kind") kind: string, @Param("id") id: string, @Body() body: { body?: unknown }) {
    const k = this.kind(kind);
    const orgId = this.orgFor(req, k);
    const tid = parseUuid(id);
    const text = body1(body?.body);
    return withOrg(this.pool, orgId, async (c) => {
      if (k === "driver" && !(await c.query("SELECT 1 FROM users WHERE id = $1 AND role = 'driver'", [tid])).rowCount) throw new NotFoundException();
      if (k === "customer" && !(await c.query("SELECT 1 FROM jobs WHERE id = $1", [tid])).rowCount) throw new NotFoundException();
      const m = (await c.query("INSERT INTO messages (org_id, thread_kind, thread_id, sender_kind, sender_id, body, job_id) VALUES ($1,$2,$3,'dispatch',$4,$5,$6) RETURNING id, created_at AS at", [orgId, k, tid, req.session!.userId, text, k === "customer" ? tid : null])).rows[0];
      // The customer also gets the reply by email or text, with the link back to the conversation.
      let customer: string[] = [];
      if (k === "customer") customer = (await notifyCustomer(c, { providers: this.notify, secret: this.secret }, orgId, tid, "custom", { text, repeat: m.id, force: true })).map((s) => `${s.channel}: ${s.status}`);
      return { ...m, from: "dispatch", body: text, customer };
    });
  }

  /** One message to every driver (or to the ones chosen). */
  @Post("broadcast")
  async broadcast(@Req() req: AuthedRequest, @Body() body: { body?: unknown; driverIds?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const text = body1(body?.body, 1000);
    const ids = Array.isArray(body?.driverIds) ? body.driverIds.map((x) => parseUuid(String(x))) : null;
    return withOrg(this.pool, orgId, async (c) => {
      const r = await c.query(
        `INSERT INTO messages (org_id, thread_kind, thread_id, sender_kind, sender_id, body) SELECT $1,'driver',u.id,'dispatch',$2,$3 FROM users u WHERE u.role = 'driver' AND u.disabled_at IS NULL AND ($4::uuid[] IS NULL OR u.id = ANY($4))`,
        [orgId, req.session!.userId, text, ids]);
      return { sent: r.rowCount };
    });
  }
}

/** Calls for help from drivers: see them, say you are on it, close them. */
@Controller("help-requests")
@UseGuards(AuthGuard)
export class HelpRequestsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get()
  async list(@Req() req: AuthedRequest, @Query("status") status?: string) {
    const orgId = requireAny(req, "routes.dispatch", "routes.view");
    if (status && !["open", "acknowledged", "resolved"].includes(status)) throw new BadRequestException("status must be open, acknowledged or resolved");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT h.id, h.kind, h.note, h.status, h.lat, h.lng, h.created_at AS "createdAt", h.resolution, h.driver_id AS "driverId", coalesce(u.display_name, u.email) AS driver, j.title AS job, dp.phone
       FROM help_requests h JOIN users u ON u.id = h.driver_id LEFT JOIN jobs j ON j.id = h.job_id LEFT JOIN driver_profiles dp ON dp.user_id = h.driver_id
       WHERE ($1::text IS NULL OR h.status = $1) ORDER BY (h.status <> 'resolved') DESC, h.created_at DESC LIMIT 200`, [status ?? null]))).rows;
  }

  private async step(req: AuthedRequest, id: string, to: "acknowledged" | "resolved", resolution?: unknown) {
    const orgId = requirePerm(req, "routes.dispatch");
    const note = typeof resolution === "string" && resolution.trim() ? resolution.trim().slice(0, 500) : null;
    return withOrg(this.pool, orgId, async (c) => {
      const h = (await c.query(
        to === "acknowledged"
          ? "UPDATE help_requests SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 AND status = 'open' RETURNING driver_id, kind"
          : "UPDATE help_requests SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolution = $3 WHERE id = $1 AND status <> 'resolved' RETURNING driver_id, kind",
        to === "acknowledged" ? [parseUuid(id), req.session!.userId] : [parseUuid(id), req.session!.userId, note])).rows[0];
      if (!h) throw new NotFoundException("that request is already handled or does not exist");
      await c.query("INSERT INTO messages (org_id, thread_kind, thread_id, sender_kind, sender_id, body) VALUES ($1,'driver',$2,'dispatch',$3,$4)",
        [orgId, h.driver_id, req.session!.userId, to === "acknowledged" ? "Dispatch has your request and is on it." : `Your request is closed.${note ? ` ${note}` : ""}`]);
      if (to === "resolved") await c.query("UPDATE alerts SET status = 'resolved' WHERE dedupe_key = $1", [`help:${id}`]);
      return { id, status: to };
    });
  }

  @Post(":id/acknowledge") @HttpCode(200) ack(@Req() req: AuthedRequest, @Param("id") id: string) { return this.step(req, id, "acknowledged"); }
  @Post(":id/resolve") @HttpCode(200) resolve(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { resolution?: unknown }) { return this.step(req, id, "resolved", body?.resolution); }
}

interface ShiftRow { id: string; driverId: string; name: string; startedAt: Date; endedAt: Date | null; source: string; note: string | null; workedMin: number; breakMin: number; overtimeMin: number; overtimeStatus: string; rate: number | null }

/** Timesheets: what the shift clocks recorded, corrected by the office, with pay estimates. */
@Controller("timesheets")
@UseGuards(AuthGuard)
export class TimesheetsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  private async load(c: pg.PoolClient, from: Date, to: Date, driverId: string | null): Promise<{ shifts: ShiftRow[]; tz: string }> {
    const tz = (await c.query<{ timezone: string }>("SELECT timezone FROM organizations")).rows[0]!.timezone;
    const rows = (await c.query(
      `SELECT s.id, s.driver_id, coalesce(u.display_name, u.email) AS name, s.started_at, s.ended_at, s.source, s.note, s.overtime_minutes, s.overtime_status, dp.hourly_rate::float AS rate
       FROM shifts s JOIN users u ON u.id = s.driver_id LEFT JOIN driver_profiles dp ON dp.user_id = s.driver_id
       WHERE s.started_at >= $1 AND s.started_at < $2 AND ($3::uuid IS NULL OR s.driver_id = $3) ORDER BY s.started_at DESC LIMIT 2000`, [from, to, driverId])).rows;
    const ids = rows.map((r) => r.id);
    const brk = ids.length ? (await c.query("SELECT shift_id, started_at, ended_at FROM shift_breaks WHERE shift_id = ANY($1::uuid[])", [ids])).rows : [];
    return {
      tz, shifts: rows.map((r) => {
        const b = brk.filter((x) => x.shift_id === r.id).map((x) => ({ startedAt: x.started_at as Date, endedAt: x.ended_at as Date | null }));
        return { id: r.id, driverId: r.driver_id, name: r.name, startedAt: r.started_at, endedAt: r.ended_at, source: r.source, note: r.note, workedMin: workedMinutes({ startedAt: r.started_at, endedAt: r.ended_at, breaks: b }), breakMin: b.reduce((m, x) => m + Math.round(((x.endedAt ?? new Date()).getTime() - x.startedAt.getTime()) / 60_000), 0), overtimeMin: r.overtime_minutes, overtimeStatus: r.overtime_status, rate: r.rate };
      }),
    };
  }

  /** Pay estimate: regular hours at the driver's hourly rate, approved overtime at one and a half times. */
  static pay(s: ShiftRow): number {
    if (s.rate == null) return 0;
    const overtime = s.overtimeStatus === "approved" ? s.overtimeMin : 0;
    const regular = Math.max(0, s.workedMin - s.overtimeMin);
    return Math.round(((regular / 60) * s.rate + (overtime / 60) * s.rate * 1.5) * 100) / 100;
  }

  private async summary(req: AuthedRequest, from?: string, to?: string, driverId?: string) {
    const orgId = requirePerm(req, "reports.view");
    const range = parseRange(from ?? new Date(Date.now() - 14 * 86_400_000).toISOString(), to, 93);
    return withOrg(this.pool, orgId, async (c) => {
      const { shifts, tz } = await this.load(c, range.from, range.to, driverId ? parseUuid(driverId) : null);
      const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: tz });
      const perDriver = new Map<string, { driverId: string; name: string; shifts: number; workedMin: number; breakMin: number; overtimeMin: number; pendingOvertimeMin: number; pay: number; rate: number | null }>();
      for (const s of shifts) {
        const d = perDriver.get(s.driverId) ?? { driverId: s.driverId, name: s.name, shifts: 0, workedMin: 0, breakMin: 0, overtimeMin: 0, pendingOvertimeMin: 0, pay: 0, rate: s.rate };
        d.shifts++; d.workedMin += s.workedMin; d.breakMin += s.breakMin; d.overtimeMin += s.overtimeMin; d.pay = Math.round((d.pay + TimesheetsController.pay(s)) * 100) / 100;
        if (s.overtimeStatus === "pending") d.pendingOvertimeMin += s.overtimeMin;
        perDriver.set(s.driverId, d);
      }
      return { from: range.from, to: range.to, drivers: [...perDriver.values()].sort((a, b) => a.name.localeCompare(b.name)), shifts: shifts.map((s) => ({ ...s, date: fmt.format(s.startedAt), pay: TimesheetsController.pay(s) })) };
    });
  }

  @Get()
  get(@Req() req: AuthedRequest, @Query("from") from?: string, @Query("to") to?: string, @Query("driverId") driverId?: string) { return this.summary(req, from, to, driverId); }

  @Get("export.csv")
  @Header("Content-Type", "text/csv; charset=utf-8")
  async csv(@Req() req: AuthedRequest, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    requirePerm(req, "reports.export");
    const s = await this.summary(req, from, to);
    const lines = [["Driver", "Date", "Start", "End", "Worked (h)", "Break (min)", "Overtime (h)", "Overtime status", "Pay estimate", "Source"].join(",")];
    for (const r of s.shifts) lines.push([r.name, r.date, r.startedAt.toISOString(), r.endedAt?.toISOString() ?? "", (r.workedMin / 60).toFixed(2), r.breakMin, (r.overtimeMin / 60).toFixed(2), r.overtimeStatus, r.pay.toFixed(2), r.source].map(csvEscape).join(","));
    res.type("text/csv").setHeader("Content-Disposition", 'attachment; filename="timesheets.csv"');
    res.send(lines.join("\n"));
  }

  private time(v: unknown, what: string): Date { const d = new Date(String(v)); if (Number.isNaN(d.getTime())) throw new BadRequestException(`${what} must be a timestamp`); return d; }

  @Post("shifts")
  async add(@Req() req: AuthedRequest, @Body() body: { driverId?: unknown; startedAt?: unknown; endedAt?: unknown; note?: unknown }) {
    const orgId = requirePerm(req, "reports.manage");
    const start = this.time(body?.startedAt, "startedAt"), end = this.time(body?.endedAt, "endedAt");
    if (end <= start || end.getTime() - start.getTime() > 24 * 3_600_000) throw new BadRequestException("the shift must end after it starts and be under 24 hours");
    return withOrg(this.pool, orgId, async (c) => {
      const did = parseUuid(String(body?.driverId));
      if (!(await c.query("SELECT 1 FROM users WHERE id = $1 AND role = 'driver'", [did])).rowCount) throw new BadRequestException("unknown driver");
      const row = (await c.query("INSERT INTO shifts (org_id, driver_id, started_at, ended_at, source, note, edited_by) VALUES ($1,$2,$3,$4,'edited',$5,$6) RETURNING id", [orgId, did, start, end, typeof body?.note === "string" ? body.note.slice(0, 500) : null, req.session!.userId])).rows[0];
      return settleOvertime(c, orgId, row.id);
    });
  }

  @Patch("shifts/:id")
  async edit(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { startedAt?: unknown; endedAt?: unknown; note?: unknown }) {
    const orgId = requirePerm(req, "reports.manage");
    return withOrg(this.pool, orgId, async (c) => {
      const cur = (await c.query("SELECT started_at, ended_at FROM shifts WHERE id = $1 FOR UPDATE", [parseUuid(id)])).rows[0];
      if (!cur) throw new NotFoundException();
      const start = body?.startedAt != null ? this.time(body.startedAt, "startedAt") : cur.started_at;
      const end = body?.endedAt !== undefined ? (body.endedAt === null ? null : this.time(body.endedAt, "endedAt")) : cur.ended_at;
      if (end && (end <= start || end.getTime() - start.getTime() > 24 * 3_600_000)) throw new BadRequestException("the shift must end after it starts and be under 24 hours");
      try {
        await c.query("UPDATE shifts SET started_at = $2, ended_at = $3, note = coalesce($4, note), source = 'edited', edited_by = $5 WHERE id = $1", [id, start, end, typeof body?.note === "string" ? body.note.slice(0, 500) : null, req.session!.userId]);
      } catch (e) { if ((e as { code?: string }).code === "23505") throw new ConflictException("this driver already has an open shift"); throw e; }
      return end ? settleOvertime(c, orgId, id) : { id };
    });
  }
}

/** Expenses the drivers submitted. Small ones are approved on the spot; large ones wait in Approvals. */
@Controller("expenses")
@UseGuards(AuthGuard)
export class ExpensesController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  private async rows(req: AuthedRequest, from?: string, to?: string, status?: string) {
    const orgId = requirePerm(req, "reports.view");
    if (status && !["submitted", "approved", "rejected", "reimbursed"].includes(status)) throw new BadRequestException("unknown status");
    const range = parseRange(from ?? new Date(Date.now() - 31 * 86_400_000).toISOString(), to, 366);
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT e.id, e.kind, e.amount::float AS amount, e.tax::float AS tax, e.currency, e.spent_on::text AS "spentOn", e.vendor, e.note, e.status, e.litres::float AS litres, (e.receipt_data_url IS NOT NULL) AS "hasReceipt",
              coalesce(u.display_name, u.email) AS driver, v.name AS vehicle, e.decision_note AS "decisionNote"
       FROM expenses e JOIN users u ON u.id = e.user_id LEFT JOIN vehicles v ON v.id = e.vehicle_id
       WHERE e.spent_on >= $1::date AND e.spent_on < $2::date + 1 AND ($3::text IS NULL OR e.status = $3) ORDER BY e.spent_on DESC, e.created_at DESC LIMIT 1000`, [range.from, range.to, status ?? null]))).rows;
  }

  @Get()
  async list(@Req() req: AuthedRequest, @Query("from") from?: string, @Query("to") to?: string, @Query("status") status?: string) {
    const items = await this.rows(req, from, to, status);
    const totals: Record<string, number> = {};
    for (const e of items) if (e.status !== "rejected") totals[e.kind] = Math.round(((totals[e.kind] ?? 0) + e.amount) * 100) / 100;
    return { items, totals, total: Math.round(Object.values(totals).reduce((a, b) => a + b, 0) * 100) / 100 };
  }

  @Get("export.csv")
  async csv(@Req() req: AuthedRequest, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string) {
    requirePerm(req, "reports.export");
    const items = await this.rows(req, from, to);
    const lines = [["Date", "Driver", "Kind", "Vendor", "Amount", "Tax", "Currency", "Vehicle", "Status"].join(",")];
    for (const e of items) lines.push([e.spentOn, e.driver, e.kind, e.vendor ?? "", e.amount.toFixed(2), e.tax.toFixed(2), e.currency, e.vehicle ?? "", e.status].map(csvEscape).join(","));
    res.type("text/csv").setHeader("Content-Disposition", 'attachment; filename="expenses.csv"');
    res.send(lines.join("\n"));
  }

  @Get(":id/receipt")
  async receipt(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "reports.view");
    const r = (await withOrg(this.pool, orgId, (c) => c.query("SELECT receipt_data_url AS url FROM expenses WHERE id = $1", [parseUuid(id)]))).rows[0];
    if (!r?.url) throw new NotFoundException();
    return r;
  }

  @Post(":id/reimburse")
  @HttpCode(200)
  async reimburse(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "reports.manage");
    const n = (await withOrg(this.pool, orgId, (c) => c.query("UPDATE expenses SET status = 'reimbursed' WHERE id = $1 AND status = 'approved'", [parseUuid(id)]))).rowCount;
    if (!n) throw new ConflictException("only an approved expense can be marked reimbursed");
    return { id, status: "reimbursed" };
  }
}
