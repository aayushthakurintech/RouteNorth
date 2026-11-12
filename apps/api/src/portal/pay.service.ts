import { BadRequestException, ConflictException } from "@nestjs/common";
import type { pg } from "@routenorth/db";
import { evaluateBonus, longestStreak, priceTrip, resolveCard, type Assignment, type BonusRule, type DriverPeriodStats, type Line, type RateSpec, type TripFacts } from "@routenorth/shared";

export interface VersionRow { id: string; cardId: string; cardName: string; kind: "customer" | "driver"; version: number; spec: RateSpec; startsOn: string; endsOn: string | null; status: string }

/** The version of a card that is in force on a day: approved, started, and not ended. */
export async function versionOnDay(c: pg.PoolClient, cardId: string, day: string): Promise<VersionRow | null> {
  const r = (await c.query(
    `SELECT v.id, v.card_id, k.name, k.kind, v.version, v.spec, v.starts_on::text AS starts_on, v.ends_on::text AS ends_on, v.status
     FROM portal_rate_versions v JOIN portal_rate_cards k ON k.id = v.card_id
     WHERE v.card_id = $1 AND v.status = 'active' AND v.starts_on <= $2::date AND (v.ends_on IS NULL OR v.ends_on >= $2::date) AND k.archived_at IS NULL
     ORDER BY v.starts_on DESC, v.version DESC LIMIT 1`, [cardId, day])).rows[0];
  return r ? { id: r.id, cardId: r.card_id, cardName: r.name, kind: r.kind, version: r.version, spec: r.spec, startsOn: r.starts_on, endsOn: r.ends_on, status: r.status } : null;
}

export async function assignmentsFor(c: pg.PoolClient, kind: "customer" | "driver"): Promise<Assignment[]> {
  return (await c.query(
    `SELECT a.id, a.card_id AS "cardId", k.name AS "cardName", a.kind, a.target, a.starts_on::text AS "startsOn", a.ends_on::text AS "endsOn"
     FROM rate_card_assignments a JOIN portal_rate_cards k ON k.id = a.card_id WHERE k.kind = $1 AND a.archived_at IS NULL AND k.archived_at IS NULL`, [kind])).rows;
}

export interface Resolved { version: VersionRow | null; considered: ReturnType<typeof resolveCard>["considered"]; assignment: Assignment | null }
/** Which card prices this trip: the most specific assignment that applies on the day, then its version in force that day. */
export async function resolveForTrip(c: pg.PoolClient, kind: "customer" | "driver", ctx: { driverId?: string | null; customer?: string | null; zone?: string | null; vehicleKind?: string | null; day: string }): Promise<Resolved> {
  const groups = ctx.driverId ? (await c.query(`SELECT team_id FROM driver_profiles WHERE user_id = $1 AND team_id IS NOT NULL`, [ctx.driverId])).rows.map((r) => r.team_id as string) : [];
  const all = await assignmentsFor(c, kind);
  // Skip assignments whose card has no version in force that day, so the next best one can win.
  const live: Assignment[] = [];
  for (const a of all) if (await versionOnDay(c, a.cardId, ctx.day)) live.push(a);
  const r = resolveCard(live, { ...ctx, groupIds: groups });
  return { version: r.winner ? await versionOnDay(c, r.winner.cardId, ctx.day) : null, considered: resolveCard(all, { ...ctx, groupIds: groups }).considered, assignment: r.winner };
}

export interface TripRow { id: string; driver_id: string | null; vehicle_id: string | null; customer_name: string | null; started_at: Date; distance_m: number; duration_s: number; waiting_s: number; stops: number; weight_kg: number; zone: string | null; status: string; revenue_cents: number; tip_cents: number; toll_cents: number; conditions: TripFacts["conditions"] }

export const factsOf = (t: TripRow, vehicleKind: string | null, customerPriceCents?: number): TripFacts => ({
  distanceKm: t.distance_m / 1000, durationMin: t.duration_s / 60, waitingMin: t.waiting_s / 60, stops: t.stops, weightKg: t.weight_kg, zone: t.zone, status: t.status as TripFacts["status"],
  tipCents: t.tip_cents, tollCents: t.toll_cents, vehicleKind, customerPriceCents, conditions: t.conditions ?? {}, hours: t.duration_s / 3600,
});

