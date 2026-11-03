import {
  BadRequestException, Body, Controller, Get, Header, HttpException, Inject, NotFoundException, Param, Post, Put,
  Query, Req, Res, UseGuards,
} from "@nestjs/common";
import { pg, recomputeRouteStatus, withOrg } from "@routenorth/db";
import type { Response } from "express";
import { AuthGuard, hasPerm, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { parseDate } from "../routes/validate.js";
import { parseUuid } from "../history/range.js";
import { PG_POOL } from "../tokens.js";
import { MAX_PROOF_BYTES, PROOF_TYPES } from "../configure.js";
import { matchesImageType } from "./proof-files.js";

const STATUSES = ["pending", "arrived", "done", "failed", "skipped"];
const FINAL = ["done", "failed", "skipped"];
/** Offline phones may report actions late, but not absurdly old or from the future. */
const MAX_AGE_MS = 48 * 3_600_000;
const MAX_FUTURE_MS = 5 * 60_000;

function parseOccurred(v: unknown, now = Date.now()): Date {
  if (v === undefined || v === null || v === "") return new Date(now);
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) throw new BadRequestException("occurredAt must be an ISO 8601 timestamp");
  if (d.getTime() > now + MAX_FUTURE_MS) throw new BadRequestException("occurredAt is in the future");
  if (d.getTime() < now - MAX_AGE_MS) throw new BadRequestException("occurredAt is too old");
  return d;
}

function text(v: unknown, field: string, max: number): string | null | undefined {
  if (v === undefined) return undefined;
  if (v === null || v === "") return null;
  if (typeof v !== "string" || v.length > max) throw new BadRequestException(`${field} must be text up to ${max} characters`);
  return v.trim() || null;
}

