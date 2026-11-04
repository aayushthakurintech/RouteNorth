import { pg, withOrg } from "@routenorth/db";
import { dayNumber, keepRepairSell, round } from "@routenorth/shared";
import { budgetRows, cashPieces, scopedVehicleIds, taxMonths } from "../portal/finance.service.js";
import { loadDrivers } from "../portal/drivers.service.js";
import { bounds, shiftDay, vehicleMoney, type VehicleMoney } from "../portal/money-rules.js";
import { loadVehicles, todayIn } from "../portal/vehicles.service.js";
import type { Column, Ctx, Dataset } from "./datasets.js";

/**
 * Datasets for the owner portal's 56 ready-made reports and its report builder. Money columns are whole cents (type "money").
 * Every money figure comes from the same rules as the vehicle pages, the dashboard and the finance pages (money-rules.ts), so a
 * report total always equals the matching total there. People who are limited to a region only get rows for their region.
 */
const txt = (key: string, label: string): Column => ({ key, label, type: "text" });
const num = (key: string, label: string, agg: Column["agg"] = "sum"): Column => ({ key, label, type: "num", agg });
const money = (key: string, label: string, agg: Column["agg"] = "sum"): Column => ({ key, label, type: "money", agg });
const date = (key: string, label: string): Column => ({ key, label, type: "date" });
const ts = (key: string, label: string): Column => ({ key, label, type: "ts" });
const rate = (key: string, label: string): Column => ({ key, label, type: "pct", agg: "avg" });
const count: Column = { key: "count", label: "Rows", type: "num", agg: "sum" };

const MONEY: ("finance.view" | "vehicles.costs")[] = ["finance.view", "vehicles.costs"];
const PAY: ("pay.view" | "pay.manage")[] = ["pay.view", "pay.manage"];
const PEOPLE: ("drivers.view" | "drivers.manage")[] = ["drivers.view", "drivers.manage"];
const FLEET: ("fleet.view" | "vehicles.manage")[] = ["fleet.view", "vehicles.manage"];
const can = (x: Ctx, ...p: string[]) => !x.perms || p.some((k) => x.perms!.has(k));

interface Env { tz: string; today: string; teams: string[] | null; vehicleIds: string[] | undefined }
async function db<T>(x: Ctx, fn: (c: pg.PoolClient, e: Env) => Promise<T>): Promise<T> {
  return withOrg(x.pool, x.orgId, async (c) => {
    const tz = (await c.query<{ timezone: string }>("SELECT timezone FROM organizations LIMIT 1")).rows[0]?.timezone ?? "America/Toronto";
    const teams = x.filters.teamIds ?? null;
    return fn(c, { tz, today: todayIn(tz), teams, vehicleIds: await scopedVehicleIds(c, teams) });
  });
}
/** Inclusive local-date range as timestamps in the company time zone. */
const tsBounds = (x: Ctx) => bounds(x.range);
const dateIn = (col: string, tzParam: string) => `(${col} AT TIME ZONE ${tzParam})::date`;
const day = (d: unknown) => (d ? new Date(d as string).toISOString().slice(0, 10) : null);
const iso = (d: unknown) => (d ? new Date(d as string).toISOString() : null);
const monthsOf = (from: string, to: string): { month: string; from: string; to: string }[] => {
  const out: { month: string; from: string; to: string }[] = [];
  let y = Number(from.slice(0, 4)), m = Number(from.slice(5, 7));
  for (let i = 0; i < 36; i++) {
    const f = `${y}-${String(m).padStart(2, "0")}-01`; const l = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
    if (f > to) break;
    out.push({ month: f.slice(0, 7), from: f < from ? from : f, to: l > to ? to : l });
    if (++m > 12) { m = 1; y++; }
  }
  return out;
};
const sumM = (m: VehicleMoney | undefined, k: keyof VehicleMoney) => (m ? (m[k] as number) : 0);

