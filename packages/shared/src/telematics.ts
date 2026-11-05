import { haversine } from "./geo.js";
import { DEFAULT_TRIP_OPTIONS, type Fix, type TripOptions } from "./trips.js";

/*
 * Calculations that sit on top of cleaned positions: idling, fuel, harsh-event grading, utilization and
 * track simplification. All pure and deterministic. Every constant below that is an estimate says so, and
 * can be overridden per vehicle, so no screen presents an estimate as a measurement.
 */

// ---------------------------------------------------------------- idling

export interface IdleEpisode {
  start: string;
  end: string;
  durationS: number;
  lat: number;
  lng: number;
  /** What ended it: the vehicle moved, the engine was switched off, the data stopped, or the data simply ran out. */
  endedBy: "moving" | "ignition_off" | "gap" | "data_end";
}

export interface IdleOptions {
  /** Shorter engine-on pauses (traffic lights, a delivery handoff) are not reported as episodes. */
  minSeconds: number;
}
export const DEFAULT_IDLE: IdleOptions = { minSeconds: 120 };

const ms = (f: Fix) => Date.parse(f.time);

/**
 * Engine on, not moving. An interval between two fixes counts as idling by the same rule `dailyTotals` uses
 * (stationary at both ends, engine not reported off), so episode totals and daily totals always agree.
 * Fixes without an ignition value cannot be called idle: that is "unknown", not "idle".
 */
export function idleEpisodes(fixes: readonly Fix[], idle: Partial<IdleOptions> = {}, trip: Partial<TripOptions> = {}): IdleEpisode[] {
  const o = { ...DEFAULT_IDLE, ...idle };
  const to = { ...DEFAULT_TRIP_OPTIONS, ...trip };
  const out: IdleEpisode[] = [];
  let cur: { start: Fix; last: Fix; seconds: number } | null = null;

  const close = (endedBy: IdleEpisode["endedBy"]) => {
    if (cur && cur.seconds >= o.minSeconds) {
      out.push({ start: cur.start.time, end: cur.last.time, durationS: Math.round(cur.seconds), lat: cur.start.lat, lng: cur.start.lng, endedBy });
    }
    cur = null;
  };

  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1]!, b = fixes[i]!;
    const dt = (ms(b) - ms(a)) / 1000;
    if (dt <= 0) continue;
    if (dt > to.maxGapSec) { close("gap"); continue; }
    const stationary = a.speed < to.movingKmh && b.speed < to.movingKmh;
    const engineOn = a.ignition === true && b.ignition !== false;
    if (stationary && engineOn) {
      if (!cur) cur = { start: a, last: b, seconds: 0 };
      cur.seconds += dt;
      cur.last = b;
    } else {
      close(b.ignition === false && stationary ? "ignition_off" : "moving");
    }
  }
  close("data_end");
  return out;
}

export type VehicleClass = "truck" | "bus" | "van" | "car";

/** Typical idle burn in litres per hour. Estimates for planning: engine size, temperature and accessories change them a lot. */
export const IDLE_LITRES_PER_HOUR: Record<VehicleClass, number> = { truck: 3.8, bus: 3.0, van: 1.7, car: 0.9 };
/** Typical on-road consumption in litres per 100 km, used only when nothing better is known. */
export const DRIVING_LITRES_PER_100KM: Record<VehicleClass, number> = { truck: 32, bus: 30, van: 14, car: 9 };

/** Typical tank sizes in litres, used only when the vehicle has none recorded. */
export const DEFAULT_TANK_LITRES: Record<VehicleClass, number> = { truck: 400, bus: 250, van: 80, car: 60 };

export const vehicleClass = (kind: string | null | undefined): VehicleClass => (kind === "truck" || kind === "bus" || kind === "van" ? kind : "car");

export interface IdleCost { hours: number; litres: number; cost: number | null; co2Kg: number }

