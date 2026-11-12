import type { pg } from "@routenorth/db";
import { emit } from "../automation/events.js";
import { withDefaults } from "../org/settings.js";
import { companyFormat } from "../portal/common.js";
import { assertDriverAvailable } from "../portal/drivers.service.js";
import { todayIn } from "../portal/vehicles.service.js";

export interface Shift { id: string; startedAt: Date; endedAt: Date | null; source: string; breaks: { id: string; kind: string; startedAt: Date; endedAt: Date | null }[] }

const MIN = 60_000;
export const minutesBetween = (a: Date, b: Date) => Math.max(0, Math.round((b.getTime() - a.getTime()) / MIN));

/** Minutes worked in a shift: the time it ran minus the breaks (breaks are unpaid). */
export function workedMinutes(s: { startedAt: Date; endedAt: Date | null; breaks: { startedAt: Date; endedAt: Date | null }[] }, now = new Date()): number {
  const end = s.endedAt ?? now;
  const brk = s.breaks.reduce((n, b) => n + minutesBetween(b.startedAt, b.endedAt ?? now), 0);
  return Math.max(0, minutesBetween(s.startedAt, end) - brk);
}

/** How long the driver has been working without a break (since the last break ended or the shift began). */
export function minutesSinceBreak(s: { startedAt: Date; breaks: { startedAt: Date; endedAt: Date | null }[] }, now = new Date()): number {
  if (s.breaks.some((b) => !b.endedAt)) return 0;
  const lastEnd = s.breaks.reduce<Date>((d, b) => (b.endedAt && b.endedAt > d ? b.endedAt : d), s.startedAt);
  return minutesBetween(lastEnd, now);
}

export async function openShift(c: pg.PoolClient, driverId: string): Promise<Shift | null> {
  const s = (await c.query("SELECT id, started_at, ended_at, source FROM shifts WHERE driver_id = $1 AND ended_at IS NULL", [driverId])).rows[0];
  if (!s) return null;
  const breaks = (await c.query("SELECT id, kind, started_at, ended_at FROM shift_breaks WHERE shift_id = $1 ORDER BY started_at", [s.id])).rows;
  return { id: s.id, startedAt: s.started_at, endedAt: null, source: s.source, breaks: breaks.map((b) => ({ id: b.id, kind: b.kind, startedAt: b.started_at, endedAt: b.ended_at })) };
}

export async function startShift(c: pg.PoolClient, orgId: string, driverId: string, source: "manual" | "auto", at: Date, where?: { lat?: number | null; lng?: number | null }): Promise<{ id: string; started: boolean }> {
  const open = await c.query<{ id: string }>("SELECT id FROM shifts WHERE driver_id = $1 AND ended_at IS NULL", [driverId]);
  if (open.rows[0]) return { id: open.rows[0].id, started: false };
  // A driver whose required papers have expired, who is suspended or still onboarding cannot go on duty by hand.
  if (source === "manual") {
    const tz = (await companyFormat(c)).timezone;
    await assertDriverAvailable(c, driverId, { tz, today: todayIn(tz), now: new Date() });
  }
  const row = (await c.query("INSERT INTO shifts (org_id, driver_id, started_at, source, start_lat, start_lng) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id", [orgId, driverId, at, source, where?.lat ?? null, where?.lng ?? null])).rows[0];
  return { id: row.id, started: true };
}

/** Finish the open shift. Overtime beyond the organization's daily limit is flagged, and a manager is asked to approve it. */
export async function endShift(c: pg.PoolClient, orgId: string, driverId: string, at: Date, where?: { lat?: number | null; lng?: number | null }): Promise<{ id: string; workedMin: number; overtimeMin: number } | null> {
  const s = await openShift(c, driverId);
  if (!s) return null;
  const end = at < s.startedAt ? new Date() : at;
  await c.query("UPDATE shift_breaks SET ended_at = $2 WHERE shift_id = $1 AND ended_at IS NULL", [s.id, end]);
  await c.query("UPDATE shifts SET ended_at = $2, end_lat = $3, end_lng = $4 WHERE id = $1", [s.id, end, where?.lat ?? null, where?.lng ?? null]);
  return settleOvertime(c, orgId, s.id);
}

