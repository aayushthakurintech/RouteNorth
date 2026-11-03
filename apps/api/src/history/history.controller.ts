import { Controller, Get, HttpException, Inject, NotFoundException, Param, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { dailyTotals, detectTrips, type Fix } from "@routenorth/shared";
import { offShiftSql } from "../security/privacy.js";
import { withDefaults } from "../org/settings.js";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { PG_POOL } from "../tokens.js";
import { parseRange, parseTimeZone, parseUuid } from "./range.js";

/** Most rows a single history request may load. Bigger ranges must be narrowed. */
const MAX_ROWS = 200_000;

interface Row { device_id: string; time: Date; lat: number; lng: number; speed: number; ignition: boolean | null; odometer: number | null }

const toFix = (r: Row): Fix => ({
  time: r.time.toISOString(), lat: r.lat, lng: r.lng, speed: r.speed, ignition: r.ignition, odometer: r.odometer,
});

@Controller()
@UseGuards(AuthGuard)
export class HistoryController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** All fixes in range, oldest first, for one device (or the whole organization when deviceId is null). */
  private async load(orgId: string, deviceId: string | null, from: Date, to: Date): Promise<Row[]> {
    const res = await withOrg(this.pool, orgId, async (c) => {
      const priv = withDefaults((await c.query("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0]?.settings).trackOnlyDuringShift;
      return c.query<Row>(
        `SELECT device_id, time, lat, lng, speed, ignition, odometer FROM positions
         WHERE time >= $1 AND time < $2 AND ($3::uuid IS NULL OR device_id = $3)${priv ? ` AND NOT ${offShiftSql("positions.time", "positions.device_id")}` : ""}
         ORDER BY device_id, time LIMIT ${MAX_ROWS + 1}`,
        [from, to, deviceId],
      );
    },
    );
    if (res.rows.length > MAX_ROWS) throw new HttpException("too much data in range; choose a shorter range", 413);
    return res.rows;
  }

  private async assertDevice(orgId: string, deviceId: string): Promise<void> {
    const found = await withOrg(this.pool, orgId, (c) => c.query("SELECT 1 FROM devices WHERE id = $1", [deviceId]));
    if (found.rowCount === 0) throw new NotFoundException();
  }

  /** The path a vehicle drove, for replay. */
  @Get("vehicles/:deviceId/track")
  async track(
    @Req() req: AuthedRequest, @Param("deviceId") deviceId: string,
    @Query("from") from?: string, @Query("to") to?: string,
  ) {
    requirePerm(req, "fleet.view");
    const range = parseRange(from, to, 7);
    const orgId = req.session!.orgId;
    await this.assertDevice(orgId, parseUuid(deviceId));
    const rows = await this.load(orgId, deviceId, range.from, range.to);
    return rows.map((r) => ({
      time: r.time.toISOString(), lat: r.lat, lng: r.lng, speed: r.speed, ignition: r.ignition,
    }));
  }

  /** Trips and stops for one vehicle. */
  @Get("vehicles/:deviceId/trips")
  async trips(
    @Req() req: AuthedRequest, @Param("deviceId") deviceId: string,
    @Query("from") from?: string, @Query("to") to?: string,
  ) {
    requirePerm(req, "fleet.view");
    const range = parseRange(from, to, 31);
    const orgId = req.session!.orgId;
    await this.assertDevice(orgId, parseUuid(deviceId));
    const rows = await this.load(orgId, deviceId, range.from, range.to);
    return detectTrips(rows.map(toFix));
  }

  /** Distance, moving time and idle time per vehicle per local day. */
  @Get("reports/daily")
  async daily(
    @Req() req: AuthedRequest, @Query("from") from?: string, @Query("to") to?: string, @Query("tz") tz?: string,
  ) {
    requirePerm(req, "reports.view");
    const range = parseRange(from, to, 14);
    const zone = parseTimeZone(tz);
    const { byDevice, names } = await this.fleetFixes(req.session!.orgId, range.from, range.to);
    const out: { deviceId: string; name: string; date: string; distanceM: number; idleS: number; movingS: number }[] = [];
    for (const [deviceId, fixes] of byDevice) {
      for (const d of dailyTotals(fixes, zone)) out.push({ deviceId, name: names.get(deviceId) ?? deviceId, ...d });
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.name.localeCompare(b.name));
  }

  /** Idle report: where and how long each vehicle sat with its engine running. */
  @Get("reports/idle")
  async idle(@Req() req: AuthedRequest, @Query("from") from?: string, @Query("to") to?: string) {
    requirePerm(req, "reports.view");
    const range = parseRange(from, to, 14);
    const { byDevice, names } = await this.fleetFixes(req.session!.orgId, range.from, range.to);
    const vehicles = [];
    for (const [deviceId, fixes] of byDevice) {
      const { stops } = detectTrips(fixes);
      const idleStops = stops.filter((s) => s.idling).map((s) => ({
        time: s.start.time, lat: s.start.lat, lng: s.start.lng, durationS: s.durationS,
      }));
      const totalIdleS = dailyTotals(fixes).reduce((sum, d) => sum + d.idleS, 0);
      vehicles.push({ deviceId, name: names.get(deviceId) ?? deviceId, totalIdleS, idleStops });
    }
    return vehicles.sort((a, b) => b.totalIdleS - a.totalIdleS);
  }

  private async fleetFixes(orgId: string, from: Date, to: Date) {
    const rows = await this.load(orgId, null, from, to);
    const byDevice = new Map<string, Fix[]>();
    for (const r of rows) {
      const list = byDevice.get(r.device_id) ?? [];
      list.push(toFix(r));
      byDevice.set(r.device_id, list);
    }
    const named = await withOrg(this.pool, orgId, (c) =>
      c.query<{ id: string; name: string }>(
        "SELECT d.id, coalesce(v.name, d.external_id) AS name FROM devices d LEFT JOIN vehicles v ON v.id = d.vehicle_id",
      ),
    );
    return { byDevice, names: new Map(named.rows.map((r) => [r.id, r.name])) };
  }
}
