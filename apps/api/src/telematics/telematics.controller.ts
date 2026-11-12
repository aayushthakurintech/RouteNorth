import { BadRequestException, Controller, Get, HttpException, Inject, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import {
  DEFAULT_TANK_LITRES, RULE_SETS, dailyTotals, detectTrips, dutyLogFromShifts, fuelEvents, hosClocks, idleCost, idleEpisodes, idlePercent, utilization, vehicleClass,
  type Fix, type FuelSample, type RuleSetId,
} from "@routenorth/shared";
import { AuthGuard, requireAny, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { parseRange, parseTimeZone } from "../history/range.js";
import { withDefaults } from "../org/settings.js";
import { offShiftSql } from "../security/privacy.js";
import { PG_POOL } from "../tokens.js";

const MAX_ROWS = 300_000;
const DAY = 86_400_000;

interface Row { device_id: string; time: Date; lat: number; lng: number; speed: number; ignition: boolean | null; odometer: number | null; fuel: number | null }
const toFix = (r: Row): Fix => ({ time: r.time.toISOString(), lat: r.lat, lng: r.lng, speed: r.speed, ignition: r.ignition, odometer: r.odometer });

interface DeviceInfo { deviceId: string; vehicleId: string | null; name: string; kind: string | null; tankLitres: number | null; fuelType: string | null }

/** Calculations over stored positions: idling, utilization, fuel events and hours-of-service clocks. */
@Controller("telematics")
@UseGuards(AuthGuard)
export class TelematicsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  private async devices(orgId: string, deviceIds?: string[]): Promise<Map<string, DeviceInfo>> {
    const rows = (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT d.id, v.id AS vehicle_id, coalesce(v.name, d.label, d.external_id) AS name, v.kind, v.tank_litres, v.fuel_type
       FROM devices d LEFT JOIN vehicles v ON v.id = d.vehicle_id WHERE ($1::uuid[] IS NULL OR d.id = ANY($1))`, [deviceIds ?? null]))).rows;
    return new Map(rows.map((r) => [r.id, { deviceId: r.id, vehicleId: r.vehicle_id, name: r.name, kind: r.kind, tankLitres: r.tank_litres != null ? Number(r.tank_litres) : null, fuelType: r.fuel_type }]));
  }

  private async load(orgId: string, from: Date, to: Date, deviceIds?: string[]): Promise<Map<string, Row[]>> {
    const res = await withOrg(this.pool, orgId, async (c) => {
      const priv = withDefaults((await c.query("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0]?.settings).trackOnlyDuringShift;
      return c.query<Row>(
        `SELECT device_id, time, lat, lng, speed, ignition, odometer, fuel_level_pct AS fuel FROM positions
         WHERE time >= $1 AND time < $2 AND ($3::uuid[] IS NULL OR device_id = ANY($3))${priv ? ` AND NOT ${offShiftSql("positions.time", "positions.device_id")}` : ""}
         ORDER BY device_id, time LIMIT ${MAX_ROWS + 1}`, [from, to, deviceIds ?? null]);
    });
    if (res.rows.length > MAX_ROWS) throw new HttpException("too much data in range; choose a shorter range", 413);
    const by = new Map<string, Row[]>();
    for (const r of res.rows) (by.get(r.device_id) ?? by.set(r.device_id, []).get(r.device_id)!).push(r);
    return by;
  }

  private async settings(orgId: string) {
    return withOrg(this.pool, orgId, async (c) => withDefaults((await c.query("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0]?.settings));
  }

  /** Idling: every engine-on stop of at least the organization's idle threshold, with fuel, money and CO2. */
  @Get("idling")
  async idling(@Req() req: AuthedRequest, @Query("from") from?: string, @Query("to") to?: string) {
    const orgId = requirePerm(req, "reports.view");
    const range = parseRange(from, to, 14);
    const s = await this.settings(orgId);
    const info = await this.devices(orgId);
    const by = await this.load(orgId, range.from, range.to);
    const price = s.costing?.fuelPricePerL ?? null;
    const vehicles = [];
    for (const [deviceId, rows] of by) {
      const d = info.get(deviceId);
      if (!d) continue;
      const fixes = rows.map(toFix);
      const eps = idleEpisodes(fixes, { minSeconds: s.idleThresholdMin * 60 });
      const days = dailyTotals(fixes);
      const idleS = days.reduce((a, x) => a + x.idleS, 0), movingS = days.reduce((a, x) => a + x.movingS, 0);
      const episodeS = eps.reduce((a, e) => a + e.durationS, 0);
      const cost = idleCost(episodeS, d.kind, { pricePerLitre: price && price > 0 ? price : null, fuelType: d.fuelType === "gasoline" ? "gasoline" : "diesel" });
      vehicles.push({ deviceId, name: d.name, kind: vehicleClass(d.kind), idleS, movingS, idlePct: idlePercent(idleS, movingS), episodeS, episodes: eps.slice(0, 50), cost });
    }
    vehicles.sort((a, b) => b.episodeS - a.episodeS);
    const total = vehicles.reduce((a, v) => ({ episodeS: a.episodeS + v.episodeS, litres: a.litres + v.cost.litres, cost: a.cost + (v.cost.cost ?? 0), co2Kg: a.co2Kg + v.cost.co2Kg, episodes: a.episodes + v.episodes.length }), { episodeS: 0, litres: 0, cost: 0, co2Kg: 0, episodes: 0 });
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() }, thresholdMin: s.idleThresholdMin, fuelPricePerL: price,
      basis: "Idle fuel is an estimate from typical burn rates per vehicle type (litres per hour), not a measurement.",
      totals: { ...total, litres: Math.round(total.litres * 10) / 10, cost: price && price > 0 ? Math.round(total.cost * 100) / 100 : null, co2Kg: Math.round(total.co2Kg * 10) / 10 },
      vehicles,
    };
  }

  /** How hard each vehicle works: days used, share of the workday moving, and which are barely used. */
  @Get("utilization")
  async utilization(@Req() req: AuthedRequest, @Query("from") from?: string, @Query("to") to?: string, @Query("tz") tz?: string, @Query("workday") workday?: string) {
    const orgId = requirePerm(req, "reports.view");
    const range = parseRange(from, to, 14);
    const zone = parseTimeZone(tz);
    const wd = workday === undefined ? 10 : Number(workday);
    if (!Number.isFinite(wd) || wd < 1 || wd > 24) throw new BadRequestException("workday must be 1 to 24 hours");
    const info = await this.devices(orgId);
    const by = await this.load(orgId, range.from, range.to);
    const days = Math.max(1, Math.round((range.to.getTime() - range.from.getTime()) / DAY));
    const out = [];
    for (const d of info.values()) {
      if (!d.vehicleId) continue;
      const totals = dailyTotals((by.get(d.deviceId) ?? []).map(toFix), zone);
      // Days with no data at all count as unused days, so a parked vehicle is not hidden.
      const padded = totals.map((t) => ({ date: t.date, movingS: t.movingS, idleS: t.idleS, km: t.distanceM / 1000 }));
      while (padded.length < days) padded.push({ date: `none-${padded.length}`, movingS: 0, idleS: 0, km: 0 });
      out.push({ deviceId: d.deviceId, vehicleId: d.vehicleId, name: d.name, kind: vehicleClass(d.kind), km: Math.round(totals.reduce((a, t) => a + t.distanceM, 0) / 100) / 10, ...utilization(padded, { workdayHours: wd }) });
    }
    out.sort((a, b) => (a.daysUsedPct ?? 0) - (b.daysUsedPct ?? 0) || a.name.localeCompare(b.name));
    const used = out.filter((v) => v.level !== "none").length;
    return { range: { from: range.from.toISOString(), to: range.to.toISOString() }, workdayHours: wd, summary: { vehicles: out.length, used, light: out.filter((v) => v.level === "light").length, unused: out.length - used }, vehicles: out };
  }

  /** Refuels and suspected fuel drains from vehicles that have a fuel level sensor. */
  @Get("fuel-events")
  async fuel(@Req() req: AuthedRequest, @Query("from") from?: string, @Query("to") to?: string) {
    const orgId = requirePerm(req, "reports.view");
    const range = parseRange(from, to, 14);
    const info = await this.devices(orgId);
    const by = await this.load(orgId, range.from, range.to);
    const vehicles = [];
    for (const [deviceId, rows] of by) {
      const d = info.get(deviceId);
      const samples: FuelSample[] = rows.filter((r) => r.fuel != null).map((r) => ({ time: r.time.toISOString(), pct: r.fuel!, speed: r.speed, ignition: r.ignition }));
      if (!d || samples.length < 5) continue;
      const tank = d.tankLitres ?? DEFAULT_TANK_LITRES[vehicleClass(d.kind)];
      vehicles.push({ deviceId, name: d.name, tankLitres: tank, tankKnown: d.tankLitres != null, events: fuelEvents(samples, { tankLitres: tank }), lastPct: samples[samples.length - 1]!.pct });
    }
    return {
      range: { from: range.from.toISOString(), to: range.to.toISOString() },
      note: "A drain is a prompt to look, not proof of theft: sensors drift, and parking on a slope moves the reading. Set the tank size on the vehicle for litres to be accurate.",
      vehicles,
    };
  }

  /**
   * Hours-of-service clocks per driver, built from shifts, breaks and when the assigned vehicle was moving.
   * For awareness and planning: not a certified ELD and not the driver's official log.
   */
  @Get("hos")
  async hos(@Req() req: AuthedRequest, @Query("rule") rule?: string) {
    const orgId = requireAny(req, "reports.view", "drivers.view");
    const id = (rule ?? "canada_cycle1") as RuleSetId;
    if (!(id in RULE_SETS)) throw new BadRequestException(`rule must be one of ${Object.keys(RULE_SETS).join(", ")}`);
    const r = RULE_SETS[id];
    const now = new Date();
    const from = new Date(now.getTime() - (r.cycleDays + 1) * DAY);

    const { shifts, breaks, routes, names } = await withOrg(this.pool, orgId, async (c) => ({
      shifts: (await c.query("SELECT id, driver_id, started_at, ended_at FROM shifts WHERE started_at >= $1 OR ended_at IS NULL OR ended_at >= $1 ORDER BY started_at", [from])).rows,
      breaks: (await c.query("SELECT shift_id, started_at, ended_at FROM shift_breaks WHERE started_at >= $1 ORDER BY started_at", [from])).rows,
      routes: (await c.query("SELECT driver_id, vehicle_id, route_date::text AS d FROM routes WHERE route_date >= $1::date - 1 AND driver_id IS NOT NULL AND vehicle_id IS NOT NULL", [from])).rows,
      names: new Map((await c.query("SELECT id, coalesce(display_name, email) AS name FROM users WHERE role = 'driver'")).rows.map((u) => [u.id as string, u.name as string])),
    }));
    const drivers = [...new Set(shifts.map((s) => s.driver_id as string))].filter((d) => names.has(d));
    const vehiclesOf = new Map<string, Set<string>>();
    for (const rt of routes) (vehiclesOf.get(rt.driver_id) ?? vehiclesOf.set(rt.driver_id, new Set()).get(rt.driver_id)!).add(rt.vehicle_id);
    const devs = (await withOrg(this.pool, orgId, (c) => c.query("SELECT id, vehicle_id FROM devices WHERE vehicle_id IS NOT NULL"))).rows;
    const deviceOf = new Map<string, string[]>();
    for (const d of devs) (deviceOf.get(d.vehicle_id) ?? deviceOf.set(d.vehicle_id, []).get(d.vehicle_id)!).push(d.id);
    const wanted = [...new Set(drivers.flatMap((d) => [...(vehiclesOf.get(d) ?? [])].flatMap((v) => deviceOf.get(v) ?? [])))];
    const positions = wanted.length ? await this.load(orgId, from, now, wanted) : new Map<string, Row[]>();
    const tripsOf = new Map<string, { start: string; end: string }[]>();
    for (const [dev, rows] of positions) tripsOf.set(dev, detectTrips(rows.map(toFix)).trips.map((t) => ({ start: t.start.time, end: t.end.time })));

    const out = drivers.map((driverId) => {
      const mine = shifts.filter((s) => s.driver_id === driverId);
      const driving = [...(vehiclesOf.get(driverId) ?? [])].flatMap((v) => (deviceOf.get(v) ?? []).flatMap((d) => tripsOf.get(d) ?? []));
      const log = dutyLogFromShifts(
        mine.map((s) => ({
          start: new Date(s.started_at).toISOString(), end: s.ended_at ? new Date(s.ended_at).toISOString() : null,
          breaks: breaks.filter((b) => b.shift_id === s.id).map((b) => ({ start: new Date(b.started_at).toISOString(), end: b.ended_at ? new Date(b.ended_at).toISOString() : null })),
        })), driving);
      return { driverId, name: names.get(driverId)!, hasVehicleData: driving.length > 0, status: hosClocks(log, id, now) };
    }).sort((a, b) => (a.status.canDrive === b.status.canDrive ? a.status.driveMinutesLeft - b.status.driveMinutesLeft : a.status.canDrive ? 1 : -1));

    return {
      rule: id, label: r.label, rules: Object.values(RULE_SETS).map((x) => ({ id: x.id, label: x.label })),
      note: "Estimates from shifts, breaks and vehicle movement. Not a certified electronic logging device (ELD) and not the driver's official log.",
      drivers: out,
    };
  }
}
