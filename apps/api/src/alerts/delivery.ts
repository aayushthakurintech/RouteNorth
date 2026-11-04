import { pg, withOrg } from "@routenorth/db";
import { inQuietHours } from "@routenorth/shared";
import { deliver, type Endpoint, type Providers } from "../notify/notifier.js";

/**
 * Telling people. Each person picks, for each severity, how they want to hear (in the app, email, SMS, push, Slack, Teams), which areas to mute, and quiet hours.
 * Critical alerts ignore quiet hours and mutes. "In the app" needs no sending: the alert is in the bell and the inbox.
 */
export type Channel = "inapp" | "email" | "sms" | "push" | "slack" | "teams";
export const CHANNELS: readonly Channel[] = ["inapp", "email", "sms", "push", "slack", "teams"];
export type Sev = "info" | "warn" | "critical";
export const DEFAULT_CHANNELS: Record<Sev, Channel[]> = { info: ["inapp"], warn: ["inapp", "email"], critical: ["inapp", "email"] };

export interface Item { id: string; title: string; detail: Record<string, unknown>; severity: Sev }
export interface Prefs { channels: Partial<Record<Sev, Channel[]>>; mutedAreas: string[]; quietStart: string | null; quietEnd: string | null; digest: boolean; phone: string | null }
export interface Person { id: string; name: string; email: string; prefs: Prefs }
export interface SendSummary { sent: number; failed: number; skipped: number; notes: string[]; byAlert: Map<string, Record<string, unknown>> }

const hhmm = (d: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);
const WEB = () => process.env.PUBLIC_WEB_URL ?? "http://localhost:3000";

export function channelsFor(p: Prefs, sev: Sev): Channel[] {
  const own = p.channels?.[sev];
  return Array.isArray(own) ? own.filter((c): c is Channel => (CHANNELS as readonly string[]).includes(c)) : DEFAULT_CHANNELS[sev];
}

/** The people a rule tells: the ones it names, or when it names nobody, the owners and admins. */
export async function peopleFor(pool: pg.Pool, orgId: string, recipientIds: string[]): Promise<Person[]> {
  const rows = (await withOrg(pool, orgId, (c) => c.query(
    `SELECT u.id, coalesce(u.display_name, u.email) AS name, u.email, p.channels, p.muted_areas AS "mutedAreas", p.quiet_start::text AS "quietStart", p.quiet_end::text AS "quietEnd", coalesce(p.digest, true) AS digest, p.phone
     FROM users u LEFT JOIN portal_alert_prefs p ON p.user_id = u.id
     WHERE u.disabled_at IS NULL AND u.role <> 'driver' AND ${recipientIds.length ? "u.id = ANY($1::uuid[])" : "u.role IN ('owner','admin')"}`, recipientIds.length ? [recipientIds] : []))).rows;
  return rows.map((r) => ({ id: r.id, name: r.name, email: r.email, prefs: { channels: r.channels ?? {}, mutedAreas: r.mutedAreas ?? [], quietStart: r.quietStart, quietEnd: r.quietEnd, digest: r.digest, phone: r.phone } }));
}

/** Send a rule's alerts to its people, following each person's choices. Returns what happened for each alert so the history can show it. */
export async function notifyPeople(pool: pg.Pool, notify: Providers, orgId: string, rule: { name: string; recipientIds: string[]; area: string | null }, items: Item[], tz: string, now: Date): Promise<SendSummary> {
  const out: SendSummary = { sent: 0, failed: 0, skipped: 0, notes: [], byAlert: new Map() };
  const people = await peopleFor(pool, orgId, rule.recipientIds);
  const shared = (await withOrg(pool, orgId, (c) => c.query<Endpoint & { enabled: boolean }>("SELECT id, kind, target, label, enabled FROM notification_endpoints WHERE enabled AND kind IN ('slack','teams')"))).rows;
  const usedShared = new Set<string>();
  const touch = (ids: string[], key: string, v: string) => { for (const id of ids) { const e = out.byAlert.get(id) ?? out.byAlert.set(id, {}).get(id)!; ((e[key] as string[] | undefined) ?? (e[key] = [] as string[]) as string[]).push(v); } };
  for (const person of people) {
    const quiet = inQuietHours(hhmm(now, tz), person.prefs.quietStart, person.prefs.quietEnd);
    for (const sev of ["critical", "warn", "info"] as const) {
      const group = items.filter((i) => i.severity === sev);
      if (!group.length) continue;
      if (sev !== "critical" && ((rule.area && person.prefs.mutedAreas.includes(rule.area)) || quiet)) { out.skipped++; continue; }
      const subject = group.length === 1 ? `${rule.name}: ${group[0]!.title}` : `${rule.name}: ${group.length} alerts`;
      const text = group.length === 1 ? group[0]!.title : group.slice(0, 10).map((g) => `• ${g.title}`).join("\n") + (group.length > 10 ? `\n…and ${group.length - 10} more` : "");
      const msg = { subject, text, severity: sev, link: `${WEB()}/owner/alerts` };
      const ids = group.map((g) => g.id);
      for (const ch of channelsFor(person.prefs, sev)) {
        if (ch === "inapp") continue;
        if (ch === "push") { out.skipped++; out.notes.push(`${person.name}: push was skipped because push messages need the mobile app and a push service, which are not set up`); continue; }
        if (ch === "slack" || ch === "teams") {
          for (const ep of shared.filter((e) => e.kind === ch)) {
            if (usedShared.has(`${ep.id}:${sev}`)) continue;
            usedShared.add(`${ep.id}:${sev}`);
            const r = await deliver(ep, msg, notify);
            if (r.ok) { out.sent++; touch(ids, "channels", `${ch}:${ep.label}`); } else { out.failed++; out.notes.push(`${ep.label}: ${r.error}`); }
          }
          continue;
        }
        const target = ch === "email" ? person.email : person.prefs.phone;
        if (!target) { out.skipped++; out.notes.push(`${person.name}: no ${ch === "sms" ? "mobile number" : "email"} on file`); continue; }
        const r = await deliver({ id: person.id, kind: ch, target, label: person.name }, msg, notify);
        if (r.ok) { out.sent++; touch(ids, "channels", `${ch}:${person.name}`); }
        else if (!r.ok && r.unconfigured) { out.skipped++; out.notes.push(`${person.name}: ${r.error}`); touch(ids, "notSent", `${ch}:${person.name}`); }
        else { out.failed++; out.notes.push(`${person.name}: ${(r as { error: string }).error}`); touch(ids, "failed", `${ch}:${person.name}`); }
      }
    }
  }
  return out;
}
