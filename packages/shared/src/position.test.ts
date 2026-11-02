import { describe, expect, it } from "vitest";
import { isValidPosition, vehicleStatus } from "./position.js";

const now = new Date("2026-11-02T12:00:00Z");
const fix = (over: object = {}) => ({
  time: "2026-11-02T11:59:30Z", speed: 80, ignition: true, ...over,
});

describe("vehicleStatus", () => {
  it("is moving above 3 km/h", () => expect(vehicleStatus(fix(), now)).toBe("moving"));
  it("is idle when stopped with ignition on", () =>
    expect(vehicleStatus(fix({ speed: 0 }), now)).toBe("idle"));
  it("is stopped when ignition off", () =>
    expect(vehicleStatus(fix({ speed: 0, ignition: false }), now)).toBe("stopped"));
  it("is offline after 10 minutes without a fix", () =>
    expect(vehicleStatus(fix({ time: "2026-11-02T11:40:00Z" }), now)).toBe("offline"));
});

describe("isValidPosition", () => {
  it("accepts a Toronto fix", () =>
    expect(isValidPosition({ lat: 43.65, lng: -79.38, speed: 60 })).toBe(true));
  it("rejects out-of-range coordinates", () =>
    expect(isValidPosition({ lat: 91, lng: 0, speed: 0 })).toBe(false));
  it("rejects NaN", () =>
    expect(isValidPosition({ lat: NaN, lng: 0, speed: 0 })).toBe(false));
});
