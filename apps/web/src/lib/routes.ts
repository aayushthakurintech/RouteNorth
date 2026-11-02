import type { StopOutcome, StopStatus } from "@routenorth/shared";

export interface RouteSummary {
  id: string; name: string; date: string; status: string; vehicleId: string | null;
  stopCount: number; finishedCount: number;
}

export interface RouteStop {
  id: string; sequence: number; name: string; address: string | null; lat: number; lng: number; radiusM: number;
  windowStart: string | null; windowEnd: string | null; packages: number; notes: string | null;
  status: StopStatus; failureReason: string | null; eta: string | null; arrivedAt: string | null; departedAt: string | null;
}

export interface RouteDetail {
  id: string; name: string; date: string; status: string; vehicleId: string | null;
  startedAt: string | null; completedAt: string | null; stops: RouteStop[];
}

export interface RouteReport {
  summary: {
    total: number; done: number; failed: number; skipped: number; pending: number;
    onTime: number; early: number; late: number; noWindow: number; onTimePct: number | null;
  };
  stops: { id: string; outcome: StopOutcome; lateByS: number; dwellS: number | null }[];
}

export const STOP_COLORS: Record<StopStatus, string> = {
  pending: "#6b7280", arrived: "#f2a900", done: "#1a9850", failed: "#c0392b", skipped: "#94a3b8",
};

/** New order after moving the stop at `index` by `delta` (-1 up, +1 down). Returns null when it cannot move. */
export function moveStop(ids: string[], index: number, delta: -1 | 1): string[] | null {
  const to = index + delta;
  if (index < 0 || index >= ids.length || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  [next[index], next[to]] = [next[to]!, next[index]!];
  return next;
}

/** A datetime-local value (browser local time) to an ISO string, or undefined when empty. */
export function localToIso(value: string): string | undefined {
  if (!value) return undefined;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
