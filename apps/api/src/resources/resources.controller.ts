import {
  BadRequestException, Body, Controller, Delete, Get, Header, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards,
} from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import type { Response } from "express";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { parseUuid } from "../history/range.js";
import { PG_POOL } from "../tokens.js";
import { BY_NAME, REF_TABLES, RESOURCES, type Field, type ResourceDef } from "./defs.js";
import { csvEscape, parseBody, parseValue, selectList } from "./engine.js";

const MAX_LIMIT = 1000;

function def(name: string): ResourceDef {
  const d = BY_NAME.get(name);
  if (!d) throw new NotFoundException();
  return d;
}

/** Rows of every resource the caller may see, described for the web client (field names, types, choices). */
@Controller("r")
@UseGuards(AuthGuard)
export class ResourcesController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get("_schema")
  schema(@Req() req: AuthedRequest) {
    return RESOURCES.filter((r) => r.view.some((p) => req.perms?.has(p))).map((r) => ({
      name: r.name, canWrite: !!req.perms?.has(r.write),
      fields: r.fields.map((f) => ({ key: f.key, type: f.type, required: !!f.required, values: f.values, ref: f.ref, heavy: !!f.heavy, min: f.min, max: f.max })),
    }));
  }

  /** Check that every referenced id exists in this organization (Row-Level Security hides other organizations' rows). */
  private async checkRefs(c: pg.PoolClient, d: ResourceDef, v: Record<string, unknown>, existing: Record<string, unknown> | null): Promise<void> {
    for (const f of d.fields) {
      if (f.type !== "ref" || v[f.key] == null) continue;
      let target = f.ref!;
      if (target === "@owner") {
        const kind = String(v.ownerKind ?? existing?.ownerKind);
        target = kind === "driver" ? "drivers" : kind === "equipment" ? "equipment" : "vehicles";
      }
      const rt = REF_TABLES[target];
      if (!rt) throw new Error(`no ref table for ${target}`);
      const found = await c.query(`SELECT 1 FROM ${rt.table} WHERE id = $1 ${rt.where ? `AND ${rt.where}` : ""}`, [v[f.key]]);
      if (found.rowCount === 0) throw new BadRequestException(`${f.key} does not exist`);
    }
  }

  private runCheck(d: ResourceDef, merged: Record<string, unknown>, existing: Record<string, unknown> | null): void {
    try { d.check?.(merged, existing); } catch (e) { throw new BadRequestException(e instanceof Error ? e.message : "invalid"); }
  }

  private filterSql(d: ResourceDef, query: Record<string, string | undefined>, params: unknown[]): string {
    const where: string[] = [];
    for (const f of d.fields) {
      if (!f.filter || query[f.key] === undefined) continue;
      const v = parseValue({ ...f, required: false }, query[f.key]);
      params.push(v);
      where.push(`${d.table}.${f.col} = $${params.length}`);
    }
    if (query.q) {
      params.push(`%${query.q.slice(0, 80).replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
      where.push(`(${d.search.map((c) => `${d.table}.${c}::text ILIKE $${params.length}`).join(" OR ")})`);
    }
    return where.length ? `WHERE ${where.join(" AND ")}` : "";
  }

  @Get(":resource")
  async list(@Req() req: AuthedRequest, @Param("resource") name: string, @Query() query: Record<string, string | undefined>, @Res() res: Response) {
    const d = def(name);
    requirePerm(req, ...d.view);
    const params: unknown[] = [];
    const where = this.filterSql(d, query, params);
    const csv = query.format === "csv";
    const limit = Math.min(MAX_LIMIT, Math.max(1, Number(query.limit) || 500));
    const offset = Math.max(0, Number(query.offset) || 0);
    const rows = await withOrg(this.pool, req.session!.orgId, (c) =>
      c.query(`SELECT ${selectList(d)} FROM ${d.table} ${where} ORDER BY ${d.order} LIMIT ${csv ? 50_000 : limit} OFFSET ${csv ? 0 : offset}`, params),
    );
    if (csv) {
      requirePerm(req, "reports.export");
      const cols = ["id", ...d.fields.filter((f) => !f.heavy).map((f) => f.key)];
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="${d.name}.csv"`);
      res.send([cols.join(","), ...rows.rows.map((r) => cols.map((c) => csvEscape(r[c])).join(","))].join("\r\n"));
      return;
    }
    res.json(rows.rows);
  }

  @Get(":resource/:id")
  async get(@Req() req: AuthedRequest, @Param("resource") name: string, @Param("id") id: string) {
    const d = def(name);
    requirePerm(req, ...d.view);
    const row = (await withOrg(this.pool, req.session!.orgId, (c) =>
      c.query(`SELECT ${selectList(d, true)} FROM ${d.table} WHERE ${d.table}.id = $1`, [parseUuid(id)]),
    )).rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post(":resource")
  async create(@Req() req: AuthedRequest, @Param("resource") name: string, @Body() body: unknown) {
    const d = def(name);
    const orgId = requirePerm(req, d.write);
    const v = parseBody(d, body, true);
    this.runCheck(d, v, null);
    return withOrg(this.pool, orgId, async (c) => {
      await this.checkRefs(c, d, v, null);
      const fields = d.fields.filter((f) => v[f.key] !== undefined);
      const cols = ["org_id", ...fields.map((f) => f.col)];
      const vals = [orgId, ...fields.map((f) => encode(f, v[f.key]))];
      const row = (await c.query(
        `INSERT INTO ${d.table} (${cols.join(",")}) VALUES (${vals.map((_, i) => `$${i + 1}`).join(",")}) RETURNING ${selectList(d, true)}`, vals,
      )).rows[0];
      return row;
    });
  }

  @Patch(":resource/:id")
  async update(@Req() req: AuthedRequest, @Param("resource") name: string, @Param("id") id: string, @Body() body: unknown) {
    const d = def(name);
    const orgId = requirePerm(req, d.write);
    const rid = parseUuid(id);
    const v = parseBody(d, body, false);
    if (Object.keys(v).length === 0) throw new BadRequestException("nothing to change");
    return withOrg(this.pool, orgId, async (c) => {
      const existing = (await c.query(`SELECT ${selectList(d, true)} FROM ${d.table} WHERE ${d.table}.id = $1 FOR UPDATE`, [rid])).rows[0];
      if (!existing) throw new NotFoundException();
      this.runCheck(d, { ...existing, ...v }, existing);
      await this.checkRefs(c, d, v, existing);
      const fields = d.fields.filter((f) => v[f.key] !== undefined);
      const sets = fields.map((f, i) => `${f.col} = $${i + 2}`);
      const touch = d.table === "jobs" ? ", updated_at = now()" : "";
      return (await c.query(
        `UPDATE ${d.table} SET ${sets.join(", ")}${touch} WHERE id = $1 RETURNING ${selectList(d, true)}`,
        [rid, ...fields.map((f) => encode(f, v[f.key]))],
      )).rows[0];
    });
  }

  @Delete(":resource/:id")
  @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param("resource") name: string, @Param("id") id: string) {
    const d = def(name);
    const orgId = requirePerm(req, d.write);
    const rid = parseUuid(id);
    const n = await withOrg(this.pool, orgId, async (c) => {
      // Records that point at this one by a plain id are cleared or removed with it.
      if (d.name === "vehicles") {
        await c.query("DELETE FROM documents WHERE owner_kind = 'vehicle' AND owner_id = $1", [rid]);
        await c.query("DELETE FROM maintenance_plans WHERE vehicle_id = $1", [rid]);
        await c.query("DELETE FROM maintenance_logs WHERE vehicle_id = $1", [rid]);
        await c.query("DELETE FROM fuel_logs WHERE vehicle_id = $1", [rid]);
        await c.query("DELETE FROM inspections WHERE vehicle_id = $1", [rid]);
        await c.query("UPDATE incidents SET vehicle_id = NULL WHERE vehicle_id = $1", [rid]);
        await c.query("UPDATE equipment SET vehicle_id = NULL WHERE vehicle_id = $1", [rid]);
        await c.query("UPDATE jobs SET vehicle_id = NULL WHERE vehicle_id = $1", [rid]);
        await c.query("UPDATE route_templates SET vehicle_id = NULL WHERE vehicle_id = $1", [rid]);
      }
      if (d.name === "depots") {
        await c.query("UPDATE vehicles SET depot_id = NULL WHERE depot_id = $1", [rid]);
        await c.query("UPDATE equipment SET depot_id = NULL WHERE depot_id = $1", [rid]);
        await c.query("UPDATE route_templates SET depot_id = NULL WHERE depot_id = $1", [rid]);
        await c.query("UPDATE routes SET depot_id = NULL WHERE depot_id = $1", [rid]);
      }
      if (d.name === "equipment") await c.query("DELETE FROM documents WHERE owner_kind = 'equipment' AND owner_id = $1", [rid]);
      if (d.name === "maintenance-plans") await c.query("UPDATE maintenance_logs SET plan_id = NULL WHERE plan_id = $1", [rid]);
      if (d.name === "geofences") {
        await c.query("DELETE FROM geofence_events WHERE geofence_id = $1", [rid]);
        await c.query("DELETE FROM geofence_state WHERE geofence_id = $1", [rid]);
      }
      if (d.name === "jobs") await c.query("DELETE FROM job_events WHERE job_id = $1", [rid]);
      if (d.name === "incidents") await c.query("DELETE FROM attachments WHERE owner_kind = 'incident' AND owner_id = $1", [rid]);
      return (await c.query(`DELETE FROM ${d.table} WHERE id = $1`, [rid])).rowCount;
    });
    if (!n) throw new NotFoundException();
  }
}

function encode(f: Field, v: unknown): unknown {
  return f.type === "json" && v !== null ? JSON.stringify(v) : v;
}
