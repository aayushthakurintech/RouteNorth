import { checkRateCard, type Permission } from "@routenorth/shared";
import { checkTarget, type EndpointKind } from "../notify/notifier.js";
import { CUSTOMER_EVENTS, validateWorkflow } from "../automation/spec.js";

export type FieldType = "text" | "int" | "num" | "bool" | "date" | "ts" | "time" | "ref" | "enum" | "tags" | "json";

export interface Field {
  /** API (camelCase) name */
  key: string;
  /** database column (snake_case) */
  col: string;
  type: FieldType;
  required?: boolean;
  max?: number;
  min?: number;
  values?: readonly string[];
  /** For type "ref": which resource the id must belong to. */
  ref?: string;
  /** Large value (a photo): left out of lists. */
  heavy?: boolean;
  /** Allow filtering the list with ?key=value. */
  filter?: boolean;
  /** For json: the expected shape. */
  json?: "array" | "object";
}

export interface ResourceDef {
  name: string;
  table: string;
  view: readonly Permission[];
  write: Permission;
  fields: readonly Field[];
  order: string;
  search: readonly string[];
  /** Extra checks after field validation (cross-field rules). Throw BadRequestException. */
  check?: (v: Record<string, unknown>, existing: Record<string, unknown> | null) => void;
}

const t = (key: string, col: string, o: Partial<Field> = {}): Field => ({ key, col, type: "text", max: 300, ...o });
const n = (key: string, col: string, o: Partial<Field> = {}): Field => ({ key, col, type: "num", ...o });
const i = (key: string, col: string, o: Partial<Field> = {}): Field => ({ key, col, type: "int", ...o });
const d = (key: string, col: string, o: Partial<Field> = {}): Field => ({ key, col, type: "date", ...o });
const ref = (key: string, col: string, to: string, o: Partial<Field> = {}): Field => ({ key, col, type: "ref", ref: to, filter: true, ...o });
const en = (key: string, col: string, values: readonly string[], o: Partial<Field> = {}): Field => ({ key, col, type: "enum", values, filter: true, ...o });
const b = (key: string, col: string, o: Partial<Field> = {}): Field => ({ key, col, type: "bool", ...o });

const FLEET_VIEW: readonly Permission[] = ["fleet.view", "routes.view"];

export const VEHICLE_KINDS = ["truck", "bus", "van", "car"] as const;

