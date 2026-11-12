export type SourceState = "live" | "quiet" | "not_connected" | "needs_setup" | "problem" | "not_built";
export interface DataSource { id: string; name: string; group: string; state: SourceState; summary: string; lastDataAt: string | null; next: { label: string; href: string } | null; needs: string[]; canTest: boolean }
export interface Result { checkedAt: string; counts: Record<SourceState, number>; sources: DataSource[]; needsAttention: number; totals: { vehicles: number; drivers: number; orders: number } }

export const STATE_LABEL: Record<SourceState, string> = { live: "Live", quiet: "Quiet", not_connected: "Not connected", needs_setup: "Needs setup", problem: "Problem", not_built: "Not built" };
export const STATE_TONE: Record<SourceState, "good" | "info" | "neutral" | "warn" | "bad"> = { live: "good", quiet: "info", not_connected: "neutral", needs_setup: "warn", problem: "bad", not_built: "neutral" };
export function ago(iso: string | null, now = Date.now()): string {
  if (!iso) return "never";
  const m = Math.round((now - new Date(iso).getTime()) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 2880) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
}

