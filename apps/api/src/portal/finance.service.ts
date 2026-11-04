import type { pg } from "@routenorth/db";
import { dayNumber } from "@routenorth/shared";
import { shiftDay, sumMoney, vehicleMoney, type Range, type VehicleMoney } from "./money-rules.js";

/** The vehicles a person is limited to by region, or null for everything. Money for a region leaves out costs not tied to a car. */
export async function scopedVehicleIds(c: pg.PoolClient, teamIds: string[] | null): Promise<string[] | undefined> {
  if (!teamIds) return undefined;
  return (await c.query(`SELECT id FROM vehicles WHERE team_id = ANY($1::uuid[])`, [teamIds])).rows.map((r) => r.id as string);
}

/** Company totals for a range: the same rules as the vehicle pages, added up. */
export async function companyMoney(c: pg.PoolClient, r: Range, tz: string, vehicleIds?: string[]): Promise<VehicleMoney> {
  if (vehicleIds && !vehicleIds.length) return sumMoney([]);
  return sumMoney((await vehicleMoney(c, r, tz, { vehicleIds })).values());
}

export const previousRange = (r: Range): Range => {
  const days = dayNumber(r.to) - dayNumber(r.from) + 1;
  return { from: shiftDay(r.from, -days), to: shiftDay(r.from, -1) };
};

export interface Point { from: string; to: string; revenueCents: number; costCents: number; profitCents: number; trips: number }
/** Revenue, cost and profit by day (or by week for long ranges). Each point is a real money calculation, so the points add up to the total. */
export async function moneySeries(c: pg.PoolClient, r: Range, tz: string, vehicleIds?: string[]): Promise<Point[]> {
  const days = dayNumber(r.to) - dayNumber(r.from) + 1;
  const step = days <= 92 ? 1 : days <= 400 ? 7 : 30;
  const out: Point[] = [];
  for (let d = 0; d < days; d += step) {
    const from = shiftDay(r.from, d), to = shiftDay(r.from, Math.min(days - 1, d + step - 1));
    const m = await companyMoney(c, { from, to }, tz, vehicleIds);
    out.push({ from, to, revenueCents: m.revenueCents, costCents: m.costCents, profitCents: m.profitCents, trips: m.trips });
  }
  return out;
}

export interface Bill { date: string; label: string; amountCents: number | null; href: string }
/** Money going out soon that we know about: loan and lease payments by their interval, and insurance renewals (amount not known). */
export async function upcomingBills(c: pg.PoolClient, today: string, days: number): Promise<Bill[]> {
  const out: Bill[] = [];
  const end = shiftDay(today, days);
  for (const v of (await c.query(
    `SELECT id, name, finance_payment_cents::float8 AS pay, finance_interval AS iv, purchase_date::text AS start, finance_end_date::text AS fin, insurance_expiry::text AS ins
     FROM vehicles WHERE archived_at IS NULL AND status <> 'sold'`)).rows) {
    if (v.pay && v.iv) {
      const stepDays = v.iv === "weekly" ? 7 : v.iv === "biweekly" ? 14 : 0;
      const anchor = v.start ?? today;
      if (stepDays) {
        let n = dayNumber(anchor); const t = dayNumber(today);
        if (n < t) n += Math.ceil((t - n) / stepDays) * stepDays;
        for (; n <= dayNumber(end); n += stepDays) { const d = shiftDay("1970-01-01", n); if (!v.fin || d <= v.fin) out.push({ date: d, label: `${v.name}: loan or lease payment`, amountCents: v.pay, href: `/owner/vehicles/${v.id}` }); }
      } else {
        // monthly: on the day of the month the car was bought, clamped to the month's length
        const dom = Number(anchor.slice(8, 10));
        for (let k = 0; k <= Math.ceil(days / 28) + 1; k++) {
          const base = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1 + k, 1));
          const last = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0)).getUTCDate();
          const d = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), Math.min(dom, last))).toISOString().slice(0, 10);
          if (d >= today && d <= end && (!v.fin || d <= v.fin)) out.push({ date: d, label: `${v.name}: loan or lease payment`, amountCents: v.pay, href: `/owner/vehicles/${v.id}` });
        }
      }
    }
    if (v.ins && v.ins >= today && v.ins <= end) out.push({ date: v.ins, label: `${v.name}: insurance renewal`, amountCents: null, href: `/owner/vehicles/${v.id}` });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export const EXPENSE_CATEGORIES = ["fuel", "maintenance", "insurance", "finance", "tolls", "parking", "fines", "tires", "software", "payroll", "other"] as const;
