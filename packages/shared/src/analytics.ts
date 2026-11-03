// Pure helpers behind dashboards, reports, alerts and the ask-a-question box.
// Nothing here touches a database or the network, so all of it is unit-tested.
import { haversine } from "./geo.js";
import type { Fix } from "./trips.js";

// ---- statistics ----

export const sum = (xs: readonly number[]) => xs.reduce((a, b) => a + b, 0);
export const mean = (xs: readonly number[]) => (xs.length ? sum(xs) / xs.length : null);
export function percentile(xs: readonly number[], p: number): number | null {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * p;
  const lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo]! + (s[hi]! - s[lo]!) * (i - lo);
}
export const median = (xs: readonly number[]) => percentile(xs, 0.5);
/** Share as a percentage, or null when there is nothing to divide by. */
export const pct = (n: number, d: number): number | null => (d > 0 ? Math.round((n / d) * 1000) / 10 : null);
export const round = (x: number | null, digits = 1): number | null => (x == null || !Number.isFinite(x) ? null : Math.round(x * 10 ** digits) / 10 ** digits);

/** Compare a value with an earlier one: the change and the change as a percentage. */
export function delta(cur: number | null, prev: number | null): { abs: number; pct: number | null } | null {
  if (cur == null || prev == null) return null;
  return { abs: round(cur - prev, 2)!, pct: prev === 0 ? null : round(((cur - prev) / Math.abs(prev)) * 100, 1) };
}

/** The period to compare against: the same length just before, or the same dates a year earlier. */
export function periodBefore(from: Date, to: Date, mode: "prev" | "year"): { from: Date; to: Date } {
  if (mode === "year") {
    const f = new Date(from), t = new Date(to);
    f.setUTCFullYear(f.getUTCFullYear() - 1); t.setUTCFullYear(t.getUTCFullYear() - 1);
    return { from: f, to: t };
  }
  const len = to.getTime() - from.getTime();
  return { from: new Date(from.getTime() - len), to: new Date(from.getTime()) };
}

/**
 * Is `value` far outside what `history` usually looks like? Uses the median and the median absolute deviation,
 * so a few wild past values do not hide a real jump. Needs at least 5 past values.
 */
export function anomaly(value: number, history: readonly number[], threshold = 3.5): { score: number; unusual: boolean; typical: number; changePct: number | null } | null {
  if (history.length < 5) return null;
  const med = median(history)!;
  const dev = median(history.map((h) => Math.abs(h - med)))!;
  const scale = dev === 0 ? Math.max(Math.abs(med) * 0.05, 1e-9) : dev * 1.4826;
  const score = (value - med) / scale;
  return { score: Math.round(score * 10) / 10, unusual: Math.abs(score) >= threshold, typical: med, changePct: med === 0 ? null : Math.round(((value - med) / Math.abs(med)) * 1000) / 10 };
}

/** Expected values for the next days: the average for each weekday, scaled by the recent trend. */
export function forecast(series: readonly { date: string; value: number }[], days: number): { date: string; value: number }[] {
  if (series.length < 7) return [];
  const byDow: number[][] = [[], [], [], [], [], [], []];
  for (const p of series) byDow[new Date(`${p.date}T00:00:00Z`).getUTCDay()]!.push(p.value);
  const overall = mean(series.map((p) => p.value)) ?? 0;
  const dowAvg = byDow.map((v) => mean(v) ?? overall);
  const recent = series.slice(-7), before = series.slice(-14, -7);
  const trend = before.length === 7 && sum(before.map((p) => p.value)) > 0 ? Math.min(1.5, Math.max(0.67, sum(recent.map((p) => p.value)) / sum(before.map((p) => p.value)))) : 1;
  const last = new Date(`${series[series.length - 1]!.date}T00:00:00Z`);
  const out: { date: string; value: number }[] = [];
  for (let i = 1; i <= days; i++) {
    const d = new Date(last.getTime() + i * 86_400_000);
    out.push({ date: d.toISOString().slice(0, 10), value: Math.round(dowAvg[d.getUTCDay()]! * trend * 10) / 10 });
  }
  return out;
}

// ---- emissions ----

/** Kilograms of CO2 per litre burned (Environment and Climate Change Canada style factors, rounded). */
export const CO2_KG_PER_LITRE: Record<string, number> = { diesel: 2.68, gasoline: 2.31, propane: 1.51, cng: 1.93, hybrid: 2.31 };
export function co2Kg(litres: number, fuelType: string | null | undefined): number {
  return litres * (CO2_KG_PER_LITRE[fuelType ?? "diesel"] ?? 0);
}

