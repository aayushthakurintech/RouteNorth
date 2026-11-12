import { describe, expect, it } from "vitest";
import { addDays, comparisonRange, fmtMetric, presetRange, query, TEMPLATES } from "./analytics";

describe("analytics helpers", () => {
  it("builds date presets", () => {
    expect(presetRange("last7", "2026-03-10")).toEqual({ from: "2026-03-04", to: "2026-03-10" });
    expect(presetRange("thisMonth", "2026-03-10")).toEqual({ from: "2026-03-01", to: "2026-03-10" });
    expect(presetRange("yesterday", "2026-03-01")).toEqual({ from: "2026-02-28", to: "2026-02-28" });
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
  it("compares with the period before or a year earlier", () => {
    const f = { from: "2026-03-04", to: "2026-03-10" };
    expect(comparisonRange(f, "prev")).toEqual({ from: "2026-02-25", to: "2026-03-03" });
    expect(comparisonRange(f, "year")).toEqual({ from: "2025-03-04", to: "2025-03-10" });
    expect(comparisonRange(f, "none")).toBeNull();
  });
  it("writes filters into a query", () => {
    expect(query({ from: "a", to: "b", driverId: "d1" }, { by: "route" })).toBe("from=a&to=b&by=route&driverId=d1");
    expect(query({ from: "a", to: "b", refresh: 3 })).toContain("_r=3");
  });
  it("prints numbers with units in both languages", () => {
    expect(fmtMetric(93.44, "%", "en")).toBe("93.4%");
    expect(fmtMetric(null, "%", "en")).toBe("—");
    expect(fmtMetric(12, "min", "fr")).toBe("12 min");
    expect(fmtMetric(1204, "$", "en", "CAD")).toContain("1,204");
  });
  it("has a template for every role with widgets", () => {
    for (const [, tpl] of Object.entries(TEMPLATES)) {
      const w = tpl.widgets();
      expect(w.length).toBeGreaterThan(0);
      expect(new Set(w.map((x) => x.id)).size).toBe(w.length);
    }
  });
});
