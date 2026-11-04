import { describe, expect, it } from "vitest";
import { applyDeductions, cardState, evaluateBonus, isBigChange, longestStreak, netPay, priceTrip, resolveCard, type Assignment, type RateSpec } from "./rate-engine.js";

describe("the spec's worked example", () => {
  // 25 km, 40 minutes, 10 minutes waiting (first 5 free), peak hour, $5 tip, $8 vehicle fee -> net $55.20
  const spec: RateSpec = { type: "base_distance_time", baseCents: 400, perKmCents: 120, perMinCents: 30, waiting: { freeMin: 5, perMinCents: 50 }, peakPct: 20 };
  const trip = { distanceKm: 25, durationMin: 40, waitingMin: 10, stops: 1, weightKg: 0, tipCents: 500, conditions: { peak: true } };
  it("gives the same lines and total", () => {
    const r = priceTrip(spec, trip);
    const by = Object.fromEntries(r.lines.map((l) => [l.key, l.cents]));
    expect(by).toMatchObject({ base: 400, distance: 3000, time: 1200, waiting: 250, peak: 970, tip: 500 });
    expect(r.subtotalCents).toBe(5820);
    expect(r.totalCents).toBe(6320);
    expect(netPay({ earnings: r.subtotalCents, bonuses: 0, tips: 500, deductions: 800 })).toBe(5520); // $55.20
  });
});

describe("other rate types", () => {
  const t = { distanceKm: 10, durationMin: 30, waitingMin: 0, stops: 4, weightKg: 200, zone: "Downtown" };
  it("flat, distance, time, per stop, zone, weight", () => {
    expect(priceTrip({ type: "flat", flatCents: 1200 }, t).totalCents).toBe(1200);
    expect(priceTrip({ type: "distance", perKmCents: 120 }, t).totalCents).toBe(1200);
    expect(priceTrip({ type: "time", perMinCents: 30 }, t).totalCents).toBe(900);
    expect(priceTrip({ type: "per_stop", baseCents: 500, perStopCents: 300 }, t).totalCents).toBe(1400);
    expect(priceTrip({ type: "zone", zones: [{ name: "Downtown", cents: 800 }, { name: "Suburbs", cents: 1400 }] }, t).totalCents).toBe(800);
    expect(priceTrip({ type: "weight", baseCents: 100, perKgCents: 5 }, t).totalCents).toBe(1100);
  });
  it("commission, hourly and the hybrid guarantee", () => {
    expect(priceTrip({ type: "commission", commissionPct: 70 }, { ...t, customerPriceCents: 3333 }).totalCents).toBe(2333); // 2333.1 rounds down
    expect(priceTrip({ type: "hourly", perHourCents: 2000 }, { ...t, hours: 2.5 }).totalCents).toBe(5000);
    const h: RateSpec = { type: "hybrid", perHourCents: 2000, baseCents: 300, perKmCents: 100, guaranteeCents: 1500 };
    expect(priceTrip(h, { ...t, hours: 0.5 }).totalCents).toBe(1500); // hourly 1000, trip 1300 -> guarantee 1500
    expect(priceTrip(h, { ...t, hours: 2 }).totalCents).toBe(4000); // hourly wins
  });
  it("minimum, rounding, tax, surge cap, tolls and cancellation", () => {
    expect(priceTrip({ type: "distance", perKmCents: 100, minCents: 1500 }, t).totalCents).toBe(1500);
    expect(priceTrip({ type: "flat", flatCents: 1233, rounding: "5c" }, t).totalCents).toBe(1235);
    const taxed = priceTrip({ type: "flat", flatCents: 1000, tax: { label: "HST", pct: 13 } }, t);
    expect(taxed.lines.find((l) => l.key === "tax")!.cents).toBe(130);
    expect(priceTrip({ type: "flat", flatCents: 1000, surgeCapX: 1.5 }, { ...t, conditions: { surge: 3 } }).totalCents).toBe(1500);
    expect(priceTrip({ type: "flat", flatCents: 1000 }, { ...t, conditions: { surge: 3 } }).notes.join()).toMatch(/surge/i);
    expect(priceTrip({ type: "flat", flatCents: 1000, tollsPassThrough: true }, { ...t, tollCents: 450 }).totalCents).toBe(1450);
    expect(priceTrip({ type: "flat", flatCents: 1000, cancellationFeeCents: 300 }, { ...t, status: "cancelled" }).totalCents).toBe(300);
    expect(priceTrip({ type: "flat", flatCents: 1000 }, { ...t, status: "failed" }).totalCents).toBe(0);
  });
  it("never drifts by a cent: whole cents in, whole cents out, lines add up", () => {
    const spec: RateSpec = { type: "base_distance_time", baseCents: 333, perKmCents: 117, perMinCents: 29, peakPct: 17, nightPct: 11, fuelSurchargePct: 3 };
    for (let k = 1; k <= 200; k++) {
      const r = priceTrip(spec, { distanceKm: k * 0.37, durationMin: k * 1.3, waitingMin: 0, stops: 1, weightKg: 0, conditions: { peak: k % 2 === 0, night: k % 3 === 0 } });
      expect(r.lines.every((l) => Number.isInteger(l.cents))).toBe(true);
      expect(r.lines.reduce((a, l) => a + l.cents, 0)).toBe(r.totalCents);
    }
  });
});

