import { BadRequestException, Body, ConflictException, Controller, Get, HttpException, Inject, NotFoundException, Param, Post, Put, Query, Req, Res } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import type { Response } from "express";
import { emit } from "../automation/events.js";
import type { AuthedRequest } from "../auth/auth.guard.js";
import type { Geocoder } from "../dispatch/geocoder.js";
import { event, loadJob, unplace } from "../dispatch/jobs.service.js";
import { withDefaults } from "../org/settings.js";
import { zonedToEpoch } from "../plan/time.js";
import { GEOCODER, JWT_SECRET, PG_POOL } from "../tokens.js";
import { estimateQuote, round2 } from "./invoices.js";
import { ensureJobLink, sha256, TOKEN_RE } from "./links.js";
import { customerOptions } from "./settings.js";

const hits = new Map<string, { n: number; reset: number }>();
/** For tests: forget every count. */
export const resetLimits = () => hits.clear();
/** At most `max` calls per key per window. Public pages have no sign-in, so every write is limited. */
export function limit(key: string, max: number, windowMs = 60_000): void {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { if (hits.size > 10_000) hits.clear(); hits.set(key, { n: 1, reset: now + windowMs }); return; }
  if (++h.n > max) throw new HttpException("too many requests, please try again in a little while", 429);
}
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const text = (v: unknown, max: number, what: string, required = false): string | null => {
  if (v == null || v === "") { if (required) throw new BadRequestException(`${what} is required`); return null; }
  if (typeof v !== "string" || v.length > max) throw new BadRequestException(`${what} must be text up to ${max} characters`);
  return v.trim() || null;
};
const firstName = (s: string | null) => (s ? s.trim().split(/\s+/)[0]! : null);

interface Link { orgId: string; jobId: string }

