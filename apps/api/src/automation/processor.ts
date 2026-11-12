import { pg, withOrg } from "@routenorth/db";
import { isSafeWebhookUrl } from "../notify/notifier.js";
import { notifyCustomer } from "../customer/notify.js";
import { customerOptions } from "../customer/settings.js";
import type { CustomerEvent } from "./spec.js";
import { runActions, type ActionResult, type Ctx, type Deps } from "./actions.js";
import { RETRY_MINUTES, signWebhook } from "./events.js";
import { conditionsHold, type Action, type Condition } from "./spec.js";

interface EventRow { id: string; kind: string; subject_kind: string | null; subject_id: string | null; payload: Record<string, unknown>; at: Date }
interface WorkflowRow { id: string; name: string; trigger: { kind: string; minutes?: number; stops?: number }; match: "all" | "any"; conditions: Condition[]; actions: Action[] }

const JOB_TO_CUSTOMER: Record<string, CustomerEvent> = {
  "job.assigned": "scheduled", "job.started": "on_the_way", "job.arrived": "arrived", "job.done": "delivered", "job.failed": "failed", "job.cancelled": "cancelled", "job.rescheduled": "rescheduled",
};

/** Everything a workflow can read about one event: the job, driver and route involved, plus the event's own details. */
export async function buildContext(c: pg.PoolClient, ev: { id: string | null; kind: string; subject_kind?: string | null; subject_id?: string | null; payload: Record<string, unknown> }): Promise<Ctx> {
  const org = (await c.query<{ name: string }>("SELECT coalesce(brand_name, name) AS name FROM organizations")).rows[0] ?? { name: "" };
  const ctx: Ctx = { event: { ...ev.payload, id: ev.id, kind: ev.kind }, org };
  const jobId = ev.subject_kind === "job" ? ev.subject_id : (ev.payload.jobId as string | undefined) ?? null;
  if (jobId) {
    const j = (await c.query(
      `SELECT j.id, j.ref, j.title, j.status, j.priority, j.type, j.customer_name AS customer, j.customer_email, j.customer_phone, j.tags, j.address, j.weight_kg, j.price, j.source,
              j.route_id, j.driver_id, j.scheduled_date::text AS scheduled_date, j.window_start, j.window_end, j.reason_code,
              round(extract(epoch FROM (now() - j.created_at)) / 60)::int AS age_min,
              coalesce(u.display_name, u.email) AS driver_name, r.name AS route_name
       FROM jobs j LEFT JOIN users u ON u.id = j.driver_id LEFT JOIN routes r ON r.id = j.route_id WHERE j.id = $1`, [jobId])).rows[0];
    if (j) {
      ctx.job = j;
      if (j.driver_id) ctx.driver = { id: j.driver_id, name: j.driver_name };
      if (j.route_id) ctx.route = { id: j.route_id, name: j.route_name };
    }
  }
  const root = ev.kind.split(".")[0]!;
  if (!["job", "driver"].includes(root)) ctx[root] = { ...ev.payload };
  return ctx;
}

async function runWorkflow(c: pg.PoolClient, deps: Deps, orgId: string, wf: WorkflowRow, ctx: Ctx, dedupe: string, eventId: string | null): Promise<ActionResult[] | null> {
  const claim = await c.query("INSERT INTO workflow_runs (org_id, workflow_id, event_id, dedupe_key, status) VALUES ($1,$2,$3,$4,'skipped') ON CONFLICT (workflow_id, dedupe_key) DO NOTHING RETURNING id", [orgId, wf.id, eventId, dedupe]);
  if (!claim.rows[0]) return null; // this workflow already handled it
  const runId = claim.rows[0].id as string;
  if (!conditionsHold(wf.conditions, wf.match, ctx)) {
    await c.query("UPDATE workflow_runs SET detail = $2 WHERE id = $1", [runId, JSON.stringify({ reason: "conditions did not match" })]);
    return [];
  }
  const results = await runActions(c, deps, orgId, wf, wf.actions, ctx, dedupe);
  const failed = results.some((r) => !r.ok);
  await c.query("UPDATE workflow_runs SET status = $2, detail = $3, at = now() WHERE id = $1", [runId, failed ? "failed" : "ok", JSON.stringify({ results, job: ctx.job?.id ?? null })]);
  await c.query("UPDATE workflows SET run_count = run_count + 1, last_run_at = now() WHERE id = $1", [wf.id]);
  return results;
}

