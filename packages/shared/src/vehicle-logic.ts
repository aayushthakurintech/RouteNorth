/**
 * Pure rules for the Owner Portal's vehicles: VIN check, service schedule, document status, licence check,
 * depreciation, payback and the keep/repair/sell score. No database here, so every rule has a plain test.
 */

// ---- VIN ------------------------------------------------------------------------------------------------------------
const VIN_VALUES: Record<string, number> = {};
"0123456789".split("").forEach((c, i) => { VIN_VALUES[c] = i; });
"ABCDEFGH".split("").forEach((c, i) => { VIN_VALUES[c] = i + 1; });
"JKLMN".split("").forEach((c, i) => { VIN_VALUES[c] = i + 1; });
VIN_VALUES.P = 7; VIN_VALUES.R = 9;
"STUVWXYZ".split("").forEach((c, i) => { VIN_VALUES[c] = i + 2; });
const VIN_WEIGHTS = [8, 7, 6, 5, 4, 3, 2, 10, 0, 9, 8, 7, 6, 5, 4, 3, 2];

export interface VinCheck { ok: boolean; vin: string; error?: string; /** North American check digit (position 9) matches. Non-NA vehicles may legitimately fail it. */ checkDigitOk?: boolean }
export function checkVin(raw: string): VinCheck {
  const vin = raw.trim().toUpperCase();
  if (vin.length !== 17) return { ok: false, vin, error: "A VIN has exactly 17 characters" };
  if (!/^[A-HJ-NPR-Z0-9]{17}$/.test(vin)) return { ok: false, vin, error: "A VIN uses letters and digits, but never I, O or Q" };
  const sum = vin.split("").reduce((a, ch, i) => a + VIN_VALUES[ch]! * VIN_WEIGHTS[i]!, 0);
  const check = sum % 11 === 10 ? "X" : String(sum % 11);
  return { ok: true, vin, checkDigitOk: vin[8] === check };
}

// ---- dates ----------------------------------------------------------------------------------------------------------
export const dayNumber = (isoDate: string): number => Math.floor(Date.parse(`${isoDate.slice(0, 10)}T00:00:00Z`) / 86_400_000);
export const addDaysISO = (isoDate: string, days: number): string => new Date((dayNumber(isoDate) + days) * 86_400_000).toISOString().slice(0, 10);
export const daysUntilISO = (isoDate: string, today: string): number => dayNumber(isoDate) - dayNumber(today);

// ---- documents --------------------------------------------------------------------------------------------------------
export type DocState = "valid" | "expiring" | "expired" | "none";
/** `remindDays` is how early the owner wants to hear (30 by default). */
export function docStatus(expiresOn: string | null, today: string, remindDays = 30): { state: DocState; daysLeft: number | null } {
  if (!expiresOn) return { state: "none", daysLeft: null };
  const d = daysUntilISO(expiresOn, today);
  return { state: d < 0 ? "expired" : d <= remindDays ? "expiring" : "valid", daysLeft: d };
}
/** Papers that make a car illegal or unsafe to dispatch when they run out. Others (lease papers, manuals) only warn. */
export const LEGAL_DOC = /registration|insurance|inspection|permit|safety|licen[cs]e|certificate|cvor|nsc/i;