/** What idling cost: fuel, money (when a price is given) and CO₂ (2.68 kg per litre of diesel, 2.31 for gasoline). */
export function idleCost(seconds: number, kind: string | null | undefined, o: { litresPerHour?: number; pricePerLitre?: number | null; fuelType?: "diesel" | "gasoline" } = {}): IdleCost {
  const hours = seconds / 3600;
  const litres = hours * (o.litresPerHour ?? IDLE_LITRES_PER_HOUR[vehicleClass(kind)]);
  const co2PerLitre = o.fuelType === "gasoline" ? 2.31 : 2.68;
  return {
    hours: Math.round(hours * 100) / 100,
    litres: Math.round(litres * 10) / 10,
    cost: o.pricePerLitre != null ? Math.round(litres * o.pricePerLitre * 100) / 100 : null,
    co2Kg: Math.round(litres * co2PerLitre * 10) / 10,
  };
}

/** Idle as a share of engine-on time. Null when the engine was never on. */
export function idlePercent(idleS: number, movingS: number): number | null {
  const on = idleS + movingS;
  return on > 0 ? Math.round((idleS / on) * 1000) / 10 : null;
}

// ---------------------------------------------------------------- fuel

export interface FuelEstimate { litres: number; lPer100: number; basis: "measured" | "typical" }

/** Fuel used over a stretch: driving by distance plus idling by time. Uses the vehicle's measured economy when known. */
export function estimateFuel(i: { km: number; idleS: number; kind: string | null | undefined; measuredLPer100?: number | null; idleLitresPerHour?: number }): FuelEstimate {
  const cls = vehicleClass(i.kind);
  const rate = i.measuredLPer100 && i.measuredLPer100 > 0 ? i.measuredLPer100 : DRIVING_LITRES_PER_100KM[cls];
  const driving = (i.km / 100) * rate;
  const idling = (i.idleS / 3600) * (i.idleLitresPerHour ?? IDLE_LITRES_PER_HOUR[cls]);
  return { litres: Math.round((driving + idling) * 10) / 10, lPer100: rate, basis: i.measuredLPer100 && i.measuredLPer100 > 0 ? "measured" : "typical" };
}

export interface FuelSample { time: string; pct: number; speed: number; ignition: boolean | null }
export interface FuelEvent { kind: "refuel" | "drain"; time: string; endTime: string; fromPct: number; toPct: number; litres: number }
export interface FuelEventOptions {
  tankLitres: number;
  /** A change smaller than this (percent of the tank) is noise. */
  minChangePct: number;
  /** Sensor readings jump around while fuel sloshes; the median of this many readings is used. */
  smoothing: number;
  /** A stationary stretch with a silence longer than this is split. */
  maxGapSec: number;
  movingKmh: number;
  /** Litres per hour the engine legitimately burns while idling, so slow idle consumption is not called theft. */
  idleLitresPerHour: number;
}
export const DEFAULT_FUEL_EVENTS: Omit<FuelEventOptions, "tankLitres"> = { minChangePct: 8, smoothing: 5, maxGapSec: 20 * 60, movingKmh: 3, idleLitresPerHour: 3.8 };

function medianSmooth(xs: readonly number[], window: number): number[] {
  const half = Math.floor(window / 2);
  const last = xs.length - 1;
  // Edges repeat their end value, so a steady fall or rise keeps its true start and end instead of being flattened.
  return xs.map((_, i) => {
    const w: number[] = [];
    for (let k = i - half; k <= i + half; k++) w.push(xs[Math.min(last, Math.max(0, k))]!);
    w.sort((a, b) => a - b);
    return w[Math.floor(w.length / 2)]!;
  });
}

/**
 * Refuels and suspected drains from a fuel level sensor. Only stationary stretches are judged: while driving,
 * fuel sloshes and the level legitimately falls. A stretch that gained at least `minChangePct` is a refuel.
 * One that lost that much beyond what idling explains is a drain (possible theft or a leak) — a prompt to
 * look, not proof.
 */
