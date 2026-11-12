import { Controller, Get, Inject, Post, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { deviceHealth } from "@routenorth/shared";
import { AuthGuard, requireAny, type AuthedRequest } from "../auth/auth.guard.js";
import { deliver, type Providers } from "../notify/notifier.js";
import { providerFromEnv } from "../plan/providers.js";
import { GEOCODER, NOTIFY, PG_POOL } from "../tokens.js";

/**
 * Where data comes from, in plain words, and whether each source is flowing.
 * "live" = data arrived recently, "quiet" = set up but nothing lately, "not_connected" = nothing ever arrived,
 * "needs_setup" = the server is missing a key or address, "problem" = it is failing, "not_built" = does not exist yet.
 */
export type SourceState = "live" | "quiet" | "not_connected" | "needs_setup" | "problem" | "not_built";
export interface DataSource {
  id: string; name: string; group: "positions" | "work" | "people" | "services" | "partners";
  state: SourceState; summary: string; lastDataAt: string | null;
  /** What to do next, with a link to the page where it is done. */
  next: { label: string; href: string } | null;
  /** Server settings a person with access to the server must set (never their values). */
  needs: string[];
  /** Whether the "Send a test" button works for this source. */
  canTest: boolean;
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
const ageMin = (v: string | null, now: Date) => (v ? Math.round((now.getTime() - new Date(v).getTime()) / 60_000) : null);
const ago = (v: string | null, now: Date) => {
  const m = ageMin(v, now);
  if (m == null) return "never";
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  if (m < 2880) return `${Math.round(m / 60)} h ago`;
  return `${Math.round(m / 1440)} days ago`;
};

@Controller("portal/data-sources")
@UseGuards(AuthGuard)
export class PortalDataSourcesController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(NOTIFY) private readonly notify: Providers,
    @Inject(GEOCODER) private readonly geocoder: unknown | null,
  ) {}

  @Get()
  async list(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "settings.manage", "fleet.manage", "integrations.manage");
    const now = new Date();
    const d = await withOrg(this.pool, orgId, async (c) => {
      const one = async (sql: string, args: unknown[] = []) => (await c.query(sql, args)).rows[0] as Record<string, any>;
      const devices = (await c.query(
        `SELECT d.id, d.source, lp.time AS last_seen, lp.satellites, lp.battery_pct, lp.ext_voltage, lp.signal, lp.ignition, lp.speed
         FROM devices d LEFT JOIN latest_positions lp ON lp.device_id = d.id`)).rows;
      const quality = await one(
        `SELECT coalesce(sum(n),0)::float8 AS total,
                coalesce(sum(n) FILTER (WHERE outcome IN ('stored','latest_only','history_only')),0)::float8 AS accepted
         FROM ingest_counters WHERE day >= (now() AT TIME ZONE 'UTC')::date - 6`);
      const shifts = await one(`SELECT max(started_at) AS last, count(*) FILTER (WHERE started_at > now() - interval '7 days')::int AS week FROM shifts`);
      const jobs = (await c.query(
        `SELECT source, count(*)::int AS n, max(created_at) AS last, count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS month FROM jobs GROUP BY source`)).rows;
      const fuelImport = await one(`SELECT max(created_at) AS last, count(*)::int AS n FROM fuel_logs WHERE source = 'import'`);
      const hooks = await one(
        `SELECT (SELECT count(*)::int FROM webhook_subscriptions) AS subs,
                count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '24 hours')::int AS failed,
                count(*) FILTER (WHERE status = 'ok' AND created_at > now() - interval '24 hours')::int AS ok,
                max(delivered_at) AS last
         FROM webhook_deliveries`);
      const msgs = await one(
        `SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'sent')::int AS sent, max(at) FILTER (WHERE status = 'sent') AS last
         FROM customer_notifications WHERE channel = 'email' AND at > now() - interval '7 days'`);
      const sms = await one(
        `SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'sent')::int AS sent, max(at) FILTER (WHERE status = 'sent') AS last
         FROM customer_notifications WHERE channel = 'sms' AND at > now() - interval '7 days'`);
      const keys = await one(
        `SELECT count(*) FILTER (WHERE kind = 'api' AND revoked_at IS NULL)::int AS api, count(*) FILTER (WHERE kind IN ('feed','inbound') AND revoked_at IS NULL)::int AS feeds,
                max(last_used_at) FILTER (WHERE kind = 'api') AS api_last
         FROM api_keys`);
      const totals = await one(`SELECT (SELECT count(*)::int FROM vehicles WHERE archived_at IS NULL AND status NOT IN ('sold','retired')) AS vehicles, (SELECT count(*)::int FROM driver_profiles WHERE archived_at IS NULL) AS drivers, (SELECT count(*)::int FROM jobs) AS orders`);
      return { devices, quality, shifts, jobs, fuelImport, hooks, msgs, sms, keys, totals };
    });

    const sources: DataSource[] = [];
    const add = (s: DataSource) => sources.push(s);

    // ---- positions
    const trackers = d.devices.filter((x: any) => x.source !== "api" && x.source !== "simulator");
    const sim = d.devices.filter((x: any) => x.source === "simulator");
    const phones = d.devices.filter((x: any) => x.source === "api");
    const newest = (rows: any[]) => iso(rows.map((r) => r.last_seen).filter(Boolean).sort().at(-1));
    const trackLast = newest(trackers);
    const silent = trackers.filter((x: any) => !x.last_seen || deviceHealth({ lastSeen: iso(x.last_seen), satellites: x.satellites, batteryPct: x.battery_pct, extVoltage: x.ext_voltage, signal: x.signal, active: x.ignition === true || (x.speed ?? 0) >= 3 }, now).state === "offline").length;
    const acceptedPct = d.quality.total > 0 ? Math.round((d.quality.accepted / d.quality.total) * 1000) / 10 : null;
    if (!trackers.length) {
      add({ id: "trackers", name: "GPS trackers", group: "positions", state: "not_connected",
        summary: sim.length ? "Only demo vehicles are reporting. No real tracker is registered yet." : "No tracker registered yet.",
        lastDataAt: newest(sim), next: { label: "Add a tracker", href: "/devices" }, needs: [], canTest: false });
    } else {
      const m = ageMin(trackLast, now);
      const state: SourceState = m == null ? "not_connected" : m > 60 ? "problem" : "live";
      add({ id: "trackers", name: "GPS trackers", group: "positions", state,
        summary: `${trackers.length} tracker${trackers.length === 1 ? "" : "s"}, last position ${ago(trackLast, now)}${silent ? `, ${silent} silent` : ""}${acceptedPct != null ? `, ${acceptedPct}% of readings accepted this week` : ""}.`,
        lastDataAt: trackLast, next: state === "live" && !silent ? null : { label: "Check trackers", href: "/devices" }, needs: [], canTest: false });
    }
    add({ id: "phone-feed", name: "Phone apps and vendor feeds", group: "positions",
      state: !phones.length ? "not_connected" : (ageMin(newest(phones), now) ?? 9e9) > 60 ? "quiet" : "live",
      summary: phones.length ? `${phones.length} feed device${phones.length === 1 ? "" : "s"}, last position ${ago(newest(phones), now)}.` : "No device is sending through the JSON feed yet.",
      lastDataAt: newest(phones), next: phones.length ? null : { label: "Read the feed guide", href: "/integrations" }, needs: ["INGEST_TOKEN (on the ingest service)"], canTest: false });
    add({ id: "driver-app", name: "Driver app", group: "people",
      state: d.shifts.last == null ? "not_connected" : d.shifts.week > 0 ? "live" : "quiet",
      summary: d.shifts.last == null ? "No driver has started a shift in the app yet." : `${d.shifts.week} shift${d.shifts.week === 1 ? "" : "s"} in the last 7 days, last started ${ago(iso(d.shifts.last), now)}.`,
      lastDataAt: iso(d.shifts.last), next: d.shifts.last == null ? { label: "Invite a driver", href: "/owner/drivers" } : null, needs: [], canTest: false });

    // ---- work coming in
    const bySource = new Map<string, any>(d.jobs.map((j: any) => [j.source, j]));
    const jobSource = (id: string, name: string, key: string[], idleText: string, next: DataSource["next"], needs: string[] = []) => {
      const rows = key.map((k) => bySource.get(k)).filter(Boolean);
      const last = iso(rows.map((r) => r.last).filter(Boolean).sort().at(-1));
      const month = rows.reduce((a, r) => a + r.month, 0);
      add({ id, name, group: "work", state: !rows.length ? "not_connected" : month > 0 ? "live" : "quiet",
        summary: rows.length ? `${month} order${month === 1 ? "" : "s"} in the last 30 days, last one ${ago(last, now)}.` : idleText, lastDataAt: last, next: rows.length ? null : next, needs, canTest: false });
    };
    jobSource("orders-booking", "Booking form and customer portal", ["booking", "portal"], "No order has come through the booking form yet.", { label: "Open customer settings", href: "/settings/customers" });
    jobSource("orders-email", "Email-to-order", ["email"], "No forwarded email has become an order yet.", { label: "Open integrations", href: "/integrations" }, ["An inbound email service pointed at the API"]);
    jobSource("orders-store", "Shop and API orders", ["store", "api"], "No order has arrived from a shop or the API yet.", { label: "Open integrations", href: "/integrations" });
    const files = bySource.get("import");
    const fuelLast = iso(d.fuelImport.last);
    const fileLast = iso([files?.last, d.fuelImport.last].filter(Boolean).sort().at(-1));
    add({ id: "files", name: "File imports", group: "work", state: files || d.fuelImport.n ? "live" : "not_connected",
      summary: files || d.fuelImport.n ? `Last import ${ago(fileLast, now)} (${files?.n ?? 0} orders, ${d.fuelImport.n} fuel records).` : "Nothing imported yet. Vehicles, drivers, stops and fuel statements can be imported from CSV.",
      lastDataAt: fileLast ?? fuelLast, next: { label: "Open the import wizard", href: "/import" }, needs: [], canTest: false });

    // ---- outside services
    const routing = providerFromEnv();
    add({ id: "routing", name: "Road routing and ETAs", group: "services", state: routing ? "live" : "needs_setup",
      summary: routing ? "A routing engine is set. ETAs and route lengths use real roads." : "No routing engine is set, so ETAs use straight-line distance times 1.3 at 40 km/h.",
      lastDataAt: null, next: null, needs: routing ? [] : ["ROUTING_URL and ROUTING_PROVIDER (osrm or valhalla)"], canTest: false });
    add({ id: "geocoder", name: "Address search", group: "services", state: this.geocoder ? "live" : "needs_setup",
      summary: this.geocoder ? "Address search is on." : "Address search is off, so stops need coordinates or a CSV with coordinates.",
      lastDataAt: null, next: null, needs: this.geocoder ? [] : ["GEOCODER_URL (and GEOCODER_CONTACT)"], canTest: false });
    add({ id: "email", name: "Email", group: "services",
      state: !this.notify.email ? "needs_setup" : d.msgs.failed > 0 && d.msgs.sent === 0 ? "problem" : d.msgs.sent > 0 ? "live" : "quiet",
      summary: !this.notify.email ? "Email is not set up. Alerts, digests, invites and reset links cannot be emailed." : d.msgs.sent > 0 ? `${d.msgs.sent} customer email${d.msgs.sent === 1 ? "" : "s"} sent this week${d.msgs.failed ? `, ${d.msgs.failed} failed` : ""}.` : d.msgs.failed > 0 ? `${d.msgs.failed} customer email${d.msgs.failed === 1 ? "" : "s"} failed this week.` : "Email is set up. Send a test to see it arrive.",
      lastDataAt: iso(d.msgs.last), next: null, needs: this.notify.email ? [] : ["RESEND_API_KEY and EMAIL_FROM"], canTest: !!this.notify.email });
    add({ id: "sms", name: "Text messages", group: "services",
      state: !this.notify.sms ? "needs_setup" : d.sms.failed > 0 && d.sms.sent === 0 ? "problem" : d.sms.sent > 0 ? "live" : "quiet",
      summary: !this.notify.sms ? "Text messages are not set up." : d.sms.sent > 0 ? `${d.sms.sent} text${d.sms.sent === 1 ? "" : "s"} sent this week${d.sms.failed ? `, ${d.sms.failed} failed` : ""}.` : "Text messages are set up and nothing was sent this week.",
      lastDataAt: iso(d.sms.last), next: null, needs: this.notify.sms ? [] : ["TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM"], canTest: false });
    add({ id: "webhooks", name: "Webhooks and API", group: "services",
      state: d.hooks.failed > 0 ? "problem" : d.hooks.subs > 0 && d.hooks.ok > 0 ? "live" : d.hooks.subs > 0 ? "quiet" : "not_connected",
      summary: d.hooks.subs ? `${d.hooks.subs} webhook${d.hooks.subs === 1 ? "" : "s"}; ${d.hooks.ok} delivered and ${d.hooks.failed} failed in the last 24 hours. ${d.keys.api} API key${d.keys.api === 1 ? "" : "s"}.` : `No webhook set up. ${d.keys.api} API key${d.keys.api === 1 ? "" : "s"}, ${d.keys.feeds} feed key${d.keys.feeds === 1 ? "" : "s"}.`,
      lastDataAt: iso(d.hooks.last ?? d.keys.api_last), next: d.hooks.subs ? null : { label: "Open integrations", href: "/integrations" }, needs: [], canTest: false });

    // ---- partner feeds that do not exist yet
    for (const [id, name, summary] of [
      ["eld", "Certified ELD", "Not built. Hours of service on screen are estimates, not official logs. A certified ELD provider is planned."],
      ["fuel-cards", "Fuel card feeds", "Not built. Fuel statements can be imported as CSV today."],
      ["accounting", "Live accounting sync", "Not built. Invoices and payouts export as QuickBooks, Xero and Sage CSV."],
    ] as const) add({ id, name, group: "partners", state: "not_built", summary, lastDataAt: null, next: null, needs: [], canTest: false });

    const counts = { live: 0, quiet: 0, not_connected: 0, needs_setup: 0, problem: 0, not_built: 0 } as Record<SourceState, number>;
    for (const s of sources) counts[s.state]++;
    return { checkedAt: now.toISOString(), counts, sources, totals: d.totals as { vehicles: number; drivers: number; orders: number }, needsAttention: sources.filter((s) => s.state === "problem").length };
  }

  /** "Send a test": a real email to the person who clicked, so a missing key or a bad sender address shows up now, not at 7 a.m. */
  @Post("test-email")
  async testEmail(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "settings.manage", "integrations.manage");
    const me = (await withOrg(this.pool, orgId, (c) => c.query("SELECT email, coalesce(display_name, email) AS name FROM users WHERE id = $1", [req.session!.userId]))).rows[0];
    if (!this.notify.email) return { ok: false, error: "Email is not set up on this server yet (RESEND_API_KEY and EMAIL_FROM)." };
    const r = await deliver({ id: req.session!.userId, kind: "email", target: me.email, label: me.name }, { subject: "RouteNorth test email", text: "This is a test from the Data sources page. If you can read it, email works.", link: `${process.env.PUBLIC_WEB_URL ?? "http://localhost:3000"}/owner/settings/data-sources`, severity: "info" }, this.notify);
    return r.ok ? { ok: true, to: me.email } : { ok: false, error: r.error ?? "The email service refused the message." };
  }
}
