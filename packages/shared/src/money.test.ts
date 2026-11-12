import { describe, expect, it } from "vitest";
import { allocate, applyRounding, centsFromDollars, centsToPlain, parseCents, percentOf, sumCents, times } from "./money.js";

describe("money in whole cents", () => {
  it("parses amounts without float error", () => {
    expect(parseCents("12.34")).toBe(1234);
    expect(parseCents("$1,200")).toBe(120000);
    expect(parseCents("0.1")).toBe(10);
    expect(parseCents("-4.5")).toBe(-450);
    expect(() => parseCents("12.345")).toThrow();
    expect(() => parseCents("abc")).toThrow();
  });
  it("reads old dollar decimals", () => {
    expect(centsFromDollars(19.99)).toBe(1999);
    expect(centsFromDollars(1.005)).toBe(101);
    expect(centsFromDollars(0.1 + 0.2)).toBe(30);
    expect(centsFromDollars(-2.5)).toBe(-250);
  });
  it("takes a percent of an amount", () => {
    expect(percentOf(4850, 20)).toBe(970);
    expect(percentOf(333, 10)).toBe(33);
    expect(percentOf(335, 10)).toBe(34); // 33.5 rounds up
    expect(percentOf(-335, 10)).toBe(-34);
    expect(percentOf(10000, 13)).toBe(1300);
  });
  it("multiplies a rate by a quantity", () => {
    expect(times(120, 25)).toBe(3000);
    expect(times(30, 40)).toBe(1200);
    expect(times(120, 25.4)).toBe(3048);
    expect(times(50, 5)).toBe(250);
  });
  it("applies a rounding rule", () => {
    expect(applyRounding(1237, "cent")).toBe(1237);
    expect(applyRounding(1237, "5c")).toBe(1235);
    expect(applyRounding(1238, "5c")).toBe(1240);
    expect(applyRounding(1250, "dollar")).toBe(1300);
  });
  it("splits a total so the parts always add back to it", () => {
    for (const total of [1, 99, 100, 1001, 123457]) {
      const parts = allocate(total, [1, 1, 1]);
      expect(sumCents(parts)).toBe(total);
    }
    expect(allocate(100, [1, 1, 1])).toEqual([34, 33, 33]);
  });
  it("sums thousands of cents with no drift", () => {
    let total = 0;
    for (let i = 0; i < 10000; i++) total += parseCents("0.10");
    expect(total).toBe(100000);
    expect(centsToPlain(total)).toBe("1000.00");
    expect(centsToPlain(-5)).toBe("-0.05");
  });
});
