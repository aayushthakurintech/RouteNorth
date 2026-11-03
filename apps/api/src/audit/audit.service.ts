import { Inject, Injectable, Logger } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { PG_POOL } from "../tokens.js";

export interface AuditEntry {
  orgId: string;
  actorId?: string | null;
  actorLabel?: string | null;
  action: string;
  entity?: string | null;
  entityId?: string | null;
  method?: string | null;
  path?: string | null;
  status?: number | null;
  detail?: unknown;
  ip?: string | null;
}

/** Keys that never go into the log, whatever the request carried. */
const SECRET_KEYS = /pass|token|secret|signature|image|data|authorization|key|code|otp/i;

/** A short, safe summary of a request body for the log: no secrets, bounded size. */
export function summarizeBody(body: unknown, depth = 0): unknown {
  if (body === null || body === undefined) return undefined;
  if (typeof body === "string") return body.length > 200 ? `${body.slice(0, 200)}…` : body;
  if (typeof body !== "object") return body;
  if (Buffer.isBuffer(body)) return undefined;
  if (depth >= 3) return "…";
  if (Array.isArray(body)) {
    const items = body.slice(0, 20).map((x) => summarizeBody(x, depth + 1));
    return body.length > 20 ? [...items, `…${body.length - 20} more`] : items;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(body as Record<string, unknown>).slice(0, 40)) {
    out[k] = SECRET_KEYS.test(k) ? "[hidden]" : summarizeBody(v, depth + 1);
  }
  return out;
}

function detailJson(detail: unknown): string | null {
  if (detail === undefined) return null;
  const json = JSON.stringify(detail);
  return json.length > 4000 ? JSON.stringify({ truncated: true }) : json;
}

@Injectable()
export class AuditService {
  private readonly log = new Logger("audit");
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Writes one row. Never throws: a logging problem must not fail the change that was already made. */
  async record(e: AuditEntry): Promise<void> {
    try {
      await withOrg(this.pool, e.orgId, (c) =>
        c.query(
          `INSERT INTO audit_log (org_id, actor_id, actor_label, action, entity, entity_id, method, path, status, detail, ip)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [
            e.orgId, e.actorId ?? null, e.actorLabel ?? null, e.action, e.entity ?? null, e.entityId ?? null,
            e.method ?? null, e.path ?? null, e.status ?? null,
            detailJson(e.detail),
            e.ip ?? null,
          ],
        ),
      );
    } catch (err) {
      // The organization was deleted while the request was running: there is nothing left to record against.
      if ((err as { code?: string }).code === "23503") return;
      this.log.error(`could not write audit row: ${(err as Error).message}`);
    }
  }
}
