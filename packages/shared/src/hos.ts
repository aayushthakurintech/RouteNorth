/*
 * Hours-of-service clocks for awareness and planning.
 *
 * This is NOT a certified electronic logging device (ELD) and does not replace the driver's official log. In Canada,
 * federally regulated carriers must use a certified ELD where the rules require a daily log; RouteNorth plans to integrate
 * certified providers rather than certify its own. These clocks help dispatchers see who is about to run out of hours.
 *
 * Rule sets (simplified, documented where they differ from the regulation):
 *  - Canada, federal Commercial Vehicle Drivers Hours of Service Regulations (SOR/2005-313):
 *      13 h driving and 14 h on-duty per day, no driving after 16 h elapsed since coming on duty; the daily reset here is
 *      8 consecutive hours off duty (the regulation also needs 10 h off per day in total, with a 2 h split allowance, which is not checked).
 *      Cycle 1 = 70 h on-duty in 7 days, reset by 36 h off. Cycle 2 = 120 h in 14 days, reset by 72 h off, and
 *      24 consecutive hours off before driving again once 70 h are used since the last 24 h off.
 *  - United States, FMCSA 49 CFR 395.3, for cross-border work: 11 h driving, 14 h window, 30 min break after 8 h driving,
 *      60 h/7 days or 70 h/8 days, 34 h restart, 10 h off for the daily reset (sleeper-berth splits are not modelled).
 * Provincial and intra-provincial rules differ (e.g. Ontario and Quebec follow the federal rules for most carriers; some provinces have
 * their own exemptions). Always confirm with the carrier's safety officer.
 */

export type DutyStatus = "off" | "sleeper" | "on" | "driving";
export interface DutySegment { status: DutyStatus; start: string; /** null = still in this status */ end: string | null }
export type RuleSetId = "canada_cycle1" | "canada_cycle2" | "us_70_8" | "us_60_7";

interface RuleSet {
  id: RuleSetId;
  label: string;
  drivingH: number;
  /** Daily on-duty / window limit in hours. */
  windowH: number;
  /** "onduty": counts on-duty hours only; "elapsed": wall-clock hours since the day began. */
  windowKind: "onduty" | "elapsed";
  /** Extra Canadian rule: no driving after this many elapsed hours since coming on duty. */
  elapsedH: number | null;
  dailyResetH: number;
  /** US only: driving allowed before a 30 minute break. */
  breakAfterDrivingH: number | null;
  cycleH: number;
  cycleDays: number;
  cycleResetH: number;
  /** Canada cycle 2 only. */
  needs24OffAfterH: number | null;
}

export const RULE_SETS: Record<RuleSetId, RuleSet> = {
  canada_cycle1: { id: "canada_cycle1", label: "Canada, cycle 1 (70 h / 7 days)", drivingH: 13, windowH: 14, windowKind: "onduty", elapsedH: 16, dailyResetH: 8, breakAfterDrivingH: null, cycleH: 70, cycleDays: 7, cycleResetH: 36, needs24OffAfterH: null },
  canada_cycle2: { id: "canada_cycle2", label: "Canada, cycle 2 (120 h / 14 days)", drivingH: 13, windowH: 14, windowKind: "onduty", elapsedH: 16, dailyResetH: 8, breakAfterDrivingH: null, cycleH: 120, cycleDays: 14, cycleResetH: 72, needs24OffAfterH: 70 },
  us_70_8: { id: "us_70_8", label: "United States, 70 h / 8 days", drivingH: 11, windowH: 14, windowKind: "elapsed", elapsedH: null, dailyResetH: 10, breakAfterDrivingH: 8, cycleH: 70, cycleDays: 8, cycleResetH: 34, needs24OffAfterH: null },
  us_60_7: { id: "us_60_7", label: "United States, 60 h / 7 days", drivingH: 11, windowH: 14, windowKind: "elapsed", elapsedH: null, dailyResetH: 10, breakAfterDrivingH: 8, cycleH: 60, cycleDays: 7, cycleResetH: 34, needs24OffAfterH: null },
};

