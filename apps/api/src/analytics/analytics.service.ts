import { BadRequestException, HttpException, Inject, Injectable } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import {
  co2Kg, dailyTotals, detectSafetyEvents, driverScore, fuelEconomy, haversine, median, percentile, pct, round, routeAdherence, sum,
  type Fix, type SafetyEvent,
} from "@routenorth/shared";
import { withDefaults } from "../org/settings.js";
import { PG_POOL } from "../tokens.js";

export const GROUPS = ["driver", "vehicle", "route", "day", "depot", "customer"] as const;
export type Group = (typeof GROUPS)[number];

export interface Filters { driverId?: string | null; vehicleId?: string | null; depotId?: string | null }
export interface Range { from: string; to: string } // inclusive local dates, YYYY-MM-DD

/** Every number the dashboards and reports can show. `better` says which direction is good, for colours and rankings. */
export const METRICS: Record<string, { unit: "%" | "min" | "h" | "km" | "$" | "n" | "L" | "kg" | "score" | "L/100km" | "ratio"; better: "up" | "down" | null }> = {
  onTimeRate: { unit: "%", better: "up" }, firstAttemptRate: { unit: "%", better: "up" }, avgDelayMin: { unit: "min", better: "down" }, worstDelayMin: { unit: "min", better: "down" },
  missedWindows: { unit: "n", better: "down" }, failedStops: { unit: "n", better: "down" }, stops: { unit: "n", better: null }, stopsDone: { unit: "n", better: "up" }, skippedStops: { unit: "n", better: "down" },
  distanceKm: { unit: "km", better: null }, engineOnH: { unit: "h", better: null }, idleH: { unit: "h", better: "down" }, idleSharePct: { unit: "%", better: "down" },
  costTotal: { unit: "$", better: "down" }, costPerStop: { unit: "$", better: "down" }, costPerKm: { unit: "$", better: "down" }, costPerHour: { unit: "$", better: "down" },
  fuelCost: { unit: "$", better: "down" }, repairCost: { unit: "$", better: "down" }, downtimeH: { unit: "h", better: "down" },
  utilizationPct: { unit: "%", better: "up" }, loadFillPct: { unit: "%", better: "up" },
  plannedKm: { unit: "km", better: null }, actualKm: { unit: "km", better: null }, kmOverPlanPct: { unit: "%", better: "down" }, plannedMin: { unit: "min", better: null }, actualMin: { unit: "min", better: null },
  stopsPerHour: { unit: "ratio", better: "up" }, fuelLitres: { unit: "L", better: "down" }, lPer100: { unit: "L/100km", better: "down" }, co2Kg: { unit: "kg", better: "down" },
  csat: { unit: "score", better: "up" }, nps: { unit: "score", better: "up" }, feedbackCount: { unit: "n", better: null },
  routeAdherencePct: { unit: "%", better: "up" }, overtimeH: { unit: "h", better: "down" }, incidents: { unit: "n", better: "down" },
  speedingEvents: { unit: "n", better: "down" }, harshBrakes: { unit: "n", better: "down" }, harshAccels: { unit: "n", better: "down" }, driverScore: { unit: "score", better: "up" },
};
export type MetricKey = keyof typeof METRICS;
export type Metrics = Partial<Record<string, number | null>>;

export interface StopRow { routeId: string; driverId: string | null; vehicleId: string | null; depotId: string | null; date: string; status: string; reason: string | null; windowEnd: Date | null; arrivedAt: Date | null; departedAt: Date | null; serviceMin: number; customer: string | null; lat: number; lng: number; sequence: number; weightKg: number; jobId: string | null }
export interface RouteRow { id: string; name: string; date: string; driverId: string | null; vehicleId: string | null; depotId: string | null; plannedKm: number; plannedMin: number; actualMin: number | null; stops: StopRow[]; adherence: number | null; actualKm: number }
export interface Mv { deviceId: string | null; vehicleId: string | null; driverId: string | null; depotId: string | null; date: string; km: number; idleS: number; movingS: number; shiftH: number; routeIds: string[] }
export interface FuelRow { vehicleId: string; driverId: string | null; depotId: string | null; date: string; litres: number; cost: number; odometerKm: number | null; fuelType: string | null }
export interface MaintRow { vehicleId: string; depotId: string | null; date: string; cost: number; downtimeH: number }
export interface IncRow { vehicleId: string | null; driverId: string | null; depotId: string | null; date: string; kind: string; severity: string }
export interface FbRow { driverId: string | null; routeId: string | null; vehicleId: string | null; date: string; csat: number | null; nps: number | null }
interface SafeRow extends SafetyEvent { vehicleId: string | null; driverId: string | null; depotId: string | null; date: string; name: string }

