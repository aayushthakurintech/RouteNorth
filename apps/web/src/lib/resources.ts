import type { MessageKey } from "@routenorth/shared";

export interface FieldSchema {
  key: string; type: "text" | "int" | "num" | "bool" | "date" | "ts" | "time" | "ref" | "enum" | "tags" | "json";
  required: boolean; values?: string[]; ref?: string; heavy: boolean; min?: number; max?: number;
}
export interface ResourceSchema { name: string; canWrite: boolean; fields: FieldSchema[] }

/** What each records page shows in its table and hides from its form. Field names and choices come from the API schema. */
export interface ResourceView {
  /** Columns shown in the table, in order. */
  columns: string[];
  /** Fields left out of the edit form (managed elsewhere). */
  hideInForm?: string[];
  /** Page-specific note under the title. */
  hint?: MessageKey;
  /** Default sort key. */
  sortKey?: string;
  /** Attachments can be added to a record of this kind. */
  attach?: "vehicle" | "incident" | "equipment" | "document";
  /** Fields that are long text. */
  longText?: string[];
}

export const RESOURCE_VIEWS: Record<string, ResourceView> = {
  vehicles: { columns: ["name", "kind", "plate", "make", "model", "year", "capacityKg", "odometerKm", "status"], hideInForm: [], attach: "vehicle", longText: ["notes"] },
  depots: { columns: ["name", "address", "radiusM", "spots"], longText: ["notes", "address"] },
  equipment: { columns: ["name", "kind", "plate", "serial", "vehicleId", "status"], attach: "equipment", longText: ["notes"] },
  documents: { columns: ["ownerKind", "ownerId", "kind", "number", "expiresOn"], attach: "document", longText: ["notes"] },
  "maintenance-plans": { columns: ["vehicleId", "task", "everyDays", "everyKm", "lastDoneOn", "lastDoneKm"], longText: ["notes"] },
  "maintenance-logs": { columns: ["doneOn", "vehicleId", "task", "odometerKm", "cost", "vendor"], longText: ["notes"] },
  "fuel-logs": { columns: ["filledOn", "vehicleId", "litres", "cost", "odometerKm", "station", "source"] },
  inspections: { columns: ["at", "vehicleId", "kind", "defects", "odometerKm", "notes"], hideInForm: ["items", "at"], longText: ["notes"] },
  incidents: { columns: ["occurredAt", "kind", "severity", "vehicleId", "driverId", "status", "description"], hideInForm: [], attach: "incident", longText: ["description"] },
  geofences: { columns: ["name", "shape", "alertOn", "active"], hideInForm: ["polygon"], longText: ["notes"] },
  jobs: {
    columns: ["scheduledDate", "title", "type", "priority", "status", "customerName", "address"],
    hideInForm: ["status", "driverId", "vehicleId", "routeId", "reasonCode", "reasonNote"], longText: ["notes", "address"],
  },
  "faq-items": { columns: ["question", "lang", "sort", "published"], longText: ["answer"] },
  "status-notices": { columns: ["level", "title", "startsAt", "endsAt"], longText: ["body"] },
  "training-items": { columns: ["title", "lang", "sort", "active"], longText: ["body"] },
  "route-templates": { columns: ["name", "vehicleId", "driverId", "startTime", "objective", "active"], hideInForm: ["stops"] },
};

/** All pages of fleet records, in menu order, with the permission needed to see them. */
export const RESOURCE_ORDER = ["vehicles", "equipment", "depots", "documents", "maintenance-plans", "maintenance-logs", "fuel-logs", "inspections", "incidents", "route-templates"] as const;

/** ISO timestamp → value for <input type="datetime-local">. */
export function isoToLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Form state (strings) → the JSON body the API wants, leaving out untouched blanks on create. */
export function formToBody(fields: FieldSchema[], form: Record<string, unknown>, hidden: string[], creating: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (hidden.includes(f.key) || f.heavy && form[f.key] === undefined) continue;
    const v = form[f.key];
    const blank = v === undefined || v === null || v === "";
    switch (f.type) {
      case "bool": if (v !== undefined || creating) out[f.key] = !!v; break;
      case "int": case "num": if (!blank) out[f.key] = Number(v); else if (!creating) out[f.key] = null; break;
      case "ts": if (!blank) out[f.key] = new Date(String(v)).toISOString(); else if (!creating) out[f.key] = null; break;
      case "tags": out[f.key] = Array.isArray(v) ? v : String(v ?? "").split(",").map((s) => s.trim()).filter(Boolean); break;
      case "json": if (typeof v === "string" && v.trim()) out[f.key] = JSON.parse(v); break;
      default: if (!blank) out[f.key] = v; else if (!creating) out[f.key] = null;
    }
  }
  return out;
}
