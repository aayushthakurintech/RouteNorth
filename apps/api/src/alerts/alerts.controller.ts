import { BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { AnalyticsService } from "../analytics/analytics.service.js";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { parseUuid } from "../history/range.js";
import { deliver, type Endpoint, type Providers } from "../notify/notifier.js";
import { NOTIFY, PG_POOL } from "../tokens.js";
import { evaluateOrg, EVALUATORS, sendDigest, type RuleKind } from "./engine.js";

@Controller("alerts")
@UseGuards(AuthGuard)
export class AlertsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(AnalyticsService) private readonly svc: AnalyticsService, @Inject(NOTIFY) private readonly notify: Providers) {}

  /** The inbox. */
  @Get()
  async list(@Req() req: AuthedRequest, @Query("status") status?: string, @Query("kind") kind?: string, @Query("limit") limit?: string) {
    const orgId = requirePerm(req, "alerts.view");
    if (status && !["open", "acknowledged", "resolved", "active"].includes(status)) throw new BadRequestException("status must be open, acknowledged, resolved or active");
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT a.id, a.kind, a.severity, a.title, a.detail, a.subject_kind AS "subjectKind", a.subject_id AS "subjectId", a.first_at AS "firstAt", a.last_at AS "lastAt", a.count, a.status,
              r.name AS rule, coalesce(r.notify_inapp, true) AS inapp
       FROM alerts a LEFT JOIN alert_rules r ON r.id = a.rule_id
       WHERE ($1::text IS NULL OR a.status = $1 OR ($1 = 'active' AND a.status IN ('open','acknowledged'))) AND ($2::text IS NULL OR a.kind = $2)
       ORDER BY (a.status = 'open') DESC, a.last_at DESC LIMIT $3`, [status ?? null, kind ?? null, n]))).rows;
  }

  /** For the badge in the header. */
  @Get("summary")
  async summary(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "alerts.view");
    const r = (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT count(*) FILTER (WHERE a.status = 'open' AND coalesce(r.notify_inapp, true))::int AS open, count(*) FILTER (WHERE a.status = 'open' AND a.severity = 'critical' AND coalesce(r.notify_inapp, true))::int AS critical
       FROM alerts a LEFT JOIN alert_rules r ON r.id = a.rule_id`))).rows[0];
    return r;
  }

  @Post(":id/acknowledge")
  @HttpCode(200)
  async acknowledge(@Req() req: AuthedRequest, @Param("id") id: string) { return this.move(req, id, "acknowledged"); }

  @Post(":id/resolve")
  @HttpCode(200)
  async resolve(@Req() req: AuthedRequest, @Param("id") id: string) { return this.move(req, id, "resolved"); }

  private async move(req: AuthedRequest, id: string, to: "acknowledged" | "resolved") {
    const orgId = requirePerm(req, "alerts.view");
    const n = (await withOrg(this.pool, orgId, (c) => c.query(
      "UPDATE alerts SET status = $2, acknowledged_by = coalesce(acknowledged_by, $3) WHERE id = $1 AND status IN ('open','acknowledged') AND ($2 = 'resolved' OR status = 'open')", [parseUuid(id), to, req.session!.userId]))).rowCount;
    if (!n) throw new NotFoundException();
    return { id, status: to };
  }

  /** Check the rules now instead of waiting for the next minute. */
  @Post("evaluate")
  @HttpCode(200)
  async evaluate(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "alerts.manage");
    return evaluateOrg(this.pool, this.svc, this.notify, orgId);
  }

  /** Send the morning summary now. */
  @Post("digest")
  @HttpCode(200)
  async digest(@Req() req: AuthedRequest) { return sendDigest(this.pool, this.notify, requirePerm(req, "alerts.manage")); }

  /** Send a test message to one destination, so people know it works before relying on it. */
  @Post("endpoints/:id/test")
  @HttpCode(200)
  async testEndpoint(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "alerts.manage");
    const ep = (await withOrg(this.pool, orgId, (c) => c.query<Endpoint>("SELECT id, kind, target, label FROM notification_endpoints WHERE id = $1", [parseUuid(id)]))).rows[0];
    if (!ep) throw new NotFoundException();
    const r = await deliver(ep, { subject: "RouteNorth test message", text: "If you can read this, alerts and reports can reach this destination.", severity: "info" }, this.notify);
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  }

  /** What would this rule match right now? Nothing is saved or sent. */
  @Post("preview")
  @HttpCode(200)
  async preview(@Req() req: AuthedRequest, @Body() body: { kind?: string; params?: Record<string, unknown> }) {
    const orgId = requirePerm(req, "alerts.manage");
    const ev = EVALUATORS[body?.kind as RuleKind];
    if (!ev) throw new BadRequestException("unknown rule kind");
    const meta = (await withOrg(this.pool, orgId, (c) => c.query<{ d: string; tz: string }>("SELECT (now() AT TIME ZONE timezone)::date::text AS d, timezone AS tz FROM organizations"))).rows[0]!;
    const today = meta.d;
    const matches = await withOrg(this.pool, orgId, (c) => ev.run(c, body.params && typeof body.params === "object" ? body.params : {}, { orgId, today, tz: meta.tz, svc: this.svc, now: new Date() }));
    return { count: matches.length, matches: matches.slice(0, 20).map((m) => ({ title: m.title, detail: m.detail })) };
  }
}
