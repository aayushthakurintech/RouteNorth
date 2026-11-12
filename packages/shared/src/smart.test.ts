import { describe, expect, it } from "vitest";
import {
  backhaul, breakdownRisk, clusterTerritories, coachingTips, demandForecast, detectCornering, detectCrash, explainDelays, fatigueState, groupRides, learnDwell, lateRisk,
  normalizeAddress, parseAssistant, suggestDrivers, suggestMoves, workloadBalance, type DriverCtx,
} from "./smart.js";

const min = (n: number) => n * 60000;
const T0 = Date.parse("2026-03-02T14:00:00Z");

describe("learnDwell", () => {
  it("needs enough visits, then reports the typical time against the plan", () => {
    const obs = [8, 10, 9, 30].map((m) => ({ key: "acme", label: "Acme", minutes: m, planned: 5 })).concat([{ key: "once", label: "Once", minutes: 3, planned: 5 }]);
    const r = learnDwell(obs);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ key: "acme", samples: 4, medianMin: 9.5, plannedMin: 5, diffMin: 4.5 });
  });
  it("ignores impossible times", () => { expect(learnDwell([{ key: "a", minutes: -1 }, { key: "a", minutes: 999 }, { key: "a", minutes: 5 }], 1)[0]!.samples).toBe(1); });
});

describe("demandForecast", () => {
  const hist = Array.from({ length: 56 }, (_, i) => { const d = new Date(Date.parse("2026-01-05T12:00:00Z") + i * 86400000); return { date: d.toISOString().slice(0, 10), value: d.getUTCDay() === 1 ? 40 : 20 }; });
  it("follows the weekday pattern and turns jobs into drivers", () => {
    const f = demandForecast(hist, "2026-03-02", 7, 10);
    expect(new Date("2026-03-02T12:00:00Z").getUTCDay()).toBe(1);
    expect(f[0]).toMatchObject({ jobs: 40, drivers: 4 });
    expect(f[1]!.jobs).toBe(20); expect(f[1]!.drivers).toBe(2);
  });
  it("says nothing without history", () => { expect(demandForecast([], "2026-03-02", 7, 10)).toEqual([]); });
});

describe("explainDelays", () => {
  it("names a late start and a long stop, and leaves the rest as driving time", () => {
    const e = explainDelays({
      plannedStart: T0, startedAt: T0 + min(12),
      stops: [
        { name: "A", windowEnd: T0 + min(60), arrivedAt: T0 + min(40), departedAt: T0 + min(65), serviceMin: 5, status: "done" },
        { name: "B", windowEnd: T0 + min(90), arrivedAt: T0 + min(110), departedAt: T0 + min(115), serviceMin: 5, status: "done" },
      ],
    });
    expect(e.worstLateMin).toBe(20);
    expect(e.causes.map((c) => c.kind)).toEqual(["long_stop", "late_start"]);
    expect(e.causes[0]).toMatchObject({ stop: "A", minutes: 20 });
  });
  it("is empty for an on-time route", () => {
    expect(explainDelays({ plannedStart: T0, startedAt: T0, stops: [{ name: "A", windowEnd: T0 + min(60), arrivedAt: T0 + min(30), departedAt: T0 + min(35), serviceMin: 5, status: "done" }] }).causes).toEqual([]);
  });
});

describe("lateRisk", () => {
  it("rises as the slack disappears", () => {
    const r = lateRisk([
      { id: "a", name: "A", etaMs: T0 + min(30), windowEndMs: T0 + min(120) },
      { id: "b", name: "B", etaMs: T0 + min(30), windowEndMs: T0 + min(32) },
      { id: "c", name: "C", etaMs: T0 + min(30), windowEndMs: T0 + min(10) },
      { id: "d", name: "D", etaMs: T0 + min(30), windowEndMs: null },
    ], T0);
    expect(r.map((x) => x.id)).toEqual(["c", "b", "a"]);
    expect(r[0]!.level).toBe("high"); expect(r[2]!.level).toBe("low");
  });
});

describe("breakdownRisk", () => {
  const base = { odometerKm: 80_000, ageYears: 3, kmSinceService: 1000, serviceEveryKm: 10_000, daysSinceService: 30, serviceEveryDays: 180, openDefects: 0, incidents90: 0, repairs90: 0, downtimeH90: 0, lPer100Now: 30, lPer100Base: 30 };
  it("is low for a healthy vehicle", () => expect(breakdownRisk(base).level).toBe("low"));
  it("flags overdue service, defects and rising fuel use, and says why", () => {
    const r = breakdownRisk({ ...base, kmSinceService: 12_500, openDefects: 2, lPer100Now: 36, repairs90: 3 });
    expect(r.level).not.toBe("low");
    expect(r.reasons.map((x) => x.key)).toEqual(expect.arrayContaining(["service_km", "open_defects", "fuel_up", "repairs"]));
  });
});

