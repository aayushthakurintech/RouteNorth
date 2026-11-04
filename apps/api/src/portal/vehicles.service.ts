import { ConflictException } from "@nestjs/common";
import type { pg } from "@routenorth/db";
import { LEGAL_DOC, docStatus, serviceStatus, type ServiceStatus } from "@routenorth/shared";

export type VehicleStatus = "active" | "on_trip" | "idle" | "in_service" | "out_of_service" | "sold" | "archived";

export interface VehicleRow {
  id: string; name: string; kind: string; plate: string | null; vin: string | null; make: string | null; model: string | null; year: number | null; trim: string | null; color: string | null;
  fuelType: string | null; status: VehicleStatus; storedStatus: string; odometerKm: number; engineHours: number | null; ownershipType: string | null;
  insuranceExpiry: string | null; currentDriverId: string | null; currentDriverName: string | null; teamId: string | null; depotId: string | null; tags: string[];
  archivedAt: string | null; hasPhoto: boolean; deviceId: string | null; lastSeen: string | null; lastActivity: string | null;
  service: ServiceStatus; docs: { expired: number; expiring: number; nextExpiry: string | null }; blockedReasons: string[];
  purchaseDate: string | null; purchasePriceCents: number | null; currentValueCents: number | null; createdAt: string;
}

export interface Ctx { today: string; tz: string; now: Date }

/** What the car is doing right now, from what is stored plus live signals (open jobs, last movement, last trip). */
export function deriveStatus(stored: string, archived: boolean, onTrip: boolean, lastActivity: Date | null, idleDays: number, now: Date): VehicleStatus {
  if (archived) return "archived";
  if (stored === "sold") return "sold";
  if (stored === "in_shop") return "in_service";
  if (stored === "out_of_service" || stored === "retired") return "out_of_service";
  if (onTrip) return "on_trip";
  if (lastActivity && now.getTime() - lastActivity.getTime() > idleDays * 86_400_000) return "idle";
  return "active";
}

