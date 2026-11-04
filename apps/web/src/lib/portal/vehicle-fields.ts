import type { FieldSpec } from "@/components/portal/field-form";

const opts = (xs: readonly string[], label?: Record<string, string>) => xs.map((x) => ({ value: x, label: label?.[x] ?? x.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) }));

export const KINDS = opts(["truck", "bus", "van", "car", "suv", "bike", "other"]);
export const FUELS = opts(["diesel", "gasoline", "electric", "hybrid", "propane", "cng"]);
/** What the owner can set by hand. "On trip" and "Idle" are worked out from live activity, so they are not choices. */
export const STORED_STATUSES = [
  { value: "active", label: "In use" }, { value: "in_shop", label: "In service (at the shop)" }, { value: "out_of_service", label: "Out of service" }, { value: "retired", label: "Out of service (retired)" },
];
export const STATUS_LABEL: Record<string, string> = { active: "Active", on_trip: "On trip", idle: "Idle", in_service: "In service", out_of_service: "Out of service", sold: "Sold", archived: "Archived" };
export const STATUS_TONE: Record<string, "good" | "info" | "warn" | "bad" | "neutral"> = { active: "good", on_trip: "info", idle: "warn", in_service: "warn", out_of_service: "bad", sold: "neutral", archived: "neutral" };

/** The add / edit car form, in the order the spec lists the fields. */
export const VEHICLE_FORM: FieldSpec[] = [
  { key: "name", label: "Nickname", required: true, placeholder: "Truck 12" },
  { key: "kind", label: "Vehicle type", type: "select", options: KINDS, required: true },
  { key: "plate", label: "Plate number" },
  { key: "vin", label: "VIN", help: "17 characters. The last check is a warning only." },
  { key: "make", label: "Make" }, { key: "model", label: "Model" },
  { key: "year", label: "Year", type: "number", step: "1" }, { key: "trim", label: "Trim" },
  { key: "color", label: "Colour" }, { key: "fuelType", label: "Fuel type", type: "select", options: FUELS },
  { key: "engine", label: "Engine" }, { key: "seats", label: "Seats", type: "number", step: "1" },
  { key: "tireSize", label: "Tire size" },
  { key: "capacityKg", label: "Max load (kg)", type: "number" }, { key: "capacityM3", label: "Cargo volume (m³)", type: "number" },
  { key: "weightKg", label: "Weight (kg)", type: "number" }, { key: "heightM", label: "Height (m)", type: "number" },
  { key: "odometerKm", label: "Odometer (km)", type: "number" }, { key: "engineHours", label: "Engine hours", type: "number" },
  { key: "status", label: "Status", type: "select", options: STORED_STATUSES, required: true, help: "On trip and Idle are worked out from live activity." },
  { key: "ownershipType", label: "Ownership", type: "select", options: opts(["owned", "financed", "leased"]) },
  { key: "purchaseDate", label: "Purchase date", type: "date" }, { key: "purchasePriceCents", label: "Purchase price", type: "money" },
  { key: "financePaymentCents", label: "Loan or lease payment", type: "money", showIf: (v) => v.ownershipType === "financed" || v.ownershipType === "leased" },
  { key: "financeInterval", label: "Paid", type: "select", options: opts(["weekly", "biweekly", "monthly"]), showIf: (v) => v.ownershipType === "financed" || v.ownershipType === "leased" },
  { key: "financeEndDate", label: "Loan or lease ends", type: "date", showIf: (v) => v.ownershipType === "financed" || v.ownershipType === "leased" },
  { key: "interestRatePct", label: "Interest rate (%)", type: "number", showIf: (v) => v.ownershipType === "financed" || v.ownershipType === "leased" },
  { key: "residualValueCents", label: "Value at the end", type: "money" }, { key: "currentValueCents", label: "Value today", type: "money" },
  { key: "insuranceProvider", label: "Insurance provider" }, { key: "policyNumber", label: "Policy number" }, { key: "insuranceExpiry", label: "Insurance expires", type: "date" },
  { key: "serviceIntervalKm", label: "Service every (km)", type: "number", step: "1" }, { key: "serviceIntervalDays", label: "Service every (days)", type: "number", step: "1" },
  { key: "serviceIntervalHours", label: "Service every (engine hours)", type: "number", step: "1" },
  { key: "idleAlertDays", label: "Call it idle after (days)", type: "number", step: "1", help: "Default is 3 days with no movement or trips." },
  { key: "tags", label: "Tags", type: "tags", help: "Separate with commas." },
  { key: "notes", label: "Notes", type: "textarea" },
];
