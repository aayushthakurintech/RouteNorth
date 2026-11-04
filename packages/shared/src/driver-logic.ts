/**
 * Driver rules shared by the API, the screens and the reports: the score formula, safety score, onboarding steps, hours and compliance.
 * The formulas are written out in plain words so the owner can see exactly how a number is made (spec: "formula visible").
 */

// ---- onboarding -------------------------------------------------------------------------------------------------------
export const ONBOARDING_STEPS = [
  { key: "personal_details", label: "Personal details" },
  { key: "license", label: "Licence upload" },
  { key: "background_check", label: "Background check" },
  { key: "vehicle_training", label: "Vehicle training" },
  { key: "contract", label: "Contract signed" },
  { key: "bank_details", label: "Bank details" },
  { key: "test_trip", label: "First test trip" },
] as const;
export type OnboardingStep = (typeof ONBOARDING_STEPS)[number]["key"];
/** A driver cannot get jobs until these are approved (the owner can change the list in settings). */
export const DEFAULT_REQUIRED_STEPS: OnboardingStep[] = ["personal_details", "license", "background_check", "contract"];

export const DRIVER_STATUSES = ["applicant", "onboarding", "active", "on_trip", "off_duty", "suspended", "archived"] as const;
export type DriverStatus = (typeof DRIVER_STATUSES)[number];

// ---- score -----------------------------------------------------------------------------------------------------------------
export interface ScoreWeights { onTime: number; safety: number; rating: number; acceptance: number; cleanliness: number }
export const DEFAULT_WEIGHTS: ScoreWeights = { onTime: 30, safety: 25, rating: 25, acceptance: 10, cleanliness: 10 };
export interface ScoreInputs {
  /** 0 to 100 each, or null when there is no data yet */
  onTimePct: number | null; safetyScore: number | null; ratingAvg: number | null; acceptancePct: number | null; cleanlinessAvg: number | null;
}
export interface ScorePart { key: keyof ScoreWeights; label: string; weight: number; value: number | null; points: number | null }

/** Ratings are 1 to 5; 1 counts as 0 points and 5 as 100. Parts with no data are left out and the others share their weight. */
export function portalDriverScore(i: ScoreInputs, w: ScoreWeights = DEFAULT_WEIGHTS): { score: number | null; parts: ScorePart[]; formula: string } {
  const star = (x: number | null) => (x == null ? null : Math.max(0, Math.min(100, ((x - 1) / 4) * 100)));
  const raw: Record<keyof ScoreWeights, number | null> = { onTime: i.onTimePct, safety: i.safetyScore, rating: star(i.ratingAvg), acceptance: i.acceptancePct, cleanliness: star(i.cleanlinessAvg) };
  const labels: Record<keyof ScoreWeights, string> = { onTime: "On-time rate", safety: "Safety", rating: "Customer rating", acceptance: "Acceptance", cleanliness: "Cleanliness" };
  const keys = Object.keys(w) as (keyof ScoreWeights)[];
  const have = keys.filter((k) => raw[k] != null && w[k] > 0);
  const total = have.reduce((a, k) => a + w[k], 0);
  const parts: ScorePart[] = keys.map((k) => ({ key: k, label: labels[k], weight: w[k], value: raw[k] == null ? null : Math.round(raw[k]!), points: raw[k] != null && total > 0 && w[k] > 0 ? Math.round(((raw[k]! * w[k]) / total) * 10) / 10 : null }));
  const score = total > 0 ? Math.round(have.reduce((a, k) => a + (raw[k]! * w[k]) / total, 0)) : null;
  return { score, parts, formula: `${keys.map((k) => `${w[k]}% ${labels[k].toLowerCase()}`).join(", ")}. A part with no data yet is left out and the rest share its weight.` };
}

// ---- safety ------------------------------------------------------------------------------------------------------------------
export const SAFETY_POINTS: Record<string, number> = { speeding: 2, harsh_brake: 2, harsh_turn: 1, phone_use: 5, late_night: 1, incident: 10, ticket: 5 };
/** 100 minus 5 for every penalty point per 1,000 km driven (at least 500 km counts, so one event on a new driver does not zero them). */
export function safetyScore(events: { kind: string; severity: number }[], km: number): number {
  const penalty = events.reduce((a, e) => a + (SAFETY_POINTS[e.kind] ?? 1) * Math.max(1, Math.min(3, e.severity)), 0);
  const per1000 = penalty / (Math.max(km, 500) / 1000);
  return Math.max(0, Math.min(100, Math.round(100 - 5 * per1000)));
}
export const SAFETY_FORMULA = "100 minus 5 for every penalty point per 1,000 km (at least 500 km counts). Points: speeding 2, harsh braking 2, harsh turn 1, phone use 5, late-night driving 1, incident 10, ticket 5, each multiplied by severity 1 to 3.";

// ---- hours and compliance -----------------------------------------------------------------------------------------------------
export interface HoursRules {
  region: string;
  /** Overtime starts after this many hours in a week (Ontario default 44) */
  overtimeWeeklyHours: number; overtimeDailyHours: number | null;
  /** Hours-of-service style limits for commercial drivers (starting points based on the federal rules; confirm for your own operation) */
  maxDailyHours: number; maxWeeklyHours: number; minRestHours: number;
}
export const DEFAULT_HOURS_RULES: HoursRules = { region: "Ontario", overtimeWeeklyHours: 44, overtimeDailyHours: null, maxDailyHours: 14, maxWeeklyHours: 70, minRestHours: 10 };

