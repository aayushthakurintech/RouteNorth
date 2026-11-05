import { describe, expect, it } from "vitest";
import { estimateFuel, fuelEvents, harshSeverity, idleCost, idleEpisodes, idlePercent, kmhPerSecToG, mergeEvents, sensorLitresUsed, simplifyTrack, speedingSeverity, utilization, vehicleClass, type FuelSample } from "./telematics.js";
import { dailyTotals, type Fix } from "./trips.js";

const T0 = Date.parse("2026-11-05T14:00:00Z");
const at = (s: number) => new Date(T0 + s * 1000).toISOString();
const fix = (s: number, speed: number, ignition: boolean | null = true, lat = 43.65, lng = -79.38): Fix => ({ time: at(s), lat, lng, speed, ignition });

describe("idleEpisodes", () => {
  it("finds an engine-on stop and ignores a short light", () => {
    const fixes = [fix(0, 50), fix(10, 0), fix(20, 0), fix(30, 0), fix(40, 0), fix(220, 0), fix(230, 40), // 220 s idle
      fix(300, 40), fix(310, 0), fix(330, 0), fix(340, 45)]; // 30 s light
    const eps = idleEpisodes(fixes);
    expect(eps).toHaveLength(1);
    expect(eps[0]).toMatchObject({ start: at(10), end: at(220), durationS: 210, endedBy: "moving" });
  });
  it("is not idling when the engine is off or unknown", () => {
    expect(idleEpisodes([fix(0, 0, false), fix(300, 0, false), fix(600, 0, false)])).toEqual([]);
    expect(idleEpisodes([fix(0, 0, null), fix(300, 0, null), fix(600, 0, null)])).toEqual([]);
  });
  it("reports the engine being switched off", () => {
    const eps = idleEpisodes([fix(0, 0), fix(150, 0), fix(300, 0), fix(310, 0, false)]);
    expect(eps[0]).toMatchObject({ durationS: 300, endedBy: "ignition_off" });
  });
  it("splits on a data gap and honours the minimum", () => {
    const eps = idleEpisodes([fix(0, 0), fix(300, 0), fix(5000, 0), fix(5100, 0)], { minSeconds: 60 });
    expect(eps.map((e) => e.durationS)).toEqual([300, 100]);
    expect(idleEpisodes([fix(0, 0), fix(100, 0)], { minSeconds: 300 })).toEqual([]);
  });
  it("adds up to the same idle total as the daily report", () => {
    const fixes = [fix(0, 40), fix(10, 0), fix(200, 0), fix(210, 30), fix(260, 30), fix(270, 0), fix(500, 0), fix(520, 0, false)];
    const eps = idleEpisodes(fixes, { minSeconds: 0 });
    const day = dailyTotals(fixes, "America/Toronto");
    expect(eps.reduce((a, e) => a + e.durationS, 0)).toBe(day.reduce((a, d) => a + d.idleS, 0));
  });
});

describe("idle cost and percentages", () => {
  it("prices idling by vehicle class and says how much CO2", () => {
    const c = idleCost(3600, "truck", { pricePerLitre: 1.9 });
    expect(c).toEqual({ hours: 1, litres: 3.8, cost: 7.22, co2Kg: 10.2 });
    expect(idleCost(1800, "bus").litres).toBe(1.5);
    expect(idleCost(3600, "car", { fuelType: "gasoline", litresPerHour: 1 })).toMatchObject({ litres: 1, co2Kg: 2.3, cost: null });
    expect(vehicleClass("bicycle")).toBe("car");
  });
  it("idle share of engine-on time", () => {
    expect(idlePercent(600, 1800)).toBe(25);
    expect(idlePercent(0, 0)).toBeNull();
  });
  it("estimates fuel and says what it is based on", () => {
    expect(estimateFuel({ km: 100, idleS: 3600, kind: "truck" })).toEqual({ litres: 35.8, lPer100: 32, basis: "typical" });
    expect(estimateFuel({ km: 100, idleS: 0, kind: "truck", measuredLPer100: 28 })).toEqual({ litres: 28, lPer100: 28, basis: "measured" });
  });
});

const fs = (pcts: number[], opt: { speed?: number; step?: number; ignition?: boolean | null } = {}): FuelSample[] =>
  pcts.map((pct, i) => ({ time: at(i * (opt.step ?? 60)), pct, speed: opt.speed ?? 0, ignition: opt.ignition ?? false }));

