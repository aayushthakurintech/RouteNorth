import { BadRequestException, Body, Controller, Get, Inject, Put, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { LOCALES } from "@routenorth/shared";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { PG_POOL } from "../tokens.js";
import { parseSettingsPatch, withDefaults } from "./settings.js";

const NESTED = ["customerNotify", "customerPortal", "booking", "approvals"];
const LOGO =/^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;

@Controller("org")
@UseGuards(AuthGuard)
export class OrgController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** Company profile, branding and all settings. */
  @Get()
  async get(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "settings.manage");
    const o = (
      await withOrg(this.pool, orgId, (c) =>
        c.query(
          `SELECT id, name, locale, timezone, retention_days AS "retentionDays", brand_name AS "brandName", brand_color AS "brandColor",
                  logo_data_url AS "logoDataUrl", settings FROM organizations WHERE id = $1`, [orgId]),
      )
    ).rows[0];
    return { ...o, settings: withDefaults(o.settings) };
  }

  /** Update any of: name, locale, timezone, retentionDays, brandName, brandColor (#rrggbb), logoDataUrl, settings (partial). */
  @Put()
  async update(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>) {
    const orgId = requirePerm(req, "settings.manage");
    const set: string[] = [];
    const args: unknown[] = [orgId];
    const add = (col: string, v: unknown) => { args.push(v); set.push(`${col} = $${args.length}`); };
    if (body.name !== undefined) {
      if (typeof body.name !== "string" || !body.name.trim() || body.name.length > 120) throw new BadRequestException("name must be 1 to 120 characters");
      add("name", body.name.trim());
    }
    if (body.locale !== undefined) {
      if (!(LOCALES as readonly unknown[]).includes(body.locale)) throw new BadRequestException("unknown locale");
      add("locale", body.locale);
    }
    if (body.timezone !== undefined) {
      try { new Intl.DateTimeFormat("en", { timeZone: String(body.timezone) }); } catch { throw new BadRequestException("unknown time zone"); }
      add("timezone", body.timezone);
    }
    if (body.retentionDays !== undefined) {
      const d = Number(body.retentionDays);
      if (!Number.isInteger(d) || d < 30 || d > 3650) throw new BadRequestException("retentionDays must be 30 to 3650");
      add("retention_days", d);
    }
    if (body.brandName !== undefined) {
      if (body.brandName !== null && (typeof body.brandName !== "string" || body.brandName.length > 60)) throw new BadRequestException("brandName must be up to 60 characters");
      add("brand_name", body.brandName ? String(body.brandName).trim() : null);
    }
    if (body.brandColor !== undefined) {
      if (body.brandColor !== null && !/^#[0-9a-fA-F]{6}$/.test(String(body.brandColor))) throw new BadRequestException("brandColor must look like #1a73e8");
      add("brand_color", body.brandColor);
    }
    if (body.logoDataUrl !== undefined) {
      if (body.logoDataUrl !== null && (typeof body.logoDataUrl !== "string" || !LOGO.test(body.logoDataUrl) || body.logoDataUrl.length > 400_000)) {
        throw new BadRequestException("logo must be a PNG, JPEG, WebP or SVG image under about 300 KB");
      }
      add("logo_data_url", body.logoDataUrl);
    }
    if (body.settings !== undefined) {
      let patch;
      try { patch = parseSettingsPatch(body.settings); } catch (e) { throw new BadRequestException((e as Error).message); }
      args.push(JSON.stringify(patch));
      // Grouped options (customer messages, booking ...) are merged one level deep, so saving one switch keeps the others.
      let expr = `settings || $${args.length}::jsonb`;
      for (const k of NESTED) if (k in patch) expr = `jsonb_set(${expr}, '{${k}}', coalesce(settings->'${k}', '{}'::jsonb) || ($${args.length}::jsonb->'${k}'))`;
      set.push(`settings = ${expr}`);
    }
    if (set.length === 0) throw new BadRequestException("nothing to update");
    await withOrg(this.pool, orgId, (c) => c.query(`UPDATE organizations SET ${set.join(", ")} WHERE id = $1`, args));
    return this.get(req);
  }
}