async function handleEvent(c: pg.PoolClient, deps: Deps, orgId: string, ev: EventRow, now: Date): Promise<void> {
  const ctx = await buildContext(c, ev);
  // 1. The customer's own messages.
  const ce = JOB_TO_CUSTOMER[ev.kind];
  if (ctx.job && ce) {
    await notifyCustomer(c, deps, orgId, ctx.job.id, ce, { repeat: ce === "rescheduled" ? ev.id : undefined });
    if (ce === "delivered") await c.query("UPDATE job_links SET expires_at = greatest(expires_at, now() + interval '30 days') WHERE job_id = $1", [ctx.job.id]);
  } else if (ctx.job && ev.kind === "job.created" && !["office", "import"].includes(String(ctx.job.source))) {
    await notifyCustomer(c, deps, orgId, ctx.job.id, "received");
  }
  // 2. The organization's workflows.
  const wfs = (await c.query<WorkflowRow>("SELECT id, name, trigger, match, conditions, actions FROM workflows WHERE active AND trigger->>'kind' = $1", [ev.kind])).rows;
  for (const wf of wfs) await runWorkflow(c, deps, orgId, wf, ctx, ev.id, ev.id);
  // 3. Webhooks.
  const subs = (await c.query<{ id: string }>("SELECT id FROM webhook_subscriptions WHERE active AND (cardinality(events) = 0 OR $1 = ANY(events))", [ev.kind])).rows;
  if (subs.length) {
    const body = { id: ev.id, kind: ev.kind, at: ev.at.toISOString(), orgId, data: { ...ev.payload, ...(ctx.job ? { job: { id: ctx.job.id, ref: ctx.job.ref, title: ctx.job.title, status: ctx.job.status, priority: ctx.job.priority, scheduledDate: ctx.job.scheduled_date, driverId: ctx.job.driver_id, routeId: ctx.job.route_id } } : {}) } };
    for (const s of subs) await c.query("INSERT INTO webhook_deliveries (org_id, subscription_id, event_id, kind, payload, next_attempt_at) VALUES ($1,$2,$3,$4,$5,$6)", [orgId, s.id, ev.id, ev.kind, JSON.stringify(body), now]);
  }
}

/** Handle the events waiting in the feed (oldest first, a bounded batch per pass). */
export async function processEvents(pool: pg.Pool, deps: Deps, orgId: string, limit = 200, now = new Date()): Promise<number> {
  return withOrg(pool, orgId, async (c) => {
    const events = (await c.query<EventRow>("SELECT id, kind, subject_kind, subject_id, payload, at FROM automation_events WHERE processed_at IS NULL ORDER BY at, id LIMIT $1 FOR UPDATE SKIP LOCKED", [limit])).rows;
    for (const ev of events) {
      await c.query("SAVEPOINT ev");
      try { await handleEvent(c, deps, orgId, ev, now); await c.query("RELEASE SAVEPOINT ev"); await c.query("UPDATE automation_events SET processed_at = now() WHERE id = $1", [ev.id]); }
      catch (e) {
        await c.query("ROLLBACK TO SAVEPOINT ev");
        await c.query("UPDATE automation_events SET processed_at = now(), error = $2 WHERE id = $1", [ev.id, (e as Error).message.slice(0, 500)]);
      }
    }
    return events.length;
  });
}

