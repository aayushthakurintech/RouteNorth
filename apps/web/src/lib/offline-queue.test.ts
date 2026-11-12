import { describe, expect, it } from "vitest";
import { applyPending, MemoryStore, syncQueue, type DriverRoute, type QueueItem } from "./offline-queue";
import { navigationLinks, nextStopIndex, scaledSize } from "./driver-nav";

const status = (id: string, stopId: string, s: "arrived" | "done" | "failed", at = "2026-11-02T10:00:00Z"): QueueItem =>
  ({ id, kind: "status", stopId, body: { status: s, occurredAt: at, ...(s === "failed" ? { reason: "closed" } : {}) } });

describe("syncQueue", () => {
  it("sends in order and removes accepted items", async () => {
    const store = new MemoryStore();
    await store.put(status("1", "a", "arrived"));
    await store.put(status("2", "a", "done"));
    const seen: string[] = [];
    const out = await syncQueue(store, async (i) => { seen.push(i.id); return 200; });
    expect(seen).toEqual(["1", "2"]);
    expect(out).toEqual({ sent: 2, failed: 0, stoppedBy: null });
    expect(await store.all()).toEqual([]);
  });
  it("stops at a network error and keeps the rest", async () => {
    const store = new MemoryStore();
    await store.put(status("1", "a", "arrived"));
    await store.put(status("2", "a", "done"));
    const out = await syncQueue(store, async () => { throw new TypeError("offline"); });
    expect(out.stoppedBy).toBe("network");
    expect((await store.all()).length).toBe(2);
  });
  it("stops on 401 and on 5xx without marking failure", async () => {
    for (const [code, by] of [[401, "auth"], [503, "network"]] as const) {
      const store = new MemoryStore();
      await store.put(status("1", "a", "done"));
      expect((await syncQueue(store, async () => code)).stoppedBy).toBe(by);
      expect((await store.all())[0]!.failed).toBeUndefined();
    }
  });
  it("marks permanent 4xx as failed and carries on", async () => {
    const store = new MemoryStore();
    await store.put(status("1", "a", "done"));
    await store.put(status("2", "b", "done"));
    const out = await syncQueue(store, async (i) => (i.id === "1" ? 404 : 200));
    expect(out).toEqual({ sent: 1, failed: 1, stoppedBy: null });
    const left = await store.all();
    expect(left.map((i) => [i.id, i.failed])).toEqual([["1", "HTTP 404"]]);
    // failed items are not retried
    expect((await syncQueue(store, async () => 200)).sent).toBe(0);
  });
});

describe("applyPending", () => {
  const route = (st: string): DriverRoute => ({
    id: "r", stops: [{ id: "a", status: st as never, arrivedAt: null, departedAt: null, failureReason: null, driverNotes: null, recipientName: null, proofCount: 0 }],
  });
  it("shows queued completion with notes and proofs", () => {
    const q: QueueItem[] = [
      { id: "1", kind: "status", stopId: "a", body: { status: "done", occurredAt: "T", recipientName: "Sam" } },
      { id: "2", kind: "proof", stopId: "a", clientId: "c", proofKind: "photo", takenAt: "T", contentType: "image/jpeg", data: new Blob() },
    ];
    const s = applyPending([route("pending")], q)[0]!.stops[0]!;
    expect([s.status, s.recipientName, s.proofCount, s.arrivedAt, s.departedAt]).toEqual(["done", "Sam", 1, "T", "T"]);
  });
  it("does not let a late arrival undo a finished stop, and ignores failed items", () => {
    const q: QueueItem[] = [status("1", "a", "arrived"), { ...status("2", "a", "failed"), failed: "HTTP 400" }];
    expect(applyPending([route("done")], q)[0]!.stops[0]!.status).toBe("done");
  });
});

describe("driver nav helpers", () => {
  it("builds deep links", () => {
    const l = navigationLinks(43.65, -79.38);
    expect(l.google).toContain("destination=43.65,-79.38");
    expect(l.apple).toContain("daddr=43.65,-79.38");
    expect(l.waze).toContain("ll=43.65,-79.38");
  });
  it("finds the next unfinished stop", () => {
    expect(nextStopIndex([{ status: "done" }, { status: "skipped" }, { status: "arrived" }, { status: "pending" }])).toBe(2);
    expect(nextStopIndex([{ status: "done" }])).toBe(-1);
  });
  it("downscales but never enlarges", () => {
    expect(scaledSize(4000, 3000)).toEqual({ width: 1600, height: 1200 });
    expect(scaledSize(800, 600)).toEqual({ width: 800, height: 600 });
  });
});
