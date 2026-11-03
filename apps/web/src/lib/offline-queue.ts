/**
 * Actions a driver takes while offline are queued here and replayed in order once the
 * connection is back. The server accepts replays safely (see /driver endpoints), so the
 * worst case of a dropped response is sending the same action twice.
 */
export interface StatusBody {
  status: "pending" | "arrived" | "done" | "failed" | "skipped";
  occurredAt: string;
  reason?: string;
  notes?: string;
  recipientName?: string;
}

export type QueueItem =
  | { id: string; kind: "status"; stopId: string; body: StatusBody; failed?: string }
  | {
      id: string; kind: "proof"; stopId: string; clientId: string; proofKind: "photo" | "signature";
      takenAt: string; contentType: string; data: Blob; lat?: number; lng?: number; failed?: string;
    };

export interface QueueStore {
  all(): Promise<QueueItem[]>;
  put(item: QueueItem): Promise<void>;
  remove(id: string): Promise<void>;
}

export class MemoryStore implements QueueStore {
  private items = new Map<string, QueueItem>();
  async all() { return [...this.items.values()]; }
  async put(item: QueueItem) { this.items.set(item.id, item); }
  async remove(id: string) { this.items.delete(id); }
}

/** IndexedDB-backed store; keeps insertion order through an increasing `seq` index. */
export class IdbStore implements QueueStore {
  private db: Promise<IDBDatabase> | null = null;
  private open(): Promise<IDBDatabase> {
    this.db ??= new Promise((resolve, reject) => {
      const req = indexedDB.open("routenorth-driver", 1);
      req.onupgradeneeded = () => req.result.createObjectStore("queue", { keyPath: "id" });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.db;
  }
  private async run<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const req = fn(db.transaction("queue", mode).objectStore("queue"));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  async all() {
    const items = await this.run("readonly", (s) => s.getAll() as IDBRequest<(QueueItem & { seq: number })[]>);
    return items.sort((a, b) => a.seq - b.seq);
  }
  async put(item: QueueItem) {
    const seq = (item as { seq?: number }).seq ?? Date.now() * 1000 + Math.floor(Math.random() * 1000);
    await this.run("readwrite", (s) => s.put({ ...item, seq }));
  }
  async remove(id: string) { await this.run("readwrite", (s) => s.delete(id)); }
}

export type SendResult = number; // HTTP status. Throw for network errors.

export interface SyncOutcome { sent: number; failed: number; stoppedBy: "network" | "auth" | null }

/** HTTP statuses worth retrying later rather than recording as a permanent failure. */
const RETRY_LATER = new Set([401, 408, 425, 429]);

/**
 * Send queued items oldest-first. Stops at the first network error or 401 (the rest would fail
 * the same way and order matters). Other 4xx responses mean the server will never accept the
 * item, so it is kept but marked failed and skipped; 5xx is retried later.
 */
export async function syncQueue(store: QueueStore, send: (item: QueueItem) => Promise<SendResult>): Promise<SyncOutcome> {
  let sent = 0, failed = 0;
  for (const item of await store.all()) {
    if (item.failed) continue;
    let status: number;
    try { status = await send(item); } catch { return { sent, failed, stoppedBy: "network" }; }
    if (status >= 200 && status < 300) { await store.remove(item.id); sent++; continue; }
    if (status === 401) return { sent, failed, stoppedBy: "auth" };
    if (status >= 500 || RETRY_LATER.has(status)) return { sent, failed, stoppedBy: "network" };
    await store.put({ ...item, failed: `HTTP ${status}` });
    failed++;
  }
  return { sent, failed, stoppedBy: null };
}

export interface DriverStop {
  id: string; status: StatusBody["status"]; arrivedAt: string | null; departedAt: string | null;
  failureReason: string | null; driverNotes: string | null; recipientName: string | null; proofCount: number;
  [k: string]: unknown;
}
export interface DriverRoute { id: string; stops: DriverStop[]; [k: string]: unknown }

/** Show the queued actions on top of the last server data, so the screen reflects what the driver did. */
export function applyPending<R extends DriverRoute>(routes: R[], queue: QueueItem[]): R[] {
  return routes.map((r) => ({
    ...r,
    stops: r.stops.map((s) => {
      let stop = s;
      for (const q of queue) {
        if (q.stopId !== s.id || q.failed) continue;
        if (q.kind === "proof") { stop = { ...stop, proofCount: stop.proofCount + 1 }; continue; }
        const b = q.body;
        // Mirrors the server: a late "arrived" never undoes a finished stop.
        const finished = ["done", "failed", "skipped"].includes(stop.status);
        const status = b.status === "arrived" && finished ? stop.status : b.status;
        stop = {
          ...stop, status,
          arrivedAt: b.status === "pending" ? null : stop.arrivedAt ?? (b.status === "arrived" || b.status === "done" ? b.occurredAt : null),
          departedAt: b.status === "pending" ? null : stop.departedAt ?? (b.status === "done" ? b.occurredAt : null),
          failureReason: b.status === "failed" || b.status === "skipped" ? b.reason ?? stop.failureReason : null,
          driverNotes: b.notes !== undefined ? b.notes : stop.driverNotes,
          recipientName: b.recipientName !== undefined ? b.recipientName : stop.recipientName,
        };
      }
      return stop;
    }),
  }));
}
