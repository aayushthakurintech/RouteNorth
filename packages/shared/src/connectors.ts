import { mphToKmh, type Reading } from "./telemetry.js";

/**
 * Pull connectors: RouteNorth signs in to a company's own GPS provider account and pulls positions from it, for
 * providers that cannot push to a web address. Each pull starts where the last one ended (a cursor), so nothing is
 * read twice. Plain `fetch`, no Node-only imports, so the API (to check a login) and the ingest worker share it.
 *
 * Tested against recorded response shapes from the providers' public documentation, not against a live account.
 */

export type ProviderKind = "geotab" | "samsara";
export const PROVIDERS: readonly ProviderKind[] = ["geotab", "samsara"];

export interface GeotabSettings { server: string; database: string; userName: string }
export interface SamsaraSettings { region: "us" | "eu" }

export interface PullInput {
  provider: ProviderKind;
  settings: Record<string, unknown>;
  /** Geotab: the password. Samsara: the API token. */
  secret: string;
  cursor: string | null;
}

export interface PullResult {
  readings: Reading[];
  /** Where the next pull starts. */
  cursor: string | null;
  /** True when the provider has more waiting; the worker pulls again soon instead of waiting a full interval. */
  more: boolean;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal }) =>
  Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** A failure worth showing the owner. `auth` means the saved login is wrong or was revoked: retrying will not help. */
export class ConnectorError extends Error {
  constructor(message: string, readonly auth = false) { super(message); this.name = "ConnectorError"; }
}

const base = (externalId: string, time: string, lat: number, lng: number, speed: number, heading: number, ignition: boolean | null, attributes: Record<string, unknown> = {}): Reading => ({
  externalId, time, lat, lng, speed, heading, ignition, odometer: null, altitude: null, hdop: null, satellites: null,
  batteryPct: null, extVoltage: null, fuelLevelPct: null, rpm: null, engineHours: null, coolantC: null, signal: null, attributes,
});

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
const iso = (v: unknown): string | null => { const t = Date.parse(str(v)); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

// ---------------------------------------------------------------- Geotab (MyGeotab JSON-RPC API)

/** Only Geotab's own servers: the server name is typed by a customer, so it must never point the worker elsewhere. */
export const isGeotabServer = (s: string) => /^([a-z0-9-]+\.)*geotab\.com$/i.test(s) && s.length <= 100;

export function geotabSettings(v: Record<string, unknown>): GeotabSettings | string {
  const server = (str(v.server).trim().toLowerCase() || "my.geotab.com").replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  const database = str(v.database).trim();
  const userName = str(v.userName).trim();
  if (!isGeotabServer(server)) return "server must be a geotab.com address, for example my.geotab.com";
  if (!database || database.length > 100) return "database is required (the name you type when signing in to MyGeotab)";
  if (!userName || userName.length > 200) return "user name is required";
  return { server, database, userName };
}

interface GeotabSession { server: string; credentials: { database: string; userName: string; sessionId: string } }
/** Sessions last about two weeks; keeping them avoids signing in on every pull. Keyed by server, database and user. */
const geotabSessions = new Map<string, GeotabSession>();
export function clearConnectorSessions() { geotabSessions.clear(); }

async function geotabCall(fetchFn: FetchLike, server: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  let res;
  try {
    res = await fetchFn(`https://${server}/apiv1`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ method, params }), signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ConnectorError(`could not reach ${server}`);
  }
  if (!res.ok) throw new ConnectorError(`${server} answered ${res.status}`);
  const body = (await res.json()) as { result?: unknown; error?: { message?: string; errors?: { name?: string; message?: string }[] } };
  if (body.error) {
    const name = body.error.errors?.[0]?.name ?? "";
    const auth = /InvalidUser|DbUnavailable|Unauthorized/i.test(name);
    throw new ConnectorError(auth ? "Geotab refused the login: check the database, user name and password" : `Geotab error: ${body.error.message ?? name ?? "unknown"}`, auth);
  }
  return body.result;
}

