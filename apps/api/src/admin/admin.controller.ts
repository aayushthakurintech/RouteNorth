import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg, withPlatform } from "@routenorth/db";
import {
  CORE_FEATURES, IMPERSONATION_MINUTES, MIN_REASON_LENGTH, PLANS, PLAN_IDS, PLATFORM_ROLES, PLATFORM_ROLE_LABEL, PLATFORM_ROLE_PERMISSIONS, PRESETS, SECTIONS, SECTION_IDS,
  clientHealth, isPlatformRole, passwordProblem, resolveEntitlements, type PlanId, type SectionId,
} from "@routenorth/shared";
import { createHash, randomBytes } from "node:crypto";
import { AuditService } from "../audit/audit.service.js";
import { signSession } from "../auth/jwt.js";
import { parseUuid } from "../history/range.js";
import { hashPassword, verifyPassword } from "../passwords.js";
import { encryptSecret } from "../security/secrets.js";
import { hashRecovery, newRecoveryCodes, newSecret, otpauthUrl } from "../security/totp.js";
import { JWT_SECRET, PG_POOL } from "../tokens.js";
import { PlatformAudit } from "./platform-audit.js";
import { PlatformAuth } from "./platform-login.js";
import { PlatformGuard, requireAdminPerm, requireStepUp, type AdminRequest } from "./platform-auth.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const text = (v: unknown, name: string, min: number, max: number): string => {
  if (typeof v !== "string") throw new BadRequestException(`${name} is required`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw new BadRequestException(`${name} must be ${min} to ${max} characters`);
  return s;
};
const reasonOf = (v: unknown): string => text(v, "reason", MIN_REASON_LENGTH, 500);
const slugify = (s: string) => s.toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "client";
const staffLabel = (a: NonNullable<AdminRequest["admin"]>) => `RouteNorth staff (${a.displayName ?? "support team"})`;

interface Stats {
  org_id: string; vehicles: number; devices: number; devices_live: number; devices_recent: number; users: number; drivers: number;
  last_position_at: Date | null; last_login_at: Date | null; jobs_month: number; owner_email: string | null; owner_name: string | null;
}
interface OrgRow {
  id: string; name: string; slug: string; plan: string; status: string; created_at: Date; trial_ends_at: Date | null; locale: string; timezone: string;
  suspended_at: Date | null; suspended_reason: string | null; internal_notes: string | null; sections: string[] | null; limits: unknown;
}

function shape(o: OrgRow, s: Stats | undefined) {
  const ent = resolveEntitlements(o.sections ? { sections: o.sections, limits: o.limits } : null);
  const usage = {
    vehicles: s?.vehicles ?? 0, devices: s?.devices ?? 0, devicesLive: s?.devices_live ?? 0, devicesRecent: s?.devices_recent ?? 0, users: s?.users ?? 0, drivers: s?.drivers ?? 0,
    jobsMonth: s?.jobs_month ?? 0, lastPositionAt: s?.last_position_at ?? null, lastLoginAt: s?.last_login_at ?? null,
  };
  const health = clientHealth({
    status: o.status as "active" | "suspended", plan: o.plan, trialEndsAt: o.trial_ends_at, createdAt: o.created_at,
    vehicles: usage.vehicles, devices: usage.devices, devicesLive: usage.devicesLive, devicesRecent: usage.devicesRecent, lastLoginAt: usage.lastLoginAt, limits: ent.limits, users: usage.users,
  });
  return {
    id: o.id, name: o.name, slug: o.slug, plan: o.plan, status: o.status, createdAt: o.created_at, trialEndsAt: o.trial_ends_at, locale: o.locale, timezone: o.timezone,
    suspendedAt: o.suspended_at, suspendedReason: o.suspended_reason, ownerEmail: s?.owner_email ?? null, ownerName: s?.owner_name ?? null,
    entitlements: ent, usage, health,
  };
}

const ORG_SELECT = `SELECT o.id, o.name, o.slug, o.plan, o.status, o.created_at, o.trial_ends_at, o.locale, o.timezone, o.suspended_at, o.suspended_reason, o.internal_notes, e.sections, e.limits
                    FROM organizations o LEFT JOIN org_entitlements e ON e.org_id = o.id`;

/**
 * The admin console API. Everything here is for RouteNorth staff only: PlatformGuard accepts staff tokens and nothing else,
 * and each action asks for its own permission (a role is only a bundle of those permissions).
 * Actions that change a client or open its data also need a recent second-factor code (step-up) and are written to the
 * staff audit log. Actions a client should know about are also written to the client's own audit log.
 */
