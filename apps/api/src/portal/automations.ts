import { pg, withOrg } from "@routenorth/db";
import { maintenanceDue } from "@routenorth/shared";
import { PORTAL_EVALUATORS } from "../alerts/portal-rules.js";
import { emit } from "../automation/events.js";
import { addNotification } from "../business/notifications.js";
import { deliver, type Providers } from "../notify/notifier.js";
import { companyFormat } from "./common.js";
import { companyMoney } from "./finance.service.js";
import { shiftDay } from "./money-rules.js";
import { PortalPayoutsController, payoutStatement } from "./payouts.controller.js";
import { todayIn } from "./vehicles.service.js";

/**
 * The automations of the Owner Portal spec. Each one is a small, plain job that runs every minute for every company, does its work once
 * per thing (the table portal_automation_runs remembers what was done), and says what it did. Sending email or SMS needs an outside account;
 * without one the in-app part still happens and the email part waits until the account is set up.
 */
export interface AutomationField { key: string; label: string; type: "number" | "select" | "list"; unit?: string; min?: number; max?: number; options?: { value: string; label: string }[]; help?: string }
export interface AutomationDef {
  key: string; spec: number; name: string; description: string; defaultEnabled: boolean; builtIn?: boolean;
  settings: Record<string, unknown>; fields: AutomationField[];
  /** Plain words about what needs an outside account or is only partly done. */
  note?: string;
}

export const AUTOMATIONS: readonly AutomationDef[] = [
  { key: "block_on_expiry", spec: 1, name: "Block a driver or car from new jobs when a required document expires", builtIn: true, defaultEnabled: true, settings: {}, fields: [],
    description: "Always on. A driver with an expired licence or legal document, or a car with an expired legal document or an unsigned failed inspection, cannot be given a route, a job or a shift until it is fixed." },
  { key: "service_work_order", spec: 2, name: "Create a work order when a service is due", defaultEnabled: true, settings: { when: "due_soon" },
    fields: [{ key: "when", label: "Create the work order when the service is", type: "select", options: [{ value: "due_soon", label: "due soon (inside the warning window)" }, { value: "overdue", label: "overdue" }] }],
    description: "When a maintenance plan reaches its due date or distance, a work order is opened for that car (one per plan). It shows up on the car's page and on Work orders." },
  { key: "driver_doc_reminder", spec: 3, name: "Remind the driver before a document expires", defaultEnabled: true, settings: { daysBefore: 14 },
    fields: [{ key: "daysBefore", label: "Remind the driver this many days before", type: "number", unit: "days", min: 1, max: 90 }],
    description: "Each driver gets one reminder, in the app and by email, when a licence or document is this many days from its end date.",
    note: "The email part needs an email account (RESEND_API_KEY and EMAIL_FROM). The in-app reminder always goes." },
  { key: "payout_run_on_payday", spec: 4, name: "Start the payout run on pay day and send it for approval", defaultEnabled: false, settings: { cycle: "weekly", payWeekday: 5, payMonthDay: 1, hour: 6 },
    fields: [
      { key: "cycle", label: "How often drivers are paid", type: "select", options: [{ value: "weekly", label: "Every week" }, { value: "biweekly", label: "Every two weeks" }, { value: "monthly", label: "Every month" }] },
      { key: "payWeekday", label: "Pay day (weekly)", type: "select", options: ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((l, i) => ({ value: String(i), label: l })) },
      { key: "payMonthDay", label: "Pay day (monthly)", type: "number", unit: "of the month", min: 1, max: 28 },
      { key: "hour", label: "Start at", type: "number", unit: "o'clock, company time", min: 0, max: 23 },
    ],
    description: "On pay day a draft payout run is made for the days since the last one and the owner and accountant are told it is waiting. Nothing is approved or paid without a person. Off until you switch it on.",
    note: "A run covers the days before pay day. Every-two-weeks uses the even weeks of the year." },
  { key: "payout_paid_statement", spec: 5, name: "Send the driver their statement when a payout is paid", defaultEnabled: true, settings: {}, fields: [],
    description: "When a payout is marked paid the driver gets a message in the app (always) and an email with the totals and a link to the full statement.",
    note: "The email has the totals and a link, not a PDF. It needs an email account." },
  { key: "weekly_summary", spec: 6, name: "Email a weekly summary to the owner every Monday morning", defaultEnabled: true, settings: { hour: 7 },
    fields: [{ key: "hour", label: "Send at", type: "number", unit: "o'clock, company time", min: 0, max: 23 }],
    description: "Last week against the week before: revenue, costs, profit and trips, plus what is open (alerts, payouts to approve, late invoices). It also appears in the owner's notifications.",
    note: "The email needs an email account. The notification in the app always goes." },
  { key: "flag_odd_pay", spec: 7, name: "Flag a trip for review when its pay is far from normal", defaultEnabled: true, settings: {}, fields: [],
    description: "A trip whose driver pay is far from the usual for its route gets a flag on the Trips page until someone marks it reviewed. The distance from normal is set by the \"Trip pay far from the usual\" alert rule." },
  { key: "invoice_reminder", spec: 8, name: "Remind the customer when an invoice is late", defaultEnabled: true, settings: { afterDays: [1, 7, 14] },
    fields: [{ key: "afterDays", label: "Remind after this many days late", type: "list", unit: "days", min: 1, max: 120, help: "For example 1, 7, 14" }],
    description: "A late invoice sends the customer one reminder email at each step, and tells the owner in the app each time.",
    note: "The customer email needs an email account. Without one, the owner is told in the app to remind them." },
  { key: "webhooks", spec: 9, name: "Call another tool's web address on any event", defaultEnabled: true, builtIn: true, settings: {}, fields: [],
    description: "Add a webhook under Settings, Alerts, Webhooks. Pick events such as an alert being raised, a payout being paid or a trip being flagged. Every call is signed and retried if it fails." },
];
export const AUTOMATION_BY_KEY = new Map(AUTOMATIONS.map((a) => [a.key, a]));

