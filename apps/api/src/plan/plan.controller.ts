import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import {
  comparePlans, DEFAULT_TRAFFIC, evaluateOrder, learnTrafficProfile, liveEtas, makeTravel, matrixTravel, planCost, planFleet, planRoute, whatIfAdd,
  type LatLng, type Objective, type PlanStop, type PlanVehicle, type RoutePlan, type TravelFn,
} from "@routenorth/shared";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { parseUuid } from "../history/range.js";
import { parseDate, parseStopInput } from "../routes/validate.js";
import { withDefaults } from "../org/settings.js";
import { PG_POOL, ROUTING_PROVIDER } from "../tokens.js";
import { hourIn, zonedToEpoch } from "./time.js";
import type { RoutingProvider } from "./providers.js";

const AVOIDS = ["tolls", "highways", "ferries", "unpaved"];
const KIND_SPEED: Record<string, number> = { truck: 50, bus: 45, van: 50, car: 55 };
const MAX_STOPS = 300;

interface PlanRequest {
  date: string;
  vehicleId: string | null;
  driverId: string | null;
  depotId: string | null;
  start: LatLng | null;
  startTime: string;
  objective: Objective;
  avoid: string[];
  stops: PlanStop[];
  /** Keep the order given instead of reordering (to price a plan someone made by hand). */
  fixedOrder: boolean;
}

function point(v: unknown, field: string): LatLng | null {
  if (v == null) return null;
  const o = v as { lat?: unknown; lng?: unknown };
  const lat = Number(o.lat), lng = Number(o.lng);
  if (!(lat >= -90 && lat <= 90) || !(lng >= -180 && lng <= 180)) throw new BadRequestException(`${field} needs a valid lat and lng`);
  return { lat, lng };
}

/** Parse the stops in a planning request into optimizer input. */
export function parsePlanStops(raw: unknown): PlanStop[] {
  if (!Array.isArray(raw)) throw new BadRequestException("stops must be a list");
  if (raw.length > MAX_STOPS) throw new BadRequestException(`at most ${MAX_STOPS} stops can be planned at once`);
  const ids = new Set<string>();
  return raw.map((r, i) => {
    let s;
    try { s = parseStopInput(r); } catch (e) { throw new BadRequestException(`stop ${i + 1}: ${(e as Error).message}`); }
    const o = r as Record<string, unknown>;
    const id = typeof o.id === "string" && o.id ? o.id.slice(0, 80) : `s${i}`;
    if (ids.has(id)) throw new BadRequestException(`stop ${i + 1}: duplicate id`);
    ids.add(id);
    const skills = Array.isArray(o.skills) ? o.skills.map(String).slice(0, 20) : undefined;
    return {
      id, lat: s.lat, lng: s.lng, serviceMin: s.serviceMin, weightKg: s.weightKg, volumeM3: s.volumeM3, items: Number(o.items) > 0 ? Number(o.items) : s.packages,
      priority: s.priority, kind: s.kind, pairId: typeof o.pairId === "string" ? o.pairId : undefined, skills, territory: typeof o.territory === "string" ? o.territory : undefined,
      windowStart: s.windowStart ? Date.parse(s.windowStart) : null, windowEnd: s.windowEnd ? Date.parse(s.windowEnd) : null,
    };
  });
}

