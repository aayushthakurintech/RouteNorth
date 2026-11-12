import { describe, expect, it } from "vitest";
import { distance } from "./geo.js";
import { DEFAULT_FLEET, TORONTO_TRUCK } from "./routes.js";
import { initialState, step } from "./vehicle.js";

describe("simulator", () => {
  it("covers about speed x time of distance", () => {
    let s = initialState(HWY);
    const start = s.position;
    for (let i = 0; i < 60; i++) s = step(HWY, s, 1); // 60 s at 100 km/h
    expect(distance(start, s.position)).toBeGreaterThan(1600);
    expect(distance(start, s.position)).toBeLessThan(1700);
    expect(s.odometer).toBeCloseTo(1666, -1);
  });

  it("stops and dwells at each route point", () => {
    const v = { ...TORONTO_TRUCK, dwellSeconds: 60 };
    let s = initialState(v);
    let sawDwell = false;
    for (let i = 0; i < 600; i++) {
      s = step(v, s, 5);
      if (s.speedKmh === 0 && s.dwellLeft > 0) sawDwell = true;
    }
    expect(sawDwell).toBe(true);
  });

  it("keeps every vehicle on valid coordinates for a long run", () => {
    for (const v of DEFAULT_FLEET) {
      let s = initialState(v);
      for (let i = 0; i < 5000; i++) {
        s = step(v, s, 5);
        expect(s.position.lat).toBeGreaterThan(40);
        expect(s.position.lat).toBeLessThan(46);
        expect(Number.isFinite(s.heading)).toBe(true);
      }
    }
  });
});

const HWY = DEFAULT_FLEET[2]!;

import { sensors } from "./vehicle.js";
describe("sensors", () => {
  it("are deterministic and in believable ranges", () => {
    const s = { leg: 0, along: 0, dwellLeft: 0, odometer: 52_000, position: { lat: 43, lng: -79 }, heading: 0, speedKmh: 60 };
    expect(sensors(s)).toEqual(sensors(s));
    const x = sensors(s);
    expect(x.sat).toBeGreaterThanOrEqual(8); expect(x.hdop).toBeLessThan(2);
    expect(x.fuel).toBeGreaterThan(0); expect(x.fuel).toBeLessThanOrEqual(100);
    expect(x.rpm).toBeGreaterThan(750);
  });
});
