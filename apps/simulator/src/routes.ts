import type { SimVehicle } from "./vehicle.js";

/** A downtown Toronto delivery loop for a truck. */
export const TORONTO_TRUCK: SimVehicle = {
  id: "sim-truck-1",
  speedKmh: 40,
  dwellSeconds: 120,
  route: [
    { lat: 43.6532, lng: -79.3832 },
    { lat: 43.6629, lng: -79.3957 },
    { lat: 43.6677, lng: -79.4046 },
    { lat: 43.6455, lng: -79.4020 },
    { lat: 43.6426, lng: -79.3871 },
  ],
};

/** A school bus loop with short stops. */
export const MISSISSAUGA_BUS: SimVehicle = {
  id: "sim-bus-1",
  speedKmh: 35,
  dwellSeconds: 30,
  route: [
    { lat: 43.5890, lng: -79.6441 },
    { lat: 43.5960, lng: -79.6300 },
    { lat: 43.6050, lng: -79.6350 },
    { lat: 43.6000, lng: -79.6520 },
  ],
};

/** A long-haul truck on Highway 401 between Toronto and Kingston (no stops). */
export const HWY401_TRUCK: SimVehicle = {
  id: "sim-truck-2",
  speedKmh: 100,
  dwellSeconds: 0,
  route: [
    { lat: 43.7001, lng: -79.4163 },
    { lat: 43.8561, lng: -79.0204 },
    { lat: 43.9000, lng: -78.8600 },
    { lat: 44.2312, lng: -76.4860 },
  ],
};

export const DEFAULT_FLEET: SimVehicle[] = [TORONTO_TRUCK, MISSISSAUGA_BUS, HWY401_TRUCK];
