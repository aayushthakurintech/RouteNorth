import { applyRounding, percentOf, sumCents, times, type Cents, type RoundingRule } from "./money.js";

/**
 * The rate engine: one trip in, a list of money lines out. Used for what the customer pays, what the driver earns,
 * the price simulator, "what if" replays and every trip's breakdown, so no two screens can disagree.
 * All amounts are whole cents. Percentages are taken of the subtotal and rounded once, half away from zero.
 */
export const RATE_TYPES = [
  "flat", "distance", "time", "base_distance_time", "per_stop", "zone", "weight", "hourly", "salary", "commission", "hybrid",
] as const;
export type RateType = (typeof RATE_TYPES)[number];
export const RATE_TYPE_LABEL: Record<RateType, string> = {
  flat: "Per trip (flat)", distance: "Per distance", time: "Per time", base_distance_time: "Base plus distance plus time", per_stop: "Per stop", zone: "Per zone", weight: "Per weight",
  hourly: "Hourly wage", salary: "Daily or weekly salary", commission: "Commission", hybrid: "Hybrid (minimum guarantee, better of two)",
};

export interface RateSpec {
  type: RateType;
  baseCents?: number; flatCents?: number; perKmCents?: number; perMinCents?: number; perHourCents?: number; perStopCents?: number; perKgCents?: number;
  zones?: { name: string; cents: number }[];
  /** commission: share of the customer price the driver keeps */
  commissionPct?: number;
  /** salary: not per trip; paid as a fixed amount per period (see payouts) */
  salaryCents?: number; salaryPeriod?: "day" | "week";
  /** hybrid: pay the larger of the hourly wage and the per-trip method, but never less than the guarantee */
  guaranteeCents?: number;
  minCents?: number;
  waiting?: { freeMin: number; perMinCents: number };
  /** percent add-ons, taken of the subtotal when the trip has that condition */
  peakPct?: number; nightPct?: number; weekendPct?: number; holidayPct?: number; weatherPct?: number; longDistancePct?: number; longDistanceKm?: number;
  outOfZoneCents?: number;
  surgeCapX?: number;
  vehicleTypePct?: Record<string, number>;
  levelPct?: Record<string, number>;
  fuelSurchargePct?: number;
  tollsPassThrough?: boolean;
  cancellationFeeCents?: number;
  tax?: { label: string; pct: number };
  rounding?: RoundingRule;
}

export interface TripFacts {
  distanceKm: number; durationMin: number; waitingMin: number; stops: number; weightKg: number; zone?: string | null;
  status?: "completed" | "cancelled" | "failed" | "no_show";
  tipCents?: number; tollCents?: number; vehicleKind?: string | null; driverLevel?: string | null;
  /** the price the customer paid (needed by commission cards) */
  customerPriceCents?: number;
  conditions?: { peak?: boolean; night?: boolean; weekend?: boolean; holiday?: boolean; weather?: boolean; outOfZone?: boolean; surge?: number };
  /** shift hours, for hourly and hybrid cards */
  hours?: number;
}

export interface Line { key: string; label: string; cents: Cents; /** shown as a deduction or pass-through */ kind: "earning" | "addon" | "tip" | "toll" | "tax" | "deduction" }
export interface Priced { lines: Line[]; subtotalCents: Cents; totalCents: Cents; notes: string[] }

const km = (n: number) => `${Math.round(n * 100) / 100} km`;
const mins = (n: number) => `${Math.round(n * 100) / 100} min`;

