/** Fleet housekeeping rules: maintenance due dates, document expiry, fuel economy, weather warnings. */

export type DueState = "overdue" | "due_soon" | "ok";

export interface PlanInput {
  everyDays: number | null;
  everyKm: number | null;
  lastDoneOn: string | null;
  lastDoneKm: number | null;
}

export interface Due {
  state: DueState;
  /** YYYY-MM-DD the task is due (by date), if the plan repeats by days. */
  dueOn: string | null;
  /** Odometer the task is due at, if the plan repeats by kilometers. */
  dueKm: number | null;
  daysLeft: number | null;
  kmLeft: number | null;
}

const DAY = 86_400_000;
const day = (d: string) => Date.parse(`${d}T00:00:00Z`);

/**
 * When is a maintenance task next due? A plan that repeats by days and by kilometers is due at whichever comes first.
 * "Due soon" is within 14 days or 500 km.
 */
export function maintenanceDue(plan: PlanInput, today: string, odometerKm: number, soonDays = 14, soonKm = 500): Due {
  let dueOn: string | null = null;
  let daysLeft: number | null = null;
  if (plan.everyDays && plan.lastDoneOn) {
    dueOn = new Date(day(plan.lastDoneOn) + plan.everyDays * DAY).toISOString().slice(0, 10);
    daysLeft = Math.round((day(dueOn) - day(today)) / DAY);
  } else if (plan.everyDays && !plan.lastDoneOn) {
    daysLeft = 0; // never done: due now
    dueOn = today;
  }
  let dueKm: number | null = null;
  let kmLeft: number | null = null;
  if (plan.everyKm) {
    dueKm = (plan.lastDoneKm ?? 0) + plan.everyKm;
    kmLeft = Math.round(dueKm - odometerKm);
  }
  const overdue = (daysLeft !== null && daysLeft < 0) || (kmLeft !== null && kmLeft < 0);
  const soon = (daysLeft !== null && daysLeft <= soonDays) || (kmLeft !== null && kmLeft <= soonKm);
  return { state: overdue ? "overdue" : soon ? "due_soon" : "ok", dueOn, dueKm, daysLeft, kmLeft };
}

/** Days until a document expires (negative if it already has), or null if it never expires. */
export function daysToExpiry(expiresOn: string | null, today: string): number | null {
  return expiresOn ? Math.round((day(expiresOn) - day(today)) / DAY) : null;
}

export function documentState(expiresOn: string | null, remindDays: number, today: string): DueState {
  const d = daysToExpiry(expiresOn, today);
  if (d === null) return "ok";
  return d < 0 ? "overdue" : d <= remindDays ? "due_soon" : "ok";
}

export interface FuelFill { odometerKm: number | null; litres: number; cost: number | null }

/**
 * Fuel use from a vehicle's fill-ups in date order: litres per 100 km between the first and last readings
 * (the first fill's litres belong to the trip before it, so they are left out).
 */
export function fuelEconomy(fills: readonly FuelFill[]): { litres: number; cost: number; km: number; lPer100: number | null; costPerKm: number | null } {
  const lit = fills.reduce((a, f) => a + f.litres, 0);
  const cost = fills.reduce((a, f) => a + (f.cost ?? 0), 0);
  const withOdo = fills.filter((f) => f.odometerKm != null);
  if (withOdo.length < 2) return { litres: lit, cost, km: 0, lPer100: null, costPerKm: null };
  const km = withOdo[withOdo.length - 1]!.odometerKm! - withOdo[0]!.odometerKm!;
  if (km <= 0) return { litres: lit, cost, km: 0, lPer100: null, costPerKm: null };
  const used = withOdo.slice(1).reduce((a, f) => a + f.litres, 0);
  const usedCost = withOdo.slice(1).reduce((a, f) => a + (f.cost ?? 0), 0);
  return { litres: lit, cost, km: Math.round(km), lPer100: Math.round((used / km) * 1000) / 10, costPerKm: Math.round((usedCost / km) * 1000) / 1000 };
}

// ---- weather ----

export type WeatherLevel = "ok" | "caution" | "severe";
export interface WeatherNow { tempC: number; precipMm: number; precipProb: number; windKmh: number; code: number }
export interface WeatherSummary extends WeatherNow { label: string; level: WeatherLevel; reason: string | null }

/** WMO weather codes as used by Open-Meteo. */
function label(code: number): string {
  if (code === 0) return "clear";
  if (code <= 3) return "cloudy";
  if (code === 45 || code === 48) return "fog";
  if (code >= 51 && code <= 57) return "drizzle";
  if (code >= 61 && code <= 67) return "rain";
  if (code >= 71 && code <= 77) return "snow";
  if (code >= 80 && code <= 82) return "showers";
  if (code === 85 || code === 86) return "snow showers";
  if (code >= 95) return "thunderstorm";
  return "cloudy";
}

/** Turn a forecast into something a dispatcher can act on: is it safe to drive, and why not. */
export function summarizeWeather(w: WeatherNow): WeatherSummary {
  let level: WeatherLevel = "ok";
  let reason: string | null = null;
  const raise = (l: WeatherLevel, r: string) => { if (l === "severe" || (l === "caution" && level === "ok")) { level = l; reason = r; } };
  const lab = label(w.code);
  if (w.code >= 95) raise("severe", "thunderstorm");
  if (w.code === 56 || w.code === 57 || w.code === 66 || w.code === 67) raise("severe", "freezing rain");
  if ((w.code >= 71 && w.code <= 77) || w.code === 85 || w.code === 86) raise(w.precipMm >= 2 ? "severe" : "caution", "snow");
  if (w.code === 45 || w.code === 48) raise("caution", "fog");
  if (w.windKmh >= 70) raise("severe", "high wind"); else if (w.windKmh >= 50) raise("caution", "strong wind");
  if (w.precipMm >= 7) raise("severe", "heavy rain"); else if (w.precipMm >= 2.5 && w.precipProb >= 50) raise("caution", "rain");
  if (w.tempC <= -25) raise("severe", "extreme cold"); else if (w.tempC <= -15) raise("caution", "cold");
  if (w.tempC >= 35) raise("caution", "heat");
  return { ...w, label: lab, level, reason };
}
