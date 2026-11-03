import type { pg } from "@routenorth/db";

export type NotificationKind = "mention" | "task" | "time_off" | "approval" | "invite" | "system";

/** A line in a person's in-app notification list. Never throws: a failed notification must not undo the thing that caused it. */
export async function addNotification(c: pg.PoolClient, orgId: string, userId: string, kind: NotificationKind, title: string, link?: string): Promise<void> {
  try {
    await c.query("SAVEPOINT notif");
    await c.query("INSERT INTO notifications (org_id, user_id, kind, title, link) VALUES ($1,$2,$3,$4,$5)", [orgId, userId, kind, title.slice(0, 200), link ?? null]);
    await c.query("RELEASE SAVEPOINT notif");
  } catch {
    await c.query("ROLLBACK TO SAVEPOINT notif").catch(() => {});
  }
}
