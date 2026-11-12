/**
 * Roles and permissions. The API checks permissions, never role names, so a custom role
 * (an organization's own list of permissions) works everywhere a built-in role does.
 */
export const PERMISSIONS = [
  "fleet.view", "fleet.manage",
  "routes.view", "routes.write", "routes.dispatch",
  "reports.view", "reports.export", "reports.manage",
  "alerts.view", "alerts.manage",
  "users.view", "users.manage", "roles.manage",
  "audit.view",
  "settings.manage", "billing.manage", "api.manage", "integrations.manage",
  "customers.view", "customers.manage",
  "driver.app", "customer.portal",
  // Owner Portal (docs/owner-portal/SPEC_STATUS.md). Finer than the older fleet.* / reports.* permissions on purpose,
  // so the role matrix in the spec (owner, admin, manager, dispatcher, accountant, driver, read-only) can be followed.
  "vehicles.manage", "vehicles.assign", "vehicles.costs",
  "drivers.view", "drivers.manage", "drivers.sensitive",
  "pay.view", "pay.manage", "payouts.approve",
  "finance.view", "finance.manage",
  "reports.builder",
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["owner", "admin", "dispatcher", "manager", "accountant", "driver", "customer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** `viewer` is the read-only role. */
const READ: Permission[] = ["fleet.view", "routes.view", "reports.view", "alerts.view", "customers.view"];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  // Admin: everything except billing, driver bank and tax details, approving payouts and editing finance pages (spec role matrix: finance is View).
  admin: PERMISSIONS.filter((p) => !["billing.manage", "drivers.sensitive", "payouts.approve", "finance.manage"].includes(p)),
  dispatcher: [...READ, "fleet.manage", "routes.write", "routes.dispatch", "reports.export", "customers.manage", "users.view", "vehicles.assign", "drivers.view"],
  // Manager: full in their region (the API limits what they see to their teams), cost view, no finance pages.
  manager: [...READ, "reports.export", "reports.manage", "alerts.manage", "users.view", "routes.write", "routes.dispatch", "fleet.manage", "customers.manage",
    "vehicles.manage", "vehicles.assign", "vehicles.costs", "drivers.view", "drivers.manage", "pay.view", "reports.builder"],
  // Accountant: money, payouts, finance pages and reports on them; read-only on people and vehicles.
  accountant: ["fleet.view", "reports.view", "reports.export", "reports.builder", "audit.view", "users.view", "customers.view", "alerts.view",
    "vehicles.costs", "drivers.view", "drivers.sensitive", "pay.view", "payouts.approve", "finance.view", "finance.manage"],
  driver: ["driver.app"],
  customer: ["customer.portal"],
  viewer: READ,
};

export function isRole(x: unknown): x is Role {
  return typeof x === "string" && (ROLES as readonly string[]).includes(x);
}
export function isPermission(x: unknown): x is Permission {
  return typeof x === "string" && (PERMISSIONS as readonly string[]).includes(x);
}

/** The permissions a user has: their custom role's list when they have one, otherwise their built-in role's. */
export function effectivePermissions(role: string, custom?: readonly string[] | null): Set<Permission> {
  if (custom) return new Set(custom.filter(isPermission));
  return new Set(isRole(role) ? ROLE_PERMISSIONS[role] : []);
}

/** Where a person lands after signing in. */
export function homePath(role: string, perms: ReadonlySet<Permission>): string {
  if (perms.has("driver.app") && perms.size === 1) return "/driver";
  if (perms.has("customer.portal") && perms.size === 1) return "/portal";
  return "/";
}
