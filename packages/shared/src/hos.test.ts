import { describe, expect, it } from "vitest";
import { dutyLogFromShifts, hosClocks, type DutySegment } from "./hos.js";

const D0 = Date.parse("2026-11-02T06:00:00Z"); // a Monday, 06:00 UTC
const at = (h: number) => new Date(D0 + h * 3600_000).toISOString();
const seg = (status: DutySegment["status"], from: number, to: number | null): DutySegment => ({ status, start: at(from), end: to == null ? null : at(to) });

describe("hosClocks: Canada", () => {
  it("counts a normal day: 5 h driving, 1 h on duty, 5 h driving", () => {
    const log = [seg("driving", 0, 5), seg("on", 5, 6), seg("driving", 6, 11)];
    const s = hosClocks(log, "canada_cycle1", new Date(at(11)));
    expect(s.driving).toEqual({ usedH: 10, limitH: 13, remainingH: 3 });
    expect(s.window).toEqual({ usedH: 11, limitH: 14, remainingH: 3 });
    expect(s.elapsed).toEqual({ usedH: 11, limitH: 16, remainingH: 5 });
    expect(s.canDrive).toBe(true);
    expect(s.driveMinutesLeft).toBe(180);
    expect(s.binding).toBe("driving");
    expect(s.mustStopBy).toBe(at(14));
    expect(s.violations).toEqual([]);
  });

  it("an ongoing drive keeps counting up to now", () => {
    const s = hosClocks([seg("driving", 0, null)], "canada_cycle1", new Date(at(12.5)));
    expect(s.currentStatus).toBe("driving");
    expect(s.driving.usedH).toBe(12.5);
    expect(s.driveMinutesLeft).toBe(30);
  });

  it("flags driving past 13 hours where it happened", () => {
    const s = hosClocks([seg("driving", 0, 14)], "canada_cycle1", new Date(at(14)));
    expect(s.canDrive).toBe(false);
    expect(s.driveMinutesLeft).toBe(0);
    expect(s.violations).toEqual([{ kind: "driving", at: at(13), detail: "Over 13 h of driving" }]);
  });

  it("14 h on-duty counts working time but not time off in between", () => {
    // 8 h driving, 3 h off (not a daily reset), 4 h on duty → 12 h on duty, 14 h clock has 2 h left; elapsed is 15 h
    const s = hosClocks([seg("driving", 0, 8), seg("off", 8, 11), seg("on", 11, 15)], "canada_cycle1", new Date(at(15)));
    expect(s.window.usedH).toBe(12);
    expect(s.elapsed!.usedH).toBe(15);
    expect(s.elapsed!.remainingH).toBe(1);
    expect(s.binding).toBe("elapsed");
  });

  it("8 consecutive hours off starts a new day", () => {
    const log = [seg("driving", 0, 10), seg("sleeper", 10, 14), seg("off", 14, 19)]; // 9 h rest
    const s = hosClocks(log, "canada_cycle1", new Date(at(19)));
    expect(s.driving.usedH).toBe(0);
    expect(s.window.usedH).toBe(0);
    expect(s.canDrive).toBe(true);
  });
  it("7 hours off is not enough", () => {
    const s = hosClocks([seg("driving", 0, 10), seg("off", 10, 17)], "canada_cycle1", new Date(at(17)));
    expect(s.driving.usedH).toBe(10);
  });

  it("cycle 1: 70 hours in 7 days, with hours returning as old days roll off", () => {
    const week = [0, 1, 2, 3, 4, 5, 6].flatMap((d) => [seg("driving", d * 24, d * 24 + 8), seg("on", d * 24 + 8, d * 24 + 10)]);
    const now = new Date(at(6 * 24 + 10)); // 70 h worked
    const s = hosClocks(week, "canada_cycle1", now);
    expect(s.cycle).toEqual({ usedH: 70, limitH: 70, remainingH: 0 });
    expect(s.canDrive).toBe(false);
    expect(s.binding).toBe("cycle");
    // a day later the first day has rolled out of the 7-day window
    const next = hosClocks(week, "canada_cycle1", new Date(at(7 * 24 + 10)));
    expect(next.cycle.usedH).toBe(60);
    expect(next.canDrive).toBe(true);
  });

  it("36 hours off resets cycle 1", () => {
    const log = [seg("driving", 0, 13), seg("off", 13, 13 + 36)];
    const s = hosClocks(log, "canada_cycle1", new Date(at(49)));
    expect(s.cycle.usedH).toBe(0);
  });

  it("cycle 2 needs 24 hours off after 70 hours", () => {
    // 6 days of 12 h on-duty (72 h) with 12 h rests, so no 24 h block
    const log = [0, 1, 2, 3, 4, 5].flatMap((d) => [seg("driving", d * 24, d * 24 + 10), seg("on", d * 24 + 10, d * 24 + 12)]);
    const now = new Date(at(5 * 24 + 12));
    const s = hosClocks(log, "canada_cycle2", now);
    expect(s.cycle.limitH).toBe(120);
    expect(s.cycle.usedH).toBe(72);
    expect(s.canDrive).toBe(false);
    expect(s.binding).toBe("needs_24_off");
    // after 24 h off it can drive again
    const rested = hosClocks([...log, seg("off", 5 * 24 + 12, 6 * 24 + 12)], "canada_cycle2", new Date(at(6 * 24 + 12)));
    expect(rested.canDrive).toBe(true);
  });
});

