/** A single GPS fix from any source (Traccar, vendor API, simulator). */
export interface Position {
  orgId: string;
  deviceId: string;
  /** ISO 8601 UTC timestamp of the fix (device time). */
  time: string;
  lat: number;
  lng: number;
  /** km/h */
  speed: number;
  /** degrees, 0-359 */
  heading: number;
  ignition: boolean | null;
  /** metres */
  odometer: number | null;
  attributes: Record<string, unknown>;
}

export type VehicleStatus = "moving" | "idle" | "stopped" | "offline";

/** Fixes older than this mark a vehicle offline. */
export const OFFLINE_AFTER_SECONDS = 10 * 60;

export function vehicleStatus(
  p: Pick<Position, "time" | "speed" | "ignition">,
  now: Date = new Date(),
): VehicleStatus {
  const ageSeconds = (now.getTime() - new Date(p.time).getTime()) / 1000;
  if (ageSeconds > OFFLINE_AFTER_SECONDS) return "offline";
  if (p.speed >= 3) return "moving";
  return p.ignition ? "idle" : "stopped";
}

export function isValidPosition(p: Pick<Position, "lat" | "lng" | "speed">): boolean {
  return (
    Number.isFinite(p.lat) && Number.isFinite(p.lng) &&
    p.lat >= -90 && p.lat <= 90 && p.lng >= -180 && p.lng <= 180 &&
    p.speed >= 0 && p.speed < 300
  );
}
