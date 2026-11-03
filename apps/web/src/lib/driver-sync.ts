"use client";
import { API_URL, loadSession } from "./session";
import { IdbStore, syncQueue, type QueueItem, type SyncOutcome } from "./offline-queue";

export const queueStore = new IdbStore();

/** Send one queued action. Returns the HTTP status; throws on network failure. */
export async function sendItem(item: QueueItem): Promise<number> {
  const session = loadSession();
  if (!session) return 401;
  const auth = { Authorization: `Bearer ${session.token}` };
  if (item.kind === "status") {
    const res = await fetch(`${API_URL}/driver/stops/${item.stopId}/status`, {
      method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(item.body),
    });
    return res.status;
  }
  const q = new URLSearchParams({ kind: item.proofKind, takenAt: item.takenAt });
  if (item.lat !== undefined && item.lng !== undefined) { q.set("lat", String(item.lat)); q.set("lng", String(item.lng)); }
  const res = await fetch(`${API_URL}/driver/stops/${item.stopId}/proofs/${item.clientId}?${q}`, {
    method: "PUT", headers: { ...auth, "content-type": item.contentType }, body: item.data,
  });
  return res.status;
}

let running: Promise<SyncOutcome> | null = null;

async function drain(): Promise<SyncOutcome> {
  let total: SyncOutcome = { sent: 0, failed: 0, stoppedBy: null };
  // Items queued while a pass was running are picked up by another pass straight away.
  for (let pass = 0; pass < 5; pass++) {
    const out = await syncQueue(queueStore, sendItem);
    total = { sent: total.sent + out.sent, failed: total.failed + out.failed, stoppedBy: out.stoppedBy };
    if (out.stoppedBy || !(await queueStore.all()).some((i) => !i.failed)) break;
  }
  return total;
}

/** Only one sync at a time, so two triggers (timer + online event) can't send items twice. */
export function syncNow(): Promise<SyncOutcome> {
  running ??= drain().finally(() => { running = null; });
  return running;
}

export const newId = () => crypto.randomUUID();
