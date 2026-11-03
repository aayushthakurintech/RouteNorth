import { pg, withOrg } from "@routenorth/db";
import { anomaly, daysToExpiry, detectSafetyEvents, distanceToPath, documentState, inQuietHours, maintenanceDue, type Fix } from "@routenorth/shared";
import { breakdown, METRICS, summarize, type AnalyticsService } from "../analytics/analytics.service.js";
import { deliver, type Endpoint, type Providers } from "../notify/notifier.js";

/**
 * Alert rules: "if this happens, tell these people". Each kind of rule looks at the live data and lists the things that match
 * right now. The engine then groups repeats, respects quiet hours, resolves alerts whose cause has gone away, and sends them.
 */
export type RuleKind = "late_risk" | "off_route" | "long_idle" | "speeding" | "geofence" | "offline" | "harsh_driving" | "document_expiry" | "maintenance_due" | "cost_anomaly" | "custom_metric";
export interface Rule { id: string; name: string; kind: RuleKind; params: Record<string, unknown>; severity: "info" | "warn" | "critical"; endpointIds: string[]; quietStart: string | null; quietEnd: string | null; groupMinutes: number }
export interface Candidate { key: string; title: string; detail: Record<string, unknown>; subjectKind?: string; subjectId?: string }
interface Env { orgId: string; today: string; svc: AnalyticsService; now: Date }
type Evaluator = { /** Alerts about a state (like "offline") end when the state ends; alerts about an event (like "entered a zone") do not. */ resolves: boolean; run: (c: pg.PoolClient, p: Record<string, unknown>, e: Env) => Promise<Candidate[]> };

const num = (v: unknown, d: number, lo = 0, hi = 1e9) => { const n = typeof v === "number" ? v : Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };

export const EVALUATORS: Record<RuleKind, Evaluator> = {
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

const hhmm = (d: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

export interface TickResult { raised: number; bumped: number; resolved: number; sent: number; failed: number }

/** Check every active rule of one organization. Safe to run every minute. */
export async function evaluateOrg(pool: pg.Pool, svc: AnalyticsService, notify: Providers, orgId: string, now = new Date(), only?: string): Promise<TickResult> {
  const res: TickResult = { raised: 0, bumped: 0, resolved: 0, sent: 0, failed: 0 };
  const meta = (await withOrg(pool, orgId, (c) => c.query<{ today: string; tz: string }>("SELECT (now() AT TIME ZONE timezone)::date::text AS today, timezone AS tz FROM organizations"))).rows[0];
  if (!meta) return res;
  const rules = (await withOrg(pool, orgId, (c) => c.query<Rule & { quiet_start: string | null; quiet_end: string | null }>(
    `SELECT id, name, kind, params, severity, endpoint_ids AS "endpointIds", quiet_start::text AS "quietStart", quiet_end::text AS "quietEnd", group_minutes AS "groupMinutes" FROM alert_rules WHERE active AND ($1::uuid IS NULL OR id = $1)`, [only ?? null]))).rows;
  for (const rule of rules) {
    const ev = EVALUATORS[rule.kind];
    if (!ev) continue;
    let found: Candidate[];
    try { found = await withOrg(pool, orgId, (c) => ev.run(c, rule.params ?? {}, { orgId, today: meta.today, svc, now })); } catch (e) { console.error(`alert rule ${rule.id} (${rule.kind}):`, (e as Error).message); continue; }
    const quiet = inQuietHours(hhmm(now, meta.tz), rule.quietStart, rule.quietEnd) && rule.severity !== "critical";
    const toSend: { title: string; detail: Record<string, unknown>; id: string }[] = [];
    await withOrg(pool, orgId, async (c) => {
      for (const f of found.slice(0, 100)) {
        const cur = (await c.query("SELECT id, status, last_at, delivered_at FROM alerts WHERE dedupe_key = $1 AND status IN ('open','acknowledged')", [f.key])).rows[0];
        if (cur) {
          const regroup = cur.status === "open" && (!cur.delivered_at || (now.getTime() - new Date(cur.delivered_at).getTime()) / 60000 >= rule.groupMinutes) && rule.groupMinutes > 0;
          await c.query("UPDATE alerts SET last_at = now(), count = count + 1, detail = $2, title = $3 WHERE id = $1", [cur.id, f.detail, f.title]);
          res.bumped++;
          if (regroup && !quiet) toSend.push({ id: cur.id, title: f.title, detail: f.detail });
          continue;
        }
        const row = (await c.query(
          `INSERT INTO alerts (org_id, rule_id, kind, severity, title, detail, subject_kind, subject_id, dedupe_key) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
          [orgId, rule.id, rule.kind, rule.severity, f.title, f.detail, f.subjectKind ?? null, f.subjectId ?? null, f.key])).rows[0];
        res.raised++;
        if (!quiet) toSend.push({ id: row.id, title: f.title, detail: f.detail });
      }
      if (ev.resolves) {
        const keys = found.map((f) => f.key);
        res.resolved += (await c.query("UPDATE alerts SET status = 'resolved' WHERE rule_id = $1 AND status IN ('open','acknowledged') AND NOT (dedupe_key = ANY($2::text[]))", [rule.id, keys])).rowCount ?? 0;
      }
    });
    if (toSend.length && rule.endpointIds.length) {
      const endpoints = (await withOrg(pool, orgId, (c) => c.query<Endpoint & { enabled: boolean }>("SELECT id, kind, target, label, enabled FROM notification_endpoints WHERE id = ANY($1::uuid[])", [rule.endpointIds.filter((x) => /^[0-9a-f-]{36}$/i.test(x))]))).rows.filter((e) => e.enabled);
      // Many matches in one pass become one message, so a burst never floods a channel.
      const first = toSend[0]!;
      const msg = toSend.length === 1
        ? { subject: `${rule.name}: ${first.title}`, text: first.title }
        : { subject: `${rule.name}: ${toSend.length} alerts`, text: toSend.slice(0, 10).map((s) => `• ${s.title}`).join("\n") + (toSend.length > 10 ? `\n…and ${toSend.length - 10} more` : "") };
      for (const ep of endpoints) {
        const r = await deliver(ep, { ...msg, severity: rule.severity, link: `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"}/alerts` }, notify);
        if (r.ok) res.sent++; else res.failed++;
      }
    }
    if (toSend.length) await withOrg(pool, orgId, (c) => c.query("UPDATE alerts SET delivered_at = now() WHERE id = ANY($1::uuid[])", [toSend.map((s) => s.id)]));
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
      const r = await evaluateOrg(pool, svc, notify, id, now);
      if (r.raised) log(`alerts: ${r.raised} new for ${id}`);
      const tz = (await withOrg(pool, id, (c) => c.query<{ timezone: string }>("SELECT timezone FROM organizations"))).rows[0]?.timezone;
      if (tz && hhmm(now, tz).startsWith("07:")) await sendDigest(pool, notify, id);
    } catch (e) { log(`alerts failed for ${id}: ${(e as Error).message}`); }
  }
}