export interface AutomationState { enabled: boolean; settings: Record<string, unknown> }
export async function loadAutomationState(c: pg.PoolClient): Promise<Record<string, AutomationState>> {
  const saved = ((await c.query<{ data: { automations?: Record<string, Record<string, unknown>> } }>("SELECT data FROM portal_settings LIMIT 1")).rows[0]?.data.automations) ?? {};
  const out: Record<string, AutomationState> = {};
  for (const a of AUTOMATIONS) {
    const own = saved[a.key] ?? {};
    const { enabled, ...rest } = own;
    out[a.key] = { enabled: a.builtIn ? true : typeof enabled === "boolean" ? enabled : a.defaultEnabled, settings: { ...a.settings, ...rest } };
  }
  return out;
}
export async function saveAutomationState(c: pg.PoolClient, orgId: string, key: string, patch: { enabled?: boolean; settings?: Record<string, unknown> }, by: string | null): Promise<void> {
  const row = (await c.query<{ data: Record<string, unknown> }>("SELECT data FROM portal_settings WHERE org_id = $1 FOR UPDATE", [orgId])).rows[0];
  const data = { ...(row?.data ?? {}) } as { automations?: Record<string, Record<string, unknown>> };
  const autos = { ...(data.automations ?? {}) };
  autos[key] = { ...(autos[key] ?? {}), ...(patch.settings ?? {}), ...(patch.enabled === undefined ? {} : { enabled: patch.enabled }) };
  data.automations = autos;
  await c.query(`INSERT INTO portal_settings (org_id, data, updated_by, updated_at) VALUES ($1,$2,$3,now()) ON CONFLICT (org_id) DO UPDATE SET data = $2, updated_by = $3, updated_at = now()`, [orgId, JSON.stringify(data), by]);
}

export interface RunResult { automation: string; subject: string; status: "ok" | "skipped" | "failed"; message: string }
interface Cx { pool: pg.Pool; c: pg.PoolClient; orgId: string; notify: Providers; now: Date; tz: string; today: string; st: Record<string, unknown>; force: boolean }

const WEB = () => process.env.PUBLIC_WEB_URL ?? "http://localhost:3000";
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-CA", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const localHour = (d: Date, tz: string) => Number(new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hour12: false }).format(d)) % 24;
const dow = (day: string) => new Date(`${day}T12:00:00Z`).getUTCDay();
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

