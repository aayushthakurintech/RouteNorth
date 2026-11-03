import { pg, withOrg } from "@routenorth/db";
import { withDefaults } from "../org/settings.js";

/**
 * Deletes what each organization chose not to keep: GPS positions older than its retention days, and driver and office
 * messages older than its message retention (0 keeps them). Also tidies the small housekeeping tables.
 * Runs once a day. Returns how many rows went, for the log.
 */
export async function runRetention(pool: pg.Pool, log: (m: string) => void = () => {}): Promise<{ positions: number; messages: number }> {
  const orgs = (await pool.query<{ id: string }>("SELECT all_org_ids() AS id")).rows.map((r) => r.id);
  const total = { positions: 0, messages: 0 };
  for (const orgId of orgs) {
    try {
      await withOrg(pool, orgId, async (c) => {
        const o = (await c.query("SELECT retention_days AS days, settings FROM organizations WHERE id = $1", [orgId])).rows[0];
        if (!o) return;
        const s = withDefaults(o.settings);
        total.positions += (await c.query("DELETE FROM positions WHERE time < now() - make_interval(days => $1)", [o.days])).rowCount ?? 0;
        if (s.privacy.messageRetentionDays > 0) {
          total.messages += (await c.query("DELETE FROM messages WHERE created_at < now() - make_interval(days => $1)", [s.privacy.messageRetentionDays])).rowCount ?? 0;
        }
        await c.query("DELETE FROM notifications WHERE created_at < now() - interval '90 days'");
        await c.query("DELETE FROM error_log WHERE at < now() - interval '30 days'");
        await c.query("DELETE FROM usage_counts WHERE day < current_date - 400");
        await c.query("DELETE FROM user_sessions WHERE coalesce(revoked_at, created_at) < now() - interval '30 days'");
      });
    } catch (e) { log(`retention for ${orgId} failed: ${(e as Error).message}`); }
  }
  if (total.positions || total.messages) log(`retention: removed ${total.positions} positions and ${total.messages} messages`);
  return total;
}
