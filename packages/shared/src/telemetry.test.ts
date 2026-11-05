import { describe, expect, it } from "vitest";
import { assessReading, deviceHealth, eventsFromAttributes, knotsToKmh, mphToKmh, sensorsFromAttributes, type DeviceState, type Reading } from "./telemetry.js";

const NOW = new Date("2026-11-05T12:00:00Z");
const base: Reading = {
  externalId: "X", time: "2026-11-05T11:59:50Z", lat: 43.65, lng: -79.38, speed: 60, heading: 90, ignition: true, odometer: null,
  altitude: null, hdop: null, satellites: null, batteryPct: null, extVoltage: null, fuelLevelPct: null, rpm: null, engineHours: null, coolantC: null, signal: null, attributes: {},
};
const r = (o: Partial<Reading> = {}): Reading => ({ ...base, ...o });
const state = (o: Partial<DeviceState> = {}): DeviceState => ({ time: "2026-11-05T11:59:40Z", lat: 43.65, lng: -79.38, speed: 60, ignition: true, ...o });
const act = (x: Reading, p: DeviceState | null = null) => assessReading(x, p, { now: NOW });

describe("assessReading: rejects", () => {
  it("coordinates out of range or not numbers", () => {
    expect(act(r({ lat: 91 }))).toMatchObject({ action: "reject", reason: "bad_coordinates" });
    expect(act(r({ lng: NaN }))).toMatchObject({ action: "reject", reason: "bad_coordinates" });
  });
  it("null island", () => {
    expect(act(r({ lat: 0, lng: 0 }))).toMatchObject({ reason: "null_island" });
    expect(act(r({ lat: 0.2, lng: -0.3 }))).toMatchObject({ reason: "null_island" });
  });
  it("bad, future and ancient times", () => {
    expect(act(r({ time: "nope" }))).toMatchObject({ reason: "bad_time" });
    expect(act(r({ time: "2026-11-05T12:02:00Z" }))).toMatchObject({ reason: "future_time" });
    expect(act(r({ time: "2026-11-05T12:00:50Z" })).action).toBe("store"); // within the skew
    expect(act(r({ time: "2026-09-01T00:00:00Z" }))).toMatchObject({ reason: "too_old" });
  });
  it("impossible speeds", () => {
    expect(act(r({ speed: 400 }))).toMatchObject({ reason: "bad_speed" });
    expect(act(r({ speed: -1 }))).toMatchObject({ reason: "bad_speed" });
  });
  it("too few satellites or very poor HDOP", () => {
    expect(act(r({ satellites: 2 }))).toMatchObject({ reason: "no_satellites" });
    expect(act(r({ hdop: 20 }))).toMatchObject({ reason: "poor_accuracy" });
    expect(act(r({ hdop: 7 }))).toEqual({ action: "store", flags: ["poor_hdop"] });
  });
});

