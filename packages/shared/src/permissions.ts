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
] as const;
export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = ["owner", "admin", "dispatcher", "manager", "driver", "customer", "viewer"] as const;
export type Role = (typeof ROLES)[number];

/** `viewer` is the read-only role. */
const READ: Permission[] = ["fleet.view", "routes.view", "reports.view", "alerts.view", "customers.view"];

export const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
  owner: PERMISSIONS,
  admin: PERMISSIONS.filter((p) => p !== "billing.manage"),
  dispatcher: [...READ, "fleet.manage", "routes.write", "routes.dispatch", "reports.export", "customers.manage", "users.view"],
  manager: [...READ, "reports.export", "reports.manage", "alerts.manage", "users.view", "audit.view", "routes.write", "routes.dispatch", "fleet.manage", "customers.manage"],
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
