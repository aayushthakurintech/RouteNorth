/**
 * How a vehicle's tracker reaches RouteNorth, in words an owner can act on.
 *
 * Pure functions, no I/O, shared by the API (which resolves a tracker ID and reports a vehicle's connection state)
 * and the web app (which shows the same words in the Add vehicle flow and on the connection panel).
 *
 * Nothing here talks to a tracker or a provider. It explains and classifies; the ingest service and the provider
 * connectors do the real work. Tested against made-up IDs and times, not against real hardware.
 */

export const CONNECTION_METHODS = ["traccar", "feed", "geotab", "samsara"] as const;
export type ConnectionMethod = (typeof CONNECTION_METHODS)[number];

/** The `devices.source` a method stores. Pulled providers and company feeds both arrive through the company's own feed. */
export const sourceForMethod = (m: ConnectionMethod): "traccar" | "feed" => (m === "traccar" ? "traccar" : "feed");

/**
 * The id the ingest pipeline stores for a device. The pull connectors tag every reading with the provider name
 * (`geotab:b1F`, `samsara:2120…`) so ids from different providers never collide; a tracker, or a feed, uses the id as is.
 */
export const deviceExternalId = (m: ConnectionMethod, id: string): string => (m === "geotab" ? `geotab:${id}` : m === "samsara" ? `samsara:${id}` : id);
/** The id an owner recognises: the stored id without the provider tag. */
export const displayTrackerId = (externalId: string): string => externalId.replace(/^(geotab|samsara):/, "");

export interface MethodInfo {
  id: ConnectionMethod;
  title: string;
  /** One line an owner understands without knowing what a protocol is. */
  summary: string;
  /** Who it is for. */
  forWho: string;
  /** Label of the ID field. */
  idLabel: string;
  idPlaceholder: string;
  /** Where to find that number. */
  idHelp: string;
  /** True when a saved provider login is needed first. */
  needsProvider: boolean;
}

export const METHOD_INFO: Record<ConnectionMethod, MethodInfo> = {
  traccar: {
    id: "traccar", title: "Tracker to RouteNorth", summary: "Point the tracker at RouteNorth's server. You only need its IMEI.",
    forWho: "A plug-in or hard-wired GPS tracker you own and can set up, or an installer can.",
    idLabel: "Tracker ID (IMEI)", idPlaceholder: "356307042441013",
    idHelp: "Printed on the tracker's label, usually 15 digits and called IMEI. Some trackers use a serial number instead.",
    needsProvider: false,
  },
  feed: {
    id: "feed", title: "My GPS company sends it", summary: "Your GPS provider, your own Traccar server or a gateway pushes positions to RouteNorth with your key.",
    forWho: "You already pay a GPS provider that can forward data, or you run your own Traccar.",
    idLabel: "Device ID in their system", idPlaceholder: "truck-12 or 356307042441013",
    idHelp: "The exact ID your provider or Traccar puts on each position. Look at one position in their portal or export.",
    needsProvider: false,
  },
  geotab: {
    id: "geotab", title: "Geotab account", summary: "RouteNorth signs in to your MyGeotab account and reads your vehicles' positions.",
    forWho: "Fleets that use Geotab GO devices.",
    idLabel: "Geotab device ID", idPlaceholder: "b1F",
    idHelp: "In MyGeotab open Vehicles, then the vehicle. The ID is in the address bar after \"device:\", it looks like b1F.",
    needsProvider: true,
  },
  samsara: {
    id: "samsara", title: "Samsara account", summary: "RouteNorth uses an API token from your Samsara dashboard to read your vehicles' positions.",
    forWho: "Fleets that use Samsara vehicle gateways.",
    idLabel: "Samsara vehicle ID", idPlaceholder: "212014918086169",
    idHelp: "In Samsara open Fleet, then the vehicle. The number at the end of the address is the vehicle ID.",
    needsProvider: true,
  },
};

/** Luhn check, the check digit every real IMEI carries in its last place. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  let dbl = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = digits.charCodeAt(i) - 48;
    if (dbl) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
    dbl = !dbl;
  }
  return sum % 10 === 0;
}

export type TrackerIdResult =
  | { ok: true; id: string; warnings: string[]; kind: "imei" | "serial" | "provider" }
  | { ok: false; error: string };

const ID_CHARS = /^[A-Za-z0-9._:-]{3,80}$/;

/**
 * Clean what an owner typed or pasted (spaces, dashes inside a number, a trailing comma) and say what is wrong in plain
 * words. A 15-digit number must pass the IMEI check digit: a mistyped IMEI is the most common reason a tracker never
 * shows up, and this catches it before anything is saved.
 */
