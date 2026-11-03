/** Small helpers for money, dates and invoice lines on the billing pages. */

export const localeTag = (loc: string) => (loc === "fr" ? "fr-CA" : "en-CA");

export function money(n: number | null | undefined, currency: string, loc: string): string {
  if (n == null || !Number.isFinite(n)) return "–";
  try { return new Intl.NumberFormat(localeTag(loc), { style: "currency", currency }).format(n); } catch { return `${currency} ${n.toFixed(2)}`; }
}

export const isoDay = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export function addDays(iso: string, n: number): string {
  const [y, m, d] = iso.split("-").map(Number);
  return isoDay(new Date(y!, m! - 1, d! + n));
}

/** Monday of the week that holds `iso`. */
export function weekStart(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  const dow = (new Date(y!, m! - 1, d!).getDay() + 6) % 7;
  return addDays(iso, -dow);
}

export interface LineDraft { description: string; qty: string; unitPrice: string }
export const emptyLine = (): LineDraft => ({ description: "", qty: "1", unitPrice: "" });

/** Lines the person filled in, as the API wants them. Blank lines are left out. */
export function linesToBody(lines: LineDraft[]): { description: string; qty: number; unitPrice: number }[] {
  return lines.filter((l) => l.description.trim() || l.unitPrice.trim()).map((l) => ({ description: l.description.trim(), qty: Number(l.qty || 1), unitPrice: Number(l.unitPrice) }));
}

export function linesSubtotal(lines: LineDraft[]): number {
  const t = linesToBody(lines).reduce((a, l) => a + (Number.isFinite(l.qty * l.unitPrice) ? l.qty * l.unitPrice : 0), 0);
  return Math.round(t * 100) / 100;
}

/** Percentage bar width, kept between 0 and 100. */
export const barPct = (pct: number | null | undefined) => Math.max(0, Math.min(100, pct ?? 0));
