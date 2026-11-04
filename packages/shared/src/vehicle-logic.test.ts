import { describe, expect, it } from "vitest";
import { addDaysISO, checkVin, docStatus, financeAccrual, keepRepairSell, licenceAllows, paybackDays, serviceStatus } from "./vehicle-logic.js";

describe("VIN", () => {
  it("accepts a real VIN and checks the digit", () => {
    const ok = checkVin("1M8GDM9AXKP042788"); // the well-known example VIN from the standard
    expect(ok.ok).toBe(true);
    expect(ok.checkDigitOk).toBe(true);
    expect(checkVin("1M8GDM9A1KP042788").checkDigitOk).toBe(false);
  });
  it("rejects bad length and I, O, Q", () => {
    expect(checkVin("123").ok).toBe(false);
    expect(checkVin("1M8GDM9AXKP04278I").ok).toBe(false);
  });
});

describe("documents", () => {
  it("is valid, expiring or expired", () => {
    expect(docStatus("2026-12-31", "2026-11-04").state).toBe("valid");
    expect(docStatus("2026-11-20", "2026-11-04").state).toBe("expiring");
    expect(docStatus("2026-11-03", "2026-11-04")).toEqual({ state: "expired", daysLeft: -1 });
    expect(docStatus(null, "2026-11-04").state).toBe("none");
  });
});

describe("service schedule: date, kilometres or hours, whichever comes first", () => {
  const base = { today: "2026-11-04", odometerKm: 50_000, intervalKm: 10_000, intervalDays: 180, lastDoneOn: "2026-06-01", lastDoneKm: 42_000 };
  it("km comes first", () => {
    const s = serviceStatus(base);
    expect(s.nextKm).toBe(52_000);
    expect(s.kmLeft).toBe(2_000);
    expect(s.nextDate).toBe(addDaysISO("2026-06-01", 180));
    expect(s.dueBy).toBe("date"); // 2026-11-28 is 24 days away: 24/14 > 2000/500? date = 1.7, km = 4 so date is more urgent
    expect(s.state).toBe("ok");
  });
  it("is overdue once the kilometres are passed", () => {
    const s = serviceStatus({ ...base, odometerKm: 52_300 });
    expect(s.state).toBe("overdue");
    expect(s.dueBy).toBe("km");
  });
  it("is due soon within 14 days or 500 km", () => {
    expect(serviceStatus({ ...base, odometerKm: 51_600 }).state).toBe("due_soon");
    expect(serviceStatus({ ...base, today: "2026-11-20" }).state).toBe("due_soon");
  });
  it("has nothing to say without a schedule", () => {
    expect(serviceStatus({ today: "2026-11-04", odometerKm: 1 }).state).toBe("none");
  });
  it("uses the soonest of the extra plans", () => {
    const s = serviceStatus({ today: "2026-11-04", odometerKm: 1000, plans: [{ task: "Brakes", everyKm: 40_000, lastDoneKm: 0 }, { task: "Annual inspection", everyDays: 365, lastDoneOn: "2025-11-10" }] });
    expect(s.task).toBe("Annual inspection");
    expect(s.daysLeft).toBe(6);
    expect(s.state).toBe("due_soon");
  });
});

describe("licence class", () => {
  it("covers cars, trucks and buses", () => {
    expect(licenceAllows("5", "car")).toBe("ok");
    expect(licenceAllows("5", "truck")).toBe("not_licensed");
    expect(licenceAllows("1", "truck")).toBe("ok");
    expect(licenceAllows("Class 2", "bus")).toBe("ok");
    expect(licenceAllows("DZ", "bus")).toBe("not_licensed");
    expect(licenceAllows("4", "bus", 30)).toBe("not_licensed");
    expect(licenceAllows("XYZ", "truck")).toBe("unknown");
    expect(licenceAllows(null, "car")).toBe("unknown");
  });
});

describe("money view helpers", () => {
  it("payback", () => {
    expect(paybackDays(5_000_000, 1_000_000, 100)).toBe(500);
    expect(paybackDays(5_000_000, -1, 100)).toBeNull();
  });
  it("keep, repair or sell", () => {
    expect(keepRepairSell({ repairs12mCents: 0, valueCents: 2_000_000, ageYears: 1, profit12mCents: 500_000 }).advice).toBe("keep");
    expect(keepRepairSell({ repairs12mCents: 1_200_000, valueCents: 1_500_000, ageYears: 9, profit12mCents: -1 }).advice).toBe("sell");
    expect(keepRepairSell({ repairs12mCents: 700_000, valueCents: 2_000_000, ageYears: 6, profit12mCents: 1 }).advice).toBe("repair");
  });
  it("accrues loan cost by the day", () => {
    expect(financeAccrual(120_000, "monthly", 365)).toBe(1_440_000);
    expect(financeAccrual(30_000, "weekly", 7)).toBe(Math.round((30_000 * 52 * 7) / 365));
  });
});
