import { describe, expect, it } from "vitest";
import { applyPosition, filterFleet, initFleet, refreshStatuses, TRAIL_LENGTH, type LiveVehicle } from "./fleet.js";

const base: LiveVehicle = {
  deviceId: "d1", vehicleId: "v1", name: "Truck 7", kind: "truck", time: "2026-11-02T12:00:00Z",
  lat: 43.65, lng: -79.38, speed: 0, heading: 0, ignition: true, status: "idle",
};
const now = new Date("2026-11-02T12:00:30Z");

describe("fleet state", () => {
  it("moves a vehicle and extends its trail", () => {
    const f = applyPosition(initFleet([base]), {
      deviceId: "d1", time: "2026-11-02T12:00:20Z", lat: 43.66, lng: -79.39, speed: 50, heading: 90, ignition: true,
    }, now);
    expect(f.d1!.status).toBe("moving");
    expect(f.d1!.trail).toHaveLength(2);
    expect(f.d1!.lat).toBe(43.66);
  });
  it("ignores older fixes and unknown devices", () => {
    const f0 = initFleet([base]);
    const old = { deviceId: "d1", time: "2026-11-02T11:00:00Z", lat: 1, lng: 1, speed: 0, heading: 0, ignition: true };
    expect(applyPosition(f0, old, now)).toBe(f0);
    expect(applyPosition(f0, { ...old, deviceId: "zzz", time: "2026-11-02T12:01:00Z" }, now)).toBe(f0);
  });
  it("caps the trail length", () => {
    let f = initFleet([base]);
    for (let i = 1; i <= TRAIL_LENGTH + 20; i++) {
      f = applyPosition(f, {
        deviceId: "d1", time: new Date(Date.parse(base.time) + i * 1000).toISOString(),
        lat: 43 + i / 1000, lng: -79, speed: 10, heading: 0, ignition: true,
      }, new Date(Date.parse(base.time) + i * 1000));
    }
    expect(f.d1!.trail).toHaveLength(TRAIL_LENGTH);
  });
  it("turns silent vehicles offline over time", () => {
    const f = refreshStatuses(initFleet([base]), new Date("2026-11-02T12:20:00Z"));
    expect(f.d1!.status).toBe("offline");
  });
  it("searches by name, case-insensitively", () => {
    const f = initFleet([base, { ...base, deviceId: "d2", name: "Bus 3" }]);
    expect(filterFleet(f, "bus").map((v) => v.name)).toEqual(["Bus 3"]);
    expect(filterFleet(f, "").map((v) => v.name)).toEqual(["Bus 3", "Truck 7"]);
  });
});
