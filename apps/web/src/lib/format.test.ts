import { describe, expect, it } from "vitest";
import { dayRange, formatDuration, formatKm, toCsv } from "./format.js";

describe("format", () => {
  it("formats durations", () => {
    expect(formatDuration(45)).toBe("45 s");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(3720)).toBe("1 h 02 min");
  });
  it("formats distance per locale", () => {
    expect(formatKm(12_340, "en")).toBe("12.3 km");
    expect(formatKm(12_340, "fr")).toContain("12,3");
  });
  it("covers one local day", () => {
    const { from, to } = dayRange("2026-11-02");
    expect(new Date(to).getTime() - new Date(from).getTime()).toBeGreaterThanOrEqual(23 * 3600_000);
    expect(new Date(from).getDate()).toBe(2);
  });
  it("escapes CSV cells and neutralizes formulas", () => {
    expect(toCsv(["a", "b"], [["x,y", 'say "hi"'], ["=SUM(A1)", 3]])).toBe(
      'a,b\r\n"x,y","say ""hi"""\r\n\'=SUM(A1),3\r\n',
    );
  });
});
