import { describe, expect, it } from "vitest";
import { occursOn, upcoming, isRecurrence, isoWeekday } from "./recurrence.js";
import { checkAddress } from "./address.js";

describe("recurrence", () => {
  it("knows weekdays", () => {
    expect(isoWeekday("2026-06-01")).toBe(1); // Monday
    expect(isoWeekday("2026-06-07")).toBe(7);
  });
  it("repeats daily and every other day", () => {
    expect(occursOn({ every: "day", from: "2026-06-01" }, "2026-06-09")).toBe(true);
    const every2 = { every: "day", interval: 2, from: "2026-06-01" } as const;
    expect(occursOn(every2, "2026-06-03")).toBe(true);
    expect(occursOn(every2, "2026-06-04")).toBe(false);
    expect(occursOn(every2, "2026-05-30")).toBe(false);
  });
  it("repeats weekly on chosen days, every N weeks, within limits", () => {
    const mwf = { every: "week", days: [1, 3, 5], from: "2026-06-01", until: "2026-06-30" } as const;
    expect(upcoming(mwf, "2026-06-01", 4)).toEqual(["2026-06-01", "2026-06-03", "2026-06-05", "2026-06-08"]);
    expect(occursOn(mwf, "2026-07-01")).toBe(false);
    const biweekly = { every: "week", days: [2], interval: 2, from: "2026-06-02" } as const;
    expect(upcoming(biweekly, "2026-06-01", 3)).toEqual(["2026-06-02", "2026-06-16", "2026-06-30"]);
  });
  it("supports a custom list and validates shape", () => {
    expect(occursOn({ every: "custom", dates: ["2026-12-24"] }, "2026-12-24")).toBe(true);
    expect(isRecurrence({ every: "week", days: [8] })).toBe(false);
    expect(isRecurrence({ every: "month" })).toBe(false);
    expect(isRecurrence({ every: "day", interval: 3 })).toBe(true);
  });
});

describe("address checks", () => {
  it("tidies postal codes, provinces and capitals", () => {
    const a = checkAddress("123 MAIN STREET, TORONTO, ONTARIO m5v2t6");
    expect(a.postalCode).toBe("M5V 2T6");
    expect(a.province).toBe("ON");
    expect(a.suggestion).toBe("123 Main St, Toronto, ON M5V 2T6");
    expect(a.issues).toEqual(["all_caps"]);
  });
  it("flags what is missing", () => {
    expect(checkAddress("Main St Toronto").issues).toEqual(expect.arrayContaining(["no_street_number", "no_postal_code", "no_province"]));
    expect(checkAddress("").issues).toEqual(["empty"]);
    expect(checkAddress("45 rue Saint-Denis, Montréal, Québec H2X 3K8").province).toBe("QC");
  });
});
