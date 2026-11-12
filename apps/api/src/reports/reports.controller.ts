import { createHash, randomBytes } from "node:crypto";
import { BadRequestException, Body, Controller, Delete, Get, HttpCode, HttpException, Inject, NotFoundException, Param, Post, Put, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { pg, withOrg } from "@routenorth/db";
import { periodBefore } from "@routenorth/shared";
import { AnalyticsService, checkRange, summarize } from "../analytics/analytics.service.js";
import { buildInsights } from "../analytics/insights.js";
import { AuthGuard, requirePerm, requireAny, type AuthedRequest } from "../auth/auth.guard.js";
import { parseUuid } from "../history/range.js";
import { deliver, type Endpoint, type Providers } from "../notify/notifier.js";
import { NOTIFY, PG_POOL } from "../tokens.js";
import { datasetInfo, runReport, validateSpec, type ReportResult, type ReportSpec } from "./datasets.js";
import { executivePdf, toCsv, toPdf, toXlsx, type Brand } from "./export.js";
import { REPORT_TEMPLATES } from "./templates.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const hits = new Map<string, { n: number; reset: number }>();
function limit(key: string, perMinute: number) {
  const now = Date.now(); const h = hits.get(key);
  if (!h || h.reset < now) { if (hits.size > 5000) hits.clear(); hits.set(key, { n: 1, reset: now + 60_000 }); return; }
  if (++h.n > perMinute) throw new HttpException("too many requests", 429);
}

export async function orgToday(pool: pg.Pool, orgId: string) {
  return (await withOrg(pool, orgId, (c) => c.query<{ d: string; name: string; color: string | null; logo: string | null; locale: string }>(
    "SELECT (now() AT TIME ZONE timezone)::date::text AS d, coalesce(brand_name, name) AS name, brand_color AS color, logo_data_url AS logo, locale FROM organizations"))).rows[0]!;
}
export const brandOf = (o: { name: string; color: string | null; logo: string | null }): Brand => ({ name: o.name, color: o.color, logoDataUrl: o.logo });

export type Format = "csv" | "xlsx" | "pdf";
const TYPES: Record<Format, string> = { csv: "text/csv; charset=utf-8", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", pdf: "application/pdf" };

export async function render(format: Format, result: ReportResult, o: { title: string; brand: Brand; labels?: Record<string, string> }): Promise<{ data: Buffer; type: string; ext: string }> {
  if (format === "csv") return { data: Buffer.from(toCsv(result, o.labels), "utf8"), type: TYPES.csv, ext: "csv" };
  if (format === "xlsx") return { data: Buffer.from(toXlsx(result, o.title, o.labels)), type: TYPES.xlsx, ext: "xlsx" };
  return { data: await toPdf(result, { brand: o.brand, title: o.title, labels: o.labels }), type: TYPES.pdf, ext: "pdf" };
}

const cleanLabels = (x: unknown): Record<string, string> => {
  const out: Record<string, string> = {};
  if (x && typeof x === "object") for (const [k, v] of Object.entries(x as Record<string, unknown>).slice(0, 100)) if (typeof v === "string" && v.length <= 80) out[k] = v;
  return out;
};
const fileName = (s: string) => (s.replace(/[^\w.\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "report");

@Controller("reports")
@UseGuards(AuthGuard)
export class ReportsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(AnalyticsService) private readonly svc: AnalyticsService, @Inject(NOTIFY) private readonly notify: Providers) {}

  @Get("datasets")
  datasets(@Req() req: AuthedRequest) { requirePerm(req, "reports.view"); return datasetInfo(); }

  @Get("templates")
  templates(@Req() req: AuthedRequest) { requirePerm(req, "reports.view"); return REPORT_TEMPLATES; }

  /** Compute a report. The browser cannot add its own row limits: scope comes only from share links. */
  private async execute(req: AuthedRequest, raw: unknown): Promise<{ result: ReportResult; brand: Brand; locale: string }> {
    const orgId = requirePerm(req, "reports.view");
    const spec = validateSpec(raw);
    delete spec.scope;
    const org = await orgToday(this.pool, orgId);
    return { result: await runReport(spec, { pool: this.pool, orgId, svc: this.svc, today: org.d }), brand: brandOf(org), locale: org.locale };
  }

  @Post("run")
  @HttpCode(200)
  async run(@Req() req: AuthedRequest, @Body() body: { spec?: unknown }) { return (await this.execute(req, body?.spec)).result; }

  /** Download as CSV, Excel or branded PDF. */
  @Post("export")
  @HttpCode(200)
  async export(@Req() req: AuthedRequest, @Res() res: Response, @Query("format") format: string, @Body() body: { spec?: unknown; title?: unknown; labels?: unknown }) {
    if (!["csv", "xlsx", "pdf"].includes(format)) throw new BadRequestException("format must be csv, xlsx or pdf");
    requirePerm(req, "reports.export");
    const { result, brand } = await this.execute(req, body?.spec);
    const title = typeof body?.title === "string" && body.title.trim() ? body.title.trim().slice(0, 120) : result.dataset;
    const out = await render(format as Format, result, { title, brand, labels: cleanLabels(body?.labels) });
    res.setHeader("Content-Type", out.type);
    res.setHeader("Content-Disposition", `attachment; filename="${fileName(title)}-${result.range.from}.${out.ext}"`);
    res.send(out.data);
  }

  /** One-page executive summary as a PDF. */
  @Get("executive.pdf")
  async executive(@Req() req: AuthedRequest, @Res() res: Response, @Query() q: Record<string, string>) {
    const orgId = requirePerm(req, "reports.view", "reports.export");
    const org = await orgToday(this.pool, orgId);
    const range = checkRange(q.from, q.to);
    const b = await this.svc.load(orgId, range);
    const before = periodBefore(new Date(`${range.from}T00:00:00Z`), new Date(`${range.to}T00:00:00Z`), "prev");
    const len = Math.round((Date.parse(range.to) - Date.parse(range.from)) / 86_400_000) + 1;
    const prevRange = { from: new Date(Date.parse(range.from) - len * 86_400_000).toISOString().slice(0, 10), to: new Date(Date.parse(range.from) - 86_400_000).toISOString().slice(0, 10) };
    void before;
    const prev = await this.svc.load(orgId, prevRange);
    const metrics = summarize(b), previous = summarize(prev);
    const pdf = await executivePdf({ brand: brandOf(org), range, metrics, previous, insights: buildInsights(b, metrics, previous), lang: q.lang === "fr" || org.locale === "fr" ? "fr" : "en" });
    res.setHeader("Content-Type", TYPES.pdf);
    res.setHeader("Content-Disposition", `attachment; filename="executive-summary-${range.to}.pdf"`);
    res.send(pdf);
  }

  // ---- saved reports, with history ----

  @Get("saved")
  async list(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "reports.view");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT id, name, spec, shared, version, owner_id = $1 AS mine, updated_at AS "updatedAt" FROM report_defs WHERE shared OR owner_id = $1 ORDER BY name`, [req.session!.userId]))).rows;
  }

  @Post("saved")
  async create(@Req() req: AuthedRequest, @Body() body: { name?: unknown; spec?: unknown; shared?: unknown }) {
    const orgId = requirePerm(req, "reports.manage");
    const name = typeof body?.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 120) throw new BadRequestException("name is required (up to 120 characters)");
    const spec = validateSpec(body?.spec); delete spec.scope;
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query("INSERT INTO report_defs (org_id, owner_id, name, spec, shared) VALUES ($1,$2,$3,$4,$5) RETURNING id, version", [orgId, req.session!.userId, name, spec, body?.shared === true])).rows[0];
      await c.query("INSERT INTO report_versions (org_id, report_id, version, name, spec, saved_by) VALUES ($1,$2,1,$3,$4,$5)", [orgId, r.id, name, spec, req.session!.userId]);
      return r;
    });
  }

  @Put("saved/:id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { name?: unknown; spec?: unknown; shared?: unknown; note?: unknown }) {
    const orgId = requirePerm(req, "reports.manage");
    const rid = parseUuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const cur = (await c.query("SELECT * FROM report_defs WHERE id = $1 FOR UPDATE", [rid])).rows[0];
      if (!cur) throw new NotFoundException();
      if (cur.owner_id !== req.session!.userId && !req.perms?.has("settings.manage")) throw new HttpException("only the owner can change this report", 403);
      const name = body?.name === undefined ? cur.name : String(body.name).trim().slice(0, 120);
      if (!name) throw new BadRequestException("name is required");
      const spec = body?.spec === undefined ? cur.spec : validateSpec(body.spec);
      delete spec.scope;
      const changed = name !== cur.name || JSON.stringify(spec) !== JSON.stringify(cur.spec);
      const version = changed ? cur.version + 1 : cur.version;
      await c.query("UPDATE report_defs SET name = $2, spec = $3, shared = $4, version = $5, updated_at = now() WHERE id = $1", [rid, name, spec, body?.shared === undefined ? cur.shared : body.shared === true, version]);
      if (changed) await c.query("INSERT INTO report_versions (org_id, report_id, version, name, spec, saved_by, note) VALUES ($1,$2,$3,$4,$5,$6,$7)", [orgId, rid, version, name, spec, req.session!.userId, body?.note ? String(body.note).slice(0, 200) : null]);
      return { id: rid, version };
    });
  }

  @Delete("saved/:id")
  @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "reports.manage");
    const n = (await withOrg(this.pool, orgId, (c) => c.query("DELETE FROM report_defs WHERE id = $1 AND (owner_id = $2 OR $3)", [parseUuid(id), req.session!.userId, !!req.perms?.has("settings.manage")]))).rowCount;
    if (!n) throw new NotFoundException();
  }

  @Get("saved/:id/versions")
  async versions(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "reports.view");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT v.version, v.name, v.spec, v.saved_at AS "savedAt", v.note, coalesce(u.display_name, u.email) AS "savedBy" FROM report_versions v LEFT JOIN users u ON u.id = v.saved_by WHERE v.report_id = $1 ORDER BY v.version DESC`, [parseUuid(id)]))).rows;
  }

  @Post("saved/:id/restore/:version")
  @HttpCode(200)
  async restore(@Req() req: AuthedRequest, @Param("id") id: string, @Param("version") version: string) {
    const orgId = requirePerm(req, "reports.manage");
    const rid = parseUuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const old = (await c.query("SELECT name, spec FROM report_versions WHERE report_id = $1 AND version = $2", [rid, Number(version)])).rows[0];
      if (!old) throw new NotFoundException();
      const cur = (await c.query("SELECT version FROM report_defs WHERE id = $1 FOR UPDATE", [rid])).rows[0];
      if (!cur) throw new NotFoundException();
      const v = cur.version + 1;
      await c.query("UPDATE report_defs SET name = $2, spec = $3, version = $4, updated_at = now() WHERE id = $1", [rid, old.name, old.spec, v]);
      await c.query("INSERT INTO report_versions (org_id, report_id, version, name, spec, saved_by, note) VALUES ($1,$2,$3,$4,$5,$6,$7)", [orgId, rid, v, old.name, old.spec, req.session!.userId, `Restored version ${version}`]);
      return { id: rid, version: v };
    });
  }

  // ---- share links ----

  /** A public link to the current results (until it expires). `scope` limits it to one driver, vehicle or depot. */
  @Post("saved/:id/share")
  async share(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { days?: unknown; scope?: { driverId?: string; vehicleId?: string; depotId?: string } }) {
    const orgId = requirePerm(req, "reports.manage");
    const days = body?.days == null ? 7 : Number(body.days);
    if (!(days >= 1 && days <= 90)) throw new BadRequestException("days must be 1 to 90");
    const scope = { driverId: body?.scope?.driverId ? parseUuid(body.scope.driverId) : null, vehicleId: body?.scope?.vehicleId ? parseUuid(body.scope.vehicleId) : null, depotId: body?.scope?.depotId ? parseUuid(body.scope.depotId) : null };
    const token = randomBytes(24).toString("base64url");
    return withOrg(this.pool, orgId, async (c) => {
      const def = (await c.query("SELECT id, name, spec FROM report_defs WHERE id = $1", [parseUuid(id)])).rows[0];
      if (!def) throw new NotFoundException();
      const row = (await c.query(
        `INSERT INTO report_shares (org_id, report_id, name, spec, token_hash, expires_at, created_by) VALUES ($1,$2,$3,$4,$5, now() + make_interval(days => $6), $7) RETURNING id, expires_at AS "expiresAt"`,
        [orgId, def.id, def.name, { ...def.spec, scope }, sha(token), days, req.session!.userId])).rows[0];
      return { ...row, token, path: `/shared/report/${token}`, csvPath: `/public/report/${token}?format=csv` };
    });
  }

  @Get("shares")
  async shares(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "reports.manage");
    return (await withOrg(this.pool, orgId, (c) => c.query(`SELECT id, report_id AS "reportId", name, expires_at AS "expiresAt", revoked_at AS "revokedAt", created_at AS "createdAt" FROM report_shares ORDER BY created_at DESC LIMIT 200`))).rows;
  }

  @Delete("shares/:id")
  @HttpCode(204)
  async revoke(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "reports.manage");
    const n = (await withOrg(this.pool, orgId, (c) => c.query("UPDATE report_shares SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [parseUuid(id)]))).rowCount;
    if (!n) throw new NotFoundException();
  }

  /** Send a saved report to its destinations right now (handy for testing a schedule). */
  @Post("saved/:id/send")
  @HttpCode(200)
  async sendNow(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { endpointIds?: unknown; format?: unknown }) {
    const orgId = requirePerm(req, "reports.manage");
    const ids = Array.isArray(body?.endpointIds) ? body.endpointIds.map(String).slice(0, 10) : [];
    if (!ids.length) throw new BadRequestException("choose where to send it");
    const format = (["csv", "xlsx", "pdf"].includes(String(body?.format)) ? body!.format : "csv") as Format;
    return sendReport(this.pool, this.svc, this.notify, orgId, parseUuid(id), ids, format, req.session!.userId);
  }
}

/** Run a saved report and deliver it. Used by "send now" and by the schedule runner. */
export async function sendReport(pool: pg.Pool, svc: AnalyticsService, notify: Providers, orgId: string, reportId: string, endpointIds: string[], format: Format, userId: string | null) {
  const def = (await withOrg(pool, orgId, (c) => c.query("SELECT name, spec FROM report_defs WHERE id = $1", [reportId]))).rows[0];
  if (!def) throw new NotFoundException();
  const endpoints = (await withOrg(pool, orgId, (c) => c.query<Endpoint & { enabled: boolean }>("SELECT id, kind, target, label, enabled FROM notification_endpoints WHERE id = ANY($1::uuid[])", [endpointIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x))]))).rows.filter((e) => e.enabled);
  if (!endpoints.length) throw new BadRequestException("none of those destinations are set up");
  const org = await orgToday(pool, orgId);
  const spec = validateSpec(def.spec);
  const result = await runReport(spec, { pool, orgId, svc, today: org.d });
  const out = await render(format, result, { title: def.name, brand: brandOf(org) });
  // Chat tools cannot take file uploads, so they get a summary and a link that opens the results for a week.
  const token = randomBytes(24).toString("base64url");
  await withOrg(pool, orgId, (c) => c.query("INSERT INTO report_shares (org_id, name, spec, token_hash, expires_at, created_by) VALUES ($1,$2,$3,$4, now() + interval '7 days', $5)", [orgId, def.name, spec, sha(token), userId]));
  const base = process.env.PUBLIC_WEB_URL ?? "http://localhost:3000";
  const top = result.rows.slice(0, 8).map((r) => result.columns.slice(0, 4).map((c) => String(r[c.key] ?? "")).join(" · ")).join("\n");
  const results: { endpoint: string; ok: boolean; error?: string }[] = [];
  for (const ep of endpoints) {
    const r = await deliver(ep, { subject: `${def.name} (${result.range.from} – ${result.range.to})`, text: `${result.total} rows.\n${top}`, link: `${base}/shared/report/${token}`, attachments: ep.kind === "email" ? [{ name: `${fileName(def.name)}.${out.ext}`, contentType: out.type, data: out.data }] : [] }, notify);
    results.push({ endpoint: ep.label, ...(r.ok ? { ok: true } : { ok: false, error: r.error }) });
  }
  return { rows: result.total, results };
}

