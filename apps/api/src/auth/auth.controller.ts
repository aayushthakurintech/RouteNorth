import { BadRequestException, Body, Controller, ForbiddenException, HttpCode, Inject, Post, UnauthorizedException } from "@nestjs/common";
import { pg } from "@routenorth/db";
import { DUMMY_HASH, verifyPassword } from "../passwords.js";
import { JWT_SECRET, PG_POOL } from "../tokens.js";
import { signSession } from "./jwt.js";
import { Req } from "@nestjs/common";
import { AuditService } from "../audit/audit.service.js";
import { effectivePermissions, homePath } from "@routenorth/shared";
import { withOrg } from "@routenorth/db";
import { withDefaults } from "../org/settings.js";
import type { AuthedRequest } from "./auth.guard.js";

@Controller("auth")
export class AuthController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(JWT_SECRET) private readonly secret: string,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  @Post("login")
  @HttpCode(200)
  async login(@Body() body: { email?: unknown; password?: unknown }, @Req() req: AuthedRequest) {
    if (typeof body?.email !== "string" || typeof body?.password !== "string") {
      throw new BadRequestException("email and password are required");
    }
    const found = await this.pool.query<{
      user_id: string; org_id: string; password_hash: string; role: string; locale: string; disabled: boolean;
    }>("SELECT * FROM find_login($1)", [body.email]);
    const user = found.rows[0];
    const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || user.disabled) {
      if (user) await this.audit.record({ orgId: user.org_id, actorId: user.user_id, actorLabel: String(body.email).toLowerCase(), action: "auth.login.failed", entity: "auth", method: "POST", path: "/auth/login", status: 401, ip: req.ip ?? null });
      throw new UnauthorizedException("invalid credentials");
    }

    // Organization-wide sign-in rules.
    const org = (await withOrg(this.pool, user.org_id, (c) => c.query("SELECT settings FROM organizations WHERE id = $1", [user.org_id]))).rows[0];
    const settings = withDefaults(org?.settings);
    if (settings.ipAllowList.length > 0 && !ipAllowed(req.ip ?? "", settings.ipAllowList)) {
      await this.audit.record({ orgId: user.org_id, actorId: user.user_id, actorLabel: String(body.email).toLowerCase(), action: "auth.login.blocked_ip", entity: "auth", method: "POST", path: "/auth/login", status: 403, ip: req.ip ?? null });
      throw new ForbiddenException("sign-in is not allowed from this network");
    }

    const token = await signSession(this.secret, { userId: user.user_id, orgId: user.org_id, role: user.role }, `${settings.sessionHours}h`);
    await this.audit.record({ orgId: user.org_id, actorId: user.user_id, actorLabel: String(body.email).toLowerCase(), action: "auth.login", entity: "auth", method: "POST", path: "/auth/login", status: 200, ip: req.ip ?? null });
    return { token, user: { id: user.user_id, orgId: user.org_id, role: user.role, locale: user.locale, home: homePath(user.role, effectivePermissions(user.role)) } };
  }
}

/** True when `ip` matches an entry of the list: an exact address or an IPv4 CIDR range. */
export function ipAllowed(ip: string, list: string[]): boolean {
  const addr = ip.replace(/^::ffff:/, "");
  const toInt = (a: string) => a.split(".").reduce((n, p) => (n << 8) + Number(p), 0) >>> 0;
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  return list.some((entry) => {
    if (entry === addr) return true;
    const [base, bits] = entry.split("/");
    if (!bits || !v4.test(base!) || !v4.test(addr)) return false;
    const n = Number(bits);
    if (!(n >= 0 && n <= 32)) return false;
    const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
    return (toInt(addr) & mask) === (toInt(base!) & mask);
  });
}
