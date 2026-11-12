import { withOrg, pg } from "@routenorth/db";
import { assessReading, eventsFromAttributes, type DeviceState, type Flag, type Reading, type RejectReason } from "@routenorth/shared";
import type { NormalizedFix } from "./traccar.js";

export interface StoredPosition {
  orgId: string;
  deviceId: string;
  time: string;
  lat: number;
  lng: number;
  speed: number;
  heading: number;
  ignition: boolean | null;
}

export type Outcome =
  | { kind: "unknown_device" }
  | { kind: "stored"; position: StoredPosition; flags: Flag[]; events: number }
  | { kind: "latest_only" | "history_only" | "duplicate"; orgId: string; flags: Flag[] }
  | { kind: "rejected"; reason: RejectReason; orgId: string };

export const outcomeKey = (o: Outcome): string =>
  o.kind === "rejected" ? `rejected:${o.reason}` : o.kind;

// ---- device lookup cache: every fix needs its org, and the registry changes rarely ----

interface Cached { deviceId: string; orgId: string }
const registry = new Map<string, Cached | null>();
const POSITIVE_TTL_MS = 60_000;
const NEGATIVE_TTL_MS = 30_000;
const registryExpiry = new Map<string, number>();

export function clearDeviceCache() { registry.clear(); registryExpiry.clear(); }

async function lookup(pool: pg.Pool, source: string, externalId: string): Promise<Cached | null> {
  const key = `${source}\u0000${externalId}`;
  const hit = registry.get(key);
  const exp = registryExpiry.get(key) ?? 0;
  if (registry.has(key) && exp > Date.now()) return hit ?? null;
  const found = await pool.query<{ device_id: string; org_id: string }>("SELECT device_id, org_id FROM resolve_device($1, $2)", [source, externalId]);
  const row = found.rows[0];
  const value = row ? { deviceId: row.device_id, orgId: row.org_id } : null;
  if (registry.size > 50_000) clearDeviceCache(); // unknown ids can be sent by anyone; never grow without bound
  registry.set(key, value);
  registryExpiry.set(key, Date.now() + (value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS));
  return value;
}

/** Most devices one company's feed may create by itself. Past this, new ids are dropped until someone cleans up. */
export const MAX_FEED_DEVICES = 1000;

/**
 * Devices that arrive through a company's own key. The key already says which company the data belongs to, so the
 * device is found (or created) inside that company only; "truck 12" of two companies never meets.
 */
async function lookupFeed(pool: pg.Pool, orgId: string, externalId: string): Promise<Cached | null> {
  const key = `feed\u0000${orgId}\u0000${externalId}`;
  const exp = registryExpiry.get(key) ?? 0;
  if (registry.has(key) && exp > Date.now()) return registry.get(key) ?? null;
  const deviceId = await withOrg(pool, orgId, async (c) => {
    const found = await c.query<{ id: string }>("SELECT id FROM devices WHERE source = 'feed' AND external_id = $1", [externalId]);
    if (found.rows[0]) return found.rows[0].id;
    const n = (await c.query<{ n: number }>("SELECT count(*)::int AS n FROM devices WHERE source = 'feed'")).rows[0]!.n;
    if (n >= MAX_FEED_DEVICES) return null;
    const made = await c.query<{ id: string }>(
      "INSERT INTO devices (org_id, source, external_id) VALUES ($1, 'feed', $2) ON CONFLICT (org_id, external_id) WHERE source = 'feed' DO UPDATE SET external_id = EXCLUDED.external_id RETURNING id", [orgId, externalId]);
    return made.rows[0]!.id;
  });
  const value = deviceId ? { deviceId, orgId } : null;
  if (registry.size > 50_000) clearDeviceCache();
  registry.set(key, value);
  registryExpiry.set(key, Date.now() + (value ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS));
  return value;
}

/** Consecutive impossible-jump rejections per device. In memory on purpose: it only matters within a drive. */
const jumpStreaks = new Map<string, number>();