/** What people with a share link see: the results only, no sign-in. */
@Controller("public")
export class PublicReportController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(AnalyticsService) private readonly svc: AnalyticsService) {}

  @Get("report/:token")
  async report(@Req() req: AuthedRequest, @Res() res: Response, @Param("token") token: string, @Query("format") format?: string) {
    limit(`${req.ip ?? "?"}`, 60);
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException();
    const link = (await this.pool.query("SELECT id, org_id, name, spec, expires_at FROM resolve_report_share($1)", [sha(token)])).rows[0];
    if (!link) throw new NotFoundException();
    const org = await orgToday(this.pool, link.org_id);
    const result = await runReport(validateSpec(link.spec), { pool: this.pool, orgId: link.org_id, svc: this.svc, today: org.d });
    if (format === "csv") { res.setHeader("Content-Type", TYPES.csv); res.send(toCsv(result)); return; }
    if (format === "xlsx" || format === "pdf") { const out = await render(format, result, { title: link.name, brand: brandOf(org) }); res.setHeader("Content-Type", out.type); res.send(out.data); return; }
    res.json({ name: link.name, expiresAt: link.expires_at, org: { name: org.name, color: org.color, logo: org.logo }, result: { ...result, spec: { ...result.spec, scope: undefined } } });
  }
}

export { requireAny };
export type { ReportSpec };
