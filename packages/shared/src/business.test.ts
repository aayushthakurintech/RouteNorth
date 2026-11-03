import { describe, expect, it } from "vitest";
import {
  budgetStatus, buildLines, checkRateCard, computePay, daysUntil, extractMentions, monthlyEstimate, parseFx, periodRange, planConflicts, planUsage,
  priceFromRateCard, slaState, taxFor, toHome, trialDaysLeft, type RateCardLike,
} from "./business.js";

describe("tax", () => {
  it("uses the province table", () => {
    expect(taxFor("ON", 100).total).toBe(13);
    expect(taxFor("ON", 100).lines).toEqual([{ code: "HST", rate: 13, amount: 13 }]);
    expect(taxFor("QC", 100).lines.map((l) => [l.code, l.amount])).toEqual([["GST", 5], ["QST", 9.98]]);
    expect(taxFor("BC", 200).total).toBe(24);
    expect(taxFor("AB", 100).total).toBe(5);
  });
  it("supports a flat custom rate and falls back safely", () => {
    expect(taxFor("ON", 100, { mode: "custom", customRatePct: 8 }).total).toBe(8);
    expect(taxFor("ZZ", 100).total).toBe(13);
    expect(taxFor("ON", -5).total).toBe(0);
  });
});

describe("currency", () => {
  it("parses rates and converts", () => {
    const r = parseFx("USD=1.37, eur: 1.47; b4d=3; GBP=0; EURO=2");
    expect(r).toEqual({ USD: 1.37, EUR: 1.47 });
    expect(toHome(100, "USD", "CAD", r)).toBe(137);
    expect(toHome(100, "CAD", "CAD", r)).toBe(100);
    expect(toHome(100, "MXN", "CAD", r)).toBeNull();
  });
});

describe("lines", () => {
  it("adds up and validates", () => {
    const r = buildLines([{ description: "Delivery", qty: 2, unitPrice: 12.5 }, { description: "Fuel surcharge", unitPrice: 3.333 }]);
    expect(r.subtotal).toBe(28.33);
    expect(r.lines[0]!.amount).toBe(25);
    expect(() => buildLines([])).toThrow();
    expect(() => buildLines([{ description: "", unitPrice: 1 }])).toThrow(/line 1/);
    expect(() => buildLines([{ description: "x", qty: 0, unitPrice: 1 }])).toThrow(/quantity/);
    expect(() => buildLines([{ description: "x", unitPrice: -1 }])).toThrow(/price/);
  });
});

describe("plans", () => {
  it("flags usage near and over the limit", () => {
    const rows = planUsage("starter", { vehicles: 9, users: 6, jobs: 10 });
    expect(rows.find((r) => r.metric === "vehicles")).toMatchObject({ pct: 90, state: "warn" });
    expect(rows.find((r) => r.metric === "users")?.state).toBe("over");
    expect(rows.find((r) => r.metric === "jobs")?.state).toBe("ok");
    expect(planUsage("enterprise", { vehicles: 9999, users: 1, jobs: 1 })[0]).toMatchObject({ limit: null, pct: null, state: "ok" });
  });
  it("estimates cost and trial days", () => {
    expect(monthlyEstimate("pro", 10)).toBe(199);
    expect(trialDaysLeft("2026-01-10T00:00:00Z", new Date("2026-01-01T12:00:00Z"))).toBe(9);
    expect(trialDaysLeft("2025-01-01T00:00:00Z", new Date("2026-01-01T00:00:00Z"))).toBe(0);
    expect(trialDaysLeft(null)).toBeNull();
  });
});

describe("rate cards", () => {
  const distance: RateCardLike = { basis: "distance", base: 10, minimum: 20, zones: [], tiers: [{ upTo: 10, rate: 2 }, { upTo: 50, rate: 1.5 }, { upTo: null, rate: 1 }] };
  it("prices distance in marginal bands", () => {
    expect(priceFromRateCard(distance, { km: 5 }).amount).toBe(20); // 10 + 10 = 20
    expect(priceFromRateCard(distance, { km: 30 }).amount).toBe(10 + 20 + 30);
    expect(priceFromRateCard(distance, { km: 80 }).amount).toBe(10 + 20 + 60 + 30);
    expect(priceFromRateCard(distance, { km: 0 }).amount).toBe(20); // minimum
  });
  it("prices by zone and rejects unknown zones", () => {
    const z: RateCardLike = { basis: "zone", base: 0, minimum: 0, tiers: [], zones: [{ name: "Downtown", price: 8 }, { name: "Suburbs", price: 15 }] };
    expect(priceFromRateCard(z, { zone: "suburbs" }).amount).toBe(15);
    expect(() => priceFromRateCard(z, { zone: "Mars" })).toThrow(/zone/);
  });
  it("validates what a person typed", () => {
    expect(checkRateCard({ basis: "distance", tiers: [] })).toMatch(/band/);
    expect(checkRateCard({ basis: "distance", tiers: [{ upTo: 10, rate: 1 }, { upTo: 5, rate: 1 }] })).toMatch(/go up/);
    expect(checkRateCard({ basis: "distance", tiers: [{ upTo: null, rate: 1 }, { upTo: 5, rate: 1 }] })).toMatch(/last band/);
    expect(checkRateCard({ basis: "distance", tiers: [{ upTo: 10, rate: 1 }, { upTo: null, rate: 1 }] })).toBeNull();
    expect(checkRateCard({ basis: "zone", zones: [] })).toMatch(/zone/);
  });
});