/** Workflows about something that stays true for a while ("nobody picked this up in 15 minutes", "driver 10 minutes away"). */
export async function runTimeTriggers(pool: pg.Pool, deps: Deps, orgId: string, now = new Date()): Promise<number> {
  return withOrg(pool, orgId, async (c) => {
    const wfs = (await c.query<WorkflowRow>("SELECT id, name, trigger, match, conditions, actions FROM workflows WHERE active AND trigger->>'kind' = ANY($1)", [["job.unassigned_for", "job.not_started_for", "driver.minutes_away", "driver.stops_away"]])).rows;
    let ran = 0;
    for (const wf of wfs) {
      const t = wf.trigger;
      let rows: { job_id: string; key: string; extra: Record<string, unknown> }[] = [];
      if (t.kind === "job.unassigned_for") {
        rows = (await c.query(
          `SELECT id AS job_id, 'job:' || id AS key, jsonb_build_object('waitingMin', floor(extract(epoch FROM ($1::timestamptz - created_at)) / 60)) AS extra FROM jobs
           WHERE status = 'unassigned' AND created_at <= $1::timestamptz - make_interval(mins => $2) AND created_at > $1::timestamptz - interval '7 days' LIMIT 200`, [now, t.minutes])).rows;
      } else if (t.kind === "job.not_started_for") {
        rows = (await c.query(
          `SELECT id AS job_id, 'job:' || id AS key, jsonb_build_object('lateMin', floor(extract(epoch FROM ($1::timestamptz - window_start)) / 60)) AS extra FROM jobs
           WHERE status = 'assigned' AND window_start IS NOT NULL AND window_start <= $1::timestamptz - make_interval(mins => $2) AND window_start > $1::timestamptz - interval '1 day' LIMIT 200`, [now, t.minutes])).rows;
      } else if (t.kind === "driver.minutes_away") {
        rows = (await c.query(
          `SELECT s.job_id, 'stop:' || s.id AS key, jsonb_build_object('minutes', greatest(0, round(extract(epoch FROM (s.eta - $1::timestamptz)) / 60))) AS extra
           FROM stops s JOIN routes r ON r.id = s.route_id AND r.status = 'in_progress'
           WHERE s.status = 'pending' AND s.job_id IS NOT NULL AND s.eta IS NOT NULL AND s.eta <= $1::timestamptz + make_interval(mins => $2) LIMIT 300`, [now, t.minutes])).rows;
      } else {
        rows = (await c.query(
          `SELECT s.job_id, 'stop:' || s.id AS key, jsonb_build_object('stops', a.ahead) AS extra
           FROM stops s JOIN routes r ON r.id = s.route_id AND r.status = 'in_progress'
           CROSS JOIN LATERAL (SELECT count(*)::int AS ahead FROM stops p WHERE p.route_id = s.route_id AND p.sequence < s.sequence AND p.status IN ('pending','arrived')) a
           WHERE s.status = 'pending' AND s.job_id IS NOT NULL AND a.ahead <= $1 LIMIT 300`, [t.stops])).rows;
      }
      for (const r of rows) {
        await c.query("SAVEPOINT tw");
        try {
          const ctx = await buildContext(c, { id: null, kind: t.kind, subject_kind: "job", subject_id: r.job_id, payload: r.extra });
          const res = await runWorkflow(c, deps, orgId, wf, ctx, r.key, null);
          if (res) ran++;
          await c.query("RELEASE SAVEPOINT tw");
        } catch (e) { await c.query("ROLLBACK TO SAVEPOINT tw"); console.error("time workflow failed:", (e as Error).message); }
      }
    }
    return ran;
  });
}

/** The built-in customer messages that depend on where the vehicle is: "on the way", "about 10 minutes away", "3 stops away". */
export async function runCustomerTracking(pool: pg.Pool, deps: Deps, orgId: string, now = new Date()): Promise<number> {
  return withOrg(pool, orgId, async (c) => {
    const org = (await c.query<{ settings: unknown }>("SELECT settings FROM organizations")).rows[0];
    if (!org) return 0;
    const opt = customerOptions(org.settings);
    if (!opt.notify.enabled) return 0;
    const rows = (await c.query<{ job_id: string; eta: Date | null; ahead: number }>(
      `SELECT s.job_id, s.eta, a.ahead FROM stops s JOIN routes r ON r.id = s.route_id AND r.status = 'in_progress'
       CROSS JOIN LATERAL (SELECT count(*)::int AS ahead FROM stops p WHERE p.route_id = s.route_id AND p.sequence < s.sequence AND p.status IN ('pending','arrived')) a
       JOIN jobs j ON j.id = s.job_id AND (j.customer_email IS NOT NULL OR j.customer_phone IS NOT NULL)
       WHERE s.status = 'pending' AND s.job_id IS NOT NULL LIMIT 500`)).rows;
    const done = new Set((await c.query<{ k: string }>("SELECT job_id || ':' || event AS k FROM customer_notifications WHERE job_id = ANY($1::uuid[])", [rows.map((r) => r.job_id)])).rows.map((r) => r.k));
    let sent = 0;
    for (const r of rows) {
      const todo: CustomerEvent[] = [];
      if (r.ahead === 0) todo.push("on_the_way");
      if (r.eta && r.eta.getTime() <= now.getTime() + opt.notify.minutesAway * 60_000) todo.push("minutes_away");
      if (r.ahead <= opt.notify.stopsAway && r.ahead > 0) todo.push("stops_away");
      for (const ev of todo) {
        if (done.has(`${r.job_id}:${ev}`)) continue;
        await c.query("SAVEPOINT ct");
        try { sent += (await notifyCustomer(c, deps, orgId, r.job_id, ev, { vars: ev === "minutes_away" ? { minutes: String(Math.max(1, Math.round(((r.eta?.getTime() ?? now.getTime()) - now.getTime()) / 60_000))) } : ev === "stops_away" ? { stops: String(r.ahead) } : {} })).filter((s) => s.status === "sent").length; await c.query("RELEASE SAVEPOINT ct"); }
        catch (e) { await c.query("ROLLBACK TO SAVEPOINT ct"); console.error("customer tracking message failed:", (e as Error).message); }
      }
    }
    return sent;
  });
}

