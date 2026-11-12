import type { pg } from "@routenorth/db";
import { hoursReport } from "@routenorth/shared";
import { loadDrivers, loadSettings } from "../portal/drivers.service.js";
import { sumMoney, shiftDay, vehicleMoney } from "../portal/money-rules.js";
import { loadVehicles } from "../portal/vehicles.service.js";

/**
 * The numbers an owner can build a rule on: "when [measure] [is above/below] [value] for [a car, a driver, or the company]".
 * Money measures are in dollars here (what the owner types); everything else is in the unit named.
 */
export type MeasureUnit = "money" | "pct" | "num" | "days" | "hours" | "km" | "rating" | "score";
export interface Measure { key: string; label: string; subject: "vehicle" | "driver" | "company"; unit: MeasureUnit; help: string }

export const MEASURES: readonly Measure[] = [
  // a car
  { key: "idleDays", label: "Days without a trip or movement", subject: "vehicle", unit: "days", help: "Whole days since the car last moved or finished a trip." },
  { key: "monthRevenue", label: "Revenue this month", subject: "vehicle", unit: "money", help: "From the start of the month to today." },
  { key: "monthCost", label: "Costs this month", subject: "vehicle", unit: "money", help: "Fuel, repairs, insurance, loan or lease, tires, tickets and driver pay." },
  { key: "monthProfit", label: "Profit this month", subject: "vehicle", unit: "money", help: "Revenue minus all costs, as on the car's money tab." },
  { key: "monthMargin", label: "Margin this month", subject: "vehicle", unit: "pct", help: "Profit as a share of revenue." },
  { key: "serviceDaysLeft", label: "Days until the next service", subject: "vehicle", unit: "days", help: "Negative when the service is overdue." },
  { key: "serviceKmLeft", label: "Kilometres until the next service", subject: "vehicle", unit: "km", help: "Negative when the service is overdue." },
  { key: "docDaysLeft", label: "Days until the first document expires", subject: "vehicle", unit: "days", help: "Negative when a document has already expired." },
  { key: "odometerKm", label: "Odometer", subject: "vehicle", unit: "km", help: "The odometer reading kept on the car." },
  // a driver
  { key: "score", label: "Driver score", subject: "driver", unit: "score", help: "The 0 to 100 score on the driver's page." },
  { key: "safety", label: "Safety score", subject: "driver", unit: "score", help: "The 0 to 100 safety score." },
  { key: "rating", label: "Customer rating", subject: "driver", unit: "rating", help: "Average of the last 30 days, out of 5." },
  { key: "onTimePct", label: "On-time rate", subject: "driver", unit: "pct", help: "Share of trips on time in the last 30 days." },
  { key: "weeklyHours", label: "Hours worked this week", subject: "driver", unit: "hours", help: "From shifts in the driver app, minus breaks." },
  { key: "daysSinceTrip", label: "Days since the last trip", subject: "driver", unit: "days", help: "Whole days since a trip or a shift." },
  { key: "monthTrips", label: "Trips this month", subject: "driver", unit: "num", help: "Completed trips so far this month." },
  { key: "monthEarnings", label: "Pay earned this month", subject: "driver", unit: "money", help: "Trip pay so far this month." },
  // the company
  { key: "companyRevenue", label: "Revenue this month", subject: "company", unit: "money", help: "All cars, month to date." },
  { key: "companyCost", label: "Costs this month", subject: "company", unit: "money", help: "All cars and company costs, month to date." },
  { key: "companyProfit", label: "Profit this month", subject: "company", unit: "money", help: "Same as the dashboard." },
  { key: "companyMargin", label: "Margin this month", subject: "company", unit: "pct", help: "Profit as a share of revenue." },
  { key: "overdueInvoices", label: "Overdue invoices", subject: "company", unit: "num", help: "Sent invoices past their due date." },
  { key: "overdueInvoicesAmount", label: "Money owed on overdue invoices", subject: "company", unit: "money", help: "Total of the overdue invoices." },
  { key: "openDisputes", label: "Open pay questions", subject: "company", unit: "num", help: "Driver questions about their pay with no reply yet." },
  { key: "unpaidPayouts", label: "Driver pay waiting to be paid", subject: "company", unit: "money", help: "Payouts that are drafted or approved but not paid." },
  { key: "activeCars", label: "Active cars", subject: "company", unit: "num", help: "Cars that are not archived or sold." },
  { key: "activeDrivers", label: "Active drivers", subject: "company", unit: "num", help: "Drivers who are not archived or suspended." },
];
export const MEASURE_BY_KEY = new Map(MEASURES.map((m) => [m.key, m]));
export const UNIT_LABEL: Record<MeasureUnit, string> = { money: "$", pct: "%", num: "", days: "days", hours: "hours", km: "km", rating: "of 5", score: "points" };