/** Base, distance, time and waiting for one trip, before add-ons. */
function core(spec: RateSpec, t: TripFacts, notes: string[]): Line[] {
  const L: Line[] = [];
  const add = (key: string, label: string, cents: Cents) => { if (cents !== 0) L.push({ key, label, cents, kind: "earning" }); };
  const money = (c: number | undefined) => c ?? 0;
  switch (spec.type) {
    case "flat": add("base", "Flat price per trip", money(spec.flatCents ?? spec.baseCents)); break;
    case "distance": add("distance", `${km(t.distanceKm)} × ${money(spec.perKmCents)}¢`, times(money(spec.perKmCents), t.distanceKm)); break;
    case "time": add("time", `${mins(t.durationMin)} × ${money(spec.perMinCents)}¢`, times(money(spec.perMinCents), t.durationMin)); break;
    case "base_distance_time":
      add("base", "Start fee", money(spec.baseCents));
      add("distance", `${km(t.distanceKm)} × ${money(spec.perKmCents)}¢`, times(money(spec.perKmCents), t.distanceKm));
      add("time", `${mins(t.durationMin)} × ${money(spec.perMinCents)}¢`, times(money(spec.perMinCents), t.durationMin));
      break;
    case "per_stop": {
      const extra = Math.max(0, t.stops - 1);
      add("base", "First stop", money(spec.baseCents ?? spec.perStopCents));
      add("stops", `${extra} extra stop${extra === 1 ? "" : "s"} × ${money(spec.perStopCents)}¢`, times(money(spec.perStopCents), extra));
      break;
    }
    case "zone": {
      const z = spec.zones?.find((x) => x.name.toLowerCase() === (t.zone ?? "").toLowerCase());
      if (!z) notes.push(`No price set for zone “${t.zone ?? "none"}”; the base price was used.`);
      add("zone", z ? `Zone ${z.name}` : "Base price", z ? z.cents : money(spec.baseCents));
      break;
    }
    case "weight": add("base", "Start fee", money(spec.baseCents)); add("weight", `${Math.round(t.weightKg * 100) / 100} kg × ${money(spec.perKgCents)}¢`, times(money(spec.perKgCents), t.weightKg)); break;
    case "hourly": { const h = t.hours ?? t.durationMin / 60; add("hourly", `${Math.round(h * 100) / 100} h × ${money(spec.perHourCents)}¢`, times(money(spec.perHourCents), h)); break; }
    case "salary": notes.push("Salary cards pay a fixed amount per period, not per trip."); break;
    case "commission": {
      const price = t.customerPriceCents ?? 0;
      if (t.customerPriceCents == null) notes.push("A commission card needs the customer price.");
      add("commission", `${spec.commissionPct ?? 0}% of the ${price ? "customer price" : "price"}`, percentOf(price, spec.commissionPct ?? 0));
      break;
    }
    case "hybrid": {
      const hourly = times(money(spec.perHourCents), t.hours ?? t.durationMin / 60);
      const trip = money(spec.baseCents) + times(money(spec.perKmCents), t.distanceKm) + times(money(spec.perMinCents), t.durationMin);
      const better = Math.max(hourly, trip);
      add("hybrid", `Better of hourly (${hourly}¢) and trip pay (${trip}¢)`, better);
      break;
    }
  }
  const w = spec.waiting;
  if (w && t.waitingMin > w.freeMin) { const paid = t.waitingMin - w.freeMin; add("waiting", `${mins(paid)} paid waiting (${w.freeMin} free) × ${w.perMinCents}¢`, times(w.perMinCents, paid)); }
  return L;
}