describe("assessReading: against the previous fix", () => {
  it("accepts normal driving", () => {
    // 10 s at 60 km/h is about 167 m
    expect(act(r({ lat: 43.6515 }), state())).toEqual({ action: "store", flags: [] });
  });
  it("rejects a teleport but allows a long drive after a long silence", () => {
    // Toronto → Montreal in 10 seconds
    expect(act(r({ lat: 45.5, lng: -73.57 }), state())).toMatchObject({ action: "reject", reason: "position_jump" });
    // the same distance after 6 hours of silence is just driving
    expect(act(r({ time: "2026-11-05T11:59:40Z", lat: 45.5, lng: -73.57 }), state({ time: "2026-11-05T05:00:00Z" })).action).toBe("store");
  });
  it("accepts a new place after three consistent jumps (the first fix was the wrong one)", () => {
    const v = act(r({ lat: 45.5, lng: -73.57 }), state({ jumpStreak: 2 }));
    expect(v).toEqual({ action: "store", flags: ["rebaselined"] });
  });
  it("keeps late or duplicate-time fixes for history without moving the marker", () => {
    expect(act(r({ time: "2026-11-05T11:59:30Z" }), state())).toEqual({ action: "history_only", flags: ["late_arrival"] });
    expect(act(r({ time: "2026-11-05T11:59:40Z" }), state())).toMatchObject({ action: "history_only" });
  });
  it("compresses a parked vehicle but still stores a heartbeat", () => {
    const parked = state({ speed: 0, ignition: false, time: "2026-11-05T11:55:00Z" });
    const quiet = r({ speed: 0, ignition: false, lat: 43.65005, time: "2026-11-05T11:57:00Z" });
    expect(act(quiet, parked)).toEqual({ action: "latest_only", flags: ["snapped_parked"] });
    const later = r({ speed: 0, ignition: false, lat: 43.65005, time: "2026-11-05T12:00:00Z" });
    expect(act(later, parked)).toEqual({ action: "store", flags: ["snapped_parked"] });
  });
  it("stores a stationary fix when ignition changed or the vehicle really moved", () => {
    const parked = state({ speed: 0, ignition: false, time: "2026-11-05T11:59:00Z" });
    expect(act(r({ speed: 0, ignition: true, time: "2026-11-05T11:59:30Z" }), parked).action).toBe("store");
    expect(act(r({ speed: 0, ignition: false, lat: 43.6505, time: "2026-11-05T11:59:30Z" }), parked).action).toBe("store");
  });
});

describe("events and sensors", () => {
  it("maps Traccar alarms and ignition changes", () => {
    expect(eventsFromAttributes({ alarm: "hardBraking" }, true, true)).toEqual([{ kind: "harsh_brake", severity: 2 }]);
    expect(eventsFromAttributes({ alarm: "sos,powerCut" }, null, null).map((e) => e.kind)).toEqual(["sos", "power_cut"]);
    expect(eventsFromAttributes({ alarm: "somethingNew" }, false, true).map((e) => e.kind)).toEqual(["ignition_on"]);
    expect(eventsFromAttributes({}, true, true)).toEqual([]);
    expect(eventsFromAttributes({}, null, true)).toEqual([]);
  });
  it("converts units", () => {
    expect(knotsToKmh(10)).toBe(18.5);
    expect(mphToKmh(60)).toBe(96.6);
  });
  it("reads sensors and drops impossible values", () => {
    const s = sensorsFromAttributes({ sat: 9, hdop: 0.9, batteryLevel: 87, power: 13.8, fuel: 42, rpm: 1500, hours: 7_200_000, coolantTemp: 88, rssi: 4 });
    expect(s).toEqual({ hdop: 0.9, satellites: 9, batteryPct: 87, extVoltage: 13.8, fuelLevelPct: 42, rpm: 1500, engineHours: 2, coolantC: 88, signal: 4 });
    const bad = sensorsFromAttributes({ batteryLevel: 400, power: -3, rpm: 90000, fuel: 5000 });
    expect(bad.batteryPct).toBeNull(); expect(bad.extVoltage).toBeNull(); expect(bad.rpm).toBeNull(); expect(bad.fuelLevelPct).toBeNull();
  });
});

describe("deviceHealth", () => {
  const h = (o = {}) => ({ lastSeen: "2026-11-05T11:58:00Z", satellites: 10, batteryPct: 90, extVoltage: 13.9, signal: 4, active: true, ...o });
  it("healthy, attention, offline, never reported", () => {
    expect(deviceHealth(h(), NOW).state).toBe("healthy");
    expect(deviceHealth(h({ batteryPct: 10, satellites: 3 }), NOW)).toEqual({ state: "attention", issues: ["low_battery", "weak_gps"] });
    expect(deviceHealth(h({ lastSeen: "2026-11-05T11:00:00Z" }), NOW).state).toBe("offline");
    expect(deviceHealth(h({ lastSeen: null }), NOW).state).toBe("never_reported");
  });
  it("a parked vehicle that has been quiet for hours is fine", () => {
    expect(deviceHealth(h({ active: false, lastSeen: "2026-11-05T05:00:00Z" }), NOW).state).toBe("healthy");
  });
});