/** What a customer can see and do with the link they were sent: follow the order, change it, message the office, rate it. */
@Controller("public")
export class PublicJobController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(JWT_SECRET) private readonly secret: string, @Inject(GEOCODER) private readonly geocoder: Geocoder | null) {}

  private async link(req: AuthedRequest, token: string, perMinute = 60, action = "view"): Promise<Link> {
    limit(`job:${action}:${req.ip ?? "?"}`, perMinute);
    if (!TOKEN_RE.test(token)) throw new NotFoundException();
    const l = (await this.pool.query<{ org_id: string; job_id: string }>("SELECT org_id, job_id FROM resolve_job_link($1)", [sha256(token)])).rows[0];
    if (!l) throw new NotFoundException();
    return { orgId: l.org_id, jobId: l.job_id };
  }

  /** Whether the customer may still change this order, and why not. */
  private static changeable(job: { status: string; window_start: Date | null }, opt: ReturnType<typeof customerOptions>, now = Date.now()): string | null {
    if (!["unassigned", "assigned"].includes(job.status)) return job.status === "done" ? "this order is already delivered" : job.status === "cancelled" ? "this order is cancelled" : "the driver has already started";
    if (job.window_start && now > job.window_start.getTime() - opt.portal.cutoffMin * 60_000) return "it is too close to the delivery time to change it here";
    return null;
  }

  @Get("job/:token")
  async view(@Req() req: AuthedRequest, @Param("token") token: string) {
    const { orgId, jobId } = await this.link(req, token);
    return withOrg(this.pool, orgId, async (c) => {
      const org = (await c.query("SELECT coalesce(brand_name, name) AS name, brand_color AS color, logo_data_url AS logo, locale, timezone, slug, settings FROM organizations WHERE id = $1", [orgId])).rows[0];
      const j = (await c.query(
        `SELECT id, ref, title, type, status, address, lat, lng, customer_name, scheduled_date::text AS date, window_start, window_end, customer_instructions, driver_id, vehicle_id, route_id, stop_id, price, parent_job_id
         FROM jobs WHERE id = $1`, [jobId])).rows[0];
      if (!j) throw new NotFoundException();
      const opt = customerOptions(org.settings);
      const stop = j.stop_id ? (await c.query("SELECT status, eta, arrived_at, departed_at, sequence, route_id FROM stops WHERE id = $1", [j.stop_id])).rows[0] : null;
      let driver = null, vehicle = null, live = null;
      if (opt.portal.showDriver && j.driver_id && ["assigned", "started", "arrived"].includes(j.status)) {
        const d = (await c.query("SELECT split_part(coalesce(u.display_name, u.email), ' ', 1) AS name, dp.photo_data_url AS photo FROM users u LEFT JOIN driver_profiles dp ON dp.user_id = u.id WHERE u.id = $1", [j.driver_id])).rows[0];
        driver = d ? { name: d.name, photo: d.photo } : null;
        const v = j.vehicle_id ? (await c.query("SELECT name, kind, plate, color, make, model FROM vehicles WHERE id = $1", [j.vehicle_id])).rows[0] : null;
        vehicle = v ? { name: v.name, kind: v.kind, plate: v.plate, color: v.color, make: v.make, model: v.model } : null;
      }
      if (stop && ["pending", "arrived"].includes(stop.status) && j.route_id && ["assigned", "started", "arrived"].includes(j.status)) {
        const route = (await c.query("SELECT status, vehicle_id FROM routes WHERE id = $1", [j.route_id])).rows[0];
        if (route?.status === "in_progress" && route.vehicle_id) {
          const pos = (await c.query("SELECT lp.lat, lp.lng, lp.heading, lp.time FROM latest_positions lp JOIN devices d ON d.id = lp.device_id WHERE d.vehicle_id = $1 ORDER BY lp.time DESC LIMIT 1", [route.vehicle_id])).rows[0];
          const ahead = (await c.query("SELECT count(*)::int AS n FROM stops WHERE route_id = $1 AND sequence < $2 AND status IN ('pending','arrived')", [j.route_id, stop.sequence])).rows[0].n;
          live = { stopsAway: ahead, eta: stop.eta, position: pos ? { lat: pos.lat, lng: pos.lng, heading: pos.heading, time: pos.time } : null };
        }
      }
      const proofs = j.status === "done" && j.stop_id ? (await c.query("SELECT id, kind, taken_at AS \"takenAt\" FROM proofs WHERE stop_id = $1 ORDER BY taken_at", [j.stop_id])).rows : [];
      const deliveredAt = j.status === "done" ? stop?.departed_at ?? stop?.arrived_at ?? null : null;
      const messages = (await c.query("SELECT id, sender_kind AS \"from\", body, created_at AS \"at\" FROM messages WHERE thread_kind = 'customer' AND thread_id = $1 ORDER BY created_at LIMIT 100", [jobId])).rows;
      const feedback = (await c.query("SELECT csat, nps, comment FROM feedback WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1", [jobId])).rows[0] ?? null;
      const blocked = PublicJobController.changeable(j, opt);
      const prefs = j.customer_name !== undefined ? (await c.query("SELECT email_on AS \"emailOn\", sms_on AS \"smsOn\", muted_events AS \"mutedEvents\", locale FROM customer_prefs WHERE contact = (SELECT lower(coalesce(customer_email, customer_phone)) FROM jobs WHERE id = $1)", [jobId])).rows[0] ?? { emailOn: true, smsOn: true, mutedEvents: [], locale: null } : null;
      return {
        org: { name: org.name, color: org.color, logo: org.logo, locale: org.locale, slug: org.slug, whiteLabel: withDefaults(org.settings).platform.whiteLabel, widgetOrigins: withDefaults(org.settings).platform.widgetOrigins },
        job: { ref: j.ref, title: j.title, type: j.type, status: j.status, address: j.address, lat: j.lat, lng: j.lng, customer: firstName(j.customer_name), date: j.date, windowStart: j.window_start, windowEnd: j.window_end, instructions: j.customer_instructions, deliveredAt, isReturn: !!j.parent_job_id },
        driver, vehicle, live, proofs, messages, feedback, prefs,
        can: { reschedule: opt.portal.allowReschedule && !blocked, cancel: opt.portal.allowCancel && !blocked, why: blocked, instructions: opt.portal.allowInstructions && !["done", "cancelled", "failed"].includes(j.status), returns: opt.portal.allowReturns && j.status === "done", rate: ["done", "failed"].includes(j.status) },
        slots: opt.portal.slots,
      };
    });
  }

  /** Which delivery windows are open on which days (full ones are marked). */
  @Get("job/:token/slots")
  async slots(@Req() req: AuthedRequest, @Param("token") token: string) {
    const { orgId } = await this.link(req, token);
    return withOrg(this.pool, orgId, (c) => this.openSlots(c));
  }

  private async openSlots(c: pg.PoolClient) {
    const org = (await c.query("SELECT timezone, settings, (now() AT TIME ZONE timezone)::date::text AS today FROM organizations")).rows[0];
    const opt = customerOptions(org.settings);
    const out: { date: string; slots: { index: number; label: string; start: string; end: string; full: boolean }[] }[] = [];
    for (let d = 1; d <= opt.portal.horizonDays; d++) {
      const date = new Date(Date.parse(`${org.today}T12:00:00Z`) + d * 86_400_000).toISOString().slice(0, 10);
      if ([0].includes(new Date(`${date}T12:00:00Z`).getUTCDay())) continue; // no Sunday slots offered by default
      const slots = [];
      for (const [index, s] of opt.portal.slots.entries()) {
        const start = new Date(zonedToEpoch(date, s.start, org.timezone));
        const used = (await c.query("SELECT count(*)::int AS n FROM jobs WHERE window_start = $1 AND status NOT IN ('cancelled','failed')", [start])).rows[0].n;
        slots.push({ index, label: s.label, start: s.start, end: s.end, full: used >= opt.portal.slotCapacity });
      }
      out.push({ date, slots });
    }
    return out;
  }

  @Post("job/:token/reschedule")
  async reschedule(@Req() req: AuthedRequest, @Param("token") token: string, @Body() body: { date?: unknown; slot?: unknown }) {
    const { orgId, jobId } = await this.link(req, token, 20, "reschedule");
    if (typeof body?.date !== "string" || !DATE.test(body.date)) throw new BadRequestException("choose a day");
    const day: string = body.date;
    const slotIdx = body.slot == null || body.slot === "" ? null : Number(body.slot);
    return withOrg(this.pool, orgId, async (c) => {
      const org = (await c.query("SELECT timezone, settings, (now() AT TIME ZONE timezone)::date::text AS today FROM organizations")).rows[0];
      const opt = customerOptions(org.settings);
      const job = await loadJob(c, jobId, true);
      if (!opt.portal.allowReschedule) throw new ConflictException("changing the time is switched off for this company");
      const why = PublicJobController.changeable(job, opt);
      if (why) throw new ConflictException(why);
      const days = (Date.parse(`${day}T12:00:00Z`) - Date.parse(`${org.today}T12:00:00Z`)) / 86_400_000;
      if (!(days >= 0 && days <= opt.portal.horizonDays)) throw new BadRequestException(`choose a day in the next ${opt.portal.horizonDays} days`);
      let ws: Date | null = null, we: Date | null = null;
      if (slotIdx !== null) {
        const slot = opt.portal.slots[slotIdx];
        if (!slot) throw new BadRequestException("unknown time window");
        ws = new Date(zonedToEpoch(day, slot.start, org.timezone)); we = new Date(zonedToEpoch(day, slot.end, org.timezone));
        const used = (await c.query("SELECT count(*)::int AS n FROM jobs WHERE window_start = $1 AND status NOT IN ('cancelled','failed') AND id <> $2", [ws, jobId])).rows[0].n;
        if (used >= opt.portal.slotCapacity) throw new ConflictException("that time window is full, please choose another");
      }
      await unplace(c, job);
      await c.query("UPDATE jobs SET scheduled_date = $2, window_start = $3, window_end = $4, status = 'unassigned', driver_id = NULL, vehicle_id = NULL, reason_code = 'customer_request', updated_at = now() WHERE id = $1", [jobId, day, ws, we]);
      await event(c, orgId, jobId, "rescheduled", null, { from: job.scheduled_date, to: day, reasonCode: "customer_request", by: "customer" });
      await c.query("INSERT INTO customer_requests (org_id, job_id, kind, detail) VALUES ($1,$2,'reschedule',$3)", [orgId, jobId, JSON.stringify({ date: day, slot: slotIdx })]);
      await this.tellOffice(c, orgId, jobId, `A customer moved "${job.title}" to ${day}`);
      return { ok: true };
    });
  }

  @Post("job/:token/cancel")
  async cancel(@Req() req: AuthedRequest, @Param("token") token: string, @Body() body: { note?: unknown }) {
    const { orgId, jobId } = await this.link(req, token, 10, "cancel");
    const note = text(body?.note, 300, "note");
    return withOrg(this.pool, orgId, async (c) => {
      const opt = customerOptions((await c.query("SELECT settings FROM organizations")).rows[0].settings);
      const job = await loadJob(c, jobId, true);
      if (!opt.portal.allowCancel) throw new ConflictException("cancelling here is switched off for this company, please contact them");
      const why = PublicJobController.changeable(job, opt);
      if (why) throw new ConflictException(why);
      await unplace(c, job);
      await c.query("UPDATE jobs SET status = 'cancelled', reason_code = 'customer_cancelled', reason_note = $2, updated_at = now() WHERE id = $1", [jobId, note]);
      await event(c, orgId, jobId, "cancelled", null, { reasonCode: "customer_cancelled", note, by: "customer" });
      await c.query("INSERT INTO customer_requests (org_id, job_id, kind, detail) VALUES ($1,$2,'cancel',$3)", [orgId, jobId, JSON.stringify({ note })]);
      await this.tellOffice(c, orgId, jobId, `A customer cancelled "${job.title}"`);
      return { ok: true };
    });
  }

  @Put("job/:token/instructions")
  async instructions(@Req() req: AuthedRequest, @Param("token") token: string, @Body() body: { text?: unknown }) {
    const { orgId, jobId } = await this.link(req, token, 20, "instructions");
    const t = text(body?.text, 500, "instructions");
    return withOrg(this.pool, orgId, async (c) => {
      const opt = customerOptions((await c.query("SELECT settings FROM organizations")).rows[0].settings);
      const job = await loadJob(c, jobId, true);
      if (!opt.portal.allowInstructions || ["done", "cancelled", "failed"].includes(job.status)) throw new ConflictException("instructions can no longer be changed");
      await c.query("UPDATE jobs SET customer_instructions = $2, updated_at = now() WHERE id = $1", [jobId, t]);
      await c.query("INSERT INTO customer_requests (org_id, job_id, kind, detail) VALUES ($1,$2,'instructions',$3)", [orgId, jobId, JSON.stringify({ text: t })]);
      if (job.driver_id && t) await c.query("INSERT INTO messages (org_id, thread_kind, thread_id, sender_kind, body, job_id) VALUES ($1,'driver',$2,'system',$3,$4)", [orgId, job.driver_id, `Customer note for ${job.title}: ${t}`, jobId]);
      return { ok: true };
    });
  }

  /** Ask for a return (take something back) or a pickup after a delivery. This makes a new job for the office to schedule. */
  @Post("job/:token/return")
  async returns(@Req() req: AuthedRequest, @Param("token") token: string, @Body() body: { kind?: unknown; date?: unknown; slot?: unknown; note?: unknown }) {
    const { orgId, jobId } = await this.link(req, token, 5, "return");
    const kind = body?.kind === "pickup" ? "pickup" : "return";
    const note = text(body?.note, 500, "note");
    const date = typeof body?.date === "string" && DATE.test(body.date) ? body.date : null;
    return withOrg(this.pool, orgId, async (c) => {
      const org = (await c.query("SELECT timezone, settings FROM organizations")).rows[0];
      const opt = customerOptions(org.settings);
      const job = await loadJob(c, jobId, true);
      if (!opt.portal.allowReturns) throw new ConflictException("returns are not available here, please contact the company");
      if (job.status !== "done") throw new ConflictException("a return can be requested after the delivery");
      const open = (await c.query("SELECT 1 FROM jobs WHERE parent_job_id = $1 AND status NOT IN ('done','cancelled','failed')", [jobId])).rowCount;
      if (open) throw new ConflictException("a return is already requested for this order");
      let ws: Date | null = null, we: Date | null = null;
      const slot = body?.slot == null || body.slot === "" ? null : opt.portal.slots[Number(body.slot)];
      if (date && slot) { ws = new Date(zonedToEpoch(date, slot.start, org.timezone)); we = new Date(zonedToEpoch(date, slot.end, org.timezone)); }
      const row = (await c.query(
        `INSERT INTO jobs (org_id, type, title, customer_name, customer_phone, customer_email, address, lat, lng, scheduled_date, window_start, window_end, notes, source, parent_job_id, ref)
         SELECT org_id, 'pickup', $2 || title, customer_name, customer_phone, customer_email, address, lat, lng, $3, $4, $5, $6, 'return', id, CASE WHEN ref IS NULL THEN NULL ELSE ref || '-R' END FROM jobs WHERE id = $1 RETURNING id`,
        [jobId, kind === "return" ? "Return: " : "Pickup: ", date, ws, we, note ? `Customer request: ${note}` : null])).rows[0];
      await c.query("INSERT INTO customer_requests (org_id, job_id, kind, detail) VALUES ($1,$2,$3,$4)", [orgId, jobId, kind, JSON.stringify({ date, note, newJobId: row.id })]);
      await this.tellOffice(c, orgId, row.id, `A customer asked for a ${kind}: "${job.title}"`);
      return { ok: true };
    });
  }

  @Post("job/:token/message")
  async message(@Req() req: AuthedRequest, @Param("token") token: string, @Body() body: { body?: unknown }) {
    const { orgId, jobId } = await this.link(req, token, 10, "message");
    const t = text(body?.body, 1000, "message", true)!;
    return withOrg(this.pool, orgId, async (c) => {
      const recent = (await c.query("SELECT count(*)::int AS n FROM messages WHERE thread_kind = 'customer' AND thread_id = $1 AND sender_kind = 'customer' AND created_at > now() - interval '1 hour'", [jobId])).rows[0].n;
      if (recent >= 20) throw new HttpException("please wait a little before sending more messages", 429);
      const m = (await c.query("INSERT INTO messages (org_id, thread_kind, thread_id, sender_kind, body, job_id) VALUES ($1,'customer',$2,'customer',$3,$2) RETURNING id, created_at AS at", [orgId, jobId, t])).rows[0];
      await emit(c, orgId, "message.received", "job", jobId, { from: "customer", jobId, body: t });
      return { ...m, from: "customer", body: t };
    });
  }

  @Post("job/:token/feedback")
  async feedback(@Req() req: AuthedRequest, @Param("token") token: string, @Body() body: { csat?: unknown; nps?: unknown; comment?: unknown }) {
    const { orgId, jobId } = await this.link(req, token, 10, "feedback");
    const score = (v: unknown, lo: number, hi: number, what: string) => { if (v == null || v === "") return null; const x = Number(v); if (!Number.isInteger(x) || x < lo || x > hi) throw new BadRequestException(`${what} must be a whole number from ${lo} to ${hi}`); return x; };
    const csat = score(body?.csat, 1, 5, "csat"), nps = score(body?.nps, 0, 10, "nps");
    if (csat == null && nps == null) throw new BadRequestException("give a satisfaction score (1 to 5) or a recommend score (0 to 10)");
    const comment = text(body?.comment, 2000, "comment");
    return withOrg(this.pool, orgId, async (c) => {
      const job = await loadJob(c, jobId, true);
      if (!["done", "failed"].includes(job.status)) throw new ConflictException("you can rate this once it has been delivered");
      const old = (await c.query("SELECT id FROM feedback WHERE job_id = $1", [jobId])).rows[0];
      if (old) await c.query("UPDATE feedback SET csat = $2, nps = $3, comment = $4 WHERE id = $1", [old.id, csat, nps, comment]);
      else await c.query("INSERT INTO feedback (org_id, job_id, route_id, driver_id, csat, nps, comment, source) VALUES ($1,$2,$3,$4,$5,$6,$7,'link')", [orgId, jobId, job.route_id, job.driver_id, csat, nps, comment]);
      await emit(c, orgId, "feedback.received", "job", jobId, { jobId, csat, nps, comment: comment ?? "" });
      return { ok: true };
    });
  }

  @Put("job/:token/prefs")
  async prefs(@Req() req: AuthedRequest, @Param("token") token: string, @Body() body: { emailOn?: unknown; smsOn?: unknown; mutedEvents?: unknown; locale?: unknown }) {
    const { orgId, jobId } = await this.link(req, token, 20, "prefs");
    const muted = body?.mutedEvents == null ? [] : body.mutedEvents;
    if (!Array.isArray(muted) || muted.length > 12 || !muted.every((m) => typeof m === "string" && /^[a-z_]{3,20}$/.test(m))) throw new BadRequestException("mutedEvents must be a short list of message names");
    const locale = body?.locale === "fr" ? "fr" : body?.locale === "en" ? "en" : null;
    return withOrg(this.pool, orgId, async (c) => {
      const j = (await c.query("SELECT lower(coalesce(customer_email, customer_phone)) AS contact FROM jobs WHERE id = $1", [jobId])).rows[0];
      if (!j?.contact) throw new ConflictException("there is no email or phone on this order");
      await c.query(
        `INSERT INTO customer_prefs (org_id, contact, email_on, sms_on, muted_events, locale) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (org_id, contact) DO UPDATE SET email_on = EXCLUDED.email_on, sms_on = EXCLUDED.sms_on, muted_events = EXCLUDED.muted_events, locale = EXCLUDED.locale, updated_at = now()`,
        [orgId, j.contact.replace(/[^\w@+.\-]/g, ""), body?.emailOn !== false, body?.smsOn !== false, muted, locale]);
      return { ok: true };
    });
  }

  /** The proof-of-delivery photo or signature, for the person whose order it is. */
  @Get("job/:token/proof/:id")
  async proof(@Req() req: AuthedRequest, @Param("token") token: string, @Param("id") id: string, @Res() res: Response) {
    const { orgId, jobId } = await this.link(req, token, 120, "proof");
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new NotFoundException();
    const row = await withOrg(this.pool, orgId, async (c) => (await c.query("SELECT p.content_type, p.data FROM proofs p JOIN jobs j ON j.stop_id = p.stop_id WHERE p.id = $1 AND j.id = $2 AND j.status = 'done'", [id, jobId])).rows[0]);
    if (!row) throw new NotFoundException();
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "private, max-age=600");
    res.type(row.content_type).send(row.data);
  }

  /** A note for the office: it shows in the alerts list so nobody misses a customer change. */
  private async tellOffice(c: pg.PoolClient, orgId: string, jobId: string, title: string): Promise<void> {
    await c.query("INSERT INTO alerts (org_id, kind, severity, title, detail, subject_kind, subject_id, dedupe_key) VALUES ($1,'customer_request','info',$2,'{}',$3,$4,$5)", [orgId, title, "job", jobId, `cust:${jobId}:${Date.now()}`]);
  }

  // ---- the organization's public pages: booking, status, help ----

  private async org(req: AuthedRequest, slug: string, perMinute = 60, action = "read"): Promise<string> {
    limit(`org:${action}:${req.ip ?? "?"}`, perMinute);
    if (!/^[a-z0-9][a-z0-9-]{0,48}$/.test(slug)) throw new NotFoundException();
    const r = (await this.pool.query<{ id: string }>("SELECT id FROM resolve_org_slug($1)", [slug])).rows[0];
    if (!r) throw new NotFoundException();
    return r.id;
  }

  @Get("org/:slug")
  async orgInfo(@Req() req: AuthedRequest, @Param("slug") slug: string) {
    const orgId = await this.org(req, slug);
    return withOrg(this.pool, orgId, async (c) => {
      const o = (await c.query("SELECT coalesce(brand_name, name) AS name, brand_color AS color, logo_data_url AS logo, locale, settings FROM organizations")).rows[0];
      const opt = customerOptions(o.settings);
      const s = withDefaults(o.settings);
      return {
        name: o.name, color: o.color, logo: o.logo, locale: o.locale, whiteLabel: s.platform.whiteLabel, currency: s.currency,
        booking: opt.booking.enabled ? { enabled: true, requirePhone: opt.booking.requirePhone, slots: opt.portal.slots, taxRatePct: s.taxRatePct, horizonDays: opt.portal.horizonDays } : { enabled: false },
        statusPage: opt.publicStatus, faq: (await c.query("SELECT count(*)::int AS n FROM faq_items WHERE published")).rows[0].n > 0,
      };
    });
  }

  private async geo(q: string): Promise<{ lat: number; lng: number; label: string } | null> {
    if (!this.geocoder) return null;
    try { const h = (await this.geocoder.search(q, 1))[0]; return h ? { lat: h.lat, lng: h.lng, label: h.label } : null; } catch { return null; }
  }

  private async quoteFor(c: pg.PoolClient, input: { address?: string | null; lat?: number | null; lng?: number | null; weightKg: number; rush: boolean }) {
    const o = (await c.query("SELECT settings FROM organizations")).rows[0];
    const opt = customerOptions(o.settings);
    const s = withDefaults(o.settings);
    let to = input.lat != null && input.lng != null ? { lat: input.lat, lng: input.lng } : null;
    if (!to && input.address) to = await this.geo(input.address);
    const depot = (await c.query<{ lat: number; lng: number }>("SELECT lat, lng FROM depots ORDER BY created_at LIMIT 1")).rows[0] ?? null;
    const q = estimateQuote(opt.booking, s.currency, { from: depot, to: to ?? { lat: 0, lng: 0 }, weightKg: input.weightKg, rush: input.rush });
    // Without a known address or depot the distance part is unknown, so only the base and weight are counted.
    const known = !!to && !!depot;
    const quote = known ? q : { ...q, distanceKm: 0, distance: 0, total: round2(Math.max(opt.booking.minimum, opt.booking.baseFee + q.weight) * (input.rush ? 1 + opt.booking.rushPct / 100 : 1)) };
    const tax = round2(quote.total * (s.taxRatePct / 100));
    return { ...quote, tax, totalWithTax: round2(quote.total + tax), estimated: true, distanceKnown: known, coords: to };
  }

  @Post("org/:slug/quote")
  async quote(@Req() req: AuthedRequest, @Param("slug") slug: string, @Body() body: { address?: unknown; lat?: unknown; lng?: unknown; weightKg?: unknown; rush?: unknown }) {
    const orgId = await this.org(req, slug, 30, "quote");
    const w = body?.weightKg == null || body.weightKg === "" ? 0 : Number(body.weightKg);
    if (!(w >= 0 && w <= 50_000)) throw new BadRequestException("weight must be between 0 and 50,000 kg");
    return withOrg(this.pool, orgId, async (c) => {
      const opt = customerOptions((await c.query("SELECT settings FROM organizations")).rows[0].settings);
      if (!opt.booking.enabled) throw new NotFoundException();
      const { coords, ...q } = await this.quoteFor(c, { address: text(body?.address, 300, "address"), lat: body?.lat == null ? null : Number(body.lat), lng: body?.lng == null ? null : Number(body.lng), weightKg: w, rush: body?.rush === true });
      void coords;
      return q;
    });
  }

  /** A customer books a delivery or pickup on the company's own page. The office sees it as a new unassigned job. */
  @Post("org/:slug/book")
  async book(@Req() req: AuthedRequest, @Param("slug") slug: string, @Body() body: Record<string, unknown>) {
    const orgId = await this.org(req, slug, 30, "book");
    limit(`book:${req.ip ?? "?"}`, 6, 3_600_000);
    if (body?.website) return { ok: true }; // a hidden field only robots fill in
    const name = text(body?.name, 120, "name", true)!;
    const email = text(body?.email, 200, "email");
    const phone = text(body?.phone, 40, "phone");
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) throw new BadRequestException("enter a valid email address");
    if (phone && !/^\+?[\d\s().-]{7,20}$/.test(phone)) throw new BadRequestException("enter a valid phone number");
    if (!email && !phone) throw new BadRequestException("give an email address or a phone number so we can reach you");
    const address = text(body?.address, 300, "address", true)!;
    const what = text(body?.description, 300, "description", true)!;
    const notes = text(body?.notes, 500, "notes");
    const type = body?.type === "pickup" ? "pickup" : "delivery";
    const w = body?.weightKg == null || body.weightKg === "" ? 0 : Number(body.weightKg);
    if (!(w >= 0 && w <= 50_000)) throw new BadRequestException("weight must be between 0 and 50,000 kg");
    const date = typeof body?.date === "string" && DATE.test(body.date) ? body.date : null;
    return withOrg(this.pool, orgId, async (c) => {
      const org = (await c.query("SELECT timezone, settings, (now() AT TIME ZONE timezone)::date::text AS today FROM organizations")).rows[0];
      const opt = customerOptions(org.settings);
      if (!opt.booking.enabled) throw new NotFoundException();
      if (opt.booking.requirePhone && !phone) throw new BadRequestException("a phone number is required");
      let ws: Date | null = null, we: Date | null = null;
      if (date) {
        const days = (Date.parse(`${date}T12:00:00Z`) - Date.parse(`${org.today}T12:00:00Z`)) / 86_400_000;
        if (!(days >= 0 && days <= opt.portal.horizonDays)) throw new BadRequestException(`choose a day in the next ${opt.portal.horizonDays} days`);
        const slot = body?.slot == null || body.slot === "" ? null : opt.portal.slots[Number(body.slot)];
        if (slot) {
          ws = new Date(zonedToEpoch(date, slot.start, org.timezone)); we = new Date(zonedToEpoch(date, slot.end, org.timezone));
          const used = (await c.query("SELECT count(*)::int AS n FROM jobs WHERE window_start = $1 AND status NOT IN ('cancelled','failed')", [ws])).rows[0].n;
          if (used >= opt.portal.slotCapacity) throw new ConflictException("that time window is full, please choose another");
        }
      }
      const q = await this.quoteFor(c, { address, lat: body?.lat == null ? null : Number(body.lat), lng: body?.lng == null ? null : Number(body.lng), weightKg: w, rush: body?.rush === true });
      const n = (await c.query<{ n: number }>("SELECT next_counter($1, 'booking') AS n", [orgId])).rows[0]!.n;
      const ref = `WEB-${String(n).padStart(4, "0")}`;
      const job = (await c.query(
        `INSERT INTO jobs (org_id, ref, type, priority, title, customer_name, customer_email, customer_phone, address, lat, lng, scheduled_date, window_start, window_end, weight_kg, notes, price, source)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'booking') RETURNING id`,
        [orgId, ref, type, body?.rush === true ? "high" : "normal", `${type === "pickup" ? "Pickup" : "Delivery"}: ${what}`.slice(0, 200), name, email, phone, address, q.coords?.lat ?? null, q.coords?.lng ?? null,
          date, ws, we, w, notes, q.total])).rows[0];
      const l = await ensureJobLink(c, orgId, job.id, this.secret);
      return { ok: true, ref, price: q.total, tax: q.tax, total: q.totalWithTax, currency: q.currency, track: `/j/${l.token}` };
    });
  }

  /** Service health for the company's own public status page, worked out from today's real jobs. */
  @Get("org/:slug/status")
  async status(@Req() req: AuthedRequest, @Param("slug") slug: string) {
    const orgId = await this.org(req, slug);
    return withOrg(this.pool, orgId, async (c) => {
      const o = (await c.query("SELECT coalesce(brand_name, name) AS name, brand_color AS color, logo_data_url AS logo, locale, settings, timezone FROM organizations")).rows[0];
      if (!customerOptions(o.settings).publicStatus) throw new NotFoundException();
      const today = (await c.query(
        `SELECT count(*)::int AS total, count(*) FILTER (WHERE status = 'done')::int AS done, count(*) FILTER (WHERE status = 'failed')::int AS failed, count(*) FILTER (WHERE status = 'cancelled')::int AS cancelled
         FROM jobs WHERE scheduled_date = (now() AT TIME ZONE $1)::date`, [o.timezone])).rows[0];
      const late = (await c.query(
        `SELECT count(*)::int AS n FROM stops s JOIN routes r ON r.id = s.route_id WHERE r.route_date = (now() AT TIME ZONE $1)::date AND s.window_end IS NOT NULL AND ((s.arrived_at IS NOT NULL AND s.arrived_at > s.window_end) OR (s.status = 'pending' AND s.window_end < now()))`, [o.timezone])).rows[0].n;
      const live = (await c.query("SELECT count(*)::int AS n FROM latest_positions WHERE time > now() - interval '15 minutes'")).rows[0].n;
      const days = (await c.query(
        `SELECT (s.window_end AT TIME ZONE $1)::date::text AS day, count(*)::int AS total, count(*) FILTER (WHERE s.arrived_at <= s.window_end)::int AS on_time
         FROM stops s WHERE s.arrived_at IS NOT NULL AND s.window_end IS NOT NULL AND s.window_end > now() - interval '30 days' GROUP BY 1 ORDER BY 1`, [o.timezone])).rows;
      const notices = (await c.query(
        `SELECT id, level, title, body, starts_at AS "startsAt", ends_at AS "endsAt" FROM status_notices WHERE starts_at > now() - interval '14 days' AND starts_at <= now() ORDER BY starts_at DESC LIMIT 20`)).rows;
      const active = notices.filter((n) => n.level !== "resolved" && (!n.endsAt || new Date(n.endsAt) > new Date()));
      const lateShare = today.total ? late / today.total : 0;
      const level = active.some((n) => n.level === "major") ? "major" : active.some((n) => n.level === "minor") || lateShare > 0.25 ? "degraded" : "operational";
      return { org: { name: o.name, color: o.color, logo: o.logo, locale: o.locale, whiteLabel: withDefaults(o.settings).platform.whiteLabel }, level, today: { ...today, late, vehiclesReporting: live }, days: days.map((d) => ({ day: d.day, total: d.total, onTimePct: Math.round((d.on_time / d.total) * 100) })), notices };
    });
  }

  @Get("org/:slug/faq")
  async faq(@Req() req: AuthedRequest, @Param("slug") slug: string, @Query("lang") lang?: string) {
    const orgId = await this.org(req, slug);
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT id, question, answer, lang FROM faq_items WHERE published AND (lang IS NULL OR $1::text IS NULL OR lang = $1) ORDER BY sort, question LIMIT 200`, [lang === "fr" ? "fr" : lang === "en" ? "en" : null]))).rows;
  }
}
