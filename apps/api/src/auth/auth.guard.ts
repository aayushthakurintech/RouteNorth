import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { pg, withOrg, withPlatform } from "@routenorth/db";
import { hasSection, type SectionId, IMPERSONATION_BLOCKED_PATHS, IMPERSONATION_HIDDEN_PERMS, classifyRoute, effectivePermissions, resolveEntitlements, routeAllowed, type Entitlements, type Permission } from "@routenorth/shared";
import { JWT_SECRET, PG_POOL } from "../tokens.js";
import { hashKey, isKeyToken } from "../platform/keys.js";
import { verifySession, type Session } from "./jwt.js";

export interface AuthedRequest {
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  method?: string;
  originalUrl?: string;
  url?: string;
  body?: unknown;
  session?: Session;
  /** What this person may do, loaded from the database on every request so role changes apply at once. */
  perms?: ReadonlySet<Permission>;
  /** Set when a handler already wrote its own audit row (with old and new values), so the generic one is skipped. */
  auditDone?: boolean;
  /** Who is calling, for the audit log. */
  actor?: { email: string; displayName: string | null };
  /** What RouteNorth staff gave this company: the sections it may use and any hard limits. Loaded on every request. */
  entitlements?: Entitlements;
  /** Set when RouteNorth staff are viewing this account (read-only). */
  impersonation?: { id: string; reason: string; expiresAt: Date; adminName: string };
}

/** Replaces ids with ":id" so the list of pages staff looked at has no customer data in it. */
export function pathShape(url: string): string {
  return ("/" + url.split("?")[0]!.split("/").filter(Boolean).slice(0, 5).map((p) => (/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(p) || /^\d+$/.test(p) ? ":id" : p.slice(0, 40))).join("/")).slice(0, 120);
}

