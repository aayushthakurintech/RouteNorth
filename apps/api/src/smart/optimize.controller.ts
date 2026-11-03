import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Query, Req, UseGuards, Patch } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import {
  backhaul, clusterTerritories, co2Kg, evaluateOrder, groupRides, haversine, makeTravel, planFleet, planRoute, pointInPolygon, suggestMoves, workloadBalance,
  type Load, type LatLng, type PlanStop, type PlanVehicle, type RoutePlan,
} from "@routenorth/shared";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { emit } from "../automation/events.js";
import { parseUuid } from "../history/range.js";
import { resequence, routeForDriver, place, loadJob } from "../dispatch/jobs.service.js";
import { withDefaults } from "../org/settings.js";
import { hourIn, zonedToEpoch } from "../plan/time.js";
import { parseDate } from "../routes/validate.js";
import { PG_POOL } from "../tokens.js";
import { todayIn } from "./ai.controller.js";

const CONSUMPTION: Record<string, number> = { truck: 30, bus: 35, van: 14, car: 9 };
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
const r2 = (x: number) => Math.round(x * 100) / 100;

interface Ctx { tz: string; settings: ReturnType<typeof withDefaults>; depot: LatLng | null }
async function ctxOf(c: pg.PoolClient, orgId: string): Promise<Ctx> {
  const o = (await c.query<{ timezone: string; settings: unknown }>("SELECT timezone, settings FROM organizations WHERE id = $1", [orgId])).rows[0]!;
  const d = (await c.query<LatLng>("SELECT lat, lng FROM depots ORDER BY created_at LIMIT 1")).rows[0] ?? null;
  return { tz: o.timezone, settings: withDefaults(o.settings), depot: d };
}
const planStop = (s: Record<string, any>): PlanStop => ({
  id: s.id, lat: s.lat, lng: s.lng, serviceMin: s.service_min ?? 5, weightKg: s.weight_kg ?? 0, volumeM3: s.volume_m3 ?? 0, items: s.packages ?? 0, priority: s.priority, kind: s.kind,
  windowStart: s.window_start ? new Date(s.window_start).getTime() : null, windowEnd: s.window_end ? new Date(s.window_end).getTime() : null,
});
/** What a kilometre costs for a vehicle, split into fuel, wear and tolls, and what an hour costs in wages. */
function rates(ctx: Ctx, v: { kind?: string | null; fuel_type?: string | null } | null, hourly: number | null) {
  const k = ctx.settings.costing as { fuelPricePerL: number; wearPerKm: number; tollPerKm: number; evCostPerKm: number };
  const ev = v?.fuel_type === "electric";
  const lPer100 = ev ? 0 : CONSUMPTION[v?.kind ?? "van"] ?? 14;
  return { fuelPerKm: ev ? k.evCostPerKm : (lPer100 / 100) * k.fuelPricePerL, wearPerKm: k.wearPerKm, tollPerKm: k.tollPerKm, perHour: hourly ?? ctx.settings.costPerHour, lPer100, fuelType: v?.fuel_type ?? "diesel" };
}
function costOf(p: RoutePlan, r: ReturnType<typeof rates>) {
  const km = p.totals.distanceM / 1000, h = p.totals.durationS / 3600;
  const fuel = km * r.fuelPerKm, wages = h * r.perHour, wear = km * r.wearPerKm, tolls = km * r.tollPerKm;
  return { fuel: r2(fuel), wages: r2(wages), wear: r2(wear), tolls: r2(tolls), total: r2(fuel + wages + wear + tolls), co2Kg: r2(co2Kg((km * r.lPer100) / 100, r.fuelType)) };
}

