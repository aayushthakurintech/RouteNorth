import type { MessageKey } from "@routenorth/shared";

export type MetricMeta = Record<string, { unit: string; better: "up" | "down" | null }>;
export type Metrics = Record<string, number | null>;
export interface Filters { from: string; to: string; driverId?: string; vehicleId?: string; depotId?: string; /** bumps to ask for fresh data */ refresh?: number }

export const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const today = () => { const d = new Date(); return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10); };

export const PRESETS = ["today", "yesterday", "last7", "last30", "thisMonth"] as const;
export type Preset = (typeof PRESETS)[number];
export function presetRange(p: Preset, now = today()): { from: string; to: string } {
  switch (p) {
    case "today": return { from: now, to: now };
    case "yesterday": return { from: addDays(now, -1), to: addDays(now, -1) };
    case "last30": return { from: addDays(now, -29), to: now };
    case "thisMonth": return { from: `${now.slice(0, 8)}01`, to: now };
    default: return { from: addDays(now, -6), to: now };
  }
}

export function query(f: Filters, extra: Record<string, string> = {}): string {
  const p = new URLSearchParams({ from: f.from, to: f.to, ...extra });
  if (f.driverId) p.set("driverId", f.driverId);
  if (f.vehicleId) p.set("vehicleId", f.vehicleId);
  if (f.depotId) p.set("depotId", f.depotId);
  if (f.refresh) p.set("_r", String(f.refresh));
  return p.toString();
}

/** Print a metric with its unit, for example 93.4% or $1,204. */
export function fmtMetric(v: number | null | undefined, unit: string | undefined, locale: string, currency = "CAD"): string {
  if (v == null) return "—";
  const lc = locale === "fr" ? "fr-CA" : "en-CA";
  const num = (d: number) => new Intl.NumberFormat(lc, { maximumFractionDigits: d }).format(v);
  switch (unit) {
    case "%": return `${num(1)} %`.replace(" %", locale === "fr" ? " %" : "%");
    case "$": return new Intl.NumberFormat(lc, { style: "currency", currency, maximumFractionDigits: Math.abs(v) < 100 ? 2 : 0 }).format(v);
    case "min": return `${num(0)} min`;
    case "h": return `${num(1)} h`;
    case "km": return `${num(1)} km`;
    case "L": return `${num(0)} L`;
    case "kg": return `${num(0)} kg`;
    case "L/100km": return `${num(1)} L/100 km`;
    case "ratio": case "score": return num(1);
    default: return num(Math.abs(v) < 10 && !Number.isInteger(v) ? 1 : 0);
  }
}

export const metricLabel = (k: string) => `an_${k}` as MessageKey;

/** The dashboards people start from, one per role. Each is a list of widgets that can be changed and saved as a copy. */
export type WidgetKind = "kpi" | "trend" | "breakdown" | "reasons" | "insights" | "goals" | "safety" | "savings" | "live" | "forecast" | "benchmarks" | "ask" | "me" | "feedback";
export interface Widget {
  id: string; kind: WidgetKind; title?: string;
  metric?: string; metrics?: string[]; by?: string; chart?: "bar" | "line" | "pie" | "stacked" | "heat";
  /** Width in grid columns (1 to 4). */
  w?: number;
}
let seq = 0;
export const wid = () => `w${Date.now().toString(36)}${(seq++).toString(36)}`;
const k = (metric: string): Widget => ({ id: wid(), kind: "kpi", metric, w: 1 });
const trend = (metric: string, w = 2): Widget => ({ id: wid(), kind: "trend", metric, w });
const by = (metric: string, group: string, chart: Widget["chart"] = "bar", w = 2): Widget => ({ id: wid(), kind: "breakdown", metric, by: group, chart, w });

export const TEMPLATES: Record<string, { label: MessageKey; role: string; widgets: () => Widget[] }> = {
  executive: { label: "dash_executive", role: "manager", widgets: () => [k("costTotal"), k("onTimeRate"), k("utilizationPct"), k("csat"), trend("onTimeRate"), trend("costTotal"), { id: wid(), kind: "goals", w: 2 }, { id: wid(), kind: "insights", w: 2 }, { id: wid(), kind: "forecast", w: 4 }] },
  operations: { label: "dash_operations", role: "dispatcher", widgets: () => [{ id: wid(), kind: "live", w: 4 }, k("stopsDone"), k("failedStops"), k("missedWindows"), k("idleH"), trend("stopsDone"), { id: wid(), kind: "reasons", w: 2 }, by("onTimeRate", "route", "bar", 4)] },
  driver: { label: "dash_driver", role: "driver", widgets: () => [{ id: wid(), kind: "me", w: 4 }] },
  customer: { label: "dash_customer", role: "customer", widgets: () => [k("stopsDone"), k("onTimeRate"), k("failedStops"), k("avgDelayMin"), trend("onTimeRate"), by("avgDelayMin", "customer", "bar", 2), { id: wid(), kind: "reasons", w: 2 }, { id: wid(), kind: "feedback", w: 2 }] },
  finance: { label: "dash_finance", role: "manager", widgets: () => [k("costTotal"), k("costPerStop"), k("costPerKm"), k("costPerHour"), by("costTotal", "route", "bar", 2), by("costTotal", "vehicle", "bar", 2), trend("costPerStop"), trend("fuelCost")] },
  safety: { label: "dash_safety", role: "manager", widgets: () => [k("speedingEvents"), k("harshBrakes"), k("harshAccels"), k("incidents"), { id: wid(), kind: "safety", w: 4 }, by("driverScore", "driver", "bar", 4)] },
  sustainability: { label: "dash_sustainability", role: "manager", widgets: () => [k("fuelLitres"), k("co2Kg"), k("lPer100"), k("idleSharePct"), trend("co2Kg"), by("co2Kg", "vehicle", "pie", 2), { id: wid(), kind: "savings", w: 4 }] },
};

export function isTv(): boolean { return typeof window !== "undefined" && new URLSearchParams(window.location.search).has("tv"); }

export type Compare = "none" | "prev" | "year";
/** The same length of time just before (or a year before) the chosen dates. */
export function comparisonRange(f: Filters, mode: Compare): { from: string; to: string } | null {
  if (mode === "none") return null;
  const len = Math.round((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000) + 1;
  if (mode === "prev") return { from: addDays(f.from, -len), to: addDays(f.from, -1) };
  return { from: addDays(f.from, -365), to: addDays(f.to, -365) };
}

