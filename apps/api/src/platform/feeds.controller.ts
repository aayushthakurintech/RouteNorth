import { BadRequestException, Body, Controller, Get, Header, Inject, Optional, Param, Post, Query, Req, Res, UnauthorizedException } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { buildIcs, parseEmailJob, type IcsEvent } from "@routenorth/shared";
import { AnalyticsService } from "../analytics/analytics.service.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import { GEOCODER, PG_POOL } from "../tokens.js";
import { zonedToEpoch } from "../plan/time.js";
import { DATASETS, DATASET_BY_KEY, runReport } from "../reports/datasets.js";
import { toCsv } from "../reports/export.js";
import { orgToday } from "../reports/reports.controller.js";
import type { Geocoder } from "../dispatch/geocoder.js";
import { hashKey, isKeyToken } from "./keys.js";
import { openApiDocument } from "./openapi.js";

interface Found { key_id: string; org_id: string; kind: string; scope: string; created_by: string | null; name: string }

/** Find the key in the Authorization header or the ?key= link. Spreadsheets and calendars can only use the link. */
async function keyFrom(pool: pg.Pool, req: AuthedRequest, query: string | undefined, kinds: string[]): Promise<Found> {
  const h = req.headers.authorization;
  const bearer = typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : "";
  const token = (isKeyToken(bearer) ? bearer : query) ?? "";
  if (!isKeyToken(token)) throw new UnauthorizedException("a valid key is needed");
  const k = (await pool.query<Found>("SELECT * FROM find_api_key($1)", [hashKey(token)])).rows[0];
  if (!k || !kinds.includes(k.kind)) throw new UnauthorizedException("a valid key is needed");
  void withOrg(pool, k.org_id, (c) => c.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1", [k.key_id])).catch(() => {});
  return k;
}

const ndjson = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "");

/** Data links for spreadsheets, BI tools and warehouse loads, and a calendar feed. Read-only and protected by a feed key. */
@Controller("feeds")
export class FeedsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(AnalyticsService) private readonly svc: AnalyticsService) {}

  @Get("datasets")
  async list(@Req() req: AuthedRequest, @Query("key") key?: string) {
    await keyFrom(this.pool, req, key, ["feed", "api"]);
    return DATASETS.map((d) => ({ key: d.key, label: d.label, columns: d.columns.filter((c) => !c.hidden).map((c) => c.key) }));
  }

  /** One dataset as CSV, JSON or NDJSON (one record per line, for BigQuery, Snowflake and S3 loads). Default range: the last 30 days. */
  @Get("data/:dataset")
  async data(@Req() req: AuthedRequest, @Res() res: { setHeader(k: string, v: string): void; send(b: string): void }, @Param("dataset") dataset: string, @Query("format") format = "csv", @Query("from") from?: string, @Query("to") to?: string, @Query("key") key?: string) {
    const k = await keyFrom(this.pool, req, key, ["feed", "api"]);
    if (!DATASET_BY_KEY.has(dataset)) throw new BadRequestException("unknown dataset");
    if (!["csv", "json", "ndjson"].includes(format)) throw new BadRequestException("format must be csv, json or ndjson");
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if ((from && !day.test(from)) || (to && !day.test(to))) throw new BadRequestException("dates must look like 2026-03-31");
    const org = await orgToday(this.pool, k.org_id);
    const range = from && to ? { from, to } : { preset: "last30" as const };
    if (from && to && (Date.parse(to) - Date.parse(from)) / 86_400_000 > 366) throw new BadRequestException("ask for at most one year at a time");
    const r = await runReport({ dataset, range, limit: 50_000 }, { pool: this.pool, orgId: k.org_id, svc: this.svc, today: org.d });
    res.setHeader("cache-control", "no-store");
    if (format === "json") { res.setHeader("content-type", "application/json; charset=utf-8"); res.send(JSON.stringify({ dataset, range: r.range, rows: r.rows })); }
    else if (format === "ndjson") { res.setHeader("content-type", "application/x-ndjson; charset=utf-8"); res.send(ndjson(r.rows)); }
    else { res.setHeader("content-type", "text/csv; charset=utf-8"); res.send(toCsv(r)); }
  }

  /** Routes as calendar events (last week and the next five weeks), for Google Calendar or Outlook to subscribe to. */
  @Get("calendar.ics")
  async calendar(@Req() req: AuthedRequest, @Res() res: { setHeader(k: string, v: string): void; send(b: string): void }, @Query("key") key?: string, @Query("driverId") driverId?: string) {
    const k = await keyFrom(this.pool, req, key, ["feed", "api"]);
    if (driverId && !/^[0-9a-f-]{36}$/i.test(driverId)) throw new BadRequestException("driverId is not valid");
    const events = await withOrg(this.pool, k.org_id, async (c) => {
      const org = (await c.query<{ timezone: string; name: string }>("SELECT timezone, name FROM organizations WHERE id = $1", [k.org_id])).rows[0]!;
      const rows = (await c.query<{ id: string; name: string; day: string; driver: string | null; vehicle: string | null; first: Date | null; last: Date | null; stops: number; addr: string | null }>(
        `SELECT r.id, r.name, r.route_date::text AS day, u.display_name AS driver, v.name AS vehicle, min(coalesce(s.eta, s.window_start)) AS first, max(coalesce(s.eta, s.window_end)) AS last, count(s.id)::int AS stops, (array_agg(s.address ORDER BY s.sequence))[1] AS addr
         FROM routes r LEFT JOIN stops s ON s.route_id = r.id LEFT JOIN users u ON u.id = r.driver_id LEFT JOIN vehicles v ON v.id = r.vehicle_id
         WHERE r.status <> 'cancelled' AND r.route_date BETWEEN current_date - 7 AND current_date + 35 AND ($1::uuid IS NULL OR r.driver_id = $1)
         GROUP BY r.id, u.display_name, v.name ORDER BY r.route_date LIMIT 500`, [driverId ?? null])).rows;
      return { name: org.name, list: rows.map((r): IcsEvent => {
        const start = r.first ?? new Date(zonedToEpoch(r.day, "08:00", org.timezone));
        const end = r.last && r.last > start ? new Date(r.last.getTime() + 15 * 60_000) : new Date(start.getTime() + 8 * 3_600_000);
        return { uid: `route-${r.id}@routenorth`, start, end, summary: `${r.name}${r.driver ? ` (${r.driver})` : ""}`, description: `${r.stops} stops${r.vehicle ? ` · ${r.vehicle}` : ""}`, location: r.addr ?? undefined };
      }) };
    });
    res.setHeader("content-type", "text/calendar; charset=utf-8");
    res.setHeader("cache-control", "private, max-age=300");
    res.send(buildIcs(`${events.name} routes`, events.list));
  }
}

