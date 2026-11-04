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