async function seen(c: pg.PoolClient, automation: string, subject: string): Promise<boolean> {
  return (await c.query("SELECT 1 FROM portal_automation_runs WHERE automation = $1 AND subject = $2", [automation, subject])).rowCount! > 0;
}
async function record(cx: Cx, automation: string, subject: string, status: RunResult["status"], message: string, detail: Record<string, unknown> = {}): Promise<RunResult> {
  await cx.c.query(`INSERT INTO portal_automation_runs (org_id, automation, subject, status, detail) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (org_id, automation, subject) DO NOTHING`, [cx.orgId, automation, subject, status, JSON.stringify({ message, ...detail })]);
  return { automation, subject, status, message };
}
/** Try to email. `unconfigured` means the server has no email account, so the caller should try again later. */
async function mail(cx: Cx, to: string, subject: string, text: string, link?: string): Promise<"sent" | "unconfigured" | "failed"> {
  const r = await deliver({ id: "auto", kind: "email", target: to, label: to }, { subject, text, link }, cx.notify);
  return r.ok ? "sent" : r.unconfigured ? "unconfigured" : "failed";
}
const owners = async (c: pg.PoolClient, roles = ["owner"]) => (await c.query<{ id: string; name: string; email: string }>(`SELECT id, coalesce(display_name, email) AS name, email FROM users WHERE disabled_at IS NULL AND role = ANY($1::text[])`, [roles])).rows;

// ---- 2. work order when a service is due ------------------------------------------------------------------------------------------------
async function serviceWorkOrder(cx: Cx): Promise<RunResult[]> {
  const out: RunResult[] = [];
  const overdueOnly = cx.st.when === "overdue";
  const plans = (await cx.c.query(
    `SELECT p.id, p.vehicle_id AS "vehicleId", v.name AS vehicle, p.task, p.every_days AS "everyDays", p.every_km AS "everyKm", p.last_done_on::text AS "lastDoneOn", p.last_done_km AS "lastDoneKm",
            greatest(v.odometer_km, coalesce((SELECT max(po.odometer) / 1000 FROM latest_positions lp JOIN devices d ON d.id = lp.device_id JOIN positions po ON po.device_id = d.id AND po.time = lp.time WHERE d.vehicle_id = v.id), 0)) AS odo
     FROM maintenance_plans p JOIN vehicles v ON v.id = p.vehicle_id WHERE p.archived_at IS NULL AND v.archived_at IS NULL AND v.status NOT IN ('sold','retired')`)).rows;
  for (const pl of plans) {
    const due = maintenanceDue(pl, cx.today, Number(pl.odo));
    if (due.state === "overdue" || (!overdueOnly && due.state === "due_soon")) {
      const subject = `plan:${pl.id}:${pl.lastDoneOn ?? "never"}`;
      if (await seen(cx.c, "service_work_order", subject)) continue;
      if ((await cx.c.query(`SELECT 1 FROM work_orders WHERE plan_id = $1 AND status NOT IN ('closed','cancelled') AND archived_at IS NULL`, [pl.id])).rowCount) { out.push(await record(cx, "service_work_order", subject, "skipped", `${pl.vehicle}: a work order for ${pl.task} is already open`)); continue; }
      const wo = (await cx.c.query(
        `INSERT INTO work_orders (org_id, vehicle_id, plan_id, title, description, source, due_on) VALUES ($1,$2,$3,$4,$5,'automation',$6) RETURNING id`,
        [cx.orgId, pl.vehicleId, pl.id, `${pl.task} for ${pl.vehicle}`.slice(0, 200), `Opened automatically because the "${pl.task}" service ${due.state === "overdue" ? "is overdue" : "is due soon"}.`, due.dueOn ?? null])).rows[0];
      await emit(cx.c, cx.orgId, "work_order.created", "work_order", wo.id, { vehicleId: pl.vehicleId, task: pl.task, source: "automation" });
      for (const u of await owners(cx.c, ["owner", "admin", "manager"])) await addNotification(cx.c, cx.orgId, u.id, "task", `Work order opened: ${pl.task} for ${pl.vehicle}`, `/owner/vehicles/${pl.vehicleId}`);
      out.push(await record(cx, "service_work_order", subject, "ok", `Opened a work order for ${pl.task} on ${pl.vehicle}`, { workOrderId: wo.id }));
    }
  }
  return out;
}

