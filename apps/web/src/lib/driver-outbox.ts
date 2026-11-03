/**
 * Small things a driver sends from the road (a chat message, a call for help, an expense) wait here when there is no signal
 * and are sent again later. Every item carries a clientId, which the server uses to store it only once.
 */
export interface OutboxItem { id: string; method: "POST" | "PUT"; path: string; body: unknown; at: string }
export interface OutboxStorage { get(): string | null; set(v: string): void }

const KEY = "routenorth.driver.outbox";
export const browserStorage = (): OutboxStorage => ({
  get: () => { try { return localStorage.getItem(KEY); } catch { return null; } },
  set: (v) => { try { localStorage.setItem(KEY, v); } catch { /* storage is optional */ } },
});

export function readOutbox(s: OutboxStorage): OutboxItem[] {
  try { const v = JSON.parse(s.get() ?? "[]"); return Array.isArray(v) ? v : []; } catch { return []; }
}
export function addToOutbox(s: OutboxStorage, item: OutboxItem, max = 100): void {
  const all = readOutbox(s).filter((x) => x.id !== item.id);
  all.push(item);
  s.set(JSON.stringify(all.slice(-max)));
}

/** Send what is waiting, oldest first. Stops at the first network failure; drops items the server refuses for good (4xx other than 401/408/429). */
export async function flushOutbox(s: OutboxStorage, send: (i: OutboxItem) => Promise<{ status: number }>): Promise<{ sent: number; left: number; dropped: number; auth: boolean }> {
  const all = readOutbox(s);
  const keep: OutboxItem[] = [];
  let sent = 0, dropped = 0, auth = false, stopped = false;
  for (const item of all) {
    if (stopped) { keep.push(item); continue; }
    try {
      const { status } = await send(item);
      if (status >= 200 && status < 300) sent++;
      else if (status === 401) { auth = true; stopped = true; keep.push(item); }
      else if (status === 408 || status === 429 || status >= 500) { stopped = true; keep.push(item); }
      else dropped++;
    } catch { stopped = true; keep.push(item); }
  }
  s.set(JSON.stringify(keep));
  return { sent, left: keep.length, dropped, auth };
}
