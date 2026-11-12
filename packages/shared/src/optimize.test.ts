import { describe, expect, it } from "vitest";
import {
  comparePlans, evaluate, evaluateOrder, learnTrafficProfile, liveEtas, makeTravel, planFleet, planRoute, whatIfAdd,
  type PlanStop, type PlanVehicle,
} from "./optimize.js";
import { insideShape, pointInPolygon } from "./geo.js";

const flat = Array(24).fill(1);
const travel = makeTravel({ traffic: flat, roadFactor: 1, speedKph: 60 });
const T0 = Date.UTC(2026, 5, 1, 13, 0); // 08:00 Toronto
const depot = { lat: 43.65, lng: -79.38 };
const veh = (o: Partial<PlanVehicle> = {}): PlanVehicle => ({ id: "v1", start: depot, shiftStart: T0, ...o });
const stop = (id: string, dLat: number, dLng: number, o: Partial<PlanStop> = {}): PlanStop => ({ id, lat: depot.lat + dLat, lng: depot.lng + dLng, serviceMin: 5, ...o });

describe("travel model", () => {
  it("is slower in rush hour and when avoiding highways", () => {
    const a = depot, b = { lat: 43.75, lng: -79.38 };
    const free = makeTravel({ traffic: flat })(a, b, T0);
    const rush = makeTravel()(a, b, Date.UTC(2026, 5, 1, 22, 0)); // 17:00 local
    const noHw = makeTravel({ traffic: flat, avoid: ["highways"] })(a, b, T0);
    expect(rush.s).toBeGreaterThan(free.s * 1.3);
    expect(noHw.s).toBeGreaterThan(free.s);
    expect(noHw.m).toBeGreaterThan(free.m);
  });
});

describe("single vehicle planning", () => {
  it("orders stops along a line instead of zig-zagging", () => {
    const stops = [stop("c", 0.03, 0), stop("a", 0.01, 0), stop("d", 0.04, 0), stop("b", 0.02, 0)];
    const plan = planRoute(veh({ openEnd: true }), stops, travel);
    expect(plan.order).toEqual(["a", "b", "c", "d"]);
    expect(plan.violations).toEqual([]);
  });

  it("beats the naive order and respects time windows", () => {
    const stops = [
      stop("far", 0.2, 0, { windowStart: T0, windowEnd: T0 + 3 * 3600_000 }),
      stop("near", 0.01, 0, { windowStart: T0 + 3 * 3600_000, windowEnd: T0 + 5 * 3600_000 }),
    ];
    const plan = planRoute(veh(), stops, travel);
    expect(plan.order).toEqual(["far", "near"]);
    expect(plan.totals.lateCount).toBe(0);
    expect(plan.totals.waitS).toBeGreaterThan(0);
    const naive = evaluateOrder(veh(), [...stops].reverse(), travel);
    expect(naive.totals.lateCount).toBeGreaterThan(0);
  });

  it("minimises distance when asked", () => {
    const stops = Array.from({ length: 8 }, (_, i) => stop(`s${i}`, Math.sin(i) * 0.05, Math.cos(i * 2) * 0.05));
    const byTime = planRoute(veh(), stops, travel, { objective: "time" });
    const byDist = planRoute(veh(), stops, travel, { objective: "distance" });
    expect(byDist.totals.distanceM).toBeLessThanOrEqual(byTime.totals.distanceM + 1);
  });

  it("flags capacity and shift limits as violations", () => {
    const heavy = [stop("a", 0.01, 0, { weightKg: 600 }), stop("b", 0.02, 0, { weightKg: 600 })];
    expect(planRoute(veh({ capacityKg: 1000 }), heavy, travel).violations).toContain("capacity");
    expect(planRoute(veh({ capacityKg: 2000 }), heavy, travel).violations).toEqual([]);
    expect(planRoute(veh({ maxShiftMin: 20 }), [stop("far", 0.5, 0)], travel).violations).toContain("shift");
  });

  it("inserts a mandatory break after long driving", () => {
    const stops = [stop("a", 0.3, 0), stop("b", 0.6, 0)];
    const plan = planRoute(veh({ breakAfterMin: 30, breakMin: 20 }), stops, travel);
    expect(plan.events.some((e) => e.kind === "break")).toBe(true);
    expect(plan.totals.breakS % (20 * 60)).toBe(0);
    expect(plan.totals.breakS).toBeGreaterThanOrEqual(20 * 60);
  });

  it("keeps pickups before their deliveries", () => {
    const stops = [
      stop("drop", 0.01, 0, { kind: "delivery", pairId: "p", weightKg: 10 }),
      stop("pick", 0.05, 0, { kind: "pickup", pairId: "p", weightKg: 10 }),
    ];
    const plan = planRoute(veh(), stops, travel);
    expect(plan.order.indexOf("pick")).toBeLessThan(plan.order.indexOf("drop"));
    expect(plan.violations).toEqual([]);
  });
});

describe("electric vehicles", () => {
  it("adds a charging stop when the range is not enough", () => {
    const charger = { lat: depot.lat + 0.25, lng: depot.lng };
    const stops = [stop("a", 0.45, 0)];
    const ev = veh({ rangeKm: 70, chargers: [charger], chargeMin: 30 });
    const plan = planRoute(ev, stops, travel);
    expect(plan.events.filter((e) => e.kind === "charge").length).toBeGreaterThan(0);
    expect(plan.violations).toEqual([]);
    expect(planRoute(veh({ rangeKm: 70 }), stops, travel).violations).toContain("range");
  });
});

