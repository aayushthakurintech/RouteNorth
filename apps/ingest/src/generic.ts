import { mphToKmh, sensorsFromAttributes, type Reading } from "@routenorth/shared";

/**
 * A simple JSON format for anything that is not Traccar: a vendor's telematics API, a phone app, a gateway.
 *
 *   { "deviceId": "ABC123", "positions": [ { "time": "2026-11-05T12:00:00Z", "lat": 43.65, "lng": -79.38,
 *       "speedKmh": 62, "heading": 90, "ignition": true, "odometerKm": 18234.5, "sensors": { "fuelLevel": 71 } } ] }
 *
 * Speed may be given as speedKmh, speedMph or speedKnots. Sensors use the same names as Traccar attributes.
 */
export interface GenericBatch { deviceId?: unknown; positions?: unknown }

export const MAX_BATCH = 500;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function normalizeGeneric(body: GenericBatch): { readings: Reading[]; unusable: number; error?: string } {
  if (typeof body.deviceId !== "string" || !body.deviceId.trim() || body.deviceId.length > 80) return { readings: [], unusable: 0, error: "deviceId is required" };
  if (!Array.isArray(body.positions)) return { readings: [], unusable: 0, error: "positions must be a list" };
  if (body.positions.length > MAX_BATCH) return { readings: [], unusable: 0, error: `at most ${MAX_BATCH} positions per request` };
  const readings: Reading[] = [];
  let unusable = 0;
  for (const raw of body.positions) {
    const p = raw as Record<string, unknown> | null;
    const lat = num(p?.lat), lng = num(p?.lng);
    if (!p || lat == null || lng == null || typeof p.time !== "string") { unusable++; continue; }
    const t = new Date(p.time);
    const sensors = p.sensors && typeof p.sensors === "object" ? (p.sensors as Record<string, unknown>) : {};
    const kmh = num(p.speedKmh) ?? (num(p.speedMph) != null ? mphToKmh(num(p.speedMph)!) : num(p.speedKnots) != null ? Math.round(num(p.speedKnots)! * 1.852 * 10) / 10 : 0);
    const odoKm = num(p.odometerKm);
    readings.push({
      externalId: body.deviceId.trim(),
      time: Number.isNaN(t.getTime()) ? "invalid" : t.toISOString(),
      lat, lng, speed: kmh,
      heading: ((((num(p.heading) ?? 0) % 360) + 360) % 360),
      ignition: typeof p.ignition === "boolean" ? p.ignition : null,
      odometer: odoKm != null ? Math.round(odoKm * 1000) : num(p.odometerM),
      altitude: num(p.altitude),
      ...sensorsFromAttributes(sensors),
      attributes: sensors,
    });
  }
  return { readings, unusable };
}
