import { describe, expect, it } from "vitest";
import { brandVars, contrast, parseHex } from "./color";

describe("brand colors", () => {
  it("parses hex", () => {
    expect(parseHex("#0f5fa8")).toEqual([15, 95, 168]);
    expect(parseHex("nope")).toBeNull();
  });
  it("keeps white text readable on any brand color on light backgrounds", () => {
    for (const hex of ["#ffd400", "#0f5fa8", "#00a86b", "#ff4500", "#e6e6e6"]) {
      const v = brandVars(hex, false)!;
      const c = parseHex(v["--brand"]!)!;
      expect(contrast(c, [255, 255, 255])).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("keeps the brand readable against dark surfaces", () => {
    for (const hex of ["#0b1f4d", "#330000", "#0f5fa8"]) {
      const c = parseHex(brandVars(hex, true)!["--brand"]!)!;
      expect(contrast(c, [19, 26, 39])).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("picks black or white text for the button", () => {
    expect(brandVars("#ffd400", true)!["--brand-fg"]).toBe("#000000");
  });
});