// ---- driving behaviour from GPS fixes ----

export interface SafetyEvent { kind: "speeding" | "harsh_brake" | "harsh_accel"; time: string; lat: number; lng: number; value: number; durationS?: number }
export interface SafetyOptions { speedLimitKmh: number; harshKmhPerS: number; maxGapS: number; minSpeedingS: number }
export const DEFAULT_SAFETY: SafetyOptions = { speedLimitKmh: 105, harshKmhPerS: 9, maxGapS: 15, minSpeedingS: 10 };

/**
 * Speeding episodes (over the limit for a while) and harsh braking or acceleration (speed changing faster than about 0.25 g
 * between two fixes close together). Needs fixes a few seconds apart; sparse tracks give fewer events, never false ones.
 */
export function detectSafetyEvents(fixes: readonly Fix[], opts: Partial<SafetyOptions> = {}): SafetyEvent[] {
  const o = { ...DEFAULT_SAFETY, ...opts };
  const out: SafetyEvent[] = [];
  let run: { start: Fix; max: number; last: Fix } | null = null;
  const closeRun = () => {
    if (run) {
      const dur = (Date.parse(run.last.time) - Date.parse(run.start.time)) / 1000;
      if (dur >= o.minSpeedingS) out.push({ kind: "speeding", time: run.start.time, lat: run.start.lat, lng: run.start.lng, value: Math.round(run.max), durationS: Math.round(dur) });
    }
    run = null;
  };
  for (let i = 0; i < fixes.length; i++) {
    const f = fixes[i]!;
    if (f.speed > o.speedLimitKmh) { if (run) { run.max = Math.max(run.max, f.speed); run.last = f; } else run = { start: f, max: f.speed, last: f }; } else closeRun();
    const p = fixes[i - 1];
    if (!p) continue;
    const dt = (Date.parse(f.time) - Date.parse(p.time)) / 1000;
    if (dt <= 0 || dt > o.maxGapS) continue;
    const a = (f.speed - p.speed) / dt;
    if (a <= -o.harshKmhPerS) out.push({ kind: "harsh_brake", time: f.time, lat: f.lat, lng: f.lng, value: Math.round(-a * 10) / 10 });
    else if (a >= o.harshKmhPerS) out.push({ kind: "harsh_accel", time: f.time, lat: f.lat, lng: f.lng, value: Math.round(a * 10) / 10 });
  }
  closeRun();
  return out;
}

/** A 0 to 100 driving score: starts at 100 and loses points per event for every 100 km driven. Short drives are not over-punished. */
export function driverScore(km: number, ev: { speeding: number; harshBrake: number; harshAccel: number; incidents?: number }): number | null {
  if (km < 5) return null;
  const per100 = 100 / Math.max(km, 25);
  const penalty = (ev.speeding * 3 + ev.harshBrake * 2 + ev.harshAccel * 1.5 + (ev.incidents ?? 0) * 15) * per100;
  return Math.max(0, Math.min(100, Math.round(100 - penalty)));
}

// ---- route adherence ----

/** Distance in metres from a point to the nearest part of a path (a chain of lat/lng points). */
export function distanceToPath(lat: number, lng: number, path: readonly { lat: number; lng: number }[]): number {
  if (path.length === 0) return Infinity;
  if (path.length === 1) return haversine(lat, lng, path[0]!.lat, path[0]!.lng);
  const kx = 111_320 * Math.cos((lat * Math.PI) / 180), ky = 110_540;
  let best = Infinity;
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1]!, b = path[i]!;
    const ax = (a.lng - lng) * kx, ay = (a.lat - lat) * ky, bx = (b.lng - lng) * kx, by = (b.lat - lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2));
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}
/** Share (percent) of fixes within `withinM` metres of the planned path. Straight lines between stops are a rough guide, so the default allows 600 m. */
export function routeAdherence(fixes: readonly { lat: number; lng: number }[], path: readonly { lat: number; lng: number }[], withinM = 600): number | null {
  if (fixes.length === 0 || path.length < 2) return null;
  return pct(fixes.filter((f) => distanceToPath(f.lat, f.lng, path) <= withinM).length, fixes.length);
}

// ---- calculated fields ----

/**
 * Evaluate a formula such as `cost / stops * 100` with named values. Supports + - * / % ( ), unary minus, numbers, names and
 * abs, round, min, max, sqrt. Division by zero or a missing name gives null. No access to anything else.
 */
