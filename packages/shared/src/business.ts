/**
 * Business rules shared by the API and the web app: Canadian sales tax, plans and usage, rate cards, driver pay,
 * budgets, contract targets, schedule conflicts and @mentions. Everything here is a pure function, so it is easy to test.
 */

export const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

// ---------------------------------------------------------------- tax

export const PROVINCES = ["AB", "BC", "MB", "NB", "NL", "NS", "NT", "NU", "ON", "PE", "QC", "SK", "YT"] as const;
export type Province = (typeof PROVINCES)[number];

/** Default sales tax by province, in percent. These are the usual rates; the business should confirm them with the CRA or Revenu Québec. */
export const CA_TAX: Record<Province, { gst?: number; hst?: number; pst?: number; qst?: number }> = {
  AB: { gst: 5 }, BC: { gst: 5, pst: 7 }, MB: { gst: 5, pst: 7 }, NB: { hst: 15 }, NL: { hst: 15 }, NS: { hst: 14 },
  NT: { gst: 5 }, NU: { gst: 5 }, ON: { hst: 13 }, PE: { hst: 15 }, QC: { gst: 5, qst: 9.975 }, SK: { gst: 5, pst: 6 }, YT: { gst: 5 },
};

export interface TaxLine { code: "GST" | "HST" | "PST" | "QST" | "TAX"; rate: number; amount: number }

/** Tax on a subtotal. "province" uses the table above; "custom" uses one flat rate chosen by the business. */
export function taxFor(province: string, subtotal: number, o: { mode?: string; customRatePct?: number } = {}): { lines: TaxLine[]; total: number } {
  const sub = Math.max(0, subtotal);
  let lines: TaxLine[];
  if (o.mode === "custom") {
    lines = [{ code: "TAX", rate: o.customRatePct ?? 0, amount: round2((sub * (o.customRatePct ?? 0)) / 100) }];
  } else {
    const r = CA_TAX[(PROVINCES as readonly string[]).includes(province) ? (province as Province) : "ON"];
    lines = [];
    if (r.gst) lines.push({ code: "GST", rate: r.gst, amount: round2((sub * r.gst) / 100) });
    if (r.hst) lines.push({ code: "HST", rate: r.hst, amount: round2((sub * r.hst) / 100) });
    if (r.pst) lines.push({ code: "PST", rate: r.pst, amount: round2((sub * r.pst) / 100) });
    if (r.qst) lines.push({ code: "QST", rate: r.qst, amount: round2((sub * r.qst) / 100) });
  }
  return { lines, total: round2(lines.reduce((a, l) => a + l.amount, 0)) };
}

// ---------------------------------------------------------------- currency

/** "USD=1.37, EUR=1.47" → how many units of the home currency one unit of that currency is worth. */
export function parseFx(text: string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const part of String(text ?? "").split(/[,;\n]/)) {
    const m = /^\s*([A-Za-z]{3})\s*[=:]\s*(\d+(?:\.\d+)?)\s*$/.exec(part);
    if (m && Number(m[2]) > 0) out[m[1]!.toUpperCase()] = Number(m[2]);
  }
  return out;
}

/** An amount in `currency` as home currency. Returns null when there is no rate. */
export function toHome(amount: number, currency: string, home: string, rates: Record<string, number>): number | null {
  if (currency === home) return amount;
  const r = rates[currency];
  return r ? round2(amount * r) : null;
}

export const CURRENCIES = ["CAD", "USD", "EUR", "GBP", "MXN"] as const;

// ---------------------------------------------------------------- invoice and quote lines

export interface DocLine { description: string; qty: number; unitPrice: number; amount: number }

/** Check lines typed by a person and add up the amounts. Throws a plain message when something is wrong. */
export function buildLines(raw: unknown): { lines: DocLine[]; subtotal: number } {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("add at least one line");
  if (raw.length > 100) throw new Error("at most 100 lines");
  const lines = raw.map((l, i) => {
    const o = (l ?? {}) as Record<string, unknown>;
    const description = typeof o.description === "string" ? o.description.trim() : "";
    const qty = Number(o.qty ?? 1), unitPrice = Number(o.unitPrice);
    if (!description || description.length > 200) throw new Error(`line ${i + 1}: description is 1 to 200 characters`);
    if (!Number.isFinite(qty) || qty <= 0 || qty > 1_000_000) throw new Error(`line ${i + 1}: quantity must be above 0`);
    if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 10_000_000) throw new Error(`line ${i + 1}: price must be 0 or more`);
    return { description, qty, unitPrice: round2(unitPrice), amount: round2(qty * unitPrice) };
  });
  return { lines, subtotal: round2(lines.reduce((a, l) => a + l.amount, 0)) };
}

// ---------------------------------------------------------------- plans and usage

export type PlanId = "trial" | "starter" | "pro" | "enterprise";
export interface PlanDef { id: PlanId; vehicles: number | null; users: number | null; jobsPerMonth: number | null; perVehicleCad: number; baseCad: number }

