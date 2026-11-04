import { BadRequestException, Body, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import type { Response } from "express";
import { strToU8, zipSync } from "fflate";
import { pg, withOrg } from "@routenorth/db";
import { AnalyticsService } from "../analytics/analytics.service.js";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard.js";
import { auditChange } from "../audit/domain-audit.js";
import { assertDatasetAllowed, datasetInfo, runReport, validateSpec, type ReportResult, type ReportSpec } from "../reports/datasets.js";
import { CATALOG, CATALOG_BY_ID, GROUP_NAMES } from "../reports/catalog.js";
import { toCsv, toPdf } from "../reports/export.js";
import { brandOf, orgToday, render, type Format } from "../reports/reports.controller.js";
import { draftFromText, filtersText, forExport, previousPeriod, sameLastYear } from "../reports/report-utils.js";
import { PG_POOL } from "../tokens.js";
import { body as asBody, companyFormat, regionScope, requireAny, str, uuid } from "./common.js";

const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Everything the owner portal's Reports area does: the 56 ready-made reports, running any report with compare and drill-down, exports, favourites, pins, comments, folders and drafts from plain words. */
@Controller("portal/reports")
@UseGuards(AuthGuard)
export class PortalReportsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(AnalyticsService) private readonly svc: AnalyticsService) {}

  private view(req: AuthedRequest) { return requireAny(req, "reports.view"); }

  private allowed(req: AuthedRequest, spec: ReportSpec) {
    try { assertDatasetAllowed(spec, req.perms); return true; } catch { return false; }
  }

  /** Work out the spec to run (a ready-made report or one from the builder), apply the person's region, and run it. */
  private async execute(req: AuthedRequest, b: { id?: unknown; spec?: unknown; from?: unknown; to?: unknown; compare?: unknown }) {
    const orgId = this.view(req);
    let spec: ReportSpec; let name: string; let id: string | null = null;
    if (typeof b.id === "string" && b.id) {
      if (isUuid(b.id)) {
        const def = (await withOrg(this.pool, orgId, (c) => c.query("SELECT name, spec FROM report_defs WHERE id = $1 AND (shared OR owner_id = $2)", [b.id, req.session!.userId]))).rows[0];
        if (!def) throw new NotFoundException();
        spec = validateSpec(def.spec); name = def.name;
      } else {
        const cat = CATALOG_BY_ID.get(b.id.toUpperCase()); if (!cat) throw new NotFoundException();
        spec = structuredClone(cat.spec); name = cat.name; id = cat.id;
      }
    } else { spec = validateSpec(b.spec); name = spec.title ?? spec.dataset; }
    delete spec.scope;
    if (typeof b.from === "string" || typeof b.to === "string") {
      const org = await orgToday(this.pool, orgId);
      const cur = { from: DAY.test(String(b.from)) ? String(b.from) : (spec.range?.from ?? org.d), to: DAY.test(String(b.to)) ? String(b.to) : (spec.range?.to ?? org.d) };
      if (cur.to < cur.from) throw new BadRequestException("to cannot be before from");
      spec.range = cur;
    }
    assertDatasetAllowed(spec, req.perms);
    const org = await orgToday(this.pool, orgId);
    const { teams, currency } = await withOrg(this.pool, orgId, async (c) => ({ teams: await regionScope(c, req), currency: (await companyFormat(c)).currency }));
    if (teams) spec.scope = { teamIds: teams };
    const ctx = { pool: this.pool, orgId, svc: this.svc, today: org.d, perms: req.perms as ReadonlySet<string> | undefined };
    const result = await runReport(spec, ctx);
    let previous: { kind: string; range: { from: string; to: string }; totals: Record<string, number | null>; byKey: Record<string, Record<string, number | null>> } | null = null;
    const mode = b.compare === "year" ? "year" : b.compare === true || b.compare === "1" || b.compare === "prev" ? "prev" : null;
    if (mode && !(id && CATALOG_BY_ID.get(id)?.fixedRange)) {
      const range = mode === "year" ? sameLastYear(result.range) : previousPeriod(result.range);
      const prev = await runReport({ ...spec, range }, ctx);
      const group = spec.groupBy ?? [];
      const byKey: Record<string, Record<string, number | null>> = {};
      if (group.length) for (const r of prev.rows) byKey[group.map((g) => String(r[g] ?? "")).join("|")] = Object.fromEntries(prev.columns.filter((c) => c.type !== "text" && c.type !== "date").map((c) => [c.key, typeof r[c.key] === "number" ? (r[c.key] as number) : null]));
      previous = { kind: mode === "year" ? "same period last year" : "previous period", range, totals: prev.totals, byKey };
    }
    const cat = id ? CATALOG_BY_ID.get(id) : undefined;
    return { result, org, currency, name, id, previous, spec, region: !!teams, meta: cat ? { status: cat.status, note: cat.note ?? null, specChart: cat.specChart, drill: cat.drill ?? null, fixedRange: !!cat.fixedRange, groupBy: cat.groupBy ?? null, question: cat.question } : null };
  }

  private payload(x: Awaited<ReturnType<PortalReportsController["execute"]>>) {
    return { id: x.id, name: x.name, ...x.result, spec: { ...x.result.spec, scope: undefined }, currency: x.currency, generatedAt: new Date().toISOString(), filters: filtersText(x.spec), previous: x.previous, region: x.region, meta: x.meta };
  }

  // ---- the catalog, the builder's data sources, and "ask in plain words" ----------------------------------------------------

  @Get("catalog")
  async catalog(@Req() req: AuthedRequest) {
    const orgId = this.view(req);
    return withOrg(this.pool, orgId, async (c) => {
      const me = req.session!.userId;
      const prefs = new Map((await c.query(`SELECT report_ref AS ref, favorite, pinned, last_opened_at AS "lastOpenedAt" FROM portal_report_prefs WHERE user_id = $1`, [me])).rows.map((r) => [r.ref as string, r]));
      const saved = (await c.query(`SELECT id, name, spec, shared, folder, owner_id = $1 AS mine, updated_at AS "updatedAt", version FROM report_defs WHERE shared OR owner_id = $1 ORDER BY name`, [me])).rows;
      const p = (ref: string) => ({ favorite: !!prefs.get(ref)?.favorite, pinned: !!prefs.get(ref)?.pinned, lastOpenedAt: prefs.get(ref)?.lastOpenedAt ?? null });
      return {
        groups: Object.entries(GROUP_NAMES).map(([key, label]) => ({ key, label })),
        reports: CATALOG.map((r) => ({ id: r.id, group: r.group, name: r.name, question: r.question, specChart: r.specChart, status: r.status, note: r.note ?? null, available: this.allowed(req, r.spec), fixedRange: !!r.fixedRange, ...p(r.id) })),
        saved: saved.map((s) => ({ id: s.id, name: s.name, dataset: s.spec?.dataset, shared: s.shared, folder: s.folder, mine: s.mine, updatedAt: s.updatedAt, version: s.version, ...p(s.id) })),
      };
    });
  }

  @Get("datasets")
  datasets(@Req() req: AuthedRequest) { this.view(req); return datasetInfo(req.perms as ReadonlySet<string> | undefined); }

  @Post("ask")
  @HttpCode(200)
  async ask(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.view(req);
    const text = str(asBody(raw).text, "text", { required: true, max: 300 })!;
    const org = await orgToday(this.pool, orgId);
    const d = draftFromText(text, org.d);
    if (!d) return { found: false, message: "I could not match that to any data. Try words like profit, fuel, repairs, drivers, customers, invoices or payouts, with a time such as last month." };
    if (!this.allowed(req, d.spec)) throw new ForbiddenException("You do not have access to that data");
    return { found: true, ...d, note: "This is a draft made by matching words, not by an AI model. Check it and adjust it before saving." };
  }

  // ---- running, exporting and the API ----------------------------------------------------------------------------------------

  @Post("run")
  @HttpCode(200)
  async run(@Req() req: AuthedRequest, @Body() raw: unknown) { return this.payload(await this.execute(req, asBody(raw))); }

  /** Every ready-made report is also a plain URL, so other tools can read the numbers (use an API key as the bearer token). */
  @Get(":id/data")
  async data(@Req() req: AuthedRequest, @Res() res: Response, @Param("id") id: string, @Query() q: Record<string, string | undefined>) {
    const x = await this.execute(req, { id, from: q.from, to: q.to, compare: q.compare });
    if (q.format === "csv") {
      if (!req.perms?.has("reports.export")) throw new ForbiddenException("requires reports.export");
      const out = forExport(x.result, x.currency);
      res.setHeader("Content-Type", "text/csv; charset=utf-8"); res.send(toCsv(out.result, out.labels)); return;
    }
    res.json(this.payload(x));
  }

  @Post("export")
  @HttpCode(200)
  async export(@Req() req: AuthedRequest, @Res() res: Response, @Query("format") format: string, @Body() raw: unknown) {
    if (!["csv", "xlsx", "pdf"].includes(format)) throw new BadRequestException("format must be csv, xlsx or pdf");
    requireAny(req, "reports.export");
    const b = asBody(raw);
    const x = await this.execute(req, b);
    const title = typeof b.title === "string" && b.title.trim() ? b.title.trim().slice(0, 120) : x.name;
    const out = forExport(x.result, x.currency, format === "pdf");
    const f = filtersText(x.spec);
    // A cover line for every file: the dates, the filters used and when the numbers were made (spec: report quality rules 1 and 3).
    const footer = `${x.name} · ${x.result.range.from} to ${x.result.range.to}${f.length ? ` · Filters: ${f.join("; ")}` : ""} · Amounts in ${x.currency} · Made ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`;
    const file = format === "pdf"
      ? { data: await toPdf(out.result, { brand: brandOf(x.org), title: `${title}`, labels: out.labels, footer }), type: "application/pdf", ext: "pdf" }
      : await render(format as Format, out.result, { title, brand: brandOf(x.org), labels: out.labels });
    const data = file.data;
    res.setHeader("Content-Type", file.type);
    res.setHeader("Content-Disposition", `attachment; filename="${(title.replace(/[^\w.\- ]+/g, "").trim().replace(/\s+/g, "-").slice(0, 60) || "report")}-${x.result.range.from}.${file.ext}"`);
    res.send(data);
  }

  /** The whole company's data in one zip of CSV files (vehicles, drivers, trips, pay, payouts, expenses, invoices, documents, maintenance). Only for people who can see all of it. */
  @Get("export-all")
  async exportAll(@Req() req: AuthedRequest, @Res() res: Response) {
    const orgId = requireAny(req, "settings.manage");
    for (const p of ["reports.export", "finance.view", "drivers.view", "pay.view", "fleet.view"] as const) if (!req.perms?.has(p)) throw new ForbiddenException("Exporting everything is for the owner or an admin");
    const org = await orgToday(this.pool, orgId);
    const teams = await withOrg(this.pool, orgId, (c) => regionScope(c, req));
    if (teams) throw new ForbiddenException("Exporting everything is for people who can see the whole company");
    const currency = (await withOrg(this.pool, orgId, (c) => companyFormat(c))).currency;
    const files: Record<string, Uint8Array> = {};
    const ctx = { pool: this.pool, orgId, svc: this.svc, today: org.d, perms: req.perms as ReadonlySet<string> | undefined };
    for (const [file, dataset] of [["vehicles", "vehicles"], ["vehicle-lifetime-costs", "carLifetime"], ["drivers", "drivers"], ["trips", "trips"], ["pay-lines", "payLines"], ["payouts", "payouts"], ["expenses", "expenses"], ["invoices", "invoices"], ["documents", "documents"], ["maintenance", "repairs"], ["incidents", "incidentRegister"]] as const) {
      const r: ReportResult = await runReport({ dataset, range: { preset: "allTime" } }, ctx);
      const o = forExport(r, currency);
      files[`${file}.csv`] = strToU8(toCsv(o.result, o.labels));
    }
    files["README.txt"] = strToU8(`RouteNorth full export for ${org.name}\nMade ${new Date().toISOString()}\nAmounts are in ${currency}. Dates are shown in the company time zone. Archived records are left out.\n`);
    await withOrg(this.pool, orgId, (c) => auditChange(c, req, { action: "reports.export_all", entity: "reports", entityId: null, label: "Full company export", old: null, next: { files: Object.keys(files).length }, sensitive: true }));
    res.setHeader("Content-Type", "application/zip");
    res.setHeader("Content-Disposition", `attachment; filename="routenorth-export-${org.d}.zip"`);
    res.send(Buffer.from(zipSync(files)));
  }

  // ---- favourites, recent, pins -----------------------------------------------------------------------------------------------

  @Post("prefs")
  @HttpCode(200)
  async setPrefs(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = this.view(req);
    const b = asBody(raw);
    const ref = str(b.ref, "ref", { required: true, max: 60 })!;
    if (!isUuid(ref) && !CATALOG_BY_ID.has(ref.toUpperCase())) throw new BadRequestException("unknown report");
    const fav = typeof b.favorite === "boolean" ? b.favorite : null, pin = typeof b.pinned === "boolean" ? b.pinned : null;
    return withOrg(this.pool, orgId, async (c) => {
      await c.query(
        `INSERT INTO portal_report_prefs (org_id, user_id, report_ref, favorite, pinned) VALUES ($1,$2,$3, coalesce($4,false), coalesce($5,false))
         ON CONFLICT (org_id, user_id, report_ref) DO UPDATE SET favorite = coalesce($4, portal_report_prefs.favorite), pinned = coalesce($5, portal_report_prefs.pinned)`, [orgId, req.session!.userId, ref.toUpperCase() === ref || !isUuid(ref) ? ref.toUpperCase() : ref, fav, pin]);
      return { ok: true };
    });
  }

  @Post("open/:ref")
  @HttpCode(200)
  async opened(@Req() req: AuthedRequest, @Param("ref") ref: string) {
    const orgId = this.view(req);
    const r = isUuid(ref) ? ref : ref.toUpperCase();
    if (!isUuid(r) && !CATALOG_BY_ID.has(r)) throw new NotFoundException();
    await withOrg(this.pool, orgId, (c) => c.query(`INSERT INTO portal_report_prefs (org_id, user_id, report_ref, last_opened_at) VALUES ($1,$2,$3, now()) ON CONFLICT (org_id, user_id, report_ref) DO UPDATE SET last_opened_at = now()`, [orgId, req.session!.userId, r]));
    return { ok: true };
  }

  /** The reports this person pinned, each with its first rows and totals for the last 30 days, for cards on the dashboard. */
  @Get("pinned")
  async pinned(@Req() req: AuthedRequest, @Query() q: Record<string, string | undefined>) {
    const orgId = this.view(req);
    const refs = (await withOrg(this.pool, orgId, (c) => c.query(`SELECT report_ref AS ref FROM portal_report_prefs WHERE user_id = $1 AND pinned ORDER BY report_ref`, [req.session!.userId]))).rows.map((r) => r.ref as string);
    const out: unknown[] = [];
    for (const ref of refs.slice(0, 6)) {
      try {
        const x = await this.execute(req, { id: ref, from: q.from, to: q.to });
        out.push({ ref, name: x.name, columns: x.result.columns.slice(0, 5), rows: x.result.rows.slice(0, 5), totals: x.result.totals, total: x.result.total, currency: x.currency, range: x.result.range });
      } catch { /* a report that is no longer allowed or was removed simply drops off the dashboard */ }
    }
    return out;
  }

  // ---- comments with @mentions ------------------------------------------------------------------------------------------------

  @Get("comments/:ref")
  async comments(@Req() req: AuthedRequest, @Param("ref") ref: string) {
    const orgId = this.view(req);
    const r = isUuid(ref) ? ref : ref.toUpperCase();
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT m.id, m.body, m.mentions, m.created_at AS "createdAt", coalesce(u.display_name, u.email) AS author, (SELECT coalesce(array_agg(coalesce(x.display_name, x.email)), '{}') FROM users x WHERE x.id = ANY(m.mentions)) AS "mentionNames"
       FROM portal_report_comments m JOIN users u ON u.id = m.author_id WHERE m.report_ref = $1 AND m.archived_at IS NULL ORDER BY m.created_at`, [r]))).rows;
  }

  @Post("comments/:ref")
  async addComment(@Req() req: AuthedRequest, @Param("ref") ref: string, @Body() raw: unknown) {
    const orgId = this.view(req);
    const r = isUuid(ref) ? ref : ref.toUpperCase();
    if (!isUuid(r) && !CATALOG_BY_ID.has(r)) throw new NotFoundException();
    const b = asBody(raw);
    const body = str(b.body, "body", { required: true, max: 2000 })!;
    const mentions = Array.isArray(b.mentions) ? [...new Set(b.mentions.map((m) => uuid(m, "mention")))].slice(0, 10) : [];
    return withOrg(this.pool, orgId, async (c) => {
      const valid = mentions.length ? (await c.query(`SELECT id FROM users WHERE id = ANY($1::uuid[]) AND disabled_at IS NULL`, [mentions])).rows.map((x) => x.id as string) : [];
      if (valid.length !== mentions.length) throw new BadRequestException("one of the people you tagged was not found");
      const row = (await c.query(`INSERT INTO portal_report_comments (org_id, report_ref, author_id, body, mentions) VALUES ($1,$2,$3,$4,$5) RETURNING id`, [orgId, r, req.session!.userId, body, valid])).rows[0];
      return { id: row.id as string };
    });
  }

  // ---- saved reports: folders --------------------------------------------------------------------------------------------------

  @Patch("saved/:id")
  async savedFolder(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = requireAny(req, "reports.manage");
    const b = asBody(raw);
    const folder = b.folder == null || b.folder === "" ? null : str(b.folder, "folder", { max: 60 });
    return withOrg(this.pool, orgId, async (c) => {
      const cur = (await c.query(`SELECT owner_id, folder, name FROM report_defs WHERE id = $1`, [uuid(id)])).rows[0];
      if (!cur) throw new NotFoundException();
      if (cur.owner_id !== req.session!.userId && !req.perms?.has("settings.manage")) throw new ForbiddenException("only the owner of the report can move it");
      await c.query(`UPDATE report_defs SET folder = $2 WHERE id = $1`, [uuid(id), folder]);
      await auditChange(c, req, { action: "reports.folder", entity: "reports", entityId: id, label: cur.name, old: { folder: cur.folder }, next: { folder } });
      return { ok: true };
    });
  }
}
