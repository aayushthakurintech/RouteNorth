import { BadRequestException, Body, ConflictException, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Put, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { PERMISSIONS, ROLES, ROLE_PERMISSIONS, isPermission } from "@routenorth/shared";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { parseUuid } from "../history/range.js";
import { PG_POOL } from "../tokens.js";

function parseRoleBody(body: { name?: unknown; permissions?: unknown }) {
  if (typeof body?.name !== "string" || !body.name.trim() || body.name.trim().length > 60) throw new BadRequestException("name must be 1 to 60 characters");
  if (!Array.isArray(body.permissions) || !body.permissions.every(isPermission)) {
    throw new BadRequestException(`permissions must be a list drawn from: ${PERMISSIONS.join(", ")}`);
  }
  return { name: body.name.trim(), permissions: [...new Set(body.permissions as string[])] };
}

@Controller("roles")
@UseGuards(AuthGuard)
export class RolesController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Built-in roles and the organization's custom roles, with what each may do. */
  @Get()
  async list(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "users.view");
    const custom = (
      await withOrg(this.pool, orgId, (c) =>
        c.query(
          `SELECT r.id, r.name, r.permissions, (SELECT count(*)::int FROM users u WHERE u.custom_role_id = r.id) AS "userCount"
           FROM custom_roles r ORDER BY r.name`),
      )
    ).rows;
    return {
      permissions: PERMISSIONS,
      builtIn: ROLES.map((r) => ({ role: r, permissions: ROLE_PERMISSIONS[r] })),
      custom,
    };
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: { name?: unknown; permissions?: unknown }) {
    const orgId = requirePerm(req, "roles.manage");
    const r = parseRoleBody(body);
    try {
      return (await withOrg(this.pool, orgId, (c) =>
        c.query(`INSERT INTO custom_roles (org_id, name, permissions) VALUES ($1,$2,$3) RETURNING id, name, permissions`, [orgId, r.name, r.permissions]))).rows[0];
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ConflictException("a role with that name already exists");
      throw e;
    }
  }

  @Put(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { name?: unknown; permissions?: unknown }) {
    const orgId = requirePerm(req, "roles.manage");
    const r = parseRoleBody(body);
    try {
      const row = (await withOrg(this.pool, orgId, (c) =>
        c.query(`UPDATE custom_roles SET name=$2, permissions=$3 WHERE id=$1 RETURNING id, name, permissions`, [parseUuid(id), r.name, r.permissions]))).rows[0];
      if (!row) throw new NotFoundException();
      return row;
    } catch (e) {
      if ((e as { code?: string }).code === "23505") throw new ConflictException("a role with that name already exists");
      throw e;
    }
  }

  /** People with this role go back to their built-in role. */
  @Delete(":id")
  @HttpCode(204)
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "roles.manage");
    const done = await withOrg(this.pool, orgId, (c) => c.query("DELETE FROM custom_roles WHERE id = $1", [parseUuid(id)]));
    if (done.rowCount === 0) throw new NotFoundException();
  }
}
