/**
 * What each client company (organization) may use.
 *
 * Two different questions are answered by two different systems and they must not be mixed up:
 *  - permissions (permissions.ts): what a PERSON may do inside their company (owner, dispatcher, custom roles).
 *  - entitlements (this file): what the COMPANY has been given by RouteNorth staff (which sections of the product exist for it).
 * A request is allowed only when BOTH say yes. Entitlements never grant a permission; they only take whole sections away.
 *
 * The API enforces this in AuthGuard for every signed-in route, by route path (classifyRoute), so a client who
 * is not entitled to a section gets 403 from the server even when they type the URL or call the API by hand.
 * The web app uses the same table to hide menu entries and show a "not included" page.
 */

export const SECTIONS = [
  { id: "tracking", label: "Live tracking and vehicles", blurb: "Live map, trackers and connections, vehicles, trips and history, geofences, shared tracking links." },
  { id: "fleet_care", label: "Fleet care", blurb: "Maintenance, documents, fuel logs, inspections, incidents, equipment and depots." },
  { id: "dispatch", label: "Routes and dispatch", blurb: "Routes, stops, jobs, the dispatch board, route planning and optimization, tasks and schedules." },
  { id: "drivers", label: "Drivers and safety", blurb: "Driver profiles and app, timesheets, expenses, safety scores, driver messages and approvals." },
  { id: "finance", label: "Finance and pay", blurb: "Driver pay, payouts, invoices, quotes, rate cards, budgets, contracts, profit." },
  { id: "reports", label: "Reports and analytics", blurb: "Owner dashboard, report catalog and builder, goals, scheduled reports, data export." },
  { id: "alerts", label: "Alerts and automation", blurb: "Alert rules, notifications to Slack/Teams/email, workflows and webhooks." },
  { id: "customers", label: "Customer portal", blurb: "Customer-facing orders, tracking pages, message templates, feedback." },
  { id: "integrations", label: "API and integrations", blurb: "API keys, data feeds, inbound email, custom fields and statuses." },
  { id: "assistant", label: "AI assistant", blurb: "Briefings, questions and forecasts." },
] as const;

export type SectionId = (typeof SECTIONS)[number]["id"];
export const SECTION_IDS: readonly SectionId[] = SECTIONS.map((s) => s.id);
export const isSectionId = (x: unknown): x is SectionId => typeof x === "string" && (SECTION_IDS as readonly string[]).includes(x);

/**
 * Always on for every client, whatever sections they were given. These are the "basic default permissions":
 * signing in and out, your own profile and security, your company's settings, your own team, support, notifications.
 * Staff cannot switch them off (the console does not offer it and the API ignores it).
 */
export const CORE_FEATURES = [
  "Sign in, profile, password and two-factor", "Company settings and branding", "Users, roles and invitations", "The company's own audit log",
  "Notifications, search (within the sections the company has) and support", "Seeing which plan and sections the company has",
] as const;

/** Ready-made bundles for the console. They only fill in the checkboxes; nothing in the API looks at a bundle's name. */
export const PRESETS: { id: string; label: string; sections: readonly SectionId[] }[] = [
  { id: "tracking_only", label: "Tracking only", sections: ["tracking"] },
  { id: "tracking_reports", label: "Tracking and reports", sections: ["tracking", "reports", "alerts"] },
  { id: "operations", label: "Operations", sections: ["tracking", "fleet_care", "dispatch", "drivers", "alerts", "reports"] },
  { id: "full", label: "Everything", sections: SECTION_IDS },
];

/** Limits staff can set per client. null means "no limit set by staff" (the plan's own soft limits still show warnings). */
export interface HardLimits { vehicles: number | null; users: number | null }
export const NO_LIMITS: HardLimits = { vehicles: null, users: null };

export interface Entitlements {
  /** True when staff chose a list of sections. False means the company has everything (the default for all companies that existed before this feature). */
  restricted: boolean;
  sections: SectionId[];
  limits: HardLimits;
}

export function resolveEntitlements(row: { sections?: readonly string[] | null; limits?: unknown } | null | undefined): Entitlements {
  if (!row || !row.sections) return { restricted: false, sections: [...SECTION_IDS], limits: { ...NO_LIMITS } };
  const sections = SECTION_IDS.filter((s) => row.sections!.includes(s));
  const l = row.limits && typeof row.limits === "object" ? (row.limits as Record<string, unknown>) : {};
  const lim = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
  return { restricted: sections.length < SECTION_IDS.length, sections, limits: { vehicles: lim(l.vehicles), users: lim(l.users) } };
}