/** Work out a finished shift's overtime and, when the organization wants approval, ask for it. Safe to run again after an edit. */
export async function settleOvertime(c: pg.PoolClient, orgId: string, shiftId: string): Promise<{ id: string; workedMin: number; overtimeMin: number }> {
  const row = (await c.query("SELECT s.driver_id, s.started_at, s.ended_at, o.settings, coalesce(u.display_name, u.email) AS name FROM shifts s JOIN organizations o ON o.id = s.org_id JOIN users u ON u.id = s.driver_id WHERE s.id = $1", [shiftId])).rows[0];
  const breaks = (await c.query("SELECT started_at, ended_at FROM shift_breaks WHERE shift_id = $1", [shiftId])).rows.map((b) => ({ startedAt: b.started_at as Date, endedAt: b.ended_at as Date | null }));
  const worked = workedMinutes({ startedAt: row.started_at, endedAt: row.ended_at, breaks });
  const settings = withDefaults(row.settings) as ReturnType<typeof withDefaults> & { approvals?: { overtimeNeedsApproval?: boolean } };
  const overtime = Math.max(0, worked - Math.round(settings.overtimeAfterH * 60));
  const needs = overtime > 0 && settings.approvals?.overtimeNeedsApproval !== false;
  await c.query("UPDATE shifts SET overtime_minutes = $2, overtime_status = CASE WHEN $2 = 0 THEN 'none' WHEN $3 THEN CASE WHEN overtime_status IN ('approved','rejected') THEN overtime_status ELSE 'pending' END ELSE 'approved' END WHERE id = $1", [shiftId, overtime, needs]);
  if (needs) {
    const pending = await c.query("SELECT 1 FROM approvals WHERE kind = 'overtime' AND subject_id = $1 AND status = 'pending'", [shiftId]);
    const decided = await c.query("SELECT 1 FROM approvals WHERE kind = 'overtime' AND subject_id = $1 AND status <> 'pending'", [shiftId]);
    if (!pending.rowCount && !decided.rowCount) {
      await c.query("INSERT INTO approvals (org_id, kind, title, detail, subject_kind, subject_id, requested_by) VALUES ($1,'overtime',$2,$3,'shift',$4,$5)",
        [orgId, `Overtime: ${row.name}, ${(overtime / 60).toFixed(1)} h`, JSON.stringify({ driver: row.name, workedMin: worked, overtimeMin: overtime }), shiftId, row.driver_id]);
    }
  }
  await emit(c, orgId, "shift.ended", "shift", shiftId, { driverId: row.driver_id, hours: Math.round((worked / 60) * 10) / 10, overtimeMin: overtime });
  return { id: shiftId, workedMin: worked, overtimeMin: overtime };
}

export async function toggleBreak(c: pg.PoolClient, orgId: string, driverId: string, action: "start" | "end", kind: "break" | "lunch", at: Date): Promise<{ onBreak: boolean }> {
  const s = await openShift(c, driverId);
  if (!s) throw new Error("start your shift first");
  const open = s.breaks.find((b) => !b.endedAt);
  if (action === "start") {
    if (open) return { onBreak: true };
    await c.query("INSERT INTO shift_breaks (org_id, shift_id, kind, started_at) VALUES ($1,$2,$3,$4)", [orgId, s.id, kind, at < s.startedAt ? s.startedAt : at]);
    return { onBreak: true };
  }
  if (open) await c.query("UPDATE shift_breaks SET ended_at = greatest($2, started_at) WHERE id = $1", [open.id, at]);
  return { onBreak: false };
}
