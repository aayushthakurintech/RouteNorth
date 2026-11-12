import { describe, expect, it } from "vitest";
import { MAX_BATCH, normalizeGeneric } from "./generic.js";

describe("normalizeGeneric", () => {
  const body = (p: unknown[]) => ({ deviceId: "ABC", positions: p });
  it("reads km/h, mph and knots and odometer units", () => {
    const { readings } = normalizeGeneric(body([
      { time: "2026-11-05T12:00:00Z", lat: 43.6, lng: -79.4, speedKmh: 50, odometerKm: 10.5 },
      { time: "2026-11-05T12:00:10Z", lat: 43.6, lng: -79.4, speedMph: 60 },
      { time: "2026-11-05T12:00:20Z", lat: 43.6, lng: -79.4, speedKnots: 10, sensors: { fuelLevel: 40, sat: 9 } },
    ]));
    expect(readings.map((r) => r.speed)).toEqual([50, 96.6, 18.5]);
    expect(readings[0]!.odometer).toBe(10_500);
    expect(readings[2]).toMatchObject({ fuelLevelPct: 40, satellites: 9 });
  });
  it("counts unusable rows instead of failing the batch", () => {
    const r = normalizeGeneric(body([{ lat: 1 }, null, { time: "2026-11-05T12:00:00Z", lat: 43.6, lng: -79.4 }]));
    expect(r.unusable).toBe(2);
    expect(r.readings).toHaveLength(1);
  });
  it("rejects a missing device, a non-list and an oversized batch", () => {
    expect(normalizeGeneric({ positions: [] }).error).toMatch(/deviceId/);
    expect(normalizeGeneric({ deviceId: "x", positions: "no" }).error).toMatch(/list/);
    expect(normalizeGeneric(body(new Array(MAX_BATCH + 1).fill({}))).error).toMatch(/at most/);
  });
});
