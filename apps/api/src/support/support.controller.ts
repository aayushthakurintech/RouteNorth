import { BadRequestException, Body, Controller, Get, HttpCode, Inject, NotFoundException, Param, Post, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { AuthGuard, hasPerm, type AuthedRequest } from "../auth/auth.guard.js";
import { deliver, type Providers } from "../notify/notifier.js";
import { NOTIFY, PG_POOL } from "../tokens.js";

const KINDS = ["question", "bug", "idea", "praise"];

/** Messages to the product team, and the roadmap people can vote on. */
@Controller("support")
@UseGuards(AuthGuard)
export class SupportController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(NOTIFY) private readonly notify: Providers) {}

  /** Send a question, bug report, idea or thank-you. It is stored, and emailed to SUPPORT_EMAIL when that is set. */
  @Post("requests")
  async send(@Req() req: AuthedRequest, @Body() b: { kind?: unknown; subject?: unknown; body?: unknown; page?: unknown }) {
    const kind = String(b?.kind ?? "question");
    if (!KINDS.includes(kind)) throw new BadRequestException(`kind must be ${KINDS.join(", ")}`);
    if (typeof b?.body !== "string" || !b.body.trim() || b.body.length > 4000) throw new BadRequestException("write a message of up to 4000 characters");
    const text = b.body.trim();
    const subject = typeof b.subject === "string" && b.subject.trim() ? b.subject.trim().slice(0, 160) : null;
    const page = typeof b.page === "string" ? b.page.slice(0, 200) : null;
    const { orgId, userId } = req.session!;
    const row = (await withOrg(this.pool, orgId, (c) => c.query(
      "INSERT INTO support_requests (org_id, user_id, kind, subject, body, page) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, kind, status, created_at AS \"createdAt\"",
      [orgId, /^[0-9a-f-]{36}$/.test(userId) ? userId : null, kind, subject, text, page]))).rows[0];
    const to = process.env.SUPPORT_EMAIL;
    let emailed = false;
    if (to) {
      const org = (await withOrg(this.pool, orgId, (c) => c.query("SELECT name FROM organizations WHERE id = $1", [orgId]))).rows[0];
      const r = await deliver({ id: row.id, kind: "email", target: to, label: "support" }, { subject: `[${kind}] ${subject ?? text.slice(0, 60)}`, text: `${text}\n\nFrom ${req.actor?.email} at ${org?.name}${page ? ` (page ${page})` : ""}` }, this.notify).catch(() => ({ ok: false as const, error: "failed" }));
      emailed = r.ok;
    }
    return { ...row, emailed };
  }

  /** Your own messages; managers see everyone's in the organization. */
  @Get("requests")
  async list(@Req() req: AuthedRequest) {
    const { orgId, userId } = req.session!;
    const all = hasPerm(req, "users.manage");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT r.id, r.kind, r.subject, r.body, r.status, r.reply, r.replied_at AS "repliedAt", r.created_at AS "createdAt", coalesce(u.display_name, u.email) AS "from"
       FROM support_requests r LEFT JOIN users u ON u.id = r.user_id AND u.org_id = r.org_id
       WHERE ($2 OR r.user_id = $1) ORDER BY r.created_at DESC LIMIT 100`, [userId, all]))).rows;
  }

  @Get("roadmap")
  async roadmap(@Req() req: AuthedRequest) {
    const { orgId, userId } = req.session!;
    return withOrg(this.pool, orgId, async (c) => {
      const items = await roadmapItems(c);
      const mine = new Set((await c.query("SELECT item_id FROM roadmap_votes WHERE user_id = $1", [userId])).rows.map((r) => r.item_id));
      return items.map((i) => ({ ...i, voted: mine.has(i.id) }));
    });
  }

  /** Vote for an item, or take the vote back. One vote per person. */
  @Post("roadmap/:id/vote")
  @HttpCode(200)
  async vote(@Req() req: AuthedRequest, @Param("id") id: string) {
    const { orgId, userId } = req.session!;
    if (!/^[0-9a-f-]{36}$/.test(userId)) throw new BadRequestException("sign in as a person to vote");
    return withOrg(this.pool, orgId, async (c) => {
      const item = (await c.query("SELECT status FROM roadmap_items WHERE id = $1", [id])).rows[0];
      if (!item) throw new NotFoundException();
      if (item.status === "shipped") throw new BadRequestException("this is already shipped");
      const had = (await c.query("DELETE FROM roadmap_votes WHERE user_id = $1 AND item_id = $2", [userId, id])).rowCount;
      if (!had) await c.query("INSERT INTO roadmap_votes (org_id, user_id, item_id) VALUES ($1,$2,$3)", [orgId, userId, id]);
      return { voted: !had };
    });
  }
}

async function roadmapItems(c: pg.PoolClient) {
  const items = (await c.query(
    `SELECT id, status, title_en AS "titleEn", title_fr AS "titleFr", body_en AS "bodyEn", body_fr AS "bodyFr" FROM roadmap_items ORDER BY
       CASE status WHEN 'building' THEN 0 WHEN 'planned' THEN 1 WHEN 'considering' THEN 2 ELSE 3 END, sort, id`)).rows;
  const counts = new Map((await c.query("SELECT item_id, votes::int FROM roadmap_vote_counts()")).rows.map((r) => [r.item_id as string, r.votes as number]));
  return items.map((i) => ({ ...i, votes: counts.get(i.id) ?? 0 }));
}

/** Pages anyone can read without signing in: the public roadmap and the status of the service itself. */
@Controller("public")
export class PublicSupportController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get("roadmap")
  async roadmap() {
    const c = await this.pool.connect();
    try { return await roadmapItems(c); } finally { c.release(); }
  }

  /** Is the service up? Checks the database, how fresh the GPS feed is, and lists recent incidents. */
  @Get("system-status")
  async status() {
    const started = Date.now();
    let db = true;
    let incidents: unknown[] = [];
    try { await this.pool.query("SELECT 1"); } catch { db = false; }
    const dbMs = Date.now() - started;
    if (db) {
      incidents = (await this.pool.query(
        `SELECT id, title, body, level, status, started_at AS "startedAt", resolved_at AS "resolvedAt" FROM service_incidents
         WHERE started_at > now() - interval '90 days' ORDER BY started_at DESC LIMIT 30`)).rows;
    }
    const open = (incidents as { status: string; level: string }[]).filter((i) => i.status !== "resolved");
    const level = !db || open.some((i) => i.level === "major") ? "major" : open.some((i) => i.level === "minor") ? "degraded" : "operational";
    return { level, checkedAt: new Date().toISOString(), components: [{ id: "api", ok: true }, { id: "database", ok: db, ms: dbMs }], incidents };
  }
}
