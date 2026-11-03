import { BadRequestException, Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Put, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { FLAGS, flagEnabled, resolveFlags } from "@routenorth/shared";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { withDefaults } from "../org/settings.js";
import { GEOCODER, NOTIFY, PG_POOL } from "../tokens.js";
import type { Providers } from "../notify/notifier.js";

/** What a page or feature is called in the usage counts: ids and numbers are folded away so nothing personal is kept. */
export function usageName(raw: string): string {
  return raw.replace(/[?#].*$/, "").replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id").replace(/\/\d+(?=\/|$)/g, "/:n").slice(0, 80);
}
const NAME = /^[A-Za-z0-9/_:.\- ]{1,80}$/;

export type Status = "ok" | "warn" | "fail" | "off";

/** Health, usage, feature flags, errors, onboarding and sample data: the tools for running an account well. */
@Controller("ops")
@UseGuards(AuthGuard)
export class OpsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: pg.Pool,
    @Inject(NOTIFY) private readonly notify: Providers,
    @Inject(GEOCODER) private readonly geocoder: unknown | null,
  ) {}

  // -------------------------------------------------------------------------------- health

  @Get("health")
  async health(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "settings.manage");
    const t0 = Date.now();
    return withOrg(this.pool, orgId, async (c) => {
      const dbMs = Date.now() - t0;
      const one = async (sql: string) => (await c.query(sql)).rows[0] as Record<string, number | string | null>;
      const pos = await one(`SELECT count(*)::int AS devices, max(time) AS newest, count(*) FILTER (WHERE time < now() - interval '24 hours')::int AS silent FROM latest_positions`);
      const hooks = await one(`SELECT count(*) FILTER (WHERE status = 'failed' AND created_at > now() - interval '24 hours')::int AS failed,
                                      count(*) FILTER (WHERE status = 'pending' AND next_attempt_at < now() - interval '15 minutes')::int AS stuck FROM webhook_deliveries`);
      const msgs = await one(`SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*)::int AS total FROM customer_notifications WHERE at > now() - interval '24 hours'`);
      const runs = await one(`SELECT count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*)::int AS total FROM workflow_runs WHERE at > now() - interval '24 hours'`);
      const errs = await one(`SELECT count(*)::int AS n FROM error_log WHERE at > now() - interval '24 hours'`);
      const ageMin = pos.newest ? Math.round((Date.now() - new Date(pos.newest as string).getTime()) / 60_000) : null;
      const checks: { id: string; status: Status; value?: number | string | null; extra?: number }[] = [
        { id: "database", status: dbMs > 1500 ? "warn" : "ok", value: dbMs },
        { id: "gpsFeed", status: !pos.devices ? "off" : ageMin! > 60 ? "fail" : ageMin! > 15 ? "warn" : "ok", value: ageMin, extra: pos.devices as number },
        { id: "silentDevices", status: !pos.devices ? "off" : pos.silent ? "warn" : "ok", value: pos.silent as number },
        { id: "webhooks", status: hooks.failed || hooks.stuck ? "warn" : "ok", value: hooks.failed as number, extra: hooks.stuck as number },
        { id: "customerMessages", status: !msgs.total ? "off" : msgs.failed ? "warn" : "ok", value: msgs.failed as number, extra: msgs.total as number },
        { id: "workflows", status: !runs.total ? "off" : runs.failed ? "warn" : "ok", value: runs.failed as number, extra: runs.total as number },
        { id: "errors", status: (errs.n as number) > 10 ? "fail" : errs.n ? "warn" : "ok", value: errs.n as number },
        { id: "email", status: this.notify.email ? "ok" : "off" },
        { id: "sms", status: this.notify.sms ? "ok" : "off" },
        { id: "geocoder", status: this.geocoder ? "ok" : "off" },
      ];
      const overall: Status = checks.some((x) => x.status === "fail") ? "fail" : checks.some((x) => x.status === "warn") ? "warn" : "ok";
      return { overall, checkedAt: new Date().toISOString(), checks };
    });
  }

  @Get("errors")
  async errors(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "settings.manage");
    return (await withOrg(this.pool, orgId, (c) => c.query(`SELECT id, at, status, method, path, message FROM error_log ORDER BY at DESC LIMIT 50`))).rows;
  }

  // -------------------------------------------------------------------------------- usage

  /** The browser reports which pages and features were used. Only a name, the day and the role are kept. */
  @Post("usage")
  @HttpCode(204)
  async track(@Req() req: AuthedRequest, @Body() b: { events?: unknown }): Promise<void> {
    if (!Array.isArray(b?.events)) throw new BadRequestException("events must be a list");
    const { orgId, role } = req.session!;
    const counts = new Map<string, { kind: string; name: string; n: number }>();
    for (const e of b.events.slice(0, 50) as { kind?: unknown; name?: unknown }[]) {
      if ((e?.kind !== "page" && e?.kind !== "feature") || typeof e.name !== "string") continue;
      const name = usageName(e.name);
      if (!NAME.test(name)) continue;
      const k = `${e.kind}|${name}`;
      counts.set(k, { kind: e.kind, name, n: (counts.get(k)?.n ?? 0) + 1 });
    }
    if (!counts.size) return;
    await withOrg(this.pool, orgId, async (c) => {
      const s = withDefaults((await c.query("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0]?.settings);
      if (s.platform.analyticsOptOut || !flagEnabled("usageAnalytics", orgId, s.featureFlags)) return;
      for (const v of counts.values()) {
        await c.query(
          `INSERT INTO usage_counts (org_id, day, kind, name, role, n) VALUES ($1, current_date, $2, $3, $4, $5)
           ON CONFLICT (org_id, day, kind, name, role) DO UPDATE SET n = usage_counts.n + EXCLUDED.n`, [orgId, v.kind, v.name, role, v.n]);
      }
    });
  }

  @Get("usage")
  async usage(@Req() req: AuthedRequest, @Query("days") daysRaw?: string) {
    const orgId = requirePerm(req, "settings.manage");
    const days = Math.min(Math.max(Number(daysRaw) || 30, 1), 365);
    return withOrg(this.pool, orgId, async (c) => {
      const top = async (kind: string) => (await c.query(
        `SELECT name, sum(n)::int AS n FROM usage_counts WHERE kind = $1 AND day > current_date - $2::int GROUP BY name ORDER BY n DESC, name LIMIT 15`, [kind, days])).rows;
      const byRole = (await c.query(`SELECT role, sum(n)::int AS n FROM usage_counts WHERE kind = 'page' AND day > current_date - $1::int GROUP BY role ORDER BY n DESC`, [days])).rows;
      const byDay = (await c.query(`SELECT day::text AS day, sum(n)::int AS n FROM usage_counts WHERE kind = 'page' AND day > current_date - $1::int GROUP BY day ORDER BY day`, [days])).rows;
      const s = withDefaults((await c.query("SELECT settings FROM organizations WHERE id = $1", [orgId])).rows[0]?.settings);
      return { days, optedOut: s.platform.analyticsOptOut, pages: await top("page"), features: await top("feature"), byRole, byDay };
    });
  }

  // -------------------------------------------------------------------------------- feature flags

  @Get("flags")
  async flags(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "settings.manage");
    const s = await this.settings(orgId);
    const on = resolveFlags(orgId, s.featureFlags);
    return FLAGS.map((f) => ({ key: f.key, enabled: on[f.key], overridden: typeof s.featureFlags[f.key] === "boolean", default: f.default, rolloutPct: f.rolloutPct }));
  }

  /** Switch a flag on or off for this organization, or pass null to go back to the default. */
  @Put("flags/:key")
  async setFlag(@Req() req: AuthedRequest, @Param("key") key: string, @Body() b: { enabled?: unknown }) {
    const orgId = requirePerm(req, "settings.manage");
    if (!FLAGS.some((f) => f.key === key)) throw new BadRequestException("unknown flag");
    if (b?.enabled !== null && typeof b?.enabled !== "boolean") throw new BadRequestException("enabled must be true, false or null");
    await withOrg(this.pool, orgId, async (c) => {
      const cur = withDefaults((await c.query("SELECT settings FROM organizations WHERE id = $1 FOR UPDATE", [orgId])).rows[0]?.settings).featureFlags;
      const next = { ...cur };
      if (b.enabled === null) delete next[key]; else next[key] = b.enabled as boolean;
      await c.query("UPDATE organizations SET settings = coalesce(settings, '{}'::jsonb) || jsonb_build_object('featureFlags', $2::jsonb) WHERE id = $1", [orgId, JSON.stringify(next)]);
    });
    return this.flags(req);
  }

  private async settings(orgId: string) {
    return withDefaults((await withOrg(this.pool, orgId, (c) => c.query("SELECT settings FROM organizations WHERE id = $1", [orgId]))).rows[0]?.settings);
  }

  // -------------------------------------------------------------------------------- onboarding and sample data

  /** What has been set up so far, for the getting-started checklist. */
  @Get("onboarding")
  async onboarding(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "settings.manage");
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query(
        `SELECT (SELECT count(*)::int FROM vehicles) AS vehicles,
                (SELECT count(*)::int FROM users WHERE role = 'driver' AND disabled_at IS NULL) AS drivers,
                (SELECT count(*)::int FROM routes) AS routes,
                (SELECT count(*)::int FROM jobs WHERE NOT ('sample' = ANY(tags))) AS jobs,
                (SELECT count(*)::int FROM jobs WHERE 'sample' = ANY(tags)) AS sample,
                (SELECT count(*)::int FROM users WHERE disabled_at IS NULL) AS people,
                (SELECT count(*)::int FROM invites) AS invites,
                (SELECT count(*)::int FROM user_security WHERE user_id = $1 AND totp_enabled_at IS NOT NULL) AS two_factor,
                (SELECT (brand_name IS NOT NULL OR logo_data_url IS NOT NULL) FROM organizations WHERE id = $2) AS branded`, [req.session!.userId, orgId])).rows[0];
      return { vehicles: r.vehicles, drivers: r.drivers, routes: r.routes, jobs: r.jobs, sampleJobs: r.sample, teammates: Math.max(r.people - 1, 0) + r.invites, twoFactor: r.two_factor > 0, branded: !!r.branded };
    });
  }

  /** Six example jobs around downtown Toronto, tagged "sample", so a new account has something to plan with. */
  @Post("sample")
  @HttpCode(200)
  async addSample(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "routes.write");
    const spots: [string, string, number, number][] = [
      ["Office supplies", "100 Queen St W, Toronto", 43.6529, -79.3849], ["Pharmacy order", "55 Mill St, Toronto", 43.6503, -79.3596],
      ["Furniture drop", "1 Blue Jays Way, Toronto", 43.6414, -79.3894], ["Café restock", "290 Bremner Blvd, Toronto", 43.6426, -79.3871],
      ["Parcel pickup", "220 Yonge St, Toronto", 43.6544, -79.3807], ["Medical samples", "555 University Ave, Toronto", 43.6577, -79.3903],
    ];
    return withOrg(this.pool, orgId, async (c) => {
      if ((await c.query("SELECT 1 FROM jobs WHERE 'sample' = ANY(tags) LIMIT 1")).rowCount) throw new BadRequestException("the sample jobs are already there");
      for (const [i, [title, address, lat, lng]] of spots.entries()) {
        await c.query(
          `INSERT INTO jobs (org_id, title, type, address, lat, lng, scheduled_date, customer_name, weight_kg, tags, source, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,current_date,$7,$8,ARRAY['sample'],'office',$9)`,
          [orgId, title, i % 3 === 2 ? "pickup" : "delivery", address, lat, lng, `Sample customer ${i + 1}`, 5 + i * 4, /^[0-9a-f-]{36}$/.test(req.session!.userId) ? req.session!.userId : null]);
      }
      return { added: spots.length };
    });
  }

  /** Remove the sample jobs that nobody has started. Jobs that are already on a route are left alone. */
  @Delete("sample")
  @HttpCode(200)
  async removeSample(@Req() req: AuthedRequest) {
    const orgId = requirePerm(req, "routes.write");
    return withOrg(this.pool, orgId, async (c) => {
      const r = await c.query("DELETE FROM jobs WHERE 'sample' = ANY(tags) AND status = 'unassigned' AND route_id IS NULL");
      const left = (await c.query("SELECT count(*)::int AS n FROM jobs WHERE 'sample' = ANY(tags)")).rows[0].n;
      return { removed: r.rowCount ?? 0, left };
    });
  }
}