const SENSOR_COLS = "altitude, hdop, satellites, battery_pct, ext_voltage, fuel_level_pct, rpm, engine_hours, coolant_c, signal";
const sensorValues = (f: Reading) => [f.altitude, f.hdop, f.satellites, f.batteryPct, f.extVoltage, f.fuelLevelPct, f.rpm, f.engineHours, f.coolantC, f.signal];

/**
 * The whole pipeline for one reading of a registered device: assess it, then write history, the live
 * marker and any device events in a single transaction. Unknown devices are dropped, except through a company's own feed key (`feedOrgId`), which registers them for that company.
 */
export async function ingestReading(pool: pg.Pool, source: string, fix: Reading, now: Date = new Date(), feedOrgId?: string): Promise<Outcome> {
  const dev = feedOrgId ? await lookupFeed(pool, feedOrgId, fix.externalId) : await lookup(pool, source, fix.externalId);
  if (!dev) return { kind: "unknown_device" };
  const { deviceId, orgId } = dev;

  return withOrg(pool, orgId, async (c): Promise<Outcome> => {
    const prevRow = (await c.query(
      "SELECT time, lat, lng, speed, ignition FROM latest_positions WHERE device_id = $1", [deviceId],
    )).rows[0];
    const prev: DeviceState | null = prevRow
      ? { time: new Date(prevRow.time).toISOString(), lat: prevRow.lat, lng: prevRow.lng, speed: prevRow.speed, ignition: prevRow.ignition, jumpStreak: jumpStreaks.get(deviceId) ?? 0 }
      : null;

    const verdict = assessReading(fix, prev, { now });
    if (verdict.action === "reject") {
      if (verdict.reason === "position_jump") jumpStreaks.set(deviceId, (jumpStreaks.get(deviceId) ?? 0) + 1);
      return { kind: "rejected", reason: verdict.reason, orgId };
    }
    jumpStreaks.delete(deviceId);

    const flags = verdict.flags;
    if (verdict.action === "latest_only") {
      // Parked and unchanged: say "still here, still reporting" without growing the history. Position stays where it was.
      await c.query(
        `UPDATE latest_positions SET time = $2, speed = $3, ignition = $4, received_at = now(),
           hdop = $5, satellites = $6, battery_pct = $7, ext_voltage = $8, fuel_level_pct = $9, rpm = $10,
           engine_hours = $11, coolant_c = $12, signal = $13, odometer = coalesce($14, odometer)
         WHERE device_id = $1 AND time < $2`,
        [deviceId, fix.time, fix.speed, fix.ignition, fix.hdop, fix.satellites, fix.batteryPct, fix.extVoltage, fix.fuelLevelPct, fix.rpm, fix.engineHours, fix.coolantC, fix.signal, fix.odometer],
      );
      return { kind: "latest_only", orgId, flags };
    }

    const ins = await c.query(
      `INSERT INTO positions (time, org_id, device_id, lat, lng, speed, heading, ignition, odometer, attributes, source, ${SENSOR_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21)
       ON CONFLICT (device_id, time) DO NOTHING`,
      [fix.time, orgId, deviceId, fix.lat, fix.lng, fix.speed, fix.heading, fix.ignition, fix.odometer, fix.attributes, source, ...sensorValues(fix)],
    );
    if (ins.rowCount === 0) return { kind: "duplicate", orgId, flags };

    const events = eventsFromAttributes(fix.attributes, prev?.ignition ?? null, fix.ignition);
    for (const e of events) {
      await c.query(
        `INSERT INTO device_events (org_id, device_id, time, kind, severity, value, lat, lng)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (device_id, time, kind) DO NOTHING`,
        [orgId, deviceId, fix.time, e.kind, e.severity, e.value ?? null, fix.lat, fix.lng],
      );
    }
    if (verdict.action === "history_only") return { kind: "history_only", orgId, flags };

    // Only move "latest" forward, so out-of-order packets never rewind the map.
    const latest = await c.query(
      `INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed, heading, ignition, odometer, received_at, ${SENSOR_COLS})
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now(), $10,$11,$12,$13,$14,$15,$16,$17,$18,$19)
       ON CONFLICT (device_id) DO UPDATE SET time=EXCLUDED.time, lat=EXCLUDED.lat, lng=EXCLUDED.lng,
         speed=EXCLUDED.speed, heading=EXCLUDED.heading, ignition=EXCLUDED.ignition, odometer=coalesce(EXCLUDED.odometer, latest_positions.odometer),
         received_at=now(), altitude=EXCLUDED.altitude, hdop=EXCLUDED.hdop, satellites=EXCLUDED.satellites,
         battery_pct=coalesce(EXCLUDED.battery_pct, latest_positions.battery_pct), ext_voltage=coalesce(EXCLUDED.ext_voltage, latest_positions.ext_voltage),
         fuel_level_pct=coalesce(EXCLUDED.fuel_level_pct, latest_positions.fuel_level_pct), rpm=EXCLUDED.rpm,
         engine_hours=coalesce(EXCLUDED.engine_hours, latest_positions.engine_hours), coolant_c=EXCLUDED.coolant_c,
         signal=coalesce(EXCLUDED.signal, latest_positions.signal)
       WHERE latest_positions.time < EXCLUDED.time
       RETURNING device_id`,
      [deviceId, orgId, fix.time, fix.lat, fix.lng, fix.speed, fix.heading, fix.ignition, fix.odometer, ...sensorValues(fix)],
    );
    if (latest.rowCount === 0) return { kind: "history_only", orgId, flags: [...flags, "late_arrival"] };
    return {
      kind: "stored", flags, events: events.length,
      position: { orgId, deviceId, time: fix.time, lat: fix.lat, lng: fix.lng, speed: fix.speed, heading: fix.heading, ignition: fix.ignition },
    };
  });
}

