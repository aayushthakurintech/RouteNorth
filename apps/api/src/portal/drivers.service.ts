import { ConflictException } from "@nestjs/common";
import type { pg } from "@routenorth/db";
import {
  DEFAULT_HOURS_RULES, DEFAULT_REQUIRED_STEPS, DEFAULT_WEIGHTS, DRIVER_LEGAL_DOC, ONBOARDING_STEPS, complianceScore, docStatus, driverBlockers, portalDriverScore, safetyScore,
  type DriverStatus, type HoursRules, type ScoreWeights,
} from "@routenorth/shared";

export interface DriverRow {
  id: string; name: string; email: string; phone: string | null; status: DriverStatus; storedStatus: string; statusReason: string | null; hasPhoto: boolean; teamId: string | null; homeDepotId: string | null;
  employmentType: string; licenseNo: string | null; licenseClass: string | null; licenseExpiry: string | null; vehicleId: string | null; vehicleName: string | null; rateCardId: string | null; rateCardName: string | null;
  rating: number | null; onTimePct: number | null; score: number | null; safety: number | null; tripsMonth: number; revenueMonthCents: number; earningsMonthCents: number | null;
  docs: { expired: number; expiring: number; nextExpiry: string | null }; compliance: number; onboarding: { done: number; total: number; requiredOpen: string[] }; blockedReasons: string[];
  lastActive: string | null; createdAt: string; archivedAt: string | null; tags: string[]; applicant?: boolean; inviteId?: string;
}
export interface DCtx { today: string; tz: string; now: Date }
export interface PortalSettings { weights: ScoreWeights; requiredSteps: string[]; hours: HoursRules; leaderboard: boolean; idleDriverDays: number; lowRating: number; scoreFloor: number; stuckOnboardingDays: number; cancellationAlertPct: number }
export const DEFAULT_SETTINGS: PortalSettings = { weights: DEFAULT_WEIGHTS, requiredSteps: DEFAULT_REQUIRED_STEPS, hours: DEFAULT_HOURS_RULES, leaderboard: false, idleDriverDays: 14, lowRating: 4, scoreFloor: 60, stuckOnboardingDays: 5, cancellationAlertPct: 20 };

export async function loadSettings(c: pg.PoolClient): Promise<PortalSettings> {
  const d = (await c.query<{ data: Partial<PortalSettings> }>("SELECT data FROM portal_settings LIMIT 1")).rows[0]?.data ?? {};
  return { ...DEFAULT_SETTINGS, ...d, weights: { ...DEFAULT_WEIGHTS, ...(d.weights ?? {}) }, hours: { ...DEFAULT_HOURS_RULES, ...(d.hours ?? {}) } };
}

/** The window the score, rating and on-time numbers cover. */
export const SCORE_DAYS = 30;