export interface Bundle {
  range: Range; tz: string; costPerKm: number; costPerHour: number; overtimeAfterH: number;
  stops: StopRow[]; routes: RouteRow[]; mv: Mv[]; fuel: FuelRow[]; maint: MaintRow[]; inc: IncRow[]; fb: FbRow[]; safe: SafeRow[];
  vehicleDays: number; vehicleCount: number;
  names: { driver: Map<string, string>; vehicle: Map<string, string>; depot: Map<string, string>; route: Map<string, string> };
  vehicles: Map<string, { capacityKg: number | null; depotId: string | null; fuelType: string | null }>;
}

const ROAD_FACTOR = 1.3;
const AVG_KMH = 45;
const MAX_DAYS = 31;
const MAX_FIXES = 300_000;
const dayMs = 86_400_000;

export function checkRange(from: unknown, to: unknown, now = new Date()): Range {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  const t = (x: Date) => x.toISOString().slice(0, 10);
  const f = typeof from === "string" && from ? from : t(new Date(now.getTime() - 6 * dayMs));
  const u = typeof to === "string" && to ? to : t(now);
  if (!re.test(f) || !re.test(u) || Number.isNaN(Date.parse(f)) || Number.isNaN(Date.parse(u))) throw new BadRequestException("from and to must be dates like 2026-03-01");
  if (u < f) throw new BadRequestException("to must not be before from");
  if ((Date.parse(u) - Date.parse(f)) / dayMs + 1 > MAX_DAYS) throw new BadRequestException(`range cannot exceed ${MAX_DAYS} days`);
  return { from: f, to: u };
}

