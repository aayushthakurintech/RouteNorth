import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { AnalyticsService } from "../analytics/analytics.service.js";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { auditChange } from "../audit/domain-audit.js";
import { addNotification } from "../business/notifications.js";
import { DEFAULT_BY_KEY, DEFAULT_RULES, ensureDefaultRules, type RuleField } from "../alerts/defaults.js";
import { areasFor, sendPersonalDigests } from "../alerts/digest.js";
import { CHANNELS, DEFAULT_CHANNELS, channelsFor, type Channel, type Prefs } from "../alerts/delivery.js";
import { EVALUATORS, evaluateOrg, type RuleKind } from "../alerts/engine.js";
import { MEASURES, MEASURE_BY_KEY, UNIT_LABEL } from "../alerts/measures.js";
import type { Providers } from "../notify/notifier.js";
import { NOTIFY, PG_POOL } from "../tokens.js";
import { AUTOMATIONS, AUTOMATION_BY_KEY, loadAutomationState, runAutomations, saveAutomationState } from "./automations.js";
import { body as asBody, companyFormat, int, oneOf, onlyKeys, regionScope, str, uuid } from "./common.js";
import { todayIn } from "./vehicles.service.js";

const SEVERITIES = ["info", "warn", "critical"] as const;
const AREAS = ["vehicle", "driver", "pay", "money", "custom", "live"] as const;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The alert inbox, the rules behind it, each person's own delivery choices, and the automations. Everything the Owner Portal spec lists under
 * "Alerts and automations" is reached from here; the engine that checks the rules lives in alerts/engine.ts.
 */
