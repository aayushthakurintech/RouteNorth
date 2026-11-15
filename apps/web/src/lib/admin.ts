import type { SectionId } from "@routenorth/shared";

export interface AdminMe {
  id: string; email: string; displayName: string | null; role: string; roleLabel: string; perms: string[]; mustChangePassword: boolean; steppedUp: boolean;
}
export type Level = "ok" | "warn" | "bad" | "off";
export interface HealthFlag { code: string; level: "info" | "warn" | "bad"; text: string }
export interface ClientRow {
  id: string; name: string; slug: string; plan: string; status: "active" | "suspended"; createdAt: string; trialEndsAt: string | null; locale: string; timezone: string;
  suspendedAt: string | null; suspendedReason: string | null; ownerEmail: string | null; ownerName: string | null;
  entitlements: { restricted: boolean; sections: SectionId[]; limits: { vehicles: number | null; users: number | null } };
  usage: { vehicles: number; devices: number; devicesLive: number; devicesRecent: number; users: number; drivers: number; jobsMonth: number; lastPositionAt: string | null; lastLoginAt: string | null };
  health: { level: Level; flags: HealthFlag[] };
}
export interface ClientDetail extends ClientRow {
  internalNotes: string | null; staffAccessAllowed: boolean;
  users: { id: string; email: string; displayName: string | null; role: string; disabled: boolean; createdAt: string; lastSignIn: string | null; twoFactor: boolean }[];
  trackerMethods: { method: string; n: number }[];
  staffActions: { id: number; at: string; adminEmail: string | null; action: string; reason: string | null; target: string | null }[];
  staffViews: { id: string; startedAt: string; expiresAt: string; endedAt: string | null; reason: string; requests: number; blockedWrites: number; adminEmail: string }[];
}
export interface Overview {
  clients: { total: number; active: number; suspended: number; restricted: number; trials: number };
  fleet: { vehicles: number; devices: number; reportingNow: number; reporting24h: number; users: number };
  health: { ok: number; warn: number; bad: number };
  attention: ClientRow[]; activeStaffViews: number;
}
export interface Catalog {
  sections: { id: SectionId; label: string; blurb: string }[];
  core: string[];
  presets: { id: string; label: string; sections: SectionId[] }[];
  plans: { id: string; vehicles: number | null; users: number | null; baseCad: number; perVehicleCad: number }[];
  roles: { id: string; label: string; perms: string[] }[];
  impersonationMinutes: number;
}
export interface AuditRow { id: string; at: string; adminEmail: string | null; action: string; orgId: string | null; orgName: string | null; target: string | null; reason: string | null; detail: unknown; status: number | null; ip: string | null }
export interface StaffRow { id: string; email: string; displayName: string | null; role: string; ipAllowList: string[]; disabled: boolean; locked: boolean; lastLoginAt: string | null; mustChangePassword: boolean; createdAt: string; activeSessions: number }
export interface SetupPackage { temporaryPassword: string; totpSecret: string; otpauth: string; recoveryCodes: string[] }

export const LEVEL_LABEL: Record<Level, string> = { ok: "Healthy", warn: "Needs a look", bad: "Needs attention", off: "Suspended" };
export const LEVEL_COLOR: Record<Level, string> = { ok: "var(--ok)", warn: "var(--warn)", bad: "var(--danger)", off: "var(--muted)" };

export const ACTION_LABEL: Record<string, string> = {
  login: "Signed in", "login.failed": "Failed sign-in", "login.locked": "Sign-in while locked", "login.blocked_ip": "Sign-in from a blocked network", "login.disabled": "Sign-in to a disabled account", "mfa.failed": "Wrong authenticator code",
  logout: "Signed out", stepup: "Confirmed with a code", "stepup.failed": "Wrong code at confirmation", "password.changed": "Changed password",
  "client.viewed": "Opened a client's details", "client.created": "Created a client", "client.updated": "Edited a client", "client.access.changed": "Changed what a client can use",
  "client.suspended": "Suspended a client", "client.reinstated": "Reinstated a client", "view_as.started": "Started viewing as a client", "impersonation.ended": "Ended a view as a client",
  "view_as.refused_by_client": "View refused (client turned it off)", "device.lookup": "Looked up a tracker ID",
  "admin.created": "Created a staff account", "admin.updated": "Changed a staff account", "admin.credentials_reset": "Reset a staff member's credentials", "admin.unlocked": "Unlocked a staff account", "admin.created_by_cli": "Staff account created on the server",
};

export function ago(iso: string | null | undefined): string {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h ago`;
  return `${Math.floor(s / 86_400)} d ago`;
}
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString("en-CA", { dateStyle: "medium", timeStyle: "short" }) : "–");
