import { ForbiddenException } from "@nestjs/common";
import type { pg } from "@routenorth/db";

type Kind = "vehicles" | "users";

/**
 * Hard limits that RouteNorth staff set by hand for one client (org_entitlements.limits). The plan's own limits stay soft
 * warnings, as before; only a limit a staff member typed in stops anything. Call inside the transaction that adds the row.
 */
export async function assertWithinLimit(c: pg.PoolClient, orgId: string, kind: Kind, adding = 1): Promise<void> {
  const row = (await c.query<{ limit: string | null }>("SELECT limits ->> $2 AS \"limit\" FROM org_entitlements WHERE org_id = $1", [orgId, kind])).rows[0];
  if (!row || row.limit === null) return;
  const max = Number(row.limit);
  if (!Number.isInteger(max)) return;
  const used = Number((await c.query(kind === "vehicles"
    ? "SELECT count(*) AS n FROM vehicles WHERE status <> 'retired'"
    : "SELECT count(*) AS n FROM users WHERE disabled_at IS NULL AND role NOT IN ('customer')")).rows[0].n);
  if (used + adding > max) {
    throw new ForbiddenException({ message: `your account is limited to ${max} ${kind}; contact RouteNorth to raise it`, code: "limit_reached", limit: max, used, kind });
  }
}