export const PORTAL_DATASETS: Dataset[] = [
  {
    key: "vehicles", label: "Vehicles", requires: FLEET, about: "One row per car: what it is, its state, service and document dates.",
    columns: [txt("vehicle", "Car"), txt("plate", "Plate"), txt("kind", "Kind"), txt("status", "Status"), txt("driver", "Driver"), txt("ownership", "Ownership"), num("ageYears", "Age (years)", "avg"), num("odometerKm", "Odometer (km)", "max"),
      date("nextService", "Next service"), num("daysToService", "Days to service", "min"), txt("serviceState", "Service state"), num("docsExpired", "Documents expired"), num("docsExpiring", "Documents expiring"), date("nextDocExpiry", "Next document expiry"), count],
    async load(x) {
      return db(x, async (c, e) => (await loadVehicles(c, { today: e.today, tz: e.tz, now: new Date() }, { teamIds: e.teams })).map((v) => ({
        vehicle: v.name, plate: v.plate, kind: v.kind, status: v.status, driver: v.currentDriverName, ownership: v.ownershipType,
        ageYears: v.year ? Math.max(0, Number(e.today.slice(0, 4)) - v.year) : null, odometerKm: Math.round(v.odometerKm), nextService: v.service.nextDate, daysToService: v.service.daysLeft, serviceState: v.service.state,
        docsExpired: v.docs.expired, docsExpiring: v.docs.expiring, nextDocExpiry: v.docs.nextExpiry, count: 1, vehicleId: v.id,
      })));
    },
  },
  {
    key: "carMoney", label: "Vehicle profit and loss", requires: MONEY, about: "One row per car for the dates picked: revenue, every cost and profit.",
    columns: [txt("vehicle", "Car"), txt("plate", "Plate"), money("revenue", "Revenue"), money("fuel", "Fuel"), money("repairs", "Repairs and service"), money("insurance", "Insurance"), money("finance", "Loan and lease"), money("driverPay", "Driver pay"), money("otherCosts", "Tires, fines, other"),
      money("cost", "Total costs"), money("profit", "Profit"), num("trips", "Trips"), num("km", "km"), num("hoursOnTrip", "Hours on trips"), money("costPerKm", "Cost per km", "avg"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const vs = await loadVehicles(c, { today: e.today, tz: e.tz, now: new Date() }, { teamIds: e.teams });
        const per = await vehicleMoney(c, x.range, e.tz, { vehicleIds: e.vehicleIds });
        const rows = vs.map((v) => {
          const m = per.get(v.id); const km = sumM(m, "distanceM") / 1000;
          return { vehicle: v.name, plate: v.plate, revenue: sumM(m, "revenueCents"), fuel: sumM(m, "fuelCents"), repairs: sumM(m, "maintenanceCents"), insurance: sumM(m, "insuranceCents"), finance: sumM(m, "financeCents"), driverPay: sumM(m, "driverPayCents"),
            otherCosts: sumM(m, "tiresCents") + sumM(m, "ticketsCents") + sumM(m, "otherCents"), cost: sumM(m, "costCents"), profit: sumM(m, "profitCents"), trips: sumM(m, "trips"), km: round(km, 1), hoursOnTrip: round(sumM(m, "durationS") / 3600, 1),
            costPerKm: km > 0 ? Math.round((sumM(m, "costCents") - sumM(m, "driverPayCents")) / km) : null, count: 1, vehicleId: v.id };
        });
        // Costs not tied to any car (a card payment, software) belong to the company and are shown on their own line, so totals match the finance pages.
        const loose = per.get(null);
        if (!e.teams && loose && (loose.costCents || loose.revenueCents)) rows.push({ vehicle: "(not tied to a car)", plate: null, revenue: loose.revenueCents, fuel: loose.fuelCents, repairs: loose.maintenanceCents, insurance: loose.insuranceCents, finance: loose.financeCents, driverPay: loose.driverPayCents,
          otherCosts: loose.tiresCents + loose.ticketsCents + loose.otherCents, cost: loose.costCents, profit: loose.profitCents, trips: loose.trips, km: round(loose.distanceM / 1000, 1), hoursOnTrip: round(loose.durationS / 3600, 1), costPerKm: null, count: 1, vehicleId: null as never });
        return rows;
      });
    },
  },
  {
    key: "carLifetime", label: "Vehicle lifetime cost and value", requires: MONEY, about: "One row per car over its whole life (the date range does not apply): cost of ownership, value now, and the keep, repair or sell score.",
    columns: [txt("vehicle", "Car"), date("purchaseDate", "Bought on"), num("ageYears", "Age (years)", "avg"), money("purchasePrice", "Purchase price"), money("currentValue", "Value now"), num("valueLostPct", "Value lost (%)", "avg"), money("financeCost", "Loan and lease paid"), money("fuel", "Fuel"), money("repairs", "Repairs and service"),
      money("insurance", "Insurance"), money("otherRunning", "Tires, fines, other"), money("totalCost", "Total cost of ownership"), num("km", "km driven"), money("costPerKm", "Cost per km", "avg"), money("repairs12m", "Repairs, last 12 months"), money("profit12m", "Profit, last 12 months"), num("keepScore", "Keep, repair or sell score", "avg"), txt("advice", "Advice"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const vs = await loadVehicles(c, { today: e.today, tz: e.tz, now: new Date() }, { teamIds: e.teams });
        const out: Record<string, unknown>[] = [];
        const year = await vehicleMoney(c, { from: shiftDay(e.today, -364), to: e.today }, e.tz, { vehicleIds: vs.map((v) => v.id) });
        const rep = new Map((await c.query(`SELECT vehicle_id AS id, coalesce(sum(total_cents),0)::float8 AS v FROM maintenance_logs WHERE archived_at IS NULL AND kind = 'repair' AND done_on > $1::date - 365 GROUP BY 1`, [e.today])).rows.map((r) => [r.id as string, r.v as number]));
        for (const v of vs) {
          const start = v.purchaseDate ?? day(v.createdAt)!;
          const life = (await vehicleMoney(c, { from: start, to: e.today }, e.tz, { vehicleIds: [v.id] })).get(v.id);
          const price = v.purchasePriceCents ?? 0; const value = v.currentValueCents; const km = sumM(life, "distanceM") / 1000;
          const running = sumM(life, "costCents") - sumM(life, "driverPayCents");
          const age = v.purchaseDate ? Math.max(0, dayNumber(e.today) - dayNumber(v.purchaseDate)) / 365 : 0;
          const k = keepRepairSell({ repairs12mCents: rep.get(v.id) ?? 0, valueCents: value ?? Math.round(price * 0.5), ageYears: age, profit12mCents: sumM(year.get(v.id), "profitCents") });
          out.push({ vehicle: v.name, purchaseDate: v.purchaseDate, ageYears: round(age, 1), purchasePrice: price || null, currentValue: value, valueLostPct: price && value != null ? round(((price - value) / price) * 100, 1) : null,
            financeCost: sumM(life, "financeCents"), fuel: sumM(life, "fuelCents"), repairs: sumM(life, "maintenanceCents"), insurance: sumM(life, "insuranceCents"), otherRunning: sumM(life, "tiresCents") + sumM(life, "ticketsCents") + sumM(life, "otherCents"),
            totalCost: price + running, km: round(km, 1), costPerKm: km > 0 ? Math.round((price + running) / km) : null, repairs12m: rep.get(v.id) ?? 0, profit12m: sumM(year.get(v.id), "profitCents"), keepScore: k.score, advice: k.advice, count: 1, vehicleId: v.id });
        }
        return out;
      });
    },
  },
  {
    key: "repairs", label: "Maintenance and repairs (money in cents)", requires: FLEET, about: "Every service and repair, with shop, cost and days out of service.",
    columns: [date("date", "Date"), txt("vehicle", "Car"), txt("task", "Work done"), txt("kind", "Type"), txt("shop", "Shop"), money("labour", "Labour"), money("parts", "Parts"), money("total", "Total"), num("downtimeDays", "Days out of service"), num("odometerKm", "Odometer (km)", "max"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `SELECT m.done_on::text AS date, v.name AS vehicle, m.task, m.kind, m.vendor AS shop, coalesce(m.labour_cents,0)::float8 AS labour, coalesce(m.parts_cents,0)::float8 AS parts, coalesce(m.total_cents,0)::float8 AS total, round(coalesce(m.downtime_hours,0) / 24, 1)::float8 AS "downtimeDays", m.odometer_km AS "odometerKm", 1 AS count, m.vehicle_id AS "vehicleId"
         FROM maintenance_logs m JOIN vehicles v ON v.id = m.vehicle_id WHERE m.archived_at IS NULL AND m.done_on BETWEEN $1::date AND $2::date AND ($3::uuid[] IS NULL OR m.vehicle_id = ANY($3)) ORDER BY m.done_on`, [x.range.from, x.range.to, e.vehicleIds ?? null]).then((r) => r.rows));
    },
  },
  {
    key: "fuelLogs", label: "Fuel and energy (money in cents)", requires: FLEET, about: "Every fill-up with litres or kWh, cost and economy since the last fill.",
    columns: [date("date", "Date"), txt("vehicle", "Car"), txt("driver", "Driver"), txt("station", "Station"), num("amount", "Litres or kWh"), money("cost", "Cost"), num("odometerKm", "Odometer (km)", "max"), num("kmSinceLast", "km since last fill"), num("kmPerUnit", "km per litre or kWh", "avg"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const rows = (await c.query(
          `SELECT f.filled_on::text AS date, v.name AS vehicle, coalesce(u.display_name, u.email) AS driver, f.station, f.litres AS amount, coalesce(f.cost_cents, round(f.cost * 100))::float8 AS cost, f.odometer_km AS "odometerKm", f.vehicle_id AS "vehicleId",
                  f.odometer_km - lag(f.odometer_km) OVER (PARTITION BY f.vehicle_id ORDER BY f.filled_on, f.created_at) AS gap
           FROM fuel_logs f JOIN vehicles v ON v.id = f.vehicle_id LEFT JOIN users u ON u.id = f.driver_id WHERE f.archived_at IS NULL AND ($1::uuid[] IS NULL OR f.vehicle_id = ANY($1)) ORDER BY f.filled_on`, [e.vehicleIds ?? null])).rows;
        return rows.filter((r) => r.date >= x.range.from && r.date <= x.range.to).map((r) => ({ ...r, kmSinceLast: r.gap != null && r.gap > 0 ? round(r.gap, 1) : null, kmPerUnit: r.gap != null && r.gap > 0 && r.amount > 0 ? round(r.gap / r.amount, 2) : null, count: 1 }));
      });
    },
  },
  {
    key: "documents", label: "Documents (cars and drivers)", requires: ["fleet.view", "vehicles.manage", "drivers.view", "drivers.manage"], about: "Every document with an owner, an expiry date and how many days are left.",
    columns: [txt("ownerKind", "For"), txt("subject", "Car or driver"), txt("kind", "Document"), txt("number", "Number"), date("issuedOn", "Issued"), date("expiresOn", "Expires"), num("daysLeft", "Days left", "min"), txt("status", "Status"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const cars = can(x, "fleet.view", "vehicles.manage"), people = can(x, "drivers.view", "drivers.manage");
        const rows = (await c.query(
          `SELECT d.owner_kind AS "ownerKind", coalesce(v.name, u.display_name, u.email) AS subject, d.kind, d.number, d.issued_on::text AS "issuedOn", d.expires_on::text AS "expiresOn", (d.expires_on - $1::date) AS days, d.owner_id AS "ownerId", v.team_id AS vteam, dp.team_id AS dteam
           FROM documents d LEFT JOIN vehicles v ON d.owner_kind = 'vehicle' AND v.id = d.owner_id LEFT JOIN users u ON d.owner_kind = 'driver' AND u.id = d.owner_id LEFT JOIN driver_profiles dp ON dp.user_id = u.id
           WHERE d.archived_at IS NULL AND d.owner_kind IN ('vehicle','driver')`, [e.today])).rows;
        return rows.filter((r) => (r.ownerKind === "vehicle" ? cars : people) && (!e.teams || e.teams.includes(r.ownerKind === "vehicle" ? r.vteam : r.dteam))).map((r) => ({
          ownerKind: r.ownerKind === "vehicle" ? "Car" : "Driver", subject: r.subject, kind: r.kind, number: r.number, issuedOn: r.issuedOn, expiresOn: r.expiresOn, daysLeft: r.days, status: r.days == null ? "no expiry" : r.days < 0 ? "expired" : r.days <= 30 ? "expiring" : "valid", count: 1 }));
      });
    },
  },
  {
    key: "inspections", label: "Inspections", requires: FLEET, about: "Every inspection, with failed items and the day it was signed off.",
    columns: [date("date", "Date"), txt("vehicle", "Car"), txt("driver", "Driver"), txt("kind", "Type"), txt("result", "Result"), num("failedItems", "Failed items"), date("signedOffOn", "Signed off"), num("daysToFix", "Days to sign off", "avg"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `SELECT ${dateIn("i.at", "$3")}::text AS date, v.name AS vehicle, coalesce(u.display_name, u.email) AS driver, i.kind, CASE WHEN i.defects THEN 'failed' ELSE 'passed' END AS result,
                coalesce((SELECT count(*) FROM jsonb_array_elements(CASE WHEN jsonb_typeof(i.items) = 'array' THEN i.items ELSE '[]'::jsonb END) it WHERE it->>'ok' = 'false' OR it->>'status' IN ('fail','failed')),0)::int AS "failedItems",
                ${dateIn("i.signed_off_at", "$3")}::text AS "signedOffOn", CASE WHEN i.signed_off_at IS NOT NULL THEN extract(epoch FROM i.signed_off_at - i.at) / 86400 END AS "daysToFix", 1 AS count
         FROM inspections i JOIN vehicles v ON v.id = i.vehicle_id LEFT JOIN users u ON u.id = i.driver_id
         WHERE i.archived_at IS NULL AND ${dateIn("i.at", "$3")} BETWEEN $1::date AND $2::date AND ($4::uuid[] IS NULL OR i.vehicle_id = ANY($4)) ORDER BY i.at`, [x.range.from, x.range.to, e.tz, e.vehicleIds ?? null]).then((r) => r.rows));
    },
  },
  {
    key: "incidentRegister", label: "Incidents and claims", requires: FLEET, about: "Every incident with damage cost, fines and claim status.",
    columns: [date("date", "Date"), txt("vehicle", "Car"), txt("driver", "Driver"), txt("kind", "Type"), txt("severity", "Severity"), txt("status", "Status"), txt("location", "Where"), num("injuries", "Injuries"), money("repairCost", "Damage cost"), money("fine", "Fine"), txt("claimNumber", "Claim"), txt("claimStatus", "Claim status"), txt("followUp", "Follow-up"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `SELECT ${dateIn("i.occurred_at", "$3")}::text AS date, v.name AS vehicle, coalesce(u.display_name, u.email) AS driver, i.kind, i.severity, i.status, i.location, CASE WHEN i.injuries THEN 1 ELSE 0 END AS injuries,
                coalesce(i.repair_cost_cents,0)::float8 AS "repairCost", coalesce(i.fine_cents,0)::float8 AS fine, i.claim_number AS "claimNumber", i.claim_status AS "claimStatus", CASE WHEN i.status = 'open' THEN 'open' ELSE 'closed' END AS "followUp", 1 AS count
         FROM incidents i LEFT JOIN vehicles v ON v.id = i.vehicle_id LEFT JOIN users u ON u.id = i.driver_id
         WHERE i.archived_at IS NULL AND ${dateIn("i.occurred_at", "$3")} BETWEEN $1::date AND $2::date AND ($4::uuid[] IS NULL OR i.vehicle_id = ANY($4)) ORDER BY i.occurred_at`, [x.range.from, x.range.to, e.tz, e.vehicleIds ?? null]).then((r) => r.rows));
    },
  },
  {
    key: "drivers", label: "Drivers", requires: PEOPLE, about: "One row per driver: status, car, rate card, score, rating, on-time rate and compliance.",
    columns: [txt("driver", "Driver"), txt("status", "Status"), txt("vehicle", "Car"), date("startDate", "Start date"), txt("rateCard", "Rate card"), txt("employmentType", "Employment"), num("score", "Score", "avg"), num("onTimePct", "On-time (%)", "avg"), num("rating", "Rating", "avg"), num("safety", "Safety", "avg"), num("compliance", "Compliance (%)", "avg"),
      num("trips30", "Trips, last 30 days"), money("revenue30", "Revenue, last 30 days"), money("earnings30", "Earned, last 30 days"), num("docsExpired", "Documents expired"), num("docsExpiring", "Documents expiring"), num("acceptancePct", "Acceptance (%)", "avg"), date("lastActive", "Last active"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const rows = await loadDrivers(c, { today: e.today, tz: e.tz, now: new Date() }, { applicants: false, teamIds: e.teams });
        const pay = can(x, ...PAY, "finance.view");
        return rows.map((d) => ({ driver: d.name, status: d.status, vehicle: d.vehicleName, startDate: day(d.createdAt), rateCard: d.rateCardName, employmentType: d.employmentType, score: d.score, onTimePct: d.onTimePct, rating: d.rating, safety: d.safety, compliance: d.compliance,
          trips30: d.tripsMonth, revenue30: pay ? d.revenueMonthCents : null, earnings30: pay ? d.earningsMonthCents : null, docsExpired: d.docs.expired, docsExpiring: d.docs.expiring, acceptancePct: null, lastActive: day(d.lastActive), count: 1, driverId: d.id }));
      });
    },
  },
  {
    key: "driverProfit", label: "Driver profit", requires: MONEY, about: "What each driver brought in, what they were paid and what the car cost, for the dates picked.",
    columns: [txt("driver", "Driver"), num("trips", "Trips"), money("revenue", "Revenue"), money("driverPay", "Driver earned"), money("carCost", "Car running cost"), money("profit", "Left for you"), num("marginPct", "Margin (%)", "avg"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const b = tsBounds(x);
        const rows = (await c.query(
          `SELECT coalesce(u.display_name, u.email, '(no driver)') AS driver, t.driver_id AS "driverId", count(*)::int AS trips, sum(t.revenue_cents)::float8 AS revenue, sum(coalesce(p.pay,0))::float8 AS "driverPay", sum(coalesce(t.vehicle_cost_cents,0))::float8 AS "carCost"
           FROM portal_trips t LEFT JOIN users u ON u.id = t.driver_id
             LEFT JOIN LATERAL (SELECT sum(amount_cents) AS pay FROM portal_pay_lines l WHERE l.trip_id = t.id AND l.archived_at IS NULL AND l.approval = 'approved' AND l.kind IN ('earning','addon')) p ON true
           WHERE t.archived_at IS NULL AND t.status = 'completed' AND t.started_at >= ($1::timestamp AT TIME ZONE $3) AND t.started_at < ($2::timestamp AT TIME ZONE $3) AND ($4::uuid[] IS NULL OR t.vehicle_id = ANY($4)) GROUP BY 1, 2`, [b.fromTs, b.toTs, e.tz, e.vehicleIds ?? null])).rows;
        return rows.map((r) => ({ ...r, profit: r.revenue - r.driverPay - r.carCost, marginPct: r.revenue > 0 ? round(((r.revenue - r.driverPay - r.carCost) / r.revenue) * 100, 1) : null, count: 1 }));
      });
    },
  },
  {
    key: "shifts", label: "Shifts, hours and overtime", requires: PEOPLE, about: "Every shift with its length and overtime.",
    columns: [date("date", "Date"), txt("driver", "Driver"), ts("startedAt", "Started"), ts("endedAt", "Ended"), num("hours", "Hours"), num("overtimeHours", "Overtime hours"), txt("overtimeStatus", "Overtime status"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `SELECT ${dateIn("s.started_at", "$3")}::text AS date, coalesce(u.display_name, u.email) AS driver, s.started_at AS "startedAt", s.ended_at AS "endedAt", round((extract(epoch FROM coalesce(s.ended_at, now()) - s.started_at) / 3600)::numeric, 2)::float8 AS hours,
                round((coalesce(s.overtime_minutes,0) / 60.0)::numeric, 2)::float8 AS "overtimeHours", s.overtime_status AS "overtimeStatus", 1 AS count
         FROM shifts s JOIN users u ON u.id = s.driver_id LEFT JOIN driver_profiles dp ON dp.user_id = u.id
         WHERE ${dateIn("s.started_at", "$3")} BETWEEN $1::date AND $2::date AND ($4::uuid[] IS NULL OR dp.team_id = ANY($4)) ORDER BY s.started_at`, [x.range.from, x.range.to, e.tz, e.teams]).then((r) => r.rows.map((s) => ({ ...s, startedAt: iso(s.startedAt), endedAt: iso(s.endedAt) }))));
    },
  },
  {
    key: "attendance", label: "Attendance (jobs given vs shifts worked)", requires: PEOPLE, about: "For each driver and day: jobs given, hours worked, late start in minutes, and whether they did not show.",
    columns: [date("date", "Date"), txt("driver", "Driver"), num("jobs", "Jobs given"), num("hours", "Hours worked"), num("lateMinutes", "Late start (min)", "max"), num("noShow", "No-show"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `WITH j AS (SELECT driver_id, scheduled_date AS d, count(*)::int AS jobs, min(window_start) AS first_window FROM jobs WHERE driver_id IS NOT NULL AND scheduled_date BETWEEN $1::date AND $2::date AND status <> 'cancelled' GROUP BY 1, 2),
              s AS (SELECT driver_id, ${dateIn("started_at", "$3")} AS d, min(started_at) AS first_start, sum(extract(epoch FROM coalesce(ended_at, now()) - started_at)) / 3600 AS hours FROM shifts WHERE ${dateIn("started_at", "$3")} BETWEEN $1::date AND $2::date GROUP BY 1, 2)
         SELECT coalesce(j.d, s.d)::text AS date, coalesce(u.display_name, u.email) AS driver, coalesce(j.jobs,0) AS jobs, round(coalesce(s.hours,0)::numeric, 2)::float8 AS hours,
                CASE WHEN j.first_window IS NOT NULL AND s.first_start IS NOT NULL AND s.first_start > j.first_window THEN round(extract(epoch FROM s.first_start - j.first_window) / 60)::int ELSE 0 END AS "lateMinutes",
                CASE WHEN coalesce(j.jobs,0) > 0 AND s.first_start IS NULL THEN 1 ELSE 0 END AS "noShow", 1 AS count
         FROM j FULL JOIN s ON s.driver_id = j.driver_id AND s.d = j.d JOIN users u ON u.id = coalesce(j.driver_id, s.driver_id) LEFT JOIN driver_profiles dp ON dp.user_id = u.id
         WHERE ($4::uuid[] IS NULL OR dp.team_id = ANY($4)) ORDER BY 1`, [x.range.from, x.range.to, e.tz, e.teams]).then((r) => r.rows));
    },
  },
  {
    key: "driverEvents", label: "Driver safety events", requires: PEOPLE, about: "Speeding, harsh braking, phone use and other events recorded against drivers.",
    columns: [date("date", "Date"), txt("driver", "Driver"), txt("vehicle", "Car"), txt("kind", "Event"), num("severity", "Severity", "avg"), txt("detail", "Detail"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `SELECT ${dateIn("s.at", "$3")}::text AS date, coalesce(u.display_name, u.email) AS driver, v.name AS vehicle, s.kind, s.severity, s.detail, 1 AS count
         FROM driver_safety_events s JOIN users u ON u.id = s.driver_id LEFT JOIN vehicles v ON v.id = s.vehicle_id LEFT JOIN driver_profiles dp ON dp.user_id = u.id
         WHERE s.archived_at IS NULL AND ${dateIn("s.at", "$3")} BETWEEN $1::date AND $2::date AND ($4::uuid[] IS NULL OR dp.team_id = ANY($4)) ORDER BY s.at`, [x.range.from, x.range.to, e.tz, e.teams]).then((r) => r.rows));
    },
  },
  {
    key: "safetyMonthly", label: "Safety trend (events per 1,000 km)", requires: FLEET.concat(PEOPLE as never), about: "Events by type for each month, divided by the kilometres driven that month.",
    columns: [txt("month", "Month"), txt("kind", "Event"), num("events", "Events"), num("km", "km driven", "max"), num("per1000", "Events per 1,000 km", "avg"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const out: Record<string, unknown>[] = [];
        for (const m of monthsOf(x.range.from, x.range.to)) {
          const b = bounds({ from: m.from, to: m.to });
          const km = Number((await c.query(`SELECT coalesce(sum(distance_m),0)::float8 / 1000 AS km FROM portal_trips WHERE archived_at IS NULL AND status = 'completed' AND started_at >= ($1::timestamp AT TIME ZONE $3) AND started_at < ($2::timestamp AT TIME ZONE $3) AND ($4::uuid[] IS NULL OR vehicle_id = ANY($4))`, [b.fromTs, b.toTs, e.tz, e.vehicleIds ?? null])).rows[0].km);
          const ev = (await c.query(`SELECT s.kind, count(*)::int AS n FROM driver_safety_events s LEFT JOIN driver_profiles dp ON dp.user_id = s.driver_id WHERE s.archived_at IS NULL AND s.at >= ($1::timestamp AT TIME ZONE $3) AND s.at < ($2::timestamp AT TIME ZONE $3) AND ($4::uuid[] IS NULL OR dp.team_id = ANY($4)) GROUP BY 1`, [b.fromTs, b.toTs, e.tz, e.teams])).rows;
          for (const r of ev) out.push({ month: m.month, kind: r.kind, events: r.n, km: round(km, 1), per1000: km > 0 ? round((r.n / km) * 1000, 2) : null, count: 1 });
        }
        return out;
      });
    },
  },
  {
    key: "ratings", label: "Ratings, complaints and feedback", requires: ["reports.view"], about: "Trip ratings, complaints and customer feedback scores, with comments.",
    columns: [date("date", "Date"), txt("source", "From"), txt("driver", "Driver"), txt("customer", "Customer"), num("rating", "Rating (1-5)", "avg"), num("nps", "Recommend score (0-10)", "avg"), txt("comment", "Comment"), num("complaints", "Complaints"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const t = (await c.query(
          `SELECT ${dateIn("t.started_at", "$3")}::text AS date, 'trip' AS source, coalesce(u.display_name, u.email) AS driver, t.customer_name AS customer, t.rating, NULL::int AS nps, t.complaint AS comment, CASE WHEN t.complaint IS NOT NULL AND t.complaint <> '' THEN 1 ELSE 0 END AS complaints, 1 AS count
           FROM portal_trips t LEFT JOIN users u ON u.id = t.driver_id LEFT JOIN driver_profiles dp ON dp.user_id = u.id
           WHERE t.archived_at IS NULL AND (t.rating IS NOT NULL OR t.complaint IS NOT NULL) AND ${dateIn("t.started_at", "$3")} BETWEEN $1::date AND $2::date AND ($4::uuid[] IS NULL OR dp.team_id = ANY($4))`, [x.range.from, x.range.to, e.tz, e.teams])).rows;
        const f = (await c.query(
          `SELECT ${dateIn("f.created_at", "$3")}::text AS date, 'feedback' AS source, coalesce(u.display_name, u.email) AS driver, NULL AS customer, f.csat AS rating, f.nps, f.comment, 0 AS complaints, 1 AS count
           FROM feedback f LEFT JOIN users u ON u.id = f.driver_id LEFT JOIN driver_profiles dp ON dp.user_id = u.id
           WHERE ${dateIn("f.created_at", "$3")} BETWEEN $1::date AND $2::date AND ($4::uuid[] IS NULL OR dp.team_id = ANY($4))`, [x.range.from, x.range.to, e.tz, e.teams])).rows;
        return [...t, ...f].sort((a, b) => String(a.date).localeCompare(String(b.date)));
      });
    },
  },
  {
    key: "onboarding", label: "Driver onboarding steps", requires: PEOPLE, about: "Every onboarding step for every driver, with how long it took to decide.",
    columns: [txt("driver", "Driver"), txt("step", "Step"), txt("status", "Status"), date("submittedOn", "Submitted"), date("decidedOn", "Decided"), num("daysToDecide", "Days to decide", "avg"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `SELECT coalesce(u.display_name, u.email) AS driver, s.step, s.status, s.submitted_at::date::text AS "submittedOn", s.decided_at::date::text AS "decidedOn", CASE WHEN s.decided_at IS NOT NULL AND s.submitted_at IS NOT NULL THEN round((extract(epoch FROM s.decided_at - s.submitted_at) / 86400)::numeric, 1)::float8 END AS "daysToDecide", 1 AS count
         FROM driver_onboarding_steps s JOIN users u ON u.id = s.driver_id LEFT JOIN driver_profiles dp ON dp.user_id = u.id WHERE ($1::uuid[] IS NULL OR dp.team_id = ANY($1)) ORDER BY u.display_name, s.step`, [e.teams]).then((r) => r.rows));
    },
  },
  {
    key: "driverTenure", label: "Driver start, end and tenure", requires: PEOPLE, about: "When each driver started and left, how long they stayed, and why.",
    columns: [txt("driver", "Driver"), txt("status", "Status"), date("startDate", "Start date"), date("endDate", "End date"), num("tenureDays", "Tenure (days)", "avg"), txt("reason", "Reason"), txt("startMonth", "Start month"), txt("endMonth", "End month"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `SELECT coalesce(u.display_name, u.email) AS driver, coalesce(p.status, 'active') AS status, u.created_at::date::text AS "startDate", p.offboarded_at::date::text AS "endDate", (coalesce(p.offboarded_at, now())::date - u.created_at::date) AS "tenureDays", p.status_reason AS reason,
                to_char(u.created_at, 'YYYY-MM') AS "startMonth", to_char(p.offboarded_at, 'YYYY-MM') AS "endMonth", 1 AS count
         FROM users u LEFT JOIN driver_profiles p ON p.user_id = u.id WHERE u.role = 'driver' AND ($1::uuid[] IS NULL OR p.team_id = ANY($1)) ORDER BY u.created_at`, [e.teams]).then((r) => r.rows));
    },
  },
  {
    key: "training", label: "Training and courses", requires: PEOPLE, about: "Every course each driver needs, whether it is done and when it expires.",
    columns: [txt("driver", "Driver"), txt("course", "Course"), txt("required", "Required"), date("completedOn", "Completed"), date("expiresOn", "Expires"), txt("status", "Status"), num("score", "Score", "avg"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `SELECT coalesce(u.display_name, u.email) AS driver, t.course, CASE WHEN t.required THEN 'yes' ELSE 'no' END AS required, t.completed_on::text AS "completedOn", t.expires_on::text AS "expiresOn",
                CASE WHEN t.completed_on IS NULL THEN 'not done' WHEN t.expires_on IS NOT NULL AND t.expires_on < $2::date THEN 'expired' ELSE 'done' END AS status, t.score, 1 AS count
         FROM driver_trainings t JOIN users u ON u.id = t.driver_id LEFT JOIN driver_profiles dp ON dp.user_id = u.id WHERE t.archived_at IS NULL AND ($1::uuid[] IS NULL OR dp.team_id = ANY($1)) ORDER BY 1, 2`, [e.teams, e.today]).then((r) => r.rows));
    },
  },
  {
    key: "payLines", label: "Pay lines (earnings, bonuses, deductions)", requires: PAY, about: "Every line that makes up driver pay.",
    columns: [date("date", "Date"), txt("driver", "Driver"), txt("kind", "Type"), txt("label", "Line"), money("amount", "Amount"), txt("approval", "Approval"), txt("reason", "Reason"), txt("changedBy", "Entered by"), txt("rateCard", "Rate card"), txt("payoutStatus", "Payout"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `SELECT l.line_date::text AS date, coalesce(u.display_name, u.email) AS driver, l.kind, l.label, l.amount_cents::float8 AS amount, l.approval, l.reason, coalesce(cb.display_name, cb.email) AS "changedBy", rc.name || ' v' || rv.version AS "rateCard", p.status AS "payoutStatus", 1 AS count
         FROM portal_pay_lines l JOIN users u ON u.id = l.driver_id LEFT JOIN users cb ON cb.id = l.created_by LEFT JOIN portal_rate_versions rv ON rv.id = l.rate_version_id LEFT JOIN portal_rate_cards rc ON rc.id = rv.card_id LEFT JOIN portal_payouts p ON p.id = l.payout_id LEFT JOIN driver_profiles dp ON dp.user_id = l.driver_id
         WHERE l.archived_at IS NULL AND l.line_date BETWEEN $1::date AND $2::date AND ($3::uuid[] IS NULL OR dp.team_id = ANY($3)) ORDER BY l.line_date`, [x.range.from, x.range.to, e.teams]).then((r) => r.rows));
    },
  },
  {
    key: "payouts", label: "Payouts", requires: PAY, about: "One row per driver per payout run.",
    columns: [date("from", "From"), date("to", "To"), txt("driver", "Driver"), txt("employment", "Employment"), txt("status", "Status"), money("earnings", "Earnings"), money("bonuses", "Bonuses"), money("tips", "Tips"), money("deductions", "Deductions"), money("net", "Net pay"), txt("method", "Method"), txt("taxForm", "Tax form"), date("paidOn", "Paid on"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `SELECT p.from_date::text AS "from", p.to_date::text AS "to", coalesce(u.display_name, u.email) AS driver, coalesce(p.employment_type, dp.employment_type) AS employment, p.status, p.earnings_cents::float8 AS earnings, p.bonus_cents::float8 AS bonuses, p.tips_cents::float8 AS tips, p.deduction_cents::float8 AS deductions, p.net_cents::float8 AS net,
                p.method, CASE WHEN dp.tax_form_received_on IS NOT NULL THEN 'received' ELSE coalesce(dp.tax_form, 'missing') END AS "taxForm", ${dateIn("p.paid_at", "$3")}::text AS "paidOn", 1 AS count
         FROM portal_payouts p JOIN users u ON u.id = p.driver_id LEFT JOIN driver_profiles dp ON dp.user_id = p.driver_id
         WHERE p.to_date >= $1::date AND p.from_date <= $2::date AND ($4::uuid[] IS NULL OR dp.team_id = ANY($4)) ORDER BY p.to_date, 3`, [x.range.from, x.range.to, e.tz, e.teams]).then((r) => r.rows));
    },
  },
  {
    key: "disputes", label: "Pay questions and corrections", requires: PAY, about: "Every question a driver raised about a payout, and how long it took to fix.",
    columns: [date("date", "Raised"), txt("driver", "Driver"), txt("line", "Line"), txt("message", "Question"), txt("status", "Status"), txt("reply", "Reply"), date("resolvedOn", "Resolved"), num("daysToFix", "Days to fix", "avg"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `SELECT ${dateIn("d.created_at", "$3")}::text AS date, coalesce(u.display_name, u.email) AS driver, l.label AS line, d.message, d.status, d.reply, ${dateIn("d.resolved_at", "$3")}::text AS "resolvedOn",
                CASE WHEN d.resolved_at IS NOT NULL THEN round((extract(epoch FROM d.resolved_at - d.created_at) / 86400)::numeric, 1)::float8 END AS "daysToFix", 1 AS count
         FROM portal_disputes d JOIN users u ON u.id = d.driver_id LEFT JOIN portal_pay_lines l ON l.id = d.line_id LEFT JOIN driver_profiles dp ON dp.user_id = d.driver_id
         WHERE ${dateIn("d.created_at", "$3")} BETWEEN $1::date AND $2::date AND ($4::uuid[] IS NULL OR dp.team_id = ANY($4)) ORDER BY d.created_at`, [x.range.from, x.range.to, e.tz, e.teams]).then((r) => r.rows));
    },
  },
  {
    key: "trips", label: "Trips", requires: [...MONEY, ...PAY], about: "Every completed or failed trip with price, driver pay, car cost and what was left.",
    columns: [date("date", "Date"), txt("hour", "Hour"), txt("weekday", "Day"), txt("driver", "Driver"), txt("vehicle", "Car"), txt("customer", "Customer"), txt("zone", "Zone"), txt("route", "Route"), txt("status", "Result"), txt("onTime", "On time"), num("km", "km"), num("minutes", "Minutes"), num("waitMinutes", "Waiting (min)"),
      money("price", "Customer paid"), money("tip", "Tip"), money("driverPay", "Driver earned"), money("carCost", "Car running cost"), money("margin", "Left over"), money("revenuePerKm", "Revenue per km", "avg"), money("revenuePerHour", "Revenue per hour", "avg"), num("rating", "Rating", "avg"), txt("rateCard", "Driver rate card"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const b = tsBounds(x); const seePay = can(x, ...PAY, ...MONEY);
        const rows = (await c.query(
          `SELECT ${dateIn("t.started_at", "$3")}::text AS date, lpad(extract(hour FROM t.started_at AT TIME ZONE $3)::int::text, 2, '0') || ':00' AS hour, to_char(t.started_at AT TIME ZONE $3, 'Dy') AS weekday, coalesce(u.display_name, u.email) AS driver, v.name AS vehicle, t.customer_name AS customer, t.zone, r.name AS route, t.status,
                  CASE WHEN t.on_time IS NULL THEN NULL WHEN t.on_time THEN 'yes' ELSE 'late' END AS "onTime", round((t.distance_m / 1000.0)::numeric, 1)::float8 AS km, round((t.duration_s / 60.0)::numeric)::float8 AS minutes, round((t.waiting_s / 60.0)::numeric)::float8 AS "waitMinutes",
                  t.revenue_cents::float8 AS price, t.tip_cents::float8 AS tip, coalesce(p.pay,0)::float8 AS "driverPay", coalesce(t.vehicle_cost_cents,0)::float8 AS "carCost", t.rating, rc.name || ' v' || rv.version AS "rateCard", t.distance_m, t.duration_s, t.id AS "tripId", t.vehicle_id AS "vehicleId", t.driver_id AS "driverId"
           FROM portal_trips t LEFT JOIN users u ON u.id = t.driver_id LEFT JOIN vehicles v ON v.id = t.vehicle_id LEFT JOIN routes r ON r.id = t.route_id LEFT JOIN portal_rate_versions rv ON rv.id = t.driver_rate_version_id LEFT JOIN portal_rate_cards rc ON rc.id = rv.card_id
             LEFT JOIN LATERAL (SELECT sum(amount_cents) AS pay FROM portal_pay_lines l WHERE l.trip_id = t.id AND l.archived_at IS NULL AND l.approval = 'approved' AND l.kind IN ('earning','addon')) p ON true
           WHERE t.archived_at IS NULL AND t.started_at >= ($1::timestamp AT TIME ZONE $3) AND t.started_at < ($2::timestamp AT TIME ZONE $3) AND ($4::uuid[] IS NULL OR t.vehicle_id = ANY($4)) ORDER BY t.started_at`, [b.fromTs, b.toTs, e.tz, e.vehicleIds ?? null])).rows;
        return rows.map((t) => {
          const margin = t.status === "completed" ? t.price - t.driverPay - t.carCost : null;
          return { ...t, driverPay: seePay ? t.driverPay : null, carCost: seePay ? t.carCost : null, margin: seePay ? margin : null, revenuePerKm: t.distance_m > 0 ? Math.round(t.price / (t.distance_m / 1000)) : null, revenuePerHour: t.duration_s > 0 ? Math.round(t.price / (t.duration_s / 3600)) : null, count: 1 };
        });
      });
    },
  },
  {
    key: "customers", label: "Customers", requires: MONEY, about: "One row per customer name: trips, revenue, margin, rating, how often they come back and what they owe.",
    columns: [txt("customer", "Customer"), num("trips", "Trips"), money("revenue", "Revenue"), money("margin", "Left over"), num("marginPct", "Margin (%)", "avg"), num("rating", "Rating", "avg"), num("activeDays", "Days with a trip"), rate("repeat", "Came back"), money("owed", "Owes you"), date("firstTrip", "First trip"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const b = tsBounds(x);
        const rows = (await c.query(
          `SELECT coalesce(t.customer_name, '(no customer)') AS customer, count(*)::int AS trips, sum(t.revenue_cents)::float8 AS revenue, sum(t.revenue_cents - coalesce(p.pay,0) - coalesce(t.vehicle_cost_cents,0))::float8 AS margin, avg(t.rating)::float8 AS rating,
                  count(DISTINCT ${dateIn("t.started_at", "$3")})::int AS "activeDays", min(${dateIn("t.started_at", "$3")})::text AS "firstTrip"
           FROM portal_trips t LEFT JOIN LATERAL (SELECT sum(amount_cents) AS pay FROM portal_pay_lines l WHERE l.trip_id = t.id AND l.archived_at IS NULL AND l.approval = 'approved' AND l.kind IN ('earning','addon')) p ON true
           WHERE t.archived_at IS NULL AND t.status = 'completed' AND t.started_at >= ($1::timestamp AT TIME ZONE $3) AND t.started_at < ($2::timestamp AT TIME ZONE $3) AND ($4::uuid[] IS NULL OR t.vehicle_id = ANY($4)) GROUP BY 1`, [b.fromTs, b.toTs, e.tz, e.vehicleIds ?? null])).rows;
        const owed = new Map((await c.query(`SELECT customer_name AS n, round(sum(total) * 100)::float8 AS v FROM invoices WHERE status = 'sent' GROUP BY 1`)).rows.map((r) => [r.n as string, r.v as number]));
        return rows.map((r) => ({ ...r, marginPct: r.revenue > 0 ? round((r.margin / r.revenue) * 100, 1) : null, repeat: r.activeDays > 1 ? 1 : 0, owed: owed.get(r.customer) ?? 0, count: 1 }));
      });
    },
  },
  {
    key: "costs", label: "Costs by type, car and month", requires: MONEY, about: "Every cost in the profit and loss, by type, car and month.",
    columns: [txt("month", "Month"), txt("vehicle", "Car"), txt("category", "Type"), money("amount", "Amount"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const names = new Map((await c.query(`SELECT id, name FROM vehicles`)).rows.map((r) => [r.id as string, r.name as string]));
        const out: Record<string, unknown>[] = [];
        for (const m of monthsOf(x.range.from, x.range.to)) {
          const per = await vehicleMoney(c, { from: m.from > x.range.from ? m.from : x.range.from, to: m.to }, e.tz, { vehicleIds: e.vehicleIds });
          for (const [id, v] of per) {
            const car = id ? names.get(id) ?? "(unknown car)" : "(not tied to a car)";
            for (const [category, key] of [["Fuel", "fuelCents"], ["Repairs and service", "maintenanceCents"], ["Insurance", "insuranceCents"], ["Loan and lease", "financeCents"], ["Tires", "tiresCents"], ["Fines", "ticketsCents"], ["Other", "otherCents"], ["Driver pay", "driverPayCents"]] as const) {
              if (v[key]) out.push({ month: m.month, vehicle: car, category, amount: v[key], count: 1 });
            }
          }
        }
        return out;
      });
    },
  },
  {
    key: "expenses", label: "Expenses (individual lines)", requires: ["finance.view"], about: "Every expense line you entered or imported.",
    columns: [date("date", "Date"), txt("category", "Type"), txt("vendor", "Paid to"), txt("vehicle", "Car"), txt("description", "Note"), money("amount", "Amount"), money("tax", "Tax"), txt("source", "How added"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `SELECT x.spent_on::text AS date, x.category, x.vendor, v.name AS vehicle, x.description, x.amount_cents::float8 AS amount, x.tax_cents::float8 AS tax, x.source, 1 AS count
         FROM finance_expenses x LEFT JOIN vehicles v ON v.id = x.vehicle_id WHERE x.archived_at IS NULL AND x.spent_on BETWEEN $1::date AND $2::date AND ($3::uuid[] IS NULL OR x.vehicle_id = ANY($3)) ORDER BY x.spent_on`, [x.range.from, x.range.to, e.vehicleIds ?? null]).then((r) => r.rows));
    },
  },
  {
    key: "invoices", label: "Invoices", requires: ["finance.view"], about: "Every invoice with how late it is and which aging bucket it falls in today.",
    columns: [txt("number", "Invoice"), txt("customer", "Customer"), txt("status", "Status"), date("issuedOn", "Issued"), date("dueOn", "Due"), num("daysLate", "Days late", "max"), txt("bucket", "Aging"), money("subtotal", "Subtotal"), money("tax", "Tax"), money("total", "Total"), date("paidOn", "Paid on"), count],
    async load(x) {
      return db(x, async (c, e) => (await c.query(
        `SELECT number, customer_name AS customer, CASE WHEN status = 'sent' AND due_on < $3::date THEN 'overdue' ELSE status END AS status, issued_on::text AS "issuedOn", due_on::text AS "dueOn", CASE WHEN status = 'sent' AND due_on < $3::date THEN ($3::date - due_on) END AS "daysLate",
                round(subtotal * 100)::float8 AS subtotal, round(tax * 100)::float8 AS tax, round(total * 100)::float8 AS total, paid_at::date::text AS "paidOn", 1 AS count
         FROM invoices WHERE status <> 'void' AND issued_on BETWEEN $1::date AND $2::date ORDER BY issued_on`, [x.range.from, x.range.to, e.today])).rows.map((r) => ({
        ...r, bucket: r.status === "paid" ? "paid" : r.status === "draft" ? "draft" : r.daysLate == null ? "not due yet" : r.daysLate <= 30 ? "1-30 days late" : r.daysLate <= 60 ? "31-60 days late" : r.daysLate <= 90 ? "61-90 days late" : "over 90 days late" })));
    },
  },
  {
    key: "monthly", label: "Month by month (money and growth)", requires: MONEY, about: "One row per month: revenue, every cost, profit, trips, km, new drivers and new customers.",
    columns: [txt("month", "Month"), money("revenue", "Revenue"), money("driverPay", "Driver pay"), money("fuel", "Fuel"), money("repairs", "Repairs and service"), money("insurance", "Insurance"), money("finance", "Loan and lease"), money("otherCosts", "Tires, fines, other"), money("cost", "Total costs"), money("profit", "Profit"), num("trips", "Trips"), num("km", "km"), num("newDrivers", "New drivers"), num("newCustomers", "New customers"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const out: Record<string, unknown>[] = [];
        for (const m of monthsOf(x.range.from, x.range.to)) {
          const per = [...(await vehicleMoney(c, { from: m.from, to: m.to }, e.tz, { vehicleIds: e.vehicleIds })).values()];
          const t = (k: keyof VehicleMoney) => per.reduce((a, v) => a + (v[k] as number), 0);
          const b = bounds({ from: m.from, to: m.to });
          const nd = Number((await c.query(`SELECT count(*)::int AS n FROM users WHERE role = 'driver' AND created_at >= ($1::timestamp AT TIME ZONE $3) AND created_at < ($2::timestamp AT TIME ZONE $3)`, [b.fromTs, b.toTs, e.tz])).rows[0].n);
          const nc = Number((await c.query(`SELECT count(*)::int AS n FROM (SELECT customer_name, min(started_at) AS first FROM portal_trips WHERE archived_at IS NULL AND customer_name IS NOT NULL GROUP BY 1) x WHERE first >= ($1::timestamp AT TIME ZONE $3) AND first < ($2::timestamp AT TIME ZONE $3)`, [b.fromTs, b.toTs, e.tz])).rows[0].n);
          out.push({ month: m.month, revenue: t("revenueCents"), driverPay: t("driverPayCents"), fuel: t("fuelCents"), repairs: t("maintenanceCents"), insurance: t("insuranceCents"), finance: t("financeCents"), otherCosts: t("tiresCents") + t("ticketsCents") + t("otherCents"), cost: t("costCents"), profit: t("profitCents"),
            trips: t("trips"), km: round(t("distanceM") / 1000, 1), newDrivers: nd, newCustomers: nc, count: 1 });
        }
        return out;
      });
    },
  },
  {
    key: "profitLossLines", label: "Profit and loss, line by line", requires: MONEY, about: "Revenue, each cost and profit as separate lines, for a waterfall.",
    columns: [num("step", "Order", "min"), txt("line", "Line"), money("amount", "Amount"), money("running", "Running total", "max"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const per = [...(await vehicleMoney(c, x.range, e.tz, { vehicleIds: e.vehicleIds })).values()];
        const t = (k: keyof VehicleMoney) => per.reduce((a, v) => a + (v[k] as number), 0);
        const lines: [string, number][] = [["Revenue", t("revenueCents")], ["Driver pay", -t("driverPayCents")], ["Fuel", -t("fuelCents")], ["Repairs and service", -t("maintenanceCents")], ["Insurance", -t("insuranceCents")], ["Loan and lease", -t("financeCents")], ["Tires, fines, other", -(t("tiresCents") + t("ticketsCents") + t("otherCents"))]];
        let run = 0; const out = lines.map(([line, amount], i) => ({ step: i + 1, line, amount, running: (run += amount), count: 1 }));
        out.push({ step: out.length + 1, line: "Profit", amount: t("profitCents"), running: t("profitCents"), count: 1 });
        return out;
      });
    },
  },
  {
    key: "cashForecast", label: "Cash flow forecast", requires: ["finance.view"], about: "The next 13 weeks: expected money in, expected money out, and the running balance of the two.",
    columns: [txt("week", "Week starting"), money("expectedIn", "Expected in"), money("expectedOut", "Expected out"), money("net", "Net"), money("balance", "Running net", "max"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const p = await cashPieces(c, e.tz, e.today, 91);
        const out: Record<string, unknown>[] = []; let bal = 0;
        for (let w = 0; w < 13; w++) {
          const s = shiftDay(e.today, w * 7), end = shiftDay(e.today, w * 7 + 6);
          const inn = p.invoices.filter((i) => (w === 0 ? (i.due ?? e.today) <= end : (i.due ?? e.today) >= s && (i.due ?? e.today) <= end)).reduce((a, i) => a + i.cents, 0);
          const bills = p.bills.filter((b) => b.date >= s && b.date <= end).reduce((a, b) => a + (b.amountCents ?? 0), 0);
          const outv = bills + p.usualDaily * 7 + (w === 0 ? p.owed : 0);
          bal += inn - outv; out.push({ week: s, expectedIn: inn, expectedOut: outv, net: inn - outv, balance: bal, count: 1 });
        }
        return out;
      });
    },
  },
  {
    key: "budgetActual", label: "Budget vs actual", requires: ["finance.view"], about: "For the month of the last date picked: budget, actual, difference and share used per cost type.",
    columns: [txt("category", "Cost type"), money("budget", "Budget"), money("actual", "Actual"), money("difference", "Left (negative = over)"), num("usedPct", "Used (%)", "avg"), txt("state", "State"), count],
    async load(x) {
      return db(x, async (c, e) => (await budgetRows(c, e.tz, e.today, x.range.to.slice(0, 7))).map((r) => ({ category: r.category.replace("_", " "), budget: r.budgetCents, actual: r.actualCents, difference: r.budgetCents == null ? null : r.budgetCents - r.actualCents, usedPct: r.usedPct, state: r.state, count: 1 })));
    },
  },
  {
    key: "taxSummary", label: "Tax summary", requires: ["finance.view"], about: "Tax collected on invoices and tax paid on expenses, by month. For your accountant, not a filing.",
    columns: [txt("month", "Month"), money("sales", "Sales"), money("taxCollected", "Tax collected"), money("spend", "Expenses"), money("taxPaid", "Tax paid"), money("netOwed", "Net tax owed"), count],
    async load(x) {
      return db(x, async (c) => (await taxMonths(c, x.range)).map((m) => ({ month: m.month, sales: m.salesCents, taxCollected: m.taxCollectedCents, spend: m.spendCents, taxPaid: m.taxPaidCents, netOwed: m.netOwedCents, count: 1 })));
    },
  },
  {
    key: "breakEven", label: "Break-even", requires: MONEY, about: "Fixed costs, what each trip leaves after its own costs, and how many trips cover the fixed costs.",
    columns: [num("trips", "Trips", "max"), money("revenue", "Revenue"), money("profit", "Profit", "max"), money("fixedCosts", "Fixed costs", "max"), money("marginPerTrip", "Left per trip", "avg"), num("breakEvenTrips", "Break-even trips", "max"), count],
    async load(x) {
      return db(x, async (c, e) => {
        const per = [...(await vehicleMoney(c, x.range, e.tz, { vehicleIds: e.vehicleIds })).values()];
        const t = (k: keyof VehicleMoney) => per.reduce((a, v) => a + (v[k] as number), 0);
        const trips = t("trips"); const fixed = t("insuranceCents") + t("financeCents");
        const variable = t("driverPayCents") + t("fuelCents") + t("maintenanceCents") + t("tiresCents") + t("ticketsCents") + t("otherCents");
        const perTrip = trips > 0 ? Math.round((t("revenueCents") - variable) / trips) : 0; const revPerTrip = trips > 0 ? Math.round(t("revenueCents") / trips) : 0;
        const be = perTrip > 0 ? Math.ceil(fixed / perTrip) : null;
        const top = Math.max(10, be ? be * 2 : trips * 2); const step = Math.max(1, Math.ceil(top / 20));
        const out: Record<string, unknown>[] = [];
        for (let n = 0; n <= top; n += step) out.push({ trips: n, revenue: n * revPerTrip, profit: n * perTrip - fixed, fixedCosts: fixed, marginPerTrip: perTrip, breakEvenTrips: be, count: 1 });
        return out;
      });
    },
  },
  {
    key: "capacity", label: "Capacity vs demand", requires: ["reports.view"], about: "For each day: jobs asked for, jobs left undone, and the drivers and cars that worked.",
    columns: [date("date", "Date"), num("demand", "Jobs asked for"), num("unmet", "Jobs not done"), num("drivers", "Drivers who worked", "max"), num("cars", "Cars used", "max"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `WITH d AS (SELECT generate_series($1::date, $2::date, interval '1 day')::date AS d)
         SELECT d.d::text AS date,
                (SELECT count(*) FROM jobs j WHERE j.scheduled_date = d.d AND j.status <> 'cancelled')::int AS demand,
                (SELECT count(*) FROM jobs j WHERE j.scheduled_date = d.d AND j.status NOT IN ('completed','done','cancelled') AND (j.driver_id IS NULL OR j.status IN ('failed','unassigned','pending')))::int AS unmet,
                (SELECT count(DISTINCT s.driver_id) FROM shifts s WHERE ${dateIn("s.started_at", "$3")} = d.d)::int AS drivers,
                (SELECT count(DISTINCT t.vehicle_id) FROM portal_trips t WHERE t.archived_at IS NULL AND ${dateIn("t.started_at", "$3")} = d.d AND ($4::uuid[] IS NULL OR t.vehicle_id = ANY($4)))::int AS cars, 1 AS count
         FROM d ORDER BY 1`, [x.range.from, x.range.to, e.tz, e.vehicleIds ?? null]).then((r) => r.rows));
    },
  },
  {
    key: "auditLog", label: "Audit log", requires: ["audit.view"], about: "Who changed what and when, with the old and new value. Sensitive values are hidden.",
    columns: [ts("time", "When"), txt("user", "Who"), txt("action", "Action"), txt("entity", "Item type"), txt("item", "Item"), txt("oldValue", "Old value"), txt("newValue", "New value"), count],
    async load(x) {
      return db(x, (c, e) => c.query(
        `SELECT a.at AS time, coalesce(a.actor_label, '(system)') AS "user", a.action, a.entity, a.item_label AS item,
                CASE WHEN a.sensitive THEN '(hidden)' ELSE left(a.old_value::text, 400) END AS "oldValue", CASE WHEN a.sensitive THEN '(hidden)' ELSE left(a.new_value::text, 400) END AS "newValue", 1 AS count
         FROM audit_log a WHERE ${dateIn("a.at", "$3")} BETWEEN $1::date AND $2::date ORDER BY a.at DESC LIMIT 5000`, [x.range.from, x.range.to, e.tz]).then((r) => r.rows.map((a) => ({ ...a, time: iso(a.time) }))));
    },
  },
];
