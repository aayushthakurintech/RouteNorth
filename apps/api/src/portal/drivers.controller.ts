import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import {
  COMPLIANCE_FORMULA, DEFAULT_WEIGHTS, ONBOARDING_STEPS, SAFETY_FORMULA, hoursReport, licenceAllows, portalDriverScore, safetyScore, type DriverStatus, type Permission,
} from "@routenorth/shared";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard.js";
import { auditChange } from "../audit/domain-audit.js";
import { parseBody } from "../resources/engine.js";
import type { ResourceDef } from "../resources/defs.js";
import { PG_POOL } from "../tokens.js";
import { body as asBody, companyFormat, oneOf, regionScope, requireAny, uuid } from "./common.js";
import { archiveChild, createChild, listChild, updateChild } from "./crud.js";
import { BANK_FIELDS, D_CHILD_BY_NAME, DRIVER_FIELDS, DRIVER_STATUSES_STORED, VIEW_DRIVERS } from "./drivers.defs.js";
import { SCORE_DAYS, ensureSteps, loadDrivers, loadSettings, stepLabel, type DCtx, type DriverRow } from "./drivers.service.js";
import { todayIn } from "./vehicles.service.js";

const can = (req: AuthedRequest, ...p: Permission[]) => p.some((x) => req.perms?.has(x));
const PROFILE = `SELECT p.*, p.license_expiry::text AS license_expiry_t, p.birth_date::text AS birth_date_t, p.tax_form_received_on::text AS tax_received_t FROM driver_profiles p WHERE p.user_id = $1`;
const profileJson = (p: Record<string, unknown>) => ({
  phone: p.phone, address: p.address, birthDate: p.birth_date_t, languages: p.languages, homeBase: p.home_base, homeDepotId: p.home_depot_id, teamId: p.team_id, employmentType: p.employment_type,
  licenseNo: p.license_no, licenseClass: p.license_class, licenseExpiry: p.license_expiry_t, emergencyName: p.emergency_name, emergencyPhone: p.emergency_phone,
  workPermitRequired: p.work_permit_required, leaderboardOptOut: p.leaderboard_opt_out, skills: p.skills, notes: p.notes,
});
const bankJson = (p: Record<string, unknown>) => ({ payoutMethod: p.payout_method, bankInstitution: p.bank_institution, bankAccountLast4: p.bank_account_last4, taxForm: p.tax_form, taxFormReceivedOn: p.tax_received_t });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Controller("portal/drivers")
@UseGuards(AuthGuard)
export class PortalDriversController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  private async ctx(c: pg.PoolClient): Promise<DCtx> {
    const f = await companyFormat(c);
    return { tz: f.timezone, today: todayIn(f.timezone), now: new Date() };
  }
  private view(req: AuthedRequest) { return requireAny(req, ...VIEW_DRIVERS); }
  private write(req: AuthedRequest) { return requireAny(req, "drivers.manage"); }
  /** A driver the caller may see (region limits apply to managers). */
  private async one(c: pg.PoolClient, req: AuthedRequest, id: string, ctx: DCtx, archived = true): Promise<DriverRow> {
    const row = (await loadDrivers(c, ctx, { id, teamIds: await regionScope(c, req), applicants: false, archived }))[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  // ---- list ------------------------------------------------------------------------------------------------------------------
  @Get()
  async list(@Req() req: AuthedRequest, @Query("archived") archived?: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const rows = await loadDrivers(c, await this.ctx(c), { archived: archived === "1", teamIds: await regionScope(c, req) });
      return can(req, "pay.view") ? rows : rows.map((r) => ({ ...r, revenueMonthCents: 0, earningsMonthCents: null }));
    });
  }

  @Get("meta")
  async meta(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => ({
      teams: (await c.query(`SELECT id, name FROM teams ORDER BY name`)).rows,
      depots: (await c.query(`SELECT id, name FROM depots ORDER BY name`)).rows,
      vehicles: (await c.query(`SELECT id, name FROM vehicles WHERE archived_at IS NULL AND status NOT IN ('sold') ORDER BY name`)).rows,
      steps: ONBOARDING_STEPS, settings: await loadSettings(c), canSeeBank: can(req, "drivers.sensitive"),
    }));
  }

  // ---- settings (score weights, overtime rule, leaderboard switch, required steps) -------------------------------------------
  @Get("settings")
  async getSettings(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, (c) => loadSettings(c));
  }
  @Put("settings")
  async putSettings(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = requireAny(req, "settings.manage", "drivers.manage");
    const b = asBody(raw);
    return withOrg(this.pool, orgId, async (c) => {
      const old = await loadSettings(c);
      const next = { ...old } as Record<string, unknown>;
      if (b.weights !== undefined) {
        const w = asBody(b.weights); const keys = Object.keys(DEFAULT_WEIGHTS);
        const weights = Object.fromEntries(keys.map((k) => [k, Number(w[k] ?? (old.weights as unknown as Record<string, number>)[k])]));
        if (Object.values(weights).some((x) => !Number.isFinite(x) || x < 0 || x > 100)) throw new BadRequestException("each weight is 0 to 100");
        if (Object.values(weights).reduce((a, x) => a + x, 0) !== 100) throw new BadRequestException("weights must add up to 100");
        next.weights = weights;
      }
      if (b.leaderboard !== undefined) next.leaderboard = b.leaderboard === true;
      if (b.requiredSteps !== undefined) {
        if (!Array.isArray(b.requiredSteps) || b.requiredSteps.some((s) => !ONBOARDING_STEPS.some((x) => x.key === s))) throw new BadRequestException("requiredSteps must be onboarding step names");
        next.requiredSteps = b.requiredSteps;
      }
      if (b.hours !== undefined) {
        const h = asBody(b.hours); const cur = old.hours as unknown as Record<string, unknown>;
        const hours: Record<string, unknown> = { ...cur };
        for (const k of ["overtimeWeeklyHours", "maxDailyHours", "maxWeeklyHours", "minRestHours"]) if (h[k] !== undefined) { const v = Number(h[k]); if (!Number.isFinite(v) || v <= 0 || v > 200) throw new BadRequestException(`${k} must be a positive number`); hours[k] = v; }
        if (h.overtimeDailyHours !== undefined) hours.overtimeDailyHours = h.overtimeDailyHours === null ? null : Number(h.overtimeDailyHours);
        if (typeof h.region === "string") hours.region = h.region.slice(0, 60);
        next.hours = hours;
      }
      for (const k of ["idleDriverDays", "lowRating", "scoreFloor", "stuckOnboardingDays", "cancellationAlertPct"]) if (b[k] !== undefined) { const v = Number(b[k]); if (!Number.isFinite(v) || v < 0) throw new BadRequestException(`${k} must be a number`); next[k] = v; }
      await c.query(`INSERT INTO portal_settings (org_id, data, updated_by) VALUES ($1,$2,$3) ON CONFLICT (org_id) DO UPDATE SET data = portal_settings.data || EXCLUDED.data, updated_by = $3, updated_at = now()`, [orgId, JSON.stringify(next), req.session!.userId]);
      await auditChange(c, req, { action: "portal_settings.update", entity: "portal_settings", entityId: orgId, label: "Driver and portal settings", old: old as never, next: next as never });
      return loadSettings(c);
    });
  }

  // ---- company views ---------------------------------------------------------------------------------------------------------
  /** Leaderboard of the last 30 days. The owner switches it on in settings; a driver can opt out. */
  @Get("leaderboard")
  async leaderboard(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const st = await loadSettings(c);
      if (!st.leaderboard) return { enabled: false, rows: [] };
      const ctx = await this.ctx(c);
      const rows = (await loadDrivers(c, ctx, { applicants: false, teamIds: await regionScope(c, req) })).filter((d) => d.score != null && d.status !== "archived");
      const opted = new Set((await c.query(`SELECT user_id FROM driver_profiles WHERE leaderboard_opt_out`)).rows.map((r) => r.user_id));
      const ranked = rows.filter((d) => !opted.has(d.id)).sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.tripsMonth - a.tripsMonth).map((d, k) => ({ rank: k + 1, id: d.id, name: d.name, score: d.score, rating: d.rating, onTimePct: d.onTimePct, tripsMonth: d.tripsMonth }));
      return { enabled: true, windowDays: SCORE_DAYS, rows: ranked };
    });
  }

  @Get("compliance")
  async companyCompliance(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const rows = (await loadDrivers(c, await this.ctx(c), { applicants: false, teamIds: await regionScope(c, req) }));
      const avg = rows.length ? Math.round(rows.reduce((a, r) => a + r.compliance, 0) / rows.length) : null;
      return { companyScore: avg, formula: COMPLIANCE_FORMULA, drivers: rows.map((r) => ({ id: r.id, name: r.name, score: r.compliance, expired: r.docs.expired, expiring: r.docs.expiring, blockedReasons: r.blockedReasons })).sort((a, b) => a.score - b.score) };
    });
  }

  // ---- add / import / bulk ---------------------------------------------------------------------------------------------------
  /** CSV of people to invite (name, email, phone). Checked first; "dryRun: false" creates the invitations (the invite email goes out the usual way). */
  @Post("import")
  @HttpCode(200)
  async importRows(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.write(req);
    const b = asBody(raw);
    const rows = Array.isArray(b.rows) ? (b.rows as Record<string, unknown>[]) : [];
    if (!rows.length || rows.length > 500) throw new BadRequestException("rows must be 1 to 500 lines");
    const dry = b.dryRun !== false;
    return withOrg(this.pool, orgId, async (c) => {
      const seen = new Set<string>();
      const report: { line: number; ok: boolean; errors: string[]; email: string }[] = [];
      for (const [k, r] of rows.entries()) {
        const email = String(r.email ?? "").trim().toLowerCase();
        const errors: string[] = [];
        if (!EMAIL.test(email)) errors.push("email is not valid");
        else {
          if (seen.has(email)) errors.push("email appears twice in this file"); seen.add(email);
          if ((await c.query(`SELECT 1 FROM users WHERE lower(email) = $1`, [email])).rowCount) errors.push("this email already has an account");
        }
        report.push({ line: k + 1, ok: errors.length === 0, errors, email });
      }
      return { dryRun: dry, total: rows.length, valid: report.filter((r) => r.ok).length, rows: report, note: dry ? null : "Use POST /invites for each valid line; the invitation email and link are created there." };
    });
  }

  @Post("bulk")
  @HttpCode(200)
  async bulk(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.write(req);
    const b = asBody(raw);
    const ids = Array.isArray(b.ids) ? b.ids.map((x) => uuid(x, "ids")) : [];
    if (!ids.length || ids.length > 500) throw new BadRequestException("ids must be 1 to 500 drivers");
    const action = String(b.action);
    return withOrg(this.pool, orgId, async (c) => {
      let done = 0; const skipped: { id: string; reason: string }[] = [];
      for (const id of ids) {
        const d = (await c.query(`SELECT u.id, coalesce(u.display_name, u.email) AS name, p.status FROM users u JOIN driver_profiles p ON p.user_id = u.id WHERE u.id = $1 AND u.role = 'driver' FOR UPDATE OF p`, [id])).rows[0];
        if (!d) { skipped.push({ id, reason: "not found" }); continue; }
        if (action === "status") {
          const s = oneOf(b.status, "status", DRIVER_STATUSES_STORED, { required: true })!;
          if (s === "suspended" && !(typeof b.reason === "string" && b.reason.trim())) throw new BadRequestException("a reason is needed to suspend a driver");
          await c.query(`UPDATE driver_profiles SET status = $2, status_reason = $3, updated_at = now() WHERE user_id = $1`, [id, s, s === "suspended" ? String(b.reason).slice(0, 500) : null]);
          await auditChange(c, req, { action: "drivers.status", entity: "drivers", entityId: id, label: d.name, old: { status: d.status }, next: { status: s, reason: b.reason ?? null } });
        } else if (action === "message") {
          const text = typeof b.text === "string" ? b.text.trim().slice(0, 190) : "";
          if (!text) throw new BadRequestException("text is required");
          await c.query(`INSERT INTO notifications (org_id, user_id, kind, title) VALUES ($1,$2,'system',$3)`, [orgId, id, text]);
          await auditChange(c, req, { action: "drivers.message", entity: "drivers", entityId: id, label: d.name, old: null, next: { message: text } });
        } else if (action === "assign_vehicle") {
          const vid = uuid(b.vehicleId, "vehicleId");
          const r = await this.assignVehicle(c, req, id, vid, !!b.force);
          if (!r.ok) { skipped.push({ id, reason: r.reason }); continue; }
        } else if (action === "team") {
          const team = b.teamId == null ? null : uuid(b.teamId, "teamId");
          await c.query(`UPDATE driver_profiles SET team_id = $2, updated_at = now() WHERE user_id = $1`, [id, team]);
          await auditChange(c, req, { action: "drivers.update", entity: "drivers", entityId: id, label: d.name, old: null, next: { teamId: team } });
        } else throw new BadRequestException("action must be status, message, assign_vehicle or team");
        done++;
      }
      return { done, skipped };
    });
  }

  /** Give a driver a car (permanent). Refuses when the car is blocked, archived, or has a booking in the way. */
  private async assignVehicle(c: pg.PoolClient, req: AuthedRequest, driverId: string, vehicleId: string, force: boolean): Promise<{ ok: true } | { ok: false; reason: string }> {
    const v = (await c.query(`SELECT id, name, kind, seats, archived_at, status FROM vehicles WHERE id = $1 FOR UPDATE`, [vehicleId])).rows[0];
    if (!v || v.archived_at || v.status === "sold") return { ok: false, reason: "car is not available" };
    const dr = (await c.query(`SELECT coalesce(u.display_name,u.email) AS name, p.license_class FROM users u JOIN driver_profiles p ON p.user_id = u.id WHERE u.id = $1`, [driverId])).rows[0];
    const lic = licenceAllows(dr.license_class, v.kind, v.seats);
    if (lic === "not_licensed" && !force) return { ok: false, reason: `licence class ${dr.license_class} does not cover a ${v.kind}` };
    const clash = (await c.query(`SELECT 1 FROM vehicle_assignments WHERE vehicle_id = $1 AND archived_at IS NULL AND driver_id <> $2 AND start_at < now() + interval '1 day' AND coalesce(end_at, 'infinity') > now()`, [vehicleId, driverId])).rowCount;
    if (clash && !force) return { ok: false, reason: "car is booked by another driver" };
    await c.query(`UPDATE vehicle_assignments SET end_at = now() WHERE driver_id = $1 AND kind = 'permanent' AND archived_at IS NULL AND end_at IS NULL AND start_at < now()`, [driverId]);
    const a = (await c.query(`INSERT INTO vehicle_assignments (org_id, vehicle_id, driver_id, kind, start_at, created_by) VALUES ($1,$2,$3,'permanent',now(),$4) RETURNING id`, [req.session!.orgId, vehicleId, driverId, req.session!.userId])).rows[0];
    await c.query(`UPDATE vehicles SET current_driver_id = NULL WHERE current_driver_id = $1 AND id <> $2`, [driverId, vehicleId]);
    await c.query(`UPDATE vehicles SET current_driver_id = $2 WHERE id = $1`, [vehicleId, driverId]);
    await auditChange(c, req, { action: "vehicle_assignments.create", entity: "vehicle_assignments", entityId: a.id, label: `${v.name} → ${dr.name}`, old: null, next: { vehicle: v.name, driver: dr.name, kind: "permanent" } });
    return { ok: true };
  }

  // ---- one driver ------------------------------------------------------------------------------------------------------------
  @Get(":id")
  async profile(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    const did = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const ctx = await this.ctx(c);
      const d = await this.one(c, req, did, ctx);
      const p = (await c.query(PROFILE, [did])).rows[0];
      const pay = can(req, "pay.view");
      return { ...d, ...(pay ? {} : { revenueMonthCents: 0 }), profile: profileJson(p), canSeeBank: can(req, "drivers.sensitive"), counts: (await c.query(
        `SELECT (SELECT count(*) FROM documents WHERE owner_kind='driver' AND owner_id=$1 AND archived_at IS NULL)::int AS documents,
                (SELECT count(*) FROM portal_trips WHERE driver_id=$1 AND archived_at IS NULL)::int AS trips,
                (SELECT count(*) FROM driver_notes WHERE driver_id=$1 AND archived_at IS NULL AND kind IN ('warning','coaching','improvement_plan') AND done_on IS NULL)::int AS "openFollowUps"`, [did])).rows[0] };
    });
  }

  @Patch(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.write(req);
    const did = uuid(id);
    const b = asBody(raw);
    const v = parseBody({ fields: DRIVER_FIELDS } as unknown as ResourceDef, Object.fromEntries(Object.entries(b).filter(([k]) => k !== "displayName")), false);
    const name = typeof b.displayName === "string" ? b.displayName.trim().slice(0, 120) : undefined;
    if (!Object.keys(v).length && name === undefined) throw new BadRequestException("nothing to change");
    return withOrg(this.pool, orgId, async (c) => {
      const old = (await c.query(PROFILE, [did])).rows[0];
      if (!old) throw new NotFoundException();
      await regionGuard(c, req, old.team_id);
      for (const f of DRIVER_FIELDS) if (f.type === "ref" && v[f.key]) {
        if (!(await c.query(`SELECT 1 FROM ${f.ref === "depots" ? "depots" : "teams"} WHERE id = $1`, [v[f.key]])).rowCount) throw new BadRequestException(`${f.key} does not exist`);
      }
      const fields = DRIVER_FIELDS.filter((f) => v[f.key] !== undefined);
      if (fields.length) await c.query(`UPDATE driver_profiles SET ${fields.map((f, k) => `${f.col} = $${k + 2}`).join(", ")}, updated_at = now() WHERE user_id = $1`, [did, ...fields.map((f) => v[f.key])]);
      if (name) await c.query(`UPDATE users SET display_name = $2 WHERE id = $1 AND role = 'driver'`, [did, name]);
      const now = (await c.query(PROFILE, [did])).rows[0];
      const label = (await c.query(`SELECT coalesce(display_name,email) AS n FROM users WHERE id = $1`, [did])).rows[0].n;
      await auditChange(c, req, { action: "drivers.update", entity: "drivers", entityId: did, label, old: profileJson(old), next: { ...profileJson(now), ...(name ? { displayName: name } : {}) } });
      return this.one(c, req, did, await this.ctx(c));
    });
  }

  /** Bank and tax: owners with the right permission only. Every view and change is on the audit log. */
  @Get(":id/bank")
  async bank(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requireAny(req, "drivers.sensitive");
    const did = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const p = (await c.query(PROFILE, [did])).rows[0];
      if (!p) throw new NotFoundException();
      await auditChange(c, req, { action: "driver_bank.view", entity: "drivers", entityId: did, label: null, old: null, next: null, sensitive: true });
      return { ...bankJson(p), employmentType: p.employment_type, note: "Only the institution and the last digits are kept here. The full account number stays with your payment provider." };
    });
  }
  @Patch(":id/bank")
  async setBank(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = requireAny(req, "drivers.sensitive");
    const did = uuid(id);
    const v = parseBody({ fields: BANK_FIELDS } as unknown as ResourceDef, raw, false);
    if (!Object.keys(v).length) throw new BadRequestException("nothing to change");
    return withOrg(this.pool, orgId, async (c) => {
      const old = (await c.query(PROFILE, [did])).rows[0];
      if (!old) throw new NotFoundException();
      const fields = BANK_FIELDS.filter((f) => v[f.key] !== undefined);
      await c.query(`UPDATE driver_profiles SET ${fields.map((f, k) => `${f.col} = $${k + 2}`).join(", ")}, updated_at = now() WHERE user_id = $1`, [did, ...fields.map((f) => v[f.key])]);
      const now = (await c.query(PROFILE, [did])).rows[0];
      await auditChange(c, req, { action: "driver_bank.update", entity: "drivers", entityId: did, label: null, old: bankJson(old), next: bankJson(now), sensitive: true });
      return bankJson(now);
    });
  }

  // ---- status, archive, offboarding -------------------------------------------------------------------------------------------
  @Post(":id/status")
  @HttpCode(200)
  async setStatus(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.write(req);
    const did = uuid(id);
    const b = asBody(raw);
    const s = oneOf(b.status, "status", DRIVER_STATUSES_STORED, { required: true })!;
    const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
    if (s === "suspended" && !reason) throw new BadRequestException("a reason is needed to suspend a driver");
    return withOrg(this.pool, orgId, async (c) => {
      const ctx = await this.ctx(c);
      const d = await this.one(c, req, did, ctx, false);
      if (s === "active") {
        const open = d.onboarding.requiredOpen;
        if (d.storedStatus === "onboarding" && open.length) throw new BadRequestException(`approve these steps first: ${open.map(stepLabel).join(", ")}`);
      }
      await c.query(`UPDATE driver_profiles SET status = $2, status_reason = $3, updated_at = now() WHERE user_id = $1`, [did, s, reason || null]);
      await auditChange(c, req, { action: "drivers.status", entity: "drivers", entityId: did, label: d.name, old: { status: d.storedStatus, reason: d.statusReason }, next: { status: s, reason: reason || null } });
      return this.one(c, req, did, ctx);
    });
  }

  /** Offboarding: car returned, final payout settled, access removed, then archived. The checklist is returned so the screen can tick it. */
  @Get(":id/offboarding")
  async offboardingState(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.write(req);
    return withOrg(this.pool, orgId, (c) => this.offboardChecklist(c, uuid(id)));
  }
  private async offboardChecklist(c: pg.PoolClient, did: string) {
    const cars = (await c.query(`SELECT v.name FROM vehicles v WHERE v.current_driver_id = $1 AND v.archived_at IS NULL`, [did])).rows.map((r) => r.name as string);
    const p = (await c.query(`SELECT p.archived_at, p.offboarded_at, u.disabled_at FROM driver_profiles p JOIN users u ON u.id = p.user_id WHERE p.user_id = $1`, [did])).rows[0];
    if (!p) throw new NotFoundException();
    const unpaid = (await c.query(`SELECT to_regclass('portal_pay_lines') IS NOT NULL AS ok`)).rows[0].ok
      ? Number((await c.query(`SELECT coalesce(sum(amount_cents),0)::float8 AS v FROM portal_pay_lines WHERE driver_id = $1 AND payout_id IS NULL AND archived_at IS NULL`, [did])).rows[0].v) : 0;
    return {
      items: [
        { key: "car_returned", label: "Return the car", done: cars.length === 0, detail: cars.length ? `Still has ${cars.join(", ")}` : "No car assigned" },
        { key: "final_payout", label: "Final payout", done: unpaid === 0, detail: unpaid ? `${unpaid} cents not yet paid out` : "Nothing owed" },
        { key: "access_removed", label: "Remove access", done: !!p.disabled_at, detail: p.disabled_at ? "Sign-in disabled" : "Can still sign in" },
        { key: "archived", label: "Archive the record", done: !!p.archived_at, detail: p.archived_at ? "Archived" : "Active record" },
      ],
      unpaidCents: unpaid,
    };
  }
  @Post(":id/offboard")
  @HttpCode(200)
  async offboard(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.write(req);
    const did = uuid(id);
    const b = asBody(raw);
    return withOrg(this.pool, orgId, async (c) => {
      const ctx = await this.ctx(c);
      const d = await this.one(c, req, did, ctx, false);
      const list = await this.offboardChecklist(c, did);
      if (list.unpaidCents > 0 && b.acknowledgeUnpaid !== true) throw new ConflictException({ message: "This driver is still owed money. Pay it out first, or confirm that you will settle it outside RouteNorth.", code: "unpaid_pay" });
      // 1. return the car (ends open bookings)
      await c.query(`UPDATE vehicle_assignments SET end_at = now() WHERE driver_id = $1 AND archived_at IS NULL AND (end_at IS NULL OR end_at > now())`, [did]);
      await c.query(`UPDATE vehicles SET current_driver_id = NULL WHERE current_driver_id = $1`, [did]);
      // 2. remove access, 3. archive
      await c.query(`UPDATE users SET disabled_at = now() WHERE id = $1`, [did]);
      await c.query(`UPDATE driver_profiles SET archived_at = now(), offboarded_at = now(), status_reason = $2, updated_at = now() WHERE user_id = $1`, [did, typeof b.reason === "string" ? b.reason.slice(0, 500) : null]);
      await auditChange(c, req, { action: "drivers.offboard", entity: "drivers", entityId: did, label: d.name, old: { archivedAt: null, access: true }, next: { archivedAt: new Date().toISOString(), access: false, reason: b.reason ?? null }, sensitive: true });
      return { id: did, offboarded: true };
    });
  }
  @Post(":id/restore")
  @HttpCode(200)
  async restore(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.write(req);
    const did = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const p = (await c.query(`SELECT archived_at FROM driver_profiles WHERE user_id = $1 FOR UPDATE`, [did])).rows[0];
      if (!p) throw new NotFoundException();
      await c.query(`UPDATE users SET disabled_at = NULL WHERE id = $1`, [did]);
      await c.query(`UPDATE driver_profiles SET archived_at = NULL, offboarded_at = NULL, status = 'off_duty', updated_at = now() WHERE user_id = $1`, [did]);
      await auditChange(c, req, { action: "drivers.restore", entity: "drivers", entityId: did, label: null, old: { archivedAt: p.archived_at }, next: { archivedAt: null } });
      return this.one(c, req, did, await this.ctx(c));
    });
  }

  // ---- onboarding --------------------------------------------------------------------------------------------------------------
  @Get(":id/onboarding")
  async onboarding(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    const did = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const st = await loadSettings(c);
      await ensureSteps(c, orgId, did);
      const rows = (await c.query(`SELECT step, status, reason, submitted_at AS "submittedAt", decided_at AS "decidedAt", (SELECT coalesce(display_name,email) FROM users WHERE id = decided_by) AS "decidedBy" FROM driver_onboarding_steps WHERE driver_id = $1`, [did])).rows;
      return { steps: ONBOARDING_STEPS.map((s) => ({ ...s, required: st.requiredSteps.includes(s.key), ...(rows.find((r) => r.step === s.key) ?? { status: "pending" }) })) };
    });
  }

  /** A step moves pending -> submitted (the driver or the office hands it in) -> approved or rejected by the owner, who must give a reason to reject. */
  @Post(":id/onboarding/:step")
  @HttpCode(200)
  async decide(@Req() req: AuthedRequest, @Param("id") id: string, @Param("step") step: string, @Body() raw: unknown) {
    const orgId = this.write(req);
    const did = uuid(id);
    if (!ONBOARDING_STEPS.some((s) => s.key === step)) throw new NotFoundException();
    const b = asBody(raw);
    const action = oneOf(b.action, "action", ["submit", "approve", "reject", "reset"] as const, { required: true })!;
    const reason = typeof b.reason === "string" ? b.reason.trim().slice(0, 500) : "";
    if (action === "reject" && !reason) throw new BadRequestException("a reason is needed to reject a step");
    return withOrg(this.pool, orgId, async (c) => {
      await ensureSteps(c, orgId, did);
      const old = (await c.query(`SELECT status, reason FROM driver_onboarding_steps WHERE driver_id = $1 AND step = $2 FOR UPDATE`, [did, step])).rows[0];
      const next = action === "submit" ? "submitted" : action === "approve" ? "approved" : action === "reject" ? "rejected" : "pending";
      await c.query(`UPDATE driver_onboarding_steps SET status = $3, reason = $4, submitted_at = CASE WHEN $3 = 'submitted' THEN now() ELSE submitted_at END,
                     decided_by = CASE WHEN $3 IN ('approved','rejected') THEN $5::uuid ELSE NULL END, decided_at = CASE WHEN $3 IN ('approved','rejected') THEN now() ELSE NULL END, updated_at = now() WHERE driver_id = $1 AND step = $2`,
        [did, step, next, reason || null, req.session!.userId]);
      const name = (await c.query(`SELECT coalesce(display_name,email) AS n FROM users WHERE id = $1`, [did])).rows[0].n;
      await auditChange(c, req, { action: `driver_onboarding.${action}`, entity: "drivers", entityId: did, label: `${name} · ${stepLabel(step)}`, old: { status: old.status, reason: old.reason }, next: { status: next, reason: reason || null } });
      // A driver still in onboarding becomes active once every required step is approved.
      const ctx = await this.ctx(c);
      const d = await this.one(c, req, did, ctx, false);
      let activated = false;
      if (d.storedStatus === "onboarding" && d.onboarding.requiredOpen.length === 0) {
        await c.query(`UPDATE driver_profiles SET status = 'active', updated_at = now() WHERE user_id = $1`, [did]);
        await auditChange(c, req, { action: "drivers.status", entity: "drivers", entityId: did, label: name, old: { status: "onboarding" }, next: { status: "active", reason: "all required onboarding steps approved" } });
        activated = true;
      }
      return { step, status: next, activated };
    });
  }

  /** Remind a driver who stopped halfway. At most once every two days per driver. */
  @Post(":id/remind")
  @HttpCode(200)
  async remind(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.write(req);
    const did = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const p = (await c.query(`SELECT last_reminded_at FROM driver_profiles WHERE user_id = $1 FOR UPDATE`, [did])).rows[0];
      if (!p) throw new NotFoundException();
      if (p.last_reminded_at && Date.now() - new Date(p.last_reminded_at).getTime() < 2 * 86_400_000) return { sent: false, reason: "reminded less than two days ago" };
      await c.query(`INSERT INTO notifications (org_id, user_id, kind, title, link) VALUES ($1,$2,'system','Please finish your onboarding steps so you can start getting jobs','/driver')`, [orgId, did]);
      await c.query(`UPDATE driver_profiles SET last_reminded_at = now() WHERE user_id = $1`, [did]);
      await auditChange(c, req, { action: "driver_onboarding.remind", entity: "drivers", entityId: did, label: null, old: null, next: { reminded: true } });
      return { sent: true, via: "in-app notification" };
    });
  }

  // ---- performance, safety, hours, trips, vehicle, schedule ------------------------------------------------------------------
  @Get(":id/performance")
  async performance(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    const did = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const ctx = await this.ctx(c);
      const st = await loadSettings(c);
      const d = await this.one(c, req, did, ctx);
      const all = (await loadDrivers(c, ctx, { applicants: false })).filter((x) => x.status !== "archived");
      const stats = (await c.query(
        `SELECT count(*)::int AS assigned, count(*) FILTER (WHERE status = 'completed')::int AS done, count(*) FILTER (WHERE status IN ('cancelled','no_show'))::int AS cancelled,
                avg(rating)::float8 AS rating, avg(cleanliness)::float8 AS clean, count(*) FILTER (WHERE complaint IS NOT NULL)::int AS complaints,
                100.0 * count(*) FILTER (WHERE on_time) / nullif(count(*) FILTER (WHERE on_time IS NOT NULL),0) AS on_time,
                sum(duration_s) FILTER (WHERE status = 'completed')::float8 / 3600 AS hours
         FROM portal_trips WHERE driver_id = $1 AND archived_at IS NULL AND started_at >= now() - make_interval(days => $2)`, [did, SCORE_DAYS])).rows[0];
      const sc = portalDriverScore({ onTimePct: stats.on_time == null ? null : Number(stats.on_time), safetyScore: d.safety, ratingAvg: stats.rating, acceptancePct: stats.assigned ? Math.round((100 * stats.done) / stats.assigned) : null, cleanlinessAvg: stats.clean }, st.weights);
      const avg = (f: (x: DriverRow) => number | null) => { const v = all.map(f).filter((x): x is number => x != null); return v.length ? Math.round((v.reduce((a, x) => a + x, 0) / v.length) * 10) / 10 : null; };
      const goals = (await listChild(c, D_CHILD_BY_NAME.get("goals")!, did)) as { id: string; metric: string; target: number; period: string }[];
      const progress = await Promise.all(goals.map(async (g) => {
        const since = g.period === "week" ? `date_trunc('week', now())` : `date_trunc('month', now())`;
        const r = (await c.query(
          `SELECT count(*) FILTER (WHERE status='completed')::float8 AS trips, avg(rating)::float8 AS rating, 100.0 * count(*) FILTER (WHERE on_time) / nullif(count(*) FILTER (WHERE on_time IS NOT NULL),0) AS ontime
           FROM portal_trips WHERE driver_id = $1 AND archived_at IS NULL AND started_at >= ${since}`, [did])).rows[0];
        const value = g.metric === "trips" ? r.trips : g.metric === "rating" ? r.rating : g.metric === "on_time_rate" ? r.ontime : g.metric === "safety_score" ? d.safety : null;
        return { ...g, current: value == null ? null : Math.round(Number(value) * 10) / 10, pct: value == null || !g.target ? null : Math.min(100, Math.round((100 * Number(value)) / g.target)) };
      }));
      return {
        windowDays: SCORE_DAYS, score: sc.score, parts: sc.parts, formula: sc.formula, weights: st.weights,
        vsTeam: { score: { driver: d.score, team: avg((x) => x.score) }, rating: { driver: d.rating, team: avg((x) => x.rating) }, onTimePct: { driver: d.onTimePct, team: avg((x) => x.onTimePct) } },
        acceptanceRate: stats.assigned ? Math.round((100 * stats.done) / stats.assigned) : null, cancellationRate: stats.assigned ? Math.round((100 * stats.cancelled) / stats.assigned) : null,
        ratingAvg: stats.rating == null ? null : Math.round(stats.rating * 100) / 100, complaints: stats.complaints, tripsPerHour: stats.hours > 0 ? Math.round((stats.done / stats.hours) * 100) / 100 : null,
        goals: progress, belowFloor: sc.score != null && sc.score < st.scoreFloor, scoreFloor: st.scoreFloor,
        definitions: { acceptance: "Share of assigned trips that were completed (not cancelled, failed or a no-show).", cancellation: "Share of assigned trips that were cancelled or a no-show.", onTime: "Share of trips marked on time, last 30 days." },
      };
    });
  }

  @Get(":id/safety")
  async safety(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    const did = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const d = await this.one(c, req, did, await this.ctx(c));
      const events = (await c.query(`SELECT id, at, kind, severity, detail, source, vehicle_id AS "vehicleId" FROM driver_safety_events WHERE driver_id = $1 AND archived_at IS NULL ORDER BY at DESC LIMIT 300`, [did])).rows;
      // weekly trend: score each of the last 8 weeks from that week's events and distance
      const trend: { weekStart: string; score: number; events: number }[] = [];
      for (let k = 7; k >= 0; k--) {
        const w = (await c.query(`SELECT date_trunc('week', now() - make_interval(weeks => $1::int))::date::text AS ws, date_trunc('week', now() - make_interval(weeks => $1::int)) AS s`, [k])).rows[0];
        const ev = events.filter((e) => new Date(e.at) >= new Date(w.s) && new Date(e.at) < new Date(new Date(w.s).getTime() + 7 * 86_400_000));
        const km = Number((await c.query(`SELECT coalesce(sum(distance_m),0)::float8 / 1000 AS km FROM portal_trips WHERE driver_id = $1 AND archived_at IS NULL AND started_at >= $2 AND started_at < $2::timestamptz + interval '7 days'`, [did, w.s])).rows[0].km);
        trend.push({ weekStart: w.ws, score: safetyScore(ev, km), events: ev.length });
      }
      const counts: Record<string, number> = {};
      for (const e of events) counts[e.kind] = (counts[e.kind] ?? 0) + 1;
      return { score: d.safety, formula: SAFETY_FORMULA, counts, events: events.slice(0, 100), trend };
    });
  }

  @Get(":id/hours")
  async hours(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    const did = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const ctx = await this.ctx(c);
      await this.one(c, req, did, ctx);
      const st = await loadSettings(c);
      const shifts = (await c.query(
        `SELECT s.started_at AS "startedAt", s.ended_at AS "endedAt", coalesce((SELECT sum(extract(epoch FROM (coalesce(b.ended_at, now()) - b.started_at)) / 60) FROM shift_breaks b WHERE b.shift_id = s.id), 0)::float8 AS "breakMinutes"
         FROM shifts s WHERE s.driver_id = $1 AND s.started_at >= now() - interval '35 days' ORDER BY s.started_at`, [did])).rows;
      const r = hoursReport(shifts, st.hours, ctx.now, ctx.tz);
      const openBlock = (await loadDrivers(c, ctx, { id: did, applicants: false }))[0]?.blockedReasons ?? [];
      return { rules: st.hours, ...r, blockedFromDuty: openBlock.length > 0, blockedReasons: openBlock, note: "Hours are worked out from shifts started in the driver app. This is a planning aid, not a certified ELD log." };
    });
  }

  @Get(":id/trips")
  async trips(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    const did = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      await this.one(c, req, did, await this.ctx(c));
      const rows = (await c.query(
        `SELECT t.id, t.started_at AS "startedAt", t.ended_at AS "endedAt", t.distance_m AS "distanceM", t.duration_s AS "durationS", t.revenue_cents::float8 AS "revenueCents", t.tip_cents::float8 AS "tipCents", t.status, t.customer_name AS customer,
                t.rating, t.on_time AS "onTime", t.complaint, v.name AS vehicle
         FROM portal_trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id WHERE t.driver_id = $1 AND t.archived_at IS NULL ORDER BY t.started_at DESC LIMIT 500`, [did])).rows;
      return can(req, "pay.view") ? rows : rows.map((r) => ({ ...r, revenueCents: null, tipCents: null }));
    });
  }

  @Get(":id/vehicle")
  async vehicle(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    const did = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const d = await this.one(c, req, did, await this.ctx(c));
      const history = (await c.query(
        `SELECT a.id, a.vehicle_id AS "vehicleId", v.name AS vehicle, v.kind, v.seats, a.kind AS "assignKind", a.start_at AS "startAt", a.end_at AS "endAt", a.odometer_start_km AS "odometerStartKm", a.odometer_end_km AS "odometerEndKm", a.damage_notes AS "damageNotes"
         FROM vehicle_assignments a JOIN vehicles v ON v.id = a.vehicle_id WHERE a.driver_id = $1 AND a.archived_at IS NULL ORDER BY a.start_at DESC LIMIT 100`, [did])).rows;
      const incidents = (await c.query(`SELECT id, occurred_at AS "occurredAt", kind, severity, description, v.name AS vehicle FROM incidents i LEFT JOIN vehicles v ON v.id = i.vehicle_id WHERE i.driver_id = $1 AND i.archived_at IS NULL ORDER BY occurred_at DESC LIMIT 50`, [did])).rows;
      const cur = d.vehicleId ? history.find((h) => h.vehicleId === d.vehicleId) : null;
      const check = cur ? licenceAllows(d.licenseClass, cur.kind, cur.seats) : null;
      return { current: d.vehicleId ? { id: d.vehicleId, name: d.vehicleName, licenceCheck: check } : null, licenseClass: d.licenseClass, history, damageReports: history.filter((h) => h.damageNotes), incidents };
    });
  }
  @Post(":id/vehicle")
  @HttpCode(200)
  async giveVehicle(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = requireAny(req, "drivers.manage", "vehicles.assign");
    const b = asBody(raw);
    return withOrg(this.pool, orgId, async (c) => {
      const r = await this.assignVehicle(c, req, uuid(id), uuid(b.vehicleId, "vehicleId"), b.force === true);
      if (!r.ok) throw new ConflictException({ message: r.reason, code: "assign_refused" });
      return { ok: true };
    });
  }

  /** Change history for this driver: who changed what, with old and new values. */
  @Get(":id/activity")
  async activity(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.write(req);
    const did = uuid(id);
    return withOrg(this.pool, orgId, async (c) => (await c.query(
      `SELECT id, at, actor_label AS actor, action, item_label AS label, old_value AS "oldValue", new_value AS "newValue", sensitive FROM audit_log
       WHERE (entity LIKE 'driver%' AND entity_id = $1) ORDER BY at DESC LIMIT 200`, [did])).rows);
  }

  @Get(":id/schedule")
  async schedule(@Req() req: AuthedRequest, @Param("id") id: string, @Query("from") from?: string, @Query("to") to?: string) {
    const orgId = this.view(req);
    const did = uuid(id);
    const f = from ? new Date(from) : new Date(Date.now() - 7 * 86_400_000), t = to ? new Date(to) : new Date(Date.now() + 28 * 86_400_000);
    if (Number.isNaN(f.getTime()) || Number.isNaN(t.getTime())) throw new BadRequestException("from and to must be dates");
    return withOrg(this.pool, orgId, async (c) => {
      await this.one(c, req, did, await this.ctx(c));
      const plans = (await c.query(`SELECT id, starts_at AS "startsAt", ends_at AS "endsAt", vehicle_id AS "vehicleId", note FROM shift_plans WHERE driver_id = $1 AND starts_at < $3 AND ends_at > $2 ORDER BY starts_at`, [did, f.toISOString(), t.toISOString()])).rows;
      const off = (await c.query(`SELECT id, kind, starts_on::text AS "startsOn", ends_on::text AS "endsOn", status, note FROM time_off WHERE user_id = $1 AND ends_on >= $2::date AND starts_on <= $3::date ORDER BY starts_on`, [did, f.toISOString().slice(0, 10), t.toISOString().slice(0, 10)])).rows;
      const clash = (p: { startsAt: string; endsAt: string }) => off.filter((o) => o.status !== "rejected").some((o) => new Date(p.startsAt) < new Date(`${o.endsOn}T23:59:59Z`) && new Date(p.endsAt) > new Date(`${o.startsOn}T00:00:00Z`));
      const overlap = (a: { id: string; startsAt: string; endsAt: string }) => plans.some((b2) => b2.id !== a.id && new Date(a.startsAt) < new Date(b2.endsAt) && new Date(b2.startsAt) < new Date(a.endsAt));
      return { shifts: plans.map((p) => ({ ...p, conflict: clash(p) ? "time off" : overlap(p) ? "overlapping shift" : null })), timeOff: off };
    });
  }
  @Post(":id/schedule")
  async addShift(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.write(req);
    const did = uuid(id);
    const b = asBody(raw);
    const s = new Date(String(b.startsAt)), e = new Date(String(b.endsAt));
    if (Number.isNaN(s.getTime()) || Number.isNaN(e.getTime()) || e <= s || e.getTime() - s.getTime() > 24 * 3_600_000) throw new BadRequestException("a shift needs a start, and an end up to 24 hours later");
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`INSERT INTO shift_plans (org_id, driver_id, starts_at, ends_at, vehicle_id, note) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [orgId, did, s.toISOString(), e.toISOString(), b.vehicleId ? uuid(b.vehicleId, "vehicleId") : null, typeof b.note === "string" ? b.note.slice(0, 500) : null])).rows[0];
      await auditChange(c, req, { action: "driver_schedule.create", entity: "drivers", entityId: did, label: null, old: null, next: { startsAt: s.toISOString(), endsAt: e.toISOString() } });
      return r;
    });
  }

  // ---- generic children: documents, notes, goals, trainings, safety events ----------------------------------------------------
  @Get(":id/:child")
  async listChildren(@Req() req: AuthedRequest, @Param("id") id: string, @Param("child") name: string, @Query("archived") archived?: string) {
    const d = this.childDef(name);
    const orgId = requireAny(req, ...d.view);
    return withOrg(this.pool, orgId, async (c) => { await this.one(c, req, uuid(id), await this.ctx(c)); return listChild(c, d, uuid(id), { archived: archived === "1" }); });
  }
  @Post(":id/:child")
  async createChildRow(@Req() req: AuthedRequest, @Param("id") id: string, @Param("child") name: string, @Body() raw: unknown) {
    const d = this.childDef(name);
    const orgId = requireAny(req, ...d.write);
    return withOrg(this.pool, orgId, async (c) => { await this.one(c, req, uuid(id), await this.ctx(c)); return createChild(c, req, d, uuid(id), raw); });
  }
  @Patch(":id/:child/:cid")
  async updateChildRow(@Req() req: AuthedRequest, @Param("child") name: string, @Param("cid") cid: string, @Body() raw: unknown) {
    const d = this.childDef(name);
    return withOrg(this.pool, requireAny(req, ...d.write), (c) => updateChild(c, req, d, uuid(cid), raw));
  }
  @Post(":id/:child/:cid/archive") @HttpCode(200)
  async archiveChildRow(@Req() req: AuthedRequest, @Param("child") name: string, @Param("cid") cid: string) {
    const d = this.childDef(name);
    return withOrg(this.pool, requireAny(req, ...d.write), (c) => archiveChild(c, req, d, uuid(cid)));
  }
  @Post(":id/:child/:cid/restore") @HttpCode(200)
  async restoreChildRow(@Req() req: AuthedRequest, @Param("child") name: string, @Param("cid") cid: string) {
    const d = this.childDef(name);
    return withOrg(this.pool, requireAny(req, ...d.write), (c) => archiveChild(c, req, d, uuid(cid), true));
  }
  private childDef(name: string) {
    const d = D_CHILD_BY_NAME.get(name);
    if (!d) throw new NotFoundException();
    return d;
  }
}

async function regionGuard(c: pg.PoolClient, req: AuthedRequest, teamId: string | null): Promise<void> {
  const scope = await regionScope(c, req);
  if (scope && (!teamId || !scope.includes(teamId))) throw new ForbiddenException("this driver is outside your region");
}

export type { DriverStatus };
