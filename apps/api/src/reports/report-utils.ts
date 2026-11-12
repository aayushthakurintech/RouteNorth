import { dayNumber } from "@routenorth/shared";
import { DATASET_BY_KEY, type ReportResult, type ReportSpec } from "./datasets.js";

const shift = (d: string, n: number) => new Date((dayNumber(d) + n) * 86_400_000).toISOString().slice(0, 10);

/** The period of the same length that ends the day before this one starts ("compare to the previous period"). */
export function previousPeriod(r: { from: string; to: string }): { from: string; to: string } {
  const len = dayNumber(r.to) - dayNumber(r.from) + 1;
  return { from: shift(r.from, -len), to: shift(r.from, -1) };
}
/** The same dates one year earlier ("compare to the same period last year"). */
export function sameLastYear(r: { from: string; to: string }): { from: string; to: string } {
  const back = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`.replace(/-02-29$/, "-02-28");
  return { from: back(r.from), to: back(r.to) };
}

const OPS: Record<string, string> = { eq: "is", ne: "is not", gt: "is more than", gte: "is at least", lt: "is less than", lte: "is at most", in: "is one of", contains: "contains" };
/** The filters in plain words, printed on the screen and on every export (spec: "every report shows the filters used"). */
export function filtersText(spec: ReportSpec): string[] {
  const ds = DATASET_BY_KEY.get(spec.dataset);
  const label = (k: string) => ds?.columns.find((c) => c.key === k)?.label ?? k;
  return (spec.filters ?? []).map((f) => `${label(f.key)} ${OPS[f.op] ?? f.op} ${Array.isArray(f.value) ? f.value.join(", ") : String(f.value)}`);
}

/**
 * Turn a result into what a spreadsheet should hold: money columns become dollars (not cents) and the header says the currency.
 * `text` makes money a "12.34" string for PDFs, so the zeros are not dropped.
 */
export function forExport(r: ReportResult, currency: string, text = false): { result: ReportResult; labels: Record<string, string> } {
  const money = r.columns.filter((c) => c.type === "money");
  const conv = (v: unknown) => (typeof v === "number" ? (text ? (v / 100).toFixed(2) : Math.round(v) / 100) : v);
  const rows = r.rows.map((row) => { const o = { ...row }; for (const c of money) o[c.key] = conv(o[c.key]); return o; });
  const totals: Record<string, number | null> = { ...r.totals };
  const totalOut: Record<string, unknown> = { ...totals };
  for (const c of money) if (typeof totals[c.key] === "number") totalOut[c.key] = conv(totals[c.key]);
  const labels: Record<string, string> = {};
  for (const c of money) labels[c.key] = `${c.label} (${currency})`;
  return { result: { ...r, rows, totals: totalOut as ReportResult["totals"] }, labels };
}

// ---- "Ask in plain words": a draft report from keywords. No AI model is used; it matches words and says what it matched. ----

interface Rule { words: RegExp; dataset: string; columns: string[]; explain: string; sort?: { key: string; dir: "asc" | "desc" } }
const DATA_RULES: Rule[] = [
  { words: /\b(profit|margin|earn(ed|ings)?)\b.*\b(driver|drivers)\b|\b(driver|drivers)\b.*\b(profit|margin)\b/, dataset: "driverProfit", columns: ["driver", "trips", "revenue", "driverPay", "carCost", "profit"], sort: { key: "profit", dir: "desc" }, explain: "Driver profit" },
  { words: /\b(profit|loss|losing|money)\b.*\b(car|cars|vehicle|vehicles|truck|trucks|bus|buses)\b|\b(car|cars|vehicle|vehicles|truck|trucks)\b.*\b(profit|loss)\b|\bprofit\b/, dataset: "carMoney", columns: ["vehicle", "revenue", "cost", "profit"], sort: { key: "profit", dir: "asc" }, explain: "Vehicle profit and loss" },
  { words: /\bcustomers?\b/, dataset: "customers", columns: ["customer", "trips", "revenue", "margin"], sort: { key: "revenue", dir: "desc" }, explain: "Customers" },
  { words: /\b(fuel|gas|diesel|energy)\b/, dataset: "fuelLogs", columns: ["date", "vehicle", "amount", "cost", "kmPerUnit"], sort: { key: "date", dir: "desc" }, explain: "Fuel and energy" },
  { words: /\b(repair|repairs|maintenance|service|servicing)\b/, dataset: "repairs", columns: ["date", "vehicle", "task", "total", "downtimeDays"], sort: { key: "date", dir: "desc" }, explain: "Maintenance and repairs" },
  { words: /\b(expense|expenses|spend|spending)\b/, dataset: "expenses", columns: ["date", "category", "vendor", "vehicle", "amount"], sort: { key: "date", dir: "desc" }, explain: "Expenses" },
  { words: /\b(invoice|invoices|owed|owe|receivable)\b/, dataset: "invoices", columns: ["number", "customer", "status", "dueOn", "daysLate", "total"], sort: { key: "dueOn", dir: "asc" }, explain: "Invoices" },
  { words: /\b(payout|payouts|payroll|paid)\b/, dataset: "payouts", columns: ["from", "to", "driver", "earnings", "bonuses", "deductions", "net"], sort: { key: "to", dir: "desc" }, explain: "Payouts" },
  { words: /\b(bonus|bonuses|deduction|deductions|pay lines?)\b/, dataset: "payLines", columns: ["date", "driver", "kind", "label", "amount"], sort: { key: "date", dir: "desc" }, explain: "Pay lines" },
  { words: /\b(incident|incidents|accident|accidents|claim|claims)\b/, dataset: "incidentRegister", columns: ["date", "vehicle", "driver", "kind", "severity", "repairCost"], sort: { key: "date", dir: "desc" }, explain: "Incidents and claims" },
  { words: /\b(document|documents|licen[cs]e|expire|expiring|expiry)\b/, dataset: "documents", columns: ["subject", "kind", "expiresOn", "daysLeft", "status"], sort: { key: "daysLeft", dir: "asc" }, explain: "Documents" },
  { words: /\b(driver|drivers|score|rating)\b/, dataset: "drivers", columns: ["driver", "status", "score", "onTimePct", "rating"], sort: { key: "score", dir: "desc" }, explain: "Drivers" },
  { words: /\b(trip|trips|revenue|sales|income)\b/, dataset: "trips", columns: ["date", "driver", "vehicle", "customer", "price", "driverPay", "margin"], sort: { key: "date", dir: "desc" }, explain: "Trips" },
  { words: /\b(car|cars|vehicle|vehicles|fleet|truck|trucks|bus|buses)\b/, dataset: "vehicles", columns: ["vehicle", "status", "driver", "odometerKm", "nextService"], explain: "Vehicles" },
];
const GROUPS: [RegExp, string][] = [[/\b(per|by|each) (car|vehicle|truck|bus)\b/, "vehicle"], [/\b(per|by|each) driver\b/, "driver"], [/\b(per|by|each) customer\b/, "customer"], [/\b(per|by|each) (month|monthly)\b/, "month"], [/\b(per|by|each) (day|daily)\b/, "date"], [/\b(per|by|each) route\b/, "route"], [/\b(per|by|each) zone\b/, "zone"], [/\b(per|by|each) (type|category|kind)\b/, "category"]];

function monthStart(y: number, m: number) { return `${y}-${String(m).padStart(2, "0")}-01`; }
/** Dates for words like "last quarter" or "this month", in the company's calendar. */
export function rangeFromWords(t: string, today: string): { range: { from: string; to: string }; said: string } | null {
  const y = Number(today.slice(0, 4)), mo = Number(today.slice(5, 7));
  const lastDay = (yy: number, mm: number) => new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  if (/last quarter|previous quarter/.test(t)) { const q = Math.floor((mo - 1) / 3); const qy = q === 0 ? y - 1 : y, qs = q === 0 ? 10 : (q - 1) * 3 + 1; return { range: { from: monthStart(qy, qs), to: lastDay(qy, qs + 2) }, said: "last quarter" }; }
  if (/this quarter/.test(t)) { const qs = Math.floor((mo - 1) / 3) * 3 + 1; return { range: { from: monthStart(y, qs), to: today }, said: "this quarter" }; }
  if (/last month|previous month/.test(t)) { const mm = mo === 1 ? 12 : mo - 1, yy = mo === 1 ? y - 1 : y; return { range: { from: monthStart(yy, mm), to: lastDay(yy, mm) }, said: "last month" }; }
  if (/this month/.test(t)) return { range: { from: monthStart(y, mo), to: today }, said: "this month" };
  if (/last year|previous year/.test(t)) return { range: { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` }, said: "last year" };
  if (/this year|year to date|ytd/.test(t)) return { range: { from: `${y}-01-01`, to: today }, said: "this year" };
  const n = /last (\d{1,3}) days/.exec(t);
  if (n) { const d = Math.min(800, Math.max(1, Number(n[1]))); return { range: { from: shift(today, -(d - 1)), to: today }, said: `last ${d} days` }; }
  if (/last week|past week|last 7/.test(t)) return { range: { from: shift(today, -6), to: today }, said: "last 7 days" };
  if (/yesterday/.test(t)) return { range: { from: shift(today, -1), to: shift(today, -1) }, said: "yesterday" };
  if (/today/.test(t)) return { range: { from: today, to: today }, said: "today" };
  return null;
}

