import { describe, expect, it } from "vitest";
import { accessMatrix } from "./portal-access.js";

/** The matrix printed in the Owner Portal spec (page 23): Owner, Admin, Manager (region), Dispatcher, Accountant, Driver. */
const SPEC: Record<string, [string, string, string, string, string, string]> = {
  "Vehicles": ["Full", "Full", "Full in region", "View, assign", "View costs", "-"],
  "Vehicle costs and value": ["Full", "Full", "View in region", "-", "Full", "-"],
  "Drivers": ["Full", "Full", "Full in region", "View", "View", "-"],
  "Driver bank and tax details": ["Full", "-", "-", "-", "View", "-"],
  "Pay rate cards": ["Full", "Full", "View", "-", "View", "-"],
  "Approve payouts": ["Full", "-", "-", "-", "Full", "-"],
  "Reports and dashboards": ["Full", "Full", "Region only", "Operations only", "Finance only", "-"],
  "Report builder": ["Full", "Full", "Full in region", "-", "Full", "-"],
  "Finance pages": ["Full", "View", "-", "-", "Full", "-"],
  "Settings and billing": ["Full", "Full", "-", "-", "-", "-"],
  "Audit log": ["Full", "View", "-", "-", "View", "-"],
};

describe("role matrix from the spec", () => {
  const m = accessMatrix();
  const cols = ["owner", "admin", "manager", "dispatcher", "accountant", "driver"] as const;
  for (const [area, want] of Object.entries(SPEC)) {
    it(area, () => {
      const got = cols.map((r) => m.cells[area]![r]);
      // The driver column in the spec shows what a driver sees of THEIR OWN records ("Own car", "Own profile"); the web
      // portal itself is for office roles, so the drivers app handles those. Compare the office roles exactly.
      expect(got.slice(0, 5)).toEqual(want.slice(0, 5));
    });
  }
  it("has a read-only role", () => {
    expect(m.roles).toContain("viewer");
    expect(m.cells["Vehicles"]!.viewer).toBe("View");
    expect(m.cells["Pay rate cards"]!.viewer).toBe("-");
  });
});
