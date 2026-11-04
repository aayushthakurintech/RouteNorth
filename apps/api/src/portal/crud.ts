import { BadRequestException, NotFoundException } from "@nestjs/common";
import type { pg } from "@routenorth/db";
import type { Permission } from "@routenorth/shared";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { auditChange } from "../audit/domain-audit.js";
import { parseBody } from "../resources/engine.js";
import { REF_TABLES, type Field, type ResourceDef } from "../resources/defs.js";

/** A child table of a vehicle, driver or rate card, described once and served by the same list / add / edit / archive code. */
export interface ChildDef {
  /** URL segment, e.g. "maintenance" */
  name: string;
  /** Audit entity name, e.g. "vehicle_maintenance" */
  entity: string;
  table: string;
  /** Column that points at the parent (vehicle_id, driver_id, owner_id ...) */
  parentCol: string;
  /** Extra columns written on create and used to filter reads (e.g. owner_kind = 'vehicle') */
  fixed?: Record<string, string>;
  fields: readonly Field[];
  /** SQL ORDER BY, columns prefixed with the table name */
  order: string;
  label: (row: Record<string, unknown>) => string;
  view: readonly Permission[];
  write: readonly Permission[];
  /** Audit highlights these as sensitive */
  sensitive?: boolean;
  /** Extra SELECT expressions, e.g. a computed status */
  extra?: string;
  /** Column holding when the row was made, when it is not created_at (inspections use "at") */
  createdCol?: string;
  /** false when the table has no created_by / updated_at columns */
  stamped?: boolean;
  /** Cross-field rules */
  check?: (merged: Record<string, unknown>, existing: Record<string, unknown> | null) => void;
  /** Runs inside the transaction after create/update (update the car's odometer, close a work order ...) */
  after?: (c: pg.PoolClient, row: Record<string, unknown>, ctx: { creating: boolean; req: AuthedRequest }) => Promise<void>;
  /** Extra column values to write, worked out from the validated request (e.g. cents -> the older dollar column). */
  columns?: (v: Record<string, unknown>) => Record<string, unknown>;
  /** Runs before create/update with the validated values; may throw or adjust. */
  before?: (c: pg.PoolClient, v: Record<string, unknown>, existing: Record<string, unknown> | null, ctx: { parentId: string; req: AuthedRequest }) => Promise<void>;
}

const MONEY = /Cents$/;

export const colList = (d: ChildDef): string =>
  [`${d.table}.id`, ...d.fields.filter((f) => !f.virtual).map((f) => {
    const cast = MONEY.test(f.key) ? "::float8" : f.type === "date" || f.type === "time" ? "::text" : "";
    return `${d.table}.${f.col}${cast} AS "${f.key}"`;
  }), `${d.table}.${d.createdCol ?? "created_at"} AS "createdAt"`, `${d.table}.archived_at AS "archivedAt"`, ...(d.extra ? [d.extra] : [])].join(", ");

const asDef = (d: ChildDef) => ({ fields: d.fields }) as unknown as ResourceDef;

export async function listChild(c: pg.PoolClient, d: ChildDef, parentId: string, o: { archived?: boolean } = {}): Promise<Record<string, unknown>[]> {
  const params: unknown[] = [parentId];
  const fixed = Object.entries(d.fixed ?? {}).map(([k, v]) => { params.push(v); return `AND ${d.table}.${k} = $${params.length}`; }).join(" ");
  const archived = o.archived ? "" : `AND ${d.table}.archived_at IS NULL`;
  return (await c.query(`SELECT ${colList(d)} FROM ${d.table} WHERE ${d.table}.${d.parentCol} = $1 ${fixed} ${archived} ORDER BY ${d.order}`, params)).rows;
}

export async function getChild(c: pg.PoolClient, d: ChildDef, id: string, lock = false): Promise<Record<string, unknown> | undefined> {
  const params: unknown[] = [id];
  const fixed = Object.entries(d.fixed ?? {}).map(([k, v]) => { params.push(v); return `AND ${d.table}.${k} = $${params.length}`; }).join(" ");
  return (await c.query(`SELECT ${colList(d)}, ${d.table}.${d.parentCol} AS "_parent" FROM ${d.table} WHERE ${d.table}.id = $1 ${fixed} ${lock ? "FOR UPDATE" : ""}`, params)).rows[0];
}

/** Every id the request points at must exist in this company (Row-Level Security hides other companies' rows). */
async function checkRefs(c: pg.PoolClient, d: ChildDef, v: Record<string, unknown>): Promise<void> {
  for (const f of d.fields) {
    if (f.type !== "ref" || v[f.key] == null) continue;
    const rt = REF_TABLES[f.ref!];
    if (!rt) throw new Error(`no ref table for ${f.ref}`);
    if (!(await c.query(`SELECT 1 FROM ${rt.table} WHERE id = $1 ${rt.where ? `AND ${rt.where}` : ""}`, [v[f.key]])).rowCount) throw new BadRequestException(`${f.key} does not exist`);
  }
}

