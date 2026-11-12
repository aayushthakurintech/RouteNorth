import { FLAGS, HELP_ARTICLES, HELP_TOPICS, messages } from "@routenorth/shared";
import { describe, expect, it } from "vitest";

const { en, fr } = messages;

const TRIGGERS = ["job.created", "job.assigned", "job.started", "job.arrived", "job.done", "job.failed", "job.cancelled", "job.unassigned", "job.rescheduled", "route.stop_removed", "help.requested", "expense.submitted", "feedback.received", "alert.raised", "shift.ended", "message.received", "order.received", "job.unassigned_for", "job.not_started_for", "driver.minutes_away", "driver.stops_away"];
const ACTIONS = ["notify", "notify_customer", "notify_driver", "create_alert", "set_job", "request_approval", "create_invoice", "replan_route"];
const EVENTS = ["received", "scheduled", "on_the_way", "minutes_away", "stops_away", "arrived", "delivered", "failed", "rescheduled", "cancelled"];
const CTL = ["tenant", "audit", "twoFactorRequired", "twoFactorAdmins", "twoFactorCoverage", "ipAllow", "sessionLength", "retention", "driverPrivacy", "staleKeys", "backups", "encryptionTransit", "policies"];
const HX = ["database", "gpsFeed", "silentDevices", "webhooks", "customerMessages", "workflows", "errors", "email", "sms", "geocoder"];
const HX_STATES: Record<string, string[]> = { database: ["ok", "warn"], gpsFeed: ["off", "ok", "warn", "fail"], silentDevices: ["off", "ok", "warn"], webhooks: ["ok", "warn"], customerMessages: ["off", "ok", "warn"], workflows: ["off", "ok", "warn"], errors: ["ok", "warn", "fail"], email: ["ok", "off"], sms: ["ok", "off"], geocoder: ["ok", "off"] };
const SEC_PARTS: Record<string, number> = { tenant: 3, signin: 4, data: 4, privacy: 3, ops: 3, canada: 2, gaps: 4 };
const FLAG_KEYS = FLAGS.map((f) => f.key);
const FAMILIES: Record<string, string[]> = {
  sx_ctl_: [...CTL, ...CTL.map((c) => `${c}_d`)], sx_cs_: ["ok", "todo", "external"], sx_plan_: ["now", "now_d", "policies", "policies_d", "audit", "audit_d", "iso", "iso_d"],
  hx_overall_: ["ok", "warn", "fail", "off"], hx_s_: ["ok", "warn", "fail", "off"], hx_c_: [...HX, ...HX.flatMap((h) => HX_STATES[h]!.map((st) => `${h}_${st}`))],
  lb_f_: [...FLAG_KEYS, ...FLAG_KEYS.map((k) => `${k}_d`)], hlp_: HELP_ARTICLES.flatMap((a) => [`${a.id}_t`, `${a.id}_b`]), hlp_topic_: ["all", ...HELP_TOPICS],
  fb_k_: ["question", "bug", "idea", "praise"], fb_ph_: ["question", "bug", "idea", "praise"], fb_s_: ["open", "answered", "closed"], rm_s_: ["considering", "planned", "building", "shipped"],
  pb_sec_: [...Object.keys(SEC_PARTS), ...Object.entries(SEC_PARTS).flatMap(([k, n]) => Array.from({ length: n }, (_, i) => `${k}_${i + 1}`))], pb_sys_c_: ["api", "database"], pb_sys_s_: ["investigating", "monitoring", "resolved"],
  bl_plan_: ["trial", "starter", "pro", "enterprise"], bl_m_: ["vehicles", "users", "jobs"], bl_qs_: ["draft", "sent", "accepted", "declined", "expired"], bl_bs_: ["ok", "warn", "over"],
  bl_sla_: ["ok", "at_risk", "breached", "no_data"], bl_by_: ["customer", "job", "route"], bl_part_: ["base", "minimum"], tm_k_: ["team", "region", "depot_group"], tm_is_: ["open", "accepted", "revoked", "expired"],
  tk_p_: ["low", "normal", "high"], sc_off_: ["vacation", "sick", "personal", "other"], res_: ["shift-plans", "rate-cards", "budgets", "contracts"],
  f_: ["teamId", "basis", "base", "minimum", "tiers", "zones", "onTimeTargetPct", "rateCardId", "autoRenew", "startsOn", "endsOn", "startsAt", "endsAt", "category", "period", "amount", "value", "customerName", "title", "note", "notes", "name", "active"],
  wf_tr_: TRIGGERS, wf_a_: ACTIONS, wf_op_: ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "in"], wf_run_: ["ok", "failed", "skipped"],
  cx_ev_: EVENTS, cx_p_: ["showDriver", "allowReschedule", "allowCancel", "allowInstructions", "allowReturns"],
  ap_s_: ["pending", "approved", "rejected"], ap_k_: ["overtime", "expense", "job", "custom"], hr_s_: ["open", "acknowledged", "resolved"],
  hk_: ["flat_tire", "breakdown", "accident", "medical", "wrong_address", "customer_not_home", "access_problem", "other", "sos", "crash"],
  ai_b_: ["help", "unassigned", "late", "approvals", "alerts", "documents", "maintenance", "unhappy", "overtime"], ai_sev_: ["info", "warn", "critical"], ai_risk_: ["low", "medium", "high"],
  ai_cause_: ["late_start", "failed_stop", "long_stop", "help", "weather", "idle", "driving"], ai_h_: ["service_km", "service_days", "open_defects", "fuel_up", "repairs", "downtime", "incidents", "age", "mileage"],
  ai_fix_: ["capitals", "postal_code", "province", "street_type", "unit_order"], ai_issue_: ["empty", "no_street_number", "no_postal_code", "no_province", "odd_postal_code", "all_caps", "too_short"],
  ai_tpl_: ["daily", "fuelEmissions", "idle", "mileage", "driverScorecard", "vehicleHealth", "customerService", "exceptions", "routeEfficiency", "billing", "geofenceVisits", "compliance"],
  ai_range_: ["yesterday", "last7", "last30", "thisMonth", "lastMonth"], ai_ex: ["1", "2", "3", "4", "_report"],
  op_opt_: ["current", "time", "distance"], op_pair_: ["ok", "waiting", "wrong_order", "different_driver", "unplaced", "new"], op_tab_: ["areas", "balance", "depots", "cost", "returns", "whatif", "prefs"],
  sf_ev_: ["speeding", "harsh_brake", "harsh_accel", "harsh_corner", "crash", "sos", "incident", "other"], sf_lvl_: ["ok", "soon", "now"],
  sf_m_: ["driverScore", "onTimeRate", "stopsDone", "csat", "speedingEvents", "harshBrakes"], sf_p_: ["week", "month"], sf_r_: ["earned", "paid", "void"],
  sf_tab_: ["scores", "live", "rewards", "clips", "settings"], sf_tip_: ["speed", "brake", "accel", "corner", "idle", "great"], sf_badge_: ["smooth", "no_speeding", "incident_free"],
  sf_set_: ["coaching", "leaderboard", "anonymous", "crash", "warnBreak", "stopBreak", "warnShift", "maxShift", "grace", "note"],
  integ_g_: ["developers", "automation", "maps", "accounting", "crm", "ecommerce", "erp", "telematics", "fuel", "messaging", "chat", "calendar", "payments", "inbound", "data", "security"],
  integ_m_: ["built_in", "api", "webhook", "feed", "external"], integ_tab_: ["catalog", "keys", "docs", "data", "email", "widget", "maps"], integ_p_: ["osm", "maptiler", "mapbox", "here", "google"],
  integ_k_: ["api", "feed", "inbound"], integ_s_: ["read", "write"], cf_e_: ["job", "vehicle", "driver", "customer", "depot"], cf_t_: ["text", "number", "date", "bool", "select"],
  imp_f_: ["title", "address", "customer_name", "customer_phone", "customer_email", "scheduled_date", "type", "priority", "notes", "weight_kg", "service_min", "ref"],
  jobEvent_: ["created", "assigned", "unassigned", "status", "cancelled", "rescheduled", "urgent", "attachment", "customer", "workflow"],
  qr_: ["ok", "late_10", "late_30", "arrived", "loaded", "call_me", "cant_find", "customer_absent"],
  ex_s_: ["submitted", "approved", "rejected", "reimbursed"], ex_k_: ["fuel", "parking", "toll", "meal", "repair", "other"], iv_s_: ["draft", "sent", "paid", "void"],
  wh_s_: ["pending", "ok", "failed"], cj_s_: ["unassigned", "assigned", "started", "arrived", "done", "failed", "cancelled"],
  st_level_: ["operational", "degraded", "major"], st_n_: ["info", "minor", "major", "resolved"],
  vc_: ["arrive", "complete", "fail", "navigate", "help", "break_start", "break_end", "shift_end", "message"],
  al_k_: ["needs_break", "help_request", "fatigue", "checkin_missed", "crash", "budget"], al_if_: ["needs_break", "help_request", "fatigue", "checkin_missed", "crash"], v_: ["en", "fr", "resolved", "help_request", "needs_break", "distance", "weight", "zone", "time", "fuel", "maintenance", "expenses", "total", "month", "quarter", "year", "draft", "terminated"],
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
    for (const k of Object.keys(en)) if (k in fr && /^(wf_|wh_|cx_|cj_|bk_|st_|pt_|dx_|ts_|ex_|iv_|ap_|ib_|ai_|op_|sf_|integ_|cf_|cs_|imp_|bl_|tm_|tk_|sc_|cm_|inv_|sx_|hx_|ux_|lb_|sp_|fb_|rm_|pb_|hlp_|mfa_)/.test(k)) expect(names(fr[k]!), k).toBe(names(en[k]!));
  });
});