@Controller("portal/alerts")
@UseGuards(AuthGuard)
export class PortalAlertsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(AnalyticsService) private readonly svc: AnalyticsService, @Inject(NOTIFY) private readonly notify: Providers) {}
  private view(req: AuthedRequest) { return requirePerm(req, "alerts.view"); }
  private manage(req: AuthedRequest) { return requirePerm(req, "alerts.manage"); }
  private areas(req: AuthedRequest) { return areasFor(req.perms as ReadonlySet<string>); }

  // ---- the inbox ----------------------------------------------------------------------------------------------------------------
  /** Which alerts this person may see: only the areas they have access to, and for a regional manager only their own region's cars and drivers. */
  private async visible(c: pg.PoolClient, req: AuthedRequest, params: unknown[]): Promise<string> {
    params.push(this.areas(req));
    const parts = [`(a.area IS NULL OR a.area = ANY($${params.length}::text[]))`];
    const teams = await regionScope(c, req);
    if (teams) {
      params.push(teams);
      parts.push(`((a.subject_kind = 'vehicle' AND a.subject_id IN (SELECT id::text FROM vehicles WHERE team_id = ANY($${params.length}::uuid[]))) OR (a.subject_kind = 'driver' AND a.subject_id IN (SELECT user_id::text FROM driver_profiles WHERE team_id = ANY($${params.length}::uuid[]))))`);
    }
    return parts.join(" AND ");
  }

  @Get()
  async list(@Req() req: AuthedRequest, @Query() q: Record<string, string | undefined>) {
    const orgId = this.view(req);
    const me = req.session!.userId;
    const mode = oneOf(q.view ?? "active", "view", ["active", "mine", "snoozed", "done", "all"] as const, { required: true })!;
    const area = q.area ? oneOf(q.area, "area", AREAS) : null, sev = q.severity ? oneOf(q.severity, "severity", SEVERITIES) : null;
    const limit = Math.min(200, Math.max(1, Number(q.limit) || 100));
    return withOrg(this.pool, orgId, async (c) => {
      const params: unknown[] = [me];
      const vis = await this.visible(c, req, params);
      const base = `FROM alerts a LEFT JOIN alert_rules r ON r.id = a.rule_id LEFT JOIN users asg ON asg.id = a.assigned_to LEFT JOIN users rb ON rb.id = a.resolved_by WHERE $1::uuid IS NOT NULL AND ${vis}`;
      const counts = (await c.query(
        `SELECT count(*) FILTER (WHERE a.status <> 'resolved' AND (a.snoozed_until IS NULL OR a.snoozed_until <= now()))::int AS active,
                count(*) FILTER (WHERE a.status <> 'resolved' AND (a.snoozed_until IS NULL OR a.snoozed_until <= now()) AND a.severity = 'critical')::int AS critical,
                count(*) FILTER (WHERE a.status <> 'resolved' AND a.assigned_to = $1)::int AS mine,
                count(*) FILTER (WHERE a.status <> 'resolved' AND a.snoozed_until > now())::int AS snoozed,
                count(*) FILTER (WHERE a.status = 'resolved' AND a.resolved_at > now() - interval '30 days')::int AS done ${base}`, params)).rows[0];
      const where: string[] = [];
      const p2 = [...params];
      if (mode === "active") where.push(`a.status <> 'resolved' AND (a.snoozed_until IS NULL OR a.snoozed_until <= now())`);
      if (mode === "mine") where.push(`a.status <> 'resolved' AND a.assigned_to = $1`);
      if (mode === "snoozed") where.push(`a.status <> 'resolved' AND a.snoozed_until > now()`);
      if (mode === "done") where.push(`a.status = 'resolved'`);
      if (area) { p2.push(area); where.push(`a.area = $${p2.length}`); }
      if (sev) { p2.push(sev); where.push(`a.severity = $${p2.length}`); }
      if (q.q) { p2.push(`%${String(q.q).slice(0, 80)}%`); where.push(`a.title ILIKE $${p2.length}`); }
      const rows = (await c.query(
        `SELECT a.id, a.title, a.severity, a.status, a.area, a.kind, a.detail, a.count, a.first_at AS "firstAt", a.last_at AS "lastAt", a.snoozed_until AS "snoozedUntil", a.assigned_to AS "assignedToId",
                coalesce(asg.display_name, asg.email) AS "assignedTo", a.resolved_at AS "resolvedAt", a.resolved_how AS "resolvedHow", coalesce(rb.display_name, rb.email) AS "resolvedBy", r.name AS rule, a.subject_kind AS "subjectKind", a.subject_id AS "subjectId"
         ${base} ${where.length ? `AND ${where.join(" AND ")}` : ""}
         ORDER BY ${mode === "done" ? "a.resolved_at DESC NULLS LAST" : "CASE a.severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, a.last_at DESC"} LIMIT ${limit}`, p2)).rows;
      return { counts, alerts: rows };
    });
  }

  /** For the bell in the top bar. */
  @Get("summary")
  async summary(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const params: unknown[] = [req.session!.userId];
      const vis = await this.visible(c, req, params);
      return (await c.query(
        `SELECT count(*) FILTER (WHERE a.status = 'open' AND (a.snoozed_until IS NULL OR a.snoozed_until <= now()))::int AS open,
                count(*) FILTER (WHERE a.status <> 'resolved' AND a.severity = 'critical' AND (a.snoozed_until IS NULL OR a.snoozed_until <= now()))::int AS critical,
                count(*) FILTER (WHERE a.status <> 'resolved' AND a.assigned_to = $1)::int AS mine
         FROM alerts a WHERE ${vis}`, params)).rows[0];
    });
  }

  @Get("measures")
  measures(@Req() req: AuthedRequest) { this.manage(req); return MEASURES.map((m) => ({ ...m, unitLabel: UNIT_LABEL[m.unit] })); }

  // ---- my own choices -----------------------------------------------------------------------------------------------------------
  @Get("prefs")
  async prefs(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const p = await this.loadPrefs(c, req.session!.userId);
      const ends = (await c.query(`SELECT kind, count(*)::int AS n FROM notification_endpoints WHERE enabled AND kind IN ('slack','teams') GROUP BY 1`)).rows;
      const n = (k: string) => ends.find((e) => e.kind === k)?.n ?? 0;
      return {
        channels: { info: channelsFor(p, "info"), warn: channelsFor(p, "warn"), critical: channelsFor(p, "critical") }, mutedAreas: p.mutedAreas, quietStart: p.quietStart?.slice(0, 5) ?? null, quietEnd: p.quietEnd?.slice(0, 5) ?? null, digest: p.digest, phone: p.phone,
        areas: this.areas(req), defaults: DEFAULT_CHANNELS,
        // What is actually set up, so the screen can say "needs an account" instead of letting a person choose something that cannot work.
        available: { inapp: true, email: !!this.notify.email, sms: !!this.notify.sms, push: false, slack: n("slack") > 0, teams: n("teams") > 0 },
        notes: { email: this.notify.email ? null : "Email is not set up on this server yet (RESEND_API_KEY and EMAIL_FROM).", sms: this.notify.sms ? null : "SMS is not set up on this server yet (a Twilio account).", push: "Push messages need the mobile app and a push service, which are not built yet.",
          slack: n("slack") ? null : "Add a Slack channel under Settings, Alerts, Where alerts go.", teams: n("teams") ? null : "Add a Teams channel under Settings, Alerts, Where alerts go." },
      };
    });
  }

  private async loadPrefs(c: pg.PoolClient, userId: string): Promise<Prefs> {
    const r = (await c.query(`SELECT channels, muted_areas AS "mutedAreas", quiet_start::text AS "quietStart", quiet_end::text AS "quietEnd", digest, phone FROM portal_alert_prefs WHERE user_id = $1`, [userId])).rows[0];
    return { channels: r?.channels ?? {}, mutedAreas: r?.mutedAreas ?? [], quietStart: r?.quietStart ?? null, quietEnd: r?.quietEnd ?? null, digest: r?.digest ?? true, phone: r?.phone ?? null };
  }

  @Put("prefs")
  async setPrefs(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.view(req);
    const b = asBody(raw);
    onlyKeys(b, ["channels", "mutedAreas", "quietStart", "quietEnd", "digest", "phone"]);
    return withOrg(this.pool, orgId, async (c) => {
      const cur = await this.loadPrefs(c, req.session!.userId);
      const next: Prefs = { ...cur };
      if (b.channels !== undefined) {
        const ch = asBody(b.channels); const out: Prefs["channels"] = { ...cur.channels };
        for (const sev of SEVERITIES) if (ch[sev] !== undefined) {
          if (!Array.isArray(ch[sev]) || !(ch[sev] as unknown[]).every((x) => (CHANNELS as readonly string[]).includes(String(x)))) throw new BadRequestException(`${sev}: choose from ${CHANNELS.join(", ")}`);
          out[sev] = [...new Set(ch[sev] as Channel[])];
        }
        next.channels = out;
      }
      if (b.mutedAreas !== undefined) {
        if (!Array.isArray(b.mutedAreas) || !(b.mutedAreas as unknown[]).every((x) => (AREAS as readonly string[]).includes(String(x)))) throw new BadRequestException("mutedAreas must be a list of areas");
        next.mutedAreas = [...new Set(b.mutedAreas as string[])];
      }
      for (const k of ["quietStart", "quietEnd"] as const) if (b[k] !== undefined) {
        if (b[k] !== null && b[k] !== "" && !HHMM.test(String(b[k]))) throw new BadRequestException(`${k} must look like 22:00`);
        next[k] = b[k] ? String(b[k]) : null;
      }
      if ((next.quietStart == null) !== (next.quietEnd == null)) throw new BadRequestException("Set both the start and the end of quiet hours, or neither");
      if (b.digest !== undefined) next.digest = b.digest === true;
      if (b.phone !== undefined) {
        const ph = b.phone === null || b.phone === "" ? null : String(b.phone).replace(/[\s()-]/g, "");
        if (ph && !/^\+[1-9]\d{7,14}$/.test(ph)) throw new BadRequestException("Enter a mobile number like +14165550123");
        next.phone = ph;
      }
      await c.query(
        `INSERT INTO portal_alert_prefs (org_id, user_id, channels, muted_areas, quiet_start, quiet_end, digest, phone) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (org_id, user_id) DO UPDATE SET channels = $3, muted_areas = $4, quiet_start = $5, quiet_end = $6, digest = $7, phone = $8, updated_at = now()`,
        [orgId, req.session!.userId, JSON.stringify(next.channels), next.mutedAreas, next.quietStart, next.quietEnd, next.digest, next.phone]);
      await auditChange(c, req, { action: "alerts.prefs", entity: "alert_prefs", entityId: req.session!.userId, label: "My alert settings", old: { ...cur, phone: cur.phone ? "set" : null }, next: { ...next, phone: next.phone ? "set" : null } });
      return this.prefs(req);
    });
  }

  /** Send the morning summary to me now, so I can see what it looks like. */
  @Post("digest/me")
  @HttpCode(200)
  async digestMe(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    const r = await sendPersonalDigests(this.pool, this.notify, orgId, new Date(), req.session!.userId);
    return { ...r, message: r.sent ? "Sent to your email." : r.people && !r.notes.length ? "Nothing needs you right now, so nothing was sent." : r.notes[0] ?? "Nothing was sent." };
  }

  // ---- rules ----------------------------------------------------------------------------------------------------------------------
  @Get("rules")
  async rules(@Req() req: AuthedRequest) {
    const orgId = this.manage(req);
    await ensureDefaultRules(this.pool, orgId);
    return withOrg(this.pool, orgId, async (c) => {
      const rows = (await c.query(
        `SELECT r.id, r.name, r.kind, r.params, r.severity, r.active, r.area, r.system_key AS "systemKey", r.description, r.endpoint_ids AS "endpointIds", r.recipient_ids AS "recipientIds", r.quiet_start::text AS "quietStart", r.quiet_end::text AS "quietEnd",
                r.group_minutes AS "groupMinutes", r.repeat_minutes AS "repeatMinutes", r.scope_kind AS "scopeKind", r.scope_id AS "scopeId", r.created_at AS "createdAt",
                (SELECT count(*)::int FROM alerts a WHERE a.rule_id = r.id AND a.status <> 'resolved') AS "openCount", (SELECT max(a.first_at) FROM alerts a WHERE a.rule_id = r.id) AS "lastRaisedAt"
         FROM alert_rules r WHERE r.archived_at IS NULL AND r.area IS NOT NULL ORDER BY r.system_key IS NULL, array_position(ARRAY['vehicle','driver','pay','money','custom'], r.area), r.created_at`)).rows;
      const names = new Map((await c.query(`SELECT id, coalesce(display_name, email) AS name FROM users`)).rows.map((u) => [u.id as string, u.name as string]));
      const order = new Map(DEFAULT_RULES.map((d, i) => [d.key, i]));
      return rows.sort((a, b) => (a.systemKey ? 0 : 1) - (b.systemKey ? 0 : 1) || (order.get(a.systemKey) ?? 0) - (order.get(b.systemKey) ?? 0)).map((r) => {
        const d = r.systemKey ? DEFAULT_BY_KEY.get(r.systemKey) : null;
        return { ...r, isDefault: !!d, fields: d?.fields ?? [], defaults: d?.params ?? null, spec: d?.spec ?? null, note: d?.note ?? null, recipients: (r.recipientIds as string[]).map((id) => names.get(id) ?? "Someone who left") };
      });
    });
  }

  /** Check and clean what the person sent for a rule's numbers. */
  private cleanParams(fields: RuleField[], raw: unknown, base: Record<string, unknown>): Record<string, unknown> {
    const p = asBody(raw); const out = { ...base };
    for (const f of fields) {
      if (p[f.key] === undefined) continue;
      if ((p[f.key] === null || p[f.key] === "") && f.optional) { out[f.key] = null; continue; }
      const n = Number(p[f.key]);
      if (!Number.isFinite(n) || n < f.min || n > f.max) throw new BadRequestException(`${f.label} must be a number from ${f.min} to ${f.max}`);
      out[f.key] = n;
    }
    for (const k of Object.keys(p)) if (!fields.some((f) => f.key === k)) throw new BadRequestException(`"${k}" is not a setting of this rule`);
    return out;
  }

  private async cleanPeople(c: pg.PoolClient, v: unknown): Promise<string[]> {
    if (!Array.isArray(v) || v.length > 20) throw new BadRequestException("recipientIds must be a list of up to 20 people");
    const ids = [...new Set(v.map((x) => uuid(x, "person")))];
    if (!ids.length) return [];
    const ok = (await c.query(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND disabled_at IS NULL AND role <> 'driver'`, [ids])).rows.map((r) => r.id as string);
    if (ok.length !== ids.length) throw new BadRequestException("Choose people who work in the office");
    return ids;
  }

  @Put("rules/:id")
  async updateRule(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    onlyKeys(b, ["name", "active", "severity", "params", "recipientIds", "endpointIds", "quietStart", "quietEnd", "repeatMinutes", "groupMinutes", "description"]);
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`SELECT * FROM alert_rules WHERE id = $1 AND archived_at IS NULL AND area IS NOT NULL FOR UPDATE`, [uuid(id)])).rows[0];
      if (!r) throw new NotFoundException();
      const d = r.system_key ? DEFAULT_BY_KEY.get(r.system_key) : null;
      if (d && (b.name !== undefined || b.description !== undefined)) throw new BadRequestException("The name of a default rule cannot change");
      const next: Record<string, unknown> = {};
      if (b.name !== undefined) next.name = str(b.name, "name", { required: true, max: 120 });
      if (b.description !== undefined) next.description = str(b.description, "description", { max: 500 });
      if (b.active !== undefined) next.active = b.active === true;
      if (b.severity !== undefined) next.severity = oneOf(b.severity, "severity", SEVERITIES, { required: true });
      if (b.params !== undefined) {
        next.params = d ? this.cleanParams(d.fields, b.params, r.params) : (() => { const p = asBody(b.params); const m = this.customParams({ ...r.params, ...p }); return m; })();
      }
      if (b.recipientIds !== undefined) next.recipient_ids = await this.cleanPeople(c, b.recipientIds);
      if (b.endpointIds !== undefined) {
        if (!Array.isArray(b.endpointIds) || b.endpointIds.length > 10) throw new BadRequestException("endpointIds must be a list");
        const ids = [...new Set(b.endpointIds.map((x) => uuid(x, "destination")))];
        if (ids.length && (await c.query(`SELECT count(*)::int AS n FROM notification_endpoints WHERE id = ANY($1::uuid[])`, [ids])).rows[0].n !== ids.length) throw new BadRequestException("Unknown destination");
        next.endpoint_ids = ids;
      }
      for (const [k, col] of [["quietStart", "quiet_start"], ["quietEnd", "quiet_end"]] as const) if (b[k] !== undefined) {
        if (b[k] !== null && b[k] !== "" && !HHMM.test(String(b[k]))) throw new BadRequestException(`${k} must look like 22:00`);
        next[col] = b[k] ? String(b[k]) : null;
      }
      if ((("quiet_start" in next ? next.quiet_start : r.quiet_start) == null) !== (("quiet_end" in next ? next.quiet_end : r.quiet_end) == null)) throw new BadRequestException("Set both the start and the end of quiet hours, or neither");
      if (b.repeatMinutes !== undefined) next.repeat_minutes = int(b.repeatMinutes, "repeatMinutes", { min: 5, max: 1440, required: true });
      if (b.groupMinutes !== undefined) next.group_minutes = int(b.groupMinutes, "groupMinutes", { min: 0, max: 1440, required: true });
      const keys = Object.keys(next);
      if (!keys.length) return { id: r.id };
      const jsonCols = new Set(["params"]);
      await c.query(`UPDATE alert_rules SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")}, updated_by = $${keys.length + 2}, updated_at = now() WHERE id = $1`,
        [r.id, ...keys.map((k) => (jsonCols.has(k) ? JSON.stringify(next[k]) : next[k])), req.session!.userId]);
      const show = (row: Record<string, unknown>) => ({ name: row.name, active: row.active, severity: row.severity, params: row.params, recipients: row.recipient_ids ?? row.recipientIds, quietStart: row.quiet_start, quietEnd: row.quiet_end, repeatMinutes: row.repeat_minutes, groupMinutes: row.group_minutes });
      await auditChange(c, req, { action: "alert_rules.update", entity: "alert_rules", entityId: r.id, label: r.name, old: show(r), next: show({ ...r, ...next }) });
      return { id: r.id };
    });
  }

  @Post("rules/:id/reset")
  @HttpCode(200)
  async resetRule(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.manage(req);
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`SELECT * FROM alert_rules WHERE id = $1 AND system_key IS NOT NULL FOR UPDATE`, [uuid(id)])).rows[0];
      const d = r && DEFAULT_BY_KEY.get(r.system_key);
      if (!d) throw new NotFoundException();
      await c.query(`UPDATE alert_rules SET params = $2, severity = $3, group_minutes = $4, repeat_minutes = $5, quiet_start = NULL, quiet_end = NULL, active = true, updated_by = $6, updated_at = now() WHERE id = $1`,
        [r.id, JSON.stringify(d.params), d.severity, d.groupMinutes ?? 30, d.repeatMinutes ?? 30, req.session!.userId]);
      await auditChange(c, req, { action: "alert_rules.reset", entity: "alert_rules", entityId: r.id, label: r.name, old: { params: r.params, severity: r.severity, active: r.active }, next: { params: d.params, severity: d.severity, active: true } });
      return { id: r.id };
    });
  }

  private customParams(p: Record<string, unknown>): Record<string, unknown> {
    const m = MEASURE_BY_KEY.get(String(p.measure ?? ""));
    if (!m) throw new BadRequestException("Choose what to watch");
    const op = oneOf(p.op, "op", ["gt", "lt"] as const, { required: true })!;
    const value = Number(p.value);
    if (p.value === "" || p.value == null || !Number.isFinite(value) || Math.abs(value) > 1e9) throw new BadRequestException("Enter the number to compare with");
    const scopeId = typeof p.scopeId === "string" && p.scopeId ? uuid(p.scopeId, "scope") : null;
    if (scopeId && m.subject === "company") throw new BadRequestException("A company-wide number has no single car or driver");
    return { measure: m.key, op, value, ...(scopeId ? { scopeId } : {}) };
  }

  /** "When [measure] [is above/below] [value] for [car, driver or company], tell [person]." */
  @Post("rules")
  async createRule(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw);
    onlyKeys(b, ["name", "measure", "op", "value", "scopeId", "severity", "recipientIds", "endpointIds"]);
    return withOrg(this.pool, orgId, async (c) => {
      const params = this.customParams(b);
      const m = MEASURE_BY_KEY.get(params.measure as string)!;
      if (params.scopeId) {
        const t = m.subject === "vehicle" ? "vehicles" : "users";
        if (!(await c.query(`SELECT 1 FROM ${t} WHERE id = $1`, [params.scopeId])).rowCount) throw new BadRequestException(`That ${m.subject} does not exist`);
      }
      const severity = oneOf(b.severity ?? "warn", "severity", SEVERITIES, { required: true })!;
      const recipients = b.recipientIds === undefined ? [] : await this.cleanPeople(c, b.recipientIds);
      const unit = m.unit === "money" ? "$" : UNIT_LABEL[m.unit];
      const name = str(b.name, "name", { max: 120 }) ?? `${m.label} ${params.op === "gt" ? "above" : "below"} ${unit === "$" ? "$" : ""}${params.value}${unit && unit !== "$" ? ` ${unit}` : ""}`;
      const count = (await c.query(`SELECT count(*)::int AS n FROM alert_rules WHERE area = 'custom' AND archived_at IS NULL`)).rows[0].n;
      if (count >= 50) throw new ConflictException("You have 50 custom rules. Archive one you no longer need first.");
      const row = (await c.query(
        `INSERT INTO alert_rules (org_id, name, kind, params, severity, area, recipient_ids, scope_kind, scope_id, group_minutes, created_by, description)
         VALUES ($1,$2,'custom_measure',$3,$4,'custom',$5,$6,$7,1440,$8,$9) RETURNING id`,
        [orgId, name, JSON.stringify(params), severity, recipients, m.subject, params.scopeId ?? null, req.session!.userId, `When ${m.label.toLowerCase()} is ${params.op === "gt" ? "above" : "below"} ${params.value}.`])).rows[0];
      await auditChange(c, req, { action: "alert_rules.create", entity: "alert_rules", entityId: row.id, label: name, old: null, next: { name, params, severity, recipients } });
      return { id: row.id };
    });
  }

  /** Custom rules are archived, not deleted; default rules can only be switched off. */
  @Delete("rules/:id")
  @HttpCode(200)
  async archiveRule(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.manage(req);
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(`SELECT id, name, system_key FROM alert_rules WHERE id = $1 AND archived_at IS NULL AND area IS NOT NULL FOR UPDATE`, [uuid(id)])).rows[0];
      if (!r) throw new NotFoundException();
      if (r.system_key) throw new ConflictException("A default rule cannot be removed. Switch it off instead.");
      await c.query(`UPDATE alert_rules SET archived_at = now(), active = false, updated_by = $2 WHERE id = $1`, [r.id, req.session!.userId]);
      await c.query(`UPDATE alerts SET status = 'resolved', resolved_at = now(), resolved_how = 'auto' WHERE rule_id = $1 AND status <> 'resolved'`, [r.id]);
      await auditChange(c, req, { action: "alert_rules.archive", entity: "alert_rules", entityId: r.id, label: r.name, old: { archived: false }, next: { archived: true } });
      return { id: r.id };
    });
  }

  /** What would this rule match right now? Nothing is saved or sent. */
  @Post("rules/:id/preview")
  @HttpCode(200)
  async preview(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const b = asBody(raw ?? {});
    return withOrg(this.pool, orgId, async (c) => {
      const r = id === "new" ? null : (await c.query(`SELECT kind, params, system_key FROM alert_rules WHERE id = $1`, [uuid(id)])).rows[0];
      if (id !== "new" && !r) throw new NotFoundException();
      const kind = (r?.kind ?? "custom_measure") as RuleKind;
      const d = r?.system_key ? DEFAULT_BY_KEY.get(r.system_key) : null;
      const params = b.params !== undefined ? (d ? this.cleanParams(d.fields, b.params, r.params) : this.customParams({ ...(r?.params ?? {}), ...asBody(b.params) })) : r?.params ?? this.customParams(b);
      const f = await companyFormat(c);
      const matches = await EVALUATORS[kind].run(c, params, { orgId, today: todayIn(f.timezone), tz: f.timezone, svc: this.svc, now: new Date() });
      return { count: matches.length, matches: matches.slice(0, 20).map((m) => ({ title: m.title, severity: m.severity ?? null })) };
    });
  }

  /** Check this one rule now and send what it finds, to see that it reaches the people and channels chosen. */
  @Post("rules/:id/run")
  @HttpCode(200)
  async runRule(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.manage(req);
    const rid = uuid(id);
    const r = await evaluateOrg(this.pool, this.svc, this.notify, orgId, new Date(), rid);
    const open = (await withOrg(this.pool, orgId, (c) => c.query(`SELECT count(*)::int AS n FROM alerts WHERE rule_id = $1 AND status <> 'resolved'`, [rid]))).rows[0].n;
    return { ...r, open };
  }

  // ---- automations ---------------------------------------------------------------------------------------------------------------
  @Get("automations")
  async automations(@Req() req: AuthedRequest) {
    const orgId = this.manage(req);
    return withOrg(this.pool, orgId, async (c) => {
      const st = await loadAutomationState(c);
      const last = new Map<string, { at: string; status: string; message: string; n: number }>();
      for (const r of (await c.query(
        `SELECT DISTINCT ON (automation) automation, at, status, detail->>'message' AS message, (SELECT count(*)::int FROM portal_automation_runs x WHERE x.automation = r.automation) AS n FROM portal_automation_runs r ORDER BY automation, at DESC`)).rows) last.set(r.automation, r);
      const hooks = (await c.query(`SELECT count(*) FILTER (WHERE active)::int AS active, count(*)::int AS total FROM webhook_subscriptions`)).rows[0];
      return AUTOMATIONS.map((a) => ({
        key: a.key, spec: a.spec, name: a.name, description: a.description, note: a.note ?? null, builtIn: !!a.builtIn, fields: a.fields,
        enabled: st[a.key]!.enabled, settings: st[a.key]!.settings, last: last.get(a.key) ?? null,
        extra: a.key === "webhooks" ? { active: hooks.active, total: hooks.total } : null,
      }));
    });
  }

  @Put("automations/:key")
  async setAutomation(@Req() req: AuthedRequest, @Param("key") key: string, @Body() raw: unknown) {
    const orgId = this.manage(req);
    const a = AUTOMATION_BY_KEY.get(key);
    if (!a) throw new NotFoundException();
    if (a.builtIn) throw new ConflictException("This one is always on");
    const b = asBody(raw);
    onlyKeys(b, ["enabled", "settings"]);
    const settings: Record<string, unknown> = {};
    if (b.settings !== undefined) {
      const s = asBody(b.settings);
      for (const f of a.fields) {
        if (s[f.key] === undefined) continue;
        if (f.type === "select") { if (!f.options!.some((o) => o.value === String(s[f.key]))) throw new BadRequestException(`${f.label}: choose one of the options`); settings[f.key] = /^\d+$/.test(String(s[f.key])) && f.key !== "cycle" && f.key !== "when" ? Number(s[f.key]) : s[f.key]; }
        else if (f.type === "number") { const n = Number(s[f.key]); if (!Number.isInteger(n) || n < (f.min ?? 0) || n > (f.max ?? 1e6)) throw new BadRequestException(`${f.label} must be a whole number from ${f.min} to ${f.max}`); settings[f.key] = n; }
        else {
          const list = (Array.isArray(s[f.key]) ? (s[f.key] as unknown[]) : String(s[f.key]).split(/[,\s]+/)).filter((x) => x !== "").map(Number);
          if (!list.length || list.length > 8 || list.some((n) => !Number.isInteger(n) || n < (f.min ?? 0) || n > (f.max ?? 1e6))) throw new BadRequestException(`${f.label}: enter up to 8 whole numbers from ${f.min} to ${f.max}`);
          settings[f.key] = [...new Set(list)].sort((x, y) => x - y);
        }
      }
      for (const k of Object.keys(s)) if (!a.fields.some((f) => f.key === k)) throw new BadRequestException(`"${k}" is not a setting of this automation`);
    }
    return withOrg(this.pool, orgId, async (c) => {
      const before = (await loadAutomationState(c))[key]!;
      await saveAutomationState(c, orgId, key, { enabled: b.enabled === undefined ? undefined : b.enabled === true, settings }, req.session!.userId);
      const after = (await loadAutomationState(c))[key]!;
      await auditChange(c, req, { action: "automations.update", entity: "automations", entityId: null, label: a.name, old: { ...before }, next: { ...after } });
      return after;
    });
  }

  /** Run one automation now, even if it is not its time. */
  @Post("automations/:key/run")
  @HttpCode(200)
  async runAutomation(@Req() req: AuthedRequest, @Param("key") key: string) {
    const orgId = this.manage(req);
    const a = AUTOMATION_BY_KEY.get(key);
    if (!a || a.builtIn) throw new NotFoundException();
    if (a.key === "payout_run_on_payday") requirePerm(req, "payouts.approve");
    const results = await runAutomations(this.pool, this.notify, orgId, new Date(), key);
    await withOrg(this.pool, orgId, (c) => auditChange(c, req, { action: "automations.run", entity: "automations", entityId: null, label: a.name, old: null, next: { results: results.length } }));
    return { results };
  }

  @Get("automations/runs")
  async runs(@Req() req: AuthedRequest, @Query("automation") automation?: string) {
    const orgId = this.manage(req);
    return withOrg(this.pool, orgId, async (c) => (await c.query(
      `SELECT id, automation, subject, status, detail->>'message' AS message, at FROM portal_automation_runs WHERE automation <> 'digest' AND ($1::text IS NULL OR automation = $1) ORDER BY at DESC LIMIT 100`, [automation ?? null])).rows);
  }

  // ---- one alert and what can be done with it -----------------------------------------------------------------------------------------
  @Get(":id")
  async one(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const params: unknown[] = [uuid(id)];
      const vis = await this.visible(c, req, params);
      const a = (await c.query(
        `SELECT a.id, a.title, a.severity, a.status, a.area, a.kind, a.detail, a.count, a.first_at AS "firstAt", a.last_at AS "lastAt", a.snoozed_until AS "snoozedUntil", a.assigned_to AS "assignedToId",
                coalesce(asg.display_name, asg.email) AS "assignedTo", a.resolved_at AS "resolvedAt", a.resolved_how AS "resolvedHow", coalesce(rb.display_name, rb.email) AS "resolvedBy", r.name AS rule
         FROM alerts a LEFT JOIN alert_rules r ON r.id = a.rule_id LEFT JOIN users asg ON asg.id = a.assigned_to LEFT JOIN users rb ON rb.id = a.resolved_by WHERE a.id = $1 AND ${vis}`, params)).rows[0];
      if (!a) throw new NotFoundException();
      const history = (await c.query(
        `SELECT e.id, e.at, e.kind, e.note, e.detail, coalesce(u.display_name, u.email, 'RouteNorth') AS actor FROM alert_events e LEFT JOIN users u ON u.id = e.actor_id WHERE e.alert_id = $1 ORDER BY e.at, e.id`, [a.id])).rows;
      return { ...a, history };
    });
  }

  private async act(req: AuthedRequest, id: string, fn: (c: pg.PoolClient, a: Record<string, any>, orgId: string) => Promise<{ kind: string; note?: string | null; detail?: Record<string, unknown>; audit: Record<string, unknown> }>) {
    const orgId = this.manage(req);
    return withOrg(this.pool, orgId, async (c) => {
      const params: unknown[] = [uuid(id)];
      const vis = await this.visible(c, req, params);
      const a = (await c.query(`SELECT a.* FROM alerts a WHERE a.id = $1 AND ${vis} FOR UPDATE OF a`, params)).rows[0];
      if (!a) throw new NotFoundException();
      const r = await fn(c, a, orgId);
      await c.query(`INSERT INTO alert_events (org_id, alert_id, actor_id, kind, note, detail) VALUES ($1,$2,$3,$4,$5,$6)`, [orgId, a.id, req.session!.userId, r.kind, r.note ?? null, JSON.stringify(r.detail ?? {})]);
      await auditChange(c, req, { action: `alerts.${r.kind}`, entity: "alerts", entityId: a.id, label: String(a.title).slice(0, 120), old: { status: a.status, assignedTo: a.assigned_to, snoozedUntil: a.snoozed_until }, next: r.audit });
      return { id: a.id, ok: true };
    });
  }

  @Post(":id/acknowledge")
  @HttpCode(200)
  acknowledge(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.act(req, id, async (c, a) => {
      if (a.status === "resolved") throw new ConflictException("This alert is already done");
      await c.query(`UPDATE alerts SET status = 'acknowledged', acknowledged_by = $2 WHERE id = $1 AND status = 'open'`, [a.id, req.session!.userId]);
      return { kind: "acknowledged", audit: { status: "acknowledged", assignedTo: a.assigned_to, snoozedUntil: a.snoozed_until } };
    });
  }

  @Post(":id/assign")
  @HttpCode(200)
  assign(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const b = asBody(raw ?? {});
    onlyKeys(b, ["userId", "note"]);
    return this.act(req, id, async (c, a, orgId) => {
      if (a.status === "resolved") throw new ConflictException("This alert is already done");
      if (b.userId === null || b.userId === "") {
        await c.query(`UPDATE alerts SET assigned_to = NULL, assigned_at = NULL WHERE id = $1`, [a.id]);
        return { kind: "unassigned", audit: { status: a.status, assignedTo: null, snoozedUntil: a.snoozed_until } };
      }
      const uid = uuid(b.userId, "userId");
      const u = (await c.query(`SELECT id, coalesce(display_name, email) AS name FROM users WHERE id = $1 AND disabled_at IS NULL AND role <> 'driver'`, [uid])).rows[0];
      if (!u) throw new BadRequestException("Choose someone who works in the office");
      await c.query(`UPDATE alerts SET assigned_to = $2, assigned_at = now(), status = CASE WHEN status = 'open' THEN 'acknowledged' ELSE status END, acknowledged_by = coalesce(acknowledged_by, $3) WHERE id = $1`, [a.id, uid, req.session!.userId]);
      if (uid !== req.session!.userId) await addNotification(c, orgId, uid, "task", `${req.actor?.email ?? "Someone"} gave you an alert: ${a.title}`, `/owner/alerts?id=${a.id}`);
      return { kind: "assigned", note: str(b.note, "note", { max: 500 }), detail: { to: u.name }, audit: { status: "acknowledged", assignedTo: uid, snoozedUntil: a.snoozed_until } };
    });
  }

  @Post(":id/snooze")
  @HttpCode(200)
  snooze(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const b = asBody(raw ?? {});
    onlyKeys(b, ["hours", "until", "note"]);
    return this.act(req, id, async (c, a) => {
      if (a.status === "resolved") throw new ConflictException("This alert is already done");
      let until: Date;
      if (b.until !== undefined) { until = new Date(String(b.until)); if (Number.isNaN(until.getTime())) throw new BadRequestException("until must be a date and time"); }
      else until = new Date(Date.now() + (int(b.hours ?? 24, "hours", { min: 1, max: 24 * 90, required: true })!) * 3_600_000);
      if (until.getTime() <= Date.now() || until.getTime() > Date.now() + 90 * 86_400_000) throw new BadRequestException("Snooze for between an hour and 90 days");
      await c.query(`UPDATE alerts SET snoozed_until = $2, snoozed_by = $3 WHERE id = $1`, [a.id, until, req.session!.userId]);
      return { kind: "snoozed", note: str(b.note, "note", { max: 500 }), detail: { until: until.toISOString() }, audit: { status: a.status, assignedTo: a.assigned_to, snoozedUntil: until.toISOString() } };
    });
  }

  @Post(":id/unsnooze")
  @HttpCode(200)
  unsnooze(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.act(req, id, async (c, a) => {
      await c.query(`UPDATE alerts SET snoozed_until = NULL, snoozed_by = NULL WHERE id = $1`, [a.id]);
      return { kind: "unsnoozed", audit: { status: a.status, assignedTo: a.assigned_to, snoozedUntil: null } };
    });
  }

  @Post(":id/done")
  @HttpCode(200)
  done(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const b = asBody(raw ?? {});
    onlyKeys(b, ["note"]);
    return this.act(req, id, async (c, a) => {
      if (a.status === "resolved") throw new ConflictException("This alert is already done");
      await c.query(`UPDATE alerts SET status = 'resolved', resolved_by = $2, resolved_at = now(), resolved_how = 'person', snoozed_until = NULL WHERE id = $1`, [a.id, req.session!.userId]);
      return { kind: "done", note: str(b.note, "note", { max: 500 }), audit: { status: "resolved", assignedTo: a.assigned_to, snoozedUntil: null } };
    });
  }

  @Post(":id/reopen")
  @HttpCode(200)
  reopen(@Req() req: AuthedRequest, @Param("id") id: string) {
    return this.act(req, id, async (c, a) => {
      if (a.status !== "resolved") throw new ConflictException("This alert is not done");
      if ((await c.query(`SELECT 1 FROM alerts WHERE dedupe_key = $1 AND status <> 'resolved'`, [a.dedupe_key])).rowCount) throw new ConflictException("The same alert is already open");
      await c.query(`UPDATE alerts SET status = 'open', resolved_by = NULL, resolved_at = NULL, resolved_how = NULL, last_at = now() WHERE id = $1`, [a.id]);
      return { kind: "reopened", audit: { status: "open", assignedTo: a.assigned_to, snoozedUntil: null } };
    });
  }

  @Post(":id/note")
  @HttpCode(200)
  note(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const b = asBody(raw ?? {});
    onlyKeys(b, ["note"]);
    return this.act(req, id, async (_c, a) => ({ kind: "note", note: str(b.note, "note", { required: true, max: 1000 }), audit: { status: a.status, assignedTo: a.assigned_to, snoozedUntil: a.snoozed_until } }));
  }

  /** The floating bar over selected rows: acknowledge, snooze or close several at once. */
  @Post("bulk")
  @HttpCode(200)
  async bulk(@Req() req: AuthedRequest, @Body() raw: unknown) {
    this.manage(req);
    const b = asBody(raw);
    onlyKeys(b, ["ids", "action", "hours"]);
    const action = oneOf(b.action, "action", ["acknowledge", "snooze", "done"] as const, { required: true })!;
    if (!Array.isArray(b.ids) || !b.ids.length || b.ids.length > 100) throw new BadRequestException("Choose between 1 and 100 alerts");
    let ok = 0; const failed: string[] = [];
    for (const id of b.ids) {
      try {
        if (action === "acknowledge") await this.acknowledge(req, String(id));
        else if (action === "done") await this.done(req, String(id), {});
        else await this.snooze(req, String(id), { hours: b.hours ?? 24 });
        ok++;
      } catch { failed.push(String(id)); }
    }
    return { done: ok, failed };
  }
}

