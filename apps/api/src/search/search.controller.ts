import { Controller, Get, Inject, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { AuthGuard, hasPerm, type AuthedRequest } from "../auth/auth.guard.js";
import { PG_POOL } from "../tokens.js";

export interface SearchHit {
  type: "vehicle" | "driver" | "route" | "stop" | "customer";
  id: string;
  title: string;
  subtitle: string | null;
  href: string;
}

const PER_GROUP = 6;

/** Global search across vehicles, drivers, routes and stops (customers join in when they exist). Respects permissions. */
@Controller("search")
@UseGuards(AuthGuard)
export class SearchController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get()
  async search(@Req() req: AuthedRequest, @Query("q") q?: string): Promise<SearchHit[]> {
    const text = (q ?? "").trim().slice(0, 80);
    if (text.length < 1) return [];
    const like = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
    const hits: SearchHit[] = [];
    await withOrg(this.pool, req.session!.orgId, async (c) => {
      if (hasPerm(req, "fleet.view")) {
        const r = await c.query(
          `SELECT v.id, v.name, v.kind, v.plate, d.id AS device_id FROM vehicles v LEFT JOIN devices d ON d.vehicle_id = v.id
           WHERE v.name ILIKE $1 OR v.plate ILIKE $1 OR v.vin ILIKE $1 ORDER BY v.name LIMIT ${PER_GROUP}`, [like]);
        for (const v of r.rows) hits.push({ type: "vehicle", id: v.id, title: v.name, subtitle: [v.kind, v.plate].filter(Boolean).join(" · "), href: v.device_id ? `/?v=${v.device_id}` : "/" });
      }
      if (hasPerm(req, "users.view")) {
        const r = await c.query(
          `SELECT id, coalesce(display_name, email) AS name, email FROM users
           WHERE role = 'driver' AND disabled_at IS NULL AND (email ILIKE $1 OR display_name ILIKE $1) ORDER BY 2 LIMIT ${PER_GROUP}`, [like]);
        for (const u of r.rows) hits.push({ type: "driver", id: u.id, title: u.name, subtitle: u.email, href: "/settings/users" });
      }
      if (hasPerm(req, "routes.view")) {
        const rt = await c.query(
          `SELECT id, name, route_date::text AS date, status FROM routes WHERE name ILIKE $1 ORDER BY route_date DESC LIMIT ${PER_GROUP}`, [like]);
        for (const r of rt.rows) hits.push({ type: "route", id: r.id, title: r.name, subtitle: `${r.date} · ${r.status}`, href: `/routes/${r.id}` });
        const st = await c.query(
          `SELECT s.id, s.name, s.address, s.route_id, r.name AS route_name FROM stops s JOIN routes r ON r.id = s.route_id
           WHERE s.name ILIKE $1 OR s.address ILIKE $1 ORDER BY r.route_date DESC LIMIT ${PER_GROUP}`, [like]);
        for (const s of st.rows) hits.push({ type: "stop", id: s.id, title: s.name, subtitle: [s.address, s.route_name].filter(Boolean).join(" · "), href: `/routes/${s.route_id}` });
      }
    });
    return hits;
  }
}
