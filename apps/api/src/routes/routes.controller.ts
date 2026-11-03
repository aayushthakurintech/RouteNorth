import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException,
  Param, Patch, Post, Put, Query, Req, UseGuards,
} from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { classifyStop, type StopOutcome, type StopStatus } from "@routenorth/shared";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { PG_POOL } from "../tokens.js";
import { parseUuid } from "../history/range.js";
import { csvToObjects } from "./csv.js";
import { MAX_STOPS_PER_ROUTE, parseDate, parseName, parseStopInput, type StopInput } from "./validate.js";

const ROUTE_STATUSES = ["planned", "in_progress", "completed", "cancelled"];

const AVOIDS = ["tolls", "highways", "ferries", "unpaved"];
function objective(v: unknown): "time" | "distance" {
  if (v === undefined || v === null || v === "") return "time";
  if (v !== "time" && v !== "distance") throw new BadRequestException("objective must be time or distance");
  return v;
}
function avoidList(v: unknown): string[] {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.some((x) => !AVOIDS.includes(String(x)))) throw new BadRequestException(`avoid must list: ${AVOIDS.join(", ")}`);
  return [...new Set(v.map(String))];
}
function startTime(v: unknown): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string" || !/^([01][0-9]|2[0-3]):[0-5][0-9]$/.test(v)) throw new BadRequestException("startTime must be HH:MM");
  return v;
}

function requirePlanner(req: AuthedRequest): string {
  return requirePerm(req, "routes.write");
}

const STOP_COLUMNS = `id, route_id, sequence, name, address, lat, lng, radius_m AS "radiusM",
  window_start AS "windowStart", window_end AS "windowEnd", packages, notes, status,
  failure_reason AS "failureReason", eta, arrived_at AS "arrivedAt", departed_at AS "departedAt",
  weight_kg AS "weightKg", volume_m3 AS "volumeM3", service_min AS "serviceMin", priority, kind, job_id AS "jobId"`;

