import { BadRequestException } from "@nestjs/common";
import type { Permission } from "@routenorth/shared";
import type { Field } from "../resources/defs.js";
import type { ChildDef } from "./crud.js";
import { b, d, en, i, n, ref, t, ts } from "./field-kit.js";

export const VIEW_DRIVERS: readonly Permission[] = ["drivers.view", "drivers.manage"];
export const WRITE_DRIVERS: readonly Permission[] = ["drivers.manage"];
export const DRIVER_STATUSES_STORED = ["onboarding", "active", "off_duty", "suspended"] as const;

/** The driver's own fields on driver_profiles (personal tab, licence, work details). Bank and tax fields are separate and permission-gated. */
export const DRIVER_FIELDS: readonly Field[] = [
  t("phone", "phone", { max: 40 }), t("address", "address", { max: 300 }), d("birthDate", "birth_date"),
  { key: "languages", col: "languages", type: "tags" }, t("homeBase", "home_base", { max: 200 }), ref("homeDepotId", "home_depot_id", "depots"), ref("teamId", "team_id", "teams"),
  en("employmentType", "employment_type", ["employee", "contractor"]),
  t("licenseNo", "license_no", { max: 40 }), t("licenseClass", "license_class", { max: 20 }), d("licenseExpiry", "license_expiry"),
  t("emergencyName", "emergency_name", { max: 120 }), t("emergencyPhone", "emergency_phone", { max: 40 }),
  b("workPermitRequired", "work_permit_required"), b("leaderboardOptOut", "leaderboard_opt_out"),
  { key: "skills", col: "skills", type: "tags" }, t("notes", "notes", { max: 2000 }),
];
export const BANK_FIELDS: readonly Field[] = [
  en("payoutMethod", "payout_method", ["direct_deposit", "etransfer", "cheque", "cash"]), t("bankInstitution", "bank_institution", { max: 120 }),
  t("bankAccountLast4", "bank_account_last4", { max: 4 }), en("taxForm", "tax_form", ["td1", "t4a_contractor", "gst_hst_number", "none"]), d("taxFormReceivedOn", "tax_form_received_on"),
];

const day = (v: unknown) => String(v ?? "").slice(0, 10);
const LABEL = (r: Record<string, unknown>, ...keys: string[]) => keys.map((k) => r[k]).filter(Boolean).join(" · ").slice(0, 120);

export const D_DOCUMENTS: ChildDef = {
  name: "documents", entity: "driver_documents", table: "documents", parentCol: "owner_id", fixed: { owner_kind: "driver" }, order: "documents.expires_on NULLS LAST, documents.kind", sensitive: true,
  fields: [t("kind", "kind", { required: true, max: 60 }), t("number", "number", { max: 80 }), d("issuedOn", "issued_on"), d("expiresOn", "expires_on"), i("remindDays", "remind_days", { min: 0, max: 365 }), t("notes", "notes", { max: 1000 })],
  label: (r) => LABEL(r, "kind", "number"), view: VIEW_DRIVERS, write: WRITE_DRIVERS,
  check: (v) => { if (v.issuedOn && v.expiresOn && day(v.expiresOn) < day(v.issuedOn)) throw new BadRequestException("expiry date cannot be before the issue date"); },
};
export const D_NOTES: ChildDef = {
  name: "notes", entity: "driver_notes", table: "driver_notes", parentCol: "driver_id", order: "driver_notes.noted_on DESC, driver_notes.created_at DESC",
  fields: [en("kind", "kind", ["note", "warning", "praise", "coaching", "improvement_plan", "private"], { required: true }), t("body", "body", { required: true, max: 4000 }), d("notedOn", "noted_on"), d("dueOn", "due_on"), d("doneOn", "done_on")],
  label: (r) => LABEL(r, "kind", "body"), view: WRITE_DRIVERS, write: WRITE_DRIVERS,
};
export const D_GOALS: ChildDef = {
  name: "goals", entity: "driver_goals", table: "driver_goals", parentCol: "driver_id", order: "driver_goals.created_at",
  fields: [en("metric", "metric", ["trips", "on_time_rate", "rating", "earnings_cents", "safety_score"], { required: true }), n("target", "target", { required: true, min: 0 }), en("period", "period", ["week", "month"])],
  label: (r) => LABEL(r, "metric", "target"), view: VIEW_DRIVERS, write: WRITE_DRIVERS,
};
export const D_TRAININGS: ChildDef = {
  name: "trainings", entity: "driver_trainings", table: "driver_trainings", parentCol: "driver_id", order: "driver_trainings.completed_on DESC NULLS FIRST, driver_trainings.course",
  fields: [t("course", "course", { required: true, max: 200 }), b("required", "required"), d("completedOn", "completed_on"), d("expiresOn", "expires_on"), i("score", "score", { min: 0, max: 100 }), t("certificateRef", "certificate_ref", { max: 200 })],
  label: (r) => LABEL(r, "course", "completedOn"), view: VIEW_DRIVERS, write: WRITE_DRIVERS,
};
export const D_SAFETY: ChildDef = {
  name: "safety-events", entity: "driver_safety_events", table: "driver_safety_events", parentCol: "driver_id", order: "driver_safety_events.at DESC",
  fields: [ts("at", "at"), en("kind", "kind", ["speeding", "harsh_brake", "harsh_turn", "phone_use", "late_night", "incident", "ticket"], { required: true }), i("severity", "severity", { min: 1, max: 3 }), ref("vehicleId", "vehicle_id", "vehicles"), t("detail", "detail", { max: 1000 })],
  label: (r) => LABEL(r, "kind", "detail"), view: VIEW_DRIVERS, write: WRITE_DRIVERS,
};

export const D_CHILDREN = [D_DOCUMENTS, D_NOTES, D_GOALS, D_TRAININGS, D_SAFETY];
export const D_CHILD_BY_NAME = new Map(D_CHILDREN.map((c) => [c.name, c]));