// ---- service schedule (date, kilometres or engine hours, whichever comes first) ---------------------------------------------
export interface ServiceInput {
  today: string;
  odometerKm: number;
  engineHours?: number | null;
  intervalKm?: number | null; intervalDays?: number | null; intervalHours?: number | null;
  /** Latest service on record */
  lastDoneOn?: string | null; lastDoneKm?: number | null; lastDoneHours?: number | null;
  /** Fallback start of the schedule when nothing has been done yet */
  startOn?: string | null;
  /** Extra plans (oil change every 10 000 km, annual inspection ...) */
  plans?: { task: string; everyDays?: number | null; everyKm?: number | null; lastDoneOn?: string | null; lastDoneKm?: number | null }[];
  warnDays?: number; warnKm?: number;
}
export interface ServiceStatus {
  nextDate: string | null; nextKm: number | null; nextHours: number | null; daysLeft: number | null; kmLeft: number | null; hoursLeft: number | null;
  dueBy: "date" | "km" | "hours" | null; task: string | null; state: "ok" | "due_soon" | "overdue" | "none";
}
export function serviceStatus(i: ServiceInput): ServiceStatus {
  const warnDays = i.warnDays ?? 14, warnKm = i.warnKm ?? 500;
  type Cand = { date: string | null; km: number | null; hours: number | null; task: string | null };
  const cands: Cand[] = [];
  if (i.intervalKm || i.intervalDays || i.intervalHours) {
    const baseDate = i.lastDoneOn ?? i.startOn ?? null;
    cands.push({
      date: i.intervalDays && baseDate ? addDaysISO(baseDate, i.intervalDays) : null,
      km: i.intervalKm ? (i.lastDoneKm ?? 0) + i.intervalKm : null,
      hours: i.intervalHours ? (i.lastDoneHours ?? 0) + i.intervalHours : null, task: "Scheduled service",
    });
  }
  for (const p of i.plans ?? []) {
    cands.push({ date: p.everyDays && p.lastDoneOn ? addDaysISO(p.lastDoneOn, p.everyDays) : null, km: p.everyKm && p.lastDoneKm != null ? p.lastDoneKm + p.everyKm : null, hours: null, task: p.task });
  }
  if (!cands.length) return { nextDate: null, nextKm: null, nextHours: null, daysLeft: null, kmLeft: null, hoursLeft: null, dueBy: null, task: null, state: "none" };
  // The most urgent candidate: the one with the least days left, or (no date) the least km left.
  const scored = cands.map((c) => ({ c, d: c.date ? daysUntilISO(c.date, i.today) : Infinity, k: c.km != null ? c.km - i.odometerKm : Infinity, h: c.hours != null && i.engineHours != null ? c.hours - i.engineHours : Infinity }));
  const urgent = (x: (typeof scored)[number]) => Math.min(x.d / warnDays, x.k / warnKm, x.h / 50);
  scored.sort((a, b) => urgent(a) - urgent(b));
  const w = scored[0]!;
  const daysLeft = Number.isFinite(w.d) ? w.d : null, kmLeft = Number.isFinite(w.k) ? w.k : null, hoursLeft = Number.isFinite(w.h) ? w.h : null;
  const dueBy = (daysLeft ?? Infinity) / warnDays <= (kmLeft ?? Infinity) / warnKm && daysLeft != null && (hoursLeft == null || daysLeft / warnDays <= hoursLeft / 50) ? "date" : kmLeft != null && (hoursLeft == null || kmLeft / warnKm <= hoursLeft / 50) ? "km" : hoursLeft != null ? "hours" : null;
  const overdue = (daysLeft != null && daysLeft < 0) || (kmLeft != null && kmLeft < 0) || (hoursLeft != null && hoursLeft < 0);
  const soon = (daysLeft != null && daysLeft <= warnDays) || (kmLeft != null && kmLeft <= warnKm) || (hoursLeft != null && hoursLeft <= 50);
  return { nextDate: w.c.date, nextKm: w.c.km, nextHours: w.c.hours, daysLeft, kmLeft, hoursLeft, dueBy, task: w.c.task, state: overdue ? "overdue" : soon ? "due_soon" : "ok" };
}

// ---- licence class vs vehicle ----------------------------------------------------------------------------------------------
export type LicenceCheck = "ok" | "not_licensed" | "unknown";
const CLASS_RANK: Record<string, { rank: number; bus?: boolean; truck?: boolean }> = {
  "5": { rank: 1 }, "G": { rank: 1 }, "G2": { rank: 1 }, "7": { rank: 0 }, "6": { rank: 0 }, "M": { rank: 0 },
  "4": { rank: 2, bus: true }, "3": { rank: 3, truck: true }, "D": { rank: 3, truck: true }, "DZ": { rank: 5, truck: true, bus: false },
  "2": { rank: 4, bus: true }, "B": { rank: 4, bus: true }, "C": { rank: 4, bus: true }, "E": { rank: 3, bus: true }, "F": { rank: 3, bus: true },
  "1": { rank: 5, truck: true }, "A": { rank: 5, truck: true }, "AZ": { rank: 5, truck: true },
};
/**
 * Does this licence class cover this kind of vehicle? A general guide for Canadian classes (Class 1-5, Ontario letters).
 * Rules differ by province, so an unrecognised class returns "unknown" and the owner is asked to check by hand.
 */
