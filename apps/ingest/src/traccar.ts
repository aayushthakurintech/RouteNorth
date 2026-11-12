import { knotsToKmh, sensorsFromAttributes, type Reading } from "@routenorth/shared";

/** Shape of the JSON Traccar forwards for each position (only fields we use). */
export interface TraccarForward {
  position?: {
    fixTime?: string;
    latitude?: number;
    longitude?: number;
    speed?: number; // knots
    course?: number;
    valid?: boolean;
    altitude?: number;
    attributes?: Record<string, unknown>;
  };
  device?: { uniqueId?: string };
}

/** What the pipeline works with. Kept as an alias so older imports keep working. */
export type NormalizedFix = Reading;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * Convert a Traccar forward payload into a `Reading`, or null when the message cannot be a position at all
 * (no device, no coordinates, or the tracker itself says it has no GPS fix). Range and plausibility checks
 * live in `assessReading`, so that every refusal is counted with a reason.
 */
export function normalizeTraccar(msg: TraccarForward): Reading | null {
  const p = msg.position;
  const externalId = msg.device?.uniqueId;
  if (!p || !externalId || p.valid === false) return null;
  if (typeof p.latitude !== "number" || typeof p.longitude !== "number" || !p.fixTime) return null;
  const t = new Date(p.fixTime);
  const a = p.attributes ?? {};
  return {
    externalId,
    time: Number.isNaN(t.getTime()) ? "invalid" : t.toISOString(),
    lat: p.latitude,
    lng: p.longitude,
    speed: knotsToKmh(p.speed ?? 0),
    heading: (((p.course ?? 0) % 360) + 360) % 360,
    ignition: typeof a.ignition === "boolean" ? a.ignition : null,
    odometer: num(a.totalDistance),
    altitude: num(p.altitude),
    ...sensorsFromAttributes(a),
    attributes: a,
  };
}
