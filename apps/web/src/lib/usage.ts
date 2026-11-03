"use client";
import { apiSend } from "./api";
import { API_URL, loadSession } from "./session";

/**
 * Product analytics without people: which pages and features get used. Events are batched and sent every 20 seconds,
 * or when the tab is hidden. Only a name goes out (ids are removed on the server too); the server drops it if the
 * organization opted out.
 */
interface UsageEvent { kind: "page" | "feature"; name: string }
let queue: UsageEvent[] = [];
let timer: ReturnType<typeof setTimeout> | undefined;
let hooked = false;

export function track(kind: UsageEvent["kind"], name: string): void {
  if (typeof window === "undefined" || !loadSession()) return;
  queue.push({ kind, name: name.slice(0, 80) });
  if (!hooked) {
    hooked = true;
    document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flush(true); });
  }
  if (queue.length >= 25) flush(false);
  else if (!timer) timer = setTimeout(() => flush(false), 20_000);
}

function flush(leaving: boolean): void {
  if (timer) { clearTimeout(timer); timer = undefined; }
  const events = queue.splice(0, 50);
  if (!events.length) return;
  const s = loadSession();
  if (!s) return;
  if (leaving) {
    void fetch(`${API_URL}/ops/usage`, { method: "POST", keepalive: true, headers: { Authorization: `Bearer ${s.token}`, "content-type": "application/json" }, body: JSON.stringify({ events }) }).catch(() => {});
  } else {
    void apiSend("POST", "/ops/usage", { events }).catch(() => { /* analytics must never get in the way */ });
  }
}
