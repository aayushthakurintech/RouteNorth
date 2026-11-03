import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { effectivePermissions, type Permission } from "@routenorth/shared";
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
  /** Who is calling, for the audit log. */
  actor?: { email: string; displayName: string | null };
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
      c.query<{ role: string; disabled: boolean; custom: string[] | null; email: string; display_name: string | null }>(
        `SELECT u.role, u.email, u.display_name, (u.disabled_at IS NOT NULL) AS disabled, cr.permissions AS custom
         FROM users u LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id AND cr.org_id = u.org_id
         WHERE u.id = $1`, [session.userId]),
    );
    const user = found.rows[0];
    if (!user || user.disabled) throw new UnauthorizedException();
    req.session = { ...session, role: user.role };
    req.perms = effectivePermissions(user.role, user.custom);
    req.actor = { email: user.email, displayName: user.display_name };
    return true;
  }

  /** An API key acts as a read-only or a dispatcher-level user, never as an owner, and cannot manage users, billing or settings. */
  private async withApiKey(req: AuthedRequest, token: string): Promise<boolean> {
    const k = (await this.pool.query<{ key_id: string; org_id: string; kind: string; scope: string; created_by: string | null; name: string }>("SELECT * FROM find_api_key($1)", [hashKey(token)])).rows[0];
    if (!k || k.kind !== "api") throw new UnauthorizedException();
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
