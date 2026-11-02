import { vehicleStatus, type VehicleStatus } from "@routenorth/shared";

/** What GET /vehicles/live returns for one vehicle. */
export interface LiveVehicle {
  deviceId: string;
  vehicleId: string | null;
  name: string;
  kind: string;
  time: string;
  lat: number;
  lng: number;
  speed: number;
  heading: number;
  ignition: boolean | null;
  status: VehicleStatus;
}

/** What the WebSocket sends for each new fix. */
export interface PositionMessage {
  deviceId: string;
  time: string;
  lat: number;
  lng: number;
  speed: number;
  heading: number;
  ignition: boolean | null;
}

export interface FleetVehicle extends LiveVehicle {
  /** Recent [lng, lat] points, oldest first. */
  trail: [number, number][];
}

export type Fleet = Record<string, FleetVehicle>;

export const TRAIL_LENGTH = 60;

export function initFleet(list: LiveVehicle[]): Fleet {
  const fleet: Fleet = {};
  for (const v of list) fleet[v.deviceId] = { ...v, trail: [[v.lng, v.lat]] };
  return fleet;
}

/** Apply one streamed fix. Unknown devices and out-of-order fixes are ignored. */
export function applyPosition(fleet: Fleet, p: PositionMessage, now: Date = new Date()): Fleet {
  const v = fleet[p.deviceId];
  if (!v || new Date(p.time) <= new Date(v.time)) return fleet;
  const trail = [...v.trail, [p.lng, p.lat] as [number, number]].slice(-TRAIL_LENGTH);
  return {
    ...fleet,
    [p.deviceId]: {
      ...v, time: p.time, lat: p.lat, lng: p.lng, speed: p.speed, heading: p.heading,
      ignition: p.ignition, status: vehicleStatus(p, now), trail,
    },
  };
}

/** Recompute statuses with the clock, so silent vehicles turn offline without new data. */
export function refreshStatuses(fleet: Fleet, now: Date = new Date()): Fleet {
  let changed = false;
  const next: Fleet = {};
  for (const [id, v] of Object.entries(fleet)) {
    const status = vehicleStatus(v, now);
    if (status !== v.status) changed = true;
    next[id] = status === v.status ? v : { ...v, status };
  }
  return changed ? next : fleet;
}

export function filterFleet(fleet: Fleet, query: string): FleetVehicle[] {
  const q = query.trim().toLowerCase();
  return Object.values(fleet)
    .filter((v) => !q || v.name.toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export const STATUS_COLORS: Record<VehicleStatus, string> = {
  moving: "#1a9850",
  idle: "#f2a900",
  stopped: "#6b7280",
  offline: "#c0392b",
};