export function hasSection(e: Pick<Entitlements, "sections">, s: SectionId): boolean {
  return e.sections.includes(s);
}

// ---------------------------------------------------------------------------------------------------------------- API routes

type Where = SectionId | "core";

/**
 * The first matching row wins, so list specific paths before general ones. Paths are matched segment by segment
 * from the start ("portal/finance" matches /portal/finance and /portal/finance/x, not /portal/financex).
 * A signed-in route that matches no row is treated as NOT allowed for a restricted company (fail closed), and a
 * test fails when a controller is added without a row here.
 */
export const API_ROUTE_RULES: readonly (readonly [string, Where])[] = [
  // core
  ["auth", "core"], ["me", "core"], ["org", "core"], ["users", "core"], ["roles", "core"], ["teams", "core"], ["invites", "core"],
  ["security", "core"], ["support", "core"], ["notifications", "core"], ["search", "core"], ["audit", "core"], ["ops", "core"], ["comments", "core"],
  ["billing/plan", "core"], ["portal/roles-matrix", "core"], ["r/_schema", "core"], ["public", "core"], ["share", "tracking"],
  // tracking
  ["fleet/depots", "fleet_care"], ["fleet/fuel", "fleet_care"], ["fleet/maintenance", "fleet_care"], ["fleet/reminders", "fleet_care"], ["fleet/inspection-template", "fleet_care"], ["fleet/drivers", "drivers"],
  ["fleet", "tracking"], ["heat", "tracking"], ["weather/route", "dispatch"], ["weather", "tracking"], ["devices", "tracking"], ["telematics", "tracking"], ["vehicles", "tracking"],
  ["portal/vehicles", "tracking"], ["portal/connections", "tracking"], ["portal/data-sources", "tracking"], ["portal/gps-connect", "tracking"], ["portal/provider-connections", "tracking"],
  ["portal/trips", "tracking"], ["portal/assignments", "tracking"], ["reports/daily", "reports"], ["reports/idle", "reports"],
  ["r/vehicles", "tracking"], ["r/geofences", "tracking"],
  // fleet care
  ["portal/shops", "fleet_care"], ["r/depots", "fleet_care"], ["r/equipment", "fleet_care"], ["r/documents", "fleet_care"], ["r/maintenance-plans", "fleet_care"],
  ["r/maintenance-logs", "fleet_care"], ["r/fuel-logs", "fleet_care"], ["r/inspections", "fleet_care"], ["r/incidents", "fleet_care"], ["r/work-orders", "fleet_care"], ["r/shops", "fleet_care"],
  // dispatch
  ["routes", "dispatch"], ["route-templates", "dispatch"], ["dispatch", "dispatch"], ["jobs", "dispatch"], ["plan", "dispatch"], ["geocode", "dispatch"], ["attachments", "dispatch"],
  ["stops", "dispatch"], ["proofs", "dispatch"], ["tasks", "dispatch"], ["schedule", "dispatch"], ["time-off", "dispatch"], ["optimize", "dispatch"],
  ["r/jobs", "dispatch"], ["r/shift-plans", "dispatch"], ["r/route-templates", "dispatch"],
  // drivers
  ["portal/drivers", "drivers"], ["driver", "drivers"], ["safety", "drivers"], ["timesheets", "drivers"], ["expenses", "drivers"], ["help-requests", "drivers"], ["messages", "drivers"],
  ["approvals", "drivers"], ["r/training-items", "drivers"],
  // finance
  ["portal/finance", "finance"], ["portal/pay", "finance"], ["portal/payouts", "finance"], ["portal/me", "finance"], ["portal/invoices", "finance"], ["invoices", "finance"], ["billing", "finance"],
  ["platform/export", "finance"], ["r/rate-cards", "finance"], ["r/budgets", "finance"], ["r/contracts", "finance"],
  // reports
  ["analytics", "reports"], ["reports", "reports"], ["portal/dashboard", "reports"], ["portal/reports", "reports"], ["portal/export", "reports"],
  ["r/dashboards", "reports"], ["r/goals", "reports"], ["r/report-schedules", "reports"], ["r/report-defs", "reports"],
  // alerts
  ["alerts", "alerts"], ["automation", "alerts"], ["webhooks", "alerts"], ["portal/alerts", "alerts"], ["r/alert-rules", "alerts"], ["r/notification-endpoints", "alerts"], ["r/workflows", "alerts"],
  // customers
  ["portal/orders", "customers"], ["portal/support", "customers"], ["message-defaults", "customers"],
  ["r/feedback", "customers"], ["r/status-notices", "customers"], ["r/faq-items", "customers"], ["r/message-templates", "customers"],
  // integrations
  ["platform", "integrations"], ["feeds", "integrations"], ["inbound", "integrations"],
  // assistant
  ["ai", "assistant"],
];

