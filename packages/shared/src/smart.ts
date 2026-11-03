import { haversine } from "./geo.js";
import { median, percentile } from "./analytics.js";
import type { Fix } from "./trips.js";

/**
 * The "smart" helpers: learning from history, predicting, explaining and suggesting.
 * Everything here is plain arithmetic over data the app already has. These are simple, explainable
 * rules (and say so on screen), not trained models.
 */

const r1 = (x: number) => Math.round(x * 10) / 10;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const strip = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim();

/* ------------------------------------------------------------------ learn real stop times */
export interface DwellObs { key: string; label?: string; minutes: number; planned?: number | null }
export interface LearnedDwell { key: string; label: string; samples: number; medianMin: number; p80Min: number; plannedMin: number | null; diffMin: number | null }

/** Typical time at each customer (or address), from the stops the drivers actually did. Needs a few visits before it says anything. */
export function learnDwell(obs: readonly DwellObs[], minSamples = 3): LearnedDwell[] {
  const by = new Map<string, DwellObs[]>();
  for (const o of obs) if (Number.isFinite(o.minutes) && o.minutes >= 0 && o.minutes <= 240) (by.get(o.key) ?? by.set(o.key, []).get(o.key)!).push(o);
  const out: LearnedDwell[] = [];
  for (const [key, xs] of by) {
    if (xs.length < minSamples) continue;
    const mins = xs.map((x) => x.minutes);
    const med = median(mins)!, p80 = percentile(mins, 0.8)!;
    const planned = median(xs.map((x) => x.planned).filter((x): x is number => x != null));
    out.push({ key, label: xs[0]!.label ?? key, samples: xs.length, medianMin: r1(med), p80Min: r1(p80), plannedMin: planned == null ? null : r1(planned), diffMin: planned == null ? null : r1(med - planned) });
  }
  return out.sort((a, b) => Math.abs(b.diffMin ?? 0) - Math.abs(a.diffMin ?? 0) || b.samples - a.samples);
}

/* ------------------------------------------------------------------ demand forecast */
export interface DemandDay { date: string; jobs: number; low: number; high: number; drivers: number }

const dow = (d: string) => new Date(`${d}T12:00:00Z`).getUTCDay();
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Jobs expected on each coming day: the average of the same weekday over recent weeks, nudged by the recent trend. */
export function demandForecast(history: readonly { date: string; value: number }[], fromDate: string, days: number, stopsPerDriver: number): DemandDay[] {
  const byDate = new Map(history.map((h) => [h.date, h.value]));
  const dates = [...byDate.keys()].sort();
  if (dates.length === 0) return [];
  const last = dates[dates.length - 1]!;
  const recent = (a: number, b: number) => { let s = 0, n = 0; for (let i = a; i <= b; i++) { const v = byDate.get(addDays(last, -i)); if (v != null) { s += v; n++; } } return n ? s / n : null; };
  const r = recent(0, 13), p = recent(14, 27);
  const trend = r != null && p != null && p > 0 ? clamp(r / p, 0.7, 1.4) : 1;
  const out: DemandDay[] = [];
  for (let k = 0; k < days; k++) {
    const date = addDays(fromDate, k);
    const same: number[] = [];
    for (let w = 1; w <= 8; w++) { const v = byDate.get(addDays(date, -7 * w)); if (v != null) same.push(v); }
    const base = same.length ? same.reduce((a, b) => a + b, 0) / same.length : (recent(0, 27) ?? 0);
    const sd = same.length > 1 ? Math.sqrt(same.reduce((a, b) => a + (b - base) ** 2, 0) / (same.length - 1)) : base * 0.25;
    const jobs = Math.max(0, Math.round(base * trend));
    out.push({ date, jobs, low: Math.max(0, Math.round(jobs - sd)), high: Math.round(jobs + sd), drivers: jobs === 0 ? 0 : Math.ceil(jobs / Math.max(1, stopsPerDriver)) });
  }
  return out;
}

/* ------------------------------------------------------------------ explain delays */
export interface ExplainStop { name: string; windowEnd: number | null; arrivedAt: number | null; departedAt: number | null; serviceMin: number | null; status: string; failureReason?: string | null }
export interface ExplainInput { stops: readonly ExplainStop[]; startedAt: number | null; plannedStart: number | null; helpRequests?: number; weatherAlerts?: number; idleMin?: number }
export type CauseKind = "late_start" | "long_stop" | "failed_stop" | "help" | "weather" | "idle" | "driving";
export interface Cause { kind: CauseKind; minutes: number | null; stop?: string; reason?: string }
export interface Explanation { lateStops: { name: string; lateMin: number }[]; worstLateMin: number; causes: Cause[] }