export interface Clock { usedH: number; limitH: number; remainingH: number }
export type Binding = "driving" | "window" | "elapsed" | "break" | "cycle" | "needs_24_off" | "none";
export interface HosViolation { kind: "driving" | "window" | "elapsed" | "break" | "cycle"; at: string; detail: string }
export interface HosStatus {
  ruleSet: RuleSetId;
  currentStatus: DutyStatus;
  driving: Clock;
  window: Clock;
  elapsed: Clock | null;
  /** Driving hours since the last 30 minute break (US only). */
  breakClock: Clock | null;
  cycle: Clock;
  /** Can the driver legally start driving right now. */
  canDrive: boolean;
  /** Minutes of driving left before the first limit is reached (0 when canDrive is false). */
  driveMinutesLeft: number;
  binding: Binding;
  /** When the driver will have to stop if they drive continuously from now. Null when they are off duty, cannot drive, or no limit is near. */
  mustStopBy: string | null;
  violations: HosViolation[];
}

const H = 3600_000;
const h2 = (ms: number) => Math.round((ms / H) * 100) / 100;
const clock = (usedMs: number, limitH: number): Clock => ({ usedH: h2(usedMs), limitH, remainingH: Math.max(0, h2(limitH * H - usedMs)) });

/**
 * Where a driver stands against the rules at `now`, given their duty-status log (oldest first).
 * Any gap between segments is treated as off duty. Segments after `now` are ignored.
 */
