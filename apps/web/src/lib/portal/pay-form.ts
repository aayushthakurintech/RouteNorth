import type { FieldSpec } from "@/components/portal/field-form";

/** Rate card rules as the owner types them: dollars and percents. Converted to the API's whole cents on save. */
export interface RateSpecT { type: string; [k: string]: unknown }

const T = (...types: string[]) => (v: Record<string, unknown>) => types.includes(String(v.type));
const ALL_BUT_SALARY = (v: Record<string, unknown>) => v.type !== "salary";

export const RATE_TYPE_OPTIONS = [
  { value: "flat", label: "Per trip (flat)" }, { value: "distance", label: "Per distance" }, { value: "time", label: "Per time" }, { value: "base_distance_time", label: "Base plus distance plus time" },
  { value: "per_stop", label: "Per stop" }, { value: "zone", label: "Per zone" }, { value: "weight", label: "Per weight" }, { value: "hourly", label: "Hourly wage" },
  { value: "salary", label: "Daily or weekly salary" }, { value: "commission", label: "Commission (percent of the trip price)" }, { value: "hybrid", label: "Hybrid (hourly or trip pay, whichever is higher)" },
];

/** Inputs for the rules of one card; each shows only for the rate types that use it. */
export const SPEC_FIELDS: FieldSpec[] = [
  { key: "type", label: "Rate type", type: "select", required: true, options: RATE_TYPE_OPTIONS, wide: true },
  { key: "flat", label: "Price per trip", showIf: T("flat"), type: "number", step: "0.01", help: "In dollars" },
  { key: "base", label: "Start fee / base", showIf: T("base_distance_time", "per_stop", "zone", "weight", "hybrid"), type: "number", step: "0.01", help: "In dollars" },
  { key: "perKm", label: "Price per km", showIf: T("distance", "base_distance_time", "hybrid"), type: "number", step: "0.0001", help: "In dollars, for example 1.20" },
  { key: "perMin", label: "Price per minute", showIf: T("time", "base_distance_time", "hybrid"), type: "number", step: "0.0001", help: "In dollars, for example 0.30" },
  { key: "perHour", label: "Price per hour", showIf: T("hourly", "hybrid"), type: "number", step: "0.01", help: "In dollars" },
  { key: "perStop", label: "Price per extra stop", showIf: T("per_stop"), type: "number", step: "0.01", help: "In dollars" },
  { key: "perKg", label: "Price per kg", showIf: T("weight"), type: "number", step: "0.0001", help: "In dollars, for example 0.05" },
  { key: "salary", label: "Salary", showIf: T("salary"), type: "number", step: "0.01", help: "In dollars per period" },
  { key: "salaryPeriod", label: "Salary period", showIf: T("salary"), type: "select", required: true, options: [{ value: "week", label: "Per week" }, { value: "day", label: "Per day" }] },
  { key: "commissionPct", label: "Driver's share of the trip price (%)", showIf: T("commission"), type: "number", step: "0.1" },
  { key: "zones", label: "Zone prices", showIf: T("zone"), type: "textarea", wide: true, placeholder: "Downtown: 8.00\nSuburbs: 14.00", help: "One zone per line, “name: price in dollars”." },
  { key: "guarantee", label: "Minimum guarantee", showIf: T("hybrid"), type: "number", step: "0.01", help: "The least a hybrid trip pays, in dollars" },
  { key: "min", label: "Minimum per trip", showIf: ALL_BUT_SALARY, type: "number", step: "0.01", help: "In dollars; a smaller result is raised to this" },
  { key: "waitFree", label: "Free waiting (minutes)", showIf: ALL_BUT_SALARY, type: "number", step: "1" },
  { key: "waitPerMin", label: "Waiting fee per minute after that", showIf: ALL_BUT_SALARY, type: "number", step: "0.01", help: "In dollars" },
  { key: "peakPct", label: "Peak hours add-on (%)", showIf: ALL_BUT_SALARY, type: "number", step: "0.1" },
  { key: "nightPct", label: "Night add-on (%)", showIf: ALL_BUT_SALARY, type: "number", step: "0.1" },
  { key: "weekendPct", label: "Weekend add-on (%)", showIf: ALL_BUT_SALARY, type: "number", step: "0.1" },
  { key: "holidayPct", label: "Holiday add-on (%)", showIf: ALL_BUT_SALARY, type: "number", step: "0.1" },
  { key: "weatherPct", label: "Bad weather add-on (%)", showIf: ALL_BUT_SALARY, type: "number", step: "0.1" },
  { key: "fuelSurchargePct", label: "Fuel surcharge (%)", showIf: ALL_BUT_SALARY, type: "number", step: "0.1" },
  { key: "longDistanceKm", label: "Long distance starts at (km)", showIf: ALL_BUT_SALARY, type: "number", step: "1" },
  { key: "longDistancePct", label: "Long distance add-on (%)", showIf: ALL_BUT_SALARY, type: "number", step: "0.1" },
  { key: "outOfZone", label: "Out-of-zone add-on", showIf: ALL_BUT_SALARY, type: "number", step: "0.01", help: "In dollars" },
  { key: "surgeCapX", label: "Surge cap (times)", showIf: ALL_BUT_SALARY, type: "number", step: "0.1", help: "Highest surge multiplier allowed, for example 1.5. Empty means surge is ignored." },
  { key: "cancelFee", label: "Cancellation or no-show fee", showIf: ALL_BUT_SALARY, type: "number", step: "0.01", help: "In dollars" },
  { key: "taxLabel", label: "Tax name", showIf: ALL_BUT_SALARY, placeholder: "HST" },
  { key: "taxPct", label: "Tax (%)", showIf: ALL_BUT_SALARY, type: "number", step: "0.01" },
  { key: "rounding", label: "Rounding", showIf: ALL_BUT_SALARY, type: "select", options: [{ value: "cent", label: "To the cent" }, { value: "5c", label: "To 5 cents" }, { value: "10c", label: "To 10 cents" }, { value: "dollar", label: "To the dollar" }] },
  { key: "tolls", label: "Tolls and parking are paid back with a receipt", showIf: ALL_BUT_SALARY, type: "checkbox", wide: true },
];

