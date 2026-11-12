import { BadRequestException, Body, Controller, Get, HttpCode, Inject, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { accessMatrix } from "@routenorth/shared";
import type { Response } from "express";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard.js";
import { PG_POOL } from "../tokens.js";
import { body as parseBody, requireAny, sendRows, type ExportColumn } from "./common.js";

const MAX_ROWS = 50_000;

/**
 * Every list and report in the portal exports through here: CSV or Excel, with exactly the rows and columns on screen.
 * The export is written to the audit log with the filters it was made with (spec: "Every create, edit, archive, export ... is logged").
 */
@Controller("portal")
@UseGuards(AuthGuard)
export class PortalExportController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Post("export")
  @HttpCode(200)
  async export(@Req() req: AuthedRequest, @Res() res: Response, @Body() raw: unknown, @Query("format") format?: string): Promise<void> {
    const orgId = requireAny(req, "fleet.view", "vehicles.manage", "drivers.view", "pay.view", "finance.view", "reports.view", "reports.export");
    if (format !== "csv" && format !== "xlsx") throw new BadRequestException("format must be csv or xlsx");
    const b = parseBody(raw);
    const columns = b.columns as ExportColumn[];
    const rows = b.rows as Record<string, unknown>[];
    if (!Array.isArray(columns) || columns.length === 0 || columns.length > 80 || columns.some((c) => !c || typeof c.key !== "string" || typeof c.label !== "string")) throw new BadRequestException("columns must be a list of { key, label, type }");
    if (!Array.isArray(rows) || rows.length > MAX_ROWS) throw new BadRequestException(`rows must be a list of at most ${MAX_ROWS}`);
    const title = typeof b.title === "string" ? b.title.slice(0, 80) : "export";
    await withOrg(this.pool, orgId, (c) => c.query(
      `INSERT INTO audit_log (org_id, actor_id, actor_label, action, entity, item_label, method, path, status, ip, detail) VALUES ($1,$2,$3,'export','export',$4,'POST','/portal/export',200,$5,$6)`,
      [orgId, req.session!.userId, req.actor?.email ?? null, title, req.ip ?? null, JSON.stringify({ format, rows: rows.length, columns: columns.length, filters: typeof b.filters === "object" ? b.filters : undefined })]));
    req.auditDone = true;
    sendRows(res, format, title, columns, rows);
  }
}


/** The role matrix, worked out from the permissions the API enforces (so the screen cannot disagree with the rules). */
@Controller("portal")
@UseGuards(AuthGuard)
export class PortalAccessController {
  @Get("roles-matrix")
  matrix(@Req() req: AuthedRequest) {
    requireAny(req, "users.view", "settings.manage", "roles.manage");
    return accessMatrix();
  }
}
