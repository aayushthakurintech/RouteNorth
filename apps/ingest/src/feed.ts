import { createHash } from "node:crypto";
import { withOrg, pg } from "@routenorth/db";

/**
 * Per-company "gps" keys. A company that already has GPS data (its provider's feed, its own Traccar server, a gateway)
 * sends it with a key from Settings > Connect your GPS. The key says which company the data belongs to.
 * The hash is the same one the API uses for every key (sha256, hex); only the hash is stored.
 */
export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
export const isGpsKey = (s: string) => /^rn_gps_[A-Za-z0-9_-]{32,}$/.test(s);

/** The key from the Authorization header, or from the link (`?key=`) for senders that cannot set headers, such as Traccar. */
export function keyFromRequest(authorization: string | undefined, query: string | null): string {
  const bearer = (authorization ?? "").replace(/^Bearer\s+/i, "");
  return isGpsKey(bearer) ? bearer : isGpsKey(query ?? "") ? query! : "";
}

export interface FeedKey { keyId: string; orgId: string }

const cache = new Map<string, { value: FeedKey | null; until: number }>();
const TTL_MS = 30_000; // a revoked key stops working within this time

export function clearKeyCache() { cache.clear(); }

export async function authenticateFeedKey(pool: pg.Pool, token: string, now = Date.now()): Promise<FeedKey | null> {
  if (!isGpsKey(token)) return null;
  const h = hashKey(token);
  const hit = cache.get(h);
  if (hit && hit.until > now) return hit.value;
  const row = (await pool.query<{ key_id: string; org_id: string; kind: string }>("SELECT key_id, org_id, kind FROM find_api_key($1)", [h])).rows[0];
  const value = row && row.kind === "gps" ? { keyId: row.key_id, orgId: row.org_id } : null;
  if (cache.size > 10_000) cache.clear();
  cache.set(h, { value, until: now + (value ? TTL_MS : 10_000) });
  if (value) void withOrg(pool, value.orgId, (c) => c.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '1 minute')", [value.keyId])).catch(() => {});
  return value;
}

/** At most `limit` requests per key per minute. In memory, per ingest process. */
const windows = new Map<string, { start: number; n: number }>();
export function withinRate(keyId: string, limit = 600, now = Date.now()): boolean {
  const w = windows.get(keyId);
  if (!w || now - w.start >= 60_000) { windows.set(keyId, { start: now, n: 1 }); return true; }
  w.n++;
  return w.n <= limit;
}
