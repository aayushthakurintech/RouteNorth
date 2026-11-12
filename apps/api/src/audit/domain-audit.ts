import type { pg } from "@routenorth/db";
import type { AuthedRequest } from "../auth/auth.guard.js";

export interface DomainAudit {
  /** e.g. "vehicles.update" */
  action: string;
  /** e.g. "vehicles" */
  entity: string;
  entityId: string | null;
  /** Human label of the item ("Truck 12"), so the log reads without a lookup. */
  label?: string | null;
  /** Value before the change (null on create) and after (null on delete/archive of everything). */
  old: Record<string, unknown> | null;
  next: Record<string, unknown> | null;
  /** Highlighted in the log: pay rate changes, payout approvals, bank detail changes. */
  sensitive?: boolean;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Keep only the keys whose value changed, so a log line shows what actually moved. */
export function diffValues(old: Record<string, unknown> | null, next: Record<string, unknown> | null): { old: Record<string, unknown> | null; next: Record<string, unknown> | null } {
  if (!old || !next) return { old, next };
  const o: Record<string, unknown> = {}, n: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(old), ...Object.keys(next)])) {
    if (!same(old[k], next[k])) { o[k] = old[k] ?? null; n[k] = next[k] ?? null; }
  }
  return { old: o, next: n };
}

/** Values that never go into the log in the clear. */
const MASK_KEYS = /password|secret|token|bank|account|routing|transit|sin|tax_?id|iban/i;
export function maskForLog(v: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!v) return v;
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) {
    if (MASK_KEYS.test(k) && x != null) out[k] = typeof x === "string" && x.length > 4 ? `••••${x.slice(-4)}` : "[hidden]";
    else out[k] = x;
  }
  return out;
}

/**
 * Write one audit row inside the SAME transaction as the change, so a change cannot be saved without its log line
 * and a failed change leaves none. Marks the request so the generic request log does not add a second row.
 * Does nothing when an update changed nothing.
 */
export async function auditChange(c: pg.PoolClient, req: AuthedRequest, e: DomainAudit): Promise<void> {
  const d = diffValues(e.old, e.next);
  if (e.old && e.next && Object.keys(d.next ?? {}).length === 0) { req.auditDone = true; return; }
  const url = (req.originalUrl ?? req.url ?? "").split("?")[0];
  await c.query(
    `INSERT INTO audit_log (org_id, actor_id, actor_label, action, entity, entity_id, method, path, status, detail, ip, old_value, new_value, item_label, sensitive)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,NULL,$10,$11,$12,$13,$14)`,
    [req.session!.orgId, /^[0-9a-f-]{36}$/.test(req.session!.userId) ? req.session!.userId : null, req.actor?.email ?? null, e.action, e.entity, e.entityId, req.method ?? null, url, 200, req.ip ?? null,
      d.old ? JSON.stringify(maskForLog(d.old)) : null, d.next ? JSON.stringify(maskForLog(d.next)) : null, e.label ?? null, !!e.sensitive],
  );
  req.auditDone = true;
}