async function geotabSession(fetchFn: FetchLike, s: GeotabSettings, password: string, fresh = false): Promise<GeotabSession> {
  const key = `${s.server}\u0000${s.database}\u0000${s.userName}`;
  const hit = geotabSessions.get(key);
  if (hit && !fresh) return hit;
  const r = (await geotabCall(fetchFn, s.server, "Authenticate", { database: s.database, userName: s.userName, password })) as { credentials?: GeotabSession["credentials"]; path?: string };
  if (!r?.credentials?.sessionId) throw new ConnectorError("Geotab sign-in gave no session", true);
  // Geotab may answer that the database lives on another of its servers.
  const path = str(r.path);
  const server = path && path !== "ThisServer" && isGeotabServer(path) ? path : s.server;
  const session = { server, credentials: r.credentials };
  if (geotabSessions.size > 1000) geotabSessions.clear();
  geotabSessions.set(key, session);
  return session;
}

/** One Geotab LogRecord (a GPS point) as a reading. Geotab speed is already km/h; LogRecord carries no heading. */
export function geotabReading(rec: unknown): Reading | null {
  const r = rec as { dateTime?: unknown; latitude?: unknown; longitude?: unknown; speed?: unknown; device?: { id?: unknown } };
  const time = iso(r?.dateTime);
  const lat = num(r?.latitude), lng = num(r?.longitude);
  const id = str(r?.device?.id);
  if (!time || lat == null || lng == null || !id || (lat === 0 && lng === 0)) return null;
  return base(`geotab:${id}`, time, lat, lng, Math.max(0, num(r.speed) ?? 0), 0, null);
}

async function pullGeotab(fetchFn: FetchLike, input: PullInput, now: Date): Promise<PullResult> {
  const s = geotabSettings(input.settings);
  if (typeof s === "string") throw new ConnectorError(s, true);
  const LIMIT = 5000;
  const feed = async (session: GeotabSession) => (await geotabCall(fetchFn, session.server, "GetFeed", {
    typeName: "LogRecord", resultsLimit: LIMIT, credentials: session.credentials,
    // First pull: start an hour back rather than at the beginning of the account's history.
    ...(input.cursor ? { fromVersion: input.cursor } : { search: { fromDate: new Date(now.getTime() - 3_600_000).toISOString() } }),
  })) as { data?: unknown[]; toVersion?: string };
  let session = await geotabSession(fetchFn, s, input.secret);
  let out;
  try {
    out = await feed(session);
  } catch (e) {
    if (!(e instanceof ConnectorError && e.auth)) throw e;
    session = await geotabSession(fetchFn, s, input.secret, true); // the session expired: sign in again once
    out = await feed(session);
  }
  const data = Array.isArray(out?.data) ? out.data : [];
  return { readings: data.map(geotabReading).filter((x): x is Reading => !!x), cursor: str(out?.toVersion) || input.cursor, more: data.length >= LIMIT };
}

// ---------------------------------------------------------------- Samsara (REST API, vehicle stats feed)

export function samsaraSettings(v: Record<string, unknown>): SamsaraSettings | string {
  const region = str(v.region) || "us";
  return region === "us" || region === "eu" ? { region } : "region must be us or eu";
}
const samsaraHost = (s: SamsaraSettings) => (s.region === "eu" ? "https://api.eu.samsara.com" : "https://api.samsara.com");

const ENGINE: Record<string, boolean> = { On: true, Idle: true, Off: false };

/** One Samsara vehicle's GPS points, with ignition taken from the newest engine state at or before each point. */
export function samsaraReadings(vehicle: unknown): Reading[] {
  const v = vehicle as { id?: unknown; gps?: unknown[]; engineStates?: { time?: unknown; value?: unknown }[] };
  const id = str(v?.id);
  if (!id || !Array.isArray(v.gps)) return [];
  const states = (Array.isArray(v.engineStates) ? v.engineStates : [])
    .map((e) => ({ t: Date.parse(str(e.time)), on: ENGINE[str(e.value)] }))
    .filter((e) => Number.isFinite(e.t) && e.on !== undefined)
    .sort((a, b) => a.t - b.t);
  const out: Reading[] = [];
  for (const g of v.gps as Record<string, unknown>[]) {
    const time = iso(g?.time);
    const lat = num(g?.latitude), lng = num(g?.longitude);
    if (!time || lat == null || lng == null || (lat === 0 && lng === 0)) continue;
    const t = Date.parse(time);
    let ignition: boolean | null = null;
    for (const s of states) { if (s.t <= t) ignition = s.on!; else break; }
    out.push(base(`samsara:${id}`, time, lat, lng, mphToKmh(Math.max(0, num(g.speedMilesPerHour) ?? 0)), Math.round(num(g.headingDegrees) ?? 0) % 360, ignition));
  }
  return out;
}

