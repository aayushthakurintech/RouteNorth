import { haversine } from "./geo.js";

/*
 * Telemetry pipeline rules. Everything here is a pure function so the same rules run in the ingest
 * service, in tests and in the device simulator. Order of operations for every incoming position:
 *
 *   1. normalize  – a protocol adapter (Traccar, generic JSON) turns the raw message into a `Reading`
 *   2. assess     – `assessReading` decides: store everything, store only as "latest", or reject (with a reason)
 *   3. events     – `eventsFromAttributes` lifts alarms (SOS, harsh braking, power cut…) out of the raw attributes
 *   4. persist    – ingest writes positions / latest_positions / device_events in one transaction
 */

/** One position plus the sensor values a tracker may send with it. Anything a device does not send is null. */
export interface Reading {
  externalId: string;
  /** ISO 8601 UTC time of the fix (device clock, GPS-disciplined on every real tracker). */
  time: string;
  lat: number;
  lng: number;
  /** km/h */
  speed: number;
  /** degrees 0–359 */
  heading: number;
  ignition: boolean | null;
  /** metres, as counted by the vehicle or the tracker */
  odometer: number | null;
  /** metres above sea level */
  altitude: number | null;
  /** horizontal dilution of precision: lower is better, under 2 is excellent, over 5 is poor */
  hdop: number | null;
  satellites: number | null;
  /** 0–100 */
  batteryPct: number | null;
  /** vehicle supply voltage in volts (a drop to 0 while the battery still reports is a power cut) */
  extVoltage: number | null;
  /** 0–100, from a fuel level sensor or the CAN bus */
  fuelLevelPct: number | null;
  rpm: number | null;
  /** hours */
  engineHours: number | null;
  coolantC: number | null;
  /** mobile signal 0–5 bars */
  signal: number | null;
  attributes: Record<string, unknown>;
}

export type RejectReason =
  | "bad_coordinates" | "null_island" | "bad_time" | "future_time" | "too_old"
  | "bad_speed" | "no_satellites" | "poor_accuracy" | "position_jump";

export type Verdict =
  | { action: "store"; flags: Flag[] }
  /** Parked and unchanged: refresh "last seen" but keep the position history lean. */
  | { action: "latest_only"; flags: Flag[] }
  /** Arrived late or out of order: keep it in history, never let it move the live marker. */
  | { action: "history_only"; flags: Flag[] }
  | { action: "reject"; reason: RejectReason; flags: Flag[] };

export type Flag = "poor_hdop" | "rebaselined" | "late_arrival" | "snapped_parked";

export interface DeviceState {
  time: string;
  lat: number;
  lng: number;
  speed: number;
  ignition: boolean | null;
  /** consecutive fixes rejected as impossible jumps since the last accepted one */
  jumpStreak?: number;
}

export interface AssessOptions {
  now: Date;
  /** Clock skew allowed into the future. */
  futureSkewSec: number;
  /** Older than this is refused (a tracker that buffered for a month is not new data). */
  maxAgeDays: number;
  /** Faster than this between two fixes is a GPS glitch, not driving. */
  maxPlausibleKmh: number;
  /** Fewer satellites than this means the fix was not really a fix. */
  minSatellites: number;
  /** HDOP above this is rejected; above `warnHdop` it is kept but flagged. */
  maxHdop: number;
  warnHdop: number;
  /** Several mutually consistent "impossible" jumps mean the baseline was wrong; accept the new place. */
  jumpsBeforeRebaseline: number;
  /** A parked vehicle refreshes history at most this often. */
  parkedHeartbeatSec: number;
  /** Movement under this while parked is GPS wander. */
  parkedDriftM: number;
  /** Below this a vehicle counts as stationary (km/h). */
  stationaryKmh: number;
}

export const DEFAULT_ASSESS: Omit<AssessOptions, "now"> = {
  futureSkewSec: 60,
  maxAgeDays: 30,
  maxPlausibleKmh: 250,
  minSatellites: 3,
  maxHdop: 12,
  warnHdop: 5,
  jumpsBeforeRebaseline: 3,
  parkedHeartbeatSec: 300,
  parkedDriftM: 25,
  stationaryKmh: 1.5,
};

