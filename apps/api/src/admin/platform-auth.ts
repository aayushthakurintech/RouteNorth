import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { pg, withPlatform } from "@routenorth/db";
import { ADMIN_IDLE_MINUTES, ADMIN_MAX_HOURS, STEP_UP_MINUTES, platformPermissions, type PlatformPermission } from "@routenorth/shared";
import { createHash } from "node:crypto";
import { jwtVerify, SignJWT } from "jose";
import { ipAllowed } from "../auth/ip.js";
import { JWT_SECRET, PG_POOL } from "../tokens.js";

/**
 * Staff tokens are a different kind of token from client tokens: another audience, another signing key (derived from
 * the server secret), and no organization. A client token is rejected here and a staff token is rejected by the client
 * guard, because that guard needs an `org` claim and a user in that organization.
 */
const AUD = "routenorth-platform";
const AUD_MFA = "routenorth-platform-mfa";
const key = (secret: string) => new TextEncoder().encode(createHash("sha256").update(`${secret}:platform-admin`).digest("hex"));

export async function signPlatformToken(secret: string, adminId: string, sid: string, role: string): Promise<string> {
  return new SignJWT({ role, sid }).setProtectedHeader({ alg: "HS256" }).setSubject(adminId).setAudience(AUD).setIssuedAt().setExpirationTime(`${ADMIN_MAX_HOURS}h`).sign(key(secret));
}
export async function verifyPlatformToken(secret: string, token: string): Promise<{ adminId: string; sid: string } | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"], audience: AUD });
    if (!payload.sub || typeof payload.sid !== "string") return null;
    return { adminId: payload.sub, sid: payload.sid };
  } catch { return null; }
}
export async function signPlatformChallenge(secret: string, adminId: string): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: "HS256" }).setSubject(adminId).setAudience(AUD_MFA).setIssuedAt().setExpirationTime("5m").sign(key(secret));
}
export async function verifyPlatformChallenge(secret: string, token: string): Promise<string | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { algorithms: ["HS256"], audience: AUD_MFA });
    return payload.sub ?? null;
  } catch { return null; }
}

export interface AdminRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  method?: string;
  originalUrl?: string;
  url?: string;
  body?: unknown;
  admin?: { id: string; email: string; displayName: string | null; role: string; perms: ReadonlySet<PlatformPermission>; sid: string; steppedUpAt: Date | null; mustChangePassword: boolean };
}

/** Platform-wide network limit for staff, a comma-separated list of addresses or IPv4 ranges. Empty means any network. */
export function platformIpAllowList(): string[] {
  return (process.env.PLATFORM_ADMIN_IP_ALLOWLIST ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
export function adminNetworkAllowed(ip: string | undefined, personal: readonly string[]): boolean {
  const global = platformIpAllowList();
  if (global.length && !ipAllowed(ip ?? "", global)) return false;
  if (personal.length && !ipAllowed(ip ?? "", [...personal])) return false;
  return true;
}

@Injectable()
export class PlatformGuard implements CanActivate {
  constructor(@Inject(JWT_SECRET) private readonly secret: string, @Inject(PG_POOL) private readonly pool: pg.Pool) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AdminRequest>();
    const h = req.headers.authorization;
    const token = typeof h === "string" && h.startsWith("Bearer ") ? h.slice(7) : null;
    const tok = token ? await verifyPlatformToken(this.secret, token) : null;
    if (!tok) throw new UnauthorizedException();
    const row = (await withPlatform(this.pool, (c) => c.query<{
      id: string; email: string; display_name: string | null; role: string; disabled: boolean; must_change: boolean; ips: string[];
      created: Date; seen: Date; revoked: boolean; stepped: Date | null;
    }>(
      `SELECT a.id, a.email, a.display_name, a.role, (a.disabled_at IS NOT NULL) AS disabled, a.must_change_password AS must_change, a.ip_allow_list AS ips,
              s.created_at AS created, s.last_seen_at AS seen, (s.revoked_at IS NOT NULL) AS revoked, s.stepped_up_at AS stepped
       FROM platform_sessions s JOIN platform_admins a ON a.id = s.admin_id WHERE s.id = $1 AND a.id = $2`, [tok.sid, tok.adminId]))).rows[0];
    if (!row || row.disabled || row.revoked) throw new UnauthorizedException();
    const now = Date.now();
    // Two clocks, as NIST SP 800-63B asks: idle time and total time. Either one ends the session.
    if (now - new Date(row.seen).getTime() > ADMIN_IDLE_MINUTES * 60_000 || now - new Date(row.created).getTime() > ADMIN_MAX_HOURS * 3_600_000) {
      await withPlatform(this.pool, (c) => c.query("UPDATE platform_sessions SET revoked_at = now() WHERE id = $1", [tok.sid]));
      throw new UnauthorizedException();
    }
    if (!adminNetworkAllowed(req.ip, row.ips)) throw new UnauthorizedException();
    await withPlatform(this.pool, (c) => c.query("UPDATE platform_sessions SET last_seen_at = now() WHERE id = $1", [tok.sid]));
    req.admin = { id: row.id, email: row.email, displayName: row.display_name, role: row.role, perms: platformPermissions(row.role), sid: tok.sid, steppedUpAt: row.stepped, mustChangePassword: row.must_change };
    // Until a temporary password is replaced, the only things a staff account can do are replace it and sign out.
    if (row.must_change && !/^\/admin\/(me|logout)(\/|\?|$)/.test(req.originalUrl ?? req.url ?? "")) throw new ForbiddenException({ message: "choose a new password first", code: "password_change_required" });
    return true;
  }
}

export function requireAdminPerm(req: AdminRequest, ...needed: PlatformPermission[]): NonNullable<AdminRequest["admin"]> {
  const a = req.admin;
  if (!a || !needed.every((p) => a.perms.has(p))) throw new ForbiddenException(`requires ${needed.join(", ")}`);
  return a;
}

/** Sensitive actions need a code entered in the last few minutes, even inside a signed-in session. */
export function requireStepUp(req: AdminRequest): void {
  const at = req.admin?.steppedUpAt;
  if (!at || Date.now() - new Date(at).getTime() > STEP_UP_MINUTES * 60_000) {
    throw new ForbiddenException({ message: "enter your authenticator code to continue", code: "step_up_required" });
  }
}
