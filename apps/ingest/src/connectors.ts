import { decryptSecret, withOrg, pg } from "@routenorth/db";
import { backoffMs, ConnectorError, pullProvider, type FetchLike, type ProviderKind, type Reading } from "@routenorth/shared";
import type { Outcome } from "./store.js";

/** How often a healthy connection is pulled. Providers bill or rate-limit by call; a minute is close to live. */
export const PULL_EVERY_MS = 60_000;

export interface PollDeps {
  fetchFn: FetchLike;
  /** JWT_SECRET; ENCRYPTION_KEY wins when set (see decryptSecret). */
  secretKey: string;
  /** Store one reading for the company (ingestReading with feedOrgId) and run the usual follow-up. */
  ingest: (orgId: string, r: Reading) => Promise<Outcome>;
  now?: () => Date;
}

interface Row { id: string; provider: ProviderKind; settings: Record<string, unknown>; secret_enc: string; cursor: string | null; failures: number }

/**
 * Pull every connection that is due. Each company's rows are read and written inside that company (withOrg);
 * only the list of due ids comes from a SECURITY DEFINER function. One connection failing never stops the others.
 * Returns what happened per connection, for logs and tests.
 */
export async function pullDueConnections(pool: pg.Pool, deps: PollDeps, limit = 10): Promise<{ id: string; stored: number; error?: string }[]> {
  const due = (await pool.query<{ id: string; org_id: string }>("SELECT id, org_id FROM due_provider_connections($1)", [limit])).rows;
  const results: { id: string; stored: number; error?: string }[] = [];
  for (const d of due) results.push(await pullOne(pool, d.id, d.org_id, deps));
  return results;
}

async function pullOne(pool: pg.Pool, id: string, orgId: string, deps: PollDeps) {
  const now = deps.now?.() ?? new Date();
  const row = await withOrg(pool, orgId, async (c) => (await c.query<Row>(
    "SELECT id, provider, settings, secret_enc, cursor, failures FROM provider_connections WHERE id = $1 AND status <> 'paused'", [id])).rows[0]);
  if (!row) return { id, stored: 0 };
  const fail = async (message: string, auth: boolean) => {
    const failures = row.failures + 1;
    await withOrg(pool, orgId, (c) => c.query(
      `UPDATE provider_connections SET status = 'error', last_error = $2, failures = $3, last_sync_at = $4, next_run_at = $5 WHERE id = $1`,
      [id, message.slice(0, 300), failures, now, new Date(now.getTime() + backoffMs(failures, auth))]));
    return { id, stored: 0, error: message };
  };

  const secret = decryptSecret(deps.secretKey, row.secret_enc);
  if (secret == null) return fail("The saved login cannot be read (the server's encryption key changed). Enter it again.", true);

  let pulled;
  try {
    pulled = await pullProvider({ provider: row.provider, settings: row.settings, secret, cursor: row.cursor }, deps.fetchFn, now);
  } catch (e) {
    if (e instanceof ConnectorError) return fail(e.message, e.auth);
    console.error("connector pull failed", id, e);
    return fail("Unexpected error while pulling; we will try again.", false);
  }

  let stored = 0;
  let lastData: string | null = null;
  for (const r of pulled.readings) {
    const o = await deps.ingest(orgId, r);
    if (o.kind === "stored" || o.kind === "history_only" || o.kind === "latest_only") { stored++; lastData = r.time; }
  }
  await withOrg(pool, orgId, (c) => c.query(
    `UPDATE provider_connections SET status = 'ok', last_error = NULL, failures = 0, cursor = $2, last_sync_at = $3,
       last_data_at = coalesce($4, last_data_at), next_run_at = $5 WHERE id = $1`,
    [id, pulled.cursor, now, lastData, new Date(now.getTime() + (pulled.more ? 5_000 : PULL_EVERY_MS))]));
  return { id, stored };
}