/** Everyone with a driver login (plus open driver invitations as "Applicant"), with the numbers the list and profile show. */
export async function loadDrivers(c: pg.PoolClient, ctx: DCtx, o: { id?: string; archived?: boolean; teamIds?: string[] | null; applicants?: boolean } = {}): Promise<DriverRow[]> {
  const st = await loadSettings(c);
  const params: unknown[] = [];
  const where: string[] = ["u.role = 'driver'"];
  if (o.id) { params.push(o.id); where.push(`u.id = $${params.length}`); }
  else if (!o.archived) where.push("p.archived_at IS NULL AND u.disabled_at IS NULL");
  else where.push("(p.archived_at IS NOT NULL OR u.disabled_at IS NOT NULL)");
  if (o.teamIds) { params.push(o.teamIds); where.push(`p.team_id = ANY($${params.length}::uuid[])`); }
  const month = ctx.today.slice(0, 8) + "01";
  const people = (await c.query(
    `SELECT u.id, coalesce(u.display_name, u.email) AS name, u.email, u.created_at, u.disabled_at, p.phone, p.status, p.status_reason, (p.photo_data_url IS NOT NULL) AS has_photo, p.team_id, p.home_depot_id,
            p.employment_type, p.license_no, p.license_class, p.license_expiry::text AS license_expiry, p.archived_at, p.skills,
            v.id AS vehicle_id, v.name AS vehicle_name
     FROM users u JOIN driver_profiles p ON p.user_id = u.id LEFT JOIN vehicles v ON v.current_driver_id = u.id AND v.archived_at IS NULL
     WHERE ${where.join(" AND ")} ORDER BY lower(coalesce(u.display_name, u.email))`, params)).rows;
  const ids = people.map((p) => p.id as string);
  const out: DriverRow[] = [];
  if (ids.length) {
    const from30 = new Date(ctx.now.getTime() - SCORE_DAYS * 86_400_000).toISOString();
    const stats = new Map<string, Record<string, number | null>>();
    for (const r of (await c.query(
      `SELECT driver_id AS id,
              count(*) FILTER (WHERE status = 'completed')::int AS done, count(*)::int AS assigned,
              avg(rating)::float8 AS rating, avg(cleanliness)::float8 AS clean,
              100.0 * count(*) FILTER (WHERE on_time) / nullif(count(*) FILTER (WHERE on_time IS NOT NULL), 0) AS on_time,
              coalesce(sum(distance_m) FILTER (WHERE status = 'completed'), 0)::float8 / 1000 AS km
       FROM portal_trips WHERE driver_id = ANY($1::uuid[]) AND archived_at IS NULL AND started_at >= $2 GROUP BY 1`, [ids, from30])).rows) stats.set(r.id, r);
    const monthly = new Map<string, { trips: number; revenue: number }>();
    for (const r of (await c.query(
      `SELECT driver_id AS id, count(*)::int AS trips, coalesce(sum(revenue_cents),0)::float8 AS revenue FROM portal_trips
       WHERE driver_id = ANY($1::uuid[]) AND archived_at IS NULL AND status = 'completed' AND started_at >= ($2::timestamp AT TIME ZONE $3) GROUP BY 1`, [ids, month, ctx.tz])).rows) monthly.set(r.id, { trips: r.trips, revenue: r.revenue });
    const events = new Map<string, { kind: string; severity: number }[]>();
    for (const r of (await c.query(`SELECT driver_id, kind, severity FROM driver_safety_events WHERE driver_id = ANY($1::uuid[]) AND archived_at IS NULL AND at >= $2`, [ids, from30])).rows) (events.get(r.driver_id) ?? events.set(r.driver_id, []).get(r.driver_id)!).push(r);
    const docs = new Map<string, { expired: number; expiring: number; next: string | null; legal: string[] }>();
    for (const r of (await c.query(`SELECT owner_id, kind, expires_on::text AS e, remind_days FROM documents WHERE owner_kind = 'driver' AND owner_id = ANY($1::uuid[]) AND archived_at IS NULL AND expires_on IS NOT NULL`, [ids])).rows) {
      const s = docStatus(r.e, ctx.today, r.remind_days);
      const d = docs.get(r.owner_id) ?? docs.set(r.owner_id, { expired: 0, expiring: 0, next: null, legal: [] }).get(r.owner_id)!;
      if (s.state === "expired") { d.expired++; if (DRIVER_LEGAL_DOC.test(r.kind)) d.legal.push(r.kind); } else if (s.state === "expiring") d.expiring++;
      if (!d.next || r.e < d.next) d.next = r.e;
    }
    const steps = new Map<string, Map<string, string>>();
    for (const r of (await c.query(`SELECT driver_id, step, status FROM driver_onboarding_steps WHERE driver_id = ANY($1::uuid[])`, [ids])).rows) (steps.get(r.driver_id) ?? steps.set(r.driver_id, new Map()).get(r.driver_id)!).set(r.step, r.status);
    const courses = new Map<string, number>();
    for (const r of (await c.query(`SELECT driver_id, count(*)::int AS n FROM driver_trainings WHERE driver_id = ANY($1::uuid[]) AND archived_at IS NULL AND required AND (completed_on IS NULL OR (expires_on IS NOT NULL AND expires_on < $2::date)) GROUP BY 1`, [ids, ctx.today])).rows) courses.set(r.driver_id, r.n);
    const onTrip = new Set<string>();
    for (const r of (await c.query(`SELECT DISTINCT driver_id FROM jobs WHERE driver_id = ANY($1::uuid[]) AND status IN ('started','arrived')`, [ids])).rows) onTrip.add(r.driver_id);
    const last = new Map<string, Date>();
    for (const r of (await c.query(`SELECT driver_id, max(t) AS t FROM (SELECT driver_id, max(coalesce(ended_at, started_at)) AS t FROM portal_trips WHERE driver_id = ANY($1::uuid[]) GROUP BY 1 UNION ALL SELECT driver_id, max(coalesce(ended_at, started_at)) FROM shifts WHERE driver_id = ANY($1::uuid[]) GROUP BY 1) x GROUP BY 1`, [ids])).rows) last.set(r.driver_id, r.t);
    const hoursBad = new Map<string, number>();
    for (const r of (await c.query(`SELECT driver_id, count(*)::int AS n FROM shifts WHERE driver_id = ANY($1::uuid[]) AND overtime_status IN ('pending') AND started_at >= $2 GROUP BY 1`, [ids, from30])).rows) hoursBad.set(r.driver_id, r.n);
    const rate = await rateCards(c, ids);
    const earned = new Map<string, number>();
    for (const r of (await c.query(
      `SELECT driver_id AS id, coalesce(sum(amount_cents),0)::float8 AS v FROM portal_pay_lines
       WHERE driver_id = ANY($1::uuid[]) AND archived_at IS NULL AND approval = 'approved' AND kind IN ('earning','addon','tip','toll','bonus','adjustment') AND line_date >= $2::date GROUP BY 1`, [ids, month.slice(0, 10)])).rows) earned.set(r.id, r.v);

    for (const p of people) {
      const s = stats.get(p.id) ?? {};
      const ev = events.get(p.id) ?? [];
      const safety = s.assigned || ev.length ? safetyScore(ev, Number(s.km ?? 0)) : null;
      const acceptance = s.assigned ? Math.round((100 * Number(s.done)) / Number(s.assigned)) : null;
      const sc = portalDriverScore({ onTimePct: s.on_time == null ? null : Number(s.on_time), safetyScore: safety, ratingAvg: s.rating == null ? null : Number(s.rating), acceptancePct: acceptance, cleanlinessAvg: s.clean == null ? null : Number(s.clean) }, st.weights);
      const d = docs.get(p.id) ?? { expired: 0, expiring: 0, next: null, legal: [] };
      const licExp = p.license_expiry ? docStatus(p.license_expiry, ctx.today, 30) : null;
      if (licExp?.state === "expired") { d.expired++; d.legal.push("Driver licence"); } else if (licExp?.state === "expiring") d.expiring++;
      if (p.license_expiry && (!d.next || p.license_expiry < d.next)) d.next = p.license_expiry;
      const stepMap = steps.get(p.id) ?? new Map();
      const requiredOpen = st.requiredSteps.filter((k) => stepMap.get(k) !== "approved");
      const archived = !!p.archived_at || !!p.disabled_at;
      const stored = p.status as string;
      const status: DriverStatus = archived ? "archived" : stored === "active" && onTrip.has(p.id) ? "on_trip" : (stored as DriverStatus);
      const blocked = driverBlockers({ status: stored, archived, requiredOpen: requiredOpen.map(stepLabel), legalDocsExpired: d.legal });
      const lastAct = last.get(p.id);
      out.push({
        id: p.id, name: p.name, email: p.email, phone: p.phone, status, storedStatus: stored, statusReason: p.status_reason, hasPhoto: p.has_photo, teamId: p.team_id, homeDepotId: p.home_depot_id,
        employmentType: p.employment_type, licenseNo: p.license_no, licenseClass: p.license_class, licenseExpiry: p.license_expiry, vehicleId: p.vehicle_id, vehicleName: p.vehicle_name,
        rateCardId: rate.get(p.id)?.id ?? null, rateCardName: rate.get(p.id)?.name ?? null,
        rating: s.rating == null ? null : Math.round(Number(s.rating) * 100) / 100, onTimePct: s.on_time == null ? null : Math.round(Number(s.on_time)), score: sc.score, safety,
        tripsMonth: monthly.get(p.id)?.trips ?? 0, revenueMonthCents: monthly.get(p.id)?.revenue ?? 0, earningsMonthCents: earned.get(p.id) ?? 0,
        docs: { expired: d.expired, expiring: d.expiring, nextExpiry: d.next },
        compliance: complianceScore({ expiredDocs: d.expired, expiringDocs: d.expiring, missingCourses: courses.get(p.id) ?? 0, hoursViolations: hoursBad.get(p.id) ?? 0, onboardingIncomplete: stored === "onboarding" }),
        onboarding: { done: ONBOARDING_STEPS.filter((x) => stepMap.get(x.key) === "approved").length, total: ONBOARDING_STEPS.length, requiredOpen },
        blockedReasons: blocked, lastActive: lastAct ? new Date(lastAct).toISOString() : null, createdAt: p.created_at, archivedAt: p.archived_at ?? (p.disabled_at ?? null), tags: p.skills ?? [],
      });
    }
  }
  if (o.applicants !== false && !o.id && !o.archived && !o.teamIds) {
    for (const r of (await c.query(`SELECT id, email, created_at, team_id FROM invites WHERE role = 'driver' AND accepted_at IS NULL AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`)).rows) {
      out.push({
        id: `invite:${r.id}`, inviteId: r.id, applicant: true, name: r.email, email: r.email, phone: null, status: "applicant", storedStatus: "applicant", statusReason: null, hasPhoto: false, teamId: r.team_id, homeDepotId: null, employmentType: "employee",
        licenseNo: null, licenseClass: null, licenseExpiry: null, vehicleId: null, vehicleName: null, rateCardId: null, rateCardName: null, rating: null, onTimePct: null, score: null, safety: null, tripsMonth: 0, revenueMonthCents: 0, earningsMonthCents: null,
        docs: { expired: 0, expiring: 0, nextExpiry: null }, compliance: 0, onboarding: { done: 0, total: ONBOARDING_STEPS.length, requiredOpen: [] }, blockedReasons: ["Has not signed up yet"], lastActive: null, createdAt: r.created_at, archivedAt: null, tags: [],
      });
    }
  }
  return out;
}

