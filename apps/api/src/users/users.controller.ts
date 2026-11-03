import {
  BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, NotFoundException,
  Param, Patch, Post, Query, Req, UseGuards,
} from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { LOCALES } from "@routenorth/shared";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { parseUuid } from "../history/range.js";
import { hashPassword } from "../passwords.js";
import { PG_POOL } from "../tokens.js";

/** Roles that can be given to a new person. Owners are created with the organization, not through the API. */
const ASSIGNABLE = ["admin", "dispatcher", "manager", "driver", "customer", "viewer"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Controller("users")
@UseGuards(AuthGuard)
export class UsersController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** People in the organization (disabled ones are hidden unless includeDisabled=1). */
  @Get()
  async list(@Req() req: AuthedRequest, @Query("role") role?: string, @Query("includeDisabled") includeDisabled?: string) {
    const orgId = requirePerm(req, "users.view");
    const rows = await withOrg(this.pool, orgId, (c) =>
      c.query(
        `SELECT u.id, u.email, u.display_name AS "displayName", u.role, u.locale, u.custom_role_id AS "customRoleId",
                cr.name AS "customRoleName", u.disabled_at AS "disabledAt", u.created_at AS "createdAt"
         FROM users u LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id AND cr.org_id = u.org_id
         WHERE ($1::text IS NULL OR u.role = $1) AND ($2::boolean OR u.disabled_at IS NULL)
         ORDER BY coalesce(u.display_name, u.email)`,
        [role ?? null, includeDisabled === "1"],
      ),
    );
    return rows.rows;
  }

  /** Create a user with an initial password (shared with the person out of band). */
  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: { email?: unknown; password?: unknown; role?: unknown; locale?: unknown; displayName?: unknown; customRoleId?: unknown }) {
    const orgId = requirePerm(req, "users.manage");
    const caller = req.session!;
    if (typeof body?.email !== "string" || !EMAIL.test(body.email) || body.email.length > 200) throw new BadRequestException("a valid email is required");
    if (typeof body.password !== "string" || body.password.length < 10 || body.password.length > 200) {
      throw new BadRequestException("password must be 10 to 200 characters");
    }
    if (typeof body.role !== "string" || !ASSIGNABLE.includes(body.role)) throw new BadRequestException(`role must be one of ${ASSIGNABLE.join(", ")}`);
    // Only an owner can create another admin.
    if (body.role === "admin" && caller.role !== "owner") throw new ForbiddenException();
    if (body.displayName !== undefined && body.displayName !== null && (typeof body.displayName !== "string" || body.displayName.length > 80)) {
      throw new BadRequestException("displayName must be up to 80 characters");
    }
    const locale = (LOCALES as readonly unknown[]).includes(body.locale) ? (body.locale as string) : "en";
    const customRoleId = body.customRoleId ? parseUuid(String(body.customRoleId)) : null;
    const hash = await hashPassword(body.password);
    try {
      const rows = await withOrg(this.pool, orgId, (c) =>
        c.query(
          `INSERT INTO users (org_id, email, password_hash, role, locale, display_name, custom_role_id) VALUES ($1,$2,$3,$4,$5,$6,$7)
           RETURNING id, email, display_name AS "displayName", role, locale, custom_role_id AS "customRoleId"`,
          [orgId, body.email, hash, body.role, locale, typeof body.displayName === "string" ? body.displayName.trim() || null : null, customRoleId],
        ),
      );
      return rows.rows[0];
    } catch (e) {
      const code = (e as { code?: string }).code;
      if (code === "23505") throw new ConflictException("that email is already in use");
      if (code === "23503") throw new BadRequestException("unknown custom role");
      throw e;
    }
  }

  /** Change someone's role, custom role, name, or disable/enable them. */
  @Patch(":id")
  async update(
    @Req() req: AuthedRequest, @Param("id") id: string,
    @Body() body: { role?: unknown; customRoleId?: unknown; displayName?: unknown; disabled?: unknown; locale?: unknown },
  ) {
    const orgId = requirePerm(req, "users.manage");
    const caller = req.session!;
    const uid = parseUuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      const target = (await c.query("SELECT id, role FROM users WHERE id = $1 FOR UPDATE", [uid])).rows[0];
      if (!target) throw new NotFoundException();
      if (target.role === "owner" && caller.role !== "owner") throw new ForbiddenException("only an owner can change an owner");
      if (uid === caller.userId && (body.disabled === true || (body.role !== undefined && body.role !== caller.role))) {
        throw new BadRequestException("you cannot disable yourself or change your own role");
      }
      const set: string[] = [];
      const args: unknown[] = [uid];
      const add = (col: string, v: unknown) => { args.push(v); set.push(`${col} = $${args.length}`); };
      if (body.role !== undefined) {
        if (typeof body.role !== "string" || ![...ASSIGNABLE, "owner"].includes(body.role)) throw new BadRequestException("unknown role");
        if ((body.role === "admin" || body.role === "owner") && caller.role !== "owner") throw new ForbiddenException("only an owner can make an admin or owner");
        add("role", body.role);
      }
      if (body.customRoleId !== undefined) add("custom_role_id", body.customRoleId ? parseUuid(String(body.customRoleId)) : null);
      if (body.displayName !== undefined) {
        if (body.displayName !== null && (typeof body.displayName !== "string" || body.displayName.length > 80)) throw new BadRequestException("displayName must be up to 80 characters");
        add("display_name", body.displayName ? String(body.displayName).trim() : null);
      }
      if (body.locale !== undefined) {
        if (!(LOCALES as readonly unknown[]).includes(body.locale)) throw new BadRequestException("unknown locale");
        add("locale", body.locale);
      }
      if (body.disabled !== undefined) set.push(`disabled_at = ${body.disabled ? "coalesce(disabled_at, now())" : "NULL"}`);
      if (set.length === 0) throw new BadRequestException("nothing to update");
      try {
        await c.query(`UPDATE users SET ${set.join(", ")} WHERE id = $1`, args);
      } catch (e) {
        if ((e as { code?: string }).code === "23503") throw new BadRequestException("unknown custom role");
        throw e;
      }
      // Never leave an organization with no active owner.
      const owners = (await c.query("SELECT count(*)::int AS n FROM users WHERE role = 'owner' AND disabled_at IS NULL")).rows[0].n;
      if (owners === 0) throw new BadRequestException("the organization needs at least one active owner");
      return (await c.query(`SELECT id, email, display_name AS "displayName", role, locale, custom_role_id AS "customRoleId", disabled_at AS "disabledAt" FROM users WHERE id = $1`, [uid])).rows[0];
    });
  }
}

