import type { pg } from "@routenorth/db";
import { createHmac } from "node:crypto";

/** Put something that happened on the feed. Workflows, webhooks and customer messages pick it up within a minute. */
export async function emit(c: pg.PoolClient, orgId: string, kind: string, subjectKind: string | null, subjectId: string | null, payload: Record<string, unknown> = {}): Promise<void> {
  await c.query("INSERT INTO automation_events (org_id, kind, subject_kind, subject_id, payload) VALUES ($1,$2,$3,$4,$5)", [orgId, kind, subjectKind, subjectId, JSON.stringify(payload)]);
}

/** How a receiver checks a webhook came from us: HMAC-SHA256 of "<timestamp>.<body>" with the subscription's secret. */
export function signWebhook(secret: string, timestamp: number, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}
export const RETRY_MINUTES = [1, 5, 30, 120, 720];
