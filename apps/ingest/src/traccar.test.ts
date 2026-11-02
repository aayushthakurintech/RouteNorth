import { describe, expect, it } from "vitest";
import { normalizeTraccar } from "./traccar.js";

const now = new Date("2026-11-02T12:00:00Z");
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
    const n = normalizeTraccar(msg(), now)!;
    expect(n.speed).toBeCloseTo(100, 0);
    expect(n.heading).toBe(10);
    expect(n.ignition).toBe(true);
    expect(n.odometer).toBe(1200);
  });
  it("drops invalid-GPS fixes", () => expect(normalizeTraccar(msg({ valid: false }), now)).toBeNull());
  it("drops out-of-range coordinates", () => expect(normalizeTraccar(msg({ latitude: 120 }), now)).toBeNull());
  it("drops fixes from the future", () =>
    expect(normalizeTraccar(msg({ fixTime: "2026-11-02T13:00:00Z" }), now)).toBeNull());
  it("drops messages without a device id", () =>
    expect(normalizeTraccar({ ...msg(), device: {} }, now)).toBeNull());
});
