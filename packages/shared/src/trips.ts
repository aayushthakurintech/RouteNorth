import { haversine } from "./geo.js";

/** One GPS fix, as stored in the positions table. Fixes must be sorted by time. */
export interface Fix {
  time: string;
  lat: number;
  lng: number;
  /** km/h */
  speed: number;
  ignition: boolean | null;
  /** metres, when the device reports it */
  odometer?: number | null;
}

export interface TripOptions {
  /** At or above this speed (km/h) a vehicle counts as moving. */
  movingKmh: number;
  /** A trip ends once the vehicle has been stationary this long. Shorter pauses stay inside the trip. */
  endTripAfterSec: number;
  /** A silence longer than this splits trips and is never counted as distance. */
  maxGapSec: number;
  /** Segments implying more than this speed are GPS glitches and are ignored. */
  maxPlausibleKmh: number;
}

export const DEFAULT_TRIP_OPTIONS: TripOptions = {
  movingKmh: 3,
  endTripAfterSec: 5 * 60,
  maxGapSec: 15 * 60,
  maxPlausibleKmh: 200,
};

export interface Place { time: string; lat: number; lng: number }

export interface Trip {
  start: Place;
  end: Place;
  distanceM: number;
  durationS: number;
  /** Seconds spent stationary with the engine on, including short pauses inside the trip. */
  idleS: number;
  maxSpeedKmh: number;
  /** Average speed while moving, km/h. */
  avgSpeedKmh: number;
  fixCount: number;
  /** True when the trip ended because the data stopped, not because the vehicle parked. */
  endedByGap: boolean;
}

export interface Stop {
  start: Place;
  /** Equal to start's time plus duration; for an open stop (still parked) this is the last fix. */
  end: Place;
  durationS: number;
  /** Engine on for most of the stop (idling), as opposed to parked with the engine off. */
  idling: boolean;
  /** Still stationary at the end of the data. */
  open: boolean;
}

const t = (f: Fix) => new Date(f.time).getTime();
const place = (f: Fix): Place => ({ time: f.time, lat: f.lat, lng: f.lng });

/**
 * Distance covered between two consecutive fixes, in metres. Returns 0 for the cases that
 * would add error rather than distance: data gaps, impossible jumps, and GPS drift while parked.
 */
export function segmentDistance(a: Fix, b: Fix, o: TripOptions = DEFAULT_TRIP_OPTIONS): number {
  const dt = (t(b) - t(a)) / 1000;
  if (dt <= 0 || dt > o.maxGapSec) return 0;
  if (a.speed < o.movingKmh && b.speed < o.movingKmh) return 0;
  const straight = haversine(a.lat, a.lng, b.lat, b.lng);
  const capM = (o.maxPlausibleKmh / 3.6) * dt;
  // Prefer the vehicle's own odometer when it is present and consistent.
  if (a.odometer != null && b.odometer != null) {
    const d = b.odometer - a.odometer;
    if (d >= 0 && d <= capM) return d;
  }
  return straight > capM ? 0 : straight;
}

/**
 * Split a vehicle's fixes into trips and stops.
 *  - A trip starts at the first moving fix and ends once the vehicle has been stationary for
 *    `endTripAfterSec` (the trip's end is when it stopped, not when the timer expired).
 *  - Every stationary period of at least `endTripAfterSec` is reported as a stop.
 */