describe("pay", () => {
  it("adds hours, overtime, stops and distance", () => {
    expect(computePay({ regularHours: 40, overtimeHours: 4, stops: 100, km: 500, hourlyRate: 20, payPerStop: 0.5, payPerKm: 0.1, overtimeMultiplier: 1.5 }))
      .toEqual({ regular: 800, overtime: 120, perStop: 50, perKm: 50, gross: 1020 });
  });
});

describe("budgets and contracts", () => {
  it("reads the state of a budget", () => {
    expect(budgetStatus(100, 1000, 90, 0.5)).toMatchObject({ pct: 10, projected: 200, state: "ok" });
    expect(budgetStatus(950, 1000, 90, 0.9).state).toBe("warn");
    expect(budgetStatus(600, 1000, 90, 0.4).state).toBe("warn"); // on track to overspend
    expect(budgetStatus(1200, 1000, 90, 1).state).toBe("over");
  });
  it("finds the period", () => {
    const r = periodRange("quarter", new Date("2026-05-16T00:00:00Z"));
    expect(r.from).toBe("2026-04-01");
    expect(r.to).toBe("2026-07-01");
    expect(r.elapsedFrac).toBeGreaterThan(0.2);
    expect(periodRange("year", new Date("2026-12-31T00:00:00Z")).to).toBe("2027-01-01");
  });
  it("judges service levels and dates", () => {
    expect(slaState(96, 95)).toBe("ok");
    expect(slaState(93, 95)).toBe("at_risk");
    expect(slaState(80, 95)).toBe("breached");
    expect(slaState(null, 95)).toBe("no_data");
    expect(daysUntil("2026-03-10", new Date("2026-03-01T15:00:00Z"))).toBe(9);
  });
});

describe("schedule", () => {
  it("finds overlaps and days off", () => {
    const plans = [
      { id: "a", driverId: "d1", startsAt: "2026-03-02T08:00:00Z", endsAt: "2026-03-02T16:00:00Z" },
      { id: "b", driverId: "d1", startsAt: "2026-03-02T15:00:00Z", endsAt: "2026-03-02T20:00:00Z" },
      { id: "c", driverId: "d2", startsAt: "2026-03-02T15:00:00Z", endsAt: "2026-03-02T20:00:00Z" },
      { id: "d", driverId: "d1", startsAt: "2026-03-03T12:00:00Z", endsAt: "2026-03-03T14:00:00Z" },
    ];
    const off = [{ id: "o1", userId: "d1", startsOn: "2026-03-03", endsOn: "2026-03-03", status: "approved" }, { id: "o2", userId: "d2", startsOn: "2026-03-02", endsOn: "2026-03-02", status: "rejected" }];
    const c = planConflicts(plans, off);
    expect(c.filter((x) => x.kind === "overlap").map((x) => x.planId).sort()).toEqual(["a", "b"]);
    expect(c.filter((x) => x.kind === "time_off").map((x) => x.planId)).toEqual(["d"]);
    expect(c.some((x) => x.planId === "c")).toBe(false);
  });
});

describe("mentions", () => {
  const people = [{ id: "1", email: "Dana.Lee@x.ca" }, { id: "2", email: "sam@x.ca" }, { id: "3", email: "sam@y.ca" }];
  it("finds handles and ignores emails and unknown names", () => {
    expect(extractMentions("hi @dana.lee, please check", people)).toEqual(["1"]);
    expect(extractMentions("@sam ok?", people).sort()).toEqual(["2", "3"]);
    expect(extractMentions("mail me at x@sam.ca", people)).toEqual([]);
    expect(extractMentions("@nobody and @dana.lee.", people)).toEqual(["1"]);
  });
});
