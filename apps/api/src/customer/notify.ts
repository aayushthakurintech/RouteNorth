import type { pg } from "@routenorth/db";
import { deliver, type Providers } from "../notify/notifier.js";
import type { CustomerEvent } from "../automation/spec.js";
import { ensureJobLink } from "./links.js";
import { customerOptions } from "./settings.js";
import { renderCustomerMessage, type Locale } from "./templates.js";

export interface CustomerDeps { providers: Providers; secret: string }
export interface Sent { channel: "email" | "sms"; status: "sent" | "failed" | "skipped"; error?: string }

const contactKey = (j: { customer_email: string | null; customer_phone: string | null }) => (j.customer_email ? j.customer_email.trim().toLowerCase() : (j.customer_phone ?? "").replace(/[^\d+]/g, ""));

/** "Tue, Nov 4, 8:00 a.m. to 12:00 p.m." in the organization's time zone and language. */
export function windowText(ws: Date | null, we: Date | null, date: string | null, tz: string, locale: Locale): string {
  const loc = locale === "fr" ? "fr-CA" : "en-CA";
  const day = (d: Date) => new Intl.DateTimeFormat(loc, { timeZone: tz, weekday: "short", month: "short", day: "numeric" }).format(d);
  const hm = (d: Date) => new Intl.DateTimeFormat(loc, { timeZone: tz, hour: "numeric", minute: "2-digit" }).format(d);
  if (ws && we) return locale === "fr" ? `le ${day(ws)}, de ${hm(ws)} à ${hm(we)}` : `on ${day(ws)}, ${hm(ws)} to ${hm(we)}`;
  if (ws) return locale === "fr" ? `le ${day(ws)} vers ${hm(ws)}` : `on ${day(ws)} around ${hm(ws)}`;
  if (date) { const d = new Date(`${date}T12:00:00Z`); return locale === "fr" ? `le ${new Intl.DateTimeFormat(loc, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(d)}` : `on ${new Intl.DateTimeFormat(loc, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(d)}`; }
  return locale === "fr" ? "bientôt" : "soon";
}

export async function customerLocale(c: pg.PoolClient, orgLocale: string, jobContact: string): Promise<Locale> {
  const pref = jobContact ? (await c.query<{ locale: Locale | null }>("SELECT locale FROM customer_prefs WHERE contact = $1", [jobContact])).rows[0]?.locale : null;
  return pref ?? (orgLocale === "fr" ? "fr" : "en");
}

/**
 * Tell the customer about one step of their job, by email and by SMS (whichever they have given and have not switched off).
 * Each job, step and channel is sent at most once; what happened (sent, failed, skipped and why) is recorded so the office can see it.
 * `repeat` lets steps that can happen again (a second reschedule) be sent again.
 */
export async function notifyCustomer(c: pg.PoolClient, deps: CustomerDeps, orgId: string, jobId: string, event: CustomerEvent | "custom", opts: { vars?: Record<string, string>; text?: string; repeat?: string; force?: boolean } = {}): Promise<Sent[]> {
  const job = (await c.query(
    `SELECT j.id, j.ref, j.title, j.status, j.customer_name, j.customer_email, j.customer_phone, j.scheduled_date::text AS date, j.window_start, j.window_end, j.reason_code, j.driver_id,
            o.name AS org, o.brand_name, o.brand_color, o.locale, o.timezone, o.settings
     FROM jobs j JOIN organizations o ON o.id = j.org_id WHERE j.id = $1`, [jobId])).rows[0];
  if (!job || (!job.customer_email && !job.customer_phone)) return [];
  const opt = customerOptions(job.settings);
  if (!opt.notify.enabled && !opts.force) return [];
  if (event !== "custom" && !opt.notify.events[event] && !opts.force) return [];
  const contact = contactKey(job);
  const prefs = (await c.query<{ email_on: boolean; sms_on: boolean; muted_events: string[] }>("SELECT email_on, sms_on, muted_events FROM customer_prefs WHERE contact = $1", [contact])).rows[0];
  const locale = await customerLocale(c, job.locale, contact);
  const link = await ensureJobLink(c, orgId, jobId, deps.secret);
  const driver = opt.portal.showDriver && job.driver_id ? (await c.query<{ n: string }>("SELECT split_part(coalesce(display_name, email), ' ', 1) AS n FROM users WHERE id = $1", [job.driver_id])).rows[0]?.n : null;
  const vars: Record<string, string> = {
    customer: job.customer_name?.split(" ")[0] ?? (locale === "fr" ? "client" : "there"), org: job.brand_name ?? job.org, ref: job.ref ?? job.title, title: job.title,
    link: link.url, driverWith: driver ? ` ${driver}` : "", window: windowText(job.window_start, job.window_end, job.date, job.timezone, locale), reason: job.reason_code ? job.reason_code.replace(/_/g, " ") : "",
    minutes: String(opt.notify.minutesAway), stops: String(opt.notify.stopsAway), ...(opts.vars ?? {}),
  };
  const custom = event === "custom" ? [] : (await c.query<{ channel: "email" | "sms"; subject: string | null; body: string }>("SELECT channel, subject, body FROM message_templates WHERE event = $1 AND locale = $2", [event, locale])).rows;
  const msg = renderCustomerMessage(event, locale, vars, { name: vars.org!, color: job.brand_color },
    { email: custom.find((x) => x.channel === "email"), sms: custom.find((x) => x.channel === "sms") }, opts.text);
  const key = `${event}${opts.repeat ? `:${opts.repeat}` : ""}`;
  const out: Sent[] = [];
  const muted = prefs?.muted_events?.includes(event) ?? false;
  const plan: { channel: "email" | "sms"; to: string | null; on: boolean }[] = [
    { channel: "email", to: job.customer_email, on: prefs?.email_on !== false }, { channel: "sms", to: job.customer_phone, on: prefs?.sms_on !== false },
  ];
  for (const p of plan) {
    if (!p.to) continue;
    const claimed = await c.query("INSERT INTO customer_notifications (org_id, job_id, event, channel, to_addr, subject, status) VALUES ($1,$2,$3,$4,$5,$6,'skipped') ON CONFLICT (job_id, event, channel) DO NOTHING RETURNING id", [orgId, jobId, key, p.channel, p.to, msg.subject]);
    if (!claimed.rows[0]) continue; // already handled
    const id = claimed.rows[0].id as string;
    let res: Sent;
    if (!p.on || (muted && event !== "custom")) res = { channel: p.channel, status: "skipped", error: "the customer switched this off" };
    else {
      const r = await deliver({ id: "customer", kind: p.channel, target: p.to, label: "customer" },
        p.channel === "email" ? { subject: msg.subject, text: msg.text, html: msg.html } : { subject: msg.subject, text: msg.sms, plain: true }, deps.providers);
      res = r.ok ? { channel: p.channel, status: "sent" } : { channel: p.channel, status: r.unconfigured ? "skipped" : "failed", error: r.error };
    }
    await c.query("UPDATE customer_notifications SET status = $2, error = $3, at = now() WHERE id = $1", [id, res.status, res.error ?? null]);
    out.push(res);
  }
  return out;
}
