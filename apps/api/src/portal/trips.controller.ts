import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { parseCents, type Permission } from "@routenorth/shared";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard.js";
import { auditChange } from "../audit/domain-audit.js";
import { PG_POOL } from "../tokens.js";
import { body as asBody, cents, companyFormat, dateOnly, int, num, oneOf, onlyKeys, pageParams, requireAny, str, uuid } from "./common.js";
import { calcTripPay } from "./pay.service.js";
import { todayIn } from "./vehicles.service.js";

const can = (req: AuthedRequest, ...p: Permission[]) => p.some((x) => req.perms?.has(x));
const STATUSES = ["completed", "cancelled", "failed", "no_show"] as const;
const COND_KEYS = ["peak", "night", "weekend", "holiday", "weather", "outOfZone"] as const;
/** Fields that change what is paid; once a trip is in a payout these can no longer change. */
const PAY_FIELDS = ["driverId", "vehicleId", "customerName", "startedAt", "distanceKm", "durationMin", "waitingMin", "stops", "weightKg", "zone", "status", "revenueCents", "tipCents", "tollCents", "conditions"];

const SELECT = `t.id, t.vehicle_id AS "vehicleId", v.name AS "vehicleName", t.driver_id AS "driverId", coalesce(u.display_name, u.email) AS "driverName", t.customer_name AS "customerName", t.title,
  t.started_at AS "startedAt", t.ended_at AS "endedAt", t.distance_m / 1000.0 AS "distanceKm", t.duration_s / 60.0 AS "durationMin", t.waiting_s / 60.0 AS "waitingMin", t.stops, t.weight_kg AS "weightKg", t.zone, t.status,
  t.revenue_cents::float8 AS "revenueCents", t.tip_cents::float8 AS "tipCents", t.toll_cents::float8 AS "tollCents", t.conditions, t.source, t.note, t.rating, t.on_time AS "onTime", t.cleanliness, t.complaint,
  t.revenue_manual AS "revenueManual", t.pay_calculated_at AS "payCalculatedAt", t.vehicle_cost_cents::float8 AS "vehicleCostCents", t.driver_rate_version_id AS "driverRateVersionId", t.customer_rate_version_id AS "customerRateVersionId",
  coalesce((SELECT sum(l.amount_cents) FROM portal_pay_lines l WHERE l.trip_id = t.id AND l.archived_at IS NULL AND l.approval = 'approved' AND l.kind IN ('earning','addon')),0)::float8 AS "driverPayCents",
  EXISTS (SELECT 1 FROM portal_pay_lines l WHERE l.trip_id = t.id AND l.payout_id IS NOT NULL AND l.archived_at IS NULL) AS locked, t.created_at AS "createdAt", t.archived_at AS "archivedAt"`;
const FROM = `portal_trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id LEFT JOIN users u ON u.id = t.driver_id`;

