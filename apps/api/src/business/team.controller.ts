import { createHash, randomBytes } from "node:crypto";
import {
  BadRequestException, Body, ConflictException, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Put, Req, UseGuards,
} from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { effectivePermissions, homePath, INVITE_ROLES, LOCALES } from "@routenorth/shared";
import { AuthGuard, requireAny, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { startSession } from "../security/sessions.js";
import { webUrl } from "../customer/links.js";
import { parseUuid } from "../history/range.js";
import { deliver, type Providers } from "../notify/notifier.js";
import { withDefaults } from "../org/settings.js";
import { hashPassword } from "../passwords.js";
import { JWT_SECRET, NOTIFY, PG_POOL } from "../tokens.js";
import { ensureSteps } from "../portal/drivers.service.js";
import { addNotification } from "./notifications.js";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KINDS = ["team", "region", "depot_group"];
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

/** Teams, regions and depot groups. People and vehicles can belong to one, and lists can be filtered by it. */
@Controller("teams")
@UseGuards(AuthGuard)
export class TeamsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "users.view", "fleet.view", "routes.view");
    return withOrg(this.pool, orgId, async (c) => {
      const teams = (await c.query(
        `SELECT t.id, t.name, t.kind, t.depot_id AS "depotId", d.name AS "depotName", t.color, t.notes,
                (SELECT count(*)::int FROM vehicles v WHERE v.team_id = t.id) AS "vehicleCount",
                (SELECT count(*)::int FROM jobs j WHERE j.team_id = t.id AND j.status NOT IN ('done','failed','cancelled')) AS "openJobs"
         FROM teams t LEFT JOIN depots d ON d.id = t.depot_id AND d.org_id = t.org_id ORDER BY t.kind, t.name`)).rows;
      const members = (await c.query(`SELECT m.team_id AS "teamId", u.id, coalesce(u.display_name, u.email) AS name, u.role FROM team_members m JOIN users u ON u.id = m.user_id AND u.org_id = m.org_id WHERE u.disabled_at IS NULL ORDER BY name`)).rows;
      return teams.map((t) => ({ ...t, members: members.filter((m) => m.teamId === t.id).map(({ id, name, role }) => ({ id, name, role })) }));
    });
  }

  private fields(b: Record<string, unknown>, creating: boolean) {
    const out: Record<string, unknown> = {};
    if (creating || b.name !== undefined) {
      if (typeof b.name !== "string" || !b.name.trim() || b.name.length > 120) throw new BadRequestException("name is required (up to 120 characters)");
      out.name = b.name.trim();
    }
    if (b.kind !== undefined) { if (!KINDS.includes(String(b.kind))) throw new BadRequestException(`kind must be ${KINDS.join(", ")}`); out.kind = b.kind; }
    if (b.depotId !== undefined) out.depot_id = b.depotId ? parseUuid(String(b.depotId)) : null;
    if (b.color !== undefined) { if (b.color !== null && b.color !== "" && !/^#[0-9a-fA-F]{6}$/.test(String(b.color))) throw new BadRequestException("color must look like #1a2b3c"); out.color = b.color || null; }
    if (b.notes !== undefined) { if (b.notes !== null && String(b.notes).length > 1000) throw new BadRequestException("notes are up to 1000 characters"); out.notes = b.notes || null; }
    return out;
  }

  private async write(c: pg.PoolClient, sql: string, args: unknown[]) {
    try { return await c.query(sql, args); } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "23505") throw new ConflictException("a team with that name already exists");
      if (code === "23503") throw new BadRequestException("unknown depot or person");
      throw e;
    }
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() b: Record<string, unknown>) {
    const orgId = requirePerm(req, "users.manage");
    const f = this.fields(b ?? {}, true);
    return withOrg(this.pool, orgId, async (c) => {
      const n = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM teams")).rows[0]!.n;
      if (n >= 200) throw new BadRequestException("at most 200 teams");
      return (await this.write(c, `INSERT INTO teams (org_id, name, kind, depot_id, color, notes) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, name, kind`, [orgId, f.name, f.kind ?? "team", f.depot_id ?? null, f.color ?? null, f.notes ?? null])).rows[0];
    });
  }

  @Patch(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() b: Record<string, unknown>) {
    const orgId = requirePerm(req, "users.manage");
    const f = this.fields(b ?? {}, false);
    const keys = Object.keys(f);
    if (keys.length === 0) throw new BadRequestException("nothing to update");
    return withOrg(this.pool, orgId, async (c) => {
      const r = await this.write(c, `UPDATE teams SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(", ")} WHERE id = $1 RETURNING id, name, kind`, [parseUuid(id), ...keys.map((k) => f[k])]);
      if (!r.rowCount) throw new NotFoundException();
      return r.rows[0];
    });
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "users.manage");
    const r = await withOrg(this.pool, orgId, (c) => c.query("DELETE FROM teams WHERE id = $1", [parseUuid(id)]));
    if (!r.rowCount) throw new NotFoundException();
    return { ok: true };
  }

  /** Replace the people in a team. */
  @Put(":id/members")
  async members(@Req() req: AuthedRequest, @Param("id") id: string, @Body() b: { userIds?: unknown }) {
    const orgId = requirePerm(req, "users.manage");
    if (!Array.isArray(b?.userIds) || b.userIds.length > 500) throw new BadRequestException("userIds must be a list of up to 500 ids");
    const ids = [...new Set(b.userIds.map((x) => parseUuid(String(x))))];
    return withOrg(this.pool, orgId, async (c) => {
      const tid = parseUuid(id);
      if (!(await c.query("SELECT 1 FROM teams WHERE id = $1", [tid])).rowCount) throw new NotFoundException();
      const found = (await c.query("SELECT count(*)::int AS n FROM users WHERE id = ANY($1::uuid[])", [ids])).rows[0].n;
      if (found !== ids.length) throw new BadRequestException("unknown person in the list");
      await c.query("DELETE FROM team_members WHERE team_id = $1", [tid]);
      if (ids.length) await c.query("INSERT INTO team_members (org_id, team_id, user_id) SELECT $1, $2, unnest($3::uuid[])", [orgId, tid, ids]);
      return { id: tid, members: ids.length };
    });
  }
}