/** Forward an email to the address RouteNorth gives you and it becomes a job. Works with any inbound-email service that can post a form or JSON. */
@Controller("inbound")
export class InboundController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Optional() @Inject(GEOCODER) private readonly geocoder: Geocoder | null) {}

  @Post("email/:key")
  @Header("cache-control", "no-store")
  async email(@Req() req: AuthedRequest, @Param("key") key: string, @Body() body: Record<string, unknown>) {
    const k = await keyFrom(this.pool, req, key, ["inbound"]);
    const pick = (...names: string[]) => { for (const n of names) { const v = body?.[n]; if (typeof v === "string" && v) return v; } return undefined; };
    const mail = { from: pick("from", "sender", "From"), subject: pick("subject", "Subject"), text: pick("text", "body-plain", "stripped-text", "body", "TextBody") };
    if (!mail.subject && !mail.text) throw new BadRequestException("the email has no subject or text");
    return withOrg(this.pool, k.org_id, async (c) => {
      const recent = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM jobs WHERE source = 'email' AND created_at > now() - interval '1 hour'")).rows[0]!.n;
      if (recent >= 100) throw new BadRequestException("too many emails in the last hour");
      const today = (await c.query<{ d: string }>("SELECT (now() AT TIME ZONE timezone)::date::text AS d FROM organizations WHERE id = $1", [k.org_id])).rows[0]!.d;
      const j = parseEmailJob(mail, today);
      let lat: number | null = null, lng: number | null = null;
      if (j.address && this.geocoder) { try { const hit = (await this.geocoder.search(j.address, 1))[0]; if (hit) { lat = hit.lat; lng = hit.lng; } } catch { /* the office can place it by hand */ } }
      const id = (await c.query<{ id: string }>(
        `INSERT INTO jobs (org_id, type, title, customer_name, customer_email, customer_phone, address, lat, lng, scheduled_date, notes, tags, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,ARRAY['email'],'email') RETURNING id`,
        [k.org_id, j.type, j.title, j.customerName, j.customerEmail, j.customerPhone, j.address, lat, lng, j.scheduledDate, j.notes])).rows[0]!.id;
      await c.query("INSERT INTO job_events (org_id, job_id, kind, detail) VALUES ($1,$2,'created',$3)", [k.org_id, id, JSON.stringify({ source: "email" })]);
      return { id, title: j.title, located: lat != null, address: j.address, scheduledDate: j.scheduledDate };
    });
  }
}

/** The API description, public so tools like Postman and code generators can read it. */
@Controller("public")
export class DocsController {
  @Get("openapi.json")
  @Header("cache-control", "public, max-age=300")
  doc(@Req() req: AuthedRequest) {
    const host = req.headers["x-forwarded-host"] ?? req.headers.host;
    const proto = req.headers["x-forwarded-proto"] ?? "http";
    return openApiDocument(typeof host === "string" && /^[A-Za-z0-9.:-]+$/.test(host) ? `${String(proto).split(",")[0]}://${host}` : "/");
  }
}
