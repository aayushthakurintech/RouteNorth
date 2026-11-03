/**
 * Grouped settings added after the first ones (safety, billing, onboarding ...). Each group is a small object of
 * simple values; the spec below is the single place that says what exists, its limits and its default.
 */
type Spec = { t: "bool"; d: boolean } | { t: "num"; d: number; min: number; max: number } | { t: "str"; d: string; max: number } | { t: "enum"; d: string; values: readonly string[] };
const bool = (d: boolean): Spec => ({ t: "bool", d });
const num = (d: number, min: number, max: number): Spec => ({ t: "num", d, min, max });
const str = (d: string, max = 80): Spec => ({ t: "str", d, max });
const en = (d: string, ...values: string[]): Spec => ({ t: "enum", d, values });

export const EXTRA_GROUPS: Record<string, Record<string, Spec>> = {
  safety: {
    leaderboard: bool(false), anonymous: bool(true), coaching: bool(true), crashDetection: bool(true),
    fatigueWarnMin: num(240, 30, 720), fatigueStopMin: num(300, 30, 900), shiftWarnMin: num(540, 60, 1200), shiftMaxMin: num(660, 60, 1440), checkinGraceMin: num(10, 1, 120),
  },
  billing: {
    province: en("ON", "AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"), taxMode: en("province", "province", "custom"),
    paymentTermsDays: num(30, 0, 180), quoteValidDays: num(14, 1, 180), payPerStop: num(0, 0, 1000), payPerKm: num(0, 0, 100), overtimeMultiplier: num(1.5, 1, 4),
    budgetAlertPct: num(90, 10, 200), companyName: str("", 120), taxNumber: str("", 40), fxRates: str("", 300),
  },
  costing: { fuelPricePerL: num(1.7, 0, 20), wearPerKm: num(0.12, 0, 10), tollPerKm: num(0, 0, 10), evCostPerKm: num(0.05, 0, 10) },
  privacy: { messageRetentionDays: num(0, 0, 3650) },
  onboarding: { dismissed: bool(false), sampleLoaded: bool(false) },
  platform: { widgetOrigins: str("", 500), whiteLabel: bool(false), poweredBy: bool(true), analyticsOptOut: bool(false), mapTileUrl: str("", 300), mapKey: str("", 200) },
};

export const EXTRA_KEYS = Object.keys(EXTRA_GROUPS);

export function extraDefaults(): Record<string, Record<string, unknown>> {
  return Object.fromEntries(Object.entries(EXTRA_GROUPS).map(([g, spec]) => [g, Object.fromEntries(Object.entries(spec).map(([k, s]) => [k, s.d]))]));
}

/** Validate the groups present in a settings update. Unknown names and out-of-range values are rejected with a message. */
export function parseExtraSettings(b: Record<string, unknown>): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const [g, spec] of Object.entries(EXTRA_GROUPS)) {
    const v = b[g];
    if (v === undefined) continue;
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${g} must be an object`);
    const o: Record<string, unknown> = {};
    for (const [k, raw] of Object.entries(v as Record<string, unknown>)) {
      const s = spec[k];
      if (!s) throw new Error(`unknown ${g} setting "${k}"`);
      if (s.t === "bool") o[k] = Boolean(raw);
      else if (s.t === "num") { const n = Number(raw); if (!Number.isFinite(n) || n < s.min || n > s.max) throw new Error(`${k} must be between ${s.min} and ${s.max}`); o[k] = n; }
      else if (s.t === "str") { if (typeof raw !== "string" || raw.length > s.max) throw new Error(`${k} must be up to ${s.max} characters`); o[k] = raw; }
      else { if (!s.values.includes(String(raw))) throw new Error(`${k} must be one of ${s.values.join(", ")}`); o[k] = String(raw); }
    }
    out[g] = o;
  }
  return out;
}

export function mergeExtra(raw: Record<string, unknown>): Record<string, unknown> {
  const d = extraDefaults();
  return Object.fromEntries(Object.entries(d).map(([g, def]) => [g, { ...def, ...((raw[g] as object) ?? {}) }]));
}
