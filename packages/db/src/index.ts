import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(here, "..", "migrations");

/** Apply every migrations/*.sql file in order, once each. Run as the table owner. */
export async function migrate(databaseUrl: string): Promise<string[]> {
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    await client.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const done = new Set(
      (await client.query<{ name: string }>("SELECT name FROM schema_migrations")).rows.map((r) => r.name),
    );
    for (const file of readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue;
      await client.query("BEGIN");
      try {
        await client.query(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
        await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
        await client.query("COMMIT");
        applied.push(file);
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

/**
 * Run `fn` in a transaction scoped to one organization. Row-Level Security reads
 * app.org_id, so queries inside `fn` can only see or write that org's rows.
 */
export async function withOrg<T>(
  pool: pg.Pool,
  orgId: string,
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.org_id', $1, true)", [orgId]);
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Move a route between planned, in_progress and completed based on its stops.
 * Shared by GPS arrival detection and manual driver actions so both agree.
 * Cancelled routes are left alone. Call inside withOrg.
 */
export async function recomputeRouteStatus(client: pg.PoolClient, routeId: string, at: string): Promise<void> {
  const { rows } = await client.query<{ status: string; total: number; finished: number; started: number }>(
    `SELECT r.status, count(s.id)::int AS total,
            count(s.id) FILTER (WHERE s.status IN ('done','failed','skipped'))::int AS finished,
            count(s.id) FILTER (WHERE s.status <> 'pending')::int AS started
     FROM routes r LEFT JOIN stops s ON s.route_id = r.id WHERE r.id = $1 GROUP BY r.id`,
    [routeId],
  );
  const r = rows[0];
  if (!r || r.status === "cancelled") return;
  if (r.total > 0 && r.finished === r.total) {
    if (r.status !== "completed") {
      await client.query(
        "UPDATE routes SET status='completed', completed_at=$2, started_at=coalesce(started_at,$2) WHERE id=$1",
        [routeId, at],
      );
    }
  } else if (r.started > 0 && r.status !== "in_progress") {
    // Also reopens a completed route when a stop is put back to pending.
    await client.query(
      "UPDATE routes SET status='in_progress', started_at=coalesce(started_at,$2), completed_at=NULL WHERE id=$1",
      [routeId, at],
    );
  } else if (r.started === 0 && r.status === "completed") {
    await client.query("UPDATE routes SET status='planned', started_at=NULL, completed_at=NULL WHERE id=$1", [routeId]);
  }
}

export { pg };
export { decryptSecret, encryptionKeyProblem, encryptSecret } from "./secrets.js";
