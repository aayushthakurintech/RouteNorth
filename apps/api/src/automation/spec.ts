/**
 * Workflows are plain data: a trigger, optional conditions and a list of actions. This file says what is allowed and
 * checks it, so a saved workflow can always be run. Nothing here touches the database.
 */
export const CUSTOMER_EVENTS = ["received", "scheduled", "on_the_way", "minutes_away", "stops_away", "arrived", "delivered", "failed", "rescheduled", "cancelled"] as const;
export type CustomerEvent = (typeof CUSTOMER_EVENTS)[number];

/** Things that happen. The processor reads them from the event feed. */
export const EVENT_TRIGGERS = [
  "job.created", "job.assigned", "job.started", "job.arrived", "job.done", "job.failed", "job.cancelled", "job.unassigned", "job.rescheduled",
  "route.stop_removed", "help.requested", "expense.submitted", "feedback.received", "alert.raised", "shift.ended", "message.received", "order.received",
] as const;
/** Things that are true for too long. The processor looks for them every minute. */
export const TIME_TRIGGERS = ["job.unassigned_for", "job.not_started_for", "driver.minutes_away", "driver.stops_away"] as const;
export const ALL_TRIGGERS: readonly string[] = [...EVENT_TRIGGERS, ...TIME_TRIGGERS];

