import { BadRequestException, Controller, Get, Inject, Query, Req, Res, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import type { Response } from "express";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { PG_POOL } from "../tokens.js";

const COLUMNS = `id, at, actor_id AS "actorId", actor_label AS "actor", action, entity, entity_id AS "entityId", method, path, status, detail, ip`;
const csvCell = (v: unknown) => {
  const s = v === null || v === undefined ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s;
};

@Controller("audit")
@UseGuards(AuthGuard)
export class AuditController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Who changed what and when. Newest first. Filters: actor, entity, q (action/path text), from, to. */
  @Get()
  async list(
    @Req() req: AuthedRequest, @Res({ passthrough: true }) res: Response,
    @Query("actor") actor?: string, @Query("entity") entity?: string, @Query("q") q?: string,
    @Query("from") from?: string, @Query("to") to?: string, @Query("before") before?: string,
    @Query("limit") limit?: string, @Query("format") format?: string,
  ) {
    const orgId = requirePerm(req, "audit.view");
    const date = (v: string | undefined, name: string) => {
      if (!v) return null;
      const d = new Date(v);
      if (Number.isNaN(d.getTime())) throw new BadRequestException(`${name} must be a date`);
      return d;
    };
    const max = Math.min(Math.max(Number(limit) || 100, 1), format === "csv" ? 5000 : 500);
    const like = q ? `%${q.replace(/[\\%_]/g, "\\$&")}%` : null;
    const rows = (
      await withOrg(this.pool, orgId, (c) =>
        c.query(
          `SELECT ${COLUMNS} FROM audit_log
           WHERE ($1::text IS NULL OR actor_label ILIKE $1) AND ($2::text IS NULL OR entity = $2)
             AND ($3::text IS NULL OR action ILIKE $3 OR path ILIKE $3 OR actor_label ILIKE $3)
             AND ($4::timestamptz IS NULL OR at >= $4) AND ($5::timestamptz IS NULL OR at < $5)
             AND ($6::timestamptz IS NULL OR at < $6)
           ORDER BY at DESC LIMIT ${max}`,
          [actor ? `%${actor.replace(/[\\%_]/g, "\\$&")}%` : null, entity ?? null, like, date(from, "from"), date(to, "to"), date(before, "before")],
        ),
      )
    ).rows;
    if (format === "csv") {
      res.type("text/csv").setHeader("Content-Disposition", 'attachment; filename="audit-log.csv"');
      const head = ["time", "actor", "action", "entity", "entity_id", "method", "path", "status", "detail", "ip"];
      const lines = rows.map((r) => [new Date(r.at).toISOString(), r.actor, r.action, r.entity, r.entityId, r.method, r.path, r.status, r.detail, r.ip].map(csvCell).join(","));
      return [head.join(","), ...lines].join("\n");
    }
    return rows;
  }
}
