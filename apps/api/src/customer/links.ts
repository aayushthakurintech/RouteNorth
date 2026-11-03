import { createHash, createHmac, randomUUID } from "node:crypto";
import type { pg } from "@routenorth/db";

export const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");
/** The secret part of a job link. It is worked out from the link id and the server secret, so it never has to be stored. */
export const linkToken = (secret: string, linkId: string) => createHmac("sha256", secret).update(`joblink:${linkId}`).digest("base64url").slice(0, 32);
export const TOKEN_RE = /^[A-Za-z0-9_-]{20,64}$/;
export const webUrl = () => (process.env.PUBLIC_WEB_URL ?? "http://localhost:3000").replace(/\/$/, "");

/** The link for a job (made on first use). Returns the token and the full address to put in a message. */
export async function ensureJobLink(c: pg.PoolClient, orgId: string, jobId: string, secret: string): Promise<{ id: string; token: string; url: string }> {
  let id = (await c.query<{ id: string }>("SELECT id FROM job_links WHERE job_id = $1", [jobId])).rows[0]?.id;
  if (!id) {
    const fresh = randomUUID();
    const ins = await c.query<{ id: string }>(
      `INSERT INTO job_links (id, org_id, job_id, token_hash, expires_at) VALUES ($1,$2,$3,$4, now() + interval '60 days') ON CONFLICT (job_id) DO NOTHING RETURNING id`,
      [fresh, orgId, jobId, sha256(linkToken(secret, fresh))]);
    id = ins.rows[0]?.id ?? (await c.query<{ id: string }>("SELECT id FROM job_links WHERE job_id = $1", [jobId])).rows[0]!.id;
  }
  const token = linkToken(secret, id);
  return { id, token, url: `${webUrl()}/j/${token}` };
}
