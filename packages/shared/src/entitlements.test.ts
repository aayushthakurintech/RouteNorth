import { describe, expect, it } from "vitest";
import { PAGE_RULES, SECTION_IDS, classifyPage, classifyRoute, homeForEntitlements, pageAllowed, resolveEntitlements, routeAllowed } from "./entitlements.js";
import { PLATFORM_ROLE_PERMISSIONS, platformPermissions } from "./platform-admin.js";

const only = (...s: string[]) => resolveEntitlements({ sections: s });

describe("entitlements", () => {
  it("a company with no row has everything", () => {
    const e = resolveEntitlements(null);
    expect(e.restricted).toBe(false);
    expect(e.sections).toEqual([...SECTION_IDS]);
    expect(routeAllowed(e, "/anything/at/all")).toBe(true);
  });

  it("a company with every section is not restricted", () => {
    expect(resolveEntitlements({ sections: [...SECTION_IDS] }).restricted).toBe(false);
  });

  it("ignores unknown section names and keeps the order of the catalog", () => {
    expect(resolveEntitlements({ sections: ["reports", "nonsense", "tracking"] }).sections).toEqual(["tracking", "reports"]);
  });

  it("reads limits and drops bad values", () => {
    expect(resolveEntitlements({ sections: ["tracking"], limits: { vehicles: 5, users: -1 } }).limits).toEqual({ vehicles: 5, users: null });
    expect(resolveEntitlements({ sections: ["tracking"], limits: { vehicles: "5" } }).limits).toEqual({ vehicles: null, users: null });
  });

  it("a tracking-only company can use tracking and the always-on core, and nothing else", () => {
    const e = only("tracking");
    for (const ok of ["/fleet", "/devices/abc", "/vehicles/1/track", "/portal/connections/overview", "/r/vehicles", "/r/geofences/1", "/me", "/users", "/org", "/security/2fa", "/billing/plan", "/audit", "/search?q=x"]) {
      expect(routeAllowed(e, ok), ok).toBe(true);
    }
    for (const no of ["/routes", "/jobs/1", "/portal/finance/summary", "/portal/payouts", "/billing/quotes", "/invoices", "/analytics/kpis", "/alerts", "/automation", "/platform/keys", "/ai/ask", "/portal/drivers", "/r/fuel-logs", "/r/rate-cards", "/driver/routes"]) {
      expect(routeAllowed(e, no), no).toBe(false);
    }
  });

  it("matches whole path segments, not prefixes of words", () => {
    const e = only("tracking");
    expect(classifyRoute("/portal/financex")).toBe(null);
    expect(classifyRoute("/portal/finance")).toBe("finance");
    expect(routeAllowed(e, "/routesx")).toBe(false);
    expect(classifyRoute("/billing/plan")).toBe("core");
    expect(classifyRoute("/billing/plans")).toBe("finance");
  });

  it("refuses routes nobody classified when the company is restricted (fail closed)", () => {
    expect(routeAllowed(only("tracking"), "/brand-new-controller")).toBe(false);
    expect(routeAllowed(resolveEntitlements(null), "/brand-new-controller")).toBe(true);
  });

  it("routes by section for the generic resources", () => {
    expect(classifyRoute("/r/vehicles")).toBe("tracking");
    expect(classifyRoute("/r/fuel-logs")).toBe("fleet_care");
    expect(classifyRoute("/r/rate-cards")).toBe("finance");
    expect(classifyRoute("/r/_schema")).toBe("core");
    expect(classifyRoute("/r/never-heard-of-it")).toBe(null);
  });

  it("pages follow the same sections", () => {
    const e = only("tracking");
    expect(pageAllowed(e, "/live")).toBe(true);
    expect(pageAllowed(e, "/owner/vehicles/abc")).toBe(true);
    expect(pageAllowed(e, "/owner")).toBe(false);
    expect(pageAllowed(e, "/owner/finance")).toBe(false);
    expect(pageAllowed(e, "/settings/users")).toBe(true);
    expect(classifyPage("/owner/settings/connect-gps")).toBe("tracking");
    expect(classifyPage("/owner/settings/anything")).toBe("core");
  });

  it("every page rule names a real section", () => {
    for (const [, where] of PAGE_RULES) expect(where === "core" || SECTION_IDS.includes(where as never)).toBe(true);
  });

  it("sends people to a page their company has", () => {
    expect(homeForEntitlements("/owner", only("tracking"))).toBe("/live");
    expect(homeForEntitlements("/owner", only("reports"))).toBe("/owner");
    expect(homeForEntitlements("/owner", only("finance"))).toBe("/owner/finance");
    expect(homeForEntitlements("/driver", only("tracking"))).toBe("/driver");
    expect(homeForEntitlements("/live", resolveEntitlements(null))).toBe("/live");
    expect(homeForEntitlements("/owner", only("assistant"))).toBe("/assistant");
  });
});

