import { BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { RATE_TYPES, RATE_TYPE_LABEL, cardState, evaluateBonus, isBigChange, priceTrip, type Permission, type RateSpec } from "@routenorth/shared";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard.js";
import { auditChange } from "../audit/domain-audit.js";
import { addNotification } from "../business/notifications.js";
import { PG_POOL } from "../tokens.js";
import { body as asBody, cents, companyFormat, dateOnly, int, num, oneOf, onlyKeys, requireAny, str, uuid } from "./common.js";
import { parseSpec, specSummary } from "./pay-spec.js";
import { PAY_DEFAULTS, activeBonusRules, assignmentsFor, assertSecondPerson, calcTripPay, costPerKmCents, factsOf, paySettings, periodStats, replayTrips, resolveForTrip, versionOnDay, type TripRow } from "./pay.service.js";
import { todayIn } from "./vehicles.service.js";

const can = (req: AuthedRequest, ...p: Permission[]) => p.some((x) => req.perms?.has(x));
const VIEW: Permission[] = ["pay.view", "pay.manage"];
const ASSIGN_KINDS = ["driver", "customer", "zone", "vehicle_type", "group", "all"] as const;
const BONUS_KINDS = ["trip_count", "on_time", "rating", "peak", "busy_zone", "referral", "safety", "streak", "tiered", "manual"] as const;
const DEDUCTION_KINDS = ["vehicle_share", "fuel_advance", "fine", "damage", "equipment", "phone", "loan", "other"] as const;

/** Rate cards, versions, assignments, the simulator, bonus rules, deductions and manual adjustments. */
@Controller("portal/pay")
@UseGuards(AuthGuard)
export class PortalPayController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}
  private view(req: AuthedRequest) { return requireAny(req, ...VIEW); }
  private manage(req: AuthedRequest) { return requireAny(req, "pay.manage"); }
  private async tz(c: pg.PoolClient) { return (await companyFormat(c)).timezone; }

  // ---- settings --------------------------------------------------------------------------------------------------------------
  @Get("settings")
  async getSettings(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, (c) => paySettings(c));
  }
  @Put("settings")
  async putSettings(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    onlyKeys(b, ["secondApprover", "deductionCapPct", "holdOnExpiredDocs", "holdOnOpenIncident", "defaultCycle"]);
    return withOrg(this.pool, orgId, async (c) => {
      const old = await paySettings(c);
      const next = { ...old };
      if (b.secondApprover !== undefined) {
        if (typeof b.secondApprover !== "boolean") throw new BadRequestException("secondApprover must be true or false");
        // Turning the second-person rule off removes a safety check, so only the owner may do it.
        if (b.secondApprover !== old.secondApprover && req.session!.role !== "owner") throw new ForbiddenException("Only an owner can change the second-person rule");
        next.secondApprover = b.secondApprover;
      }
      if (b.deductionCapPct !== undefined) next.deductionCapPct = num(b.deductionCapPct, "deductionCapPct", { min: 0, max: 100, required: true })!;
      for (const k of ["holdOnExpiredDocs", "holdOnOpenIncident"] as const) if (b[k] !== undefined) { if (typeof b[k] !== "boolean") throw new BadRequestException(`${k} must be true or false`); next[k] = b[k] as boolean; }
      if (b.defaultCycle !== undefined) next.defaultCycle = oneOf(b.defaultCycle, "defaultCycle", ["daily", "weekly", "biweekly", "monthly"] as const, { required: true })!;
      await c.query(`INSERT INTO portal_settings (org_id, data, updated_by) VALUES ($1, jsonb_build_object('pay', $2::jsonb), $3)
                     ON CONFLICT (org_id) DO UPDATE SET data = jsonb_set(portal_settings.data, '{pay}', $2::jsonb), updated_by = $3, updated_at = now()`, [orgId, JSON.stringify(next), req.session!.userId]);
      await auditChange(c, req, { action: "pay.settings.update", entity: "pay_settings", entityId: orgId, label: "Pay settings", old: old as never, next: next as never, sensitive: true });
      return next;
    });
  }

  // ---- rate cards ------------------------------------------------------------------------------------------------------------
  @Get("meta")
  async meta(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => ({
      types: RATE_TYPES.map((t) => ({ value: t, label: RATE_TYPE_LABEL[t] })), settings: await paySettings(c), defaults: PAY_DEFAULTS,
      drivers: (await c.query(`SELECT u.id, coalesce(u.display_name, u.email) AS name FROM users u WHERE u.role = 'driver' AND u.disabled_at IS NULL ORDER BY 2`)).rows,
      teams: (await c.query(`SELECT id, name FROM teams ORDER BY name`)).rows,
      vehicleKinds: (await c.query(`SELECT DISTINCT kind AS name FROM vehicles WHERE archived_at IS NULL ORDER BY 1`)).rows.map((r) => r.name),
      customers: (await c.query(`SELECT DISTINCT customer_name AS name FROM portal_trips WHERE customer_name IS NOT NULL AND archived_at IS NULL ORDER BY 1 LIMIT 300`)).rows.map((r) => r.name),
      zones: (await c.query(`SELECT DISTINCT zone AS name FROM portal_trips WHERE zone IS NOT NULL AND archived_at IS NULL ORDER BY 1 LIMIT 300`)).rows.map((r) => r.name),
      canManage: can(req, "pay.manage"),
    }));
  }

  @Get("cards")
  async cards(@Req() req: AuthedRequest, @Query("kind") kind?: string, @Query("archived") archived?: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const today = todayIn(await this.tz(c));
      const rows = (await c.query(
        `SELECT k.id, k.name, k.kind, k.notes, k.archived_at AS "archivedAt", k.created_at AS "createdAt",
                (SELECT count(*) FROM rate_card_assignments a WHERE a.card_id = k.id AND a.archived_at IS NULL)::int AS assignments
         FROM portal_rate_cards k WHERE ($1::text IS NULL OR k.kind = $1) AND ($2::boolean OR k.archived_at IS NULL) ORDER BY k.kind, lower(k.name)`, [kind ?? null, archived === "1"])).rows;
      const out = [];
      for (const k of rows) {
        const vs = (await c.query(`SELECT id, version, spec, starts_on::text AS "startsOn", ends_on::text AS "endsOn", status, big_change AS "bigChange" FROM portal_rate_versions WHERE card_id = $1 ORDER BY version DESC`, [k.id])).rows;
        // The state shown on the card is the version in force today, else the newest one.
        const live = vs.filter((v) => v.status === "active").sort((a, b) => b.startsOn.localeCompare(a.startsOn)).find((v) => v.startsOn <= today && (!v.endsOn || v.endsOn >= today));
        const head = live ?? vs[0];
        out.push({ ...k, state: head ? cardState(head, today, !!k.archivedAt) : "draft", current: head ? { id: head.id, version: head.version, summary: specSummary(head.spec), type: head.spec.type, startsOn: head.startsOn, endsOn: head.endsOn } : null, versions: vs.length, pending: vs.some((v) => v.status === "pending") });
      }
      return out;
    });
  }

  @Post("cards")
  async createCard(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    onlyKeys(b, ["name", "kind", "notes", "spec", "startsOn", "endsOn", "changeNote"]);
    const name = str(b.name, "name", { required: true, max: 120 })!;
    const kind = oneOf(b.kind, "kind", ["customer", "driver"] as const, { required: true })!;
    const spec = parseSpec(b.spec);
    const startsOn = dateOnly(b.startsOn, "startsOn", true)!; const endsOn = dateOnly(b.endsOn, "endsOn");
    if (endsOn && endsOn < startsOn) throw new BadRequestException("endsOn cannot be before startsOn");
    return withOrg(this.pool, orgId, async (c) => {
      if ((await c.query(`SELECT 1 FROM portal_rate_cards WHERE lower(name) = lower($1) AND kind = $2 AND archived_at IS NULL`, [name, kind])).rowCount) throw new ConflictException(`A ${kind} card called “${name}” already exists`);
      const card = (await c.query(`INSERT INTO portal_rate_cards (org_id, name, kind, notes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [orgId, name, kind, str(b.notes, "notes", { max: 1000 }), req.session!.userId])).rows[0];
      const v = (await c.query(`INSERT INTO portal_rate_versions (org_id, card_id, version, spec, starts_on, ends_on, big_change, change_note, created_by) VALUES ($1,$2,1,$3,$4,$5,true,$6,$7) RETURNING id`,
        [orgId, card.id, JSON.stringify(spec), startsOn, endsOn, str(b.changeNote, "changeNote", { max: 500 }) ?? "First version", req.session!.userId])).rows[0];
      await auditChange(c, req, { action: "rate_cards.create", entity: "rate_cards", entityId: card.id, label: name, old: null, next: { name, kind, spec: spec as never, startsOn, endsOn }, sensitive: true });
      return { id: card.id, versionId: v.id };
    });
  }

  @Get("cards/:id")
  async card(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const k = (await c.query(`SELECT id, name, kind, notes, archived_at AS "archivedAt", created_at AS "createdAt" FROM portal_rate_cards WHERE id = $1`, [uuid(id)])).rows[0];
      if (!k) throw new NotFoundException();
      const versions = (await c.query(
        `SELECT v.id, v.version, v.spec, v.starts_on::text AS "startsOn", v.ends_on::text AS "endsOn", v.status, v.big_change AS "bigChange", v.change_note AS "changeNote", v.created_at AS "createdAt", v.approved_at AS "approvedAt",
                coalesce(cu.display_name, cu.email) AS "createdBy", coalesce(au.display_name, au.email) AS "approvedBy",
                (SELECT count(*) FROM portal_trips t WHERE t.driver_rate_version_id = v.id OR t.customer_rate_version_id = v.id)::int AS trips
         FROM portal_rate_versions v LEFT JOIN users cu ON cu.id = v.created_by LEFT JOIN users au ON au.id = v.approved_by WHERE v.card_id = $1 ORDER BY v.version DESC`, [k.id])).rows;
      const assignments = await this.assignmentRows(c, k.id);
      const history = (await c.query(`SELECT a.at, a.action, a.actor_label AS "actor", a.old_value AS "old", a.new_value AS "new" FROM audit_log a WHERE a.entity IN ('rate_cards','rate_versions') AND (a.entity_id = $1::text OR a.entity_id = ANY($2::text[])) ORDER BY a.at DESC LIMIT 100`, [k.id, versions.map((v) => v.id)])).rows;
      return { ...k, versions: versions.map((v) => ({ ...v, summary: specSummary(v.spec) })), assignments, history };
    });
  }

  @Patch("cards/:id")
  async editCard(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    onlyKeys(b, ["name", "notes"]);
    return withOrg(this.pool, orgId, async (c) => {
      const old = (await c.query(`SELECT name, notes FROM portal_rate_cards WHERE id = $1`, [uuid(id)])).rows[0];
      if (!old) throw new NotFoundException();
      const name = b.name !== undefined ? str(b.name, "name", { required: true, max: 120 })! : old.name;
      const notes = b.notes !== undefined ? str(b.notes, "notes", { max: 1000 }) : old.notes;
      await c.query(`UPDATE portal_rate_cards SET name = $2, notes = $3, updated_at = now() WHERE id = $1`, [id, name, notes]);
      await auditChange(c, req, { action: "rate_cards.update", entity: "rate_cards", entityId: id, label: name, old, next: { name, notes }, sensitive: true });
      return { ok: true };
    });
  }

  @Post("cards/:id/clone")
  async cloneCard(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    return withOrg(this.pool, orgId, async (c) => {
      const k = (await c.query(`SELECT name, kind, notes FROM portal_rate_cards WHERE id = $1`, [uuid(id)])).rows[0];
      if (!k) throw new NotFoundException();
      const v = (await c.query(`SELECT spec FROM portal_rate_versions WHERE card_id = $1 AND status <> 'draft' ORDER BY version DESC LIMIT 1`, [id])).rows[0] ?? (await c.query(`SELECT spec FROM portal_rate_versions WHERE card_id = $1 ORDER BY version DESC LIMIT 1`, [id])).rows[0];
      const name = str(b.name, "name", { max: 120 }) ?? `${k.name} (copy)`;
      const day = todayIn(await this.tz(c));
      const card = (await c.query(`INSERT INTO portal_rate_cards (org_id, name, kind, notes, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [orgId, name, k.kind, k.notes, req.session!.userId])).rows[0];
      await c.query(`INSERT INTO portal_rate_versions (org_id, card_id, version, spec, starts_on, big_change, change_note, created_by) VALUES ($1,$2,1,$3,$4,true,$5,$6)`, [orgId, card.id, JSON.stringify(v.spec), day, `Copied from ${k.name}`, req.session!.userId]);
      await auditChange(c, req, { action: "rate_cards.clone", entity: "rate_cards", entityId: card.id, label: name, old: null, next: { name, copiedFrom: k.name }, sensitive: true });
      return { id: card.id };
    });
  }

  @Post("cards/:id/archive")
  @HttpCode(200)
  async archiveCard(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.manage(req);
    return withOrg(this.pool, orgId, async (c) => {
      const k = (await c.query(`SELECT name FROM portal_rate_cards WHERE id = $1 AND archived_at IS NULL`, [uuid(id)])).rows[0];
      if (!k) throw new NotFoundException();
      await c.query(`UPDATE portal_rate_cards SET archived_at = now(), updated_at = now() WHERE id = $1`, [id]);
      await c.query(`UPDATE rate_card_assignments SET archived_at = now() WHERE card_id = $1 AND archived_at IS NULL`, [id]);
      await auditChange(c, req, { action: "rate_cards.archive", entity: "rate_cards", entityId: id, label: k.name, old: { archived: false }, next: { archived: true }, sensitive: true });
      return { ok: true };
    });
  }

  @Post("cards/:id/restore")
  @HttpCode(200)
  async restoreCard(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.manage(req);
    return withOrg(this.pool, orgId, async (c) => {
      const k = (await c.query(`UPDATE portal_rate_cards SET archived_at = NULL, updated_at = now() WHERE id = $1 AND archived_at IS NOT NULL RETURNING name`, [uuid(id)])).rows[0];
      if (!k) throw new NotFoundException();
      await auditChange(c, req, { action: "rate_cards.restore", entity: "rate_cards", entityId: id, label: k.name, old: { archived: true }, next: { archived: false }, sensitive: true });
      return { ok: true };
    });
  }

  // ---- versions --------------------------------------------------------------------------------------------------------------
  /** A new version of a card (a draft). Its start date must be after the one in force, so history stays in order. */
  @Post("cards/:id/versions")
  async newVersion(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    onlyKeys(b, ["spec", "startsOn", "endsOn", "changeNote"]);
    const spec = parseSpec(b.spec); const startsOn = dateOnly(b.startsOn, "startsOn", true)!; const endsOn = dateOnly(b.endsOn, "endsOn");
    if (endsOn && endsOn < startsOn) throw new BadRequestException("endsOn cannot be before startsOn");
    return withOrg(this.pool, orgId, async (c) => {
      const k = (await c.query(`SELECT name FROM portal_rate_cards WHERE id = $1 AND archived_at IS NULL FOR UPDATE`, [uuid(id)])).rows[0];
      if (!k) throw new NotFoundException();
      if ((await c.query(`SELECT 1 FROM portal_rate_versions WHERE card_id = $1 AND status IN ('draft','pending')`, [id])).rowCount) throw new ConflictException("This card already has a draft or a version waiting for approval. Finish or discard it first.");
      const prev = (await c.query(`SELECT spec, starts_on::text AS starts_on, version FROM portal_rate_versions WHERE card_id = $1 AND status = 'active' ORDER BY starts_on DESC, version DESC LIMIT 1`, [id])).rows[0];
      if (prev && startsOn <= prev.starts_on) throw new BadRequestException(`The new version must start after ${prev.starts_on}, when the current one starts. Old trips keep the old rate.`);
      const big = isBigChange(prev?.spec ?? null, spec);
      const nextVer = (await c.query(`SELECT coalesce(max(version),0) + 1 AS n FROM portal_rate_versions WHERE card_id = $1`, [id])).rows[0].n;
      const v = (await c.query(`INSERT INTO portal_rate_versions (org_id, card_id, version, spec, starts_on, ends_on, big_change, change_note, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [orgId, id, nextVer, JSON.stringify(spec), startsOn, endsOn, big, str(b.changeNote, "changeNote", { max: 500 }), req.session!.userId])).rows[0];
      await auditChange(c, req, { action: "rate_versions.create", entity: "rate_versions", entityId: v.id, label: `${k.name} v${nextVer}`, old: (prev?.spec ?? null) as never, next: spec as never, sensitive: true });
      return { id: v.id, version: nextVer, bigChange: big };
    });
  }

  @Patch("versions/:id")
  async editVersion(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    onlyKeys(b, ["spec", "startsOn", "endsOn", "changeNote"]);
    return withOrg(this.pool, orgId, async (c) => {
      const v = (await c.query(`SELECT v.*, v.starts_on::text AS so, v.ends_on::text AS eo, k.name FROM portal_rate_versions v JOIN portal_rate_cards k ON k.id = v.card_id WHERE v.id = $1 FOR UPDATE OF v`, [uuid(id)])).rows[0];
      if (!v) throw new NotFoundException();
      if (v.status !== "draft") throw new ConflictException("Only a draft can be edited. Make a new version instead.");
      const spec = b.spec !== undefined ? parseSpec(b.spec) : v.spec;
      const startsOn = b.startsOn !== undefined ? dateOnly(b.startsOn, "startsOn", true)! : v.so;
      const endsOn = b.endsOn !== undefined ? dateOnly(b.endsOn, "endsOn") : v.eo;
      if (endsOn && endsOn < startsOn) throw new BadRequestException("endsOn cannot be before startsOn");
      const prev = (await c.query(`SELECT spec, starts_on::text AS starts_on FROM portal_rate_versions WHERE card_id = $1 AND status = 'active' ORDER BY starts_on DESC, version DESC LIMIT 1`, [v.card_id])).rows[0];
      if (prev && startsOn <= prev.starts_on) throw new BadRequestException(`The new version must start after ${prev.starts_on}`);
      const big = isBigChange(prev?.spec ?? null, spec);
      await c.query(`UPDATE portal_rate_versions SET spec = $2, starts_on = $3, ends_on = $4, big_change = $5, change_note = $6 WHERE id = $1`, [id, JSON.stringify(spec), startsOn, endsOn, big, b.changeNote !== undefined ? str(b.changeNote, "changeNote", { max: 500 }) : v.change_note]);
      await auditChange(c, req, { action: "rate_versions.update", entity: "rate_versions", entityId: id, label: `${v.name} v${v.version}`, old: { spec: v.spec, startsOn: v.so, endsOn: v.eo }, next: { spec, startsOn, endsOn }, sensitive: true });
      return { ok: true, bigChange: big };
    });
  }

  @Delete("versions/:id")
  async discardVersion(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.manage(req);
    return withOrg(this.pool, orgId, async (c) => {
      const v = (await c.query(`SELECT v.version, v.status, k.name FROM portal_rate_versions v JOIN portal_rate_cards k ON k.id = v.card_id WHERE v.id = $1`, [uuid(id)])).rows[0];
      if (!v) throw new NotFoundException();
      if (v.status !== "draft") throw new ConflictException("Only a draft can be discarded");
      if (v.version === 1 && !(await c.query(`SELECT 1 FROM portal_rate_versions WHERE card_id = (SELECT card_id FROM portal_rate_versions WHERE id = $1) AND id <> $1`, [id])).rowCount) throw new ConflictException("This is the card's only version. Archive the card instead.");
      await c.query(`DELETE FROM portal_rate_versions WHERE id = $1`, [id]);
      await auditChange(c, req, { action: "rate_versions.discard", entity: "rate_versions", entityId: id, label: `${v.name} v${v.version}`, old: { status: "draft" }, next: null, sensitive: true });
      return { ok: true };
    });
  }

  private async activate(c: pg.PoolClient, req: AuthedRequest, v: Record<string, any>, by: string): Promise<void> {
    // The version before it stops the day before this one starts, so no day is covered by two versions.
    await c.query(`UPDATE portal_rate_versions SET ends_on = ($2::date - 1) WHERE card_id = $1 AND status = 'active' AND id <> $3 AND starts_on < $2::date AND (ends_on IS NULL OR ends_on >= $2::date)`, [v.card_id, v.so, v.id]);
    await c.query(`UPDATE portal_rate_versions SET status = 'active', approved_by = $2, approved_at = now() WHERE id = $1`, [v.id, by]);
    await auditChange(c, req, { action: "rate_versions.activate", entity: "rate_versions", entityId: v.id, label: `${v.name} v${v.version}`, old: { status: v.status }, next: { status: "active", startsOn: v.so }, sensitive: true });
  }

  /** Small changes go live at once. Big ones (over 10 percent, a new rate type, a new card) wait for a second person. */
  @Post("versions/:id/submit")
  @HttpCode(200)
  async submit(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.manage(req);
    return withOrg(this.pool, orgId, async (c) => {
      const v = (await c.query(`SELECT v.*, v.starts_on::text AS so, k.name, k.kind FROM portal_rate_versions v JOIN portal_rate_cards k ON k.id = v.card_id WHERE v.id = $1 AND k.archived_at IS NULL FOR UPDATE OF v`, [uuid(id)])).rows[0];
      if (!v) throw new NotFoundException();
      if (v.status !== "draft") throw new ConflictException(`This version is already ${v.status}`);
      const st = await paySettings(c);
      if (v.big_change && st.secondApprover) {
        const first = !(await c.query(`SELECT 1 FROM portal_rate_versions WHERE card_id = $1 AND status = 'active'`, [v.card_id])).rowCount;
        await c.query(`UPDATE portal_rate_versions SET status = 'pending', submitted_by = $2 WHERE id = $1`, [id, req.session!.userId]);
        await c.query(`INSERT INTO change_requests (org_id, kind, entity, entity_id, summary, proposed, current, requested_by) VALUES ($1,$2,'rate_versions',$3,$4,$5,$6,$7)`,
          [orgId, first ? "rate_card_activation" : "rate_card_change", id, `${first ? "Start" : "Change"} ${v.kind} rate card “${v.name}” (v${v.version}, from ${v.so}): ${specSummary(v.spec)}`.slice(0, 300), JSON.stringify({ spec: v.spec, startsOn: v.so }),
          JSON.stringify({ summary: "previous version" }), req.session!.userId]);
        await auditChange(c, req, { action: "rate_versions.submit", entity: "rate_versions", entityId: id, label: `${v.name} v${v.version}`, old: { status: "draft" }, next: { status: "pending" }, sensitive: true });
        for (const u of (await c.query(`SELECT id FROM users WHERE role IN ('owner','admin') AND disabled_at IS NULL AND id <> $1`, [req.session!.userId])).rows) await addNotification(c, orgId, u.id, "approval", `Rate card waiting for approval: ${v.name}`, "/owner/pay-rates");
        return { status: "pending", needsApproval: true };
      }
      await this.activate(c, req, v, req.session!.userId);
      return { status: "active", needsApproval: false };
    });
  }

  @Post("versions/:id/approve")
  @HttpCode(200)
  async approve(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.manage(req);
    return withOrg(this.pool, orgId, async (c) => {
      const v = (await c.query(`SELECT v.*, v.starts_on::text AS so, k.name FROM portal_rate_versions v JOIN portal_rate_cards k ON k.id = v.card_id WHERE v.id = $1 FOR UPDATE OF v`, [uuid(id)])).rows[0];
      if (!v) throw new NotFoundException();
      if (v.status !== "pending") throw new ConflictException("Nothing to approve here");
      assertSecondPerson(await paySettings(c), v.submitted_by, req.session!.userId, "this rate card change");
      await this.activate(c, req, v, req.session!.userId);
      await c.query(`UPDATE change_requests SET status = 'approved', decided_by = $2, decided_at = now(), updated_at = now() WHERE entity_id = $1 AND status = 'pending'`, [id, req.session!.userId]);
      if (v.submitted_by) await addNotification(c, orgId, v.submitted_by, "approval", `Rate card approved: ${v.name}`, "/owner/pay-rates");
      return { status: "active" };
    });
  }

  @Post("versions/:id/reject")
  @HttpCode(200)
  async reject(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const note = str(asBody(raw).note, "note", { required: true, max: 500 })!;
    return withOrg(this.pool, orgId, async (c) => {
      const v = (await c.query(`SELECT v.*, k.name FROM portal_rate_versions v JOIN portal_rate_cards k ON k.id = v.card_id WHERE v.id = $1 FOR UPDATE OF v`, [uuid(id)])).rows[0];
      if (!v) throw new NotFoundException();
      if (v.status !== "pending") throw new ConflictException("Nothing to reject here");
      await c.query(`UPDATE portal_rate_versions SET status = 'draft', submitted_by = NULL WHERE id = $1`, [id]);
      await c.query(`UPDATE change_requests SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3, updated_at = now() WHERE entity_id = $1 AND status = 'pending'`, [id, req.session!.userId, note]);
      await auditChange(c, req, { action: "rate_versions.reject", entity: "rate_versions", entityId: id, label: `${v.name} v${v.version}`, old: { status: "pending" }, next: { status: "draft", note }, sensitive: true });
      if (v.submitted_by) await addNotification(c, orgId, v.submitted_by, "approval", `Rate card sent back: ${v.name} (${note})`, "/owner/pay-rates");
      return { status: "draft" };
    });
  }

  @Get("approvals")
  async approvals(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => ({
      rateCards: (await c.query(`SELECT cr.id, cr.entity_id AS "versionId", cr.kind, cr.summary, cr.requested_at AS "requestedAt", coalesce(u.display_name, u.email) AS "requestedBy", cr.requested_by AS "requestedById" FROM change_requests cr LEFT JOIN users u ON u.id = cr.requested_by WHERE cr.status = 'pending' AND cr.entity = 'rate_versions' ORDER BY cr.requested_at`)).rows,
      deductions: (await c.query(`SELECT d.id, d.label, d.total_cents::float8 AS "totalCents", d.created_at AS "createdAt", coalesce(u.display_name, u.email) AS driver FROM portal_deductions d JOIN users u ON u.id = d.driver_id WHERE d.status = 'pending_approval' AND d.archived_at IS NULL ORDER BY d.created_at`)).rows,
      adjustments: (await c.query(`SELECT l.id, l.label, l.kind, l.amount_cents::float8 AS "amountCents", l.reason, l.created_at AS "createdAt", coalesce(u.display_name, u.email) AS driver FROM portal_pay_lines l JOIN users u ON u.id = l.driver_id WHERE l.approval = 'pending' AND l.archived_at IS NULL ORDER BY l.created_at`)).rows,
      payouts: (await c.query(`SELECT p.id, p.run_id AS "runId", p.net_cents::float8 AS "netCents", p.from_date::text AS "from", p.to_date::text AS "to", coalesce(u.display_name, u.email) AS driver FROM portal_payouts p JOIN users u ON u.id = p.driver_id WHERE p.status = 'draft' AND p.hold_reason IS NULL ORDER BY p.created_at`)).rows,
    }));
  }

  // ---- assignments and "which card wins" -----------------------------------------------------------------------------------
  private async assignmentRows(c: pg.PoolClient, cardId?: string) {
    return (await c.query(
      `SELECT a.id, a.card_id AS "cardId", k.name AS "cardName", k.kind AS "cardKind", a.kind, a.target, a.starts_on::text AS "startsOn", a.ends_on::text AS "endsOn", a.created_at AS "createdAt",
              CASE a.kind WHEN 'driver' THEN (SELECT coalesce(u.display_name, u.email) FROM users u WHERE u.id::text = a.target) WHEN 'group' THEN (SELECT t.name FROM teams t WHERE t.id::text = a.target) ELSE a.target END AS "targetName"
       FROM rate_card_assignments a JOIN portal_rate_cards k ON k.id = a.card_id WHERE a.archived_at IS NULL AND k.archived_at IS NULL ${cardId ? "AND a.card_id = $1" : ""} ORDER BY k.kind, a.kind, a.starts_on DESC`, cardId ? [cardId] : [])).rows;
  }

  @Get("assignments")
  async assignments(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, (c) => this.assignmentRows(c));
  }

  @Post("assignments")
  async assign(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    onlyKeys(b, ["cardId", "kind", "target", "targetIds", "startsOn", "endsOn"]);
    const kind = oneOf(b.kind, "kind", ASSIGN_KINDS, { required: true })!;
    const targets: (string | null)[] = kind === "all" ? [null] : Array.isArray(b.targetIds) && b.targetIds.length ? (b.targetIds as unknown[]).map((x) => str(x, "target", { required: true, max: 200 })) : [str(b.target, "target", { required: true, max: 200 })];
    if (targets.length > 200) throw new BadRequestException("too many targets at once");
    return withOrg(this.pool, orgId, async (c) => {
      const k = (await c.query(`SELECT name, kind FROM portal_rate_cards WHERE id = $1 AND archived_at IS NULL`, [uuid(b.cardId, "cardId")])).rows[0];
      if (!k) throw new NotFoundException("rate card not found");
      const day = todayIn(await this.tz(c));
      const startsOn = dateOnly(b.startsOn, "startsOn") ?? day; const endsOn = dateOnly(b.endsOn, "endsOn");
      if (endsOn && endsOn < startsOn) throw new BadRequestException("endsOn cannot be before startsOn");
      const made: string[] = [];
      for (const t of targets) {
        if (kind === "driver") { uuid(t, "driver"); if (!(await c.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'driver'`, [t])).rowCount) throw new BadRequestException("driver not found"); }
        if (kind === "group") { uuid(t, "group"); if (!(await c.query(`SELECT 1 FROM teams WHERE id = $1`, [t])).rowCount) throw new BadRequestException("group (team) not found"); }
        // A driver is on one pay card at a time: the new one takes over from its start date.
        if (kind === "driver" && k.kind === "driver") {
          await c.query(`UPDATE rate_card_assignments a SET ends_on = ($3::date - 1) FROM portal_rate_cards pk WHERE pk.id = a.card_id AND pk.kind = 'driver' AND a.kind = 'driver' AND a.target = $1 AND a.archived_at IS NULL AND a.id IS NOT NULL AND a.starts_on < $3::date AND (a.ends_on IS NULL OR a.ends_on >= $3::date) AND a.org_id = $2`, [t, orgId, startsOn]);
          await c.query(`UPDATE rate_card_assignments a SET archived_at = now() FROM portal_rate_cards pk WHERE pk.id = a.card_id AND pk.kind = 'driver' AND a.kind = 'driver' AND a.target = $1 AND a.archived_at IS NULL AND a.starts_on >= $2::date`, [t, startsOn]);
        }
        const r = (await c.query(`INSERT INTO rate_card_assignments (org_id, card_id, kind, target, starts_on, ends_on, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`, [orgId, b.cardId, kind, t, startsOn, endsOn, req.session!.userId])).rows[0];
        made.push(r.id);
        await auditChange(c, req, { action: "rate_assignments.create", entity: "rate_assignments", entityId: r.id, label: `${k.name} → ${kind}${t ? ` ${t}` : ""}`, old: null, next: { card: k.name, kind, target: t, startsOn, endsOn }, sensitive: true });
      }
      return { ids: made };
    });
  }

  @Post("assignments/:id/end")
  @HttpCode(200)
  async endAssignment(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    return withOrg(this.pool, orgId, async (c) => {
      const a = (await c.query(`SELECT a.*, a.starts_on::text AS so, k.name FROM rate_card_assignments a JOIN portal_rate_cards k ON k.id = a.card_id WHERE a.id = $1 AND a.archived_at IS NULL`, [uuid(id)])).rows[0];
      if (!a) throw new NotFoundException();
      const on = dateOnly(b.endsOn, "endsOn") ?? todayIn(await this.tz(c));
      if (on < a.so) { await c.query(`UPDATE rate_card_assignments SET archived_at = now() WHERE id = $1`, [id]); }
      else await c.query(`UPDATE rate_card_assignments SET ends_on = $2 WHERE id = $1`, [id, on]);
      await auditChange(c, req, { action: "rate_assignments.end", entity: "rate_assignments", entityId: id, label: `${a.name} → ${a.kind}`, old: { endsOn: null }, next: { endsOn: on }, sensitive: true });
      return { ok: true };
    });
  }

  /** Which card wins for a trip, and why each other assignment lost. */
  @Get("resolve")
  async resolve(@Req() req: AuthedRequest, @Query() q: Record<string, string | undefined>) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const kind = oneOf(q.kind ?? "driver", "kind", ["customer", "driver"] as const, { required: true })!;
      const day = dateOnly(q.day, "day") ?? todayIn(await this.tz(c));
      const r = await resolveForTrip(c, kind, { driverId: q.driverId ? uuid(q.driverId, "driverId") : null, customer: q.customer ?? null, zone: q.zone ?? null, vehicleKind: q.vehicleKind ?? null, day });
      return { day, winner: r.assignment, version: r.version ? { id: r.version.id, cardId: r.version.cardId, name: r.version.cardName, version: r.version.version, summary: specSummary(r.version.spec) } : null, considered: r.considered };
    });
  }

  // ---- simulator, compare, what-if ---------------------------------------------------------------------------------------------
  private async specOf(c: pg.PoolClient, ref: { cardId?: unknown; spec?: unknown }, day: string): Promise<{ spec: RateSpec; name: string } | null> {
    if (ref.spec != null) return { spec: parseSpec(ref.spec), name: "Typed card" };
    if (ref.cardId == null || ref.cardId === "") return null;
    const v = await versionOnDay(c, uuid(ref.cardId, "cardId"), day);
    if (v) return { spec: v.spec, name: `${v.cardName} v${v.version}` };
    // A card with only a draft can still be tried out before it is saved for real.
    const d = (await c.query(`SELECT v.spec, k.name, v.version FROM portal_rate_versions v JOIN portal_rate_cards k ON k.id = v.card_id WHERE v.card_id = $1 ORDER BY v.version DESC LIMIT 1`, [ref.cardId])).rows[0];
    if (!d) throw new NotFoundException("rate card not found");
    return { spec: d.spec, name: `${d.name} v${d.version} (not live yet)` };
  }

  /** Type a distance, time and conditions; see what the customer pays, what the driver earns, what the car costs and what is left. Nothing is saved. */
  @Post("simulate")
  @HttpCode(200)
  async simulate(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.view(req);
    const b = asBody(raw);
    return withOrg(this.pool, orgId, async (c) => {
      const day = dateOnly(b.day, "day") ?? todayIn(await this.tz(c));
      const t = asBody(b.trip ?? {});
      const cond = asBody(t.conditions ?? {});
      const vehicleKind = str(t.vehicleKind, "vehicleKind", { max: 60 });
      const tipCents = cents(t.tipCents, "tipCents") ?? 0, tollCents = cents(t.tollCents, "tollCents") ?? 0;
      const base = {
        distanceKm: num(t.distanceKm, "distanceKm", { min: 0, max: 100_000 }) ?? 0, durationMin: num(t.durationMin, "durationMin", { min: 0, max: 100_000 }) ?? 0, waitingMin: num(t.waitingMin, "waitingMin", { min: 0, max: 100_000 }) ?? 0,
        stops: int(t.stops, "stops", { min: 0, max: 1000 }) ?? 1, weightKg: num(t.weightKg, "weightKg", { min: 0, max: 1_000_000 }) ?? 0, zone: str(t.zone, "zone", { max: 80 }), vehicleKind, driverLevel: str(t.driverLevel, "driverLevel", { max: 40 }),
        status: (oneOf(t.status, "status", ["completed", "cancelled", "failed", "no_show"] as const) ?? "completed") as "completed",
        conditions: { peak: cond.peak === true, night: cond.night === true, weekend: cond.weekend === true, holiday: cond.holiday === true, weather: cond.weather === true, outOfZone: cond.outOfZone === true, surge: cond.surge == null ? undefined : (num(cond.surge, "surge", { min: 1, max: 20 }) ?? undefined) },
        hours: num(t.hours, "hours", { min: 0, max: 1000 }) ?? undefined,
      };
      const cust = await this.specOf(c, { cardId: b.customerCardId, spec: b.customerSpec }, day);
      const drv = await this.specOf(c, { cardId: b.driverCardId, spec: b.driverSpec }, day);
      const customer = cust ? priceTrip(cust.spec, { ...base, tipCents: 0, tollCents: 0 }) : null;
      const driver = drv ? priceTrip(drv.spec, { ...base, tipCents, tollCents, customerPriceCents: customer?.subtotalCents ?? cents(t.customerPriceCents, "customerPriceCents") ?? undefined }) : null;
      const vehicleId = b.vehicleId ? uuid(b.vehicleId, "vehicleId") : null;
      const perKm = cents(b.carCostPerKmCents, "carCostPerKmCents") ?? (await costPerKmCents(c, vehicleId));
      const carCost = Math.round(base.distanceKm * perKm);
      const price = customer?.subtotalCents ?? cents(t.customerPriceCents, "customerPriceCents") ?? 0;
      const driverPay = driver ? driver.lines.filter((l) => l.kind === "earning" || l.kind === "addon").reduce((a, l) => a + l.cents, 0) : 0;
      return {
        customer: customer && { card: cust!.name, lines: customer.lines, subtotalCents: customer.subtotalCents, totalCents: customer.totalCents, notes: customer.notes },
        driver: driver && { card: drv!.name, lines: driver.lines.filter((l) => l.kind !== "tax"), payCents: driverPay, totalCents: driver.lines.filter((l) => l.kind !== "tax").reduce((a, l) => a + l.cents, 0), notes: driver.notes },
        carCost: { perKmCents: perKm, totalCents: carCost },
        marginCents: price - driverPay - carCost, priceCents: price,
        marginPct: price > 0 ? Math.round(((price - driverPay - carCost) / price) * 1000) / 10 : null,
      };
    });
  }

  /** Two cards side by side on the same recent trips. */
  @Post("compare")
  @HttpCode(200)
  async compare(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.view(req);
    const b = asBody(raw);
    return withOrg(this.pool, orgId, async (c) => {
      const tz = await this.tz(c); const today = todayIn(tz);
      const kind = oneOf(b.kind, "kind", ["customer", "driver"] as const, { required: true })!;
      const to = dateOnly(b.to, "to") ?? today;
      const from = dateOnly(b.from, "from") ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
      const a = await this.specOf(c, { cardId: b.aCardId, spec: b.aSpec }, to); const z = await this.specOf(c, { cardId: b.bCardId, spec: b.bSpec }, to);
      if (!a || !z) throw new BadRequestException("pick two cards (aCardId and bCardId) or type two specs");
      const ra = await replayTrips(c, a.spec, kind, from, to, tz), rb = await replayTrips(c, z.spec, kind, from, to, tz);
      return { from, to, kind, a: { name: a.name, ...ra }, b: { name: z.name, ...rb }, differenceTotalCents: rb.newTotalCents - ra.newTotalCents, differenceAverageCents: rb.averageNewCents - ra.averageNewCents };
    });
  }

  /** Replay a period's trips with a new card and show the effect on cost and margin. Saves nothing. */
  @Post("what-if")
  @HttpCode(200)
  async whatIf(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.view(req);
    const b = asBody(raw);
    return withOrg(this.pool, orgId, async (c) => {
      const tz = await this.tz(c); const today = todayIn(tz);
      const to = dateOnly(b.to, "to") ?? today;
      const from = dateOnly(b.from, "from") ?? new Date(Date.parse(`${to}T00:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
      const n = await this.specOf(c, { cardId: b.cardId, spec: b.spec }, to);
      if (!n) throw new BadRequestException("give a cardId or a spec");
      const r = await replayTrips(c, n.spec, "driver", from, to, tz, { driverId: b.driverId ? uuid(b.driverId, "driverId") : null });
      const marginNow = r.revenueCents - r.currentTotalCents - r.vehicleCostCents, marginNew = r.revenueCents - r.newTotalCents - r.vehicleCostCents;
      return { from, to, card: n.name, ...r, marginNowCents: marginNow, marginNewCents: marginNew, costChangeCents: r.newTotalCents - r.currentTotalCents, marginChangeCents: marginNew - marginNow };
    });
  }

  // ---- bonus rules -----------------------------------------------------------------------------------------------------------
  @Get("bonuses")
  async bonuses(@Req() req: AuthedRequest, @Query("archived") archived?: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => (await c.query(
      `SELECT id, name, kind, amount_cents::float8 AS "amountCents", params, period, active, archived_at AS "archivedAt", created_at AS "createdAt",
              (SELECT count(*) FROM portal_pay_lines l WHERE l.ref_id = portal_bonus_rules.id AND l.source = 'bonus' AND l.archived_at IS NULL)::int AS "timesPaid"
       FROM portal_bonus_rules WHERE ($1::boolean OR archived_at IS NULL) ORDER BY lower(name)`, [archived === "1"])).rows);
  }

  private bonusBody(b: Record<string, unknown>, creating: boolean) {
    onlyKeys(b, ["name", "kind", "amountCents", "params", "period", "active"]);
    const p = asBody(b.params ?? {});
    onlyKeys(p, ["minTrips", "minPct", "minRating", "zone", "days", "tiers", "perTripCents"]);
    if (p.tiers !== undefined && (!Array.isArray(p.tiers) || p.tiers.length > 20 || p.tiers.some((t) => !t || !Number.isInteger(t.trips) || t.trips < 1 || !Number.isSafeInteger(t.cents) || t.cents < 0))) throw new BadRequestException("tiers must be a list of { trips, cents }");
    if (p.perTripCents !== undefined) cents(p.perTripCents, "perTripCents");
    return {
      name: b.name !== undefined || creating ? str(b.name, "name", { required: true, max: 120 }) : undefined,
      kind: b.kind !== undefined || creating ? oneOf(b.kind, "kind", BONUS_KINDS, { required: true }) : undefined,
      amountCents: b.amountCents !== undefined ? cents(b.amountCents, "amountCents", { required: true }) : creating ? 0 : undefined,
      params: b.params !== undefined ? p : creating ? {} : undefined,
      period: b.period !== undefined || creating ? (oneOf(b.period ?? "week", "period", ["week", "month"] as const, { required: true })) : undefined,
      active: b.active !== undefined ? b.active === true : undefined,
    };
  }

  @Post("bonuses")
  async createBonus(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const v = this.bonusBody(asBody(raw), true);
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`INSERT INTO portal_bonus_rules (org_id, name, kind, amount_cents, params, period, active, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [orgId, v.name, v.kind, v.amountCents, JSON.stringify(v.params), v.period, v.active ?? true, req.session!.userId])).rows[0];
      await auditChange(c, req, { action: "bonus_rules.create", entity: "bonus_rules", entityId: r.id, label: v.name, old: null, next: v as never, sensitive: true });
      return { id: r.id };
    });
  }

  @Patch("bonuses/:id")
  async editBonus(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const v = this.bonusBody(asBody(raw), false);
    return withOrg(this.pool, orgId, async (c) => {
      const old = (await c.query(`SELECT name, kind, amount_cents::float8 AS "amountCents", params, period, active FROM portal_bonus_rules WHERE id = $1`, [uuid(id)])).rows[0];
      if (!old) throw new NotFoundException();
      const next = { ...old, ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) };
      await c.query(`UPDATE portal_bonus_rules SET name=$2, kind=$3, amount_cents=$4, params=$5, period=$6, active=$7, updated_at=now() WHERE id=$1`, [id, next.name, next.kind, next.amountCents, JSON.stringify(next.params), next.period, next.active]);
      await auditChange(c, req, { action: "bonus_rules.update", entity: "bonus_rules", entityId: id, label: next.name, old, next, sensitive: true });
      return { ok: true };
    });
  }

  @Post("bonuses/:id/archive")
  @HttpCode(200)
  async archiveBonus(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.manage(req);
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`UPDATE portal_bonus_rules SET archived_at = now(), active = false WHERE id = $1 AND archived_at IS NULL RETURNING name`, [uuid(id)])).rows[0];
      if (!r) throw new NotFoundException();
      await auditChange(c, req, { action: "bonus_rules.archive", entity: "bonus_rules", entityId: id, label: r.name, old: { archived: false }, next: { archived: true }, sensitive: true });
      return { ok: true };
    });
  }

  /** What each active bonus would pay one driver for a period, and how close they are. */
  @Get("bonuses/preview")
  async bonusPreview(@Req() req: AuthedRequest, @Query() q: Record<string, string | undefined>) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const tz = await this.tz(c); const today = todayIn(tz);
      const driverId = uuid(q.driverId, "driverId");
      const to = dateOnly(q.to, "to") ?? today;
      const from = dateOnly(q.from, "from") ?? new Date(Date.parse(`${to}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
      const stats = await periodStats(c, driverId, from, to, tz);
      const rows = (await activeBonusRules(c)).map((r) => ({ id: r.id, name: r.name, kind: r.kind, ...evaluateBonus(r, stats) }));
      return { from, to, stats, rules: rows, totalCents: rows.reduce((a, r) => a + r.earnedCents, 0) };
    });
  }

  // ---- one-off bonus and manual adjustment (a second person approves) ------------------------------------------------------------------
  @Get("adjustments")
  async adjustments(@Req() req: AuthedRequest, @Query("status") status?: string, @Query("driverId") driverId?: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => (await c.query(
      `SELECT l.id, l.driver_id AS "driverId", coalesce(u.display_name, u.email) AS driver, l.kind, l.label, l.amount_cents::float8 AS "amountCents", l.reason, l.line_date::text AS date, l.approval, l.source, l.payout_id AS "payoutId", l.created_at AS "createdAt",
              coalesce(cu.display_name, cu.email) AS "createdBy"
       FROM portal_pay_lines l JOIN users u ON u.id = l.driver_id LEFT JOIN users cu ON cu.id = l.created_by
       WHERE l.source IN ('manual','dispute') AND l.archived_at IS NULL AND ($1::text IS NULL OR l.approval = $1) AND ($2::uuid IS NULL OR l.driver_id = $2) ORDER BY l.created_at DESC LIMIT 500`, [status ?? null, driverId ? uuid(driverId, "driverId") : null])).rows);
  }

  /** A bonus typed by hand, or a plus-or-minus fix, always with a reason. It counts only after a second person approves it. */
  @Post("adjustments")
  async createAdjustment(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    onlyKeys(b, ["driverId", "kind", "amountCents", "reason", "date", "label"]);
    const kind = oneOf(b.kind ?? "adjustment", "kind", ["bonus", "adjustment"] as const, { required: true })!;
    const amount = cents(b.amountCents, "amountCents", { required: true, min: kind === "bonus" ? 0 : -100_000_000 })!;
    if (amount === 0) throw new BadRequestException("amountCents cannot be zero");
    const reason = str(b.reason, "reason", { required: true, max: 500 })!;
    return withOrg(this.pool, orgId, async (c) => {
      const tz = await this.tz(c);
      const driverId = uuid(b.driverId, "driverId");
      if (!(await c.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'driver'`, [driverId])).rowCount) throw new BadRequestException("driver not found");
      const st = await paySettings(c);
      const date = dateOnly(b.date, "date") ?? todayIn(tz);
      const label = str(b.label, "label", { max: 200 }) ?? (kind === "bonus" ? "One-time bonus" : amount >= 0 ? "Pay adjustment (plus)" : "Pay adjustment (minus)");
      const approval = st.secondApprover ? "pending" : "approved";
      const r = (await c.query(`INSERT INTO portal_pay_lines (org_id, driver_id, kind, key, label, amount_cents, line_date, source, reason, approval, created_by) VALUES ($1,$2,$3,'manual',$4,$5,$6,'manual',$7,$8,$9) RETURNING id`,
        [orgId, driverId, kind, label, amount, date, reason, approval, req.session!.userId])).rows[0];
      await auditChange(c, req, { action: "pay_adjustments.create", entity: "pay_adjustments", entityId: r.id, label: `${label} ${(amount / 100).toFixed(2)}`, old: null, next: { driverId, kind, amountCents: amount, reason, approval }, sensitive: true });
      return { id: r.id, approval };
    });
  }

  @Post("adjustments/:id/:decision")
  @HttpCode(200)
  async decideAdjustment(@Req() req: AuthedRequest, @Param("id") id: string, @Param("decision") decision: string) {
    const orgId = this.manage(req);
    if (decision !== "approve" && decision !== "reject") throw new NotFoundException();
    return withOrg(this.pool, orgId, async (c) => {
      const l = (await c.query(`SELECT * FROM portal_pay_lines WHERE id = $1 AND source IN ('manual','dispute') FOR UPDATE`, [uuid(id)])).rows[0];
      if (!l) throw new NotFoundException();
      if (l.approval !== "pending") throw new ConflictException(`Already ${l.approval}`);
      assertSecondPerson(await paySettings(c), l.created_by, req.session!.userId, "this adjustment");
      const next = decision === "approve" ? "approved" : "rejected";
      await c.query(`UPDATE portal_pay_lines SET approval = $2 WHERE id = $1`, [id, next]);
      await auditChange(c, req, { action: `pay_adjustments.${decision}`, entity: "pay_adjustments", entityId: id, label: l.label, old: { approval: "pending" }, next: { approval: next, amountCents: Number(l.amount_cents) }, sensitive: true });
      return { approval: next };
    });
  }

  // ---- deductions ------------------------------------------------------------------------------------------------------------
  @Get("deductions")
  async deductions(@Req() req: AuthedRequest, @Query("driverId") driverId?: string, @Query("status") status?: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => (await c.query(
      `SELECT d.id, d.driver_id AS "driverId", coalesce(u.display_name, u.email) AS driver, d.kind, d.label, d.reason, d.total_cents::float8 AS "totalCents", d.per_payout_cents::float8 AS "perPayoutCents", d.taken_cents::float8 AS "takenCents",
              (d.total_cents - d.taken_cents)::float8 AS "remainingCents", d.recurring, d.status, d.attachment_id AS "attachmentId", d.created_at AS "createdAt", d.approved_at AS "approvedAt", coalesce(cu.display_name, cu.email) AS "createdBy", d.created_by AS "createdById"
       FROM portal_deductions d JOIN users u ON u.id = d.driver_id LEFT JOIN users cu ON cu.id = d.created_by
       WHERE d.archived_at IS NULL AND ($1::uuid IS NULL OR d.driver_id = $1) AND ($2::text IS NULL OR d.status = $2) ORDER BY d.created_at DESC LIMIT 500`, [driverId ? uuid(driverId, "driverId") : null, status ?? null])).rows);
  }

  @Post("deductions")
  async createDeduction(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    onlyKeys(b, ["driverId", "kind", "label", "reason", "totalCents", "perPayoutCents", "recurring", "attachmentId"]);
    const kind = oneOf(b.kind, "kind", DEDUCTION_KINDS, { required: true })!;
    const total = cents(b.totalCents, "totalCents", { required: true, min: 1 })!;
    const per = cents(b.perPayoutCents, "perPayoutCents", { min: 1 }) ?? total;
    if (per > total && b.recurring !== true) throw new BadRequestException("perPayoutCents cannot be more than the total");
    const label = str(b.label, "label", { required: true, max: 200 })!; const reason = str(b.reason, "reason", { required: true, max: 500 })!;
    return withOrg(this.pool, orgId, async (c) => {
      const driverId = uuid(b.driverId, "driverId");
      if (!(await c.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'driver'`, [driverId])).rowCount) throw new BadRequestException("driver not found");
      if (b.attachmentId != null && !(await c.query(`SELECT 1 FROM attachments WHERE id = $1`, [uuid(b.attachmentId, "attachmentId")])).rowCount) throw new BadRequestException("attachment not found");
      const st = await paySettings(c);
      const status = st.secondApprover ? "pending_approval" : "active";
      const r = (await c.query(`INSERT INTO portal_deductions (org_id, driver_id, kind, label, reason, total_cents, per_payout_cents, recurring, status, attachment_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING id`,
        [orgId, driverId, kind, label, reason, total, per, b.recurring === true, status, b.attachmentId ?? null, req.session!.userId])).rows[0];
      await auditChange(c, req, { action: "deductions.create", entity: "deductions", entityId: r.id, label, old: null, next: { driverId, kind, totalCents: total, perPayoutCents: per, reason, status }, sensitive: true });
      return { id: r.id, status };
    });
  }

  @Post("deductions/:id/:decision")
  @HttpCode(200)
  async decideDeduction(@Req() req: AuthedRequest, @Param("id") id: string, @Param("decision") decision: string) {
    const orgId = this.manage(req);
    if (!["approve", "cancel"].includes(decision)) throw new NotFoundException();
    return withOrg(this.pool, orgId, async (c) => {
      const d = (await c.query(`SELECT * FROM portal_deductions WHERE id = $1 AND archived_at IS NULL FOR UPDATE`, [uuid(id)])).rows[0];
      if (!d) throw new NotFoundException();
      if (decision === "approve") {
        if (d.status !== "pending_approval") throw new ConflictException(`This deduction is ${d.status}`);
        assertSecondPerson(await paySettings(c), d.created_by, req.session!.userId, "this deduction");
        await c.query(`UPDATE portal_deductions SET status = 'active', approved_by = $2, approved_at = now(), updated_at = now() WHERE id = $1`, [id, req.session!.userId]);
        await addNotification(c, orgId, d.driver_id, "system", `A deduction was added to your pay: ${d.label}. Reason: ${d.reason}`, "/driver/pay");
      } else {
        if (!["pending_approval", "active"].includes(d.status)) throw new ConflictException(`This deduction is ${d.status}`);
        await c.query(`UPDATE portal_deductions SET status = 'cancelled', updated_at = now() WHERE id = $1`, [id]);
      }
      await auditChange(c, req, { action: `deductions.${decision}`, entity: "deductions", entityId: id, label: d.label, old: { status: d.status }, next: { status: decision === "approve" ? "active" : "cancelled" }, sensitive: true });
      return { ok: true };
    });
  }

  // ---- which pay lines belong to a driver (used by the driver Pay tab) ------------------------------------------------------------------
  @Get("drivers/:id")
  async driverPay(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const tz = await this.tz(c); const today = todayIn(tz);
      const driverId = uuid(id);
      if (!(await c.query(`SELECT 1 FROM users WHERE id = $1 AND role = 'driver'`, [driverId])).rowCount) throw new NotFoundException();
      const weekFrom = new Date(Date.parse(`${today}T00:00:00Z`) - 6 * 86_400_000).toISOString().slice(0, 10);
      const stats = await periodStats(c, driverId, weekFrom, today, tz);
      const bonus = (await activeBonusRules(c)).map((r) => ({ id: r.id, name: r.name, ...evaluateBonus(r, stats) }));
      const open = (await c.query(`SELECT coalesce(sum(amount_cents),0)::float8 AS cents, count(DISTINCT trip_id)::int AS trips FROM portal_pay_lines WHERE driver_id = $1 AND payout_id IS NULL AND archived_at IS NULL AND approval = 'approved'`, [driverId])).rows[0];
      const res = await resolveForTrip(c, "driver", { driverId, day: today });
      return {
        rateCard: res.version ? { cardId: res.version.cardId, name: res.version.cardName, version: res.version.version, summary: specSummary(res.version.spec), via: res.assignment?.kind } : null,
        unpaidCents: open.cents, unpaidTrips: open.trips, bonusProgress: bonus, window: { from: weekFrom, to: today },
        payouts: (await c.query(`SELECT id, run_id AS "runId", from_date::text AS "from", to_date::text AS "to", status, earnings_cents::float8 AS "earningsCents", bonus_cents::float8 AS "bonusCents", tips_cents::float8 AS "tipsCents", deduction_cents::float8 AS "deductionCents", net_cents::float8 AS "netCents", hold_reason AS "holdReason", paid_at AS "paidAt" FROM portal_payouts WHERE driver_id = $1 ORDER BY to_date DESC LIMIT 50`, [driverId])).rows,
        deductions: (await c.query(`SELECT id, kind, label, reason, total_cents::float8 AS "totalCents", per_payout_cents::float8 AS "perPayoutCents", taken_cents::float8 AS "takenCents", recurring, status FROM portal_deductions WHERE driver_id = $1 AND archived_at IS NULL ORDER BY created_at DESC LIMIT 100`, [driverId])).rows,
      };
    });
  }
}