@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    @Inject(JWT_SECRET) private readonly secret: string,
    @Inject(PG_POOL) private readonly pool: pg.Pool,
  ) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest<AuthedRequest>();
    const header = req.headers.authorization;
    const token = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : null;
    if (token && isKeyToken(token)) return this.withApiKey(req, token);
    const session = token ? await verifySession(this.secret, token) : null;
    if (!session) throw new UnauthorizedException();

    // The token only proves who they are. Role, custom role and disabled state come from the database,
    // so removing someone or changing their role takes effect immediately.
    const found = await withOrg(this.pool, session.orgId, (c) =>
      c.query<{ role: string; disabled: boolean; custom: string[] | null; email: string; display_name: string | null; sid_ok: boolean | null; seen: Date | null; has2fa: boolean; require2fa: string | null; org_status: string; ent_sections: string[] | null; ent_limits: unknown }>(
        `SELECT u.role, u.email, u.display_name, (u.disabled_at IS NOT NULL) AS disabled, cr.permissions AS custom,
                (SELECT s.revoked_at IS NULL AND s.user_id = u.id FROM user_sessions s WHERE s.id = $2::uuid) AS sid_ok,
                (SELECT s.last_seen_at FROM user_sessions s WHERE s.id = $2::uuid) AS seen,
                coalesce((SELECT us.totp_enabled_at IS NOT NULL FROM user_security us WHERE us.user_id = u.id), false) AS has2fa,
                (SELECT o.settings ->> 'twoFactorRequired' FROM organizations o WHERE o.id = u.org_id) AS require2fa,
                (SELECT o.status FROM organizations o WHERE o.id = u.org_id) AS org_status,
                (SELECT e.sections FROM org_entitlements e WHERE e.org_id = u.org_id) AS ent_sections,
                (SELECT e.limits FROM org_entitlements e WHERE e.org_id = u.org_id) AS ent_limits
         FROM users u LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id AND cr.org_id = u.org_id
         WHERE u.id = $1`, [session.userId, session.sid ?? null]),
    );
    const user = found.rows[0];
    if (!user || user.disabled) throw new UnauthorizedException();
    // Staff "view as client" token: valid only while its platform row says so, and then read-only. It has no user_sessions row.
    let imp: AuthedRequest["impersonation"];
    if (session.imp) {
      imp = await this.checkImpersonation(session.imp, session.orgId, session.userId);
    } else {
      // A token tied to a sign-in is dead once that sign-in is revoked (signed out, or removed from the sessions list).
      if (session.sid && user.sid_ok !== true) throw new UnauthorizedException();
      if (session.sid && (!user.seen || Date.now() - new Date(user.seen).getTime() > 5 * 60_000)) {
        void withOrg(this.pool, session.orgId, (c) => c.query("UPDATE user_sessions SET last_seen_at = now() WHERE id = $1", [session.sid])).catch(() => {});
      }
    }
    const url = req.originalUrl ?? req.url ?? "";
    // Suspended companies cannot use the product. Staff viewing the account can still look, so they can help.
    if (user.org_status === "suspended" && !imp && !/^\/auth\/logout/.test(url)) throw new ForbiddenException({ message: "this account is suspended, contact RouteNorth", code: "account_suspended" });
    const ent = resolveEntitlements(user.ent_sections ? { sections: user.ent_sections, limits: user.ent_limits } : null);
    req.entitlements = ent;
    // Entitlements are checked here, in the one place every signed-in route passes through, so a section that was switched off
    // is closed for the API itself and not just hidden from the menu.
    if (!routeAllowed(ent, url)) throw new ForbiddenException({ message: "this part of RouteNorth is not included in your plan", code: "section_not_included", section: classifyRoute(url) });
    req.session = { ...session, role: user.role };
    req.perms = effectivePermissions(user.role, user.custom);
    req.actor = { email: user.email, displayName: user.display_name };
    if (imp) {
      req.impersonation = imp;
      req.actor = { email: user.email, displayName: `${imp.adminName} (RouteNorth staff, viewing)` };
      for (const p of IMPERSONATION_HIDDEN_PERMS) (req.perms as Set<Permission>).delete(p);
      const method = (req.method ?? "GET").toUpperCase();
      const path = url.split("?")[0]!.split("/").filter(Boolean).join("/");
      const blockedPath = IMPERSONATION_BLOCKED_PATHS.some((b) => path === b || path.startsWith(`${b}/`));
      const mayEnd = method === "POST" && path === "auth/logout";
      const write = !["GET", "HEAD", "OPTIONS"].includes(method) && !mayEnd;
      void withPlatform(this.pool, (c) => c.query(
        `UPDATE platform_impersonations SET requests = requests + 1, blocked_writes = blocked_writes + $2,
           paths = CASE WHEN $3 = ANY(paths) OR cardinality(paths) >= 300 THEN paths ELSE paths || $3::text END WHERE id = $1`,
        [imp.id, write || blockedPath ? 1 : 0, pathShape(url)])).catch(() => {});
      if (write) throw new ForbiddenException({ message: "RouteNorth staff are viewing this account read-only", code: "read_only_view" });
      if (blockedPath) throw new ForbiddenException({ message: "this page cannot be opened while viewing as staff", code: "blocked_in_staff_view" });
    }
    // When the organization requires two-factor sign-in, office users without it can only reach the screens that set it up.
    if (user.require2fa === "true" && !user.has2fa && !["driver", "customer"].includes(user.role)) {
      const url = req.originalUrl ?? req.url ?? "";
      if (!/^\/(me|auth|security\/2fa)(\/|\?|$)/.test(url)) throw new ForbiddenException({ message: "two-factor sign-in is required", code: "mfa_required" });
    }
    return true;
  }

  private async checkImpersonation(id: string, orgId: string, userId: string): Promise<NonNullable<AuthedRequest["impersonation"]>> {
    const r = (await withPlatform(this.pool, (c) => c.query<{ reason: string; expires_at: Date; admin: string }>(
      `SELECT i.reason, i.expires_at, coalesce(a.display_name, 'RouteNorth staff') AS admin
       FROM platform_impersonations i JOIN platform_admins a ON a.id = i.admin_id
       WHERE i.id = $1 AND i.org_id = $2 AND i.user_id = $3 AND i.ended_at IS NULL AND i.expires_at > now() AND a.disabled_at IS NULL`, [id, orgId, userId]))).rows[0];
    if (!r) throw new UnauthorizedException();
    return { id, reason: r.reason, expiresAt: r.expires_at, adminName: r.admin };
  }

  /** An API key acts as a read-only or a dispatcher-level user, never as an owner, and cannot manage users, billing or settings. */
  private async withApiKey(req: AuthedRequest, token: string): Promise<boolean> {
    const k = (await this.pool.query<{ key_id: string; org_id: string; kind: string; scope: string; created_by: string | null; name: string }>("SELECT * FROM find_api_key($1)", [hashKey(token)])).rows[0];
    if (!k || k.kind !== "api") throw new UnauthorizedException();
    const gate = (await withOrg(this.pool, k.org_id, (c) => c.query<{ status: string; sections: string[] | null; limits: unknown }>(
      `SELECT o.status, e.sections, e.limits FROM organizations o LEFT JOIN org_entitlements e ON e.org_id = o.id WHERE o.id = $1`, [k.org_id]))).rows[0];
    if (!gate || gate.status === "suspended") throw new ForbiddenException({ message: "this account is suspended, contact RouteNorth", code: "account_suspended" });
    const ent = resolveEntitlements(gate.sections ? { sections: gate.sections, limits: gate.limits } : null);
    if (!routeAllowed(ent, req.originalUrl ?? req.url ?? "")) throw new ForbiddenException({ message: "this part of RouteNorth is not included in your plan", code: "section_not_included", section: classifyRoute(req.originalUrl ?? req.url ?? "") });
    req.entitlements = ent;
    const role = k.scope === "write" ? "dispatcher" : "viewer";
    req.session = { userId: k.created_by ?? k.key_id, orgId: k.org_id, role };
    req.perms = effectivePermissions(role, null);
    req.actor = { email: `api-key:${k.name}`, displayName: `API key ${k.name}` };
    void withOrg(this.pool, k.org_id, (c) => c.query("UPDATE api_keys SET last_used_at = now() WHERE id = $1 AND (last_used_at IS NULL OR last_used_at < now() - interval '5 minutes')", [k.key_id])).catch(() => {});
    return true;
  }
}

/** Throws 403 unless the caller has every listed permission. Returns the caller's organization id. */
export function requirePerm(req: AuthedRequest, ...needed: Permission[]): string {
  const perms = req.perms;
  if (!perms || !needed.every((p) => perms.has(p))) throw new ForbiddenException(`requires ${needed.join(", ")}`);
  return req.session!.orgId;
}

/** Throws 403 unless the caller has at least one of the listed permissions. Returns the caller's organization id. */
export function requireAny(req: AuthedRequest, ...any: Permission[]): string {
  if (!any.some((p) => req.perms?.has(p))) throw new ForbiddenException(`requires one of ${any.join(", ")}`);
  return req.session!.orgId;
}

/** True when the caller has any of the listed permissions. */
export function hasPerm(req: AuthedRequest, ...any: Permission[]): boolean {
  return any.some((p) => req.perms?.has(p));
}

/** True when the caller's company has this section (always true for companies with everything). */
export function sectionOn(req: AuthedRequest, section: SectionId): boolean {
  return !req.entitlements || hasSection(req.entitlements, section);
}
