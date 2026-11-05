import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { deviceHealth } from "@routenorth/shared";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { parseUuid } from "../history/range.js";
import { PG_POOL } from "../tokens.js";

const SOURCES = ["traccar", "api"] as const;
const text = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Trackers: register them, see whether each one is healthy, and see what the pipeline accepted and refused. */
@Controller("devices")
@UseGuards(AuthGuard)
export class DevicesController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "fleet.view");
    const rows = (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT d.id, d.source, d.external_id, d.label, d.model, d.vehicle_id, v.name AS vehicle_name, d.created_at,
              lp.time AS last_seen, lp.received_at, lp.speed, lp.ignition, lp.satellites, lp.hdop, lp.battery_pct, lp.ext_voltage,
              lp.fuel_level_pct, lp.signal, lp.engine_hours, lp.odometer
       FROM devices d LEFT JOIN vehicles v ON v.id = d.vehicle_id LEFT JOIN latest_positions lp ON lp.device_id = d.id
       ORDER BY coalesce(v.name, d.label, d.external_id)`))).rows;
    const now = new Date();
    return rows.map((r) => {
      const lastSeen = r.last_seen ? new Date(r.last_seen).toISOString() : null;
      const active = r.ignition === true || (r.speed ?? 0) >= 3;
      const health = deviceHealth({ lastSeen, satellites: r.satellites, batteryPct: r.battery_pct, extVoltage: r.ext_voltage, signal: r.signal, active }, now);
      return {
        id: r.id, source: r.source, externalId: r.external_id, label: r.label, model: r.model,
        vehicleId: r.vehicle_id, vehicleName: r.vehicle_name, lastSeen,
        satellites: r.satellites, hdop: r.hdop, batteryPct: r.battery_pct, extVoltage: r.ext_voltage, fuelLevelPct: r.fuel_level_pct,
        signal: r.signal, engineHours: r.engine_hours, odometerKm: r.odometer != null ? Math.round(r.odometer / 100) / 10 : null,
        health: health.state, issues: health.issues,
      };
    });
  }

  @Post()
  async register(@Req() req: AuthedRequest, @Body() body: { source?: string; externalId?: string; vehicleId?: string | null; label?: string; model?: string }) {
    const orgId = requirePerm(req, "fleet.manage");
    const source = (SOURCES as readonly string[]).includes(body.source ?? "traccar") ? (body.source ?? "traccar") : null;
    if (!source) throw new BadRequestException("source must be traccar or api");
    const externalId = text(body.externalId, 80);
    if (!/^[A-Za-z0-9._:-]{3,80}$/.test(externalId)) throw new BadRequestException("The tracker ID (usually the IMEI) must be 3 to 80 letters, digits or . _ : -");
    const vehicleId = body.vehicleId ? parseUuid(body.vehicleId) : null;
    try {
      return await withOrg(this.pool, orgId, async (c) => {
        if (vehicleId) {
          const v = await c.query("SELECT 1 FROM vehicles WHERE id = $1", [vehicleId]);
          if (!v.rowCount) throw new NotFoundException("Vehicle not found");
        }
        const r = await c.query("INSERT INTO devices (org_id, source, external_id, vehicle_id, label, model) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [orgId, source, externalId, vehicleId, text(body.label, 80) || null, text(body.model, 80) || null]);
        return { id: r.rows[0].id as string };
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ConflictException("That tracker ID is already registered (possibly by another company).");
      throw e;
    }
  }

  @Patch(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { vehicleId?: string | null; label?: string; model?: string }) {
    const orgId = requirePerm(req, "fleet.manage");
    const did = parseUuid(id);
    const vehicleId = body.vehicleId === undefined ? undefined : body.vehicleId ? parseUuid(body.vehicleId) : null;
    return withOrg(this.pool, orgId, async (c) => {
      if (vehicleId) {
        if (!(await c.query("SELECT 1 FROM vehicles WHERE id = $1", [vehicleId])).rowCount) throw new NotFoundException("Vehicle not found");
      }
      const r = await c.query(
        `UPDATE devices SET vehicle_id = CASE WHEN $2::boolean THEN $3::uuid ELSE vehicle_id END,
           label = coalesce($4, label), model = coalesce($5, model) WHERE id = $1 RETURNING id`,
        [did, vehicleId !== undefined, vehicleId ?? null, body.label === undefined ? null : text(body.label, 80), body.model === undefined ? null : text(body.model, 80)]);
      if (!r.rowCount) throw new NotFoundException("Tracker not found");
      return { ok: true };
    });
  }

  /** Only a tracker that never reported can be removed. One with history is unassigned instead, so no trip data is lost. */
  @Delete(":id")
  @HttpCode(200)
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "fleet.manage");
    const did = parseUuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      if (!(await c.query("SELECT 1 FROM devices WHERE id = $1", [did])).rowCount) throw new NotFoundException("Tracker not found");
      if ((await c.query("SELECT 1 FROM positions WHERE device_id = $1 LIMIT 1", [did])).rowCount) {
        throw new ConflictException("This tracker has location history, so it cannot be deleted. Unassign it from the vehicle instead.");
      }
      await c.query("DELETE FROM devices WHERE id = $1", [did]);
      return { ok: true };
    });
  }

  /** What the pipeline did with incoming positions over the last days: stored, kept lean, or refused (with the reason). */
  @Get("quality")
  async quality(@Req() req: AuthedRequest, @Query("days") days?: string) {
    const orgId = requirePerm(req, "fleet.view");
    const n = Math.max(1, Math.min(30, Number(days) || 7));
    const rows = (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT outcome, sum(n)::bigint AS n FROM ingest_counters WHERE day >= (now() AT TIME ZONE 'UTC')::date - $1::int + 1 GROUP BY outcome ORDER BY n DESC`, [n]))).rows;
    const by: Record<string, number> = {};
    for (const r of rows) by[r.outcome] = Number(r.n);
    const total = Object.values(by).reduce((a, b) => a + b, 0);
    const accepted = (by.stored ?? 0) + (by.latest_only ?? 0) + (by.history_only ?? 0);
    const rejected = Object.entries(by).filter(([k]) => k.startsWith("rejected:")).reduce((a, [, v]) => a + v, 0);
    return {
      days: n, total, accepted, rejected, duplicates: by.duplicate ?? 0,
      acceptedPct: total ? Math.round((accepted / total) * 1000) / 10 : null,
      outcomes: Object.entries(by).map(([outcome, count]) => ({ outcome, count })),
    };
  }

  /** Alarms the trackers raised themselves (SOS, harsh braking, power cut…), newest first. */
  @Get("events")
  async events(@Req() req: AuthedRequest, @Query("limit") limit?: string) {
    const orgId = requirePerm(req, "fleet.view");
    const n = Math.max(1, Math.min(200, Number(limit) || 50));
    const rows = (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT e.id, e.time, e.kind, e.severity, e.lat, e.lng, d.id AS device_id, coalesce(v.name, d.label, d.external_id) AS name
       FROM device_events e JOIN devices d ON d.id = e.device_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
       WHERE e.kind NOT IN ('ignition_on','ignition_off') ORDER BY e.time DESC LIMIT $1`, [n]))).rows;
    return rows.map((r) => ({ id: r.id, time: new Date(r.time).toISOString(), kind: r.kind, severity: r.severity, lat: r.lat, lng: r.lng, deviceId: r.device_id, name: r.name }));
  }
}