export function priceTrip(spec: RateSpec, t: TripFacts): Priced {
  const notes: string[] = [];
  const lines: Line[] = [];
  const status = t.status ?? "completed";
  if (status === "cancelled" || status === "no_show") {
    if (spec.cancellationFeeCents) lines.push({ key: "cancellation", label: status === "no_show" ? "No-show fee" : "Cancellation fee", cents: spec.cancellationFeeCents, kind: "earning" });
    else notes.push("This trip was not completed, so nothing is paid.");
    const total = sumCents(lines.map((l) => l.cents));
    return { lines, subtotalCents: total, totalCents: total, notes };
  }
  if (status === "failed") { notes.push("A failed trip earns nothing."); return { lines, subtotalCents: 0, totalCents: 0, notes }; }

  lines.push(...core(spec, t, notes));
  let subtotal = sumCents(lines.map((l) => l.cents));
  if (spec.minCents != null && subtotal < spec.minCents && spec.type !== "salary") {
    lines.push({ key: "minimum", label: `Raised to the minimum`, cents: spec.minCents - subtotal, kind: "earning" });
    subtotal = spec.minCents;
  }
  if (spec.type === "hybrid" && spec.guaranteeCents != null && subtotal < spec.guaranteeCents) {
    lines.push({ key: "guarantee", label: "Minimum guarantee", cents: spec.guaranteeCents - subtotal, kind: "earning" });
    subtotal = spec.guaranteeCents;
  }
  const c = t.conditions ?? {};
  const pct = (key: string, label: string, p: number | undefined, on: boolean | undefined) => { if (p && on) lines.push({ key, label: `${label} (${p}% of ${(subtotal / 100).toFixed(2)})`, cents: percentOf(subtotal, p), kind: "addon" }); };
  pct("peak", "Peak hours", spec.peakPct, c.peak); pct("night", "Night hours", spec.nightPct, c.night); pct("weekend", "Weekend", spec.weekendPct, c.weekend);
  pct("holiday", "Holiday", spec.holidayPct, c.holiday); pct("weather", "Bad weather", spec.weatherPct, c.weather);
  if (spec.longDistancePct && spec.longDistanceKm != null && t.distanceKm > spec.longDistanceKm) pct("long", "Long distance", spec.longDistancePct, true);
  if (spec.outOfZoneCents && c.outOfZone) lines.push({ key: "out_of_zone", label: "Out-of-zone add-on", cents: spec.outOfZoneCents, kind: "addon" });
  if (spec.vehicleTypePct && t.vehicleKind && spec.vehicleTypePct[t.vehicleKind]) pct("vehicle", `Vehicle type ${t.vehicleKind}`, spec.vehicleTypePct[t.vehicleKind], true);
  if (spec.levelPct && t.driverLevel && spec.levelPct[t.driverLevel]) pct("level", `Driver level ${t.driverLevel}`, spec.levelPct[t.driverLevel], true);
  pct("fuel", "Fuel surcharge", spec.fuelSurchargePct, true);
  if (c.surge && c.surge > 1) {
    const x = Math.min(c.surge, spec.surgeCapX ?? 1);
    if (x > 1) lines.push({ key: "surge", label: `Surge ×${x}${c.surge > x ? ` (capped from ×${c.surge})` : ""}`, cents: percentOf(subtotal, (x - 1) * 100), kind: "addon" });
    else notes.push("Surge was ignored because this card has no surge cap set.");
  }
  let before = sumCents(lines.map((l) => l.cents));
  const rounded = applyRounding(before, spec.rounding ?? "cent");
  if (rounded !== before) { lines.push({ key: "rounding", label: `Rounded (${spec.rounding})`, cents: rounded - before, kind: "addon" }); before = rounded; }
  if (spec.tax && spec.tax.pct) { lines.push({ key: "tax", label: `${spec.tax.label} ${spec.tax.pct}%`, cents: percentOf(before, spec.tax.pct), kind: "tax" }); }
  if (t.tipCents) lines.push({ key: "tip", label: "Tip", cents: t.tipCents, kind: "tip" });
  if (t.tollCents && spec.tollsPassThrough) lines.push({ key: "toll", label: "Toll paid back (receipt)", cents: t.tollCents, kind: "toll" });
  return { lines, subtotalCents: before, totalCents: sumCents(lines.map((l) => l.cents)), notes };
}

/** Net pay = base + distance + time + waiting + surcharges + bonuses + tips - deductions (spec formula). `deductions` are positive numbers. */
export function netPay(parts: { earnings: Cents; bonuses: Cents; tips: Cents; deductions: Cents }): Cents {
  return parts.earnings + parts.bonuses + parts.tips - parts.deductions;
}