describe("suggestDrivers", () => {
  const d = (o: Partial<DriverCtx>): DriverCtx => ({ id: "x", name: "X", skills: [], lat: 43.65, lng: -79.38, stopsToday: 2, maxStops: 20, onTimeRate: 90, csat: 4.5, visitsHere: 0, onTimeHere: null, ...o });
  it("blocks drivers without the skill, off today or full, and prefers the closer, lighter one", () => {
    const r = suggestDrivers({ lat: 43.66, lng: -79.39, skills: ["refrigerated"] }, [
      d({ id: "a", name: "A", skills: ["refrigerated"] }), d({ id: "b", name: "B", skills: [] }), d({ id: "c", name: "C", skills: ["refrigerated"], lat: 44.5, lng: -80 }),
      d({ id: "e", name: "E", skills: ["refrigerated"], offToday: true }), d({ id: "f", name: "F", skills: ["refrigerated"], stopsToday: 20 }),
    ]);
    expect(r.map((x) => x.driverId).slice(0, 2)).toEqual(["a", "c"]);
    expect(Object.fromEntries(r.map((x) => [x.driverId, x.blocked]))).toMatchObject({ b: "skills", e: "off_today", f: "full" });
  });
  it("likes a driver who knows the customer and respects 'avoid'", () => {
    const r = suggestDrivers({ lat: 43.65, lng: -79.38, skills: [], customer: "Acme" }, [d({ id: "a", visitsHere: 5, onTimeHere: 95 }), d({ id: "b" }), d({ id: "c", prefers: { avoidCustomers: ["acme"] } })]);
    expect(r[0]!.driverId).toBe("a"); expect(r.find((x) => x.driverId === "c")!.blocked).toBe("avoids_customer");
  });
});

describe("normalizeAddress", () => {
  it("spells out street types, fixes capitals, postal code and province", () => {
    const r = normalizeAddress("123 KING ST W, toronto, ontario m5h2n2");
    expect(r.text).toBe("123 King Street W, Toronto, ON M5H 2N2");
    expect(r.changes).toEqual(expect.arrayContaining(["capitals", "street_type", "postal_code", "province"]));
  });
  it("moves a unit number to the end", () => { expect(normalizeAddress("5 - 22 Elm Ave, Ottawa ON").text).toBe("22 Elm Avenue, Ottawa ON, Unit 5"); });
  it("handles empty text", () => expect(normalizeAddress("   ")).toEqual({ text: "", changes: [] }));
});

describe("parseAssistant", () => {
  const ctx = { drivers: [{ id: "s", name: "Sam Singh" }, { id: "a", name: "Alex Roy" }], today: "2026-03-02" };
  it("understands the reassignment sentence from the playbook", () => {
    expect(parseAssistant("Move all of Sam's stops to Alex and tell the customers", ctx)).toEqual({ type: "reassign", fromId: "s", toId: "a", date: "2026-03-02", notify: true });
  });
  it("understands French and tomorrow", () => {
    expect(parseAssistant("Déplace tous les arrêts de Sam à Alex demain", ctx)).toMatchObject({ type: "reassign", fromId: "s", toId: "a", date: "2026-03-03", notify: false });
  });
  it("does not guess an unknown or identical driver", () => {
    expect(parseAssistant("move Sam's stops to Zed", ctx)).toEqual({ type: "unknown", reason: "driver_not_found", name: "Zed" });
    expect(parseAssistant("move Sam's stops to Sam", ctx)).toEqual({ type: "unknown", reason: "same_driver" });
  });
  it("turns a described report into a template, period and grouping", () => {
    expect(parseAssistant("Show me a fuel report for last month by vehicle", ctx)).toEqual({ type: "report", template: "fuelEmissions", range: "lastMonth", groupBy: "vehicle" });
    expect(parseAssistant("driver report last 30 days", ctx)).toMatchObject({ template: "driverScorecard", range: "last30" });
  });
  it("answers the other common questions", () => {
    expect(parseAssistant("What needs my attention today?", ctx).type).toBe("briefing");
    expect(parseAssistant("who is running late", ctx).type).toBe("late");
    expect(parseAssistant("how many drivers do I need next week", ctx).type).toBe("forecast");
    expect(parseAssistant("why was route 7 late?", ctx)).toEqual({ type: "explain", routeHint: "7" });
    expect(parseAssistant("tell me a joke", ctx)).toEqual({ type: "unknown", reason: "no_match" });
  });
});