/** Running cost per km for a car over its life (fuel, service and the rest), in cents; used for the "car cost" in simulators and margins. */
export async function costPerKmCents(c: pg.PoolClient, vehicleId: string | null): Promise<number> {
  if (!vehicleId) return 0;
  const r = (await c.query(
    `SELECT (coalesce((SELECT sum(cost_cents) FROM fuel_logs WHERE vehicle_id = $1 AND archived_at IS NULL),0) + coalesce((SELECT sum(total_cents) FROM maintenance_logs WHERE vehicle_id = $1 AND archived_at IS NULL),0))::float8 AS cost,
            coalesce((SELECT sum(distance_m) FROM portal_trips WHERE vehicle_id = $1 AND archived_at IS NULL AND status = 'completed'),0)::float8 / 1000 AS km`, [vehicleId])).rows[0];
  return r.km > 0 ? Math.round(r.cost / r.km) : 0;
}

export async function companyTz(c: pg.PoolClient): Promise<string> {
  return ((await c.query<{ timezone: string }>("SELECT timezone FROM organizations LIMIT 1")).rows[0]?.timezone) ?? "America/Toronto";
}

/**
 * Price one trip for the customer and the driver, store the lines, and remember which card versions were used.
 * Trips already included in a payout are locked: their lines never change (old money never moves).
 */
export async function calcTripPay(c: pg.PoolClient, orgId: string, tripId: string, actor: string | null): Promise<{ customer: Line[]; driver: Line[]; notes: string[]; driverTotalCents: number; customerTotalCents: number; revenueCents: number }> {
  const t = (await c.query(
    `SELECT id, driver_id, vehicle_id, customer_name, started_at, distance_m, duration_s, waiting_s, stops, weight_kg, zone, status, revenue_cents::float8 AS revenue_cents, tip_cents::float8 AS tip_cents, toll_cents::float8 AS toll_cents, conditions, revenue_manual,
            (started_at AT TIME ZONE (SELECT timezone FROM organizations LIMIT 1))::date::text AS day FROM portal_trips WHERE id = $1 FOR UPDATE`, [tripId])).rows[0] as (TripRow & { day: string; revenue_manual: boolean }) | undefined;
  if (!t) throw new BadRequestException("trip not found");
  if ((await c.query(`SELECT 1 FROM portal_pay_lines WHERE trip_id = $1 AND payout_id IS NOT NULL AND archived_at IS NULL LIMIT 1`, [tripId])).rowCount) throw new ConflictException({ message: "This trip is already in a payout, so its pay can no longer change. Add an adjustment instead.", code: "trip_locked" });
  const vk = t.vehicle_id ? (await c.query(`SELECT kind FROM vehicles WHERE id = $1`, [t.vehicle_id])).rows[0]?.kind ?? null : null;
  const notes: string[] = [];

  // 1. what the customer pays
  const cust = await resolveForTrip(c, "customer", { driverId: t.driver_id, customer: t.customer_name, zone: t.zone, vehicleKind: vk, day: t.day });
  let customerLines: Line[] = []; let revenue = t.revenue_cents;
  if (cust.version) {
    const p = priceTrip(cust.version.spec, factsOf({ ...t, tip_cents: 0, toll_cents: 0 }, vk));
    customerLines = p.lines; notes.push(...p.notes);
    // A price typed in by hand wins over the card; otherwise the card's subtotal (before tax) is the revenue.
    if (!t.revenue_manual) revenue = p.subtotalCents;
  } else if (!(revenue > 0)) notes.push("No customer rate card applies, so no price was worked out.");

  // 2. what the driver earns
  let driverLines: Line[] = []; let driverVersion: string | null = null;
  if (t.driver_id) {
    const drv = await resolveForTrip(c, "driver", { driverId: t.driver_id, customer: t.customer_name, zone: t.zone, vehicleKind: vk, day: t.day });
    if (drv.version) {
      driverVersion = drv.version.id;
      const p = priceTrip(drv.version.spec, factsOf(t, vk, revenue));
      driverLines = p.lines.filter((l) => l.kind !== "tax"); notes.push(...p.notes);
    } else notes.push("No driver rate card applies, so no pay was worked out.");
  } else notes.push("No driver on this trip.");

  await c.query(`DELETE FROM portal_pay_lines WHERE trip_id = $1 AND source = 'rate' AND payout_id IS NULL`, [tripId]);
  for (const l of driverLines) {
    await c.query(`INSERT INTO portal_pay_lines (org_id, driver_id, trip_id, kind, key, label, amount_cents, rate_version_id, line_date, source, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'rate',$10)`,
      [orgId, t.driver_id, tripId, l.kind === "tax" ? "addon" : l.kind, l.key, l.label.slice(0, 300), l.cents, driverVersion, t.day, actor]);
  }
  const vcost = Math.round(((t.distance_m / 1000) * (await costPerKmCents(c, t.vehicle_id))));
  await c.query(`UPDATE portal_trips SET revenue_cents = $2, driver_rate_version_id = $3, customer_rate_version_id = $4, customer_lines = $5, vehicle_cost_cents = $6, pay_calculated_at = now(), updated_at = now() WHERE id = $1`,
    [tripId, revenue, driverVersion, cust.version?.id ?? null, JSON.stringify(customerLines), vcost]);
  return { customer: customerLines, driver: driverLines, notes, driverTotalCents: driverLines.reduce((a, l) => a + l.cents, 0), customerTotalCents: customerLines.reduce((a, l) => a + l.cents, 0), revenueCents: revenue };
}

