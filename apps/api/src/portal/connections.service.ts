import { BadRequestException, ConflictException, NotFoundException } from "@nestjs/common";
import { decryptSecret, pg, withOrg } from "@routenorth/db";
import {
  CONNECTION_METHODS, connectionStatus, deviceExternalId, displayTrackerId, listProviderDevices, normalizeTrackerId, setupInstructions, sourceForMethod,
  ConnectorError, type ConnectionMethod, type ConnectionStatus, type FetchLike, type ProviderDevice, type SetupContext,
} from "@routenorth/shared";

/** What an owner sends to link a tracker to a vehicle. */
export interface TrackerInput {
  method: ConnectionMethod;
  trackerId: string;
  /** Geotab and Samsara: which saved provider login the vehicle belongs to. */
  providerConnectionId?: string | null;
  label?: string | null;
}

export type ClaimState = "free" | "yours" | "taken";

export interface TrackerCheck {
  method: ConnectionMethod;
  /** The ID cleaned up the way it will be stored for the owner to see (no provider tag). */
  trackerId: string;
  externalId: string;
  source: "traccar" | "feed";
  warnings: string[];
  claim: ClaimState;
  /** The vehicle this ID is already on, in this company. */
  onVehicle: { id: string; name: string } | null;
  /** A tracker with this ID reached us recently but was not registered. */
  heard: { lastSeen: string; messages: number } | null;
  provider: { name: string; status: string; lastError: string | null; found: ProviderDevice | null; error: string | null } | null;
  /** Problems that stop it being saved, in plain words. */
  problems: string[];
  setup: ReturnType<typeof setupInstructions>;
  canRegister: boolean;
}

/** Where the server says trackers and providers should send data. Set by whoever runs this install. */
export function setupContext(): SetupContext {
  const base = (process.env.INGEST_PUBLIC_URL ?? "").trim().replace(/\/+$/, "");
  const host = (process.env.TRACCAR_PUBLIC_HOST ?? "").trim();
  // "Teltonika:5027,OsmAnd:5055"
  const ports = (process.env.TRACCAR_PORTS ?? "").split(",").map((p) => p.trim()).filter(Boolean).map((p) => {
    const [protocol, port] = p.split(":");
    return { protocol: (protocol ?? "").trim(), port: Number(port) };
  }).filter((p) => p.protocol && Number.isInteger(p.port) && p.port > 0 && p.port < 65536);
  return { ingestUrl: base || null, traccarHost: host || null, traccarPorts: ports };
}

export function readInput(raw: unknown): TrackerInput {
  const b = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const method = String(b.method ?? "") as ConnectionMethod;
  if (!CONNECTION_METHODS.includes(method)) throw new BadRequestException(`method must be one of ${CONNECTION_METHODS.join(", ")}`);
  const providerConnectionId = b.providerConnectionId == null || b.providerConnectionId === "" ? null : String(b.providerConnectionId);
  if (providerConnectionId && !/^[0-9a-f-]{36}$/i.test(providerConnectionId)) throw new BadRequestException("providerConnectionId must be an id");
  return {
    method, trackerId: typeof b.trackerId === "string" ? b.trackerId : "", providerConnectionId,
    label: typeof b.label === "string" && b.label.trim() ? b.label.trim().slice(0, 80) : null,
  };
}

interface Ctx { pool: pg.Pool; orgId: string; secret: string; fetchFn: FetchLike }

