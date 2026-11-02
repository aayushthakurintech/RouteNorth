import { describe, expect, it } from "vitest";
import { dailyTotals, detectTrips, segmentDistance, type Fix } from "./trips.js";

/** Builds a synthetic day: vehicles drive due east at constant speed, or sit still. */
class Day {
  fixes: Fix[] = [];
  private ms = Date.parse("2026-11-02T12:00:00Z"); // 07:00 in Toronto
  private lng = -79.5;
  private readonly lat = 43.65;
  private readonly step = 10; // seconds between fixes

  drive(minutes: number, kmh: number): this {
    for (let s = 0; s < minutes * 60; s += this.step) {
      this.lng += (kmh / 3.6) * this.step / (111_320 * Math.cos((this.lat * Math.PI) / 180));
      this.ms += this.step * 1000;
      this.push(kmh, true);
    }
    return this;
  }
  park(minutes: number, ignition: boolean): this {
    for (let s = 0; s < minutes * 60; s += this.step) {
      this.ms += this.step * 1000;
      this.push(0, ignition);
    }
    return this;
  }
  silence(minutes: number): this { this.ms += minutes * 60_000; return this; }
  private push(speed: number, ignition: boolean) {
    this.fixes.push({ time: new Date(this.ms).toISOString(), lat: this.lat, lng: this.lng, speed, ignition });
  }
}

const near = (actual: number, expected: number, tol = 0.02) =>
  expect(Math.abs(actual - expected) / expected).toBeLessThan(tol);

describe("detectTrips", () => {
  it("finds two trips separated by a long idle stop, with a short pause staying inside a trip", () => {
    const day = new Day().drive(10, 60).park(20, true).drive(5, 60).park(2, true).drive(5, 60).park(30, false);
    const { trips, stops } = detectTrips(day.fixes);

    expect(trips).toHaveLength(2);
    near(trips[0]!.distanceM, 10_000);
    near(trips[1]!.distanceM, 10_000, 0.03); // 5 + 5 minutes at 60 km/h, 2-minute pause inside
    expect(trips[1]!.idleS).toBeGreaterThan(100);
    expect(trips[1]!.idleS).toBeLessThan(140);
    expect(trips[0]!.maxSpeedKmh).toBe(60);
    near(trips[0]!.avgSpeedKmh, 60);

    expect(stops).toHaveLength(2);
    expect(stops[0]!.idling).toBe(true);
    near(stops[0]!.durationS, 20 * 60, 0.03);
    expect(stops[0]!.open).toBe(false);
    expect(stops[1]!.idling).toBe(false);
    expect(stops[1]!.open).toBe(true);
  });

  it("ends a trip when the vehicle stopped, not when the stop timer expired", () => {
    const day = new Day().drive(10, 60).park(20, false);
    const { trips } = detectTrips(day.fixes);
    near(trips[0]!.durationS, 10 * 60, 0.03);
  });

  it("splits trips across a data gap and flags it", () => {
    const day = new Day().drive(5, 60).silence(30).drive(5, 60).park(10, false);
    const { trips } = detectTrips(day.fixes);
    expect(trips).toHaveLength(2);
    expect(trips[0]!.endedByGap).toBe(true);
    expect(trips[1]!.endedByGap).toBe(false);
  });

  it("reports an in-progress trip when the data ends while moving", () => {
    const { trips, stops } = detectTrips(new Day().park(10, false).drive(5, 60).fixes);
    expect(trips).toHaveLength(1);
    expect(trips[0]!.endedByGap).toBe(true);
    expect(stops).toHaveLength(1);
  });

  it("does not turn GPS drift while parked into a trip or distance", () => {
    const day = new Day().park(30, false);
    day.fixes.forEach((f, i) => { f.lat += (i % 2) * 0.0001; f.speed = 1; });
    const { trips } = detectTrips(day.fixes);
    expect(trips).toHaveLength(0);
    expect(dailyTotals(day.fixes)[0]!.distanceM).toBe(0);
  });

  it("returns nothing for empty or single-fix input", () => {
    expect(detectTrips([])).toEqual({ trips: [], stops: [] });
    expect(detectTrips(new Day().drive(0.1, 60).fixes).trips.length).toBeLessThanOrEqual(1);
  });
});

describe("segmentDistance", () => {
  const a: Fix = { time: "2026-11-02T12:00:00Z", lat: 43.65, lng: -79.5, speed: 60, ignition: true };
  it("ignores impossible jumps", () => {
    const b = { ...a, time: "2026-11-02T12:00:10Z", lng: -79.0 };
    expect(segmentDistance(a, b)).toBe(0);
  });
  it("ignores data gaps", () => {
    const b = { ...a, time: "2026-11-02T13:00:00Z", lng: -79.49 };
    expect(segmentDistance(a, b)).toBe(0);
  });
  it("prefers a consistent odometer over straight-line distance", () => {
    const b = { ...a, time: "2026-11-02T12:00:10Z", lng: -79.4975, odometer: 1050 };
    expect(segmentDistance({ ...a, odometer: 1000 }, b)).toBe(50);
  });
  it("falls back to straight-line distance when the odometer resets", () => {
    const b = { ...a, time: "2026-11-02T12:00:10Z", lng: -79.4975, odometer: 5 };
    expect(segmentDistance({ ...a, odometer: 1000 }, b)).toBeGreaterThan(150);
  });
});

describe("dailyTotals", () => {
  it("totals distance and idle time per local day", () => {
    const day = new Day().drive(10, 60).park(20, true).drive(5, 60).park(30, false);
    const totals = dailyTotals(day.fixes, "America/Toronto");
    expect(totals).toHaveLength(1);
    expect(totals[0]!.date).toBe("2026-11-02");
    near(totals[0]!.distanceM, 15_000, 0.03);
    near(totals[0]!.idleS, 20 * 60, 0.05);
  });

  it("uses the local time zone for the day boundary", () => {
    // 03:30 UTC on Nov 3 is 23:30 on Nov 2 in Toronto (EST).
    const fixes: Fix[] = [0, 1, 2].map((i) => ({
      time: new Date(Date.parse("2026-11-03T03:30:00Z") + i * 10_000).toISOString(),
      lat: 43.65, lng: -79.5 + i * 0.0002, speed: 50, ignition: true,
    }));
    expect(dailyTotals(fixes, "America/Toronto")[0]!.date).toBe("2026-11-02");
    expect(dailyTotals(fixes, "UTC")[0]!.date).toBe("2026-11-03");
  });
});
