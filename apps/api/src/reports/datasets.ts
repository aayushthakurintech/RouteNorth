import { BadRequestException, ForbiddenException } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { aggregate, co2Kg, evalFormula, pivot, round, type Agg, type Permission } from "@routenorth/shared";
import { PORTAL_DATASETS } from "./portal-datasets.js";
import { breakdown, GROUPS, METRICS, type Bundle, type Filters, type Group, type Range, AnalyticsService } from "../analytics/analytics.service.js";

/** `money` columns hold whole cents; screens show them with the currency and exports turn them into dollars. */
export type ColType = "text" | "num" | "date" | "ts" | "bool" | "pct" | "money";
export interface Column { key: string; label: string; type: ColType; /** Default way to combine rows when grouping. */ agg?: Agg; /** Multiply by this on output (0/1 flags shown as percent). */ scale?: number; hidden?: boolean }
/** `requires`: the person needs at least one of these permissions to use the dataset (money, pay, audit and people data). */
export interface Dataset { key: string; label: string; columns: Column[]; load: (x: Ctx) => Promise<Record<string, unknown>[]>; requires?: Permission[]; /** What the dataset answers, for the builder. */ about?: string }
export interface Ctx { pool: pg.Pool; orgId: string; range: Range; filters: Filters; svc: AnalyticsService; bundle: () => Promise<Bundle>; /** Who is asking. Left out for shared links and schedules, which were checked when they were made. */ perms?: ReadonlySet<string> }

const txt = (key: string, label = key): Column => ({ key, label, type: "text" });
const num = (key: string, label = key, agg: Agg = "sum"): Column => ({ key, label, type: "num", agg });
const date = (key: string, label = key): Column => ({ key, label, type: "date" });
const ts = (key: string, label = key): Column => ({ key, label, type: "ts" });
const rate = (key: string, label = key): Column => ({ key, label, type: "pct", agg: "avg", scale: 100 });
const id = (key: string): Column => ({ key, label: key, type: "text", hidden: true });

const iso = (d: Date | null) => (d ? d.toISOString() : null);
const name = (m: Map<string, string>, k: string | null) => (k ? m.get(k) ?? null : null);