export const BUDGET_CATEGORIES = ["driver_pay", "fuel", "maintenance", "insurance", "finance", "tires", "fines", "other", "total"] as const;
/** Pick a cost type's amount out of the money totals, so the budget screen and the dashboard use the same numbers. */
export function actualFor(m: VehicleMoney, cat: (typeof BUDGET_CATEGORIES)[number]): number {
  switch (cat) {
    case "driver_pay": return m.driverPayCents; case "fuel": return m.fuelCents; case "maintenance": return m.maintenanceCents; case "insurance": return m.insuranceCents;
    case "finance": return m.financeCents; case "tires": return m.tiresCents; case "fines": return m.ticketsCents; case "other": return m.otherCents; case "total": return m.costCents;
  }
}

/** Budget rows for one month (YYYY-MM): the same numbers the budget page and the budget report show. */
export async function budgetRows(c: pg.PoolClient, tz: string, today: string, m: string) {
  const from = `${m}-01`; const to = new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5)), 0)).toISOString().slice(0, 10);
  const actual = await companyMoney(c, { from, to: to > today ? today : to }, tz);
  const set = (await c.query(`SELECT category, month::text AS month, amount_cents::float8 AS cents FROM portal_budgets WHERE month IS NULL OR month = $1::date`, [from])).rows;
  return BUDGET_CATEGORIES.map((cat) => {
    const own = set.find((x) => x.category === cat && x.month === from), dflt = set.find((x) => x.category === cat && x.month == null);
    const budgetCents = (own ?? dflt)?.cents ?? null; const spent = actualFor(actual, cat);
    const used = budgetCents ? Math.round((spent / budgetCents) * 1000) / 10 : null;
    return { category: cat, budgetCents, appliesTo: own ? "this month" : dflt ? "every month" : null, actualCents: spent, usedPct: used, state: used == null ? "none" : used >= 100 ? "over" : used >= 80 ? "warning" : "ok" } as const;
  });
}

/** Tax collected on invoices and tax paid on expenses, by month. */
export async function taxMonths(c: pg.PoolClient, r: Range) {
  const collected = (await c.query(`SELECT to_char(issued_on, 'YYYY-MM') AS month, round(sum(tax) * 100)::float8 AS cents, round(sum(subtotal) * 100)::float8 AS sales FROM invoices WHERE status IN ('sent','paid') AND issued_on BETWEEN $1::date AND $2::date GROUP BY 1`, [r.from, r.to])).rows;
  const paid = (await c.query(`SELECT to_char(spent_on, 'YYYY-MM') AS month, sum(tax_cents)::float8 AS cents, sum(amount_cents)::float8 AS spend FROM finance_expenses WHERE archived_at IS NULL AND spent_on BETWEEN $1::date AND $2::date GROUP BY 1`, [r.from, r.to])).rows;
  return [...new Set([...collected.map((x) => x.month as string), ...paid.map((x) => x.month as string)])].sort().map((m) => {
    const a = collected.find((x) => x.month === m), p = paid.find((x) => x.month === m);
    return { month: m, salesCents: (a?.sales ?? 0) as number, taxCollectedCents: (a?.cents ?? 0) as number, spendCents: (p?.spend ?? 0) as number, taxPaidCents: (p?.cents ?? 0) as number, netOwedCents: ((a?.cents ?? 0) - (p?.cents ?? 0)) as number };
  });
}

/** The pieces the cash flow page and the cash flow report are both made from. */
export async function cashPieces(c: pg.PoolClient, tz: string, today: string, days = 90) {
  const invoices = (await c.query(`SELECT number, customer_name AS customer, due_on::text AS due, round(total * 100)::float8 AS cents FROM invoices WHERE status = 'sent'`)).rows as { number: string; customer: string; due: string | null; cents: number }[];
  const bills = await upcomingBills(c, today, days);
  const owed = Number((await c.query(`SELECT coalesce(sum(amount_cents),0)::float8 AS n FROM portal_pay_lines WHERE payout_id IS NULL AND archived_at IS NULL AND approval = 'approved'`)).rows[0].n)
    + Number((await c.query(`SELECT coalesce(sum(net_cents),0)::float8 AS n FROM portal_payouts WHERE status IN ('draft','approved','sent','failed','disputed')`)).rows[0].n);
  const past = await companyMoney(c, { from: shiftDay(today, -89), to: today }, tz);
  const usualDaily = Math.round((past.fuelCents + past.maintenanceCents + past.tiresCents + past.ticketsCents + past.otherCents) / 90);
  return { invoices, bills, owed, usualDaily };
}