const plain = (row: Record<string, unknown>, d: ChildDef): Record<string, unknown> => Object.fromEntries(d.fields.map((f) => [f.key, row[f.key] ?? null]));
const userId = (req: AuthedRequest) => (/^[0-9a-f-]{36}$/.test(req.session!.userId) ? req.session!.userId : null);

export async function createChild(c: pg.PoolClient, req: AuthedRequest, d: ChildDef, parentId: string, raw: unknown): Promise<Record<string, unknown>> {
  const v = parseBody(asDef(d), raw, true);
  try { d.check?.(v, null); } catch (e) { throw new BadRequestException(e instanceof Error ? e.message : "invalid"); }
  await checkRefs(c, d, v);
  await d.before?.(c, v, null, { parentId, req });
  const fields = d.fields.filter((f) => v[f.key] !== undefined && !f.virtual);
  const extra = d.columns?.(v) ?? {};
  const cols = ["org_id", d.parentCol, ...Object.keys(d.fixed ?? {}), ...fields.map((f) => f.col), ...Object.keys(extra), ...(d.stamped === false ? [] : ["created_by"])];
  const vals = [req.session!.orgId, parentId, ...Object.values(d.fixed ?? {}), ...fields.map((f) => (f.type === "json" ? JSON.stringify(v[f.key]) : v[f.key])), ...Object.values(extra), ...(d.stamped === false ? [] : [userId(req)])];
  const id = (await c.query(`INSERT INTO ${d.table} (${cols.join(",")}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(",")}) RETURNING id`, vals)).rows[0].id as string;
  const row = (await getChild(c, d, id))!;
  await auditChange(c, req, { action: `${d.entity}.create`, entity: d.entity, entityId: id, label: d.label(row), old: null, next: plain(row, d), sensitive: d.sensitive });
  await d.after?.(c, row, { creating: true, req });
  return row;
}

export async function updateChild(c: pg.PoolClient, req: AuthedRequest, d: ChildDef, id: string, raw: unknown): Promise<Record<string, unknown>> {
  const v = parseBody(asDef(d), raw, false);
  if (!Object.keys(v).length) throw new BadRequestException("nothing to change");
  const existing = await getChild(c, d, id, true);
  if (!existing) throw new NotFoundException();
  if (existing.archivedAt) throw new BadRequestException("this record is archived; restore it first");
  try { d.check?.({ ...existing, ...v }, existing); } catch (e) { throw new BadRequestException(e instanceof Error ? e.message : "invalid"); }
  await checkRefs(c, d, v);
  await d.before?.(c, v, existing, { parentId: String(existing._parent), req });
  const fields = d.fields.filter((f) => v[f.key] !== undefined && !f.virtual);
  const extra = d.columns?.(v) ?? {};
  const sets = [...fields.map((f) => f.col), ...Object.keys(extra)];
  await c.query(
    `UPDATE ${d.table} SET ${sets.map((col, i) => `${col} = $${i + 2}`).join(", ")}${d.stamped === false ? "" : `${sets.length ? ", " : ""}updated_at = now()`} WHERE id = $1`,
    [id, ...fields.map((f) => (f.type === "json" ? JSON.stringify(v[f.key]) : v[f.key])), ...Object.values(extra)]);
  const row = (await getChild(c, d, id))!;
  await auditChange(c, req, { action: `${d.entity}.update`, entity: d.entity, entityId: id, label: d.label(row), old: plain(existing, d), next: plain(row, d), sensitive: d.sensitive });
  await d.after?.(c, row, { creating: false, req });
  return row;
}

/** Nothing is removed for good: archiving hides a record from lists, and reports keep adding up. */
export async function archiveChild(c: pg.PoolClient, req: AuthedRequest, d: ChildDef, id: string, restore = false): Promise<Record<string, unknown>> {
  const existing = await getChild(c, d, id, true);
  if (!existing) throw new NotFoundException();
  if (restore ? !existing.archivedAt : !!existing.archivedAt) return existing;
  await c.query(`UPDATE ${d.table} SET archived_at = ${restore ? "NULL" : "now()"}${d.stamped === false ? "" : ", updated_at = now()"} WHERE id = $1`, [id]);
  const row = (await getChild(c, d, id))!;
  await auditChange(c, req, { action: `${d.entity}.${restore ? "restore" : "archive"}`, entity: d.entity, entityId: id, label: d.label(row), old: { archivedAt: existing.archivedAt }, next: { archivedAt: row.archivedAt }, sensitive: d.sensitive });
  return row;
}
