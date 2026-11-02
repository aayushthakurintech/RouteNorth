import { bearing, distance, type LatLng } from "./geo.js";

export interface SimVehicle {
  id: string;
  /** Route to drive, looped forever. */
  route: LatLng[];
  /** Cruise speed in km/h. */
  speedKmh: number;
  /** Seconds to wait at each route point (a delivery stop or bus stop). */
  dwellSeconds: number;
}

export interface SimState {
  /** Index of the point we are driving away from. */
  leg: number;
  /** Metres travelled along the current leg. */
  along: number;
  dwellLeft: number;
  odometer: number;
  position: LatLng;
  heading: number;
  speedKmh: number;
}

export function initialState(v: SimVehicle): SimState {
  const [first, second] = v.route;
  if (!first || !second) throw new Error("route needs at least two points");
  return { leg: 0, along: 0, dwellLeft: 0, odometer: 0, position: first, heading: bearing(first, second), speedKmh: 0 };
}

/** Advance the vehicle by dt seconds. Pure: returns a new state. */
export function step(v: SimVehicle, s: SimState, dt: number): SimState {
  if (s.dwellLeft > 0) {
    return { ...s, dwellLeft: Math.max(0, s.dwellLeft - dt), speedKmh: 0 };
  }
  let leg = s.leg;
  let along = s.along + (v.speedKmh / 3.6) * dt;
  let odometer = s.odometer + (v.speedKmh / 3.6) * dt;
  let dwellLeft = 0;

  for (;;) {
    const a = v.route[leg % v.route.length]!;
    const b = v.route[(leg + 1) % v.route.length]!;
    const len = distance(a, b);
    if (along < len) {
      const f = len === 0 ? 0 : along / len;
      return {
        leg: leg % v.route.length, along, dwellLeft, odometer,
        position: { lat: a.lat + (b.lat - a.lat) * f, lng: a.lng + (b.lng - a.lng) * f },
        heading: bearing(a, b),
        speedKmh: dwellLeft > 0 ? 0 : v.speedKmh,
      };
    }
    // Arrived at point b: start dwelling there and continue on the next leg afterwards.
    along -= len;
    leg += 1;
    dwellLeft = v.dwellSeconds;
    if (dwellLeft > 0) {
      return {
        leg: leg % v.route.length, along: 0, dwellLeft, odometer,
        position: b, heading: bearing(b, v.route[(leg + 1) % v.route.length]!), speedKmh: 0,
      };
    }
  }
}