/** Invitations: the office makes a link, the person opens it and chooses a password. */
@Controller("invites")
@UseGuards(AuthGuard)
export class InvitesController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(NOTIFY) private readonly notify: Providers) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "users.manage");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT i.id, i.email, i.role, i.team_id AS "teamId", t.name AS "teamName", i.expires_at AS "expiresAt", i.accepted_at AS "acceptedAt", i.revoked_at AS "revokedAt", i.created_at AS "createdAt",
              (i.accepted_at IS NULL AND i.revoked_at IS NULL AND i.expires_at > now()) AS open
       FROM invites i LEFT JOIN teams t ON t.id = i.team_id AND t.org_id = i.org_id ORDER BY i.created_at DESC LIMIT 200`))).rows;
  }

  /** Make an invitation. The link is in the answer once; only its hash is kept. */
  @Post()
  async create(@Req() req: AuthedRequest, @Body() b: { email?: unknown; role?: unknown; teamId?: unknown; expiresInDays?: unknown }) {
    const orgId = requirePerm(req, "users.manage");
    const email = typeof b?.email === "string" ? b.email.trim() : "";
    if (!EMAIL.test(email) || email.length > 200) throw new BadRequestException("a valid email is required");
    if (!(INVITE_ROLES as readonly unknown[]).includes(b?.role)) throw new BadRequestException(`role must be one of ${INVITE_ROLES.join(", ")}`);
    if (b.role === "admin" && req.session!.role !== "owner") throw new ForbiddenException("only an owner can invite an admin");
    const days = b.expiresInDays === undefined ? 7 : Number(b.expiresInDays);
    if (!Number.isInteger(days) || days < 1 || days > 30) throw new BadRequestException("expiresInDays must be 1 to 30");
    const token = randomBytes(32).toString("base64url");
    const link = `${webUrl()}/invite/${token}`;
    const row = await withOrg(this.pool, orgId, async (c) => {
      if ((await c.query("SELECT 1 FROM users WHERE lower(email) = lower($1)", [email])).rowCount) throw new ConflictException("that email already has an account");
      // A new invitation replaces any open one for the same address.
      await c.query("UPDATE invites SET revoked_at = now() WHERE lower(email) = lower($1) AND accepted_at IS NULL AND revoked_at IS NULL", [email]);
      try {
        return (await c.query(
          `INSERT INTO invites (org_id, email, role, team_id, token_hash, expires_at, created_by) VALUES ($1,$2,$3,$4,$5, now() + ($6 || ' days')::interval,$7)
           RETURNING id, email, role, expires_at AS "expiresAt"`, [orgId, email, b.role, b.teamId ? parseUuid(String(b.teamId)) : null, sha(token), days, req.session!.userId])).rows[0];
      } catch (e) {
        if ((e as { code?: string }).code === "23503") throw new BadRequestException("unknown team");
        throw e;
      }
    });
    const org = (await withOrg(this.pool, orgId, (c) => c.query("SELECT coalesce(brand_name, name) AS name FROM organizations WHERE id = $1", [orgId]))).rows[0];
    const sent = await deliver({ id: row.id, kind: "email", target: email, label: email }, { subject: `You are invited to ${org.name} on RouteNorth`, text: `You have been invited to join ${org.name} as ${b.role}. Open this link to choose a password (it works for ${days} days):\n${link}`, link }, this.notify);
    return { ...row, link, emailSent: sent.ok, emailNote: sent.ok ? null : sent.error };
  }

  @Delete(":id")
  @HttpCode(200)
  async revoke(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "users.manage");
    const r = await withOrg(this.pool, orgId, (c) => c.query("UPDATE invites SET revoked_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL", [parseUuid(id)]));
    if (!r.rowCount) throw new NotFoundException("that invitation is not open");
    return { ok: true };
  }
}

interface Found { invite_id: string; org_id: string; email: string; role: string; team_id: string | null; org_name: string; brand_name: string | null }

/** The page behind an invitation link. No sign-in is needed; the secret in the link is the proof. */
@Controller("public/invite")
export class PublicInviteController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(JWT_SECRET) private readonly secret: string) {}

  private async find(token: string): Promise<Found> {
    if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) throw new NotFoundException("this invitation is not valid");
    const f = (await this.pool.query<Found>("SELECT * FROM find_invite($1)", [sha(token)])).rows[0];
    if (!f) throw new NotFoundException("this invitation is not valid or has expired");
    return f;
  }

  @Get(":token")
  async peek(@Param("token") token: string) {
    const f = await this.find(token);
    return { email: f.email, role: f.role, orgName: f.brand_name ?? f.org_name };
  }

  @Post(":token/accept")
  @HttpCode(200)
  async accept(@Param("token") token: string, @Body() b: { password?: unknown; displayName?: unknown; locale?: unknown }, @Req() req: AuthedRequest) {
    const f = await this.find(token);
    if (typeof b?.password !== "string" || b.password.length < 10 || b.password.length > 200) throw new BadRequestException("password must be 10 to 200 characters");
    const name = typeof b.displayName === "string" && b.displayName.trim() ? b.displayName.trim().slice(0, 80) : null;
    const locale = (LOCALES as readonly unknown[]).includes(b.locale) ? (b.locale as string) : "en";
    const hash = await hashPassword(b.password);
    const user = await withOrg(this.pool, f.org_id, async (c) => {
      // Take the invitation first so a double click cannot make two accounts.
      const taken = await c.query("UPDATE invites SET accepted_at = now() WHERE id = $1 AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now()", [f.invite_id]);
      if (!taken.rowCount) throw new NotFoundException("this invitation is no longer open");
      let u;
      try {
        u = (await c.query(`INSERT INTO users (org_id, email, password_hash, role, locale, display_name) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, role, locale`, [f.org_id, f.email, hash, f.role, locale, name])).rows[0];
      } catch (e) {
        if ((e as { code?: string }).code === "23505") throw new ConflictException("that email already has an account");
        throw e;
      }
      if (f.team_id) await c.query("INSERT INTO team_members (org_id, team_id, user_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING", [f.org_id, f.team_id, u.id]);
      if (f.role === "driver") {
        // A driver who joins by invitation starts in onboarding: the owner approves each step before jobs can be given.
        await c.query("UPDATE driver_profiles SET status = 'onboarding', team_id = $2 WHERE user_id = $1", [u.id, f.team_id ?? null]);
        await ensureSteps(c, f.org_id, u.id);
      }
      const owners = (await c.query("SELECT id FROM users WHERE role IN ('owner','admin') AND disabled_at IS NULL")).rows;
      for (const o of owners) await addNotification(c, f.org_id, o.id, "invite", `${name ?? f.email} accepted the invitation`, "/settings/users");
      const s = withDefaults((await c.query("SELECT settings FROM organizations WHERE id = $1", [f.org_id])).rows[0]?.settings);
      return { ...u, hours: s.sessionHours };
    });
    const jwt = await startSession(this.pool, this.secret, { userId: user.id, orgId: f.org_id, role: user.role }, user.hours, req);
    return { token: jwt, user: { id: user.id, orgId: f.org_id, role: user.role, locale: user.locale, home: homePath(user.role, effectivePermissions(user.role)) } };
  }
}
