import { describe, expect, it } from "vitest";
import { classifyPage, pageAllowed, resolveEntitlements, SECTION_IDS } from "@routenorth/shared";
import { NAV } from "./nav";
import { ago } from "./admin";

describe("menu and plan sections", () => {
  const trackingOnly = resolveEntitlements({ sections: ["tracking"] });
  it("a company on every section sees the whole menu", () => {
    const all = resolveEntitlements({ sections: [...SECTION_IDS] });
    expect(NAV.every((n) => pageAllowed(all, n.href))).toBe(true);
  });
  it("a tracking-only company loses finance, dispatch and reports pages but keeps tracking", () => {
    expect(pageAllowed(trackingOnly, "/live")).toBe(true);
    expect(pageAllowed(trackingOnly, "/owner/connections")).toBe(true);
    for (const p of ["/billing", "/routes", "/owner/finance", "/analytics", "/owner", "/alerts", "/owner/pay-rates"]) expect(pageAllowed(trackingOnly, p), p).toBe(false);
  });
  it("core pages stay reachable whatever the plan", () => {
    const none = resolveEntitlements({ sections: [] });
    for (const p of ["/settings/security", "/settings/profile", "/support", "/owner/start", "/owner/settings"]) expect(pageAllowed(none, p), p).toBe(true);
  });
  it("every menu page is either core or belongs to a named section (nothing falls through by accident)", () => {
    const core = NAV.filter((n) => classifyPage(n.href) === "core").map((n) => n.href);
    // These are the always-on pages: the company's own settings, team, audit log and support. Anything new in the menu must be placed in a section on purpose.
    expect(core.sort()).toEqual(["/audit", "/owner/start", "/settings", "/settings/health", "/settings/security", "/settings/teams", "/settings/users", "/styleguide", "/support"]);
  });
});

describe("ago", () => {
  it("speaks plainly", () => {
    expect(ago(null)).toBe("never");
    expect(ago(new Date(Date.now() - 5 * 60_000).toISOString())).toBe("5 min ago");
    expect(ago(new Date(Date.now() - 3 * 86_400_000).toISOString())).toBe("3 d ago");
  });
});