// ---- 3. driver reminder before a document expires ---------------------------------------------------------------------------------------
async function driverDocReminder(cx: Cx): Promise<RunResult[]> {
  const out: RunResult[] = [];
  const n = Math.max(1, Math.min(90, Number(cx.st.daysBefore) || 14));
  const rows = (await cx.c.query(
    `SELECT 'doc:' || d.id AS ref, d.kind AS what, d.expires_on::text AS "expiresOn", u.id AS uid, coalesce(u.display_name, u.email) AS name, u.email
       FROM documents d JOIN users u ON u.id = d.owner_id AND d.owner_kind = 'driver' WHERE d.archived_at IS NULL AND u.disabled_at IS NULL AND d.expires_on BETWEEN $1::date AND $1::date + $2::int
     UNION ALL
     SELECT 'lic:' || u.id, 'driver''s licence', dp.license_expiry::text, u.id, coalesce(u.display_name, u.email), u.email FROM driver_profiles dp JOIN users u ON u.id = dp.user_id
       WHERE u.disabled_at IS NULL AND dp.archived_at IS NULL AND dp.license_expiry BETWEEN $1::date AND $1::date + $2::int`, [cx.today, n])).rows;
  for (const r of rows) {
    const subject = `${r.ref}:${r.expiresOn}`;
    if (await seen(cx.c, "driver_doc_reminder", subject)) continue;
    const left = daysBetween(cx.today, r.expiresOn);
    const text = `Your ${r.what} ${left === 0 ? "expires today" : `expires in ${left} day${left === 1 ? "" : "s"}`} (${r.expiresOn}). Please upload the new one in the app so you can keep getting jobs.`;
    await addNotification(cx.c, cx.orgId, r.uid, "task", text, "/driver");
    const sent = await mail(cx, r.email, "Your document is about to expire", `Hi ${r.name},\n\n${text}`, `${WEB()}/driver`);
    await emit(cx.c, cx.orgId, "document.expiring", "driver", r.uid, { document: r.what, expiresOn: r.expiresOn, daysLeft: left });
    out.push(await record(cx, "driver_doc_reminder", subject, "ok", `Reminded ${r.name}: ${r.what} ${left === 0 ? "expires today" : `expires in ${left} days`}`, { email: sent }));
  }
  return out;
}

