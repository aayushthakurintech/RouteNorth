import { describe, expect, it } from "vitest";
import { daysToExpiry, documentState, fuelEconomy, maintenanceDue, summarizeWeather } from "./fleet.js";

describe("maintenance", () => {
  const today = "2026-07-01";
  it("is due by date or kilometers, whichever comes first", () => {
    const byDate = maintenanceDue({ everyDays: 90, everyKm: null, lastDoneOn: "2026-04-10", lastDoneKm: null }, today, 0);
    expect(byDate).toMatchObject({ dueOn: "2026-07-09", daysLeft: 8, state: "due_soon" });
    const byKm = maintenanceDue({ everyDays: 365, everyKm: 10000, lastDoneOn: "2026-06-01", lastDoneKm: 50000 }, today, 60200);
    expect(byKm).toMatchObject({ dueKm: 60000, kmLeft: -200, state: "overdue" });
    expect(maintenanceDue({ everyDays: 365, everyKm: 10000, lastDoneOn: "2026-06-01", lastDoneKm: 50000 }, today, 52000).state).toBe("ok");
    expect(maintenanceDue({ everyDays: 30, everyKm: null, lastDoneOn: null, lastDoneKm: null }, today, 0).state).toBe("due_soon");
  });
});

describe("documents", () => {
  it("counts days and classifies", () => {
    expect(daysToExpiry("2026-07-31", "2026-07-01")).toBe(30);
    expect(documentState("2026-07-20", 30, "2026-07-01")).toBe("due_soon");
    expect(documentState("2026-06-30", 30, "2026-07-01")).toBe("overdue");
    expect(documentState("2027-01-01", 30, "2026-07-01")).toBe("ok");
    expect(documentState(null, 30, "2026-07-01")).toBe("ok");
  });
});

describe("fuel economy", () => {
  it("measures litres per 100 km between readings", () => {
    const r = fuelEconomy([
      { odometerKm: 1000, litres: 60, cost: 90 }, { odometerKm: 1500, litres: 50, cost: 75 }, { odometerKm: 2000, litres: 45, cost: 69 },
    ]);
    expect(r.km).toBe(1000);
    expect(r.lPer100).toBe(9.5);
    expect(r.litres).toBe(155);
    expect(fuelEconomy([{ odometerKm: null, litres: 40, cost: null }]).lPer100).toBeNull();
  });
});

describe("weather", () => {
  it("warns about winter driving", () => {
    expect(summarizeWeather({ tempC: 18, precipMm: 0, precipProb: 5, windKmh: 12, code: 1 }).level).toBe("ok");
    expect(summarizeWeather({ tempC: -3, precipMm: 3, precipProb: 90, windKmh: 20, code: 73 })).toMatchObject({ level: "severe", reason: "snow" });
    expect(summarizeWeather({ tempC: 10, precipMm: 0, precipProb: 0, windKmh: 55, code: 2 })).toMatchObject({ level: "caution", reason: "strong wind" });
    expect(summarizeWeather({ tempC: 20, precipMm: 0, precipProb: 0, windKmh: 10, code: 96 }).level).toBe("severe");
  });
});
