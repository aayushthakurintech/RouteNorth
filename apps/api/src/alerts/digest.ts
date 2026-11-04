import { pg, withOrg } from "@routenorth/db";
import { ROLE_PERMISSIONS, type Permission, type Role } from "@routenorth/shared";
import type { Providers } from "../notify/notifier.js";
import { deliver } from "../notify/notifier.js";

/** Which permission lets a person see the alerts of an area. */
export const AREA_PERM: Record<string, Permission> = { vehicle: "fleet.view", driver: "drivers.view", pay: "pay.view", money: "finance.view", custom: "alerts.manage", live: "alerts.view" };
export const areasFor = (perms: ReadonlySet<string>): string[] => Object.entries(AREA_PERM).filter(([, p]) => perms.has(p)).map(([a]) => a);

const WEB = () => process.env.PUBLIC_WEB_URL ?? "http://localhost:3000";
const hhmm = (d: Date, tz: string) => new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: false }).format(d);

/**
 * "Here is what needs you today": one email each morning to each person who wants it, with the open alerts they can see.
 * Alerts that are snoozed, or assigned to someone else, are left out. Nothing is sent when nothing needs them.
 */
export async function sendPersonalDigests(pool: pg.Pool, notify: Providers, orgId: string, now = new Date(), only?: string): Promise<{ people: number; sent: number; skipped: number; notes: string[] }> {
  const out = { people: 0, sent: 0, skipped: 0, notes: [] as string[] };
  const meta = (await withOrg(pool, orgId, (c) => c.query<{ today: string; tz: string }>("SELECT (now() AT TIME ZONE timezone)::date::text AS today, timezone AS tz FROM organizations"))).rows[0];
  if (!meta) return out;
  const people = (await withOrg(pool, orgId, (c) => c.query(
    `SELECT u.id, u.role, u.email, coalesce(u.display_name, u.email) AS name, coalesce(p.digest, true) AS digest FROM users u LEFT JOIN portal_alert_prefs p ON p.user_id = u.id
     WHERE u.disabled_at IS NULL AND u.role IN ('owner','admin','manager','accountant') AND ($1::uuid IS NULL OR u.id = $1)`, [only ?? null]))).rows;
  for (const person of people) {
    if (!person.digest && !only) continue;
    const perms = new Set<string>(ROLE_PERMISSIONS[person.role as Role] ?? []);
    const areas = areasFor(perms);
    const subject = `digest:${meta.today}:${person.id}`;
    const rows = await withOrg(pool, orgId, async (c) => {
      if (!only && (await c.query("SELECT 1 FROM portal_automation_runs WHERE automation = 'digest' AND subject = $1", [subject])).rowCount) return null;
      return (await c.query(
        `SELECT a.id, a.title, a.severity, a.assigned_to AS "assignedTo" FROM alerts a WHERE a.status <> 'resolved' AND (a.snoozed_until IS NULL OR a.snoozed_until <= now())
           AND (a.area IS NULL OR a.area = ANY($1::text[])) AND (a.assigned_to IS NULL OR a.assigned_to = $2)
         ORDER BY CASE a.severity WHEN 'critical' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END, a.first_at LIMIT 200`, [areas, person.id])).rows;
    });
    if (rows === null) continue;
    out.people++;
    if (!rows.length) { out.skipped++; continue; }
    const mine = rows.filter((r) => r.assignedTo === person.id);
    const group = (sev: string, label: string) => { const g = rows.filter((r) => r.severity === sev); return g.length ? [`${label} (${g.length})`, ...g.slice(0, 8).map((r) => `  • ${r.title}`), ...(g.length > 8 ? [`  …and ${g.length - 8} more`] : []), ""] : []; };
    const text = [`Good morning ${person.name}. Here is what needs you today.`, "", ...(mine.length ? [`${mine.length} assigned to you.`, ""] : []), ...group("critical", "Critical"), ...group("warn", "Warnings"), ...group("info", "For your information")].join("\n");
    const r = await deliver({ id: person.id, kind: "email", target: person.email, label: person.name }, { subject: `What needs you today: ${rows.length} alert${rows.length === 1 ? "" : "s"}`, text, link: `${WEB()}/owner/alerts`, severity: rows.some((x) => x.severity === "critical") ? "critical" : "info" }, notify);
    if (r.ok) {
      out.sent++;
      await withOrg(pool, orgId, (c) => c.query("INSERT INTO portal_automation_runs (org_id, automation, subject, status, detail) VALUES ($1,'digest',$2,'ok',$3) ON CONFLICT DO NOTHING", [orgId, subject, JSON.stringify({ alerts: rows.length, to: person.email })]));
    } else { out.skipped++; out.notes.push(`${person.name}: ${r.error}`); }
  }
  return out;
}

export const isDigestHour = (now: Date, tz: string) => hhmm(now, tz).startsWith("07:");
