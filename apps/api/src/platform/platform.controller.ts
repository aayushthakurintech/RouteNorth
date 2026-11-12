import { BadRequestException, Body, Controller, Delete, Get, Inject, NotFoundException, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { ACCOUNTING_FORMATS, checkCustomValues, CUSTOM_ENTITIES, CUSTOM_TYPES, INTEGRATIONS, invoiceCsv, type AccountingFormat, type CustomEntity, type CustomFieldDef, type InvoiceExportRow, type Permission } from "@routenorth/shared";
import { AuthGuard, requireAny, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { withDefaults } from "../org/settings.js";
import { PG_POOL } from "../tokens.js";
import { parseUuid } from "../history/range.js";
import { KEY_KINDS, newKey, type KeyKind } from "./keys.js";

const WRITE_PERM: Record<CustomEntity, Permission> = { job: "routes.write", vehicle: "fleet.manage", driver: "fleet.manage", depot: "fleet.manage", customer: "customers.manage" };
const READ_PERM: Record<CustomEntity, Permission> = { job: "routes.view", vehicle: "fleet.view", driver: "fleet.view", depot: "fleet.view", customer: "customers.view" };
const TABLE: Record<CustomEntity, string> = { job: "jobs", vehicle: "vehicles", driver: "users", depot: "depots", customer: "users" };
const JOB_STATES = ["unassigned", "assigned", "started", "arrived", "done", "failed", "cancelled"];
const KEY = /^[a-z][a-z0-9_]{0,39}$/;

function entityOf(v: unknown): CustomEntity {
  if (!(CUSTOM_ENTITIES as readonly unknown[]).includes(v)) throw new BadRequestException(`entity must be one of ${CUSTOM_ENTITIES.join(", ")}`);
  return v as CustomEntity;
}
const text = (v: unknown, name: string, max: number, required = true): string | null => {
  if (v === undefined || v === null || v === "") { if (required) throw new BadRequestException(`${name} is required`); return null; }
  if (typeof v !== "string" || v.length > max) throw new BadRequestException(`${name} must be up to ${max} characters`);
  return v.trim();
};

@Controller("platform")
@UseGuards(AuthGuard)
export class PlatformController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  // ---- API keys, feed links and inbound-email addresses ----
  @Get("keys")
  async keys(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "api.manage");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT id, name, kind, scope, prefix, last_used_at AS "lastUsedAt", expires_at AS "expiresAt", revoked_at AS "revokedAt", created_at AS "createdAt" FROM api_keys ORDER BY created_at DESC LIMIT 200`))).rows;
  }

  /** Create a key. The key itself is in the answer once; only its hash is kept. */
  @Post("keys")
  async createKey(@Req() req: AuthedRequest, @Body() b: { name?: unknown; kind?: unknown; scope?: unknown; expiresInDays?: unknown }) {
    const orgId = requirePerm(req, "api.manage");
    const name = text(b?.name, "name", 80)!;
    const kind = String(b?.kind ?? "api") as KeyKind;
    if (!KEY_KINDS.includes(kind)) throw new BadRequestException("kind must be api, feed or inbound");
    const scope = kind === "api" ? String(b?.scope ?? "read") : "read";
    if (!["read", "write"].includes(scope)) throw new BadRequestException("scope must be read or write");
    let days: number | null = null;
    if (b?.expiresInDays !== undefined && b.expiresInDays !== null && b.expiresInDays !== "") { days = Number(b.expiresInDays); if (!Number.isInteger(days) || days < 1 || days > 3650) throw new BadRequestException("expiresInDays must be 1 to 3650"); }
    const k = newKey(kind);
    const row = (await withOrg(this.pool, orgId, async (c) => {
      const count = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM api_keys WHERE revoked_at IS NULL")).rows[0]!.n;
      if (count >= 50) throw new BadRequestException("at most 50 active keys; revoke some first");
      return (await c.query(
        `INSERT INTO api_keys (org_id, name, kind, scope, prefix, key_hash, created_by, expires_at) VALUES ($1,$2,$3,$4,$5,$6,$7, CASE WHEN $8::int IS NULL THEN NULL ELSE now() + ($8::int || ' days')::interval END)
         RETURNING id, name, kind, scope, prefix, expires_at AS "expiresAt"`, [orgId, name, kind, scope, k.prefix, k.hash, req.session!.userId, days])).rows[0];
    }));
    return { ...row, key: k.key };
  }

  @Delete("keys/:id")
  async revokeKey(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "api.manage");
    const r = await withOrg(this.pool, orgId, (c) => c.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [parseUuid(id)]));
    if (!r.rowCount) throw new NotFoundException("key not found");
    return { ok: true };
  }

  @Get("catalog")
  catalog(@Req() req: AuthedRequest) { requirePerm(req, "api.manage"); return INTEGRATIONS; }

  // ---- custom fields ----
  @Get("custom-fields")
  async fields(@Req() req: AuthedRequest, @Query("entity") entity?: string) {
    const orgId = requireAny(req, "routes.view", "fleet.view", "customers.view");
    const e = entity ? entityOf(entity) : null;
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT id, entity, key, label, label_fr AS "labelFr", type, options, required, sort, active FROM custom_fields WHERE ($1::text IS NULL OR entity = $1) ORDER BY entity, sort, label`, [e]))).rows;
  }

  private parseField(b: Record<string, unknown>, partial: boolean) {
    const o: Record<string, unknown> = {};
    if (!partial || b.label !== undefined) o.label = text(b.label, "label", 80);
    if (b.labelFr !== undefined) o.label_fr = text(b.labelFr, "labelFr", 80, false);
    if (!partial || b.type !== undefined) { if (!(CUSTOM_TYPES as readonly unknown[]).includes(b.type)) throw new BadRequestException(`type must be one of ${CUSTOM_TYPES.join(", ")}`); o.type = b.type; }
    if (b.options !== undefined) {
      if (b.options !== null && (!Array.isArray(b.options) || b.options.length > 50 || !b.options.every((x) => typeof x === "string" && x.length > 0 && x.length <= 60))) throw new BadRequestException("options must be a list of up to 50 short texts");
      o.options = b.options === null ? null : JSON.stringify(b.options);
    }
    if (b.required !== undefined) o.required = Boolean(b.required);
    if (b.active !== undefined) o.active = Boolean(b.active);
    if (b.sort !== undefined) { const n = Number(b.sort); if (!Number.isInteger(n) || n < 0 || n > 1000) throw new BadRequestException("sort must be 0 to 1000"); o.sort = n; }
    if (o.type === "select" && (!o.options || (JSON.parse(String(o.options)) as string[]).length === 0)) throw new BadRequestException("a choice field needs at least one option");
    return o;
  }

  @Post("custom-fields")
  async addField(@Req() req: AuthedRequest, @Body() b: Record<string, unknown>) {
    const orgId = requirePerm(req, "settings.manage");
    const entity = entityOf(b?.entity);
    const key = String(b?.key ?? "");
    if (!KEY.test(key)) throw new BadRequestException("key must start with a letter and use only lowercase letters, numbers and underscores");
    const o = this.parseField(b, false);
    return withOrg(this.pool, orgId, async (c) => {
      if ((await c.query<{ n: number }>("SELECT count(*)::int AS n FROM custom_fields WHERE entity = $1", [entity])).rows[0]!.n >= 40) throw new BadRequestException("at most 40 fields per record type");
      try {
        return (await c.query(`INSERT INTO custom_fields (org_id, entity, key, label, label_fr, type, options, required) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8) RETURNING id`,
          [orgId, entity, key, o.label, o.label_fr ?? null, o.type, o.options ?? null, o.required ?? false])).rows[0];
      } catch (e) { if ((e as { code?: string }).code === "23505") throw new BadRequestException("that key is already used"); throw e; }
    });
  }

  @Patch("custom-fields/:id")
  async editField(@Req() req: AuthedRequest, @Param("id") id: string, @Body() b: Record<string, unknown>) {
    const orgId = requirePerm(req, "settings.manage");
    const o = this.parseField(b ?? {}, true);
    const cols = Object.keys(o);
    if (!cols.length) throw new BadRequestException("nothing to update");
    const r = await withOrg(this.pool, orgId, (c) => c.query(`UPDATE custom_fields SET ${cols.map((k, i) => `${k} = $${i + 2}${k === "options" ? "::jsonb" : ""}`).join(", ")} WHERE id = $1`, [parseUuid(id), ...cols.map((k) => o[k])]));
    if (!r.rowCount) throw new NotFoundException("field not found");
    return { ok: true };
  }

  @Delete("custom-fields/:id")
  async delField(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "settings.manage");
    const r = await withOrg(this.pool, orgId, (c) => c.query("DELETE FROM custom_fields WHERE id = $1", [parseUuid(id)]));
    if (!r.rowCount) throw new NotFoundException("field not found");
    return { ok: true };
  }

  /** The fields for a record type with the values for one record. */
  @Get("custom")
  async values(@Req() req: AuthedRequest, @Query("entity") entity: string, @Query("recordId") recordId: string) {
    const e = entityOf(entity);
    const orgId = requirePerm(req, READ_PERM[e]);
    const rid = parseUuid(recordId);
    return withOrg(this.pool, orgId, async (c) => ({
      fields: (await c.query(`SELECT key, label, label_fr AS "labelFr", type, options, required FROM custom_fields WHERE entity = $1 AND active ORDER BY sort, label`, [e])).rows,
      values: (await c.query<{ data: Record<string, unknown> }>("SELECT data FROM custom_values WHERE entity = $1 AND record_id = $2", [e, rid])).rows[0]?.data ?? {},
    }));
  }

  @Put("custom")
  async setValues(@Req() req: AuthedRequest, @Body() b: { entity?: unknown; recordId?: unknown; values?: unknown }) {
    const e = entityOf(b?.entity);
    const orgId = requirePerm(req, WRITE_PERM[e]);
    const rid = parseUuid(String(b?.recordId));
    if (!b.values || typeof b.values !== "object" || Array.isArray(b.values)) throw new BadRequestException("values must be an object");
    return withOrg(this.pool, orgId, async (c) => {
      const exists = await c.query(`SELECT 1 FROM ${TABLE[e]} WHERE id = $1`, [rid]);
      if (!exists.rowCount) throw new NotFoundException("record not found");
      const defs = (await c.query<CustomFieldDef & { options: string[] | null }>(`SELECT key, label, type, options, required, active FROM custom_fields WHERE entity = $1`, [e])).rows;
      const checked = checkCustomValues(defs, b.values as Record<string, unknown>);
      if (!checked.ok) throw new BadRequestException(checked.error);
      const prev = (await c.query<{ data: Record<string, unknown> }>("SELECT data FROM custom_values WHERE entity = $1 AND record_id = $2", [e, rid])).rows[0]?.data ?? {};
      const data = { ...prev, ...checked.values };
      for (const k of Object.keys(data)) if (data[k] === null) delete data[k];
      await c.query(`INSERT INTO custom_values (org_id, entity, record_id, data) VALUES ($1,$2,$3,$4::jsonb) ON CONFLICT (org_id, entity, record_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`, [orgId, e, rid, JSON.stringify(data)]);
      return { values: data };
    });
  }

  // ---- custom job statuses ----
  @Get("statuses")
  async statuses(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "routes.view");
    return (await withOrg(this.pool, orgId, (c) => c.query(`SELECT id, key, label, label_fr AS "labelFr", base_status AS "baseStatus", color, sort, active FROM custom_statuses ORDER BY sort, label`))).rows;
  }

  private parseStatus(b: Record<string, unknown>, partial: boolean) {
    const o: Record<string, unknown> = {};
    if (!partial || b.label !== undefined) o.label = text(b.label, "label", 60);
    if (b.labelFr !== undefined) o.label_fr = text(b.labelFr, "labelFr", 60, false);
    if (!partial || b.baseStatus !== undefined) { if (!JOB_STATES.includes(String(b.baseStatus))) throw new BadRequestException(`baseStatus must be one of ${JOB_STATES.join(", ")}`); o.base_status = b.baseStatus; }
    if (b.color !== undefined) { if (!/^#[0-9a-fA-F]{6}$/.test(String(b.color))) throw new BadRequestException("color must look like #1a73e8"); o.color = b.color; }
    if (b.active !== undefined) o.active = Boolean(b.active);
    if (b.sort !== undefined) { const n = Number(b.sort); if (!Number.isInteger(n) || n < 0 || n > 1000) throw new BadRequestException("sort must be 0 to 1000"); o.sort = n; }
    return o;
  }

  @Post("statuses")
  async addStatus(@Req() req: AuthedRequest, @Body() b: Record<string, unknown>) {
    const orgId = requirePerm(req, "settings.manage");
    const key = String(b?.key ?? "");
    if (!KEY.test(key)) throw new BadRequestException("key must start with a letter and use only lowercase letters, numbers and underscores");
    const o = this.parseStatus(b, false);
    try {
      return (await withOrg(this.pool, orgId, (c) => c.query(`INSERT INTO custom_statuses (org_id, key, label, label_fr, base_status, color) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [orgId, key, o.label, o.label_fr ?? null, o.base_status, o.color ?? "#64748b"]))).rows[0];
    } catch (e) { if ((e as { code?: string }).code === "23505") throw new BadRequestException("that key is already used"); throw e; }
  }

  @Patch("statuses/:id")
  async editStatus(@Req() req: AuthedRequest, @Param("id") id: string, @Body() b: Record<string, unknown>) {
    const orgId = requirePerm(req, "settings.manage");
    const o = this.parseStatus(b ?? {}, true);
    const cols = Object.keys(o);
    if (!cols.length) throw new BadRequestException("nothing to update");
    const r = await withOrg(this.pool, orgId, (c) => c.query(`UPDATE custom_statuses SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1`, [parseUuid(id), ...cols.map((k) => o[k])]));
    if (!r.rowCount) throw new NotFoundException("status not found");
    return { ok: true };
  }

  @Delete("statuses/:id")
  async delStatus(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "settings.manage");
    return withOrg(this.pool, orgId, async (c) => {
      const s = (await c.query<{ key: string }>("DELETE FROM custom_statuses WHERE id = $1 RETURNING key", [parseUuid(id)])).rows[0];
      if (!s) throw new NotFoundException("status not found");
      await c.query("UPDATE jobs SET custom_status = NULL WHERE custom_status = $1", [s.key]);
      return { ok: true };
    });
  }

  /** Put a company status on a job, or clear it. It must be one that applies while the job is in its current state. */
  @Put("jobs/:id/status")
  async setJobStatus(@Req() req: AuthedRequest, @Param("id") id: string, @Body() b: { key?: unknown }) {
    const orgId = requirePerm(req, "routes.write");
    const jobId = parseUuid(id);
    const key = b?.key === null || b?.key === "" || b?.key === undefined ? null : String(b.key);
    return withOrg(this.pool, orgId, async (c) => {
      const job = (await c.query<{ status: string }>("SELECT status FROM jobs WHERE id = $1", [jobId])).rows[0];
      if (!job) throw new NotFoundException("job not found");
      if (key) {
        const s = (await c.query<{ base_status: string }>("SELECT base_status FROM custom_statuses WHERE key = $1 AND active", [key])).rows[0];
        if (!s) throw new BadRequestException("unknown status");
        if (s.base_status !== job.status) throw new BadRequestException(`that status applies while a job is ${s.base_status}`);
      }
      await c.query("UPDATE jobs SET custom_status = $2, updated_at = now() WHERE id = $1", [jobId, key]);
      return { customStatus: key };
    });
  }

  // ---- accounting export ----
  @Get("export/invoices")
  async invoicesCsv(@Req() req: AuthedRequest, @Query("format") format = "quickbooks", @Query("from") from?: string, @Query("to") to?: string) {
    const orgId = requirePerm(req, "reports.export");
    if (!(ACCOUNTING_FORMATS as readonly string[]).includes(format)) throw new BadRequestException(`format must be one of ${ACCOUNTING_FORMATS.join(", ")}`);
    const date = (v: unknown, def: string) => (v === undefined || v === "" ? def : /^\d{4}-\d{2}-\d{2}$/.test(String(v)) ? String(v) : (() => { throw new BadRequestException("dates must look like 2026-03-31"); })());
    return withOrg(this.pool, orgId, async (c) => {
      const org = (await c.query<{ settings: Record<string, unknown> }>("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0]!;
      const s = withDefaults(org.settings);
      const rows = (await c.query(
        `SELECT number, customer_name AS customer, customer_email AS email, issued_on::text AS "issuedOn", due_on::text AS "dueOn", currency, status, lines, subtotal::float8 AS subtotal, tax::float8 AS tax, total::float8 AS total
         FROM invoices WHERE status <> 'void' AND issued_on BETWEEN $1::date AND $2::date ORDER BY issued_on, number LIMIT 5000`, [date(from, "1970-01-01"), date(to, "2999-12-31")])).rows as InvoiceExportRow[];
      const taxName = s.billing.province === "QC" ? "TPS/TVQ" : ["ON", "NB", "NL", "NS", "PE"].includes(s.billing.province) ? "HST" : "GST";
      return { csv: invoiceCsv(rows.map((r) => ({ ...r, taxName })), format as AccountingFormat), count: rows.length };
    });
  }
}
