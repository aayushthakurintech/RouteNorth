import type { pg } from "@routenorth/db";
import { deliver, type Endpoint, type Providers } from "../notify/notifier.js";
import { createInvoiceForJob } from "../customer/invoices.js";
import { notifyCustomer } from "../customer/notify.js";
import { webUrl } from "../customer/links.js";
import { render, type Action, type CustomerEvent } from "./spec.js";

export interface Deps {
  providers: Providers;
  /** Server secret used to make customer links (the same secret that signs sessions). */
  secret: string;
  /** Re-order the rest of a route (supplied by the planner so automation and the Plan screen agree). */
  replan?: (c: pg.PoolClient, orgId: string, routeId: string) => Promise<unknown>;
}

export interface Ctx {
  event: Record<string, unknown> & { id: string | null; kind: string };
  org: { name: string };
  job?: Record<string, unknown> & { id: string };
  driver?: { id: string; name: string } | null;
  route?: { id: string; name: string } | null;
  [root: string]: unknown;
}
export interface ActionResult { type: string; ok: boolean; detail?: string }

/** Run a workflow's actions in order. One failing action is recorded and the rest still run. */
export async function runActions(c: pg.PoolClient, deps: Deps, orgId: string, workflow: { id: string; name: string }, actions: readonly Action[], ctx: Ctx, runKey: string): Promise<ActionResult[]> {
  const out: ActionResult[] = [];
  for (const a of actions) {
    try { out.push({ type: a.type, ok: true, detail: await one(c, deps, orgId, workflow, a, ctx, runKey) }); }
    catch (e) { out.push({ type: a.type, ok: false, detail: (e as Error).message }); }
  }
  return out;
}

async function one(c: pg.PoolClient, deps: Deps, orgId: string, wf: { id: string; name: string }, a: Action, ctx: Ctx, runKey: string): Promise<string> {
  const p = a.params;
  const jobId = ctx.job?.id;
  switch (a.type) {
    case "notify": {
      const ids = (p.endpointIds as string[]) ?? [];
      if (!ids.length) return "no destination chosen";
      const eps = (await c.query<Endpoint & { enabled: boolean }>("SELECT id, kind, target, label, enabled FROM notification_endpoints WHERE id = ANY($1::uuid[])", [ids])).rows.filter((e) => e.enabled);
      if (!eps.length) throw new Error("none of the chosen destinations is available");
      let ok = 0; let last = "";
      for (const ep of eps) {
        const r = await deliver(ep, { subject: render(String(p.subject ?? "RouteNorth"), ctx), text: render(String(p.text), ctx), link: `${webUrl()}/${jobId ? "jobs" : "alerts"}` }, deps.providers);
        if (r.ok) ok++; else last = r.error;
      }
      if (!ok) throw new Error(last || "not sent");
      return `sent to ${ok} of ${eps.length}`;
    }
    case "notify_customer": {
      if (!jobId) throw new Error("this event has no job");
      const sent = p.event
        ? await notifyCustomer(c, deps, orgId, jobId, p.event as CustomerEvent, { force: true })
        : await notifyCustomer(c, deps, orgId, jobId, "custom", { text: render(String(p.text), ctx), repeat: runKey, force: true });
      if (!sent.length) return "the customer has no email or phone, or already got this message";
      return sent.map((s) => `${s.channel}: ${s.status}`).join(", ");
    }
    case "notify_driver": {
      const driverId = ctx.driver?.id;
      if (!driverId) throw new Error("no driver is assigned");
      await c.query("INSERT INTO messages (org_id, thread_kind, thread_id, sender_kind, body, job_id) VALUES ($1,'driver',$2,'system',$3,$4)", [orgId, driverId, render(String(p.text), ctx), jobId ?? null]);
      return "sent";
    }
    case "create_alert": {
      const title = render(String(p.title), ctx);
      const key = `wf:${wf.id}:${jobId ?? String(ctx.event.id ?? runKey)}`;
      const open = await c.query("UPDATE alerts SET last_at = now(), count = count + 1, title = $2 WHERE dedupe_key = $1 AND status IN ('open','acknowledged') RETURNING id", [key, title]);
      if (open.rowCount) return "alert already open";
      await c.query(
        `INSERT INTO alerts (org_id, kind, severity, title, detail, subject_kind, subject_id, dedupe_key) VALUES ($1,'workflow',$2,$3,$4,$5,$6,$7)`,
        [orgId, p.severity ?? "warn", title, JSON.stringify({ workflow: wf.name, eventKind: ctx.event.kind }), jobId ? "job" : null, jobId ?? null, key]);
      return "alert raised";
    }
    case "set_job": {
      if (!jobId) throw new Error("this event has no job");
      if (p.priority) await c.query("UPDATE jobs SET priority = $2, updated_at = now() WHERE id = $1", [jobId, p.priority]);
      if (p.addTag) await c.query("UPDATE jobs SET tags = (SELECT array(SELECT DISTINCT unnest(tags || $2::text))) , updated_at = now() WHERE id = $1", [jobId, p.addTag]);
      await c.query("INSERT INTO job_events (org_id, job_id, kind, detail) VALUES ($1,$2,'workflow',$3)", [orgId, jobId, JSON.stringify({ workflow: wf.name, ...(p.priority ? { priority: p.priority } : {}), ...(p.addTag ? { tag: p.addTag } : {}) })]);
      return "job updated";
    }
    case "request_approval": {
      const subject = jobId ?? null;
      const exists = subject ? (await c.query("SELECT 1 FROM approvals WHERE org_id = $1 AND kind = $2 AND subject_id = $3 AND status = 'pending'", [orgId, p.kind, subject])).rowCount : 0;
      if (exists) return "already waiting for approval";
      await c.query("INSERT INTO approvals (org_id, kind, title, detail, subject_kind, subject_id) VALUES ($1,$2,$3,$4,$5,$6)", [orgId, p.kind, render(String(p.title), ctx), JSON.stringify({ workflow: wf.name, eventKind: ctx.event.kind }), subject ? "job" : null, subject]);
      return "approval requested";
    }
    case "create_invoice": {
      if (!jobId) throw new Error("this event has no job");
      const inv = await createInvoiceForJob(c, orgId, jobId, null);
      if (!inv) throw new Error("job not found");
      return inv.existing ? `invoice ${inv.number} already exists` : `invoice ${inv.number} created`;
    }
    case "replan_route": {
      const routeId = (ctx.event.routeId as string | undefined) ?? (ctx.job?.route_id as string | undefined) ?? ctx.route?.id;
      if (!routeId) throw new Error("no route to re-plan");
      if (!deps.replan) throw new Error("re-planning is not available");
      await deps.replan(c, orgId, routeId);
      return "route re-planned";
    }
  }
}
