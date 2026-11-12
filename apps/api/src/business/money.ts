import type { pg } from "@routenorth/db";
import { budgetStatus, periodRange, taxFor, type BudgetState } from "@routenorth/shared";
import { withDefaults } from "../org/settings.js";

/** Sales tax for an organization: by province, or one flat rate when the company chose that. */
export function orgTax(settings: unknown, subtotal: number, exempt = false) {
  const s = withDefaults(settings);
  if (exempt) return { lines: [] as ReturnType<typeof taxFor>["lines"], total: 0 };
  return taxFor(s.billing.province, subtotal, { mode: s.billing.taxMode, customRatePct: s.taxRatePct });
}

export interface BudgetRow {
  id: string; name: string; category: string; period: string; amount: number; vehicleId: string | null; vehicleName: string | null; active: boolean;
  from: string; to: string; spent: number; pct: number; projected: number; state: BudgetState;
}

/** Every budget with what has been spent so far in its current period. */
export async function budgetRows(c: pg.PoolClient, alertPct: number, now = new Date(), onlyActive = false): Promise<BudgetRow[]> {
  const budgets = (await c.query(
    `SELECT b.id, b.name, b.category, b.period, b.amount::float AS amount, b.vehicle_id AS "vehicleId", v.name AS "vehicleName", b.active
     FROM budgets b LEFT JOIN vehicles v ON v.id = b.vehicle_id AND v.org_id = b.org_id WHERE ($1::boolean IS NOT TRUE OR b.active) ORDER BY b.name`, [onlyActive])).rows;
  const out: BudgetRow[] = [];
  for (const b of budgets) {
    const r = periodRange(b.period, now);
    const args = [r.from, r.to, b.vehicleId];
    const one = async (sql: string) => Number((await c.query(sql, args)).rows[0].n);
    const fuel = () => one("SELECT coalesce(sum(cost),0) AS n FROM fuel_logs WHERE filled_on >= $1::date AND filled_on < $2::date AND ($3::uuid IS NULL OR vehicle_id = $3)");
    const maint = () => one("SELECT coalesce(sum(cost),0) AS n FROM maintenance_logs WHERE done_on >= $1::date AND done_on < $2::date AND ($3::uuid IS NULL OR vehicle_id = $3)");
    // Fuel bought on an expense is already a fuel log, so it is not counted twice.
    const exp = () => one("SELECT coalesce(sum(amount),0) AS n FROM expenses WHERE status IN ('approved','reimbursed') AND fuel_log_id IS NULL AND spent_on >= $1::date AND spent_on < $2::date AND ($3::uuid IS NULL OR vehicle_id = $3)");
    const spent = b.category === "fuel" ? await fuel() : b.category === "maintenance" ? await maint() : b.category === "expenses" ? await exp() : (await fuel()) + (await maint()) + (await exp());
    const st = budgetStatus(spent, b.amount, alertPct, r.elapsedFrac);
    out.push({ ...b, from: r.from, to: r.to, spent: Math.round(spent * 100) / 100, ...st });
  }
  return out;
}
