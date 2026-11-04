import type { pg } from "@routenorth/db";
import { dayNumber, financeAccrual } from "@routenorth/shared";

/**
 * ONE set of money rules for the whole portal. The vehicle list, the vehicle Financials tab, the dashboard, the finance
 * pages and the reports all call these functions, so a number on the dashboard always equals the same number on the report
 * behind it (spec: "every dashboard number must be built from the same rules as the matching report").
 *
 * Revenue   = completed trips' price (portal_trips.revenue_cents)
 * Costs     = fuel (fuel_logs) + maintenance and repairs (maintenance_logs) + insurance, tires, tolls, parking, software, other
 *             (finance_expenses) + tickets (incidents.fine_cents) + loan or lease cost accrued daily from the vehicle's payment
 *             + driver pay (pay lines of completed trips, once pay rates are in use).
 * Profit    = revenue - costs.
 * Left out on purpose: the purchase price (a one-off; shown in total cost of ownership instead) and incident repair estimates
 *             (log the actual repair as maintenance, so it is not counted twice).
 */
export interface Range { from: string; to: string }
export interface Bounds { fromTs: string; toTs: string; days: number }

export function bounds(r: Range): Bounds {
  return { fromTs: `${r.from}T00:00:00`, toTs: `${shiftDay(r.to, 1)}T00:00:00`, days: dayNumber(r.to) - dayNumber(r.from) + 1 };
}
export const shiftDay = (d: string, n: number): string => new Date((dayNumber(d) + n) * 86_400_000).toISOString().slice(0, 10);

export interface VehicleMoney {
  vehicleId: string | null;
  revenueCents: number; trips: number; distanceM: number; durationS: number;
  fuelCents: number; maintenanceCents: number; insuranceCents: number; financeCents: number; tiresCents: number; ticketsCents: number; otherCents: number; driverPayCents: number;
  costCents: number; profitCents: number;
}
const zero = (id: string | null): VehicleMoney => ({ vehicleId: id, revenueCents: 0, trips: 0, distanceM: 0, durationS: 0, fuelCents: 0, maintenanceCents: 0, insuranceCents: 0, financeCents: 0, tiresCents: 0, ticketsCents: 0, otherCents: 0, driverPayCents: 0, costCents: 0, profitCents: 0 });