@Controller("admin")
@UseGuards(PlatformGuard)
export class AdminController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(JWT_SECRET) private readonly secret: string,
    @Inject(PlatformAudit) private readonly audit: PlatformAudit,
    @Inject(PlatformAuth) private readonly auth: PlatformAuth,
    @Inject(AuditService) private readonly clientAudit: AuditService,
  ) {}

  private who(req: AdminRequest) {
    const a = req.admin!;
    return { adminId: a.id, adminEmail: a.email, ip: req.ip ?? null, sessionId: a.sid };
  }

  // ------------------------------------------------------------------------------------------------ me and sessions

  @Get("me")
  me(@Req() req: AdminRequest) {
    const a = req.admin!;
    return {
      id: a.id, email: a.email, displayName: a.displayName, role: a.role, roleLabel: PLATFORM_ROLE_LABEL[a.role as keyof typeof PLATFORM_ROLE_LABEL] ?? a.role,
      perms: [...a.perms], mustChangePassword: a.mustChangePassword, steppedUp: !!a.steppedUpAt && Date.now() - new Date(a.steppedUpAt).getTime() < 10 * 60_000,
    };
  }

  /** Enter a fresh authenticator code to unlock the sensitive actions for ten minutes. */
  @Post("stepup")
  @HttpCode(200)
  async stepUp(@Req() req: AdminRequest, @Body() b: { code?: unknown }) {
    const a = requireAdminPerm(req);
    if (typeof b?.code !== "string") throw new BadRequestException("code is required");
    const row = (await withPlatform(this.pool, (c) => c.query("SELECT id, totp_secret, last_step, recovery_hashes, failed_attempts, locked_until FROM platform_admins WHERE id = $1", [a.id]))).rows[0];
    if (!row) throw new ForbiddenException();
    if (!(await this.auth.checkCode(row, b.code))) {
      await withPlatform(this.pool, async (c) => {
        const n = (await c.query<{ failed_attempts: number }>("UPDATE platform_admins SET failed_attempts = failed_attempts + 1 WHERE id = $1 RETURNING failed_attempts", [a.id])).rows[0]!.failed_attempts;
        // Too many wrong codes ends the session as well as locking the account, so a stolen token cannot guess codes.
        if (n >= 5) {
          await c.query("UPDATE platform_admins SET failed_attempts = 0, locked_until = now() + interval '15 minutes' WHERE id = $1", [a.id]);
          await c.query("UPDATE platform_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL", [a.id]);
        }
        await this.audit.recordIn(c, { ...this.who(req), action: "stepup.failed", status: 403 });
      });
      throw new ForbiddenException("that code is not right");
    }
    await withPlatform(this.pool, async (c) => {
      await c.query("UPDATE platform_admins SET failed_attempts = 0 WHERE id = $1", [a.id]);
      await c.query("UPDATE platform_sessions SET stepped_up_at = now() WHERE id = $1", [a.sid]);
      await this.audit.recordIn(c, { ...this.who(req), action: "stepup", status: 200 });
    });
    return { ok: true };
  }

  @Post("logout")
  @HttpCode(200)
  async logout(@Req() req: AdminRequest) {
    await withPlatform(this.pool, async (c) => {
      await c.query("UPDATE platform_sessions SET revoked_at = now() WHERE id = $1", [req.admin!.sid]);
      await this.audit.recordIn(c, { ...this.who(req), action: "logout", status: 200 });
    });
    return { ok: true };
  }

  @Post("me/password")
  @HttpCode(200)
  async password(@Req() req: AdminRequest, @Body() b: { current?: unknown; next?: unknown }) {
    const a = req.admin!;
    if (typeof b?.current !== "string" || typeof b?.next !== "string") throw new BadRequestException("current and next are required");
    // Staff passwords are held to a higher bar than clients': 14 or more characters.
    if (b.next.length < 14 || b.next.length > 200) throw new BadRequestException("use 14 to 200 characters");
    const bad = passwordProblem(b.next, { email: a.email, name: a.displayName ?? "" });
    if (bad) throw new BadRequestException(bad === "common" ? "that password is too common" : bad === "personal" ? "do not use your name or email" : "choose a different password");
    const row = (await withPlatform(this.pool, (c) => c.query("SELECT password_hash FROM platform_admins WHERE id = $1", [a.id]))).rows[0];
    if (!row || !(await verifyPassword(b.current, row.password_hash))) throw new ForbiddenException("your current password is not right");
    const hash = await hashPassword(b.next);
    await withPlatform(this.pool, async (c) => {
      await c.query("UPDATE platform_admins SET password_hash = $2, must_change_password = false WHERE id = $1", [a.id, hash]);
      await c.query("UPDATE platform_sessions SET revoked_at = now() WHERE admin_id = $1 AND id <> $2 AND revoked_at IS NULL", [a.id, a.sid]);
      await this.audit.recordIn(c, { ...this.who(req), action: "password.changed", status: 200 });
    });
    return { ok: true };
  }

  // ------------------------------------------------------------------------------------------------ catalog and overview

  @Get("catalog")
  catalog(@Req() req: AdminRequest) {
    requireAdminPerm(req);
    return {
      sections: SECTIONS, core: CORE_FEATURES, presets: PRESETS,
      plans: PLAN_IDS.map((id) => PLANS[id]),
      roles: PLATFORM_ROLES.map((r) => ({ id: r, label: PLATFORM_ROLE_LABEL[r], perms: PLATFORM_ROLE_PERMISSIONS[r] })),
      impersonationMinutes: IMPERSONATION_MINUTES,
    };
  }

  private async clients(): Promise<ReturnType<typeof shape>[]> {
    return withPlatform(this.pool, async (c) => {
      const orgs = (await c.query<OrgRow>(`${ORG_SELECT} ORDER BY lower(o.name)`)).rows;
      const stats = new Map((await c.query<Stats>("SELECT * FROM platform_org_stats()")).rows.map((s) => [s.org_id, s]));
      return orgs.map((o) => shape(o, stats.get(o.id)));
    });
  }

  @Get("overview")
  async overview(@Req() req: AdminRequest) {
    requireAdminPerm(req, "monitor.view");
    const all = await this.clients();
    const sum = (f: (c: (typeof all)[number]) => number) => all.reduce((n, c) => n + f(c), 0);
    const rank = { bad: 0, warn: 1, ok: 2, off: 3 } as const;
    const attention = all.filter((c) => c.health.level === "bad" || c.health.level === "warn").sort((a, b) => rank[a.health.level] - rank[b.health.level] || a.name.localeCompare(b.name)).slice(0, 12);
    const live = (await withPlatform(this.pool, (c) => c.query("SELECT count(*)::int AS n FROM platform_impersonations WHERE ended_at IS NULL AND expires_at > now()"))).rows[0].n as number;
    return {
      clients: { total: all.length, active: all.filter((c) => c.status === "active").length, suspended: all.filter((c) => c.status === "suspended").length, restricted: all.filter((c) => c.entitlements.restricted).length, trials: all.filter((c) => c.plan === "trial" && c.status === "active").length },
      fleet: { vehicles: sum((c) => c.usage.vehicles), devices: sum((c) => c.usage.devices), reportingNow: sum((c) => c.usage.devicesLive), reporting24h: sum((c) => c.usage.devicesRecent), users: sum((c) => c.usage.users) },
      health: { ok: all.filter((c) => c.health.level === "ok").length, warn: all.filter((c) => c.health.level === "warn").length, bad: all.filter((c) => c.health.level === "bad").length },
      attention, activeStaffViews: live,
    };
  }

  // ------------------------------------------------------------------------------------------------ clients

  @Get("clients")
  async list(@Req() req: AdminRequest, @Query("q") q?: string, @Query("status") status?: string, @Query("health") health?: string) {
    requireAdminPerm(req, "clients.view");
    let rows = await this.clients();
    const needle = (q ?? "").trim().toLowerCase().slice(0, 80);
    if (needle) rows = rows.filter((c) => c.name.toLowerCase().includes(needle) || c.slug.includes(needle) || (c.ownerEmail ?? "").toLowerCase().includes(needle));
    if (status === "active" || status === "suspended") rows = rows.filter((c) => c.status === status);
    if (health === "ok" || health === "warn" || health === "bad") rows = rows.filter((c) => c.health.level === health);
    return rows;
  }

  @Get("clients/:id")
  async detail(@Req() req: AdminRequest, @Param("id") id: string) {
    requireAdminPerm(req, "clients.view");
    const orgId = parseUuid(id);
    const base = await withPlatform(this.pool, async (c) => {
      const o = (await c.query<OrgRow>(`${ORG_SELECT} WHERE o.id = $1`, [orgId])).rows[0];
      if (!o) throw new NotFoundException("no such client");
      const s = (await c.query<Stats>("SELECT * FROM platform_org_stats() WHERE org_id = $1", [orgId])).rows[0];
      const settings = (await c.query("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0]?.settings ?? {};
      const staffActions = (await c.query("SELECT id, at, admin_email AS \"adminEmail\", action, reason, target FROM platform_audit WHERE org_id = $1 ORDER BY id DESC LIMIT 15", [orgId])).rows;
      const views = (await c.query(
        `SELECT i.id, i.started_at AS "startedAt", i.expires_at AS "expiresAt", i.ended_at AS "endedAt", i.reason, i.requests, i.blocked_writes AS "blockedWrites", a.email AS "adminEmail"
         FROM platform_impersonations i JOIN platform_admins a ON a.id = i.admin_id WHERE i.org_id = $1 ORDER BY i.started_at DESC LIMIT 10`, [orgId])).rows;
      await this.audit.recordIn(c, { ...this.who(req), action: "client.viewed", orgId, orgName: o.name, status: 200 });
      return { o, s, notes: o.internal_notes, staffAccess: (settings as { privacy?: { staffAccess?: boolean } }).privacy?.staffAccess !== false, staffActions, views };
    });
    // What staff see here is the account's frame: people, tracker counts and sign-in times. Positions, trips, pay and customer data
    // are only reachable through a logged "view as" session.
    const inside = await withOrg(this.pool, orgId, async (c) => {
      const users = (await c.query(
        `SELECT u.id, u.email, u.display_name AS "displayName", u.role, (u.disabled_at IS NOT NULL) AS disabled, u.created_at AS "createdAt",
                (SELECT max(s.created_at) FROM user_sessions s WHERE s.user_id = u.id) AS "lastSignIn",
                coalesce((SELECT us.totp_enabled_at IS NOT NULL FROM user_security us WHERE us.user_id = u.id), false) AS "twoFactor"
         FROM users u WHERE u.role <> 'customer' ORDER BY u.role = 'owner' DESC, u.created_at LIMIT 200`)).rows;
      const methods = (await c.query(`SELECT coalesce(connection_method, source) AS method, count(*)::int AS n FROM devices GROUP BY 1 ORDER BY 2 DESC`)).rows;
      return { users, methods };
    });
    return { ...shape(base.o, base.s), internalNotes: base.notes, staffAccessAllowed: base.staffAccess, users: inside.users, trackerMethods: inside.methods, staffActions: base.staffActions, staffViews: base.views };
  }

  @Post("clients")
  @HttpCode(201)
  async create(@Req() req: AdminRequest, @Body() b: Record<string, unknown>) {
    const a = requireAdminPerm(req, "clients.create");
    requireStepUp(req);
    const name = text(b?.name, "name", 2, 100);
    const ownerEmail = text(b?.ownerEmail, "ownerEmail", 3, 200).toLowerCase();
    if (!EMAIL.test(ownerEmail)) throw new BadRequestException("a valid owner email is required");
    const ownerName = text(b?.ownerName, "ownerName", 1, 80);
    const plan = (b.plan === undefined ? "trial" : b.plan) as PlanId;
    if (!PLAN_IDS.includes(plan)) throw new BadRequestException("unknown plan");
    const locale = b.locale === "fr" ? "fr" : "en";
    const timezone = typeof b.timezone === "string" ? b.timezone : "America/Toronto";
    try { new Intl.DateTimeFormat("en", { timeZone: timezone }); } catch { throw new BadRequestException("unknown time zone"); }
    const sections = this.parseSections(b);
    const limits = this.parseLimits(b.limits);
    const existing = (await this.pool.query("SELECT 1 FROM find_login($1)", [ownerEmail])).rowCount;
    if (existing) throw new ConflictException("that email already has an account");
    const token = randomBytes(32).toString("base64url");
    const unusable = await hashPassword(randomBytes(32).toString("base64url"));
    let out: { id: string; slug: string };
    try {
      out = await withPlatform(this.pool, async (c) => {
        let slug = slugify(name);
        for (let n = 2; (await c.query("SELECT slug_taken($1) AS t", [slug])).rows[0].t; n++) { slug = `${slugify(name).slice(0, 36)}-${n}`; if (n > 50) throw new ConflictException("could not make a unique short name"); }
        const org = (await c.query<{ id: string }>("INSERT INTO organizations (name, locale, timezone, plan, slug) VALUES ($1,$2,$3,$4,$5) RETURNING id", [name, locale, timezone, plan, slug])).rows[0]!;
        await c.query("INSERT INTO org_entitlements (org_id, sections, limits, updated_by) VALUES ($1,$2,$3,$4)", [org.id, sections, JSON.stringify(limits), a.id]);
        // The new organization's first user is written as that organization (its own row-level policy), in the same transaction.
        await c.query("SELECT set_config('app.org_id', $1, true)", [org.id]);
        await c.query("INSERT INTO users (org_id, email, password_hash, role, locale, display_name) VALUES ($1,$2,$3,'owner',$4,$5)", [org.id, ownerEmail, unusable, locale, ownerName]);
        await c.query("SELECT * FROM start_password_reset($1,$2, now() + interval '7 days')", [ownerEmail, sha(token)]);
        await this.audit.recordIn(c, { ...this.who(req), action: "client.created", orgId: org.id, orgName: name, detail: { plan, sections, limits, ownerEmail }, status: 201 });
        return { id: org.id, slug };
      });
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ConflictException("that email already has an account");
      throw e;
    }
    const base = (process.env.APP_URL ?? process.env.WEB_ORIGIN?.split(",")[0] ?? "http://localhost:3000").replace(/\/$/, "");
    await this.clientAudit.record({ orgId: out.id, actorId: null, actorLabel: staffLabel(a), action: "staff.client.created", entity: "organization", entityId: out.id, detail: { sections } });
    // No email is sent from here (email delivery is not connected), so the link is handed to the staff member once, to pass on.
    return { id: out.id, slug: out.slug, setupLink: `${base}/reset/${token}`, setupLinkValidDays: 7 };
  }

  @Patch("clients/:id")
  async update(@Req() req: AdminRequest, @Param("id") id: string, @Body() b: Record<string, unknown>) {
    const a = requireAdminPerm(req, "clients.edit");
    const orgId = parseUuid(id);
    const set: string[] = []; const args: unknown[] = [orgId]; const changed: Record<string, unknown> = {};
    const add = (col: string, key: string, v: unknown) => { args.push(v); set.push(`${col} = $${args.length}`); changed[key] = v; };
    if (b.name !== undefined) add("name", "name", text(b.name, "name", 2, 100));
    if (b.plan !== undefined) { if (!PLAN_IDS.includes(b.plan as PlanId)) throw new BadRequestException("unknown plan"); add("plan", "plan", b.plan); }
    if (b.trialEndsAt !== undefined) {
      const d = new Date(String(b.trialEndsAt));
      if (Number.isNaN(d.getTime())) throw new BadRequestException("trialEndsAt must be a date");
      add("trial_ends_at", "trialEndsAt", d.toISOString());
    }
    if (b.internalNotes !== undefined) add("internal_notes", "internalNotes", b.internalNotes === null || b.internalNotes === "" ? null : text(b.internalNotes, "internalNotes", 1, 4000));
    if (!set.length) throw new BadRequestException("nothing to change");
    await withPlatform(this.pool, async (c) => {
      const before = (await c.query("SELECT name, plan, trial_ends_at AS \"trialEndsAt\" FROM organizations WHERE id = $1", [orgId])).rows[0];
      if (!before) throw new NotFoundException("no such client");
      await c.query(`UPDATE organizations SET ${set.join(", ")} WHERE id = $1`, args);
      await this.audit.recordIn(c, { ...this.who(req), action: "client.updated", orgId, orgName: (changed.name as string | undefined) ?? before.name, detail: { before, after: { ...changed, internalNotes: "internalNotes" in changed ? "[changed]" : undefined } }, status: 200 });
    });
    if ("plan" in changed) await this.clientAudit.record({ orgId, actorLabel: staffLabel(a), action: "staff.plan.changed", entity: "organization", entityId: orgId, detail: { plan: changed.plan } });
    return { ok: true };
  }

  private parseSections(b: Record<string, unknown>): SectionId[] {
    if (typeof b.preset === "string") {
      const p = PRESETS.find((x) => x.id === b.preset);
      if (!p) throw new BadRequestException("unknown preset");
      return [...p.sections];
    }
    if (b.sections === undefined) return [...SECTION_IDS];
    if (!Array.isArray(b.sections) || !b.sections.every((s) => typeof s === "string")) throw new BadRequestException("sections must be a list of section names");
    const bad = (b.sections as string[]).filter((s) => !(SECTION_IDS as readonly string[]).includes(s));
    if (bad.length) throw new BadRequestException(`unknown section: ${bad[0]}`);
    return SECTION_IDS.filter((s) => (b.sections as string[]).includes(s));
  }

  private parseLimits(v: unknown): { vehicles?: number; users?: number } {
    if (v === undefined || v === null) return {};
    if (typeof v !== "object" || Array.isArray(v)) throw new BadRequestException("limits must be an object");
    const out: { vehicles?: number; users?: number } = {};
    for (const k of ["vehicles", "users"] as const) {
      const x = (v as Record<string, unknown>)[k];
      if (x === undefined || x === null || x === "") continue;
      if (typeof x !== "number" || !Number.isInteger(x) || x < 0 || x > 100_000) throw new BadRequestException(`${k} limit must be a whole number from 0 to 100000`);
      out[k] = x;
    }
    return out;
  }

  /** Choose which sections a client has and its hard limits. Takes effect on the client's very next request. */
  @Put("clients/:id/access")
  async setAccess(@Req() req: AdminRequest, @Param("id") id: string, @Body() b: Record<string, unknown>) {
    const a = requireAdminPerm(req, "clients.access");
    requireStepUp(req);
    const orgId = parseUuid(id);
    const sections = this.parseSections(b);
    const limits = this.parseLimits(b.limits);
    const reason = typeof b.reason === "string" && b.reason.trim() ? text(b.reason, "reason", 3, 500) : null;
    const result = await withPlatform(this.pool, async (c) => {
      const o = (await c.query<OrgRow>(`${ORG_SELECT} WHERE o.id = $1`, [orgId])).rows[0];
      if (!o) throw new NotFoundException("no such client");
      const before = resolveEntitlements(o.sections ? { sections: o.sections, limits: o.limits } : null);
      await c.query(
        `INSERT INTO org_entitlements (org_id, sections, limits, updated_by, updated_at) VALUES ($1,$2,$3,$4, now())
         ON CONFLICT (org_id) DO UPDATE SET sections = EXCLUDED.sections, limits = EXCLUDED.limits, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [orgId, sections, JSON.stringify(limits), a.id]);
      const after = resolveEntitlements({ sections, limits });
      const added = after.sections.filter((s) => !before.sections.includes(s));
      const removed = before.sections.filter((s) => !after.sections.includes(s));
      await this.audit.recordIn(c, { ...this.who(req), action: "client.access.changed", orgId, orgName: o.name, reason, detail: { added, removed, limits: after.limits, previousLimits: before.limits }, status: 200 });
      return { name: o.name, added, removed, entitlements: after };
    });
    await this.clientAudit.record({ orgId, actorLabel: staffLabel(a), action: "staff.access.changed", entity: "organization", entityId: orgId, detail: { added: result.added, removed: result.removed, limits: result.entitlements.limits } });
    return { ok: true, entitlements: result.entitlements, added: result.added, removed: result.removed };
  }

  @Post("clients/:id/suspend")
  @HttpCode(200)
  async suspend(@Req() req: AdminRequest, @Param("id") id: string, @Body() b: { reason?: unknown }) {
    const a = requireAdminPerm(req, "clients.suspend");
    requireStepUp(req);
    const orgId = parseUuid(id);
    const reason = reasonOf(b?.reason);
    await withPlatform(this.pool, async (c) => {
      const o = (await c.query("UPDATE organizations SET status = 'suspended', suspended_at = now(), suspended_reason = $2 WHERE id = $1 AND status <> 'suspended' RETURNING name", [orgId, reason])).rows[0];
      if (!o) {
        const exists = (await c.query("SELECT 1 FROM organizations WHERE id = $1", [orgId])).rowCount;
        if (!exists) throw new NotFoundException("no such client");
        throw new ConflictException("already suspended");
      }
      // Open "view as" sessions for a suspended client keep working only if staff started them; end the rest of the client's own sign-ins.
      await this.audit.recordIn(c, { ...this.who(req), action: "client.suspended", orgId, orgName: o.name, reason, status: 200 });
    });
    await this.clientAudit.record({ orgId, actorLabel: staffLabel(a), action: "staff.account.suspended", entity: "organization", entityId: orgId, detail: { reason } });
    return { ok: true };
  }

  @Post("clients/:id/reinstate")
  @HttpCode(200)
  async reinstate(@Req() req: AdminRequest, @Param("id") id: string, @Body() b: { reason?: unknown }) {
    const a = requireAdminPerm(req, "clients.suspend");
    requireStepUp(req);
    const orgId = parseUuid(id);
    const reason = reasonOf(b?.reason);
    await withPlatform(this.pool, async (c) => {
      const o = (await c.query("UPDATE organizations SET status = 'active', suspended_at = NULL, suspended_reason = NULL WHERE id = $1 AND status = 'suspended' RETURNING name", [orgId])).rows[0];
      if (!o) throw new NotFoundException("no suspended client with that id");
      await this.audit.recordIn(c, { ...this.who(req), action: "client.reinstated", orgId, orgName: o.name, reason, status: 200 });
    });
    await this.clientAudit.record({ orgId, actorLabel: staffLabel(a), action: "staff.account.reinstated", entity: "organization", entityId: orgId, detail: { reason } });
    return { ok: true };
  }

  // ------------------------------------------------------------------------------------------------ view as client

  /**
   * Opens a short, read-only session as one of the client's own people. A written reason is required, the client's own audit
   * log records that it happened, the client can switch this off in its privacy settings, and the page shows a banner.
   */
  @Post("clients/:id/view-as")
  @HttpCode(201)
  async viewAs(@Req() req: AdminRequest, @Param("id") id: string, @Body() b: { reason?: unknown; ticket?: unknown; userId?: unknown }) {
    const a = requireAdminPerm(req, "impersonate.view");
    requireStepUp(req);
    const orgId = parseUuid(id);
    const reason = reasonOf(b?.reason);
    const ticket = b?.ticket === undefined || b.ticket === "" ? null : text(b.ticket, "ticket", 1, 80);
    const org = (await withPlatform(this.pool, (c) => c.query("SELECT name, status, settings FROM organizations WHERE id = $1", [orgId]))).rows[0];
    if (!org) throw new NotFoundException("no such client");
    if ((org.settings as { privacy?: { staffAccess?: boolean } } | null)?.privacy?.staffAccess === false) {
      await this.audit.record({ ...this.who(req), action: "view_as.refused_by_client", orgId, orgName: org.name, reason, status: 403 });
      throw new ForbiddenException({ message: "this client has turned off staff access in its privacy settings", code: "staff_access_off" });
    }
    const target = (await withOrg(this.pool, orgId, (c) => b?.userId
      ? c.query("SELECT id, email, display_name, role FROM users WHERE id = $1 AND disabled_at IS NULL AND role <> 'customer'", [parseUuid(String(b.userId))])
      : c.query("SELECT id, email, display_name, role FROM users WHERE role = 'owner' AND disabled_at IS NULL ORDER BY created_at LIMIT 1"))).rows[0];
    if (!target) throw new NotFoundException("that client has no one to view as");
    const row = await withPlatform(this.pool, async (c) => {
      const r = (await c.query<{ id: string; expires_at: Date }>(
        `INSERT INTO platform_impersonations (admin_id, admin_session_id, org_id, user_id, reason, ticket, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6, now() + make_interval(mins => $7)) RETURNING id, expires_at`,
        [a.id, a.sid, orgId, target.id, reason, ticket, IMPERSONATION_MINUTES])).rows[0]!;
      await this.audit.recordIn(c, { ...this.who(req), action: "view_as.started", orgId, orgName: org.name, target: `${target.email} (${target.role})`, reason, detail: { ticket, minutes: IMPERSONATION_MINUTES, readOnly: true }, status: 201 });
      return r;
    });
    await this.clientAudit.record({ orgId, actorLabel: staffLabel(a), action: "staff.access.started", entity: "organization", entityId: orgId, detail: { reason, ticket, viewingAs: target.role, minutes: IMPERSONATION_MINUTES, readOnly: true } });
    const token = await signSession(this.secret, { userId: target.id, orgId, role: target.role, imp: row.id }, `${IMPERSONATION_MINUTES}m`);
    return { token, expiresAt: row.expires_at, impersonationId: row.id, client: { id: orgId, name: org.name }, viewingAs: { id: target.id, email: target.email, role: target.role } };
  }

  @Post("view-as/:id/end")
  @HttpCode(200)
  async endViewAs(@Req() req: AdminRequest, @Param("id") id: string) {
    const a = req.admin!;
    const iid = parseUuid(id);
    const row = (await withPlatform(this.pool, (c) => c.query("SELECT admin_id FROM platform_impersonations WHERE id = $1", [iid]))).rows[0];
    if (!row) throw new NotFoundException();
    // Anyone with the right to open a view may close any open one, so a colleague can end a session that was left running.
    requireAdminPerm(req, "impersonate.view");
    await this.auth.endImpersonation(iid, `${a.email}`);
    return { ok: true };
  }

  @Get("view-as")
  async views(@Req() req: AdminRequest, @Query("active") active?: string) {
    requireAdminPerm(req, "audit.view");
    return (await withPlatform(this.pool, (c) => c.query(
      `SELECT i.id, o.id AS "orgId", o.name AS "orgName", a.email AS "adminEmail", i.reason, i.ticket, i.started_at AS "startedAt", i.expires_at AS "expiresAt", i.ended_at AS "endedAt",
              i.requests, i.blocked_writes AS "blockedWrites", i.paths
       FROM platform_impersonations i JOIN platform_admins a ON a.id = i.admin_id JOIN organizations o ON o.id = i.org_id
       ${active === "1" ? "WHERE i.ended_at IS NULL AND i.expires_at > now()" : ""} ORDER BY i.started_at DESC LIMIT 100`))).rows;
  }

  // ------------------------------------------------------------------------------------------------ audit and lookups

  @Get("audit")
  async auditLog(@Req() req: AdminRequest, @Query() q: Record<string, string | undefined>) {
    requireAdminPerm(req, "audit.view");
    const where: string[] = []; const args: unknown[] = [];
    const eq = (col: string, v: string | undefined) => { if (v) { args.push(v); where.push(`${col} = $${args.length}`); } };
    if (q.org) eq("org_id", parseUuid(q.org));
    eq("admin_email", q.admin?.slice(0, 200));
    if (q.action) { args.push(`${q.action.slice(0, 60).replace(/[\\%_]/g, "")}%`); where.push(`action LIKE $${args.length}`); }
    if (q.before && /^\d{1,18}$/.test(q.before)) { args.push(q.before); where.push(`id < $${args.length}`); }
    const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 200);
    const rows = (await withPlatform(this.pool, (c) => c.query(
      `SELECT id::text, at, admin_email AS "adminEmail", action, org_id AS "orgId", org_name AS "orgName", target, reason, detail, status, ip
       FROM platform_audit ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY id DESC LIMIT ${limit}`, args))).rows;
    return { rows, next: rows.length === limit ? rows[rows.length - 1].id : null };
  }

  /** Which client holds a tracker ID. For settling "two companies claim the same tracker" without opening either company's devices. */
  @Get("devices/lookup")
  async lookupDevice(@Req() req: AdminRequest, @Query("source") source?: string, @Query("id") id?: string) {
    requireAdminPerm(req, "clients.view");
    if (!source || !["traccar", "geotab", "samsara", "terminal", "simulator"].includes(source)) throw new BadRequestException("source must be traccar, geotab, samsara, terminal or simulator");
    if (!id || id.length > 100) throw new BadRequestException("id is required");
    const rows = await withPlatform(this.pool, async (c) => {
      const r = (await c.query(`SELECT org_id AS "orgId", org_name AS "orgName", device_id AS "deviceId", connection_method AS "method", registered_at AS "registeredAt", last_position_at AS "lastPositionAt" FROM platform_find_device($1,$2)`, [source, id])).rows;
      await this.audit.recordIn(c, { ...this.who(req), action: "device.lookup", target: `${source}:${id}`, detail: { found: r.length }, status: 200 });
      return r;
    });
    return { found: rows.length > 0, holder: rows[0] ?? null };
  }

  // ------------------------------------------------------------------------------------------------ staff accounts

  @Get("admins")
  async admins(@Req() req: AdminRequest) {
    requireAdminPerm(req, "admins.manage");
    return (await withPlatform(this.pool, (c) => c.query(
      `SELECT a.id, a.email, a.display_name AS "displayName", a.role, a.ip_allow_list AS "ipAllowList", (a.disabled_at IS NOT NULL) AS disabled,
              (a.locked_until IS NOT NULL AND a.locked_until > now()) AS locked, a.last_login_at AS "lastLoginAt", a.must_change_password AS "mustChangePassword", a.created_at AS "createdAt",
              (SELECT count(*)::int FROM platform_sessions s WHERE s.admin_id = a.id AND s.revoked_at IS NULL AND s.last_seen_at > now() - interval '30 minutes') AS "activeSessions"
       FROM platform_admins a ORDER BY lower(a.email)`))).rows;
  }

  private async setupPackage(email: string) {
    const seed = newSecret();
    const codes = newRecoveryCodes();
    const temp = randomBytes(15).toString("base64url");
    return { seed, codes, temp, view: { temporaryPassword: temp, totpSecret: seed, otpauth: otpauthUrl(seed, email, "RouteNorth Admin"), recoveryCodes: codes } };
  }

  /** The new person gets a temporary password and an authenticator secret, shown once. They must choose their own password at first sign-in. */
  @Post("admins")
  @HttpCode(201)
  async createAdmin(@Req() req: AdminRequest, @Body() b: Record<string, unknown>) {
    requireAdminPerm(req, "admins.manage");
    requireStepUp(req);
    const email = text(b?.email, "email", 3, 200).toLowerCase();
    if (!EMAIL.test(email)) throw new BadRequestException("a valid email is required");
    const displayName = text(b?.displayName, "displayName", 1, 80);
    if (!isPlatformRole(b.role)) throw new BadRequestException("unknown role");
    const ips = this.parseIps(b.ipAllowList);
    if ((await this.pool.query("SELECT 1 FROM find_login($1)", [email])).rowCount) throw new ConflictException("that email already has a client account");
    const pkg = await this.setupPackage(email);
    const hash = await hashPassword(pkg.temp);
    const id = await withPlatform(this.pool, async (c) => {
      try {
        const r = await c.query<{ id: string }>(
          `INSERT INTO platform_admins (email, display_name, password_hash, role, totp_secret, recovery_hashes, must_change_password, ip_allow_list, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,true,$7,$8) RETURNING id`,
          [email, displayName, hash, b.role, encryptSecret(this.secret, pkg.seed), pkg.codes.map(hashRecovery), ips, req.admin!.id]);
        await this.audit.recordIn(c, { ...this.who(req), action: "admin.created", target: email, detail: { role: b.role, ipAllowList: ips }, status: 201 });
        return r.rows[0]!.id;
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new ConflictException("a staff account with that email already exists");
        throw e;
      }
    });
    return { id, setup: pkg.view };
  }

  private parseIps(v: unknown): string[] {
    if (v === undefined || v === null) return [];
    if (!Array.isArray(v) || v.length > 20 || !v.every((x) => typeof x === "string" && /^[0-9a-fA-F.:/]{3,50}$/.test(x))) throw new BadRequestException("ipAllowList must be a list of addresses or ranges");
    return v as string[];
  }

  @Patch("admins/:id")
  async updateAdmin(@Req() req: AdminRequest, @Param("id") id: string, @Body() b: Record<string, unknown>) {
    const me = requireAdminPerm(req, "admins.manage");
    requireStepUp(req);
    const adminId = parseUuid(id);
    const set: string[] = []; const args: unknown[] = [adminId]; const changed: Record<string, unknown> = {};
    const add = (col: string, key: string, v: unknown) => { args.push(v); set.push(`${col} = $${args.length}`); changed[key] = v; };
    if (b.role !== undefined) { if (!isPlatformRole(b.role)) throw new BadRequestException("unknown role"); add("role", "role", b.role); }
    if (b.displayName !== undefined) add("display_name", "displayName", text(b.displayName, "displayName", 1, 80));
    if (b.ipAllowList !== undefined) add("ip_allow_list", "ipAllowList", this.parseIps(b.ipAllowList));
    if (b.disabled !== undefined) { set.push(`disabled_at = ${b.disabled ? "now()" : "NULL"}`); changed.disabled = !!b.disabled; }
    if (!set.length) throw new BadRequestException("nothing to change");
    if (adminId === me.id && (changed.role !== undefined || changed.disabled === true)) throw new ForbiddenException("you cannot change your own role or disable yourself");
    await withPlatform(this.pool, async (c) => {
      const cur = (await c.query("SELECT email, role, disabled_at FROM platform_admins WHERE id = $1 FOR UPDATE", [adminId])).rows[0];
      if (!cur) throw new NotFoundException("no such staff account");
      const losesSuper = cur.role === "super_admin" && !cur.disabled_at && ((changed.role !== undefined && changed.role !== "super_admin") || changed.disabled === true);
      if (losesSuper) {
        const others = (await c.query("SELECT count(*)::int AS n FROM platform_admins WHERE role = 'super_admin' AND disabled_at IS NULL AND id <> $1", [adminId])).rows[0].n as number;
        if (others === 0) throw new ConflictException("there must always be one active super admin");
      }
      await c.query(`UPDATE platform_admins SET ${set.join(", ")} WHERE id = $1`, args);
      // A change of role or access takes effect now: their sessions end and they sign in again.
      if (changed.role !== undefined || changed.disabled === true) await c.query("UPDATE platform_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL", [adminId]);
      await this.audit.recordIn(c, { ...this.who(req), action: "admin.updated", target: cur.email, detail: { before: { role: cur.role, disabled: !!cur.disabled_at }, changed }, status: 200 });
    });
    return { ok: true };
  }

  /** Lost phone: new temporary password and a new authenticator secret, old sessions ended. Shown once. */
  @Post("admins/:id/reset-credentials")
  @HttpCode(200)
  async resetCredentials(@Req() req: AdminRequest, @Param("id") id: string) {
    requireAdminPerm(req, "admins.manage");
    requireStepUp(req);
    const adminId = parseUuid(id);
    const email = (await withPlatform(this.pool, (c) => c.query("SELECT email FROM platform_admins WHERE id = $1", [adminId]))).rows[0]?.email as string | undefined;
    if (!email) throw new NotFoundException("no such staff account");
    const pkg = await this.setupPackage(email);
    const hash = await hashPassword(pkg.temp);
    await withPlatform(this.pool, async (c) => {
      await c.query(
        `UPDATE platform_admins SET password_hash = $2, totp_secret = $3, recovery_hashes = $4, last_step = NULL, must_change_password = true, failed_attempts = 0, locked_until = NULL WHERE id = $1`,
        [adminId, hash, encryptSecret(this.secret, pkg.seed), pkg.codes.map(hashRecovery)]);
      await c.query("UPDATE platform_sessions SET revoked_at = now() WHERE admin_id = $1 AND revoked_at IS NULL", [adminId]);
      await this.audit.recordIn(c, { ...this.who(req), action: "admin.credentials_reset", target: email, status: 200 });
    });
    return { setup: pkg.view };
  }

  @Post("admins/:id/unlock")
  @HttpCode(200)
  async unlock(@Req() req: AdminRequest, @Param("id") id: string) {
    requireAdminPerm(req, "admins.manage");
    requireStepUp(req);
    const adminId = parseUuid(id);
    await withPlatform(this.pool, async (c) => {
      const r = (await c.query("UPDATE platform_admins SET failed_attempts = 0, locked_until = NULL WHERE id = $1 RETURNING email", [adminId])).rows[0];
      if (!r) throw new NotFoundException("no such staff account");
      await this.audit.recordIn(c, { ...this.who(req), action: "admin.unlocked", target: r.email, status: 200 });
    });
    return { ok: true };
  }
}