/** The numbers for one slice of the data (everything, or one driver, one route, one day...). */
export function computeMetrics(b: Bundle, s: { stops: StopRow[]; routes: RouteRow[]; mv: Mv[]; fuel: FuelRow[]; maint: MaintRow[]; inc: IncRow[]; fb: FbRow[]; safe: SafeRow[]; vehicleDays?: number }): Metrics {
  const finished = s.stops.filter((x) => ["done", "failed", "skipped"].includes(x.status));
  const done = s.stops.filter((x) => x.status === "done");
  const withWindow = s.stops.filter((x) => x.windowEnd && (x.arrivedAt || x.status === "failed" || x.status === "skipped"));
  const late = withWindow.filter((x) => x.arrivedAt && x.windowEnd && x.arrivedAt > x.windowEnd);
  const missed = withWindow.filter((x) => !x.arrivedAt || (x.windowEnd && x.arrivedAt > x.windowEnd));
  const delays = late.map((x) => (x.arrivedAt!.getTime() - x.windowEnd!.getTime()) / 60000);
  const onTime = done.filter((x) => !x.windowEnd || !x.arrivedAt || x.arrivedAt <= x.windowEnd);
  const failed = s.stops.filter((x) => x.status === "failed");
  const km = sum(s.mv.map((m) => m.km));
  const engineS = sum(s.mv.map((m) => m.idleS + m.movingS));
  const idleS = sum(s.mv.map((m) => m.idleS));
  const costTotal = km * b.costPerKm + (engineS / 3600) * b.costPerHour;
  const fuelByVehicle = new Map<string, FuelRow[]>();
  for (const f of s.fuel) (fuelByVehicle.get(f.vehicleId) ?? fuelByVehicle.set(f.vehicleId, []).get(f.vehicleId)!).push(f);
  let usedL = 0, econKm = 0;
  for (const fills of fuelByVehicle.values()) {
    const e = fuelEconomy(fills.sort((x, y) => x.date.localeCompare(y.date)).map((x) => ({ litres: x.litres, cost: x.cost, odometerKm: x.odometerKm })));
    if (e.lPer100 != null && e.km > 0) { usedL += (e.lPer100 * e.km) / 100; econKm += e.km; }
  }
  const litres = sum(s.fuel.map((f) => f.litres));
  const adh = s.routes.map((r) => r.adherence).filter((x): x is number => x != null);
  const planned = s.routes.filter((r) => r.plannedKm > 0);
  const plannedKm = sum(planned.map((r) => r.plannedKm));
  const actualKmPlanned = sum(planned.map((r) => r.actualKm));
  const timed = s.routes.filter((r) => r.actualMin != null);
  const caps = s.routes.map((r) => {
    const cap = b.vehicles.get(r.vehicleId ?? "")?.capacityKg;
    return cap ? Math.min(150, (sum(r.stops.map((x) => x.weightKg)) / cap) * 100) : null;
  }).filter((x): x is number => x != null);
  const csat = s.fb.map((f) => f.csat).filter((x): x is number => x != null);
  const nps = s.fb.map((f) => f.nps).filter((x): x is number => x != null);
  const sp = s.safe.filter((e) => e.kind === "speeding").length, hb = s.safe.filter((e) => e.kind === "harsh_brake").length, ha = s.safe.filter((e) => e.kind === "harsh_accel").length;
  const dayCount = s.vehicleDays ?? 0;
  return {
    stops: s.stops.length, stopsDone: done.length, failedStops: failed.length, skippedStops: s.stops.filter((x) => x.status === "skipped").length,
    onTimeRate: pct(onTime.length, done.length),
    firstAttemptRate: pct(done.length, finished.length),
    avgDelayMin: delays.length ? round(sum(delays) / delays.length) : withWindow.length ? 0 : null,
    worstDelayMin: delays.length ? round(Math.max(...delays)) : withWindow.length ? 0 : null,
    missedWindows: withWindow.length ? missed.length : null,
    distanceKm: round(km), engineOnH: round(engineS / 3600), idleH: round(idleS / 3600), idleSharePct: pct(idleS, engineS),
    costTotal: round(costTotal, 2), costPerStop: done.length ? round(costTotal / done.length, 2) : null, costPerKm: km > 0 ? round(costTotal / km, 2) : null, costPerHour: engineS > 0 ? round(costTotal / (engineS / 3600), 2) : null,
    fuelCost: round(sum(s.fuel.map((f) => f.cost)), 2), repairCost: round(sum(s.maint.map((m) => m.cost)), 2), downtimeH: round(sum(s.maint.map((m) => m.downtimeH))),
    utilizationPct: dayCount > 0 ? pct(new Set(s.mv.filter((m) => m.routeIds.length > 0).map((m) => `${m.vehicleId}|${m.date}`)).size, dayCount) : null,
    loadFillPct: caps.length ? round(sum(caps) / caps.length) : null,
    plannedKm: round(plannedKm), actualKm: round(actualKmPlanned), kmOverPlanPct: plannedKm > 0 ? round(((actualKmPlanned - plannedKm) / plannedKm) * 100) : null,
    plannedMin: timed.length ? round(sum(timed.map((r) => r.plannedMin)), 0) : null, actualMin: timed.length ? round(sum(timed.map((r) => r.actualMin!)), 0) : null,
    stopsPerHour: engineS > 0 && done.length ? round(done.length / (engineS / 3600)) : null,
    fuelLitres: round(litres), lPer100: econKm > 0 ? round((usedL / econKm) * 100) : null, co2Kg: round(sum(s.fuel.map((f) => co2Kg(f.litres, f.fuelType))), 0),
    csat: csat.length ? round(sum(csat) / csat.length, 2) : null,
    nps: nps.length ? Math.round(((nps.filter((n) => n >= 9).length - nps.filter((n) => n <= 6).length) / nps.length) * 100) : null, feedbackCount: s.fb.length,
    routeAdherencePct: adh.length ? round(sum(adh) / adh.length) : null,
    overtimeH: round(sum(s.mv.map((m) => Math.max(0, m.shiftH - b.overtimeAfterH)))),
    incidents: s.inc.length, speedingEvents: sp, harshBrakes: hb, harshAccels: ha, driverScore: driverScore(km, { speeding: sp, harshBrake: hb, harshAccel: ha, incidents: s.inc.length }),
  };
}

