import { haversine } from "./geo.js";

/**
 * Route planning: orders stops for one vehicle or splits them across several, honouring time windows,
 * vehicle capacity, shift and break limits, pickup-before-delivery pairs, skills, territories and
 * electric range. The travel model is pluggable (straight-line with a road factor and rush-hour speeds
 * here; a road-network provider such as OSRM or Valhalla can supply real times).
 */

export interface LatLng { lat: number; lng: number }
export type Priority = "low" | "normal" | "high" | "urgent";
export type Objective = "time" | "distance";

export interface PlanStop extends LatLng {
  id: string;
  serviceMin?: number;
  /** Epoch milliseconds. */
  windowStart?: number | null;
  windowEnd?: number | null;
  weightKg?: number;
  volumeM3?: number;
  items?: number;
  priority?: Priority;
  /** "pickup" adds load to the vehicle, anything else removes it. */
  kind?: "pickup" | "delivery" | string;
  /** A pickup and a delivery with the same pairId must be on the same vehicle, pickup first. */
  pairId?: string;
  skills?: string[];
  territory?: string;
}

export interface PlanVehicle {
  id: string;
  start: LatLng;
  /** Where the day ends. Default: back at the start. Set `openEnd` to end at the last stop. */
  end?: LatLng | null;
  openEnd?: boolean;
  /** Epoch milliseconds. */
  shiftStart: number;
  maxShiftMin?: number;
  breakAfterMin?: number;
  breakMin?: number;
  capacityKg?: number;
  capacityM3?: number;
  capacityItems?: number;
  skills?: string[];
  /** If set, the vehicle only serves stops in these territories (and stops without one). */
  territories?: string[];
  rangeKm?: number;
  chargers?: LatLng[];
  chargeMin?: number;
}

/** Seconds and metres to drive from a to b when leaving at `departMs`. */
export type TravelFn = (a: LatLng, b: LatLng, departMs: number) => { s: number; m: number };

export const PRIORITY_WEIGHT: Record<Priority, number> = { low: 0.5, normal: 1, high: 2, urgent: 5 };
const RANK: Record<Priority, number> = { low: 0, normal: 1, high: 2, urgent: 3 };

/** Typical weekday speed factor by local hour: 1 is free flow, 1.45 means trips take 45% longer. */
export const DEFAULT_TRAFFIC: readonly number[] = [
  1, 1, 1, 1, 1, 1.05, 1.15, 1.35, 1.4, 1.2, 1.1, 1.1, 1.15, 1.1, 1.15, 1.25, 1.4, 1.45, 1.3, 1.15, 1.05, 1, 1, 1,
];

export interface TravelOptions {
  /** Road distance is longer than the straight line; 1.3 suits most cities. */
  roadFactor?: number;
  speedKph?: number;
  avoid?: readonly string[];
  /** 24 factors by local hour (see DEFAULT_TRAFFIC). Pass an array of ones to ignore traffic. */
  traffic?: readonly number[];
  /** Local hour of an epoch time (default: UTC minus 5 hours). */
  hourOf?: (ms: number) => number;
}

/** Straight-line travel with a road factor, avoid options and hourly traffic. */
export function makeTravel(o: TravelOptions = {}): TravelFn {
  const avoid = new Set(o.avoid ?? []);
  // Avoiding highways means slower roads and a longer way; avoiding tolls takes a small detour.
  const speed = (o.speedKph ?? 50) * (avoid.has("highways") ? 0.75 : 1);
  const road = (o.roadFactor ?? 1.3) * (avoid.has("highways") ? 1.12 : 1) * (avoid.has("tolls") ? 1.06 : 1) * (avoid.has("unpaved") ? 1.03 : 1) * (avoid.has("ferries") ? 1.04 : 1);
  const traffic = o.traffic ?? DEFAULT_TRAFFIC;
  const hourOf = o.hourOf ?? ((ms: number) => new Date(ms - 5 * 3_600_000).getUTCHours());
  return (a, b, at) => {
    const m = haversine(a.lat, a.lng, b.lat, b.lng) * road;
    const f = traffic[hourOf(at)] ?? 1;
    return { m, s: (m / 1000 / speed) * 3600 * f };
  };
}

