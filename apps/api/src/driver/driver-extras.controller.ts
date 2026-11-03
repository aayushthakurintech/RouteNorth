import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { emit } from "../automation/events.js";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { parseUuid } from "../history/range.js";
import { withDefaults } from "../org/settings.js";
import { PG_POOL } from "../tokens.js";
import { minutesSinceBreak, openShift, startShift, endShift, toggleBreak, workedMinutes } from "./shifts.js";

export const HELP_KINDS = ["flat_tire", "breakdown", "accident", "medical", "wrong_address", "customer_not_home", "access_problem", "other"] as const;
const URGENT_HELP = ["accident", "medical", "breakdown"];
export const EXPENSE_KINDS = ["fuel", "parking", "toll", "meal", "repair", "other"] as const;
const DATA_IMAGE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const DATA_AUDIO = /^data:audio\/(webm|ogg|mp4|mpeg|wav|x-m4a|aac)(;codecs=[\w.,-]+)?;base64,[A-Za-z0-9+/=]+$/;

const text = (v: unknown, max: number, what: string): string | null => {
  if (v == null || v === "") return null;
  if (typeof v !== "string" || v.length > max) throw new BadRequestException(`${what} must be text up to ${max} characters`);
  return v.trim() || null;
};
const coord = (v: unknown, lo: number, hi: number): number | null => { if (v == null || v === "") return null; const n = Number(v); if (!(n >= lo && n <= hi)) throw new BadRequestException("invalid coordinates"); return n; };
const when = (v: unknown): Date => { if (v == null || v === "") return new Date(); const d = new Date(String(v)); if (Number.isNaN(d.getTime()) || d.getTime() > Date.now() + 5 * 60_000 || d.getTime() < Date.now() - 48 * 3_600_000) throw new BadRequestException("occurredAt is not a recent time"); return d; };
const cid = (v: unknown): string | null => (v == null || v === "" ? null : parseUuid(String(v)));

