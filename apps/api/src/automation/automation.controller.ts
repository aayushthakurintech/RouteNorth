import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { randomBytes } from "node:crypto";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { parseUuid } from "../history/range.js";
import { isSafeWebhookUrl, type Providers } from "../notify/notifier.js";
import { NOTIFY, PG_POOL } from "../tokens.js";
import { emit } from "./events.js";
import { deliverWebhooks, buildContext } from "./processor.js";
import { ACTION_TYPES, ALL_TRIGGERS, conditionsHold, CUSTOMER_EVENTS, EVENT_TRIGGERS, OPS, render, validateWorkflow, type WorkflowSpec } from "./spec.js";
import { WORKFLOW_TEMPLATES } from "./templates.js";

/** Events a webhook can subscribe to (an empty list means all of them). */
export const WEBHOOK_EVENTS: readonly string[] = [...EVENT_TRIGGERS, "approval.decided", "invoice.created"];
/** Fields a condition can look at, for the builder's drop-down. */
const FIELDS = ["job.priority", "job.type", "job.status", "job.title", "job.customer", "job.tags", "job.weight_kg", "job.price", "job.source", "job.age_min", "driver.name", "route.name",
  "help.kind", "expense.amount", "expense.kind", "feedback.csat", "feedback.nps", "alert.severity", "alert.kind", "shift.hours", "message.from"];

/** The no-code workflow builder's helpers: what you can pick from, ready-made workflows, a test run and the history of runs. */
@Controller("automation")
@UseGuards(AuthGuard)
export class AutomationController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get("catalog")
  catalog(@Req() req: AuthedRequest) {
    requirePerm(req, "alerts.view");
    return { triggers: ALL_TRIGGERS, ops: OPS, actions: ACTION_TYPES, fields: FIELDS, customerEvents: CUSTOMER_EVENTS, templates: WORKFLOW_TEMPLATES.map((t) => ({ id: t.id, name: t.name, description: t.description, spec: t.spec })) };
  }

  @Post("templates/:id/use")
  async useTemplate(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "alerts.manage");
    const t = WORKFLOW_TEMPLATES.find((x) => x.id === id);
    if (!t) throw new NotFoundException();
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `INSERT INTO workflows (org_id, name, description, active, trigger, match, conditions, actions, created_by) VALUES ($1,$2,$3,true,$4,$5,$6,$7,$8) RETURNING id, name`,
      [orgId, t.name, t.description, t.spec.trigger, t.spec.match, JSON.stringify(t.spec.conditions), JSON.stringify(t.spec.actions), req.session!.userId]))).rows[0];
  }

  /** Try a workflow on a real job without doing anything: do its conditions match, and what would it say? */
  @Post("workflows/:id/test")
  @HttpCode(200)
  async test(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { jobId?: unknown }) {
    const orgId = requirePerm(req, "alerts.manage");
    return withOrg(this.pool, orgId, async (c) => {
      const wf = (await c.query("SELECT name, trigger, match, conditions, actions FROM workflows WHERE id = $1", [parseUuid(id)])).rows[0];
      if (!wf) throw new NotFoundException();
      let spec: WorkflowSpec;
      try { spec = validateWorkflow(wf); } catch (e) { throw new BadRequestException((e as Error).message); }
      const jobId = body?.jobId ? parseUuid(String(body.jobId)) : (await c.query("SELECT id FROM jobs ORDER BY created_at DESC LIMIT 1")).rows[0]?.id;
      if (!jobId) throw new BadRequestException("add a job first, so the workflow has something to try on");
      const ctx = await buildContext(c, { id: null, kind: spec.trigger.kind, subject_kind: "job", subject_id: jobId, payload: {} });
      const matches = conditionsHold(spec.conditions, spec.match, ctx);
      return {
        jobId, matches,
        wouldDo: matches ? spec.actions.map((a) => ({ type: a.type, preview: a.params.text ?? a.params.title ? render(String(a.params.text ?? a.params.title), ctx) : null })) : [],
      };
    });
  }

  @Get("runs")
  async runs(@Req() req: AuthedRequest, @Query("workflowId") workflowId?: string) {
    const orgId = requirePerm(req, "alerts.view");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT r.id, r.workflow_id AS "workflowId", w.name AS workflow, r.status, r.detail, r.at FROM workflow_runs r JOIN workflows w ON w.id = r.workflow_id
       WHERE ($1::uuid IS NULL OR r.workflow_id = $1) ORDER BY r.at DESC LIMIT 100`, [workflowId ? parseUuid(workflowId) : null]))).rows;
  }

  @Get("events")
  async events(@Req() req: AuthedRequest, @Query("limit") limit?: string) {
    const orgId = requirePerm(req, "alerts.view");
    const n = Math.min(200, Math.max(1, Number(limit) || 50));
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT id, kind, subject_kind AS "subjectKind", subject_id AS "subjectId", payload, at, processed_at AS "processedAt", error FROM automation_events ORDER BY at DESC LIMIT $1`, [n]))).rows;
  }
}

