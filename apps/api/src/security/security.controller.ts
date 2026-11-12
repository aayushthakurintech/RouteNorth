import {
  BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Req, Res, UseGuards,
} from "@nestjs/common";
import type { Response } from "express";
import { pg, withOrg } from "@routenorth/db";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { AuditService } from "../audit/audit.service.js";
import { parseUuid } from "../history/range.js";
import { withDefaults } from "../org/settings.js";
import { hashPassword, verifyPassword } from "../passwords.js";
import { JWT_SECRET, PG_POOL } from "../tokens.js";
import { decryptSecret, encryptSecret } from "./secrets.js";
import { hashRecovery, matchStep, newRecoveryCodes, newSecret, otpauthUrl } from "./totp.js";
import { randomBytes } from "node:crypto";

/** Tables an export leaves out, and column names that never leave the database. */
const NOT_EXPORTED = new Set(["user_security", "user_sessions", "api_keys", "invites", "webhook_subscriptions", "roadmap_votes"]);
const SECRET_COLUMN = /password|secret|token|key_hash|hash$/i;
const ROW_CAP = 20_000;
const BIG_TABLE_CAP = 100_000;

/** Two-factor sign-in, signed-in devices, privacy tools (export, erase, delete) and the compliance checklist. */
@Controller("security")
@UseGuards(AuthGuard)
export class SecurityController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(JWT_SECRET) private readonly secret: string,
    @Inject(AuditService) private readonly audit: AuditService,
  ) {}

  // -------------------------------------------------------------------------------- two-factor

  @Get("2fa")
  async status(@Req() req: AuthedRequest) {
    const { orgId, userId } = req.session!;
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query("SELECT totp_enabled_at AS \"enabledAt\", cardinality(recovery_hashes)::int AS \"recoveryLeft\" FROM user_security WHERE user_id = $1", [userId])).rows[0];
      const org = (await c.query("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0];
      return { enabled: !!r?.enabledAt, enabledAt: r?.enabledAt ?? null, recoveryLeft: r?.enabledAt ? r.recoveryLeft : 0, required: withDefaults(org?.settings).twoFactorRequired };
    });
  }

  /** Step 1: make a new secret. Nothing changes until the person proves their app works (step 2). */
  @Post("2fa/setup")
  @HttpCode(200)
  async setup(@Req() req: AuthedRequest) {
    const { orgId, userId } = req.session!;
    if (!/^[0-9a-f-]{36}$/.test(userId) || req.actor?.email.startsWith("api-key:")) throw new ForbiddenException("sign in as a person to set up two-factor");
    const seed = newSecret();
    await withOrg(this.pool, orgId, async (c) => {
      const cur = (await c.query("SELECT totp_enabled_at FROM user_security WHERE user_id = $1", [userId])).rows[0];
      if (cur?.totp_enabled_at) throw new BadRequestException("two-factor is already on; turn it off first to set it up again");
      await c.query(
        `INSERT INTO user_security (user_id, org_id, totp_pending) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET totp_pending = EXCLUDED.totp_pending, updated_at = now()`, [userId, orgId, encryptSecret(this.secret, seed)]);
    });
    return { secret: seed, otpauth: otpauthUrl(seed, req.actor?.email ?? userId) };
  }

  /** Step 2: a code from the app turns it on and returns ten recovery codes, shown once. */
  @Post("2fa/enable")
  @HttpCode(200)
  async enable(@Req() req: AuthedRequest, @Body() b: { code?: unknown }) {
    const { orgId, userId } = req.session!;
    if (typeof b?.code !== "string") throw new BadRequestException("code is required");
    const code = b.code;
    return withOrg(this.pool, orgId, async (c) => {
      const row = (await c.query("SELECT totp_pending FROM user_security WHERE user_id = $1", [userId])).rows[0];
      const seed = row?.totp_pending ? decryptSecret(this.secret, row.totp_pending) : null;
      if (!seed) throw new BadRequestException("start the setup first");
      const step = matchStep(seed, code.replace(/\s/g, ""));
      if (step === null) throw new BadRequestException("that code is not right; check the time on your phone and try again");
      const codes = newRecoveryCodes();
      await c.query(
        `UPDATE user_security SET totp_secret = totp_pending, totp_pending = NULL, totp_enabled_at = now(), recovery_hashes = $2, last_step = $3, updated_at = now() WHERE user_id = $1`,
        [userId, codes.map(hashRecovery), step]);
      return { ok: true, recoveryCodes: codes };
    });
  }

  private async checkPassword(c: pg.PoolClient, userId: string, password: unknown): Promise<void> {
    if (typeof password !== "string") throw new BadRequestException("your password is required");
    const h = (await c.query("SELECT password_hash FROM users WHERE id = $1", [userId])).rows[0]?.password_hash;
    if (!h || !(await verifyPassword(password, h))) throw new ForbiddenException("that password is not right");
  }

  @Post("2fa/disable")
  @HttpCode(200)
  async disable(@Req() req: AuthedRequest, @Body() b: { password?: unknown }) {
    const { orgId, userId } = req.session!;
    await withOrg(this.pool, orgId, async (c) => {
      await this.checkPassword(c, userId, b?.password);
      const org = (await c.query("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0];
      if (withDefaults(org?.settings).twoFactorRequired && !["driver", "customer"].includes(req.session!.role)) throw new BadRequestException("your organization requires two-factor sign-in");
      await c.query("DELETE FROM user_security WHERE user_id = $1", [userId]);
    });
    return { ok: true };
  }

  @Post("2fa/recovery")
  @HttpCode(200)
  async recovery(@Req() req: AuthedRequest, @Body() b: { password?: unknown }) {
    const { orgId, userId } = req.session!;
    return withOrg(this.pool, orgId, async (c) => {
      await this.checkPassword(c, userId, b?.password);
      const on = (await c.query("SELECT 1 FROM user_security WHERE user_id = $1 AND totp_enabled_at IS NOT NULL", [userId])).rowCount;
      if (!on) throw new BadRequestException("two-factor is not on");
      const codes = newRecoveryCodes();
      await c.query("UPDATE user_security SET recovery_hashes = $2 WHERE user_id = $1", [userId, codes.map(hashRecovery)]);
      return { recoveryCodes: codes };
    });
  }

  /** A manager helps someone who lost their phone and recovery codes: turn off their two-factor and sign them out. */
  @Post("users/:id/reset-2fa")
  @HttpCode(200)
  async reset(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "users.manage");
    const uid = parseUuid(id);
    await withOrg(this.pool, orgId, async (c) => {
      if (!(await c.query("SELECT 1 FROM users WHERE id = $1", [uid])).rowCount) throw new NotFoundException();
      await c.query("DELETE FROM user_security WHERE user_id = $1", [uid]);
      await c.query("UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [uid]);
    });
    return { ok: true };
  }

  // -------------------------------------------------------------------------------- sessions

  @Get("sessions")
  async sessions(@Req() req: AuthedRequest) {
    const { orgId, userId, sid } = req.session!;
    return withOrg(this.pool, orgId, async (c) => (await c.query(
      `SELECT id, created_at AS "createdAt", last_seen_at AS "lastSeenAt", ip, user_agent AS "userAgent", (id = $2::uuid) AS current
       FROM user_sessions WHERE user_id = $1 AND revoked_at IS NULL AND created_at > now() - interval '30 days' ORDER BY last_seen_at DESC LIMIT 50`, [userId, sid ?? null])).rows);
  }

  @Delete("sessions/:id")
  @HttpCode(200)
  async revoke(@Req() req: AuthedRequest, @Param("id") id: string) {
    const { orgId, userId } = req.session!;
    const n = (await withOrg(this.pool, orgId, (c) => c.query("UPDATE user_sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL", [parseUuid(id), userId]))).rowCount;
    if (!n) throw new NotFoundException();
    return { ok: true };
  }

  /** Sign out everywhere except this device (for a lost laptop or a shared computer). */
  @Post("sessions/revoke-others")
  @HttpCode(200)
  async revokeOthers(@Req() req: AuthedRequest) {
    const { orgId, userId, sid } = req.session!;
    const r = await withOrg(this.pool, orgId, (c) => c.query("UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND id IS DISTINCT FROM $2::uuid", [userId, sid ?? null]));
    return { revoked: r.rowCount ?? 0 };
  }

  @Post("users/:id/sign-out")
  @HttpCode(200)
  async signOutUser(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "users.manage");
    const r = await withOrg(this.pool, orgId, (c) => c.query("UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [parseUuid(id)]));
    return { revoked: r.rowCount ?? 0 };
  }

  // -------------------------------------------------------------------------------- your data

  /** Everything the organization owns, as one JSON file. Secrets and password hashes are never included. */
  @Get("export")
  async export(@Req() req: AuthedRequest, @Res() res: Response, @Query("tables") only?: string) {
    const orgId = requirePerm(req, "settings.manage");
    const want = only ? new Set(only.split(",").map((s) => s.trim()).filter(Boolean)) : null;
    const out = await withOrg(this.pool, orgId, async (c) => {
      const names = (await c.query<{ table_name: string }>(
        `SELECT t.table_name FROM information_schema.tables t
         WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
           AND EXISTS (SELECT 1 FROM information_schema.columns k WHERE k.table_schema = 'public' AND k.table_name = t.table_name AND k.column_name = 'org_id')
         ORDER BY 1`)).rows.map((r) => r.table_name).filter((n) => !NOT_EXPORTED.has(n) && (!want || want.has(n)));
      const data: Record<string, unknown[]> = {};
      const truncated: string[] = [];
      for (const n of names) {
        const cap = n === "positions" ? BIG_TABLE_CAP : ROW_CAP;
        const order = n === "positions" ? "ORDER BY time DESC" : "";
        const rows = (await c.query(`SELECT * FROM ${pg.escapeIdentifier(n)} ${order} LIMIT ${cap + 1}`)).rows;
        if (rows.length > cap) { rows.length = cap; truncated.push(n); }
        data[n] = rows.map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !SECRET_COLUMN.test(k))));
      }
      const org = (await c.query("SELECT id, name, slug FROM organizations WHERE id = $1", [orgId])).rows[0];
      return { meta: { exportedAt: new Date().toISOString(), organization: org, tables: names.length, truncated, note: "Passwords, API keys, webhook secrets and sign-in records are not included." }, data };
    });
    await this.audit.record({ orgId, actorId: req.session!.userId, actorLabel: req.actor?.email ?? null, action: "privacy.export", entity: "organization", method: "GET", path: "/security/export", status: 200 });
    res.type("application/json").setHeader("Content-Disposition", `attachment; filename="routenorth-export-${new Date().toISOString().slice(0, 10)}.json"`);
    res.send(JSON.stringify(out));
  }

  /** Remove a person's details (right to erasure). Their jobs and history stay, attributed to "erased user". */
  @Post("users/:id/erase")
  @HttpCode(200)
  async erase(@Req() req: AuthedRequest, @Param("id") id: string, @Body() b: { confirm?: unknown }) {
    const orgId = requirePerm(req, "users.manage");
    const uid = parseUuid(id);
    if (uid === req.session!.userId) throw new BadRequestException("you cannot erase yourself; ask another owner");
    await withOrg(this.pool, orgId, async (c) => {
      const u = (await c.query("SELECT email, role FROM users WHERE id = $1", [uid])).rows[0];
      if (!u) throw new NotFoundException();
      if (typeof b?.confirm !== "string" || b.confirm.toLowerCase() !== String(u.email).toLowerCase()) throw new BadRequestException("type the person's email to confirm");
      if (u.role === "owner") {
        const owners = (await c.query("SELECT count(*)::int AS n FROM users WHERE role = 'owner' AND disabled_at IS NULL")).rows[0].n;
        if (owners <= 1) throw new BadRequestException("an organization needs at least one owner");
      }
      await c.query("UPDATE user_sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL", [uid]);
      await c.query("DELETE FROM user_security WHERE user_id = $1", [uid]);
      await c.query("DELETE FROM user_prefs WHERE user_id = $1", [uid]);
      await c.query("DELETE FROM driver_profiles WHERE user_id = $1", [uid]);
      await c.query("DELETE FROM notifications WHERE user_id = $1", [uid]);
      await c.query("UPDATE support_requests SET body = '[erased]', subject = NULL WHERE user_id = $1", [uid]);
      await c.query(
        "UPDATE users SET email = $2, display_name = NULL, password_hash = $3, disabled_at = coalesce(disabled_at, now()), custom_role_id = NULL WHERE id = $1",
        [uid, `erased-${uid}@erased.invalid`, await hashPassword(randomBytes(24).toString("hex"))]);
    });
    return { ok: true };
  }

  /** Delete the whole organization and every record it owns. Owner only; needs the password and the company name. */
  @Post("delete-organization")
  @HttpCode(200)
  async deleteOrg(@Req() req: AuthedRequest, @Body() b: { password?: unknown; confirm?: unknown }) {
    const orgId = requirePerm(req, "billing.manage", "settings.manage");
    const { userId, role } = req.session!;
    if (role !== "owner") throw new ForbiddenException("only an owner can delete the organization");
    await withOrg(this.pool, orgId, async (c) => {
      await this.checkPassword(c, userId, b?.password);
      const name = (await c.query("SELECT name FROM organizations WHERE id = $1", [orgId])).rows[0]?.name;
      if (typeof b?.confirm !== "string" || b.confirm.trim() !== name) throw new BadRequestException("type the exact company name to confirm");
    });
    // The audit row is written first; it goes with the organization, which is the point. The log of the deletion is the server log.
    console.log(`organization ${orgId} deleted by ${req.actor?.email}`);
    await withOrg(this.pool, orgId, (c) => c.query("SELECT erase_organization($1)", [orgId]));
    return { ok: true };
  }

  // -------------------------------------------------------------------------------- compliance

  /** A live checklist of the controls this product can show evidence for, with what is still up to your organization. */
  @Get("compliance")
  async compliance(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "settings.manage");
    return withOrg(this.pool, orgId, async (c) => {
      const org = (await c.query("SELECT settings, retention_days AS \"retentionDays\" FROM organizations WHERE id = $1", [orgId])).rows[0];
      const s = withDefaults(org?.settings);
      const people = (await c.query(
        `SELECT count(*) FILTER (WHERE u.role NOT IN ('driver','customer'))::int AS office,
                count(*) FILTER (WHERE u.role NOT IN ('driver','customer') AND us.totp_enabled_at IS NOT NULL)::int AS office_2fa,
                count(*) FILTER (WHERE u.role IN ('owner','admin') AND us.totp_enabled_at IS NULL)::int AS admins_without
         FROM users u LEFT JOIN user_security us ON us.user_id = u.id WHERE u.disabled_at IS NULL`)).rows[0];
      const stale = (await c.query("SELECT count(*)::int AS n FROM api_keys WHERE revoked_at IS NULL AND coalesce(last_used_at, created_at) < now() - interval '90 days'")).rows[0].n;
      const audit30 = (await c.query("SELECT count(*)::int AS n FROM audit_log WHERE at > now() - interval '30 days'")).rows[0].n;
      type S = "ok" | "todo" | "external";
      const control = (id: string, status: S, params: Record<string, string | number> = {}) => ({ id, status, params });
      return {
        controls: [
          control("tenant", "ok"),
          control("audit", audit30 > 0 ? "ok" : "todo", { n: audit30 }),
          control("twoFactorRequired", s.twoFactorRequired ? "ok" : "todo"),
          control("twoFactorAdmins", people.admins_without === 0 ? "ok" : "todo", { n: people.admins_without }),
          control("twoFactorCoverage", people.office > 0 && people.office_2fa === people.office ? "ok" : "todo", { done: people.office_2fa, total: people.office }),
          control("ipAllow", s.ipAllowList.length ? "ok" : "todo", { n: s.ipAllowList.length }),
          control("sessionLength", s.sessionHours <= 12 ? "ok" : "todo", { h: s.sessionHours }),
          control("retention", "ok", { days: org.retentionDays }),
          control("driverPrivacy", s.trackOnlyDuringShift ? "ok" : "todo"),
          control("staleKeys", stale === 0 ? "ok" : "todo", { n: stale }),
          control("backups", "external"),
          control("encryptionTransit", "external"),
          control("policies", "external"),
        ],
      };
    });
  }
}