export function hosClocks(log: readonly DutySegment[], ruleSet: RuleSetId, now: Date): HosStatus {
  const r = RULE_SETS[ruleSet];
  const nowMs = now.getTime();
  const horizon = nowMs - (r.cycleDays + 1) * 24 * H;
  const segs = normalize(log, horizon, nowMs);

  // Day state, reset after dailyResetH consecutive hours off duty.
  let dayStart: number | null = null;
  let drivingMs = 0, onDutyMs = 0, sinceBreakDrivingMs = 0, nonDrivingRun = 0, offRun = 0;
  const violations: HosViolation[] = [];
  const flagged = new Set<string>();
  const flag = (kind: HosViolation["kind"], at: number, detail: string) => {
    const key = `${kind}|${dayStart ?? 0}`;
    if (flagged.has(key)) return;
    flagged.add(key);
    violations.push({ kind, at: new Date(at).toISOString(), detail });
  };
  let lastEnd = horizon;
  let cycleBase = horizon; // start of the current cycle after a qualifying rest
  let offBlock = 0;
  let lastLong24Off = horizon; // end of the latest 24 h consecutive off-duty block (cycle 2 rule)
  const dayReset = () => { dayStart = null; drivingMs = 0; onDutyMs = 0; sinceBreakDrivingMs = 0; nonDrivingRun = 0; };

  for (const s of segs) {
    const start = s.start, end = s.end;
    const dur = end - start;
    if (dur <= 0) continue;
    const isOff = s.status === "off" || s.status === "sleeper";
    if (isOff) {
      // Rest accumulates across adjacent off-duty segments (off → sleeper → off).
      const before = offBlock;
      offBlock += dur;
      offRun = offBlock;
      if (before < r.dailyResetH * H && offBlock >= r.dailyResetH * H) dayReset();
      if (before < r.cycleResetH * H && offBlock >= r.cycleResetH * H) cycleBase = start + (r.cycleResetH * H - before);
      if (before < 24 * H && offBlock >= 24 * H) lastLong24Off = start + (24 * H - before);
      if (r.breakAfterDrivingH != null && before < 30 * 60_000 && offBlock >= 30 * 60_000) { sinceBreakDrivingMs = 0; }
      if (offBlock >= 24 * H) lastLong24Off = Math.max(lastLong24Off, end);
      continue;
    }
    offBlock = 0; offRun = 0;
    if (dayStart == null) dayStart = start;
    if (s.status === "on") {
      onDutyMs += dur;
      nonDrivingRun += dur;
      if (r.breakAfterDrivingH != null && nonDrivingRun >= 30 * 60_000) sinceBreakDrivingMs = 0;
      continue;
    }
    // Driving: advance in pieces so each limit is flagged where it was actually crossed.
    nonDrivingRun = 0;
    let t = start;
    while (t < end) {
      const caps: [number, HosViolation["kind"]][] = [
        [r.drivingH * H - drivingMs, "driving"],
        [r.windowKind === "onduty" ? r.windowH * H - onDutyMs : r.windowH * H - (t - dayStart), "window"],
      ];
      if (r.elapsedH != null) caps.push([r.elapsedH * H - (t - dayStart), "elapsed"]);
      if (r.breakAfterDrivingH != null) caps.push([r.breakAfterDrivingH * H - sinceBreakDrivingMs, "break"]);
      const [capMs, kind] = caps.reduce((a, b) => (b[0] < a[0] ? b : a));
      const piece = Math.min(end - t, Math.max(0, capMs));
      drivingMs += piece; onDutyMs += piece; sinceBreakDrivingMs += piece; t += piece;
      if (t < end) {
        flag(kind, t, kindDetail(kind, r));
        // Count the rest of the segment as driving beyond the limit and stop stepping.
        const rest = end - t;
        drivingMs += rest; onDutyMs += rest; sinceBreakDrivingMs += rest; t = end;
      }
    }
  }

  // Time since the last segment end up to now is off duty (nothing logged).
  lastEnd = segs.length ? segs[segs.length - 1]!.end : horizon;
  if (lastEnd < nowMs) {
    const dur = nowMs - lastEnd;
    const before = offBlock;
    offBlock += dur;
    if (before < r.dailyResetH * H && offBlock >= r.dailyResetH * H) dayReset();
    if (before < r.cycleResetH * H && offBlock >= r.cycleResetH * H) cycleBase = lastEnd + (r.cycleResetH * H - before);
    if (offBlock >= 24 * H) lastLong24Off = Math.max(lastLong24Off, nowMs);
    if (r.breakAfterDrivingH != null && before < 30 * 60_000 && offBlock >= 30 * 60_000) sinceBreakDrivingMs = 0;
  }
  void offRun; void lastEnd;

  // Cycle: rolling window of on-duty hours, counting only after the latest qualifying reset.
  const cycleFrom = Math.max(nowMs - r.cycleDays * 24 * H, cycleBase);
  let cycleMs = 0, since24Ms = 0;
  for (const s of segs) {
    if (s.status === "off" || s.status === "sleeper") continue;
    const a = Math.max(s.start, cycleFrom), b = Math.min(s.end, nowMs);
    if (b > a) cycleMs += b - a;
    const c = Math.max(s.start, lastLong24Off, cycleFrom), d = Math.min(s.end, nowMs);
    if (d > c) since24Ms += d - c;
  }
  const cycleOver = cycleMs > r.cycleH * H;
  if (cycleOver) {
    // Report when the limit was crossed.
    let acc = 0, at = nowMs;
    for (const s of segs) {
      if (s.status === "off" || s.status === "sleeper") continue;
      const a = Math.max(s.start, cycleFrom), b = Math.min(s.end, nowMs);
      if (b <= a) continue;
      if (acc + (b - a) > r.cycleH * H) { at = a + (r.cycleH * H - acc); break; }
      acc += b - a;
    }
    violations.push({ kind: "cycle", at: new Date(at).toISOString(), detail: `Over ${r.cycleH} h in ${r.cycleDays} days` });
  }

  const current: DutyStatus = segs.length && segs[segs.length - 1]!.end >= nowMs - 1000 ? segs[segs.length - 1]!.status : "off";
  const windowUsed = r.windowKind === "onduty" ? onDutyMs : dayStart == null ? 0 : nowMs - dayStart;
  const elapsedUsed = dayStart == null ? 0 : nowMs - dayStart;

  const driving = clock(drivingMs, r.drivingH);
  const window = clock(windowUsed, r.windowH);
  const elapsed = r.elapsedH != null ? clock(elapsedUsed, r.elapsedH) : null;
  const breakClock = r.breakAfterDrivingH != null ? clock(sinceBreakDrivingMs, r.breakAfterDrivingH) : null;
  const cycle = clock(cycleMs, r.cycleH);

  const limits: [Binding, number][] = [["driving", driving.remainingH], ["window", window.remainingH], ["cycle", cycle.remainingH]];
  if (elapsed) limits.push(["elapsed", elapsed.remainingH]);
  if (breakClock) limits.push(["break", breakClock.remainingH]);
  let needs24 = false;
  if (r.needs24OffAfterH != null && since24Ms >= r.needs24OffAfterH * H) { needs24 = true; limits.push(["needs_24_off", 0]); }
  const [binding, leftH] = limits.reduce((a, b) => (b[1] < a[1] ? b : a));
  const canDrive = leftH > 0;
  const driveMinutesLeft = Math.floor(leftH * 60);
  return {
    ruleSet, currentStatus: current, driving, window, elapsed, breakClock, cycle,
    canDrive, driveMinutesLeft,
    binding: leftH >= 24 && !needs24 ? "none" : binding,
    mustStopBy: canDrive && leftH < 24 && current !== "off" && current !== "sleeper" ? new Date(nowMs + leftH * H).toISOString() : null,
    violations,
  };
}

