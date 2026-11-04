import { BadRequestException } from "@nestjs/common";
import { type Permission } from "@routenorth/shared";
import type { Field } from "../resources/defs.js";
import type { ChildDef } from "./crud.js";
import { b, d, en, i, json, money, n, ref, t, tagsF, ts } from "./field-kit.js";

export const VEHICLE_KINDS = ["truck", "bus", "van", "car", "suv", "bike", "other"] as const;
export const VEHICLE_STATUSES = ["active", "in_shop", "out_of_service", "sold", "retired"] as const;
export const FUEL_TYPES = ["diesel", "gasoline", "electric", "hybrid", "propane", "cng"] as const;

export const VIEW_VEHICLES: readonly Permission[] = ["fleet.view", "vehicles.manage", "vehicles.assign", "vehicles.costs"];
export const WRITE_VEHICLES: readonly Permission[] = ["vehicles.manage"];
export const WRITE_OPS: readonly Permission[] = ["vehicles.manage", "fleet.manage"];

/** The vehicle's own fields (the spec's data model). `name` is the spec's nickname, `kind` its vehicle_type. */
export const VEHICLE_FIELDS: readonly Field[] = [
  t("name", "name", { required: true, max: 120 }), en("kind", "kind", VEHICLE_KINDS), t("plate", "plate", { max: 20 }), t("vin", "vin", { max: 17 }),
  t("make", "make", { max: 60 }), t("model", "model", { max: 60 }), i("year", "year", { min: 1950, max: 2100 }), t("trim", "trim", { max: 60 }), t("color", "color", { max: 30 }),
  en("fuelType", "fuel_type", FUEL_TYPES), t("engine", "engine", { max: 80 }), i("seats", "seats", { min: 0, max: 100 }), t("tireSize", "tire_size", { max: 40 }),
  n("capacityKg", "capacity_kg", { min: 0, max: 200_000 }), n("capacityM3", "capacity_m3", { min: 0, max: 500 }), n("weightKg", "weight_kg", { min: 100, max: 200_000 }), n("heightM", "height_m", { min: 0.5, max: 6 }),
  n("odometerKm", "odometer_km", { min: 0, max: 10_000_000 }), n("engineHours", "engine_hours", { min: 0, max: 1_000_000 }),
  en("status", "status", VEHICLE_STATUSES),
  en("ownershipType", "ownership_type", ["owned", "financed", "leased"]), d("purchaseDate", "purchase_date"), money("purchasePriceCents", "purchase_price_cents"),
  money("financePaymentCents", "finance_payment_cents"), en("financeInterval", "finance_interval", ["weekly", "biweekly", "monthly"]), d("financeEndDate", "finance_end_date"),
  n("interestRatePct", "interest_rate_pct", { min: 0, max: 100 }), money("residualValueCents", "residual_value_cents"), money("currentValueCents", "current_value_cents"),
  t("insuranceProvider", "insurance_provider", { max: 120 }), t("policyNumber", "policy_number", { max: 80 }), d("insuranceExpiry", "insurance_expiry"),
  i("serviceIntervalKm", "service_interval_km", { min: 1, max: 1_000_000 }), i("serviceIntervalDays", "service_interval_days", { min: 1, max: 3650 }), i("serviceIntervalHours", "service_interval_hours", { min: 1, max: 100_000 }),
  i("idleAlertDays", "idle_alert_days", { min: 1, max: 365 }),
  ref("depotId", "depot_id", "depots"), ref("teamId", "team_id", "teams"), tagsF("tags", "tags"), t("notes", "notes", { max: 2000 }),
];

const day = (v: unknown) => String(v ?? "").slice(0, 10);
const LABEL = (r: Record<string, unknown>, ...keys: string[]) => keys.map((k) => r[k]).filter(Boolean).join(" · ").slice(0, 120);

const checkDates = (a: string, b2: string, msg: string) => (v: Record<string, unknown>) => {
  if (v[a] && v[b2] && day(v[b2]) < day(v[a])) throw new BadRequestException(msg);
};

