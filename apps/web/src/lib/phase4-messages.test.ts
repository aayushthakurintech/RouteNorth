import { messages } from "@routenorth/shared";
import { describe, expect, it } from "vitest";

const { en, fr } = messages;

const TRIGGERS = ["job.created", "job.assigned", "job.started", "job.arrived", "job.done", "job.failed", "job.cancelled", "job.unassigned", "job.rescheduled", "route.stop_removed", "help.requested", "expense.submitted", "feedback.received", "alert.raised", "shift.ended", "message.received", "order.received", "job.unassigned_for", "job.not_started_for", "driver.minutes_away", "driver.stops_away"];
const ACTIONS = ["notify", "notify_customer", "notify_driver", "create_alert", "set_job", "request_approval", "create_invoice", "replan_route"];
const EVENTS = ["received", "scheduled", "on_the_way", "minutes_away", "stops_away", "arrived", "delivered", "failed", "rescheduled", "cancelled"];
const FAMILIES: Record<string, string[]> = {
  wf_tr_: TRIGGERS, wf_a_: ACTIONS, wf_op_: ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "in"], wf_run_: ["ok", "failed", "skipped"],
  cx_ev_: EVENTS, cx_p_: ["showDriver", "allowReschedule", "allowCancel", "allowInstructions", "allowReturns"],
  ap_s_: ["pending", "approved", "rejected"], ap_k_: ["overtime", "expense", "job", "custom"], hr_s_: ["open", "acknowledged", "resolved"],
  hk_: ["flat_tire", "breakdown", "accident", "medical", "wrong_address", "customer_not_home", "access_problem", "other"],
  qr_: ["ok", "late_10", "late_30", "arrived", "loaded", "call_me", "cant_find", "customer_absent"],
  ex_s_: ["submitted", "approved", "rejected", "reimbursed"], ex_k_: ["fuel", "parking", "toll", "meal", "repair", "other"], iv_s_: ["draft", "sent", "paid", "void"],
  wh_s_: ["pending", "ok", "failed"], cj_s_: ["unassigned", "assigned", "started", "arrived", "done", "failed", "cancelled"],
  st_level_: ["operational", "degraded", "major"], st_n_: ["info", "minor", "major", "resolved"],
  vc_: ["arrive", "complete", "fail", "navigate", "help", "break_start", "break_end", "shift_end", "message"],
  al_k_: ["needs_break", "help_request"], al_if_: ["needs_break", "help_request"], v_: ["en", "fr", "resolved", "help_request", "needs_break"],
};

describe("Phase 4 strings", () => {
  for (const [prefix, names] of Object.entries(FAMILIES)) {
    it(`${prefix}* exists in English and French`, () => {
      for (const n of names) {
        expect(en[`${prefix}${n}`], `${prefix}${n} (en)`).toBeTruthy();
        expect(fr[`${prefix}${n}`], `${prefix}${n} (fr)`).toBeTruthy();
      }
    });
  }
  it("keeps the same placeholders in both languages", () => {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(",");
    for (const k of Object.keys(en)) if (k in fr && /^(wf_|wh_|cx_|cj_|bk_|st_|pt_|dx_|ts_|ex_|iv_|ap_|ib_)/.test(k)) expect(names(fr[k]!), k).toBe(names(en[k]!));
  });
});