const keyOf: Record<Group, { stop: (x: StopRow) => string | null; route: (x: RouteRow) => string | null; mv: (x: Mv) => string | null; fuel: (x: FuelRow) => string | null; maint: (x: MaintRow) => string | null; inc: (x: IncRow) => string | null; fb: (x: FbRow) => string | null; safe: (x: SafeRow) => string | null }> = {
  driver: { stop: (x) => x.driverId, route: (x) => x.driverId, mv: (x) => x.driverId, fuel: (x) => x.driverId, maint: () => null, inc: (x) => x.driverId, fb: (x) => x.driverId, safe: (x) => x.driverId },
  vehicle: { stop: (x) => x.vehicleId, route: (x) => x.vehicleId, mv: (x) => x.vehicleId, fuel: (x) => x.vehicleId, maint: (x) => x.vehicleId, inc: (x) => x.vehicleId, fb: (x) => x.vehicleId, safe: (x) => x.vehicleId },
  route: { stop: (x) => x.routeId, route: (x) => x.id, mv: () => null, fuel: () => null, maint: () => null, inc: () => null, fb: (x) => x.routeId, safe: () => null },
  day: { stop: (x) => x.date, route: (x) => x.date, mv: (x) => x.date, fuel: (x) => x.date, maint: (x) => x.date, inc: (x) => x.date, fb: (x) => x.date, safe: (x) => x.date },
  depot: { stop: (x) => x.depotId, route: (x) => x.depotId, mv: (x) => x.depotId, fuel: (x) => x.depotId, maint: (x) => x.depotId, inc: (x) => x.depotId, fb: () => null, safe: (x) => x.depotId },
  customer: { stop: (x) => x.customer, route: () => null, mv: () => null, fuel: () => null, maint: () => null, inc: () => null, fb: () => null, safe: () => null },
};

/** Metrics for every group (every driver, every day...). Distance for a route is shared out of its vehicle's day. */
export interface BreakdownRow { key: string; name: string; metrics: Metrics }
export function breakdown(b: Bundle, by: Group): BreakdownRow[] {
  const k = keyOf[by];
  const slices = new Map<string, Parameters<typeof computeMetrics>[1]>();
  const at = (key: string | null) => {
    if (key == null) return null;
    let s = slices.get(key);
    if (!s) { s = { stops: [], routes: [], mv: [], fuel: [], maint: [], inc: [], fb: [], safe: [], vehicleDays: 0 }; slices.set(key, s); }
    return s;
  };
  for (const x of b.stops) at(k.stop(x))?.stops.push(x);
  for (const x of b.routes) at(k.route(x))?.routes.push(x);
  if (by === "route") {
    for (const r of b.routes) {
      const s = at(r.id)!;
      s.mv.push({ deviceId: null, vehicleId: r.vehicleId, driverId: r.driverId, depotId: r.depotId, date: r.date, km: r.actualKm, idleS: 0, movingS: 0, shiftH: 0, routeIds: [r.id] });
    }
  } else for (const x of b.mv) at(k.mv(x))?.mv.push(x);
  for (const x of b.fuel) at(k.fuel(x))?.fuel.push(x);
  for (const x of b.maint) at(k.maint(x))?.maint.push(x);
  for (const x of b.inc) at(k.inc(x))?.inc.push(x);
  for (const x of b.fb) at(k.fb(x))?.fb.push(x);
  for (const x of b.safe) at(k.safe(x))?.safe.push(x);
  const nameOf = (key: string) => (by === "day" || by === "customer" ? key : (by === "driver" ? b.names.driver : by === "vehicle" ? b.names.vehicle : by === "depot" ? b.names.depot : b.names.route).get(key) ?? key.slice(0, 8));
  const days = Math.round((Date.parse(b.range.to) - Date.parse(b.range.from)) / dayMs) + 1;
  return [...slices.entries()]
    .map(([key, s]) => {
      s.vehicleDays = by === "vehicle" ? days : by === "day" ? b.vehicleCount : undefined;
      return { key, name: nameOf(key), metrics: computeMetrics(b, s) };
    })
    .sort((x, y) => (by === "day" ? x.key.localeCompare(y.key) : x.name.localeCompare(y.name)));
}