/** Datasets people can build reports from. Each one lists exactly the columns a report may use. */
export const DATASETS: Dataset[] = [
  {
    key: "stops", label: "Stops",
    columns: [date("date"), txt("route"), txt("driver"), txt("vehicle"), txt("depot"), txt("customer"), txt("status"), txt("reason"), txt("exception"), ts("windowEnd"), ts("arrivedAt"),
      num("delayMin", "delayMin", "avg"), rate("onTime"), num("done"), num("failed"), num("skipped"), num("serviceMin", "serviceMin", "avg"), num("weightKg"), num("lat", "lat", "avg"), num("lng", "lng", "avg"), num("count"),
      id("routeId"), id("driverId"), id("vehicleId")],
    async load(x) {
      const b = await x.bundle();
      return b.stops.map((s) => ({
        date: s.date, route: name(b.names.route, s.routeId), driver: name(b.names.driver, s.driverId), vehicle: name(b.names.vehicle, s.vehicleId), depot: name(b.names.depot, s.depotId),
        customer: s.customer, status: s.status, reason: s.reason, windowEnd: iso(s.windowEnd), arrivedAt: iso(s.arrivedAt),
        exception: s.status === "failed" ? "failed" : s.status === "skipped" ? "skipped" : s.windowEnd && s.arrivedAt && s.arrivedAt > s.windowEnd ? "late" : null,
        delayMin: s.windowEnd && s.arrivedAt ? Math.max(0, Math.round((s.arrivedAt.getTime() - s.windowEnd.getTime()) / 60000)) : null,
        onTime: s.status === "done" ? (!s.windowEnd || !s.arrivedAt || s.arrivedAt <= s.windowEnd ? 1 : 0) : null,
        done: s.status === "done" ? 1 : 0, failed: s.status === "failed" ? 1 : 0, skipped: s.status === "skipped" ? 1 : 0, serviceMin: s.serviceMin, weightKg: s.weightKg, lat: s.lat, lng: s.lng, count: 1,
        routeId: s.routeId, driverId: s.driverId, vehicleId: s.vehicleId,
      }));
    },
  },
  {
    key: "routes", label: "Routes",
    columns: [date("date"), txt("route"), txt("driver"), txt("vehicle"), txt("depot"), num("stops"), num("done"), num("failed"), num("plannedKm"), num("actualKm"), num("kmOverPlanPct", "kmOverPlanPct", "avg"),
      num("plannedMin"), num("actualMin"), num("adherencePct", "adherencePct", "avg"), num("count"), id("routeId"), id("driverId"), id("vehicleId")],
    async load(x) {
      const b = await x.bundle();
      return b.routes.map((r) => ({
        date: r.date, route: r.name, driver: name(b.names.driver, r.driverId), vehicle: name(b.names.vehicle, r.vehicleId), depot: name(b.names.depot, r.depotId),
        stops: r.stops.length, done: r.stops.filter((s) => s.status === "done").length, failed: r.stops.filter((s) => s.status === "failed").length,
        plannedKm: round(r.plannedKm), actualKm: round(r.actualKm), kmOverPlanPct: r.plannedKm > 0 ? round(((r.actualKm - r.plannedKm) / r.plannedKm) * 100) : null,
        plannedMin: round(r.plannedMin, 0), actualMin: round(r.actualMin, 0), adherencePct: r.adherence, count: 1, routeId: r.id, driverId: r.driverId, vehicleId: r.vehicleId,
      }));
    },
  },
  {
    key: "vehicleDays", label: "Vehicle days (distance, idling, shifts)",
    columns: [date("date"), txt("vehicle"), txt("driver"), txt("depot"), num("km"), num("movingH"), num("idleH"), num("engineH"), num("shiftH", "shiftH", "max"), num("overtimeH"), num("routes"), num("count"), id("deviceId"), id("vehicleId"), id("driverId")],
    async load(x) {
      const b = await x.bundle();
      return b.mv.map((m) => ({
        date: m.date, vehicle: name(b.names.vehicle, m.vehicleId), driver: name(b.names.driver, m.driverId), depot: name(b.names.depot, m.depotId),
        km: round(m.km, 1), movingH: round(m.movingS / 3600, 2), idleH: round(m.idleS / 3600, 2), engineH: round((m.movingS + m.idleS) / 3600, 2), shiftH: round(m.shiftH, 2),
        overtimeH: round(Math.max(0, m.shiftH - b.overtimeAfterH), 2), routes: m.routeIds.length, count: 1, deviceId: m.deviceId, vehicleId: m.vehicleId, driverId: m.driverId,
      }));
    },
  },
  {
    key: "fuel", label: "Fuel fill-ups",
    columns: [date("date"), txt("vehicle"), txt("driver"), txt("depot"), txt("fuelType"), num("litres"), num("cost"), num("odometerKm", "odometerKm", "max"), num("co2Kg"), num("pricePerL", "pricePerL", "avg"), num("count"), id("vehicleId")],
    async load(x) {
      const b = await x.bundle();
      return b.fuel.map((f) => ({
        date: f.date, vehicle: name(b.names.vehicle, f.vehicleId), driver: name(b.names.driver, f.driverId), depot: name(b.names.depot, f.depotId), fuelType: f.fuelType,
        litres: f.litres, cost: f.cost, odometerKm: f.odometerKm, co2Kg: round(co2Kg(f.litres, f.fuelType), 1), pricePerL: f.litres > 0 ? round(f.cost / f.litres, 3) : null, count: 1, vehicleId: f.vehicleId,
      }));
    },
  },
  {
    key: "maintenance", label: "Maintenance and repairs",
    columns: [date("date"), txt("vehicle"), txt("task"), txt("vendor"), num("cost"), num("downtimeH"), num("odometerKm", "odometerKm", "max"), num("count"), id("vehicleId")],
    async load(x) {
      const rows = (await withOrg(x.pool, x.orgId, (c) => c.query(
        `SELECT m.done_on::text AS date, v.name AS vehicle, m.task, m.vendor, coalesce(m.cost, 0)::float AS cost, coalesce(m.downtime_hours, 0)::float AS "downtimeH", m.odometer_km AS "odometerKm", 1 AS count, m.vehicle_id AS "vehicleId"
         FROM maintenance_logs m JOIN vehicles v ON v.id = m.vehicle_id WHERE m.done_on BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR m.vehicle_id = $3) ORDER BY m.done_on`,
        [x.range.from, x.range.to, x.filters.vehicleId ?? null]))).rows;
      return rows;
    },
  },
  {
    key: "incidents", label: "Incidents",
    columns: [date("date"), txt("vehicle"), txt("driver"), txt("kind"), txt("severity"), txt("status"), txt("location"), num("injuries"), num("count"), id("vehicleId"), id("driverId")],
    async load(x) {
      return (await withOrg(x.pool, x.orgId, (c) => c.query(
        `SELECT (i.occurred_at AT TIME ZONE o.timezone)::date::text AS date, v.name AS vehicle, coalesce(u.display_name, u.email) AS driver, i.kind, i.severity, i.status, i.location,
                CASE WHEN i.injuries THEN 1 ELSE 0 END AS injuries, 1 AS count, i.vehicle_id AS "vehicleId", i.driver_id AS "driverId"
         FROM incidents i CROSS JOIN organizations o LEFT JOIN vehicles v ON v.id = i.vehicle_id LEFT JOIN users u ON u.id = i.driver_id
         WHERE (i.occurred_at AT TIME ZONE o.timezone)::date BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR i.driver_id = $3) AND ($4::uuid IS NULL OR i.vehicle_id = $4) ORDER BY i.occurred_at`,
        [x.range.from, x.range.to, x.filters.driverId ?? null, x.filters.vehicleId ?? null]))).rows;
    },
  },
  {
    key: "safety", label: "Driving events (speeding, harsh braking)",
    columns: [date("date"), ts("time"), txt("vehicle"), txt("driver"), txt("kind"), num("value", "value", "max"), num("durationS", "durationS", "sum"), num("lat", "lat", "avg"), num("lng", "lng", "avg"), num("count")],
    async load(x) {
      const b = await x.bundle();
      return b.safe.map((e) => ({ date: e.date, time: e.time, vehicle: e.name, driver: name(b.names.driver, e.driverId), kind: e.kind, value: e.value, durationS: e.durationS ?? null, lat: e.lat, lng: e.lng, count: 1 }));
    },
  },
  {
    key: "feedback", label: "Customer feedback",
    columns: [date("date"), txt("driver"), txt("route"), num("csat", "csat", "avg"), num("nps", "nps", "avg"), txt("comment"), num("count")],
    async load(x) {
      return (await withOrg(x.pool, x.orgId, (c) => c.query(
        `SELECT (f.created_at AT TIME ZONE o.timezone)::date::text AS date, coalesce(u.display_name, u.email) AS driver, r.name AS route, f.csat, f.nps, f.comment, 1 AS count
         FROM feedback f CROSS JOIN organizations o LEFT JOIN users u ON u.id = f.driver_id LEFT JOIN routes r ON r.id = f.route_id
         WHERE (f.created_at AT TIME ZONE o.timezone)::date BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR f.driver_id = $3) ORDER BY f.created_at`, [x.range.from, x.range.to, x.filters.driverId ?? null]))).rows;
    },
  },
  {
    key: "jobs", label: "Jobs",
    columns: [date("date"), txt("ref"), txt("title"), txt("type"), txt("priority"), txt("status"), txt("customer"), txt("driver"), txt("vehicle"), txt("address"), txt("reason"), num("weightKg"), num("count")],
    async load(x) {
      return (await withOrg(x.pool, x.orgId, (c) => c.query(
        `SELECT j.scheduled_date::text AS date, j.ref, j.title, j.type, j.priority, j.status, j.customer_name AS customer, coalesce(u.display_name, u.email) AS driver, v.name AS vehicle, j.address,
                coalesce(j.reason_code, '') AS reason, j.weight_kg AS "weightKg", 1 AS count
         FROM jobs j LEFT JOIN users u ON u.id = j.driver_id LEFT JOIN vehicles v ON v.id = j.vehicle_id
         WHERE j.scheduled_date BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR j.driver_id = $3) AND ($4::uuid IS NULL OR j.vehicle_id = $4) ORDER BY j.scheduled_date`,
        [x.range.from, x.range.to, x.filters.driverId ?? null, x.filters.vehicleId ?? null]))).rows;
    },
  },
  {
    key: "geofenceVisits", label: "Geofence visits",
    columns: [date("date"), txt("zone"), txt("vehicle"), ts("enteredAt"), ts("leftAt"), num("minutes", "minutes", "sum"), num("count")],
    async load(x) {
      const ev = (await withOrg(x.pool, x.orgId, (c) => c.query<{ zone: string; vehicle: string; device_id: string; geofence_id: string; kind: string; at: Date; date: string }>(
        `SELECT g.name AS zone, coalesce(v.name, d.external_id) AS vehicle, e.device_id, e.geofence_id, e.kind, e.at, (e.at AT TIME ZONE o.timezone)::date::text AS date
         FROM geofence_events e CROSS JOIN organizations o JOIN geofences g ON g.id = e.geofence_id JOIN devices d ON d.id = e.device_id LEFT JOIN vehicles v ON v.id = d.vehicle_id
         WHERE e.at >= (($1::date)::timestamp AT TIME ZONE o.timezone) - interval '1 day' AND e.at < ((($2::date) + 1)::timestamp AT TIME ZONE o.timezone) AND ($3::uuid IS NULL OR d.vehicle_id = $3) ORDER BY e.device_id, e.geofence_id, e.at`,
        [x.range.from, x.range.to, x.filters.vehicleId ?? null]))).rows;
      const out: Record<string, unknown>[] = [];
      const open = new Map<string, (typeof ev)[number]>();
      for (const e of ev) {
        const key = `${e.device_id}|${e.geofence_id}`;
        if (e.kind === "enter") { open.set(key, e); continue; }
        const inn = open.get(key); open.delete(key);
        if (!inn) continue;
        if (inn.date < x.range.from || inn.date > x.range.to) continue;
        out.push({ date: inn.date, zone: e.zone, vehicle: e.vehicle, enteredAt: inn.at.toISOString(), leftAt: e.at.toISOString(), minutes: Math.round((e.at.getTime() - inn.at.getTime()) / 60000), count: 1 });
      }
      for (const [, inn] of open) if (inn.date >= x.range.from && inn.date <= x.range.to) out.push({ date: inn.date, zone: inn.zone, vehicle: inn.vehicle, enteredAt: inn.at.toISOString(), leftAt: null, minutes: null, count: 1 });
      return out;
    },
  },
  {
    key: "compliance", label: "Compliance (shift hours, inspections, documents)",
    columns: [txt("check"), date("date"), txt("subject"), txt("detail"), num("value", "value", "max"), txt("status"), num("count")],
    async load(x) {
      const b = await x.bundle();
      const out: Record<string, unknown>[] = [];
      // Hours: Canada's daily limits are 13 h driving and 14 h on duty. Shift length from GPS is an estimate, not a certified log.
      for (const m of b.mv) if (m.driverId && m.shiftH > 0) out.push({ check: "dailyHours", date: m.date, subject: name(b.names.driver, m.driverId), detail: `${name(b.names.vehicle, m.vehicleId) ?? ""}`, value: round(m.shiftH, 1), status: m.shiftH > 14 ? "breach" : m.shiftH > 13 ? "warning" : "ok", count: 1 });
      const insp = (await withOrg(x.pool, x.orgId, (c) => c.query(
        `SELECT (i.at AT TIME ZONE o.timezone)::date::text AS date, v.name AS vehicle, coalesce(u.display_name, u.email) AS driver, i.kind, i.defects FROM inspections i CROSS JOIN organizations o JOIN vehicles v ON v.id = i.vehicle_id LEFT JOIN users u ON u.id = i.driver_id
         WHERE (i.at AT TIME ZONE o.timezone)::date BETWEEN $1::date AND $2::date`, [x.range.from, x.range.to]))).rows;
      for (const i of insp) out.push({ check: "inspection", date: i.date, subject: i.vehicle, detail: `${i.kind}${i.driver ? ` · ${i.driver}` : ""}`, value: i.defects ? 1 : 0, status: i.defects ? "defect" : "ok", count: 1 });
      const docs = (await withOrg(x.pool, x.orgId, (c) => c.query(
        `SELECT d.kind, d.expires_on::text AS expires, (d.expires_on - (now() AT TIME ZONE o.timezone)::date) AS days, coalesce(v.name, e.name, coalesce(u.display_name, u.email)) AS subject
         FROM documents d CROSS JOIN organizations o LEFT JOIN vehicles v ON d.owner_kind = 'vehicle' AND v.id = d.owner_id LEFT JOIN equipment e ON d.owner_kind = 'equipment' AND e.id = d.owner_id LEFT JOIN users u ON d.owner_kind = 'driver' AND u.id = d.owner_id
         WHERE d.expires_on IS NOT NULL`))).rows;
      for (const d of docs) out.push({ check: "document", date: d.expires, subject: d.subject, detail: d.kind, value: d.days, status: d.days < 0 ? "expired" : d.days <= 30 ? "expiring" : "ok", count: 1 });
      return out;
    },
  },
];

