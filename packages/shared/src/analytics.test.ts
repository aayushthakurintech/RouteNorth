import { describe, expect, it } from "vitest";
import { anomaly, co2Kg, delta, detectSafetyEvents, driverScore, evalFormula, forecast, inQuietHours, parseQuestion, percentile, periodBefore, pivot, routeAdherence } from "./analytics.js";
import type { Fix } from "./trips.js";

const fix = (s: number, speed: number, extra: Partial<Fix> = {}): Fix => ({ time: new Date(Date.UTC(2026, 0, 1, 12, 0, s)).toISOString(), lat: 43.7, lng: -79.4, speed, ignition: true, odometer: null, ...extra });

describe("statistics", () => {
  it("percentile and delta", () => {
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
    expect(percentile([], 0.5)).toBeNull();
    expect(delta(110, 100)).toEqual({ abs: 10, pct: 10 });
    expect(delta(5, 0)).toEqual({ abs: 5, pct: null });
    expect(delta(null, 3)).toBeNull();
  });
  it("compares with the previous period or last year", () => {
    const from = new Date("2026-03-08T00:00:00Z"), to = new Date("2026-03-15T00:00:00Z");
    expect(periodBefore(from, to, "prev").from.toISOString()).toBe("2026-03-01T00:00:00.000Z");
    expect(periodBefore(from, to, "year").to.toISOString()).toBe("2025-03-15T00:00:00.000Z");
  });
  it("flags a route that cost 30% more than usual only when it is unusual", () => {
    const hist = [100, 102, 98, 101, 99, 100, 103];
    expect(anomaly(130, hist)?.unusual).toBe(true);
    expect(anomaly(130, hist)?.changePct).toBe(30);
    expect(anomaly(101, hist)?.unusual).toBe(false);
    expect(anomaly(1, [1, 2])).toBeNull();
  });
  it("forecasts weekdays from past weekdays", () => {
    const series = Array.from({ length: 28 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), value: new Date(Date.UTC(2026, 0, 1 + i)).getUTCDay() === 0 ? 0 : 10 }));
    const f = forecast(series, 7);
    expect(f).toHaveLength(7);
    expect(f.find((x) => new Date(`${x.date}T00:00:00Z`).getUTCDay() === 0)?.value).toBe(0);
    expect(f.find((x) => new Date(`${x.date}T00:00:00Z`).getUTCDay() === 3)?.value).toBe(10);
    expect(forecast(series.slice(0, 3), 7)).toEqual([]);
  });
  it("converts fuel to CO2 and treats electric as zero", () => {
    expect(co2Kg(100, "diesel")).toBeCloseTo(268);
    expect(co2Kg(100, "electric")).toBe(0);
  });
});

describe("driving behaviour", () => {
  it("finds a speeding episode that lasts, not a blip", () => {
    const f = [fix(0, 100), fix(5, 120), fix(10, 125), fix(16, 122), fix(21, 100)];
    const ev = detectSafetyEvents(f, { speedLimitKmh: 110 });
    expect(ev.filter((e) => e.kind === "speeding")).toEqual([expect.objectContaining({ value: 125, durationS: 11 })]);
    expect(detectSafetyEvents([fix(0, 100), fix(3, 120), fix(6, 100)], { speedLimitKmh: 110 }).filter((e) => e.kind === "speeding")).toHaveLength(0);
  });
  it("finds harsh braking and ignores gaps", () => {
    const f = [fix(0, 80), fix(2, 50), fix(4, 50)];
    expect(detectSafetyEvents(f, { speedLimitKmh: 200 })).toEqual([expect.objectContaining({ kind: "harsh_brake", value: 15 })]);
    expect(detectSafetyEvents([fix(0, 80), fix(60, 10)], { speedLimitKmh: 200 })).toEqual([]);
  });
  it("scores drivers by events per distance", () => {
    expect(driverScore(2, { speeding: 5, harshBrake: 0, harshAccel: 0 })).toBeNull();
    expect(driverScore(100, { speeding: 0, harshBrake: 0, harshAccel: 0 })).toBe(100);
    expect(driverScore(100, { speeding: 2, harshBrake: 2, harshAccel: 0 })).toBe(90);
    expect(driverScore(100, { speeding: 50, harshBrake: 50, harshAccel: 0 })).toBe(0);
  });
  it("measures how closely a driver followed the plan", () => {
    const path = [{ lat: 43.0, lng: -79.0 }, { lat: 43.0, lng: -78.9 }];
    expect(routeAdherence([{ lat: 43.0005, lng: -78.95 }, { lat: 43.1, lng: -78.95 }], path)).toBe(50);
    expect(routeAdherence([], path)).toBeNull();
  });
});