export function detectTrips(
  fixes: Fix[],
  options: Partial<TripOptions> = {},
): { trips: Trip[]; stops: Stop[] } {
  const o = { ...DEFAULT_TRIP_OPTIONS, ...options };
  const trips: Trip[] = [];
  const stops: Stop[] = [];

  interface Open {
    first: Fix; lastMoving: Fix; distanceM: number; idleS: number; movingS: number;
    maxSpeed: number; fixCount: number;
  }
  let trip: Open | null = null;
  // Start of the current stationary run (first stationary fix after movement or data start).
  let stillFrom: Fix | null = null;
  let stillIdleS = 0;
  let stillSeconds = 0;

  const closeStop = (end: Fix, open: boolean) => {
    if (!stillFrom) return;
    const durationS = (t(end) - t(stillFrom)) / 1000;
    if (durationS >= o.endTripAfterSec) {
      stops.push({
        start: place(stillFrom), end: place(end), durationS,
        idling: stillSeconds > 0 && stillIdleS / stillSeconds >= 0.5, open,
      });
    }
    stillFrom = null; stillIdleS = 0; stillSeconds = 0;
  };

  const finishTrip = (endFix: Fix, endedByGap: boolean) => {
    if (!trip) return;
    const durationS = (t(endFix) - t(trip.first)) / 1000;
    if (trip.distanceM > 0 || durationS > 0) {
      trips.push({
        start: place(trip.first), end: place(endFix), distanceM: trip.distanceM, durationS,
        idleS: trip.idleS, maxSpeedKmh: trip.maxSpeed,
        avgSpeedKmh: trip.movingS > 0 ? (trip.distanceM / trip.movingS) * 3.6 : 0,
        fixCount: trip.fixCount, endedByGap,
      });
    }
    trip = null;
  };

  let prev: Fix | null = null;
  for (const f of fixes) {
    const moving = f.speed >= o.movingKmh;
    const gap = prev ? (t(f) - t(prev)) / 1000 : 0;

    if (prev && gap > o.maxGapSec) {
      // Silence: close whatever was in progress at the last fix we saw.
      if (trip) finishTrip(trip.lastMoving, true);
      closeStop(prev, false);
      stillFrom = null;
    }
    const continuing = prev !== null && gap <= o.maxGapSec;

    if (moving) {
      if (stillFrom && continuing) {
        const stillFor = (t(f) - t(stillFrom)) / 1000;
        if (trip && stillFor >= o.endTripAfterSec) {
          finishTrip(trip.lastMoving, false);
        } else if (trip) {
          // Short pause inside a trip: it was idle time if the engine was on.
          trip.idleS += stillIdleS;
        }
        closeStop(f, false);
      } else if (stillFrom) {
        stillFrom = null;
      }
      if (!trip) {
        trip = { first: f, lastMoving: f, distanceM: 0, idleS: 0, movingS: 0, maxSpeed: f.speed, fixCount: 0 };
      } else if (continuing && prev) {
        const d = segmentDistance(prev, f, o);
        trip.distanceM += d;
        trip.movingS += (t(f) - t(prev)) / 1000;
      }
      trip.lastMoving = f;
      trip.maxSpeed = Math.max(trip.maxSpeed, f.speed);
      trip.fixCount += 1;
    } else {
      if (!stillFrom) {
        // The stationary run begins where the vehicle stopped: the previous (moving) fix if any.
        stillFrom = trip && continuing && prev ? prev : f;
        stillIdleS = 0;
        stillSeconds = 0;
      }
      if (prev && continuing) {
        const dt = (t(f) - t(prev)) / 1000;
        stillSeconds += dt;
        if (prev.ignition && f.ignition !== false) stillIdleS += dt;
      }
      if (trip) {
        trip.fixCount += 1;
        if ((t(f) - t(stillFrom)) / 1000 >= o.endTripAfterSec) finishTrip(trip.lastMoving, false);
      }
    }
    prev = f;
  }

  if (trip) {
    // Data ended mid-trip: close it at the last moving fix; if parked, the stop stays open.
    finishTrip(trip.lastMoving, !stillFrom);
    if (prev && stillFrom) closeStop(prev, true);
  } else if (stillFrom && prev) {
    closeStop(prev, true);
  }
  return { trips, stops };
}

export interface DayTotal {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  distanceM: number;
  /** Seconds stationary with the engine on. */
  idleS: number;
  movingS: number;
}

/**
 * Daily distance, idle and moving time for one vehicle, in the given IANA time zone.
 * Each interval between two fixes is credited to the local day of the later fix.
 */
export function dailyTotals(
  fixes: Fix[],
  timeZone = "America/Toronto",
  options: Partial<TripOptions> = {},
): DayTotal[] {
  const o = { ...DEFAULT_TRIP_OPTIONS, ...options };
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
  const days = new Map<string, DayTotal>();
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1]!;
    const b = fixes[i]!;
    const dt = (t(b) - t(a)) / 1000;
    if (dt <= 0 || dt > o.maxGapSec) continue;
    const date = fmt.format(new Date(b.time));
    const day = days.get(date) ?? { date, distanceM: 0, idleS: 0, movingS: 0 };
    day.distanceM += segmentDistance(a, b, o);
    if (a.speed >= o.movingKmh || b.speed >= o.movingKmh) day.movingS += dt;
    else if (a.ignition && b.ignition !== false) day.idleS += dt;
    days.set(date, day);
  }
  return [...days.values()].sort((x, y) => x.date.localeCompare(y.date));
}
