import { BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Post, Query, Req, ServiceUnavailableException, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import {
  breakdownRisk, checkAddress, demandForecast, explainDelays, learnDwell, lateRisk, median, normalizeAddress, parseAssistant, suggestDrivers,
  type AssistantIntent, type DriverCtx, type VehicleHealth,
} from "@routenorth/shared";
import { AuthGuard, requirePerm, requireAny, type AuthedRequest } from "../auth/auth.guard.js";
import { emit } from "../automation/events.js";
import { notifyCustomer } from "../customer/notify.js";
import { GEOCODER, JWT_SECRET, NOTIFY, PG_POOL } from "../tokens.js";
import type { GeoHit, Geocoder } from "../dispatch/geocoder.js";
import { parseUuid } from "../history/range.js";
import { resequence, routeForDriver } from "../dispatch/jobs.service.js";
import type { Providers } from "../notify/notifier.js";
import { AnalyticsService } from "../analytics/analytics.service.js";
import { REPORT_TEMPLATES } from "../reports/templates.js";
import { parseDate } from "../routes/validate.js";
import { aiAsk, aiConfigured, extractJson } from "./ai.js";

export const todayIn = (tz: string, offsetDays = 0) => new Date(Date.now() + offsetDays * 86_400_000).toLocaleDateString("en-CA", { timeZone: tz });
const DAY = 86_400_000;

/** The "smart" helpers: a daily briefing, predictions, explanations, learned times and a chat assistant. All are rules over the organization's own data, and say what they used. */
@Controller("ai")
@UseGuards(AuthGuard)
export class AiController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(GEOCODER) private readonly geocoder: Geocoder | null,
    @Inject(NOTIFY) private readonly notify: Providers,
    @Inject(JWT_SECRET) private readonly secret: string,
    @Inject(AnalyticsService) private readonly svc: AnalyticsService,
  ) {}

  private tz = async (c: pg.PoolClient, orgId: string) => (await c.query<{ timezone: string }>("SELECT timezone FROM organizations WHERE id = $1", [orgId])).rows[0]!.timezone;

  /** Where the AI features stand: what works without any outside service and what needs a key. */
  @Get("status")
  status(@Req() req: AuthedRequest) {
    requirePerm(req, "routes.view");
    return { assistant: { rules: true, ai: aiConfigured() }, readDocuments: aiConfigured() };
  }

  /** "What needs my attention today?" */
  @Get("briefing")
  async briefing(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "routes.view");
    return withOrg(this.pool, orgId, async (c) => {
      const tz = await this.tz(c, orgId);
      const today = todayIn(tz);
      const one = async (sql: string, args: unknown[] = []) => (await c.query(sql, args)).rows;
      const items: { key: string; severity: "info" | "warn" | "critical"; count: number; examples: string[]; link: string }[] = [];
      const add = (key: string, severity: "info" | "warn" | "critical", rows: { label: string }[], link: string) => { if (rows.length) items.push({ key, severity, count: rows.length, examples: rows.slice(0, 3).map((r) => r.label), link }); };
      add("help", "critical", await one(`SELECT coalesce(u.display_name, u.email) || ': ' || replace(h.kind, '_', ' ') AS label FROM help_requests h JOIN users u ON u.id = h.driver_id WHERE h.status <> 'resolved' ORDER BY h.created_at`), "/inbox");
      add("unassigned", "warn", await one(`SELECT title AS label FROM jobs WHERE status = 'unassigned' AND (scheduled_date = $1 OR scheduled_date IS NULL) ORDER BY priority DESC, created_at`, [today]), "/dispatch");
      const late = await this.lateRows(c);
      add("late", "warn", late.filter((l) => l.level !== "low").map((l) => ({ label: `${l.name} (${l.driver ?? "-"})` })), "/ai?tab=late");
      add("approvals", "info", await one(`SELECT title AS label FROM approvals WHERE status = 'pending' ORDER BY created_at`), "/approvals");
      add("alerts", "warn", await one(`SELECT title AS label FROM alerts WHERE status = 'open' AND severity IN ('warn','critical') ORDER BY last_at DESC LIMIT 20`), "/alerts");
      add("documents", "warn", await one(`SELECT kind || ' (' || owner_kind || ') ' || expires_on::text AS label FROM documents WHERE expires_on IS NOT NULL AND expires_on <= $1::date + 14 ORDER BY expires_on`, [today]), "/fleet/documents");
      add("maintenance", "warn", await one(`SELECT v.name || ': ' || p.task AS label FROM maintenance_plans p JOIN vehicles v ON v.id = p.vehicle_id
        WHERE (p.every_days IS NOT NULL AND p.last_done_on IS NOT NULL AND p.last_done_on + p.every_days <= $1::date) OR (p.every_km IS NOT NULL AND p.last_done_km IS NOT NULL AND v.odometer_km >= p.last_done_km + p.every_km)`, [today]), "/fleet/maintenance-plans");
      add("unhappy", "info", await one(`SELECT coalesce(comment, 'rating ' || csat) AS label FROM feedback WHERE csat <= 2 AND created_at > now() - interval '2 days'`), "/analytics");
      add("overtime", "info", await one(`SELECT coalesce(u.display_name, u.email) AS label FROM shifts s JOIN users u ON u.id = s.driver_id WHERE s.overtime_status = 'pending'`), "/timesheets");
      const day = (await one(`SELECT (SELECT count(*) FROM routes WHERE route_date = $1 AND status <> 'cancelled')::int AS routes,
          (SELECT count(*) FROM stops s JOIN routes r ON r.id = s.route_id WHERE r.route_date = $1 AND r.status <> 'cancelled')::int AS stops,
          (SELECT count(*) FROM stops s JOIN routes r ON r.id = s.route_id WHERE r.route_date = $1 AND s.status = 'done')::int AS done`, [today]))[0];
      const rank = { critical: 0, warn: 1, info: 2 };
      items.sort((a, b) => rank[a.severity] - rank[b.severity]);
      return { date: today, day, items };
    });
  }

  private async lateRows(c: pg.PoolClient) {
    const rows = (await c.query(
      `SELECT s.id, s.name, s.eta, s.window_end AS "windowEnd", r.id AS "routeId", r.name AS route, coalesce(u.display_name, u.email) AS driver
       FROM stops s JOIN routes r ON r.id = s.route_id AND r.status = 'in_progress' LEFT JOIN users u ON u.id = r.driver_id
       WHERE s.status = 'pending' AND s.eta IS NOT NULL AND s.window_end IS NOT NULL ORDER BY s.window_end LIMIT 300`)).rows;
    const risks = lateRisk(rows.map((r) => ({ id: r.id, name: r.name, etaMs: new Date(r.eta).getTime(), windowEndMs: new Date(r.windowEnd).getTime() })), Date.now());
    const by = new Map(rows.map((r) => [r.id as string, r]));
    return risks.map((k) => ({ ...k, driver: by.get(k.id)!.driver as string | null, route: by.get(k.id)!.route as string, routeId: by.get(k.id)!.routeId as string, windowEnd: by.get(k.id)!.windowEnd as string }));
  }

  /** Stops that may miss their time window, riskiest first. */
  @Get("late")
  async late(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "routes.view");
    const rows = await withOrg(this.pool, orgId, (c) => this.lateRows(c));
    return { stops: rows.slice(0, 50), basis: "eta" };
  }

  /** Routes of a day with how late they ran, to pick one to explain. */
  @Get("explain/routes")
  async explainList(@Req() req: AuthedRequest, @Query("date") date?: string) {
    const orgId = requirePerm(req, "routes.view");
    return withOrg(this.pool, orgId, async (c) => {
      const day = date ? parseDate(date) : todayIn(await this.tz(c, orgId));
      const rows = (await c.query(
        `SELECT r.id, r.name, coalesce(u.display_name, u.email) AS driver,
                coalesce(max(extract(epoch FROM (s.arrived_at - s.window_end)) / 60) FILTER (WHERE s.arrived_at > s.window_end), 0)::int AS "lateMin"
         FROM routes r LEFT JOIN users u ON u.id = r.driver_id LEFT JOIN stops s ON s.route_id = r.id
         WHERE r.route_date = $1 AND r.status <> 'cancelled' GROUP BY r.id, u.display_name, u.email ORDER BY "lateMin" DESC, r.name`, [day])).rows;
      return { date: day, routes: rows };
    });
  }

  /** "Route 7 was late because ..." from what was recorded: start time, time at stops, failed stops, calls for help, idling. */
  @Get("explain")
  async explain(@Req() req: AuthedRequest, @Query("routeId") routeId?: string) {
    const orgId = requirePerm(req, "routes.view");
    const id = parseUuid(String(routeId));
    const e = await withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(
        `SELECT r.id, r.name, r.route_date::text AS date, r.vehicle_id, r.driver_id, r.start_time, r.started_at FROM routes r WHERE r.id = $1`, [id])).rows[0];
      if (!r) throw new NotFoundException();
      const tz = await this.tz(c, orgId);
      const stops = (await c.query(
        `SELECT name, window_end, arrived_at, departed_at, service_min, status, failure_reason FROM stops WHERE route_id = $1 ORDER BY sequence`, [id])).rows;
      const help = r.driver_id ? Number((await c.query("SELECT count(*) AS n FROM help_requests WHERE driver_id = $1 AND (created_at AT TIME ZONE $3)::date = $2::date", [r.driver_id, r.date, tz])).rows[0].n) : 0;
      const weather = Number((await c.query("SELECT count(*) AS n FROM alerts WHERE kind = 'weather' AND (first_at AT TIME ZONE $2)::date = $1::date", [r.date, tz])).rows[0].n);
      return { r, stops, help, weather };
    });
    const b = await this.svc.load(orgId, { from: e.r.date, to: e.r.date });
    const idleS = b.mv.filter((m) => m.vehicleId === e.r.vehicle_id).reduce((a, m) => a + m.idleS, 0);
    const ms = (d: unknown) => (d ? new Date(d as string).getTime() : null);
    const plannedStart = e.r.start_time ? await this.plannedStart(orgId, e.r.date, String(e.r.start_time)) : null;
    const x = explainDelays({
      plannedStart, startedAt: ms(e.r.started_at), helpRequests: e.help, weatherAlerts: e.weather, idleMin: idleS / 60,
      stops: e.stops.map((s) => ({ name: s.name, windowEnd: ms(s.window_end), arrivedAt: ms(s.arrived_at), departedAt: ms(s.departed_at), serviceMin: s.service_min, status: s.status, failureReason: s.failure_reason })),
    });
    return { route: { id: e.r.id, name: e.r.name, date: e.r.date }, ...x, trafficMeasured: false };
  }

  private async plannedStart(orgId: string, date: string, hhmm: string): Promise<number | null> {
    const { zonedToEpoch } = await import("../plan/time.js");
    const tz = await withOrg(this.pool, orgId, (c) => this.tz(c, orgId));
    try { return zonedToEpoch(date, hhmm.slice(0, 5), tz); } catch { return null; }
  }

  /** A health score for each vehicle from service, defects, fuel use, repairs, age and mileage. */
  @Get("breakdown")
  async breakdown(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "fleet.view");
    return withOrg(this.pool, orgId, async (c) => {
      const today = todayIn(await this.tz(c, orgId));
      const vs = (await c.query("SELECT id, name, year, odometer_km FROM vehicles WHERE status = 'active' ORDER BY name")).rows;
      const out = [];
      for (const v of vs) {
        const plan = (await c.query("SELECT every_km, every_days, last_done_km, last_done_on::text AS last_done_on FROM maintenance_plans WHERE vehicle_id = $1 ORDER BY last_done_on DESC NULLS LAST LIMIT 1", [v.id])).rows[0];
        const last = (await c.query("SELECT done_on::text AS d, odometer_km FROM maintenance_logs WHERE vehicle_id = $1 ORDER BY done_on DESC LIMIT 1", [v.id])).rows[0];
        const lastKm = plan?.last_done_km ?? last?.odometer_km ?? null, lastOn = plan?.last_done_on ?? last?.d ?? null;
        const stat = (await c.query(
          `SELECT (SELECT count(*) FROM inspections WHERE vehicle_id = $1 AND defects AND at > now() - interval '30 days')::int AS defects,
                  (SELECT count(*) FROM incidents WHERE vehicle_id = $1 AND occurred_at > now() - interval '90 days')::int AS inc,
                  (SELECT count(*) FROM maintenance_logs WHERE vehicle_id = $1 AND done_on > $2::date - 90)::int AS repairs,
                  (SELECT coalesce(sum(downtime_hours), 0) FROM maintenance_logs WHERE vehicle_id = $1 AND done_on > $2::date - 90)::float AS down`, [v.id, today])).rows[0];
        const econ = async (from: number, to: number) => {
          const r = (await c.query(
            `SELECT sum(litres)::float AS l, (max(odometer_km) - min(odometer_km))::float AS km, count(*)::int AS n FROM fuel_logs WHERE vehicle_id = $1 AND odometer_km IS NOT NULL AND filled_on BETWEEN $2::date - $3::int AND $2::date - $4::int`, [v.id, today, from, to])).rows[0];
          return r.n >= 3 && r.km > 100 ? (r.l / r.km) * 100 : null;
        };
        const health: VehicleHealth = {
          odometerKm: v.odometer_km, ageYears: v.year ? new Date(today).getFullYear() - v.year : null,
          kmSinceService: lastKm != null && v.odometer_km != null ? v.odometer_km - lastKm : null, serviceEveryKm: plan?.every_km ?? null,
          daysSinceService: lastOn ? Math.round((Date.parse(today) - Date.parse(lastOn)) / DAY) : null, serviceEveryDays: plan?.every_days ?? null,
          openDefects: stat.defects, incidents90: stat.inc, repairs90: stat.repairs, downtimeH90: stat.down, lPer100Now: await econ(30, 0), lPer100Base: await econ(120, 31),
        };
        out.push({ vehicleId: v.id, name: v.name, ...breakdownRisk(health) });
      }
      return { vehicles: out.sort((a, b) => b.score - a.score), basis: "points" };
    });
  }

  /** The best driver for a job, with the reasons. */
  @Post("suggest-driver")
  @HttpCode(200)
  async suggest(@Req() req: AuthedRequest, @Body() body: { jobId?: unknown; date?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const jobId = parseUuid(String(body?.jobId));
    return withOrg(this.pool, orgId, async (c) => {
      const job = (await c.query("SELECT id, lat, lng, skills, customer_name, scheduled_date::text AS date FROM jobs WHERE id = $1", [jobId])).rows[0];
      if (!job) throw new NotFoundException();
      if (job.lat == null) throw new BadRequestException("this job has no map position yet");
      const day = body?.date ? parseDate(body.date) : job.date ?? todayIn(await this.tz(c, orgId));
      const drivers = (await c.query(
        `SELECT u.id, coalesce(u.display_name, u.email) AS name, dp.skills, dp.preferences, dp.max_shift_min FROM users u LEFT JOIN driver_profiles dp ON dp.user_id = u.id
         WHERE u.role = 'driver' AND u.disabled_at IS NULL ORDER BY name`)).rows;
      const bundle = await this.svc.load(orgId, { from: todayIn("UTC", -30), to: day });
      const ctxs: DriverCtx[] = [];
      for (const d of drivers) {
        const pos = (await c.query(
          `SELECT lp.lat, lp.lng FROM routes r JOIN devices dv ON dv.vehicle_id = r.vehicle_id JOIN latest_positions lp ON lp.device_id = dv.id
           WHERE r.driver_id = $1 AND r.route_date = $2 AND lp.time > now() - interval '30 minutes' ORDER BY lp.time DESC LIMIT 1`, [d.id, day])).rows[0]
          ?? (await c.query(`SELECT lat, lng FROM stops s JOIN routes r ON r.id = s.route_id WHERE r.driver_id = $1 AND r.route_date = $2 AND s.status = 'pending' ORDER BY s.sequence DESC LIMIT 1`, [d.id, day])).rows[0]
          ?? (await c.query(`SELECT dep.lat, dep.lng FROM driver_profiles dp JOIN depots dep ON dep.id = dp.home_depot_id WHERE dp.user_id = $1`, [d.id])).rows[0];
        const n = Number((await c.query("SELECT count(*) AS n FROM stops s JOIN routes r ON r.id = s.route_id WHERE r.driver_id = $1 AND r.route_date = $2 AND r.status <> 'cancelled'", [d.id, day])).rows[0].n);
        const mine = bundle.stops.filter((s) => s.driverId === d.id && (s.status === "done" || s.status === "failed"));
        const done = mine.filter((s) => s.status === "done" && s.windowEnd && s.arrivedAt);
        const onTime = done.length >= 5 ? (done.filter((s) => new Date(s.arrivedAt!) <= new Date(s.windowEnd!)).length / done.length) * 100 : null;
        const fb = bundle.fb.filter((f) => f.driverId === d.id && f.csat != null);
        const here = job.customer_name ? mine.filter((s) => s.customer === job.customer_name) : [];
        const hereDone = here.filter((s) => s.status === "done" && s.windowEnd && s.arrivedAt);
        const prefs = (d.preferences ?? {}) as { avoidCustomers?: string[]; maxStops?: number; daysOff?: string[] };
        ctxs.push({
          id: d.id, name: d.name, skills: d.skills ?? [], lat: pos?.lat ?? null, lng: pos?.lng ?? null, stopsToday: n, maxStops: 25, onTimeRate: onTime == null ? null : Math.round(onTime),
          csat: fb.length >= 3 ? Math.round((fb.reduce((a, f) => a + f.csat!, 0) / fb.length) * 10) / 10 : null, visitsHere: here.length,
          onTimeHere: hereDone.length ? Math.round((hereDone.filter((s) => new Date(s.arrivedAt!) <= new Date(s.windowEnd!)).length / hereDone.length) * 100) : null,
          prefers: prefs, offToday: !!prefs.daysOff?.includes(day),
        });
      }
      return { jobId, date: day, suggestions: suggestDrivers({ lat: job.lat, lng: job.lng, skills: job.skills ?? [], customer: job.customer_name }, ctxs).slice(0, 8) };
    });
  }

  /** Real time at each customer, from what drivers did, next to the time planned. */
  @Get("learned/stop-times")
  async stopTimes(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "routes.view");
    const rows = (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT j.customer_name AS key, extract(epoch FROM (s.departed_at - s.arrived_at)) / 60 AS minutes, s.service_min AS planned
       FROM stops s JOIN jobs j ON j.id = s.job_id WHERE s.status = 'done' AND s.arrived_at IS NOT NULL AND s.departed_at IS NOT NULL AND j.customer_name IS NOT NULL
         AND s.departed_at > now() - interval '120 days' LIMIT 20000`))).rows;
    return { customers: learnDwell(rows.map((r) => ({ key: r.key, label: r.key, minutes: Number(r.minutes), planned: r.planned }))).slice(0, 200), minVisits: 3 };
  }

  /** Use a learned time for this customer's coming jobs and stops. */
  @Post("learned/stop-times/apply")
  @HttpCode(200)
  async applyStopTime(@Req() req: AuthedRequest, @Body() body: { customer?: unknown; minutes?: unknown }) {
    const orgId = requirePerm(req, "routes.write");
    const customer = String(body?.customer ?? "").trim();
    const minutes = Math.round(Number(body?.minutes));
    if (!customer || !(minutes >= 1 && minutes <= 240)) throw new BadRequestException("customer and minutes (1 to 240) are needed");
    return withOrg(this.pool, orgId, async (c) => {
      const j = await c.query("UPDATE jobs SET service_min = $2 WHERE customer_name = $1 AND status IN ('unassigned','assigned')", [customer, minutes]);
      const s = await c.query("UPDATE stops s SET service_min = $2 FROM jobs j WHERE j.id = s.job_id AND j.customer_name = $1 AND s.status = 'pending'", [customer, minutes]);
      return { jobs: j.rowCount, stops: s.rowCount };
    });
  }

  /** Real driving speeds by hour of day and by driver, from GPS history (moving fixes only). */
  @Get("learned/speeds")
  async speeds(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "routes.view");
    return withOrg(this.pool, orgId, async (c) => {
      const tz = await this.tz(c, orgId);
      const byHour = (await c.query(
        `SELECT extract(hour FROM time AT TIME ZONE $1)::int AS hour, avg(speed)::float AS "avgKmh", count(*)::int AS samples FROM positions
         WHERE time > now() - interval '30 days' AND speed > 5 AND speed < 160 GROUP BY 1 ORDER BY 1`, [tz])).rows;
      const byDriver = (await c.query(
        `SELECT r.driver_id AS "driverId", coalesce(u.display_name, u.email) AS name, avg(p.speed)::float AS "avgKmh", count(*)::int AS samples
         FROM positions p JOIN devices d ON d.id = p.device_id JOIN routes r ON r.vehicle_id = d.vehicle_id AND r.route_date = (p.time AT TIME ZONE $1)::date
         JOIN users u ON u.id = r.driver_id WHERE p.time > now() - interval '30 days' AND p.speed > 5 AND p.speed < 160 GROUP BY r.driver_id, u.display_name, u.email ORDER BY "avgKmh" DESC`, [tz])).rows;
      const best = Math.max(0, ...byHour.filter((h) => h.samples >= 20).map((h) => h.avgKmh));
      return {
        byHour: byHour.map((h) => ({ ...h, avgKmh: Math.round(h.avgKmh * 10) / 10, slowdown: best && h.samples >= 20 ? Math.round(Math.min(2, Math.max(1, best / h.avgKmh)) * 100) / 100 : null })),
        byDriver: byDriver.map((d) => ({ ...d, avgKmh: Math.round(d.avgKmh * 10) / 10 })), plannerUsesHourly: true,
      };
    });
  }

  /** Jobs expected over the coming days and the drivers they need. */
  @Get("forecast")
  async forecast(@Req() req: AuthedRequest, @Query("days") daysQ?: string) {
    const orgId = requirePerm(req, "reports.view");
    const days = Math.min(28, Math.max(1, Number(daysQ) || 14));
    return withOrg(this.pool, orgId, async (c) => {
      const tz = await this.tz(c, orgId);
      const today = todayIn(tz);
      const hist = (await c.query(
        `SELECT scheduled_date::text AS date, count(*)::int AS value FROM jobs WHERE scheduled_date BETWEEN $1::date - 120 AND $1::date - 1 AND status <> 'cancelled' GROUP BY 1 ORDER BY 1`, [today])).rows;
      const per = (await c.query(
        `SELECT count(*)::int AS n FROM stops s JOIN routes r ON r.id = s.route_id WHERE r.route_date BETWEEN $1::date - 30 AND $1::date - 1 AND r.driver_id IS NOT NULL AND r.status <> 'cancelled' GROUP BY r.id`, [today])).rows.map((r) => r.n as number);
      const stopsPerDriver = Math.max(1, Math.round(median(per) ?? 12));
      const drivers = Number((await c.query("SELECT count(*) AS n FROM users WHERE role = 'driver' AND disabled_at IS NULL")).rows[0].n);
      const planned = (await c.query("SELECT scheduled_date::text AS date, count(*)::int AS n FROM jobs WHERE scheduled_date >= $1::date AND status <> 'cancelled' GROUP BY 1", [today])).rows;
      const known = new Map(planned.map((p) => [p.date as string, p.n as number]));
      const f = demandForecast(hist, today, days, stopsPerDriver).map((d) => ({ ...d, booked: known.get(d.date) ?? 0, shortBy: Math.max(0, d.drivers - drivers) }));
      return { days: f, stopsPerDriver, drivers, historyDays: hist.length, enoughHistory: hist.length >= 14 };
    });
  }

  /** Tidy a messy address and look it up. */
  @Post("fix-address")
  @HttpCode(200)
  async fixAddress(@Req() req: AuthedRequest, @Body() body: { text?: unknown }) {
    const orgId = requirePerm(req, "routes.view");
    const raw = String(body?.text ?? "").slice(0, 300);
    if (raw.trim().length < 3) throw new BadRequestException("type an address");
    const n = normalizeAddress(raw);
    const check = checkAddress(n.text);
    const like = `%${n.text.split(",")[0]!.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const saved: GeoHit[] = (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT DISTINCT ON (label) label, lat, lng FROM (SELECT address AS label, lat, lng FROM jobs WHERE address ILIKE $1 AND lat IS NOT NULL UNION ALL SELECT address, lat, lng FROM stops WHERE address ILIKE $1 AND lat IS NOT NULL) x
       WHERE label IS NOT NULL ORDER BY label LIMIT 3`, [like]))).rows.map((r) => ({ ...r, source: "saved" as const }));
    let remote: GeoHit[] = [], geocoderError = false;
    if (this.geocoder) { try { remote = await this.geocoder.search(n.text, 3); } catch { geocoderError = true; } }
    return { original: raw, text: n.text, changes: n.changes, issues: check.issues, hits: [...saved, ...remote], geocoder: this.geocoder?.name ?? null, geocoderError };
  }

  /** Read a photo of a delivery note or receipt and fill in the fields. Needs an AI key. */
  @Post("read-document")
  @HttpCode(200)
  async readDocument(@Req() req: AuthedRequest, @Body() body: { image?: unknown; kind?: unknown }) {
    requireAny(req, "routes.write", "driver.app");
    const image = String(body?.image ?? "");
    const m = image.match(/^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/);
    if (!m || image.length > 7_000_000) throw new BadRequestException("send a JPEG, PNG or WebP photo under about 5 MB");
    if (!aiConfigured()) throw new ServiceUnavailableException("reading photos needs an AI key (ANTHROPIC_API_KEY)");
    const kind = body?.kind === "receipt" ? "receipt" : "delivery_note";
    const fields = kind === "receipt" ? "vendor, date (YYYY-MM-DD), total (number), tax (number), litres (number or null), kind (fuel, parking, toll, meal, repair or other)"
      : "customerName, phone, address, reference, title, items (number), weightKg (number or null), notes";
    const text = await aiAsk(this.notify.fetch, [{ type: "image", source: { type: "base64", media_type: m[1]!, data: m[2]! } }, { type: "text", text: `Read this ${kind.replace("_", " ")}. Reply with only a JSON object with these keys: ${fields}. Use null when something is not on the page.` }]);
    const parsed = extractJson(text);
    if (!parsed || typeof parsed !== "object") throw new BadRequestException("could not read that photo");
    return { kind, fields: parsed, review: true };
  }

  /** Read one sentence. Rules first; with an AI key, anything the rules cannot read is passed to the model, and its answer is checked the same way. */
  @Post("assistant")
  @HttpCode(200)
  async assistant(@Req() req: AuthedRequest, @Body() body: { text?: unknown }) {
    const orgId = requirePerm(req, "routes.view");
    const text = String(body?.text ?? "").trim();
    if (!text || text.length > 400) throw new BadRequestException("type a sentence of up to 400 characters");
    const { drivers, today } = await withOrg(this.pool, orgId, async (c) => ({
      drivers: (await c.query("SELECT id, coalesce(display_name, email) AS name FROM users WHERE role = 'driver' AND disabled_at IS NULL ORDER BY 2")).rows as { id: string; name: string }[],
      today: todayIn(await this.tz(c, orgId)),
    }));
    let intent = parseAssistant(text, { drivers, today });
    let source: "rules" | "ai" = "rules";
    if (intent.type === "unknown" && intent.reason === "no_match" && aiConfigured()) {
      try {
        const out = await aiAsk(this.notify.fetch, [{ type: "text", text: `Turn the request into one JSON object. Allowed shapes: {"type":"reassign","fromId":"<driver id>","toId":"<driver id>","date":"YYYY-MM-DD","notify":true|false} | {"type":"report","template":"<one of ${REPORT_TEMPLATES.map((t) => t.id).join(", ")}>","range":"yesterday|last7|last30|thisMonth|lastMonth","groupBy":null} | {"type":"briefing"} | {"type":"late"} | {"type":"forecast"} | {"type":"explain","routeHint":null} | {"type":"unknown","reason":"no_match"}. Drivers: ${JSON.stringify(drivers)}. Today: ${today}. Request: ${JSON.stringify(text)}. Reply with only the JSON.` }]);
        const j = extractJson(out) as AssistantIntent | null;
        if (j && this.validIntent(j, drivers)) { intent = j; source = "ai"; }
      } catch { /* the rules' answer stands */ }
    }
    return { text, source, intent, preview: await this.preview(orgId, intent, drivers) };
  }

  private validIntent(j: AssistantIntent, drivers: { id: string }[]): boolean {
    const ids = new Set(drivers.map((d) => d.id));
    switch (j.type) {
      case "reassign": return ids.has(j.fromId) && ids.has(j.toId) && j.fromId !== j.toId && /^\d{4}-\d{2}-\d{2}$/.test(j.date) && typeof j.notify === "boolean";
      case "report": return REPORT_TEMPLATES.some((t) => t.id === j.template) && ["yesterday", "last7", "last30", "thisMonth", "lastMonth"].includes(j.range);
      case "briefing": case "late": case "forecast": case "unknown": return true;
      case "explain": return true;
      default: return false;
    }
  }

  private async preview(orgId: string, intent: AssistantIntent, drivers: { id: string; name: string }[]) {
    if (intent.type === "reassign") {
      const name = (id: string) => drivers.find((d) => d.id === id)?.name ?? id;
      const rows = await withOrg(this.pool, orgId, async (c) => (await c.query(
        `SELECT s.id, s.name, s.job_id, j.customer_name, (j.customer_email IS NOT NULL OR j.customer_phone IS NOT NULL) AS reachable
         FROM stops s JOIN routes r ON r.id = s.route_id LEFT JOIN jobs j ON j.id = s.job_id
         WHERE r.driver_id = $1 AND r.route_date = $2 AND r.status IN ('planned','in_progress') AND s.status = 'pending' ORDER BY r.created_at, s.sequence`, [intent.fromId, intent.date])).rows);
      return { from: name(intent.fromId), to: name(intent.toId), date: intent.date, stops: rows.map((r) => r.name), count: rows.length, customers: intent.notify ? rows.filter((r) => r.reachable).length : 0 };
    }
    if (intent.type === "report") {
      const t = REPORT_TEMPLATES.find((x) => x.id === intent.template)!;
      return { spec: buildSpec(t.spec, intent) };
    }
    return null;
  }

  /** Do what was asked, after the person has seen the preview and agreed. */
  @Post("assistant/run")
  @HttpCode(200)
  async run(@Req() req: AuthedRequest, @Body() body: { intent?: AssistantIntent }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const intent = body?.intent;
    if (!intent || intent.type !== "reassign") throw new BadRequestException("only moving stops needs confirming");
    const drivers = (await withOrg(this.pool, orgId, (c) => c.query("SELECT id, coalesce(display_name, email) AS name FROM users WHERE role = 'driver' AND disabled_at IS NULL"))).rows as { id: string; name: string }[];
    if (!this.validIntent(intent, drivers)) throw new BadRequestException("that request is not valid");
    const toName = drivers.find((d) => d.id === intent.toId)!.name;
    return withOrg(this.pool, orgId, async (c) => {
      const stops = (await c.query(
        `SELECT s.id, s.route_id, s.job_id FROM stops s JOIN routes r ON r.id = s.route_id
         WHERE r.driver_id = $1 AND r.route_date = $2 AND r.status IN ('planned','in_progress') AND s.status = 'pending' ORDER BY r.created_at, s.sequence`, [intent.fromId, intent.date])).rows;
      if (stops.length === 0) return { moved: 0, notified: 0 };
      const target = await routeForDriver(c, orgId, intent.toId, intent.date, toName);
      const veh = (await c.query("SELECT vehicle_id FROM routes WHERE id = $1", [target])).rows[0]?.vehicle_id ?? null;
      const from = new Set<string>();
      let seq = Number((await c.query("SELECT coalesce(max(sequence), 0)::int AS m FROM stops WHERE route_id = $1", [target])).rows[0].m);
      for (const s of stops) {
        seq += 1; from.add(s.route_id);
        await c.query("UPDATE stops SET route_id = $2, sequence = $3 WHERE id = $1", [s.id, target, seq]);
        if (s.job_id) {
          await c.query("UPDATE jobs SET route_id = $2, driver_id = $3, vehicle_id = $4 WHERE id = $1", [s.job_id, target, intent.toId, veh]);
          await emit(c, orgId, "job.assigned", "job", s.job_id, { driverId: intent.toId, routeId: target, via: "assistant" });
        }
      }
      for (const r of from) { await resequence(c, r); if (!(await c.query("SELECT 1 FROM stops WHERE route_id = $1 LIMIT 1", [r])).rowCount) await c.query("DELETE FROM routes WHERE id = $1 AND status = 'planned'", [r]); }
      await resequence(c, target);
      let notified = 0;
      if (intent.notify) {
        for (const s of stops) {
          if (!s.job_id) continue;
          const sent = await notifyCustomer(c, { providers: this.notify, secret: this.secret }, orgId, s.job_id, "custom", { text: "{{org}}: your delivery now has a new driver. Track it here: {{link}}", repeat: `reassign:${intent.date}`, force: true });
          if (sent.some((x) => x.status === "sent")) notified += 1;
        }
      }
      return { moved: stops.length, notified, routeId: target };
    });
  }
}

/** A template's report with the period and grouping that were asked for. */
export function buildSpec(spec: import("../reports/datasets.js").ReportSpec, i: { range: string; groupBy: string | null }) {
  const out = JSON.parse(JSON.stringify(spec)) as typeof spec;
  out.range = { preset: i.range as "yesterday" | "last7" | "last30" | "thisMonth" | "lastMonth" };
  const ds: Record<string, string> = { driver: "scorecard.driver", vehicle: "scorecard.vehicle", day: "scorecard.day", customer: "scorecard.customer", route: "scorecard.route" };
  if (i.groupBy && ds[i.groupBy] && out.dataset.startsWith("scorecard.") && out.dataset !== ds[i.groupBy]) {
    const key = i.groupBy;
    out.dataset = ds[key]!;
    const keep = (out.columns ?? []).filter((c) => !["driver", "vehicle", "date", "customer", "route"].includes(c.key));
    out.columns = [{ key: key === "day" ? "date" : key }, ...keep];
    out.chart = out.chart ? { ...out.chart, x: key === "day" ? "date" : key } : out.chart;
    out.sort = null;
  }
  return out;
}
