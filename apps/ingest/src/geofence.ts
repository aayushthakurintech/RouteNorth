import { pg, withOrg } from "@routenorth/db";
import { insideShape, type Polygon } from "@routenorth/shared";
import type { StoredPosition } from "./store.js";

export interface GeofenceEvent { geofenceId: string; name: string; deviceId: string; kind: "enter" | "exit"; at: string; alertOn: string }

/**
 * Compare a vehicle's new position with every active geofence and record entries and exits.
 * The first fix ever seen for a vehicle and fence only sets the starting state (no alert), so a truck that
 * begins the day parked in the depot does not "enter" it.
 */
export async function updateGeofences(pool: pg.Pool, p: StoredPosition): Promise<GeofenceEvent[]> {
  const out: GeofenceEvent[] = [];
  await withOrg(pool, p.orgId, async (c) => {
    const fences = (await c.query(
      `SELECT g.id, g.name, g.shape, g.lat, g.lng, g.radius_m, g.polygon, g.alert_on, s.inside AS was_inside
       FROM geofences g LEFT JOIN geofence_state s ON s.geofence_id = g.id AND s.device_id = $1 WHERE g.active`, [p.deviceId])).rows;
    for (const g of fences) {
      const inside = insideShape(
        { shape: g.shape, lat: g.lat, lng: g.lng, radiusM: g.radius_m, polygon: g.polygon as Polygon | null }, p.lat, p.lng);
      if (g.was_inside === inside) continue;
      await c.query(
        `INSERT INTO geofence_state (geofence_id, device_id, org_id, inside, since) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (geofence_id, device_id) DO UPDATE SET inside = EXCLUDED.inside, since = EXCLUDED.since`, [g.id, p.deviceId, p.orgId, inside, p.time]);
      if (g.was_inside === null) continue; // starting state only
      const kind = inside ? "enter" : "exit";
      await c.query(
        "INSERT INTO geofence_events (org_id, geofence_id, device_id, kind, at, lat, lng) VALUES ($1,$2,$3,$4,$5,$6,$7)", [p.orgId, g.id, p.deviceId, kind, p.time, p.lat, p.lng]);
      out.push({ geofenceId: g.id, name: g.name, deviceId: p.deviceId, kind, at: p.time, alertOn: g.alert_on });
    }
  });
  return out;
}