describe("platform staff roles", () => {
  it("only a super admin manages staff", () => {
    for (const [role, perms] of Object.entries(PLATFORM_ROLE_PERMISSIONS)) expect(perms.includes("admins.manage")).toBe(role === "super_admin");
  });
  it("only super admins and support can view as a client", () => {
    expect([...Object.entries(PLATFORM_ROLE_PERMISSIONS)].filter(([, p]) => p.includes("impersonate.view")).map(([r]) => r).sort()).toEqual(["super_admin", "support"]);
  });
  it("an auditor cannot change anything", () => {
    const p = platformPermissions("auditor");
    for (const w of ["clients.create", "clients.edit", "clients.access", "clients.suspend", "impersonate.view", "admins.manage"]) expect(p.has(w as never)).toBe(false);
  });
  it("an unknown role has no permissions", () => { expect(platformPermissions("root").size).toBe(0); });
});

import { clientHealth, type ClientHealthInput } from "./platform-admin.js";
const base: ClientHealthInput = { status: "active", plan: "pro", trialEndsAt: null, createdAt: "2026-01-01T00:00:00Z", vehicles: 4, devices: 4, devicesLive: 3, devicesRecent: 4, lastLoginAt: "2026-11-13T00:00:00Z", limits: { vehicles: null, users: null }, users: 2, now: new Date("2026-11-14T00:00:00Z") };
describe("client health", () => {
  it("is ok when trackers report and people sign in", () => { expect(clientHealth(base).level).toBe("ok"); });
  it("is bad when no tracker reported in a day", () => {
    const h = clientHealth({ ...base, devicesLive: 0, devicesRecent: 0 });
    expect(h.level).toBe("bad"); expect(h.flags[0]!.code).toBe("no_data");
  });
  it("warns about some silent trackers, and about vehicles without trackers", () => {
    expect(clientHealth({ ...base, devicesRecent: 3 }).flags.map((f) => f.code)).toEqual(["silent_trackers"]);
    expect(clientHealth({ ...base, devices: 0, devicesLive: 0, devicesRecent: 0 }).flags.map((f) => f.code)).toEqual(["no_trackers"]);
  });
  it("warns when nobody has signed in for two weeks, but not for a brand new client", () => {
    expect(clientHealth({ ...base, lastLoginAt: "2026-10-01T00:00:00Z" }).flags.map((f) => f.code)).toEqual(["inactive"]);
    expect(clientHealth({ ...base, lastLoginAt: null, createdAt: "2026-11-13T00:00:00Z" }).level).toBe("ok");
    expect(clientHealth({ ...base, lastLoginAt: null }).flags.map((f) => f.code)).toEqual(["never_signed_in"]);
  });
  it("tracks trials and limits", () => {
    expect(clientHealth({ ...base, plan: "trial", trialEndsAt: "2026-11-10T00:00:00Z" }).flags.map((f) => f.code)).toEqual(["trial_ended"]);
    expect(clientHealth({ ...base, plan: "trial", trialEndsAt: "2026-11-18T00:00:00Z" }).flags.map((f) => f.code)).toEqual(["trial_ending"]);
    expect(clientHealth({ ...base, limits: { vehicles: 3, users: 1 } }).flags.map((f) => f.code)).toEqual(["over_vehicle_limit", "over_user_limit"]);
  });
  it("a suspended client is off, whatever else is true", () => { expect(clientHealth({ ...base, status: "suspended", devicesRecent: 0 }).level).toBe("off"); });
});

describe("fleet routes are split by what they are for", () => {
  it("keeps maintenance, fuel and depots in fleet care, drivers in drivers and the trip log in tracking", () => {
    expect(classifyRoute("/fleet/maintenance")).toBe("fleet_care");
    expect(classifyRoute("/fleet/fuel/summary")).toBe("fleet_care");
    expect(classifyRoute("/fleet/drivers/photo")).toBe("drivers");
    expect(classifyRoute("/fleet/trip-log")).toBe("tracking");
    expect(classifyRoute("/fleet/fleet")).toBe("tracking");
  });
});
