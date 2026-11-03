/**
 * Repeat rules for routes and jobs.
 *  every "day":    every `interval` days counting from `from`
 *  every "week":   on the ISO weekdays in `days` (1 = Monday ... 7 = Sunday), every `interval` weeks counting from the week of `from`
 *  every "custom": on exactly the listed `dates`
 */
export interface Recurrence {
  every: "day" | "week" | "custom";
  interval?: number;
  days?: number[];
  dates?: string[];
  from?: string;
  until?: string;
}

const DAY = 86_400_000;
const utc = (d: string) => Date.parse(`${d}T00:00:00Z`);

/** ISO weekday of a YYYY-MM-DD date: 1 = Monday ... 7 = Sunday. */
export function isoWeekday(date: string): number {
  const d = new Date(utc(date)).getUTCDay();
  return d === 0 ? 7 : d;
}

export function isRecurrence(x: unknown): x is Recurrence {
  if (!x || typeof x !== "object") return false;
  const r = x as Recurrence;
  if (!["day", "week", "custom"].includes(r.every)) return false;
  if (r.interval !== undefined && (!Number.isInteger(r.interval) || r.interval < 1 || r.interval > 52)) return false;
  if (r.days !== undefined && (!Array.isArray(r.days) || r.days.some((d) => !Number.isInteger(d) || d < 1 || d > 7))) return false;
  if (r.dates !== undefined && (!Array.isArray(r.dates) || r.dates.some((d) => typeof d !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(d)))) return false;
  for (const k of [r.from, r.until]) if (k !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(k)) return false;
  return true;
}

/** Does the rule produce a route on this date? */
export function occursOn(r: Recurrence, date: string): boolean {
  if (r.from && date < r.from) return false;
  if (r.until && date > r.until) return false;
  const interval = r.interval ?? 1;
  if (r.every === "custom") return (r.dates ?? []).includes(date);
  const from = r.from ?? date;
  if (r.every === "day") return Math.round((utc(date) - utc(from)) / DAY) % interval === 0;
  const days = r.days?.length ? r.days : [isoWeekday(from)];
  if (!days.includes(isoWeekday(date))) return false;
  const weekStart = (d: string) => utc(d) - (isoWeekday(d) - 1) * DAY;
  return Math.round((weekStart(date) - weekStart(from)) / (7 * DAY)) % interval === 0;
}

/** The next dates on which the rule applies, starting at `after` (inclusive). */
export function upcoming(r: Recurrence, after: string, count: number, horizonDays = 400): string[] {
  const out: string[] = [];
  for (let i = 0; i < horizonDays && out.length < count; i++) {
    const d = new Date(utc(after) + i * DAY).toISOString().slice(0, 10);
    if (occursOn(r, d)) out.push(d);
  }
  return out;
}