export function normalizeTrackerId(method: ConnectionMethod, raw: string): TrackerIdResult {
  const trimmed = String(raw ?? "").trim().replace(/[,;]+$/, "");
  if (!trimmed) return { ok: false, error: "Enter the tracker's ID." };
  const warnings: string[] = [];
  // A number written as "356 307 042 441 013" or "356307-042441-013" is one number.
  const compact = /^[\d\s-]+$/.test(trimmed) ? trimmed.replace(/[\s-]+/g, "") : trimmed;
  if (/\s/.test(compact)) return { ok: false, error: "The ID has spaces in it. Copy just the ID, without any other words." };
  if (!ID_CHARS.test(compact)) return { ok: false, error: "The ID can only use letters, digits and . _ : - and must be 3 to 80 characters long." };

  if (method === "traccar" || method === "feed") {
    if (/^\d{15}$/.test(compact)) {
      if (!luhnValid(compact)) return { ok: false, error: "That number does not pass the IMEI check. Compare it with the label on the tracker; one digit is probably wrong." };
      return { ok: true, id: compact, warnings, kind: "imei" };
    }
    if (/^\d{14,17}$/.test(compact)) warnings.push("IMEIs are 15 digits. If this is the tracker's serial number instead, that is fine, but check it matches what the tracker sends.");
    else if (/^\d{1,13}$/.test(compact) && compact.length >= 3) warnings.push("This is a short number. Use it only if your tracker or Traccar reports exactly this ID.");
    return { ok: true, id: compact, warnings, kind: /^\d+$/.test(compact) ? "serial" : "provider" };
  }
  if (method === "geotab") {
    if (!/^b[0-9A-Fa-f]{1,8}$/.test(compact)) warnings.push("Geotab device IDs usually start with b followed by letters or digits, like b1F. Check you copied the device ID, not the vehicle name.");
    return { ok: true, id: compact, warnings, kind: "provider" };
  }
  if (!/^\d{6,20}$/.test(compact)) warnings.push("Samsara vehicle IDs are long numbers. Check you copied the vehicle ID, not the vehicle name.");
  return { ok: true, id: compact, warnings, kind: "provider" };
}

// ------------------------------------------------------------------------------------------------ state

export type ConnectionState = "not_connected" | "waiting_first_ping" | "connected" | "quiet" | "error";

export interface ConnectionStatusInput {
  method: ConnectionMethod | null;
  /** Is a tracker registered on this vehicle at all? */
  hasDevice: boolean;
  /** When the tracker was registered. */
  registeredAt: string | null;
  /** Time of the newest position, if any. */
  lastSeen: string | null;
  /** Pull providers only: the saved login's state. */
  provider?: { status: "pending" | "ok" | "error" | "paused"; lastError: string | null; lastSyncAt: string | null } | null;
  now: Date;
}

export interface ConnectionStatus {
  state: ConnectionState;
  title: string;
  detail: string;
  /** What to try, in plain language, most likely first. Empty when nothing is wrong. */
  fixes: string[];
  /** How long since the last position, in minutes, or null. */
  minutesSince: number | null;
}

/** A position newer than this counts as live. Most trackers report every 10 to 60 seconds while driving and about every 10 minutes while parked. */
export const LIVE_WITHIN_MIN = 15;
/** Past this long without a first position, the owner is shown the full checklist instead of "give it a few minutes". */
export const FIRST_PING_PATIENCE_MIN = 10;

const minutes = (a: string, now: Date) => Math.max(0, Math.round((now.getTime() - Date.parse(a)) / 60_000));
export function ago(min: number): string {
  if (min < 1) return "just now";
  if (min < 60) return `${min} minute${min === 1 ? "" : "s"} ago`;
  const h = Math.round(min / 60);
  if (h < 48) return `${h} hour${h === 1 ? "" : "s"} ago`;
  return `${Math.round(h / 24)} days ago`;
}

/** Reasons a registered tracker has not reported, per method, most likely first. */
export function silenceFixes(method: ConnectionMethod | null): string[] {
  switch (method) {
    case "traccar": return [
      "Check the tracker has power: the vehicle's ignition may need to be on the first time, and a plug-in tracker must be fully seated.",
      "Check the SIM has mobile data and credit. A tracker with no data plan connects to nothing.",
      "Check the server address and port set on the tracker match the ones shown above, and the tracker's protocol matches the port.",
      "Check the ID you entered is the one printed on the tracker. A wrong digit means we cannot match its messages to this vehicle.",
      "Take the vehicle outside. A tracker with no GPS fix sends nothing useful, and a depot roof can block it.",
    ];
    case "feed": return [
      "Check your provider or Traccar is really sending to the address and key on the Connect page. Their send log should show success.",
      "Check the device ID your provider sends is exactly the one entered here, including capital letters.",
      "Check the key has not been revoked on the Connect page.",
    ];
    case "geotab": return [
      "Open the Geotab connection and press Check now. If the login was changed or removed, enter it again.",
      "Check this device ID exists in your MyGeotab database and is assigned to a vehicle that has moved recently.",
      "Check the Geotab device is plugged in and powered; Geotab itself will show it as offline if not.",
    ];
    case "samsara": return [
      "Open the Samsara connection and press Check now. If the token expired or was revoked, create a new one in Samsara and enter it again.",
      "Check this vehicle ID exists in Samsara and the token allows reading vehicle locations.",
      "Check the Samsara gateway is powered; Samsara shows it as offline if not.",
    ];
    default: return ["Add a tracker to this vehicle so it can appear on the map."];
  }
}