/** Webhooks: another system is called (and the call is signed) whenever one of the chosen events happens. */
@Controller("webhooks")
@UseGuards(AuthGuard)
export class WebhooksController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(NOTIFY) private readonly notify: Providers) {}

  private parse(body: { label?: unknown; url?: unknown; events?: unknown; active?: unknown }, partial: boolean) {
    const out: { label?: string; url?: string; events?: string[]; active?: boolean } = {};
    if (!partial || body.label !== undefined) { if (typeof body.label !== "string" || !body.label.trim() || body.label.length > 80) throw new BadRequestException("give the webhook a name (up to 80 characters)"); out.label = body.label.trim(); }
    if (!partial || body.url !== undefined) { if (typeof body.url !== "string" || body.url.length > 500 || !isSafeWebhookUrl(body.url)) throw new BadRequestException("enter a public https address"); out.url = body.url; }
    if (body.events !== undefined) {
      if (!Array.isArray(body.events) || body.events.length > 40 || !body.events.every((e) => typeof e === "string" && WEBHOOK_EVENTS.includes(e))) throw new BadRequestException("unknown event in the list");
      out.events = body.events as string[];
    }
    if (body.active !== undefined) out.active = Boolean(body.active);
    return out;
  }

  @Get("events")
  events(@Req() req: AuthedRequest) { requirePerm(req, "integrations.manage"); return WEBHOOK_EVENTS; }

  @Get()
  async list(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "integrations.manage");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT s.id, s.label, s.url, s.events, s.active, s.created_at AS "createdAt",
              (SELECT count(*)::int FROM webhook_deliveries d WHERE d.subscription_id = s.id AND d.status = 'failed' AND d.created_at > now() - interval '7 days') AS "failedLastWeek",
              (SELECT max(delivered_at) FROM webhook_deliveries d WHERE d.subscription_id = s.id AND d.status = 'ok') AS "lastDeliveredAt"
       FROM webhook_subscriptions s ORDER BY s.created_at DESC`))).rows;
  }

  /** The signing secret is shown once, here, and never listed again. */
  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: { label?: unknown; url?: unknown; events?: unknown }) {
    const orgId = requirePerm(req, "integrations.manage");
    const v = this.parse(body, false);
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    const row = (await withOrg(this.pool, orgId, (c) => c.query(
      `INSERT INTO webhook_subscriptions (org_id, label, url, secret, events, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, label, url, events, active`,
      [orgId, v.label, v.url, secret, v.events ?? [], req.session!.userId]))).rows[0];
    return { ...row, secret };
  }

  @Patch(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { label?: unknown; url?: unknown; events?: unknown; active?: unknown }) {
    const orgId = requirePerm(req, "integrations.manage");
    const v = this.parse(body, true);
    const row = (await withOrg(this.pool, orgId, (c) => c.query(
      `UPDATE webhook_subscriptions SET label = coalesce($2, label), url = coalesce($3, url), events = coalesce($4, events), active = coalesce($5, active) WHERE id = $1 RETURNING id, label, url, events, active`,
      [parseUuid(id), v.label ?? null, v.url ?? null, v.events ?? null, v.active ?? null]))).rows[0];
    if (!row) throw new NotFoundException();
    return row;
  }

  @Post(":id/rotate-secret")
  @HttpCode(200)
  async rotate(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "integrations.manage");
    const secret = `whsec_${randomBytes(24).toString("base64url")}`;
    const n = (await withOrg(this.pool, orgId, (c) => c.query("UPDATE webhook_subscriptions SET secret = $2 WHERE id = $1", [parseUuid(id), secret]))).rowCount;
    if (!n) throw new NotFoundException();
    return { secret };
  }

  @Delete(":id")
  @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "integrations.manage");
    const n = (await withOrg(this.pool, orgId, (c) => c.query("DELETE FROM webhook_subscriptions WHERE id = $1", [parseUuid(id)]))).rowCount;
    if (!n) throw new NotFoundException();
  }

  /** Send a "ping" now and report what the receiver said. */
  @Post(":id/test")
  @HttpCode(200)
  async test(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "integrations.manage");
    const sid = parseUuid(id);
    const did = await withOrg(this.pool, orgId, async (c) => {
      if (!(await c.query("SELECT 1 FROM webhook_subscriptions WHERE id = $1", [sid])).rowCount) throw new NotFoundException();
      return (await c.query("INSERT INTO webhook_deliveries (org_id, subscription_id, kind, payload) VALUES ($1,$2,'ping',$3) RETURNING id", [orgId, sid, JSON.stringify({ kind: "ping", orgId, at: new Date().toISOString(), data: { hello: "from RouteNorth" } })])).rows[0].id as string;
    });
    await deliverWebhooks(this.pool, { providers: this.notify }, orgId);
    return (await withOrg(this.pool, orgId, (c) => c.query(`SELECT id, status, attempts, response_status AS "responseStatus", last_error AS "lastError" FROM webhook_deliveries WHERE id = $1`, [did]))).rows[0];
  }

  @Get(":id/deliveries")
  async deliveries(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "integrations.manage");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT id, kind, status, attempts, response_status AS "responseStatus", last_error AS "lastError", next_attempt_at AS "nextAttemptAt", created_at AS "createdAt", delivered_at AS "deliveredAt"
       FROM webhook_deliveries WHERE subscription_id = $1 ORDER BY created_at DESC LIMIT 100`, [parseUuid(id)]))).rows;
  }

  @Post("deliveries/:id/retry")
  @HttpCode(200)
  async retry(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "integrations.manage");
    const n = (await withOrg(this.pool, orgId, (c) => c.query("UPDATE webhook_deliveries SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE id = $1 AND status = 'failed'", [parseUuid(id)]))).rowCount;
    if (!n) throw new NotFoundException();
    await deliverWebhooks(this.pool, { providers: this.notify }, orgId);
    return { ok: true };
  }
}