const num = (v: unknown) => { const s = String(v ?? "").trim(); return s === "" ? undefined : Number(s); };
/** dollars to cents; a flat fee must be a whole cent, a price per unit may be a fraction of a cent. */
const wholeCents = (v: unknown) => { const n = num(v); return n === undefined ? undefined : Math.round(n * 100); };
const unitCents = (v: unknown) => { const n = num(v); return n === undefined ? undefined : Number((n * 100).toFixed(4)); };

export function specFromValues(all: Record<string, string | boolean>): RateSpecT {
  // Values of fields that are hidden for this rate type (left over from a type picked earlier) are not sent.
  const v: Record<string, string | boolean> = { ...all };
  for (const f of SPEC_FIELDS) if (f.showIf && !f.showIf(all)) v[f.key] = f.type === "checkbox" ? false : "";
  const out: RateSpecT = { type: String(v.type) };
  const put = (k: string, x: unknown) => { if (x !== undefined && !(typeof x === "number" && Number.isNaN(x))) out[k] = x; };
  if (v.type === "flat") put("flatCents", wholeCents(v.flat));
  put("baseCents", wholeCents(v.base)); put("perKmCents", unitCents(v.perKm)); put("perMinCents", unitCents(v.perMin)); put("perHourCents", unitCents(v.perHour)); put("perStopCents", unitCents(v.perStop)); put("perKgCents", unitCents(v.perKg));
  put("salaryCents", wholeCents(v.salary)); if (v.type === "salary") put("salaryPeriod", String(v.salaryPeriod || "week"));
  put("commissionPct", num(v.commissionPct)); put("guaranteeCents", wholeCents(v.guarantee)); put("minCents", wholeCents(v.min));
  const free = num(v.waitFree), per = unitCents(v.waitPerMin);
  if (per !== undefined) out.waiting = { freeMin: free ?? 0, perMinCents: per };
  for (const k of ["peakPct", "nightPct", "weekendPct", "holidayPct", "weatherPct", "fuelSurchargePct", "longDistanceKm", "longDistancePct", "surgeCapX"]) put(k, num(v[k]));
  put("outOfZoneCents", wholeCents(v.outOfZone)); put("cancellationFeeCents", wholeCents(v.cancelFee));
  if (String(v.taxLabel ?? "").trim() && num(v.taxPct)) out.tax = { label: String(v.taxLabel).trim(), pct: num(v.taxPct) };
  if (v.rounding) out.rounding = String(v.rounding);
  if (v.tolls === true) out.tollsPassThrough = true;
  if (v.type === "zone") {
    out.zones = String(v.zones ?? "").split("\n").map((l) => l.trim()).filter(Boolean).map((l) => {
      const i = l.lastIndexOf(":");
      if (i < 1) throw new Error(`Zone line “${l}” needs a name, a colon and a price`);
      const cents = wholeCents(l.slice(i + 1));
      if (cents === undefined || Number.isNaN(cents)) throw new Error(`Zone line “${l}” has no valid price`);
      return { name: l.slice(0, i).trim(), cents };
    });
  }
  return out;
}