async function pullSamsara(fetchFn: FetchLike, input: PullInput): Promise<PullResult> {
  const s = samsaraSettings(input.settings);
  if (typeof s === "string") throw new ConnectorError(s, true);
  const readings: Reading[] = [];
  let cursor = input.cursor;
  let more = false;
  // A few pages per pull; the rest waits for the next pull so one big fleet cannot hold the worker.
  for (let page = 0; page < 5; page++) {
    const url = `${samsaraHost(s)}/fleet/vehicles/stats/feed?types=gps,engineStates${cursor ? `&after=${encodeURIComponent(cursor)}` : ""}`;
    let res;
    try {
      res = await fetchFn(url, { method: "GET", headers: { authorization: `Bearer ${input.secret}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
    } catch {
      throw new ConnectorError("could not reach Samsara");
    }
    if (res.status === 401 || res.status === 403) throw new ConnectorError("Samsara refused the API token: check it has read access to vehicle statistics", true);
    if (res.status === 429) { more = true; break; }
    if (!res.ok) throw new ConnectorError(`Samsara answered ${res.status}`);
    const body = (await res.json()) as { data?: unknown[]; pagination?: { endCursor?: unknown; hasNextPage?: unknown } };
    for (const v of Array.isArray(body.data) ? body.data : []) readings.push(...samsaraReadings(v));
    cursor = str(body.pagination?.endCursor) || cursor;
    more = body.pagination?.hasNextPage === true;
    if (!more) break;
  }
  return { readings, cursor, more };
}

// ---------------------------------------------------------------- shared entry points

/** Settings checked and cleaned for storage, or a sentence saying what is wrong. */
export function cleanProviderSettings(provider: ProviderKind, v: Record<string, unknown>): Record<string, unknown> | string {
  const r = provider === "geotab" ? geotabSettings(v) : samsaraSettings(v);
  return typeof r === "string" ? r : { ...r };
}

/** Pull what is new since `cursor`. Readings are oldest first. */
export async function pullProvider(input: PullInput, fetchFn: FetchLike, now = new Date()): Promise<PullResult> {
  const r = input.provider === "geotab" ? await pullGeotab(fetchFn, input, now) : await pullSamsara(fetchFn, input);
  r.readings.sort((a, b) => Date.parse(a.time) - Date.parse(b.time));
  return r;
}

/** Check a login before saving it. Resolves when the provider accepts it; throws ConnectorError otherwise. */
export async function checkProvider(input: Omit<PullInput, "cursor">, fetchFn: FetchLike): Promise<void> {
  if (input.provider === "geotab") {
    const s = geotabSettings(input.settings);
    if (typeof s === "string") throw new ConnectorError(s, true);
    await geotabSession(fetchFn, s, input.secret, true);
    return;
  }
  const s = samsaraSettings(input.settings);
  if (typeof s === "string") throw new ConnectorError(s, true);
  let res;
  try {
    res = await fetchFn(`${samsaraHost(s)}/fleet/vehicles?limit=1`, { method: "GET", headers: { authorization: `Bearer ${input.secret}`, accept: "application/json" }, signal: AbortSignal.timeout(30_000) });
  } catch {
    throw new ConnectorError("could not reach Samsara");
  }
  if (res.status === 401 || res.status === 403) throw new ConnectorError("Samsara refused the API token: check it has read access to vehicles", true);
  if (!res.ok) throw new ConnectorError(`Samsara answered ${res.status}`);
}

/** How long to wait after a failed pull: one minute, doubling, at most 30 minutes; a refused login waits an hour. */
export function backoffMs(failures: number, auth: boolean): number {
  if (auth) return 3_600_000;
  return Math.min(30 * 60_000, 60_000 * 2 ** Math.max(0, failures - 1));
}
