import { describe, expect, it } from "vitest";
import { normalizeTraccar } from "./traccar.js";

const msg = (over: Record<string, unknown> = {}) => ({
  device: { uniqueId: "sim-1" },
  position: {
    fixTime: "2026-11-02T11:59:50Z", latitude: 43.65, longitude: -79.38,
    speed: 54, course: 370, valid: true, attributes: { ignition: true, totalDistance: 1200 },
    ...over,
  },
});

describe("normalizeTraccar", () => {
  it("converts knots to km/h and wraps heading", () => {
    const n = normalizeTraccar(msg())!;
    expect(n.speed).toBeCloseTo(100, 0);
    expect(n.heading).toBe(10);
    expect(n.ignition).toBe(true);
    expect(n.odometer).toBe(1200);
  });
  it("drops invalid-GPS fixes", () => expect(normalizeTraccar(msg({ valid: false }))).toBeNull());
  it("passes out-of-range values on, so the quality gate can count them with a reason", () => {
    expect(normalizeTraccar(msg({ latitude: 120 }))!.lat).toBe(120);
    expect(normalizeTraccar(msg({ fixTime: "garbage" }))!.time).toBe("invalid");
  });
  it("reads sensors, altitude and engine hours", () => {
    const n = normalizeTraccar(msg({ altitude: 91, attributes: { sat: 11, hdop: 0.8, batteryLevel: 80, power: 13.9, fuel: 55, hours: 3_600_000, rssi: 4, alarm: "hardBraking" } }))!;
    expect(n).toMatchObject({ altitude: 91, satellites: 11, hdop: 0.8, batteryPct: 80, extVoltage: 13.9, fuelLevelPct: 55, engineHours: 1, signal: 4 });
    expect(n.attributes.alarm).toBe("hardBraking");
  });
  it("drops messages without a device id", () =>
    expect(normalizeTraccar({ ...msg(), device: {} })).toBeNull());
});