/** Why a route ran late, from what is recorded: a late start, stops that took longer than planned, failed stops, calls for help, weather, idling. The rest is driving time (traffic is not measured). */
export function explainDelays(x: ExplainInput): Explanation {
  const lateStops = x.stops.filter((s) => s.windowEnd != null && s.arrivedAt != null && s.arrivedAt > s.windowEnd).map((s) => ({ name: s.name, lateMin: Math.round((s.arrivedAt! - s.windowEnd!) / 60000) })).filter((s) => s.lateMin > 0);
  const worst = lateStops.reduce((a, b) => Math.max(a, b.lateMin), 0);
  const causes: Cause[] = [];
  let explained = 0;
  if (x.startedAt != null && x.plannedStart != null && x.startedAt - x.plannedStart > 5 * 60000) { const m = Math.round((x.startedAt - x.plannedStart) / 60000); causes.push({ kind: "late_start", minutes: m }); explained += m; }
  for (const s of x.stops) {
    if (s.arrivedAt == null || s.departedAt == null) continue;
    const dwell = (s.departedAt - s.arrivedAt) / 60000;
    const over = dwell - (s.serviceMin ?? 5);
    if (s.status === "failed") causes.push({ kind: "failed_stop", minutes: Math.round(dwell), stop: s.name, reason: s.failureReason ?? undefined });
    else if (over >= 5) { causes.push({ kind: "long_stop", minutes: Math.round(over), stop: s.name }); explained += over; }
  }
  if ((x.helpRequests ?? 0) > 0) causes.push({ kind: "help", minutes: null });
  if ((x.weatherAlerts ?? 0) > 0) causes.push({ kind: "weather", minutes: null });
  if ((x.idleMin ?? 0) >= 15) { causes.push({ kind: "idle", minutes: Math.round(x.idleMin!) }); explained += x.idleMin!; }
  const rest = Math.round(worst - explained);
  if (worst > 0 && rest >= 5) causes.push({ kind: "driving", minutes: rest });
  causes.sort((a, b) => (b.minutes ?? 0) - (a.minutes ?? 0));
  return { lateStops, worstLateMin: worst, causes };
}

/* ------------------------------------------------------------------ predict late deliveries */
export interface RiskStop { id: string; name: string; etaMs: number; windowEndMs: number | null }
export interface LateRisk { id: string; name: string; slackMin: number; probability: number; level: "low" | "medium" | "high" }

const erf = (x: number) => { const s = Math.sign(x); x = Math.abs(x); const t = 1 / (1 + 0.3275911 * x); return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x)); };
const normCdf = (z: number) => 0.5 * (1 + erf(z / Math.SQRT2));

/** How likely each coming stop is to miss its window: the slack between the ETA and the window end, against how much ETAs usually wobble (more the further away the stop is). */
export function lateRisk(stops: readonly RiskStop[], nowMs: number, wobbleMin = 8): LateRisk[] {
  const out: LateRisk[] = [];
  for (const s of stops) {
    if (s.windowEndMs == null) continue;
    const slack = (s.windowEndMs - s.etaMs) / 60000;
    const sd = wobbleMin + 0.1 * Math.max(0, (s.etaMs - nowMs) / 60000);
    const p = Math.round(normCdf(-slack / sd) * 100) / 100;
    out.push({ id: s.id, name: s.name, slackMin: Math.round(slack), probability: p, level: p >= 0.6 ? "high" : p >= 0.25 ? "medium" : "low" });
  }
  return out.sort((a, b) => b.probability - a.probability);
}

/* ------------------------------------------------------------------ predict breakdowns */
export interface VehicleHealth {
  odometerKm: number | null; ageYears: number | null; kmSinceService: number | null; serviceEveryKm: number | null; daysSinceService: number | null; serviceEveryDays: number | null;
  openDefects: number; incidents90: number; repairs90: number; downtimeH90: number; lPer100Now: number | null; lPer100Base: number | null;
}
export interface BreakdownRisk { score: number; level: "low" | "medium" | "high"; reasons: { key: string; points: number; value?: number }[] }