/** The same numbers as the dashboards, one row per driver, vehicle, route, day, depot or customer. */
for (const g of GROUPS) {
  DATASETS.push({
    key: `scorecard.${g}`, label: `Scorecard by ${g}`,
    columns: [txt(g === "day" ? "date" : g), ...Object.entries(METRICS).map(([k, m]): Column => ({ key: k, label: k, type: m.unit === "%" ? "num" : "num", agg: "avg" })), num("count")],
    async load(x) {
      const b = await x.bundle();
      return breakdown(b, g as Group).map((r) => ({ [g === "day" ? "date" : g]: r.name, ...r.metrics, count: 1 }));
    },
  });
}
DATASETS.push(...PORTAL_DATASETS);
export const DATASET_BY_KEY = new Map(DATASETS.map((d) => [d.key, d]));

// ---- spec and run ----

export type Op = "eq" | "ne" | "gt" | "gte" | "lt" | "lte" | "in" | "contains";
export interface ReportSpec {
  dataset: string;
  range?: { from?: string; to?: string; preset?: "last7" | "last30" | "last90" | "thisMonth" | "lastMonth" | "thisYear" | "last12months" | "allTime" | "yesterday" };
  filters?: { key: string; op: Op; value: unknown }[];
  /** Hard limits added by a share link or a person's own access. Not editable from the browser. */
  scope?: Filters;
  columns?: { key: string; agg?: Agg; label?: string }[];
  groupBy?: string[];
  calc?: { key: string; label?: string; formula: string }[];
  sort?: { key: string; dir: "asc" | "desc" } | null;
  limit?: number;
  chart?: { type: "bar" | "line" | "area" | "stacked" | "pie" | "donut" | "heat" | "funnel" | "scatter" | "waterfall" | "map" | "table"; x?: string; y?: string[]; series?: string; /** Group a date column by month on the chart. */ bucket?: "month" };
  pivot?: { row: string; col: string; value: string; agg?: Agg };
  title?: string;
}

