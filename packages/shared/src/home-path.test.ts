import { describe, expect, it } from "vitest";
import { effectivePermissions, homePath } from "./permissions.js";

describe("where each role lands after signing in", () => {
  const home = (role: string) => homePath(role, effectivePermissions(role));
  it("sends the people who run the business to the dashboard", () => {
    for (const r of ["owner", "admin", "accountant", "manager"]) expect(home(r)).toBe("/owner");
  });
  it("sends dispatchers to the board and drivers and customers to their own apps", () => {
    expect(home("dispatcher")).toBe("/dispatch");
    expect(home("driver")).toBe("/driver");
    expect(home("customer")).toBe("/portal");
  });
  it("keeps the live map for read-only people and unknown roles", () => {
    expect(home("viewer")).toBe("/live");
    expect(home("somebody-else")).toBe("/live");
  });
  it("lands a person with custom permissions where those permissions allow", () => {
    expect(homePath("owner", effectivePermissions("owner", ["fleet.view"]))).toBe("/live");
  });
});
