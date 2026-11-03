import {
  BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, HttpException, Inject, NotFoundException, Param, Post, Put, Query, Req, Res, UseGuards,
} from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import {
  isRecurrence, makeTravel, occursOn, planFleet, upcoming, whatIfAdd, type PlanStop, type PlanVehicle, type Recurrence,
} from "@routenorth/shared";
import type { Response } from "express";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { ATTACHMENT_TYPES } from "../configure.js";
import { matchesImageType } from "../driver/proof-files.js";
import { parseUuid } from "../history/range.js";
import { hourIn, zonedToEpoch } from "../plan/time.js";
import { csvToObjects } from "../routes/csv.js";
import { parseDate } from "../routes/validate.js";
import { GEOCODER, PG_POOL } from "../tokens.js";
import type { Geocoder } from "./geocoder.js";
import {
  CANCEL_REASONS, RESCHEDULE_REASONS, event, loadJob, place, resequence, routeForDriver, unplace, type JobRow,
} from "./jobs.service.js";
import { generateRoutes } from "./templates.js";

const MAX_ATTACHMENT = 6 * 1024 * 1024;
const FLOW: Record<string, string[]> = {
  unassigned: ["assigned", "cancelled"],
  assigned: ["started", "arrived", "done", "failed", "cancelled", "unassigned"],
  started: ["arrived", "done", "failed", "cancelled", "assigned"],
  arrived: ["done", "failed", "started"],
  done: [],
  failed: ["assigned", "unassigned"],
  cancelled: ["unassigned"],
};

const priorityScore = (p: string) => ({ low: 0, normal: 1, high: 2, urgent: 3 })[p] ?? 1;

function reason(v: unknown, allowed: readonly string[], field = "reasonCode"): string {
  if (typeof v !== "string" || !allowed.includes(v)) throw new BadRequestException(`${field} must be one of ${allowed.join(", ")}`);
  return v;
}
const note = (v: unknown) => (v == null || v === "" ? null : String(v).slice(0, 500));

