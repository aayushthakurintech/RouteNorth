import { ROLES, ROLE_PERMISSIONS, type Permission, type Role } from "./permissions.js";

/** The role matrix from the Owner Portal spec, worked out from the real permission lists so it can never drift from what the API enforces. */
export const ACCESS_AREAS = [
  "Vehicles", "Vehicle costs and value", "Drivers", "Driver bank and tax details", "Pay rate cards", "Approve payouts",
  "Reports and dashboards", "Report builder", "Finance pages", "Settings and billing", "Audit log",
] as const;
export type AccessArea = (typeof ACCESS_AREAS)[number];

export function accessFor(role: Role | string, area: AccessArea, perms: ReadonlySet<Permission>): string {
  const has = (p: Permission) => perms.has(p);
  const region = role === "manager" ? " in region" : "";
  switch (area) {
    case "Vehicles":
      if (has("vehicles.manage")) return `Full${region}`;
      if (has("vehicles.assign")) return "View, assign";
      if (has("fleet.view") && has("vehicles.costs")) return "View costs";
      if (has("fleet.view")) return "View";
      return role === "driver" ? "Own car" : "-";
    case "Vehicle costs and value":
      if (!has("vehicles.costs")) return "-";
      return has("vehicles.manage") && !region ? "Full" : role === "accountant" ? "Full" : `View${region}`;
    case "Drivers":
      if (has("drivers.manage")) return `Full${region}`;
      if (has("drivers.view")) return "View";
      return role === "driver" ? "Own profile" : "-";
    case "Driver bank and tax details":
      if (has("drivers.sensitive")) return role === "accountant" ? "View" : "Full";
      return role === "driver" ? "Own" : "-";
    case "Pay rate cards":
      if (has("pay.manage")) return "Full";
      if (has("pay.view")) return role === "accountant" ? "View" : "View";
      return role === "driver" ? "Own rate" : "-";
    case "Approve payouts": return has("payouts.approve") ? "Full" : "-";
    case "Reports and dashboards":
      if (role === "owner" || role === "admin") return "Full";
      if (role === "manager") return "Region only";
      if (role === "dispatcher") return "Operations only";
      if (role === "accountant") return "Finance only";
      if (has("reports.view")) return "View";
      return role === "driver" ? "Own stats" : "-";
    case "Report builder":
      if (!has("reports.builder")) return "-";
      return `Full${region}`;
    case "Finance pages":
      if (has("finance.manage")) return "Full";
      return has("finance.view") ? "View" : "-";
    case "Settings and billing": return has("settings.manage") ? "Full" : "-";
    case "Audit log":
      if (!has("audit.view")) return "-";
      return role === "owner" ? "Full" : "View";
  }
}

export function accessMatrix(): { roles: Role[]; areas: readonly AccessArea[]; cells: Record<string, Record<string, string>> } {
  const roles = ROLES.filter((r) => r !== "customer") as Role[];
  const cells: Record<string, Record<string, string>> = {};
  for (const a of ACCESS_AREAS) {
    cells[a] = {};
    for (const r of roles) cells[a]![r] = accessFor(r, a, new Set(ROLE_PERMISSIONS[r]));
  }
  return { roles, areas: ACCESS_AREAS, cells };
}
