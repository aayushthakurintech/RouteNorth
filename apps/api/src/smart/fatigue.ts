import { fatigueState } from "@routenorth/shared";
import type { pg } from "@routenorth/db";
import { minutesSinceBreak, openShift, workedMinutes } from "../driver/shifts.js";

export interface FatigueLimits { fatigueWarnMin: number; fatigueStopMin: number; shiftWarnMin: number; shiftMaxMin: number }

/** Where a driver stands on hours: time on shift, time since the last break, and the warning level. */
export async function fatigueOf(c: pg.PoolClient, driverId: string, s: FatigueLimits) {
  const sh = await openShift(c, driverId);
  if (!sh) return { level: "ok" as const, drivingMin: 0, sinceBreakMin: 0, shiftMin: 0 };
  return fatigueState(workedMinutes(sh), minutesSinceBreak(sh), { warnBreakMin: s.fatigueWarnMin, maxBreakMin: s.fatigueStopMin, warnShiftMin: s.shiftWarnMin, maxShiftMin: s.shiftMaxMin });
}