describe("territories and balance", () => {
  const pts = [...Array.from({ length: 6 }, (_, i) => ({ id: `w${i}`, lat: 43.65 + i * 0.001, lng: -79.9 + (i % 2) * 0.01 })), ...Array.from({ length: 6 }, (_, i) => ({ id: `e${i}`, lat: 43.65 + i * 0.001, lng: -79.0 + (i % 2) * 0.01 }))];
  it("splits points into even, compact areas and is repeatable", () => {
    const c = clusterTerritories(pts, 2);
    expect(c.map((x) => x.ids.length)).toEqual([6, 6]);
    for (const g of c) expect(new Set(g.ids.map((i) => i[0])).size).toBe(1);
    expect(clusterTerritories(pts, 2)).toEqual(c);
    expect(c[0]!.hull.length).toBeGreaterThanOrEqual(3);
  });
  it("copes with more areas than points", () => expect(clusterTerritories(pts.slice(0, 2), 5)).toHaveLength(2));
  it("measures balance and suggests moves toward the light driver", () => {
    const loads = [{ id: "a", name: "A", stops: 10, minutes: 600, km: 100 }, { id: "b", name: "B", stops: 2, minutes: 120, km: 20 }];
    const b = workloadBalance(loads);
    expect(b.overloaded).toEqual(["a"]); expect(b.underloaded).toEqual(["b"]); expect(b.fair).toBe(false);
    const stops = Array.from({ length: 10 }, (_, i) => ({ id: `s${i}`, driverId: "a", lat: 43.65 + i * 0.01, lng: -79.4, minutes: 60 }));
    const moves = suggestMoves(loads, stops);
    expect(moves.length).toBeGreaterThan(0); expect(moves.every((m) => m.fromId === "a" && m.toId === "b")).toBe(true);
    expect(moves.length).toBeLessThanOrEqual(4);
  });
  it("calls an even day fair", () => expect(workloadBalance([{ id: "a", name: "A", stops: 5, minutes: 300, km: 50 }, { id: "b", name: "B", stops: 5, minutes: 310, km: 50 }]).fair).toBe(true));
});

describe("backhaul and shared rides", () => {
  it("lists pickups on the way home, closest detour first, within capacity", () => {
    const r = backhaul({ lat: 43.9, lng: -79.4 }, { lat: 43.65, lng: -79.4 }, [{ id: "on", lat: 43.78, lng: -79.4, weightKg: 10 }, { id: "off", lat: 43.78, lng: -78.5, weightKg: 10 }, { id: "heavy", lat: 43.78, lng: -79.4, weightKg: 900 }], 100);
    expect(r.map((x) => x.id)).toEqual(["on"]); expect(r[0]!.detourKm).toBeLessThan(0.1);
  });
  it("groups riders going the same way, never above the seats", () => {
    const rq = (id: string, lat: number, at: number) => ({ id, from: { lat, lng: -79.4 }, to: { lat: 43.9, lng: -79.4 }, seats: 2, atMs: T0 + min(at) });
    const g = groupRides([rq("a", 43.65, 0), rq("b", 43.651, 5), rq("c", 43.652, 8), rq("d", 43.0, 6), rq("e", 43.653, 90)], 4);
    expect(g.map((x) => x.ids)).toEqual([["a", "b"], ["d"], ["c"], ["e"]]);
  });
});

describe("safety", () => {
  const fx = (t: number, speed: number, heading: number) => ({ time: new Date(T0 + t * 1000).toISOString(), lat: 43.65, lng: -79.38, speed, ignition: true, heading });
  it("finds a hard corner only at speed", () => {
    expect(detectCornering([fx(0, 60, 0), fx(2, 60, 40)])).toHaveLength(1);
    expect(detectCornering([fx(0, 60, 0), fx(2, 60, 3)])).toHaveLength(0);
    expect(detectCornering([fx(0, 5, 0), fx(2, 5, 80)])).toHaveLength(0);
  });
  it("finds a sudden stop that lasts, not a slow-down", () => {
    const crash = [fx(0, 80, 0), fx(2, 1, 0), fx(20, 0, 0), fx(40, 0, 0), fx(70, 0, 0)];
    expect(detectCrash(crash)).toHaveLength(1);
    expect(detectCrash([fx(0, 80, 0), fx(2, 1, 0), fx(20, 0, 0), fx(40, 30, 0), fx(70, 40, 0)])).toHaveLength(0);
    expect(detectCrash([fx(0, 80, 0), fx(30, 20, 0), fx(60, 0, 0)])).toHaveLength(0);
  });
  it("warns before the limit and at it", () => {
    expect(fatigueState(120, 120).level).toBe("ok");
    expect(fatigueState(260, 250).level).toBe("soon");
    expect(fatigueState(310, 310).level).toBe("now");
    expect(fatigueState(670, 20).level).toBe("now");
  });
  it("picks the tips that matter and praises a clean trip", () => {
    expect(coachingTips({ km: 50, speeding: 0, harshBrake: 0, harshAccel: 0, corner: 0, idleMin: 2 })).toEqual([{ key: "tip_great" }]);
    const t = coachingTips({ km: 50, speeding: 6, harshBrake: 3, harshAccel: 1, corner: 1, idleMin: 12 });
    expect(t).toHaveLength(2); expect(t[0]!.key).toBe("tip_speed");
  });
});
