import { BadRequestException, ForbiddenException } from "@nestjs/common";
import type { pg } from "@routenorth/db";
import type { Response } from "express";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { toCsv, toXlsx } from "../reports/export.js";

/**
 * Shared helpers for the Owner Portal API.
 * Rules every portal endpoint follows (spec "Rules for the builder"):
 *  - money is whole cents (integers); dates are UTC timestamps or calendar dates;
 *  - nothing is deleted for good: records get archived_at, and reports keep adding up;
 *  - every change to a vehicle, driver or pay rate writes an audit row with old and new values.
 */

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function uuid(v: unknown, name = "id"): string {
  if (typeof v !== "string" || !UUID_RE.test(v)) throw new BadRequestException(`${name} must be an id`);
  return v;
}

export function str(v: unknown, name: string, o: { max?: number; required?: boolean } = {}): string | null {
  if (v === undefined || v === null || v === "") {
    if (o.required) throw new BadRequestException(`${name} is required`);
    return null;
  }
  if (typeof v !== "string") throw new BadRequestException(`${name} must be text`);
  const s = v.trim();
  if (o.required && !s) throw new BadRequestException(`${name} is required`);
  if (s.length > (o.max ?? 300)) throw new BadRequestException(`${name} is too long`);
  return s || null;
}

export function int(v: unknown, name: string, o: { min?: number; max?: number; required?: boolean } = {}): number | null {
  if (v === undefined || v === null || v === "") {
    if (o.required) throw new BadRequestException(`${name} is required`);
    return null;
  }
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) throw new BadRequestException(`${name} must be a whole number`);
  if (o.min !== undefined && n < o.min) throw new BadRequestException(`${name} must be at least ${o.min}`);
  if (o.max !== undefined && n > o.max) throw new BadRequestException(`${name} must be at most ${o.max}`);
  return n;
}

export function num(v: unknown, name: string, o: { min?: number; max?: number; required?: boolean } = {}): number | null {
  if (v === undefined || v === null || v === "") {
    if (o.required) throw new BadRequestException(`${name} is required`);
    return null;
  }
  const n = typeof v === "string" ? Number(v) : v;
  if (typeof n !== "number" || !Number.isFinite(n)) throw new BadRequestException(`${name} must be a number`);
  if (o.min !== undefined && n < o.min) throw new BadRequestException(`${name} must be at least ${o.min}`);
  if (o.max !== undefined && n > o.max) throw new BadRequestException(`${name} must be at most ${o.max}`);
  return n;
}

/** Money in the request body: whole cents only. Decimals ("12.34") are rejected on purpose so a float can never slip in. */
export function cents(v: unknown, name: string, o: { min?: number; required?: boolean } = {}): number | null {
  if (v === undefined || v === null || v === "") {
    if (o.required) throw new BadRequestException(`${name} is required`);
    return null;
  }
  if (typeof v !== "number" || !Number.isSafeInteger(v)) throw new BadRequestException(`${name} must be whole cents (an integer)`);
  if (v < (o.min ?? 0)) throw new BadRequestException(`${name} must be at least ${o.min ?? 0}`);
  return v;
}

export function dateOnly(v: unknown, name: string, required = false): string | null {
  if (v === undefined || v === null || v === "") {
    if (required) throw new BadRequestException(`${name} is required`);
    return null;
  }
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(v) || Number.isNaN(new Date(`${v}T00:00:00Z`).getTime())) throw new BadRequestException(`${name} must be YYYY-MM-DD`);
  return v;
}

export function oneOf<T extends string>(v: unknown, name: string, values: readonly T[], o: { required?: boolean } = {}): T | null {
  if (v === undefined || v === null || v === "") {
    if (o.required) throw new BadRequestException(`${name} is required`);
    return null;
  }
  if (typeof v !== "string" || !(values as readonly string[]).includes(v)) throw new BadRequestException(`${name} must be one of ${values.join(", ")}`);
  return v as T;
}

