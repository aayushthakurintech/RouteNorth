import { BadRequestException, Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { co2Kg, delta, forecast, median, parseQuestion, percentile, periodBefore, round } from "@routenorth/shared";
import { AuthGuard, requirePerm, type AuthedRequest, requireAny } from "../auth/auth.guard.js";
import { parseUuid } from "../history/range.js";
import { withDefaults } from "../org/settings.js";
import { PG_POOL } from "../tokens.js";
import { AnalyticsService, breakdown, checkRange, failureReasons, GROUPS, METRICS, summarize, type Filters, type Group, type Range } from "./analytics.service.js";
import { buildInsights } from "./insights.js";

const addDays = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);

export function filtersFrom(q: { driverId?: string; vehicleId?: string; depotId?: string }): Filters {
  return { driverId: q.driverId ? parseUuid(q.driverId) : null, vehicleId: q.vehicleId ? parseUuid(q.vehicleId) : null, depotId: q.depotId ? parseUuid(q.depotId) : null };
}
const groupOf = (x: unknown): Group => { if (!(GROUPS as readonly string[]).includes(String(x))) throw new BadRequestException(`by must be one of ${GROUPS.join(", ")}`); return x as Group; };

/** Today's date in the organization's time zone. */
async function today(pool: pg.Pool, orgId: string): Promise<string> {
  return (await withOrg(pool, orgId, (c) => c.query<{ d: string }>("SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM organizations"))).rows[0]!.d;
}
/** Start of the day, week (Monday) or month containing `d`. */
export function periodStart(d: string, period: "day" | "week" | "month"): string {
  if (period === "day") return d;
  if (period === "month") return `${d.slice(0, 8)}01`;
  const dow = (new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7;
  return addDays(d, -dow);
}

@Controller("analytics")
@UseGuards(AuthGuard)
export class AnalyticsController {
  constructor(@Inject(AnalyticsService) private readonly svc: AnalyticsService, @Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get("metrics")
  metrics(@Req() req: AuthedRequest) { requirePerm(req, "reports.view"); return METRICS; }

  /** All the headline numbers for a period, optionally with the previous period or last year beside them. */
  @Get("summary")
  async summary(@Req() req: AuthedRequest, @Query() q: Record<string, string>) {
    const orgId = requirePerm(req, "reports.view");
    const range = checkRange(q.from, q.to);
    const f = filtersFrom(q);
    const metrics = await this.svc.summary(orgId, range, f);
    if (q.compare !== "prev" && q.compare !== "year") return { range, metrics };
    const before = periodBefore(new Date(`${range.from}T00:00:00Z`), new Date(`${range.to}T00:00:00Z`), q.compare);
    const prevRange: Range = { from: before.from.toISOString().slice(0, 10), to: before.to.toISOString().slice(0, 10) };
    const previous = await this.svc.summary(orgId, q.compare === "prev" ? { from: addDays(range.from, -(Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1)), to: addDays(range.from, -1) } : prevRange, f);
    const deltas: Record<string, ReturnType<typeof delta>> = {};
    for (const k of Object.keys(metrics)) deltas[k] = delta(metrics[k] ?? null, previous[k] ?? null);
    return { range, metrics, previous, deltas, compare: q.compare };
  }

  @Get("breakdown")
  async by(@Req() req: AuthedRequest, @Query() q: Record<string, string>) {
    const orgId = requirePerm(req, "reports.view");
    const range = checkRange(q.from, q.to);
    const b = await this.svc.load(orgId, range, filtersFrom(q));
    return { range, by: groupOf(q.by), rows: breakdown(b, groupOf(q.by)) };
  }

  /** One metric day by day, for a trend line. */
  @Get("series")
  async series(@Req() req: AuthedRequest, @Query() q: Record<string, string>) {
    const orgId = requirePerm(req, "reports.view");
    const metric = q.metric;
    if (!metric || !(metric in METRICS)) throw new BadRequestException("unknown metric");
    const range = checkRange(q.from, q.to);
    const rows = breakdown(await this.svc.load(orgId, range, filtersFrom(q)), "day");
    const byDay = new Map(rows.map((r) => [r.key, r.metrics[metric] ?? null]));
    const days: { date: string; value: number | null }[] = [];
    for (let d = range.from; d <= range.to; d = addDays(d, 1)) days.push({ date: d, value: byDay.get(d) ?? null });
    return { metric, days };
  }

  @Get("reasons")
  async reasons(@Req() req: AuthedRequest, @Query() q: Record<string, string>) {
    const orgId = requirePerm(req, "reports.view");
    return failureReasons(await this.svc.load(orgId, checkRange(q.from, q.to), filtersFrom(q)));
  }

  /** Right now: today's jobs by state, stops running late, vehicles sitting with the engine on. */
  @Get("live")
  async live(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "reports.view", "fleet.view", "routes.view");
    return withOrg(this.pool, orgId, async (c) => {
      const org = (await c.query<{ d: string; settings: unknown }>("SELECT (now() AT TIME ZONE timezone)::date::text AS d, settings FROM organizations")).rows[0]!;
      const idleMin = withDefaults(org.settings).idleThresholdMin;
      const jobs = (await c.query<{ status: string; n: number }>("SELECT status, count(*)::int AS n FROM jobs WHERE scheduled_date = $1::date GROUP BY status", [org.d])).rows;
      const late = (await c.query(
        `SELECT s.id, s.name, s.route_id AS "routeId", r.name AS "routeName", s.window_end AS "windowEnd", s.eta, s.status,
                greatest(extract(epoch FROM (coalesce(s.eta, now()) - s.window_end)) / 60, 0)::int AS "lateMin"
         FROM stops s JOIN routes r ON r.id = s.route_id WHERE r.route_date = $1::date AND r.status <> 'cancelled' AND s.status IN ('pending','arrived') AND s.window_end IS NOT NULL
           AND (s.window_end < now() OR s.eta > s.window_end) ORDER BY "lateMin" DESC LIMIT 50`, [org.d])).rows;
      const idle = (await c.query(
        `SELECT d.id AS "deviceId", coalesce(v.name, d.external_id) AS name, lp.lat, lp.lng FROM latest_positions lp JOIN devices d ON d.id = lp.device_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
         WHERE lp.time > now() - interval '15 minutes' AND lp.speed < 2 AND coalesce(lp.ignition, false)
           AND NOT EXISTS (SELECT 1 FROM positions p WHERE p.device_id = d.id AND p.time > now() - make_interval(mins => $1) AND (p.speed >= 2 OR p.ignition IS NOT TRUE))
           AND EXISTS (SELECT 1 FROM positions p WHERE p.device_id = d.id AND p.time <= now() - make_interval(mins => $1) AND p.time > now() - make_interval(mins => $1 + 10))`, [idleMin])).rows;
      const moving = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM latest_positions WHERE time > now() - interval '10 minutes' AND speed >= 2")).rows[0]!.n;
      const active = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM routes WHERE route_date = $1::date AND status = 'in_progress'", [org.d])).rows[0]!.n;
      return { date: org.d, jobs, lateStops: late, idleVehicles: idle, vehiclesMoving: moving, routesActive: active, idleThresholdMin: idleMin };
    });
  }

  /** Driving events found in the GPS tracks: speeding, harsh braking, harsh acceleration. */
  @Get("safety")
  async safety(@Req() req: AuthedRequest, @Query() q: Record<string, string>) {
    const orgId = requirePerm(req, "reports.view");
    const b = await this.svc.load(orgId, checkRange(q.from, q.to), filtersFrom(q));
    const events = b.safe.map((e) => ({ ...e, driver: e.driverId ? b.names.driver.get(e.driverId) ?? null : null, vehicle: e.name })).sort((a, c) => c.time.localeCompare(a.time));
    return { totals: { speeding: events.filter((e) => e.kind === "speeding").length, harshBrake: events.filter((e) => e.kind === "harsh_brake").length, harshAccel: events.filter((e) => e.kind === "harsh_accel").length, incidents: b.inc.length }, events: events.slice(0, 500) };
  }

  /** Kilometres, money and CO2 saved by applying optimized route orders. */
  @Get("savings")
  async savings(@Req() req: AuthedRequest, @Query() q: Record<string, string>) {
    const orgId = requirePerm(req, "reports.view");
    const range = checkRange(q.from, q.to);
    const r = (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT count(*)::int AS "routes", coalesce(sum(greatest(before_km - after_km, 0)), 0) AS km, coalesce(sum(greatest(before_cost - after_cost, 0)), 0) AS cost
       FROM route_savings WHERE (at AT TIME ZONE (SELECT timezone FROM organizations))::date BETWEEN $1::date AND $2::date`, [range.from, range.to]))).rows[0]!;
    const km = Number(r.km);
    return { optimizedRoutes: r.routes, kmSaved: round(km), costSaved: round(Number(r.cost), 2), co2KgSaved: round(co2Kg((km * 30) / 100, "diesel"), 0), assumption: "30 L per 100 km" };
  }

  /** Compare drivers, vehicles, depots or routes: each one against the middle of the group. */
  @Get("benchmarks")
  async benchmarks(@Req() req: AuthedRequest, @Query() q: Record<string, string>) {
    const orgId = requirePerm(req, "reports.view");
    const by = groupOf(q.by ?? "driver");
    const keys = (q.metrics ?? "onTimeRate,avgDelayMin,idleSharePct,costPerKm,driverScore").split(",").filter((k) => k in METRICS);
    const rows = breakdown(await this.svc.load(orgId, checkRange(q.from, q.to), filtersFrom(q)), by);
    const stats = Object.fromEntries(keys.map((k) => {
      const vals = rows.map((r) => r.metrics[k]).filter((x): x is number => x != null);
      return [k, { median: round(median(vals), 2), p25: round(percentile(vals, 0.25), 2), p75: round(percentile(vals, 0.75), 2), best: vals.length ? (METRICS[k]!.better === "down" ? Math.min(...vals) : Math.max(...vals)) : null }];
    }));
    return {
      by, metrics: keys, stats,
      rows: rows.map((r) => ({
        key: r.key, name: r.name,
        values: Object.fromEntries(keys.map((k) => {
          const v = r.metrics[k] ?? null; const vals = rows.map((x) => x.metrics[k]).filter((x): x is number => x != null);
          const better = METRICS[k]!.better;
          const rank = v == null || better == null ? null : 1 + vals.filter((x) => (better === "up" ? x > v : x < v)).length;
          return [k, { value: v, rank, of: vals.length, vsMedianPct: v != null && stats[k]!.median ? round(((v - stats[k]!.median!) / Math.abs(stats[k]!.median!)) * 100, 1) : null }];
        })),
      })),
    };
  }

  /** Next week's expected workload from the last four weeks of the same weekdays. */
  @Get("forecast")
  async forecast(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "reports.view");
    const end = await today(this.pool, orgId);
    const range: Range = { from: addDays(end, -27), to: end };
    const rows = breakdown(await this.svc.load(orgId, range, {}), "day");
    const series = (k: string) => { const m = new Map(rows.map((r) => [r.key, Number(r.metrics[k] ?? 0)])); const out: { date: string; value: number }[] = []; for (let d = range.from; d <= range.to; d = addDays(d, 1)) out.push({ date: d, value: m.get(d) ?? 0 }); return out; };
    const booked = (await withOrg(this.pool, orgId, (c) => c.query<{ d: string; n: number }>(
      "SELECT scheduled_date::text AS d, count(*)::int AS n FROM jobs WHERE scheduled_date > $1::date AND scheduled_date <= ($1::date + 7) AND status <> 'cancelled' GROUP BY 1", [end]))).rows;
    return { from: addDays(end, 1), stops: forecast(series("stops"), 7), cost: forecast(series("costTotal"), 7), driveHours: forecast(series("engineOnH"), 7), booked: Object.fromEntries(booked.map((b) => [b.d, b.n])) };
  }

  /** What stands out lately, in plain language. */
  @Get("insights")
  async insights(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "reports.view");
    const end = await today(this.pool, orgId);
    const b = await this.svc.load(orgId, { from: addDays(end, -27), to: end }, {});
    const cur = summarize({ ...b, stops: b.stops.filter((s) => s.date > addDays(end, -7)), routes: b.routes.filter((r) => r.date > addDays(end, -7)), mv: b.mv.filter((m) => m.date > addDays(end, -7)), fuel: [], maint: [], inc: [], fb: [], safe: [] });
    const prev = summarize({ ...b, stops: b.stops.filter((s) => s.date <= addDays(end, -7) && s.date > addDays(end, -14)), routes: [], mv: [], fuel: [], maint: [], inc: [], fb: [], safe: [] });
    return buildInsights(b, cur, prev);
  }

  /** Targets with progress for the current day, week or month. */
  @Get("goals")
  async goals(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "reports.view");
    const end = await today(this.pool, orgId);
    const goals = (await withOrg(this.pool, orgId, (c) => c.query("SELECT id, name, metric, target, direction, period FROM goals WHERE active ORDER BY name"))).rows;
    const cache = new Map<string, Record<string, number | null | undefined>>();
    const out = [];
    for (const g of goals) {
      const from = periodStart(end, g.period);
      const key = `${from}`;
      if (!cache.has(key)) cache.set(key, await this.svc.summary(orgId, { from, to: end }));
      const value = (cache.get(key)![g.metric] ?? null) as number | null;
      let progress: number | null = null;
      if (value != null) progress = g.direction === "up" ? (g.target > 0 ? Math.min(100, (value / g.target) * 100) : 100) : value <= g.target ? 100 : Math.min(100, (g.target / value) * 100);
      const met = value != null && (g.direction === "up" ? value >= g.target : value <= g.target);
      out.push({ ...g, period: g.period, from, to: end, value, progressPct: round(progress, 0), status: value == null ? "nodata" : met ? "met" : (progress ?? 0) >= 90 ? "close" : "behind" });
    }
    return out;
  }

  /** Ask in plain words: "which driver had the most delays last month?" */
  @Post("ask")
  async ask(@Req() req: AuthedRequest, @Body() body: { q?: unknown }) {
    const orgId = requirePerm(req, "reports.view");
    const text = typeof body?.q === "string" ? body.q.trim() : "";
    if (!text || text.length > 300) throw new BadRequestException("ask a question of up to 300 characters");
    const q = parseQuestion(text);
    if (!q) return { understood: false };
    const to = addDays(q.to.toISOString().slice(0, 10), -1);
    let from = new Date(q.from.getTime() - q.from.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const endLocal = new Date(q.to.getTime() - q.to.getTimezoneOffset() * 60000 - 86_400_000).toISOString().slice(0, 10);
    let clamped = false;
    if ((Date.parse(endLocal) - Date.parse(from)) / 86_400_000 + 1 > 31) { from = addDays(endLocal, -30); clamped = true; }
    const range: Range = { from, to: endLocal };
    void to;
    const b = await this.svc.load(orgId, range, {});
    const meta = METRICS[q.metric]!;
    if (!q.by) return { understood: true, metric: q.metric, unit: meta.unit, period: q.periodLabel, range, clamped, by: null, value: summarize(b)[q.metric] ?? null };
    const rows = breakdown(b, q.by as Group).map((r) => ({ key: r.key, name: r.name, value: r.metrics[q.metric] ?? null })).filter((r) => r.value != null) as { key: string; name: string; value: number }[];
    rows.sort((a, c) => (q.order === "desc" ? c.value - a.value : a.value - c.value));
    return { understood: true, metric: q.metric, unit: meta.unit, period: q.periodLabel, range, clamped, by: q.by, rows: q.by === "day" ? rows.sort((a, c) => a.key.localeCompare(c.key)) : rows.slice(0, q.limit) };
  }

  /** A driver's own numbers: score, distance, on-time rate, safety events and an earnings estimate. Managers can look up any driver. */
  @Get("me")
  async me(@Req() req: AuthedRequest, @Query() q: Record<string, string>) {
    const orgId = requireAny(req, "driver.app", "reports.view");
    const isDriver = req.session!.role === "driver" || !!(req as { perms?: Set<string> }).perms?.has("driver.app") && !(req as { perms?: Set<string> }).perms?.has("reports.view");
    const driverId = isDriver || !q.driverId ? req.session!.userId : parseUuid(q.driverId);
    const end = await today(this.pool, orgId);
    const range = checkRange(q.from ?? periodStart(end, "month"), q.to ?? end);
    const b = await this.svc.load(orgId, range, { driverId });
    const metrics = summarize(b);
    const rate = (await withOrg(this.pool, orgId, (c) => c.query<{ r: string | null }>("SELECT hourly_rate AS r FROM driver_profiles WHERE user_id = $1", [driverId]))).rows[0]?.r;
    const hours = b.mv.reduce((a, m) => a + m.shiftH, 0);
    const ot = metrics.overtimeH ?? 0;
    const earnings = rate ? { hours: round(hours), rate: Number(rate), overtimeH: ot, estimate: round(Number(rate) * (hours - ot) + Number(rate) * 1.5 * ot, 2) } : null;
    const days = breakdown(b, "day").map((d) => ({ date: d.key, distanceKm: d.metrics.distanceKm ?? 0, stops: d.metrics.stopsDone ?? 0 }));
    return { range, metrics, earnings, days, note: "Earnings are an estimate from hourly rate and shift hours; overtime is paid at 1.5 times." };
  }
}
