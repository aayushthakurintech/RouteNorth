import { pg, withOrg } from "@routenorth/db";
import type { AnalyticsService } from "../analytics/analytics.service.js";
import type { Providers } from "../notify/notifier.js";
import { sendReport, type Format } from "./reports.controller.js";

/**
 * Send scheduled reports. A schedule is due when the organization's local clock has reached its hour on a matching day and it has not
 * already run today. Safe to run every minute; a schedule that fails is recorded and tried again the next day, not every minute.
 */
export async function runDueReports(pool: pg.Pool, svc: AnalyticsService, notify: Providers, log: (m: string) => void = () => {}, now = new Date()): Promise<number> {
  const orgs = (await pool.query<{ id: string }>("SELECT all_org_ids() AS id")).rows;
  let sent = 0;
  for (const { id } of orgs) {
    const due = (await withOrg(pool, id, (c) => c.query<{ id: string; reportId: string; format: Format; endpointIds: string[]; createdBy: string | null }>(
      `SELECT s.id, s.report_id AS "reportId", s.format, s.endpoint_ids AS "endpointIds", s.created_by AS "createdBy"
       FROM report_schedules s CROSS JOIN organizations o
       WHERE s.active AND extract(hour FROM ($1::timestamptz AT TIME ZONE o.timezone)) >= s.hour
         AND (s.last_run_at IS NULL OR (s.last_run_at AT TIME ZONE o.timezone)::date < ($1::timestamptz AT TIME ZONE o.timezone)::date)
         AND (s.freq = 'daily'
           OR (s.freq = 'weekly' AND extract(dow FROM ($1::timestamptz AT TIME ZONE o.timezone)) = s.weekday)
           OR (s.freq = 'monthly' AND extract(day FROM ($1::timestamptz AT TIME ZONE o.timezone)) = s.monthday))`, [now]))).rows;
    for (const s of due) {
      let status = "ok";
      try {
        const r = await sendReport(pool, svc, notify, id, s.reportId, s.endpointIds, s.format, s.createdBy);
        const failed = r.results.filter((x) => !x.ok);
        if (failed.length) status = `${failed.length} of ${r.results.length} failed: ${failed[0]!.error}`.slice(0, 300);
        else sent++;
      } catch (e) { status = `failed: ${(e as Error).message}`.slice(0, 300); }
      await withOrg(pool, id, (c) => c.query("UPDATE report_schedules SET last_run_at = $2, last_status = $3 WHERE id = $1", [s.id, now, status])).catch(() => {});
      log(`scheduled report ${s.id}: ${status}`);
    }
  }
  return sent;
}
