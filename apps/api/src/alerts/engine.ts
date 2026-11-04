import { pg, withOrg } from "@routenorth/db";
import { anomaly, daysToExpiry, detectCrash, detectSafetyEvents, distanceToPath, documentState, inQuietHours, maintenanceDue, type Fix } from "@routenorth/shared";
import { minutesSinceBreak } from "../driver/shifts.js";
import { fatigueOf } from "../smart/fatigue.js";
import { withDefaults } from "../org/settings.js";
import { budgetRows } from "../business/money.js";
import { breakdown, METRICS, summarize, type AnalyticsService } from "../analytics/analytics.service.js";
import { deliver, type Endpoint, type Providers } from "../notify/notifier.js";
import { emit } from "../automation/events.js";
import { notifyPeople, type Item } from "./delivery.js";
import { PORTAL_EVALUATORS } from "./portal-rules.js";
import { ensureDefaultRules } from "./defaults.js";
import { sendPersonalDigests } from "./digest.js";
import { runAutomations } from "../portal/automations.js";

/**
 * Alert rules: "if this happens, tell these people". Each kind of rule looks at the live data and lists the things that match
 * right now. The engine then groups repeats, respects quiet hours, resolves alerts whose cause has gone away, and sends them.
 */
export type RuleKind = "late_risk" | "off_route" | "long_idle" | "speeding" | "geofence" | "offline" | "harsh_driving" | "document_expiry" | "maintenance_due" | "cost_anomaly" | "custom_metric" | "needs_break" | "help_request" | "fatigue" | "checkin_missed" | "crash" | "budget"
  | "vehicle_docs" | "service_due" | "inspection_failed" | "vehicle_idle" | "fuel_above_normal" | "repair_over_budget"
  | "driver_docs" | "driver_safety_low" | "driver_rating_low" | "driver_overtime" | "driver_inactive" | "driver_cancellations" | "driver_stuck_onboarding"
  | "payout_waiting" | "trip_pay_off" | "dispute_open" | "losing_money" | "invoice_overdue" | "portal_budget" | "custom_measure";
export type Severity = "info" | "warn" | "critical";
export interface Rule { id: string; name: string; kind: RuleKind; params: Record<string, unknown>; severity: Severity; endpointIds: string[]; quietStart: string | null; quietEnd: string | null; groupMinutes: number; repeatMinutes: number; recipientIds: string[]; area: string | null }
/** `severity` lets one rule raise alerts of different weight (a document 30 days out is Info, 7 days out is Critical). */
export interface Candidate { key: string; title: string; detail: Record<string, unknown>; subjectKind?: string; subjectId?: string; severity?: Severity }
export interface Env { orgId: string; today: string; tz: string; svc: AnalyticsService; now: Date }
export type Evaluator = { /** Alerts about a state (like "offline") end when the state ends; alerts about an event (like "entered a zone") do not. */ resolves: boolean; run: (c: pg.PoolClient, p: Record<string, unknown>, e: Env) => Promise<Candidate[]> };
const RANK: Record<Severity, number> = { info: 0, warn: 1, critical: 2 };

