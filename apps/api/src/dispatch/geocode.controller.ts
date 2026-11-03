import { BadRequestException, Body, Controller, Get, Inject, Post, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { checkAddress } from "@routenorth/shared";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { GEOCODER, PG_POOL } from "../tokens.js";
import type { GeoHit, Geocoder } from "./geocoder.js";

/** Address auto-complete and geocoding with fix suggestions. */
@Controller("geocode")
@UseGuards(AuthGuard)
export class GeocodeController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(GEOCODER) private readonly geocoder: Geocoder | null) {}

  /** Places this organization already knows (stops, jobs, depots), matched by address text. */
  private async saved(orgId: string, q: string, limit: number): Promise<GeoHit[]> {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    const rows = (await withOrg(this.pool, orgId, (c) => c.query<{ label: string; lat: number; lng: number }>(
      `SELECT DISTINCT ON (label) label, lat, lng FROM (
         SELECT address AS label, lat, lng FROM stops WHERE address ILIKE $1
         UNION ALL SELECT address, lat, lng FROM jobs WHERE address ILIKE $1 AND lat IS NOT NULL
         UNION ALL SELECT coalesce(address, name), lat, lng FROM depots WHERE coalesce(address, name) ILIKE $1) x
       WHERE label IS NOT NULL ORDER BY label LIMIT $2`, [like, limit]))).rows;
    return rows.map((r) => ({ ...r, source: "saved" as const }));
  }

  @Get()
  async search(@Req() req: AuthedRequest, @Query("q") q?: string) {
    const orgId = requirePerm(req, "routes.view");
    const text = (q ?? "").trim();
    if (text.length < 3) return { query: text, check: null, results: [] };
    if (text.length > 200) throw new BadRequestException("q is too long");
    const check = checkAddress(text);
    const saved = await this.saved(orgId, text, 5);
    let remote: GeoHit[] = [];
    let geocoderError = false;
    if (this.geocoder) {
      try { remote = await this.geocoder.search(check.suggestion || text, 5); } catch { geocoderError = true; }
    }
    return { query: text, check, results: [...saved, ...remote], geocoder: this.geocoder?.name ?? null, geocoderError };
  }

  /** Find coordinates for many addresses at once (first match each). */
  @Post("batch")
  async batch(@Req() req: AuthedRequest, @Body() body: { addresses?: unknown }) {
    const orgId = requirePerm(req, "routes.write");
    if (!Array.isArray(body?.addresses) || body.addresses.length > 200) throw new BadRequestException("addresses must be a list of up to 200");
    const out = [];
    for (const a of body.addresses) {
      const text = String(a ?? "").trim().slice(0, 200);
      if (text.length < 3) { out.push({ address: text, found: false, check: checkAddress(text) }); continue; }
      const check = checkAddress(text);
      let hit: GeoHit | undefined = (await this.saved(orgId, text, 1))[0];
      if (!hit && this.geocoder) { try { hit = (await this.geocoder.search(check.suggestion || text, 1))[0]; } catch { /* leave unfound */ } }
      out.push({ address: text, found: !!hit, lat: hit?.lat, lng: hit?.lng, label: hit?.label, source: hit?.source, check });
    }
    return out;
  }
}
