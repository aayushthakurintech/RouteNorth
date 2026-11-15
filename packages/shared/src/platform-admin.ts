/**
 * RouteNorth's own staff (platform admins). They are a separate kind of account from a client's users:
 * their own table, their own login rules (two-factor is always required), their own token, their own audit log.
 * A client's owner is never a platform admin, and a platform admin has no company.
 */
export const PLATFORM_PERMISSIONS = [
  "clients.view",       // list clients, see details and usage
  "clients.create",     // create a client company and its first owner invitation
  "clients.edit",       // name, plan, trial end, internal notes
  "clients.access",     // choose sections and limits
  "clients.suspend",    // suspend / reinstate
  "monitor.view",       // health and usage across clients
  "impersonate.view",   // "view as client", read-only
  "audit.view",         // platform audit log
  "admins.manage",      // create, change, disable staff accounts
] as const;
export type PlatformPermission = (typeof PLATFORM_PERMISSIONS)[number];

export const PLATFORM_ROLES = ["super_admin", "account_manager", "support", "auditor"] as const;
export type PlatformRole = (typeof PLATFORM_ROLES)[number];

/** Least privilege: nobody but a super admin can manage staff, and only super admins and support can look inside a client's account. */
export const PLATFORM_ROLE_PERMISSIONS: Record<PlatformRole, readonly PlatformPermission[]> = {
  super_admin: PLATFORM_PERMISSIONS,
  account_manager: ["clients.view", "clients.create", "clients.edit", "clients.access", "clients.suspend", "monitor.view", "audit.view"],
  support: ["clients.view", "monitor.view", "impersonate.view"],
  auditor: ["clients.view", "monitor.view", "audit.view"],
};

export const PLATFORM_ROLE_LABEL: Record<PlatformRole, string> = {
  super_admin: "Super admin", account_manager: "Account manager", support: "Support", auditor: "Auditor (read-only)",
};

export const isPlatformRole = (x: unknown): x is PlatformRole => typeof x === "string" && (PLATFORM_ROLES as readonly string[]).includes(x);
export const platformPermissions = (role: string): Set<PlatformPermission> => new Set(isPlatformRole(role) ? PLATFORM_ROLE_PERMISSIONS[role] : []);

/** Actions that need a recent second factor, even inside a signed-in session ("step-up"). */
export const STEP_UP_MINUTES = 10;
/** Admin sessions end after this long idle, and after this long in total. */
export const ADMIN_IDLE_MINUTES = 30;
export const ADMIN_MAX_HOURS = 8;
/** "View as client" sessions: short, read-only, and always with a written reason. */
export const IMPERSONATION_MINUTES = 30;
export const MIN_REASON_LENGTH = 10;

/** Permissions that are removed from a "view as client" session even for the person being viewed (bank and tax details of drivers). */
export const IMPERSONATION_HIDDEN_PERMS = ["drivers.sensitive", "api.manage", "billing.manage", "users.manage", "roles.manage", "payouts.approve", "finance.manage"] as const;

/** Paths a "view as client" session can never read, even with GET: credentials, privacy exports and bulk data exports. */
export const IMPERSONATION_BLOCKED_PATHS: readonly string[] = ["security", "portal/export", "platform/keys", "feeds", "invoices/export.csv"];

// ---------------------------------------------------------------------------------------------------------------- client health

export interface ClientHealthInput {
  status: "active" | "suspended";
  plan: string;
  trialEndsAt: string | Date | null;
  createdAt: string | Date;
  vehicles: number; devices: number; devicesLive: number; devicesRecent: number;
  lastLoginAt: string | Date | null;
  limits: { vehicles: number | null; users: number | null };
  users: number;
  now?: Date;
}
export interface ClientHealthFlag { code: string; level: "info" | "warn" | "bad"; text: string }
export type ClientHealthLevel = "ok" | "warn" | "bad" | "off";

const DAY = 86_400_000;

/** One honest summary of how a client is doing, with the reasons, from numbers the console already has. */
export function clientHealth(i: ClientHealthInput): { level: ClientHealthLevel; flags: ClientHealthFlag[] } {
  const now = (i.now ?? new Date()).getTime();
  const flags: ClientHealthFlag[] = [];
  if (i.status === "suspended") return { level: "off", flags: [{ code: "suspended", level: "info", text: "Suspended" }] };
  if (i.vehicles > 0 && i.devices === 0) flags.push({ code: "no_trackers", level: "warn", text: `${i.vehicles} vehicle${i.vehicles === 1 ? "" : "s"}, no tracker connected` });
  if (i.devices > 0 && i.devicesRecent === 0) flags.push({ code: "no_data", level: "bad", text: "No tracker has reported in 24 hours" });
  else if (i.devices > 0 && i.devicesRecent < i.devices) flags.push({ code: "silent_trackers", level: "warn", text: `${i.devices - i.devicesRecent} of ${i.devices} trackers silent for 24 hours` });
  const age = (now - new Date(i.createdAt).getTime()) / DAY;
  if (age > 3) {
    if (!i.lastLoginAt) flags.push({ code: "never_signed_in", level: "warn", text: "Nobody has ever signed in" });
    else if ((now - new Date(i.lastLoginAt).getTime()) / DAY > 14) flags.push({ code: "inactive", level: "warn", text: `No sign-in for ${Math.floor((now - new Date(i.lastLoginAt).getTime()) / DAY)} days` });
  }
  if (i.plan === "trial" && i.trialEndsAt) {
    const left = Math.ceil((new Date(i.trialEndsAt).getTime() - now) / DAY);
    if (left <= 0) flags.push({ code: "trial_ended", level: "bad", text: "Trial has ended" });
    else if (left <= 7) flags.push({ code: "trial_ending", level: "warn", text: `Trial ends in ${left} day${left === 1 ? "" : "s"}` });
  }
  if (i.limits.vehicles !== null && i.vehicles > i.limits.vehicles) flags.push({ code: "over_vehicle_limit", level: "warn", text: `${i.vehicles} vehicles, limit ${i.limits.vehicles}` });
  if (i.limits.users !== null && i.users > i.limits.users) flags.push({ code: "over_user_limit", level: "warn", text: `${i.users} users, limit ${i.limits.users}` });
  const level: ClientHealthLevel = flags.some((f) => f.level === "bad") ? "bad" : flags.some((f) => f.level === "warn") ? "warn" : "ok";
  return { level, flags };
}