describe("fuelEvents", () => {
  it("finds a refuel while parked", () => {
    const e = fuelEvents(fs([20, 20, 20, 35, 55, 70, 70, 70]), { tankLitres: 400 });
    expect(e).toHaveLength(1);
    expect(e[0]).toMatchObject({ kind: "refuel", fromPct: 20, toPct: 70, litres: 200 });
  });
  it("flags a drain with the engine off", () => {
    const e = fuelEvents(fs([80, 80, 80, 70, 60, 50, 50, 50]), { tankLitres: 400 });
    expect(e[0]).toMatchObject({ kind: "drain", fromPct: 80, toPct: 50, litres: 120 });
  });
  it("does not call slow idling a drain, nor sloshing a refuel", () => {
    // 10 minutes of idling burns ~0.6 L of a 400 L tank: nothing to report
    expect(fuelEvents(fs([60, 60, 59, 59, 59, 58], { ignition: true }), { tankLitres: 400 })).toEqual([]);
    // a single bad reading is smoothed away
    expect(fuelEvents(fs([60, 60, 85, 60, 60, 60]), { tankLitres: 400 })).toEqual([]);
  });
  it("ignores level changes while driving", () => {
    expect(fuelEvents(fs([90, 70, 50, 30], { speed: 80, ignition: true }), { tankLitres: 400 })).toEqual([]);
  });
  it("splits stationary stretches at a drive", () => {
    const samples: FuelSample[] = [
      ...fs([20, 20, 40, 60, 60]),
      ...fs([60, 59, 58], { speed: 70, ignition: true }).map((s, i) => ({ ...s, time: at(300 + i * 60) })),
      ...fs([58, 58, 58, 58, 58]).map((s, i) => ({ ...s, time: at(600 + i * 60) })),
    ];
    const e = fuelEvents(samples, { tankLitres: 300 });
    expect(e.map((x) => x.kind)).toEqual(["refuel"]);
  });
  it("measures litres used while moving, ignoring refuels", () => {
    const moving = fs([80, 78, 76, 74, 72, 70], { speed: 60, ignition: true });
    expect(sensorLitresUsed(moving, 400)).toBeCloseTo(40, 0);
  });
});

describe("harsh events", () => {
  it("converts km/h per second into g and grades it", () => {
    expect(kmhPerSecToG(9)).toBe(0.25);
    expect(harshSeverity(9)).toBe("moderate");
    expect(harshSeverity(-13)).toBe("severe");
    expect(harshSeverity(-19)).toBe("extreme");
    expect(harshSeverity(5)).toBeNull();
  });
  it("grades speeding by how far over the limit", () => {
    expect(speedingSeverity(108, 105)).toBeNull();
    expect(speedingSeverity(116, 105)).toBe("moderate");
    expect(speedingSeverity(126, 105)).toBe("severe");
    expect(speedingSeverity(140, 105)).toBe("extreme");
  });
  it("counts one event once when the tracker and GPS both saw it", () => {
    const gps = [{ kind: "harsh_brake", time: at(100) }, { kind: "harsh_brake", time: at(900) }, { kind: "harsh_accel", time: at(105) }];
    const dev = [{ kind: "harsh_brake", time: at(104) }];
    const m = mergeEvents(gps, dev);
    expect(m.map((e) => `${e.kind}:${e.source}`)).toEqual(["harsh_brake:device", "harsh_accel:gps", "harsh_brake:gps"]);
  });
});

describe("utilization", () => {
  const day = (date: string, movingH: number, idleH: number, km: number) => ({ date, movingS: movingH * 3600, idleS: idleH * 3600, km });
  it("separates days used from how hard it worked", () => {
    const u = utilization([day("1", 6, 1, 300), day("2", 4, 2, 200), day("3", 0, 0, 0), day("4", 0, 0.2, 0)]);
    expect(u).toMatchObject({ daysTracked: 4, daysUsed: 2, daysUsedPct: 50, movingPct: 50, engineOnPct: 65, avgKmPerUsedDay: 250, level: "normal" });
  });
  it("calls a barely used vehicle light, and an unused one none", () => {
    expect(utilization([day("1", 1, 0, 20), day("2", 0.5, 0, 10)]).level).toBe("light");
    expect(utilization([day("1", 0, 0, 0)])).toMatchObject({ level: "none", movingPct: null, avgKmPerUsedDay: null });
    expect(utilization([])).toMatchObject({ daysUsedPct: null, level: "none" });
  });
});

describe("simplifyTrack", () => {
  it("drops points on a straight line and keeps the corner", () => {
    const line = Array.from({ length: 50 }, (_, i) => ({ lat: 43.6 + i * 0.0001, lng: -79.4 }));
    const turn = Array.from({ length: 50 }, (_, i) => ({ lat: 43.6049, lng: -79.4 + (i + 1) * 0.0001 }));
    const out = simplifyTrack([...line, ...turn], 5);
    expect(out.length).toBeLessThanOrEqual(4);
    expect(out[0]).toEqual(line[0]);
    expect(out[out.length - 1]).toEqual(turn[turn.length - 1]);
    expect(out).toContain(line[49]);
  });
  it("keeps a real detour above the tolerance and leaves tiny inputs alone", () => {
    const pts = [{ lat: 43.6, lng: -79.4 }, { lat: 43.6005, lng: -79.4 }, { lat: 43.601, lng: -79.4 }];
    expect(simplifyTrack(pts, 5)).toHaveLength(2);
    expect(simplifyTrack([{ lat: 43.6, lng: -79.4 }, { lat: 43.6005, lng: -79.4004 }, { lat: 43.601, lng: -79.4 }], 5)).toHaveLength(3);
    expect(simplifyTrack(pts.slice(0, 2))).toHaveLength(2);
  });
});