@Controller("routes")
@UseGuards(AuthGuard)
export class RoutesController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Create a route with its stops in order. */
  @Post()
  async create(
    @Req() req: AuthedRequest,
    @Body() body: { name?: unknown; date?: unknown; vehicleId?: unknown; driverId?: unknown; stops?: unknown; objective?: unknown; avoid?: unknown; depotId?: unknown; startTime?: unknown },
  ) {
    const orgId = requirePlanner(req);
    const name = parseName(body?.name);
    const date = parseDate(body?.date);
    const stops = this.parseStops(body?.stops ?? []);
    const vehicleId = body?.vehicleId == null ? null : parseUuid(String(body.vehicleId));
    const driverId = body?.driverId == null ? null : parseUuid(String(body.driverId));

    return withOrg(this.pool, orgId, async (c) => {
      await this.assertRefs(c, vehicleId, driverId);
      const route = (
        await c.query(
          `INSERT INTO routes (org_id, name, route_date, vehicle_id, driver_id, objective, avoid, depot_id, start_time)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [orgId, name, date, vehicleId, driverId, objective(body?.objective), avoidList(body?.avoid), body?.depotId == null ? null : parseUuid(String(body.depotId)),
            startTime(body?.startTime)],
        )
      ).rows[0];
      await this.insertStops(c, orgId, route.id, stops, 1);
      return this.load(c, route.id);
    });
  }

  /** Routes for a day, with how many stops are done. */
  @Get()
  async list(@Req() req: AuthedRequest, @Query("date") date?: string) {
    requirePerm(req, "routes.view");
    const day = parseDate(date);
    const rows = await withOrg(this.pool, req.session!.orgId, (c) =>
      c.query(
        `SELECT r.id, r.name, r.route_date::text AS date, r.status, r.vehicle_id AS "vehicleId", r.driver_id AS "driverId",
                count(s.id)::int AS "stopCount",
                count(s.id) FILTER (WHERE s.status IN ('done','failed','skipped'))::int AS "finishedCount"
         FROM routes r LEFT JOIN stops s ON s.route_id = r.id
         WHERE r.route_date = $1 GROUP BY r.id ORDER BY r.name`,
        [day],
      ),
    );
    return rows.rows;
  }

  /** Planned vs actual: how each stop went against its time window. */
  @Get(":id/report")
  async report(@Req() req: AuthedRequest, @Param("id") id: string) {
    requirePerm(req, "routes.view");
    const route = await withOrg(this.pool, req.session!.orgId, (c) => this.load(c, parseUuid(id)));
    if (!route) throw new NotFoundException();
    const iso = (d: Date | string | null) => (d ? new Date(d).toISOString() : null);
    const stops = route.stops.map((s: Record<string, any>) => {
      const arrivedAt = iso(s.arrivedAt);
      const departedAt = iso(s.departedAt);
      const outcome: StopOutcome = classifyStop({
        status: s.status as StopStatus, windowStart: iso(s.windowStart), windowEnd: iso(s.windowEnd), arrivedAt,
      });
      const lateByS = outcome === "late" ? Math.round((new Date(arrivedAt!).getTime() - new Date(iso(s.windowEnd)!).getTime()) / 1000) : 0;
      return {
        sequence: s.sequence, id: s.id, name: s.name, status: s.status, failureReason: s.failureReason,
        windowStart: iso(s.windowStart), windowEnd: iso(s.windowEnd), eta: iso(s.eta), arrivedAt, departedAt,
        dwellS: arrivedAt && departedAt ? Math.round((new Date(departedAt).getTime() - new Date(arrivedAt).getTime()) / 1000) : null,
        outcome, lateByS,
      };
    });
    const count = (o: StopOutcome) => stops.filter((s: { outcome: StopOutcome }) => s.outcome === o).length;
    const judged = count("on_time") + count("late") + count("early");
    return {
      route: { id: route.id, name: route.name, date: route.date, status: route.status, startedAt: iso(route.startedAt), completedAt: iso(route.completedAt) },
      summary: {
        total: stops.length,
        done: stops.filter((s: { status: string }) => s.status === "done").length,
        failed: stops.filter((s: { status: string }) => s.status === "failed").length,
        skipped: stops.filter((s: { status: string }) => s.status === "skipped").length,
        pending: stops.filter((s: { status: string }) => s.status === "pending" || s.status === "arrived").length,
        onTime: count("on_time"), early: count("early"), late: count("late"), noWindow: count("no_window"),
        // Early arrivals count as on time: the driver was there when the customer needed them.
        onTimePct: judged === 0 ? null : Math.round(((count("on_time") + count("early")) / judged) * 100),
      },
      stops,
    };
  }

  @Get(":id")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    requirePerm(req, "routes.view");
    const route = await withOrg(this.pool, req.session!.orgId, (c) => this.load(c, parseUuid(id)));
    if (!route) throw new NotFoundException();
    return route;
  }

  @Patch(":id")
  async update(
    @Req() req: AuthedRequest, @Param("id") id: string,
    @Body() body: { name?: unknown; vehicleId?: unknown; driverId?: unknown; status?: unknown; objective?: unknown; avoid?: unknown; depotId?: unknown; startTime?: unknown; notes?: unknown },
  ) {
    const orgId = requirePlanner(req);
    const routeId = parseUuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const sets: string[] = [];
      const vals: unknown[] = [];
      const add = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
      if (body?.objective !== undefined) add("objective", objective(body.objective));
      if (body?.avoid !== undefined) add("avoid", avoidList(body.avoid));
      if (body?.depotId !== undefined) add("depot_id", body.depotId === null ? null : parseUuid(String(body.depotId)));
      if (body?.startTime !== undefined) add("start_time", startTime(body.startTime));
      if (body?.notes !== undefined) add("notes", body.notes === null ? null : String(body.notes).slice(0, 2000));
      if (body?.name !== undefined) add("name", parseName(body.name));
      if (body?.status !== undefined) {
        if (typeof body.status !== "string" || !ROUTE_STATUSES.includes(body.status)) throw new BadRequestException("invalid status");
        add("status", body.status);
      }
      const vehicleId = body?.vehicleId === undefined ? undefined : body.vehicleId === null ? null : parseUuid(String(body.vehicleId));
      const driverId = body?.driverId === undefined ? undefined : body.driverId === null ? null : parseUuid(String(body.driverId));
      await this.assertRefs(c, vehicleId ?? null, driverId ?? null);
      if (vehicleId !== undefined) add("vehicle_id", vehicleId);
      if (driverId !== undefined) add("driver_id", driverId);
      if (sets.length === 0) throw new BadRequestException("nothing to update");
      vals.push(routeId);
      const res = await c.query(`UPDATE routes SET ${sets.join(", ")} WHERE id = $${vals.length}`, vals);
      if (res.rowCount === 0) throw new NotFoundException();
      return this.load(c, routeId);
    });
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePlanner(req);
    const res = await withOrg(this.pool, orgId, (c) => c.query("DELETE FROM routes WHERE id = $1", [parseUuid(id)]));
    if (res.rowCount === 0) throw new NotFoundException();
  }

  /** Append stops to a route. */
  @Post(":id/stops")
  async addStops(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { stops?: unknown }) {
    const orgId = requirePlanner(req);
    const routeId = parseUuid(id);
    const stops = this.parseStops(body?.stops);
    return withOrg(this.pool, orgId, async (c) => {
      await this.lockRoute(c, routeId);
      const count = (await c.query("SELECT count(*)::int AS n, coalesce(max(sequence), 0) AS m FROM stops WHERE route_id = $1", [routeId])).rows[0];
      if (count.n + stops.length > MAX_STOPS_PER_ROUTE) throw new BadRequestException(`a route can have at most ${MAX_STOPS_PER_ROUTE} stops`);
      await this.insertStops(c, orgId, routeId, stops, count.m + 1);
      return this.load(c, routeId);
    });
  }

  /** Import stops from CSV text (columns: name, address, lat, lng, window_start, window_end, packages, notes, radius_m). */
  @Post(":id/stops/import")
  async importStops(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { csv?: unknown }) {
    const orgId = requirePlanner(req);
    const routeId = parseUuid(id);
    if (typeof body?.csv !== "string") throw new BadRequestException("csv must be text");
    if (body.csv.length > 1_000_000) throw new BadRequestException("csv is too large");
    const rows = csvToObjects(body.csv);
    if (rows.length === 0) throw new BadRequestException("csv has no rows");
    const stops: StopInput[] = rows.map((r, i) => {
      try { return parseStopInput(r); }
      catch (e) { throw new BadRequestException(`row ${i + 2}: ${(e as Error).message}`); }
    });
    return withOrg(this.pool, orgId, async (c) => {
      await this.lockRoute(c, routeId);
      const count = (await c.query("SELECT count(*)::int AS n, coalesce(max(sequence), 0) AS m FROM stops WHERE route_id = $1", [routeId])).rows[0];
      if (count.n + stops.length > MAX_STOPS_PER_ROUTE) throw new BadRequestException(`a route can have at most ${MAX_STOPS_PER_ROUTE} stops`);
      await this.insertStops(c, orgId, routeId, stops, count.m + 1);
      return this.load(c, routeId);
    });
  }

  /** Reorder: send every stop id of the route in the new order. */
  @Put(":id/stops/order")
  async reorder(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { stopIds?: unknown }) {
    const orgId = requirePlanner(req);
    const routeId = parseUuid(id);
    if (!Array.isArray(body?.stopIds)) throw new BadRequestException("stopIds must be a list");
    const ids = body.stopIds.map((s) => parseUuid(String(s)));
    return withOrg(this.pool, orgId, async (c) => {
      await this.lockRoute(c, routeId);
      const existing = (await c.query<{ id: string }>("SELECT id FROM stops WHERE route_id = $1", [routeId])).rows.map((r) => r.id);
      if (ids.length !== existing.length || new Set(ids).size !== ids.length || !ids.every((i) => existing.includes(i))) {
        throw new BadRequestException("stopIds must list every stop of the route exactly once");
      }
      await c.query(
        `UPDATE stops s SET sequence = x.seq FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, seq)
         WHERE s.id = x.id AND s.route_id = $1`,
        [routeId, ids],
      );
      return this.load(c, routeId);
    });
  }

  /** Edit or manually set the status of one stop. */
  @Patch(":id/stops/:stopId")
  async updateStop(
    @Req() req: AuthedRequest, @Param("id") id: string, @Param("stopId") stopId: string,
    @Body() body: Record<string, unknown>,
  ) {
    const orgId = requirePlanner(req);
    const routeId = parseUuid(id);
    const sid = parseUuid(stopId);
    return withOrg(this.pool, orgId, async (c) => {
      const cur = (await c.query("SELECT * FROM stops WHERE id = $1 AND route_id = $2", [sid, routeId])).rows[0];
      if (!cur) throw new NotFoundException();
      const merged = parseStopInput({
        name: body.name ?? cur.name, address: body.address ?? cur.address, lat: body.lat ?? cur.lat, lng: body.lng ?? cur.lng,
        radiusM: body.radiusM ?? cur.radius_m, windowStart: body.windowStart ?? cur.window_start?.toISOString(),
        windowEnd: body.windowEnd ?? cur.window_end?.toISOString(), packages: body.packages ?? cur.packages, notes: body.notes ?? cur.notes,
        weightKg: body.weightKg ?? cur.weight_kg, volumeM3: body.volumeM3 ?? cur.volume_m3, serviceMin: body.serviceMin ?? cur.service_min,
        priority: body.priority ?? cur.priority, kind: body.kind ?? cur.kind, jobId: cur.job_id,
      });
      let status = cur.status as string;
      if (body.status !== undefined) {
        if (typeof body.status !== "string" || !["pending", "arrived", "done", "failed", "skipped"].includes(body.status)) {
          throw new BadRequestException("invalid status");
        }
        status = body.status;
      }
      const reason = body.failureReason === undefined ? cur.failure_reason : String(body.failureReason).slice(0, 300) || null;
      await c.query(
        `UPDATE stops SET name=$2, address=$3, lat=$4, lng=$5, radius_m=$6, window_start=$7, window_end=$8,
                packages=$9, notes=$10, status=$11, failure_reason=$12,
                weight_kg=$13, volume_m3=$14, service_min=$15, priority=$16, kind=$17 WHERE id = $1`,
        [sid, merged.name, merged.address, merged.lat, merged.lng, merged.radiusM, merged.windowStart, merged.windowEnd,
          merged.packages, merged.notes, status, reason, merged.weightKg, merged.volumeM3, merged.serviceMin, merged.priority, merged.kind],
      );
      return this.load(c, routeId);
    });
  }

  @Delete(":id/stops/:stopId")
  async removeStop(@Req() req: AuthedRequest, @Param("id") id: string, @Param("stopId") stopId: string) {
    const orgId = requirePlanner(req);
    const routeId = parseUuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      await this.lockRoute(c, routeId);
      const res = await c.query("DELETE FROM stops WHERE id = $1 AND route_id = $2", [parseUuid(stopId), routeId]);
      if (res.rowCount === 0) throw new NotFoundException();
      await c.query(
        `UPDATE stops s SET sequence = r.seq FROM
           (SELECT id, row_number() OVER (ORDER BY sequence)::int AS seq FROM stops WHERE route_id = $1) r
         WHERE s.id = r.id`,
        [routeId],
      );
      return this.load(c, routeId);
    });
  }

  // ---- helpers ----

  private parseStops(raw: unknown): StopInput[] {
    if (!Array.isArray(raw)) throw new BadRequestException("stops must be a list");
    if (raw.length > MAX_STOPS_PER_ROUTE) throw new BadRequestException(`a route can have at most ${MAX_STOPS_PER_ROUTE} stops`);
    return raw.map((s, i) => {
      try { return parseStopInput(s); }
      catch (e) { throw new BadRequestException(`stop ${i + 1}: ${(e as Error).message}`); }
    });
  }

  /** Vehicle and driver must belong to the caller's organization (the composite FKs enforce it too). */
  private async assertRefs(c: pg.PoolClient, vehicleId: string | null, driverId: string | null): Promise<void> {
    if (vehicleId && (await c.query("SELECT 1 FROM vehicles WHERE id = $1", [vehicleId])).rowCount === 0) {
      throw new BadRequestException("unknown vehicle");
    }
    if (driverId && (await c.query("SELECT 1 FROM users WHERE id = $1", [driverId])).rowCount === 0) {
      throw new BadRequestException("unknown driver");
    }
  }

  /** Serialize edits to one route's stop order, and 404 when it is not ours. */
  private async lockRoute(c: pg.PoolClient, routeId: string): Promise<void> {
    const r = await c.query("SELECT 1 FROM routes WHERE id = $1 FOR UPDATE", [routeId]);
    if (r.rowCount === 0) throw new NotFoundException();
  }

  private async insertStops(c: pg.PoolClient, orgId: string, routeId: string, stops: StopInput[], firstSeq: number): Promise<void> {
    for (const [i, s] of stops.entries()) {
      await c.query(
        `INSERT INTO stops (org_id, route_id, sequence, name, address, lat, lng, radius_m, window_start, window_end, packages, notes,
                            weight_kg, volume_m3, service_min, priority, kind, job_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [orgId, routeId, firstSeq + i, s.name, s.address, s.lat, s.lng, s.radiusM, s.windowStart, s.windowEnd, s.packages, s.notes,
          s.weightKg, s.volumeM3, s.serviceMin, s.priority, s.kind, s.jobId],
      );
    }
  }

  private async load(c: pg.PoolClient, routeId: string) {
    const route = (
      await c.query(
        `SELECT id, name, route_date::text AS date, status, vehicle_id AS "vehicleId", driver_id AS "driverId",
                started_at AS "startedAt", completed_at AS "completedAt", objective, avoid, depot_id AS "depotId",
                start_time::text AS "startTime", notes FROM routes WHERE id = $1`,
        [routeId],
      )
    ).rows[0];
    if (!route) return null;
    const stops = (await c.query(`SELECT ${STOP_COLUMNS} FROM stops WHERE route_id = $1 ORDER BY sequence`, [routeId])).rows;
    return { ...route, stops };
  }
}