const num = (v: unknown, d: number, lo = 0, hi = 1e9) => { const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

const LEGACY_EVALUATORS: Record<string, Evaluator> = {
  late_risk: {
    resolves: true,
    async run(c, p) {
      const mins = num(p.minutes, 15, 0, 240);
      const rows = (await c.query(
        `SELECT s.id, s.name, s.window_end AS "windowEnd", r.name AS route, coalesce(u.display_name, u.email) AS driver
         FROM stops s JOIN routes r ON r.id = s.route_id AND r.status = 'in_progress' LEFT JOIN users u ON u.id = r.driver_id
         WHERE s.status = 'pending' AND s.window_end IS NOT NULL AND s.window_end < now() + make_interval(mins => $1) ORDER BY s.window_end LIMIT 100`, [mins])).rows;
      return rows.map((r) => ({ key: `late:${r.id}`, title: `${r.name} may miss its time window`, detail: { route: r.route, driver: r.driver, windowEnd: r.windowEnd, overdue: new Date(r.windowEnd) < new Date() }, subjectKind: "stop", subjectId: r.id }));
    },
  },
  off_route: {
    resolves: true,
    async run(c, p) {
      const metres = num(p.meters, 2000, 100, 100_000);
      const routes = (await c.query(
        `SELECT r.id, r.name, v.name AS vehicle, lp.lat, lp.lng FROM routes r JOIN vehicles v ON v.id = r.vehicle_id JOIN devices d ON d.vehicle_id = v.id
         JOIN latest_positions lp ON lp.device_id = d.id WHERE r.status = 'in_progress' AND lp.time > now() - interval '10 minutes'`)).rows;
      const out: Candidate[] = [];
      for (const r of routes) {
        const path = (await c.query("SELECT lat, lng FROM stops WHERE route_id = $1 ORDER BY sequence", [r.id])).rows;
        const dist = distanceToPath(r.lat, r.lng, path);
        if (Number.isFinite(dist) && dist > metres) out.push({ key: `off:${r.id}`, title: `${r.vehicle} is off its route`, detail: { route: r.name, metresFromPath: Math.round(dist) }, subjectKind: "route", subjectId: r.id });
      }
      return out;
    },
  },
  needs_break: {
    resolves: true,
    async run(c, p) {
      const after = num(p.afterHours, 5, 1, 12) * 60;
      const shifts = (await c.query(
        `SELECT s.id, s.driver_id, s.started_at, coalesce(u.display_name, u.email) AS name FROM shifts s JOIN users u ON u.id = s.driver_id WHERE s.ended_at IS NULL`)).rows;
      const out: Candidate[] = [];
      for (const s of shifts) {
        const breaks = (await c.query("SELECT started_at, ended_at FROM shift_breaks WHERE shift_id = $1", [s.id])).rows.map((b) => ({ startedAt: b.started_at as Date, endedAt: b.ended_at as Date | null }));
        const since = minutesSinceBreak({ startedAt: s.started_at, breaks });
        if (since >= after) out.push({ key: `break:${s.driver_id}`, title: `${s.name} has worked ${(since / 60).toFixed(1)} hours without a break`, detail: { minutesWithoutBreak: since }, subjectKind: "driver", subjectId: s.driver_id });
      }
      return out;
    },
  },
  help_request: {
    resolves: true,
    async run(c) {
      const rows = (await c.query(
        `SELECT h.id, h.kind, h.note, h.driver_id, coalesce(u.display_name, u.email) AS name FROM help_requests h JOIN users u ON u.id = h.driver_id WHERE h.status <> 'resolved' ORDER BY h.created_at LIMIT 50`)).rows;
      return rows.map((r) => ({ key: `helpreq:${r.id}`, title: `${r.name} needs help: ${String(r.kind).replace(/_/g, " ")}`, detail: { note: r.note }, subjectKind: "driver", subjectId: r.driver_id }));
    },
  },
  fatigue: {
    resolves: true,
    async run(c) {
      const lim = withDefaults((await c.query("SELECT settings FROM organizations LIMIT 1")).rows[0]?.settings).safety;
      const open = (await c.query("SELECT s.driver_id, coalesce(u.display_name, u.email) AS name FROM shifts s JOIN users u ON u.id = s.driver_id WHERE s.ended_at IS NULL")).rows;
      const out: Candidate[] = [];
      for (const o of open) {
        const f = await fatigueOf(c, o.driver_id, lim);
        if (f.level !== "ok") out.push({ key: `fatigue:${o.driver_id}:${f.level}`, title: `${o.name} ${f.level === "now" ? "should stop and rest" : "is getting tired"}: ${(f.sinceBreakMin / 60).toFixed(1)} h since a break, ${(f.shiftMin / 60).toFixed(1)} h on shift`, detail: { ...f }, subjectKind: "driver", subjectId: o.driver_id });
      }
      return out;
    },
  },
  checkin_missed: {
    resolves: true,
    async run(c) {
      const grace = withDefaults((await c.query("SELECT settings FROM organizations LIMIT 1")).rows[0]?.settings).safety.checkinGraceMin;
      const rows = (await c.query(
        `SELECT k.id, k.user_id, k.last_ok_at, k.every_min, k.lat, k.lng, coalesce(u.display_name, u.email) AS name FROM checkins k JOIN users u ON u.id = k.user_id
         WHERE k.ended_at IS NULL AND k.last_ok_at + make_interval(mins => k.every_min + $1::int) < now()`, [grace])).rows;
      return rows.map((r) => ({ key: `checkin:${r.id}`, title: `${r.name} missed a safety check-in`, detail: { lastOkAt: r.last_ok_at, everyMin: r.every_min, lat: r.lat, lng: r.lng }, subjectKind: "user", subjectId: r.user_id }));
    },
  },
  crash: {
    resolves: false,
    async run(c) {
      const rows = (await c.query(
        `SELECT p.device_id AS "deviceId", coalesce(v.name, d.external_id) AS name, p.time, p.lat, p.lng, p.speed, p.ignition FROM positions p JOIN devices d ON d.id = p.device_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
         WHERE p.time > now() - interval '20 minutes' ORDER BY p.device_id, p.time LIMIT 20000`)).rows;
      const by = new Map<string, { name: string; fixes: Fix[] }>();
      for (const r of rows) (by.get(r.deviceId) ?? by.set(r.deviceId, { name: r.name, fixes: [] }).get(r.deviceId)!).fixes.push({ time: new Date(r.time).toISOString(), lat: r.lat, lng: r.lng, speed: r.speed, ignition: r.ignition });
      const out: Candidate[] = [];
      for (const [id, v] of by) for (const e of detectCrash(v.fixes)) out.push({ key: `crash:${id}:${e.time}`, title: `${v.name}: sudden stop from ${e.fromKmh} km/h`, detail: { at: e.time, lat: e.lat, lng: e.lng, fromKmh: e.fromKmh }, subjectKind: "device", subjectId: id });
      return out;
    },
  },
  long_idle: {
    resolves: true,
    async run(c, p) {
      const mins = num(p.minutes, 20, 2, 720);
      const rows = (await c.query(
        `SELECT d.id, coalesce(v.name, d.external_id) AS name, min(p.time) AS since FROM positions p JOIN devices d ON d.id = p.device_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
         WHERE p.time > now() - make_interval(mins => $1 + 2) GROUP BY d.id, v.name, d.external_id
         HAVING count(*) >= 3 AND max(p.speed) < 2 AND bool_and(coalesce(p.ignition, false)) AND min(p.time) <= now() - make_interval(mins => $1)`, [mins])).rows;
      return rows.map((r) => ({ key: `idle:${r.id}`, title: `${r.name} has been idling for ${mins}+ minutes`, detail: { since: r.since }, subjectKind: "device", subjectId: r.id }));
    },
  },
  speeding: {
    resolves: true,
    async run(c, p) {
      const kmh = num(p.kmh, 110, 20, 250), fixes = num(p.fixes, 3, 1, 100);
      const rows = (await c.query(
        `SELECT d.id, coalesce(v.name, d.external_id) AS name, max(p.speed) AS top, count(*) AS n FROM positions p JOIN devices d ON d.id = p.device_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
         WHERE p.time > now() - interval '10 minutes' AND p.speed > $1 GROUP BY d.id, v.name, d.external_id HAVING count(*) >= $2`, [kmh, fixes])).rows;
      return rows.map((r) => ({ key: `speed:${r.id}`, title: `${r.name} is over ${kmh} km/h`, detail: { topKmh: Math.round(Number(r.top)), fixes: Number(r.n) }, subjectKind: "device", subjectId: r.id }));
    },
  },
  geofence: {
    resolves: false,
    async run(c, p) {
      const look = num(p.lookbackMinutes, 5, 1, 120);
      const which = p.event === "enter" || p.event === "exit" ? p.event : null;
      const zone = typeof p.geofenceId === "string" && /^[0-9a-f-]{36}$/i.test(p.geofenceId) ? p.geofenceId : null;
      const rows = (await c.query(
        `SELECT e.id, e.kind, e.at, g.name AS zone, coalesce(v.name, d.external_id) AS vehicle, e.device_id AS "deviceId" FROM geofence_events e JOIN geofences g ON g.id = e.geofence_id
         JOIN devices d ON d.id = e.device_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
         WHERE e.at > now() - make_interval(mins => $1) AND ($2::text IS NULL OR e.kind = $2) AND ($3::uuid IS NULL OR e.geofence_id = $3) AND g.alert_on <> 'none' ORDER BY e.at DESC LIMIT 100`, [look, which, zone])).rows;
      return rows.map((r) => ({ key: `geo:${r.id}`, title: `${r.vehicle} ${r.kind === "enter" ? "entered" : "left"} ${r.zone}`, detail: { zone: r.zone, event: r.kind, at: r.at }, subjectKind: "device", subjectId: r.deviceId }));
    },
  },
  offline: {
    resolves: true,
    async run(c, p) {
      const mins = num(p.minutes, 30, 5, 10_080);
      const rows = (await c.query(
        `SELECT d.id, coalesce(v.name, d.external_id) AS name, lp.time FROM latest_positions lp JOIN devices d ON d.id = lp.device_id JOIN vehicles v ON v.id = d.vehicle_id AND v.status <> 'retired'
         WHERE lp.time < now() - make_interval(mins => $1) AND lp.time > now() - interval '7 days'`, [mins])).rows;
      return rows.map((r) => ({ key: `offline:${r.id}`, title: `${r.name} stopped reporting`, detail: { lastSeen: r.time }, subjectKind: "device", subjectId: r.id }));
    },
  },
  harsh_driving: {
    resolves: false,
    async run(c, p) {
      const mins = num(p.minutes, 30, 5, 240);
      const rows = (await c.query(
        `SELECT p.device_id AS "deviceId", coalesce(v.name, d.external_id) AS name, p.time, p.lat, p.lng, p.speed, p.ignition, p.odometer FROM positions p JOIN devices d ON d.id = p.device_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
         WHERE p.time > now() - make_interval(mins => $1) ORDER BY p.device_id, p.time LIMIT 20000`, [mins])).rows;
      const by = new Map<string, { name: string; fixes: Fix[] }>();
      for (const r of rows) (by.get(r.deviceId) ?? by.set(r.deviceId, { name: r.name, fixes: [] }).get(r.deviceId)!).fixes.push({ time: new Date(r.time).toISOString(), lat: r.lat, lng: r.lng, speed: r.speed, ignition: r.ignition, odometer: r.odometer });
      const out: Candidate[] = [];
      for (const [id, v] of by) for (const e of detectSafetyEvents(v.fixes, { speedLimitKmh: 1000 }).filter((x) => x.kind !== "speeding").slice(0, 5)) {
        out.push({ key: `harsh:${id}:${e.kind}:${e.time}`, title: `${v.name}: ${e.kind === "harsh_brake" ? "hard braking" : "hard acceleration"}`, detail: { at: e.time, kmhPerS: e.value, lat: e.lat, lng: e.lng }, subjectKind: "device", subjectId: id });
      }
      return out.slice(0, 50);
    },
  },
  document_expiry: {
    resolves: true,
    async run(c, p, e) {
      const days = num(p.days, 30, 0, 365);
      const docs = (await c.query(
        `SELECT d.id, d.kind, d.expires_on::text AS "expiresOn", coalesce(v.name, eq.name, coalesce(u.display_name, u.email)) AS owner
         FROM documents d LEFT JOIN vehicles v ON d.owner_kind = 'vehicle' AND v.id = d.owner_id LEFT JOIN equipment eq ON d.owner_kind = 'equipment' AND eq.id = d.owner_id
           LEFT JOIN users u ON d.owner_kind = 'driver' AND u.id = d.owner_id WHERE d.expires_on IS NOT NULL AND d.expires_on <= $1::date + $2::int`, [e.today, days])).rows;
      const lic = (await c.query(
        `SELECT dp.user_id AS id, coalesce(u.display_name, u.email) AS owner, dp.license_expiry::text AS "expiresOn" FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
         WHERE dp.license_expiry IS NOT NULL AND u.disabled_at IS NULL AND dp.license_expiry <= $1::date + $2::int`, [e.today, days])).rows;
      const mk = (id: string, what: string, owner: string, on: string, kind: string): Candidate => {
        const left = daysToExpiry(on, e.today);
        return { key: `doc:${kind}:${id}`, title: left != null && left < 0 ? `${owner}: ${what} expired` : `${owner}: ${what} expires in ${left} day(s)`, detail: { expiresOn: on, daysLeft: left }, subjectKind: kind, subjectId: id };
      };
      return [...docs.map((d) => mk(d.id, d.kind, d.owner, d.expiresOn, "document")), ...lic.map((l) => mk(l.id, "licence", l.owner, l.expiresOn, "licence"))];
    },
  },
  maintenance_due: {
    resolves: true,
    async run(c, p, e) {
      const soon = p.includeSoon !== false;
      const plans = (await c.query(
        `SELECT p.id, p.vehicle_id AS "vehicleId", v.name AS vehicle, p.task, p.every_days AS "everyDays", p.every_km AS "everyKm", p.last_done_on::text AS "lastDoneOn", p.last_done_km AS "lastDoneKm",
                greatest(v.odometer_km, coalesce((SELECT max(po.odometer) / 1000 FROM latest_positions lp JOIN devices d ON d.id = lp.device_id JOIN positions po ON po.device_id = d.id AND po.time = lp.time WHERE d.vehicle_id = v.id), 0)) AS odo
         FROM maintenance_plans p JOIN vehicles v ON v.id = p.vehicle_id WHERE v.status <> 'retired'`)).rows;
      const out: Candidate[] = [];
      for (const pl of plans) {
        const due = maintenanceDue(pl, e.today, Number(pl.odo));
        if (due.state === "overdue" || (soon && due.state === "due_soon")) out.push({ key: `maint:${pl.id}`, title: `${pl.vehicle}: ${pl.task} ${due.state === "overdue" ? "is overdue" : "is due soon"}`, detail: { dueOn: due.dueOn, daysLeft: due.daysLeft, kmLeft: due.kmLeft }, subjectKind: "vehicle", subjectId: pl.vehicleId });
      }
      return out;
    },
  },
  budget: {
    resolves: true,
    async run(c, _p, e) {
      const s = withDefaults((await c.query("SELECT settings FROM organizations WHERE id = $1", [e.orgId])).rows[0]?.settings);
      const rows = await budgetRows(c, s.billing.budgetAlertPct, e.now, true);
      return rows.filter((r) => r.state !== "ok").map((r) => ({
        key: `budget:${r.id}:${r.from}`,
        title: r.state === "over" ? `${r.name} is over budget (${r.pct}% of ${r.amount})` : `${r.name} has used ${r.pct}% of its budget`,
        detail: { spent: r.spent, amount: r.amount, projected: r.projected, period: r.period, from: r.from, to: r.to }, subjectKind: "budget", subjectId: r.id,
      }));
    },
  },
  cost_anomaly: {
    resolves: false,
    async run(c, p, e) {
      const add = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
      const yesterday = add(e.today, -1);
      const b = await e.svc.load(e.orgId, { from: add(e.today, -29), to: yesterday });
      const days = breakdown(b, "day").filter((r) => r.metrics.costTotal != null && (r.metrics.costTotal as number) > 0);
      const last = days.find((r) => r.key === yesterday);
      if (!last) return [];
      const a = anomaly(last.metrics.costTotal as number, days.filter((r) => r.key !== yesterday).map((r) => r.metrics.costTotal as number), num(p.threshold, 3.5, 1, 20));
      return a?.unusual && a.score > 0 ? [{ key: `cost:${yesterday}`, title: `Costs on ${yesterday} were ${Math.abs(a.changePct ?? 0)}% above normal`, detail: { cost: last.metrics.costTotal, typical: a.typical, score: a.score } }] : [];
    },
  },
  custom_metric: {
    resolves: true,
    async run(c, p, e) {
      const metric = String(p.metric ?? "");
      if (!(metric in METRICS)) return [];
      const op = ["gt", "gte", "lt", "lte"].includes(String(p.op)) ? String(p.op) : "gt";
      const value = num(p.value, NaN, -1e12, 1e12);
      if (!Number.isFinite(value)) return [];
      const add = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
      const span = p.period === "yesterday" ? { from: add(e.today, -1), to: add(e.today, -1) } : p.period === "last7" ? { from: add(e.today, -6), to: e.today } : { from: e.today, to: e.today };
      const got = summarize(await e.svc.load(e.orgId, span))[metric as keyof ReturnType<typeof summarize>] as number | null;
      if (got == null) return [];
      const hit = op === "gt" ? got > value : op === "gte" ? got >= value : op === "lt" ? got < value : got <= value;
      return hit ? [{ key: `metric:${metric}:${span.from}`, title: `${metric} is ${got} (alert at ${op} ${value})`, detail: { metric, value: got, threshold: value, op, from: span.from, to: span.to } }] : [];
    },
  },
};
export const EVALUATORS = { ...LEGACY_EVALUATORS, ...PORTAL_EVALUATORS } as Record<RuleKind, Evaluator>;

const hhmm = (d: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

export interface TickResult { raised: number; bumped: number; resolved: number; sent: number; failed: number }

/** Check every active rule of one organization. Safe to run every minute. */
export async function evaluateOrg(pool: pg.Pool, svc: AnalyticsService, notify: Providers, orgId: string, now = new Date(), only?: string): Promise<TickResult> {
  const res: TickResult = { raised: 0, bumped: 0, resolved: 0, sent: 0, failed: 0 };
  const meta = (await withOrg(pool, orgId, (c) => c.query<{ today: string; tz: string }>("SELECT (now() AT TIME ZONE timezone)::date::text AS today, timezone AS tz FROM organizations"))).rows[0];
  if (!meta) return res;
  const rules = (await withOrg(pool, orgId, (c) => c.query<Rule>(
    `SELECT id, name, kind, params, severity, endpoint_ids AS "endpointIds", quiet_start::text AS "quietStart", quiet_end::text AS "quietEnd", group_minutes AS "groupMinutes",
            repeat_minutes AS "repeatMinutes", recipient_ids AS "recipientIds", area
     FROM alert_rules WHERE active AND archived_at IS NULL AND ($1::uuid IS NULL OR id = $1)`, [only ?? null]))).rows;
  for (const rule of rules) {
    const ev = EVALUATORS[rule.kind];
    if (!ev) continue;
    let found: Candidate[];
    try { found = await withOrg(pool, orgId, (c) => ev.run(c, rule.params ?? {}, { orgId, today: meta.today, tz: meta.tz, svc, now })); } catch (e) { console.error(`alert rule ${rule.id} (${rule.kind}):`, (e as Error).message); continue; }
    // Quiet hours hold back everything except Critical.
    const inQuiet = inQuietHours(hhmm(now, meta.tz), rule.quietStart, rule.quietEnd);
    const toSend: (Item & { repeat: boolean })[] = [];
    await withOrg(pool, orgId, async (c) => {
      const log = (alertId: string, kind: string, detail: Record<string, unknown> = {}, note: string | null = null) =>
        c.query("INSERT INTO alert_events (org_id, alert_id, kind, note, detail) VALUES ($1,$2,$3,$4,$5)", [orgId, alertId, kind, note, JSON.stringify(detail)]);
      for (const f of found.slice(0, 100)) {
        const sev = f.severity ?? rule.severity;
        const quiet = inQuiet && sev !== "critical";
        const cur = (await c.query(
          "SELECT id, status, severity, last_at, delivered_at, last_sent_at, snoozed_until FROM alerts WHERE dedupe_key = $1 AND status IN ('open','acknowledged')", [f.key])).rows[0];
        if (cur) {
          const snoozed = !!cur.snoozed_until && new Date(cur.snoozed_until) > now;
          const snoozeEnded = !!cur.snoozed_until && !snoozed;
          const escalated = RANK[sev] > RANK[cur.severity as Severity];
          // A Critical alert nobody has acted on is sent again every few minutes. Acknowledging, assigning, snoozing or closing it stops that.
          const since = (t: string | null) => (t ? (now.getTime() - new Date(t).getTime()) / 60000 : Infinity);
          const repeat = sev === "critical" && cur.status === "open" && !snoozed && since(cur.last_sent_at ?? cur.delivered_at) >= rule.repeatMinutes;
          const regroup = !repeat && cur.status === "open" && !snoozed && rule.groupMinutes > 0 && (!cur.delivered_at || since(cur.delivered_at) >= rule.groupMinutes);
          await c.query(
            `UPDATE alerts SET last_at = now(), count = count + 1, detail = $2, title = $3, severity = CASE WHEN $4 THEN $5 ELSE severity END, status = CASE WHEN $4 THEN 'open' ELSE status END,
                    snoozed_until = CASE WHEN $6 THEN NULL ELSE snoozed_until END WHERE id = $1`, [cur.id, f.detail, f.title, escalated, sev, snoozeEnded]);
          res.bumped++;
          if (escalated) await log(cur.id, "escalated", { from: cur.severity, to: sev });
          if (snoozeEnded) await log(cur.id, "unsnoozed", {}, "The snooze ended and the problem is still there");
          if (!snoozed && !quiet && (escalated || repeat || regroup || snoozeEnded)) toSend.push({ id: cur.id, title: f.title, detail: f.detail, severity: sev, repeat: repeat && !escalated });
          continue;
        }
        // Someone marked this done a short while ago and the cause is still there: do not nag again unless it has become worse.
        if ((await c.query(
          `SELECT 1 FROM alerts WHERE dedupe_key = $1 AND status = 'resolved' AND resolved_how = 'person' AND resolved_at > now() - interval '7 days'
             AND array_position(ARRAY['info','warn','critical'], severity) >= array_position(ARRAY['info','warn','critical'], $2::text) LIMIT 1`, [f.key, sev])).rowCount) continue;
        const row = (await c.query(
          `INSERT INTO alerts (org_id, rule_id, kind, severity, title, detail, subject_kind, subject_id, dedupe_key, area) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
          [orgId, rule.id, rule.kind, sev, f.title, f.detail, f.subjectKind ?? null, f.subjectId ?? null, f.key, rule.area])).rows[0];
        res.raised++;
        await log(row.id, "raised", { rule: rule.name });
        await emit(c, orgId, "alert.raised", "alert", row.id, { severity: sev, title: f.title, kind: rule.kind, area: rule.area, rule: rule.name });
        if (!quiet) toSend.push({ id: row.id, title: f.title, detail: f.detail, severity: sev, repeat: false });
      }
      if (ev.resolves) {
        const keys = found.map((f) => f.key);
        const closed = await c.query(
          "UPDATE alerts SET status = 'resolved', resolved_at = now(), resolved_how = 'auto' WHERE rule_id = $1 AND status IN ('open','acknowledged') AND NOT (dedupe_key = ANY($2::text[])) RETURNING id", [rule.id, keys]);
        res.resolved += closed.rowCount ?? 0;
        for (const r of closed.rows) await log(r.id, "auto_resolved", {}, "The problem went away");
      }
    });
    if (toSend.length) {
      const top = toSend.reduce((a, b) => (RANK[b.severity] > RANK[a.severity] ? b : a)).severity;
      // People: each person's own choices decide channels, quiet hours and what they mute.
      const people = rule.area || rule.recipientIds.length ? await notifyPeople(pool, notify, orgId, rule, toSend, meta.tz, now) : { sent: 0, failed: 0, byAlert: new Map<string, Record<string, unknown>>() };
      res.sent += people.sent; res.failed += people.failed;
      // Destinations picked on the rule itself (an email address, a Slack channel, a webhook).
      if (rule.endpointIds.length) {
        const endpoints = (await withOrg(pool, orgId, (c) => c.query<Endpoint & { enabled: boolean }>("SELECT id, kind, target, label, enabled FROM notification_endpoints WHERE id = ANY($1::uuid[])", [rule.endpointIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x))]))).rows.filter((e) => e.enabled);
        // Many matches in one pass become one message, so a burst never floods a channel.
        const first = toSend[0]!;
        const msg = toSend.length === 1
          ? { subject: `${rule.name}: ${first.title}`, text: first.title }
          : { subject: `${rule.name}: ${toSend.length} alerts`, text: toSend.slice(0, 10).map((s) => `• ${s.title}`).join("\n") + (toSend.length > 10 ? `\n…and ${toSend.length - 10} more` : "") };
        for (const ep of endpoints) {
          const r = await deliver(ep, { ...msg, severity: top, link: `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"}${rule.area ? "/owner/alerts" : "/alerts"}` }, notify);
          if (r.ok) res.sent++; else res.failed++;
        }
      }
      await withOrg(pool, orgId, async (c) => {
        await c.query("UPDATE alerts SET delivered_at = now(), last_sent_at = now() WHERE id = ANY($1::uuid[])", [toSend.map((s) => s.id)]);
        for (const s of toSend) await c.query("INSERT INTO alert_events (org_id, alert_id, kind, detail) VALUES ($1,$2,$3,$4)", [orgId, s.id, s.repeat ? "repeated" : "sent", JSON.stringify(people.byAlert.get(s.id) ?? {})]);
      });
    }
  }
  return res;
}

/** Alerts held back during quiet hours, or sent only to the screen, go out in one summary each morning. */
export async function sendDigest(pool: pg.Pool, notify: Providers, orgId: string): Promise<{ alerts: number; sent: number }> {
  const rows = (await withOrg(pool, orgId, (c) => c.query(
    `SELECT a.id, a.title, a.severity, r.name AS rule, r.endpoint_ids AS "endpointIds" FROM alerts a JOIN alert_rules r ON r.id = a.rule_id
     WHERE NOT a.in_digest AND a.delivered_at IS NULL AND a.last_at > now() - interval '24 hours' ORDER BY a.severity, a.first_at LIMIT 200`))).rows;
  if (!rows.length) return { alerts: 0, sent: 0 };
  const ids = [...new Set(rows.flatMap((r) => r.endpointIds as string[]))].filter((x) => /^[0-9a-f-]{36}$/i.test(x));
  const endpoints = ids.length ? (await withOrg(pool, orgId, (c) => c.query<Endpoint & { enabled: boolean }>("SELECT id, kind, target, label, enabled FROM notification_endpoints WHERE id = ANY($1::uuid[])", [ids]))).rows.filter((e) => e.enabled) : [];
  let sent = 0;
  const text = rows.slice(0, 30).map((r) => `• [${r.severity}] ${r.title}`).join("\n") + (rows.length > 30 ? `\n…and ${rows.length - 30} more` : "");
  for (const ep of endpoints) if ((await deliver(ep, { subject: `Daily alert summary: ${rows.length} alert(s)`, text, link: `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"}/alerts` }, notify)).ok) sent++;
  await withOrg(pool, orgId, (c) => c.query("UPDATE alerts SET in_digest = true WHERE id = ANY($1::uuid[])", [rows.map((r) => r.id)]));
  return { alerts: rows.length, sent };
}

/** One pass over every organization: evaluate rules, and at 07:00 local send the morning summary. */
export async function runAlertTick(pool: pg.Pool, svc: AnalyticsService, notify: Providers, log: (m: string) => void = () => {}, now = new Date()): Promise<void> {
  const orgs = (await pool.query<{ id: string }>("SELECT all_org_ids() AS id")).rows;
  for (const { id } of orgs) {
    try {
      await ensureDefaultRules(pool, id);
      const r = await evaluateOrg(pool, svc, notify, id, now);
      if (r.raised) log(`alerts: ${r.raised} new for ${id}`);
      const tz = (await withOrg(pool, id, (c) => c.query<{ timezone: string }>("SELECT timezone FROM organizations"))).rows[0]?.timezone;
      if (tz && hhmm(now, tz).startsWith("07:")) { await sendDigest(pool, notify, id); await sendPersonalDigests(pool, notify, id, now); }
      for (const a of await runAutomations(pool, notify, id, now)) if (a.status === "failed") log(`automation ${a.automation} failed for ${id}: ${a.message}`);
    } catch (e) { log(`alerts failed for ${id}: ${(e as Error).message}`); }
  }
}
