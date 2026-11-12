import { describe, expect, it } from "vitest";
import { addToOutbox, flushOutbox, readOutbox, type OutboxItem, type OutboxStorage } from "./driver-outbox";

const mem = (): OutboxStorage & { v: string | null } => ({ v: null, get() { return this.v; }, set(x) { this.v = x; } });
const item = (id: string): OutboxItem => ({ id, method: "POST", path: "/driver/help", body: { clientId: id }, at: "2026-11-03T10:00:00Z" });

describe("driver outbox", () => {
  it("keeps items in order and ignores duplicates", () => {
    const s = mem();
    addToOutbox(s, item("a")); addToOutbox(s, item("b")); addToOutbox(s, item("a"));
    expect(readOutbox(s).map((i) => i.id)).toEqual(["b", "a"]);
  });
  it("sends everything when the network is back", async () => {
    const s = mem(); addToOutbox(s, item("a")); addToOutbox(s, item("b"));
    const seen: string[] = [];
    const r = await flushOutbox(s, async (i) => { seen.push(i.id); return { status: 200 }; });
    expect(seen).toEqual(["a", "b"]);
    expect(r).toEqual({ sent: 2, left: 0, dropped: 0, auth: false });
  });
  it("stops at the first failure and keeps the rest in order", async () => {
    const s = mem(); addToOutbox(s, item("a")); addToOutbox(s, item("b")); addToOutbox(s, item("c"));
    const r = await flushOutbox(s, async (i) => { if (i.id === "b") throw new Error("offline"); return { status: 200 }; });
    expect(r.sent).toBe(1);
    expect(readOutbox(s).map((i) => i.id)).toEqual(["b", "c"]);
  });
  it("drops what the server will never accept but keeps retryable errors", async () => {
    const s = mem(); addToOutbox(s, item("a")); addToOutbox(s, item("b"));
    const r1 = await flushOutbox(s, async (i) => ({ status: i.id === "a" ? 400 : 503 }));
    expect(r1).toMatchObject({ dropped: 1, left: 1 });
    const r2 = await flushOutbox(s, async () => ({ status: 401 }));
    expect(r2.auth).toBe(true);
    expect(readOutbox(s)).toHaveLength(1);
  });
});