export const DOCUMENTS: ChildDef = {
  name: "documents", entity: "vehicle_documents", table: "documents", parentCol: "owner_id", fixed: { owner_kind: "vehicle" }, order: "documents.expires_on NULLS LAST, documents.kind",
  fields: [t("kind", "kind", { required: true, max: 60 }), t("number", "number", { max: 80 }), d("issuedOn", "issued_on"), d("expiresOn", "expires_on"), i("remindDays", "remind_days", { min: 0, max: 365 }), t("notes", "notes", { max: 1000 })],
  label: (r) => LABEL(r, "kind", "number"), view: VIEW_VEHICLES, write: WRITE_OPS,
  check: checkDates("issuedOn", "expiresOn", "expiry date cannot be before the issue date"),
};
export const MAINTENANCE: ChildDef = {
  name: "maintenance", entity: "vehicle_maintenance", table: "maintenance_logs", parentCol: "vehicle_id", order: "maintenance_logs.done_on DESC, maintenance_logs.created_at DESC",
  fields: [
    t("task", "task", { required: true, max: 200 }), en("kind", "kind", ["service", "repair", "inspection", "tires", "other"]), d("doneOn", "done_on", { required: true }), n("odometerKm", "odometer_km", { min: 0 }),
    t("vendor", "vendor", { max: 120 }), money("labourCents", "labour_cents"), money("partsCents", "parts_cents"), t("partsNote", "parts_note", { max: 500 }), t("notes", "notes", { max: 1000 }),
    d("nextDueOn", "next_due_on"), n("nextDueKm", "next_due_km", { min: 0 }),
    { key: "planId", col: "plan_id", type: "ref", ref: "maintenance-plans" }, { key: "workOrderId", col: "work_order_id", type: "ref", ref: "work-orders" },
  ],
  extra: `maintenance_logs.total_cents::float8 AS "totalCents"`,
  label: (r) => LABEL(r, "task", "doneOn"), view: ["vehicles.manage", "fleet.view", "vehicles.costs"], write: WRITE_OPS,
};
export const PLANS: ChildDef = {
  name: "plans", entity: "vehicle_service_plans", table: "maintenance_plans", parentCol: "vehicle_id", order: "maintenance_plans.task",
  fields: [t("task", "task", { required: true, max: 120 }), i("everyDays", "every_days", { min: 1, max: 3650 }), i("everyKm", "every_km", { min: 1, max: 1_000_000 }), d("lastDoneOn", "last_done_on"), n("lastDoneKm", "last_done_km", { min: 0 }), t("notes", "notes", { max: 1000 })],
  label: (r) => String(r.task ?? ""), view: VIEW_VEHICLES, write: WRITE_OPS,
  check: (v) => { if (!v.everyDays && !v.everyKm) throw new BadRequestException("set how often: every N days, every N km, or both"); },
};
export const FUEL: ChildDef = {
  name: "fuel", entity: "vehicle_fuel", table: "fuel_logs", parentCol: "vehicle_id", order: "fuel_logs.filled_on DESC, fuel_logs.created_at DESC",
  fields: [d("filledOn", "filled_on", { required: true }), n("litres", "litres", { required: true, min: 0.01, max: 4999 }), en("unit", "unit", ["L", "kWh"]), money("costCents", "cost", { max: 100_000_000, virtual: true }), n("odometerKm", "odometer_km", { min: 0 }), t("station", "station", { max: 120 }), ref("driverId", "driver_id", "drivers")],
  extra: `fuel_logs.cost_cents::float8 AS "costCents"`,
  // Older tables keep dollars: the portal takes cents, stores cost = cents / 100 (exact to the cent) and reads the cents column back.
  columns: (v) => (v.costCents === undefined ? {} : { cost: v.costCents === null ? null : (v.costCents as number) / 100 }),
  label: (r) => LABEL(r, "station", "filledOn"), view: ["vehicles.manage", "fleet.view", "vehicles.costs"], write: WRITE_OPS,
};
export const INSPECTIONS: ChildDef = {
  name: "inspections", entity: "vehicle_inspections", table: "inspections", createdCol: "at", parentCol: "vehicle_id", order: "inspections.at DESC",
  fields: [en("kind", "kind", ["check_out", "check_in"], { required: true }), json("items", "items", "array"), b("defects", "defects"), n("odometerKm", "odometer_km", { min: 0 }), t("notes", "notes", { max: 1000 }), ref("driverId", "driver_id", "drivers"), ts("at", "at")],
  extra: `inspections.signed_off_by AS "signedOffBy", inspections.signed_off_at AS "signedOffAt", inspections.sign_off_note AS "signOffNote"`,
  label: (r) => LABEL(r, "kind", "at"), view: VIEW_VEHICLES, write: WRITE_OPS,
};
export const INCIDENTS: ChildDef = {
  name: "incidents", entity: "vehicle_incidents", table: "incidents", parentCol: "vehicle_id", order: "incidents.occurred_at DESC",
  fields: [ts("occurredAt", "occurred_at"), en("kind", "kind", ["accident", "near_miss", "theft", "damage", "breakdown", "other"]), en("severity", "severity", ["minor", "moderate", "major"]), t("description", "description", { required: true, max: 4000 }),
    t("location", "location", { max: 300 }), b("injuries", "injuries"), t("policeReport", "police_report", { max: 120 }), en("status", "status", ["open", "investigating", "closed"]),
    ref("driverId", "driver_id", "drivers"), money("repairCostCents", "repair_cost_cents"), t("claimNumber", "claim_number", { max: 80 }), en("claimStatus", "claim_status", ["none", "filed", "approved", "denied", "paid"]), b("ticket", "ticket"), money("fineCents", "fine_cents")],
  label: (r) => LABEL(r, "kind", "description"), view: VIEW_VEHICLES, write: WRITE_OPS,
};
export const ASSIGNMENTS: ChildDef = {
  name: "assignments", entity: "vehicle_assignments", table: "vehicle_assignments", parentCol: "vehicle_id", order: "vehicle_assignments.start_at DESC",
  fields: [ref("driverId", "driver_id", "drivers", { required: true }), en("kind", "kind", ["day", "week", "permanent"]), ts("startAt", "start_at", { required: true }), ts("endAt", "end_at"),
    n("odometerStartKm", "odometer_start_km", { min: 0 }), n("odometerEndKm", "odometer_end_km", { min: 0 }), i("fuelStartPct", "fuel_start_pct", { min: 0, max: 100 }), i("fuelEndPct", "fuel_end_pct", { min: 0, max: 100 }), t("damageNotes", "damage_notes", { max: 2000 }), t("note", "note", { max: 1000 })],
  label: (r) => LABEL(r, "kind", "startAt"), view: VIEW_VEHICLES, write: ["vehicles.manage", "vehicles.assign"],
};
export const WORK_ORDERS: ChildDef = {
  name: "work-orders", entity: "work_orders", table: "work_orders", parentCol: "vehicle_id", order: "work_orders.opened_at DESC",
  fields: [t("title", "title", { required: true, max: 200 }), t("description", "description", { max: 4000 }), ref("shopId", "shop_id", "shops"), en("status", "status", ["open", "assigned", "awaiting_approval", "approved", "closed", "cancelled"]),
    money("estimateCents", "estimate_cents"), money("actualCents", "actual_cents"), t("invoiceRef", "invoice_ref", { max: 80 }), d("dueOn", "due_on")],
  extra: `work_orders.approved_by AS "approvedBy", work_orders.approved_at AS "approvedAt", work_orders.closed_at AS "closedAt", work_orders.opened_at AS "openedAt", work_orders.source AS "source"`,
  label: (r) => String(r.title ?? ""), view: VIEW_VEHICLES, write: WRITE_OPS,
};
export const WARRANTIES: ChildDef = {
  name: "warranties", entity: "vehicle_warranties", table: "vehicle_warranties", parentCol: "vehicle_id", order: "vehicle_warranties.expires_on NULLS LAST",
  fields: [en("kind", "kind", ["warranty", "recall"], { required: true }), t("title", "title", { required: true, max: 200 }), t("provider", "provider", { max: 120 }), d("startsOn", "starts_on"), d("expiresOn", "expires_on"), i("kmLimit", "km_limit", { min: 1 }), en("status", "status", ["open", "done"]), t("notes", "notes", { max: 1000 })],
  label: (r) => LABEL(r, "kind", "title"), view: VIEW_VEHICLES, write: WRITE_OPS,
};
export const PARTS: ChildDef = {
  name: "parts", entity: "vehicle_parts", table: "vehicle_parts", parentCol: "vehicle_id", order: "vehicle_parts.installed_on DESC NULLS LAST",
  fields: [en("kind", "kind", ["tire", "battery", "brakes", "other"], { required: true }), t("label", "label", { required: true, max: 120 }), t("position", "position", { max: 40 }), d("installedOn", "installed_on"), n("installedKm", "installed_km", { min: 0 }),
    i("lifeKm", "life_km", { min: 1 }), i("lifeDays", "life_days", { min: 1 }), money("costCents", "cost_cents"), d("replacedOn", "replaced_on"), t("notes", "notes", { max: 500 })],
  label: (r) => LABEL(r, "kind", "label"), view: VIEW_VEHICLES, write: WRITE_OPS,
};

/** Every child list served under /portal/vehicles/:id/:name */
export const VEHICLE_CHILDREN: readonly ChildDef[] = [DOCUMENTS, MAINTENANCE, PLANS, FUEL, INSPECTIONS, INCIDENTS, ASSIGNMENTS, WORK_ORDERS, WARRANTIES, PARTS];
export const CHILD_BY_NAME = new Map(VEHICLE_CHILDREN.map((c) => [c.name, c]));
