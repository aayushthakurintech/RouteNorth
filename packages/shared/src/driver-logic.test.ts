import { describe, expect, it } from "vitest";
import { complianceScore, DEFAULT_HOURS_RULES, driverBlockers, portalDriverScore, hoursReport, safetyScore } from "./driver-logic.js";

describe("driver score", () => {
  it("uses 30/25/25/10/10 and matches a hand calculation", () => {
    // on time 90, safety 80, rating 4.5 (87.5), acceptance 100, cleanliness 5 (100)
    const r = portalDriverScore({ onTimePct: 90, safetyScore: 80, ratingAvg: 4.5, acceptancePct: 100, cleanlinessAvg: 5 });
    expect(r.score).toBe(Math.round(0.3 * 90 + 0.25 * 80 + 0.25 * 87.5 + 0.1 * 100 + 0.1 * 100));
    expect(r.parts.map((p) => p.weight)).toEqual([30, 25, 25, 10, 10]);
    expect(r.formula).toContain("30% on-time rate");
  });
  it("shares the weight of a missing part", () => {
    const r = portalDriverScore({ onTimePct: 100, safetyScore: 100, ratingAvg: null, acceptancePct: null, cleanlinessAvg: null });
    expect(r.score).toBe(100);
    expect(r.parts.find((p) => p.key === "rating")!.points).toBeNull();
    expect(portalDriverScore({ onTimePct: null, safetyScore: null, ratingAvg: null, acceptancePct: null, cleanlinessAvg: null }).score).toBeNull();
  });
});

describe("safety score", () => {
  it("is 100 with no events and drops with events per 1,000 km", () => {
    expect(safetyScore([], 10_000)).toBe(100);
    expect(safetyScore([{ kind: "speeding", severity: 1 }], 1000)).toBe(90); // 2 points per 1000 km
    expect(safetyScore([{ kind: "incident", severity: 3 }], 100)).toBe(0); // 30 points over 0.5 (min exposure) = 60 per 1000 km
  });
});

describe("hours", () => {
  const t = (d: string, a: string, b: string) => ({ startedAt: `${d}T${a}:00Z`, endedAt: `${d}T${b}:00Z` });
  it("totals days and weeks and flags overtime, long days and short rest", () => {
    const shifts = [t("2026-03-02", "08:00", "20:00"), t("2026-03-03", "05:00", "22:00"), t("2026-03-04", "08:00", "18:00"), t("2026-03-05", "08:00", "18:00"), t("2026-03-06", "08:00", "18:00")];
    const r = hoursReport(shifts, DEFAULT_HOURS_RULES, new Date("2026-03-07T00:00:00Z"), "UTC");
    expect(r.weeks).toEqual([{ weekStart: "2026-03-02", hours: 59 }]);
    expect(r.violations.map((v) => v.kind)).toEqual(expect.arrayContaining(["overtime_week", "daily_limit", "rest"]));
  });
  it("is clean for a normal week", () => {
    const shifts = ["02", "03", "04"].map((d) => t(`2026-03-${d}`, "09:00", "17:00"));
    expect(hoursReport(shifts, DEFAULT_HOURS_RULES, new Date("2026-03-07T00:00:00Z"), "UTC").violations).toEqual([]);
  });
});

describe("compliance and blockers", () => {
  it("scores and clamps", () => {
    expect(complianceScore({ expiredDocs: 0, expiringDocs: 0, missingCourses: 0, hoursViolations: 0, onboardingIncomplete: false })).toBe(100);
    expect(complianceScore({ expiredDocs: 1, expiringDocs: 2, missingCourses: 1, hoursViolations: 0, onboardingIncomplete: false })).toBe(50);
    expect(complianceScore({ expiredDocs: 5, expiringDocs: 0, missingCourses: 0, hoursViolations: 0, onboardingIncomplete: true })).toBe(0);
  });
  it("lists why a driver cannot work", () => {
    expect(driverBlockers({ status: "active", archived: false, requiredOpen: [], legalDocsExpired: [] })).toEqual([]);
    expect(driverBlockers({ status: "suspended", archived: false, requiredOpen: [], legalDocsExpired: ["Driver licence"] })).toHaveLength(2);
    expect(driverBlockers({ status: "onboarding", archived: false, requiredOpen: ["contract"], legalDocsExpired: [] })[0]).toMatch(/contract/);
  });
});