/** One state and one next step for a vehicle's connection. */
export function connectionStatus(i: ConnectionStatusInput): ConnectionStatus {
  const m = i.method;
  if (!i.hasDevice) {
    return { state: "not_connected", title: "No tracker connected", detail: "This vehicle has no tracker yet, so it will not show on the live map or in trip reports.", fixes: ["Add the tracker's ID and choose how it reaches RouteNorth."], minutesSince: null };
  }
  const prov = i.provider;
  if ((m === "geotab" || m === "samsara") && prov?.status === "error") {
    return { state: "error", title: `${m === "geotab" ? "Geotab" : "Samsara"} could not be reached`, detail: prov.lastError ?? "The provider did not accept the saved login.", fixes: silenceFixes(m), minutesSince: i.lastSeen ? minutes(i.lastSeen, i.now) : null };
  }
  if ((m === "geotab" || m === "samsara") && prov?.status === "paused") {
    return { state: "quiet", title: "Provider connection is paused", detail: "Nothing is being read from the provider account until it is resumed.", fixes: ["Resume the provider connection."], minutesSince: i.lastSeen ? minutes(i.lastSeen, i.now) : null };
  }
  if (!i.lastSeen) {
    const since = i.registeredAt ? minutes(i.registeredAt, i.now) : 0;
    if (since < FIRST_PING_PATIENCE_MIN) {
      return { state: "waiting_first_ping", title: "Waiting for the first position", detail: "The tracker is registered. The first position usually arrives within a few minutes of the tracker getting power and a signal.", fixes: [], minutesSince: null };
    }
    return { state: "waiting_first_ping", title: "Still waiting for the first position", detail: `Registered ${ago(since)} and nothing has arrived yet.`, fixes: silenceFixes(m), minutesSince: null };
  }
  const min = minutes(i.lastSeen, i.now);
  if (min <= LIVE_WITHIN_MIN) return { state: "connected", title: "Connected", detail: `Last position ${ago(min)}.`, fixes: [], minutesSince: min };
  return { state: "quiet", title: "Connected before, quiet now", detail: `Last position ${ago(min)}. A parked vehicle with the ignition off can be quiet for a while; one that should be moving is not.`, fixes: silenceFixes(m), minutesSince: min };
}

// ------------------------------------------------------------------------------------------------ setup text

export interface SetupContext {
  /** Public address of the ingest service, or null when the server operator has not set it. */
  ingestUrl: string | null;
  /** Host a tracker should connect to, or null when RouteNorth does not run a Traccar server for this install. */
  traccarHost: string | null;
  traccarPorts: { protocol: string; port: number }[];
}

export interface SetupInstructions {
  /** True when everything needed on RouteNorth's side is configured. */
  ready: boolean;
  /** What the server operator still has to set up, in plain words. Empty when ready. */
  missing: string[];
  steps: string[];
}

export function setupInstructions(method: ConnectionMethod, ctx: SetupContext): SetupInstructions {
  if (method === "traccar") {
    const missing = ctx.traccarHost ? [] : ["RouteNorth's tracker server address is not set up on this install yet (the operator sets TRACCAR_PUBLIC_HOST). Until then, use \"My GPS company sends it\" or a Geotab or Samsara account."];
    const ports = ctx.traccarPorts.length ? ctx.traccarPorts.map((p) => `${p.protocol} on port ${p.port}`).join(", ") : "the port for your tracker's protocol";
    return {
      ready: missing.length === 0, missing,
      steps: [
        "Find the ID printed on the tracker (its IMEI) and enter it here.",
        ctx.traccarHost ? `On the tracker, set the server to ${ctx.traccarHost} and choose the port for its protocol: ${ports}.` : "On the tracker, set the server address RouteNorth gives you and the port for its protocol.",
        "Make sure the SIM has mobile data, then power the tracker. Take the vehicle outside so it can see the sky.",
        "Come back to this page. The first position usually shows within a few minutes.",
      ],
    };
  }
  if (method === "feed") {
    const missing = ctx.ingestUrl ? [] : ["The public address of RouteNorth's ingest service is not set on this install yet (the operator sets INGEST_PUBLIC_URL)."];
    return {
      ready: missing.length === 0, missing,
      steps: [
        "Create a GPS key on the Connect your GPS page and give it to your provider, or paste it into your own Traccar's forward address.",
        ctx.ingestUrl ? `Send positions to ${ctx.ingestUrl}/ingest/feed (JSON) or ${ctx.ingestUrl}/ingest/feed/traccar?key=YOUR_KEY (Traccar forward).` : "Send positions to the ingest address once it is set.",
        "Enter the device ID exactly as your provider writes it on each position.",
        "Check this page. The first position shows as soon as your provider sends one.",
      ],
    };
  }
  const name = method === "geotab" ? "Geotab" : "Samsara";
  return {
    ready: true, missing: [],
    steps: [
      `Choose the ${name} account saved on the Connect your GPS page, or add one there first.`,
      `Pick the vehicle from your ${name} list, or paste its ID.`,
      `RouteNorth reads new positions from ${name} about once a minute. The first one shows within a minute or two of saving.`,
    ],
  };
}
