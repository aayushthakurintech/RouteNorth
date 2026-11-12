import type { pg } from "@routenorth/db";
import { hoursReport } from "@routenorth/shared";
import { loadDrivers, loadSettings } from "../portal/drivers.service.js";
import { budgetRows } from "../portal/finance.service.js";
import { shiftDay, vehicleMoney } from "../portal/money-rules.js";
import { loadVehicles } from "../portal/vehicles.service.js";
import type { Candidate, Evaluator, Severity } from "./engine.js";
import { MEASURE_BY_KEY, readMeasure, weekStart } from "./measures.js";

/**
 * The alerts of the Owner Portal spec: vehicle, driver, pay and money rules, plus the owner's own "when [measure] is above/below [value]" rules.
 * Every rule here only looks and lists what matches right now; the engine does the grouping, quiet hours, repeats and sending.
 */
const num = (v: unknown, d: number, lo = 0, hi = 1e9) => { const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const daysFrom = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? "" : "s"}`;
/** 30 days out is a heads-up, 14 days a warning, 7 days or expired is critical: the 30, 14, 7 steps of the spec. */
export const docSeverity = (left: number): Severity => (left <= 7 ? "critical" : left <= 14 ? "warn" : "info");
const when = (left: number) => (left < 0 ? `expired ${plural(-left, "day")} ago` : left === 0 ? "expires today" : `expires in ${plural(left, "day")}`);
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export const PORTAL_EVALUATORS: Record<string, Evaluator> = {
  // ---- cars -----------------------------------------------------------------------------------------------------------------
  vehicle_docs: {
    resolves: true,
    async run(c, p, e) {
      const days = num(p.days, 30, 0, 365);
      const rows = (await c.query(
        `SELECT d.id, d.kind, d.expires_on::text AS "expiresOn", v.id AS vid, v.name FROM documents d JOIN vehicles v ON v.id = d.owner_id
         WHERE d.owner_kind = 'vehicle' AND d.archived_at IS NULL AND v.archived_at IS NULL AND d.expires_on IS NOT NULL AND d.expires_on <= $1::date + $2::int ORDER BY d.expires_on`, [e.today, days])).rows;
      const ins = (await c.query(
        `SELECT v.id AS vid, v.name, v.insurance_expiry::text AS "expiresOn" FROM vehicles v WHERE v.archived_at IS NULL AND v.insurance_expiry IS NOT NULL AND v.insurance_expiry <= $1::date + $2::int
           AND NOT EXISTS (SELECT 1 FROM documents d WHERE d.owner_kind = 'vehicle' AND d.owner_id = v.id AND d.archived_at IS NULL AND d.kind ~* 'insur')`, [e.today, days])).rows;
      const out: Candidate[] = [];
      for (const r of [...rows.map((x) => ({ ...x, key: `vdoc:${x.id}`, what: x.kind })), ...ins.map((x) => ({ ...x, key: `vins:${x.vid}`, what: "insurance" }))]) {
        const left = daysFrom(e.today, r.expiresOn);
        out.push({ key: r.key, title: `${r.name}: ${r.what} ${when(left)}`, detail: { expiresOn: r.expiresOn, daysLeft: left, document: r.what, href: `/owner/vehicles/${r.vid}` }, subjectKind: "vehicle", subjectId: r.vid, severity: docSeverity(left) });
      }
      return out;
    },
  },
  service_due: {
    resolves: true,
    async run(c, p, e) {
      const days = num(p.days, 14, 0, 365), km = num(p.km, 500, 0, 100_000);
      const out: Candidate[] = [];
      for (const v of await loadVehicles(c, e)) {
        const s = v.service;
        if (s.state === "none" || s.state === "ok" && !((s.daysLeft != null && s.daysLeft <= days) || (s.kmLeft != null && s.kmLeft <= km))) continue;
        const overdue = s.state === "overdue";
        const left = s.dueBy === "km" && s.kmLeft != null ? `${Math.abs(Math.round(s.kmLeft))} km` : s.daysLeft != null ? plural(Math.abs(s.daysLeft), "day") : "";
        out.push({ key: `svc:${v.id}`, title: `${v.name}: ${s.task ?? "service"} ${overdue ? `is overdue by ${left}` : `is due in ${left}`}`, detail: { task: s.task, daysLeft: s.daysLeft, kmLeft: s.kmLeft, dueBy: s.dueBy, href: `/owner/vehicles/${v.id}` }, subjectKind: "vehicle", subjectId: v.id, severity: overdue ? "critical" : "warn" });
      }
      return out;
    },
  },
  inspection_failed: {
    resolves: true,
    async run(c) {
      const rows = (await c.query(
        `SELECT DISTINCT ON (i.vehicle_id) i.id, i.vehicle_id AS vid, i.at, v.name, i.notes FROM inspections i JOIN vehicles v ON v.id = i.vehicle_id
         WHERE i.archived_at IS NULL AND i.defects AND i.signed_off_at IS NULL AND v.archived_at IS NULL ORDER BY i.vehicle_id, i.at DESC`)).rows;
      return rows.map((r) => ({ key: `insp:${r.vid}`, title: `${r.name} failed an inspection that nobody has signed off. It cannot take new jobs until it is.`, detail: { at: r.at, notes: r.notes, href: `/owner/vehicles/${r.vid}` }, subjectKind: "vehicle", subjectId: r.vid, severity: "critical" as const }));
    },
  },
  vehicle_idle: {
    resolves: true,
    async run(c, p, e) {
      const dflt = num(p.days, 3, 1, 365);
      const own = new Map((await c.query(`SELECT id, idle_alert_days FROM vehicles WHERE idle_alert_days IS NOT NULL`)).rows.map((r) => [r.id as string, r.idle_alert_days as number]));
      const out: Candidate[] = [];
      for (const v of await loadVehicles(c, e)) {
        if (["in_service", "out_of_service", "sold", "archived", "on_trip"].includes(v.status) || !v.lastActivity) continue;
        const idle = Math.floor((e.now.getTime() - Date.parse(v.lastActivity)) / 86_400_000);
        const limit = own.get(v.id) ?? dflt;
        if (idle > limit) out.push({ key: `idle:${v.id}`, title: `${v.name} has not moved or finished a trip for ${plural(idle, "day")}`, detail: { idleDays: idle, limit, href: `/owner/vehicles/${v.id}` }, subjectKind: "vehicle", subjectId: v.id });
      }
      return out;
    },
  },
  fuel_above_normal: {
    resolves: true,
    async run(c, p, e) {
      const pct = num(p.pct, 20, 1, 500), fresh = num(p.freshDays, 14, 1, 90);
      const rows = (await c.query(
        `SELECT f.id, f.vehicle_id AS vid, v.name, f.filled_on::text AS "on", f.litres, f.odometer_km AS odo FROM fuel_logs f JOIN vehicles v ON v.id = f.vehicle_id
         WHERE f.archived_at IS NULL AND f.unit = 'L' AND f.odometer_km IS NOT NULL AND v.archived_at IS NULL AND f.filled_on >= $1::date - 365 ORDER BY f.vehicle_id, f.odometer_km, f.filled_on`, [e.today])).rows;
      const by = new Map<string, typeof rows>();
      for (const r of rows) (by.get(r.vid) ?? by.set(r.vid, []).get(r.vid)!).push(r);
      const out: Candidate[] = [];
      for (const [vid, fills] of by) {
        // Litres put in at fill N cover the distance since fill N-1 (a full tank each time).
        const legs = fills.slice(1).map((f, i) => ({ on: f.on as string, per100: f.odo > fills[i]!.odo ? (f.litres / (f.odo - fills[i]!.odo)) * 100 : null })).filter((l) => l.per100 != null && l.per100 > 0 && l.per100 < 200) as { on: string; per100: number }[];
        if (legs.length < 4) continue;
        const latest = legs[legs.length - 1]!, before = legs.slice(Math.max(0, legs.length - 7), -1);
        const usual = before.reduce((a, l) => a + l.per100, 0) / before.length;
        if (daysFrom(latest.on, e.today) > fresh) continue;
        const over = ((latest.per100 - usual) / usual) * 100;
        if (over > pct) out.push({ key: `fuel:${vid}`, title: `${fills[0]!.name} used ${Math.round(over)}% more fuel than usual on its last fill (${latest.per100.toFixed(1)} against ${usual.toFixed(1)} L per 100 km)`, detail: { latestPer100: Math.round(latest.per100 * 10) / 10, usualPer100: Math.round(usual * 10) / 10, overPct: Math.round(over), href: `/owner/vehicles/${vid}` }, subjectKind: "vehicle", subjectId: vid });
      }
      return out;
    },
  },
  repair_over_budget: {
    resolves: true,
    async run(c, _p, e) {
      const month = e.today.slice(0, 7);
      const row = (await budgetRows(c, e.tz, e.today, month)).find((r) => r.category === "maintenance");
      if (!row || row.budgetCents == null || row.actualCents <= row.budgetCents) return [];
      return [{ key: `repairs:${month}`, title: `Repairs and maintenance are over budget this month: ${money(row.actualCents)} spent of ${money(row.budgetCents)}`, detail: { spentCents: row.actualCents, budgetCents: row.budgetCents, usedPct: row.usedPct, href: "/owner/finance/budget" }, subjectKind: "budget", subjectId: "maintenance", severity: "warn" }];
    },
  },

  // ---- drivers --------------------------------------------------------------------------------------------------------------
  driver_docs: {
    resolves: true,
    async run(c, p, e) {
      const days = num(p.days, 30, 0, 365);
      const docs = (await c.query(
        `SELECT d.id, d.kind, d.expires_on::text AS "expiresOn", u.id AS uid, coalesce(u.display_name, u.email) AS name FROM documents d JOIN users u ON u.id = d.owner_id AND d.owner_kind = 'driver'
         WHERE d.archived_at IS NULL AND u.disabled_at IS NULL AND d.expires_on IS NOT NULL AND d.expires_on <= $1::date + $2::int ORDER BY d.expires_on`, [e.today, days])).rows;
      const lic = (await c.query(
        `SELECT dp.user_id AS uid, coalesce(u.display_name, u.email) AS name, dp.license_expiry::text AS "expiresOn" FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
         WHERE dp.license_expiry IS NOT NULL AND u.disabled_at IS NULL AND dp.archived_at IS NULL AND dp.license_expiry <= $1::date + $2::int`, [e.today, days])).rows;
      const out: Candidate[] = [];
      for (const r of [...docs.map((x) => ({ ...x, key: `ddoc:${x.id}`, what: x.kind as string })), ...lic.map((x) => ({ ...x, key: `dlic:${x.uid}`, what: "driver's licence" }))]) {
        const left = daysFrom(e.today, r.expiresOn);
        out.push({ key: r.key, title: `${r.name}: ${r.what} ${when(left)}`, detail: { expiresOn: r.expiresOn, daysLeft: left, document: r.what, href: `/owner/drivers/${r.uid}` }, subjectKind: "driver", subjectId: r.uid, severity: docSeverity(left) });
      }
      return out;
    },
  },
  driver_safety_low: {
    resolves: true,
    async run(c, p, e) {
      const below = num(p.below, 70, 1, 100);
      return (await loadDrivers(c, e, { applicants: false })).filter((d) => !d.archivedAt && d.status !== "suspended" && d.safety != null && d.safety < below)
        .map((d) => ({ key: `safety:${d.id}`, title: `${d.name}'s safety score is ${Math.round(d.safety!)}, below ${below}`, detail: { safety: d.safety, below, href: `/owner/drivers/${d.id}` }, subjectKind: "driver", subjectId: d.id, severity: d.safety! < below - 20 ? "critical" as const : "warn" as const }));
    },
  },
  driver_rating_low: {
    resolves: true,
    async run(c, p, e) {
      const below = num(p.below, 4.2, 1, 5), complaintDays = num(p.complaintDays, 7, 0, 90);
      const out: Candidate[] = (await loadDrivers(c, e, { applicants: false })).filter((d) => !d.archivedAt && d.status !== "suspended" && d.rating != null && d.rating < below)
        .map((d) => ({ key: `rating:${d.id}`, title: `${d.name}'s rating is ${d.rating!.toFixed(1)}, below ${below}`, detail: { rating: d.rating, below, href: `/owner/drivers/${d.id}` }, subjectKind: "driver", subjectId: d.id }));
      if (complaintDays > 0) {
        for (const r of (await c.query(
          `SELECT t.id, t.driver_id AS uid, t.complaint, t.customer_name AS customer, coalesce(u.display_name, u.email) AS name FROM portal_trips t JOIN users u ON u.id = t.driver_id
           WHERE t.archived_at IS NULL AND t.complaint IS NOT NULL AND t.complaint <> '' AND t.started_at >= now() - make_interval(days => $1) ORDER BY t.started_at DESC LIMIT 50`, [complaintDays])).rows) {
          out.push({ key: `complaint:${r.id}`, title: `New complaint about ${r.name}${r.customer ? ` from ${r.customer}` : ""}: ${String(r.complaint).slice(0, 120)}`, detail: { complaint: r.complaint, href: `/owner/drivers/${r.uid}` }, subjectKind: "driver", subjectId: r.uid });
        }
      }
      return out;
    },
  },
  driver_overtime: {
    resolves: true,
    async run(c, p, e) {
      const st = await loadSettings(c);
      const limit = p.hours == null || p.hours === "" ? st.hours.overtimeWeeklyHours : num(p.hours, st.hours.overtimeWeeklyHours, 1, 168);
      const rows = (await c.query(
        `SELECT s.driver_id AS did, coalesce(u.display_name, u.email) AS name, s.started_at AS "startedAt", s.ended_at AS "endedAt",
                coalesce((SELECT sum(extract(epoch FROM (coalesce(b.ended_at, now()) - b.started_at)) / 60) FROM shift_breaks b WHERE b.shift_id = s.id), 0)::float8 AS "breakMinutes"
         FROM shifts s JOIN users u ON u.id = s.driver_id WHERE s.started_at >= now() - interval '10 days' ORDER BY s.started_at`)).rows;
      const by = new Map<string, typeof rows>();
      for (const r of rows) (by.get(r.did) ?? by.set(r.did, []).get(r.did)!).push(r);
      const week = weekStart(e.today), out: Candidate[] = [];
      for (const [did, list] of by) {
        const h = hoursReport(list, { ...st.hours, overtimeWeeklyHours: limit }, e.now, e.tz).weeks.find((w) => w.weekStart === week)?.hours ?? 0;
        if (h > limit) out.push({ key: `overtime:${did}:${week}`, title: `${list[0]!.name} has worked ${h} hours this week, over the ${limit} hour limit`, detail: { hours: h, limit, weekStart: week, href: `/owner/drivers/${did}` }, subjectKind: "driver", subjectId: did });
      }
      return out;
    },
  },
  driver_inactive: {
    resolves: true,
    async run(c, p, e) {
      const days = num(p.days, 14, 1, 365);
      const rows = (await c.query(
        `SELECT u.id, coalesce(u.display_name, u.email) AS name, greatest(t.t, s.t, u.created_at) AS last FROM users u JOIN driver_profiles dp ON dp.user_id = u.id
           LEFT JOIN LATERAL (SELECT max(started_at) AS t FROM portal_trips WHERE driver_id = u.id AND archived_at IS NULL) t ON true
           LEFT JOIN LATERAL (SELECT max(started_at) AS t FROM shifts WHERE driver_id = u.id) s ON true
         WHERE u.role = 'driver' AND u.disabled_at IS NULL AND dp.archived_at IS NULL AND dp.status = 'active' AND greatest(t.t, s.t, u.created_at) < now() - make_interval(days => $1)`, [days])).rows;
      return rows.map((r) => ({ key: `inactive:${r.id}`, title: `${r.name} has had no trips or shifts for ${plural(Math.floor((e.now.getTime() - new Date(r.last).getTime()) / 86_400_000), "day")}`, detail: { lastActive: r.last, days, href: `/owner/drivers/${r.id}` }, subjectKind: "driver", subjectId: r.id }));
    },
  },
  driver_cancellations: {
    resolves: true,
    async run(c, p) {
      const st = await loadSettings(c);
      const pct = num(p.pct, st.cancellationAlertPct, 1, 100), min = num(p.minTrips, 5, 1, 1000), days = num(p.days, 30, 1, 365);
      const rows = (await c.query(
        `SELECT t.driver_id AS id, coalesce(u.display_name, u.email) AS name, count(*)::int AS n, count(*) FILTER (WHERE t.status IN ('cancelled','no_show'))::int AS bad
         FROM portal_trips t JOIN users u ON u.id = t.driver_id WHERE t.archived_at IS NULL AND t.driver_id IS NOT NULL AND t.started_at >= now() - make_interval(days => $1) GROUP BY 1, 2
         HAVING count(*) >= $2 AND count(*) FILTER (WHERE t.status IN ('cancelled','no_show')) * 100.0 / count(*) > $3`, [days, min, pct])).rows;
      return rows.map((r) => ({ key: `cancel:${r.id}`, title: `${r.name} cancelled or missed ${r.bad} of ${r.n} trips (${Math.round((r.bad / r.n) * 100)}%) in the last ${days} days`, detail: { trips: r.n, cancelled: r.bad, pct, href: `/owner/drivers/${r.id}` }, subjectKind: "driver", subjectId: r.id }));
    },
  },
  driver_stuck_onboarding: {
    resolves: true,
    async run(c, p, e) {
      const days = num(p.days, (await loadSettings(c)).stuckOnboardingDays, 1, 365);
      return (await loadDrivers(c, e, { applicants: false })).filter((d) => d.status === "onboarding" && !d.archivedAt && e.now.getTime() - Date.parse(d.createdAt) > days * 86_400_000)
        .map((d) => ({ key: `onboarding:${d.id}`, title: `${d.name} has been in onboarding for more than ${plural(days, "day")} (${d.onboarding.done} of ${d.onboarding.total} steps done)`, detail: { done: d.onboarding.done, total: d.onboarding.total, open: d.onboarding.requiredOpen, href: `/owner/drivers/${d.id}` }, subjectKind: "driver", subjectId: d.id }));
    },
  },

  // ---- pay ------------------------------------------------------------------------------------------------------------------
  payout_waiting: {
    resolves: true,
    async run(c, p, e) {
      const before = num(p.daysBefore, 1, 0, 14);
      // Pay day is the day after a run's last day. The alert starts the day before pay day, and turns critical once pay day has passed.
      const rows = (await c.query(
        `SELECT r.id, r.from_date::text AS "from", r.to_date::text AS "to", count(p.id)::int AS n, coalesce(sum(p.net_cents),0)::float8 AS net
         FROM portal_payout_runs r JOIN portal_payouts p ON p.run_id = r.id WHERE r.status <> 'cancelled' AND p.status = 'draft' GROUP BY r.id`)).rows;
      const out: Candidate[] = [];
      for (const r of rows) {
        const payDay = shiftDay(r.to, 1);
        if (e.today < shiftDay(payDay, -before)) continue;
        out.push({ key: `payrun:${r.id}`, title: `${plural(r.n, "payout")} (${money(r.net)}) for ${r.from} to ${r.to} ${e.today > payDay ? "should already have been approved" : "wait for approval"}`, detail: { runId: r.id, payDay, payouts: r.n, netCents: r.net, href: `/owner/pay-rates/runs/${r.id}` }, subjectKind: "payout_run", subjectId: r.id, severity: e.today > payDay ? "critical" : "warn" });
      }
      return out;
    },
  },
  trip_pay_off: {
    resolves: true,
    async run(c, p) {
      const pct = num(p.pct, 40, 1, 1000), min = num(p.minTrips, 5, 2, 1000), history = num(p.historyDays, 90, 7, 365), look = num(p.lookbackDays, 7, 1, 60);
      const rows = (await c.query(
        `WITH t AS (
           SELECT t.id, t.driver_id, coalesce(r.name, t.zone, t.customer_name) AS grp, t.started_at, coalesce(t.title, t.customer_name, 'Trip') AS title,
                  coalesce((SELECT sum(amount_cents) FROM portal_pay_lines l WHERE l.trip_id = t.id AND l.archived_at IS NULL AND l.approval = 'approved' AND l.kind IN ('earning','addon')), 0)::float8 AS pay
           FROM portal_trips t LEFT JOIN routes r ON r.id = t.route_id WHERE t.archived_at IS NULL AND t.status = 'completed' AND t.driver_id IS NOT NULL AND t.started_at >= now() - make_interval(days => $1)),
         usual AS (SELECT grp, percentile_cont(0.5) WITHIN GROUP (ORDER BY pay) AS usual, count(*) AS n FROM t WHERE grp IS NOT NULL GROUP BY grp HAVING count(*) >= $2)
         SELECT t.id, t.title, t.grp, t.pay, usual.usual::float8 AS usual, coalesce(u.display_name, u.email) AS driver FROM t JOIN usual USING (grp) JOIN users u ON u.id = t.driver_id
         WHERE t.started_at >= now() - make_interval(days => $3) AND usual.usual > 0 AND abs(t.pay - usual.usual) * 100 > usual.usual * $4 ORDER BY t.started_at DESC LIMIT 100`, [history, min, look, pct])).rows;
      return rows.map((r) => {
        const off = Math.round(((r.pay - r.usual) / r.usual) * 100);
        return { key: `paytrip:${r.id}`, title: `${r.driver}'s pay for "${r.title}" is ${money(r.pay)}, ${Math.abs(off)}% ${off > 0 ? "above" : "below"} the usual ${money(r.usual)} for ${r.grp}`, detail: { tripId: r.id, payCents: r.pay, usualCents: r.usual, offPct: off, group: r.grp, href: "/owner/trips" }, subjectKind: "trip", subjectId: r.id };
      });
    },
  },
  dispute_open: {
    resolves: true,
    async run(c, p, e) {
      const days = num(p.days, 3, 1, 60);
      const rows = (await c.query(
        `SELECT d.id, d.message, d.created_at, d.driver_id AS uid, coalesce(u.display_name, u.email) AS name FROM portal_disputes d JOIN users u ON u.id = d.driver_id
         WHERE d.status = 'open' AND d.created_at < now() - make_interval(days => $1) ORDER BY d.created_at`, [days])).rows;
      return rows.map((r) => {
        const waited = Math.floor((e.now.getTime() - new Date(r.created_at).getTime()) / 86_400_000);
        return { key: `dispute:${r.id}`, title: `${r.name} has waited ${plural(waited, "day")} for a reply about their pay: "${String(r.message).slice(0, 100)}"`, detail: { waitedDays: waited, href: "/owner/pay-rates" }, subjectKind: "driver", subjectId: r.uid, severity: waited >= days * 2 ? "critical" as const : "warn" as const };
      });
    },
  },

  // ---- money ----------------------------------------------------------------------------------------------------------------
  losing_money: {
    resolves: true,
    async run(c, p, e) {
      const days = num(p.tripDays, 7, 1, 90);
      const monthStart = `${e.today.slice(0, 8)}01`;
      const out: Candidate[] = [];
      const names = new Map((await c.query(`SELECT id, name FROM vehicles`)).rows.map((r) => [r.id as string, r.name as string]));
      // The same test as the dashboard's "Cars losing money this month".
      for (const [id, m] of await vehicleMoney(c, { from: monthStart, to: e.today }, e.tz)) {
        if (id && m.profitCents < 0 && (m.revenueCents > 0 || m.costCents > 0)) out.push({ key: `losscar:${id}`, title: `${names.get(id) ?? "A car"} is losing money this month: ${money(m.revenueCents)} in, ${money(m.costCents)} out`, detail: { revenueCents: m.revenueCents, costCents: m.costCents, profitCents: m.profitCents, href: `/owner/vehicles/${id}` }, subjectKind: "vehicle", subjectId: id });
      }
      const trips = (await c.query(
        `SELECT * FROM (SELECT t.id, coalesce(t.title, t.customer_name, 'Trip') AS title, t.revenue_cents::float8 AS rev, coalesce(sum(l.amount_cents), 0)::float8 AS pay
           FROM portal_trips t LEFT JOIN portal_pay_lines l ON l.trip_id = t.id AND l.archived_at IS NULL AND l.approval = 'approved' AND l.kind IN ('earning','addon')
           WHERE t.archived_at IS NULL AND t.status = 'completed' AND t.revenue_cents > 0 AND t.started_at >= now() - make_interval(days => $1) GROUP BY t.id) x WHERE pay > rev ORDER BY pay - rev DESC LIMIT 50`, [days])).rows;
      for (const t of trips) out.push({ key: `losstrip:${t.id}`, title: `"${t.title}" lost money: ${money(t.rev)} charged, ${money(t.pay)} paid to the driver`, detail: { revenueCents: t.rev, driverPayCents: t.pay, href: "/owner/trips" }, subjectKind: "trip", subjectId: t.id });
      return out;
    },
  },
  invoice_overdue: {
    resolves: true,
    async run(c, p, e) {
      const late = num(p.daysLate, 1, 0, 365);
      const rows = (await c.query(
        `SELECT id, number, customer_name AS customer, due_on::text AS due, round(total * 100)::float8 AS cents FROM invoices WHERE status = 'sent' AND due_on IS NOT NULL AND due_on <= $1::date - $2::int ORDER BY due_on`, [e.today, late])).rows;
      return rows.map((r) => {
        const n = daysFrom(r.due, e.today);
        return { key: `invoice:${r.id}`, title: `Invoice ${r.number}${r.customer ? ` for ${r.customer}` : ""} (${money(r.cents)}) is ${plural(n, "day")} late`, detail: { number: r.number, daysLate: n, totalCents: r.cents, href: "/owner/finance/invoices" }, subjectKind: "invoice", subjectId: r.id, severity: n >= 30 ? "critical" as const : "warn" as const };
      });
    },
  },
  portal_budget: {
    resolves: true,
    async run(c, p, e) {
      const pct = num(p.pct, 90, 1, 500), month = e.today.slice(0, 7);
      return (await budgetRows(c, e.tz, e.today, month)).filter((r) => r.budgetCents != null && r.usedPct != null && r.usedPct >= pct)
        .map((r) => ({ key: `pbudget:${r.category}:${month}`, title: `${r.category.replace(/_/g, " ")} has used ${r.usedPct}% of its budget this month (${money(r.actualCents)} of ${money(r.budgetCents!)})`, detail: { category: r.category, usedPct: r.usedPct, spentCents: r.actualCents, budgetCents: r.budgetCents, href: "/owner/finance/budget" }, subjectKind: "budget", subjectId: r.category, severity: r.usedPct! >= 100 ? "critical" as const : "warn" as const }));
    },
  },

  // ---- the owner's own rules ---------------------------------------------------------------------------------------------------
  custom_measure: {
    resolves: true,
    async run(c, p, e) {
      const key = String(p.measure ?? ""), m = MEASURE_BY_KEY.get(key);
      if (!m) return [];
      const op = p.op === "lt" ? "lt" : "gt", value = Number(p.value);
      if (!Number.isFinite(value)) return [];
      const scope = typeof p.scopeId === "string" && /^[0-9a-f-]{36}$/i.test(p.scopeId) ? p.scopeId : null;
      const unit = m.unit === "money" ? "$" : m.unit === "pct" ? "%" : "";
      const out: Candidate[] = [];
      for (const r of await readMeasure(c, key, e, scope)) {
        if (r.value == null || !(op === "gt" ? r.value > value : r.value < value)) continue;
        out.push({ key: `custom:${key}:${r.id ?? "company"}`, title: `${r.name}: ${m.label.toLowerCase()} is ${unit === "$" ? "$" : ""}${r.value}${unit === "%" ? "%" : ""}, ${op === "gt" ? "above" : "below"} ${unit === "$" ? "$" : ""}${value}${unit === "%" ? "%" : ""}`, detail: { measure: key, value: r.value, threshold: value, op, href: m.subject === "vehicle" ? `/owner/vehicles/${r.id}` : m.subject === "driver" ? `/owner/drivers/${r.id}` : "/owner" }, subjectKind: m.subject === "company" ? "company" : m.subject, subjectId: r.id ?? undefined });
      }
      return out;
    },
  },
};