// ---- versions, state, who wins -------------------------------------------------------------------------------------------------------
export type CardState = "draft" | "pending" | "active" | "expired" | "scheduled" | "archived";
export function cardState(v: { status: string; startsOn: string; endsOn: string | null }, today: string, archived = false): CardState {
  if (archived) return "archived";
  if (v.status === "draft") return "draft";
  if (v.status === "pending") return "pending";
  if (v.endsOn && v.endsOn < today) return "expired";
  if (v.startsOn > today) return "scheduled";
  return "active";
}

/** A change is "big" (needs a second person to approve) when any money amount moves by more than 10 percent, a rate type changes, or the card is new. */
export function isBigChange(oldSpec: RateSpec | null, next: RateSpec): boolean {
  if (!oldSpec) return true;
  if (oldSpec.type !== next.type) return true;
  const keys: (keyof RateSpec)[] = ["baseCents", "flatCents", "perKmCents", "perMinCents", "perHourCents", "perStopCents", "perKgCents", "commissionPct", "salaryCents", "guaranteeCents", "minCents", "peakPct", "nightPct", "weekendPct", "holidayPct", "fuelSurchargePct"];
  for (const k of keys) {
    const a = Number(oldSpec[k] ?? 0), b = Number(next[k] ?? 0);
    if (a === b) continue;
    if (a === 0 || Math.abs(b - a) / a > 0.1) return true;
  }
  return false;
}

export type AssignKind = "driver" | "customer" | "zone" | "vehicle_type" | "group" | "all";
/** Lower number wins. A card made for one driver beats one for a customer, which beats a zone, a vehicle type, a team and then the company default. */
export const ASSIGN_RANK: Record<AssignKind, number> = { driver: 1, customer: 2, zone: 3, vehicle_type: 4, group: 5, all: 6 };
export interface Assignment { id: string; cardId: string; cardName: string; kind: AssignKind; target: string | null; startsOn: string; endsOn: string | null }
export function resolveCard(assigns: Assignment[], ctx: { driverId?: string | null; customer?: string | null; zone?: string | null; vehicleKind?: string | null; groupIds?: string[]; day: string }): { winner: Assignment | null; considered: (Assignment & { matches: boolean; why: string })[] } {
  const lc = (s?: string | null) => (s ?? "").toLowerCase();
  const considered = assigns.map((a) => {
    const inDates = a.startsOn <= ctx.day && (!a.endsOn || a.endsOn >= ctx.day);
    const hit = a.kind === "all" || (a.kind === "driver" && a.target === ctx.driverId) || (a.kind === "customer" && lc(a.target) === lc(ctx.customer) && !!ctx.customer)
      || (a.kind === "zone" && lc(a.target) === lc(ctx.zone) && !!ctx.zone) || (a.kind === "vehicle_type" && lc(a.target) === lc(ctx.vehicleKind) && !!ctx.vehicleKind) || (a.kind === "group" && !!a.target && (ctx.groupIds ?? []).includes(a.target));
    return { ...a, matches: inDates && hit, why: !inDates ? "not active on this day" : hit ? "applies" : "does not apply to this trip" };
  });
  const winner = considered.filter((c) => c.matches).sort((a, b) => ASSIGN_RANK[a.kind] - ASSIGN_RANK[b.kind] || b.startsOn.localeCompare(a.startsOn))[0] ?? null;
  return { winner, considered };
}