// ---- 4. start the payout run on pay day ---------------------------------------------------------------------------------------------------
async function paydayRun(cx: Cx): Promise<RunResult[]> {
  const s = cx.st as { cycle?: string; payWeekday?: number; payMonthDay?: number; hour?: number };
  const cycle = s.cycle === "monthly" || s.cycle === "biweekly" ? s.cycle : "weekly";
  if (!cx.force && localHour(cx.now, cx.tz) < (Number(s.hour) || 0)) return [];
  const weekdayHit = dow(cx.today) === Number(s.payWeekday ?? 5);
  const isPayDay = cycle === "monthly" ? Number(cx.today.slice(8)) === Number(s.payMonthDay ?? 1) : cycle === "weekly" ? weekdayHit : weekdayHit && Math.floor(Date.parse(`${cx.today}T00:00:00Z`) / (7 * 86_400_000)) % 2 === 0;
  if (!isPayDay && !cx.force) return [];
  const to = shiftDay(cx.today, -1);
  let from: string;
  if (cycle === "monthly") { const d = new Date(`${to}T00:00:00Z`); d.setUTCMonth(d.getUTCMonth() - 1); d.setUTCDate(d.getUTCDate() + 1); from = d.toISOString().slice(0, 10); } else from = shiftDay(to, cycle === "weekly" ? -6 : -13);
  const subject = `run:${from}:${to}`;
  if (await seen(cx.c, "payout_run_on_payday", subject)) return [];
  await cx.c.query("SAVEPOINT payrun");
  let made: Awaited<ReturnType<PortalPayoutsController["startRun"]>>;
  try { made = await new PortalPayoutsController(cx.pool).startRun(cx.c, cx.orgId, null, cycle, from, to); await cx.c.query("RELEASE SAVEPOINT payrun"); }
  catch (e) { await cx.c.query("ROLLBACK TO SAVEPOINT payrun"); return [await record(cx, "payout_run_on_payday", subject, "failed", `Could not start the run for ${from} to ${to}: ${(e as Error).message}`)]; }
  if (!made) return [await record(cx, "payout_run_on_payday", subject, "skipped", `Nothing to pay for ${from} to ${to}, or a draft run for those days already exists`)];
  const text = `Pay day: a draft payout run for ${from} to ${to} is ready. ${made.payouts} driver${made.payouts === 1 ? "" : "s"}, ${money(made.netCents)} in total. It waits for your approval; nothing is paid until you approve it.`;
  const approvers = await owners(cx.c, ["owner", "accountant"]);
  let mailed = 0;
  for (const u of approvers) { await addNotification(cx.c, cx.orgId, u.id, "approval", text.slice(0, 200), `/owner/pay-rates/runs/${made.id}`); if ((await mail(cx, u.email, "Payout run waiting for your approval", text, `${WEB()}/owner/pay-rates/runs/${made.id}`)) === "sent") mailed++; }
  return [await record(cx, "payout_run_on_payday", subject, "ok", `Started the payout run for ${from} to ${to} (${made.payouts} drivers, ${money(made.netCents)}) and sent it for approval`, { runId: made.id, told: approvers.length, emailed: mailed })];
}

// ---- 5. statement to the driver when a payout is paid -------------------------------------------------------------------------------------
async function paidStatement(cx: Cx): Promise<RunResult[]> {
  const out: RunResult[] = [];
  const rows = (await cx.c.query(`SELECT p.id, p.driver_id AS uid, u.email, coalesce(u.display_name, u.email) AS name FROM portal_payouts p JOIN users u ON u.id = p.driver_id WHERE p.status = 'paid' AND p.paid_at > now() - interval '14 days'`)).rows;
  for (const r of rows) {
    const subject = `payout:${r.id}`;
    if (await seen(cx.c, "payout_paid_statement", subject)) continue;
    const st = await payoutStatement(cx.c, r.id);
    const p = st.payout as { from: string; to: string; trips: number; earningsCents: number; bonusCents: number; tipsCents: number; deductionCents: number; netCents: number };
    const lines = [`Hi ${r.name},`, "", `Your pay for ${p.from} to ${p.to} has been paid.`, "",
      `Trips: ${p.trips}`, `Earnings: ${money(p.earningsCents)}`, ...(p.bonusCents ? [`Bonuses: ${money(p.bonusCents)}`] : []), ...(p.tipsCents ? [`Tips: ${money(p.tipsCents)}`] : []),
      ...st.deductions.map((d) => `Deduction: ${d.label}${d.reason ? ` (${d.reason})` : ""}: ${money(d.cents)}`), `Paid to you: ${money(p.netCents)}`, "",
      "Every trip, the rate used and each deduction is in your statement in the app. If something looks wrong, use \"This looks wrong\" there."];
    const sent = await mail(cx, r.email, `Your pay statement for ${p.from} to ${p.to}`, lines.join("\n"), `${WEB()}/driver/pay`);
    // Try again later when there is no email account, so the statement still goes once one is set up.
    if (sent === "unconfigured") { out.push({ automation: "payout_paid_statement", subject, status: "skipped", message: `${r.name}: the statement email waits for an email account (the app message was sent when the payout was marked paid)` }); continue; }
    out.push(await record(cx, "payout_paid_statement", subject, sent === "sent" ? "ok" : "failed", sent === "sent" ? `Emailed ${r.name} their statement for ${p.from} to ${p.to}` : `Could not email ${r.name}`, { email: sent }));
  }
  return out;
}