@Controller("driver")
@UseGuards(AuthGuard)
export class DriverController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** The routes assigned to the logged-in driver for a day (default: today in the organization's time zone). */
  @Get("routes")
  async routes(@Req() req: AuthedRequest, @Query("date") date?: string) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    const day = date === undefined ? null : parseDate(date);
    return withOrg(this.pool, orgId, async (c) => {
      const routes = (
        await c.query(
          `SELECT r.id, r.name, r.route_date::text AS date, r.status FROM routes r
             JOIN organizations o ON o.id = r.org_id
           WHERE r.driver_id = $1 AND r.status <> 'cancelled'
             AND r.route_date = coalesce($2::date, (now() AT TIME ZONE o.timezone)::date)
           ORDER BY r.name`,
          [userId, day],
        )
      ).rows;
      for (const r of routes) {
        r.stops = (
          await c.query(
            `SELECT s.id, s.sequence, s.name, s.address, s.lat, s.lng, s.radius_m AS "radiusM", s.window_start AS "windowStart",
                    s.window_end AS "windowEnd", s.packages, s.notes, s.status, s.failure_reason AS "failureReason", s.eta,
                    s.arrived_at AS "arrivedAt", s.departed_at AS "departedAt", s.driver_notes AS "driverNotes",
                    s.recipient_name AS "recipientName",
                    (SELECT count(*)::int FROM proofs p WHERE p.stop_id = s.id) AS "proofCount"
             FROM stops s WHERE s.route_id = $1 ORDER BY s.sequence`,
            [r.id],
          )
        ).rows;
      }
      return routes;
    });
  }

  /**
   * Record what the driver did at a stop. Safe to replay: arrival and departure times keep the
   * first value, and a late "arrived" never undoes a finished stop.
   */
  @Post("stops/:stopId/status")
  async setStatus(
    @Req() req: AuthedRequest, @Param("stopId") stopId: string,
    @Body() body: { status?: unknown; occurredAt?: unknown; reason?: unknown; notes?: unknown; recipientName?: unknown },
  ) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    const id = parseUuid(stopId);
    if (typeof body?.status !== "string" || !STATUSES.includes(body.status)) throw new BadRequestException("invalid status");
    const status = body.status;
    const at = parseOccurred(body.occurredAt);
    const reason = text(body.reason, "reason", 300);
    const notes = text(body.notes, "notes", 1000);
    const recipient = text(body.recipientName, "recipientName", 120);

    return withOrg(this.pool, orgId, async (c) => {
      const cur = (
        await c.query(
          `SELECT s.status, s.route_id FROM stops s JOIN routes r ON r.id = s.route_id
           WHERE s.id = $1 AND r.driver_id = $2 FOR UPDATE OF s`,
          [id, userId],
        )
      ).rows[0];
      if (!cur) throw new NotFoundException();
      // A replayed "arrived" must not undo a stop that is already finished.
      const next = status === "arrived" && FINAL.includes(cur.status) ? cur.status : status;
      await c.query(
        `UPDATE stops SET
           status = $2,
           arrived_at = CASE WHEN $2 = 'pending' THEN NULL WHEN $2 IN ('arrived','done') THEN coalesce(arrived_at, $3) ELSE arrived_at END,
           departed_at = CASE WHEN $2 = 'pending' THEN NULL WHEN $2 = 'done' THEN coalesce(departed_at, $3) ELSE departed_at END,
           inside_since = NULL, outside_since = NULL,
           failure_reason = CASE WHEN $2 IN ('failed','skipped') THEN coalesce($4, failure_reason) ELSE NULL END,
           driver_notes = CASE WHEN $5::boolean THEN $6 ELSE driver_notes END,
           recipient_name = CASE WHEN $7::boolean THEN $8 ELSE recipient_name END
         WHERE id = $1`,
        [id, next, at, reason === undefined ? null : reason, notes !== undefined, notes ?? null, recipient !== undefined, recipient ?? null],
      );
      await recomputeRouteStatus(c, cur.route_id, at.toISOString());
      const stop = (
        await c.query(
          `SELECT id, status, arrived_at AS "arrivedAt", departed_at AS "departedAt", failure_reason AS "failureReason",
                  driver_notes AS "driverNotes", recipient_name AS "recipientName" FROM stops WHERE id = $1`,
          [id],
        )
      ).rows[0];
      const route = (await c.query("SELECT status FROM routes WHERE id = $1", [cur.route_id])).rows[0];
      return { stop, routeStatus: route.status };
    });
  }

  /** The vehicle on the driver's routes today (what they will check out). */
  @Get("vehicle")
  async myVehicle(@Req() req: AuthedRequest) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    return withOrg(this.pool, orgId, async (c) => (await c.query(
      `SELECT v.id, v.name, v.plate, v.kind, v.odometer_km AS "odometerKm" FROM routes r JOIN vehicles v ON v.id = r.vehicle_id JOIN organizations o ON o.id = r.org_id
       WHERE r.driver_id = $1 AND r.status <> 'cancelled' AND r.route_date = (now() AT TIME ZONE o.timezone)::date ORDER BY r.created_at LIMIT 1`, [userId])).rows[0] ?? null);
  }

  /** Vehicle check-out or check-in with the inspection checklist. Any failed item records a defect. */
  @Post("inspections")
  async inspect(@Req() req: AuthedRequest, @Body() body: { vehicleId?: unknown; kind?: unknown; items?: unknown; odometerKm?: unknown; notes?: unknown }) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    if (body?.kind !== "check_out" && body?.kind !== "check_in") throw new BadRequestException("kind must be check_out or check_in");
    if (!Array.isArray(body.items) || body.items.length === 0 || body.items.length > 60) throw new BadRequestException("items must be a checklist");
    const items = body.items.map((i) => {
      const o = i as { key?: unknown; ok?: unknown; note?: unknown };
      if (typeof o.key !== "string" || !o.key || o.key.length > 60 || typeof o.ok !== "boolean") throw new BadRequestException("each item needs a key and ok true or false");
      return { key: o.key, ok: o.ok, note: o.note ? String(o.note).slice(0, 300) : undefined };
    });
    const odo = body.odometerKm == null || body.odometerKm === "" ? null : Number(body.odometerKm);
    if (odo !== null && !(odo >= 0 && odo < 10_000_000)) throw new BadRequestException("odometerKm must be a number");
    const vehicleId = parseUuid(String(body.vehicleId));
    return withOrg(this.pool, orgId, async (c) => {
      if (!(await c.query("SELECT 1 FROM vehicles WHERE id = $1", [vehicleId])).rowCount) throw new NotFoundException();
      const defects = items.some((i) => !i.ok);
      const row = (await c.query(
        `INSERT INTO inspections (org_id, vehicle_id, driver_id, kind, items, defects, odometer_km, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, defects, at`,
        [orgId, vehicleId, userId, body.kind, JSON.stringify(items), defects, odo, body.notes ? String(body.notes).slice(0, 2000) : null])).rows[0];
      if (odo !== null) await c.query("UPDATE vehicles SET odometer_km = greatest(odometer_km, $2) WHERE id = $1", [vehicleId, odo]);
      return row;
    });
  }

  /** Report an accident or incident from the road. */
  @Post("incidents")
  async reportIncident(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    const kind = String(body?.kind ?? "other");
    if (!["accident", "near_miss", "theft", "damage", "breakdown", "other"].includes(kind)) throw new BadRequestException("invalid kind");
    const severity = String(body?.severity ?? "minor");
    if (!["minor", "moderate", "major"].includes(severity)) throw new BadRequestException("invalid severity");
    const description = typeof body?.description === "string" ? body.description.trim() : "";
    if (!description || description.length > 4000) throw new BadRequestException("describe what happened (up to 4000 characters)");
    const lat = body?.lat == null ? null : Number(body.lat), lng = body?.lng == null ? null : Number(body.lng);
    if ((lat !== null && !(lat >= -90 && lat <= 90)) || (lng !== null && !(lng >= -180 && lng <= 180))) throw new BadRequestException("invalid coordinates");
    const vehicleId = body?.vehicleId ? parseUuid(String(body.vehicleId)) : null;
    return withOrg(this.pool, orgId, async (c) => {
      if (vehicleId && !(await c.query("SELECT 1 FROM vehicles WHERE id = $1", [vehicleId])).rowCount) throw new NotFoundException();
      return (await c.query(
        `INSERT INTO incidents (org_id, vehicle_id, driver_id, reported_by, kind, severity, description, lat, lng, location, injuries) VALUES ($1,$2,$3,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, occurred_at AS "occurredAt"`,
        [orgId, vehicleId, userId, kind, severity, description, lat, lng, body?.location ? String(body.location).slice(0, 300) : null, body?.injuries === true])).rows[0];
    });
  }

  /** Add a photo to an incident the driver reported. */
  @Put("incidents/:id/photos")
  async incidentPhoto(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown, @Query("name") name?: string) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    const iid = parseUuid(id);
    const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!PROOF_TYPES.includes(contentType)) throw new HttpException(`content type must be one of ${PROOF_TYPES.join(", ")}`, 415);
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException("image body required");
    if (body.length > MAX_PROOF_BYTES) throw new HttpException("image too large", 413);
    if (!matchesImageType(contentType, body)) throw new BadRequestException("file contents do not match the content type");
    return withOrg(this.pool, orgId, async (c) => {
      if (!(await c.query("SELECT 1 FROM incidents WHERE id = $1 AND reported_by = $2", [iid, userId])).rowCount) throw new NotFoundException();
      return (await c.query(
        `INSERT INTO attachments (org_id, owner_kind, owner_id, name, content_type, size_bytes, data, created_by) VALUES ($1,'incident',$2,$3,$4,$5,$6,$7) RETURNING id, name`,
        [orgId, iid, (name ?? "photo").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "photo", contentType, body.length, body, userId])).rows[0];
    });
  }

  /** Record a scanned barcode or typed package code at a stop (proof of delivery). Safe to replay with the same clientId. */
  @Post("stops/:stopId/scans")
  async scan(@Req() req: AuthedRequest, @Param("stopId") stopId: string, @Body() body: { code?: unknown; clientId?: unknown; scannedAt?: unknown }) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    const sid = parseUuid(stopId);
    const code = typeof body?.code === "string" ? body.code.trim() : "";
    if (!code || code.length > 200) throw new BadRequestException("code must be 1 to 200 characters");
    const clientId = body?.clientId == null ? null : parseUuid(String(body.clientId));
    const at = parseOccurred(body?.scannedAt);
    return withOrg(this.pool, orgId, async (c) => {
      const ok = (await c.query("SELECT 1 FROM stops s JOIN routes r ON r.id = s.route_id WHERE s.id = $1 AND r.driver_id = $2", [sid, userId])).rowCount;
      if (!ok) throw new NotFoundException();
      const ins = await c.query(
        `INSERT INTO stop_scans (org_id, stop_id, code, scanned_at, scanned_by, client_id) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (org_id, client_id) DO NOTHING RETURNING id, code, scanned_at AS "scannedAt"`, [orgId, sid, code, at, userId, clientId]);
      if (ins.rows[0]) return { ...ins.rows[0], duplicate: false };
      const old = (await c.query(`SELECT id, code, scanned_at AS "scannedAt" FROM stop_scans WHERE client_id = $1`, [clientId])).rows[0];
      return { ...old, duplicate: true };
    });
  }

  /**
   * Upload a proof image. The phone picks `clientId`, so retrying after a dropped connection
   * returns the file already stored instead of creating a duplicate.
   */
  @Put("stops/:stopId/proofs/:clientId")
  async uploadProof(
    @Req() req: AuthedRequest, @Param("stopId") stopId: string, @Param("clientId") clientId: string,
    @Body() body: unknown, @Query("kind") kind?: string, @Query("takenAt") takenAt?: string,
    @Query("lat") lat?: string, @Query("lng") lng?: string,
  ) {
    requirePerm(req, "driver.app");
    const { orgId, userId } = req.session!;
    const sid = parseUuid(stopId);
    const cid = parseUuid(clientId);
    const contentType = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!PROOF_TYPES.includes(contentType)) throw new HttpException(`content type must be one of ${PROOF_TYPES.join(", ")}`, 415);
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException("image body required");
    if (body.length > MAX_PROOF_BYTES) throw new HttpException("image too large", 413);
    if (!matchesImageType(contentType, body)) throw new BadRequestException("file contents do not match the content type");
    if (kind !== "photo" && kind !== "signature") throw new BadRequestException("kind must be photo or signature");
    const taken = parseOccurred(takenAt);
    const latN = lat === undefined ? null : Number(lat);
    const lngN = lng === undefined ? null : Number(lng);
    if ((latN !== null && !(latN >= -90 && latN <= 90)) || (lngN !== null && !(lngN >= -180 && lngN <= 180))) {
      throw new BadRequestException("invalid coordinates");
    }

    return withOrg(this.pool, orgId, async (c) => {
      const stop = (
        await c.query("SELECT 1 FROM stops s JOIN routes r ON r.id = s.route_id WHERE s.id = $1 AND r.driver_id = $2", [sid, userId])
      ).rowCount;
      if (!stop) throw new NotFoundException();
      const inserted = await c.query(
        `INSERT INTO proofs (org_id, stop_id, kind, content_type, size_bytes, data, taken_at, lat, lng, created_by, client_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (org_id, client_id) DO NOTHING
         RETURNING id, kind, size_bytes AS "sizeBytes", taken_at AS "takenAt"`,
        [orgId, sid, kind, contentType, body.length, body, taken, latN, lngN, userId, cid],
      );
      if (inserted.rows[0]) return { ...inserted.rows[0], duplicate: false };
      const existing = (
        await c.query(`SELECT id, kind, size_bytes AS "sizeBytes", taken_at AS "takenAt", stop_id FROM proofs WHERE client_id = $1`, [cid])
      ).rows[0];
      if (!existing || existing.stop_id !== sid) throw new BadRequestException("clientId already used");
      return { id: existing.id, kind: existing.kind, sizeBytes: existing.sizeBytes, takenAt: existing.takenAt, duplicate: true };
    });
  }
}

