import { BadRequestException, Body, Controller, ForbiddenException, HttpCode, Inject, Post, HttpException, UnauthorizedException } from "@nestjs/common";
import { pg } from "@routenorth/db";
import { DUMMY_HASH, verifyPassword } from "../passwords.js";
import { JWT_SECRET, PG_POOL } from "../tokens.js";
import { signChallenge, verifyChallenge, verifySession } from "./jwt.js";
import { startSession } from "../security/sessions.js";
import { decryptSecret } from "../security/secrets.js";
import { hashRecovery, matchStep } from "../security/totp.js";
import { Req } from "@nestjs/common";
import { AuditService } from "../audit/audit.service.js";
import { effectivePermissions, homePath } from "@routenorth/shared";
import { withOrg } from "@routenorth/db";
import { withDefaults } from "../org/settings.js";
import type { AuthedRequest } from "./auth.guard.js";
import { LoginThrottle } from "./login-throttle.js";

@Controller("auth")
export class AuthController {
  /** Wrong second-factor codes per person, so a six-digit code cannot be guessed by trying them all. */
  private readonly fails = new Map<string, { n: number; until: number }>();
  /** Failed passwords per email and per network address, so passwords cannot be guessed at speed. */
  readonly throttle = new LoginThrottle();
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
    const email = body.email.trim().toLowerCase();
    const ip = req.ip ?? "";
    const wait = this.throttle.blockedFor(email, ip);
    if (wait > 0) throw new HttpException(`too many failed sign-ins, try again in ${Math.ceil(wait / 60)} minute(s)`, 429);
    const found = await this.pool.query<{
      user_id: string; org_id: string; password_hash: string; role: string; locale: string; disabled: boolean;
    }>("SELECT * FROM find_login($1)", [body.email]);
    const user = found.rows[0];
    const ok = await verifyPassword(body.password, user?.password_hash ?? DUMMY_HASH);
    if (!user || !ok || user.disabled) {
      this.throttle.fail(email, ip);
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

    this.throttle.succeed(email);
    const sec = (await withOrg(this.pool, user.org_id, (c) => c.query("SELECT 1 FROM user_security WHERE user_id = $1 AND totp_enabled_at IS NOT NULL", [user.user_id]))).rowCount;
    if (sec) return { mfaRequired: true, challenge: await signChallenge(this.secret, user.user_id, user.org_id) };
    return this.finish(user, settings.sessionHours, req, String(body.email).toLowerCase());
  }

  /** The second step of sign-in: an authenticator code, or one of the saved recovery codes. */
  @Post("mfa")
  @HttpCode(200)
  async mfa(@Body() body: { challenge?: unknown; code?: unknown }, @Req() req: AuthedRequest) {
    if (typeof body?.challenge !== "string" || typeof body?.code !== "string") throw new BadRequestException("challenge and code are required");
    const ch = await verifyChallenge(this.secret, body.challenge);
    if (!ch) throw new UnauthorizedException("the sign-in expired, start again");
    const lock = this.fails.get(ch.userId);
    if (lock && lock.n >= 5 && lock.until > Date.now()) throw new HttpException("too many wrong codes, wait a few minutes", 429);
    const row = (await withOrg(this.pool, ch.orgId, (c) => c.query<{ totp_secret: string | null; recovery_hashes: string[]; last_step: string | null; email: string; role: string; locale: string; disabled: boolean }>(
      `SELECT us.totp_secret, us.recovery_hashes, us.last_step, u.email, u.role, u.locale, (u.disabled_at IS NOT NULL) AS disabled
       FROM user_security us JOIN users u ON u.id = us.user_id AND u.org_id = us.org_id WHERE us.user_id = $1 AND us.totp_enabled_at IS NOT NULL`, [ch.userId]))).rows[0];
    if (!row || row.disabled) throw new UnauthorizedException();
    const seed = row.totp_secret ? decryptSecret(this.secret, row.totp_secret) : null;
    const code = body.code.trim();
    let good = false;
    const step = seed ? matchStep(seed, code.replace(/\s/g, "")) : null;
    if (step !== null && (row.last_step === null || step > Number(row.last_step))) {
      good = true;
      await withOrg(this.pool, ch.orgId, (c) => c.query("UPDATE user_security SET last_step = $2 WHERE user_id = $1", [ch.userId, step]));
    } else if (row.recovery_hashes.length) {
      const h = hashRecovery(code);
      if (row.recovery_hashes.includes(h)) {
        good = true;
        await withOrg(this.pool, ch.orgId, (c) => c.query("UPDATE user_security SET recovery_hashes = array_remove(recovery_hashes, $2) WHERE user_id = $1", [ch.userId, h]));
      }
    }
    if (!good) {
      this.fails.set(ch.userId, { n: (lock && lock.until > Date.now() ? lock.n : 0) + 1, until: Date.now() + 5 * 60_000 });
      await this.audit.record({ orgId: ch.orgId, actorId: ch.userId, actorLabel: row.email, action: "auth.mfa.failed", entity: "auth", method: "POST", path: "/auth/mfa", status: 401, ip: req.ip ?? null });
      throw new UnauthorizedException("that code is not right");
    }
    this.fails.delete(ch.userId);
    const org = (await withOrg(this.pool, ch.orgId, (c) => c.query("SELECT settings FROM organizations WHERE id = $1", [ch.orgId]))).rows[0];
    return this.finish({ user_id: ch.userId, org_id: ch.orgId, role: row.role, locale: row.locale }, withDefaults(org?.settings).sessionHours, req, row.email);
  }

  /** Signs this browser out for good: the token stops working everywhere. */
  @Post("logout")
  @HttpCode(200)
  async logout(@Req() req: AuthedRequest) {
    const h = req.headers.authorization;
    const sess = typeof h === "string" && h.startsWith("Bearer ") ? await verifySession(this.secret, h.slice(7)) : null;
    if (sess?.sid) await withOrg(this.pool, sess.orgId, (c) => c.query("UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [sess.sid, sess.userId]));
    return { ok: true };
  }

  private async finish(user: { user_id: string; org_id: string; role: string; locale: string }, hours: number, req: AuthedRequest, label: string) {
    const token = await startSession(this.pool, this.secret, { userId: user.user_id, orgId: user.org_id, role: user.role }, hours, req);
    await this.audit.record({ orgId: user.org_id, actorId: user.user_id, actorLabel: label, action: "auth.login", entity: "auth", method: "POST", path: "/auth/login", status: 200, ip: req.ip ?? null });
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
