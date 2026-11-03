import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Query, Req, UseGuards, HttpException } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { vehicleStatus } from "@routenorth/shared";
import { createHash, randomBytes } from "node:crypto";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { parseRange, parseUuid } from "../history/range.js";
import { withDefaults } from "../org/settings.js";
import { PG_POOL, WEATHER } from "../tokens.js";
import type { WeatherProvider } from "../weather/provider.js";

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const MAX_SHARE_HOURS = 72;

/** Live tracking links you can send to anyone (no sign-in), expiring and revocable. */
@Controller("share")
@UseGuards(AuthGuard)
export class ShareController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Post()
  async create(@Req() req: AuthedRequest, @Body() body: { deviceId?: unknown; routeId?: unknown; hours?: unknown; label?: unknown }) {
    const orgId = requirePerm(req, "fleet.manage", "routes.dispatch");
    const hours = body?.hours == null ? 24 : Number(body.hours);
    if (!(hours > 0 && hours <= MAX_SHARE_HOURS)) throw new BadRequestException(`hours must be between 0 and ${MAX_SHARE_HOURS}`);
    const deviceId = body?.deviceId ? parseUuid(String(body.deviceId)) : null;
    const routeId = body?.routeId ? parseUuid(String(body.routeId)) : null;
    if (!deviceId && !routeId) throw new BadRequestException("choose a vehicle or a route to share");
    const token = randomBytes(24).toString("base64url");
    return withOrg(this.pool, orgId, async (c) => {
      let device = deviceId;
      if (routeId && !deviceId) {
        const r = (await c.query(`SELECT d.id FROM routes r JOIN devices d ON d.vehicle_id = r.vehicle_id WHERE r.id = $1 LIMIT 1`, [routeId])).rows[0];
        if (!(await c.query("SELECT 1 FROM routes WHERE id = $1", [routeId])).rowCount) throw new NotFoundException();
        device = r?.id ?? null;
      }
      if (deviceId && !(await c.query("SELECT 1 FROM devices WHERE id = $1", [deviceId])).rowCount) throw new NotFoundException();
      const row = (await c.query(
        `INSERT INTO share_links (org_id, token_hash, device_id, route_id, label, expires_at, created_by) VALUES ($1,$2,$3,$4,$5,now() + make_interval(secs => $6),$7)
         RETURNING id, expires_at AS "expiresAt"`, [orgId, sha(token), device, routeId, body?.label ? String(body.label).slice(0, 80) : null, hours * 3600, req.session!.userId])).rows[0];
      return { ...row, token, path: `/track/${token}` };
    });
  }

  @Get()
  async list(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "fleet.manage", "routes.dispatch");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT id, label, device_id AS "deviceId", route_id AS "routeId", expires_at AS "expiresAt", revoked_at AS "revokedAt", created_at AS "createdAt"
       FROM share_links ORDER BY created_at DESC LIMIT 200`))).rows;
  }

  @Delete(":id")
  @HttpCode(204)
  async revoke(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "fleet.manage", "routes.dispatch");
    const n = (await withOrg(this.pool, orgId, (c) => c.query("UPDATE share_links SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [parseUuid(id)]))).rowCount;
    if (!n) throw new NotFoundException();
  }
}

const hits = new Map<string, { n: number; reset: number }>();
function limit(key: string, perMinute: number): void {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { if (hits.size > 5000) hits.clear(); hits.set(key, { n: 1, reset: now + 60_000 }); return; }
  if (++h.n > perMinute) throw new HttpException("too many requests", 429);
}

/** What a person with a tracking link sees: one vehicle, its recent trail and (if shared with a route) the stops and ETAs. */
@Controller("public")
export class PublicTrackController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get("track/:token")
  async track(@Req() req: AuthedRequest, @Param("token") token: string) {
    limit(`${req.ip ?? "?"}`, 90);
    if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) throw new NotFoundException();
    const link = (await this.pool.query("SELECT org_id, device_id, route_id, label, expires_at FROM resolve_share($1)", [sha(token)])).rows[0];
    if (!link) throw new NotFoundException();
    return withOrg(this.pool, link.org_id, async (c) => {
      const org = (await c.query(`SELECT coalesce(brand_name, name) AS name, brand_color AS color, logo_data_url AS logo FROM organizations WHERE id = $1`, [link.org_id])).rows[0];
      const pos = link.device_id ? (await c.query(
        `SELECT lp.lat, lp.lng, lp.heading, lp.speed, lp.time, lp.ignition, coalesce(v.name, 'Vehicle') AS name FROM latest_positions lp JOIN devices d ON d.id = lp.device_id
         LEFT JOIN vehicles v ON v.id = d.vehicle_id WHERE lp.device_id = $1`, [link.device_id])).rows[0] : null;
      const trail = link.device_id ? (await c.query(
        `SELECT lat, lng FROM (SELECT lat, lng, time, row_number() OVER (ORDER BY time DESC) AS rn FROM positions WHERE device_id = $1 AND time > now() - interval '90 minutes') x
         WHERE rn % 3 = 1 ORDER BY time LIMIT 200`, [link.device_id])).rows : [];
      const stops = link.route_id ? (await c.query(
        "SELECT name, lat, lng, status, eta, sequence FROM stops WHERE route_id = $1 ORDER BY sequence", [link.route_id])).rows : [];
      return {
        label: link.label, expiresAt: link.expires_at, org,
        vehicle: pos ? { name: pos.name, lat: pos.lat, lng: pos.lng, heading: pos.heading, speed: Math.round(pos.speed), time: pos.time, status: vehicleStatus({ time: new Date(pos.time).toISOString(), speed: pos.speed, ignition: pos.ignition }) } : null,
        trail, stops,
      };
    });
  }
}

/** Heat layers (where vehicles stop, where trips run late, where speeding happens) and weather. */
@Controller()
@UseGuards(AuthGuard)
export class LiveExtrasController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(WEATHER) private readonly weather: WeatherProvider | null) {}

  @Get("heat")
  async heat(@Req() req: AuthedRequest, @Query("kind") kind?: string, @Query("from") from?: string, @Query("to") to?: string) {
    const orgId = requirePerm(req, "fleet.view", "reports.view");
    if (kind !== "stops" && kind !== "delays" && kind !== "speeding") throw new BadRequestException("kind must be stops, delays or speeding");
    const range = parseRange(from, to, 31);
    return withOrg(this.pool, orgId, async (c) => {
      const cell = 0.004; // about 400 m
      if (kind === "delays") {
        return (await c.query(
          `SELECT round(lat / $3) * $3 AS lat, round(lng / $3) * $3 AS lng, sum(extract(epoch FROM (arrived_at - window_end)) / 60)::int AS weight, count(*)::int AS count
           FROM stops WHERE arrived_at IS NOT NULL AND window_end IS NOT NULL AND arrived_at > window_end AND arrived_at >= $1 AND arrived_at < $2
           GROUP BY 1, 2 ORDER BY weight DESC LIMIT 2000`, [range.from, range.to, cell])).rows;
      }
      const limitKmh = withDefaults((await c.query("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0].settings).speedLimitKmh;
      const where = kind === "stops" ? "speed < 2 AND ignition IS NOT FALSE" : "speed > $4";
      return (await c.query(
        `SELECT round(lat / $3) * $3 AS lat, round(lng / $3) * $3 AS lng, count(*)::int AS weight, count(DISTINCT device_id)::int AS vehicles FROM positions
         WHERE time >= $1 AND time < $2 AND ${where} GROUP BY 1, 2 ORDER BY weight DESC LIMIT 2000`,
        kind === "stops" ? [range.from, range.to, cell] : [range.from, range.to, cell, limitKmh])).rows;
    });
  }

  @Get("weather")
  async at(@Req() req: AuthedRequest, @Query("lat") lat?: string, @Query("lng") lng?: string, @Query("at") at?: string) {
    requirePerm(req, "fleet.view", "routes.view");
    if (!this.weather) return { available: false };
    const la = Number(lat), lo = Number(lng);
    if (!(la >= -90 && la <= 90) || !(lo >= -180 && lo <= 180)) throw new BadRequestException("lat and lng are required");
    const when = at ? Date.parse(at) : Date.now();
    if (Number.isNaN(when)) throw new BadRequestException("at must be a timestamp");
    try { return { available: true, source: this.weather.name, ...(await this.weather.at(la, lo, when)) }; } catch { return { available: false, error: "weather service unreachable" }; }
  }

  /** Weather at each stop of a route when the driver is expected to arrive. */
  @Get("weather/route/:id")
  async route(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "routes.view");
    if (!this.weather) return { available: false, stops: [] };
    const stops = (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT id, name, lat, lng, coalesce(eta, window_start, now()) AS at FROM stops WHERE route_id = $1 ORDER BY sequence`, [parseUuid(id)]))).rows;
    const out = [];
    for (const s of stops) {
      try { out.push({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, at: new Date(s.at).toISOString(), weather: await this.weather.at(s.lat, s.lng, new Date(s.at).getTime()) }); }
      catch { return { available: false, error: "weather service unreachable", stops: [] }; }
    }
    return { available: true, source: this.weather.name, worst: out.reduce((w, s) => (s.weather.level === "severe" ? "severe" : s.weather.level === "caution" && w === "ok" ? "caution" : w), "ok"), stops: out };
  }
}
