import { ForbiddenException } from "@nestjs/common";
import type { Permission } from "@routenorth/shared";
import type { AuthedRequest } from "../auth/auth.guard.js";

/** Permissions only an owner may hand out, so an admin cannot give anyone (themselves included) what the admin role is denied. */
export const OWNER_ONLY: readonly Permission[] = ["billing.manage", "drivers.sensitive", "payouts.approve", "finance.manage"];

/**
 * Throws 403 unless the caller may create, change or assign a role holding `permissions`.
 * An owner may grant anything. Anyone else may only grant what they hold themselves, and never an owner-only permission.
 */
export function assertCanGrant(req: AuthedRequest, permissions: readonly string[]): void {
  if (req.session?.role === "owner") return;
  const held = req.perms;
  const over = permissions.filter((p) => OWNER_ONLY.includes(p as Permission) || !held?.has(p as Permission));
  if (over.length) throw new ForbiddenException(`you cannot grant permissions you do not hold: ${[...new Set(over)].join(", ")}`);
}
