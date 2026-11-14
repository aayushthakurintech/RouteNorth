import type { ConnectionMethod, ConnectionState, ProviderDevice, SetupInstructions } from "@routenorth/shared";

/** Shapes of the `/portal/connections` API, as the web app uses them. */
export interface MethodMeta {
  id: ConnectionMethod; title: string; summary: string; forWho: string; idLabel: string; idPlaceholder: string; idHelp: string; needsProvider: boolean; setup: SetupInstructions;
}
export interface ProviderAccount { id: string; provider: "geotab" | "samsara"; name: string; status: string; lastError: string | null; lastSyncAt: string | null }
export interface ConnMeta { methods: MethodMeta[]; ingestUrl: string | null; traccarHost: string | null; traccarPorts: { protocol: string; port: number }[]; providers: ProviderAccount[]; gpsKeys: number }

export interface TrackerCheck {
  method: ConnectionMethod; trackerId: string; externalId: string; source: "traccar" | "feed"; warnings: string[]; claim: "free" | "yours" | "taken";
  onVehicle: { id: string; name: string } | null; heard: { lastSeen: string; messages: number } | null;
  provider: { name: string; status: string; lastError: string | null; found: ProviderDevice | null; error: string | null } | null;
  problems: string[]; setup: SetupInstructions; canRegister: boolean;
}

export interface ConnStatus { state: ConnectionState; title: string; detail: string; fixes: string[]; minutesSince: number | null }
export interface VehicleConn {
  vehicleId: string; vehicleName: string; vehicleKind: string; plate: string | null;
  device: { id: string; externalId: string; trackerId: string; method: ConnectionMethod | null; label: string | null; model: string | null; registeredAt: string } | null;
  provider: { id: string; name: string; provider: string; status: string } | null;
  lastSeen: string | null; lastPosition: { lat: number; lng: number; speedKmh: number; ignition: boolean | null } | null; status: ConnStatus;
}
export interface VehicleConnDetail extends VehicleConn { setup: SetupInstructions | null; ingestUrl: string | null; traccarHost: string | null; traccarPorts: { protocol: string; port: number }[] }
export interface ConnOverview { counts: Record<ConnectionState, number>; vehicles: VehicleConn[] }

export const STATE_LABEL: Record<ConnectionState, string> = { connected: "Connected", waiting_first_ping: "Waiting for first position", quiet: "Quiet", error: "Needs attention", not_connected: "No tracker" };
export const STATE_COLOR: Record<ConnectionState, string> = { connected: "var(--ok)", waiting_first_ping: "var(--amber)", quiet: "var(--warn)", error: "var(--danger)", not_connected: "var(--muted)" };
