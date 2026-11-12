import type { pg } from "@routenorth/db";
import { isRecurrence, occursOn } from "@routenorth/shared";
import { zonedToEpoch } from "../plan/time.js";

interface TemplateStop {
  name: string; address?: string | null; lat: number; lng: number; radiusM?: number; packages?: number; notes?: string | null;
  weightKg?: number; volumeM3?: number; serviceMin?: number; priority?: string; kind?: string; windowStart?: string | null; windowEnd?: string | null;
}

/** "14:00" on `date` in the organization's zone, or a full timestamp as given. */
function when(v: string | null | undefined, date: string, tz: string): string | null {
  if (!v) return null;
  if (/^\d{2}:\d{2}$/.test(v)) return new Date(zonedToEpoch(date, v, tz)).toISOString();
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Create routes for `date` from templates. With `force` (a person pressed the button for one template) a route is always made;
 * otherwise only templates that repeat on that date and have no route for it yet, so running this twice changes nothing.
 */
export async function generateRoutes(c: pg.PoolClient, orgId: string, date: string, templateId: string | null, force: boolean): Promise<{ templateId: string; routeId: string; name: string }[]> {
  const tz = (await c.query<{ timezone: string }>("SELECT timezone FROM organizations WHERE id = $1", [orgId])).rows[0]!.timezone;
  const templates = (await c.query(
    `SELECT * FROM route_templates WHERE ($1::uuid IS NULL OR id = $1) ${force ? "" : "AND active"} ORDER BY created_at`, [templateId])).rows;
  const out: { templateId: string; routeId: string; name: string }[] = [];
  for (const t of templates) {
    if (!force) {
      if (!isRecurrence(t.recurrence) || !occursOn(t.recurrence, date)) continue;
      const had = await c.query("SELECT 1 FROM routes WHERE template_id = $1 AND route_date = $2 LIMIT 1", [t.id, date]);
      if (had.rowCount) continue;
    }
    const route = (await c.query(
      `INSERT INTO routes (org_id, name, route_date, vehicle_id, driver_id, depot_id, objective, avoid, start_time, template_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [orgId, t.name, date, t.vehicle_id, t.driver_id, t.depot_id, t.objective, t.avoid, t.start_time, t.id])).rows[0];
    const stops = (t.stops as TemplateStop[]) ?? [];
    for (const [i, s] of stops.entries()) {
      await c.query(
        `INSERT INTO stops (org_id, route_id, sequence, name, address, lat, lng, radius_m, window_start, window_end, packages, notes, weight_kg, volume_m3, service_min, priority, kind)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [orgId, route.id, i + 1, s.name, s.address ?? null, s.lat, s.lng, s.radiusM ?? 75, when(s.windowStart, date, tz), when(s.windowEnd, date, tz), s.packages ?? 0, s.notes ?? null,
          s.weightKg ?? 0, s.volumeM3 ?? 0, s.serviceMin ?? 5, s.priority ?? "normal", s.kind ?? "delivery"]);
    }
    await c.query("UPDATE route_templates SET last_generated = $2 WHERE id = $1", [t.id, date]);
    out.push({ templateId: t.id, routeId: route.id, name: t.name });
  }
  return out;
}
