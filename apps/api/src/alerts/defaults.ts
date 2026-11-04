import type { pg } from "@routenorth/db";
import { withOrg } from "@routenorth/db";
import type { RuleKind, Severity } from "./engine.js";

/**
 * The default alert rules of the Owner Portal spec. Every company gets them the first time alerts are looked at or checked.
 * The owner can change the numbers, who is told, and the severity, or switch a rule off, but cannot delete one.
 */
export interface RuleField { key: string; label: string; unit: string; min: number; max: number; step?: number; help?: string; optional?: boolean }
export interface DefaultRule {
  key: string; area: "vehicle" | "driver" | "pay" | "money"; kind: RuleKind; name: string; description: string; severity: Severity;
  params: Record<string, unknown>; fields: RuleField[]; groupMinutes?: number; repeatMinutes?: number;
  /** What the spec's table says, so the screen can show where each default comes from. */
  spec: string;
  note?: string;
}

const DAY = 1440;
export const DEFAULT_RULES: readonly DefaultRule[] = [
  // ---- cars
  { key: "veh_docs", area: "vehicle", kind: "vehicle_docs", name: "Car document expiring", severity: "info", spec: "Document expires within N days: 30, 14, 7",
    description: "A car's insurance, registration or other document is close to its end date. Starts as Info at 30 days, becomes a Warning at 14 and Critical at 7 days or once it has expired.",
    params: { days: 30 }, fields: [{ key: "days", label: "Start telling me this many days before", unit: "days", min: 1, max: 365 }], groupMinutes: DAY },
  { key: "veh_service", area: "vehicle", kind: "service_due", name: "Service due", severity: "warn", spec: "Service due within N km or days: 500 km or 14 days",
    description: "A service is close or overdue, by date, distance or engine hours, whichever comes first. Overdue is Critical.",
    params: { days: 14, km: 500 }, fields: [{ key: "days", label: "Days before it is due", unit: "days", min: 0, max: 365 }, { key: "km", label: "Kilometres before it is due", unit: "km", min: 0, max: 50000 }], groupMinutes: DAY },
  { key: "veh_inspection", area: "vehicle", kind: "inspection_failed", name: "Failed inspection", severity: "critical", spec: "Vehicle alerts: failed inspection",
    description: "A check-out or check-in inspection found a defect and nobody has signed it off. The car is blocked from new jobs until it is.", params: {}, fields: [] },
  { key: "veh_idle", area: "vehicle", kind: "vehicle_idle", name: "Car idle", severity: "info", spec: "Idle for more than N days: 3",
    description: "A car has not moved or finished a trip for more than this many days. A car with its own idle setting uses that instead.",
    params: { days: 3 }, fields: [{ key: "days", label: "Idle for more than", unit: "days", min: 1, max: 365 }], groupMinutes: DAY },
  { key: "veh_fuel", area: "vehicle", kind: "fuel_above_normal", name: "Fuel use above normal", severity: "warn", spec: "Fuel use above normal by N%: 20%",
    description: "The last fill-up used more fuel per 100 km than the car's usual. Needs fill-ups with an odometer reading, and at least four of them.",
    params: { pct: 20 }, fields: [{ key: "pct", label: "Above the car's usual by", unit: "%", min: 1, max: 300 }], groupMinutes: DAY },
  { key: "veh_repairs", area: "vehicle", kind: "repair_over_budget", name: "Repair cost over budget", severity: "warn", spec: "Repair cost this month above budget: budget set by owner",
    description: "Repairs and maintenance this month are above the maintenance budget set on the Budget page. Does nothing until a maintenance budget is set. It is one budget for the whole company, not one per car.",
    params: {}, fields: [], groupMinutes: DAY, note: "Company-wide maintenance budget; per-car repair budgets are not built." },
  // ---- drivers
  { key: "drv_docs", area: "driver", kind: "driver_docs", name: "Driver licence or permit expiring", severity: "info", spec: "Licence or permit expires within N days: 30, 14, 7",
    description: "A driver's licence or permit is close to its end date. Info at 30 days, Warning at 14, Critical at 7 days or expired.",
    params: { days: 30 }, fields: [{ key: "days", label: "Start telling me this many days before", unit: "days", min: 1, max: 365 }], groupMinutes: DAY },
  { key: "drv_safety", area: "driver", kind: "driver_safety_low", name: "Safety score low", severity: "warn", spec: "Safety score below N: 70",
    description: "A driver's safety score (from speeding, hard braking and other events) is below the line.",
    params: { below: 70 }, fields: [{ key: "below", label: "Below", unit: "points", min: 1, max: 100 }], groupMinutes: DAY },
  { key: "drv_rating", area: "driver", kind: "driver_rating_low", name: "Low rating or new complaint", severity: "warn", spec: "Rating below N: 4.2",
    description: "A driver's customer rating is below the line, or a customer made a complaint in the last few days.",
    params: { below: 4.2, complaintDays: 7 }, fields: [{ key: "below", label: "Rating below", unit: "of 5", min: 1, max: 5, step: 0.1 }, { key: "complaintDays", label: "Tell me about complaints from the last", unit: "days", min: 0, max: 90 }], groupMinutes: DAY },
  { key: "drv_overtime", area: "driver", kind: "driver_overtime", name: "Overtime reached", severity: "warn", spec: "Weekly hours above N: local overtime limit",
    description: "A driver has worked more hours this week than the limit. Leave the box empty to use the overtime limit from Driver settings (44 hours in Ontario).",
    params: { hours: null }, fields: [{ key: "hours", label: "Hours in a week", unit: "hours", min: 1, max: 168, optional: true, help: "Empty means the local overtime limit." }], groupMinutes: DAY },
  { key: "drv_inactive", area: "driver", kind: "driver_inactive", name: "Driver has had no trips", severity: "info", spec: "No trips for N days: 14",
    description: "An active driver has had no trips or shifts for this many days.",
    params: { days: 14 }, fields: [{ key: "days", label: "No trips or shifts for", unit: "days", min: 1, max: 365 }], groupMinutes: DAY },
  { key: "drv_cancel", area: "driver", kind: "driver_cancellations", name: "High cancellation rate", severity: "warn", spec: "Driver alerts: very high cancellation rate",
    description: "A driver cancelled or missed more than this share of their trips in the last 30 days (needs at least 5 trips).",
    params: { pct: 20, minTrips: 5 }, fields: [{ key: "pct", label: "More than", unit: "% of trips", min: 1, max: 100 }, { key: "minTrips", label: "Only for drivers with at least", unit: "trips", min: 1, max: 1000 }], groupMinutes: DAY },
  { key: "drv_onboarding", area: "driver", kind: "driver_stuck_onboarding", name: "New driver stuck in onboarding", severity: "info", spec: "Driver alerts: new driver stuck in onboarding",
    description: "A new driver has been in onboarding for more than this many days.",
    params: { days: 5 }, fields: [{ key: "days", label: "More than", unit: "days", min: 1, max: 365 }], groupMinutes: DAY },
  // ---- pay
  { key: "pay_approval", area: "pay", kind: "payout_waiting", name: "Payout waiting for approval", severity: "warn", spec: "Payout waiting for approval: day before pay date",
    description: "A payout run is drafted and nobody has approved it. Pay day is the day after the run's last day. The alert starts the day before and turns Critical when pay day has passed.",
    params: { daysBefore: 1 }, fields: [{ key: "daysBefore", label: "Start this many days before pay day", unit: "days", min: 0, max: 14 }], groupMinutes: DAY, repeatMinutes: 240 },
  { key: "pay_odd", area: "pay", kind: "trip_pay_off", name: "Trip pay far from the usual", severity: "warn", spec: "Trip pay far from the usual for that route: over 40% off",
    description: "A recent trip paid the driver much more or less than the usual for the same route (or zone, or customer when there is no route). Needs at least 5 trips on that route in the last 90 days. The trip is also flagged for review.",
    params: { pct: 40, minTrips: 5 }, fields: [{ key: "pct", label: "Off by more than", unit: "%", min: 1, max: 1000 }, { key: "minTrips", label: "Needs at least", unit: "similar trips", min: 2, max: 1000 }], groupMinutes: DAY },
  { key: "pay_dispute", area: "pay", kind: "dispute_open", name: "Pay question waiting too long", severity: "warn", spec: "Dispute open for more than N days: 3",
    description: "A driver asked about their pay and has had no reply for more than this many days.",
    params: { days: 3 }, fields: [{ key: "days", label: "Open for more than", unit: "days", min: 1, max: 60 }], groupMinutes: DAY },
  // ---- money
  { key: "money_loss", area: "money", kind: "losing_money", name: "Car or trip losing money", severity: "warn", spec: "Trip or car losing money: margin below 0",
    description: "A car's profit this month is below zero, or a recent trip paid the driver more than the customer was charged.",
    params: { tripDays: 7 }, fields: [{ key: "tripDays", label: "Look at trips from the last", unit: "days", min: 1, max: 90 }], groupMinutes: DAY },
  { key: "money_invoice", area: "money", kind: "invoice_overdue", name: "Invoice overdue", severity: "warn", spec: "Invoice overdue: 1 day late",
    description: "A sent invoice is past its due date. Critical when it is 30 days late.",
    params: { daysLate: 1 }, fields: [{ key: "daysLate", label: "Late by at least", unit: "days", min: 0, max: 365 }], groupMinutes: DAY },
  { key: "money_budget", area: "money", kind: "portal_budget", name: "Expense category near its budget", severity: "warn", spec: "Expense category over budget: 90% used",
    description: "A cost category has used this share of this month's budget (set on the Budget page). Critical once it is over.",
    params: { pct: 90 }, fields: [{ key: "pct", label: "Used", unit: "% of budget", min: 1, max: 500 }], groupMinutes: DAY },
];
export const DEFAULT_BY_KEY = new Map(DEFAULT_RULES.map((d) => [d.key, d]));

/** Make sure every default rule exists for this company (new rules appear later too; changed ones are never overwritten). */
export async function ensureDefaultRules(pool: pg.Pool, orgId: string): Promise<number> {
  return withOrg(pool, orgId, async (c) => {
    if ((await c.query("SELECT count(*)::int AS n FROM alert_rules WHERE system_key IS NOT NULL")).rows[0].n >= DEFAULT_RULES.length) return 0;
    let made = 0;
    for (const d of DEFAULT_RULES) {
      const r = await c.query(
        `INSERT INTO alert_rules (org_id, name, kind, params, severity, area, system_key, description, group_minutes, repeat_minutes)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (org_id, system_key) WHERE system_key IS NOT NULL DO NOTHING`,
        [orgId, d.name, d.kind, JSON.stringify(d.params), d.severity, d.area, d.key, d.description.slice(0, 500), d.groupMinutes ?? 30, d.repeatMinutes ?? 30]);
      made += r.rowCount ?? 0;
    }
    return made;
  });
}
