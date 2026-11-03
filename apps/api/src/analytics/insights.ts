import { anomaly, median, pct } from "@routenorth/shared";
import type { Bundle, Metrics } from "./analytics.service.js";

/** A finding in plain language. The browser turns `type` and `params` into a sentence in the person's language. */
export interface Insight { type: "routeLate" | "costJump" | "idleHigh" | "onTimeChange" | "failedRising" | "allGood" | "driverSafety"; severity: "info" | "warn" | "critical"; params: Record<string, string | number>; link?: string }

const dateOf = (d: string) => d;
const lastDays = (b: Bundle, n: number) => { const end = Date.parse(b.range.to); return new Set(Array.from({ length: n }, (_, i) => new Date(end - i * 86_400_000).toISOString().slice(0, 10))); };

/**
 * Read a window of recent data (about four weeks) and say what stands out:
 * routes that keep running late, routes that cost much more than usual, drivers who idle far above the fleet,
 * and big swings in on-time rate.
 */
export function buildInsights(b: Bundle, current: Metrics, previous: Metrics | null): Insight[] {
  const out: Insight[] = [];
  const last7 = lastDays(b, 7);

  // Routes (by name, since repeat routes share a name) that were late on most recent days.
  const byName = new Map<string, Map<string, { late: boolean; km: number }>>();
  for (const r of b.routes) {
    const withWindow = r.stops.filter((s) => s.windowEnd && s.arrivedAt);
    if (withWindow.length === 0) continue;
    const late = withWindow.some((s) => s.arrivedAt! > s.windowEnd!);
    const days = byName.get(r.name) ?? new Map();
    const prev = days.get(dateOf(r.date));
    days.set(dateOf(r.date), { late: (prev?.late ?? false) || late, km: (prev?.km ?? 0) + r.actualKm });
    byName.set(r.name, days);
  }
  for (const [name, days] of byName) {
    const recent = [...days.entries()].filter(([d]) => last7.has(d));
    const lateDays = recent.filter(([, v]) => v.late).length;
    if (recent.length >= 3 && lateDays / recent.length >= 0.6) out.push({ type: "routeLate", severity: lateDays === recent.length ? "critical" : "warn", params: { route: name, late: lateDays, days: recent.length } });
    // Cost jump: the newest day against the days before it.
    const sorted = [...days.entries()].sort(([a], [c]) => a.localeCompare(c));
    const newest = sorted[sorted.length - 1];
    if (newest && last7.has(newest[0]) && sorted.length >= 6) {
      const hist = sorted.slice(0, -1).map(([, v]) => v.km * b.costPerKm).filter((x) => x > 0);
      const a = anomaly(newest[1].km * b.costPerKm, hist);
      if (a?.unusual && a.changePct != null && a.changePct > 0) out.push({ type: "costJump", severity: a.changePct >= 50 ? "critical" : "warn", params: { route: name, pct: Math.round(a.changePct) } });
    }
  }

  // Drivers who sit with the engine running far more than the fleet does.
  const perDriver = new Map<string, { idle: number; on: number }>();
  for (const m of b.mv) {
    if (!m.driverId) continue;
    const e = perDriver.get(m.driverId) ?? { idle: 0, on: 0 };
    e.idle += m.idleS; e.on += m.idleS + m.movingS;
    perDriver.set(m.driverId, e);
  }
  const shares = [...perDriver.values()].map((e) => pct(e.idle, e.on)).filter((x): x is number => x != null);
  const med = median(shares);
  if (med != null && shares.length >= 3) {
    for (const [id, e] of perDriver) {
      const s = pct(e.idle, e.on);
      if (s != null && e.on > 3600 * 5 && s >= Math.max(med * 1.6, med + 10)) out.push({ type: "idleHigh", severity: "warn", params: { driver: b.names.driver.get(id) ?? id, pct: Math.round(s), fleet: Math.round(med) }, link: "/reports" });
    }
  }

  // Safety: a driver with many harsh events.
  const events = new Map<string, number>();
  for (const e of b.safe) if (e.driverId) events.set(e.driverId, (events.get(e.driverId) ?? 0) + 1);
  const top = [...events.entries()].sort((a, c) => c[1] - a[1])[0];
  if (top && top[1] >= 10) out.push({ type: "driverSafety", severity: "warn", params: { driver: b.names.driver.get(top[0]) ?? top[0], n: top[1] } });

  // Change against the previous period.
  if (previous && current.onTimeRate != null && previous.onTimeRate != null && Math.abs(current.onTimeRate - previous.onTimeRate) >= 5) {
    out.push({ type: "onTimeChange", severity: current.onTimeRate < previous.onTimeRate ? "warn" : "info", params: { now: current.onTimeRate, before: previous.onTimeRate } });
  }
  if (previous && (current.failedStops ?? 0) >= 5 && (previous.failedStops ?? 0) > 0 && (current.failedStops ?? 0) >= (previous.failedStops ?? 0) * 1.5) {
    out.push({ type: "failedRising", severity: "warn", params: { now: current.failedStops ?? 0, before: previous.failedStops ?? 0 } });
  }
  if (out.length === 0) out.push({ type: "allGood", severity: "info", params: {} });
  const rank = { critical: 0, warn: 1, info: 2 } as const;
  return out.sort((a, c) => rank[a.severity] - rank[c.severity]).slice(0, 12);
}