/** A simple points score: overdue service, open defects, fuel use creeping up, repeat repairs, age and mileage. A prompt to look at the vehicle, not a prediction from a trained model. */
export function breakdownRisk(v: VehicleHealth): BreakdownRisk {
  const reasons: BreakdownRisk["reasons"] = [];
  const add = (key: string, points: number, value?: number) => { if (points > 0) reasons.push({ key, points: Math.round(points), value }); };
  if (v.kmSinceService != null && v.serviceEveryKm) add("service_km", clamp((v.kmSinceService / v.serviceEveryKm - 0.8) * 100, 0, 30), Math.round(v.kmSinceService));
  if (v.daysSinceService != null && v.serviceEveryDays) add("service_days", clamp((v.daysSinceService / v.serviceEveryDays - 0.8) * 60, 0, 20), v.daysSinceService);
  add("open_defects", Math.min(25, v.openDefects * 12), v.openDefects);
  if (v.lPer100Now != null && v.lPer100Base != null && v.lPer100Base > 0) { const up = (v.lPer100Now / v.lPer100Base - 1) * 100; add("fuel_up", clamp(up * 1.5, 0, 20), Math.round(up)); }
  add("repairs", Math.min(15, v.repairs90 * 5), v.repairs90);
  add("downtime", clamp(v.downtimeH90 / 4, 0, 10), Math.round(v.downtimeH90));
  add("incidents", Math.min(10, v.incidents90 * 5), v.incidents90);
  if (v.ageYears != null) add("age", clamp((v.ageYears - 8) * 1.5, 0, 8), Math.round(v.ageYears));
  if (v.odometerKm != null) add("mileage", clamp((v.odometerKm - 300_000) / 20_000, 0, 8), Math.round(v.odometerKm));
  const score = Math.min(100, reasons.reduce((a, b) => a + b.points, 0));
  return { score, level: score >= 55 ? "high" : score >= 30 ? "medium" : "low", reasons: reasons.sort((a, b) => b.points - a.points) };
}

/* ------------------------------------------------------------------ best driver for a job */
export interface JobNeed { lat: number; lng: number; skills: readonly string[]; customer?: string | null; weightKg?: number }
export interface DriverCtx {
  id: string; name: string; skills: readonly string[]; lat: number | null; lng: number | null; stopsToday: number; maxStops: number; onTimeRate: number | null;
  csat: number | null; visitsHere: number; onTimeHere: number | null; prefers?: { zones?: readonly string[]; avoidCustomers?: readonly string[]; maxStops?: number } | null; offToday?: boolean;
}
export interface DriverScore { driverId: string; name: string; score: number; blocked: string | null; reasons: { key: string; points: number; value?: number | string }[] }

/** Rank drivers for a job: must have the skills and be working; then closeness, a light day, past results (overall and at this customer) and the driver's own preferences. */
export function suggestDrivers(job: JobNeed, drivers: readonly DriverCtx[]): DriverScore[] {
  const out = drivers.map<DriverScore>((d) => {
    const reasons: DriverScore["reasons"] = [];
    const add = (key: string, points: number, value?: number | string) => { if (points) reasons.push({ key, points: Math.round(points), value }); };
    const missing = job.skills.filter((s) => !d.skills.includes(s));
    let blocked: string | null = null;
    if (d.offToday) blocked = "off_today";
    else if (missing.length) blocked = "skills";
    else if (d.stopsToday >= (d.prefers?.maxStops ?? d.maxStops)) blocked = "full";
    else if (job.customer && d.prefers?.avoidCustomers?.some((c) => strip(c) === strip(job.customer!))) blocked = "avoids_customer";
    if (job.skills.length) add("skills", 10);
    if (d.lat != null && d.lng != null) { const km = haversine(job.lat, job.lng, d.lat, d.lng) / 1000; add("near", clamp(40 - km * 2, 0, 40), r1(km)); }
    add("light_day", clamp((1 - d.stopsToday / Math.max(1, d.maxStops)) * 20, 0, 20), d.stopsToday);
    if (d.onTimeRate != null) add("on_time", clamp((d.onTimeRate - 80) * 0.75, 0, 15), d.onTimeRate);
    if (d.csat != null) add("csat", clamp((d.csat - 3.5) * 6, 0, 9), d.csat);
    if (d.visitsHere >= 2) add("knows_customer", Math.min(12, 4 + d.visitsHere * 2) * (d.onTimeHere == null ? 0.7 : d.onTimeHere >= 80 ? 1 : 0.5), d.visitsHere);
    return { driverId: d.id, name: d.name, score: blocked ? 0 : Math.round(reasons.reduce((a, b) => a + b.points, 0)), blocked, reasons: reasons.sort((a, b) => b.points - a.points) };
  });
  return out.sort((a, b) => Number(!!a.blocked) - Number(!!b.blocked) || b.score - a.score);
}