/** Everything an owner needs to know about one tracker ID before saving it. Writes nothing. */
export async function checkTracker(x: Ctx, input: TrackerInput, opts: { vehicleId?: string | null } = {}): Promise<TrackerCheck> {
  const { method } = input;
  const source = sourceForMethod(method);
  const problems: string[] = [];
  const norm = normalizeTrackerId(method, input.trackerId);
  const setup = setupInstructions(method, setupContext());
  const empty: TrackerCheck = { method, trackerId: String(input.trackerId ?? "").trim(), externalId: "", source, warnings: [], claim: "free", onVehicle: null, heard: null, provider: null, problems, setup, canRegister: false };
  if (!norm.ok) { problems.push(norm.error); return empty; }
  const externalId = deviceExternalId(method, norm.id);
  const out: TrackerCheck = { ...empty, trackerId: norm.id, externalId, warnings: norm.warnings };

  // Who has this ID? A tracker (Traccar) ID is one list for everyone, so another company may already hold it;
  // a feed or pulled ID only has to be new inside this company.
  const claim: ClaimState = source === "traccar"
    ? (await x.pool.query<{ s: ClaimState }>("SELECT device_claim_state($1, $2, $3) AS s", [source, externalId, x.orgId])).rows[0]!.s
    : (await withOrg(x.pool, x.orgId, (c) => c.query("SELECT 1 FROM devices WHERE source = 'feed' AND external_id = $1", [externalId]))).rowCount ? "yours" : "free";
  out.claim = claim;
  if (claim === "taken") problems.push("That tracker ID is already registered by another company on RouteNorth. If it is yours, check the number and contact support so it can be moved.");
  if (claim === "yours" || (source === "feed" && claim !== "taken")) {
    const mine = await withOrg(x.pool, x.orgId, async (c) => (await c.query<{ vid: string; name: string }>(
      "SELECT v.id AS vid, v.name FROM devices d JOIN vehicles v ON v.id = d.vehicle_id WHERE d.source = $1 AND d.external_id = $2 AND v.archived_at IS NULL", [source, externalId])).rows[0]);
    if (mine && mine.vid !== opts.vehicleId) { out.onVehicle = { id: mine.vid, name: mine.name }; problems.push(`This tracker is already on ${mine.name}. Move it from that vehicle first.`); }
  }

  if (claim === "free" && source === "traccar") {
    const h = (await x.pool.query<{ last_seen: Date; n: string }>("SELECT last_seen, n FROM heard_from_unregistered($1, $2)", [source, externalId])).rows[0];
    if (h) out.heard = { lastSeen: new Date(h.last_seen).toISOString(), messages: Number(h.n) };
  }

  if (method === "geotab" || method === "samsara") {
    if (!input.providerConnectionId) {
      problems.push(`Choose which ${method === "geotab" ? "Geotab" : "Samsara"} account this vehicle is in. Add the account on the Connect your GPS page first if it is not listed.`);
    } else {
      const row = await withOrg(x.pool, x.orgId, async (c) => (await c.query<{ id: string; provider: string; name: string; settings: Record<string, unknown>; secret_enc: string; status: string; last_error: string | null }>(
        "SELECT id, provider, name, settings, secret_enc, status, last_error FROM provider_connections WHERE id = $1", [input.providerConnectionId])).rows[0]);
      if (!row) problems.push("That provider account was not found.");
      else if (row.provider !== method) problems.push(`That account is ${row.provider === "geotab" ? "Geotab" : "Samsara"}, not ${method === "geotab" ? "Geotab" : "Samsara"}.`);
      else {
        const p: NonNullable<TrackerCheck["provider"]> = { name: row.name, status: row.status, lastError: row.last_error, found: null, error: null };
        out.provider = p;
        const secret = decryptSecret(x.secret, row.secret_enc);
        if (secret == null) p.error = "The saved login cannot be read any more (the server's encryption key changed). Enter the login again on the Connect your GPS page.";
        else {
          try {
            const list = await listProviderDevices({ provider: method, settings: row.settings, secret }, x.fetchFn);
            p.found = list.find((d) => d.id === norm.id) ?? null;
            if (!p.found) p.error = `${method === "geotab" ? "Geotab" : "Samsara"} did not list a vehicle with ID ${norm.id}. Check the ID, or that the vehicle is in this account.`;
          } catch (e) {
            p.error = e instanceof ConnectorError ? e.message : "Could not ask the provider for its vehicle list.";
          }
        }
        if (p.error) problems.push(p.error);
      }
    }
  }

  out.canRegister = problems.length === 0;
  return out;
}

/**
 * Link a tracker to a vehicle inside the caller's open transaction. A device with this ID that already exists in this
 * company (a pulled or feed device that arrived before anyone claimed it) is reused, so its history stays with it.
 */
export async function attachTracker(c: pg.PoolClient, x: Ctx & { userId: string | null }, vehicleId: string, input: TrackerInput, opts: { replace?: boolean } = {}): Promise<{ deviceId: string }> {
  const norm = normalizeTrackerId(input.method, input.trackerId);
  if (!norm.ok) throw new BadRequestException(norm.error);
  const source = sourceForMethod(input.method);
  const externalId = deviceExternalId(input.method, norm.id);
  if (!(await c.query("SELECT 1 FROM vehicles WHERE id = $1", [vehicleId])).rowCount) throw new NotFoundException("Vehicle not found");
  if ((input.method === "geotab" || input.method === "samsara")) {
    if (!input.providerConnectionId) throw new BadRequestException("Choose the provider account this vehicle is in.");
    const pc = (await c.query<{ provider: string }>("SELECT provider FROM provider_connections WHERE id = $1", [input.providerConnectionId])).rows[0];
    if (!pc || pc.provider !== input.method) throw new BadRequestException("That provider account was not found.");
  }
  const existing = (await c.query<{ id: string; vehicle_id: string | null }>("SELECT id, vehicle_id FROM devices WHERE source = $1 AND external_id = $2", [source, externalId])).rows[0];
  if (existing?.vehicle_id && existing.vehicle_id !== vehicleId) throw new ConflictException("This tracker is already on another vehicle. Move it from that vehicle first.");
  const onVehicle = (await c.query<{ id: string; external_id: string }>("SELECT id, external_id FROM devices WHERE vehicle_id = $1 AND id <> coalesce($2::uuid, '00000000-0000-0000-0000-000000000000')", [vehicleId, existing?.id ?? null])).rows;
  if (onVehicle.length && !opts.replace) throw new ConflictException(`This vehicle already has a tracker (${displayTrackerId(onVehicle[0]!.external_id)}). Replace it, or disconnect it first.`);
  if (onVehicle.length) await c.query("UPDATE devices SET vehicle_id = NULL WHERE vehicle_id = $1 AND id = ANY($2::uuid[])", [vehicleId, onVehicle.map((d) => d.id)]);

  const label = input.label ?? null;
  if (existing) {
    await c.query("UPDATE devices SET vehicle_id = $2, connection_method = $3, provider_connection_id = $4, label = coalesce($5, label), registered_by = coalesce(registered_by, $6) WHERE id = $1",
      [existing.id, vehicleId, input.method, input.providerConnectionId ?? null, label, x.userId]);
    return { deviceId: existing.id };
  }
  try {
    const r = await c.query<{ id: string }>(
      "INSERT INTO devices (org_id, source, external_id, vehicle_id, label, connection_method, provider_connection_id, registered_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id",
      [x.orgId, source, externalId, vehicleId, label, input.method, input.providerConnectionId ?? null, x.userId]);
    return { deviceId: r.rows[0]!.id };
  } catch (e) {
    if ((e as { code?: string }).code === "23505") throw new ConflictException("That tracker ID is already registered by another company on RouteNorth.");
    throw e;
  }
}

