/**
 * Organization settings live in organizations.settings (jsonb). This file is the one place that
 * says which keys exist, their defaults and what the browser may see.
 */
export interface OrgSettings {
  /** Days to keep GPS positions (also in organizations.retention_days). */
  idleThresholdMin: number;
  speedLimitKmh: number;
  /** Quiet hours for non-urgent alerts, local time HH:MM. */
  quietHours: { start: string; end: string } | null;
  /** Drivers are tracked only while on shift. */
  trackOnlyDuringShift: boolean;
  /** Where people may sign in from. Empty means anywhere. */
  ipAllowList: string[];
  sessionHours: number;
  twoFactorRequired: boolean;
  defaultMapProvider: "osm" | "maptiler" | "mapbox" | "here" | "google";
  currency: string;
  taxRatePct: number;
  /** What a kilometer and an hour of driving cost, for comparing route plans. */
  costPerKm: number;
  costPerHour: number;
  featureFlags: Record<string, boolean>;
  [key: string]: unknown;
}

export const DEFAULT_SETTINGS: OrgSettings = {
  idleThresholdMin: 5,
  speedLimitKmh: 105,
  quietHours: null,
  trackOnlyDuringShift: false,
  ipAllowList: [],
  sessionHours: 12,
  twoFactorRequired: false,
  defaultMapProvider: "osm",
  currency: "CAD",
  taxRatePct: 13,
  costPerKm: 0.9,
  costPerHour: 35,
  featureFlags: {},
};

export function withDefaults(raw: unknown): OrgSettings {
  const o = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  return { ...DEFAULT_SETTINGS, ...o, featureFlags: { ...DEFAULT_SETTINGS.featureFlags, ...((o.featureFlags as object) ?? {}) } } as OrgSettings;
}

/** The subset every signed-in person's browser receives. Security details stay server-side. */
export function publicSettings(raw: unknown) {
  const s = withDefaults(raw);
  return {
    idleThresholdMin: s.idleThresholdMin, speedLimitKmh: s.speedLimitKmh, trackOnlyDuringShift: s.trackOnlyDuringShift,
    defaultMapProvider: s.defaultMapProvider, currency: s.currency, taxRatePct: s.taxRatePct, featureFlags: s.featureFlags,
  };
}

/** Validates a partial update. Returns only the keys that are allowed and well-formed; throws a message otherwise. */
export function parseSettingsPatch(body: unknown): Partial<OrgSettings> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("settings must be an object");
  const b = body as Record<string, unknown>;
  const out: Partial<OrgSettings> = {};
  const num = (k: keyof OrgSettings, min: number, max: number) => {
    if (b[k as string] === undefined) return;
    const v = Number(b[k as string]);
    if (!Number.isFinite(v) || v < min || v > max) throw new Error(`${String(k)} must be between ${min} and ${max}`);
    (out as Record<string, unknown>)[k as string] = v;
  };
  num("idleThresholdMin", 1, 120); num("speedLimitKmh", 20, 200); num("sessionHours", 1, 720); num("taxRatePct", 0, 30); num("costPerKm", 0, 100); num("costPerHour", 0, 1000);
  if (b.trackOnlyDuringShift !== undefined) out.trackOnlyDuringShift = Boolean(b.trackOnlyDuringShift);
  if (b.twoFactorRequired !== undefined) out.twoFactorRequired = Boolean(b.twoFactorRequired);
  if (b.quietHours !== undefined) {
    if (b.quietHours === null) out.quietHours = null;
    else {
      const q = b.quietHours as { start?: unknown; end?: unknown };
      const ok = (x: unknown) => typeof x === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(x);
      if (!ok(q.start) || !ok(q.end)) throw new Error("quietHours needs start and end as HH:MM");
      out.quietHours = { start: q.start as string, end: q.end as string };
    }
  }
  if (b.ipAllowList !== undefined) {
    if (!Array.isArray(b.ipAllowList) || b.ipAllowList.length > 100 || !b.ipAllowList.every((x) => typeof x === "string" && /^[0-9a-fA-F.:/]{3,50}$/.test(x))) {
      throw new Error("ipAllowList must be a list of IP addresses or CIDR ranges");
    }
    out.ipAllowList = b.ipAllowList as string[];
  }
  if (b.defaultMapProvider !== undefined) {
    if (!["osm", "maptiler", "mapbox", "here", "google"].includes(String(b.defaultMapProvider))) throw new Error("unknown map provider");
    out.defaultMapProvider = b.defaultMapProvider as OrgSettings["defaultMapProvider"];
  }
  if (b.currency !== undefined) {
    if (typeof b.currency !== "string" || !/^[A-Z]{3}$/.test(b.currency)) throw new Error("currency must be a 3-letter code");
    out.currency = b.currency;
  }
  if (b.featureFlags !== undefined) {
    const f = b.featureFlags as Record<string, unknown>;
    if (!f || typeof f !== "object" || Object.keys(f).length > 50 || !Object.entries(f).every(([k, v]) => /^[a-z0-9_.-]{1,40}$/.test(k) && typeof v === "boolean")) {
      throw new Error("featureFlags must map names to true or false");
    }
    out.featureFlags = f as Record<string, boolean>;
  }
  return out;
}