/** Which section a request path belongs to, "core" when it is always allowed, or null when no rule covers it. */
export function classifyRoute(rawPath: string): Where | null {
  const segs = rawPath.split("?")[0]!.split("/").filter(Boolean).map((s) => s.toLowerCase());
  for (const [prefix, where] of API_ROUTE_RULES) {
    const p = prefix.split("/");
    if (p.length <= segs.length && p.every((x, i) => segs[i] === x)) return where;
  }
  return null;
}

/** True when a company with these entitlements may call this path. Unclassified paths are refused for restricted companies. */
export function routeAllowed(e: Entitlements, rawPath: string): boolean {
  if (!e.restricted) return true;
  const where = classifyRoute(rawPath);
  if (where === "core") return true;
  if (where === null) return false;
  return hasSection(e, where);
}

// ---------------------------------------------------------------------------------------------------------------- web pages

/** The same idea for pages in the web app. Pages not listed here are core (settings, profile, support). */
export const PAGE_RULES: readonly (readonly [string, Where])[] = [
  ["/owner/connections", "tracking"], ["/owner/vehicles", "tracking"], ["/owner/trips", "tracking"], ["/owner/settings/connect-gps", "tracking"],
  ["/owner/drivers", "drivers"], ["/owner/pay-rates", "finance"], ["/owner/finance", "finance"], ["/owner/reports", "reports"], ["/owner/alerts", "alerts"],
  ["/owner/start", "core"], ["/owner/settings", "core"], ["/owner", "reports"],
  ["/live", "tracking"], ["/devices", "tracking"], ["/geofences", "tracking"], ["/history", "tracking"], ["/trips", "tracking"],
  ["/care", "fleet_care"], ["/fuel", "fleet_care"], ["/fleet", "fleet_care"],
  ["/routes", "dispatch"], ["/dispatch", "dispatch"], ["/jobs", "dispatch"], ["/optimize", "dispatch"], ["/tasks", "dispatch"], ["/schedule", "dispatch"], ["/import", "dispatch"],
  ["/inbox", "drivers"], ["/approvals", "drivers"], ["/safety", "drivers"], ["/timesheets", "drivers"], ["/expenses", "drivers"], ["/driver", "drivers"],
  ["/billing", "finance"], ["/invoices", "finance"],
  ["/analytics", "reports"], ["/reports", "reports"],
  ["/alerts", "alerts"], ["/automation", "alerts"],
  ["/integrations", "integrations"], ["/settings/fields", "integrations"], ["/settings/customers", "customers"], ["/portal", "customers"],
  ["/assistant", "assistant"],
];

export function classifyPage(pathname: string): Where {
  const segs = pathname.split("?")[0]!.split("/").filter(Boolean);
  for (const [prefix, where] of PAGE_RULES) {
    const p = prefix.split("/").filter(Boolean);
    if (p.length <= segs.length && p.every((x, i) => segs[i] === x)) return where;
  }
  return "core";
}

export function pageAllowed(e: Pick<Entitlements, "restricted" | "sections">, pathname: string): boolean {
  if (!e.restricted) return true;
  const where = classifyPage(pathname);
  return where === "core" || hasSection(e, where);
}

/** Where to land after signing in: the person's usual home when their company has that section, otherwise the first page they can use. */
export function homeForEntitlements(home: string, e: Pick<Entitlements, "restricted" | "sections">): string {
  if (home === "/driver" || home === "/portal") return home;
  if (pageAllowed(e, home)) return home;
  for (const candidate of ["/live", "/owner/connections", "/routes", "/owner/drivers", "/owner/finance", "/analytics", "/alerts", "/fleet/inspections", "/settings/customers", "/integrations", "/assistant"]) {
    if (pageAllowed(e, candidate)) return candidate;
  }
  return "/settings/security";
}