/** Sample plans. The prices are placeholders for the business to set before selling anything. */
export const PLANS: Record<PlanId, PlanDef> = {
  trial: { id: "trial", vehicles: 25, users: 10, jobsPerMonth: 500, perVehicleCad: 0, baseCad: 0 },
  starter: { id: "starter", vehicles: 10, users: 5, jobsPerMonth: 300, perVehicleCad: 9, baseCad: 0 },
  pro: { id: "pro", vehicles: 100, users: 50, jobsPerMonth: 5000, perVehicleCad: 15, baseCad: 49 },
  enterprise: { id: "enterprise", vehicles: null, users: null, jobsPerMonth: null, perVehicleCad: 12, baseCad: 199 },
};
export const PLAN_IDS = Object.keys(PLANS) as PlanId[];

export interface UsageRow { metric: "vehicles" | "users" | "jobs"; used: number; limit: number | null; pct: number | null; state: "ok" | "warn" | "over" }

export function planUsage(plan: PlanId, used: { vehicles: number; users: number; jobs: number }): UsageRow[] {
  const p = PLANS[plan] ?? PLANS.trial;
  const row = (metric: UsageRow["metric"], u: number, limit: number | null): UsageRow => {
    const pct = limit ? Math.round((u / limit) * 100) : null;
    return { metric, used: u, limit, pct, state: limit == null ? "ok" : u > limit ? "over" : pct! >= 80 ? "warn" : "ok" };
  };
  return [row("vehicles", used.vehicles, p.vehicles), row("users", used.users, p.users), row("jobs", used.jobs, p.jobsPerMonth)];
}

/** What the plan would cost this month for the number of vehicles in use. */
export function monthlyEstimate(plan: PlanId, vehicles: number): number {
  const p = PLANS[plan] ?? PLANS.trial;
  return round2(p.baseCad + p.perVehicleCad * Math.max(0, vehicles));
}

export function trialDaysLeft(endsAt: string | Date | null, now = new Date()): number | null {
  if (!endsAt) return null;
  const ms = new Date(endsAt).getTime() - now.getTime();
  return Math.max(0, Math.ceil(ms / 86_400_000));
}

// ---------------------------------------------------------------- rate cards

export interface RateTier { upTo: number | null; rate: number }
export interface RateCardLike {
  basis: "distance" | "weight" | "zone" | "time";
  base: number; minimum: number;
  tiers: RateTier[];
  zones: { name: string; price: number }[];
}

/** Check the tiers and zones a person typed. Returns a message when something is wrong, or null. */
export function checkRateCard(c: Partial<RateCardLike>): string | null {
  if (c.basis === "zone") {
    if (!Array.isArray(c.zones) || c.zones.length === 0) return "a zone rate card needs at least one zone";
    for (const z of c.zones) if (!z || typeof z.name !== "string" || !z.name.trim() || !(Number(z.price) >= 0)) return "each zone needs a name and a price";
    return null;
  }
  if (!Array.isArray(c.tiers) || c.tiers.length === 0) return "add at least one rate band";
  let prev = 0;
  for (let i = 0; i < c.tiers.length; i++) {
    const t = c.tiers[i]!;
    if (!(Number(t.rate) >= 0)) return "each band needs a rate of 0 or more";
    if (t.upTo == null) { if (i !== c.tiers.length - 1) return "only the last band can be open ended"; }
    else if (!(Number(t.upTo) > prev)) return "bands must go up (each limit above the one before)";
    else prev = Number(t.upTo);
  }
  return null;
}

/** Price from a rate card. Bands are marginal: the first band covers the first units, the next band the units after that. */
export function priceFromRateCard(card: RateCardLike, q: { km?: number; kg?: number; minutes?: number; zone?: string }): { amount: number; parts: { label: string; amount: number }[] } {
  const parts: { label: string; amount: number }[] = [];
  if (card.base) parts.push({ label: "base", amount: round2(card.base) });
  if (card.basis === "zone") {
    const z = card.zones.find((x) => x.name.toLowerCase() === String(q.zone ?? "").toLowerCase());
    if (!z) throw new Error("unknown zone");
    parts.push({ label: z.name, amount: round2(z.price) });
  } else {
    const qty = Math.max(0, Number((card.basis === "distance" ? q.km : card.basis === "weight" ? q.kg : q.minutes) ?? 0));
    let from = 0;
    for (const t of card.tiers) {
      if (qty <= from) break;
      const to = t.upTo == null ? qty : Math.min(qty, t.upTo);
      const units = to - from;
      if (units > 0) parts.push({ label: t.upTo == null ? `${from}+` : `${from}-${t.upTo}`, amount: round2(units * t.rate) });
      from = t.upTo ?? qty;
    }
  }
  const sum = round2(parts.reduce((a, p) => a + p.amount, 0));
  const amount = round2(Math.max(card.minimum || 0, sum));
  if (amount > sum) parts.push({ label: "minimum", amount: round2(amount - sum) });
  return { amount, parts };
}

// ---------------------------------------------------------------- driver pay