/** Money per vehicle in [from, to] (company time zone). `null` vehicleId key = costs not tied to any car. */
export async function vehicleMoney(c: pg.PoolClient, r: Range, tz: string, opts: { vehicleIds?: string[] } = {}): Promise<Map<string | null, VehicleMoney>> {
  const b = bounds(r);
  const ids = opts.vehicleIds ?? null;
  const out = new Map<string | null, VehicleMoney>();
  const get = (id: string | null) => { let m = out.get(id); if (!m) { m = zero(id); out.set(id, m); } return m; };
  const only = (col: string) => (ids ? `AND ${col} = ANY($4::uuid[])` : "");
  const p = (extra: unknown[] = []) => [b.fromTs, b.toTs, tz, ...(ids ? [ids] : []), ...extra];

  for (const row of (await c.query(
    `SELECT vehicle_id AS id, sum(revenue_cents)::float8 AS revenue, count(*)::int AS trips, coalesce(sum(distance_m),0)::float8 AS dist, coalesce(sum(duration_s),0)::float8 AS dur
     FROM portal_trips WHERE status = 'completed' AND archived_at IS NULL AND started_at >= ($1::timestamp AT TIME ZONE $3) AND started_at < ($2::timestamp AT TIME ZONE $3) ${only("vehicle_id")} GROUP BY 1`, p())).rows) {
    const m = get(row.id); m.revenueCents = row.revenue; m.trips = row.trips; m.distanceM = row.dist; m.durationS = row.dur;
  }
  for (const row of (await c.query(
    `SELECT vehicle_id AS id, coalesce(sum(cost_cents),0)::float8 AS v FROM fuel_logs WHERE archived_at IS NULL AND $3::text IS NOT NULL AND filled_on >= $1::date AND filled_on < $2::date ${only("vehicle_id")} GROUP BY 1`, p())).rows) get(row.id).fuelCents = row.v;
  for (const row of (await c.query(
    `SELECT vehicle_id AS id, coalesce(sum(total_cents),0)::float8 AS v FROM maintenance_logs WHERE archived_at IS NULL AND $3::text IS NOT NULL AND done_on >= $1::date AND done_on < $2::date ${only("vehicle_id")} GROUP BY 1`, p())).rows) get(row.id).maintenanceCents = row.v;
  for (const row of (await c.query(
    `SELECT vehicle_id AS id, category, coalesce(sum(amount_cents),0)::float8 AS v FROM finance_expenses WHERE archived_at IS NULL AND $3::text IS NOT NULL AND spent_on >= $1::date AND spent_on < $2::date ${only("vehicle_id")} GROUP BY 1, 2`, p())).rows) {
    const m = get(row.id);
    if (row.category === "fuel") m.fuelCents += row.v;
    else if (row.category === "maintenance") m.maintenanceCents += row.v;
    else if (row.category === "insurance") m.insuranceCents += row.v;
    else if (row.category === "tires") m.tiresCents += row.v;
    else if (row.category === "fines") m.ticketsCents += row.v;
    else if (row.category === "finance") m.financeCents += row.v;
    else m.otherCents += row.v;
  }
  for (const row of (await c.query(
    `SELECT vehicle_id AS id, coalesce(sum(fine_cents),0)::float8 AS v FROM incidents WHERE archived_at IS NULL AND fine_cents IS NOT NULL AND occurred_at >= ($1::timestamp AT TIME ZONE $3) AND occurred_at < ($2::timestamp AT TIME ZONE $3) ${only("vehicle_id")} GROUP BY 1`, p())).rows) get(row.id).ticketsCents += row.v;
  // Loan and lease cost, accrued by the day over the part of the range the car was bought and still being paid.
  for (const v of (await c.query(
    `SELECT id, finance_payment_cents::float8 AS pay, finance_interval AS iv, purchase_date::text AS start, finance_end_date::text AS fin FROM vehicles
     WHERE finance_payment_cents IS NOT NULL AND finance_interval IS NOT NULL ${ids ? "AND id = ANY($1::uuid[])" : ""}`, ids ? [ids] : [])).rows) {
    const s = Math.max(dayNumber(r.from), v.start ? dayNumber(v.start) : -Infinity), e = Math.min(dayNumber(r.to), v.fin ? dayNumber(v.fin) : Infinity);
    if (e >= s) {
      const m = get(v.id);
      // Real payments entered as expenses for this car replace the estimate.
      if (m.financeCents === 0) m.financeCents = financeAccrual(v.pay, v.iv, e - s + 1);
    }
  }
  // Driver pay, when pay rates are in use (the table arrives with the pay module).
  const hasPay = (await c.query("SELECT to_regclass('portal_pay_lines') AS t")).rows[0].t;
  if (hasPay) {
    for (const row of (await c.query(
      `SELECT t.vehicle_id AS id, coalesce(sum(l.amount_cents) FILTER (WHERE l.kind IN ('earning','addon') AND l.approval = 'approved' AND l.archived_at IS NULL),0)::float8 AS v
       FROM portal_pay_lines l JOIN portal_trips t ON t.id = l.trip_id
       WHERE t.status = 'completed' AND t.archived_at IS NULL AND t.started_at >= ($1::timestamp AT TIME ZONE $3) AND t.started_at < ($2::timestamp AT TIME ZONE $3) ${only("t.vehicle_id")} GROUP BY 1`, p())).rows) get(row.id).driverPayCents = row.v;
  }
  for (const m of out.values()) {
    m.costCents = m.fuelCents + m.maintenanceCents + m.insuranceCents + m.financeCents + m.tiresCents + m.ticketsCents + m.otherCents + m.driverPayCents;
    m.profitCents = m.revenueCents - m.costCents;
  }
  return out;
}

export function sumMoney(list: Iterable<VehicleMoney>): VehicleMoney {
  const t = zero(null);
  for (const m of list) for (const k of Object.keys(t) as (keyof VehicleMoney)[]) if (k !== "vehicleId") (t[k] as number) += m[k] as number;
  return t;
}
