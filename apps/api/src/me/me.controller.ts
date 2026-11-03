import { BadRequestException, Body, Controller, Get, Inject, Patch, Post, Put, Req, UnauthorizedException, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { LOCALES, homePath } from "@routenorth/shared";
import { AuthGuard, type AuthedRequest } from "../auth/auth.guard.js";
import { hashPassword, verifyPassword } from "../passwords.js";
import { PG_POOL } from "../tokens.js";
import { publicSettings } from "../org/settings.js";

const MAX_PREFS_BYTES = 40_000;

@Controller("me")
@UseGuards(AuthGuard)
export class MeController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Everything the web app needs at start-up: who you are, what you may do, your company's branding, your saved preferences. */
  @Get()
  async me(@Req() req: AuthedRequest) {
    const { orgId, userId } = req.session!;
    const perms = [...(req.perms ?? [])];
    return withOrg(this.pool, orgId, async (c) => {
      const u = (await c.query(
        `SELECT u.id, u.email, u.display_name AS "displayName", u.role, u.locale, u.custom_role_id AS "customRoleId", cr.name AS "customRoleName"
         FROM users u LEFT JOIN custom_roles cr ON cr.id = u.custom_role_id AND cr.org_id = u.org_id WHERE u.id = $1`, [userId])).rows[0];
      const o = (await c.query(
        `SELECT id, name, locale, timezone, brand_name AS "brandName", brand_color AS "brandColor", logo_data_url AS "logoDataUrl", settings
         FROM organizations WHERE id = $1`, [orgId])).rows[0];
      const prefs = (await c.query("SELECT prefs FROM user_prefs WHERE user_id = $1", [userId])).rows[0]?.prefs ?? {};
      return {
        user: u,
        perms,
        home: homePath(u.role, req.perms ?? new Set()),
        org: { ...o, settings: publicSettings(o.settings) },
        prefs,
      };
    });
  }

  /** Replace the saved preferences (favorites, saved views, theme, onboarding progress). */
  @Put("prefs")
  async savePrefs(@Req() req: AuthedRequest, @Body() body: { prefs?: unknown }) {
    const prefs = body?.prefs;
    if (!prefs || typeof prefs !== "object" || Array.isArray(prefs)) throw new BadRequestException("prefs must be an object");
    const json = JSON.stringify(prefs);
    if (json.length > MAX_PREFS_BYTES) throw new BadRequestException("preferences are too large");
    const { orgId, userId } = req.session!;
    await withOrg(this.pool, orgId, (c) =>
      c.query(
        `INSERT INTO user_prefs (user_id, org_id, prefs) VALUES ($1,$2,$3)
         ON CONFLICT (user_id) DO UPDATE SET prefs = EXCLUDED.prefs, updated_at = now()`,
        [userId, orgId, json],
      ),
    );
    return { ok: true };
  }

  @Patch()
  async update(@Req() req: AuthedRequest, @Body() body: { displayName?: unknown; locale?: unknown }) {
    const { orgId, userId } = req.session!;
    const name = body?.displayName;
    if (name !== undefined && name !== null && (typeof name !== "string" || name.length > 80)) throw new BadRequestException("displayName must be up to 80 characters");
    const locale = body?.locale;
    if (locale !== undefined && !(LOCALES as readonly unknown[]).includes(locale)) throw new BadRequestException("unknown locale");
    await withOrg(this.pool, orgId, (c) =>
      c.query(
        `UPDATE users SET display_name = CASE WHEN $2::boolean THEN $3 ELSE display_name END, locale = coalesce($4, locale) WHERE id = $1`,
        [userId, name !== undefined, typeof name === "string" ? name.trim() || null : null, (locale as string | undefined) ?? null],
      ),
    );
    return { ok: true };
  }

  @Post("password")
  async password(@Req() req: AuthedRequest, @Body() body: { current?: unknown; next?: unknown }) {
    if (typeof body?.current !== "string" || typeof body?.next !== "string") throw new BadRequestException("current and next are required");
    if (body.next.length < 10 || body.next.length > 200) throw new BadRequestException("password must be 10 to 200 characters");
    const { orgId, userId } = req.session!;
    const row = (await withOrg(this.pool, orgId, (c) => c.query("SELECT password_hash FROM users WHERE id = $1", [userId]))).rows[0];
    if (!row || !(await verifyPassword(body.current, row.password_hash))) throw new UnauthorizedException("current password is wrong");
    const hash = await hashPassword(body.next);
    await withOrg(this.pool, orgId, (c) => c.query("UPDATE users SET password_hash = $2 WHERE id = $1", [userId, hash]));
    return { ok: true };
  }
}