const dollars = (c: unknown) => (c == null ? "" : String(Number(c) / 100));
export function valuesFromSpec(s: RateSpecT | null): Record<string, string | boolean> {
  const x = (s ?? { type: "base_distance_time" }) as Record<string, any>;
  return {
    type: x.type, flat: dollars(x.flatCents ?? (x.type === "flat" ? x.baseCents : undefined)), base: dollars(x.baseCents), perKm: dollars(x.perKmCents), perMin: dollars(x.perMinCents), perHour: dollars(x.perHourCents), perStop: dollars(x.perStopCents), perKg: dollars(x.perKgCents),
    salary: dollars(x.salaryCents), salaryPeriod: x.salaryPeriod ?? "week", commissionPct: x.commissionPct == null ? "" : String(x.commissionPct), guarantee: dollars(x.guaranteeCents), min: dollars(x.minCents),
    waitFree: x.waiting ? String(x.waiting.freeMin) : "", waitPerMin: x.waiting ? dollars(x.waiting.perMinCents) : "",
    ...Object.fromEntries(["peakPct", "nightPct", "weekendPct", "holidayPct", "weatherPct", "fuelSurchargePct", "longDistanceKm", "longDistancePct", "surgeCapX"].map((k) => [k, x[k] == null ? "" : String(x[k])])),
    outOfZone: dollars(x.outOfZoneCents), cancelFee: dollars(x.cancellationFeeCents), taxLabel: x.tax?.label ?? "", taxPct: x.tax ? String(x.tax.pct) : "", rounding: x.rounding ?? "", tolls: !!x.tollsPassThrough,
    zones: (x.zones ?? []).map((z: { name: string; cents: number }) => `${z.name}: ${(z.cents / 100).toFixed(2)}`).join("\n"),
  };
}

export const BONUS_KINDS = [
  { value: "trip_count", label: "Trip count (complete N trips)" }, { value: "on_time", label: "On-time rate" }, { value: "rating", label: "Rating" }, { value: "peak", label: "Peak-hour trips" },
  { value: "busy_zone", label: "Busy zone trips" }, { value: "safety", label: "Safety (no safety events)" }, { value: "streak", label: "Streak (days in a row)" }, { value: "tiered", label: "Tiered (more trips, bigger bonus)" },
];
export const DEDUCTION_KINDS = [
  { value: "vehicle_share", label: "Vehicle rental or lease share" }, { value: "fuel_advance", label: "Fuel advance or fuel card" }, { value: "fine", label: "Fine or ticket" }, { value: "damage", label: "Damage cost" },
  { value: "equipment", label: "Uniform or equipment" }, { value: "phone", label: "Phone fee" }, { value: "loan", label: "Loan or advance paid back in parts" }, { value: "other", label: "Other" },
];
export const PAYOUT_TONE: Record<string, "neutral" | "good" | "warn" | "bad" | "info"> = { draft: "neutral", approved: "info", sent: "info", paid: "good", failed: "bad", disputed: "warn" };
export const CARD_TONE: Record<string, "neutral" | "good" | "warn" | "bad" | "info"> = { draft: "neutral", pending: "warn", active: "good", expired: "neutral", scheduled: "info", archived: "neutral" };