// ---- bonuses ----------------------------------------------------------------------------------------------------------------------
export type BonusKind = "trip_count" | "on_time" | "rating" | "peak" | "busy_zone" | "referral" | "safety" | "streak" | "tiered" | "manual";
export interface BonusRule { id: string; name: string; kind: BonusKind; amountCents: number; params: { minTrips?: number; minPct?: number; minRating?: number; zone?: string; days?: number; tiers?: { trips: number; cents: number }[]; perTripCents?: number } }
export interface DriverPeriodStats { trips: number; onTimePct: number | null; ratingAvg: number | null; peakTrips: number; zoneTrips: Record<string, number>; safetyEvents: number; daysWithTrips: number; longestStreak: number }
/** What a bonus pays for a period, and how close the driver is (for the progress bar in the driver's view). */
export function evaluateBonus(r: BonusRule, s: DriverPeriodStats): { earnedCents: Cents; current: number; target: number; label: string } {
  const p = r.params;
  switch (r.kind) {
    case "trip_count": { const t = p.minTrips ?? 1; return { earnedCents: s.trips >= t ? r.amountCents : 0, current: s.trips, target: t, label: `${s.trips} of ${t} trips` }; }
    case "on_time": { const min = p.minPct ?? 90, mt = p.minTrips ?? 5; const ok = s.trips >= mt && (s.onTimePct ?? 0) >= min; return { earnedCents: ok ? r.amountCents : 0, current: s.onTimePct ?? 0, target: min, label: `${s.onTimePct ?? 0}% on time (need ${min}% over ${mt}+ trips)` }; }
    case "rating": { const min = p.minRating ?? 4.8, mt = p.minTrips ?? 5; const ok = s.trips >= mt && (s.ratingAvg ?? 0) >= min; return { earnedCents: ok ? r.amountCents : 0, current: s.ratingAvg ?? 0, target: min, label: `${s.ratingAvg ?? 0} average (need ${min})` }; }
    case "peak": return { earnedCents: times(p.perTripCents ?? r.amountCents, s.peakTrips), current: s.peakTrips, target: s.peakTrips, label: `${s.peakTrips} peak-hour trips` };
    case "busy_zone": { const n = s.zoneTrips[(p.zone ?? "").toLowerCase()] ?? 0; return { earnedCents: times(p.perTripCents ?? r.amountCents, n), current: n, target: n, label: `${n} trips in ${p.zone}` }; }
    case "safety": { const ok = s.safetyEvents === 0 && s.trips > 0; return { earnedCents: ok ? r.amountCents : 0, current: s.safetyEvents, target: 0, label: ok ? "No safety events" : `${s.safetyEvents} safety event(s)` }; }
    case "streak": { const d = p.days ?? 5; return { earnedCents: s.longestStreak >= d ? r.amountCents : 0, current: s.longestStreak, target: d, label: `${s.longestStreak} of ${d} days in a row` }; }
    case "tiered": { const tiers = [...(p.tiers ?? [])].sort((a, b) => a.trips - b.trips); const hit = [...tiers].reverse().find((t) => s.trips >= t.trips); const next = tiers.find((t) => t.trips > s.trips); return { earnedCents: hit?.cents ?? 0, current: s.trips, target: next?.trips ?? hit?.trips ?? 0, label: hit ? `Tier ${hit.trips}+ trips reached` : `${s.trips} trips so far` }; }
    case "referral": case "manual": return { earnedCents: 0, current: 0, target: 0, label: "Added by hand" };
  }
}

/** Longest run of consecutive days (YYYY-MM-DD, sorted ascending, unique) in a list. */
export function longestStreak(days: string[]): number {
  let best = 0, run = 0, prev = NaN;
  for (const d of days) { const n = Math.floor(Date.parse(`${d}T00:00:00Z`) / 86_400_000); run = n === prev + 1 ? run + 1 : 1; prev = n; best = Math.max(best, run); }
  return best;
}

// ---- deductions ---------------------------------------------------------------------------------------------------------------------
/** Apply deduction instalments to a payout without taking more than `capPct` of the gross (or more than is owed). Returns what is taken from each. */
export function applyDeductions(grossCents: Cents, items: { id: string; wantCents: number }[], capPct: number): { id: string; takeCents: Cents }[] {
  let room = Math.max(0, percentOf(Math.max(0, grossCents), capPct));
  return items.map((i) => { const take = Math.max(0, Math.min(i.wantCents, room)); room -= take; return { id: i.id, takeCents: take }; });
}