/** Decide what to do with one incoming reading, given the last accepted state of the same device (or null). */
export function assessReading(r: Reading, prev: DeviceState | null, opts: Partial<AssessOptions> = {}): Verdict {
  const o: AssessOptions = { now: new Date(), ...DEFAULT_ASSESS, ...opts };
  const flags: Flag[] = [];
  const reject = (reason: RejectReason): Verdict => ({ action: "reject", reason, flags });

  if (!Number.isFinite(r.lat) || !Number.isFinite(r.lng) || Math.abs(r.lat) > 90 || Math.abs(r.lng) > 180) return reject("bad_coordinates");
  // A tracker with no fix often reports exactly 0,0 ("null island" in the Gulf of Guinea).
  if (Math.abs(r.lat) < 0.5 && Math.abs(r.lng) < 0.5) return reject("null_island");
  const t = Date.parse(r.time);
  if (!Number.isFinite(t)) return reject("bad_time");
  if (t > o.now.getTime() + o.futureSkewSec * 1000) return reject("future_time");
  if (t < o.now.getTime() - o.maxAgeDays * 86_400_000) return reject("too_old");
  if (!Number.isFinite(r.speed) || r.speed < 0 || r.speed > o.maxPlausibleKmh) return reject("bad_speed");
  if (r.satellites != null && r.satellites < o.minSatellites) return reject("no_satellites");
  if (r.hdop != null && r.hdop > o.maxHdop) return reject("poor_accuracy");
  if (r.hdop != null && r.hdop > o.warnHdop) flags.push("poor_hdop");

  if (!prev) return { action: "store", flags };

  const pt = Date.parse(prev.time);
  const dt = (t - pt) / 1000;

  // Older than or equal to the newest we have: keep for history (trip replay needs it), never move the marker.
  if (dt <= 0) return { action: "history_only", flags: [...flags, "late_arrival"] };

  const metres = haversine(prev.lat, prev.lng, r.lat, r.lng);
  const impliedKmh = (metres / 1000) / (dt / 3600);
  // Over a short gap an impossible speed is a glitch. Over a long gap a vehicle really can have driven far.
  if (dt < 3600 && impliedKmh > o.maxPlausibleKmh && metres > 300) {
    const streak = (prev.jumpStreak ?? 0) + 1;
    if (streak < o.jumpsBeforeRebaseline) return reject("position_jump");
    flags.push("rebaselined");
  }

  const stationary = r.speed < o.stationaryKmh && prev.speed < o.stationaryKmh;
  const ignitionSame = r.ignition === prev.ignition;
  if (stationary && ignitionSame && metres <= o.parkedDriftM) {
    flags.push("snapped_parked");
    return dt < o.parkedHeartbeatSec ? { action: "latest_only", flags } : { action: "store", flags };
  }
  return { action: "store", flags };
}

// ---- events from raw device attributes ----

export type DeviceEventKind =
  | "sos" | "harsh_brake" | "harsh_accel" | "harsh_corner" | "overspeed" | "crash" | "tow" | "tamper"
  | "power_cut" | "power_restored" | "low_battery" | "jamming" | "gps_antenna_cut" | "ignition_on" | "ignition_off"
  | "door_open" | "fault" | "high_rpm" | "idle" | "fatigue";

export interface DeviceEventIn { kind: DeviceEventKind; severity: 1 | 2 | 3; value?: number }

/** Traccar `alarm` values → our event kinds. Anything not listed is ignored on purpose (no free-text events). */
const ALARM_MAP: Record<string, { kind: DeviceEventKind; severity: 1 | 2 | 3 }> = {
  sos: { kind: "sos", severity: 3 },
  accident: { kind: "crash", severity: 3 },
  fallDown: { kind: "crash", severity: 3 },
  tow: { kind: "tow", severity: 3 },
  tampering: { kind: "tamper", severity: 3 },
  removing: { kind: "tamper", severity: 3 },
  powerCut: { kind: "power_cut", severity: 3 },
  powerOff: { kind: "power_cut", severity: 2 },
  powerRestored: { kind: "power_restored", severity: 1 },
  powerOn: { kind: "power_restored", severity: 1 },
  lowBattery: { kind: "low_battery", severity: 2 },
  lowPower: { kind: "low_battery", severity: 2 },
  jamming: { kind: "jamming", severity: 3 },
  gpsAntennaCut: { kind: "gps_antenna_cut", severity: 3 },
  hardAcceleration: { kind: "harsh_accel", severity: 2 },
  hardBraking: { kind: "harsh_brake", severity: 2 },
  hardCornering: { kind: "harsh_corner", severity: 2 },
  overspeed: { kind: "overspeed", severity: 2 },
  door: { kind: "door_open", severity: 1 },
  fault: { kind: "fault", severity: 2 },
  highRpm: { kind: "high_rpm", severity: 1 },
  idle: { kind: "idle", severity: 1 },
  fatigueDriving: { kind: "fatigue", severity: 2 },
};

