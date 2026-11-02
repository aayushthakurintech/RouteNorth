import { isValidPosition } from "@routenorth/shared";

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

export interface NormalizedFix {
  externalId: string;
  time: string;
  lat: number;
  lng: number;
  speed: number; // km/h
  heading: number;
  ignition: boolean | null;
  odometer: number | null;
  attributes: Record<string, unknown>;
}

const KNOTS_TO_KMH = 1.852;

/** Convert a Traccar forward payload into our position shape, or null if unusable. */
export function normalizeTraccar(msg: TraccarForward, now: Date = new Date()): NormalizedFix | null {
  const p = msg.position;
  const externalId = msg.device?.uniqueId;
  if (!p || !externalId || p.valid === false) return null;
  if (typeof p.latitude !== "number" || typeof p.longitude !== "number" || !p.fixTime) return null;

  const t = new Date(p.fixTime);
  if (Number.isNaN(t.getTime())) return null;
  // Drop fixes from the future (bad device clock); allow a minute of skew.
  if (t.getTime() > now.getTime() + 60_000) return null;

  const speed = Math.round((p.speed ?? 0) * KNOTS_TO_KMH * 10) / 10;
  if (!isValidPosition({ lat: p.latitude, lng: p.longitude, speed })) return null;

  const a = p.attributes ?? {};
  return {
    externalId,
    time: t.toISOString(),
    lat: p.latitude,
    lng: p.longitude,
    speed,
    heading: ((p.course ?? 0) % 360 + 360) % 360,
    ignition: typeof a.ignition === "boolean" ? a.ignition : null,
    odometer: typeof a.totalDistance === "number" ? a.totalDistance : null,
    attributes: a,
  };
}