describe("fleet planning", () => {
  it("splits stops between vehicles and reports what no vehicle can take", () => {
    const north = Array.from({ length: 4 }, (_, i) => stop(`n${i}`, 0.05 + i * 0.005, 0, { weightKg: 300 }));
    const south = Array.from({ length: 4 }, (_, i) => stop(`s${i}`, -0.05 - i * 0.005, 0, { weightKg: 300 }));
    const huge = stop("huge", 0.01, 0.01, { weightKg: 5000 });
    const vs = [veh({ id: "v1", capacityKg: 1500 }), veh({ id: "v2", capacityKg: 1500 })];
    const plan = planFleet(vs, [...north, ...south, huge], travel);
    expect(plan.unassigned).toEqual([{ stopId: "huge", reason: "capacity" }]);
    const ids = plan.routes.map((r) => r.order.length);
    expect(ids.reduce((a, b) => a + b, 0)).toBe(8);
    // each vehicle serves one side
    for (const r of plan.routes) {
      const sides = new Set(r.order.map((id) => id[0]));
      expect(sides.size).toBe(1);
    }
  });

  it("matches skills and territories", () => {
    const stops = [stop("cold", 0.01, 0, { skills: ["refrigerated"] }), stop("zoneB", 0.02, 0, { territory: "B" })];
    const vs = [veh({ id: "plain", territories: ["A"] }), veh({ id: "fridge", skills: ["refrigerated"], territories: ["A", "B"] })];
    const plan = planFleet(vs, stops, travel);
    expect(plan.routes.find((r) => r.vehicleId === "fridge")!.order.sort()).toEqual(["cold", "zoneB"]);
    expect(plan.unassigned).toEqual([]);
    expect(planFleet([vs[0]!], stops, travel).unassigned.map((u) => u.stopId).sort()).toEqual(["cold", "zoneB"]);
  });

  it("serves urgent stops first when capacity is short", () => {
    const a = stop("normal", 0.02, 0, { weightKg: 800 });
    const b = stop("urgent", 0.02, 0.001, { weightKg: 800, priority: "urgent" });
    const plan = planFleet([veh({ capacityKg: 1000 })], [a, b], travel);
    expect(plan.routes[0]!.order).toEqual(["urgent"]);
    expect(plan.unassigned[0]!.stopId).toBe("normal");
  });
});

describe("scenarios, what-if and ETAs", () => {
  it("compares two plans with cost", () => {
    const stops = [stop("a", 0.1, 0), stop("b", 0.2, 0), stop("c", 0.1, 0.1)];
    const good = planRoute(veh(), stops, travel);
    const bad = evaluateOrder(veh(), [stops[1]!, stops[0]!, stops[2]!], travel);
    const cmp = comparePlans(bad, good, { perKm: 0.8, perHour: 35 });
    expect(cmp.winner).toBe("b");
    expect(cmp.delta.distanceM).toBeLessThan(0);
  });

  it("shows the effect of adding a stop before saving", () => {
    const base = [stop("a", 0.02, 0), stop("b", 0.06, 0)];
    const r = whatIfAdd(veh(), base, stop("x", 0.04, 0), travel);
    expect(r.order).toEqual(["a", "x", "b"]);
    expect(r.addedDurationS).toBeGreaterThan(0);
    expect(r.addedDistanceM).toBeLessThan(1000);
  });

  it("learns rush-hour slowdowns from real fixes", () => {
    const fixes: { time: string; speed: number }[] = [];
    for (let i = 0; i < 40; i++) {
      fixes.push({ time: new Date(Date.UTC(2026, 5, 1, 17, i)).toISOString(), speed: 60 });
      fixes.push({ time: new Date(Date.UTC(2026, 5, 1, 12, i)).toISOString(), speed: 30 });
      fixes.push({ time: new Date(Date.UTC(2026, 5, 1, 14, i)).toISOString(), speed: 60 });
    }
    const prof = learnTrafficProfile(fixes, (ms) => new Date(ms).getUTCHours());
    expect(prof[12]).toBeCloseTo(2, 1);
    expect(prof[17]).toBe(1);
  });

  it("projects live ETAs and lateness", () => {
    const now = T0;
    const out = liveEtas(depot, now, [
      { id: "a", ...stop("a", 0.1, 0), windowEnd: now + 3600_000 * 5 },
      { id: "b", ...stop("b", 0.2, 0), windowEnd: now + 10 * 60_000 },
    ], travel);
    expect(out[0]!.eta).toBeGreaterThan(now);
    expect(out[0]!.lateByS).toBe(0);
    expect(out[1]!.lateByS).toBeGreaterThan(0);
  });

  it("evaluate is deterministic", () => {
    const stops = [stop("a", 0.1, 0)];
    expect(evaluate(veh(), stops, travel).cost).toBe(evaluate(veh(), stops, travel).cost);
  });
});

describe("shapes", () => {
  const sq = [[0, 0], [0, 1], [1, 1], [1, 0]] as const;
  it("detects points in polygons and circles", () => {
    expect(pointInPolygon(0.5, 0.5, sq)).toBe(true);
    expect(pointInPolygon(1.5, 0.5, sq)).toBe(false);
    expect(insideShape({ shape: "circle", lat: 43, lng: -79, radiusM: 500 }, 43.001, -79)).toBe(true);
    expect(insideShape({ shape: "circle", lat: 43, lng: -79, radiusM: 50 }, 43.01, -79)).toBe(false);
    expect(insideShape({ shape: "polygon", polygon: sq }, 0.2, 0.2)).toBe(true);
  });
});
