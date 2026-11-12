import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { AuthGuard, requireAny, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { parseUuid } from "../history/range.js";
import { newKey } from "../platform/keys.js";
import { PG_POOL } from "../tokens.js";

const KINDS = ["truck", "bus", "van", "car"] as const;

/**
 * Connect the GPS data a company already has. RouteNorth does not sell hardware: a company keeps its trackers and its
 * provider, and the provider (or its own Traccar server, or a gateway) pushes positions to RouteNorth with a key that
 * belongs to that company. This controller manages those keys and the devices that show up through them.
 */
@Controller("portal/gps-connect")
@UseGuards(AuthGuard)
export class PortalGpsConnectController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get()
  async overview(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "api.manage", "integrations.manage", "fleet.manage");
    const base = (process.env.INGEST_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
    const d = await withOrg(this.pool, orgId, async (c) => {
      const keys = (await c.query(
        `SELECT id, name, prefix, last_used_at AS "lastUsedAt", created_at AS "createdAt" FROM api_keys WHERE kind = 'gps' AND revoked_at IS NULL ORDER BY created_at DESC`)).rows;
      const devices = (await c.query(
        `SELECT d.id, d.external_id AS "externalId", d.created_at AS "createdAt", d.vehicle_id AS "vehicleId", lp.time AS "lastSeen"
         FROM devices d LEFT JOIN latest_positions lp ON lp.device_id = d.id WHERE d.source = 'feed' ORDER BY d.created_at DESC LIMIT 500`)).rows;
      const vehicles = (await c.query(`SELECT id, name FROM vehicles WHERE archived_at IS NULL AND status NOT IN ('sold','retired') ORDER BY name LIMIT 500`)).rows;
      return { keys, devices, vehicles };
    });
    return {
      /** Where a provider sends data. Empty until the server operator sets INGEST_PUBLIC_URL. */
      ingestUrl: base || null,
      needs: base ? [] : ["INGEST_PUBLIC_URL (the public address of the ingest service)"],
      keys: d.keys,
      devices: {
        total: d.devices.length,
        waiting: d.devices.filter((x: { vehicleId: string | null }) => !x.vehicleId),
        lastSeen: d.devices.map((x: { lastSeen: Date | null }) => x.lastSeen).filter(Boolean).map((x: Date | null) => new Date(x!).toISOString()).sort().at(-1) ?? null,
      },
      vehicles: d.vehicles,
    };
  }

  /** A new key. It is in the answer once; only its hash is kept. */
  @Post("keys")
  async createKey(@Req() req: AuthedRequest, @Body() b: { name?: unknown }) {
    const orgId = requirePerm(req, "api.manage");
    const name = typeof b?.name === "string" ? b.name.trim().slice(0, 80) : "";
    if (!name) throw new BadRequestException("name is required, for example the name of your GPS provider");
    const k = newKey("gps");
    const row = await withOrg(this.pool, orgId, async (c) => {
      const n = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM api_keys WHERE kind = 'gps' AND revoked_at IS NULL")).rows[0]!.n;
      if (n >= 10) throw new BadRequestException("at most 10 active GPS keys; revoke one first");
      return (await c.query(
        `INSERT INTO api_keys (org_id, name, kind, scope, prefix, key_hash, created_by) VALUES ($1,$2,'gps','read',$3,$4,$5) RETURNING id, name, prefix`,
        [orgId, name, k.prefix, k.hash, req.session!.userId])).rows[0];
    });
    return { ...row, key: k.key };
  }

  @Delete("keys/:id")
  @HttpCode(200)
  async revokeKey(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "api.manage");
    const r = await withOrg(this.pool, orgId, (c) => c.query("UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND kind = 'gps' AND revoked_at IS NULL", [parseUuid(id)]));
    if (!r.rowCount) throw new NotFoundException("key not found");
    return { ok: true };
  }

  /** One vehicle for each device that arrived through a feed and is not on a vehicle yet (or only the listed ones). Named after the device id; rename them afterwards. */
  @Post("create-vehicles")
  async createVehicles(@Req() req: AuthedRequest, @Body() b: { deviceIds?: unknown; kind?: unknown }) {
    const orgId = requirePerm(req, "fleet.manage");
    const kind = String(b?.kind ?? "truck");
    if (!(KINDS as readonly string[]).includes(kind)) throw new BadRequestException(`kind must be one of ${KINDS.join(", ")}`);
    const ids = b?.deviceIds === undefined ? null : Array.isArray(b.deviceIds) ? b.deviceIds.map((x) => parseUuid(String(x))) : (() => { throw new BadRequestException("deviceIds must be a list"); })();
    return withOrg(this.pool, orgId, async (c) => {
      const waiting = (await c.query<{ id: string; external_id: string }>(
        `SELECT id, external_id FROM devices WHERE source = 'feed' AND vehicle_id IS NULL AND ($1::uuid[] IS NULL OR id = ANY($1)) ORDER BY external_id LIMIT 500`, [ids])).rows;
      let created = 0;
      for (const dev of waiting) {
        const v = await c.query<{ id: string }>("INSERT INTO vehicles (org_id, name, kind) VALUES ($1,$2,$3) RETURNING id", [orgId, dev.external_id.slice(0, 80), kind]);
        await c.query("UPDATE devices SET vehicle_id = $2 WHERE id = $1", [dev.id, v.rows[0]!.id]);
        created++;
      }
      return { created };
    });
  }
}