export function parsePlanRequest(raw: unknown, needStops = true): PlanRequest {
  const o = (raw ?? {}) as Record<string, unknown>;
  const avoid = o.avoid === undefined ? [] : o.avoid;
  if (!Array.isArray(avoid) || avoid.some((x) => !AVOIDS.includes(String(x)))) throw new BadRequestException(`avoid must list: ${AVOIDS.join(", ")}`);
  if (o.objective !== undefined && o.objective !== "time" && o.objective !== "distance") throw new BadRequestException("objective must be time or distance");
  const startTime = o.startTime === undefined ? "08:00" : String(o.startTime);
  if (!/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(startTime)) throw new BadRequestException("startTime must be HH:MM");
  const stops = needStops ? parsePlanStops(o.stops ?? []) : [];
  if (needStops && stops.length === 0) throw new BadRequestException("add at least one stop");
  return {
    date: parseDate(o.date), vehicleId: o.vehicleId ? parseUuid(String(o.vehicleId)) : null, driverId: o.driverId ? parseUuid(String(o.driverId)) : null,
    depotId: o.depotId ? parseUuid(String(o.depotId)) : null, start: point(o.start, "start"), startTime,
    objective: (o.objective as Objective) ?? "time", avoid: [...new Set(avoid.map(String))], stops, fixedOrder: o.fixedOrder === true,
  };
}

interface Context {
  tz: string;
  rates: { perKm: number; perHour: number };
  traffic: readonly number[];
  trafficLearned: boolean;
  vehicle: PlanVehicle;
  source: string;
  travel: TravelFn;
}