/** Planning tools beyond a single route: areas, balance, several depots, cost and CO2, return loads, shared rides, pairs and what-if runs. */
@Controller("optimize")
@UseGuards(AuthGuard)
export class OptimizeController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /* ---------------------------------------------------------------- territories */
  @Get("territories")
  async territories(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "routes.view");
    return (await withOrg(this.pool, orgId, (c) => c.query(`SELECT t.id, t.name, t.color, t.polygon, t.driver_id AS "driverId", coalesce(u.display_name, u.email) AS "driverName" FROM territories t LEFT JOIN users u ON u.id = t.driver_id ORDER BY t.name`))).rows;
  }

  private polygon(v: unknown): [number, number][] {
    if (!Array.isArray(v) || v.length < 3 || v.length > 200 || !v.every((p) => Array.isArray(p) && p.length === 2 && Math.abs(Number(p[0])) <= 90 && Math.abs(Number(p[1])) <= 180)) throw new BadRequestException("an area needs 3 to 200 points as [lat, lng]");
    return v.map((p) => [Number(p[0]), Number(p[1])]);
  }

  @Post("territories")
  async createTerritory(@Req() req: AuthedRequest, @Body() b: { name?: unknown; color?: unknown; polygon?: unknown; driverId?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const name = text(b?.name, 80);
    if (!name) throw new BadRequestException("name is needed");
    const color = /^#[0-9a-fA-F]{6}$/.test(String(b?.color)) ? String(b.color) : "#2563eb";
    const driver = b?.driverId ? parseUuid(String(b.driverId)) : null;
    return (await withOrg(this.pool, orgId, (c) => c.query(`INSERT INTO territories (org_id, name, color, polygon, driver_id) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [orgId, name, color, JSON.stringify(this.polygon(b?.polygon)), driver]))).rows[0];
  }

  @Patch("territories/:id")
  async updateTerritory(@Req() req: AuthedRequest, @Param("id") id: string, @Body() b: { name?: unknown; color?: unknown; driverId?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const sets: string[] = [], args: unknown[] = [parseUuid(id)];
    if (b?.name !== undefined) { const n = text(b.name, 80); if (!n) throw new BadRequestException("name is needed"); args.push(n); sets.push(`name = $${args.length}`); }
    if (b?.color !== undefined) { if (!/^#[0-9a-fA-F]{6}$/.test(String(b.color))) throw new BadRequestException("color must look like #2563eb"); args.push(b.color); sets.push(`color = $${args.length}`); }
    if (b?.driverId !== undefined) { args.push(b.driverId ? parseUuid(String(b.driverId)) : null); sets.push(`driver_id = $${args.length}`); }
    if (!sets.length) throw new BadRequestException("nothing to update");
    const n = (await withOrg(this.pool, orgId, (c) => c.query(`UPDATE territories SET ${sets.join(", ")} WHERE id = $1`, args))).rowCount;
    if (!n) throw new NotFoundException();
    return { ok: true };
  }

  @Delete("territories/:id")
  @HttpCode(200)
  async deleteTerritory(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "routes.dispatch");
    if (!(await withOrg(this.pool, orgId, (c) => c.query("DELETE FROM territories WHERE id = $1", [parseUuid(id)]))).rowCount) throw new NotFoundException();
    return { ok: true };
  }

  /** Split the map fairly: the same number of recent stops in each area, one area per driver. */
  @Post("territories/suggest")
  @HttpCode(200)
  async suggestTerritories(@Req() req: AuthedRequest, @Body() b: { count?: unknown; days?: unknown }) {
    const orgId = requirePerm(req, "routes.view");
    const days = Math.min(180, Math.max(7, Number(b?.days) || 60));
    return withOrg(this.pool, orgId, async (c) => {
      const drivers = (await c.query("SELECT id, coalesce(display_name, email) AS name FROM users WHERE role = 'driver' AND disabled_at IS NULL ORDER BY 2")).rows;
      const k = Math.min(12, Math.max(1, Number(b?.count) || drivers.length || 1));
      const pts = (await c.query(
        `SELECT s.id, s.lat, s.lng, r.driver_id FROM stops s JOIN routes r ON r.id = s.route_id WHERE s.lat IS NOT NULL AND r.route_date > current_date - $1::int ORDER BY s.id LIMIT 3000`, [days])).rows;
      const open = (await c.query("SELECT id, lat, lng FROM jobs WHERE lat IS NOT NULL AND status = 'unassigned' ORDER BY id LIMIT 1000")).rows.map((p) => ({ ...p, driver_id: null }));
      const all = [...pts, ...open];
      if (all.length < k * 3) return { areas: [], points: all.length, reason: "not_enough_stops" };
      const clusters = clusterTerritories(all.map((p) => ({ id: p.id, lat: p.lat, lng: p.lng })), k);
      const byId = new Map(all.map((p) => [p.id as string, p]));
      const taken = new Set<string>();
      const areas = clusters.map((cl) => {
        const tally = new Map<string, number>();
        for (const id of cl.ids) { const d = byId.get(id)?.driver_id; if (d) tally.set(d, (tally.get(d) ?? 0) + 1); }
        return { cl, tally };
      });
      return {
        points: all.length,
        areas: areas.map(({ cl, tally }, i) => {
          const pick = [...tally.entries()].sort((a, b) => b[1] - a[1]).find(([d]) => !taken.has(d))?.[0] ?? null;
          if (pick) taken.add(pick);
          return { name: `Area ${i + 1}`, stops: cl.ids.length, polygon: cl.hull, centre: cl.centre, driverId: pick, driverName: drivers.find((d) => d.id === pick)?.name ?? null };
        }),
      };
    });
  }

  /* ---------------------------------------------------------------- balance */
  private async dayLoads(c: pg.PoolClient, orgId: string, day: string) {
    const ctx = await ctxOf(c, orgId);
    const travel = makeTravel({ hourOf: hourIn(ctx.tz) });
    const routes = (await c.query(
      `SELECT r.id, r.driver_id, coalesce(u.display_name, u.email) AS name FROM routes r JOIN users u ON u.id = r.driver_id WHERE r.route_date = $1 AND r.status IN ('planned','in_progress') ORDER BY r.created_at`, [day])).rows;
    const loads = new Map<string, Load>();
    const movable: { id: string; driverId: string; lat: number; lng: number; minutes: number }[] = [];
    for (const r of routes) {
      const st = (await c.query("SELECT * FROM stops WHERE route_id = $1 AND status = 'pending' ORDER BY sequence", [r.id])).rows;
      if (!st.length) continue;
      const plan = evaluateOrder({ id: r.id, start: ctx.depot ?? { lat: st[0].lat, lng: st[0].lng }, shiftStart: zonedToEpoch(day, "08:00", ctx.tz) }, st.map(planStop), travel);
      const l = loads.get(r.driver_id) ?? { id: r.driver_id, name: r.name, stops: 0, minutes: 0, km: 0 };
      l.stops += st.length; l.minutes += Math.round((plan.totals.driveS + plan.totals.serviceS) / 60); l.km += plan.totals.distanceM / 1000;
      loads.set(r.driver_id, l);
      for (const s of st) movable.push({ id: s.id, driverId: r.driver_id, lat: s.lat, lng: s.lng, minutes: (s.service_min ?? 5) + Math.round(plan.totals.driveS / 60 / st.length) });
    }
    // Drivers with no route today count as free, so work can move to them.
    const free = (await c.query(
      `SELECT u.id, coalesce(u.display_name, u.email) AS name, coalesce(dp.preferences->'daysOff' ? $1, false) AS off FROM users u LEFT JOIN driver_profiles dp ON dp.user_id = u.id WHERE u.role = 'driver' AND u.disabled_at IS NULL`, [day])).rows;
    for (const d of free) { if (d.off) loads.delete(d.id); else if (!loads.has(d.id)) loads.set(d.id, { id: d.id, name: d.name, stops: 0, minutes: 0, km: 0 }); }
    return { loads: [...loads.values()].map((l) => ({ ...l, km: r2(l.km) })), movable };
  }

  /** How even the day is, and which stops to move to even it out. */
  @Get("balance")
  async balance(@Req() req: AuthedRequest, @Query("date") date?: string) {
    const orgId = requirePerm(req, "routes.view");
    return withOrg(this.pool, orgId, async (c) => {
      const day = date ? parseDate(date) : todayIn((await ctxOf(c, orgId)).tz);
      const { loads, movable } = await this.dayLoads(c, orgId, day);
      return { date: day, loads, ...workloadBalance(loads), moves: suggestMoves(loads, movable.filter((s) => loads.some((l) => l.id === s.driverId))) };
    });
  }

  private async moveStops(c: pg.PoolClient, orgId: string, day: string, moves: { stopId: string; toId: string }[], actor: string) {
    const names = new Map((await c.query("SELECT id, coalesce(display_name, email) AS name FROM users WHERE role = 'driver'")).rows.map((d) => [d.id as string, d.name as string]));
    const touched = new Set<string>();
    for (const m of moves) {
      const s = (await c.query("SELECT s.id, s.route_id, s.job_id, s.status FROM stops s WHERE s.id = $1 FOR UPDATE", [m.stopId])).rows[0];
      if (!s || s.status !== "pending") continue;
      const to = names.get(m.toId);
      if (!to) throw new BadRequestException("unknown driver");
      const target = await routeForDriver(c, orgId, m.toId, day, to);
      const veh = (await c.query("SELECT vehicle_id FROM routes WHERE id = $1", [target])).rows[0]?.vehicle_id ?? null;
      const n = Number((await c.query("SELECT coalesce(max(sequence), 0)::int AS m FROM stops WHERE route_id = $1", [target])).rows[0].m);
      await c.query("UPDATE stops SET route_id = $2, sequence = $3 WHERE id = $1", [s.id, target, n + 1]);
      if (s.job_id) { await c.query("UPDATE jobs SET route_id = $2, driver_id = $3, vehicle_id = $4 WHERE id = $1", [s.job_id, target, m.toId, veh]); await emit(c, orgId, "job.assigned", "job", s.job_id, { driverId: m.toId, routeId: target, via: "balance", actor }); }
      touched.add(s.route_id); touched.add(target);
    }
    for (const r of touched) { await resequence(c, r); if (!(await c.query("SELECT 1 FROM stops WHERE route_id = $1 LIMIT 1", [r])).rowCount) await c.query("DELETE FROM routes WHERE id = $1 AND status = 'planned'", [r]); }
    return touched.size;
  }

  @Post("balance/apply")
  @HttpCode(200)
  async applyBalance(@Req() req: AuthedRequest, @Body() b: { date?: unknown; moves?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    if (!Array.isArray(b?.moves) || b.moves.length === 0 || b.moves.length > 100) throw new BadRequestException("moves must be a list of up to 100");
    const moves = b.moves.map((m: any) => ({ stopId: parseUuid(String(m?.stopId)), toId: parseUuid(String(m?.toId)) }));
    const day = parseDate(b?.date);
    return withOrg(this.pool, orgId, async (c) => ({ moved: moves.length, routes: await this.moveStops(c, orgId, day, moves, req.session!.userId) }));
  }

  /* ---------------------------------------------------------------- multi depot */
  /** Give each waiting job to its nearest depot, then plan each depot's drivers on their own. */
  @Post("multi-depot")
  @HttpCode(200)
  async multiDepot(@Req() req: AuthedRequest, @Body() b: { date?: unknown; apply?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const day = parseDate(b?.date);
    return withOrg(this.pool, orgId, async (c) => {
      const ctx = await ctxOf(c, orgId);
      const depots = (await c.query("SELECT id, name, lat, lng FROM depots ORDER BY name")).rows;
      if (depots.length < 2) return { depots: [], applied: false, reason: "one_depot" };
      const jobs = (await c.query(`SELECT * FROM jobs WHERE status = 'unassigned' AND lat IS NOT NULL AND (scheduled_date = $1 OR scheduled_date IS NULL) ORDER BY created_at LIMIT 400`, [day])).rows;
      const drivers = (await c.query(
        `SELECT u.id, coalesce(u.display_name, u.email) AS name, dp.home_depot_id, dp.skills, dp.max_shift_min FROM users u LEFT JOIN driver_profiles dp ON dp.user_id = u.id
         WHERE u.role = 'driver' AND u.disabled_at IS NULL ORDER BY name`)).rows;
      const nearest = (p: LatLng) => depots.reduce((a, d) => (haversine(p.lat, p.lng, d.lat, d.lng) < haversine(p.lat, p.lng, a.lat, a.lng) ? d : a));
      const travel = makeTravel({ hourOf: hourIn(ctx.tz) });
      const out = [];
      for (const d of depots) {
        const mine = jobs.filter((j) => nearest(j).id === d.id);
        const crew = drivers.filter((x) => x.home_depot_id === d.id);
        if (!mine.length) { out.push({ depotId: d.id, name: d.name, jobs: 0, drivers: crew.length, km: 0, unassigned: 0, proposals: [] }); continue; }
        const vehicles: PlanVehicle[] = crew.map((x) => ({ id: x.id, start: { lat: d.lat, lng: d.lng }, shiftStart: zonedToEpoch(day, "08:00", ctx.tz), maxShiftMin: x.max_shift_min ?? 600, skills: x.skills ?? [] }));
        const stops: PlanStop[] = mine.map((j) => ({ id: j.id, lat: j.lat, lng: j.lng, serviceMin: j.service_min, weightKg: j.weight_kg, priority: j.priority, skills: j.skills, kind: j.type === "pickup" ? "pickup" : "delivery",
          windowStart: j.window_start ? new Date(j.window_start).getTime() : null, windowEnd: j.window_end ? new Date(j.window_end).getTime() : null }));
        const plan = planFleet(vehicles, stops, travel);
        const proposals = plan.routes.flatMap((r) => r.order.map((jobId, i) => ({ jobId, driverId: r.vehicleId, driverName: crew.find((x) => x.id === r.vehicleId)!.name, position: i })));
        out.push({ depotId: d.id, name: d.name, jobs: mine.length, drivers: crew.length, km: r2(plan.routes.reduce((a, r) => a + r.totals.distanceM, 0) / 1000), unassigned: crew.length ? plan.unassigned.length : mine.length, proposals });
      }
      const apply = b?.apply === true;
      if (apply) {
        for (const d of out) for (const p of d.proposals) {
          const job = await loadJob(c, p.jobId, true);
          const routeId = await routeForDriver(c, orgId, p.driverId, day, p.driverName);
          await place(c, orgId, job, routeId, null, req.session!.userId);
          if (!job.scheduled_date) await c.query("UPDATE jobs SET scheduled_date = $2 WHERE id = $1", [p.jobId, day]);
        }
      }
      return { date: day, depots: out, applied: apply };
    });
  }

  /* ---------------------------------------------------------------- cost and CO2 */
  private async routeBundle(c: pg.PoolClient, orgId: string, routeId: string) {
    const ctx = await ctxOf(c, orgId);
    const r = (await c.query(
      `SELECT r.id, r.name, r.route_date::text AS date, r.vehicle_id, r.driver_id, r.depot_id, r.start_time, v.kind, v.fuel_type, v.capacity_kg, v.name AS vehicle, v.depot_id AS vdepot, dp.hourly_rate
       FROM routes r LEFT JOIN vehicles v ON v.id = r.vehicle_id LEFT JOIN driver_profiles dp ON dp.user_id = r.driver_id WHERE r.id = $1`, [routeId])).rows[0];
    if (!r) throw new NotFoundException();
    const stops = (await c.query("SELECT * FROM stops WHERE route_id = $1 ORDER BY sequence", [routeId])).rows;
    const depotId = r.depot_id ?? r.vdepot;
    const depot = depotId ? (await c.query<LatLng>("SELECT lat, lng FROM depots WHERE id = $1", [depotId])).rows[0] : ctx.depot;
    const pending = stops.filter((s) => s.status === "pending");
    const vehicle: PlanVehicle = { id: r.vehicle_id ?? "v", start: depot ?? { lat: pending[0]?.lat ?? 0, lng: pending[0]?.lng ?? 0 }, openEnd: !depot, shiftStart: zonedToEpoch(r.date, String(r.start_time ?? "08:00").slice(0, 5), ctx.tz), capacityKg: r.capacity_kg ?? undefined };
    return { ctx, r, stops, pending, vehicle, depot, travel: makeTravel({ hourOf: hourIn(ctx.tz) }) };
  }

  /** The route as it is, the fastest order and the shortest order, each with its cost (fuel, wages, wear, tolls) and CO2. Also the CO2 of other vehicles. */
  @Get("compare")
  async compare(@Req() req: AuthedRequest, @Query("routeId") routeId?: string) {
    const orgId = requirePerm(req, "routes.view");
    return withOrg(this.pool, orgId, async (c) => {
      const b = await this.routeBundle(c, orgId, parseUuid(String(routeId)));
      if (b.pending.length < 2) return { routeId, options: [], reason: "too_few_stops" };
      const ps = b.pending.map(planStop);
      const rt = rates(b.ctx, b.r, b.r.hourly_rate == null ? null : Number(b.r.hourly_rate));
      const plans: Record<string, RoutePlan> = { current: evaluateOrder(b.vehicle, ps, b.travel), time: planRoute(b.vehicle, ps, b.travel, { objective: "time" }), distance: planRoute(b.vehicle, ps, b.travel, { objective: "distance" }) };
      const options = Object.entries(plans).map(([id, p]) => ({ id, km: r2(p.totals.distanceM / 1000), minutes: Math.round(p.totals.durationS / 60), late: p.totals.lateCount, valid: p.violations.length === 0, order: p.order, cost: costOf(p, rt) }));
      const score = (o: (typeof options)[number]) => (o.valid ? 0 : 1e9) + o.late * 1e4 + o.cost.total;
      const cheapest = options.reduce((a, o) => (score(o) < score(a) - 0.005 ? o : a)).id;
      const greenest = options.reduce((a, o) => ((o.valid ? 0 : 1e9) + o.late * 1e4 + o.cost.co2Kg < (a.valid ? 0 : 1e9) + a.late * 1e4 + a.cost.co2Kg - 0.005 ? o : a)).id;
      const km = options.find((o) => o.id === cheapest)!.km;
      const vehicles = (await c.query("SELECT id, name, kind, fuel_type FROM vehicles WHERE status = 'active' ORDER BY name")).rows.map((v) => {
        const k = rates(b.ctx, v, null);
        return { vehicleId: v.id, name: v.name, fuelType: v.fuel_type ?? "diesel", co2Kg: r2(co2Kg((km * k.lPer100) / 100, k.fuelType)), current: v.id === b.r.vehicle_id };
      }).sort((a, z) => a.co2Kg - z.co2Kg);
      return { routeId, routeName: b.r.name, options, cheapest, greenest, vehicles, rates: { perHour: rt.perHour, fuelPerKm: r2(rt.fuelPerKm), wearPerKm: rt.wearPerKm, tollPerKm: rt.tollPerKm } };
    });
  }

  /** Put the route's waiting stops in the chosen order (from compare). */
  @Post("compare/apply")
  @HttpCode(200)
  async applyOrder(@Req() req: AuthedRequest, @Body() body: { routeId?: unknown; option?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const option = String(body?.option);
    if (option !== "time" && option !== "distance") throw new BadRequestException("option must be time or distance");
    return withOrg(this.pool, orgId, async (c) => {
      const b = await this.routeBundle(c, orgId, parseUuid(String(body?.routeId)));
      const plan = planRoute(b.vehicle, b.pending.map(planStop), b.travel, { objective: option });
      const done = b.stops.filter((s) => s.status !== "pending").map((s) => s.id as string);
      await c.query(`UPDATE stops s SET sequence = x.seq FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, seq) WHERE s.id = x.id AND s.route_id = $1`, [b.r.id, [...done, ...plan.order]]);
      await resequence(c, b.r.id);
      return { ok: true, km: r2(plan.totals.distanceM / 1000) };
    });
  }

  /* ---------------------------------------------------------------- return loads and shared rides */
  /** Waiting pickups on the way back to the depot that still fit in the vehicle. */
  @Get("backhaul")
  async backhaulFor(@Req() req: AuthedRequest, @Query("routeId") routeId?: string, @Query("maxKm") maxKm?: string) {
    const orgId = requirePerm(req, "routes.view");
    return withOrg(this.pool, orgId, async (c) => {
      const b = await this.routeBundle(c, orgId, parseUuid(String(routeId)));
      const last = [...b.stops].reverse().find((s) => s.status === "pending") ?? b.stops[b.stops.length - 1];
      if (!last || !b.depot) return { routeId, candidates: [], reason: b.depot ? "no_stops" : "no_depot" };
      const load = b.stops.reduce((a, s) => a + (s.weight_kg ?? 0), 0);
      const spare = b.r.capacity_kg != null ? Math.max(0, b.r.capacity_kg - load) : null;
      const jobs = (await c.query(`SELECT id, title, address, lat, lng, weight_kg FROM jobs WHERE type = 'pickup' AND status = 'unassigned' AND lat IS NOT NULL AND (scheduled_date = $1 OR scheduled_date IS NULL) LIMIT 300`, [b.r.date])).rows;
      const hits = backhaul(last, b.depot, jobs.map((j) => ({ id: j.id, lat: j.lat, lng: j.lng, weightKg: j.weight_kg })), spare, Math.min(50, Math.max(1, Number(maxKm) || 8)));
      return { routeId, spareKg: spare, candidates: hits.map((h) => ({ ...h, ...(jobs.find((j) => j.id === h.id)!) , lat: undefined, lng: undefined })) };
    });
  }

  /** Ride requests (a pickup job with a delivery job linked to it, tagged "ride") grouped by direction and time. */
  @Post("rides")
  @HttpCode(200)
  async rides(@Req() req: AuthedRequest, @Body() b: { date?: unknown; seats?: unknown }) {
    const orgId = requirePerm(req, "routes.view");
    const day = parseDate(b?.date);
    const seats = Math.min(60, Math.max(1, Number(b?.seats) || 4));
    return withOrg(this.pool, orgId, async (c) => {
      const rows = (await c.query(
        `SELECT p.id, p.title, p.lat AS flat, p.lng AS flng, p.items AS seats, p.window_start, d.lat AS tlat, d.lng AS tlng, d.id AS drop_id
         FROM jobs p JOIN jobs d ON d.parent_job_id = p.id WHERE 'ride' = ANY(p.tags) AND p.status <> 'cancelled' AND p.scheduled_date = $1 AND p.lat IS NOT NULL AND d.lat IS NOT NULL ORDER BY p.created_at LIMIT 500`, [day])).rows;
      const groups = groupRides(rows.map((r) => ({ id: r.id, from: { lat: r.flat, lng: r.flng }, to: { lat: r.tlat, lng: r.tlng }, seats: Math.max(1, r.seats || 1), atMs: r.window_start ? new Date(r.window_start).getTime() : null })), seats);
      const title = new Map(rows.map((r) => [r.id as string, r.title as string]));
      return { date: day, seats, requests: rows.length, groups: groups.map((g) => ({ ...g, titles: g.ids.map((i) => title.get(i)) })), vehiclesSaved: Math.max(0, rows.length - groups.length) };
    });
  }

  /* ---------------------------------------------------------------- pickup and delivery pairs */
  private async pairRows(c: pg.PoolClient, day: string) {
    return (await c.query(
      `SELECT p.id AS pickup_id, p.title AS pickup_title, p.driver_id AS pdriver, p.route_id AS proute, ps.sequence AS pseq, p.status AS pstatus,
              d.id AS drop_id, d.title AS drop_title, d.driver_id AS ddriver, d.route_id AS droute, ds.sequence AS dseq, d.status AS dstatus
       FROM jobs p JOIN jobs d ON d.parent_job_id = p.id AND d.type = 'delivery' LEFT JOIN stops ps ON ps.id = p.stop_id LEFT JOIN stops ds ON ds.id = d.stop_id
       WHERE p.type = 'pickup' AND p.status NOT IN ('cancelled','done','failed') AND d.status NOT IN ('cancelled','done','failed') AND (p.scheduled_date = $1 OR d.scheduled_date = $1) ORDER BY p.created_at`, [day])).rows;
  }
  private pairState(r: Record<string, any>): "ok" | "unplaced" | "different_driver" | "wrong_order" | "waiting" {
    if (!r.proute && !r.droute) return "waiting";
    if (!r.proute || !r.droute) return "unplaced";
    if (r.pdriver !== r.ddriver || r.proute !== r.droute) return "different_driver";
    return r.pseq > r.dseq ? "wrong_order" : "ok";
  }

  /** Pickup-and-delivery pairs and whether the rules hold: same driver, pickup before delivery. */
  @Get("pairs")
  async pairs(@Req() req: AuthedRequest, @Query("date") date?: string) {
    const orgId = requirePerm(req, "routes.view");
    return withOrg(this.pool, orgId, async (c) => {
      const day = date ? parseDate(date) : todayIn((await ctxOf(c, orgId)).tz);
      const rows = await this.pairRows(c, day);
      return { date: day, pairs: rows.map((r) => ({ pickupId: r.pickup_id, pickup: r.pickup_title, deliveryId: r.drop_id, delivery: r.drop_title, state: this.pairState(r) })) };
    });
  }

  /** Fix every broken pair: the delivery goes on the pickup's route, right after the pickup. */
  @Post("pairs/fix")
  @HttpCode(200)
  async fixPairs(@Req() req: AuthedRequest, @Body() b: { date?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const day = parseDate(b?.date);
    return withOrg(this.pool, orgId, async (c) => {
      let fixed = 0;
      for (const r of await this.pairRows(c, day)) {
        const st = this.pairState(r);
        if (st === "ok" || st === "waiting" || !r.proute) continue;
        const job = await loadJob(c, r.drop_id, true);
        const pickupSeq = (await c.query("SELECT sequence FROM stops WHERE id = (SELECT stop_id FROM jobs WHERE id = $1)", [r.pickup_id])).rows[0]?.sequence ?? 0;
        await place(c, orgId, job, r.proute, pickupSeq, req.session!.userId);
        fixed += 1;
      }
      return { fixed };
    });
  }

  /* ---------------------------------------------------------------- simulation */
  /** Try a change before paying for it: more or fewer vehicles, another depot, longer or shorter shifts. Plans the day's jobs both ways and compares. */
  @Post("simulate")
  @HttpCode(200)
  async simulate(@Req() req: AuthedRequest, @Body() b: { date?: unknown; addVehicles?: unknown; removeVehicles?: unknown; depot?: unknown; maxShiftMin?: unknown; capacityKg?: unknown }) {
    const orgId = requirePerm(req, "routes.view");
    const day = parseDate(b?.date);
    const add = Math.min(20, Math.max(0, Math.trunc(Number(b?.addVehicles) || 0))), remove = Math.min(50, Math.max(0, Math.trunc(Number(b?.removeVehicles) || 0)));
    const depot = b?.depot as { lat?: unknown; lng?: unknown } | null | undefined;
    if (depot && !(Math.abs(Number(depot.lat)) <= 90 && Math.abs(Number(depot.lng)) <= 180)) throw new BadRequestException("depot needs lat and lng");
    const shift = b?.maxShiftMin == null ? null : Math.min(1000, Math.max(60, Number(b.maxShiftMin) || 0));
    const cap = b?.capacityKg == null ? null : Math.max(0, Number(b.capacityKg) || 0);
    return withOrg(this.pool, orgId, async (c) => {
      const ctx = await ctxOf(c, orgId);
      const jobs = (await c.query(`SELECT * FROM jobs WHERE scheduled_date = $1 AND status <> 'cancelled' AND lat IS NOT NULL ORDER BY created_at LIMIT 600`, [day])).rows;
      if (!jobs.length) return { date: day, jobs: 0, baseline: null, scenario: null };
      const vs = (await c.query("SELECT v.*, d.lat AS dlat, d.lng AS dlng FROM vehicles v LEFT JOIN depots d ON d.id = v.depot_id WHERE v.status = 'active' ORDER BY v.name")).rows;
      const home = ctx.depot ?? { lat: jobs[0].lat, lng: jobs[0].lng };
      const start = (v: Record<string, any>): LatLng => (v.dlat != null ? { lat: v.dlat, lng: v.dlng } : home);
      const shiftStart = zonedToEpoch(day, "08:00", ctx.tz);
      const mk = (v: Record<string, any>, i: number, sc: boolean): PlanVehicle => ({
        id: `${v.id ?? "new"}#${i}`, start: sc && depot ? { lat: Number(depot.lat), lng: Number(depot.lng) } : start(v), shiftStart, maxShiftMin: sc && shift ? shift : 600,
        capacityKg: sc && cap != null ? cap : v.capacity_kg ?? undefined, skills: [],
      });
      const base = vs.map((v, i) => mk(v, i, false));
      let scen = vs.map((v, i) => mk(v, i, true));
      if (remove) scen = scen.slice(0, Math.max(0, scen.length - remove));
      const template = vs[0] ?? { id: "new", kind: "van" };
      for (let i = 0; i < add; i++) scen.push(mk({ ...template, id: "new" }, 100 + i, true));
      const stops: PlanStop[] = jobs.map((j) => ({ id: j.id, lat: j.lat, lng: j.lng, serviceMin: j.service_min, weightKg: j.weight_kg, priority: j.priority, kind: j.type === "pickup" ? "pickup" : "delivery", skills: [],
        windowStart: j.window_start ? new Date(j.window_start).getTime() : null, windowEnd: j.window_end ? new Date(j.window_end).getTime() : null }));
      const travel = makeTravel({ hourOf: hourIn(ctx.tz) });
      const rt = rates(ctx, null, null);
      const summarize = (fleet: PlanVehicle[]) => {
        const plan = planFleet(fleet, stops, travel);
        const used = plan.routes.filter((r) => r.order.length);
        const km = used.reduce((a, r) => a + r.totals.distanceM, 0) / 1000, h = used.reduce((a, r) => a + r.totals.durationS, 0) / 3600;
        return { vehicles: fleet.length, used: used.length, served: stops.length - plan.unassigned.length, unserved: plan.unassigned.length, late: used.reduce((a, r) => a + r.totals.lateCount, 0), km: r2(km), hours: r2(h),
          cost: r2(km * (rt.fuelPerKm + rt.wearPerKm + rt.tollPerKm) + h * rt.perHour) };
      };
      const baseline = base.length ? summarize(base) : null, scenario = scen.length ? summarize(scen) : null;
      return { date: day, jobs: jobs.length, baseline, scenario, delta: baseline && scenario ? { km: r2(scenario.km - baseline.km), cost: r2(scenario.cost - baseline.cost), unserved: scenario.unserved - baseline.unserved, late: scenario.late - baseline.late } : null };
    });
  }

  /* ---------------------------------------------------------------- driver preferences */
  @Get("preferences/:driverId")
  async getPrefs(@Req() req: AuthedRequest, @Param("driverId") id: string) {
    const orgId = requirePerm(req, "fleet.view");
    const r = (await withOrg(this.pool, orgId, (c) => c.query("SELECT preferences, skills FROM driver_profiles WHERE user_id = $1", [parseUuid(id)]))).rows[0];
    return { ...(r?.preferences ?? {}), skills: r?.skills ?? [] };
  }

  /** What a driver prefers: a day off, a most stops a day, customers to avoid, a home depot. Used when suggesting and assigning. */
  @Put("preferences/:driverId")
  async putPrefs(@Req() req: AuthedRequest, @Param("driverId") id: string, @Body() b: { maxStops?: unknown; avoidCustomers?: unknown; daysOff?: unknown; note?: unknown }) {
    const orgId = requirePerm(req, "fleet.manage");
    const out: Record<string, unknown> = {};
    if (b?.maxStops != null && b.maxStops !== "") { const n = Math.trunc(Number(b.maxStops)); if (!(n >= 1 && n <= 200)) throw new BadRequestException("maxStops must be 1 to 200"); out.maxStops = n; }
    if (b?.avoidCustomers != null) { if (!Array.isArray(b.avoidCustomers) || b.avoidCustomers.length > 50) throw new BadRequestException("avoidCustomers is a list of up to 50 names"); out.avoidCustomers = b.avoidCustomers.map((x) => text(x, 120)).filter(Boolean); }
    if (b?.daysOff != null) { if (!Array.isArray(b.daysOff) || b.daysOff.length > 366 || !b.daysOff.every((d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d)))) throw new BadRequestException("daysOff is a list of dates (YYYY-MM-DD)"); out.daysOff = b.daysOff; }
    if (b?.note != null) out.note = text(b.note, 300);
    const uid = parseUuid(id);
    await withOrg(this.pool, orgId, async (c) => {
      if (!(await c.query("SELECT 1 FROM users WHERE id = $1 AND role = 'driver'", [uid])).rowCount) throw new NotFoundException();
      await c.query(`INSERT INTO driver_profiles (user_id, org_id, preferences) VALUES ($1,$2,$3) ON CONFLICT (user_id) DO UPDATE SET preferences = $3, updated_at = now()`, [uid, orgId, JSON.stringify(out)]);
    });
    return { ok: true, preferences: out };
  }
}