export const RESOURCES: readonly ResourceDef[] = [
  {
    name: "vehicles", table: "vehicles", view: FLEET_VIEW, write: "fleet.manage", order: "name", search: ["name", "plate", "vin", "make", "model"],
    fields: [
      t("name", "name", { required: true, max: 120 }), en("kind", "kind", VEHICLE_KINDS), t("plate", "plate", { max: 20 }), t("vin", "vin", { max: 17 }),
      t("make", "make", { max: 60 }), t("model", "model", { max: 60 }), i("year", "year", { min: 1950, max: 2100 }), t("color", "color", { max: 30 }),
      { key: "photoDataUrl", col: "photo_data_url", type: "text", max: 400_000, heavy: true },
      en("fuelType", "fuel_type", ["diesel", "gasoline", "electric", "hybrid", "propane", "cng"]),
      n("capacityKg", "capacity_kg", { min: 0, max: 200_000 }), n("capacityM3", "capacity_m3", { min: 0, max: 500 }), i("capacityItems", "capacity_items", { min: 0, max: 100_000 }),
      n("heightM", "height_m", { min: 0.5, max: 6 }), n("weightKg", "weight_kg", { min: 100, max: 200_000 }), b("hazmat", "hazmat"),
      n("batteryKwh", "battery_kwh", { min: 1, max: 2000 }), n("rangeKm", "range_km", { min: 1, max: 3000 }), n("odometerKm", "odometer_km", { min: 0, max: 10_000_000 }),
      ref("depotId", "depot_id", "depots"), ref("teamId", "team_id", "teams"), t("notes", "notes", { max: 2000 }), en("status", "status", ["active", "in_shop", "retired"]),
    ],
  },
  {
    name: "depots", table: "depots", view: FLEET_VIEW, write: "fleet.manage", order: "name", search: ["name", "address"],
    fields: [
      t("name", "name", { required: true, max: 120 }), t("address", "address"), n("lat", "lat", { required: true, min: -90, max: 90 }), n("lng", "lng", { required: true, min: -180, max: 180 }),
      i("radiusM", "radius_m", { min: 20, max: 5000 }), i("spots", "spots", { min: 0, max: 100_000 }), t("notes", "notes", { max: 2000 }),
    ],
  },
  {
    name: "equipment", table: "equipment", view: FLEET_VIEW, write: "fleet.manage", order: "name", search: ["name", "plate", "serial"],
    fields: [
      en("kind", "kind", ["trailer", "equipment"]), t("name", "name", { required: true, max: 120 }), t("plate", "plate", { max: 20 }), t("serial", "serial", { max: 60 }),
      n("capacityKg", "capacity_kg", { min: 0, max: 200_000 }), ref("vehicleId", "vehicle_id", "vehicles"), ref("depotId", "depot_id", "depots"),
      en("status", "status", ["available", "in_use", "maintenance", "retired"]), t("notes", "notes", { max: 2000 }),
    ],
  },
  {
    name: "documents", table: "documents", view: FLEET_VIEW, write: "fleet.manage", order: "expires_on NULLS LAST", search: ["kind", "number"],
    fields: [
      en("ownerKind", "owner_kind", ["vehicle", "driver", "equipment"], { required: true }), { key: "ownerId", col: "owner_id", type: "ref", ref: "@owner", required: true, filter: true },
      t("kind", "kind", { required: true, max: 60 }), t("number", "number", { max: 60 }), d("issuedOn", "issued_on"), d("expiresOn", "expires_on", { filter: true }),
      i("remindDays", "remind_days", { min: 0, max: 365 }), t("notes", "notes", { max: 1000 }),
    ],
  },
  {
    name: "maintenance-plans", table: "maintenance_plans", view: FLEET_VIEW, write: "fleet.manage", order: "task", search: ["task"],
    fields: [
      ref("vehicleId", "vehicle_id", "vehicles", { required: true }), t("task", "task", { required: true, max: 120 }),
      i("everyDays", "every_days", { min: 1, max: 3650 }), i("everyKm", "every_km", { min: 1, max: 1_000_000 }),
      d("lastDoneOn", "last_done_on"), n("lastDoneKm", "last_done_km", { min: 0, max: 10_000_000 }), t("notes", "notes", { max: 1000 }),
    ],
    check: (v) => {
      if (v.everyDays == null && v.everyKm == null) throw new Error("everyDays or everyKm is required");
    },
  },
  {
    name: "maintenance-logs", table: "maintenance_logs", view: FLEET_VIEW, write: "fleet.manage", order: "done_on DESC", search: ["task", "vendor"],
    fields: [
      ref("vehicleId", "vehicle_id", "vehicles", { required: true }), ref("planId", "plan_id", "maintenance-plans"), t("task", "task", { required: true, max: 120 }),
      d("doneOn", "done_on", { required: true, filter: true }), n("odometerKm", "odometer_km", { min: 0, max: 10_000_000 }), n("cost", "cost", { min: 0, max: 10_000_000 }), n("downtimeHours", "downtime_hours", { min: 0, max: 10_000 }),
      t("vendor", "vendor", { max: 120 }), t("notes", "notes", { max: 1000 }),
    ],
  },
  {
    name: "fuel-logs", table: "fuel_logs", view: FLEET_VIEW, write: "fleet.manage", order: "filled_on DESC", search: ["station"],
    fields: [
      ref("vehicleId", "vehicle_id", "vehicles", { required: true }), ref("driverId", "driver_id", "drivers"), d("filledOn", "filled_on", { required: true, filter: true }),
      n("litres", "litres", { required: true, min: 0.1, max: 4999 }), n("cost", "cost", { min: 0, max: 1_000_000 }), n("odometerKm", "odometer_km", { min: 0, max: 10_000_000 }),
      t("station", "station", { max: 120 }), t("cardLast4", "card_last4", { max: 4 }), en("source", "source", ["manual", "import"]),
    ],
  },
  {
    name: "inspections", table: "inspections", view: FLEET_VIEW, write: "fleet.manage", order: "at DESC", search: ["notes"],
    fields: [
      ref("vehicleId", "vehicle_id", "vehicles", { required: true }), ref("driverId", "driver_id", "drivers"), en("kind", "kind", ["check_out", "check_in"], { required: true }),
      { key: "items", col: "items", type: "json", json: "array" }, b("defects", "defects"), n("odometerKm", "odometer_km", { min: 0, max: 10_000_000 }),
      t("notes", "notes", { max: 2000 }), { key: "at", col: "at", type: "ts" },
    ],
  },
  {
    name: "incidents", table: "incidents", view: FLEET_VIEW, write: "fleet.manage", order: "occurred_at DESC", search: ["description", "location"],
    fields: [
      ref("vehicleId", "vehicle_id", "vehicles"), ref("driverId", "driver_id", "drivers"), { key: "occurredAt", col: "occurred_at", type: "ts" },
      en("kind", "kind", ["accident", "near_miss", "theft", "damage", "breakdown", "other"]), en("severity", "severity", ["minor", "moderate", "major"]),
      t("description", "description", { required: true, max: 4000 }), n("lat", "lat", { min: -90, max: 90 }), n("lng", "lng", { min: -180, max: 180 }), t("location", "location"),
      b("injuries", "injuries"), t("policeReport", "police_report", { max: 60 }), en("status", "status", ["open", "investigating", "closed"]),
    ],
  },
  {
    name: "geofences", table: "geofences", view: ["fleet.view", "alerts.view"], write: "alerts.manage", order: "name", search: ["name"],
    fields: [
      t("name", "name", { required: true, max: 120 }), en("shape", "shape", ["circle", "polygon"]), n("lat", "lat", { min: -90, max: 90 }), n("lng", "lng", { min: -180, max: 180 }),
      i("radiusM", "radius_m", { min: 10, max: 100_000 }), { key: "polygon", col: "polygon", type: "json", json: "array" },
      en("alertOn", "alert_on", ["enter", "exit", "both", "none"]), t("color", "color", { max: 9 }), b("active", "active"), t("notes", "notes", { max: 1000 }),
    ],
    check: (v) => {
      const shape = v.shape ?? "circle";
      if (shape === "circle" && (v.lat == null || v.lng == null || v.radiusM == null)) throw new Error("a circle needs lat, lng and radiusM");
      if (shape === "polygon" && (!Array.isArray(v.polygon) || v.polygon.length < 3)) throw new Error("a polygon needs at least 3 points");
    },
  },
  {
    name: "jobs", table: "jobs", view: ["routes.view"], write: "routes.write", order: "scheduled_date DESC NULLS LAST, created_at DESC", search: ["title", "ref", "customer_name", "address"],
    fields: [
      t("ref", "ref", { max: 60 }), en("type", "type", ["pickup", "delivery", "service", "inspection"]), en("priority", "priority", ["low", "normal", "high", "urgent"]),
      en("status", "status", ["unassigned", "assigned", "started", "arrived", "done", "failed", "cancelled"]),
      t("title", "title", { required: true, max: 200 }), t("customerName", "customer_name", { max: 120 }), t("customerPhone", "customer_phone", { max: 40 }), t("customerEmail", "customer_email", { max: 200 }),
      t("address", "address"), n("lat", "lat", { min: -90, max: 90 }), n("lng", "lng", { min: -180, max: 180 }),
      d("scheduledDate", "scheduled_date", { filter: true }), { key: "windowStart", col: "window_start", type: "ts" }, { key: "windowEnd", col: "window_end", type: "ts" },
      i("serviceMin", "service_min", { min: 0, max: 600 }), n("weightKg", "weight_kg", { min: 0, max: 200_000 }), n("volumeM3", "volume_m3", { min: 0, max: 500 }), i("items", "items", { min: 0, max: 100_000 }),
      { key: "skills", col: "skills", type: "tags" }, { key: "tags", col: "tags", type: "tags" }, t("notes", "notes", { max: 2000 }),
      ref("driverId", "driver_id", "drivers"), ref("vehicleId", "vehicle_id", "vehicles"), ref("routeId", "route_id", "@routes"), ref("teamId", "team_id", "teams"),
      t("reasonCode", "reason_code", { max: 40 }), t("reasonNote", "reason_note", { max: 500 }),
      n("price", "price", { min: 0, max: 10_000_000 }), t("customerInstructions", "customer_instructions", { max: 500 }),
    ],
  },
  {
    name: "shift-plans", table: "shift_plans", view: ["routes.view"], write: "routes.dispatch", order: "starts_at", search: ["note"],
    fields: [
      ref("driverId", "driver_id", "drivers", { required: true }), { key: "startsAt", col: "starts_at", type: "ts", required: true }, { key: "endsAt", col: "ends_at", type: "ts", required: true },
      ref("vehicleId", "vehicle_id", "vehicles"), t("note", "note", { max: 500 }),
    ],
    check: (v) => {
      const a = Date.parse(String(v.startsAt)), e = Date.parse(String(v.endsAt));
      if (!(e > a)) throw new Error("the shift must end after it starts");
      if (e - a > 24 * 3_600_000) throw new Error("a planned shift is at most 24 hours");
    },
  },
  {
    name: "rate-cards", table: "rate_cards", view: ["reports.view", "customers.view"], write: "customers.manage", order: "name", search: ["name", "customer_name"],
    fields: [
      t("name", "name", { required: true, max: 120 }), en("basis", "basis", ["distance", "weight", "zone", "time"], { required: true }),
      n("base", "base", { min: 0, max: 1_000_000 }), n("minimum", "minimum", { min: 0, max: 1_000_000 }),
      { key: "tiers", col: "tiers", type: "json", json: "array" }, { key: "zones", col: "zones", type: "json", json: "array" },
      t("customerName", "customer_name", { max: 120 }), b("active", "active"), t("notes", "notes", { max: 1000 }),
    ],
    check: (v) => { const bad = checkRateCard(v as Parameters<typeof checkRateCard>[0]); if (bad) throw new Error(bad); },
  },
  {
    name: "budgets", table: "budgets", view: ["reports.view"], write: "customers.manage", order: "name", search: ["name"],
    fields: [
      t("name", "name", { required: true, max: 120 }), en("category", "category", ["fuel", "maintenance", "expenses", "total"], { required: true }),
      en("period", "period", ["month", "quarter", "year"]), n("amount", "amount", { required: true, min: 0.01, max: 100_000_000 }),
      ref("vehicleId", "vehicle_id", "vehicles"), b("active", "active"),
    ],
  },
  {
    name: "contracts", table: "contracts", view: ["reports.view", "customers.view"], write: "customers.manage", order: "customer_name, starts_on DESC", search: ["customer_name", "title"],
    fields: [
      t("customerName", "customer_name", { required: true, max: 120 }), t("title", "title", { required: true, max: 200 }),
      d("startsOn", "starts_on", { required: true }), d("endsOn", "ends_on"), n("value", "value", { min: 0, max: 1_000_000_000 }),
      n("onTimeTargetPct", "on_time_target_pct", { min: 0, max: 100 }), ref("rateCardId", "rate_card_id", "rate-cards"),
      b("autoRenew", "auto_renew"), en("status", "status", ["draft", "active", "terminated"]), t("notes", "notes", { max: 2000 }),
    ],
    check: (v) => { if (v.endsOn && v.startsOn && String(v.endsOn) < String(v.startsOn)) throw new Error("the contract cannot end before it starts"); },
  },
  {
    name: "route-templates", table: "route_templates", view: ["routes.view"], write: "routes.write", order: "name", search: ["name"],
    fields: [
      t("name", "name", { required: true, max: 200 }), ref("vehicleId", "vehicle_id", "vehicles"), ref("driverId", "driver_id", "drivers"), ref("depotId", "depot_id", "depots"),
      en("objective", "objective", ["time", "distance"]), { key: "avoid", col: "avoid", type: "tags" }, { key: "startTime", col: "start_time", type: "time" },
      { key: "stops", col: "stops", type: "json", json: "array" }, { key: "recurrence", col: "recurrence", type: "json", json: "object" }, b("active", "active"),
    ],
  },
  {
    name: "dashboards", table: "dashboards", view: ["reports.view"], write: "reports.manage", order: "name", search: ["name"],
    fields: [t("name", "name", { required: true, max: 80 }), { key: "widgets", col: "widgets", type: "json", json: "array", required: true }, b("shared", "shared")],
  },
  {
    name: "goals", table: "goals", view: ["reports.view"], write: "reports.manage", order: "name", search: ["name"],
    fields: [
      t("name", "name", { required: true, max: 120 }), t("metric", "metric", { required: true, max: 60 }), n("target", "target", { required: true, min: -1e9, max: 1e9 }),
      en("direction", "direction", ["up", "down"]), en("period", "period", ["day", "week", "month"]), b("active", "active"),
    ],
  },
  {
    name: "feedback", table: "feedback", view: ["reports.view"], write: "customers.manage", order: "created_at DESC", search: ["comment"],
    fields: [ref("driverId", "driver_id", "drivers"), ref("routeId", "route_id", "@routes"), i("csat", "csat", { min: 1, max: 5 }), i("nps", "nps", { min: 0, max: 10 }), t("comment", "comment", { max: 2000 }), en("source", "source", ["link", "portal", "office"])],
    check: (v) => { if (v.csat == null && v.nps == null) throw new Error("give a satisfaction score (1 to 5) or a recommend score (0 to 10)"); },
  },
  {
    name: "workflows", table: "workflows", view: ["alerts.view"], write: "alerts.manage", order: "name", search: ["name"],
    fields: [
      t("name", "name", { required: true, max: 120 }), t("description", "description", { max: 500 }), b("active", "active"),
      { key: "trigger", col: "trigger", type: "json", json: "object", required: true }, en("match", "match", ["all", "any"]),
      { key: "conditions", col: "conditions", type: "json", json: "array" }, { key: "actions", col: "actions", type: "json", json: "array", required: true },
      i("runCount", "run_count", { min: 0 }),
    ],
    check: (v) => { validateWorkflow(v as { trigger?: unknown; match?: unknown; conditions?: unknown; actions?: unknown }); },
  },
  {
    name: "training-items", table: "training_items", view: ["settings.manage", "driver.app"], write: "settings.manage", order: "sort, title", search: ["title"],
    fields: [t("title", "title", { required: true, max: 120 }), t("body", "body", { max: 2000 }), t("videoUrl", "video_url", { max: 500 }), en("lang", "lang", ["en", "fr"]), i("sort", "sort", { min: 0, max: 10000 }), b("active", "active")],
    check: (v) => { if (v.videoUrl && !/^https:\/\/[^\s]+$/.test(String(v.videoUrl))) throw new Error("the video address must start with https://"); },
  },
  {
    name: "status-notices", table: "status_notices", view: ["settings.manage", "customers.view"], write: "customers.manage", order: "starts_at DESC", search: ["title"],
    fields: [en("level", "level", ["info", "minor", "major", "resolved"]), t("title", "title", { required: true, max: 160 }), t("body", "body", { max: 2000 }), { key: "startsAt", col: "starts_at", type: "ts" }, { key: "endsAt", col: "ends_at", type: "ts" }],
  },
  {
    name: "faq-items", table: "faq_items", view: ["settings.manage", "customers.view"], write: "customers.manage", order: "sort, question", search: ["question", "answer"],
    fields: [t("question", "question", { required: true, max: 300 }), t("answer", "answer", { required: true, max: 4000 }), en("lang", "lang", ["en", "fr"]), i("sort", "sort", { min: 0, max: 10000 }), b("published", "published")],
  },
  {
    name: "message-templates", table: "message_templates", view: ["customers.view"], write: "customers.manage", order: "event, channel, locale", search: ["event"],
    fields: [
      t("event", "event", { required: true, max: 30 }), en("channel", "channel", ["email", "sms"], { required: true }), en("locale", "locale", ["en", "fr"], { required: true }),
      t("subject", "subject", { max: 200 }), t("body", "body", { required: true, max: 2000 }),
    ],
    check: (v) => { if (!(CUSTOMER_EVENTS as readonly string[]).includes(String(v.event))) throw new Error(`event must be one of ${CUSTOMER_EVENTS.join(", ")}`); },
  },
  {
    name: "notification-endpoints", table: "notification_endpoints", view: ["alerts.manage", "reports.manage"], write: "alerts.manage", order: "label", search: ["label"],
    fields: [en("kind", "kind", ["email", "slack", "teams", "sms", "webhook"], { required: true }), t("label", "label", { required: true, max: 80 }), t("target", "target", { required: true, max: 500 }), b("enabled", "enabled")],
    check: (v) => { const bad = checkTarget(v.kind as EndpointKind, String(v.target ?? "")); if (bad) throw new Error(bad); },
  },
  {
    name: "alert-rules", table: "alert_rules", view: ["alerts.view"], write: "alerts.manage", order: "name", search: ["name"],
    fields: [
      t("name", "name", { required: true, max: 120 }),
      en("kind", "kind", ["late_risk", "off_route", "long_idle", "speeding", "geofence", "offline", "harsh_driving", "document_expiry", "maintenance_due", "cost_anomaly", "custom_metric", "needs_break", "help_request", "budget"], { required: true }),
      { key: "params", col: "params", type: "json", json: "object" }, en("severity", "severity", ["info", "warn", "critical"]),
      { key: "endpointIds", col: "endpoint_ids", type: "tags" }, b("notifyInapp", "notify_inapp"), { key: "quietStart", col: "quiet_start", type: "time" }, { key: "quietEnd", col: "quiet_end", type: "time" },
      i("groupMinutes", "group_minutes", { min: 0, max: 1440 }), b("active", "active"),
    ],
  },
  {
    name: "report-schedules", table: "report_schedules", view: ["reports.view"], write: "reports.manage", order: "created_at DESC", search: [],
    fields: [
      ref("reportId", "report_id", "report-defs", { required: true }), en("freq", "freq", ["daily", "weekly", "monthly"], { required: true }), i("hour", "hour", { min: 0, max: 23 }),
      i("weekday", "weekday", { min: 0, max: 6 }), i("monthday", "monthday", { min: 1, max: 28 }), en("format", "format", ["csv", "xlsx", "pdf"]),
      { key: "endpointIds", col: "endpoint_ids", type: "tags" }, b("active", "active"),
    ],
    check: (v) => {
      if (v.freq === "weekly" && v.weekday == null) throw new Error("a weekly schedule needs a weekday (0 is Sunday)");
      if (v.freq === "monthly" && v.monthday == null) throw new Error("a monthly schedule needs a day of the month (1 to 28)");
    },
  },
];

export const BY_NAME = new Map(RESOURCES.map((r) => [r.name, r]));

/** Tables that "ref" fields point at (drivers are users whose role is driver). */
export const REF_TABLES: Record<string, { table: string; where?: string }> = {
  vehicles: { table: "vehicles" }, depots: { table: "depots" }, "maintenance-plans": { table: "maintenance_plans" },
  drivers: { table: "users", where: "role = 'driver'" }, "@routes": { table: "routes" }, "report-defs": { table: "report_defs" }, equipment: { table: "equipment" }, teams: { table: "teams" }, "rate-cards": { table: "rate_cards" },
};