/** Reading proofs: dispatchers see all of the organization's; drivers only their own routes'. */
@Controller()
@UseGuards(AuthGuard)
export class ProofsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  private async canSee(c: pg.PoolClient, req: AuthedRequest, stopId: string): Promise<boolean> {
    if (!hasPerm(req, "routes.view", "driver.app")) return false;
    const { role, userId } = req.session!;
    const r = await c.query("SELECT r.driver_id FROM stops s JOIN routes r ON r.id = s.route_id WHERE s.id = $1", [stopId]);
    if (r.rowCount === 0) return false;
    return role !== "driver" || r.rows[0].driver_id === userId;
  }

  @Get("stops/:stopId/scans")
  async scans(@Req() req: AuthedRequest, @Param("stopId") stopId: string) {
    const sid = parseUuid(stopId);
    return withOrg(this.pool, req.session!.orgId, async (c) => {
      if (!(await this.canSee(c, req, sid))) throw new NotFoundException();
      return (await c.query(`SELECT id, code, scanned_at AS "scannedAt" FROM stop_scans WHERE stop_id = $1 ORDER BY scanned_at`, [sid])).rows;
    });
  }

  @Get("stops/:stopId/proofs")
  async list(@Req() req: AuthedRequest, @Param("stopId") stopId: string) {
    const sid = parseUuid(stopId);
    return withOrg(this.pool, req.session!.orgId, async (c) => {
      if (!(await this.canSee(c, req, sid))) throw new NotFoundException();
      return (
        await c.query(
          `SELECT id, kind, size_bytes AS "sizeBytes", taken_at AS "takenAt", lat, lng FROM proofs WHERE stop_id = $1 ORDER BY taken_at`,
          [sid],
        )
      ).rows;
    });
  }

  @Get("proofs/:id")
  @Header("Cache-Control", "private, max-age=3600")
  @Header("X-Content-Type-Options", "nosniff")
  async file(@Req() req: AuthedRequest, @Param("id") id: string, @Res() res: Response) {
    const pid = parseUuid(id);
    const proof = await withOrg(this.pool, req.session!.orgId, async (c) => {
      const row = (await c.query("SELECT stop_id, content_type, data FROM proofs WHERE id = $1", [pid])).rows[0];
      if (!row || !(await this.canSee(c, req, row.stop_id))) return null;
      return row as { content_type: string; data: Buffer };
    });
    if (!proof) throw new NotFoundException();
    res.type(proof.content_type).send(proof.data);
  }
}