/** Older entry point: the stored position, or null when nothing moved the live marker. */
export async function storeFix(pool: pg.Pool, source: string, fix: NormalizedFix, now: Date = new Date()): Promise<StoredPosition | null> {
  const o = await ingestReading(pool, source, fix, now);
  return o.kind === "stored" ? o.position : null;
}

// ---- counters: accept/refuse tallies, flushed in batches ----

const tally = new Map<string, number>(); // `${orgId}|${outcome}` → n
const unknownTally = new Map<string, number>(); // source → n

export function countOutcome(source: string, o: Outcome) {
  if (o.kind === "unknown_device") { unknownTally.set(source, (unknownTally.get(source) ?? 0) + 1); return; }
  const k = `${o.kind === "stored" ? o.position.orgId : o.orgId}|${outcomeKey(o)}`;
  tally.set(k, (tally.get(k) ?? 0) + 1);
}

/** Write the in-memory tallies. Safe to call often; does nothing when empty. */
export async function flushCounters(pool: pg.Pool): Promise<void> {
  const rows = [...tally.entries()];
  const unknown = [...unknownTally.entries()];
  tally.clear(); unknownTally.clear();
  const byOrg = new Map<string, [string, number][]>();
  for (const [k, n] of rows) {
    const [org, outcome] = k.split("|") as [string, string];
    (byOrg.get(org) ?? byOrg.set(org, []).get(org)!).push([outcome, n]);
  }
  for (const [org, list] of byOrg) {
    await withOrg(pool, org, async (c) => {
      for (const [outcome, n] of list) {
        await c.query(
          `INSERT INTO ingest_counters (org_id, day, outcome, n) VALUES ($1, (now() AT TIME ZONE 'UTC')::date, $2, $3)
           ON CONFLICT (org_id, day, outcome) DO UPDATE SET n = ingest_counters.n + EXCLUDED.n`, [org, outcome, n]);
      }
    }).catch((err) => console.error("counter flush failed", err));
  }
  for (const [source, n] of unknown) {
    await pool.query(
      `INSERT INTO ingest_unknown (day, source, n) VALUES ((now() AT TIME ZONE 'UTC')::date, $1, $2)
       ON CONFLICT (day, source) DO UPDATE SET n = ingest_unknown.n + EXCLUDED.n`, [source, n]).catch((err) => console.error("counter flush failed", err));
  }
}