export const stepLabel = (k: string) => ONBOARDING_STEPS.find((s) => s.key === k)?.label ?? k;

/** The rate card each driver is paid on today: a card assigned to that driver by name, else the company-wide default pay card. */
async function rateCards(c: pg.PoolClient, ids: string[]): Promise<Map<string, { id: string; name: string }>> {
  const m = new Map<string, { id: string; name: string }>();
  for (const r of (await c.query(
    `SELECT DISTINCT ON (a.target) a.target AS driver_id, k.id, k.name FROM rate_card_assignments a JOIN portal_rate_cards k ON k.id = a.card_id
     WHERE a.kind = 'driver' AND k.kind = 'driver' AND a.target = ANY($1::text[]) AND a.archived_at IS NULL AND k.archived_at IS NULL
       AND a.starts_on <= current_date AND (a.ends_on IS NULL OR a.ends_on >= current_date) ORDER BY a.target, a.starts_on DESC`, [ids])).rows) m.set(r.driver_id, { id: r.id, name: r.name });
  const dflt = (await c.query(
    `SELECT k.id, k.name FROM rate_card_assignments a JOIN portal_rate_cards k ON k.id = a.card_id WHERE a.kind = 'all' AND k.kind = 'driver' AND a.archived_at IS NULL AND k.archived_at IS NULL
       AND a.starts_on <= current_date AND (a.ends_on IS NULL OR a.ends_on >= current_date) ORDER BY a.starts_on DESC LIMIT 1`)).rows[0];
  if (dflt) for (const id of ids) if (!m.has(id)) m.set(id, { id: dflt.id, name: `${dflt.name} (company default)` });
  return m;
}

/** A driver who is suspended, still onboarding, archived or has an expired licence cannot be given routes or start a shift. */
export async function assertDriverAvailable(c: pg.PoolClient, driverId: string, ctx: DCtx): Promise<void> {
  const d = (await loadDrivers(c, ctx, { id: driverId, applicants: false }))[0];
  if (d && d.blockedReasons.length) throw new ConflictException({ message: `${d.name} cannot be given work: ${d.blockedReasons.join("; ")}`, code: "driver_blocked", reasons: d.blockedReasons });
}

/** Make sure a driver has the seven checklist rows. */
export async function ensureSteps(c: pg.PoolClient, orgId: string, driverId: string): Promise<void> {
  await c.query(`INSERT INTO driver_onboarding_steps (org_id, driver_id, step) SELECT $1, $2, s FROM unnest($3::text[]) s ON CONFLICT (driver_id, step) DO NOTHING`, [orgId, driverId, ONBOARDING_STEPS.map((s) => s.key)]);
}