const MAX_ROWS = 5000;
const AGGS = new Set(["sum", "avg", "count", "min", "max"]);

/** Turn "last7" and friends into dates, in the organization's time zone. */
export function resolveRange(r: ReportSpec["range"], today: string): Range {
  const add = (d: string, n: number) => new Date(Date.parse(d) + n * 86_400_000).toISOString().slice(0, 10);
  if (r?.from && r?.to) return { from: r.from, to: r.to };
  switch (r?.preset) {
    case "last30": return { from: add(today, -29), to: today };
    case "last90": return { from: add(today, -89), to: today };
    case "thisYear": return { from: `${today.slice(0, 4)}-01-01`, to: today };
    case "last12months": return { from: add(`${today.slice(0, 8)}01`, -365).slice(0, 8) + "01", to: today };
    case "allTime": return { from: "2000-01-01", to: today };
    case "thisMonth": return { from: `${today.slice(0, 8)}01`, to: today };
    case "lastMonth": { const first = `${today.slice(0, 8)}01`; const to = add(first, -1); return { from: `${to.slice(0, 8)}01`, to }; }
    case "yesterday": return { from: add(today, -1), to: add(today, -1) };
    default: return { from: add(today, -6), to: today };
  }
}

export function validateSpec(raw: unknown): ReportSpec {
  if (!raw || typeof raw !== "object") throw new BadRequestException("spec must be an object");
  const s = raw as ReportSpec;
  const ds = DATASET_BY_KEY.get(String(s.dataset));
  if (!ds) throw new BadRequestException(`dataset must be one of ${[...DATASET_BY_KEY.keys()].join(", ")}`);
  const cols = new Set(ds.columns.map((c) => c.key));
  const must = (k: unknown, what: string) => { if (typeof k !== "string" || !cols.has(k)) throw new BadRequestException(`${what} "${String(k)}" is not a column of ${ds.key}`); };
  if (s.columns && (!Array.isArray(s.columns) || s.columns.length > 40)) throw new BadRequestException("columns must be a list of up to 40");
  for (const c of s.columns ?? []) { must(c.key, "column"); if (c.agg && !AGGS.has(c.agg)) throw new BadRequestException("agg must be sum, avg, count, min or max"); }
  if (s.groupBy && (!Array.isArray(s.groupBy) || s.groupBy.length > 3)) throw new BadRequestException("groupBy must be a list of up to 3 columns");
  for (const g of s.groupBy ?? []) must(g, "group");
  for (const f of s.filters ?? []) {
    must(f.key, "filter");
    if (!["eq", "ne", "gt", "gte", "lt", "lte", "in", "contains"].includes(f.op)) throw new BadRequestException("unknown filter operator");
  }
  if ((s.filters?.length ?? 0) > 20) throw new BadRequestException("at most 20 filters");
  for (const c of s.calc ?? []) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,40}$/.test(c.key) || cols.has(c.key)) throw new BadRequestException(`calculated field name "${c.key}" is not allowed`);
    if (typeof c.formula !== "string" || c.formula.length > 200) throw new BadRequestException("formula must be up to 200 characters");
    try { evalFormula(c.formula, {}); } catch (e) { throw new BadRequestException(`formula "${c.formula}": ${(e as Error).message}`); }
  }
  if ((s.calc?.length ?? 0) > 10) throw new BadRequestException("at most 10 calculated fields");
  if (s.pivot) { must(s.pivot.row, "pivot row"); must(s.pivot.col, "pivot column"); must(s.pivot.value, "pivot value"); }
  if (s.limit != null && !(s.limit >= 1 && s.limit <= MAX_ROWS)) throw new BadRequestException(`limit must be 1 to ${MAX_ROWS}`);
  return s;
}