export async function loadVehicles(c: pg.PoolClient, ctx: Ctx, o: { id?: string; archived?: boolean; teamIds?: string[] | null } = {}): Promise<VehicleRow[]> {
  const params: unknown[] = [];
  const where: string[] = [];
  if (o.id) { params.push(o.id); where.push(`v.id = $${params.length}`); }
  if (!o.archived && !o.id) where.push("v.archived_at IS NULL");
  if (o.teamIds) { params.push(o.teamIds); where.push(`v.team_id = ANY($${params.length}::uuid[])`); }
  const vs = (await c.query(
    `SELECT v.id, v.name, v.kind, v.plate, v.vin, v.make, v.model, v.year, v.trim, v.color, v.fuel_type, v.status, v.odometer_km, v.engine_hours::float8 AS engine_hours, v.ownership_type,
            v.insurance_expiry::text AS insurance_expiry, v.current_driver_id, coalesce(u.display_name, u.email) AS driver_name, v.team_id, v.depot_id, v.tags, v.archived_at, (v.photo_data_url IS NOT NULL) AS has_photo,
            v.idle_alert_days, v.service_interval_km, v.service_interval_days, v.service_interval_hours, v.purchase_date::text AS purchase_date, v.purchase_price_cents::float8 AS purchase_price_cents,
            v.current_value_cents::float8 AS current_value_cents, v.created_at,
            d.id AS device_id, lp.time AS last_seen, CASE WHEN lp.speed > 3 THEN lp.time END AS last_moved
     FROM vehicles v
     LEFT JOIN users u ON u.id = v.current_driver_id
     LEFT JOIN LATERAL (SELECT id FROM devices WHERE vehicle_id = v.id ORDER BY created_at LIMIT 1) d ON true
     LEFT JOIN latest_positions lp ON lp.device_id = d.id
     ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY v.name`, params)).rows;
  if (!vs.length) return [];
  const ids = vs.map((v) => v.id as string);

  const logs = new Map<string, { done_on: string; km: number | null }>();
  for (const r of (await c.query(
    `SELECT DISTINCT ON (vehicle_id) vehicle_id, done_on::text AS done_on, odometer_km FROM maintenance_logs WHERE vehicle_id = ANY($1::uuid[]) AND archived_at IS NULL AND kind IN ('service','repair','inspection','tires') ORDER BY vehicle_id, done_on DESC, created_at DESC`, [ids])).rows) logs.set(r.vehicle_id, { done_on: r.done_on, km: r.odometer_km });
  const plans = new Map<string, { task: string; everyDays: number | null; everyKm: number | null; lastDoneOn: string | null; lastDoneKm: number | null }[]>();
  for (const r of (await c.query(`SELECT vehicle_id, task, every_days, every_km, last_done_on::text AS last_done_on, last_done_km FROM maintenance_plans WHERE vehicle_id = ANY($1::uuid[]) AND archived_at IS NULL`, [ids])).rows) {
    (plans.get(r.vehicle_id) ?? plans.set(r.vehicle_id, []).get(r.vehicle_id)!).push({ task: r.task, everyDays: r.every_days, everyKm: r.every_km, lastDoneOn: r.last_done_on, lastDoneKm: r.last_done_km });
  }
  const docs = new Map<string, { expired: number; expiring: number; nextExpiry: string | null; legalExpired: string[] }>();
  for (const r of (await c.query(`SELECT owner_id, kind, expires_on::text AS expires_on, remind_days FROM documents WHERE owner_kind = 'vehicle' AND owner_id = ANY($1::uuid[]) AND archived_at IS NULL AND expires_on IS NOT NULL`, [ids])).rows) {
    const s = docStatus(r.expires_on, ctx.today, r.remind_days);
    const e = docs.get(r.owner_id) ?? docs.set(r.owner_id, { expired: 0, expiring: 0, nextExpiry: null, legalExpired: [] }).get(r.owner_id)!;
    if (s.state === "expired") { e.expired++; if (LEGAL_DOC.test(r.kind)) e.legalExpired.push(r.kind); } else if (s.state === "expiring") e.expiring++;
    if (!e.nextExpiry || r.expires_on < e.nextExpiry) e.nextExpiry = r.expires_on;
  }
  const failed = new Set<string>();
  for (const r of (await c.query(`SELECT DISTINCT vehicle_id FROM inspections WHERE vehicle_id = ANY($1::uuid[]) AND archived_at IS NULL AND defects AND signed_off_at IS NULL`, [ids])).rows) failed.add(r.vehicle_id);
  const onTrip = new Set<string>();
  for (const r of (await c.query(`SELECT DISTINCT vehicle_id FROM jobs WHERE vehicle_id = ANY($1::uuid[]) AND status IN ('started','arrived')`, [ids])).rows) onTrip.add(r.vehicle_id);
  const lastTrip = new Map<string, Date>();
  for (const r of (await c.query(`SELECT vehicle_id, max(coalesce(ended_at, started_at)) AS t FROM portal_trips WHERE vehicle_id = ANY($1::uuid[]) AND archived_at IS NULL GROUP BY 1`, [ids])).rows) lastTrip.set(r.vehicle_id, r.t);

  return vs.map((v): VehicleRow => {
    const last = logs.get(v.id);
    const service = serviceStatus({
      today: ctx.today, odometerKm: v.odometer_km, engineHours: v.engine_hours,
      intervalKm: v.service_interval_km, intervalDays: v.service_interval_days, intervalHours: v.service_interval_hours,
      lastDoneOn: last?.done_on ?? null, lastDoneKm: last?.km ?? null, startOn: v.purchase_date ?? new Date(v.created_at).toISOString().slice(0, 10),
      plans: plans.get(v.id),
    });
    const doc = docs.get(v.id) ?? { expired: 0, expiring: 0, nextExpiry: null, legalExpired: [] };
    const acts = [v.last_moved, lastTrip.get(v.id)].filter(Boolean).map((x) => new Date(x as string | Date));
    const lastActivity = acts.length ? new Date(Math.max(...acts.map((a) => a.getTime()))) : new Date(v.created_at);
    const status = deriveStatus(v.status, !!v.archived_at, onTrip.has(v.id), lastActivity, v.idle_alert_days ?? 3, ctx.now);
    const blockedReasons: string[] = [];
    if (doc.legalExpired.length) blockedReasons.push(`Expired: ${[...new Set(doc.legalExpired)].join(", ")}`);
    if (failed.has(v.id)) blockedReasons.push("A failed inspection has not been signed off");
    if (status === "in_service" || status === "out_of_service" || status === "sold") blockedReasons.push(`Car is ${status.replace(/_/g, " ")}`);
    return {
      id: v.id, name: v.name, kind: v.kind, plate: v.plate, vin: v.vin, make: v.make, model: v.model, year: v.year, trim: v.trim, color: v.color, fuelType: v.fuel_type,
      status, storedStatus: v.status, odometerKm: v.odometer_km, engineHours: v.engine_hours, ownershipType: v.ownership_type, insuranceExpiry: v.insurance_expiry,
      currentDriverId: v.current_driver_id, currentDriverName: v.driver_name, teamId: v.team_id, depotId: v.depot_id, tags: v.tags, archivedAt: v.archived_at, hasPhoto: v.has_photo,
      deviceId: v.device_id, lastSeen: v.last_seen, lastActivity: lastActivity.toISOString(), service, docs: { expired: doc.expired, expiring: doc.expiring, nextExpiry: doc.nextExpiry }, blockedReasons,
      purchaseDate: v.purchase_date, purchasePriceCents: v.purchase_price_cents, currentValueCents: v.current_value_cents, createdAt: v.created_at,
    };
  });
}

/** A car with an expired legal document, an unsigned failed inspection, or out of service cannot be given new jobs or routes. */
export async function assertVehicleAvailable(c: pg.PoolClient, vehicleId: string, ctx: Ctx): Promise<void> {
  const v = (await loadVehicles(c, ctx, { id: vehicleId }))[0];
  if (v && v.blockedReasons.length) throw new ConflictException({ message: `${v.name} cannot take new jobs: ${v.blockedReasons.join("; ")}`, code: "vehicle_blocked", reasons: v.blockedReasons });
}

export const todayIn = (tz: string, now = new Date()): string => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