/* ------------------------------------------------------------------ smart address fixing */
const ABBR: [RegExp, string][] = [
  [/\bst\.?(?=\s|,|$)/gi, "Street"], [/\bave\.?(?=\s|,|$)/gi, "Avenue"], [/\bblvd\.?(?=\s|,|$)/gi, "Boulevard"], [/\brd\.?(?=\s|,|$)/gi, "Road"], [/\bdr\.?(?=\s|,|$)/gi, "Drive"],
  [/\bhwy\.?(?=\s|,|$)/gi, "Highway"], [/\bcres\.?(?=\s|,|$)/gi, "Crescent"], [/\bpl\.?(?=\s|,|$)/gi, "Place"], [/\bct\.?(?=\s|,|$)/gi, "Court"], [/\bln\.?(?=\s|,|$)/gi, "Lane"], [/\bpkwy\.?(?=\s|,|$)/gi, "Parkway"],
];
const PROVINCES: Record<string, string> = { ontario: "ON", quebec: "QC", "québec": "QC", "british columbia": "BC", alberta: "AB", manitoba: "MB", saskatchewan: "SK", "nova scotia": "NS", "new brunswick": "NB", "newfoundland and labrador": "NL", "prince edward island": "PE", yukon: "YT", nunavut: "NU", "northwest territories": "NT" };
const titleWord = (w: string) => (/^(?:n|s|e|w|ne|nw|se|sw)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

export interface Normalized { text: string; changes: string[] }

/** Tidy a messy address: spelling out street types, fixing capitals, Canadian postal code spacing, province names, "Unit 5 - 123 Main" ordering. The result is then looked up on the map. */
export function normalizeAddress(raw: string): Normalized {
  const changes: string[] = [];
  let s = raw.replace(/\s+/g, " ").replace(/\s*,\s*/g, ", ").trim();
  if (!s) return { text: "", changes };
  const unit = s.match(/^(?:(?:unit|apt|suite|ste|#)\s*)?([0-9A-Za-z]{1,5})\s*[-–]\s*(\d+[A-Za-z]?\s.*)$/i);
  if (unit) { s = `${unit[2]}, Unit ${unit[1]}`; changes.push("unit_order"); }
  const fixed = s.replace(/[A-Za-zÀ-ÿ']+/g, (w) => (w.length > 1 && (w === w.toUpperCase() || w === w.toLowerCase()) && !/^(?:de|du|des|la|le|les|d'|l'|of|the)$/i.test(w) ? titleWord(w) : w));
  if (fixed !== s) { s = fixed; changes.push("capitals"); }
  for (const [re, full] of ABBR) { const t = s.replace(re, full); if (t !== s) { s = t; if (!changes.includes("street_type")) changes.push("street_type"); } }
  s = s.replace(/\b([A-Za-z]\d[A-Za-z])\s*(\d[A-Za-z]\d)\b/g, (_m, a: string, b: string) => { changes.push("postal_code"); return `${a.toUpperCase()} ${b.toUpperCase()}`; });
  for (const [name, code] of Object.entries(PROVINCES)) { const re = new RegExp(`\\b${name}\\b`, "i"); if (re.test(s)) { s = s.replace(re, code); changes.push("province"); } }
  s = s.replace(/\b(on|qc|bc|ab|mb|sk|ns|nb|nl|pe|yt|nu|nt)\b/gi, (m) => m.toUpperCase());
  return { text: s, changes: [...new Set(changes)] };
}

/* ------------------------------------------------------------------ chat assistant: understand a sentence */
export interface AssistantContext { drivers: readonly { id: string; name: string }[]; today: string }
export type AssistantIntent =
  | { type: "reassign"; fromId: string; toId: string; date: string; notify: boolean }
  | { type: "report"; template: string; range: "yesterday" | "last7" | "last30" | "thisMonth" | "lastMonth"; groupBy: string | null }
  | { type: "briefing" } | { type: "late" } | { type: "forecast" } | { type: "explain"; routeHint: string | null }
  | { type: "unknown"; reason: "no_match" | "driver_not_found" | "same_driver"; name?: string };

export function findPerson(name: string, people: readonly { id: string; name: string }[]): { id: string; name: string } | null {
  const q = strip(name).replace(/^(?:driver|chauffeur|mr\.?|ms\.?)\s+/, "").replace(/['’]s$/, "");
  if (!q) return null;
  const exact = people.find((p) => strip(p.name) === q);
  if (exact) return exact;
  const part = people.filter((p) => strip(p.name).split(/[\s@.]+/).includes(q) || strip(p.name).startsWith(q));
  return part.length === 1 ? part[0]! : null;
}

const RANGE_WORDS: [RegExp, "yesterday" | "last7" | "last30" | "thisMonth" | "lastMonth"][] = [
  [/yesterday|hier/, "yesterday"], [/last month|previous month|mois dernier|mois pass/, "lastMonth"], [/this month|ce mois/, "thisMonth"],
  [/last 30|30 days|30 jours|past month/, "last30"], [/last week|past week|7 days|7 jours|semaine derni|semaine pass|this week|cette semaine/, "last7"],
];
const REPORT_WORDS: [RegExp, string][] = [
  [/fuel|carburant|essence|emission|co2/, "fuelEmissions"], [/idle|idling|ralenti/, "idle"], [/mileage|kilom|distance|\bkm\b/, "mileage"], [/driver|chauffeur/, "driverScorecard"],
  [/vehicle|truck|bus|camion|v[ée]hicule|maintenance|repair/, "vehicleHealth"], [/customer|client/, "customerService"], [/exception|fail|[ée]chec|late|retard|problem/, "exceptions"],
  [/route efficiency|efficien|itin[ée]raire/, "routeEfficiency"], [/billing|invoice|factur/, "billing"], [/geofence|zone/, "geofenceVisits"], [/compliance|conform/, "compliance"],
];

/** Read one plain sentence in English or French and say what it asks for. Anything it cannot read is returned as "unknown" so the person is asked, never guessed at. */
export function parseAssistant(textRaw: string, ctx: AssistantContext): AssistantIntent {
  const text = textRaw.trim().replace(/[?!.]+$/, "");
  const t = strip(text);
  const move = text.match(/(?:move|reassign|give|hand|transfer|switch|d[ée]place\w*|transf[èe]re\w*|donne\w*|r[ée]affecte\w*)\s+(?:all\s+(?:of\s+)?|tous\s+(?:les\s+)?|toutes\s+(?:les\s+)?|les\s+)?(.+?)(?:'s|’s|s')?\s+(?:stops|jobs|deliveries|route|work|arr[êe]ts|livraisons|travaux|tourn[ée]e)\s+(?:over\s+)?(?:to|[àa])\s+([^,]+?)(?:\s+(?:and|et|,)\s+.*)?$/i)
    ?? text.match(/(?:move|d[ée]place\w*)\s+(?:tous\s+)?(?:les\s+)?(?:arr[êe]ts|livraisons)\s+de\s+(.+?)\s+[àa]\s+([^,]+?)(?:\s+et\s+.*)?$/i);
  if (move) {
    const clean = (x: string) => x.replace(/\s+(?:today|tomorrow|aujourd'hui|demain)$/i, "");
    const a = findPerson(clean(move[1]!), ctx.drivers), b = findPerson(clean(move[2]!), ctx.drivers);
    if (!a) return { type: "unknown", reason: "driver_not_found", name: move[1]!.trim() };
    if (!b) return { type: "unknown", reason: "driver_not_found", name: move[2]!.trim() };
    if (a.id === b.id) return { type: "unknown", reason: "same_driver" };
    const date = /tomorrow|demain/.test(t) ? new Date(Date.parse(`${ctx.today}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10) : ctx.today;
    return { type: "reassign", fromId: a.id, toId: b.id, date, notify: /\b(tell|notify|inform|message|text|email)\b.*\bcustomers?\b|pr[ée]vien|averti|inform\w+.*client/.test(t) };
  }
  if (/\b(report|rapport)\b/.test(t) || /^(show|build|make|create|montre|fais|cr[ée]e)\b.*\b(by|par)\b/.test(t)) {
    const template = REPORT_WORDS.find(([re]) => re.test(t))?.[1] ?? "daily";
    const range = RANGE_WORDS.find(([re]) => re.test(t))?.[1] ?? "last7";
    const by = t.match(/\b(?:by|par)\s+(driver|chauffeur|vehicle|vehicule|day|jour|customer|client|route)\b/)?.[1];
    return { type: "report", template, range, groupBy: by ? ({ chauffeur: "driver", vehicule: "vehicle", jour: "day", client: "customer" } as Record<string, string>)[by] ?? by : null };
  }
  if (/why\b.*\b(late|delay)|pourquoi\b.*\bretard|explain\b.*\b(late|delay)|expliqu\w+.*retard/.test(t)) return { type: "explain", routeHint: text.match(/route\s+([\w-]+)/i)?.[1] ?? null };
  if (/briefing|attention|what.?s (going on|happening)|summary of (the )?day|r[ée]sum[ée]|quoi de neuf|point du jour/.test(t)) return { type: "briefing" };
  if (/forecast|next week|how many drivers|pr[ée]vision|semaine prochaine|combien de chauffeurs/.test(t)) return { type: "forecast" };
  if (/\b(late|behind|delayed)\b|en retard|retard/.test(t)) return { type: "late" };
  return { type: "unknown", reason: "no_match" };
}

/* ------------------------------------------------------------------ territories and balance */
export interface Pt { id: string; lat: number; lng: number }
export interface Cluster { index: number; centre: { lat: number; lng: number }; ids: string[]; hull: [number, number][] }

function hullOf(pts: readonly Pt[]): [number, number][] {
  const p = [...pts].map((x) => [x.lng, x.lat] as [number, number]).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p.map(([lng, lat]) => [lat, lng]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0]! - o[0]!) * (b[1]! - o[1]!) - (a[1]! - o[1]!) * (b[0]! - o[0]!);
  const lo: [number, number][] = [], up: [number, number][] = [];
  for (const q of p) { while (lo.length >= 2 && cross(lo[lo.length - 2]!, lo[lo.length - 1]!, q) <= 0) lo.pop(); lo.push(q); }
  for (const q of [...p].reverse()) { while (up.length >= 2 && cross(up[up.length - 2]!, up[up.length - 1]!, q) <= 0) up.pop(); up.push(q); }
  return [...lo.slice(0, -1), ...up.slice(0, -1)].map(([lng, lat]) => [lat, lng]);
}

/** Split points into k areas of nearly equal size: pick far-apart centres, then assign each point to the nearest centre that still has room, and repeat. Same input always gives the same answer. */
export function clusterTerritories(points: readonly Pt[], k: number, iterations = 12): Cluster[] {
  const n = points.length;
  k = Math.max(1, Math.min(k, n));
  if (n === 0) return [];
  let centres = [points[0]!].map((p) => ({ lat: p.lat, lng: p.lng }));
  while (centres.length < k) {
    let best = -1, bd = -1;
    points.forEach((p, i) => { const d = Math.min(...centres.map((c) => haversine(p.lat, p.lng, c.lat, c.lng))); if (d > bd) { bd = d; best = i; } });
    centres.push({ lat: points[best]!.lat, lng: points[best]!.lng });
  }
  const cap = Math.ceil(n / k);
  let groups: Pt[][] = [];
  for (let it = 0; it < iterations; it++) {
    groups = Array.from({ length: k }, () => []);
    const order = points.map((p, i) => ({ p, i, d: Math.min(...centres.map((c) => haversine(p.lat, p.lng, c.lat, c.lng))) })).sort((a, b) => b.d - a.d || a.i - b.i);
    for (const { p } of order) {
      const ranked = centres.map((c, ci) => ({ ci, d: haversine(p.lat, p.lng, c.lat, c.lng) })).sort((a, b) => a.d - b.d);
      const ci = ranked.find((r) => groups[r.ci]!.length < cap)!.ci;
      groups[ci]!.push(p);
    }
    const next = groups.map((g, i) => (g.length ? { lat: g.reduce((a, b) => a + b.lat, 0) / g.length, lng: g.reduce((a, b) => a + b.lng, 0) / g.length } : centres[i]!));
    const moved = next.some((c, i) => Math.abs(c.lat - centres[i]!.lat) > 1e-6 || Math.abs(c.lng - centres[i]!.lng) > 1e-6);
    centres = next;
    if (!moved) break;
  }
  return groups.map((g, i) => ({ index: i, centre: centres[i]!, ids: g.map((p) => p.id), hull: hullOf(g) }));
}

export interface Load { id: string; name: string; stops: number; minutes: number; km: number }
export interface Balance { meanMinutes: number; spreadPct: number; overloaded: string[]; underloaded: string[]; fair: boolean }

/** How even is the day? Compares each driver's planned minutes with the average of everyone given (leave out people who are off). */
export function workloadBalance(loads: readonly Load[], tolerancePct = 20): Balance {
  if (loads.length === 0 || loads.every((l) => l.minutes === 0 && l.stops === 0)) return { meanMinutes: 0, spreadPct: 0, overloaded: [], underloaded: [], fair: true };
  const mean = loads.reduce((a, b) => a + b.minutes, 0) / loads.length;
  const hi = Math.max(...loads.map((l) => l.minutes)), lo = Math.min(...loads.map((l) => l.minutes));
  const spread = mean > 0 ? ((hi - lo) / mean) * 100 : 0;
  return {
    meanMinutes: Math.round(mean), spreadPct: Math.round(spread),
    overloaded: loads.filter((l) => mean > 0 && l.minutes > mean * (1 + tolerancePct / 100)).map((l) => l.id),
    underloaded: loads.filter((l) => l.minutes < mean * (1 - tolerancePct / 100)).map((l) => l.id), fair: spread <= tolerancePct * 2,
  };
}

export interface MovableStop { id: string; driverId: string; lat: number; lng: number; minutes: number }
export interface Move { stopId: string; fromId: string; toId: string; minutes: number }

/** Suggest moving stops from the busiest driver to the lightest, taking those closest to the lighter driver's centre, until the two are within the tolerance. */
export function suggestMoves(loads: readonly Load[], stops: readonly MovableStop[], tolerancePct = 20, maxMoves = 20): Move[] {
  const cur = new Map(loads.map((l) => [l.id, l.minutes]));
  const left = new Map<string, MovableStop[]>();
  for (const s of stops) (left.get(s.driverId) ?? left.set(s.driverId, []).get(s.driverId)!).push(s);
  const moves: Move[] = [];
  for (let i = 0; i < maxMoves; i++) {
    const ids = loads.map((l) => l.id);
    const mean = ids.reduce((a, id) => a + cur.get(id)!, 0) / Math.max(1, ids.length);
    const from = ids.reduce((a, b) => (cur.get(b)! > cur.get(a)! ? b : a));
    const to = ids.reduce((a, b) => (cur.get(b)! < cur.get(a)! ? b : a));
    if (from === to || cur.get(from)! <= mean * (1 + tolerancePct / 100)) break;
    const mine = left.get(from) ?? [];
    const theirs = [...(left.get(to) ?? [])];
    const ref = theirs.length ? { lat: theirs.reduce((a, b) => a + b.lat, 0) / theirs.length, lng: theirs.reduce((a, b) => a + b.lng, 0) / theirs.length } : null;
    const gap = (cur.get(from)! - cur.get(to)!) / 2;
    const fits = mine.filter((s) => s.minutes <= gap + 1);
    if (fits.length === 0) break;
    fits.sort((a, b) => (ref ? haversine(a.lat, a.lng, ref.lat, ref.lng) - haversine(b.lat, b.lng, ref.lat, ref.lng) : 0) || a.id.localeCompare(b.id));
    const pick = fits[0]!;
    moves.push({ stopId: pick.id, fromId: from, toId: to, minutes: pick.minutes });
    cur.set(from, cur.get(from)! - pick.minutes); cur.set(to, cur.get(to)! + pick.minutes);
    left.set(from, mine.filter((s) => s.id !== pick.id)); (left.get(to) ?? left.set(to, []).get(to)!).push({ ...pick, driverId: to });
  }
  return moves;
}

/* ------------------------------------------------------------------ backhaul, shared rides */
export interface Candidate { id: string; lat: number; lng: number; weightKg?: number }

/** Pickups that sit on the way home: the extra distance of going last-stop → pickup → depot instead of straight back. */
export function backhaul(last: { lat: number; lng: number }, home: { lat: number; lng: number }, cands: readonly Candidate[], spareKg: number | null, maxDetourKm = 8) {
  const direct = haversine(last.lat, last.lng, home.lat, home.lng) / 1000;
  return cands.filter((c) => spareKg == null || (c.weightKg ?? 0) <= spareKg)
    .map((c) => ({ id: c.id, detourKm: r1((haversine(last.lat, last.lng, c.lat, c.lng) + haversine(c.lat, c.lng, home.lat, home.lng)) / 1000 - direct) }))
    .filter((c) => c.detourKm <= maxDetourKm).sort((a, b) => a.detourKm - b.detourKm);
}

export interface RideReq { id: string; from: { lat: number; lng: number }; to: { lat: number; lng: number }; seats: number; atMs: number | null }

/** Put people going the same way at about the same time into one vehicle: pick-ups close together, drop-offs close together, within a time gap and the seats available. */
export function groupRides(reqs: readonly RideReq[], seats: number, maxKm = 3, maxGapMin = 20): { ids: string[]; seats: number }[] {
  const groups: { ids: string[]; seats: number; from: RideReq["from"]; to: RideReq["to"]; at: number | null }[] = [];
  for (const r of [...reqs].sort((a, b) => (a.atMs ?? 0) - (b.atMs ?? 0) || a.id.localeCompare(b.id))) {
    const g = groups.find((x) => x.seats + r.seats <= seats && haversine(x.from.lat, x.from.lng, r.from.lat, r.from.lng) / 1000 <= maxKm && haversine(x.to.lat, x.to.lng, r.to.lat, r.to.lng) / 1000 <= maxKm
      && (x.at == null || r.atMs == null || Math.abs(x.at - r.atMs) <= maxGapMin * 60000));
    if (g) { g.ids.push(r.id); g.seats += r.seats; } else groups.push({ ids: [r.id], seats: r.seats, from: r.from, to: r.to, at: r.atMs });
  }
  return groups.map((g) => ({ ids: g.ids, seats: g.seats }));
}

/* ------------------------------------------------------------------ safety: cornering, crash, fatigue, coaching */
export interface Corner { time: string; lat: number; lng: number; lateralG: number }

/** Hard cornering: sideways acceleration from speed and how fast the heading turns (over 0.3 g). */
export function detectCornering(fixes: readonly (Fix & { heading?: number | null })[], thresholdG = 0.3): Corner[] {
  const out: Corner[] = [];
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1]!, b = fixes[i]!;
    const dt = (Date.parse(b.time) - Date.parse(a.time)) / 1000;
    if (!(dt > 0 && dt <= 10) || a.heading == null || b.heading == null) continue;
    let dh = Math.abs(b.heading - a.heading); if (dh > 180) dh = 360 - dh;
    const v = ((a.speed + b.speed) / 2) / 3.6;
    const g = (v * ((dh * Math.PI) / 180 / dt)) / 9.81;
    if (v > 5 && g >= thresholdG) out.push({ time: b.time, lat: b.lat, lng: b.lng, lateralG: Math.round(g * 100) / 100 });
  }
  return out;
}

export interface CrashSuspect { time: string; lat: number; lng: number; fromKmh: number; secondsToStop: number }

/** A possible crash: from 40 km/h or more to a stop within 3 seconds and still stopped 30 seconds later. Phones with a motion sensor report the same thing more directly. */
export function detectCrash(fixes: readonly Fix[]): CrashSuspect[] {
  const out: CrashSuspect[] = [];
  for (let i = 1; i < fixes.length; i++) {
    const a = fixes[i - 1]!;
    if (a.speed < 40) continue;
    const t0 = Date.parse(a.time);
    const stop = fixes.slice(i).find((f) => Date.parse(f.time) - t0 <= 3000 && f.speed < 3);
    if (!stop) continue;
    const later = fixes.filter((f) => Date.parse(f.time) - Date.parse(stop.time) >= 30_000 && Date.parse(f.time) - Date.parse(stop.time) <= 120_000);
    if (later.length && later.every((f) => f.speed < 3)) { out.push({ time: stop.time, lat: stop.lat, lng: stop.lng, fromKmh: Math.round(a.speed), secondsToStop: Math.round((Date.parse(stop.time) - t0) / 1000) }); i += 30; }
  }
  return out;
}

export interface Fatigue { level: "ok" | "soon" | "now"; drivingMin: number; sinceBreakMin: number; shiftMin: number }

/** Fatigue warning from hours: continuous time on the shift since the last break (default warn at 4 h, stop at 5 h) and total shift length (warn at 9 h, stop at 11 h). */
export function fatigueState(shiftMin: number, sinceBreakMin: number, o: { warnBreakMin?: number; maxBreakMin?: number; warnShiftMin?: number; maxShiftMin?: number } = {}): Fatigue {
  const wb = o.warnBreakMin ?? 240, mb = o.maxBreakMin ?? 300, ws = o.warnShiftMin ?? 540, ms = o.maxShiftMin ?? 660;
  const level = sinceBreakMin >= mb || shiftMin >= ms ? "now" : sinceBreakMin >= wb || shiftMin >= ws ? "soon" : "ok";
  return { level, drivingMin: Math.round(shiftMin), sinceBreakMin: Math.round(sinceBreakMin), shiftMin: Math.round(shiftMin) };
}

export interface TripStats { km: number; speeding: number; harshBrake: number; harshAccel: number; corner: number; idleMin: number }
export interface Tip { key: "tip_speed" | "tip_brake" | "tip_accel" | "tip_corner" | "tip_idle" | "tip_great"; value?: number }

/** Up to two short tips for a driver after a trip, based on what stood out. */
export function coachingTips(s: TripStats): Tip[] {
  const per100 = (n: number) => (s.km >= 5 ? (n / s.km) * 100 : n);
  const t: { tip: Tip; w: number }[] = [];
  if (s.speeding) t.push({ tip: { key: "tip_speed", value: s.speeding }, w: per100(s.speeding) * 3 });
  if (s.harshBrake) t.push({ tip: { key: "tip_brake", value: s.harshBrake }, w: per100(s.harshBrake) * 2 });
  if (s.harshAccel) t.push({ tip: { key: "tip_accel", value: s.harshAccel }, w: per100(s.harshAccel) * 1.5 });
  if (s.corner) t.push({ tip: { key: "tip_corner", value: s.corner }, w: per100(s.corner) * 1.5 });
  if (s.idleMin >= 10) t.push({ tip: { key: "tip_idle", value: Math.round(s.idleMin) }, w: s.idleMin / 5 });
  if (t.length === 0) return [{ key: "tip_great" }];
  return t.sort((a, b) => b.w - a.w).slice(0, 2).map((x) => x.tip);
}