/** Send the webhook calls that are due. A failure waits 1, 5, 30 minutes, 2 and 12 hours before the next try, then stops. */
export async function deliverWebhooks(pool: pg.Pool, deps: Pick<Deps, "providers">, orgId: string, now = new Date()): Promise<{ ok: number; failed: number }> {
  const due = (await withOrg(pool, orgId, (c) => c.query<{ id: string; kind: string; payload: unknown; attempts: number; url: string; secret: string }>(
    `SELECT d.id, d.kind, d.payload, d.attempts, s.url, s.secret FROM webhook_deliveries d JOIN webhook_subscriptions s ON s.id = d.subscription_id
     WHERE d.status = 'pending' AND d.next_attempt_at <= $1 AND s.active ORDER BY d.next_attempt_at LIMIT 50`, [now]))).rows;
  const res = { ok: 0, failed: 0 };
  for (const d of due) {
    const body = JSON.stringify(d.payload);
    const ts = Math.floor(now.getTime() / 1000);
    let status: number | null = null, error: string | null = null;
    if (!isSafeWebhookUrl(d.url)) error = "the address is not a public https address";
    else if (deps.providers.guard && (error = await deps.providers.guard(d.url))) { /* refused before calling */ }
    else {
      try {
        const r = await deps.providers.fetch(d.url, { method: "POST", headers: { "content-type": "application/json", "user-agent": "RouteNorth-Webhooks/1", "routenorth-event": d.kind, "routenorth-delivery": d.id, "routenorth-signature": `t=${ts},v1=${signWebhook(d.secret, ts, body)}` }, body });
        status = r.status;
        if (!r.ok) error = `the receiver answered ${r.status}`;
      } catch (e) { error = (e as Error).message; }
    }
    const attempts = d.attempts + 1;
    await withOrg(pool, orgId, (c) => error === null
      ? c.query("UPDATE webhook_deliveries SET status = 'ok', attempts = $2, response_status = $3, last_error = NULL, delivered_at = now() WHERE id = $1", [d.id, attempts, status])
      : attempts > RETRY_MINUTES.length
        ? c.query("UPDATE webhook_deliveries SET status = 'failed', attempts = $2, response_status = $3, last_error = $4 WHERE id = $1", [d.id, attempts, status, error])
        : c.query("UPDATE webhook_deliveries SET attempts = $2, response_status = $3, last_error = $4, next_attempt_at = $5::timestamptz + make_interval(mins => $6) WHERE id = $1", [d.id, attempts, status, error, now, RETRY_MINUTES[attempts - 1]]));
    if (error === null) res.ok++; else res.failed++;
  }
  return res;
}

export interface AutomationResult { events: number; workflowRuns: number; customerMessages: number; webhooks: { ok: number; failed: number } }

export async function runAutomationOrg(pool: pg.Pool, deps: Deps, orgId: string, now = new Date()): Promise<AutomationResult> {
  const events = await processEvents(pool, deps, orgId, 200, now);
  const workflowRuns = await runTimeTriggers(pool, deps, orgId, now);
  const customerMessages = await runCustomerTracking(pool, deps, orgId, now);
  const webhooks = await deliverWebhooks(pool, deps, orgId, now);
  return { events, workflowRuns, customerMessages, webhooks };
}

/** One pass over every organization (called every minute). */
export async function runAutomation(pool: pg.Pool, deps: Deps, log: (m: string) => void = () => {}, now = new Date()): Promise<void> {
  const orgs = (await pool.query<{ id: string }>("SELECT all_org_ids() AS id")).rows;
  for (const { id } of orgs) {
    try {
      const r = await runAutomationOrg(pool, deps, id, now);
      if (r.events || r.workflowRuns || r.customerMessages || r.webhooks.ok || r.webhooks.failed) log(`automation ${id}: ${JSON.stringify(r)}`);
    } catch (e) { log(`automation failed for ${id}: ${(e as Error).message}`); }
  }
}