function parseTrip(b: Record<string, unknown>, creating: boolean): Record<string, unknown> {
  onlyKeys(b, [...PAY_FIELDS, "endedAt", "title", "note", "rating", "onTime", "cleanliness", "complaint", "recalculate"]);
  const o: Record<string, unknown> = {};
  const at = (v: unknown, name: string, required: boolean) => {
    if (v == null || v === "") { if (required) throw new BadRequestException(`${name} is required`); return null; }
    const d = new Date(String(v));
    if (Number.isNaN(d.getTime())) throw new BadRequestException(`${name} must be a date and time`);
    return d.toISOString();
  };
  if (creating || b.startedAt !== undefined) o.started_at = at(b.startedAt, "startedAt", true);
  if (b.endedAt !== undefined) o.ended_at = at(b.endedAt, "endedAt", false);
  if (b.driverId !== undefined) o.driver_id = b.driverId == null || b.driverId === "" ? null : uuid(b.driverId, "driverId");
  if (b.vehicleId !== undefined) o.vehicle_id = b.vehicleId == null || b.vehicleId === "" ? null : uuid(b.vehicleId, "vehicleId");
  if (b.customerName !== undefined) o.customer_name = str(b.customerName, "customerName", { max: 200 });
  if (b.title !== undefined) o.title = str(b.title, "title", { max: 200 });
  if (b.note !== undefined) o.note = str(b.note, "note", { max: 1000 });
  if (b.complaint !== undefined) o.complaint = str(b.complaint, "complaint", { max: 1000 });
  if (b.zone !== undefined) o.zone = str(b.zone, "zone", { max: 80 });
  if (b.distanceKm !== undefined) o.distance_m = Math.round((num(b.distanceKm, "distanceKm", { min: 0, max: 100_000, required: true })!) * 1000);
  if (b.durationMin !== undefined) o.duration_s = Math.round((num(b.durationMin, "durationMin", { min: 0, max: 100_000, required: true })!) * 60);
  if (b.waitingMin !== undefined) o.waiting_s = Math.round((num(b.waitingMin, "waitingMin", { min: 0, max: 100_000, required: true })!) * 60);
  if (b.stops !== undefined) o.stops = int(b.stops, "stops", { min: 0, max: 1000, required: true });
  if (b.weightKg !== undefined) o.weight_kg = num(b.weightKg, "weightKg", { min: 0, max: 1_000_000, required: true });
  if (b.status !== undefined) o.status = oneOf(b.status, "status", STATUSES, { required: true });
  if (b.tipCents !== undefined) o.tip_cents = cents(b.tipCents, "tipCents") ?? 0;
  if (b.tollCents !== undefined) o.toll_cents = cents(b.tollCents, "tollCents") ?? 0;
  if (b.revenueCents !== undefined) {
    const r = cents(b.revenueCents, "revenueCents");
    // A price typed by hand wins over the customer rate card; leaving it empty lets the card price the trip.
    o.revenue_manual = r != null && r > 0; o.revenue_cents = r ?? 0;
  }
  if (b.rating !== undefined) o.rating = b.rating == null || b.rating === "" ? null : int(b.rating, "rating", { min: 1, max: 5 });
  if (b.cleanliness !== undefined) o.cleanliness = b.cleanliness == null || b.cleanliness === "" ? null : int(b.cleanliness, "cleanliness", { min: 1, max: 5 });
  if (b.onTime !== undefined) o.on_time = b.onTime == null || b.onTime === "" ? null : b.onTime === true;
  if (b.conditions !== undefined) {
    const k = asBody(b.conditions); onlyKeys(k, [...COND_KEYS, "surge"]);
    const cond: Record<string, unknown> = {};
    for (const key of COND_KEYS) if (k[key] === true) cond[key] = true;
    if (k.surge != null && k.surge !== "") cond.surge = num(k.surge, "surge", { min: 1, max: 20 });
    o.conditions = JSON.stringify(cond);
  }
  return o;
}