export function licenceAllows(licenceClass: string | null | undefined, kind: string, seats?: number | null): LicenceCheck {
  if (!licenceClass) return "unknown";
  const k = CLASS_RANK[licenceClass.trim().toUpperCase().replace(/^CLASS\s*/, "")];
  if (!k) return "unknown";
  switch (kind) {
    case "bike": return k.rank === 0 || k.rank >= 1 ? (licenceClass.toUpperCase() === "M" || licenceClass === "6" ? "ok" : "unknown") : "not_licensed";
    case "car": case "suv": case "van": case "other": return k.rank >= 1 ? "ok" : "not_licensed";
    case "truck": return k.truck || k.rank >= 5 ? "ok" : "not_licensed";
    case "bus": return k.bus ? (licenceClass.trim() === "4" && (seats ?? 0) > 24 ? "not_licensed" : "ok") : "not_licensed";
    default: return "unknown";
  }
}

// ---- value, depreciation, payback ------------------------------------------------------------------------------------------------
/** Straight-line value between the purchase price and the residual value over `lifeYears`, one point per month. */
export function depreciationSeries(purchaseCents: number, residualCents: number, purchaseDate: string, lifeYears = 5): { month: string; valueCents: number }[] {
  const months = Math.max(1, Math.round(lifeYears * 12));
  const out: { month: string; valueCents: number }[] = [];
  const [y, m] = purchaseDate.split("-").map(Number) as [number, number];
  for (let i = 0; i <= months; i++) {
    const d = new Date(Date.UTC(y, m - 1 + i, 1));
    out.push({ month: d.toISOString().slice(0, 7), valueCents: Math.round(purchaseCents - ((purchaseCents - residualCents) * i) / months) });
  }
  return out;
}

/** Days until the car has paid for itself at its average daily profit so far; null when it is not on track to. */
export function paybackDays(purchaseCents: number, profitToDateCents: number, daysInService: number): number | null {
  if (daysInService <= 0 || profitToDateCents <= 0) return null;
  const perDay = profitToDateCents / daysInService;
  return Math.ceil((purchaseCents - profitToDateCents) / perDay) + daysInService;
}

/**
 * "Keep, repair or sell" score from 0 (keep) to 100 (sell). The formula is shown to the owner:
 *   60% repair cost over the last 12 months compared with the car's value, 25% age (10 years = full), 15% losing money.
 */
export function keepRepairSell(i: { repairs12mCents: number; valueCents: number; ageYears: number; profit12mCents: number }): { score: number; advice: "keep" | "repair" | "sell"; parts: { repairRatio: number; age: number; loss: number } } {
  const ratio = Math.min(1, i.repairs12mCents / Math.max(i.valueCents, 100_00));
  const age = Math.min(1, Math.max(0, i.ageYears) / 10);
  const loss = i.profit12mCents < 0 ? 1 : 0;
  const score = Math.round(60 * ratio + 25 * age + 15 * loss);
  return { score, advice: score >= 65 ? "sell" : score >= 35 ? "repair" : "keep", parts: { repairRatio: Math.round(ratio * 100) / 100, age: Math.round(age * 100) / 100, loss } };
}

/** Cost of a loan or lease for `days` days (accrued daily from the payment amount and interval). */
export function financeAccrual(paymentCents: number, interval: "weekly" | "biweekly" | "monthly", days: number): number {
  const perYear = interval === "weekly" ? 52 : interval === "biweekly" ? 26 : 12;
  return Math.round((paymentCents * perYear * days) / 365);
}