export interface Reading { id: string | null; name: string; value: number | null }
export interface MeasureEnv { today: string; tz: string; now: Date }

const round2 = (n: number) => Math.round(n * 100) / 100;
const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / 86_400_000);

/** Read one measure for every subject it applies to (every car, every driver, or the company as one). `onlyId` limits it to one car or driver. */
export async function readMeasure(c: pg.PoolClient, key: string, env: MeasureEnv, onlyId?: string | null): Promise<Reading[]> {
  const m = MEASURE_BY_KEY.get(key);
  if (!m) return [];
  const monthStart = `${env.today.slice(0, 8)}01`;
  if (m.subject === "company") return [{ id: null, name: "The company", value: await companyValue(c, key, env, monthStart) }];
  if (m.subject === "vehicle") {
    const cars = (await loadVehicles(c, env)).filter((v) => !["sold", "archived"].includes(v.status) && (!onlyId || v.id === onlyId));
    let money: Awaited<ReturnType<typeof vehicleMoney>> | null = null;
    if (key.startsWith("month")) money = await vehicleMoney(c, { from: monthStart, to: env.today }, env.tz);
    return cars.map((v): Reading => {
      const mm = money?.get(v.id);
      let value: number | null = null;
      switch (key) {
        case "idleDays": value = v.lastActivity ? daysBetween(new Date(v.lastActivity), env.now) : null; break;
        case "monthRevenue": value = round2((mm?.revenueCents ?? 0) / 100); break;
        case "monthCost": value = round2((mm?.costCents ?? 0) / 100); break;
        case "monthProfit": value = round2((mm?.profitCents ?? 0) / 100); break;
        case "monthMargin": value = mm && mm.revenueCents > 0 ? round2((mm.profitCents / mm.revenueCents) * 100) : null; break;
        case "serviceDaysLeft": value = v.service.daysLeft; break;
        case "serviceKmLeft": value = v.service.kmLeft; break;
        case "docDaysLeft": value = v.docs.nextExpiry ? Math.round((Date.parse(`${v.docs.nextExpiry}T00:00:00Z`) - Date.parse(`${env.today}T00:00:00Z`)) / 86_400_000) : null; break;
        case "odometerKm": value = v.odometerKm; break;
      }
      return { id: v.id, name: v.name, value };
    });
  }
  const drivers = (await loadDrivers(c, env, { applicants: false })).filter((d) => !["suspended"].includes(d.status) && !d.archivedAt && (!onlyId || d.id === onlyId));
  const settings = await loadSettings(c);
  let hours = new Map<string, number>(), last = new Map<string, Date>();
  if (key === "weeklyHours") {
    const rows = (await c.query(
      `SELECT s.driver_id, s.started_at AS "startedAt", s.ended_at AS "endedAt", coalesce((SELECT sum(extract(epoch FROM (coalesce(b.ended_at, now()) - b.started_at)) / 60) FROM shift_breaks b WHERE b.shift_id = s.id), 0)::float8 AS "breakMinutes"
       FROM shifts s WHERE s.started_at >= now() - interval '10 days' ORDER BY s.started_at`)).rows;
    const by = new Map<string, typeof rows>();
    for (const r of rows) (by.get(r.driver_id) ?? by.set(r.driver_id, []).get(r.driver_id)!).push(r);
    const thisWeek = weekStart(env.today);
    for (const [id, list] of by) hours.set(id, hoursReport(list, settings.hours, env.now, env.tz).weeks.find((w) => w.weekStart === thisWeek)?.hours ?? 0);
  }
  if (key === "daysSinceTrip") {
    for (const r of (await c.query(`SELECT driver_id, max(started_at) AS t FROM portal_trips WHERE archived_at IS NULL AND driver_id IS NOT NULL GROUP BY 1`)).rows) last.set(r.driver_id, r.t);
    for (const r of (await c.query(`SELECT driver_id, max(started_at) AS t FROM shifts GROUP BY 1`)).rows) if (!last.has(r.driver_id) || last.get(r.driver_id)! < r.t) last.set(r.driver_id, r.t);
  }
  return drivers.map((d): Reading => {
    let value: number | null = null;
    switch (key) {
      case "score": value = d.score; break;
      case "safety": value = d.safety; break;
      case "rating": value = d.rating; break;
      case "onTimePct": value = d.onTimePct; break;
      case "weeklyHours": value = hours.get(d.id) ?? 0; break;
      case "daysSinceTrip": { const t = last.get(d.id); value = t ? daysBetween(new Date(t), env.now) : daysBetween(new Date(d.createdAt), env.now); break; }
      case "monthTrips": value = d.tripsMonth; break;
      case "monthEarnings": value = d.earningsMonthCents == null ? null : round2(d.earningsMonthCents / 100); break;
    }
    return { id: d.id, name: d.name, value };
  });
}