export interface VehicleConnection {
  vehicleId: string;
  vehicleName: string;
  vehicleKind: string;
  plate: string | null;
  device: { id: string; externalId: string; trackerId: string; method: ConnectionMethod | null; label: string | null; model: string | null; registeredAt: string } | null;
  provider: { id: string; name: string; provider: string; status: string } | null;
  lastSeen: string | null;
  lastPosition: { lat: number; lng: number; speedKmh: number; ignition: boolean | null } | null;
  status: ConnectionStatus;
}

/** Connection state for active vehicles (or just the listed ones). One query, newest tracker per vehicle. */
export async function vehicleConnections(c: pg.PoolClient, now: Date, ids?: string[]): Promise<VehicleConnection[]> {
  const rows = (await c.query(
    `SELECT v.id AS vehicle_id, v.name, v.kind, v.plate,
            d.id AS device_id, d.external_id, d.source, d.connection_method, d.label, d.model, d.created_at AS registered_at, d.provider_connection_id,
            lp.time AS last_seen, lp.lat, lp.lng, lp.speed, lp.ignition,
            pc.name AS pc_name, pc.provider AS pc_provider, pc.status AS pc_status, pc.last_error AS pc_error, pc.last_sync_at AS pc_sync
       FROM vehicles v
       LEFT JOIN LATERAL (SELECT * FROM devices dd WHERE dd.vehicle_id = v.id ORDER BY (SELECT max(time) FROM latest_positions l WHERE l.device_id = dd.id) DESC NULLS LAST, dd.created_at DESC LIMIT 1) d ON true
       LEFT JOIN latest_positions lp ON lp.device_id = d.id
       LEFT JOIN provider_connections pc ON pc.id = d.provider_connection_id
      WHERE v.archived_at IS NULL AND v.status NOT IN ('sold','retired') AND ($1::uuid[] IS NULL OR v.id = ANY($1))
      ORDER BY v.name LIMIT 2000`, [ids ?? null])).rows;
  return rows.map((r): VehicleConnection => {
    const method = (r.connection_method as ConnectionMethod | null) ?? (r.device_id ? (r.source === "traccar" ? "traccar" : "feed") : null);
    const lastSeen = r.last_seen ? new Date(r.last_seen).toISOString() : null;
    const provider = r.provider_connection_id ? { id: r.provider_connection_id as string, name: r.pc_name as string, provider: r.pc_provider as string, status: r.pc_status as string } : null;
    return {
      vehicleId: r.vehicle_id, vehicleName: r.name, vehicleKind: r.kind, plate: r.plate,
      device: r.device_id ? { id: r.device_id, externalId: r.external_id, trackerId: displayTrackerId(r.external_id), method, label: r.label, model: r.model, registeredAt: new Date(r.registered_at).toISOString() } : null,
      provider, lastSeen,
      lastPosition: r.last_seen ? { lat: r.lat, lng: r.lng, speedKmh: Math.round(r.speed), ignition: r.ignition } : null,
      status: connectionStatus({
        method, hasDevice: !!r.device_id, registeredAt: r.registered_at ? new Date(r.registered_at).toISOString() : null, lastSeen, now,
        provider: provider ? { status: r.pc_status, lastError: r.pc_error, lastSyncAt: r.pc_sync ? new Date(r.pc_sync).toISOString() : null } : null,
      }),
    };
  });
}
