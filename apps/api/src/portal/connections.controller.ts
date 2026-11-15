import { BadRequestException, Body, Controller, Get, HttpCode, HttpException, Inject, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import { decryptSecret, pg, withOrg } from "@routenorth/db";
import { CONNECTION_METHODS, ConnectorError, listProviderDevices, METHOD_INFO, setupInstructions, type FetchLike } from "@routenorth/shared";
import { AuthGuard, requireAny, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { auditChange } from "../audit/domain-audit.js";
import { JWT_SECRET, PG_POOL } from "../tokens.js";
import { uuid } from "./common.js";
import { attachTracker, checkTracker, readInput, setupContext, vehicleConnections } from "./connections.service.js";

const hits = new Map<string, number[]>();
/**
 * At most 60 tracker checks a minute per user. Each check can ask a provider's API (using the company's quota) and
 * says whether an ID is taken, so a script must not be able to loop over IDs. In memory: one API process each.
 */
export function limitChecks(userKey: string, max = 60, windowMs = 60_000, now = Date.now()) {
  const recent = (hits.get(userKey) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) { hits.set(userKey, recent); throw new HttpException("Too many checks in a minute. Wait a moment and try again.", 429); }
  recent.push(now); hits.set(userKey, recent);
  if (hits.size > 5000) for (const [k, v] of hits) if (!v.some((t) => now - t < windowMs)) hits.delete(k);
}

/**
 * Connecting a vehicle to its tracker: what the methods are, a dry-run check of an ID, the state of every vehicle's
 * connection, and linking or unlinking a tracker. Creating a vehicle together with its tracker is
 * `POST /portal/vehicles` with a `tracker` in the body.
 */
@Controller("portal/connections")
@UseGuards(AuthGuard)
export class PortalConnectionsController {
  /** Replaced in tests; the real provider is called otherwise. */
  static fetchFn: FetchLike = (url, init) => fetch(url, init);

  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(JWT_SECRET) private readonly secret: string) {}

  private ctx(orgId: string) { return { pool: this.pool, orgId, secret: this.secret, fetchFn: PortalConnectionsController.fetchFn }; }

  /** The methods an owner can pick, what this install has set up for each, and the saved provider accounts. */
  @Get("meta")
  async meta(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "fleet.view", "fleet.manage", "vehicles.manage");
    const sctx = setupContext();
    const providers = await withOrg(this.pool, orgId, async (c) => (await c.query(
      `SELECT id, provider, name, status, last_error AS "lastError", last_sync_at AS "lastSyncAt" FROM provider_connections ORDER BY created_at`)).rows);
    const keys = await withOrg(this.pool, orgId, async (c) => Number((await c.query("SELECT count(*)::int AS n FROM api_keys WHERE kind = 'gps' AND revoked_at IS NULL")).rows[0].n));
    return {
      methods: CONNECTION_METHODS.map((m) => ({ ...METHOD_INFO[m], setup: setupInstructions(m, sctx) })),
      ingestUrl: sctx.ingestUrl, traccarHost: sctx.traccarHost, traccarPorts: sctx.traccarPorts,
      providers, gpsKeys: keys,
    };
  }

  /** Dry run: says whether this ID can be saved, and why not, without saving anything. */
  @Post("check")
  @HttpCode(200)
  async check(@Req() req: AuthedRequest, @Body() raw: unknown) {
    const orgId = requireAny(req, "fleet.manage", "vehicles.manage");
    limitChecks(`${orgId}:${req.session!.userId}`);
    const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const vehicleId = b.vehicleId ? uuid(b.vehicleId, "vehicleId") : null;
    return checkTracker(this.ctx(orgId), readInput(raw), { vehicleId });
  }

  /** The vehicles in a provider account that RouteNorth can see, with the ones already linked marked. */
  @Get("provider/:id/vehicles")
  async providerVehicles(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requireAny(req, "fleet.manage", "vehicles.manage", "integrations.manage");
    limitChecks(`${orgId}:${req.session!.userId}`);
    const row = await withOrg(this.pool, orgId, async (c) => (await c.query<{ provider: "geotab" | "samsara"; settings: Record<string, unknown>; secret_enc: string; name: string }>(
      "SELECT provider, settings, secret_enc, name FROM provider_connections WHERE id = $1", [uuid(id)])).rows[0]);
    if (!row) throw new NotFoundException("That provider account was not found.");
    const secret = decryptSecret(this.secret, row.secret_enc);
    if (secret == null) throw new BadRequestException("The saved login cannot be read any more. Enter it again on the Connect your GPS page.");
    let list;
    try { list = await listProviderDevices({ provider: row.provider, settings: row.settings, secret }, PortalConnectionsController.fetchFn); }
    catch (e) { throw new BadRequestException(e instanceof ConnectorError ? e.message : "Could not ask the provider for its vehicle list."); }
    const linked = await withOrg(this.pool, orgId, async (c) => new Set((await c.query<{ external_id: string }>("SELECT external_id FROM devices WHERE vehicle_id IS NOT NULL AND source = 'feed'")).rows.map((r) => r.external_id)));
    return { name: row.name, provider: row.provider, vehicles: list.map((d) => ({ ...d, linked: linked.has(`${row.provider}:${d.id}`) })) };
  }

  /** One row per active vehicle: its tracker and the state of its connection, plus a count of each state. */
  @Get("overview")
  async overview(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "fleet.view", "vehicles.manage", "fleet.manage");
    const rows = await withOrg(this.pool, orgId, (c) => vehicleConnections(c, new Date()));
    const counts = { not_connected: 0, waiting_first_ping: 0, connected: 0, quiet: 0, error: 0 };
    for (const r of rows) counts[r.status.state]++;
    return { counts, vehicles: rows };
  }

  @Get("vehicle/:id")
  async one(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requireAny(req, "fleet.view", "vehicles.manage", "fleet.manage");
    const row = (await withOrg(this.pool, orgId, (c) => vehicleConnections(c, new Date(), [uuid(id)])))[0];
    if (!row) throw new NotFoundException("Vehicle not found");
    const sctx = setupContext();
    return { ...row, setup: row.device?.method ? setupInstructions(row.device.method, sctx) : null, ingestUrl: sctx.ingestUrl, traccarHost: sctx.traccarHost, traccarPorts: sctx.traccarPorts };
  }

  /** Link a tracker to an existing vehicle. `replace` swaps out a tracker the vehicle already has (the old one keeps its history). */
  @Post("vehicle/:id/connect")
  async connect(@Req() req: AuthedRequest, @Param("id") id: string, @Body() raw: unknown) {
    const orgId = requirePerm(req, "fleet.manage");
    limitChecks(`${orgId}:${req.session!.userId}`);
    const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const input = readInput(b.tracker ?? raw);
    const vid = uuid(id);
    const check = await checkTracker(this.ctx(orgId), input, { vehicleId: vid });
    if (!check.canRegister) throw new BadRequestException(check.problems[0] ?? "This tracker cannot be saved.");
    const userId = /^[0-9a-f-]{36}$/.test(req.session!.userId) ? req.session!.userId : null;
    const deviceId = await withOrg(this.pool, orgId, async (c) => {
      const r = await attachTracker(c, { ...this.ctx(orgId), userId }, vid, input, { replace: b.replace === true });
      await auditChange(c, req, { action: "vehicles.connect_tracker", entity: "vehicles", entityId: vid, label: check.trackerId, old: null, next: { tracker: check.trackerId, method: input.method } });
      return r.deviceId;
    });
    const row = (await withOrg(this.pool, orgId, (c) => vehicleConnections(c, new Date(), [vid])))[0]!;
    return { deviceId, connection: row, warnings: check.warnings, heard: check.heard };
  }

  /** Unlink the tracker from the vehicle. The tracker keeps its history and can be linked again. */
  @Post("vehicle/:id/disconnect")
  @HttpCode(200)
  async disconnect(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "fleet.manage");
    const vid = uuid(id);
    return withOrg(this.pool, orgId, async (c) => {
      if (!(await c.query("SELECT 1 FROM vehicles WHERE id = $1", [vid])).rowCount) throw new NotFoundException("Vehicle not found");
      const r = await c.query<{ external_id: string }>("UPDATE devices SET vehicle_id = NULL WHERE vehicle_id = $1 RETURNING external_id", [vid]);
      await auditChange(c, req, { action: "vehicles.disconnect_tracker", entity: "vehicles", entityId: vid, label: null, old: { tracker: r.rows.map((x) => x.external_id).join(", ") || null }, next: { tracker: null } });
      return { ok: true, unlinked: r.rowCount ?? 0 };
    });
  }
}