export function summarize(b: Bundle): Metrics {
  return computeMetrics(b, { stops: b.stops, routes: b.routes, mv: b.mv, fuel: b.fuel, maint: b.maint, inc: b.inc, fb: b.fb, safe: b.safe, vehicleDays: b.vehicleDays });
}

export function failureReasons(b: Bundle): { reason: string; count: number }[] {
  const m = new Map<string, number>();
  for (const s of b.stops) if (s.status === "failed" || s.status === "skipped") m.set(s.reason?.trim() || "—", (m.get(s.reason?.trim() || "—") ?? 0) + 1);
  return [...m.entries()].map(([reason, count]) => ({ reason, count })).sort((a, c) => c.count - a.count);
}

@Injectable()
export class AnalyticsService {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async load(orgId: string, range: Range, f: Filters = {}): Promise<Bundle> {
    return withOrg(this.pool, orgId, async (c) => {
      const org = (await c.query<{ timezone: string; settings: unknown }>("SELECT timezone, settings FROM organizations WHERE id = $1", [orgId])).rows[0]!;
      const st = withDefaults(org.settings);
      const vehicles = (await c.query<{ id: string; name: string; depot_id: string | null; capacity_kg: number | null; fuel_type: string | null; status: string }>("SELECT id, name, depot_id, capacity_kg, fuel_type, status FROM vehicles")).rows;
      const vmap = new Map(vehicles.map((v) => [v.id, { capacityKg: v.capacity_kg, depotId: v.depot_id, fuelType: v.fuel_type }]));
      const names = {
        driver: new Map((await c.query<{ id: string; n: string }>("SELECT id, coalesce(display_name, email) AS n FROM users WHERE role = 'driver'")).rows.map((r) => [r.id, r.n])),
        vehicle: new Map(vehicles.map((v) => [v.id, v.name])),
        depot: new Map((await c.query<{ id: string; name: string }>("SELECT id, name FROM depots")).rows.map((r) => [r.id, r.name])),
        route: new Map<string, string>(),
      };
      const depotLoc = new Map((await c.query<{ id: string; lat: number; lng: number }>("SELECT id, lat, lng FROM depots")).rows.map((d) => [d.id, d]));
      const params = [range.from, range.to, f.driverId ?? null, f.vehicleId ?? null, f.depotId ?? null];
      const rows = (await c.query(
        `SELECT s.route_id AS "routeId", r.name AS "routeName", r.driver_id AS "driverId", r.vehicle_id AS "vehicleId", coalesce(r.depot_id, v.depot_id) AS "depotId", r.route_date::text AS date,
                s.status, s.failure_reason AS reason, s.window_end AS "windowEnd", s.arrived_at AS "arrivedAt", s.departed_at AS "departedAt", s.service_min AS "serviceMin",
                j.customer_name AS customer, s.lat, s.lng, s.sequence, s.weight_kg AS "weightKg", s.job_id AS "jobId"
         FROM stops s JOIN routes r ON r.id = s.route_id LEFT JOIN vehicles v ON v.id = r.vehicle_id LEFT JOIN jobs j ON j.id = s.job_id
         WHERE r.route_date BETWEEN $1::date AND $2::date AND r.status <> 'cancelled'
           AND ($3::uuid IS NULL OR r.driver_id = $3) AND ($4::uuid IS NULL OR r.vehicle_id = $4) AND ($5::uuid IS NULL OR coalesce(r.depot_id, v.depot_id) = $5)
         ORDER BY r.route_date, s.route_id, s.sequence`, params)).rows;
      const stops: StopRow[] = rows.map((r) => { names.route.set(r.routeId, r.routeName); return r; });
      // Routes with no stops still count for utilization, so list them too.
      const routeMeta = (await c.query<{ id: string; name: string; date: string; driver_id: string | null; vehicle_id: string | null; depot_id: string | null }>(
        `SELECT r.id, r.name, r.route_date::text AS date, r.driver_id, r.vehicle_id, coalesce(r.depot_id, v.depot_id) AS depot_id FROM routes r LEFT JOIN vehicles v ON v.id = r.vehicle_id
         WHERE r.route_date BETWEEN $1::date AND $2::date AND r.status <> 'cancelled'
           AND ($3::uuid IS NULL OR r.driver_id = $3) AND ($4::uuid IS NULL OR r.vehicle_id = $4) AND ($5::uuid IS NULL OR coalesce(r.depot_id, v.depot_id) = $5)`, params)).rows;
      const stopsByRoute = new Map<string, StopRow[]>();
      for (const s of stops) (stopsByRoute.get(s.routeId) ?? stopsByRoute.set(s.routeId, []).get(s.routeId)!).push(s);

      // Movement: distance, idling and shift length per vehicle per day, from the GPS positions.
      const vehicleIds = new Set(routeMeta.map((r) => r.vehicle_id).filter((x): x is string => !!x));
      const restrict = f.driverId || f.depotId;
      const fixesRes = await c.query<{ device_id: string; vehicle_id: string | null; time: Date; lat: number; lng: number; speed: number; ignition: boolean | null; odometer: number | null }>(
        `SELECT p.device_id, d.vehicle_id, p.time, p.lat, p.lng, p.speed, p.ignition, p.odometer FROM positions p JOIN devices d ON d.id = p.device_id
         WHERE p.time >= ($1::date)::timestamp AT TIME ZONE $3 AND p.time < (($2::date) + 1)::timestamp AT TIME ZONE $3
           AND ($4::uuid IS NULL OR d.vehicle_id = $4) AND ($5::uuid[] IS NULL OR d.vehicle_id = ANY($5))
         ORDER BY p.device_id, p.time LIMIT ${MAX_FIXES + 1}`, [range.from, range.to, org.timezone, f.vehicleId ?? null, restrict ? [...vehicleIds] : null]);
      if (fixesRes.rows.length > MAX_FIXES) throw new HttpException("too much position data in this range; choose a shorter range or a filter", 413);
      const driverOn = new Map<string, string | null>(); // vehicle|date -> driver
      const routesOn = new Map<string, string[]>();
      for (const r of routeMeta) {
        const key = `${r.vehicle_id}|${r.date}`;
        if (!driverOn.has(key) || !driverOn.get(key)) driverOn.set(key, r.driver_id);
        (routesOn.get(key) ?? routesOn.set(key, []).get(key)!).push(r.id);
      }
      const dateFmt = new Intl.DateTimeFormat("en-CA", { timeZone: org.timezone, year: "numeric", month: "2-digit", day: "2-digit" });
      const byDevice = new Map<string, { vehicleId: string | null; fixes: Fix[]; raw: typeof fixesRes.rows }>();
      for (const r of fixesRes.rows) {
        const e = byDevice.get(r.device_id) ?? { vehicleId: r.vehicle_id, fixes: [], raw: [] };
        e.fixes.push({ time: r.time.toISOString(), lat: r.lat, lng: r.lng, speed: r.speed, ignition: r.ignition, odometer: r.odometer });
        e.raw.push(r);
        byDevice.set(r.device_id, e);
      }
      const mv: Mv[] = [];
      const safe: SafeRow[] = [];
      const kmByVehicleDay = new Map<string, number>();
      const fixesByVehicleDay = new Map<string, { lat: number; lng: number; t: number; speed: number }[]>();
      for (const [devId, e] of byDevice) {
        const vId = e.vehicleId;
        const perDay = new Map<string, { first: number; last: number }>();
        for (const x of e.fixes) {
          const day = dateFmt.format(new Date(x.time));
          const t = Date.parse(x.time);
          const p = perDay.get(day) ?? { first: t, last: t };
          if (x.speed > 3 || x.ignition) { p.first = Math.min(p.first, t); p.last = Math.max(p.last, t); }
          perDay.set(day, p);
          const key = `${vId}|${day}`;
          (fixesByVehicleDay.get(key) ?? fixesByVehicleDay.set(key, []).get(key)!).push({ lat: x.lat, lng: x.lng, t, speed: x.speed });
        }
        for (const d of dailyTotals(e.fixes, org.timezone)) {
          const key = `${vId}|${d.date}`;
          const span = perDay.get(d.date);
          kmByVehicleDay.set(key, (kmByVehicleDay.get(key) ?? 0) + d.distanceM / 1000);
          mv.push({
            deviceId: devId, vehicleId: vId, driverId: driverOn.get(key) ?? null, depotId: (vId ? vmap.get(vId)?.depotId : null) ?? null, date: d.date, km: d.distanceM / 1000,
            idleS: d.idleS, movingS: d.movingS, shiftH: span ? (span.last - span.first) / 3_600_000 : 0, routeIds: routesOn.get(key) ?? [],
          });
        }
        for (const ev of detectSafetyEvents(e.fixes, { speedLimitKmh: st.speedLimitKmh })) {
          const day = dateFmt.format(new Date(ev.time));
          safe.push({ ...ev, vehicleId: vId, driverId: driverOn.get(`${vId}|${day}`) ?? null, depotId: (vId ? vmap.get(vId)?.depotId : null) ?? null, date: day, name: vId ? names.vehicle.get(vId) ?? "" : "" });
        }
      }

      // Routes: planned against actual.
      const routes: RouteRow[] = routeMeta.map((r) => {
        const rs = stopsByRoute.get(r.id) ?? [];
        const depot = r.depot_id ? depotLoc.get(r.depot_id) : null;
        const pts = [...(depot ? [{ lat: depot.lat, lng: depot.lng }] : []), ...rs.map((s) => ({ lat: s.lat, lng: s.lng }))];
        let km = 0;
        for (let i = 1; i < pts.length; i++) km += (haversine(pts[i - 1]!.lat, pts[i - 1]!.lng, pts[i]!.lat, pts[i]!.lng) / 1000) * ROAD_FACTOR;
        const arrived = rs.map((s) => s.arrivedAt?.getTime()).filter((x): x is number => x != null);
        const left = rs.map((s) => (s.departedAt ?? s.arrivedAt)?.getTime()).filter((x): x is number => x != null);
        const actualMin = arrived.length >= 2 ? (Math.max(...left) - Math.min(...arrived)) / 60000 : null;
        const plannedMin = sum(rs.map((s) => s.serviceMin)) + (km / AVG_KMH) * 60;
        const dayFixes = fixesByVehicleDay.get(`${r.vehicle_id}|${r.date}`) ?? [];
        const lo = arrived.length ? Math.min(...arrived) - 30 * 60000 : null, hi = left.length ? Math.max(...left) + 10 * 60000 : null;
        const during = lo != null && hi != null ? dayFixes.filter((x) => x.t >= lo && x.t <= hi) : [];
        return { id: r.id, name: r.name, date: r.date, driverId: r.driver_id, vehicleId: r.vehicle_id, depotId: r.depot_id, plannedKm: km, plannedMin, actualMin, stops: rs, adherence: routeAdherence(during, pts), actualKm: 0 };
      });
      // Share each vehicle-day's real distance between that day's routes, in proportion to their planned distance.
      const routesByVD = new Map<string, RouteRow[]>();
      for (const r of routes) (routesByVD.get(`${r.vehicleId}|${r.date}`) ?? routesByVD.set(`${r.vehicleId}|${r.date}`, []).get(`${r.vehicleId}|${r.date}`)!).push(r);
      for (const [key, rs] of routesByVD) {
        const total = kmByVehicleDay.get(key) ?? 0, plan = sum(rs.map((r) => r.plannedKm));
        for (const r of rs) r.actualKm = plan > 0 ? (total * r.plannedKm) / plan : total / rs.length;
      }

      const fuel = (await c.query(
        `SELECT l.vehicle_id AS "vehicleId", l.driver_id AS "driverId", v.depot_id AS "depotId", l.filled_on::text AS date, l.litres, coalesce(l.cost, 0) AS cost, l.odometer_km AS "odometerKm", v.fuel_type AS "fuelType"
         FROM fuel_logs l JOIN vehicles v ON v.id = l.vehicle_id WHERE l.filled_on BETWEEN $1::date AND $2::date
           AND ($3::uuid IS NULL OR l.driver_id = $3) AND ($4::uuid IS NULL OR l.vehicle_id = $4) AND ($5::uuid IS NULL OR v.depot_id = $5) ORDER BY l.filled_on, l.created_at`, params)).rows as FuelRow[];
      const maint = (await c.query(
        `SELECT m.vehicle_id AS "vehicleId", v.depot_id AS "depotId", m.done_on::text AS date, coalesce(m.cost, 0) AS cost, coalesce(m.downtime_hours, 0) AS "downtimeH"
         FROM maintenance_logs m JOIN vehicles v ON v.id = m.vehicle_id WHERE m.done_on BETWEEN $1::date AND $2::date
           AND ($4::uuid IS NULL OR m.vehicle_id = $4) AND ($5::uuid IS NULL OR v.depot_id = $5) AND $3::uuid IS NULL`, params)).rows.map((m) => ({ ...m, cost: Number(m.cost), downtimeH: Number(m.downtimeH) })) as MaintRow[];
      const inc = (await c.query(
        `SELECT i.vehicle_id AS "vehicleId", i.driver_id AS "driverId", v.depot_id AS "depotId", (i.occurred_at AT TIME ZONE $6)::date::text AS date, i.kind, i.severity
         FROM incidents i LEFT JOIN vehicles v ON v.id = i.vehicle_id WHERE (i.occurred_at AT TIME ZONE $6)::date BETWEEN $1::date AND $2::date
           AND ($3::uuid IS NULL OR i.driver_id = $3) AND ($4::uuid IS NULL OR i.vehicle_id = $4) AND ($5::uuid IS NULL OR v.depot_id = $5)`, [...params, org.timezone])).rows as IncRow[];
      const fb = (await c.query(
        `SELECT f.driver_id AS "driverId", f.route_id AS "routeId", r.vehicle_id AS "vehicleId", (f.created_at AT TIME ZONE $5)::date::text AS date, f.csat, f.nps
         FROM feedback f LEFT JOIN routes r ON r.id = f.route_id WHERE (f.created_at AT TIME ZONE $5)::date BETWEEN $1::date AND $2::date
           AND ($3::uuid IS NULL OR f.driver_id = $3) AND ($4::uuid IS NULL OR r.vehicle_id = $4)`, [range.from, range.to, f.driverId ?? null, f.vehicleId ?? null, org.timezone])).rows as FbRow[];

      const days = Math.round((Date.parse(range.to) - Date.parse(range.from)) / dayMs) + 1;
      const active = f.vehicleId ? 1 : vehicles.filter((v) => v.status === "active" && (!f.depotId || v.depot_id === f.depotId)).length;
      return {
        range, tz: org.timezone, costPerKm: st.costPerKm, costPerHour: st.costPerHour, overtimeAfterH: st.overtimeAfterH, stops, routes, mv, fuel, maint, inc, fb, safe,
        vehicleDays: active * days, vehicleCount: active, names, vehicles: vmap,
      };
    });
  }

  /** Same numbers as the dashboards, for any period: the engine behind every card, report and answer. */
  async summary(orgId: string, range: Range, f: Filters = {}) { return summarize(await this.load(orgId, range, f)); }
}

export { median, percentile };