export const OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "contains", "in"] as const;
export type Op = (typeof OPS)[number];
export const ACTION_TYPES = ["notify", "notify_customer", "notify_driver", "create_alert", "set_job", "request_approval", "create_invoice", "replan_route"] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface Trigger { kind: string; minutes?: number; stops?: number }
export interface Condition { field: string; op: Op; value: unknown }
export interface Action { type: ActionType; params: Record<string, unknown> }
export interface WorkflowSpec { trigger: Trigger; match: "all" | "any"; conditions: Condition[]; actions: Action[] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRIORITIES = ["low", "normal", "high", "urgent"];

function obj(v: unknown, what: string): Record<string, unknown> {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${what} must be an object`);
  return v as Record<string, unknown>;
}
function str(v: unknown, what: string, max: number, required = false): string | undefined {
  if (v == null || v === "") { if (required) throw new Error(`${what} is required`); return undefined; }
  if (typeof v !== "string" || v.length > max) throw new Error(`${what} must be text up to ${max} characters`);
  return v.trim();
}

export function validateTrigger(raw: unknown): Trigger {
  const o = obj(raw, "trigger");
  const kind = String(o.kind ?? "");
  if (!ALL_TRIGGERS.includes(kind)) throw new Error(`trigger kind must be one of ${ALL_TRIGGERS.join(", ")}`);
  const t: Trigger = { kind };
  if (kind === "job.unassigned_for" || kind === "job.not_started_for" || kind === "driver.minutes_away") {
    const m = Number(o.minutes);
    if (!Number.isInteger(m) || m < 1 || m > 1440) throw new Error("minutes must be a whole number from 1 to 1440");
    t.minutes = m;
  }
  if (kind === "driver.stops_away") {
    const n = Number(o.stops);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new Error("stops must be a whole number from 1 to 50");
    t.stops = n;
  }
  return t;
}

export function validateConditions(raw: unknown): Condition[] {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 20) throw new Error("conditions must be a list of up to 20");
  return raw.map((c, i) => {
    const o = obj(c, `condition ${i + 1}`);
    const field = String(o.field ?? "");
    if (!/^[a-z][a-z0-9_]*(\.[a-z0-9_]+){0,3}$/i.test(field) || field.length > 60) throw new Error(`condition ${i + 1}: field must look like job.priority`);
    const op = String(o.op ?? "") as Op;
    if (!OPS.includes(op)) throw new Error(`condition ${i + 1}: operator must be one of ${OPS.join(", ")}`);
    let value = o.value;
    if (op === "in") {
      if (!Array.isArray(value) || value.length === 0 || value.length > 50) throw new Error(`condition ${i + 1}: "in" needs a list of values`);
    } else if (!(typeof value === "string" || typeof value === "number" || typeof value === "boolean")) throw new Error(`condition ${i + 1}: value must be text, a number or true/false`);
    if (typeof value === "string" && value.length > 200) throw new Error(`condition ${i + 1}: value is too long`);
    return { field, op, value };
  });
}

export function validateActions(raw: unknown): Action[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 10) throw new Error("add between 1 and 10 actions");
  return raw.map((a, i) => {
    const o = obj(a, `action ${i + 1}`);
    const type = String(o.type ?? "") as ActionType;
    if (!ACTION_TYPES.includes(type)) throw new Error(`action ${i + 1}: type must be one of ${ACTION_TYPES.join(", ")}`);
    const p = o.params == null ? {} : obj(o.params, `action ${i + 1} params`);
    const out: Record<string, unknown> = {};
    switch (type) {
      case "notify": {
        const ids = p.endpointIds ?? [];
        if (!Array.isArray(ids) || ids.length > 10 || !ids.every((x) => typeof x === "string" && UUID.test(x))) throw new Error(`action ${i + 1}: choose where to send it`);
        out.endpointIds = ids;
        out.subject = str(p.subject, "subject", 120) ?? "RouteNorth";
        out.text = str(p.text, "text", 500, true);
        break;
      }
      case "notify_customer": {
        const event = str(p.event, "event", 30), text = str(p.text, "text", 500);
        if (!event && !text) throw new Error(`action ${i + 1}: choose a message or write one`);
        if (event && !(CUSTOMER_EVENTS as readonly string[]).includes(event)) throw new Error(`action ${i + 1}: unknown customer message`);
        if (event) out.event = event;
        if (text) out.text = text;
        break;
      }
      case "notify_driver": out.text = str(p.text, "text", 300, true); break;
      case "create_alert": {
        const sev = String(p.severity ?? "warn");
        if (!["info", "warn", "critical"].includes(sev)) throw new Error(`action ${i + 1}: severity must be info, warn or critical`);
        out.severity = sev; out.title = str(p.title, "title", 160, true);
        break;
      }
      case "set_job": {
        if (p.priority != null && p.priority !== "") { if (!PRIORITIES.includes(String(p.priority))) throw new Error(`action ${i + 1}: unknown priority`); out.priority = p.priority; }
        const tag = str(p.addTag, "tag", 30);
        if (tag) out.addTag = tag;
        if (!out.priority && !out.addTag) throw new Error(`action ${i + 1}: choose a priority or a tag to set`);
        break;
      }
      case "request_approval": out.title = str(p.title, "title", 160, true); out.kind = p.kind === "job" ? "job" : "custom"; break;
      case "create_invoice": case "replan_route": break;
    }
    return { type, params: out };
  });
}

export function validateWorkflow(body: { trigger?: unknown; match?: unknown; conditions?: unknown; actions?: unknown }): WorkflowSpec {
  const trigger = validateTrigger(body.trigger);
  const match = body.match === "any" ? "any" : "all";
  const conditions = validateConditions(body.conditions);
  const actions = validateActions(body.actions);
  // Replanning and invoices only make sense when a job or route is involved.
  const subject = trigger.kind.split(".")[0];
  for (const a of actions) {
    if ((a.type === "create_invoice" || a.type === "notify_customer" || a.type === "set_job") && !["job", "driver"].includes(subject!) && trigger.kind !== "help.requested" && trigger.kind !== "message.received" && trigger.kind !== "order.received" && trigger.kind !== "feedback.received") {
      throw new Error(`"${a.type}" needs a trigger that involves a job`);
    }
    if (a.type === "replan_route" && !(trigger.kind === "route.stop_removed" || subject === "job")) throw new Error('"replan_route" needs a job or route trigger');
  }
  return { trigger, match, conditions, actions };
}

/** Read `a.b.c` from nested data. */
export function getPath(data: unknown, path: string): unknown {
  let cur: unknown = data;
  for (const part of path.split(".")) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function cmp(op: Op, actual: unknown, want: unknown): boolean {
  if (actual === undefined || actual === null) return op === "ne";
  const num = (x: unknown) => (typeof x === "number" ? x : typeof x === "string" && x.trim() !== "" ? Number(x) : NaN);
  switch (op) {
    case "eq": return Array.isArray(actual) ? actual.map(String).includes(String(want)) : String(actual).toLowerCase() === String(want).toLowerCase();
    case "ne": return Array.isArray(actual) ? !actual.map(String).includes(String(want)) : String(actual).toLowerCase() !== String(want).toLowerCase();
    case "gt": return num(actual) > num(want);
    case "gte": return num(actual) >= num(want);
    case "lt": return num(actual) < num(want);
    case "lte": return num(actual) <= num(want);
    case "contains": return Array.isArray(actual) ? actual.map((x) => String(x).toLowerCase()).includes(String(want).toLowerCase()) : String(actual).toLowerCase().includes(String(want).toLowerCase());
    case "in": return Array.isArray(want) && want.map((x) => String(x).toLowerCase()).includes(String(actual).toLowerCase());
  }
}

export function conditionsHold(conditions: readonly Condition[], match: "all" | "any", data: unknown): boolean {
  if (conditions.length === 0) return true;
  const results = conditions.map((c) => cmp(c.op, getPath(data, c.field), c.value));
  return match === "any" ? results.some(Boolean) : results.every(Boolean);
}

/** Fill {{job.title}}-style placeholders. Unknown ones become empty so a template never prints "undefined". */
export function render(template: string, data: unknown): string {
  return template.replace(/\{\{\s*([a-z][a-z0-9_.]*)\s*\}\}/gi, (_m, path: string) => {
    const v = getPath(data, path);
    if (v == null) return "";
    if (v instanceof Date) return v.toISOString();
    return Array.isArray(v) ? v.join(", ") : String(v);
  });
}