describe("calculated fields", () => {
  it("evaluates arithmetic with names", () => {
    expect(evalFormula("cost / stops * 100", { cost: 50, stops: 20 })).toBe(250);
    expect(evalFormula("round((a + b) / 3, 1)", { a: 1, b: 1 })).toBe(0.7);
    expect(evalFormula("-a + 2 * (3 + 1)", { a: 1 })).toBe(7);
  });
  it("gives null for divide by zero or missing values and rejects anything else", () => {
    expect(evalFormula("a / b", { a: 1, b: 0 })).toBeNull();
    expect(evalFormula("a + x", { a: 1 })).toBeNull();
    expect(() => evalFormula("a; process.exit()", { a: 1 })).toThrow();
    expect(() => evalFormula("eval(1)", {})).toThrow(/unknown function/);
    expect(() => evalFormula("1 +", {})).toThrow();
  });
});

describe("pivot", () => {
  it("builds rows by columns with totals", () => {
    const p = pivot([{ d: "A", day: "Mon", n: 2 }, { d: "A", day: "Tue", n: 3 }, { d: "B", day: "Mon", n: 5 }], "d", "day", "n");
    expect(p.columns).toEqual(["Mon", "Tue"]);
    expect(p.rows[0]).toEqual({ name: "A", cells: [2, 3], total: 5 });
    expect(p.rows[1]).toEqual({ name: "B", cells: [5, null], total: 5 });
    expect(p.totals).toEqual([7, 3]);
    expect(p.grand).toBe(10);
  });
});

describe("questions", () => {
  const now = new Date(2026, 2, 18, 10, 0); // Wed 18 March 2026, local time
  it("understands 'which driver had the most delays last month'", () => {
    const q = parseQuestion("Which driver had the most delays last month?", now)!;
    expect(q).toMatchObject({ metric: "avgDelayMin", by: "driver", order: "desc", periodLabel: "last month" });
    expect(q.from.getMonth()).toBe(1);
    expect(q.to.getMonth()).toBe(2);
  });
  it("orders best and worst by whether lower is better", () => {
    expect(parseQuestion("who is the safest driver this week", now)).toMatchObject({ metric: "driverScore", order: "desc", by: "driver" });
    expect(parseQuestion("worst on-time rate by vehicle", now)).toMatchObject({ metric: "onTimeRate", order: "asc", by: "vehicle" });
    expect(parseQuestion("top 3 vehicles by idle time", now)).toMatchObject({ metric: "idleH", limit: 3 });
  });
  it("returns null for something it does not know", () => {
    expect(parseQuestion("what is the meaning of life", now)).toBeNull();
  });
});

describe("quiet hours", () => {
  it("handles hours that wrap past midnight", () => {
    expect(inQuietHours("23:30", "22:00", "06:00")).toBe(true);
    expect(inQuietHours("05:59", "22:00", "06:00")).toBe(true);
    expect(inQuietHours("12:00", "22:00", "06:00")).toBe(false);
    expect(inQuietHours("12:00", "09:00", "17:00")).toBe(true);
    expect(inQuietHours("12:00", null, null)).toBe(false);
  });
});