// ---- 6. weekly summary on Monday morning -------------------------------------------------------------------------------------------------
async function weeklySummary(cx: Cx): Promise<RunResult[]> {
  if (dow(cx.today) !== 1 && !cx.force) return [];
  if (!cx.force && localHour(cx.now, cx.tz) < (Number(cx.st.hour) || 0)) return [];
  const monday = dow(cx.today) === 1 ? cx.today : shiftDay(cx.today, -((dow(cx.today) + 6) % 7));
  const cur = { from: shiftDay(monday, -7), to: shiftDay(monday, -1) }, prev = { from: shiftDay(monday, -14), to: shiftDay(monday, -8) };
  const now = await companyMoney(cx.c, cur, cx.tz), before = await companyMoney(cx.c, prev, cx.tz);
  const open = (await cx.c.query(`SELECT count(*) FILTER (WHERE severity = 'critical')::int AS critical, count(*)::int AS n FROM alerts WHERE status <> 'resolved'`)).rows[0];
  const waiting = (await cx.c.query(`SELECT count(*)::int AS n FROM portal_payouts WHERE status = 'draft'`)).rows[0].n;
  const late = (await cx.c.query(`SELECT count(*)::int AS n FROM invoices WHERE status = 'sent' AND due_on < $1::date`, [cx.today])).rows[0].n;
  const change = (a: number, b: number) => (b ? ` (${a >= b ? "up" : "down"} ${Math.abs(Math.round(((a - b) / Math.abs(b)) * 100))}% on the week before)` : "");
  const lines = [`Your week, ${cur.from} to ${cur.to}`, "",
    `Revenue: ${money(now.revenueCents)}${change(now.revenueCents, before.revenueCents)}`, `Costs: ${money(now.costCents)}${change(now.costCents, before.costCents)}`,
    `Profit: ${money(now.profitCents)}${change(now.profitCents, before.profitCents)}`, `Trips: ${now.trips}${change(now.trips, before.trips)}`, "",
    `Open alerts: ${open.n}${open.critical ? ` (${open.critical} critical)` : ""}`, `Payouts waiting for approval: ${waiting}`, `Late invoices: ${late}`];
  const out: RunResult[] = [];
  for (const u of await owners(cx.c)) {
    const subject = `week:${monday}:${u.id}`;
    if (await seen(cx.c, "weekly_summary", subject)) continue;
    await addNotification(cx.c, cx.orgId, u.id, "system", `Last week: ${money(now.revenueCents)} in, profit ${money(now.profitCents)}, ${open.n} open alert${open.n === 1 ? "" : "s"}.`, "/owner");
    const sent = await mail(cx, u.email, `Your RouteNorth week: profit ${money(now.profitCents)}`, lines.join("\n"), `${WEB()}/owner`);
    out.push(await record(cx, "weekly_summary", subject, "ok", `Weekly summary for ${u.name}`, { email: sent }));
  }
  return out;
}

// ---- 7. flag a trip whose pay is far from normal ------------------------------------------------------------------------------------------
async function flagOddPay(cx: Cx): Promise<RunResult[]> {
  const out: RunResult[] = [];
  const rule = (await cx.c.query(`SELECT params FROM alert_rules WHERE system_key = 'pay_odd'`)).rows[0];
  const found = await PORTAL_EVALUATORS.trip_pay_off!.run(cx.c, rule?.params ?? { pct: 40, minTrips: 5 }, { orgId: cx.orgId, today: cx.today, tz: cx.tz, svc: undefined as never, now: cx.now });
  for (const f of found) {
    const id = String(f.detail.tripId);
    const flagged = await cx.c.query(`UPDATE portal_trips SET review_flag = $2, flagged_at = now() WHERE id = $1 AND review_flag IS NULL AND reviewed_at IS NULL RETURNING id`, [id, f.title.slice(0, 300)]);
    if (!flagged.rowCount) continue;
    await emit(cx.c, cx.orgId, "trip.flagged", "trip", id, { reason: f.title });
    out.push(await record(cx, "flag_odd_pay", `trip:${id}`, "ok", `Flagged a trip for review: ${f.title}`));
  }
  return out;
}

