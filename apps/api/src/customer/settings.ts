import { withDefaults, type OrgSettings } from "../org/settings.js";
import { CUSTOMER_EVENTS } from "../automation/spec.js";

/** Customer-facing options, read from the organization's settings with sensible defaults. */
export interface CustomerOptions {
  notify: { enabled: boolean; minutesAway: number; stopsAway: number; events: Record<string, boolean> };
  portal: {
    showDriver: boolean; allowReschedule: boolean; allowCancel: boolean; allowInstructions: boolean; allowReturns: boolean;
    /** Customers can change or cancel until this many minutes before the delivery window starts. */
    cutoffMin: number; horizonDays: number; slotCapacity: number;
    slots: { label: string; start: string; end: string }[];
  };
  booking: { enabled: boolean; baseFee: number; perKm: number; perKg: number; rushPct: number; minimum: number; requirePhone: boolean };
  publicStatus: boolean;
}

export const DEFAULT_SLOTS = [
  { label: "Morning", start: "08:00", end: "12:00" },
  { label: "Afternoon", start: "12:00", end: "16:00" },
  { label: "Evening", start: "16:00", end: "20:00" },
];

export function customerOptions(raw: unknown): CustomerOptions {
  const s = withDefaults(raw) as OrgSettings & Record<string, any>;
  const n = s.customerNotify ?? {}, p = s.customerPortal ?? {}, b = s.booking ?? {};
  const events: Record<string, boolean> = {};
  for (const e of CUSTOMER_EVENTS) events[e] = n.events?.[e] ?? e !== "stops_away";
  return {
    notify: { enabled: n.enabled !== false, minutesAway: Number(n.minutesAway) || 10, stopsAway: Number(n.stopsAway) || 3, events },
    portal: {
      showDriver: p.showDriver === true, allowReschedule: p.allowReschedule !== false, allowCancel: p.allowCancel !== false, allowInstructions: p.allowInstructions !== false,
      allowReturns: p.allowReturns !== false, cutoffMin: Number.isFinite(Number(p.cutoffMin)) ? Number(p.cutoffMin) : 60, horizonDays: Number(p.horizonDays) || 14,
      slotCapacity: Number(p.slotCapacity) || 20, slots: Array.isArray(p.slots) && p.slots.length ? p.slots : DEFAULT_SLOTS,
    },
    booking: { enabled: b.enabled === true, baseFee: Number(b.baseFee ?? 15), perKm: Number(b.perKm ?? 1.2), perKg: Number(b.perKg ?? 0.05), rushPct: Number(b.rushPct ?? 50), minimum: Number(b.minimum ?? 20), requirePhone: b.requirePhone === true },
    publicStatus: s.publicStatus !== false,
  };
}

/** Validates the customer-facing part of a settings update. */
export function parseCustomerSettings(b: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const obj = (k: string) => { const v = b[k]; if (v === undefined) return null; if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error(`${k} must be an object`); return v as Record<string, unknown>; };
  const num = (o: Record<string, unknown>, k: string, lo: number, hi: number) => { if (o[k] === undefined) return undefined; const v = Number(o[k]); if (!Number.isFinite(v) || v < lo || v > hi) throw new Error(`${k} must be between ${lo} and ${hi}`); return v; };
  const bool = (o: Record<string, unknown>, k: string) => (o[k] === undefined ? undefined : Boolean(o[k]));
  const keep = (o: Record<string, unknown>, spec: Record<string, unknown>) => Object.fromEntries(Object.entries({ ...spec }).filter(([, v]) => v !== undefined));
  const cn = obj("customerNotify");
  if (cn) {
    const events: Record<string, boolean> = {};
    if (cn.events !== undefined) {
      if (!cn.events || typeof cn.events !== "object") throw new Error("events must be an object");
      for (const [k, v] of Object.entries(cn.events as Record<string, unknown>)) { if (!(CUSTOMER_EVENTS as readonly string[]).includes(k)) throw new Error(`unknown customer message "${k}"`); events[k] = Boolean(v); }
    }
    out.customerNotify = keep(cn, { enabled: bool(cn, "enabled"), minutesAway: num(cn, "minutesAway", 2, 120), stopsAway: num(cn, "stopsAway", 1, 20), ...(cn.events !== undefined ? { events } : {}) });
  }
  const cp = obj("customerPortal");
  if (cp) {
    let slots: unknown;
    if (cp.slots !== undefined) {
      const hhmm = /^([01]\d|2[0-3]):[0-5]\d$/;
      if (!Array.isArray(cp.slots) || cp.slots.length < 1 || cp.slots.length > 8) throw new Error("slots must be a list of 1 to 8 time windows");
      slots = cp.slots.map((s) => {
        const o = s as Record<string, unknown>;
        if (typeof o?.label !== "string" || !o.label.trim() || o.label.length > 40 || !hhmm.test(String(o.start)) || !hhmm.test(String(o.end)) || String(o.end) <= String(o.start)) throw new Error("each slot needs a label, a start and a later end (HH:MM)");
        return { label: o.label.trim(), start: o.start, end: o.end };
      });
    }
    out.customerPortal = keep(cp, {
      showDriver: bool(cp, "showDriver"), allowReschedule: bool(cp, "allowReschedule"), allowCancel: bool(cp, "allowCancel"), allowInstructions: bool(cp, "allowInstructions"), allowReturns: bool(cp, "allowReturns"),
      cutoffMin: num(cp, "cutoffMin", 0, 10080), horizonDays: num(cp, "horizonDays", 1, 60), slotCapacity: num(cp, "slotCapacity", 1, 1000), ...(slots ? { slots } : {}),
    });
  }
  const bk = obj("booking");
  if (bk) out.booking = keep(bk, { enabled: bool(bk, "enabled"), baseFee: num(bk, "baseFee", 0, 10000), perKm: num(bk, "perKm", 0, 1000), perKg: num(bk, "perKg", 0, 1000), rushPct: num(bk, "rushPct", 0, 500), minimum: num(bk, "minimum", 0, 10000), requirePhone: bool(bk, "requirePhone") });
  if (b.publicStatus !== undefined) out.publicStatus = Boolean(b.publicStatus);
  const ap = obj("approvals");
  if (ap) out.approvals = keep(ap, { expenseLimit: num(ap, "expenseLimit", 0, 100000), overtimeNeedsApproval: bool(ap, "overtimeNeedsApproval") });
  return out;
}
