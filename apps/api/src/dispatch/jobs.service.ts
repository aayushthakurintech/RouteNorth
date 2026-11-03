import { ConflictException, NotFoundException } from "@nestjs/common";
import type { pg } from "@routenorth/db";
import { emit } from "../automation/events.js";

export interface JobRow {
  id: string; org_id: string; type: string; priority: string; status: string; title: string; address: string | null;
  lat: number | null; lng: number | null; window_start: Date | null; window_end: Date | null; service_min: number; weight_kg: number;
  volume_m3: number; items: number; notes: string | null; driver_id: string | null; vehicle_id: string | null; route_id: string | null;
  stop_id: string | null; scheduled_date: string | null; skills: string[]; customer_name: string | null;
}

export const CANCEL_REASONS = ["customer_cancelled", "duplicate", "address_invalid", "no_capacity", "weather", "vehicle_issue", "other"] as const;
export const RESCHEDULE_REASONS = ["customer_request", "not_ready", "no_capacity", "weather", "vehicle_issue", "access_problem", "other"] as const;
export const FAIL_REASONS = ["not_home", "refused", "wrong_address", "access_denied", "damaged", "no_time", "other"] as const;

export async function event(c: pg.PoolClient, orgId: string, jobId: string, kind: string, actorId: string | null, detail: Record<string, unknown> = {}): Promise<void> {
  await c.query("INSERT INTO job_events (org_id, job_id, actor_id, kind, detail) VALUES ($1,$2,$3,$4,$5)", [orgId, jobId, actorId, kind, JSON.stringify(detail)]);
  // A reschedule is not a status the job keeps, so announce it here for customer messages and workflows.
  if (kind === "rescheduled") await emit(c, orgId, "job.rescheduled", "job", jobId, detail);
}

export async function loadJob(c: pg.PoolClient, id: string, lock = false): Promise<JobRow> {
  const j = (await c.query<JobRow>(`SELECT *, scheduled_date::text AS scheduled_date FROM jobs WHERE id = $1 ${lock ? "FOR UPDATE" : ""}`, [id])).rows[0];
  if (!j) throw new NotFoundException();
  return j;
}

/** Renumber a route's stops 1..n in their current order. */
export async function resequence(c: pg.PoolClient, routeId: string): Promise<void> {
  await c.query(
    `UPDATE stops s SET sequence = r.seq FROM
       (SELECT id, row_number() OVER (ORDER BY sequence)::int AS seq FROM stops WHERE route_id = $1) r
     WHERE s.id = r.id AND s.sequence <> r.seq`, [routeId]);
}

/** Take a job off its route (only while its stop has not been started). */
export async function unplace(c: pg.PoolClient, job: JobRow): Promise<void> {
  if (!job.stop_id) return;
  const stop = (await c.query("SELECT status, route_id FROM stops WHERE id = $1 FOR UPDATE", [job.stop_id])).rows[0];
  if (stop) {
    if (stop.status !== "pending") throw new ConflictException("the driver has already started this stop");
    await c.query("DELETE FROM stops WHERE id = $1", [job.stop_id]);
    await resequence(c, stop.route_id);
  }
  await c.query("UPDATE jobs SET route_id = NULL, stop_id = NULL, updated_at = now() WHERE id = $1", [job.id]);
}

/** Put a job on a route as a stop, at `index` (0-based; default end). Moves it if it is on another route. */
export async function place(c: pg.PoolClient, orgId: string, job: JobRow, routeId: string, index: number | null, actorId: string | null): Promise<{ stopId: string; sequence: number }> {
  const route = (await c.query("SELECT id, vehicle_id, driver_id, status FROM routes WHERE id = $1 FOR UPDATE", [routeId])).rows[0];
  if (!route) throw new NotFoundException("route not found");
  if (route.status === "completed" || route.status === "cancelled") throw new ConflictException("that route is already finished");
  if (job.lat == null || job.lng == null) throw new ConflictException("the job needs a location before it can go on a route");
  await unplace(c, job);
  const n = (await c.query("SELECT count(*)::int AS n FROM stops WHERE route_id = $1", [routeId])).rows[0].n as number;
  const at = Math.min(n, Math.max(0, index ?? n)) + 1;
  await c.query("UPDATE stops SET sequence = sequence + 1 WHERE route_id = $1 AND sequence >= $2", [routeId, at]);
  const stop = (await c.query(
    `INSERT INTO stops (org_id, route_id, sequence, name, address, lat, lng, window_start, window_end, packages, notes, weight_kg, volume_m3, service_min, priority, kind, job_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING id, sequence`,
    [orgId, routeId, at, job.title, job.address, job.lat, job.lng, job.window_start, job.window_end, job.items, job.notes, job.weight_kg, job.volume_m3,
      job.service_min, job.priority, job.type === "pickup" ? "pickup" : "delivery", job.id],
  )).rows[0];
  await resequence(c, routeId);
  const status = job.status === "unassigned" ? "assigned" : job.status;
  await c.query(
    "UPDATE jobs SET driver_id = $2, vehicle_id = $3, route_id = $4, stop_id = $5, status = $6, updated_at = now() WHERE id = $1",
    [job.id, route.driver_id, route.vehicle_id, routeId, stop.id, status]);
  await event(c, orgId, job.id, "assigned", actorId, { routeId, driverId: route.driver_id });
  return { stopId: stop.id as string, sequence: stop.sequence as number };
}

/** The driver's open route for a day, created (planned, no vehicle) when they have none. */
export async function routeForDriver(c: pg.PoolClient, orgId: string, driverId: string, date: string, driverName: string): Promise<string> {
  const existing = (await c.query(
    "SELECT id FROM routes WHERE driver_id = $1 AND route_date = $2 AND status IN ('planned','in_progress') ORDER BY created_at LIMIT 1", [driverId, date])).rows[0];
  if (existing) return existing.id as string;
  return (await c.query(
    "INSERT INTO routes (org_id, name, route_date, driver_id) VALUES ($1,$2,$3,$4) RETURNING id", [orgId, driverName.slice(0, 150), date, driverId])).rows[0].id as string;
}