/** The driver app's extras: chat with the office, calling for help, the shift clock and breaks, expenses, tips. */
@Controller("driver")
@UseGuards(AuthGuard)
export class DriverExtrasController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  // ---- chat ----
  @Get("messages")
  async messages(@Req() req: AuthedRequest, @Query("after") after?: string) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    const since = after ? new Date(after) : null;
    if (since && Number.isNaN(since.getTime())) throw new BadRequestException("after must be a timestamp");
    return (await withOrg(this.pool, orgId, async (c) => {
      const rows = (await c.query(
        `SELECT id, sender_kind AS "from", body, quick_key AS "quickKey", (audio_data_url IS NOT NULL) AS "hasAudio", job_id AS "jobId", created_at AS at, read_at AS "readAt"
         FROM messages WHERE thread_kind = 'driver' AND thread_id = $1 AND ($2::timestamptz IS NULL OR created_at > $2) ORDER BY created_at DESC LIMIT 200`, [userId, since])).rows.reverse();
      await c.query("UPDATE messages SET read_at = now() WHERE thread_kind = 'driver' AND thread_id = $1 AND sender_kind IN ('dispatch','system') AND read_at IS NULL", [userId]);
      return rows;
    }));
  }

  @Get("messages/:id/audio")
  async audio(@Req() req: AuthedRequest, @Param("id") id: string) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    const r = (await withOrg(this.pool, orgId, (c) => c.query("SELECT audio_data_url AS url FROM messages WHERE id = $1 AND thread_kind = 'driver' AND thread_id = $2", [parseUuid(id), userId]))).rows[0];
    if (!r?.url) throw new NotFoundException();
    return r;
  }

  /** Safe to replay: the phone picks `clientId`, so a message sent twice after a dropped connection is stored once. */
  @Post("messages")
  async send(@Req() req: AuthedRequest, @Body() body: { body?: unknown; quickKey?: unknown; audioDataUrl?: unknown; clientId?: unknown; jobId?: unknown }) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    const t = text(body?.body, 2000, "message") ?? "";
    const audio = body?.audioDataUrl == null ? null : String(body.audioDataUrl);
    if (audio && (audio.length > 900_000 || !DATA_AUDIO.test(audio))) throw new BadRequestException("the voice note is too long or not a supported audio file");
    if (!t && !audio) throw new BadRequestException("write a message or record a voice note");
    const quick = text(body?.quickKey, 40, "quickKey");
    const client = cid(body?.clientId);
    const jobId = body?.jobId ? parseUuid(String(body.jobId)) : null;
    return withOrg(this.pool, orgId, async (c) => {
      const row = (await c.query(
        `INSERT INTO messages (org_id, thread_kind, thread_id, sender_kind, sender_id, body, quick_key, audio_data_url, job_id, client_id) VALUES ($1,'driver',$2,'driver',$2,$3,$4,$5,$6,$7)
         ON CONFLICT (org_id, client_id) DO NOTHING RETURNING id, created_at AS at`, [orgId, userId, t, quick, audio, jobId, client])).rows[0];
      if (!row) return { duplicate: true };
      await emit(c, orgId, "message.received", "driver", userId, { from: "driver", driverId: userId, body: t || "(voice note)", jobId });
      return { id: row.id, at: row.at, duplicate: false };
    });
  }

  /** New or changed work and messages since a time, so the app can notify while it is open. */
  @Get("updates")
  async updates(@Req() req: AuthedRequest, @Query("since") since?: string) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    const s = since ? new Date(since) : new Date(Date.now() - 60_000);
    if (Number.isNaN(s.getTime())) throw new BadRequestException("since must be a timestamp");
    return withOrg(this.pool, orgId, async (c) => ({
      now: new Date().toISOString(),
      messages: (await c.query("SELECT count(*)::int AS n FROM messages WHERE thread_kind = 'driver' AND thread_id = $1 AND sender_kind IN ('dispatch','system') AND created_at > $2", [userId, s])).rows[0].n,
      unread: (await c.query("SELECT count(*)::int AS n FROM messages WHERE thread_kind = 'driver' AND thread_id = $1 AND sender_kind IN ('dispatch','system') AND read_at IS NULL", [userId])).rows[0].n,
      jobs: (await c.query("SELECT count(*)::int AS n FROM jobs WHERE driver_id = $1 AND updated_at > $2 AND status IN ('assigned','started')", [userId, s])).rows[0].n,
      latest: (await c.query("SELECT body FROM messages WHERE thread_kind = 'driver' AND thread_id = $1 AND sender_kind IN ('dispatch','system') ORDER BY created_at DESC LIMIT 1", [userId])).rows[0]?.body ?? null,
    }));
  }

  // ---- help ----
  @Post("help")
  async help(@Req() req: AuthedRequest, @Body() body: { kind?: unknown; note?: unknown; stopId?: unknown; lat?: unknown; lng?: unknown; clientId?: unknown }) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    const kind = String(body?.kind);
    if (!(HELP_KINDS as readonly string[]).includes(kind)) throw new BadRequestException(`kind must be one of ${HELP_KINDS.join(", ")}`);
    const note = text(body?.note, 500, "note");
    const lat = coord(body?.lat, -90, 90), lng = coord(body?.lng, -180, 180);
    const stopId = body?.stopId ? parseUuid(String(body.stopId)) : null;
    const client = cid(body?.clientId);
    return withOrg(this.pool, orgId, async (c) => {
      const jobId = stopId ? (await c.query("SELECT s.job_id FROM stops s JOIN routes r ON r.id = s.route_id WHERE s.id = $1 AND r.driver_id = $2", [stopId, userId])).rows[0]?.job_id ?? null : null;
      if (stopId && !(await c.query("SELECT 1 FROM stops s JOIN routes r ON r.id = s.route_id WHERE s.id = $1 AND r.driver_id = $2", [stopId, userId])).rowCount) throw new NotFoundException();
      const row = (await c.query(
        `INSERT INTO help_requests (org_id, driver_id, kind, note, stop_id, job_id, lat, lng, client_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
         ON CONFLICT (org_id, client_id) DO NOTHING RETURNING id`, [orgId, userId, kind, note, stopId, jobId, lat, lng, client])).rows[0];
      if (!row) return { duplicate: true };
      const name = (await c.query("SELECT coalesce(display_name, email) AS n FROM users WHERE id = $1", [userId])).rows[0].n;
      const label = kind.replace(/_/g, " ");
      await c.query("INSERT INTO messages (org_id, thread_kind, thread_id, sender_kind, sender_id, body, quick_key, job_id) VALUES ($1,'driver',$2,'driver',$2,$3,$4,$5)", [orgId, userId, `HELP: ${label}${note ? ` (${note})` : ""}`, `help_${kind}`, jobId]);
      await c.query(
        `INSERT INTO alerts (org_id, kind, severity, title, detail, subject_kind, subject_id, dedupe_key) VALUES ($1,'help_request',$2,$3,$4,'driver',$5,$6)`,
        [orgId, URGENT_HELP.includes(kind) ? "critical" : "warn", `${name} needs help: ${label}`, JSON.stringify({ helpId: row.id, note, lat, lng }), userId, `help:${row.id}`]);
      await emit(c, orgId, "help.requested", "driver", userId, { helpId: row.id, kind, note: note ?? "", driverId: userId, jobId, stopId });
      return { id: row.id, duplicate: false };
    });
  }

  @Get("help")
  async myHelp(@Req() req: AuthedRequest) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    return (await withOrg(this.pool, orgId, (c) => c.query(`SELECT id, kind, note, status, created_at AS "createdAt", resolution FROM help_requests WHERE driver_id = $1 AND created_at > now() - interval '2 days' ORDER BY created_at DESC LIMIT 20`, [userId]))).rows;
  }

  // ---- shift clock and breaks ----
  private async shiftState(c: pg.PoolClient, userId: string) {
    const org = (await c.query("SELECT settings FROM organizations")).rows[0];
    const s = await openShift(c, userId);
    const profile = (await c.query("SELECT break_after_min, break_min FROM driver_profiles WHERE user_id = $1", [userId])).rows[0];
    const limit = (withDefaults(org.settings).overtimeAfterH ?? 8) * 60;
    if (!s) return { active: false, breakAfterMin: profile?.break_after_min ?? 300, breakMin: profile?.break_min ?? 30 };
    const open = s.breaks.find((b) => !b.endedAt);
    const worked = workedMinutes(s);
    return {
      active: true, shiftId: s.id, startedAt: s.startedAt, source: s.source, workedMin: worked, overtimeAfterMin: limit,
      onBreak: !!open, breakKind: open?.kind ?? null, breakStartedAt: open?.startedAt ?? null,
      sinceBreakMin: minutesSinceBreak(s), breakAfterMin: profile?.break_after_min ?? 300, breakMin: profile?.break_min ?? 30,
      breaksTakenMin: s.breaks.reduce((n, b) => n + Math.round(((b.endedAt ?? new Date()).getTime() - b.startedAt.getTime()) / 60_000), 0),
    };
  }

  @Get("shift")
  async shift(@Req() req: AuthedRequest) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    return withOrg(this.pool, orgId, (c) => this.shiftState(c, userId));
  }

  @Post("shift/start")
  async start(@Req() req: AuthedRequest, @Body() body: { lat?: unknown; lng?: unknown; occurredAt?: unknown }) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    return withOrg(this.pool, orgId, async (c) => {
      await startShift(c, orgId, userId, "manual", when(body?.occurredAt), { lat: coord(body?.lat, -90, 90), lng: coord(body?.lng, -180, 180) });
      return this.shiftState(c, userId);
    });
  }

  @Post("shift/end")
  async end(@Req() req: AuthedRequest, @Body() body: { lat?: unknown; lng?: unknown; occurredAt?: unknown }) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    return withOrg(this.pool, orgId, async (c) => {
      const r = await endShift(c, orgId, userId, when(body?.occurredAt), { lat: coord(body?.lat, -90, 90), lng: coord(body?.lng, -180, 180) });
      if (!r) throw new ConflictException("you are not on a shift");
      return { ...r, ...(await this.shiftState(c, userId)) };
    });
  }

  @Post("shift/break")
  async brk(@Req() req: AuthedRequest, @Body() body: { action?: unknown; kind?: unknown; occurredAt?: unknown }) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    if (body?.action !== "start" && body?.action !== "end") throw new BadRequestException("action must be start or end");
    return withOrg(this.pool, orgId, async (c) => {
      try { await toggleBreak(c, orgId, userId, body.action as "start" | "end", body?.kind === "lunch" ? "lunch" : "break", when(body?.occurredAt)); } catch (e) { throw new ConflictException((e as Error).message); }
      return this.shiftState(c, userId);
    });
  }

  @Get("shifts")
  async shifts(@Req() req: AuthedRequest, @Query("days") days?: string) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    const n = Math.min(60, Math.max(1, Number(days) || 14));
    return withOrg(this.pool, orgId, async (c) => {
      const rows = (await c.query(`SELECT id, started_at, ended_at, source, overtime_minutes, overtime_status FROM shifts WHERE driver_id = $1 AND started_at > now() - make_interval(days => $2) ORDER BY started_at DESC`, [userId, n])).rows;
      const out = [];
      for (const r of rows) {
        const breaks = (await c.query("SELECT started_at, ended_at FROM shift_breaks WHERE shift_id = $1", [r.id])).rows.map((b) => ({ startedAt: b.started_at as Date, endedAt: b.ended_at as Date | null }));
        out.push({ id: r.id, startedAt: r.started_at, endedAt: r.ended_at, source: r.source, workedMin: workedMinutes({ startedAt: r.started_at, endedAt: r.ended_at, breaks }), breakMin: breaks.reduce((m, b) => m + Math.round(((b.endedAt ?? new Date()).getTime() - b.startedAt.getTime()) / 60_000), 0), overtimeMin: r.overtime_minutes, overtimeStatus: r.overtime_status });
      }
      return out;
    });
  }

  // ---- expenses ----
  @Post("expenses")
  async expense(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    const kind = String(body?.kind);
    if (!(EXPENSE_KINDS as readonly string[]).includes(kind)) throw new BadRequestException(`kind must be one of ${EXPENSE_KINDS.join(", ")}`);
    const amount = Number(body?.amount);
    if (!(amount > 0 && amount < 100_000)) throw new BadRequestException("enter the amount");
    const tax = body?.tax == null || body.tax === "" ? 0 : Number(body.tax);
    if (!(tax >= 0 && tax <= amount)) throw new BadRequestException("tax must be between 0 and the amount");
    const litres = body?.litres == null || body.litres === "" ? null : Number(body.litres);
    if (litres !== null && !(litres > 0 && litres < 5000)) throw new BadRequestException("litres must be between 0 and 5000");
    const odo = body?.odometerKm == null || body.odometerKm === "" ? null : Number(body.odometerKm);
    if (odo !== null && !(odo >= 0)) throw new BadRequestException("odometer must be 0 or more");
    const receipt = body?.receiptDataUrl == null ? null : String(body.receiptDataUrl);
    if (receipt && (receipt.length > 700_000 || !DATA_IMAGE.test(receipt))) throw new BadRequestException("the receipt photo is too large or not a JPEG, PNG or WebP image");
    const vehicleId = body?.vehicleId ? parseUuid(String(body.vehicleId)) : null;
    const spent = typeof body?.spentOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.spentOn) ? body.spentOn : null;
    const client = cid(body?.clientId);
    return withOrg(this.pool, orgId, async (c) => {
      const org = (await c.query("SELECT settings FROM organizations")).rows[0];
      const s = withDefaults(org.settings) as ReturnType<typeof withDefaults> & { approvals?: { expenseLimit?: number } };
      const limit = s.approvals?.expenseLimit ?? 100;
      if (vehicleId && !(await c.query("SELECT 1 FROM vehicles WHERE id = $1", [vehicleId])).rowCount) throw new BadRequestException("unknown vehicle");
      const needs = amount > limit;
      const row = (await c.query(
        `INSERT INTO expenses (org_id, user_id, kind, amount, tax, currency, spent_on, vehicle_id, litres, odometer_km, vendor, note, receipt_data_url, status, client_id)
         VALUES ($1,$2,$3,$4,$5,$6, coalesce($7::date, current_date), $8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (org_id, client_id) DO NOTHING RETURNING id, status`,
        [orgId, userId, kind, amount, tax, s.currency, spent, vehicleId, litres, odo, text(body?.vendor, 120, "vendor"), text(body?.note, 500, "note"), receipt, needs ? "submitted" : "approved", client])).rows[0];
      if (!row) return { duplicate: true };
      if (kind === "fuel" && vehicleId && litres) {
        const log = (await c.query("INSERT INTO fuel_logs (org_id, vehicle_id, driver_id, filled_on, litres, cost, odometer_km, station) VALUES ($1,$2,$3, coalesce($4::date, current_date),$5,$6,$7,$8) RETURNING id", [orgId, vehicleId, userId, spent, litres, amount, odo, text(body?.vendor, 120, "vendor")])).rows[0];
        await c.query("UPDATE expenses SET fuel_log_id = $2 WHERE id = $1", [row.id, log.id]);
      }
      if (needs) {
        const name = (await c.query("SELECT coalesce(display_name, email) AS n FROM users WHERE id = $1", [userId])).rows[0].n;
        await c.query("INSERT INTO approvals (org_id, kind, title, detail, subject_kind, subject_id, requested_by) VALUES ($1,'expense',$2,$3,'expense',$4,$5)", [orgId, `Expense: ${name}, ${kind} ${s.currency} ${amount.toFixed(2)}`, JSON.stringify({ amount, kind, currency: s.currency, limit }), row.id, userId]);
      }
      await emit(c, orgId, "expense.submitted", "expense", row.id, { expenseId: row.id, kind, amount, driverId: userId, needsApproval: needs });
      return { id: row.id, status: row.status, needsApproval: needs, duplicate: false };
    });
  }

  @Get("expenses")
  async myExpenses(@Req() req: AuthedRequest) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    return (await withOrg(this.pool, orgId, (c) => c.query(`SELECT id, kind, amount::float AS amount, currency, spent_on::text AS "spentOn", vendor, status, decision_note AS "decisionNote", (receipt_data_url IS NOT NULL) AS "hasReceipt" FROM expenses WHERE user_id = $1 ORDER BY spent_on DESC, created_at DESC LIMIT 50`, [userId]))).rows;
  }

  // ---- tips and short training ----
  @Get("training")
  async training(@Req() req: AuthedRequest, @Query("lang") lang?: string) {
    requirePerm(req, "driver.app");
    return (await withOrg(this.pool, req.session!.orgId, (c) => c.query(`SELECT id, title, body, video_url AS "videoUrl", lang FROM training_items WHERE active AND (lang IS NULL OR $1::text IS NULL OR lang = $1) ORDER BY sort, title LIMIT 100`, [lang === "fr" ? "fr" : lang === "en" ? "en" : null]))).rows;
  }
}
