import { BadRequestException } from "@nestjs/common";
import { RATE_TYPES, type RateSpec, type RateType } from "@routenorth/shared";

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Amounts that are whole cents (a fee, a minimum). */
const FLAT_KEYS = ["baseCents", "flatCents", "salaryCents", "guaranteeCents", "minCents", "outOfZoneCents", "cancellationFeeCents"] as const;
/** Prices per unit: may carry a fraction of a cent (7.5 cents a minute); the trip total is rounded once. */
const UNIT_KEYS = ["perKmCents", "perMinCents", "perHourCents", "perStopCents", "perKgCents"] as const;
const PCT_KEYS = ["peakPct", "nightPct", "weekendPct", "holidayPct", "weatherPct", "longDistancePct", "fuelSurchargePct"] as const;

/** Check a rate card's rules from the request. Anything unknown, negative, not a number or out of range is refused with a plain reason. */
export function parseSpec(raw: unknown): RateSpec {
  if (!isObj(raw)) throw new BadRequestException("spec must be an object");
  const allowed = new Set<string>(["type", ...FLAT_KEYS, ...UNIT_KEYS, ...PCT_KEYS, "zones", "commissionPct", "salaryPeriod", "waiting", "longDistanceKm", "surgeCapX", "vehicleTypePct", "levelPct", "tollsPassThrough", "tax", "rounding"]);
  const extra = Object.keys(raw).filter((k) => !allowed.has(k));
  if (extra.length) throw new BadRequestException(`unknown rate rule: ${extra.slice(0, 3).join(", ")}`);
  if (!RATE_TYPES.includes(raw.type as RateType)) throw new BadRequestException(`type must be one of ${RATE_TYPES.join(", ")}`);
  const out: Record<string, unknown> = { type: raw.type };
  for (const k of FLAT_KEYS) if (raw[k] != null && raw[k] !== "") {
    const v = raw[k];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 100_000_000) throw new BadRequestException(`${k} must be whole cents, 0 or more`);
    out[k] = v;
  }
  for (const k of UNIT_KEYS) if (raw[k] != null && raw[k] !== "") {
    const v = raw[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 10_000_000) throw new BadRequestException(`${k} must be a number of cents, 0 or more`);
    out[k] = v;
  }
  for (const k of PCT_KEYS) if (raw[k] != null && raw[k] !== "") {
    const v = raw[k];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 500) throw new BadRequestException(`${k} must be a percent from 0 to 500`);
    out[k] = v;
  }
  if (raw.commissionPct != null && raw.commissionPct !== "") {
    const v = raw.commissionPct;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100) throw new BadRequestException("commissionPct must be 0 to 100");
    out.commissionPct = v;
  }
  if (raw.longDistanceKm != null && raw.longDistanceKm !== "") {
    const v = raw.longDistanceKm;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 100_000) throw new BadRequestException("longDistanceKm must be a distance in km");
    out.longDistanceKm = v;
  }
  if (raw.surgeCapX != null && raw.surgeCapX !== "") {
    const v = raw.surgeCapX;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 1 || v > 10) throw new BadRequestException("surgeCapX must be 1 to 10 (1 means no surge)");
    out.surgeCapX = v;
  }
  if (raw.salaryPeriod != null && raw.salaryPeriod !== "") {
    if (raw.salaryPeriod !== "day" && raw.salaryPeriod !== "week") throw new BadRequestException("salaryPeriod must be day or week");
    out.salaryPeriod = raw.salaryPeriod;
  }
  if (raw.tollsPassThrough != null) out.tollsPassThrough = raw.tollsPassThrough === true;
  if (raw.rounding != null && raw.rounding !== "") {
    if (!["cent", "5c", "10c", "dollar"].includes(raw.rounding as string)) throw new BadRequestException("rounding must be cent, 5c, 10c or dollar");
    out.rounding = raw.rounding;
  }
  if (raw.zones != null) {
    if (!Array.isArray(raw.zones) || raw.zones.length > 200) throw new BadRequestException("zones must be a list of up to 200");
    out.zones = raw.zones.map((z) => {
      if (!isObj(z) || typeof z.name !== "string" || !z.name.trim() || z.name.length > 80 || typeof z.cents !== "number" || !Number.isSafeInteger(z.cents) || z.cents < 0) throw new BadRequestException("each zone needs a name and a price in whole cents");
      return { name: z.name.trim(), cents: z.cents };
    });
  }
  if (raw.waiting != null) {
    const w = raw.waiting;
    if (!isObj(w) || typeof w.freeMin !== "number" || w.freeMin < 0 || w.freeMin > 1440 || typeof w.perMinCents !== "number" || !Number.isFinite(w.perMinCents) || w.perMinCents < 0) throw new BadRequestException("waiting needs freeMin and perMinCents");
    out.waiting = { freeMin: w.freeMin, perMinCents: w.perMinCents };
  }
  for (const k of ["vehicleTypePct", "levelPct"] as const) if (raw[k] != null) {
    const m = raw[k];
    if (!isObj(m) || Object.keys(m).length > 30 || Object.values(m).some((x) => typeof x !== "number" || !Number.isFinite(x) || x < -100 || x > 500)) throw new BadRequestException(`${k} must map a name to a percent`);
    out[k] = m;
  }
  if (raw.tax != null) {
    const t = raw.tax;
    if (!isObj(t) || typeof t.label !== "string" || !t.label.trim() || t.label.length > 40 || typeof t.pct !== "number" || t.pct < 0 || t.pct > 100) throw new BadRequestException("tax needs a label and a percent from 0 to 100");
    out.tax = { label: t.label.trim(), pct: t.pct };
  }
  // A card is useless if the type's own price is missing: say so now rather than pricing every trip at zero.
  const need: Partial<Record<RateType, string[]>> = {
    flat: ["flatCents"], distance: ["perKmCents"], time: ["perMinCents"], per_stop: ["perStopCents"], weight: ["perKgCents"], hourly: ["perHourCents"], salary: ["salaryCents"], commission: ["commissionPct"],
  };
  for (const k of need[raw.type as RateType] ?? []) if (out[k] == null && !(k === "flatCents" && out.baseCents != null)) throw new BadRequestException(`a ${raw.type} card needs ${k}`);
  if (raw.type === "base_distance_time" && out.baseCents == null && out.perKmCents == null && out.perMinCents == null) throw new BadRequestException("a base plus distance plus time card needs at least one price");
  if (raw.type === "zone" && !(out.zones as unknown[] | undefined)?.length && out.baseCents == null) throw new BadRequestException("a zone card needs at least one zone price");
  if (raw.type === "hybrid" && out.perHourCents == null) throw new BadRequestException("a hybrid card needs perHourCents (the hourly side)");
  return out as unknown as RateSpec;
}