export function tags(v: unknown, name: string): string[] | null {
  if (v === undefined || v === null) return null;
  if (!Array.isArray(v) || v.length > 50 || v.some((x) => typeof x !== "string" || !x.trim() || x.length > 60)) throw new BadRequestException(`${name} must be a list of short text values`);
  return [...new Set((v as string[]).map((x) => x.trim()))];
}

export function body(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new BadRequestException("body must be an object");
  return v as Record<string, unknown>;
}

/** Only these keys may appear in the body. */
export function onlyKeys(o: Record<string, unknown>, allowed: readonly string[]): void {
  const extra = Object.keys(o).filter((k) => !allowed.includes(k));
  if (extra.length) throw new BadRequestException(`unknown field: ${extra.slice(0, 3).join(", ")}`);
}

/**
 * The regions (teams) a person is limited to, or null for "everything". Owners and admins always see everything.
 * Anyone else who has been put in one or more teams sees only those teams' vehicles and drivers.
 * A manager with no team yet keeps the company-wide view they had before regions existed.
 */
export async function regionScope(c: pg.PoolClient, req: AuthedRequest): Promise<string[] | null> {
  const role = req.session?.role;
  if (role === "owner" || role === "admin") return null;
  const r = await c.query<{ team_id: string }>("SELECT tm.team_id FROM team_members tm JOIN teams t ON t.id = tm.team_id AND t.org_id = tm.org_id WHERE tm.user_id = $1", [req.session!.userId]);
  return r.rows.length ? r.rows.map((x) => x.team_id) : null;
}

/** Company currency and time zone (money is stored in one fixed currency per company). */
export async function companyFormat(c: pg.PoolClient): Promise<{ currency: string; timezone: string }> {
  const r = (await c.query<{ currency: string | null; timezone: string }>("SELECT settings ->> 'currency' AS currency, timezone FROM organizations LIMIT 1")).rows[0];
  return { currency: r?.currency ?? "CAD", timezone: r?.timezone ?? "America/Toronto" };
}

export interface ExportColumn { key: string; label: string; type: "text" | "num" | "date" | "bool" }

/** Send rows as CSV or Excel. The file has exactly the rows and columns the caller passes (the same ones shown on screen). */
export function sendRows(res: Response, format: "csv" | "xlsx", name: string, columns: ExportColumn[], rows: Record<string, unknown>[]): void {
  const cols = columns.map((c) => ({ key: c.key, label: c.label, type: (c.type === "num" ? "num" : c.type === "date" ? "date" : c.type === "bool" ? "bool" : "text") as "num" | "date" | "bool" | "text" }));
  const safe = name.replace(/[^\w.-]+/g, "_").slice(0, 60) || "export";
  if (format === "xlsx") {
    res.setHeader("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    res.setHeader("Content-Disposition", `attachment; filename="${safe}.xlsx"`);
    res.send(Buffer.from(toXlsx({ columns: cols, rows }, safe)));
  } else {
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="${safe}.csv"`);
    res.send(toCsv({ columns: cols, rows }));
  }
}

export function requireAny(req: AuthedRequest, ...perms: string[]): string {
  if (!perms.some((p) => req.perms?.has(p as never))) throw new ForbiddenException();
  return req.session!.orgId;
}

/** A page of a list: ?limit=&offset=&q=&sort=&dir= with safe bounds. */
export function pageParams(q: Record<string, string | undefined>, sorts: readonly string[], defaultSort: string, max = 1000): { limit: number; offset: number; sort: string; dir: "ASC" | "DESC"; q: string | null } {
  const sort = q.sort && sorts.includes(q.sort) ? q.sort : defaultSort;
  return {
    limit: Math.min(max, Math.max(1, Number(q.limit) || 500)), offset: Math.max(0, Number(q.offset) || 0),
    sort, dir: q.dir === "desc" ? "DESC" : q.dir === "asc" ? "ASC" : "ASC", q: q.q ? q.q.slice(0, 80).replace(/[\\%_]/g, (m) => `\\${m}`) : null,
  };
}
