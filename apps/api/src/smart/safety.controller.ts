import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { coachingTips, detectCornering, driverScore, fatigueState, type Fix } from "@routenorth/shared";
import { AnalyticsService, breakdown, checkRange, summarize, type Range } from "../analytics/analytics.service.js";
import { AuthGuard, requireAny, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { emit } from "../automation/events.js";
import { openShift } from "../driver/shifts.js";
import { fatigueOf } from "./fatigue.js";
import { parseUuid } from "../history/range.js";
import { withDefaults } from "../org/settings.js";
import { PG_POOL } from "../tokens.js";
import { todayIn } from "./ai.controller.js";

const METRIC_KEYS = ["driverScore", "onTimeRate", "stopsDone", "csat", "speedingEvents", "harshBrakes"] as const;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Cornering per driver in a short range, from GPS headings. Kept to 14 days because it reads raw positions. */
export async function corneringByDriver(c: pg.PoolClient, range: Range): Promise<Map<string, number>> {
  const rows = (await c.query(
    `SELECT p.device_id, d.vehicle_id, p.time, p.lat, p.lng, p.speed, p.heading, p.ignition, (p.time AT TIME ZONE o.timezone)::date::text AS day
     FROM positions p JOIN devices d ON d.id = p.device_id JOIN organizations o ON o.id = p.org_id
     WHERE p.time >= $1::date - 1 AND p.time < $2::date + 2 AND p.heading IS NOT NULL AND p.speed > 15 ORDER BY p.device_id, p.time LIMIT 400000`, [range.from, range.to])).rows;
  const byDev = new Map<string, { vehicle: string | null; fixes: (Fix & { heading: number; day: string })[] }>();
  for (const r of rows) (byDev.get(r.device_id) ?? byDev.set(r.device_id, { vehicle: r.vehicle_id, fixes: [] }).get(r.device_id)!).fixes.push({ time: new Date(r.time).toISOString(), lat: r.lat, lng: r.lng, speed: r.speed, ignition: r.ignition, heading: r.heading, day: r.day });
  const drivers = (await c.query(`SELECT vehicle_id, driver_id, route_date::text AS d FROM routes WHERE route_date BETWEEN $1::date AND $2::date AND driver_id IS NOT NULL`, [range.from, range.to])).rows;
  const who = new Map(drivers.map((r) => [`${r.vehicle_id}|${r.d}`, r.driver_id as string]));
  const out = new Map<string, number>();
  for (const dev of byDev.values()) {
    const dayOf = new Map(dev.fixes.map((f) => [f.time, f.day]));
    for (const e of detectCornering(dev.fixes)) {
      const day = dayOf.get(e.time)!;
      if (day < range.from || day > range.to) continue;
      const d = who.get(`${dev.vehicle}|${day}`);
      if (d) out.set(d, (out.get(d) ?? 0) + 1);
    }
  }
  return out;
}

/** Safety scores, coaching, leaderboard, rewards, fatigue, SOS and crash, dash cam clips and lone-worker check-ins. */
@Controller("safety")
@UseGuards(AuthGuard)
export class SafetyController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(AnalyticsService) private readonly svc: AnalyticsService) {}

  private async settings(orgId: string) { return withDefaults((await withOrg(this.pool, orgId, (c) => c.query("SELECT settings FROM organizations WHERE id = $1", [orgId]))).rows[0].settings); }
  private range(from?: string, to?: string): Range {
    const t = todayIn("UTC");
    return checkRange(from ?? addDays(t, -13), to ?? t);
  }

  /** Score for each driver: speeding, hard braking, hard acceleration, hard cornering and incidents, per distance driven. */
  @Get("scores")
  async scoresRoute(@Req() req: AuthedRequest, @Query("from") from?: string, @Query("to") to?: string) {
    return this.scores(requirePerm(req, "reports.view"), this.range(from, to));
  }

  private async scores(orgId: string, range: Range) {
    const b = await this.svc.load(orgId, range);
    const rows = breakdown(b, "driver");
    const corners = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 <= 14 ? await withOrg(this.pool, orgId, (c) => corneringByDriver(c, range)) : null;
    return {
      range, cornering: corners != null,
      drivers: rows.map((r) => {
        const m = r.metrics, corner = corners?.get(r.key) ?? 0;
        const km = Number(m.distanceKm ?? 0);
        const score = driverScore(km, { speeding: Number(m.speedingEvents ?? 0), harshBrake: Number(m.harshBrakes ?? 0), harshAccel: Number(m.harshAccels ?? 0) + corner, incidents: Number(m.incidents ?? 0) });
        return { driverId: r.key, name: r.name, km: Math.round(km), score, speeding: m.speedingEvents ?? 0, harshBrakes: m.harshBrakes ?? 0, harshAccels: m.harshAccels ?? 0, corners: corners ? corner : null, incidents: m.incidents ?? 0 };
      }).sort((a, z) => (z.score ?? -1) - (a.score ?? -1)),
    };
  }

  /** The driver's own tips after their latest trips. */
  @Get("my-tips")
  async myTips(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "driver.app");
    const { userId } = req.session!;
    if (!(await this.settings(orgId)).safety.coaching) return { enabled: false, tips: [] };
    const today = todayIn("UTC");
    const range = { from: addDays(today, -1), to: today };
    const b = await this.svc.load(orgId, range, { driverId: userId });
    const m = summarize(b);
    const corners = (await withOrg(this.pool, orgId, (c) => corneringByDriver(c, range))).get(userId) ?? 0;
    const km = Number(m.distanceKm ?? 0);
    const tips = km < 1 ? [] : coachingTips({ km, speeding: Number(m.speedingEvents ?? 0), harshBrake: Number(m.harshBrakes ?? 0), harshAccel: Number(m.harshAccels ?? 0), corner: corners, idleMin: Number(m.idleH ?? 0) * 60 });
    return { enabled: true, km: Math.round(km), score: m.driverScore ?? null, tips };
  }

  /** Optional and fair: ranks by score only, only drivers with enough distance, names hidden unless the company turned them on. */
  @Get("leaderboard")
  async leaderboard(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "driver.app", "reports.view");
    const s = await this.settings(orgId);
    const manager = !!req.perms?.has("reports.view");
    if (!s.safety.leaderboard && !manager) return { enabled: false, rows: [] };
    const r = (await this.scores(orgId, this.range())).drivers;
    const ranked = r.filter((d) => d.km >= 50 && d.score != null);
    const me = req.session!.userId;
    const rows = ranked.map((d, i) => ({ rank: i + 1, score: d.score, you: d.driverId === me, name: manager || !s.safety.anonymous || d.driverId === me ? d.name : null, badges: badges(d) }));
    return { enabled: s.safety.leaderboard, anonymous: s.safety.anonymous, minKm: 50, rows: manager ? rows : rows.filter((x) => x.rank <= 5 || x.you) };
  }

  /* ---------------------------------------------------------------- rewards */
  @Get("reward-rules")
  async rules(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "reports.view");
    return (await withOrg(this.pool, orgId, (c) => c.query(`SELECT id, name, metric, op, target::float, bonus::float, period, active FROM reward_rules ORDER BY created_at`))).rows;
  }

  private rule(b: Record<string, unknown>) {
    const name = text(b.name, 80), metric = String(b.metric), op = b.op === "lte" ? "lte" : "gte", period = b.period === "week" ? "week" : "month";
    const target = Number(b.target), bonus = Number(b.bonus);
    if (!name || !(METRIC_KEYS as readonly string[]).includes(metric) || !Number.isFinite(target) || !(bonus >= 0 && bonus <= 100000)) throw new BadRequestException("a rule needs a name, a measure, a target and a bonus");
    return { name, metric, op, target, bonus, period };
  }

  @Post("reward-rules")
  async createRule(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const orgId = requirePerm(req, "reports.manage");
    const r = this.rule(body ?? {});
    return (await withOrg(this.pool, orgId, (c) => c.query(`INSERT INTO reward_rules (org_id, name, metric, op, target, bonus, period) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [orgId, r.name, r.metric, r.op, r.target, r.bonus, r.period]))).rows[0];
  }

  @Patch("reward-rules/:id")
  async updateRule(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: Record<string, unknown>) {
    const orgId = requirePerm(req, "reports.manage");
    if (typeof body?.active === "boolean" && Object.keys(body).length === 1) {
      if (!(await withOrg(this.pool, orgId, (c) => c.query("UPDATE reward_rules SET active = $2 WHERE id = $1", [parseUuid(id), body.active]))).rowCount) throw new NotFoundException();
      return { ok: true };
    }
    const r = this.rule(body ?? {});
    if (!(await withOrg(this.pool, orgId, (c) => c.query("UPDATE reward_rules SET name=$2, metric=$3, op=$4, target=$5, bonus=$6, period=$7 WHERE id = $1", [parseUuid(id), r.name, r.metric, r.op, r.target, r.bonus, r.period]))).rowCount) throw new NotFoundException();
    return { ok: true };
  }

  @Delete("reward-rules/:id")
  @HttpCode(200)
  async deleteRule(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "reports.manage");
    if (!(await withOrg(this.pool, orgId, (c) => c.query("DELETE FROM reward_rules WHERE id = $1", [parseUuid(id)]))).rowCount) throw new NotFoundException();
    return { ok: true };
  }

  /** Work out who earned what for the last finished week or month. Safe to run again: each driver earns a rule once per period. */
  @Post("rewards/run")
  @HttpCode(200)
  async runRewards(@Req() req: AuthedRequest, @Body() body: { asOf?: unknown }) {
    const orgId = requirePerm(req, "reports.manage");
    const today = body?.asOf ? String(body.asOf) : todayIn("UTC");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(today)) throw new BadRequestException("asOf must be a date");
    const rules = (await withOrg(this.pool, orgId, (c) => c.query(`SELECT id, name, metric, op, target::float, bonus::float, period FROM reward_rules WHERE active`))).rows;
    let earned = 0;
    for (const rule of rules) {
      const p = lastPeriod(today, rule.period);
      const rows = breakdown(await this.svc.load(orgId, p), "driver");
      for (const r of rows) {
        const v = r.metrics[rule.metric as keyof typeof r.metrics];
        const active = Number(r.metrics.stopsDone ?? 0) > 0 || Number(r.metrics.distanceKm ?? 0) > 0;
        if (v == null || !active) continue;
        if (rule.op === "gte" ? Number(v) < rule.target : Number(v) > rule.target) continue;
        const ins = await withOrg(this.pool, orgId, (c) => c.query(
          `INSERT INTO rewards (org_id, rule_id, driver_id, period_start, period_end, value, amount) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (rule_id, driver_id, period_start) DO NOTHING`, [orgId, rule.id, r.key, p.from, p.to, v, rule.bonus]));
        earned += ins.rowCount ?? 0;
      }
    }
    return { earned };
  }

  @Get("rewards")
  async rewards(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "reports.view");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT w.id, w.driver_id AS "driverId", coalesce(u.display_name, u.email) AS "driverName", r.name AS rule, w.period_start::text AS "periodStart", w.period_end::text AS "periodEnd", w.value::float, w.amount::float, w.status
       FROM rewards w JOIN reward_rules r ON r.id = w.rule_id JOIN users u ON u.id = w.driver_id ORDER BY w.period_start DESC, u.email LIMIT 500`))).rows;
  }

  @Patch("rewards/:id")
  async setReward(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { status?: unknown }) {
    const orgId = requirePerm(req, "reports.manage");
    if (!["earned", "paid", "void"].includes(String(body?.status))) throw new BadRequestException("status must be earned, paid or void");
    if (!(await withOrg(this.pool, orgId, (c) => c.query("UPDATE rewards SET status = $2 WHERE id = $1", [parseUuid(id), body.status]))).rowCount) throw new NotFoundException();
    return { ok: true };
  }

  @Get("my-rewards")
  async myRewards(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "driver.app");
    const rows = (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT r.name AS rule, w.period_start::text AS "periodStart", w.period_end::text AS "periodEnd", w.amount::float, w.status FROM rewards w JOIN reward_rules r ON r.id = w.rule_id WHERE w.driver_id = $1 AND w.status <> 'void' ORDER BY w.period_start DESC LIMIT 24`, [req.session!.userId]))).rows;
    return { rewards: rows, total: rows.reduce((a, r) => a + r.amount, 0) };
  }

  /* ---------------------------------------------------------------- fatigue, SOS and crash */
  /** Hours on shift and since the last break for everyone on shift now, with the level. */
  @Get("fatigue")
  async fatigue(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "reports.view");
    const s = (await this.settings(orgId)).safety;
    return withOrg(this.pool, orgId, async (c) => {
      const open = (await c.query("SELECT s.driver_id, coalesce(u.display_name, u.email) AS name FROM shifts s JOIN users u ON u.id = s.driver_id WHERE s.ended_at IS NULL")).rows;
      const out = [];
      for (const o of open) out.push({ driverId: o.driver_id, name: o.name, ...(await fatigueOf(c, o.driver_id, s)) });
      return { drivers: out.sort((a, b) => ({ now: 0, soon: 1, ok: 2 })[a.level] - ({ now: 0, soon: 1, ok: 2 })[b.level] || b.sinceBreakMin - a.sinceBreakMin) };
    });
  }

  @Get("my-fatigue")
  async myFatigue(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "driver.app");
    const s = (await this.settings(orgId)).safety;
    return withOrg(this.pool, orgId, async (c) => ((await openShift(c, req.session!.userId)) ? { onShift: true, ...(await fatigueOf(c, req.session!.userId, s)) } : { onShift: false }));
  }

  /** Crash reported by the phone or by the vehicle's GPS track. Starts a critical call for help the office sees at once. */
  @Post("crash")
  @HttpCode(200)
  async crash(@Req() req: AuthedRequest, @Body() body: { lat?: unknown; lng?: unknown; source?: unknown; kmh?: unknown; clientId?: unknown }) {
    const orgId = requirePerm(req, "driver.app");
    const { userId } = req.session!;
    const lat = body?.lat == null ? null : Number(body.lat), lng = body?.lng == null ? null : Number(body.lng);
    if ((lat != null && !(Math.abs(lat) <= 90)) || (lng != null && !(Math.abs(lng) <= 180))) throw new BadRequestException("invalid position");
    const source = body?.source === "gps" ? "gps" : "phone";
    const cid = body?.clientId ? parseUuid(String(body.clientId)) : null;
    return withOrg(this.pool, orgId, async (c) => {
      const row = (await c.query(
        `INSERT INTO help_requests (org_id, driver_id, kind, note, lat, lng, client_id) VALUES ($1,$2,'crash',$3,$4,$5,$6) ON CONFLICT (org_id, client_id) DO NOTHING RETURNING id`,
        [orgId, userId, `Possible crash detected by the ${source}${body?.kmh ? ` (from ${Math.round(Number(body.kmh))} km/h)` : ""}. The driver did not cancel.`, lat, lng, cid])).rows[0];
      if (!row) return { duplicate: true };
      const name = (await c.query("SELECT coalesce(display_name, email) AS n FROM users WHERE id = $1", [userId])).rows[0].n;
      await c.query(`INSERT INTO alerts (org_id, kind, severity, title, detail, subject_kind, subject_id, dedupe_key) VALUES ($1,'help_request','critical',$2,$3,'driver',$4,$5)`,
        [orgId, `${name}: possible crash`, JSON.stringify({ helpId: row.id, lat, lng, source }), userId, `help:${row.id}`]);
      await emit(c, orgId, "help.requested", "driver", userId, { helpId: row.id, kind: "crash", driverId: userId, lat, lng });
      return { id: row.id, duplicate: false };
    });
  }

  /* ---------------------------------------------------------------- events and clips */
  /** Speeding, hard braking and hard acceleration in a short period, each with any dash cam clip taken within two minutes. */
  @Get("events")
  async events(@Req() req: AuthedRequest, @Query("from") from?: string, @Query("to") to?: string, @Query("driverId") driverId?: string) {
    const orgId = requirePerm(req, "reports.view");
    const range = this.range(from ?? addDays(todayIn("UTC"), -6), to);
    const b = await this.svc.load(orgId, range, { driverId: driverId ? parseUuid(driverId) : null });
    const clips = (await withOrg(this.pool, orgId, (c) => c.query(`SELECT id, vehicle_id, event_at, url, event_kind FROM video_clips WHERE event_at BETWEEN $1::date - 1 AND $2::date + 2`, [range.from, range.to]))).rows;
    const ev = b.safe.slice(0, 500).map((e) => ({
      kind: e.kind, time: e.time, lat: e.lat, lng: e.lng, value: e.value, vehicle: e.name, vehicleId: e.vehicleId, driverId: e.driverId,
      clips: clips.filter((k) => k.vehicle_id === e.vehicleId && Math.abs(new Date(k.event_at).getTime() - Date.parse(e.time)) <= 120_000).map((k) => ({ id: k.id, url: k.url })),
    }));
    return { range, events: ev.sort((a, z) => z.time.localeCompare(a.time)) };
  }

  @Get("clips")
  async clips(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "reports.view");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT k.id, k.vehicle_id AS "vehicleId", v.name AS vehicle, k.driver_id AS "driverId", k.event_kind AS "eventKind", k.event_at AS "eventAt", k.url, k.note, k.incident_id AS "incidentId"
       FROM video_clips k LEFT JOIN vehicles v ON v.id = k.vehicle_id ORDER BY k.event_at DESC LIMIT 200`))).rows;
  }

  /** Link a clip from the dash cam system (its web address) to a moment or an incident. The video stays with the camera provider. */
  @Post("clips")
  async addClip(@Req() req: AuthedRequest, @Body() b: { vehicleId?: unknown; driverId?: unknown; eventKind?: unknown; eventAt?: unknown; url?: unknown; note?: unknown; incidentId?: unknown }) {
    const orgId = requirePerm(req, "fleet.manage");
    const url = text(b?.url, 1000);
    const at = new Date(String(b?.eventAt));
    if (!/^https:\/\/[^\s]+$/.test(url) || Number.isNaN(at.getTime())) throw new BadRequestException("a clip needs an https:// address and the time of the event");
    const kind = String(b?.eventKind ?? "other");
    if (!["speeding", "harsh_brake", "harsh_accel", "harsh_corner", "crash", "sos", "incident", "other"].includes(kind)) throw new BadRequestException("unknown event kind");
    const id = (v: unknown) => (v ? parseUuid(String(v)) : null);
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `INSERT INTO video_clips (org_id, vehicle_id, driver_id, event_kind, event_at, url, note, incident_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [orgId, id(b?.vehicleId), id(b?.driverId), kind, at, url, text(b?.note, 500) || null, id(b?.incidentId), req.session!.userId]))).rows[0];
  }

  @Delete("clips/:id")
  @HttpCode(200)
  async deleteClip(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "fleet.manage");
    if (!(await withOrg(this.pool, orgId, (c) => c.query("DELETE FROM video_clips WHERE id = $1", [parseUuid(id)]))).rowCount) throw new NotFoundException();
    return { ok: true };
  }

  /* ---------------------------------------------------------------- lone worker */
  @Post("checkins/start")
  @HttpCode(200)
  async startCheckin(@Req() req: AuthedRequest, @Body() b: { everyMin?: unknown; note?: unknown; lat?: unknown; lng?: unknown }) {
    const orgId = req.session!.orgId;
    const every = Math.trunc(Number(b?.everyMin) || 30);
    if (!(every >= 5 && every <= 480)) throw new BadRequestException("everyMin must be 5 to 480");
    const { userId } = req.session!;
    return withOrg(this.pool, orgId, async (c) => {
      await c.query("UPDATE checkins SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL", [userId]);
      const r = (await c.query(`INSERT INTO checkins (org_id, user_id, every_min, note, lat, lng) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, every_min AS "everyMin", last_ok_at AS "lastOkAt"`, [orgId, userId, every, text(b?.note, 300) || null, b?.lat == null ? null : Number(b.lat), b?.lng == null ? null : Number(b.lng)])).rows[0];
      return r;
    });
  }

  @Post("checkins/ok")
  @HttpCode(200)
  async checkinOk(@Req() req: AuthedRequest, @Body() b: { lat?: unknown; lng?: unknown }) {
    const { orgId, userId } = req.session!;
    const r = await withOrg(this.pool, orgId, (c) => c.query(`UPDATE checkins SET last_ok_at = now(), lat = coalesce($2, lat), lng = coalesce($3, lng) WHERE user_id = $1 AND ended_at IS NULL RETURNING id, last_ok_at AS "lastOkAt"`, [userId, b?.lat == null ? null : Number(b.lat), b?.lng == null ? null : Number(b.lng)]));
    if (!r.rowCount) throw new NotFoundException("no check-in is running");
    return r.rows[0];
  }

  @Post("checkins/end")
  @HttpCode(200)
  async endCheckin(@Req() req: AuthedRequest) {
    const { orgId, userId } = req.session!;
    await withOrg(this.pool, orgId, (c) => c.query("UPDATE checkins SET ended_at = now() WHERE user_id = $1 AND ended_at IS NULL", [userId]));
    return { ok: true };
  }

  @Get("checkins/mine")
  async myCheckin(@Req() req: AuthedRequest) {
    const { orgId, userId } = req.session!;
    const r = (await withOrg(this.pool, orgId, (c) => c.query(`SELECT id, every_min AS "everyMin", last_ok_at AS "lastOkAt", note FROM checkins WHERE user_id = $1 AND ended_at IS NULL`, [userId]))).rows[0];
    return { active: r ?? null };
  }

  @Get("checkins")
  async checkins(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "reports.view");
    const s = (await this.settings(orgId)).safety;
    const rows = (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT k.id, coalesce(u.display_name, u.email) AS name, k.every_min AS "everyMin", k.started_at AS "startedAt", k.last_ok_at AS "lastOkAt", k.note, k.lat, k.lng
       FROM checkins k JOIN users u ON u.id = k.user_id WHERE k.ended_at IS NULL ORDER BY k.last_ok_at`))).rows;
    return { graceMin: s.checkinGraceMin, active: rows.map((r) => ({ ...r, dueAt: new Date(new Date(r.lastOkAt).getTime() + r.everyMin * 60000), missed: Date.now() > new Date(r.lastOkAt).getTime() + (r.everyMin + s.checkinGraceMin) * 60000 })) };
  }
}

/** The last finished week (Monday to Sunday) or calendar month before `today`. */
export function lastPeriod(today: string, period: "week" | "month"): Range {
  const d = new Date(`${today}T12:00:00Z`);
  if (period === "month") {
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - 1, 1, 12)), end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 0, 12));
    return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
  }
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  const mon = addDays(today, -dow - 7);
  return { from: mon, to: addDays(mon, 6) };
}

/** Small, positive badges (never shown as a shaming list). */
function badges(d: { score: number | null; speeding: number | string | null; harshBrakes: number | string | null; incidents: number | string | null; km: number }): string[] {
  const out: string[] = [];
  if ((d.score ?? 0) >= 95) out.push("smooth");
  if (Number(d.speeding) === 0 && d.km >= 100) out.push("no_speeding");
  if (Number(d.incidents) === 0 && d.km >= 500) out.push("incident_free");
  return out;
}