describe("versions and who wins", () => {
  it("calls a change big when money moves more than 10% or the type changes", () => {
    const a: RateSpec = { type: "distance", perKmCents: 100 };
    expect(isBigChange(a, { ...a, perKmCents: 105 })).toBe(false);
    expect(isBigChange(a, { ...a, perKmCents: 120 })).toBe(true);
    expect(isBigChange(a, { type: "flat", flatCents: 100 })).toBe(true);
    expect(isBigChange(null, a)).toBe(true);
  });
  it("works out draft / pending / active / expired / scheduled", () => {
    expect(cardState({ status: "draft", startsOn: "2026-01-01", endsOn: null }, "2026-06-01")).toBe("draft");
    expect(cardState({ status: "active", startsOn: "2026-01-01", endsOn: "2026-03-01" }, "2026-06-01")).toBe("expired");
    expect(cardState({ status: "active", startsOn: "2026-07-01", endsOn: null }, "2026-06-01")).toBe("scheduled");
    expect(cardState({ status: "active", startsOn: "2026-01-01", endsOn: null }, "2026-06-01")).toBe("active");
  });
  it("lets the most specific assignment win and explains the rest", () => {
    const mk = (id: string, kind: Assignment["kind"], target: string | null, startsOn = "2026-01-01"): Assignment => ({ id, cardId: id, cardName: id, kind, target, startsOn, endsOn: null });
    const r = resolveCard([mk("all", "all", null), mk("zone", "zone", "Downtown"), mk("drv", "driver", "d1"), mk("old", "driver", "d1", "2027-01-01")], { driverId: "d1", zone: "Downtown", day: "2026-06-01" });
    expect(r.winner!.id).toBe("drv");
    expect(r.considered.find((c) => c.id === "old")!.why).toMatch(/not active/);
    expect(resolveCard([mk("z", "zone", "Suburbs")], { zone: "Downtown", day: "2026-06-01" }).winner).toBeNull();
  });
});

describe("bonuses and deductions", () => {
  const s = { trips: 52, onTimePct: 96, ratingAvg: 4.9, peakTrips: 10, zoneTrips: { downtown: 6 }, safetyEvents: 0, daysWithTrips: 20, longestStreak: 6 };
  it("pays a trip count bonus and shows progress", () => {
    const r = evaluateBonus({ id: "1", name: "50 trips", kind: "trip_count", amountCents: 7500, params: { minTrips: 50 } }, s);
    expect(r).toMatchObject({ earnedCents: 7500, current: 52, target: 50 });
    expect(evaluateBonus({ id: "1", name: "x", kind: "trip_count", amountCents: 7500, params: { minTrips: 60 } }, s).earnedCents).toBe(0);
  });
  it("pays tiers, streaks, peak and zone bonuses", () => {
    expect(evaluateBonus({ id: "t", name: "t", kind: "tiered", amountCents: 0, params: { tiers: [{ trips: 20, cents: 2000 }, { trips: 50, cents: 6000 }] } }, s).earnedCents).toBe(6000);
    expect(evaluateBonus({ id: "s", name: "s", kind: "streak", amountCents: 1000, params: { days: 5 } }, s).earnedCents).toBe(1000);
    expect(evaluateBonus({ id: "p", name: "p", kind: "peak", amountCents: 200, params: {} }, s).earnedCents).toBe(2000);
    expect(evaluateBonus({ id: "z", name: "z", kind: "busy_zone", amountCents: 150, params: { zone: "Downtown" } }, s).earnedCents).toBe(900);
    expect(longestStreak(["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-05"])).toBe(3);
  });
  it("caps deductions at a share of the payout and never goes below zero", () => {
    const r = applyDeductions(10_000, [{ id: "a", wantCents: 3000 }, { id: "b", wantCents: 4000 }], 50);
    expect(r).toEqual([{ id: "a", takeCents: 3000 }, { id: "b", takeCents: 2000 }]);
    expect(applyDeductions(0, [{ id: "a", wantCents: 100 }], 50)[0]!.takeCents).toBe(0);
  });
});