export const SPEC_LABELS: Record<string, string> = {
  baseCents: "Start fee", flatCents: "Flat price", perKmCents: "Per km", perMinCents: "Per minute", perHourCents: "Per hour", perStopCents: "Per stop", perKgCents: "Per kg", salaryCents: "Salary", guaranteeCents: "Minimum guarantee",
  minCents: "Minimum", commissionPct: "Commission %", peakPct: "Peak %", nightPct: "Night %", weekendPct: "Weekend %", holidayPct: "Holiday %", weatherPct: "Bad weather %", fuelSurchargePct: "Fuel surcharge %",
  longDistancePct: "Long distance %", outOfZoneCents: "Out of zone", cancellationFeeCents: "Cancellation fee", surgeCapX: "Surge cap ×",
};

/** A short line describing a card, for lists. */
export function specSummary(s: RateSpec): string {
  const d = (c?: number) => (c == null ? "" : `$${(c / 100).toFixed(2)}`);
  switch (s.type) {
    case "flat": return `${d(s.flatCents ?? s.baseCents)} per trip`;
    case "distance": return `${d(s.perKmCents)} per km`;
    case "time": return `${d(s.perMinCents)} per minute`;
    case "base_distance_time": return `${d(s.baseCents)} + ${d(s.perKmCents)}/km + ${d(s.perMinCents)}/min`;
    case "per_stop": return `${d(s.baseCents ?? s.perStopCents)} first stop, ${d(s.perStopCents)} each extra`;
    case "zone": return `${s.zones?.length ?? 0} zone prices`;
    case "weight": return `${d(s.baseCents)} + ${d(s.perKgCents)}/kg`;
    case "hourly": return `${d(s.perHourCents)} per hour`;
    case "salary": return `${d(s.salaryCents)} per ${s.salaryPeriod ?? "week"}`;
    case "commission": return `${s.commissionPct}% of the trip price`;
    case "hybrid": return `Better of ${d(s.perHourCents)}/h or trip pay, at least ${d(s.guaranteeCents)}`;
  }
}