describe("hosClocks: United States (cross-border)", () => {
  it("11 hours of driving and a 14 hour window that keeps running while off duty", () => {
    const log = [seg("driving", 0, 6), seg("off", 6, 9), seg("driving", 9, 12)];
    const s = hosClocks(log, "us_70_8", new Date(at(12)));
    expect(s.driving).toEqual({ usedH: 9, limitH: 11, remainingH: 2 });
    expect(s.window).toEqual({ usedH: 12, limitH: 14, remainingH: 2 });
    expect(s.elapsed).toBeNull();
  });
  it("needs a 30 minute break after 8 hours of driving", () => {
    const s = hosClocks([seg("driving", 0, 8)], "us_70_8", new Date(at(8)));
    expect(s.canDrive).toBe(false);
    expect(s.binding).toBe("break");
    const rested = hosClocks([seg("driving", 0, 8), seg("on", 8, 8.5)], "us_70_8", new Date(at(8.5)));
    expect(rested.canDrive).toBe(true);
    expect(rested.breakClock!.usedH).toBe(0);
    const short = hosClocks([seg("driving", 0, 8), seg("on", 8, 8.25)], "us_70_8", new Date(at(8.25)));
    expect(short.canDrive).toBe(false);
  });
  it("flags driving past the break rule", () => {
    const s = hosClocks([seg("driving", 0, 9)], "us_70_8", new Date(at(9)));
    expect(s.violations.map((v) => v.kind)).toContain("break");
  });
  it("needs 10 hours off to reset, not 8", () => {
    const s = hosClocks([seg("driving", 0, 10), seg("off", 10, 19)], "us_70_8", new Date(at(19)));
    expect(s.driving.usedH).toBe(10);
    const ok = hosClocks([seg("driving", 0, 10), seg("off", 10, 20)], "us_70_8", new Date(at(20)));
    expect(ok.driving.usedH).toBe(0);
  });
  it("34 hours off restarts the 70 hour cycle", () => {
    const log = [seg("driving", 0, 11), seg("off", 11, 11 + 34)];
    expect(hosClocks(log, "us_70_8", new Date(at(45))).cycle.usedH).toBe(0);
    expect(hosClocks([seg("driving", 0, 11), seg("off", 11, 11 + 30)], "us_70_8", new Date(at(41))).cycle.usedH).toBe(11);
  });
});

describe("hosClocks: edge cases", () => {
  it("an empty log is a rested driver", () => {
    const s = hosClocks([], "canada_cycle1", new Date(at(5)));
    expect(s).toMatchObject({ canDrive: true, mustStopBy: null, currentStatus: "off" });
    expect(s.driving.remainingH).toBe(13);
  });
  it("ignores segments in the future and fills gaps with off duty", () => {
    const s = hosClocks([seg("driving", 0, 4), seg("driving", 30, 40)], "canada_cycle1", new Date(at(5)));
    expect(s.driving.usedH).toBe(4);
    expect(s.currentStatus).toBe("off");
  });
  it("overlapping entries are not double counted", () => {
    const s = hosClocks([seg("driving", 0, 4), seg("driving", 2, 6)], "canada_cycle1", new Date(at(6)));
    expect(s.driving.usedH).toBe(6);
  });
});

describe("dutyLogFromShifts", () => {
  it("puts driving inside the shift and the rest as on duty", () => {
    const log = dutyLogFromShifts(
      [{ start: at(0), end: at(10) }],
      [{ start: at(1), end: at(4) }, { start: at(6), end: at(11) }], // second drive runs past the shift: clipped
    );
    expect(log.map((s) => `${s.status}:${(Date.parse(s.start) - D0) / 3600_000}-${s.end ? (Date.parse(s.end) - D0) / 3600_000 : "…"}`))
      .toEqual(["on:0-1", "driving:1-4", "on:4-6", "driving:6-10"]);
  });
  it("an open shift stays open", () => {
    const log = dutyLogFromShifts([{ start: at(0), end: null }], [{ start: at(1), end: at(2) }]);
    expect(log[log.length - 1]).toEqual({ status: "on", start: at(2), end: null });
  });
  it("drives that are outside any shift are not duty time", () => {
    expect(dutyLogFromShifts([{ start: at(0), end: at(2) }], [{ start: at(5), end: at(6) }])).toEqual([{ status: "on", start: at(0), end: at(2) }]);
  });
});