/** Counts a driver's trips in a period that bonus rules look at. */
export async function periodStats(c: pg.PoolClient, driverId: string, from: string, to: string, tz: string): Promise<DriverPeriodStats> {
  const r = (await c.query(
    `SELECT count(*) FILTER (WHERE status = 'completed')::int AS trips,
            100.0 * count(*) FILTER (WHERE on_time) / nullif(count(*) FILTER (WHERE on_time IS NOT NULL AND status = 'completed'),0) AS on_time,
            avg(rating) FILTER (WHERE status = 'completed')::float8 AS rating,
            count(*) FILTER (WHERE status = 'completed' AND (conditions->>'peak')::boolean IS TRUE)::int AS peak
     FROM portal_trips WHERE driver_id = $1 AND archived_at IS NULL AND (started_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`, [driverId, from, to, tz])).rows[0];
  const zones: Record<string, number> = {};
  for (const z of (await c.query(`SELECT lower(zone) AS z, count(*)::int AS n FROM portal_trips WHERE driver_id = $1 AND archived_at IS NULL AND status = 'completed' AND zone IS NOT NULL AND (started_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date GROUP BY 1`, [driverId, from, to, tz])).rows) zones[z.z] = z.n;
  const days = (await c.query(`SELECT DISTINCT (started_at AT TIME ZONE $4)::date::text AS d FROM portal_trips WHERE driver_id = $1 AND archived_at IS NULL AND status = 'completed' AND (started_at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date ORDER BY 1`, [driverId, from, to, tz])).rows.map((x) => x.d as string);
  const safety = (await c.query(`SELECT count(*)::int AS n FROM driver_safety_events WHERE driver_id = $1 AND archived_at IS NULL AND (at AT TIME ZONE $4)::date BETWEEN $2::date AND $3::date`, [driverId, from, to, tz])).rows[0].n;
  return { trips: r.trips, onTimePct: r.on_time == null ? null : Math.round(Number(r.on_time)), ratingAvg: r.rating == null ? null : Math.round(Number(r.rating) * 100) / 100, peakTrips: r.peak, zoneTrips: zones, safetyEvents: safety, daysWithTrips: days.length, longestStreak: longestStreak(days) };
}

export async function activeBonusRules(c: pg.PoolClient): Promise<(BonusRule & { period: string })[]> {
  return (await c.query(`SELECT id, name, kind, amount_cents::float8 AS "amountCents", params, period FROM portal_bonus_rules WHERE archived_at IS NULL AND active ORDER BY name`)).rows;
}

export { evaluateBonus };

// ---- settings --------------------------------------------------------------------------------------------------------------------
export interface PaySettings { secondApprover: boolean; deductionCapPct: number; holdOnExpiredDocs: boolean; holdOnOpenIncident: boolean; defaultCycle: "daily" | "weekly" | "biweekly" | "monthly" }
export const PAY_DEFAULTS: PaySettings = { secondApprover: true, deductionCapPct: 50, holdOnExpiredDocs: true, holdOnOpenIncident: true, defaultCycle: "weekly" };
export async function paySettings(c: pg.PoolClient): Promise<PaySettings> {
  const r = (await c.query(`SELECT data -> 'pay' AS pay FROM portal_settings LIMIT 1`)).rows[0]?.pay ?? {};
  return { ...PAY_DEFAULTS, ...r };
}