export function fuelEvents(samples: readonly FuelSample[], opts: Partial<FuelEventOptions> & { tankLitres: number }): FuelEvent[] {
  const o = { ...DEFAULT_FUEL_EVENTS, ...opts };
  if (samples.length < 2) return [];
  const smooth = medianSmooth(samples.map((s) => s.pct), o.smoothing);
  const events: FuelEvent[] = [];
  let startIdx: number | null = null;

  const finish = (endIdx: number) => {
    if (startIdx == null || endIdx <= startIdx) { startIdx = null; return; }
    const a = samples[startIdx]!, b = samples[endIdx]!;
    const from = smooth[startIdx]!, to = smooth[endIdx]!;
    const seconds = (Date.parse(b.time) - Date.parse(a.time)) / 1000;
    const delta = to - from;
    const idleBurnPct = a.ignition !== false ? ((seconds / 3600) * o.idleLitresPerHour / o.tankLitres) * 100 : 0;
    if (delta >= o.minChangePct) {
      events.push({ kind: "refuel", time: a.time, endTime: b.time, fromPct: round1(from), toPct: round1(to), litres: round1((delta / 100) * o.tankLitres) });
    } else if (-delta - idleBurnPct >= o.minChangePct) {
      events.push({ kind: "drain", time: a.time, endTime: b.time, fromPct: round1(from), toPct: round1(to), litres: round1(((-delta - idleBurnPct) / 100) * o.tankLitres) });
    }
    startIdx = null;
  };

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i]!;
    const still = s.speed < o.movingKmh;
    const prev = samples[i - 1];
    const gap = prev ? (Date.parse(s.time) - Date.parse(prev.time)) / 1000 : 0;
    if (startIdx != null && (!still || gap > o.maxGapSec)) finish(i - 1);
    if (still && startIdx == null) startIdx = i;
  }
  if (startIdx != null) finish(samples.length - 1);
  return events;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Litres burned while moving, from the sensor, for the "measured economy" figure. Refuels (rises) are ignored. */
export function sensorLitresUsed(samples: readonly FuelSample[], tankLitres: number, movingKmh = 3): number {
  if (samples.length < 2) return 0;
  const smooth = medianSmooth(samples.map((s) => s.pct), 5);
  let pct = 0;
  for (let i = 1; i < samples.length; i++) {
    if (samples[i]!.speed < movingKmh && samples[i - 1]!.speed < movingKmh) continue;
    const d = smooth[i]! - smooth[i - 1]!;
    if (d < 0) pct += -d;
  }
  return round1((pct / 100) * tankLitres);
}

// ---------------------------------------------------------------- harsh events

export type Severity = "moderate" | "severe" | "extreme";
const G = 9.80665;

/** Acceleration in g from a speed change in km/h per second. */
export const kmhPerSecToG = (kmhPerS: number): number => Math.round(((Math.abs(kmhPerS) / 3.6) / G) * 100) / 100;

/** Grade a harsh braking or acceleration event by how hard it was. Under 0.25 g is not reported at all. */
export function harshSeverity(kmhPerS: number): Severity | null {
  const g = Math.abs(kmhPerS) / 3.6 / G;
  if (g >= 0.5) return "extreme";
  if (g >= 0.35) return "severe";
  if (g >= 0.25) return "moderate";
  return null;
}

/** Speeding grade by how far over the limit the maximum was. */
export function speedingSeverity(maxKmh: number, limitKmh: number): Severity | null {
  const over = maxKmh - limitKmh;
  if (over >= 30) return "extreme";
  if (over >= 20) return "severe";
  if (over >= 10) return "moderate";
  return null;
}

export interface GradedEvent { kind: string; time: string; source: "gps" | "device" }

/**
 * A harsh event the tracker's accelerometer raised and the same event derived from GPS speed changes are one event,
 * not two. Keep the device's (its accelerometer samples far faster than GPS) and drop GPS duplicates within `windowS`.
 */
export function mergeEvents<T extends { kind: string; time: string }>(gps: readonly T[], device: readonly T[], windowS = 15): (T & { source: "gps" | "device" })[] {
  const out: (T & { source: "gps" | "device" })[] = device.map((e) => ({ ...e, source: "device" as const }));
  for (const g of gps) {
    const t = Date.parse(g.time);
    if (device.some((d) => d.kind === g.kind && Math.abs(Date.parse(d.time) - t) <= windowS * 1000)) continue;
    out.push({ ...g, source: "gps" });
  }
  return out.sort((a, b) => a.time.localeCompare(b.time));
}

