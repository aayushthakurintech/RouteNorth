import { pg, withOrg } from "@routenorth/db";
import { signSession } from "../auth/jwt.js";

/** Records a sign-in and returns a token tied to it, so it can be listed and revoked. */
export async function startSession(
  pool: pg.Pool, secret: string, who: { userId: string; orgId: string; role: string }, hours: number,
  req: { ip?: string; headers: Record<string, string | string[] | undefined> },
): Promise<string> {
  const ua = req.headers["user-agent"];
  const sid = (await withOrg(pool, who.orgId, (c) => c.query<{ id: string }>(
    "INSERT INTO user_sessions (org_id, user_id, ip, user_agent) VALUES ($1,$2,$3,$4) RETURNING id",
    [who.orgId, who.userId, req.ip ?? null, typeof ua === "string" ? ua.slice(0, 300) : null]))).rows[0]!.id;
  return signSession(secret, { ...who, sid }, `${hours}h`);
}