export function evalFormula(expr: string, vars: Readonly<Record<string, number | null | undefined>>): number | null {
  const toks = expr.match(/\s*(\d+\.?\d*|\.\d+|[A-Za-z_][A-Za-z0-9_]*|[-+*/%(),])/g);
  if (!toks || toks.join("").replace(/\s+/g, "") !== expr.replace(/\s+/g, "")) throw new Error("formula has characters that are not allowed");
  const t = toks.map((x) => x.trim());
  let i = 0;
  const FN: Record<string, (...a: number[]) => number> = { abs: Math.abs, round: (x, d = 0) => Math.round(x * 10 ** d) / 10 ** d, min: Math.min, max: Math.max, sqrt: Math.sqrt };
  const fail = () => { throw new Error("formula could not be read"); };
  function primary(): number | null {
    const x = t[i++];
    if (x === undefined) return fail();
    if (x === "(") { const v = expr_(); if (t[i++] !== ")") fail(); return v; }
    if (x === "-") { const v = primary(); return v == null ? null : -v; }
    if (/^[\d.]/.test(x)) return Number(x);
    if (t[i] === "(") {
      const f = FN[x]; if (!f) throw new Error(`unknown function ${x}`);
      i++;
      const args: (number | null)[] = [];
      if (t[i] !== ")") { do { args.push(expr_()); } while (t[i] === "," && ++i); }
      if (t[i++] !== ")") fail();
      return args.some((a) => a == null) ? null : f(...(args as number[]));
    }
    const v = vars[x];
    return v == null || !Number.isFinite(v) ? null : v;
  }
  function term(): number | null {
    let v = primary();
    while (t[i] === "*" || t[i] === "/" || t[i] === "%") {
      const op = t[i++]; const r = primary();
      if (v == null || r == null) { v = null; continue; }
      v = op === "*" ? v * r : r === 0 ? null : op === "/" ? v / r : v % r;
    }
    return v;
  }
  function expr_(): number | null {
    let v = term();
    while (t[i] === "+" || t[i] === "-") { const op = t[i++]; const r = term(); v = v == null || r == null ? null : op === "+" ? v + r : v - r; }
    return v;
  }
  const out = expr_();
  if (i < t.length) fail();
  return out == null || !Number.isFinite(out) ? null : out;
}

// ---- pivot ----

export type Agg = "sum" | "avg" | "count" | "min" | "max";
export function aggregate(values: readonly number[], agg: Agg): number | null {
  if (agg === "count") return values.length;
  if (!values.length) return null;
  switch (agg) { case "sum": return sum(values); case "avg": return sum(values) / values.length; case "min": return Math.min(...values); default: return Math.max(...values); }
}
/** Rows by columns table with totals. */
export function pivot(rows: readonly Record<string, unknown>[], rowKey: string, colKey: string, valueKey: string, agg: Agg = "sum") {
  const cols = [...new Set(rows.map((r) => String(r[colKey] ?? "")))].sort();
  const rowNames = [...new Set(rows.map((r) => String(r[rowKey] ?? "")))].sort();
  const cell = (rs: readonly Record<string, unknown>[]) => round(aggregate(rs.map((r) => Number(r[valueKey])).filter(Number.isFinite), agg), 2);
  return {
    columns: cols,
    rows: rowNames.map((name) => {
      const mine = rows.filter((r) => String(r[rowKey] ?? "") === name);
      return { name, cells: cols.map((c) => cell(mine.filter((r) => String(r[colKey] ?? "") === c))), total: cell(mine) };
    }),
    totals: cols.map((c) => cell(rows.filter((r) => String(r[colKey] ?? "") === c))),
    grand: cell(rows),
  };
}

// ---- ask a question ----

export interface Question { metric: string; by: string | null; from: Date; to: Date; periodLabel: string; order: "desc" | "asc"; limit: number }

