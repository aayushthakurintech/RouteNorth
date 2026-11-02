import { pg, withOrg } from "@routenorth/db";
import { estimateEtas, evaluateStop, type StopState, type StopStatus } from "@routenorth/shared";
import type { StoredPosition } from "./store.js";

interface StopRow {
  id: string; lat: number; lng: number; radius_m: number; status: StopStatus;
  inside_since: Date | null; outside_since: Date | null; arrived_at: Date | null; departed_at: Date | null; eta: Date | null;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const toState = (r: StopRow): StopState => ({
  id: r.id, lat: r.lat, lng: r.lng, radiusM: r.radius_m, status: r.status,
  insideSince: iso(r.inside_since), outsideSince: iso(r.outside_since),
  arrivedAt: iso(r.arrived_at), departedAt: iso(r.departed_at),
});

/** Only rewrite an ETA when it moved by at least this much, to avoid a write per GPS fix. */
const ETA_MIN_CHANGE_MS = 30_000;

export interface ProgressEvent {
  routeId: string;
  stopId: string;
  status: StopStatus;
}

/**
 * Advance every active route of the vehicle this fix belongs to: detect arrivals and departures,
 * refresh ETAs, and move the route to in_progress / completed. Returns the stop status changes.
 */
export async function updateRouteProgress(pool: pg.Pool, p: StoredPosition): Promise<ProgressEvent[]> {
  const events: ProgressEvent[] = [];
  await withOrg(pool, p.orgId, async (c) => {
    const routes = await c.query<{ id: string; status: string }>(
      `SELECT r.id, r.status FROM routes r
         JOIN devices d ON d.vehicle_id = r.vehicle_id
         JOIN organizations o ON o.id = r.org_id
       WHERE d.id = $1 AND r.status IN ('planned','in_progress')
         AND r.route_date = ($2::timestamptz AT TIME ZONE o.timezone)::date
       FOR UPDATE OF r`,
      [p.deviceId, p.time],
    );
    for (const route of routes.rows) {
      const stops = (
        await c.query<StopRow>(
          `SELECT id, lat, lng, radius_m, status, inside_since, outside_since, arrived_at, departed_at, eta
           FROM stops WHERE route_id = $1 ORDER BY sequence FOR UPDATE`,
          [route.id],
        )
      ).rows;
      const fix = { time: p.time, lat: p.lat, lng: p.lng, speed: p.speed };

      // 1. arrivals and departures
      const states = stops.map(toState);
      for (const [i, s] of states.entries()) {
        const patch = evaluateStop(s, fix);
        if (!patch) continue;
        await c.query(
          `UPDATE stops SET status=$2, inside_since=$3, outside_since=$4, arrived_at=$5, departed_at=$6,
                  eta = CASE WHEN $2 = 'pending' THEN eta ELSE NULL END WHERE id = $1`,
          [s.id, patch.status, patch.insideSince, patch.outsideSince, patch.arrivedAt, patch.departedAt],
        );
        if (patch.status !== s.status) events.push({ routeId: route.id, stopId: s.id, status: patch.status });
        states[i] = { ...s, ...patch };
      }

      // 2. ETAs for what is still ahead, in route order
      const ahead = states.filter((s) => s.status === "pending");
      const etas = estimateEtas(ahead, fix);
      for (const s of ahead) {
        const next = etas.get(s.id)!;
        const old = stops.find((r) => r.id === s.id)!.eta;
        if (!old || Math.abs(new Date(next).getTime() - old.getTime()) >= ETA_MIN_CHANGE_MS) {
          await c.query("UPDATE stops SET eta = $2 WHERE id = $1", [s.id, next]);
        }
      }

      // 3. route status
      const finished = states.every((s) => s.status === "done" || s.status === "failed" || s.status === "skipped");
      const started = states.some((s) => s.status !== "pending");
      if (states.length > 0 && finished) {
        await c.query("UPDATE routes SET status='completed', completed_at=$2, started_at=coalesce(started_at,$2) WHERE id=$1", [route.id, p.time]);
      } else if (started && route.status === "planned") {
        await c.query("UPDATE routes SET status='in_progress', started_at=$2 WHERE id=$1", [route.id, p.time]);
      }
    }
  });
  return events;
}