const cmp = (a: unknown, b: unknown) => (typeof a === "number" && typeof b === "number" ? a - b : String(a ?? "").localeCompare(String(b ?? "")));
function keep(row: Record<string, unknown>, f: { key: string; op: Op; value: unknown }): boolean {
  const v = row[f.key];
  const t = f.value;
  switch (f.op) {
    case "eq": return String(v ?? "") === String(t ?? "");
    case "ne": return String(v ?? "") !== String(t ?? "");
    case "gt": return v != null && Number(v) > Number(t);
    case "gte": return v != null && Number(v) >= Number(t);
    case "lt": return v != null && Number(v) < Number(t);
    case "lte": return v != null && Number(v) <= Number(t);
    case "in": return Array.isArray(t) && t.map(String).includes(String(v ?? ""));
    default: return String(v ?? "").toLowerCase().includes(String(t ?? "").toLowerCase());
  }
}

export interface ReportResult {
  dataset: string; range: Range; columns: { key: string; label: string; type: ColType; calc?: boolean; agg?: Agg }[]; rows: Record<string, unknown>[]; total: number; truncated: boolean;
  totals: Record<string, number | null>; pivot?: ReturnType<typeof pivot>; spec: ReportSpec;
}

/** Run a report: load the rows, filter, group and total them, add calculated columns, sort. */
export async function runReport(spec: ReportSpec, x: Omit<Ctx, "range" | "filters" | "bundle"> & { today: string }): Promise<ReportResult> {
  const ds = DATASET_BY_KEY.get(spec.dataset)!;
  const range = resolveRange(spec.range, x.today);
  const filters: Filters = spec.scope ?? {};
  let cached: Promise<Bundle> | null = null;
  const ctx: Ctx = { pool: x.pool, orgId: x.orgId, svc: x.svc, range, filters, perms: x.perms, bundle: () => (cached ??= x.svc.load(x.orgId, range, filters)) };
  let rows = await ds.load(ctx);
  for (const f of spec.filters ?? []) rows = rows.filter((r) => keep(r, f));
  const byKey = new Map(ds.columns.map((c) => [c.key, c]));
  const visible = ds.columns.filter((c) => !c.hidden);
  const chosen = (spec.columns?.length ? spec.columns : visible.filter((c) => c.key !== "count").map((c) => ({ key: c.key } as { key: string; agg?: Agg; label?: string })));
  const group = spec.groupBy ?? [];
  let out: Record<string, unknown>[];
  let outCols: ReportResult["columns"];
  if (group.length) {
    const buckets = new Map<string, Record<string, unknown>[]>();
    for (const r of rows) { const k = group.map((g) => String(r[g] ?? "")).join("\u0001"); (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(r); }
    const valueCols = chosen.filter((c) => !group.includes(c.key) && isNum(byKey.get(c.key)!.type));
    if (!valueCols.some((c) => c.key === "count")) valueCols.push({ key: "count", agg: "sum" });
    out = [...buckets.values()].map((rs) => {
      const o: Record<string, unknown> = {};
      for (const g of group) o[g] = rs[0]![g];
      for (const c of valueCols) {
        const col = byKey.get(c.key)!;
        const v = aggregate(rs.map((r) => Number(r[c.key])).filter((n) => r_ok(n)), c.agg ?? col.agg ?? "sum");
        o[c.key] = v == null ? null : round(col.scale ? v * col.scale : v, 2);
      }
      return o;
    });
    outCols = [...group.map((g) => ({ key: g, label: byKey.get(g)!.label, type: byKey.get(g)!.type })), ...valueCols.map((c) => ({ key: c.key, label: c.label ?? byKey.get(c.key)!.label, type: byKey.get(c.key)!.type, agg: (c.agg ?? byKey.get(c.key)!.agg) as Agg | undefined }))];
  } else {
    out = rows.map((r) => { const o: Record<string, unknown> = {}; for (const c of chosen) o[c.key] = r[c.key]; for (const c of ds.columns) if (c.hidden) o[c.key] = r[c.key]; return o; });
    outCols = chosen.map((c) => ({ key: c.key, label: c.label ?? byKey.get(c.key)!.label, type: byKey.get(c.key)!.type, agg: byKey.get(c.key)!.agg }));
  }
  for (const c of spec.calc ?? []) {
    for (const o of out) { const vars: Record<string, number | null> = {}; for (const [k, v] of Object.entries(o)) vars[k] = typeof v === "number" ? v : null; o[c.key] = round(evalFormula(c.formula, vars), 4); }
    outCols.push({ key: c.key, label: c.label ?? c.key, type: "num", calc: true });
  }
  if (spec.sort && outCols.some((c) => c.key === spec.sort!.key)) { const k = spec.sort.key, d = spec.sort.dir === "desc" ? -1 : 1; out.sort((a, b) => d * cmp(a[k], b[k])); }
  const total = out.length;
  const limit = spec.limit ?? MAX_ROWS;
  const totals: Record<string, number | null> = {};
  for (const c of outCols) if (isNum(c.type) && !group.includes(c.key)) { const vals = out.map((o) => o[c.key]).filter((v): v is number => typeof v === "number"); totals[c.key] = vals.length ? round(vals.reduce((a, b) => a + b, 0), 2) : null; }
  const result: ReportResult = { dataset: spec.dataset, range, columns: outCols, rows: out.slice(0, limit), total, truncated: total > limit, totals, spec };
  if (spec.pivot) result.pivot = pivot(rows, spec.pivot.row, spec.pivot.col, spec.pivot.value, spec.pivot.agg ?? "sum");
  return result;
}
const r_ok = (n: number) => Number.isFinite(n);
const isNum = (t: ColType) => t === "num" || t === "pct" || t === "money";

/** Refuse a report on money, pay, people or audit data unless the person may see that data. */
export function assertDatasetAllowed(spec: ReportSpec, perms: ReadonlySet<string> | undefined): void {
  const ds = DATASET_BY_KEY.get(spec.dataset);
  if (ds?.requires?.length && !ds.requires.some((p) => perms?.has(p))) throw new ForbiddenException(`The ${ds.label} data needs one of: ${ds.requires.join(", ")}`);
}

export function datasetInfo(perms?: ReadonlySet<string>) {
  return DATASETS.filter((d) => !perms || !d.requires?.length || d.requires.some((p) => perms.has(p))).map((d) => ({ key: d.key, label: d.label, about: d.about, columns: d.columns.filter((c) => !c.hidden).map(({ key, label, type, agg, scale }) => ({ key, label, type, agg, scale })) }));
}