/** Trips: what each job earned for the customer, what the driver was paid, and what the car cost, all from the rate cards in force that day. */
@Controller("portal/trips")
@UseGuards(AuthGuard)
export class PortalTripsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}
  private view(req: AuthedRequest) { return requireAny(req, "pay.view", "pay.manage", "finance.view", "vehicles.costs"); }
  private write(req: AuthedRequest) { return requireAny(req, "pay.manage"); }

  private async checkRefs(c: pg.PoolClient, v: Record<string, unknown>) {
    if (v.driver_id && !(await c.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'driver'`, [v.driver_id])).rowCount) throw new BadRequestException("driver not found");
    if (v.vehicle_id && !(await c.query(`SELECT 1 FROM vehicles WHERE id = $1`, [v.vehicle_id])).rowCount) throw new BadRequestException("vehicle not found");
  }

  @Get()
  async list(@Req() req: AuthedRequest, @Query() q: Record<string, string | undefined>) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const f = await companyFormat(c); const today = todayIn(f.timezone);
      const to = dateOnly(q.to, "to") ?? today;
      const from = dateOnly(q.from, "from") ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
      const p = pageParams(q, ["started_at", "revenue_cents", "distance_m"], "started_at", 2000);
      const params: unknown[] = [from, to, f.timezone];
      const where = [`(t.started_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date`, q.archived === "1" ? "t.archived_at IS NOT NULL" : "t.archived_at IS NULL"];
      if (q.driverId) { params.push(uuid(q.driverId, "driverId")); where.push(`t.driver_id = $${params.length}`); }
      if (q.vehicleId) { params.push(uuid(q.vehicleId, "vehicleId")); where.push(`t.vehicle_id = $${params.length}`); }
      if (q.status) { params.push(oneOf(q.status, "status", STATUSES)); where.push(`t.status = $${params.length}`); }
      if (p.q) { params.push(`%${p.q}%`); where.push(`(t.customer_name ILIKE $${params.length} OR t.title ILIKE $${params.length} OR t.zone ILIKE $${params.length})`); }
      const rows = (await c.query(`SELECT ${SELECT} FROM ${FROM} WHERE ${where.join(" AND ")} ORDER BY t.${p.sort} ${q.dir === "asc" ? "ASC" : "DESC"} LIMIT ${p.limit} OFFSET ${p.offset}`, params)).rows;
      const seePay = can(req, "pay.view", "pay.manage");
      const trips = rows.map((r) => ({ ...r, driverPayCents: seePay ? r.driverPayCents : null, marginCents: seePay && r.status === "completed" ? r.revenueCents - r.driverPayCents - (r.vehicleCostCents ?? 0) : null }));
      return { from, to, trips, totals: { count: trips.length, revenueCents: trips.reduce((a, r) => a + (r.status === "completed" ? r.revenueCents : 0), 0), driverPayCents: seePay ? trips.reduce((a, r) => a + r.driverPayCents, 0) : null } };
    });
  }

  @Get(":id")
  async one(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const t = (await c.query(`SELECT ${SELECT}, t.customer_lines AS "customerLines" FROM ${FROM} WHERE t.id = $1`, [uuid(id)])).rows[0];
      if (!t) throw new NotFoundException();
      const seePay = can(req, "pay.view", "pay.manage");
      if (!seePay) return { ...t, driverPayCents: null, driverLines: [], customerLines: [] };
      const ver = async (vid: string | null) => vid ? (await c.query(`SELECT k.id AS "cardId", k.name, v.version, v.starts_on::text AS "startsOn" FROM portal_rate_versions v JOIN portal_rate_cards k ON k.id = v.card_id WHERE v.id = $1`, [vid])).rows[0] ?? null : null;
      const lines = (await c.query(`SELECT id, kind, key, label, amount_cents::float8 AS "cents", source, payout_id AS "payoutId", approval FROM portal_pay_lines WHERE trip_id = $1 AND archived_at IS NULL ORDER BY created_at, key`, [id])).rows;
      return {
        ...t, driverLines: lines, driverCard: await ver(t.driverRateVersionId), customerCard: await ver(t.customerRateVersionId),
        carCostCents: t.vehicleCostCents ?? 0, marginCents: t.status === "completed" ? t.revenueCents - t.driverPayCents - (t.vehicleCostCents ?? 0) : null,
      };
    });
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.write(req);
    const b = asBody(raw);
    const v = parseTrip(b, true);
    return withOrg(this.pool, orgId, async (c) => {
      await this.checkRefs(c, v);
      const cols = Object.keys(v);
      const r = (await c.query(`INSERT INTO portal_trips (org_id, source, created_by, ${cols.join(", ")}) VALUES ($1,'manual',$2,${cols.map((_, i) => `$${i + 3}`).join(", ")}) RETURNING id`, [orgId, req.session!.userId, ...cols.map((k) => v[k])])).rows[0];
      const pay = b.recalculate === false ? null : await calcTripPay(c, orgId, r.id, req.session!.userId);
      await auditChange(c, req, { action: "trips.create", entity: "trips", entityId: r.id, label: String(v.title ?? v.customer_name ?? "Trip"), old: null, next: { ...b, driverPayCents: pay?.driverTotalCents ?? null } as never });
      return { id: r.id, pay };
    });
  }

  @Patch(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.write(req);
    const b = asBody(raw);
    const v = parseTrip(b, false);
    return withOrg(this.pool, orgId, async (c) => {
      const old = (await c.query(`SELECT ${SELECT} FROM ${FROM} WHERE t.id = $1 FOR UPDATE OF t`, [uuid(id)])).rows[0];
      if (!old) throw new NotFoundException();
      if (old.locked && Object.keys(b).some((k) => PAY_FIELDS.includes(k))) throw new ConflictException({ message: "This trip is already in a payout, so its pay can no longer change. Add an adjustment to the next payout instead.", code: "trip_locked" });
      await this.checkRefs(c, v);
      const cols = Object.keys(v);
      if (cols.length) await c.query(`UPDATE portal_trips SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [id, ...cols.map((k) => v[k])]);
      const pay = !old.locked && b.recalculate !== false && Object.keys(b).some((k) => PAY_FIELDS.includes(k)) ? await calcTripPay(c, orgId, id, req.session!.userId) : null;
      const next = (await c.query(`SELECT ${SELECT} FROM ${FROM} WHERE t.id = $1`, [id])).rows[0];
      await auditChange(c, req, { action: "trips.update", entity: "trips", entityId: id, label: String(old.title ?? old.customerName ?? "Trip"), old, next });
      return { ok: true, pay };
    });
  }

  @Post(":id/archive")
  @HttpCode(200)
  async archive(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.write(req);
    return withOrg(this.pool, orgId, async (c) => {
      const t = (await c.query(`SELECT t.id, t.title, t.customer_name FROM portal_trips t WHERE t.id = $1 AND t.archived_at IS NULL FOR UPDATE`, [uuid(id)])).rows[0];
      if (!t) throw new NotFoundException();
      if ((await c.query(`SELECT 1 FROM portal_pay_lines WHERE trip_id = $1 AND payout_id IS NOT NULL AND archived_at IS NULL`, [id])).rowCount) throw new ConflictException({ message: "This trip is already in a payout and cannot be archived. Add an adjustment instead.", code: "trip_locked" });
      await c.query(`UPDATE portal_pay_lines SET archived_at = now() WHERE trip_id = $1 AND payout_id IS NULL AND archived_at IS NULL`, [id]);
      await c.query(`UPDATE portal_trips SET archived_at = now(), updated_at = now() WHERE id = $1`, [id]);
      await auditChange(c, req, { action: "trips.archive", entity: "trips", entityId: id, label: String(t.title ?? t.customer_name ?? "Trip"), old: { archived: false }, next: { archived: true } });
      return { ok: true };
    });
  }

  /** Work out the pay again with the card in force on the trip's day (for example after a card was fixed). Trips already paid are skipped. */
  @Post(":id/recalculate")
  @HttpCode(200)
  async recalc(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.write(req);
    return withOrg(this.pool, orgId, async (c) => {
      const before = (await c.query(`SELECT coalesce(sum(amount_cents),0)::float8 AS pay FROM portal_pay_lines WHERE trip_id = $1 AND archived_at IS NULL AND kind IN ('earning','addon')`, [uuid(id)])).rows[0].pay;
      const pay = await calcTripPay(c, orgId, id, req.session!.userId);
      await auditChange(c, req, { action: "trips.recalculate", entity: "trips", entityId: id, label: "Trip pay recalculated", old: { driverPayCents: before }, next: { driverPayCents: pay.driverTotalCents }, sensitive: true });
      return pay;
    });
  }

  @Post("recalculate")
  @HttpCode(200)
  async recalcMany(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.write(req);
    const b = asBody(raw);
    const from = dateOnly(b.from, "from", true)!, to = dateOnly(b.to, "to", true)!;
    return withOrg(this.pool, orgId, async (c) => {
      const tz = (await companyFormat(c)).timezone;
      const ids = (await c.query(
        `SELECT t.id FROM portal_trips t WHERE t.archived_at IS NULL AND (t.started_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date
           AND NOT EXISTS (SELECT 1 FROM portal_pay_lines l WHERE l.trip_id = t.id AND l.payout_id IS NOT NULL AND l.archived_at IS NULL) ORDER BY t.started_at LIMIT 5000`, [from, to, tz])).rows;
      let done = 0;
      for (const r of ids) { await calcTripPay(c, orgId, r.id, req.session!.userId); done++; }
      await auditChange(c, req, { action: "trips.recalculate_many", entity: "trips", entityId: null, label: `Recalculated ${done} trips`, old: null, next: { from, to, trips: done }, sensitive: true });
      return { recalculated: done };
    });
  }

  /** Import trips from a spreadsheet. Checked line by line first (dryRun, the default); money columns are in dollars. */
  @Post("import")
  @HttpCode(200)
  async importRows(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.write(req);
    const b = asBody(raw);
    const rows = Array.isArray(b.rows) ? (b.rows as Record<string, unknown>[]) : [];
    if (!rows.length || rows.length > 500) throw new BadRequestException("rows must be 1 to 500 lines");
    const dry = b.dryRun !== false;
    return withOrg(this.pool, orgId, async (c) => {
      const report: { line: number; ok: boolean; errors: string[] }[] = [];
      const todo: Record<string, unknown>[] = [];
      for (const [k, r] of rows.entries()) {
        const errors: string[] = [];
        let body: Record<string, unknown> = {};
        try {
          const money = (v: unknown) => (v == null || v === "" ? undefined : parseCents(String(v)));
          const email = String(r.driverEmail ?? "").trim().toLowerCase();
          const driver = email ? (await c.query(`SELECT id FROM users WHERE lower(email) = $1 AND role = 'driver'`, [email])).rows[0] : null;
          if (email && !driver) errors.push(`no driver with email ${email}`);
          const plate = String(r.vehicle ?? "").trim();
          const veh = plate ? (await c.query(`SELECT id FROM vehicles WHERE lower(plate) = lower($1) OR lower(name) = lower($1) LIMIT 1`, [plate])).rows[0] : null;
          if (plate && !veh) errors.push(`no vehicle called ${plate}`);
          body = {
            startedAt: r.startedAt, driverId: driver?.id ?? null, vehicleId: veh?.id ?? null, customerName: r.customer, zone: r.zone, status: r.status || "completed",
            distanceKm: r.distanceKm === "" || r.distanceKm == null ? 0 : Number(r.distanceKm), durationMin: r.durationMin === "" || r.durationMin == null ? 0 : Number(r.durationMin), waitingMin: r.waitingMin ? Number(r.waitingMin) : 0,
            stops: r.stops ? Number(r.stops) : 1, weightKg: r.weightKg ? Number(r.weightKg) : 0, revenueCents: money(r.price), tipCents: money(r.tip) ?? 0, tollCents: money(r.toll) ?? 0,
            conditions: Object.fromEntries(COND_KEYS.filter((key) => /^(1|true|yes|y)$/i.test(String(r[key] ?? "")) ).map((key) => [key, true])),
          };
          if (!errors.length) parseTrip(body, true);
        } catch (x) { errors.push(x instanceof Error ? x.message : "invalid line"); }
        report.push({ line: k + 1, ok: !errors.length, errors });
        if (!errors.length) todo.push(body);
      }
      if (dry || report.some((r) => !r.ok)) return { dryRun: true, created: 0, ok: report.every((r) => r.ok), report };
      for (const body of todo) {
        const v = parseTrip(body, true); const cols = Object.keys(v);
        const r = (await c.query(`INSERT INTO portal_trips (org_id, source, created_by, ${cols.join(", ")}) VALUES ($1,'import',$2,${cols.map((_, i) => `$${i + 3}`).join(", ")}) RETURNING id`, [orgId, req.session!.userId, ...cols.map((k) => v[k])])).rows[0];
        await calcTripPay(c, orgId, r.id, req.session!.userId);
      }
      await auditChange(c, req, { action: "trips.import", entity: "trips", entityId: null, label: `Imported ${todo.length} trips`, old: null, next: { trips: todo.length } });
      return { dryRun: false, created: todo.length, ok: true, report };
    });
  }
}