export interface ShiftIn { startedAt: string; endedAt: string | null; breakMinutes?: number }
export interface HoursViolation { kind: "overtime_week" | "overtime_day" | "daily_limit" | "weekly_limit" | "rest"; at: string; detail: string }

const hrs = (ms: number) => Math.round((ms / 3_600_000) * 100) / 100;
export function hoursReport(shifts: ShiftIn[], rules: HoursRules, now: Date, tz: string): { days: { day: string; hours: number }[]; weeks: { weekStart: string; hours: number }[]; violations: HoursViolation[] } {
  const dayOf = (iso: string) => new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(iso));
  const done = shifts.map((s) => ({ ...s, start: new Date(s.startedAt).getTime(), end: s.endedAt ? new Date(s.endedAt).getTime() : now.getTime() })).sort((a, b) => a.start - b.start);
  const days = new Map<string, number>();
  for (const s of done) { const net = Math.max(0, s.end - s.start - (s.breakMinutes ?? 0) * 60_000); days.set(dayOf(s.startedAt), (days.get(dayOf(s.startedAt)) ?? 0) + net); }
  const weekStart = (day: string) => { const d = new Date(`${day}T12:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); };
  const weeks = new Map<string, number>();
  for (const [day, ms] of days) weeks.set(weekStart(day), (weeks.get(weekStart(day)) ?? 0) + ms);
  const violations: HoursViolation[] = [];
  for (const [day, ms] of days) {
    if (rules.overtimeDailyHours != null && hrs(ms) > rules.overtimeDailyHours) violations.push({ kind: "overtime_day", at: day, detail: `${hrs(ms)} h worked, over ${rules.overtimeDailyHours} h` });
    if (hrs(ms) > rules.maxDailyHours) violations.push({ kind: "daily_limit", at: day, detail: `${hrs(ms)} h on duty, over the ${rules.maxDailyHours} h daily limit` });
  }
  for (const [w, ms] of weeks) if (hrs(ms) > rules.overtimeWeeklyHours) violations.push({ kind: "overtime_week", at: w, detail: `${hrs(ms)} h this week, over ${rules.overtimeWeeklyHours} h (${rules.region} overtime rule)` });
  // rolling seven days
  for (const s of done) {
    const from = s.end - 7 * 86_400_000;
    const total = done.filter((x) => x.end > from && x.start <= s.end).reduce((a, x) => a + Math.max(0, Math.min(x.end, s.end) - Math.max(x.start, from)), 0);
    if (hrs(total) > rules.maxWeeklyHours && !violations.some((v) => v.kind === "weekly_limit" && v.at === dayOf(s.startedAt))) violations.push({ kind: "weekly_limit", at: dayOf(s.startedAt), detail: `${hrs(total)} h in 7 days, over the ${rules.maxWeeklyHours} h limit` });
  }
  for (let k = 1; k < done.length; k++) {
    const rest = hrs(done[k]!.start - done[k - 1]!.end);
    if (rest >= 0 && rest < rules.minRestHours) violations.push({ kind: "rest", at: dayOf(done[k]!.startedAt), detail: `only ${rest} h of rest before this shift, needs ${rules.minRestHours} h` });
  }
  return { days: [...days].map(([day, ms]) => ({ day, hours: hrs(ms) })).sort((a, b) => a.day.localeCompare(b.day)), weeks: [...weeks].map(([w, ms]) => ({ weekStart: w, hours: hrs(ms) })).sort((a, b) => a.weekStart.localeCompare(b.weekStart)), violations };
}

/** 100 minus: 30 per expired document, 5 per document expiring soon, 10 per missing required course, 5 per hours violation (last 30 days), 20 if onboarding is not finished. */
export function complianceScore(i: { expiredDocs: number; expiringDocs: number; missingCourses: number; hoursViolations: number; onboardingIncomplete: boolean }): number {
  return Math.max(0, Math.min(100, 100 - 30 * i.expiredDocs - 5 * i.expiringDocs - 10 * i.missingCourses - 5 * i.hoursViolations - (i.onboardingIncomplete ? 20 : 0)));
}
export const COMPLIANCE_FORMULA = "100 minus 30 per expired document, 5 per document expiring soon, 10 per missing required course, 5 per hours-rule breach in the last 30 days, and 20 while onboarding is unfinished.";

/** Is the driver allowed to be given work? Returns the reasons they are not. */
export function driverBlockers(i: { status: string; archived: boolean; requiredOpen: string[]; legalDocsExpired: string[] }): string[] {
  const out: string[] = [];
  if (i.archived) out.push("Driver is archived");
  else if (i.status === "suspended") out.push("Driver is suspended");
  else if (i.status === "onboarding") out.push(i.requiredOpen.length ? `Onboarding is not finished (${i.requiredOpen.join(", ")})` : "Onboarding is not finished");
  if (i.legalDocsExpired.length) out.push(`Expired: ${[...new Set(i.legalDocsExpired)].join(", ")}`);
  return out;
}
export const DRIVER_LEGAL_DOC = /licen[cs]e|permit|abstract|medical|background/i;
