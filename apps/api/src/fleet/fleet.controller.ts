import { BadRequestException, Body, Controller, Get, Inject, NotFoundException, Param, Post, Put, Query, Req, Res, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { detectTrips, documentState, daysToExpiry, fuelEconomy, haversine, maintenanceDue, type Fix } from "@routenorth/shared";
import type { Response } from "express";
import { AuthGuard, requirePerm, type AuthedRequest, requireAny } from "../auth/auth.guard.js";
import { parseRange, parseUuid } from "../history/range.js";
import { csvToObjects } from "../routes/csv.js";
import { parseDate } from "../routes/validate.js";
import { csvEscape } from "../resources/engine.js";
import { PG_POOL } from "../tokens.js";

const csvOut = (cols: string[], rows: Record<string, unknown>[]) => [cols.join(","), ...rows.map((r) => cols.map((c) => csvEscape(r[c])).join(","))].join("\r\n");

/** The default digital inspection checklist (keys are translated by the apps). */
export const INSPECTION_ITEMS = ["tires", "lights", "brakes", "mirrors", "wipers", "fluids", "horn", "seatbelts", "fireExtinguisher", "firstAid", "cargoSecure", "bodyDamage", "cleanliness"] as const;

@Controller("fleet")
@UseGuards(AuthGuard)
export class FleetController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Best known odometer (km) per vehicle: the larger of the value on file and the tracker's own reading. */
  private async odometers(c: pg.PoolClient): Promise<Map<string, number>> {
    const rows = (await c.query<{ id: string; km: number }>(
      `SELECT v.id, greatest(v.odometer_km, coalesce((SELECT max(p.odometer) / 1000 FROM latest_positions lp JOIN devices d ON d.id = lp.device_id
          JOIN positions p ON p.device_id = d.id AND p.time = lp.time WHERE d.vehicle_id = v.id), 0)) AS km FROM vehicles v`)).rows;
    return new Map(rows.map((r) => [r.id, Number(r.km)]));
  }

  /** Everything that needs attention: expiring documents and licences, maintenance due, open defects. */
  @Get("reminders")
  async reminders(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "fleet.view", "routes.view");
    return withOrg(this.pool, orgId, async (c) => {
      const today = (await c.query<{ d: string }>("SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM organizations WHERE id = $1", [orgId])).rows[0]!.d;
      const odo = await this.odometers(c);
      const docs = (await c.query(
        `SELECT d.id, d.owner_kind AS "ownerKind", d.owner_id AS "ownerId", d.kind, d.number, d.expires_on::text AS "expiresOn", d.remind_days AS "remindDays",
                coalesce(v.name, e.name, coalesce(u.display_name, u.email)) AS "ownerName"
         FROM documents d LEFT JOIN vehicles v ON d.owner_kind = 'vehicle' AND v.id = d.owner_id
           LEFT JOIN equipment e ON d.owner_kind = 'equipment' AND e.id = d.owner_id
           LEFT JOIN users u ON d.owner_kind = 'driver' AND u.id = d.owner_id WHERE d.expires_on IS NOT NULL`)).rows;
      const licences = (await c.query(
        `SELECT dp.user_id AS "ownerId", coalesce(u.display_name, u.email) AS "ownerName", dp.license_expiry::text AS "expiresOn" FROM driver_profiles dp
         JOIN users u ON u.id = dp.user_id WHERE dp.license_expiry IS NOT NULL AND u.disabled_at IS NULL`)).rows;
      const plans = (await c.query(
        `SELECT p.id, p.vehicle_id AS "vehicleId", v.name AS "vehicleName", p.task, p.every_days AS "everyDays", p.every_km AS "everyKm",
                p.last_done_on::text AS "lastDoneOn", p.last_done_km AS "lastDoneKm" FROM maintenance_plans p JOIN vehicles v ON v.id = p.vehicle_id WHERE v.status <> 'retired'`)).rows;
      const items: { type: string; state: string; title: string; subject: string; detail: string; refId: string; due: string | null; daysLeft: number | null; kmLeft?: number | null }[] = [];
      for (const d of docs) {
        const state = documentState(d.expiresOn, d.remindDays, today);
        if (state !== "ok") items.push({ type: "document", state, title: d.kind, subject: d.ownerName, detail: d.number ?? "", refId: d.id, due: d.expiresOn, daysLeft: daysToExpiry(d.expiresOn, today) });
      }
      for (const l of licences) {
        const state = documentState(l.expiresOn, 30, today);
        if (state !== "ok") items.push({ type: "licence", state, title: "licence", subject: l.ownerName, detail: "", refId: l.ownerId, due: l.expiresOn, daysLeft: daysToExpiry(l.expiresOn, today) });
      }
      for (const p of plans) {
        const due = maintenanceDue(p, today, odo.get(p.vehicleId) ?? 0);
        if (due.state !== "ok") items.push({ type: "maintenance", state: due.state, title: p.task, subject: p.vehicleName, detail: due.dueKm != null ? `${Math.round(due.dueKm)} km` : "", refId: p.id, due: due.dueOn, daysLeft: due.daysLeft, kmLeft: due.kmLeft });
      }
      const defects = (await c.query(
        `SELECT i.id, v.name AS "vehicleName", i.at, i.notes FROM inspections i JOIN vehicles v ON v.id = i.vehicle_id
         WHERE i.defects AND i.at > now() - interval '14 days' AND NOT EXISTS (SELECT 1 FROM inspections j WHERE j.vehicle_id = i.vehicle_id AND j.at > i.at AND NOT j.defects)`)).rows;
      for (const d of defects) items.push({ type: "defect", state: "due_soon", title: "inspection defect", subject: d.vehicleName, detail: d.notes ?? "", refId: d.id, due: new Date(d.at).toISOString().slice(0, 10), daysLeft: null });
      const rank = (s: string) => (s === "overdue" ? 0 : 1);
      items.sort((a, b) => rank(a.state) - rank(b.state) || (a.daysLeft ?? 0) - (b.daysLeft ?? 0));
      return { today, counts: { overdue: items.filter((i) => i.state === "overdue").length, dueSoon: items.filter((i) => i.state === "due_soon").length }, items };
    });
  }

  /** Maintenance schedule for every vehicle with its next due date or odometer. */
  @Get("maintenance")
  async maintenance(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "fleet.view", "routes.view");
    return withOrg(this.pool, orgId, async (c) => {
      const today = (await c.query<{ d: string }>("SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM organizations WHERE id = $1", [orgId])).rows[0]!.d;
      const odo = await this.odometers(c);
      const plans = (await c.query(
        `SELECT p.id, p.vehicle_id AS "vehicleId", v.name AS "vehicleName", p.task, p.every_days AS "everyDays", p.every_km AS "everyKm",
                p.last_done_on::text AS "lastDoneOn", p.last_done_km AS "lastDoneKm" FROM maintenance_plans p JOIN vehicles v ON v.id = p.vehicle_id ORDER BY v.name, p.task`)).rows;
      return plans.map((p) => ({ ...p, odometerKm: Math.round(odo.get(p.vehicleId) ?? 0), ...maintenanceDue(p, today, odo.get(p.vehicleId) ?? 0) }));
    });
  }

  /** Mark a maintenance task done: records the log and resets the plan's clock. */
  @Post("maintenance/:planId/complete")
  async complete(@Req() req: AuthedRequest, @Param("planId") planId: string, @Body() body: { doneOn?: unknown; odometerKm?: unknown; cost?: unknown; vendor?: unknown; notes?: unknown }) {
    const orgId = requirePerm(req, "fleet.manage");
    const pid = parseUuid(planId);
    const doneOn = body?.doneOn ? parseDate(body.doneOn) : null;
    const num = (v: unknown, f: string) => { if (v == null || v === "") return null; const n = Number(v); if (!(n >= 0)) throw new BadRequestException(`${f} must be a number`); return n; };
    const odometerKm = num(body?.odometerKm, "odometerKm");
    const cost = num(body?.cost, "cost");
    return withOrg(this.pool, orgId, async (c) => {
      const plan = (await c.query("SELECT * FROM maintenance_plans WHERE id = $1 FOR UPDATE", [pid])).rows[0];
      if (!plan) throw new NotFoundException();
      const date = doneOn ?? (await c.query<{ d: string }>("SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM organizations WHERE id = $1", [orgId])).rows[0]!.d;
      const km = odometerKm ?? (await this.odometers(c)).get(plan.vehicle_id) ?? null;
      const log = (await c.query(
        `INSERT INTO maintenance_logs (org_id, vehicle_id, plan_id, task, done_on, odometer_km, cost, vendor, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [orgId, plan.vehicle_id, pid, plan.task, date, km, cost, body?.vendor ? String(body.vendor).slice(0, 120) : null, body?.notes ? String(body.notes).slice(0, 1000) : null])).rows[0];
      await c.query("UPDATE maintenance_plans SET last_done_on = $2, last_done_km = $3 WHERE id = $1", [pid, date, km]);
      if (km != null) await c.query("UPDATE vehicles SET odometer_km = greatest(odometer_km, $2) WHERE id = $1", [plan.vehicle_id, km]);
      return { logId: log.id, doneOn: date, odometerKm: km };
    });
  }

  /** Import fuel-card transactions from CSV: date, vehicle (name or plate), litres, cost, odometer_km, station, card_last4. */
  @Post("fuel/import")
  async importFuel(@Req() req: AuthedRequest, @Body() body: { csv?: unknown }) {
    const orgId = requirePerm(req, "fleet.manage");
    if (typeof body?.csv !== "string" || body.csv.length > 2_000_000) throw new BadRequestException("csv must be text under 2 MB");
    const rows = csvToObjects(body.csv);
    if (rows.length === 0) throw new BadRequestException("csv has no rows");
    if (rows.length > 5000) throw new BadRequestException("at most 5000 rows at a time");
    const errors: { row: number; message: string }[] = [];
    let created = 0, duplicates = 0;
    await withOrg(this.pool, orgId, async (c) => {
      const vehicles = (await c.query<{ id: string; name: string; plate: string | null }>("SELECT id, name, plate FROM vehicles")).rows;
      const find = (v: string) => { const k = v.trim().toLowerCase(); return vehicles.find((x) => x.plate?.toLowerCase() === k || x.name.toLowerCase() === k); };
      for (const [i, r] of rows.entries()) {
        try {
          const veh = find(r.vehicle || r.plate || r.unit || "");
          if (!veh) throw new Error(`unknown vehicle "${r.vehicle || r.plate || ""}"`);
          const date = parseDate((r.date || r.filled_on || "").slice(0, 10));
          const litres = Number(r.litres ?? r.liters ?? r.quantity);
          if (!(litres > 0 && litres < 5000)) throw new Error("litres must be a positive number");
          const cost = r.cost === undefined || r.cost === "" ? null : Number(r.cost);
          if (cost !== null && !(cost >= 0)) throw new Error("cost must be a number");
          const odo = r.odometer_km || r.odometer ? Number(r.odometer_km || r.odometer) : null;
          if (odo !== null && !(odo >= 0)) throw new Error("odometer_km must be a number");
          const card = r.card_last4 || r.card ? String(r.card_last4 || r.card).slice(-4) : null;
          if (card && !/^\d{4}$/.test(card)) throw new Error("card_last4 must be 4 digits");
          // The same card transaction imported twice is skipped.
          const dup = await c.query("SELECT 1 FROM fuel_logs WHERE vehicle_id = $1 AND filled_on = $2 AND litres = $3 AND coalesce(cost, -1) = coalesce($4::float8, -1) AND source = 'import'", [veh.id, date, litres, cost]);
          if (dup.rowCount) { duplicates++; continue; }
          await c.query(
            `INSERT INTO fuel_logs (org_id, vehicle_id, filled_on, litres, cost, odometer_km, station, card_last4, source) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'import')`,
            [orgId, veh.id, date, litres, cost, odo, r.station ? r.station.slice(0, 120) : null, card]);
          created++;
        } catch (e) { errors.push({ row: i + 2, message: (e as Error).message.slice(0, 120) }); }
      }
    });
    return { created, duplicates, errors };
  }

  /** Fuel use and cost per vehicle: litres per 100 km and cost per km. */
  @Get("fuel/summary")
  async fuelSummary(@Req() req: AuthedRequest, @Query("from") from?: string, @Query("to") to?: string) {
    const orgId = requireAny(req, "fleet.view", "reports.view");
    const f = from ? parseDate(from) : "1970-01-01";
    const t = to ? parseDate(to) : "2999-12-31";
    const rows = (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT l.vehicle_id AS "vehicleId", v.name, l.litres, l.cost, l.odometer_km AS "odometerKm" FROM fuel_logs l JOIN vehicles v ON v.id = l.vehicle_id
       WHERE l.filled_on BETWEEN $1 AND $2 ORDER BY v.name, l.filled_on, l.created_at`, [f, t]))).rows;
    const by = new Map<string, { name: string; fills: typeof rows }>();
    for (const r of rows) { const e: { name: string; fills: typeof rows } = by.get(r.vehicleId) ?? { name: r.name, fills: [] }; e.fills.push(r); by.set(r.vehicleId, e); }
    return [...by.entries()].map(([vehicleId, e]) => ({ vehicleId, name: e.name, fills: e.fills.length, ...fuelEconomy(e.fills) }));
  }

  // ---- trip logs for mileage and tax ----

  private async tripLog(orgId: string, from: Date, to: Date, vehicleId: string | null) {
    return withOrg(this.pool, orgId, async (c) => {
      const devices = (await c.query<{ id: string; name: string; vehicle_id: string | null }>(
        `SELECT d.id, coalesce(v.name, d.external_id) AS name, d.vehicle_id FROM devices d LEFT JOIN vehicles v ON v.id = d.vehicle_id WHERE ($1::uuid IS NULL OR d.vehicle_id = $1) ORDER BY 2`, [vehicleId])).rows;
      const places = (await c.query<{ label: string; lat: number; lng: number; r: number }>(
        `SELECT name AS label, lat, lng, radius_m AS r FROM depots UNION ALL SELECT name, lat, lng, radius_m FROM geofences WHERE shape = 'circle'`)).rows;
      const named = (lat: number, lng: number) => places.find((p) => haversine(p.lat, p.lng, lat, lng) <= Math.max(p.r, 150))?.label ?? null;
      const purposes = (await c.query<{ device_id: string; trip_start: Date; purpose: string; note: string | null }>(
        "SELECT device_id, trip_start, purpose, note FROM trip_purposes WHERE trip_start >= $1 AND trip_start < $2", [from, to])).rows;
      const out = [];
      for (const d of devices) {
        const fixes = (await c.query<{ time: Date; lat: number; lng: number; speed: number; ignition: boolean | null; odometer: number | null }>(
          "SELECT time, lat, lng, speed, ignition, odometer FROM positions WHERE device_id = $1 AND time >= $2 AND time < $3 ORDER BY time LIMIT 200000", [d.id, from, to])).rows;
        const trips = detectTrips(fixes.map((r): Fix => ({ time: r.time.toISOString(), lat: r.lat, lng: r.lng, speed: r.speed, ignition: r.ignition, odometer: r.odometer }))).trips;
        for (const t of trips) {
          const p = purposes.find((x) => x.device_id === d.id && x.trip_start.toISOString() === t.start.time);
          out.push({
            deviceId: d.id, vehicleId: d.vehicle_id, vehicle: d.name, start: t.start.time, end: t.end.time, km: Math.round(t.distanceM / 100) / 10, minutes: Math.round(t.durationS / 60),
            from: named(t.start.lat, t.start.lng), to: named(t.end.lat, t.end.lng), fromLat: t.start.lat, fromLng: t.start.lng, toLat: t.end.lat, toLng: t.end.lng,
            purpose: p?.purpose ?? null, note: p?.note ?? null,
          });
        }
      }
      return out;
    });
  }

  @Get("trip-log")
  async tripLogJson(@Req() req: AuthedRequest, @Res() res: Response, @Query("from") from?: string, @Query("to") to?: string, @Query("vehicleId") vehicleId?: string, @Query("format") format?: string) {
    const orgId = requireAny(req, "fleet.view", "reports.view");
    const range = parseRange(from, to, 31);
    const rows = await this.tripLog(orgId, range.from, range.to, vehicleId ? parseUuid(vehicleId) : null);
    if (format === "csv") {
      requirePerm(req, "reports.export");
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", 'attachment; filename="trip-log.csv"');
      res.send(csvOut(["vehicle", "start", "end", "km", "minutes", "from", "to", "purpose", "note"], rows));
      return;
    }
    res.json({ trips: rows, totals: { km: Math.round(rows.reduce((a, r) => a + r.km, 0) * 10) / 10, business: Math.round(rows.filter((r) => r.purpose === "business").reduce((a, r) => a + r.km, 0) * 10) / 10, personal: Math.round(rows.filter((r) => r.purpose === "personal").reduce((a, r) => a + r.km, 0) * 10) / 10, untagged: rows.filter((r) => !r.purpose).length } });
  }

  /** Tag a trip as business or personal (with an optional note). */
  @Put("trip-log/purpose")
  async purpose(@Req() req: AuthedRequest, @Body() body: { deviceId?: unknown; start?: unknown; purpose?: unknown; note?: unknown }) {
    const orgId = requirePerm(req, "fleet.manage");
    const deviceId = parseUuid(String(body?.deviceId));
    const start = new Date(String(body?.start));
    if (Number.isNaN(start.getTime())) throw new BadRequestException("start must be a timestamp");
    if (body?.purpose !== "business" && body?.purpose !== "personal") throw new BadRequestException("purpose must be business or personal");
    return withOrg(this.pool, orgId, async (c) => {
      if (!(await c.query("SELECT 1 FROM devices WHERE id = $1", [deviceId])).rowCount) throw new NotFoundException();
      await c.query(
        `INSERT INTO trip_purposes (org_id, device_id, trip_start, purpose, note, set_by) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (device_id, trip_start) DO UPDATE SET purpose = EXCLUDED.purpose, note = EXCLUDED.note, set_by = EXCLUDED.set_by, set_at = now()`,
        [orgId, deviceId, start, body.purpose, body?.note ? String(body.note).slice(0, 300) : null, req.session!.userId]);
      return { ok: true };
    });
  }

  // ---- depots ----

  /** How many vehicles are inside each depot right now, against its parking spots. */
  @Get("depots/occupancy")
  async occupancy(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "fleet.view", "routes.view");
    return withOrg(this.pool, orgId, async (c) => {
      const depots = (await c.query("SELECT id, name, lat, lng, radius_m AS \"radiusM\", spots FROM depots ORDER BY name")).rows;
      const live = (await c.query<{ vehicle_id: string | null; name: string; lat: number; lng: number }>(
        `SELECT d.vehicle_id, coalesce(v.name, d.external_id) AS name, lp.lat, lp.lng FROM latest_positions lp JOIN devices d ON d.id = lp.device_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
         WHERE lp.time > now() - interval '30 minutes'`)).rows;
      return depots.map((d) => {
        const inside = live.filter((v) => haversine(d.lat, d.lng, v.lat, v.lng) <= d.radiusM).map((v) => v.name);
        return { ...d, occupied: inside.length, free: Math.max(0, d.spots - inside.length), over: Math.max(0, inside.length - d.spots), vehicles: inside };
      });
    });
  }

  @Get("inspection-template")
  template() { return { items: INSPECTION_ITEMS }; }

  // ---- drivers ----

  @Get("drivers")
  async drivers(@Req() req: AuthedRequest) {
    const org = requireAny(req, "users.view", "routes.view");
    return withOrg(this.pool, org, async (c) => (await c.query(
      `SELECT u.id, coalesce(u.display_name, u.email) AS name, u.email, (u.disabled_at IS NOT NULL) AS disabled, dp.phone, dp.license_no AS "licenseNo", dp.license_class AS "licenseClass",
              dp.license_expiry::text AS "licenseExpiry", dp.emergency_name AS "emergencyName", dp.emergency_phone AS "emergencyPhone", dp.home_depot_id AS "homeDepotId",
              coalesce(dp.max_shift_min, 600) AS "maxShiftMin", coalesce(dp.break_after_min, 300) AS "breakAfterMin", coalesce(dp.break_min, 30) AS "breakMin",
              coalesce(dp.skills, '{}') AS skills, coalesce(dp.training, '[]'::jsonb) AS training, dp.notes
       FROM users u LEFT JOIN driver_profiles dp ON dp.user_id = u.id WHERE u.role = 'driver' ORDER BY name`)).rows);
  }

  @Put("drivers/:id")
  async saveDriver(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: Record<string, unknown>) {
    const orgId = requirePerm(req, "fleet.manage");
    const uid = parseUuid(id);
    const txt = (k: string, max: number) => { const v = body[k]; if (v == null || v === "") return null; if (typeof v !== "string" || v.length > max) throw new BadRequestException(`${k} must be text up to ${max} characters`); return v.trim(); };
    const int = (k: string, min: number, max: number, d: number) => { if (body[k] == null) return d; const n = Number(body[k]); if (!Number.isInteger(n) || n < min || n > max) throw new BadRequestException(`${k} must be ${min} to ${max}`); return n; };
    const expiry = body.licenseExpiry == null || body.licenseExpiry === "" ? null : parseDate(body.licenseExpiry);
    const skills = body.skills == null ? [] : body.skills;
    if (!Array.isArray(skills) || skills.length > 30 || skills.some((s) => typeof s !== "string" || !s || s.length > 40)) throw new BadRequestException("skills must be a list of short names");
    const training = body.training == null ? [] : body.training;
    if (!Array.isArray(training) || training.length > 50 || JSON.stringify(training).length > 20_000) throw new BadRequestException("training must be a short list");
    const depot = body.homeDepotId == null || body.homeDepotId === "" ? null : parseUuid(String(body.homeDepotId));
    return withOrg(this.pool, orgId, async (c) => {
      if (!(await c.query("SELECT 1 FROM users WHERE id = $1 AND role = 'driver'", [uid])).rowCount) throw new NotFoundException();
      if (depot && !(await c.query("SELECT 1 FROM depots WHERE id = $1", [depot])).rowCount) throw new BadRequestException("unknown depot");
      await c.query(
        `INSERT INTO driver_profiles (user_id, org_id, phone, license_no, license_class, license_expiry, emergency_name, emergency_phone, home_depot_id, max_shift_min, break_after_min, break_min, skills, training, notes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
         ON CONFLICT (user_id) DO UPDATE SET phone = EXCLUDED.phone, license_no = EXCLUDED.license_no, license_class = EXCLUDED.license_class, license_expiry = EXCLUDED.license_expiry,
           emergency_name = EXCLUDED.emergency_name, emergency_phone = EXCLUDED.emergency_phone, home_depot_id = EXCLUDED.home_depot_id, max_shift_min = EXCLUDED.max_shift_min,
           break_after_min = EXCLUDED.break_after_min, break_min = EXCLUDED.break_min, skills = EXCLUDED.skills, training = EXCLUDED.training, notes = EXCLUDED.notes, updated_at = now()`,
        [uid, orgId, txt("phone", 40), txt("licenseNo", 40), txt("licenseClass", 20), expiry, txt("emergencyName", 120), txt("emergencyPhone", 40), depot,
          int("maxShiftMin", 30, 1440, 600), int("breakAfterMin", 30, 1440, 300), int("breakMin", 5, 240, 30), skills, JSON.stringify(training), txt("notes", 2000)]);
      return { ok: true };
    });
  }
}
