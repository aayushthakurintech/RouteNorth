import { pg, withOrg } from "@routenorth/db";
import { generateRoutes } from "./templates.js";

/** Make today's and tomorrow's routes from repeating templates, for every organization. Safe to run as often as you like. */
export async function runScheduledTasks(pool: pg.Pool, log: (m: string) => void = () => {}): Promise<number> {
  const orgs = (await pool.query<{ id: string }>("SELECT all_org_ids() AS id")).rows;
  let made = 0;
  for (const { id } of orgs) {
    await withOrg(pool, id, async (c) => {
      const days = (await c.query<{ today: string; tomorrow: string }>(
        "SELECT (now() AT TIME ZONE timezone)::date::text AS today, ((now() AT TIME ZONE timezone)::date + 1)::text AS tomorrow FROM organizations WHERE id = $1", [id])).rows[0];
      if (!days) return;
      for (const d of [days.today, days.tomorrow]) made += (await generateRoutes(c, id, d, null, false)).length;
    }).catch((e) => log(`scheduled tasks failed for ${id}: ${(e as Error).message}`));
  }
  if (made) log(`created ${made} route(s) from templates`);
  return made;
}