@Controller("jobs")
@UseGuards(AuthGuard)
export class DispatchController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(GEOCODER) private readonly geocoder: Geocoder | null) {}

  /** The dispatch board: every driver with their routes and stops for a day, plus jobs waiting for a driver. */
  @Get("board")
  async board(@Req() req: AuthedRequest, @Query("date") date?: string) {
    const orgId = requirePerm(req, "routes.view");
    const day = parseDate(date);
    return withOrg(this.pool, orgId, async (c) => {
      const drivers = (await c.query(
        `SELECT u.id, coalesce(u.display_name, u.email) AS name, dp.skills, dp.max_shift_min AS "maxShiftMin"
         FROM users u LEFT JOIN driver_profiles dp ON dp.user_id = u.id WHERE u.role = 'driver' AND u.disabled_at IS NULL ORDER BY name`)).rows;
      const routes = (await c.query(
        `SELECT r.id, r.name, r.status, r.driver_id AS "driverId", r.vehicle_id AS "vehicleId", v.name AS "vehicleName", v.capacity_kg AS "capacityKg"
         FROM routes r LEFT JOIN vehicles v ON v.id = r.vehicle_id WHERE r.route_date = $1 AND r.status <> 'cancelled' ORDER BY r.created_at`, [day])).rows;
      const stops = (await c.query(
        `SELECT s.id, s.route_id AS "routeId", s.sequence, s.name, s.status, s.job_id AS "jobId", s.eta, s.window_start AS "windowStart", s.window_end AS "windowEnd",
                s.priority, s.weight_kg AS "weightKg", s.lat, s.lng
         FROM stops s JOIN routes r ON r.id = s.route_id WHERE r.route_date = $1 AND r.status <> 'cancelled' ORDER BY s.route_id, s.sequence`, [day])).rows;
      const unassigned = (await c.query(
        `SELECT id, title, type, priority, address, lat, lng, window_start AS "windowStart", window_end AS "windowEnd", weight_kg AS "weightKg", customer_name AS "customerName", tags
         FROM jobs WHERE status = 'unassigned' AND (scheduled_date = $1 OR scheduled_date IS NULL)
         ORDER BY CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END, created_at`, [day])).rows;
      return {
        date: day, drivers,
        routes: routes.map((r) => ({ ...r, stops: stops.filter((s) => s.routeId === r.id) })),
        unassigned,
      };
    });
  }

  @Get(":id")
  async get(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "routes.view");
    const jobId = parseUuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const job = (await c.query(`SELECT *, scheduled_date::text AS scheduled_date FROM jobs WHERE id = $1`, [jobId])).rows[0];
      if (!job) throw new NotFoundException();
      const events = (await c.query(`SELECT e.id, e.at, e.kind, e.detail, coalesce(u.display_name, u.email) AS actor FROM job_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.job_id = $1 ORDER BY e.at, e.id`, [jobId])).rows;
      const attachments = (await c.query(`SELECT id, name, content_type AS "contentType", size_bytes AS "sizeBytes", created_at AS "createdAt" FROM attachments WHERE owner_kind = 'job' AND owner_id = $1 ORDER BY created_at`, [jobId])).rows;
      const stop = job.stop_id ? (await c.query(`SELECT id, status, eta, arrived_at AS "arrivedAt", departed_at AS "departedAt", failure_reason AS "failureReason", recipient_name AS "recipientName", (SELECT count(*)::int FROM proofs p WHERE p.stop_id = stops.id) AS "proofCount" FROM stops WHERE id = $1`, [job.stop_id])).rows[0] : null;
      return { job, events, attachments, stop };
    });
  }

  /** Assign (or reassign live, or unassign with driverId null). Optional routeId and position choose where it goes. */
  @Post(":id/assign")
  async assign(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { driverId?: unknown; routeId?: unknown; position?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const jobId = parseUuid(id);
    const position = body?.position == null ? null : Number(body.position);
    if (position !== null && (!Number.isInteger(position) || position < 0)) throw new BadRequestException("position must be 0 or more");
    return withOrg(this.pool, orgId, async (c) => {
      const job = await loadJob(c, jobId, true);
      if (["done", "cancelled"].includes(job.status)) throw new ConflictException(`a ${job.status} job cannot be reassigned`);
      if (body?.driverId == null && body?.routeId == null) {
        await unplace(c, job);
        await c.query("UPDATE jobs SET driver_id = NULL, vehicle_id = NULL, status = 'unassigned', updated_at = now() WHERE id = $1", [jobId]);
        await event(c, orgId, jobId, "unassigned", req.session!.userId);
        return { jobId, status: "unassigned" };
      }
      let routeId: string;
      if (body.routeId != null) {
        routeId = parseUuid(String(body.routeId));
      } else {
        const driverId = parseUuid(String(body.driverId));
        const d = (await c.query("SELECT coalesce(display_name, email) AS name FROM users WHERE id = $1 AND role = 'driver' AND disabled_at IS NULL", [driverId])).rows[0];
        if (!d) throw new BadRequestException("unknown driver");
        const day = job.scheduled_date ?? (await c.query("SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM organizations")).rows[0].d;
        routeId = await routeForDriver(c, orgId, driverId, day, d.name);
        if (!job.scheduled_date) await c.query("UPDATE jobs SET scheduled_date = $2 WHERE id = $1", [jobId, day]);
      }
      const placed = await place(c, orgId, job, routeId, position, req.session!.userId);
      const out = await loadJob(c, jobId);
      return { jobId, status: out.status, routeId, driverId: out.driver_id, ...placed };
    });
  }

  /** Suggest (or apply) the best driver for waiting jobs, spreading work and respecting skills, capacity, shifts and windows. */
  @Post("auto-assign")
  async autoAssign(@Req() req: AuthedRequest, @Body() body: { date?: unknown; jobIds?: unknown; apply?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const day = parseDate(body?.date);
    const only = Array.isArray(body?.jobIds) ? body.jobIds.map((x) => parseUuid(String(x))) : null;
    return withOrg(this.pool, orgId, async (c) => {
      const org = (await c.query<{ timezone: string }>("SELECT timezone FROM organizations WHERE id = $1", [orgId])).rows[0]!;
      const jobs = (await c.query<JobRow>(
        `SELECT *, scheduled_date::text AS scheduled_date FROM jobs WHERE status = 'unassigned' AND lat IS NOT NULL
           AND (scheduled_date = $1 OR scheduled_date IS NULL) ${only ? "AND id = ANY($2::uuid[])" : ""} ORDER BY created_at LIMIT 300`, only ? [day, only] : [day])).rows;
      if (jobs.length === 0) return { proposals: [], unassigned: [], applied: false };
      const drivers = (await c.query(
        `SELECT u.id, coalesce(u.display_name, u.email) AS name, dp.skills, dp.max_shift_min, dp.break_after_min, dp.break_min FROM users u
         LEFT JOIN driver_profiles dp ON dp.user_id = u.id WHERE u.role = 'driver' AND u.disabled_at IS NULL ORDER BY name`)).rows;
      if (drivers.length === 0) return { proposals: [], unassigned: jobs.map((j) => ({ jobId: j.id, reason: "no drivers" })), applied: false };
      const depot = (await c.query("SELECT lat, lng FROM depots ORDER BY created_at LIMIT 1")).rows[0];
      const centre = { lat: jobs.reduce((a, j) => a + j.lat!, 0) / jobs.length, lng: jobs.reduce((a, j) => a + j.lng!, 0) / jobs.length };
      const shiftStart = zonedToEpoch(day, "08:00", org.timezone);
      const seed = new Map<string, PlanStop[]>();
      const seedStopIds = new Map<string, string>();
      const vehicles: PlanVehicle[] = [];
      for (const d of drivers) {
        const r = (await c.query(
          `SELECT r.id, v.capacity_kg, v.capacity_m3, v.capacity_items FROM routes r LEFT JOIN vehicles v ON v.id = r.vehicle_id
           WHERE r.driver_id = $1 AND r.route_date = $2 AND r.status IN ('planned','in_progress') ORDER BY r.created_at LIMIT 1`, [d.id, day])).rows[0];
        const stops = r ? (await c.query("SELECT id, lat, lng, window_start, window_end, service_min, weight_kg, volume_m3, packages, priority, kind FROM stops WHERE route_id = $1 AND status = 'pending' ORDER BY sequence", [r.id])).rows : [];
        seed.set(d.id, stops.map((s) => {
          seedStopIds.set(`stop:${s.id}`, s.id);
          return { id: `stop:${s.id}`, lat: s.lat, lng: s.lng, serviceMin: s.service_min, weightKg: s.weight_kg, volumeM3: s.volume_m3, items: s.packages, priority: s.priority, kind: s.kind,
            windowStart: s.window_start?.getTime() ?? null, windowEnd: s.window_end?.getTime() ?? null };
        }));
        vehicles.push({
          id: d.id, start: depot ?? centre, shiftStart, maxShiftMin: d.max_shift_min ?? 600, breakAfterMin: d.break_after_min ?? undefined, breakMin: d.break_min ?? undefined,
          capacityKg: r?.capacity_kg ?? undefined, capacityM3: r?.capacity_m3 ?? undefined, capacityItems: r?.capacity_items ?? undefined, skills: d.skills ?? [],
        });
      }
      const stops: PlanStop[] = jobs.map((j) => ({
        id: j.id, lat: j.lat!, lng: j.lng!, serviceMin: j.service_min, weightKg: j.weight_kg, volumeM3: j.volume_m3, items: j.items, priority: j.priority as PlanStop["priority"],
        kind: j.type === "pickup" ? "pickup" : "delivery", skills: j.skills, windowStart: j.window_start?.getTime() ?? null, windowEnd: j.window_end?.getTime() ?? null,
      }));
      const plan = planFleet(vehicles, stops, makeTravel({ hourOf: hourIn(org.timezone) }), { seed });
      const jobIds = new Set(jobs.map((j) => j.id));
      const proposals = plan.routes.flatMap((r) => r.order.filter((o) => jobIds.has(o)).map((jobId) => ({
        jobId, driverId: r.vehicleId, driverName: drivers.find((d) => d.id === r.vehicleId)!.name, position: r.order.indexOf(jobId),
      })));
      const apply = body?.apply === true;
      if (apply) {
        const touched = new Set<string>();
        for (const p of proposals) {
          const job = await loadJob(c, p.jobId, true);
          const routeId = await routeForDriver(c, orgId, p.driverId, day, p.driverName);
          await place(c, orgId, job, routeId, null, req.session!.userId);
          if (!job.scheduled_date) await c.query("UPDATE jobs SET scheduled_date = $2 WHERE id = $1", [p.jobId, day]);
          touched.add(p.driverId);
        }
        // Put each affected route's pending stops into the planned order.
        for (const r of plan.routes.filter((x) => touched.has(x.vehicleId))) {
          const route = (await c.query("SELECT id FROM routes WHERE driver_id = $1 AND route_date = $2 AND status IN ('planned','in_progress') ORDER BY created_at LIMIT 1", [r.vehicleId, day])).rows[0];
          const ordered: string[] = [];
          for (const o of r.order) {
            if (seedStopIds.has(o)) ordered.push(seedStopIds.get(o)!);
            else { const s = (await c.query("SELECT stop_id FROM jobs WHERE id = $1", [o])).rows[0]; if (s?.stop_id) ordered.push(s.stop_id); }
          }
          const done = (await c.query("SELECT id FROM stops WHERE route_id = $1 AND status <> 'pending' ORDER BY sequence", [route.id])).rows.map((s) => s.id as string);
          await c.query(`UPDATE stops s SET sequence = x.seq FROM unnest($2::uuid[]) WITH ORDINALITY AS x(id, seq) WHERE s.id = x.id AND s.route_id = $1`, [route.id, [...done, ...ordered]]);
          await resequence(c, route.id);
        }
      }
      return { proposals, unassigned: plan.unassigned.map((u) => ({ jobId: u.stopId, reason: u.reason })), applied: apply };
    });
  }

  /** Move a job to the front of the best route today and show what it costs the other stops. */
  @Post(":id/urgent")
  async urgent(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { driverId?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const jobId = parseUuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const job = await loadJob(c, jobId, true);
      if (["done", "cancelled"].includes(job.status)) throw new ConflictException(`a ${job.status} job cannot be rushed`);
      if (job.lat == null || job.lng == null) throw new ConflictException("the job needs a location");
      const org = (await c.query<{ timezone: string }>("SELECT timezone FROM organizations WHERE id = $1", [orgId])).rows[0]!;
      const day = job.scheduled_date ?? (await c.query("SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM organizations")).rows[0].d as string;
      const only = body?.driverId == null ? null : parseUuid(String(body.driverId));
      const routes = (await c.query(
        `SELECT r.id, r.driver_id, r.vehicle_id FROM routes r WHERE r.route_date = $1 AND r.status IN ('planned','in_progress') AND r.driver_id IS NOT NULL ${only ? "AND r.driver_id = $2" : ""}`, only ? [day, only] : [day])).rows;
      if (routes.length === 0) throw new ConflictException("no driver has a route that day");
      const travel = makeTravel({ hourOf: hourIn(org.timezone) });
      const extra: PlanStop = { id: "__job", lat: job.lat, lng: job.lng, serviceMin: job.service_min, weightKg: job.weight_kg, priority: "urgent", windowStart: job.window_start?.getTime() ?? null, windowEnd: job.window_end?.getTime() ?? null };
      let best: { routeId: string; at: number; added: number; late: number; score: number; driverId: string; open: number } | null = null;
      for (const r of routes) {
        const rows = (await c.query("SELECT id, lat, lng, window_start, window_end, service_min, weight_kg, status FROM stops WHERE route_id = $1 ORDER BY sequence", [r.id])).rows;
        const open = rows.filter((s) => s.status === "pending");
        const started = rows.length - open.length;
        const pos = r.vehicle_id ? (await c.query(`SELECT lp.lat, lp.lng FROM latest_positions lp JOIN devices d ON d.id = lp.device_id WHERE d.vehicle_id = $1 ORDER BY lp.time DESC LIMIT 1`, [r.vehicle_id])).rows[0] : null;
        const start = pos ?? (open[0] ? { lat: open[0].lat, lng: open[0].lng } : { lat: job.lat, lng: job.lng });
        const v: PlanVehicle = { id: r.driver_id, start, openEnd: true, shiftStart: Date.now() };
        const res = whatIfAdd(v, open.map((s) => ({ id: s.id, lat: s.lat, lng: s.lng, serviceMin: s.service_min, weightKg: s.weight_kg, windowStart: s.window_start?.getTime() ?? null, windowEnd: s.window_end?.getTime() ?? null })), extra, travel);
        const score = res.addedDurationS + res.newLate * 3600 + res.violations.length * 1e6;
        if (!best || score < best.score) best = { routeId: r.id, at: started + res.insertAt, added: res.addedDurationS, late: res.newLate, score, driverId: r.driver_id, open: open.length };
      }
      await c.query("UPDATE jobs SET priority = 'urgent' WHERE id = $1", [jobId]);
      const fresh = await loadJob(c, jobId);
      const placed = await place(c, orgId, fresh, best!.routeId, best!.at, req.session!.userId);
      await event(c, orgId, jobId, "urgent", req.session!.userId, { routeId: best!.routeId, addedMin: Math.round(best!.added / 60), newLate: best!.late });
      return { jobId, routeId: best!.routeId, driverId: best!.driverId, ...placed, addedMinutes: Math.round(best!.added / 60), othersNowLate: best!.late };
    });
  }

  /** Dispatcher-driven status changes along assigned → started → arrived → done / failed. */
  @Post(":id/status")
  async status(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { status?: unknown; reasonCode?: unknown; note?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const jobId = parseUuid(id);
    const next = String(body?.status);
    return withOrg(this.pool, orgId, async (c) => {
      const job = await loadJob(c, jobId, true);
      if (!(FLOW[job.status] ?? []).includes(next)) throw new ConflictException(`a ${job.status} job cannot become ${next}`);
      if (["assigned", "started", "arrived", "done"].includes(next) && !job.driver_id) throw new ConflictException("assign a driver first");
      const code = next === "failed" ? reason(body?.reasonCode, ["not_home", "refused", "wrong_address", "access_denied", "damaged", "no_time", "other"]) : null;
      if (next === "cancelled") throw new BadRequestException("use the cancel action to cancel with a reason");
      if (next === "unassigned") await unplace(c, job);
      if (job.stop_id && ["arrived", "done", "failed", "assigned"].includes(next)) {
        const stopStatus = next === "assigned" ? "pending" : next;
        await c.query(
          `UPDATE stops SET status = $2, failure_reason = CASE WHEN $2 = 'failed' THEN $3 ELSE NULL END,
             arrived_at = CASE WHEN $2 = 'pending' THEN NULL WHEN $2 IN ('arrived','done') THEN coalesce(arrived_at, now()) ELSE arrived_at END,
             departed_at = CASE WHEN $2 = 'pending' THEN NULL WHEN $2 = 'done' THEN coalesce(departed_at, now()) ELSE departed_at END WHERE id = $1`,
          [job.stop_id, stopStatus, code]);
      }
      await c.query("UPDATE jobs SET status = $2, reason_code = $3, reason_note = $4, driver_id = CASE WHEN $2 = 'unassigned' THEN NULL ELSE driver_id END, updated_at = now() WHERE id = $1",
        [jobId, next, code, note(body?.note)]);
      await event(c, orgId, jobId, "status", req.session!.userId, { status: next, reasonCode: code, note: note(body?.note) });
      return (await loadJob(c, jobId));
    });
  }

  @Post(":id/cancel")
  async cancel(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { reasonCode?: unknown; note?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const jobId = parseUuid(id);
    const code = reason(body?.reasonCode, CANCEL_REASONS);
    return withOrg(this.pool, orgId, async (c) => {
      const job = await loadJob(c, jobId, true);
      if (["done", "cancelled"].includes(job.status)) throw new ConflictException(`the job is already ${job.status}`);
      await unplace(c, job);
      await c.query("UPDATE jobs SET status = 'cancelled', reason_code = $2, reason_note = $3, updated_at = now() WHERE id = $1", [jobId, code, note(body?.note)]);
      await event(c, orgId, jobId, "cancelled", req.session!.userId, { reasonCode: code, note: note(body?.note) });
      return loadJob(c, jobId);
    });
  }

  @Post(":id/reschedule")
  async reschedule(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { date?: unknown; windowStart?: unknown; windowEnd?: unknown; reasonCode?: unknown; note?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const jobId = parseUuid(id);
    const date = parseDate(body?.date);
    const code = reason(body?.reasonCode, RESCHEDULE_REASONS);
    const ts = (v: unknown, f: string) => {
      if (v == null || v === "") return null;
      const d = new Date(String(v));
      if (Number.isNaN(d.getTime())) throw new BadRequestException(`${f} must be a timestamp`);
      return d.toISOString();
    };
    const ws = ts(body?.windowStart, "windowStart"), we = ts(body?.windowEnd, "windowEnd");
    if (ws && we && we <= ws) throw new BadRequestException("windowEnd must be after windowStart");
    return withOrg(this.pool, orgId, async (c) => {
      const job = await loadJob(c, jobId, true);
      if (["done", "cancelled"].includes(job.status)) throw new ConflictException(`a ${job.status} job cannot be rescheduled`);
      await unplace(c, job);
      await c.query(
        `UPDATE jobs SET scheduled_date = $2, window_start = $3, window_end = $4, status = 'unassigned', driver_id = NULL, vehicle_id = NULL,
           reason_code = $5, reason_note = $6, updated_at = now() WHERE id = $1`, [jobId, date, ws, we, code, note(body?.note)]);
      await event(c, orgId, jobId, "rescheduled", req.session!.userId, { from: job.scheduled_date, to: date, reasonCode: code, note: note(body?.note) });
      return loadJob(c, jobId);
    });
  }

  /** Create jobs from CSV text. Rows without coordinates are geocoded when a geocoder is set up. */
  @Post("import")
  async importJobs(@Req() req: AuthedRequest, @Body() body: { csv?: unknown; date?: unknown }) {
    const orgId = requirePerm(req, "routes.write");
    if (typeof body?.csv !== "string" || body.csv.length > 1_000_000) throw new BadRequestException("csv must be text under 1 MB");
    const rows = csvToObjects(body.csv);
    if (rows.length === 0) throw new BadRequestException("csv has no rows");
    if (rows.length > 1000) throw new BadRequestException("at most 1000 rows at a time");
    const defaultDate = body.date ? parseDate(body.date) : null;
    const created: string[] = [];
    const needLocation: number[] = [];
    const errors: { row: number; message: string }[] = [];
    await withOrg(this.pool, orgId, async (c) => {
      for (const [i, r] of rows.entries()) {
        try {
          const title = (r.title || r.name || r.customer_name || "").slice(0, 200);
          if (!title) throw new Error("title is required");
          const type = r.type || "delivery";
          if (!["pickup", "delivery", "service", "inspection"].includes(type)) throw new Error("type must be pickup, delivery, service or inspection");
          const priority = r.priority || "normal";
          if (!["low", "normal", "high", "urgent"].includes(priority)) throw new Error("priority must be low, normal, high or urgent");
          let lat = r.lat ? Number(r.lat) : null, lng = r.lng ? Number(r.lng) : null;
          if ((lat !== null && !(lat >= -90 && lat <= 90)) || (lng !== null && !(lng >= -180 && lng <= 180))) throw new Error("invalid coordinates");
          if ((lat === null || lng === null) && r.address && this.geocoder) {
            try { const hit = (await this.geocoder.search(r.address, 1))[0]; if (hit) { lat = hit.lat; lng = hit.lng; } } catch { /* leave without a location */ }
          }
          if (lat === null || lng === null) { lat = null; lng = null; needLocation.push(i + 2); }
          const date = r.scheduled_date || r.date || defaultDate;
          const num = (v: string | undefined) => (v ? Number(v) : 0);
          for (const [k, v] of Object.entries({ weight_kg: r.weight_kg, volume_m3: r.volume_m3, items: r.items, service_min: r.service_min })) if (v && !(Number(v) >= 0)) throw new Error(`${k} must be a number`);
          const ts = (v: string | undefined) => { if (!v) return null; const d = new Date(v); if (Number.isNaN(d.getTime())) throw new Error("invalid window time"); return d.toISOString(); };
          const row = (await c.query(
            `INSERT INTO jobs (org_id, ref, type, priority, title, customer_name, customer_phone, customer_email, address, lat, lng, scheduled_date, window_start, window_end,
                weight_kg, volume_m3, items, service_min, tags, notes, created_by)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21) RETURNING id`,
            [orgId, r.ref || null, type, priority, title, r.customer_name || null, r.customer_phone || null, r.customer_email || null, r.address || null, lat, lng,
              date || null, ts(r.window_start), ts(r.window_end), num(r.weight_kg), num(r.volume_m3), Math.round(num(r.items)), r.service_min ? Math.round(Number(r.service_min)) : 5,
              r.tags ? r.tags.split(/[;|]/).map((t) => t.trim()).filter(Boolean) : [], r.notes || null, req.session!.userId])).rows[0];
          await event(c, orgId, row.id, "created", req.session!.userId, { via: "import" });
          created.push(row.id);
        } catch (e) {
          errors.push({ row: i + 2, message: (e as Error).message.replace(/^.*?(violates|invalid input).*$/s, "invalid value") });
        }
      }
    });
    return { created: created.length, needLocation, errors };
  }

  // ---- attachments ----

  @Put(":id/attachments")
  async attach(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: unknown, @Query("name") name?: string) {
    const orgId = requirePerm(req, "routes.write");
    const jobId = parseUuid(id);
    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!ATTACHMENT_TYPES.includes(type)) throw new HttpException(`content type must be one of ${ATTACHMENT_TYPES.join(", ")}`, 415);
    if (!Buffer.isBuffer(body) || body.length === 0) throw new BadRequestException("file body required");
    if (body.length > MAX_ATTACHMENT) throw new HttpException("file too large", 413);
    if (!(type === "application/pdf" ? body.subarray(0, 5).toString("latin1") === "%PDF-" : matchesImageType(type, body))) throw new BadRequestException("file contents do not match the content type");
    const fileName = (name ?? "attachment").replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "attachment";
    return withOrg(this.pool, orgId, async (c) => {
      await loadJob(c, jobId);
      const row = (await c.query(
        `INSERT INTO attachments (org_id, owner_kind, owner_id, name, content_type, size_bytes, data, created_by) VALUES ($1,'job',$2,$3,$4,$5,$6,$7)
         RETURNING id, name, content_type AS "contentType", size_bytes AS "sizeBytes"`, [orgId, jobId, fileName, type, body.length, body, req.session!.userId])).rows[0];
      await event(c, orgId, jobId, "attachment", req.session!.userId, { name: fileName });
      return row;
    });
  }
}

/** Download or delete one attachment (job, incident or document files). */
@Controller("attachments")
@UseGuards(AuthGuard)
export class AttachmentsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get(":id")
  async file(@Req() req: AuthedRequest, @Param("id") id: string, @Res() res: Response) {
    const orgId = requirePerm(req, "routes.view", "fleet.view");
    const row = (await withOrg(this.pool, orgId, (c) => c.query("SELECT name, content_type, data FROM attachments WHERE id = $1", [parseUuid(id)]))).rows[0];
    if (!row) throw new NotFoundException();
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Disposition", `inline; filename="${String(row.name).replace(/"/g, "")}"`);
    res.setHeader("Cache-Control", "private, max-age=3600");
    res.type(row.content_type).send(row.data);
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "routes.write", "fleet.manage");
    const n = (await withOrg(this.pool, orgId, (c) => c.query("DELETE FROM attachments WHERE id = $1", [parseUuid(id)]))).rowCount;
    if (!n) throw new NotFoundException();
  }
}

/** Route templates, repeating routes, and splitting or merging routes. */
@Controller()
@UseGuards(AuthGuard)
export class RoutePlanningController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Turn an existing route into a template (stops keep their order, windows become times of day). */
  @Post("route-templates/from-route/:routeId")
  async fromRoute(@Req() req: AuthedRequest, @Param("routeId") routeId: string, @Body() body: { name?: unknown; recurrence?: unknown }) {
    const orgId = requirePerm(req, "routes.write");
    const rid = parseUuid(routeId);
    if (body?.recurrence != null && !isRecurrence(body.recurrence)) throw new BadRequestException("invalid recurrence");
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query("SELECT name, vehicle_id, driver_id, depot_id, objective, avoid, start_time FROM routes WHERE id = $1", [rid])).rows[0];
      if (!r) throw new NotFoundException();
      const org = (await c.query<{ timezone: string }>("SELECT timezone FROM organizations WHERE id = $1", [orgId])).rows[0]!;
      const stops = (await c.query(
        `SELECT name, address, lat, lng, radius_m AS "radiusM", packages, notes, weight_kg AS "weightKg", volume_m3 AS "volumeM3", service_min AS "serviceMin", priority, kind,
                to_char(window_start AT TIME ZONE $2, 'HH24:MI') AS "windowStart", to_char(window_end AT TIME ZONE $2, 'HH24:MI') AS "windowEnd"
         FROM stops WHERE route_id = $1 ORDER BY sequence`, [rid, org.timezone])).rows;
      const name = typeof body?.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : r.name;
      return (await c.query(
        `INSERT INTO route_templates (org_id, name, vehicle_id, driver_id, depot_id, objective, avoid, start_time, stops, recurrence)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, name`,
        [orgId, name, r.vehicle_id, r.driver_id, r.depot_id, r.objective, r.avoid, r.start_time, JSON.stringify(stops), body?.recurrence ? JSON.stringify(body.recurrence) : null])).rows[0];
    });
  }

  /** Create a route from a template for a date. */
  @Post("route-templates/:id/generate")
  async generate(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { date?: unknown }) {
    const orgId = requirePerm(req, "routes.write");
    const date = parseDate(body?.date);
    return withOrg(this.pool, orgId, async (c) => {
      const out = await generateRoutes(c, orgId, date, parseUuid(id), true);
      if (out.length === 0) throw new NotFoundException();
      return out[0];
    });
  }

  /** Create today's (or a given day's) routes from every active template that repeats on that day. Safe to run twice. */
  @Post("route-templates/run")
  async run(@Req() req: AuthedRequest, @Body() body: { date?: unknown }) {
    const orgId = requirePerm(req, "routes.write");
    const date = parseDate(body?.date);
    return withOrg(this.pool, orgId, async (c) => ({ date, created: await generateRoutes(c, orgId, date, null, false) }));
  }

  @Get("route-templates/:id/upcoming")
  async next(@Req() req: AuthedRequest, @Param("id") id: string, @Query("after") after?: string) {
    const orgId = requirePerm(req, "routes.view");
    const t = (await withOrg(this.pool, orgId, (c) => c.query("SELECT recurrence FROM route_templates WHERE id = $1", [parseUuid(id)]))).rows[0];
    if (!t) throw new NotFoundException();
    const rec = t.recurrence as Recurrence | null;
    const start = after ? parseDate(after) : new Date().toISOString().slice(0, 10);
    return { dates: rec ? upcoming(rec, start, 10) : [], repeats: !!rec, today: rec ? occursOn(rec, start) : false };
  }

  /** Move chosen pending stops into a new route (same day, vehicle and driver unset). */
  @Post("dispatch/routes/:id/split")
  async split(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { stopIds?: unknown; name?: unknown; driverId?: unknown; vehicleId?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const rid = parseUuid(id);
    if (!Array.isArray(body?.stopIds) || body.stopIds.length === 0) throw new BadRequestException("choose the stops to move");
    const ids = body.stopIds.map((s) => parseUuid(String(s)));
    return withOrg(this.pool, orgId, async (c) => {
      const route = (await c.query("SELECT * FROM routes WHERE id = $1 FOR UPDATE", [rid])).rows[0];
      if (!route) throw new NotFoundException();
      const stops = (await c.query("SELECT id, status FROM stops WHERE route_id = $1 AND id = ANY($2::uuid[])", [rid, ids])).rows;
      if (stops.length !== ids.length) throw new BadRequestException("some stops are not on this route");
      if (stops.some((s) => s.status !== "pending")) throw new ConflictException("only stops that have not started can be moved");
      const left = (await c.query("SELECT count(*)::int AS n FROM stops WHERE route_id = $1 AND NOT (id = ANY($2::uuid[]))", [rid, ids])).rows[0].n as number;
      if (left === 0) throw new BadRequestException("leave at least one stop on the original route");
      const driverId = body.driverId == null ? null : parseUuid(String(body.driverId));
      const vehicleId = body.vehicleId == null ? null : parseUuid(String(body.vehicleId));
      const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 200) : `${route.name} (2)`;
      const created = (await c.query(
        "INSERT INTO routes (org_id, name, route_date, driver_id, vehicle_id, depot_id, objective, avoid) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
        [orgId, name, route.route_date, driverId, vehicleId, route.depot_id, route.objective, route.avoid])).rows[0];
      // Keep the chosen order of the stops being moved as they were on the original route.
      await c.query(
        `UPDATE stops s SET route_id = $2, sequence = x.seq FROM
           (SELECT id, row_number() OVER (ORDER BY sequence)::int AS seq FROM stops WHERE route_id = $1 AND id = ANY($3::uuid[])) x
         WHERE s.id = x.id`, [rid, created.id, ids]);
      await c.query("UPDATE jobs SET route_id = $1, driver_id = $2, vehicle_id = $3 WHERE stop_id IN (SELECT id FROM stops WHERE route_id = $1)", [created.id, driverId, vehicleId]);
      await resequence(c, rid);
      return { original: rid, created: created.id, moved: ids.length };
    });
  }

  /** Move all pending stops of another route onto the end of this one, then remove the empty route. */
  @Post("dispatch/routes/:id/merge")
  async merge(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { fromId?: unknown }) {
    const orgId = requirePerm(req, "routes.dispatch");
    const rid = parseUuid(id);
    const from = parseUuid(String(body?.fromId));
    if (from === rid) throw new BadRequestException("choose a different route to merge");
    return withOrg(this.pool, orgId, async (c) => {
      const both = (await c.query("SELECT id, route_date::text AS d, status, driver_id, vehicle_id FROM routes WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE", [[rid, from]])).rows;
      if (both.length !== 2) throw new NotFoundException();
      const target = both.find((r) => r.id === rid)!;
      const source = both.find((r) => r.id === from)!;
      if (target.d !== source.d) throw new ConflictException("routes must be on the same day");
      if (source.status !== "planned") throw new ConflictException("only a route that has not started can be merged into another");
      const n = (await c.query("SELECT coalesce(max(sequence), 0)::int AS m FROM stops WHERE route_id = $1", [rid])).rows[0].m as number;
      const moved = (await c.query(
        `UPDATE stops s SET route_id = $2, sequence = $3 + x.seq FROM
           (SELECT id, row_number() OVER (ORDER BY sequence)::int AS seq FROM stops WHERE route_id = $1) x WHERE s.id = x.id`, [from, rid, n])).rowCount;
      await c.query("UPDATE jobs SET route_id = $2, driver_id = $3, vehicle_id = $4 WHERE route_id = $1", [from, rid, target.driver_id, target.vehicle_id]);
      await c.query("DELETE FROM routes WHERE id = $1", [from]);
      await resequence(c, rid);
      return { merged: moved, into: rid };
    });
  }
}