function kindDetail(kind: HosViolation["kind"], r: RuleSet): string {
  switch (kind) {
    case "driving": return `Over ${r.drivingH} h of driving`;
    case "window": return r.windowKind === "onduty" ? `Over ${r.windowH} h on duty in a day` : `Driving after the ${r.windowH} h window closed`;
    case "elapsed": return `Driving after ${r.elapsedH} h since coming on duty`;
    case "break": return `Over ${r.breakAfterDrivingH} h of driving without a 30 minute break`;
    default: return "";
  }
}

interface Seg { status: DutyStatus; start: number; end: number }

/** Sort, clip to the horizon and `now`, close open segments at `now`, and fill gaps with off duty so rest is counted. */
function normalize(log: readonly DutySegment[], from: number, now: number): Seg[] {
  const out: Seg[] = [];
  const sorted = [...log].sort((a, b) => Date.parse(a.start) - Date.parse(b.start));
  let cursor = from;
  for (const s of sorted) {
    const st = Math.max(Date.parse(s.start), from);
    const en = Math.min(s.end ? Date.parse(s.end) : now, now);
    if (!Number.isFinite(st) || !Number.isFinite(en) || en <= st) continue;
    const start = Math.max(st, cursor); // overlapping logs: the earlier entry wins
    if (en <= start) continue;
    if (start > cursor) out.push({ status: "off", start: cursor, end: start });
    out.push({ status: s.status, start, end: en });
    cursor = en;
  }
  return out;
}

/**
 * Build a duty log from what RouteNorth knows: the driver's shifts (on duty) and the times the assigned vehicle was moving
 * during them (driving). Outside shifts the driver is off duty. Driving is clipped to the shift it happened in.
 */
export function dutyLogFromShifts(shifts: readonly { start: string; end: string | null }[], driving: readonly { start: string; end: string }[]): DutySegment[] {
  const out: DutySegment[] = [];
  for (const sh of [...shifts].sort((a, b) => a.start.localeCompare(b.start))) {
    const s0 = Date.parse(sh.start), s1 = sh.end ? Date.parse(sh.end) : Number.POSITIVE_INFINITY;
    const inside = driving
      .map((d) => ({ a: Math.max(Date.parse(d.start), s0), b: Math.min(Date.parse(d.end), s1) }))
      .filter((d) => d.b > d.a)
      .sort((x, y) => x.a - y.a);
    let cursor = s0;
    for (const d of inside) {
      if (d.a > cursor) out.push({ status: "on", start: new Date(cursor).toISOString(), end: new Date(d.a).toISOString() });
      const a = Math.max(d.a, cursor);
      if (d.b > a) out.push({ status: "driving", start: new Date(a).toISOString(), end: new Date(d.b).toISOString() });
      cursor = Math.max(cursor, d.b);
    }
    if (sh.end == null) out.push({ status: "on", start: new Date(cursor).toISOString(), end: null });
    else if (cursor < s1) out.push({ status: "on", start: new Date(cursor).toISOString(), end: sh.end });
  }
  return out;
}