export interface PayInput { regularHours: number; overtimeHours: number; stops: number; km: number; hourlyRate: number; payPerStop: number; payPerKm: number; overtimeMultiplier: number }
export interface PayResult { regular: number; overtime: number; perStop: number; perKm: number; gross: number }

export function computePay(i: PayInput): PayResult {
  const regular = round2(i.regularHours * i.hourlyRate);
  const overtime = round2(i.overtimeHours * i.hourlyRate * i.overtimeMultiplier);
  const perStop = round2(i.stops * i.payPerStop);
  const perKm = round2(i.km * i.payPerKm);
  return { regular, overtime, perStop, perKm, gross: round2(regular + overtime + perStop + perKm) };
}

// ---------------------------------------------------------------- budgets and contracts

export type BudgetState = "ok" | "warn" | "over";

export function budgetStatus(spent: number, amount: number, alertPct: number, elapsedFrac: number): { pct: number; projected: number; state: BudgetState } {
  const pct = amount > 0 ? Math.round((spent / amount) * 100) : 0;
  const projected = elapsedFrac > 0.05 ? round2(spent / Math.min(1, elapsedFrac)) : round2(spent);
  const state: BudgetState = spent > amount ? "over" : pct >= alertPct || projected > amount ? "warn" : "ok";
  return { pct, projected, state };
}

/** First day, last day (exclusive) and how much of the period has gone by. */
export function periodRange(period: "month" | "quarter" | "year", now = new Date()): { from: string; to: string; elapsedFrac: number } {
  const y = now.getUTCFullYear(), m = now.getUTCMonth();
  const startM = period === "month" ? m : period === "quarter" ? m - (m % 3) : 0;
  const len = period === "month" ? 1 : period === "quarter" ? 3 : 12;
  const from = new Date(Date.UTC(y, startM, 1)), to = new Date(Date.UTC(y, startM + len, 1));
  const elapsedFrac = Math.min(1, Math.max(0, (now.getTime() - from.getTime()) / (to.getTime() - from.getTime())));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return { from: iso(from), to: iso(to), elapsedFrac };
}

export type SlaState = "ok" | "at_risk" | "breached" | "no_data";

export function slaState(actualPct: number | null, targetPct: number): SlaState {
  if (actualPct == null) return "no_data";
  return actualPct >= targetPct ? "ok" : actualPct >= targetPct - 3 ? "at_risk" : "breached";
}

/** Whole days from today until `on` (negative when past). */
export function daysUntil(on: string, now = new Date()): number {
  const t = new Date(`${on}T00:00:00Z`).getTime(), n = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return Math.round((t - n) / 86_400_000);
}

// ---------------------------------------------------------------- schedule

export interface PlanLike { id: string; driverId: string; startsAt: string; endsAt: string }
export interface TimeOffLike { id: string; userId: string; startsOn: string; endsOn: string; status: string }
export interface Conflict { planId: string; kind: "overlap" | "time_off"; withId: string }

/** Planned shifts that overlap each other for one driver, or fall on days off. Rejected time off is ignored. */
export function planConflicts(plans: PlanLike[], off: TimeOffLike[]): Conflict[] {
  const out: Conflict[] = [];
  const list = [...plans].sort((a, b) => a.startsAt.localeCompare(b.startsAt));
  for (let i = 0; i < list.length; i++) {
    const a = list[i]!;
    for (let j = i + 1; j < list.length; j++) {
      const b = list[j]!;
      if (b.driverId !== a.driverId) continue;
      if (new Date(b.startsAt) >= new Date(a.endsAt)) break;
      out.push({ planId: a.id, kind: "overlap", withId: b.id }, { planId: b.id, kind: "overlap", withId: a.id });
    }
    for (const o of off) {
      if (o.userId !== a.driverId || o.status === "rejected") continue;
      const s = new Date(`${o.startsOn}T00:00:00`).getTime(), e = new Date(`${o.endsOn}T00:00:00`).getTime() + 86_400_000;
      if (new Date(a.startsAt).getTime() < e && new Date(a.endsAt).getTime() > s) out.push({ planId: a.id, kind: "time_off", withId: o.id });
    }
  }
  return out;
}

// ---------------------------------------------------------------- @mentions

export interface Person { id: string; email: string; name?: string | null }

/** The handle people type after "@": the part of their email before the "@", in lower case. */
export const handleOf = (p: Person) => p.email.split("@")[0]!.toLowerCase();

/** People named with @handle in a comment. Unknown handles are ignored. */
export function extractMentions(body: string, people: Person[]): string[] {
  const found = new Set<string>();
  for (const m of body.matchAll(/(^|[^\w@.])@([A-Za-z0-9][A-Za-z0-9._-]{0,63})/g)) {
    const h = m[2]!.toLowerCase().replace(/[._-]+$/, "");
    for (const p of people) if (handleOf(p) === h) found.add(p.id);
  }
  return [...found];
}

// ---------------------------------------------------------------- invites

export const INVITE_ROLES = ["admin", "dispatcher", "manager", "driver", "customer", "viewer"] as const;