@Controller("plan")
@UseGuards(AuthGuard)
export class PlanController {
  private readonly trafficCache = new Map<string, { at: number; profile: number[]; learned: boolean }>();

  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(ROUTING_PROVIDER) private readonly provider: RoutingProvider | null,
  ) {}

  /** How much slower traffic is by hour of day, learned from this organization's own vehicles (falls back to typical city traffic). */
  private async trafficFor(c: pg.PoolClient, orgId: string, tz: string): Promise<{ profile: number[]; learned: boolean }> {
    const hit = this.trafficCache.get(orgId);
    if (hit && Date.now() - hit.at < 3_600_000) return hit;
    const rows = (await c.query<{ time: Date; speed: number }>(
      "SELECT time, speed FROM positions WHERE time > now() - interval '14 days' AND speed > 5 LIMIT 200000",
    )).rows;
    const profile = learnTrafficProfile(rows.map((r) => ({ time: r.time.toISOString(), speed: r.speed })), hourIn(tz));
    const learned = profile.some((x, h) => x !== DEFAULT_TRAFFIC[h]);
    const entry = { at: Date.now(), profile, learned };
    this.trafficCache.set(orgId, entry);
    return entry;
  }

  /** Vehicle limits, driver shift rules, depot, traffic and travel model for one plan. */
  private async context(c: pg.PoolClient, orgId: string, r: PlanRequest, extraPoints: LatLng[] = []): Promise<Context> {
    const org = (await c.query<{ timezone: string; settings: unknown }>("SELECT timezone, settings FROM organizations WHERE id = $1", [orgId])).rows[0]!;
    const settings = withDefaults(org.settings);
    const v = r.vehicleId ? (await c.query("SELECT * FROM vehicles WHERE id = $1", [r.vehicleId])).rows[0] : null;
    if (r.vehicleId && !v) throw new BadRequestException("unknown vehicle");
    const dp = r.driverId ? (await c.query("SELECT * FROM driver_profiles WHERE user_id = $1", [r.driverId])).rows[0] : null;
    const depotId = r.depotId ?? v?.depot_id ?? null;
    const depot = depotId ? (await c.query("SELECT lat, lng FROM depots WHERE id = $1", [depotId])).rows[0] : null;
    const electric = v?.fuel_type === "electric";
    const chargers = electric ? (await c.query<LatLng>("SELECT lat, lng FROM depots")).rows : [];
    const first = r.stops[0];
    const start = r.start ?? (depot ? { lat: depot.lat, lng: depot.lng } : first ? { lat: first.lat, lng: first.lng } : { lat: 0, lng: 0 });
    const { profile, learned } = await this.trafficFor(c, orgId, org.timezone);
    const vehicle: PlanVehicle = {
      id: r.vehicleId ?? "v", start, shiftStart: zonedToEpoch(r.date, r.startTime, org.timezone),
      openEnd: !r.start && !depot, maxShiftMin: dp?.max_shift_min, breakAfterMin: dp?.break_after_min, breakMin: dp?.break_min,
      capacityKg: v?.capacity_kg ?? undefined, capacityM3: v?.capacity_m3 ?? undefined, capacityItems: v?.capacity_items ?? undefined,
      skills: dp?.skills ?? [], rangeKm: electric ? (v?.range_km ?? undefined) : undefined, chargers, chargeMin: 40,
    };
    const fallback = makeTravel({ avoid: r.avoid, traffic: profile, hourOf: hourIn(org.timezone), speedKph: KIND_SPEED[v?.kind ?? "van"] ?? 50 });
    let travel = fallback;
    let source = "estimate";
    if (this.provider) {
      const pts = [start, ...r.stops, ...chargers, ...extraPoints];
      try {
        const m = await this.provider.matrix(pts, { avoid: r.avoid, truck: v && (v.kind === "truck" || v.kind === "bus") ? { heightM: v.height_m, weightKg: v.weight_kg, hazmat: v.hazmat } : undefined });
        const raw = matrixTravel(pts, m.seconds, m.metres, fallback);
        const hourOf = hourIn(org.timezone);
        // Real road times are free-flow; scale them by the learned hour-of-day slowdown to predict traffic.
        travel = (a, b, at) => { const x = raw(a, b, at); return { m: x.m, s: x.s * (profile[hourOf(at)] ?? 1) }; };
        source = this.provider.name;
      } catch { /* keep the estimate: planning must not fail because the routing server is down */ }
    }
    return { tz: org.timezone, rates: { perKm: settings.costPerKm, perHour: settings.costPerHour }, traffic: profile, trafficLearned: learned, vehicle, source, travel };
  }

  private present(plan: RoutePlan, stops: readonly PlanStop[], ctx: Context) {
    const byId = new Map(stops.map((s) => [s.id, s]));
    return {
      vehicleId: plan.vehicleId, order: plan.order, totals: plan.totals, violations: plan.violations, source: ctx.source,
      cost: planCost(plan.totals, ctx.rates),
      stops: plan.events.filter((e) => e.kind === "stop").map((e) => ({
        id: e.stopId!, name: undefined as string | undefined, arriveAt: new Date(e.at).toISOString(), departAt: new Date(e.until).toISOString(),
        waitS: e.waitS ?? 0, lateS: e.lateS ?? 0, windowEnd: byId.get(e.stopId!)?.windowEnd ? new Date(byId.get(e.stopId!)!.windowEnd!).toISOString() : null,
      })),
      pauses: plan.events.filter((e) => e.kind === "break" || e.kind === "charge").map((e) => ({ kind: e.kind, at: new Date(e.at).toISOString(), until: new Date(e.until).toISOString(), lat: e.lat, lng: e.lng })),
      departAt: new Date(plan.events[0]!.at).toISOString(), endAt: new Date(plan.totals.endAt).toISOString(),
    };
  }

  private async solve(c: pg.PoolClient, orgId: string, r: PlanRequest) {
    const ctx = await this.context(c, orgId, r);
    const plan = r.fixedOrder ? evaluateOrder(ctx.vehicle, r.stops, ctx.travel, r.objective) : planRoute(ctx.vehicle, r.stops, ctx.travel, { objective: r.objective });
    return { ctx, plan };
  }

  /** Order stops for one vehicle: shortest time or distance, honouring time windows, capacity, shifts, breaks, range and avoid options. */
  @Post("optimize")
  async optimize(@Req() req: AuthedRequest, @Body() body: unknown) {
    const orgId = requirePerm(req, "routes.write");
    const r = parsePlanRequest(body);
    return withOrg(this.pool, orgId, async (c) => {
      const { ctx, plan } = await this.solve(c, orgId, r);
      return this.present(plan, r.stops, ctx);
    });
  }

  /** Plan A against Plan B, with cost, time and lateness side by side. */
  @Post("compare")
  async compare(@Req() req: AuthedRequest, @Body() body: { a?: unknown; b?: unknown }) {
    const orgId = requirePerm(req, "routes.write");
    const ra = parsePlanRequest(body?.a);
    const rb = parsePlanRequest(body?.b);
    return withOrg(this.pool, orgId, async (c) => {
      const a = await this.solve(c, orgId, ra);
      const b = await this.solve(c, orgId, rb);
      return { a: this.present(a.plan, ra.stops, a.ctx), b: this.present(b.plan, rb.stops, b.ctx), comparison: comparePlans(a.plan, b.plan, a.ctx.rates) };
    });
  }

  /** Preview adding one stop to the current order, before saving anything. */
  @Post("whatif")
  async whatif(@Req() req: AuthedRequest, @Body() body: { plan?: unknown; add?: unknown }) {
    const orgId = requirePerm(req, "routes.write");
    const r = parsePlanRequest(body?.plan);
    const [extra] = parsePlanStops([{ ...(body?.add as object), id: "__new" }]);
    return withOrg(this.pool, orgId, async (c) => {
      const ctx = await this.context(c, orgId, r, [extra!]);
      const res = whatIfAdd(ctx.vehicle, r.stops, extra!, ctx.travel, r.objective);
      return { ...res, addedCost: Math.round((planCost(res.after, ctx.rates) - planCost(res.before, ctx.rates)) * 100) / 100, source: ctx.source };
    });
  }

  /** Split stops across several vehicles. Stops that fit no vehicle come back as `unassigned` with the reason. */
  @Post("fleet")
  async fleet(@Req() req: AuthedRequest, @Body() body: { vehicleIds?: unknown; drivers?: unknown } & Record<string, unknown>) {
    const orgId = requirePerm(req, "routes.write");
    const r = parsePlanRequest(body);
    if (!Array.isArray(body.vehicleIds) || body.vehicleIds.length === 0 || body.vehicleIds.length > 50) throw new BadRequestException("choose 1 to 50 vehicles");
    const ids = body.vehicleIds.map((x) => parseUuid(String(x)));
    const drivers = (body.drivers ?? {}) as Record<string, string>;
    return withOrg(this.pool, orgId, async (c) => {
      const vehicles: PlanVehicle[] = [];
      let ctx0: Context | null = null;
      for (const id of ids) {
        const ctx = await this.context(c, orgId, { ...r, vehicleId: id, driverId: drivers[id] ? parseUuid(drivers[id]!) : null });
        ctx0 ??= ctx;
        vehicles.push(ctx.vehicle);
      }
      const fp = planFleet(vehicles, r.stops, ctx0!.travel, { objective: r.objective });
      return {
        routes: fp.routes.map((p) => ({ ...this.present(p, r.stops, ctx0!) })),
        unassigned: fp.unassigned, source: ctx0!.source,
        totalCost: Math.round(fp.routes.reduce((a, p) => a + planCost(p.totals, ctx0!.rates), 0) * 100) / 100,
      };
    });
  }

  @Get("traffic")
  async traffic(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "routes.view");
    return withOrg(this.pool, orgId, async (c) => {
      const tz = (await c.query<{ timezone: string }>("SELECT timezone FROM organizations WHERE id = $1", [orgId])).rows[0]!.timezone;
      const t = await this.trafficFor(c, orgId, tz);
      return { learned: t.learned, hourly: t.profile };
    });
  }

  /** Reorder an existing route (apply=true saves the new order and ETAs). */
  @Post("routes/:id/optimize")
  async optimizeRoute(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { apply?: unknown; startTime?: unknown; objective?: unknown; avoid?: unknown }) {
    const orgId = requirePerm(req, "routes.write");
    const routeId = parseUuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const route = (await c.query(
        `SELECT id, route_date::text AS date, vehicle_id, driver_id, depot_id, objective, avoid, start_time::text AS start_time FROM routes WHERE id = $1 FOR UPDATE`, [routeId])).rows[0];
      if (!route) throw new NotFoundException();
      const rows = (await c.query(
        `SELECT id, lat, lng, window_start, window_end, service_min, weight_kg, volume_m3, packages, priority, kind, status FROM stops WHERE route_id = $1 ORDER BY sequence`, [routeId])).rows;
      const open = rows.filter((s) => s.status === "pending");
      const done = rows.filter((s) => s.status !== "pending");
      if (open.length === 0) throw new BadRequestException("no pending stops to plan");
      const stops: PlanStop[] = open.map((s) => ({
        id: s.id, lat: s.lat, lng: s.lng, serviceMin: s.service_min, weightKg: s.weight_kg, volumeM3: s.volume_m3, items: s.packages, priority: s.priority, kind: s.kind,
        windowStart: s.window_start ? s.window_start.getTime() : null, windowEnd: s.window_end ? s.window_end.getTime() : null,
      }));
      const r = parsePlanRequest({
        date: route.date, vehicleId: route.vehicle_id, driverId: route.driver_id, depotId: route.depot_id,
        startTime: body?.startTime ?? (route.start_time ? String(route.start_time).slice(0, 5) : "08:00"), objective: body?.objective ?? route.objective, avoid: body?.avoid ?? route.avoid, stops: [{ name: "x", lat: 0, lng: 0 }],
      });
      r.stops = stops;
      const { ctx, plan } = await this.solve(c, orgId, r);
      const out = this.present(plan, stops, ctx);
      if (body?.apply === true) {
        const order = [...done.map((s) => s.id), ...plan.order];
        await c.query(
          `UPDATE stops s SET sequence = x.seq FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, seq) WHERE s.id = x.id AND s.route_id = $1`, [routeId, order]);
        for (const st of out.stops) await c.query("UPDATE stops SET eta = $2 WHERE id = $1", [st.id, st.arriveAt]);
      }
      return { ...out, applied: body?.apply === true };
    });
  }

  /** Live ETAs for the rest of a route, from where its vehicle is right now. */
  @Get("routes/:id/etas")
  async routeEtas(@Req() req: AuthedRequest, @Param("id") id: string, @Query("at") at?: string) {
    const orgId = requirePerm(req, "routes.view");
    const routeId = parseUuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const route = (await c.query("SELECT id, vehicle_id FROM routes WHERE id = $1", [routeId])).rows[0];
      if (!route) throw new NotFoundException();
      const org = (await c.query<{ timezone: string }>("SELECT timezone FROM organizations WHERE id = $1", [orgId])).rows[0]!;
      const pos = route.vehicle_id ? (await c.query(
        `SELECT lp.lat, lp.lng, lp.time FROM latest_positions lp JOIN devices d ON d.id = lp.device_id WHERE d.vehicle_id = $1 ORDER BY lp.time DESC LIMIT 1`, [route.vehicle_id])).rows[0] : null;
      const stops = (await c.query(
        `SELECT id, name, lat, lng, service_min, window_end FROM stops WHERE route_id = $1 AND status IN ('pending','arrived') ORDER BY sequence`, [routeId])).rows;
      if (!pos || stops.length === 0) return { available: false, stops: [] };
      const { profile } = await this.trafficFor(c, orgId, org.timezone);
      const now = at ? Date.parse(at) : Date.now();
      if (Number.isNaN(now)) throw new BadRequestException("at must be a timestamp");
      const travel = makeTravel({ traffic: profile, hourOf: hourIn(org.timezone) });
      const etas = liveEtas({ lat: pos.lat, lng: pos.lng }, now, stops.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, serviceMin: s.service_min, windowEnd: s.window_end ? s.window_end.getTime() : null })), travel);
      const names = new Map(stops.map((s) => [s.id, s.name]));
      return { available: true, from: { lat: pos.lat, lng: pos.lng, time: pos.time }, stops: etas.map((e) => ({ id: e.id, name: names.get(e.id), eta: new Date(e.eta).toISOString(), lateByS: e.lateByS })) };
    });
  }
}