const ASK_METRICS: [RegExp, string][] = [
  [/on[- ]?time/, "onTimeRate"], [/first[- ]attempt/, "firstAttemptRate"], [/(average )?delays?|late(ness)?|behind/, "avgDelayMin"], [/missed (time )?windows?/, "missedWindows"],
  [/fail(ed|ures?)/, "failedStops"], [/idle|idling/, "idleH"], [/harsh|hard (braking|brakes)/, "harshBrakes"], [/speeding|speeders?/, "speedingEvents"],
  [/fuel (economy|use|used)|l\/100|litres? per/, "lPer100"], [/fuel/, "fuelLitres"], [/co2|emissions?|carbon/, "co2Kg"], [/cost per km/, "costPerKm"], [/cost per stop/, "costPerStop"], [/cost|spend|expenses?/, "costTotal"],
  [/overtime/, "overtimeH"], [/incidents?|accidents?/, "incidents"], [/distance|kilomet(er|re)s?|km|mileage|drove|driven/, "distanceKm"], [/stops per hour/, "stopsPerHour"],
  [/stops|deliver(y|ies)|jobs/, "stops"], [/score|safest|safety/, "driverScore"], [/satisfaction|csat/, "csat"], [/repair|maintenance cost/, "repairCost"],
];
const ASK_BY: [RegExp, string][] = [[/driver|who\b/, "driver"], [/vehicle|truck|bus|van\b/, "vehicle"], [/route/, "route"], [/customer|client/, "customer"], [/depot|region|branch/, "depot"], [/(each|per|by) day|daily|which day|what day/, "day"]];
const LOWER_IS_BETTER = new Set(["avgDelayMin", "missedWindows", "failedStops", "idleH", "harshBrakes", "speedingEvents", "lPer100", "co2Kg", "costPerKm", "costPerStop", "costTotal", "overtimeH", "incidents", "repairCost", "fuelLitres"]);

function startOfDay(d: Date) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
/** Turn a plain-language question into what to compute. Returns null when it does not understand (the caller then shows examples). */
export function parseQuestion(text: string, now = new Date()): Question | null {
  const q = text.toLowerCase();
  const metric = ASK_METRICS.find(([re]) => re.test(q))?.[1];
  if (!metric) return null;
  let by = ASK_BY.find(([re]) => re.test(q))?.[1] ?? null;
  if (/which|who|top|most|least|worst|best|highest|lowest/.test(q) && !by) by = "driver";
  const today = startOfDay(now);
  let from = new Date(today.getTime() - 29 * 86_400_000), to = new Date(today.getTime() + 86_400_000), label = "last 30 days";
  const mStart = new Date(today.getFullYear(), today.getMonth(), 1);
  if (/last month|previous month/.test(q)) { from = new Date(today.getFullYear(), today.getMonth() - 1, 1); to = mStart; label = "last month"; }
  else if (/this month/.test(q)) { from = mStart; to = new Date(today.getTime() + 86_400_000); label = "this month"; }
  else if (/last week|previous week/.test(q)) { const dow = (today.getDay() + 6) % 7; to = new Date(today.getTime() - dow * 86_400_000); from = new Date(to.getTime() - 7 * 86_400_000); label = "last week"; }
  else if (/this week/.test(q)) { const dow = (today.getDay() + 6) % 7; from = new Date(today.getTime() - dow * 86_400_000); to = new Date(today.getTime() + 86_400_000); label = "this week"; }
  else if (/yesterday/.test(q)) { from = new Date(today.getTime() - 86_400_000); to = today; label = "yesterday"; }
  else if (/today/.test(q)) { from = today; to = new Date(today.getTime() + 86_400_000); label = "today"; }
  else if (/last 7 days|past week/.test(q)) { from = new Date(today.getTime() - 6 * 86_400_000); to = new Date(today.getTime() + 86_400_000); label = "last 7 days"; }
  else if (/this year/.test(q)) { from = new Date(today.getFullYear(), 0, 1); to = new Date(today.getTime() + 86_400_000); label = "this year"; }
  const lowerBetter = LOWER_IS_BETTER.has(metric);
  let order: "desc" | "asc" = "desc";
  if (/\b(best|safest)\b/.test(q)) order = lowerBetter ? "asc" : "desc";
  else if (/\bworst\b/.test(q)) order = lowerBetter ? "desc" : "asc";
  else if (/least|fewest|lowest|smallest/.test(q)) order = "asc";
  const n = /top (\d+)|(\d+) (most|least|worst|best)/.exec(q);
  return { metric, by, from, to, periodLabel: label, order, limit: Math.min(50, Number(n?.[1] ?? n?.[2] ?? 10)) };
}

/** Is a clock time inside quiet hours? Handles hours that wrap past midnight (22:00 to 06:00). */
export function inQuietHours(nowHHMM: string, start: string | null, end: string | null): boolean {
  if (!start || !end || start === end) return false;
  const s = start.slice(0, 5), e = end.slice(0, 5), n = nowHHMM.slice(0, 5);
  return s < e ? n >= s && n < e : n >= s || n < e;
}