/** Travel times looked up from a precomputed matrix of real road times (see providers); falls back to `fallback`. */
export function matrixTravel(points: readonly LatLng[], seconds: number[][], metres: number[][], fallback: TravelFn): TravelFn {
  const key = (p: LatLng) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`;
  const idx = new Map(points.map((p, i) => [key(p), i]));
  return (a, b, at) => {
    const i = idx.get(key(a));
    const j = idx.get(key(b));
    if (i === undefined || j === undefined) return fallback(a, b, at);
    return { s: seconds[i]![j]!, m: metres[i]![j]! };
  };
}

// ---------------------------------------------------------------------------------------------

export type EventKind = "depart" | "stop" | "break" | "charge" | "arrive_end";
export interface PlanEvent {
  kind: EventKind;
  stopId?: string;
  at: number;
  /** When service finished (stops) or the pause ended (breaks, charges). */
  until: number;
  waitS?: number;
  lateS?: number;
  lat: number;
  lng: number;
}

export interface RouteTotals {
  distanceM: number;
  driveS: number;
  serviceS: number;
  waitS: number;
  breakS: number;
  chargeS: number;
  /** From leaving the depot to the end of the day. */
  durationS: number;
  lateS: number;
  lateCount: number;
  onTimeCount: number;
  endAt: number;
  peakKg: number;
}

export interface RouteEval {
  events: PlanEvent[];
  totals: RouteTotals;
  /** Hard rule breaks: the plan is not allowed to do this (capacity, order, range, shift, skills). */
  hard: string[];
  cost: number;
}

const HARD_PENALTY = 1e9;
const ZERO: RouteTotals = { distanceM: 0, driveS: 0, serviceS: 0, waitS: 0, breakS: 0, chargeS: 0, durationS: 0, lateS: 0, lateCount: 0, onTimeCount: 0, endAt: 0, peakKg: 0 };

/** Simulate a day for a vehicle visiting `seq` in order. */
export function evaluate(v: PlanVehicle, seq: readonly PlanStop[], travel: TravelFn, objective: Objective = "time"): RouteEval {
  const events: PlanEvent[] = [];
  const hard: string[] = [];
  const tot = { ...ZERO };
  let t = v.shiftStart;
  let pos: LatLng = v.start;
  events.push({ kind: "depart", at: t, until: t, lat: pos.lat, lng: pos.lng });

  // Capacity: everything not marked pickup is on board at the start and leaves as it is delivered.
  const delivers = seq.filter((s) => s.kind !== "pickup");
  let kg = delivers.reduce((a, s) => a + (s.weightKg ?? 0), 0);
  let m3 = delivers.reduce((a, s) => a + (s.volumeM3 ?? 0), 0);
  let items = delivers.reduce((a, s) => a + (s.items ?? 0), 0);
  let peakKg = kg, peakM3 = m3, peakItems = items;

  const breakAfter = (v.breakAfterMin ?? 0) * 60;
  const breakLen = (v.breakMin ?? 30) * 60;
  let sinceBreak = 0;
  let rangeLeft = v.rangeKm != null ? v.rangeKm * 1000 : Infinity;
  const reserve = v.rangeKm != null ? v.rangeKm * 1000 * 0.1 : 0;
  const chargeLen = (v.chargeMin ?? 40) * 60;
  let weighted = 0;

  const drive = (to: LatLng, final = false) => {
    let leg = travel(pos, to, t);
    // Electric range: charge on the way if, after this leg, the vehicle could not reach a charger (or the depot) with a reserve.
    const nearest = final || !v.chargers?.length ? 0 : Math.min(...v.chargers.map((c) => travel(to, c, t).m));
    if (rangeLeft - leg.m < reserve + nearest && v.chargers?.length) {
      let best: { c: LatLng; leg: { s: number; m: number }; total: number } | null = null;
      for (const c of v.chargers) {
        const l1 = travel(pos, c, t);
        if (l1.m > rangeLeft) continue;
        const l2 = travel(c, to, t);
        if (l2.m > (v.rangeKm ?? 0) * 1000) continue;
        if (!best || l1.m + l2.m < best.total) best = { c, leg: l1, total: l1.m + l2.m };
      }
      if (best) {
        t += best.leg.s * 1000; tot.driveS += best.leg.s; tot.distanceM += best.leg.m; sinceBreak += best.leg.s;
        events.push({ kind: "charge", at: t, until: t + chargeLen * 1000, lat: best.c.lat, lng: best.c.lng });
        t += chargeLen * 1000; tot.chargeS += chargeLen; sinceBreak = 0;
        pos = best.c; rangeLeft = (v.rangeKm ?? 0) * 1000;
        leg = travel(pos, to, t);
      }
    }
    if (breakAfter > 0 && sinceBreak + leg.s > breakAfter && sinceBreak > 0) {
      events.push({ kind: "break", at: t, until: t + breakLen * 1000, lat: pos.lat, lng: pos.lng });
      t += breakLen * 1000; tot.breakS += breakLen; sinceBreak = 0;
    }
    if (leg.m > rangeLeft) hard.push("range");
    rangeLeft -= leg.m;
    t += leg.s * 1000; tot.driveS += leg.s; tot.distanceM += leg.m; sinceBreak += leg.s;
    pos = to;
  };

  const seenPickup = new Set<string>();
  for (const s of seq) {
    drive(s);
    const arrive = t;
    let wait = 0;
    if (s.windowStart != null && t < s.windowStart) { wait = s.windowStart - t; t = s.windowStart; tot.waitS += wait / 1000; }
    let late = 0;
    if (s.windowEnd != null && arrive > s.windowEnd) late = arrive - s.windowEnd;
    const service = (s.serviceMin ?? 5) * 60_000;
    events.push({ kind: "stop", stopId: s.id, at: arrive, until: t + service, waitS: wait / 1000, lateS: late / 1000, lat: s.lat, lng: s.lng });
    t += service; tot.serviceS += service / 1000; sinceBreak += service / 1000;
    if (wait / 1000 >= breakLen) sinceBreak = 0;
    if (late > 0) { tot.lateCount++; tot.lateS += late / 1000; weighted += (late / 1000) * PRIORITY_WEIGHT[s.priority ?? "normal"]; }
    else if (s.windowEnd != null) tot.onTimeCount++;

    if (s.kind === "pickup") { kg += s.weightKg ?? 0; m3 += s.volumeM3 ?? 0; items += s.items ?? 0; if (s.pairId) seenPickup.add(s.pairId); }
    else { kg -= s.weightKg ?? 0; m3 -= s.volumeM3 ?? 0; items -= s.items ?? 0; if (s.pairId && !seenPickup.has(s.pairId)) hard.push("order"); }
    peakKg = Math.max(peakKg, kg); peakM3 = Math.max(peakM3, m3); peakItems = Math.max(peakItems, items);
  }
  if (!v.openEnd) drive(v.end ?? v.start, true);
  events.push({ kind: "arrive_end", at: t, until: t, lat: pos.lat, lng: pos.lng });

  if (v.capacityKg != null && peakKg > v.capacityKg + 1e-6) hard.push("capacity");
  if (v.capacityM3 != null && peakM3 > v.capacityM3 + 1e-6) hard.push("capacity");
  if (v.capacityItems != null && peakItems > v.capacityItems) hard.push("capacity");
  const skills = new Set(v.skills ?? []);
  if (seq.some((s) => (s.skills ?? []).some((k) => !skills.has(k)))) hard.push("skills");
  if (v.territories?.length && seq.some((s) => s.territory && !v.territories!.includes(s.territory))) hard.push("territory");
  tot.durationS = (t - v.shiftStart) / 1000;
  tot.endAt = t;
  tot.peakKg = peakKg;
  if (v.maxShiftMin != null && tot.durationS > v.maxShiftMin * 60) hard.push("shift");

  const base = objective === "distance" ? tot.distanceM : tot.durationS;
  // Lateness matters more than a few minutes of driving: a late second costs as much as 5 metres or seconds.
  const cost = base + weighted * 5 + hard.length * HARD_PENALTY;
  return { events, totals: tot, hard: [...new Set(hard)], cost };
}

// ---------------------------------------------------------------------------------------------

export interface PlanOptions {
  objective?: Objective;
  /** Stops already on each vehicle's route; new stops are added around them (kept in this order until improved). */
  seed?: ReadonlyMap<string, readonly PlanStop[]>;
  /** Stop improving after this many milliseconds. */
  maxMs?: number;
}

const rank = (s: PlanStop) => RANK[s.priority ?? "normal"];

function insertionOrder(stops: readonly PlanStop[], v: PlanVehicle): PlanStop[] {
  return [...stops].sort((a, b) => rank(b) - rank(a) || (a.windowEnd ?? Infinity) - (b.windowEnd ?? Infinity) ||
    haversine(v.start.lat, v.start.lng, b.lat, b.lng) - haversine(v.start.lat, v.start.lng, a.lat, a.lng));
}

/** Group a list of stops into units that must stay together: [pickup, delivery] pairs and single stops. */
function units(stops: readonly PlanStop[]): PlanStop[][] {
  const pairs = new Map<string, PlanStop[]>();
  const out: PlanStop[][] = [];
  for (const s of stops) {
    if (!s.pairId) { out.push([s]); continue; }
    const g = pairs.get(s.pairId) ?? [];
    if (g.length === 0) out.push(g);
    g.push(s);
    pairs.set(s.pairId, g);
  }
  for (const g of out) g.sort((a, b) => (a.kind === "pickup" ? -1 : 0) - (b.kind === "pickup" ? -1 : 0));
  return out;
}

/** Best place(s) to insert a unit into a sequence. Returns the new sequence and its evaluation. */
function bestInsert(v: PlanVehicle, seq: readonly PlanStop[], unit: readonly PlanStop[], travel: TravelFn, obj: Objective): { seq: PlanStop[]; ev: RouteEval } | null {
  let best: { seq: PlanStop[]; ev: RouteEval } | null = null;
  const consider = (cand: PlanStop[]) => {
    const ev = evaluate(v, cand, travel, obj);
    if (!best || ev.cost < best.ev.cost) best = { seq: cand, ev };
  };
  if (unit.length === 1) {
    for (let i = 0; i <= seq.length; i++) consider([...seq.slice(0, i), unit[0]!, ...seq.slice(i)]);
  } else {
    for (let i = 0; i <= seq.length; i++) {
      for (let j = i; j <= seq.length; j++) {
        const cand = [...seq.slice(0, i), unit[0]!, ...seq.slice(i, j), unit[1]!, ...seq.slice(j)];
        consider(cand);
      }
    }
  }
  return best;
}

/** 2-opt and or-opt improvement while the plan keeps getting cheaper. */
export function improve(v: PlanVehicle, start: readonly PlanStop[], travel: TravelFn, obj: Objective, maxMs = 400): { seq: PlanStop[]; ev: RouteEval } {
  let seq = [...start];
  let ev = evaluate(v, seq, travel, obj);
  const deadline = Date.now() + maxMs;
  let better = true;
  while (better && Date.now() < deadline) {
    better = false;
    // 2-opt: reverse a stretch
    for (let i = 0; i < seq.length - 1 && !better; i++) {
      for (let j = i + 1; j < seq.length; j++) {
        const cand = [...seq.slice(0, i), ...seq.slice(i, j + 1).reverse(), ...seq.slice(j + 1)];
        const e = evaluate(v, cand, travel, obj);
        if (e.cost < ev.cost - 1e-6) { seq = cand; ev = e; better = true; break; }
      }
      if (Date.now() > deadline) break;
    }
    // or-opt: move 1 to 3 stops elsewhere
    for (let len = 1; len <= 3 && !better; len++) {
      for (let i = 0; i + len <= seq.length && !better; i++) {
        const seg = seq.slice(i, i + len);
        const rest = [...seq.slice(0, i), ...seq.slice(i + len)];
        for (let k = 0; k <= rest.length; k++) {
          if (k === i) continue;
          const cand = [...rest.slice(0, k), ...seg, ...rest.slice(k)];
          const e = evaluate(v, cand, travel, obj);
          if (e.cost < ev.cost - 1e-6) { seq = cand; ev = e; better = true; break; }
        }
        if (Date.now() > deadline) break;
      }
    }
  }
  return { seq, ev };
}

export interface RoutePlan {
  vehicleId: string;
  order: string[];
  events: PlanEvent[];
  totals: RouteTotals;
  /** Hard rule breaks that could not be avoided. Empty means the plan is valid. */
  violations: string[];
}

function toPlan(v: PlanVehicle, seq: readonly PlanStop[], ev: RouteEval): RoutePlan {
  return { vehicleId: v.id, order: seq.map((s) => s.id), events: ev.events, totals: ev.totals, violations: ev.hard };
}

/** Order all the given stops for one vehicle (they are all kept, even if that breaks a rule: see `violations`). */
export function planRoute(v: PlanVehicle, stops: readonly PlanStop[], travel: TravelFn, o: PlanOptions = {}): RoutePlan {
  const obj = o.objective ?? "time";
  let seq: PlanStop[] = [];
  for (const u of units(insertionOrder(stops, v))) seq = bestInsert(v, seq, u, travel, obj)?.seq ?? seq;
  const { seq: out, ev } = improve(v, seq, travel, obj, o.maxMs ?? 400);
  return toPlan(v, out, ev);
}

/** Evaluate a fixed order, without reordering (e.g. the order the dispatcher dragged stops into). */
export function evaluateOrder(v: PlanVehicle, seq: readonly PlanStop[], travel: TravelFn, objective: Objective = "time"): RoutePlan {
  return toPlan(v, seq, evaluate(v, seq, travel, objective));
}

export interface FleetPlan {
  routes: RoutePlan[];
  unassigned: { stopId: string; reason: "capacity" | "skills" | "territory" | "shift" | "range" | "order" | "none" }[];
}

/** Split stops among several vehicles and order each vehicle's stops. Stops no vehicle can take are listed as unassigned. */
export function planFleet(vehicles: readonly PlanVehicle[], stops: readonly PlanStop[], travel: TravelFn, o: PlanOptions = {}): FleetPlan {
  const obj = o.objective ?? "time";
  const seqs = new Map<string, PlanStop[]>(vehicles.map((v) => [v.id, [...(o.seed?.get(v.id) ?? [])]]));
  const evs = new Map<string, RouteEval>(vehicles.map((v) => [v.id, evaluate(v, seqs.get(v.id)!, travel, obj)]));
  const unassigned: FleetPlan["unassigned"] = [];
  const ref = vehicles[0];
  if (!ref) return { routes: [], unassigned: stops.map((s) => ({ stopId: s.id, reason: "none" as const })) };

  for (const u of units(insertionOrder(stops, ref))) {
    let pick: { v: PlanVehicle; seq: PlanStop[]; ev: RouteEval; delta: number } | null = null;
    let reason: FleetPlan["unassigned"][number]["reason"] = "none";
    for (const v of vehicles) {
      const cur = seqs.get(v.id)!;
      const ins = bestInsert(v, cur, u, travel, obj);
      if (!ins) continue;
      if (ins.ev.hard.length) { reason = (ins.ev.hard[0] as typeof reason) ?? "none"; continue; }
      // A small share of the vehicle's resulting day keeps work spread out when two choices cost the same.
      const own = obj === "distance" ? ins.ev.totals.distanceM : ins.ev.totals.durationS;
      const delta = ins.ev.cost - evs.get(v.id)!.cost + 0.2 * own;
      if (!pick || delta < pick.delta) pick = { v, seq: ins.seq, ev: ins.ev, delta };
    }
    if (pick) { seqs.set(pick.v.id, pick.seq); evs.set(pick.v.id, pick.ev); }
    else for (const s of u) unassigned.push({ stopId: s.id, reason });
  }
  const routes = vehicles.map((v) => {
    const { seq, ev } = improve(v, seqs.get(v.id)!, travel, obj, o.maxMs ?? 400);
    return toPlan(v, seq, ev);
  });
  return { routes, unassigned };
}

// ---------------------------------------------------------------------------------------------

export interface CostRates { perKm: number; perHour: number }

/** Money cost of a plan: distance and paid time. */
export function planCost(t: RouteTotals, r: CostRates): number {
  return Math.round(((t.distanceM / 1000) * r.perKm + (t.durationS / 3600) * r.perHour) * 100) / 100;
}

export interface Comparison {
  a: { totals: RouteTotals; cost: number };
  b: { totals: RouteTotals; cost: number };
  /** b minus a. Negative means plan B is better. */
  delta: { distanceM: number; durationS: number; cost: number; lateCount: number };
  winner: "a" | "b" | "tie";
}

export function comparePlans(a: RoutePlan, b: RoutePlan, rates: CostRates): Comparison {
  const ca = planCost(a.totals, rates);
  const cb = planCost(b.totals, rates);
  const score = (p: RoutePlan, c: number) => p.violations.length * 1e6 + p.totals.lateCount * 1e4 + c;
  const sa = score(a, ca), sb = score(b, cb);
  return {
    a: { totals: a.totals, cost: ca }, b: { totals: b.totals, cost: cb },
    delta: { distanceM: b.totals.distanceM - a.totals.distanceM, durationS: b.totals.durationS - a.totals.durationS, cost: Math.round((cb - ca) * 100) / 100, lateCount: b.totals.lateCount - a.totals.lateCount },
    winner: Math.abs(sa - sb) < 0.01 ? "tie" : sa < sb ? "a" : "b",
  };
}

/** What happens if `extra` is added to the current order? Compares the best place to insert it with the current plan. */
export function whatIfAdd(v: PlanVehicle, current: readonly PlanStop[], extra: PlanStop, travel: TravelFn, obj: Objective = "time") {
  const before = evaluate(v, current, travel, obj);
  const ins = bestInsert(v, current, [extra], travel, obj)!;
  const index = ins.seq.findIndex((s) => s.id === extra.id);
  return {
    insertAt: index,
    order: ins.seq.map((s) => s.id),
    before: before.totals, after: ins.ev.totals,
    addedDistanceM: ins.ev.totals.distanceM - before.totals.distanceM,
    addedDurationS: ins.ev.totals.durationS - before.totals.durationS,
    newLate: ins.ev.totals.lateCount - before.totals.lateCount,
    violations: ins.ev.hard,
  };
}

// ---------------------------------------------------------------------------------------------
// ETAs

/** Learn how much slower traffic is at each hour from real fixes: factor 1 is the fastest typical hour. */
export function learnTrafficProfile(fixes: readonly { time: string; speed: number }[], hourOf: (ms: number) => number): number[] {
  const sum = new Array<number>(24).fill(0);
  const cnt = new Array<number>(24).fill(0);
  for (const f of fixes) {
    if (!(f.speed > 5)) continue; // only moving fixes
    const h = hourOf(new Date(f.time).getTime());
    sum[h]! += f.speed; cnt[h]!++;
  }
  const avg = sum.map((s, h) => (cnt[h]! >= 20 ? s / cnt[h]! : null));
  const known = avg.filter((x): x is number => x !== null);
  if (known.length < 3) return [...DEFAULT_TRAFFIC];
  const fastest = Math.max(...known);
  return avg.map((a, h) => (a === null ? DEFAULT_TRAFFIC[h]! : Math.min(2.5, Math.max(1, fastest / a))));
}

export interface EtaStop { id: string; lat: number; lng: number; serviceMin?: number; windowEnd?: number | null }

/** Arrival time at each remaining stop, in order, starting from where the vehicle is now. */
export function liveEtas(from: LatLng, now: number, remaining: readonly EtaStop[], travel: TravelFn): { id: string; eta: number; lateByS: number }[] {
  let t = now;
  let pos = from;
  return remaining.map((s) => {
    t += travel(pos, s, t).s * 1000;
    const eta = t;
    t += (s.serviceMin ?? 5) * 60_000;
    pos = s;
    return { id: s.id, eta, lateByS: s.windowEnd != null && eta > s.windowEnd ? Math.round((eta - s.windowEnd) / 1000) : 0 };
  });
}