// ---------------------------------------------------------------- utilization

export interface DayUse { date: string; movingS: number; idleS: number; km: number }
export interface UtilizationOptions {
  /** Hours in a normal working day for this fleet. */
  workdayHours: number;
  /** Below this share of the workday moving, the vehicle counts as lightly used. */
  lightUsePct: number;
}
export const DEFAULT_UTILIZATION: UtilizationOptions = { workdayHours: 10, lightUsePct: 20 };

export interface Utilization {
  daysTracked: number;
  daysUsed: number;
  /** Share of tracked days with any real driving (over 1 km). */
  daysUsedPct: number | null;
  /** Average share of the workday spent moving, on days it was used. */
  movingPct: number | null;
  /** Average share of the workday with the engine on, on days it was used. */
  engineOnPct: number | null;
  avgKmPerUsedDay: number | null;
  level: "none" | "light" | "normal";
}

/** How much a vehicle actually works. Unused days count against "days used", not against the averages. */
export function utilization(days: readonly DayUse[], opts: Partial<UtilizationOptions> = {}): Utilization {
  const o = { ...DEFAULT_UTILIZATION, ...opts };
  const used = days.filter((d) => d.km > 1);
  const avg = (f: (d: DayUse) => number) => (used.length ? used.reduce((a, d) => a + f(d), 0) / used.length : null);
  const pct = (n: number | null) => (n == null ? null : Math.round(Math.min(100, n) * 10) / 10);
  const workS = o.workdayHours * 3600;
  const movingPct = pct(avg((d) => (d.movingS / workS) * 100));
  return {
    daysTracked: days.length,
    daysUsed: used.length,
    daysUsedPct: days.length ? Math.round((used.length / days.length) * 1000) / 10 : null,
    movingPct,
    engineOnPct: pct(avg((d) => ((d.movingS + d.idleS) / workS) * 100)),
    avgKmPerUsedDay: used.length ? Math.round((used.reduce((a, d) => a + d.km, 0) / used.length) * 10) / 10 : null,
    level: used.length === 0 ? "none" : (movingPct ?? 0) < o.lightUsePct ? "light" : "normal",
  };
}

// ---------------------------------------------------------------- track simplification

/**
 * Douglas–Peucker: fewer points, same shape. A 24-hour breadcrumb of 17 000 fixes draws with a few hundred
 * points at a 5 m tolerance. First and last points are always kept.
 */
export function simplifyTrack<T extends { lat: number; lng: number }>(points: readonly T[], toleranceM = 5): T[] {
  if (points.length <= 2) return [...points];
  const keep = new Uint8Array(points.length);
  keep[0] = 1; keep[points.length - 1] = 1;
  const stack: [number, number][] = [[0, points.length - 1]];
  while (stack.length) {
    const [lo, hi] = stack.pop()!;
    let worst = -1, worstD = 0;
    for (let i = lo + 1; i < hi; i++) {
      const d = perpendicularM(points[i]!, points[lo]!, points[hi]!);
      if (d > worstD) { worstD = d; worst = i; }
    }
    if (worst !== -1 && worstD > toleranceM) { keep[worst] = 1; stack.push([lo, worst], [worst, hi]); }
  }
  return points.filter((_, i) => keep[i]);
}

/** Distance from p to the segment a–b, in metres, on a local flat projection (accurate at fleet scales). */
function perpendicularM(p: { lat: number; lng: number }, a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const kx = 111_320 * Math.cos((a.lat * Math.PI) / 180), ky = 110_540;
  const ax = 0, ay = 0, bx = (b.lng - a.lng) * kx, by = (b.lat - a.lat) * ky;
  const px = (p.lng - a.lng) * kx, py = (p.lat - a.lat) * ky;
  const len2 = bx * bx + by * by;
  if (len2 === 0) return haversine(p.lat, p.lng, a.lat, a.lng);
  const t = Math.max(0, Math.min(1, ((px - ax) * bx + (py - ay) * by) / len2));
  return Math.hypot(px - (ax + t * bx), py - (ay + t * by));
}
