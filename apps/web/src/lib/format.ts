import type { Locale } from "@routenorth/shared";

const localeTag = (l: Locale) => (l === "fr" ? "fr-CA" : "en-CA");

export function formatKm(metres: number, locale: Locale): string {
  return `${new Intl.NumberFormat(localeTag(locale), { maximumFractionDigits: 1 }).format(metres / 1000)} km`;
}

export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h} h ${String(m).padStart(2, "0")} min`;
  if (m > 0) return `${m} min`;
  return `${total} s`;
}

export function formatTime(iso: string, locale: Locale): string {
  return new Date(iso).toLocaleTimeString(localeTag(locale), { hour: "2-digit", minute: "2-digit" });
}

/** [start, end) of a local calendar day given as YYYY-MM-DD, as ISO strings. */
export function dayRange(date: string): { from: string; to: string } {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return { from: new Date(y, m - 1, d).toISOString(), to: new Date(y, m - 1, d + 1).toISOString() };
}

export function todayLocal(now = new Date()): string {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

/** Escape one CSV cell, including protection against spreadsheet formula injection. */
function cell(v: string | number): string {
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s) && typeof v === "string") s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(header: string[], rows: (string | number)[][]): string {
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
