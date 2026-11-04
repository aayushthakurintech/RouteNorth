import { BadRequestException, Body, ConflictException, Controller, Get, HttpCode, HttpException, Inject, NotFoundException, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { checkVin, depreciationSeries, financeAccrual, keepRepairSell, licenceAllows, paybackDays, type Permission } from "@routenorth/shared";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard.js";
import { auditChange } from "../audit/domain-audit.js";
import { parseBody } from "../resources/engine.js";
import type { ResourceDef } from "../resources/defs.js";
import { PG_POOL } from "../tokens.js";
import { body as asBody, companyFormat, regionScope, requireAny, uuid } from "./common.js";
import { archiveChild, colList, createChild, listChild, updateChild, type ChildDef } from "./crud.js";
import { shiftDay, sumMoney, vehicleMoney } from "./money-rules.js";
import { ASSIGNMENTS, CHILD_BY_NAME, FUEL_TYPES, MAINTENANCE, VEHICLE_FIELDS, VEHICLE_KINDS, VEHICLE_STATUSES, VIEW_VEHICLES } from "./vehicles.defs.js";
import { assertVehicleAvailable, loadVehicles, todayIn, type Ctx, type VehicleRow } from "./vehicles.service.js";

/** Fields only people who may see costs and values get back. */
const COST_KEYS = ["purchasePriceCents", "financePaymentCents", "financeInterval", "financeEndDate", "interestRatePct", "residualValueCents", "currentValueCents", "monthProfitCents"];
const VEHICLE_DEF: ChildDef = { name: "vehicles", entity: "vehicles", table: "vehicles", parentCol: "id", order: "vehicles.name", fields: VEHICLE_FIELDS, label: (r) => String(r.name ?? ""), view: VIEW_VEHICLES, write: ["vehicles.manage"] };
const SELECT = colList(VEHICLE_DEF) + `, vehicles.sold_on::text AS "soldOn", vehicles.sale_price_cents::float8 AS "salePriceCents", vehicles.current_driver_id AS "currentDriverId"`;
const AUDITED = VEHICLE_FIELDS.map((f) => f.key);
const plain = (r: Record<string, unknown>) => Object.fromEntries(AUDITED.map((k) => [k, r[k] ?? null]));

const can = (req: AuthedRequest, ...p: Permission[]) => p.some((x) => req.perms?.has(x));
function strip<T extends Record<string, unknown>>(req: AuthedRequest, row: T): T {
  if (can(req, "vehicles.costs")) return row;
  const o: Record<string, unknown> = { ...row };
  for (const k of COST_KEYS) delete o[k];
  return o as T;
}

@Controller("portal/vehicles")
@UseGuards(AuthGuard)
export class PortalVehiclesController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  private async ctx(c: pg.PoolClient): Promise<Ctx> {
    const f = await companyFormat(c);
    return { tz: f.timezone, today: todayIn(f.timezone), now: new Date() };
  }
  private view(req: AuthedRequest) { return requireAny(req, ...VIEW_VEHICLES); }
  private write(req: AuthedRequest, ...extra: Permission[]) { return requireAny(req, "vehicles.manage", ...extra); }

  // ---- list and lookups -----------------------------------------------------------------------------------------------
  @Get()
  async list(@Req() req: AuthedRequest, @Query("archived") archived?: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const ctx = await this.ctx(c);
      const rows = await loadVehicles(c, ctx, { archived: archived === "1", teamIds: await regionScope(c, req) });
      const month = ctx.today.slice(0, 8) + "01";
      const money = can(req, "vehicles.costs") ? await vehicleMoney(c, { from: month, to: ctx.today }, ctx.tz, { vehicleIds: rows.map((r) => r.id) }) : null;
      return rows.map((r) => strip(req, { ...r, monthProfitCents: money ? (money.get(r.id)?.profitCents ?? 0) : null } as VehicleRow & Record<string, unknown>));
    });
  }

  @Get("meta")
  async meta(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => ({
      kinds: VEHICLE_KINDS, statuses: VEHICLE_STATUSES, fuelTypes: FUEL_TYPES,
      teams: (await c.query(`SELECT id, name, kind FROM teams ORDER BY name`)).rows,
      depots: (await c.query(`SELECT id, name FROM depots ORDER BY name`)).rows,
      drivers: (await c.query(`SELECT id, coalesce(display_name, email) AS name FROM users WHERE role = 'driver' AND disabled_at IS NULL ORDER BY 2`)).rows,
      shops: (await c.query(`SELECT id, name FROM shops WHERE archived_at IS NULL ORDER BY name`)).rows,
      templates: SERVICE_TEMPLATES,
    }));
  }

  /** Fill make, model, year and fuel type from a VIN (US NHTSA vPIC database, which also covers Canadian-market vehicles). Needs internet access to that service. */
  @Get("vin/:vin")
  async vin(@Req() req: AuthedRequest, @Param("vin") vin: string) {
    this.view(req);
    const chk = checkVin(vin);
    if (!chk.ok) throw new BadRequestException(chk.error);
    const base = process.env.VIN_LOOKUP_URL ?? "https://vpic.nhtsa.dot.gov/api/vehicles/DecodeVinValues";
    if (base === "off") return { vin: chk.vin, checkDigitOk: chk.checkDigitOk, lookup: "off" };
    try {
      const res = await fetch(`${base}/${chk.vin}?format=json`, { signal: AbortSignal.timeout(6000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const r = ((await res.json()) as { Results?: Record<string, string>[] }).Results?.[0] ?? {};
      const fuel = (r.FuelTypePrimary ?? "").toLowerCase();
      const kindMap: Record<string, string> = { "TRUCK": "truck", "BUS": "bus", "MULTIPURPOSE PASSENGER VEHICLE (MPV)": "suv", "PASSENGER CAR": "car", "MOTORCYCLE": "bike" };
      return {
        vin: chk.vin, checkDigitOk: chk.checkDigitOk, lookup: "nhtsa",
        make: r.Make ? titleCase(r.Make) : null, model: r.Model || null, year: r.ModelYear ? Number(r.ModelYear) : null, trim: r.Trim || null,
        fuelType: fuel.includes("diesel") ? "diesel" : fuel.includes("electric") && fuel.includes("gas") ? "hybrid" : fuel.includes("electric") ? "electric" : fuel.includes("gasoline") ? "gasoline" : fuel.includes("natural") ? "cng" : fuel.includes("propane") ? "propane" : null,
        kind: kindMap[(r.VehicleType ?? "").toUpperCase()] ?? null, engine: [r.DisplacementL && `${r.DisplacementL}L`, r.EngineCylinders && `${r.EngineCylinders} cyl`].filter(Boolean).join(" ") || null, seats: r.Seats ? Number(r.Seats) : null,
        message: r.ErrorCode && r.ErrorCode !== "0" ? r.ErrorText : null,
      };
    } catch (e) {
      throw new HttpException({ message: `VIN lookup is not available right now (${e instanceof Error ? e.message : "no answer"}). Fill the details by hand.`, code: "lookup_unavailable" }, 502);
    }
  }

  private async duplicates(c: pg.PoolClient, plate: string | null, vin: string | null, excludeId: string | null) {
    const out: { id: string; name: string; field: "plate" | "vin" }[] = [];
    if (plate) for (const r of (await c.query(`SELECT id, name FROM vehicles WHERE lower(plate) = lower($1) AND archived_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`, [plate, excludeId])).rows) out.push({ ...r, field: "plate" });
    if (vin) for (const r of (await c.query(`SELECT id, name FROM vehicles WHERE upper(vin) = upper($1) AND archived_at IS NULL AND ($2::uuid IS NULL OR id <> $2)`, [vin, excludeId])).rows) out.push({ ...r, field: "vin" });
    return out;
  }

  @Post("check")
  @HttpCode(200)
  async check(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.view(req);
    const b = asBody(raw);
    const plate = typeof b.plate === "string" && b.plate.trim() ? b.plate.trim() : null;
    const vin = typeof b.vin === "string" && b.vin.trim() ? b.vin.trim().toUpperCase() : null;
    const vinCheck = vin ? checkVin(vin) : null;
    return { duplicates: await withOrg(this.pool, orgId, (c) => this.duplicates(c, plate, vin, typeof b.excludeId === "string" ? uuid(b.excludeId) : null)), vin: vinCheck };
  }

  // ---- create / edit / archive --------------------------------------------------------------------------------------------
  private cleanVehicle(v: Record<string, unknown>): void {
    if (typeof v.vin === "string") {
      const chk = checkVin(v.vin);
      if (!chk.ok) throw new BadRequestException(chk.error);
      v.vin = chk.vin;
    }
    if (typeof v.plate === "string") v.plate = v.plate.toUpperCase();
    if (v.ownershipType === "owned") { /* owned cars may still have a value */ }
    if ((v.financePaymentCents != null) !== (v.financeInterval != null) && (v.financePaymentCents !== undefined || v.financeInterval !== undefined)) throw new BadRequestException("set both the loan or lease payment and how often it is paid");
  }

  private async insertVehicle(c: pg.PoolClient, req: AuthedRequest, v: Record<string, unknown>): Promise<string> {
    this.cleanVehicle(v);
    const dups = await this.duplicates(c, (v.plate as string) ?? null, (v.vin as string) ?? null, null);
    if (dups.length) throw new ConflictException({ message: `A car with the same ${dups[0]!.field === "plate" ? "plate" : "VIN"} already exists: ${dups[0]!.name}`, code: "duplicate", duplicates: dups });
    for (const f of VEHICLE_FIELDS) if (f.type === "ref" && v[f.key]) {
      const table = f.ref === "depots" ? "depots" : "teams";
      if (!(await c.query(`SELECT 1 FROM ${table} WHERE id = $1`, [v[f.key]])).rowCount) throw new BadRequestException(`${f.key} does not exist`);
    }
    const fields = VEHICLE_FIELDS.filter((f) => v[f.key] !== undefined);
    const cols = ["org_id", ...fields.map((f) => f.col), "created_by"];
    const vals = [req.session!.orgId, ...fields.map((f) => v[f.key]), /^[0-9a-f-]{36}$/.test(req.session!.userId) ? req.session!.userId : null];
    const id = (await c.query(`INSERT INTO vehicles (${cols.join(",")}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, vals)).rows[0].id as string;
    const row = (await c.query(`SELECT ${SELECT} FROM vehicles WHERE id = $1`, [id])).rows[0];
    await auditChange(c, req, { action: "vehicles.create", entity: "vehicles", entityId: id, label: String(row.name), old: null, next: plain(row) });
    return id;
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.write(req);
    const v = parseBody({ fields: VEHICLE_FIELDS } as unknown as ResourceDef, raw, true);
    return withOrg(this.pool, orgId, async (c) => {
      const id = await this.insertVehicle(c, req, v);
      return (await loadVehicles(c, await this.ctx(c), { id }))[0];
    });
  }

  @Patch(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.write(req);
    const vid = uuid(id);
    const v = parseBody({ fields: VEHICLE_FIELDS } as unknown as ResourceDef, raw, false);
    if (!Object.keys(v).length) throw new BadRequestException("nothing to change");
    return withOrg(this.pool, orgId, async (c) => {
      const old = (await c.query(`SELECT ${SELECT}, vehicles.archived_at AS "archivedAtX" FROM vehicles WHERE id = $1 FOR UPDATE`, [vid])).rows[0];
      if (!old) throw new NotFoundException();
      if (old.archivedAtX) throw new BadRequestException("this car is archived; restore it first");
      this.cleanVehicle(v);
      const merged = { ...old, ...v };
      if (!!merged.financePaymentCents !== !!merged.financeInterval) throw new BadRequestException("set both the loan or lease payment and how often it is paid");
      if ((v.plate !== undefined || v.vin !== undefined)) {
        const dups = await this.duplicates(c, (merged.plate as string) ?? null, (merged.vin as string) ?? null, vid);
        if (dups.length) throw new ConflictException({ message: `Another car already has this ${dups[0]!.field === "plate" ? "plate" : "VIN"}: ${dups[0]!.name}`, code: "duplicate", duplicates: dups });
      }
      const fields = VEHICLE_FIELDS.filter((f) => v[f.key] !== undefined);
      await c.query(`UPDATE vehicles SET ${fields.map((f, i) => `${f.col} = $${i + 2}`).join(", ")}, updated_at = now() WHERE id = $1`, [vid, ...fields.map((f) => v[f.key])]);
      const row = (await c.query(`SELECT ${SELECT} FROM vehicles WHERE id = $1`, [vid])).rows[0];
      await auditChange(c, req, { action: "vehicles.update", entity: "vehicles", entityId: vid, label: String(row.name), old: plain(old), next: plain(row) });
      return (await loadVehicles(c, await this.ctx(c), { id: vid }))[0];
    });
  }

  private async setArchived(req: AuthedRequest, id: string, archive: boolean) {
    const orgId = this.write(req);
    const vid = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const old = (await c.query(`SELECT name, archived_at FROM vehicles WHERE id = $1 FOR UPDATE`, [vid])).rows[0];
      if (!old) throw new NotFoundException();
      if (!!old.archived_at === archive) return { id: vid, archived: archive };
      await c.query(`UPDATE vehicles SET archived_at = ${archive ? "now()" : "NULL"}, current_driver_id = ${archive ? "NULL" : "current_driver_id"}, updated_at = now() WHERE id = $1`, [vid]);
      if (archive) await c.query(`UPDATE vehicle_assignments SET end_at = now() WHERE vehicle_id = $1 AND archived_at IS NULL AND (end_at IS NULL OR end_at > now())`, [vid]);
      await auditChange(c, req, { action: `vehicles.${archive ? "archive" : "restore"}`, entity: "vehicles", entityId: vid, label: old.name, old: { archivedAt: old.archived_at }, next: { archivedAt: archive ? new Date().toISOString() : null } });
      return { id: vid, archived: archive };
    });
  }
  @Post(":id/archive") @HttpCode(200) archive(@Req() req: AuthedRequest, @Param("id") id: string) { return this.setArchived(req, id, true); }
  @Post(":id/restore") @HttpCode(200) restore(@Req() req: AuthedRequest, @Param("id") id: string) { return this.setArchived(req, id, false); }

  /** Record the sale: the car leaves the active fleet but stays in every old report. */
  @Post(":id/sell")
  @HttpCode(200)
  async sell(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.write(req);
    const vid = uuid(id);
    const b = asBody(raw);
    const price = b.salePriceCents == null ? null : Number(b.salePriceCents);
    if (price !== null && (!Number.isSafeInteger(price) || price < 0)) throw new BadRequestException("salePriceCents must be whole cents");
    const soldOn = typeof b.soldOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.soldOn) ? b.soldOn : null;
    if (!soldOn) throw new BadRequestException("soldOn must be YYYY-MM-DD");
    return withOrg(this.pool, orgId, async (c) => {
      const old = (await c.query(`SELECT name, status, sold_on::text AS sold_on, sale_price_cents::float8 AS price FROM vehicles WHERE id = $1 FOR UPDATE`, [vid])).rows[0];
      if (!old) throw new NotFoundException();
      await c.query(`UPDATE vehicles SET status = 'sold', sold_on = $2, sale_price_cents = $3, current_driver_id = NULL, updated_at = now() WHERE id = $1`, [vid, soldOn, price]);
      await c.query(`UPDATE vehicle_assignments SET end_at = now() WHERE vehicle_id = $1 AND archived_at IS NULL AND (end_at IS NULL OR end_at > now())`, [vid]);
      await auditChange(c, req, { action: "vehicles.sell", entity: "vehicles", entityId: vid, label: old.name, old: { status: old.status, soldOn: old.sold_on, salePriceCents: old.price }, next: { status: "sold", soldOn, salePriceCents: price } });
      return { id: vid, status: "sold" };
    });
  }

  // ---- bulk actions and CSV import ------------------------------------------------------------------------------------------
  @Post("bulk")
  @HttpCode(200)
  async bulk(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.write(req, "vehicles.assign");
    const b = asBody(raw);
    const ids = Array.isArray(b.ids) ? b.ids.map((x) => uuid(x, "ids")) : [];
    if (!ids.length || ids.length > 500) throw new BadRequestException("ids must be 1 to 500 cars");
    const action = String(b.action);
    if (["status", "note", "archive"].includes(action) && !can(req, "vehicles.manage")) throw new HttpException("not allowed", 403);
    return withOrg(this.pool, orgId, async (c) => {
      let done = 0; const skipped: { id: string; reason: string }[] = [];
      for (const id of ids) {
        const v = (await c.query(`SELECT name, status, archived_at FROM vehicles WHERE id = $1 FOR UPDATE`, [id])).rows[0];
        if (!v) { skipped.push({ id, reason: "not found" }); continue; }
        if (action === "status") {
          if (typeof b.status !== "string" || !VEHICLE_STATUSES.includes(b.status as never)) throw new BadRequestException(`status must be one of ${VEHICLE_STATUSES.join(", ")}`);
          await c.query(`UPDATE vehicles SET status = $2, updated_at = now() WHERE id = $1`, [id, b.status]);
          await auditChange(c, req, { action: "vehicles.update", entity: "vehicles", entityId: id, label: v.name, old: { status: v.status }, next: { status: b.status } });
        } else if (action === "note") {
          const text = typeof b.text === "string" ? b.text.trim().slice(0, 2000) : "";
          if (!text) throw new BadRequestException("text is required");
          await c.query(`INSERT INTO comments (org_id, entity, entity_id, user_id, body) VALUES ($1,'vehicle',$2,$3,$4)`, [orgId, id, req.session!.userId, text]);
          await auditChange(c, req, { action: "vehicles.note", entity: "vehicles", entityId: id, label: v.name, old: null, next: { note: text } });
        } else if (action === "archive") {
          if (v.archived_at) { skipped.push({ id, reason: "already archived" }); continue; }
          await c.query(`UPDATE vehicles SET archived_at = now(), current_driver_id = NULL, updated_at = now() WHERE id = $1`, [id]);
          await auditChange(c, req, { action: "vehicles.archive", entity: "vehicles", entityId: id, label: v.name, old: { archivedAt: null }, next: { archivedAt: new Date().toISOString() } });
        } else if (action === "assign_driver") {
          const driverId = uuid(b.driverId, "driverId");
          const r = await this.assign(c, req, id, { driverId, kind: b.kind ?? "permanent", startAt: b.startAt ?? new Date().toISOString(), endAt: b.endAt ?? null }, !!b.force);
          if (r.conflicts.length) { skipped.push({ id, reason: "booking conflict" }); continue; }
        } else throw new BadRequestException("action must be status, note, archive or assign_driver");
        done++;
      }
      return { done, skipped };
    });
  }

  /** Check a CSV (already read into rows by the browser). `dryRun` only reports problems; otherwise the good rows are created. */
  @Post("import")
  @HttpCode(200)
  async importRows(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.write(req);
    const b = asBody(raw);
    const rows = Array.isArray(b.rows) ? (b.rows as Record<string, unknown>[]) : [];
    if (!rows.length || rows.length > 2000) throw new BadRequestException("rows must be 1 to 2000 lines");
    const dry = b.dryRun !== false;
    return withOrg(this.pool, orgId, async (c) => {
      const seenPlate = new Set<string>(), seenVin = new Set<string>();
      const report: { line: number; ok: boolean; errors: string[]; data?: Record<string, unknown>; id?: string }[] = [];
      for (const [i, r] of rows.entries()) {
        const errors: string[] = [];
        let v: Record<string, unknown> = {};
        try {
          // numbers and dates arrive as text from a CSV; blank cells mean "not given"
          const cleaned = Object.fromEntries(Object.entries(r).filter(([, x]) => x !== "" && x !== null && x !== undefined));
          v = parseBody({ fields: VEHICLE_FIELDS.filter((f) => f.type !== "ref") } as unknown as ResourceDef, cleaned, true);
          this.cleanVehicle(v);
          const p = typeof v.plate === "string" ? v.plate.toLowerCase() : null, vn = typeof v.vin === "string" ? v.vin : null;
          if (p && seenPlate.has(p)) errors.push("plate appears twice in this file"); if (p) seenPlate.add(p);
          if (vn && seenVin.has(vn)) errors.push("VIN appears twice in this file"); if (vn) seenVin.add(vn);
          for (const d of await this.duplicates(c, (v.plate as string) ?? null, (v.vin as string) ?? null, null)) errors.push(`${d.field} already used by ${d.name}`);
        } catch (e) { errors.push(e instanceof HttpException ? ((e.getResponse() as { message?: string }).message ?? e.message) : String(e)); }
        const item: (typeof report)[number] = { line: i + 1, ok: errors.length === 0, errors, data: v };
        if (item.ok && !dry) item.id = await this.insertVehicle(c, req, v);
        report.push(item);
      }
      return { dryRun: dry, total: rows.length, valid: report.filter((x) => x.ok).length, created: report.filter((x) => x.id).length, rows: report };
    });
  }

  // ---- the profile ----------------------------------------------------------------------------------------------------------------
  @Get(":id")
  async one(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    const vid = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const ctx = await this.ctx(c);
      const scope = await regionScope(c, req);
      const row = (await loadVehicles(c, ctx, { id: vid, teamIds: scope }))[0];
      if (!row) throw new NotFoundException();
      const full = (await c.query(`SELECT ${SELECT} FROM vehicles WHERE id = $1`, [vid])).rows[0];
      const events = (await c.query(
        `SELECT at, action, item_label AS label, actor_label AS actor FROM audit_log WHERE entity LIKE 'vehicle%' AND (entity_id = $1 OR detail::text LIKE '%' || $1 || '%') ORDER BY at DESC LIMIT 5`, [vid])).rows;
      const counts = (await c.query(
        `SELECT (SELECT count(*) FROM documents WHERE owner_kind='vehicle' AND owner_id=$1 AND archived_at IS NULL)::int AS documents,
                (SELECT count(*) FROM maintenance_logs WHERE vehicle_id=$1 AND archived_at IS NULL)::int AS maintenance,
                (SELECT count(*) FROM work_orders WHERE vehicle_id=$1 AND archived_at IS NULL AND status NOT IN ('closed','cancelled'))::int AS "openWorkOrders",
                (SELECT count(*) FROM portal_trips WHERE vehicle_id=$1 AND archived_at IS NULL)::int AS trips`, [vid])).rows[0];
      return { ...strip(req, { ...full, ...row } as Record<string, unknown>), lastEvents: events, counts, canSeeCosts: can(req, "vehicles.costs") };
    });
  }

  // ---- photos ------------------------------------------------------------------------------------------------------------------------
  @Put(":id/photos")
  async uploadPhoto(@Req() req: AuthedRequest & { body: Buffer }, @Param("id") id: string, @Query("angle") angle?: string, @Query("main") main?: string) {
    const orgId = this.write(req);
    const vid = uuid(id);
    const type = String(req.headers["content-type"] ?? "").split(";")[0]!.trim().toLowerCase();
    if (!["image/jpeg", "image/png", "image/webp"].includes(type)) throw new HttpException("photos must be JPEG, PNG or WebP", 415);
    const buf = req.body;
    if (!Buffer.isBuffer(buf) || !buf.length) throw new BadRequestException("file body required");
    if (buf.length > 5_000_000) throw new HttpException("photo too large (5 MB max)", 413);
    const a = ["front", "back", "left", "right", "interior", "other"].includes(String(angle)) ? String(angle) : "other";
    return withOrg(this.pool, orgId, async (c) => {
      if (!(await c.query("SELECT 1 FROM vehicles WHERE id = $1", [vid])).rowCount) throw new NotFoundException();
      const att = (await c.query(`INSERT INTO attachments (org_id, owner_kind, owner_id, name, content_type, size_bytes, data, created_by) VALUES ($1,'vehicle',$2,$3,$4,$5,$6,$7) RETURNING id`,
        [orgId, vid, `photo-${a}`, type, buf.length, buf, req.session!.userId])).rows[0];
      if (main === "1" && buf.length <= 280_000) await c.query(`UPDATE vehicles SET photo_data_url = $2 WHERE id = $1`, [vid, `data:${type};base64,${buf.toString("base64")}`]);
      await auditChange(c, req, { action: "vehicles.photo", entity: "vehicles", entityId: vid, label: null, old: null, next: { photo: a, main: main === "1" } });
      return { id: att.id, angle: a, main: main === "1" && buf.length <= 280_000 };
    });
  }
  @Get(":id/photos")
  async photos(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, (c) => c.query(`SELECT id, replace(name, 'photo-', '') AS angle, created_at AS "createdAt" FROM attachments WHERE owner_kind = 'vehicle' AND owner_id = $1 AND name LIKE 'photo-%' AND archived_at IS NULL ORDER BY created_at`, [uuid(id)]).then((r) => r.rows));
  }

  // ---- money -----------------------------------------------------------------------------------------------------------------------------
  @Get(":id/financials")
  async financials(@Req() req: AuthedRequest, @Param("id") id: string, @Query("from") from?: string, @Query("to") to?: string) {
    const orgId = requireAny(req, "vehicles.costs");
    const vid = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const ctx = await this.ctx(c);
      const v = (await c.query(`SELECT name, created_at::date::text AS created, purchase_date::text AS purchase_date, purchase_price_cents::float8 AS price, residual_value_cents::float8 AS residual, current_value_cents::float8 AS value, ownership_type FROM vehicles WHERE id = $1`, [vid])).rows[0];
      if (!v) throw new NotFoundException();
      const range = { from: from && /^\d{4}-\d{2}-\d{2}$/.test(from) ? from : ctx.today.slice(0, 8) + "01", to: to && /^\d{4}-\d{2}-\d{2}$/.test(to) ? to : ctx.today };
      const one = async (r: { from: string; to: string }) => (await vehicleMoney(c, r, ctx.tz, { vehicleIds: [vid] })).get(vid) ?? sumMoney([]);
      const start = v.purchase_date ?? v.created;
      const periods = {
        range: await one(range), day: await one({ from: ctx.today, to: ctx.today }), week: await one({ from: shiftDay(ctx.today, -6), to: ctx.today }),
        month: await one({ from: ctx.today.slice(0, 8) + "01", to: ctx.today }), lifetime: await one({ from: start, to: ctx.today }),
      };
      const months: { month: string; revenueCents: number; costCents: number; profitCents: number }[] = [];
      for (let k = 11; k >= 0; k--) {
        const d = new Date(Date.UTC(Number(ctx.today.slice(0, 4)), Number(ctx.today.slice(5, 7)) - 1 - k, 1));
        const f = d.toISOString().slice(0, 10), t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
        const m = await one({ from: f, to: t < ctx.today ? t : ctx.today });
        months.push({ month: f.slice(0, 7), revenueCents: m.revenueCents, costCents: m.costCents, profitCents: m.profitCents });
      }
      const daysInService = Math.max(1, Math.round((Date.parse(`${ctx.today}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1);
      const L = periods.lifetime, price = v.price ?? 0;
      const running = L.costCents;
      const km = (m: { distanceM: number }) => m.distanceM / 1000, hours = (m: { durationS: number }) => m.durationS / 3600;
      const last12 = await one({ from: shiftDay(ctx.today, -364), to: ctx.today });
      const ageYears = v.purchase_date ? daysInService / 365 : 0;
      const repairs12 = (await c.query(`SELECT coalesce(sum(total_cents),0)::float8 AS v FROM maintenance_logs WHERE vehicle_id = $1 AND archived_at IS NULL AND kind = 'repair' AND done_on > $2::date - 365`, [vid, ctx.today])).rows[0].v as number;
      return {
        range, periods, months,
        perKm: { range: km(periods.range) > 0 ? Math.round(periods.range.costCents / km(periods.range)) : null, lifetime: km(L) > 0 ? Math.round(L.costCents / km(L)) : null },
        perHour: { range: hours(periods.range) > 0 ? Math.round(periods.range.costCents / hours(periods.range)) : null, lifetime: hours(L) > 0 ? Math.round(L.costCents / hours(L)) : null },
        tco: { purchaseCents: price, runningCents: running, totalCents: price + running, fuelCents: L.fuelCents, repairsCents: L.maintenanceCents, insuranceCents: L.insuranceCents, financeCents: L.financeCents, tiresCents: L.tiresCents, ticketsCents: L.ticketsCents, otherCents: L.otherCents, driverPayCents: L.driverPayCents },
        breakEven: { paybackDays: price ? paybackDays(price, L.profitCents, daysInService) : null, daysInService, profitToDateCents: L.profitCents, purchaseCents: price,
          date: price && paybackDays(price, L.profitCents, daysInService) != null ? new Date(Date.parse(`${start}T00:00:00Z`) + paybackDays(price, L.profitCents, daysInService)! * 86_400_000).toISOString().slice(0, 10) : null },
        depreciation: v.purchase_date && price ? depreciationSeries(price, v.residual ?? Math.round(price * 0.2), v.purchase_date) : [],
        valueNowCents: v.value,
        keepRepairSell: keepRepairSell({ repairs12mCents: repairs12, valueCents: v.value ?? Math.round(price * 0.5), ageYears, profit12mCents: last12.profitCents }),
        formula: "Score = 60% repair cost (last 12 months) compared with the car's value + 25% age (10 years = full) + 15% if it lost money over the last 12 months. Under 35 keep, 35 to 64 repair, 65 or more sell.",
      };
    });
  }

  @Get(":id/trips")
  async trips(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, (c) => c.query(
      `SELECT t.id, t.started_at AS "startedAt", t.ended_at AS "endedAt", t.distance_m AS "distanceM", t.duration_s AS "durationS", t.revenue_cents::float8 AS "revenueCents", t.status, t.customer_name AS customer,
              t.driver_id AS "driverId", coalesce(u.display_name, u.email) AS driver
       FROM portal_trips t LEFT JOIN users u ON u.id = t.driver_id WHERE t.vehicle_id = $1 AND t.archived_at IS NULL ORDER BY t.started_at DESC LIMIT 500`, [uuid(id)]).then((r) => (can(req, "vehicles.costs") ? r.rows : r.rows.map((x) => ({ ...x, revenueCents: null })))));
  }

  @Get(":id/tracking")
  async tracking(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    const vid = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const dev = (await c.query(`SELECT d.id, d.source, d.external_id FROM devices d WHERE d.vehicle_id = $1 ORDER BY d.created_at LIMIT 1`, [vid])).rows[0];
      if (!dev) return { device: null };
      const pos = (await c.query(`SELECT time, lat, lng, speed, ignition FROM latest_positions WHERE device_id = $1`, [dev.id])).rows[0] ?? null;
      const events = (await c.query(`SELECT e.kind, e.at, g.name AS geofence FROM geofence_events e LEFT JOIN geofences g ON g.id = e.geofence_id WHERE e.device_id = $1 ORDER BY e.at DESC LIMIT 20`, [dev.id])).rows;
      const today = (await c.query(
        `SELECT count(*) FILTER (WHERE speed > 3)::int AS moving, count(*) FILTER (WHERE speed <= 3 AND ignition)::int AS idling, max(speed)::float8 AS top, count(*) FILTER (WHERE speed > 110)::int AS fast
         FROM positions WHERE device_id = $1 AND time > now() - interval '24 hours'`, [dev.id])).rows[0];
      return { device: { id: dev.id, source: dev.source, externalId: dev.external_id }, position: pos, events, last24h: today, replay: `/history/${dev.id}`, live: `/?v=${dev.id}` };
    });
  }

  @Get(":id/activity")
  async activity(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    const vid = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const audit = (await c.query(`SELECT id, at, actor_label AS actor, action, item_label AS label, old_value AS "oldValue", new_value AS "newValue" FROM audit_log WHERE entity LIKE 'vehicle%' AND entity_id = $1 ORDER BY at DESC LIMIT 200`, [vid])).rows;
      const notes = (await c.query(`SELECT cm.id, cm.body, cm.created_at AS "createdAt", coalesce(u.display_name, u.email) AS author FROM comments cm LEFT JOIN users u ON u.id = cm.user_id WHERE cm.entity = 'vehicle' AND cm.entity_id = $1 ORDER BY cm.created_at DESC LIMIT 200`, [vid])).rows;
      return { audit, notes };
    });
  }
  @Post(":id/notes")
  async addNote(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = requireAny(req, "vehicles.manage", "vehicles.assign", "fleet.manage");
    const text = typeof asBody(raw).body === "string" ? (asBody(raw).body as string).trim().slice(0, 2000) : "";
    if (!text) throw new BadRequestException("body is required");
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`INSERT INTO comments (org_id, entity, entity_id, user_id, body) VALUES ($1,'vehicle',$2,$3,$4) RETURNING id`, [orgId, uuid(id), req.session!.userId, text])).rows[0];
      await auditChange(c, req, { action: "vehicle_notes.create", entity: "vehicles", entityId: uuid(id), label: null, old: null, next: { note: text.slice(0, 200) } });
      return r;
    });
  }

  // ---- assignment and availability --------------------------------------------------------------------------------------------------------
  /** Put a driver in a car. Returns warnings (licence class) and conflicts (the car or driver is already booked) and refuses on conflict unless `force`. */
  private async assign(c: pg.PoolClient, req: AuthedRequest, vehicleId: string, b: Record<string, unknown>, force: boolean) {
    const driverId = uuid(b.driverId, "driverId");
    const kind = ["day", "week", "permanent"].includes(String(b.kind)) ? String(b.kind) : "day";
    const start = new Date(String(b.startAt ?? new Date().toISOString()));
    if (Number.isNaN(start.getTime())) throw new BadRequestException("startAt must be a date and time");
    let end: Date | null = b.endAt ? new Date(String(b.endAt)) : null;
    if (!end && kind === "day") end = new Date(start.getTime() + 86_400_000);
    if (!end && kind === "week") end = new Date(start.getTime() + 7 * 86_400_000);
    if (end && (Number.isNaN(end.getTime()) || end <= start)) throw new BadRequestException("endAt must be after startAt");
    const v = (await c.query(`SELECT id, name, kind, seats, archived_at, status, odometer_km FROM vehicles WHERE id = $1 FOR UPDATE`, [vehicleId])).rows[0];
    if (!v) throw new NotFoundException();
    if (v.archived_at || v.status === "sold") throw new BadRequestException("this car is archived or sold");
    const dr = (await c.query(`SELECT u.id, coalesce(u.display_name, u.email) AS name, p.license_class FROM users u LEFT JOIN driver_profiles p ON p.user_id = u.id WHERE u.id = $1 AND u.role = 'driver' AND u.disabled_at IS NULL`, [driverId])).rows[0];
    if (!dr) throw new BadRequestException("driverId is not an active driver");
    const warnings: string[] = [];
    const lic = licenceAllows(dr.license_class, v.kind, v.seats);
    if (lic === "not_licensed") warnings.push(`${dr.name}'s licence class (${dr.license_class}) does not cover a ${v.kind}`);
    if (lic === "unknown") warnings.push(`Could not check ${dr.name}'s licence class against a ${v.kind}; check by hand`);
    const conflicts = (await c.query(
      `SELECT a.id, a.vehicle_id AS "vehicleId", a.driver_id AS "driverId", a.start_at AS "startAt", a.end_at AS "endAt",
              CASE WHEN a.vehicle_id = $1 THEN 'vehicle' ELSE 'driver' END AS "with"
       FROM vehicle_assignments a WHERE a.archived_at IS NULL AND (a.vehicle_id = $1 OR a.driver_id = $2)
         AND a.start_at < coalesce($4::timestamptz, 'infinity') AND coalesce(a.end_at, 'infinity') > $3::timestamptz`, [vehicleId, driverId, start.toISOString(), end?.toISOString() ?? null])).rows;
    if (conflicts.length && !force) return { conflicts, warnings, assignment: null };
    // A permanent assignment replaces the previous open-ended one for this car.
    if (kind === "permanent") await c.query(`UPDATE vehicle_assignments SET end_at = $2 WHERE vehicle_id = $1 AND archived_at IS NULL AND end_at IS NULL AND start_at < $2`, [vehicleId, start.toISOString()]);
    const a = (await c.query(
      `INSERT INTO vehicle_assignments (org_id, vehicle_id, driver_id, kind, start_at, end_at, odometer_start_km, fuel_start_pct, damage_notes, note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
      [req.session!.orgId, vehicleId, driverId, kind, start.toISOString(), end?.toISOString() ?? null, b.odometerStartKm ?? v.odometer_km, b.fuelStartPct ?? null, b.damageNotes ?? null, b.note ?? null, req.session!.userId])).rows[0];
    await this.syncCurrentDriver(c, vehicleId);
    await auditChange(c, req, { action: "vehicle_assignments.create", entity: "vehicle_assignments", entityId: a.id, label: `${v.name} → ${dr.name}`, old: null, next: { vehicle: v.name, driver: dr.name, kind, startAt: start.toISOString(), endAt: end?.toISOString() ?? null } });
    return { conflicts, warnings, assignment: a.id };
  }

  private async syncCurrentDriver(c: pg.PoolClient, vehicleId: string) {
    await c.query(
      `UPDATE vehicles SET current_driver_id = (SELECT driver_id FROM vehicle_assignments a WHERE a.vehicle_id = $1 AND a.archived_at IS NULL AND a.start_at <= now() AND (a.end_at IS NULL OR a.end_at > now()) ORDER BY a.start_at DESC LIMIT 1) WHERE id = $1`, [vehicleId]);
  }

  // ---- children: documents, maintenance, fuel, inspections, incidents, assignments, work orders, warranties, parts ------------------------------------
  private child(name: string): ChildDef {
    const d = CHILD_BY_NAME.get(name);
    if (!d) throw new NotFoundException();
    return d;
  }

  @Get(":id/:child")
  async listChildren(@Req() req: AuthedRequest, @Param("id") id: string, @Param("child") name: string, @Query("archived") archived?: string) {
    const d = this.child(name);
    const orgId = requireAny(req, ...d.view);
    return withOrg(this.pool, orgId, async (c) => {
      const rows = await listChild(c, d, uuid(id), { archived: archived === "1" });
      if (!can(req, "vehicles.costs") && ["maintenance", "fuel", "work-orders", "parts"].includes(name)) {
        return rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, /Cents$/.test(k) ? null : v])));
      }
      return rows;
    });
  }

  @Post(":id/assignments")
  async createAssignment(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = requireAny(req, ...ASSIGNMENTS.write);
    const b = asBody(raw);
    const r = await withOrg(this.pool, orgId, (c) => this.assign(c, req, uuid(id), b, b.force === true));
    if (!r.assignment) throw new ConflictException({ message: "This booking overlaps another one", code: "booking_conflict", conflicts: r.conflicts, warnings: r.warnings });
    return r;
  }

  @Post(":id/:child")
  async createChildRow(@Req() req: AuthedRequest, @Param("id") id: string, @Param("child") name: string, @Body() raw: unknown) {
    const d = this.child(name);
    if (name === "work-orders" || name === "maintenance") { /* normal path */ }
    const orgId = requireAny(req, ...d.write);
    return withOrg(this.pool, orgId, async (c) => {
      const vid = uuid(id);
      if (!(await c.query("SELECT 1 FROM vehicles WHERE id = $1", [vid])).rowCount) throw new NotFoundException();
      const row = await createChild(c, req, d, vid, raw);
      if (name === "maintenance" || name === "fuel") await this.afterReading(c, vid, row);
      return row;
    });
  }

  /** A fill-up or service with a higher odometer reading moves the car's odometer forward; a service resets its plan. */
  private async afterReading(c: pg.PoolClient, vid: string, row: Record<string, unknown>) {
    const km = row.odometerKm == null ? null : Number(row.odometerKm);
    if (km != null) await c.query(`UPDATE vehicles SET odometer_km = greatest(odometer_km, $2) WHERE id = $1`, [vid, km]);
    if (row.planId) await c.query(`UPDATE maintenance_plans SET last_done_on = $2::date, last_done_km = coalesce($3, last_done_km) WHERE id = $1`, [row.planId, row.doneOn, km]);
  }

  @Patch(":id/:child/:cid")
  async updateChildRow(@Req() req: AuthedRequest, @Param("id") _id: string, @Param("child") name: string, @Param("cid") cid: string, @Body() raw: unknown) {
    const d = this.child(name);
    const orgId = requireAny(req, ...d.write);
    return withOrg(this.pool, orgId, async (c) => {
      if (name === "work-orders") return this.updateWorkOrder(c, req, uuid(cid), raw);
      const row = await updateChild(c, req, d, uuid(cid), raw);
      if (name === "assignments") await this.syncCurrentDriver(c, String(row._parent));
      return row;
    });
  }

  private async updateWorkOrder(c: pg.PoolClient, req: AuthedRequest, id: string, raw: unknown) {
    const d = this.child("work-orders");
    const body = asBody(raw);
    const before = (await c.query(`SELECT status, estimate_cents::float8 AS est, actual_cents::float8 AS act, vehicle_id, title, shop_id FROM work_orders WHERE id = $1 FOR UPDATE`, [id])).rows[0];
    if (!before) throw new NotFoundException();
    const next = typeof body.status === "string" ? body.status : null;
    if (next && next !== before.status) {
      const ok: Record<string, string[]> = { open: ["assigned", "awaiting_approval", "cancelled"], assigned: ["awaiting_approval", "closed", "cancelled"], awaiting_approval: ["approved", "open", "cancelled"], approved: ["closed", "cancelled"], closed: [], cancelled: ["open"] };
      if (!ok[before.status]!.includes(next)) throw new BadRequestException(`a ${before.status.replace(/_/g, " ")} work order cannot go to ${next.replace(/_/g, " ")}`);
      if (next === "approved") {
        // The person who asked for the work cannot approve their own estimate.
        if (!can(req, "vehicles.costs")) throw new HttpException("approving a cost needs permission to see vehicle costs", 403);
        if (before.est == null) throw new BadRequestException("add an estimate before approving the cost");
      }
      if (next === "closed" && body.actualCents == null && before.act == null) throw new BadRequestException("enter the final cost (actualCents) to close the work order");
    }
    const row = await updateChild(c, req, d, id, raw);
    if (next === "approved") await c.query(`UPDATE work_orders SET approved_by = $2, approved_at = now() WHERE id = $1`, [id, req.session!.userId]);
    if (next === "closed" && next !== before.status) {
      await c.query(`UPDATE work_orders SET closed_at = now() WHERE id = $1`, [id]);
      // Closing books the cost into the car's maintenance history, so reports pick it up.
      const cost = Number(row.actualCents ?? before.act ?? 0);
      const log = (await c.query(
        `INSERT INTO maintenance_logs (org_id, vehicle_id, task, done_on, vendor, kind, labour_cents, work_order_id, created_by, notes) VALUES ($1,$2,$3,current_date,(SELECT name FROM shops WHERE id = $4),'repair',$5,$6,$7,$8) RETURNING id`,
        [req.session!.orgId, before.vehicle_id, before.title, before.shop_id, cost, id, req.session!.userId, `Work order closed${row.invoiceRef ? ` · invoice ${row.invoiceRef}` : ""}`])).rows[0];
      await auditChange(c, req, { action: "vehicle_maintenance.create", entity: "vehicle_maintenance", entityId: log.id, label: before.title, old: null, next: { fromWorkOrder: id, totalCents: cost } });
    }
    return row;
  }

  @Post(":id/:child/:cid/archive") @HttpCode(200)
  async archiveChildRow(@Req() req: AuthedRequest, @Param("child") name: string, @Param("cid") cid: string) {
    const d = this.child(name);
    return withOrg(this.pool, requireAny(req, ...d.write), async (c) => { const r = await archiveChild(c, req, d, uuid(cid)); if (name === "assignments") await this.syncCurrentDriver(c, String(r._parent)); return r; });
  }
  @Post(":id/:child/:cid/restore") @HttpCode(200)
  async restoreChildRow(@Req() req: AuthedRequest, @Param("child") name: string, @Param("cid") cid: string) {
    const d = this.child(name);
    return withOrg(this.pool, requireAny(req, ...d.write), (c) => archiveChild(c, req, d, uuid(cid), true));
  }

  /** Sign off a failed inspection: the car can take jobs again. */
  @Post(":id/inspections/:cid/sign-off") @HttpCode(200)
  async signOff(@Req() req: AuthedRequest, @Param("cid") cid: string, @Body() raw: unknown) {
    const orgId = this.write(req, "fleet.manage");
    const note = typeof asBody(raw).note === "string" ? (asBody(raw).note as string).slice(0, 500) : null;
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`UPDATE inspections SET signed_off_by = $2, signed_off_at = now(), sign_off_note = $3, updated_at = now() WHERE id = $1 AND signed_off_at IS NULL RETURNING vehicle_id`, [uuid(cid), req.session!.userId, note])).rows[0];
      if (!r) throw new NotFoundException();
      await auditChange(c, req, { action: "vehicle_inspections.sign_off", entity: "vehicle_inspections", entityId: cid, label: null, old: { signedOff: false }, next: { signedOff: true, note } });
      return { ok: true };
    });
  }

  /** Use a service template (oil change, tires, brakes, annual inspection) to add a service plan to a car. */
  @Post(":id/apply-template") @HttpCode(200)
  async applyTemplate(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.write(req, "fleet.manage");
    const t = SERVICE_TEMPLATES.find((x) => x.id === asBody(raw).template);
    if (!t) throw new BadRequestException("unknown template");
    return withOrg(this.pool, orgId, async (c) => createChild(c, req, this.child("plans"), uuid(id), { task: t.name, everyDays: t.everyDays, everyKm: t.everyKm, lastDoneOn: new Date().toISOString().slice(0, 10) }));
  }
}

export const SERVICE_TEMPLATES = [
  { id: "oil", name: "Oil change", everyKm: 10_000, everyDays: 180 },
  { id: "tires", name: "Tire rotation and check", everyKm: 12_000, everyDays: 180 },
  { id: "brakes", name: "Brake inspection", everyKm: 40_000, everyDays: 365 },
  { id: "annual", name: "Annual safety inspection", everyKm: null, everyDays: 365 },
] as const;

const titleCase = (s: string) => s.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());

// ---- shops, booking calendar, work-order shop comparison ---------------------------------------------------------------------------------------------
@Controller("portal")
@UseGuards(AuthGuard)
export class PortalFleetController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get("shops")
  async shops(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, ...VIEW_VEHICLES);
    return withOrg(this.pool, orgId, (c) => c.query(`SELECT id, name, phone, email, address, notes, archived_at AS "archivedAt" FROM shops WHERE archived_at IS NULL ORDER BY name`).then((r) => r.rows));
  }
  @Post("shops")
  async addShop(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = requireAny(req, "vehicles.manage", "fleet.manage");
    const b = asBody(raw);
    const name = typeof b.name === "string" ? b.name.trim().slice(0, 120) : "";
    if (!name) throw new BadRequestException("name is required");
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`INSERT INTO shops (org_id, name, phone, email, address, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id, name`, [orgId, name, b.phone ?? null, b.email ?? null, b.address ?? null, b.notes ?? null, req.session!.userId])).rows[0];
      await auditChange(c, req, { action: "shops.create", entity: "shops", entityId: r.id, label: name, old: null, next: { name } });
      return r;
    });
  }
  @Post("shops/:id/archive") @HttpCode(200)
  async archiveShop(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requireAny(req, "vehicles.manage", "fleet.manage");
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`UPDATE shops SET archived_at = now() WHERE id = $1 AND archived_at IS NULL RETURNING name`, [uuid(id)])).rows[0];
      if (!r) throw new NotFoundException();
      await auditChange(c, req, { action: "shops.archive", entity: "shops", entityId: id, label: r.name, old: { archivedAt: null }, next: { archivedAt: new Date().toISOString() } });
      return { ok: true };
    });
  }

  /** Compare shops by cost and speed from closed work orders. */
  @Get("shops/compare")
  async compare(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "vehicles.costs");
    return withOrg(this.pool, orgId, (c) => c.query(
      `SELECT s.id, s.name, count(w.id)::int AS jobs, coalesce(avg(w.actual_cents),0)::float8 AS "avgCostCents", coalesce(sum(w.actual_cents),0)::float8 AS "totalCents",
              avg(extract(epoch FROM (w.closed_at - w.opened_at)) / 86400)::float8 AS "avgDays"
       FROM shops s LEFT JOIN work_orders w ON w.shop_id = s.id AND w.status = 'closed' AND w.archived_at IS NULL
       WHERE s.archived_at IS NULL GROUP BY s.id, s.name ORDER BY "avgCostCents"`).then((r) => r.rows));
  }

  /** Which car is with which driver, with bookings that overlap marked as conflicts. */
  @Get("assignments/calendar")
  async calendar(@Req() req: AuthedRequest, @Query("from") from?: string, @Query("to") to?: string) {
    const orgId = requireAny(req, ...VIEW_VEHICLES);
    const f = from ? new Date(from) : new Date(Date.now() - 7 * 86_400_000), t = to ? new Date(to) : new Date(Date.now() + 28 * 86_400_000);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new BadRequestException("from and to must be dates");
    return withOrg(this.pool, orgId, async (c) => {
      const rows = (await c.query(
        `SELECT a.id, a.vehicle_id AS "vehicleId", v.name AS vehicle, a.driver_id AS "driverId", coalesce(u.display_name, u.email) AS driver, a.kind, a.start_at AS "startAt", a.end_at AS "endAt"
         FROM vehicle_assignments a JOIN vehicles v ON v.id = a.vehicle_id LEFT JOIN users u ON u.id = a.driver_id
         WHERE a.archived_at IS NULL AND a.start_at < $2 AND coalesce(a.end_at, 'infinity') > $1 ORDER BY a.start_at`, [f.toISOString(), t.toISOString()])).rows;
      const overlap = (a: (typeof rows)[number], b: (typeof rows)[number]) => new Date(a.startAt) < (b.endAt ? new Date(b.endAt) : new Date(8.64e15)) && new Date(b.startAt) < (a.endAt ? new Date(a.endAt) : new Date(8.64e15));
      return rows.map((a) => ({ ...a, conflict: rows.some((b) => b.id !== a.id && (b.vehicleId === a.vehicleId || b.driverId === a.driverId) && overlap(a, b)) }));
    });
  }
}

