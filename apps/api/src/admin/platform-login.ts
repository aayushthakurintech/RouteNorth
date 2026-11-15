import { HttpException, Inject, Injectable, UnauthorizedException } from "@nestjs/common";
import { pg, withPlatform } from "@routenorth/db";
import { matchStep, hashRecovery } from "../security/totp.js";
import { decryptSecret } from "../security/secrets.js";
import { verifyPassword } from "../passwords.js";
import { JWT_SECRET, PG_POOL } from "../tokens.js";
import { PlatformAudit } from "./platform-audit.js";
import { adminNetworkAllowed, signPlatformChallenge, signPlatformToken, verifyPlatformChallenge, type AdminRequest } from "./platform-auth.js";

const MAX_FAILS = 5;
const LOCK_MINUTES = 15;

interface AdminRow {
  id: string; email: string; display_name: string | null; password_hash: string; role: string; totp_secret: string; last_step: string | null;
  recovery_hashes: string[]; must_change_password: boolean; ip_allow_list: string[]; failed_attempts: number; locked_until: Date | null; disabled_at: Date | null;
}

/**
 * Staff sign-in, behind the same form and the same /auth/login URL as a client's. What differs:
 *  - every failure looks the same from outside (401 "invalid credentials"): unknown email, wrong password, locked,
 *    disabled, or a network that is not allowed. Nobody can use the form to find out which emails are staff.
 *  - a second factor is always required, so a password alone never produces a token.
 *  - five wrong answers in a row lock the account for 15 minutes.
 */
@Injectable()
export class PlatformAuth {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(JWT_SECRET) private readonly secret: string,
    @Inject(PlatformAudit) private readonly audit: PlatformAudit,
  ) {}

  /** Returns the answer to send when this email belongs to staff, or null when it does not (the client sign-in carries on). */
  async login(email: string, password: string, req: AdminRequest): Promise<{ mfaRequired: true; challenge: string } | null> {
    const row = (await withPlatform(this.pool, (c) => c.query<AdminRow>("SELECT * FROM platform_admins WHERE lower(email) = lower($1)", [email]))).rows[0];
    if (!row) return null;
    const ok = await verifyPassword(password, row.password_hash);
    const locked = !!row.locked_until && row.locked_until.getTime() > Date.now();
    const network = adminNetworkAllowed(req.ip, row.ip_allow_list);
    if (!ok || locked || row.disabled_at || !network) {
      await this.fail(row, req, !ok ? "login.failed" : locked ? "login.locked" : row.disabled_at ? "login.disabled" : "login.blocked_ip", !ok);
      throw new UnauthorizedException("invalid credentials");
    }
    return { mfaRequired: true, challenge: await signPlatformChallenge(this.secret, row.id) };
  }

  /** Returns the signed-in answer when `challenge` is a staff challenge, or null when it is not. */
  async mfa(challenge: string, rawCode: string, req: AdminRequest) {
    const id = await verifyPlatformChallenge(this.secret, challenge);
    if (!id) return null;
    const row = (await withPlatform(this.pool, (c) => c.query<AdminRow>("SELECT * FROM platform_admins WHERE id = $1", [id]))).rows[0];
    if (!row || row.disabled_at || !adminNetworkAllowed(req.ip, row.ip_allow_list)) throw new UnauthorizedException("that code is not right");
    if (row.locked_until && row.locked_until.getTime() > Date.now()) throw new HttpException("too many wrong codes, wait a few minutes", 429);
    if (!(await this.checkCode(row, rawCode))) {
      await this.fail(row, req, "mfa.failed", true);
      throw new UnauthorizedException("that code is not right");
    }
    const sid = (await withPlatform(this.pool, async (c) => {
      await c.query("UPDATE platform_admins SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1", [row.id]);
      const ua = req.headers["user-agent"];
      const s = await c.query<{ id: string }>("INSERT INTO platform_sessions (admin_id, ip, user_agent) VALUES ($1,$2,$3) RETURNING id", [row.id, req.ip ?? null, typeof ua === "string" ? ua.slice(0, 300) : null]);
      // Starting a new sign-in ends this person's older ones, so a stolen old token does not outlive a fresh login.
      await c.query("UPDATE platform_sessions SET revoked_at = now() WHERE admin_id = $1 AND id <> $2 AND revoked_at IS NULL", [row.id, s.rows[0]!.id]);
      await this.audit.recordIn(c, { adminId: row.id, adminEmail: row.email, action: "login", status: 200, ip: req.ip ?? null, sessionId: s.rows[0]!.id });
      return s.rows[0]!.id;
    }));
    const token = await signPlatformToken(this.secret, row.id, sid, row.role);
    return { token, user: { id: row.id, orgId: null, role: `platform:${row.role}`, locale: "en", home: "/admin", platform: true, mustChangePassword: row.must_change_password } };
  }

  /** A TOTP code (each step once only) or one of the saved recovery codes (each once only). */
  async checkCode(row: Pick<AdminRow, "id" | "totp_secret" | "last_step" | "recovery_hashes">, rawCode: string): Promise<boolean> {
    const code = rawCode.trim();
    const seed = decryptSecret(this.secret, row.totp_secret) ?? "";
    const step = seed ? matchStep(seed, code.replace(/\s/g, "")) : null;
    if (step !== null && (row.last_step === null || step > Number(row.last_step))) {
      // The update only succeeds if nobody else used this step meanwhile, so two requests cannot both spend the same code.
      const done = await withPlatform(this.pool, (c) => c.query("UPDATE platform_admins SET last_step = $2 WHERE id = $1 AND (last_step IS NULL OR last_step < $2)", [row.id, step]));
      return done.rowCount === 1;
    }
    const h = hashRecovery(code);
    if (row.recovery_hashes.includes(h)) {
      const done = await withPlatform(this.pool, (c) => c.query("UPDATE platform_admins SET recovery_hashes = array_remove(recovery_hashes, $2) WHERE id = $1 AND $2 = ANY(recovery_hashes)", [row.id, h]));
      return done.rowCount === 1;
    }
    return false;
  }

  private async fail(row: AdminRow, req: AdminRequest, action: string, countIt: boolean): Promise<void> {
    await withPlatform(this.pool, async (c) => {
      if (countIt) {
        const n = (await c.query<{ failed_attempts: number }>("UPDATE platform_admins SET failed_attempts = failed_attempts + 1 WHERE id = $1 RETURNING failed_attempts", [row.id])).rows[0]!.failed_attempts;
        if (n >= MAX_FAILS) await c.query("UPDATE platform_admins SET failed_attempts = 0, locked_until = now() + make_interval(mins => $2) WHERE id = $1", [row.id, LOCK_MINUTES]);
      }
      await this.audit.recordIn(c, { adminId: row.id, adminEmail: row.email, action, status: 401, ip: req.ip ?? null });
    }).catch(() => {});
  }

  /** Ends a "view as client" session. Safe to call twice. */
  async endImpersonation(id: string, by: string): Promise<void> {
    await withPlatform(this.pool, async (c) => {
      const r = await c.query<{ org_id: string; admin_id: string }>("UPDATE platform_impersonations SET ended_at = now(), ended_by = $2 WHERE id = $1 AND ended_at IS NULL RETURNING org_id, admin_id", [id, by]);
      if (r.rows[0]) await this.audit.recordIn(c, { adminId: r.rows[0].admin_id, action: "impersonation.ended", orgId: r.rows[0].org_id, target: id, detail: { by } });
    }).catch(() => {});
  }
}
