import { haversine } from "./geo.js";

export type StopStatus = "pending" | "arrived" | "done" | "failed" | "skipped";

/** The parts of a stop the arrival detector needs. */
export interface StopState {
  id: string;
  lat: number;
  lng: number;
  radiusM: number;
  status: StopStatus;
  /** First fix of the current stay inside the radius (not yet long enough to count as arrival). */
  insideSince: string | null;
  /** First fix beyond the departure radius after arriving. */
  outsideSince: string | null;
  arrivedAt: string | null;
  departedAt: string | null;
}

export interface ArrivalOptions {
  /** Must stay inside the radius this long before it counts as an arrival. Filters drive-bys and GPS spikes. */
  dwellSec: number;
  /** While inside the radius, faster than this does not count as stopped. */
  maxArrivalKmh: number;
  /** Departure radius is the stop radius times this, so GPS jitter at the edge does not flip the state. */
  departFactor: number;
  /** Must stay beyond the departure radius this long before it counts as a departure. */
  departSec: number;
}

export const DEFAULT_ARRIVAL_OPTIONS: ArrivalOptions = {
  dwellSec: 30,
  maxArrivalKmh: 15,
  departFactor: 1.5,
  departSec: 20,
};

export interface StopPatch {
  status: StopStatus;
  insideSince: string | null;
  outsideSince: string | null;
  arrivedAt: string | null;
  departedAt: string | null;
}

interface FixLike { time: string; lat: number; lng: number; speed: number }

const ms = (iso: string) => new Date(iso).getTime();

/**
 * Feed one GPS fix to a stop. Returns the new state, or null when nothing changed.
 * Stops move pending -> arrived -> done; a stop marked done, failed or skipped is never touched.
 * Arrival is stamped with the first fix of the stay, departure with the first fix of the exit.
 */
export function evaluateStop(
  stop: StopState,
  fix: FixLike,
  options: Partial<ArrivalOptions> = {},
): StopPatch | null {
  const o = { ...DEFAULT_ARRIVAL_OPTIONS, ...options };
  if (stop.status === "done" || stop.status === "failed" || stop.status === "skipped") return null;

  const distance = haversine(fix.lat, fix.lng, stop.lat, stop.lng);
  const next: StopPatch = {
    status: stop.status, insideSince: stop.insideSince, outsideSince: stop.outsideSince,
    arrivedAt: stop.arrivedAt, departedAt: stop.departedAt,
  };

  if (stop.status === "pending") {
    if (distance <= stop.radiusM && fix.speed <= o.maxArrivalKmh) {
      next.insideSince = stop.insideSince ?? fix.time;
      if (ms(fix.time) - ms(next.insideSince) >= o.dwellSec * 1000) {
        next.status = "arrived";
        next.arrivedAt = next.insideSince;
        next.insideSince = null;
      }
    } else {
      next.insideSince = null; // left the radius, or driving through it: start over
    }
  } else {
    // arrived
    if (distance > stop.radiusM * o.departFactor) {
      next.outsideSince = stop.outsideSince ?? fix.time;
      if (ms(fix.time) - ms(next.outsideSince) >= o.departSec * 1000) {
        next.status = "done";
        next.departedAt = next.outsideSince;
        next.outsideSince = null;
      }
    } else {
      next.outsideSince = null;
    }
  }

  const changed =
    next.status !== stop.status || next.insideSince !== stop.insideSince || next.outsideSince !== stop.outsideSince ||
    next.arrivedAt !== stop.arrivedAt || next.departedAt !== stop.departedAt;
  return changed ? next : null;
}

export interface EtaOptions {
  /** Assumed average driving speed when we have nothing better, km/h. */
  cruiseKmh: number;
  /** Roads are longer than straight lines. */
  roadFactor: number;
  /** Time spent at each stop before moving on. */
  serviceSec: number;
}

export const DEFAULT_ETA_OPTIONS: EtaOptions = { cruiseKmh: 40, roadFactor: 1.3, serviceSec: 300 };

/**
 * Rough arrival time at each remaining stop, in route order, driving from `from` through the
 * stops one after another. This is a straight-line estimate; a routing engine replaces it later.
 */
export function estimateEtas(
  remaining: { id: string; lat: number; lng: number }[],
  from: { lat: number; lng: number; time: string },
  options: Partial<EtaOptions> = {},
): Map<string, string> {
  const o = { ...DEFAULT_ETA_OPTIONS, ...options };
  const etas = new Map<string, string>();
  let at = ms(from.time);
  let here = from;
  for (const s of remaining) {
    const metres = haversine(here.lat, here.lng, s.lat, s.lng) * o.roadFactor;
    at += (metres / (o.cruiseKmh / 3.6)) * 1000;
    etas.set(s.id, new Date(at).toISOString());
    at += o.serviceSec * 1000;
    here = { lat: s.lat, lng: s.lng, time: new Date(at).toISOString() };
  }
  return etas;
}

export type StopOutcome = "early" | "on_time" | "late" | "no_window" | "missed" | "pending";

/** Planned vs actual for one stop. */
export function classifyStop(s: {
  status: StopStatus;
  windowStart: string | null;
  windowEnd: string | null;
  arrivedAt: string | null;
}): StopOutcome {
  if (s.status === "failed" || s.status === "skipped") return "missed";
  if (!s.arrivedAt) return "pending";
  if (!s.windowStart && !s.windowEnd) return "no_window";
  if (s.windowEnd && ms(s.arrivedAt) > ms(s.windowEnd)) return "late";
  if (s.windowStart && ms(s.arrivedAt) < ms(s.windowStart)) return "early";
  return "on_time";
}
