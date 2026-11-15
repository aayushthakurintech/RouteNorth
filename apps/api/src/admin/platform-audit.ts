import { Inject, Injectable, Logger } from "@nestjs/common";
import { pg, withPlatform } from "@routenorth/db";
import { PG_POOL } from "../tokens.js";

export interface PlatformAuditEntry {
  adminId?: string | null;
  adminEmail?: string | null;
  action: string;
  orgId?: string | null;
  orgName?: string | null;
  target?: string | null;
  reason?: string | null;
  detail?: unknown;
  status?: number | null;
  ip?: string | null;
  sessionId?: string | null;
}

const SECRET_KEYS = /pass|token|secret|code|otp|hash|recovery/i;
/** Staff-action details go in the log, but never anything that looks like a secret. */
export function scrub(v: unknown, depth = 0): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "string") return v.length > 300 ? `${v.slice(0, 300)}…` : v;
  if (typeof v !== "object") return v;
  if (depth >= 4) return "…";
  if (Array.isArray(v)) return v.slice(0, 50).map((x) => scrub(x, depth + 1));
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 40).map(([k, x]) => [k, SECRET_KEYS.test(k) ? "[hidden]" : scrub(x, depth + 1)]));
}

/** The staff audit log. Append-only in the database; this class only ever inserts. */
@Injectable()
export class PlatformAudit {
  private readonly log = new Logger("platform-audit");
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Inside a transaction the caller already has, so the log row and the change stand or fall together. */
  async recordIn(c: pg.PoolClient, e: PlatformAuditEntry): Promise<void> {
    await c.query(
      `INSERT INTO platform_audit (admin_id, admin_email, action, org_id, org_name, target, reason, detail, status, ip, session_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [e.adminId ?? null, e.adminEmail ?? null, e.action, e.orgId ?? null, e.orgName ?? null, e.target ?? null, e.reason ?? null,
        e.detail === undefined ? null : JSON.stringify(scrub(e.detail)), e.status ?? null, e.ip ?? null, e.sessionId ?? null]);
  }

  /** On its own, for events with no other change (a failed sign-in). Never throws. */
  async record(e: PlatformAuditEntry): Promise<void> {
    try { await withPlatform(this.pool, (c) => this.recordIn(c, e)); }
    catch (err) { this.log.error(`could not write platform audit row: ${(err as Error).message}`); }
  }
}
