import { BadRequestException, Body, ConflictException, Controller, ForbiddenException, Get, Inject, Post, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard.js";
import { hashPassword } from "../passwords.js";
import { PG_POOL } from "../tokens.js";

const ROLES = ["admin", "dispatcher", "driver", "viewer"];
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

@Controller("users")
@UseGuards(AuthGuard)
export class UsersController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** People in the organization, for assigning drivers. Dispatchers and above only. */
  @Get()
  async list(@Req() req: AuthedRequest, @Query("role") role?: string) {
    if (!["owner", "admin", "dispatcher"].includes(req.session!.role)) throw new ForbiddenException();
    const rows = await withOrg(this.pool, req.session!.orgId, (c) =>
      c.query("SELECT id, email, role, locale FROM users WHERE ($1::text IS NULL OR role = $1) ORDER BY email", [role ?? null]),
    );
    return rows.rows;
  }

  /** Create a user with an initial password (shared with the person out of band). */
  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: { email?: unknown; password?: unknown; role?: unknown; locale?: unknown }) {
    const caller = req.session!;
    if (!["owner", "admin"].includes(caller.role)) throw new ForbiddenException();
    if (typeof body?.email !== "string" || !EMAIL.test(body.email) || body.email.length > 200) throw new BadRequestException("a valid email is required");
    if (typeof body.password !== "string" || body.password.length < 10 || body.password.length > 200) {
      throw new BadRequestException("password must be 10 to 200 characters");
    }
    if (typeof body.role !== "string" || !ROLES.includes(body.role)) throw new BadRequestException(`role must be one of ${ROLES.join(", ")}`);
    // Only an owner can create another admin.
    if (body.role === "admin" && caller.role !== "owner") throw new ForbiddenException();
    const locale = body.locale === "fr" ? "fr" : "en";
    const hash = await hashPassword(body.password);
    try {
      const rows = await withOrg(this.pool, caller.orgId, (c) =>
        c.query(
          "INSERT INTO users (org_id, email, password_hash, role, locale) VALUES ($1,$2,$3,$4,$5) RETURNING id, email, role, locale",
          [caller.orgId, body.email, hash, body.role, locale],
        ),
      );
      return rows.rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ConflictException("that email is already in use");
      throw e;
    }
  }
}