/** Approvals: a manager says yes or no to overtime, a large expense or anything a workflow asked about. */
@Controller("approvals")
@UseGuards(AuthGuard)
export class ApprovalsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get()
  async list(@Req() req: AuthedRequest, @Query("status") status?: string) {
    const orgId = requirePerm(req, "reports.view");
    if (status && !["pending", "approved", "rejected"].includes(status)) throw new BadRequestException("status must be pending, approved or rejected");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT a.id, a.kind, a.title, a.detail, a.subject_kind AS "subjectKind", a.subject_id AS "subjectId", a.status, a.decision_note AS "decisionNote", a.created_at AS "createdAt", a.decided_at AS "decidedAt",
              coalesce(r.display_name, r.email) AS "requestedBy", coalesce(d.display_name, d.email) AS "decidedBy"
       FROM approvals a LEFT JOIN users r ON r.id = a.requested_by LEFT JOIN users d ON d.id = a.decided_by
       WHERE ($1::text IS NULL OR a.status = $1) ORDER BY (a.status = 'pending') DESC, a.created_at DESC LIMIT 200`, [status ?? null]))).rows;
  }

  @Get("count")
  async count(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "reports.view");
    return { pending: (await withOrg(this.pool, orgId, (c) => c.query("SELECT count(*)::int AS n FROM approvals WHERE status = 'pending'"))).rows[0].n };
  }

  @Post(":id/decide")
  @HttpCode(200)
  async decide(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { decision?: unknown; note?: unknown }) {
    const orgId = requirePerm(req, "reports.manage");
    const decision = body?.decision;
    if (decision !== "approved" && decision !== "rejected") throw new BadRequestException("decision must be approved or rejected");
    const note = typeof body?.note === "string" && body.note.trim() ? body.note.trim().slice(0, 500) : null;
    return withOrg(this.pool, orgId, async (c) => {
      const a = (await c.query("UPDATE approvals SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1 AND status = 'pending' RETURNING id, kind, subject_kind, subject_id, title", [parseUuid(id), decision, req.session!.userId, note])).rows[0];
      if (!a) throw new NotFoundException("that approval is already decided or does not exist");
      if (a.kind === "expense" && a.subject_id) await c.query("UPDATE expenses SET status = $2, decided_by = $3, decided_at = now(), decision_note = $4 WHERE id = $1 AND status = 'submitted'", [a.subject_id, decision, req.session!.userId, note]);
      if (a.kind === "overtime" && a.subject_id) await c.query("UPDATE shifts SET overtime_status = $2 WHERE id = $1", [a.subject_id, decision]);
      await emit(c, orgId, "approval.decided", a.subject_kind ?? "approval", a.subject_id ?? a.id, { approvalId: a.id, kind: a.kind, decision, title: a.title });
      return { id: a.id, status: decision };
    });
  }
}