export interface Draft { spec: ReportSpec; understood: string[]; ignored: string[] }
/** A first draft from a sentence like "profit per car last quarter". The person adjusts it; it never runs anything by itself. */
export function draftFromText(text: string, today: string): Draft | null {
  const t = text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!t) return null;
  const rule = DATA_RULES.find((r) => r.words.test(t));
  if (!rule) return null;
  const ds = DATASET_BY_KEY.get(rule.dataset)!;
  const has = (k: string) => ds.columns.some((c) => c.key === k);
  const understood = [`Data: ${rule.explain}`]; const ignored: string[] = [];
  const spec: ReportSpec = { dataset: rule.dataset, columns: rule.columns.filter(has).map((key) => ({ key })), sort: rule.sort ?? null, title: text.trim().slice(0, 100) };
  const when = rangeFromWords(t, today);
  if (when) { spec.range = when.range; understood.push(`Dates: ${when.said} (${when.range.from} to ${when.range.to})`); } else { spec.range = { preset: "last30" }; understood.push("Dates: last 30 days (you did not say)"); }
  for (const [re, key] of GROUPS) {
    if (re.test(t)) {
      if (has(key) && rule.dataset !== "carMoney" && rule.dataset !== "driverProfit") {
        spec.groupBy = [key]; understood.push(`Grouped by ${ds.columns.find((c) => c.key === key)!.label.toLowerCase()}`);
        spec.columns = [{ key }, ...ds.columns.filter((c) => (c.type === "num" || c.type === "money") && c.key !== "count" && rule.columns.includes(c.key)).map((c) => ({ key: c.key }))];
      } else if (!has(key)) ignored.push(`"${key}" is not a column of ${rule.explain.toLowerCase()}, so it was not used`);
      break;
    }
  }
  if (/\b(top|best|most)\b/.test(t) && spec.sort) { spec.sort = { key: spec.sort.key, dir: "desc" }; understood.push("Sorted with the biggest first"); }
  if (/\b(worst|lowest|least|losing)\b/.test(t) && spec.sort) { spec.sort = { key: spec.sort.key, dir: "asc" }; understood.push("Sorted with the smallest first"); }
  const lim = /\btop (\d{1,3})\b/.exec(t); if (lim) { spec.limit = Number(lim[1]); understood.push(`Limited to ${lim[1]} rows`); }
  return { spec, understood, ignored };
}