/** Lift alarms and ignition changes out of a reading's raw attributes. */
export function eventsFromAttributes(attrs: Record<string, unknown>, prevIgnition: boolean | null, ignition: boolean | null): DeviceEventIn[] {
  const out: DeviceEventIn[] = [];
  const alarm = attrs.alarm;
  const names = typeof alarm === "string" ? alarm.split(",") : Array.isArray(alarm) ? alarm.map(String) : [];
  for (const n of names) {
    const m = ALARM_MAP[n.trim()];
    if (m) out.push({ ...m });
  }
  if (prevIgnition != null && ignition != null && prevIgnition !== ignition) out.push({ kind: ignition ? "ignition_on" : "ignition_off", severity: 1 });
  return out;
}

// ---- unit conversions and sensor sanity ----

export const KNOTS_TO_KMH = 1.852;
export const MPH_TO_KMH = 1.609344;
export const knotsToKmh = (k: number) => Math.round(k * KNOTS_TO_KMH * 10) / 10;
export const mphToKmh = (m: number) => Math.round(m * MPH_TO_KMH * 10) / 10;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const inRange = (v: number | null, lo: number, hi: number): number | null => (v != null && v >= lo && v <= hi ? v : null);

/** Pull the sensor values we store out of a protocol's attribute bag. Out-of-range sensor values become null, not errors. */
export function sensorsFromAttributes(a: Record<string, unknown>): Pick<Reading, "hdop" | "satellites" | "batteryPct" | "extVoltage" | "fuelLevelPct" | "rpm" | "engineHours" | "coolantC" | "signal"> {
  // Traccar: batteryLevel (%), power (V, vehicle), battery (V, internal), fuel (litres or %), rpm, hours (ms), coolantTemp, rssi (0–5)
  const hours = num(a.hours);
  const rssi = num(a.rssi);
  return {
    hdop: inRange(num(a.hdop), 0, 99),
    satellites: inRange(num(a.sat) ?? num(a.satellites), 0, 64),
    batteryPct: inRange(num(a.batteryLevel), 0, 100),
    extVoltage: inRange(num(a.power), 0, 60),
    fuelLevelPct: inRange(num(a.fuelLevel) ?? (typeof a.fuel === "number" && a.fuel <= 100 ? (a.fuel as number) : null), 0, 100),
    rpm: inRange(num(a.rpm), 0, 10_000),
    // Traccar reports engine hours in milliseconds.
    engineHours: hours != null && hours >= 0 ? Math.round((hours / 3_600_000) * 10) / 10 : null,
    coolantC: inRange(num(a.coolantTemp), -50, 200),
    signal: rssi != null ? Math.max(0, Math.min(5, Math.round(rssi))) : null,
  };
}

// ---- device health ----

export type DeviceHealth = "healthy" | "attention" | "offline" | "never_reported";
export interface HealthInput {
  lastSeen: string | null;
  satellites: number | null;
  batteryPct: number | null;
  extVoltage: number | null;
  signal: number | null;
  /** True when the vehicle is expected to be reporting (ignition on or moving). */
  active: boolean;
}
export interface HealthResult { state: DeviceHealth; issues: ("silent" | "low_battery" | "low_voltage" | "weak_gps" | "weak_signal")[] }

/** One verdict per tracker for the "device health" page. Quiet-but-parked vehicles are not an issue. */
export function deviceHealth(h: HealthInput, now: Date = new Date()): HealthResult {
  if (!h.lastSeen) return { state: "never_reported", issues: [] };
  const ageMin = (now.getTime() - Date.parse(h.lastSeen)) / 60_000;
  const issues: HealthResult["issues"] = [];
  if (ageMin > (h.active ? 10 : 24 * 60)) issues.push("silent");
  if (h.batteryPct != null && h.batteryPct < 20) issues.push("low_battery");
  if (h.extVoltage != null && h.extVoltage > 0 && h.extVoltage < 11.5) issues.push("low_voltage");
  if (h.satellites != null && h.satellites < 5) issues.push("weak_gps");
  if (h.signal != null && h.signal <= 1) issues.push("weak_signal");
  if (issues.includes("silent")) return { state: "offline", issues };
  return { state: issues.length ? "attention" : "healthy", issues };
}
