import { withOrg, pg } from "@routenorth/db";
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

/**
 * Persist one fix for a registered device. Returns the stored position, or null when the
 * device is not registered (unknown IMEIs are dropped) or the fix is older than the latest.
 */
export async function storeFix(
  pool: pg.Pool,
  source: string,
  fix: NormalizedFix,
): Promise<StoredPosition | null> {
  const found = await pool.query<{ device_id: string; org_id: string }>(
    "SELECT device_id, org_id FROM resolve_device($1, $2)",
    [source, fix.externalId],
  );
  const row = found.rows[0];
  if (!row) return null;
  const { device_id: deviceId, org_id: orgId } = row;

  return withOrg(pool, orgId, async (c) => {
    await c.query(
      `INSERT INTO positions (time, org_id, device_id, lat, lng, speed, heading, ignition, odometer, attributes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (device_id, time) DO NOTHING`,
      [fix.time, orgId, deviceId, fix.lat, fix.lng, fix.speed, fix.heading, fix.ignition, fix.odometer, fix.attributes],
    );
    // Only move "latest" forward, so out-of-order packets never rewind the map.
    const latest = await c.query(
      `INSERT INTO latest_positions (device_id, org_id, time, lat, lng, speed, heading, ignition)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (device_id) DO UPDATE SET time=EXCLUDED.time, lat=EXCLUDED.lat, lng=EXCLUDED.lng,
         speed=EXCLUDED.speed, heading=EXCLUDED.heading, ignition=EXCLUDED.ignition
       WHERE latest_positions.time < EXCLUDED.time
       RETURNING device_id`,
      [deviceId, orgId, fix.time, fix.lat, fix.lng, fix.speed, fix.heading, fix.ignition],
    );
    if (latest.rowCount === 0) return null;
    return {
      orgId, deviceId, time: fix.time, lat: fix.lat, lng: fix.lng,
      speed: fix.speed, heading: fix.heading, ignition: fix.ignition,
    };
  });
}
