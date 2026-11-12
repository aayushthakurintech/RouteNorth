import { describe, expect, it } from "vitest";
import { addDays, barPct, emptyLine, linesSubtotal, linesToBody, money, weekStart } from "./money";

describe("money helpers", () => {
  it("formats money in both languages and survives bad input", () => {
    expect(money(1234.5, "CAD", "en")).toMatch(/1,234\.50/);
    expect(money(1234.5, "CAD", "fr")).toMatch(/1\s234,50/);
    expect(money(null, "CAD", "en")).toBe("–");
    expect(money(NaN, "CAD", "en")).toBe("–");
    expect(money(5, "??", "en")).toBe("?? 5.00");
  });
  it("moves dates and finds the Monday", () => {
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(weekStart("2026-03-01")).toBe("2026-02-23"); // a Sunday
    expect(weekStart("2026-03-02")).toBe("2026-03-02"); // a Monday
    expect(weekStart("2026-03-04")).toBe("2026-03-02");
  });
  it("turns drafts into lines and adds them up", () => {
    const lines = [{ description: "Haul", qty: "2", unitPrice: "10.50" }, emptyLine(), { description: "Fee", qty: "", unitPrice: "3.333" }];
    expect(linesToBody(lines)).toEqual([{ description: "Haul", qty: 2, unitPrice: 10.5 }, { description: "Fee", qty: 1, unitPrice: 3.333 }]);
    expect(linesSubtotal(lines)).toBe(24.33);
    expect(linesSubtotal([emptyLine()])).toBe(0);
  });
  it("keeps bars inside the box", () => {
    expect([barPct(-5), barPct(50), barPct(250), barPct(null)]).toEqual([0, 50, 100, 0]);
  });
});