export const weekStart = (day: string): string => { const d = new Date(`${day}T12:00:00Z`); const dow = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - dow); return d.toISOString().slice(0, 10); };

async function companyValue(c: pg.PoolClient, key: string, env: MeasureEnv, monthStart: string): Promise<number | null> {
  if (key === "companyRevenue" || key === "companyCost" || key === "companyProfit" || key === "companyMargin") {
    const t = sumMoney((await vehicleMoney(c, { from: monthStart, to: env.today }, env.tz)).values());
    if (key === "companyRevenue") return round2(t.revenueCents / 100);
    if (key === "companyCost") return round2(t.costCents / 100);
    if (key === "companyProfit") return round2(t.profitCents / 100);
    return t.revenueCents > 0 ? round2((t.profitCents / t.revenueCents) * 100) : null;
  }
  switch (key) {
    case "overdueInvoices": return (await c.query(`SELECT count(*)::int AS n FROM invoices WHERE status = 'sent' AND due_on < $1::date`, [env.today])).rows[0].n;
    case "overdueInvoicesAmount": return round2(Number((await c.query(`SELECT coalesce(sum(total),0)::float8 AS n FROM invoices WHERE status = 'sent' AND due_on < $1::date`, [env.today])).rows[0].n));
    case "openDisputes": return (await c.query(`SELECT count(*)::int AS n FROM portal_disputes WHERE status = 'open'`)).rows[0].n;
    case "unpaidPayouts": return round2(Number((await c.query(`SELECT coalesce(sum(net_cents),0)::float8 AS n FROM portal_payouts WHERE status IN ('draft','approved','sent')`)).rows[0].n) / 100);
    case "activeCars": return (await c.query(`SELECT count(*)::int AS n FROM vehicles WHERE archived_at IS NULL AND status NOT IN ('sold','retired')`)).rows[0].n;
    case "activeDrivers": return (await c.query(`SELECT count(*)::int AS n FROM driver_profiles WHERE archived_at IS NULL AND status IN ('active','onboarding','off_duty')`)).rows[0].n;
  }
  return null;
}

export { shiftDay };