// ---- 8. invoice reminder when a customer is late ------------------------------------------------------------------------------------------
async function invoiceReminder(cx: Cx): Promise<RunResult[]> {
  const out: RunResult[] = [];
  const steps = (Array.isArray(cx.st.afterDays) ? cx.st.afterDays : [1, 7, 14]).map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 120).sort((a, b) => a - b);
  if (!steps.length) return out;
  const rows = (await cx.c.query(
    `SELECT id, number, customer_name AS customer, customer_email AS email, due_on::text AS due, round(total * 100)::float8 AS cents, currency FROM invoices WHERE status = 'sent' AND due_on IS NOT NULL AND due_on < $1::date`, [cx.today])).rows;
  for (const inv of rows) {
    const late = daysBetween(inv.due, cx.today);
    const step = [...steps].reverse().find((s) => s <= late);
    if (!step) continue;
    const note = `invoice:${inv.id}:${step}:owner`, mailKey = `invoice:${inv.id}:${step}:customer`;
    if (!(await seen(cx.c, "invoice_reminder", note))) {
      const text = `Invoice ${inv.number}${inv.customer ? ` for ${inv.customer}` : ""} (${money(inv.cents)}) is ${late} day${late === 1 ? "" : "s"} late. ${inv.email ? "A reminder email goes to the customer." : "There is no customer email on it, so please remind them yourself."}`;
      for (const u of await owners(cx.c, ["owner", "accountant"])) await addNotification(cx.c, cx.orgId, u.id, "task", text.slice(0, 200), "/owner/finance/invoices");
      await emit(cx.c, cx.orgId, "invoice.overdue", "invoice", inv.id, { number: inv.number, daysLate: late, totalCents: inv.cents });
      out.push(await record(cx, "invoice_reminder", note, "ok", text));
    }
    if (inv.email && !(await seen(cx.c, "invoice_reminder", mailKey))) {
      const text = `Hello,\n\nThis is a friendly reminder that invoice ${inv.number} for ${money(inv.cents)} ${inv.currency} was due on ${inv.due}. If you have already paid, thank you and please ignore this message.\n\nIf you have a question about it, just reply to this email.`;
      const sent = await mail(cx, inv.email, `Reminder: invoice ${inv.number} is overdue`, text);
      if (sent === "unconfigured") { out.push({ automation: "invoice_reminder", subject: mailKey, status: "skipped", message: `Invoice ${inv.number}: the customer email waits for an email account` }); continue; }
      out.push(await record(cx, "invoice_reminder", mailKey, sent === "sent" ? "ok" : "failed", sent === "sent" ? `Emailed a reminder for invoice ${inv.number} to ${inv.email}` : `Could not email ${inv.email}`));
    }
  }
  return out;
}

const RUNNERS: Record<string, (cx: Cx) => Promise<RunResult[]>> = {
  service_work_order: serviceWorkOrder, driver_doc_reminder: driverDocReminder, payout_run_on_payday: paydayRun, payout_paid_statement: paidStatement,
  weekly_summary: weeklySummary, flag_odd_pay: flagOddPay, invoice_reminder: invoiceReminder,
};

/** Run the switched-on automations for one company. `only` runs a single one right now, even if it is not its time ("Run now"). */
export async function runAutomations(pool: pg.Pool, notify: Providers, orgId: string, now = new Date(), only?: string): Promise<RunResult[]> {
  const meta = await withOrg(pool, orgId, async (c) => {
    const f = await companyFormat(c);
    return { tz: f.timezone, today: todayIn(f.timezone, now), state: await loadAutomationState(c) };
  });
  const out: RunResult[] = [];
  for (const [key, run] of Object.entries(RUNNERS)) {
    if (only && only !== key) continue;
    const s = meta.state[key]!;
    if (!s.enabled) continue;
    try {
      const r = await withOrg(pool, orgId, (c) => run({ pool, c, orgId, notify, now, tz: meta.tz, today: meta.today, st: s.settings, force: !!only }));
      out.push(...r);
    } catch (e) {
      out.push({ automation: key, subject: "-", status: "failed", message: (e as Error).message });
      console.error(`automation ${key}:`, (e as Error).message);
    }
  }
  return out;
}