/** The "second person" rule: when on, whoever asked for a change cannot be the one who approves it. */
export function assertSecondPerson(s: PaySettings, requestedBy: string | null, approver: string, what: string): void {
  if (s.secondApprover && requestedBy && requestedBy === approver) throw new ConflictException({ message: `A second person must approve ${what}. You asked for it, so someone else has to approve it.`, code: "second_person_required" });
}

/** Add up a payout from its lines. Net is exactly the sum of the signed lines, so a payout can never drift by a cent. */
export async function recomputePayout(c: pg.PoolClient, payoutId: string): Promise<{ earnings: number; bonus: number; tips: number; deduction: number; net: number }> {
  const r = (await c.query(
    `SELECT coalesce(sum(amount_cents) FILTER (WHERE kind IN ('earning','addon','toll','adjustment')),0)::float8 AS earnings,
            coalesce(sum(amount_cents) FILTER (WHERE kind = 'bonus'),0)::float8 AS bonus,
            coalesce(sum(amount_cents) FILTER (WHERE kind = 'tip'),0)::float8 AS tips,
            coalesce(-sum(amount_cents) FILTER (WHERE kind = 'deduction'),0)::float8 AS deduction,
            coalesce(sum(amount_cents),0)::float8 AS net
     FROM portal_pay_lines WHERE payout_id = $1 AND archived_at IS NULL AND approval = 'approved'`, [payoutId])).rows[0];
  await c.query(`UPDATE portal_payouts SET earnings_cents = $2, bonus_cents = $3, tips_cents = $4, deduction_cents = $5, net_cents = $6, updated_at = now() WHERE id = $1`, [payoutId, r.earnings, r.bonus, r.tips, r.deduction, r.net]);
  return { earnings: r.earnings, bonus: r.bonus, tips: r.tips, deduction: r.deduction, net: r.net };
}

/** Replay trips with another card without saving anything: the "what if" and compare tools. */
export async function replayTrips(c: pg.PoolClient, spec: RateSpec, kind: "customer" | "driver", from: string, to: string, tz: string, o: { driverId?: string | null; limit?: number } = {}) {
  const rows = (await c.query(
    `SELECT t.id, t.driver_id, t.vehicle_id, t.customer_name, t.started_at, t.distance_m, t.duration_s, t.waiting_s, t.stops, t.weight_kg, t.zone, t.status, t.revenue_cents::float8 AS revenue_cents, t.tip_cents::float8 AS tip_cents,
            t.toll_cents::float8 AS toll_cents, t.conditions, t.vehicle_cost_cents::float8 AS vehicle_cost_cents, v.kind AS vehicle_kind,
            coalesce((SELECT sum(l.amount_cents) FROM portal_pay_lines l WHERE l.trip_id = t.id AND l.archived_at IS NULL AND l.approval = 'approved' AND l.kind IN ('earning','addon')),0)::float8 AS actual_pay
     FROM portal_trips t LEFT JOIN vehicles v ON v.id = t.vehicle_id
     WHERE t.archived_at IS NULL AND (t.started_at AT TIME ZONE $3)::date BETWEEN $1::date AND $2::date ${o.driverId ? "AND t.driver_id = $4" : ""}
     ORDER BY t.started_at LIMIT ${o.limit ?? 5000}`, o.driverId ? [from, to, tz, o.driverId] : [from, to, tz])).rows;
  let newTotal = 0, oldTotal = 0, revenue = 0, vcost = 0, n = 0;
  for (const t of rows) {
    const facts = factsOf(t as TripRow, t.vehicle_kind, t.revenue_cents);
    const p = priceTrip(spec, kind === "customer" ? { ...facts, tipCents: 0, tollCents: 0 } : facts);
    const pay = kind === "driver" ? p.lines.filter((l) => l.kind === "earning" || l.kind === "addon").reduce((a, l) => a + l.cents, 0) : p.subtotalCents;
    newTotal += pay; oldTotal += kind === "driver" ? t.actual_pay : t.revenue_cents; revenue += t.revenue_cents; vcost += t.vehicle_cost_cents ?? 0; n++;
  }
  return { trips: n, newTotalCents: newTotal, currentTotalCents: oldTotal, revenueCents: revenue, vehicleCostCents: vcost, averageNewCents: n ? Math.round(newTotal / n) : 0, averageCurrentCents: n ? Math.round(oldTotal / n) : 0 };
}
