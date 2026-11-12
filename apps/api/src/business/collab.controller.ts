import { BadRequestException, Body, Controller, Delete, ForbiddenException, Get, HttpCode, Inject, NotFoundException, Param, Patch, Post, Query, Req, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import { extractMentions, handleOf, planConflicts, type Permission } from "@routenorth/shared";
import { AuthGuard, hasPerm, requireAny, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { parseUuid } from "../history/range.js";
import { PG_POOL } from "../tokens.js";
import { addNotification } from "./notifications.js";

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ENTITIES = ["job", "vehicle", "driver", "invoice", "task", "incident"] as const;
type Entity = (typeof ENTITIES)[number];
const TABLE: Record<Entity, string> = { job: "jobs", vehicle: "vehicles", driver: "users", invoice: "invoices", task: "tasks", incident: "incidents" };
const READ: Record<Entity, Permission> = { job: "routes.view", vehicle: "fleet.view", driver: "fleet.view", invoice: "customers.view", task: "routes.view", incident: "fleet.view" };
const WRITE: Record<Entity, Permission> = { job: "routes.write", vehicle: "fleet.manage", driver: "fleet.manage", invoice: "customers.manage", task: "routes.write", incident: "fleet.manage" };
const LINK: Record<Entity, (id: string) => string> = {
  job: (id) => `/jobs?open=${id}`, vehicle: () => "/fleet/vehicles", driver: () => "/drivers", invoice: () => "/invoices", task: () => "/tasks", incident: () => "/fleet/incidents",
};
const entityOf = (v: unknown): Entity => {
  if (!(ENTITIES as readonly unknown[]).includes(v)) throw new BadRequestException(`entity must be one of ${ENTITIES.join(", ")}`);
  return v as Entity;
};

/** Comments and @mentions on jobs, vehicles, drivers, invoices, tasks and incidents. */
@Controller("comments")
@UseGuards(AuthGuard)
export class CommentsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  /** People who can be mentioned, with the handle to type after "@". */
  @Get("people")
  async people(@Req() req: AuthedRequest) {
    const orgId = requireAny(req, "routes.view", "fleet.view");
    const rows = (await withOrg(this.pool, orgId, (c) => c.query(`SELECT id, email, coalesce(display_name, email) AS name, role FROM users WHERE disabled_at IS NULL AND role <> 'customer' ORDER BY name LIMIT 500`))).rows;
    return rows.map((r) => ({ id: r.id, name: r.name, role: r.role, handle: handleOf({ id: r.id, email: r.email }) }));
  }

  @Get()
  async list(@Req() req: AuthedRequest, @Query("entity") entity?: string, @Query("entityId") entityId?: string) {
    const e = entityOf(entity);
    const orgId = requirePerm(req, READ[e]);
    const id = parseUuid(String(entityId));
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT m.id, m.body, m.created_at AS "createdAt", m.user_id AS "userId", coalesce(u.display_name, u.email) AS author, m.mentions
       FROM comments m LEFT JOIN users u ON u.id = m.user_id AND u.org_id = m.org_id WHERE m.entity = $1 AND m.entity_id = $2 ORDER BY m.created_at LIMIT 300`, [e, id]))).rows;
  }

  @Post()
  async add(@Req() req: AuthedRequest, @Body() b: { entity?: unknown; entityId?: unknown; body?: unknown }) {
    const e = entityOf(b?.entity);
    const orgId = requirePerm(req, WRITE[e]);
    const id = parseUuid(String(b?.entityId));
    const body = typeof b?.body === "string" ? b.body.trim() : "";
    if (!body || body.length > 2000) throw new BadRequestException("write a comment of up to 2000 characters");
    const me = req.session!.userId;
    return withOrg(this.pool, orgId, async (c) => {
      if (!(await c.query(`SELECT 1 FROM ${TABLE[e]} WHERE id = $1`, [id])).rowCount) throw new NotFoundException();
      const people = (await c.query<{ id: string; email: string }>("SELECT id, email FROM users WHERE disabled_at IS NULL")).rows;
      const mentions = extractMentions(body, people).filter((u) => u !== me);
      const row = (await c.query(`INSERT INTO comments (org_id, entity, entity_id, user_id, body, mentions) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, created_at AS "createdAt"`, [orgId, e, id, /^[0-9a-f-]{36}$/.test(me) ? me : null, body, mentions])).rows[0];
      const who = (await c.query("SELECT coalesce(display_name, email) AS n FROM users WHERE id = $1", [me])).rows[0]?.n ?? "Someone";
      for (const u of mentions) await addNotification(c, orgId, u, "mention", `${who} mentioned you: ${body.slice(0, 120)}`, LINK[e](id));
      return { ...row, mentions: mentions.length };
    });
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requireAny(req, "routes.write", "fleet.manage", "customers.manage");
    return withOrg(this.pool, orgId, async (c) => {
      const cur = (await c.query("SELECT user_id FROM comments WHERE id = $1", [parseUuid(id)])).rows[0];
      if (!cur) throw new NotFoundException();
      if (cur.user_id !== req.session!.userId && !hasPerm(req, "users.manage")) throw new ForbiddenException("you can only delete your own comments");
      await c.query("DELETE FROM comments WHERE id = $1", [parseUuid(id)]);
      return { ok: true };
    });
  }
}

/** A person's own notification list: mentions, tasks given to them, time-off answers. */
@Controller("notifications")
@UseGuards(AuthGuard)
export class NotificationsController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get()
  async list(@Req() req: AuthedRequest, @Query("unread") unread?: string) {
    const s = req.session!;
    return (await withOrg(this.pool, s.orgId, (c) => c.query(
      `SELECT id, kind, title, link, read_at AS "readAt", created_at AS "createdAt" FROM notifications WHERE user_id = $1 AND ($2::boolean IS NOT TRUE OR read_at IS NULL) ORDER BY created_at DESC LIMIT 100`,
      [s.userId, unread === "1"]))).rows;
  }

  @Get("count")
  async count(@Req() req: AuthedRequest) {
    const s = req.session!;
    return { unread: (await withOrg(this.pool, s.orgId, (c) => c.query("SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL", [s.userId]))).rows[0].n };
  }

  @Post("read")
  @HttpCode(200)
  async read(@Req() req: AuthedRequest, @Body() b: { ids?: unknown; all?: unknown }) {
    const s = req.session!;
    const ids = Array.isArray(b?.ids) ? b.ids.slice(0, 200).map((x) => parseUuid(String(x))) : [];
    if (!b?.all && ids.length === 0) throw new BadRequestException("give ids or all: true");
    const r = await withOrg(this.pool, s.orgId, (c) => c.query("UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::boolean OR id = ANY($3::uuid[]))", [s.userId, !!b.all, ids]));
    return { marked: r.rowCount };
  }
}

const TASK_STATUS = ["todo", "doing", "done"];
const TASK_PRIORITY = ["low", "normal", "high"];

/** To-do lists for dispatchers and managers, with an owner and a due date. */
@Controller("tasks")
@UseGuards(AuthGuard)
export class TasksController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get()
  async list(@Req() req: AuthedRequest, @Query("status") status?: string, @Query("mine") mine?: string) {
    const orgId = requirePerm(req, "routes.view");
    if (status && !TASK_STATUS.includes(status)) throw new BadRequestException("unknown status");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT t.id, t.title, t.detail, t.status, t.priority, t.due_on::text AS "dueOn", t.assignee_id AS "assigneeId", coalesce(a.display_name, a.email) AS assignee, t.job_id AS "jobId",
              t.created_at AS "createdAt", t.done_at AS "doneAt", (t.status <> 'done' AND t.due_on < current_date) AS overdue,
              (SELECT count(*)::int FROM comments m WHERE m.entity = 'task' AND m.entity_id = t.id) AS comments
       FROM tasks t LEFT JOIN users a ON a.id = t.assignee_id AND a.org_id = t.org_id
       WHERE ($1::text IS NULL OR t.status = $1) AND ($2::boolean IS NOT TRUE OR t.assignee_id = $3)
       ORDER BY (t.status = 'done'), t.due_on NULLS LAST, t.created_at DESC LIMIT 500`, [status ?? null, mine === "1", req.session!.userId]))).rows;
  }

  private fields(b: Record<string, unknown>, creating: boolean) {
    const o: Record<string, unknown> = {};
    if (creating || b.title !== undefined) {
      if (typeof b.title !== "string" || !b.title.trim() || b.title.length > 200) throw new BadRequestException("title is required (up to 200 characters)");
      o.title = b.title.trim();
    }
    if (b.detail !== undefined) { if (b.detail !== null && String(b.detail).length > 2000) throw new BadRequestException("detail is up to 2000 characters"); o.detail = b.detail || null; }
    if (b.status !== undefined) { if (!TASK_STATUS.includes(String(b.status))) throw new BadRequestException(`status must be ${TASK_STATUS.join(", ")}`); o.status = b.status; }
    if (b.priority !== undefined) { if (!TASK_PRIORITY.includes(String(b.priority))) throw new BadRequestException(`priority must be ${TASK_PRIORITY.join(", ")}`); o.priority = b.priority; }
    if (b.dueOn !== undefined) { if (b.dueOn !== null && b.dueOn !== "" && !DATE.test(String(b.dueOn))) throw new BadRequestException("dueOn must be YYYY-MM-DD"); o.due_on = b.dueOn || null; }
    if (b.assigneeId !== undefined) o.assignee_id = b.assigneeId ? parseUuid(String(b.assigneeId)) : null;
    if (b.jobId !== undefined) o.job_id = b.jobId ? parseUuid(String(b.jobId)) : null;
    return o;
  }

  @Post()
  async create(@Req() req: AuthedRequest, @Body() b: Record<string, unknown>) {
    const orgId = requirePerm(req, "routes.write");
    const f = this.fields(b ?? {}, true);
    const me = req.session!.userId;
    return withOrg(this.pool, orgId, async (c) => {
      let r;
      try {
        r = (await c.query(`INSERT INTO tasks (org_id, title, detail, status, priority, due_on, assignee_id, job_id, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, title`,
          [orgId, f.title, f.detail ?? null, f.status ?? "todo", f.priority ?? "normal", f.due_on ?? null, f.assignee_id ?? null, f.job_id ?? null, /^[0-9a-f-]{36}$/.test(me) ? me : null])).rows[0];
      } catch (e) { if ((e as { code?: string }).code === "23503") throw new BadRequestException("unknown person"); throw e; }
      if (f.assignee_id && f.assignee_id !== me) await addNotification(c, orgId, String(f.assignee_id), "task", `New task for you: ${f.title}`, "/tasks");
      return r;
    });
  }

  @Patch(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() b: Record<string, unknown>) {
    const orgId = requirePerm(req, "routes.write");
    const f = this.fields(b ?? {}, false);
    const keys = Object.keys(f);
    if (keys.length === 0) throw new BadRequestException("nothing to update");
    return withOrg(this.pool, orgId, async (c) => {
      const cur = (await c.query("SELECT assignee_id, status FROM tasks WHERE id = $1 FOR UPDATE", [parseUuid(id)])).rows[0];
      if (!cur) throw new NotFoundException();
      const sets = keys.map((k, i) => `${k} = $${i + 2}`);
      if (f.status === "done" && cur.status !== "done") sets.push("done_at = now()");
      if (f.status && f.status !== "done") sets.push("done_at = NULL");
      let r;
      try { r = await c.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $1 RETURNING id, title, status`, [parseUuid(id), ...keys.map((k) => f[k])]); }
      catch (e) { if ((e as { code?: string }).code === "23503") throw new BadRequestException("unknown person"); throw e; }
      if (f.assignee_id && f.assignee_id !== cur.assignee_id && f.assignee_id !== req.session!.userId) await addNotification(c, orgId, String(f.assignee_id), "task", `Task assigned to you: ${r.rows[0].title}`, "/tasks");
      return r.rows[0];
    });
  }

  @Delete(":id")
  @HttpCode(200)
  async remove(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requirePerm(req, "routes.write");
    const r = await withOrg(this.pool, orgId, (c) => c.query("DELETE FROM tasks WHERE id = $1", [parseUuid(id)]));
    if (!r.rowCount) throw new NotFoundException();
    return { ok: true };
  }
}

const OFF_KINDS = ["vacation", "sick", "personal", "other"];

/** Planned shifts and time off on one calendar, with clashes flagged. */
@Controller()
@UseGuards(AuthGuard)
export class ScheduleController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get("schedule")
  async schedule(@Req() req: AuthedRequest, @Query("from") from?: string, @Query("to") to?: string) {
    const orgId = requirePerm(req, "routes.view");
    if (!from || !DATE.test(from) || !to || !DATE.test(to)) throw new BadRequestException("from and to must be YYYY-MM-DD");
    const days = (Date.parse(to) - Date.parse(from)) / 86_400_000;
    if (!(days >= 0 && days <= 42)) throw new BadRequestException("choose a range of up to 6 weeks");
    return withOrg(this.pool, orgId, async (c) => {
      const tz = (await c.query<{ timezone: string }>("SELECT timezone FROM organizations WHERE id = $1", [orgId])).rows[0]!.timezone;
      const lo = new Date(`${from}T00:00:00Z`).getTime() - 86_400_000, hi = new Date(`${to}T00:00:00Z`).getTime() + 2 * 86_400_000;
      const plans = (await c.query(
        `SELECT p.id, p.driver_id AS "driverId", coalesce(u.display_name, u.email) AS driver, p.starts_at AS "startsAt", p.ends_at AS "endsAt", p.vehicle_id AS "vehicleId", v.name AS vehicle, p.note
         FROM shift_plans p JOIN users u ON u.id = p.driver_id AND u.org_id = p.org_id LEFT JOIN vehicles v ON v.id = p.vehicle_id AND v.org_id = p.org_id
         WHERE p.starts_at >= $1 AND p.starts_at < $2 ORDER BY p.starts_at`, [new Date(lo), new Date(hi)])).rows;
      const off = (await c.query(
        `SELECT o.id, o.user_id AS "userId", coalesce(u.display_name, u.email) AS person, o.kind, o.starts_on::text AS "startsOn", o.ends_on::text AS "endsOn", o.status, o.note
         FROM time_off o JOIN users u ON u.id = o.user_id AND u.org_id = o.org_id WHERE o.ends_on >= $1::date AND o.starts_on <= $2::date ORDER BY o.starts_on`, [from, to])).rows;
      const drivers = (await c.query(`SELECT id, coalesce(display_name, email) AS name FROM users WHERE role = 'driver' AND disabled_at IS NULL ORDER BY name`)).rows;
      const conflicts = planConflicts(plans.map((p) => ({ id: p.id, driverId: p.driverId, startsAt: new Date(p.startsAt).toISOString(), endsAt: new Date(p.endsAt).toISOString() })), off);
      return { from, to, tz, drivers, plans, timeOff: off, conflicts };
    });
  }

  @Get("time-off")
  async listOff(@Req() req: AuthedRequest, @Query("status") status?: string) {
    const orgId = requireAny(req, "routes.view", "driver.app");
    const all = hasPerm(req, "routes.dispatch");
    if (status && !["pending", "approved", "rejected"].includes(status)) throw new BadRequestException("unknown status");
    return (await withOrg(this.pool, orgId, (c) => c.query(
      `SELECT o.id, o.user_id AS "userId", coalesce(u.display_name, u.email) AS person, o.kind, o.starts_on::text AS "startsOn", o.ends_on::text AS "endsOn", o.status, o.note, o.created_at AS "createdAt"
       FROM time_off o JOIN users u ON u.id = o.user_id AND u.org_id = o.org_id
       WHERE ($1::text IS NULL OR o.status = $1) AND ($2::boolean OR o.user_id = $3) ORDER BY (o.status = 'pending') DESC, o.starts_on DESC LIMIT 300`, [status ?? null, all, req.session!.userId]))).rows;
  }

  @Post("time-off")
  async requestOff(@Req() req: AuthedRequest, @Body() b: { userId?: unknown; kind?: unknown; startsOn?: unknown; endsOn?: unknown; note?: unknown }) {
    const orgId = requireAny(req, "routes.view", "driver.app");
    const me = req.session!.userId;
    const target = b?.userId ? parseUuid(String(b.userId)) : me;
    const forOther = target !== me;
    if (forOther && !hasPerm(req, "routes.dispatch")) throw new ForbiddenException("only dispatch can book time off for someone else");
    const kind = String(b?.kind ?? "vacation");
    if (!OFF_KINDS.includes(kind)) throw new BadRequestException(`kind must be ${OFF_KINDS.join(", ")}`);
    if (!DATE.test(String(b?.startsOn)) || !DATE.test(String(b?.endsOn))) throw new BadRequestException("startsOn and endsOn must be YYYY-MM-DD");
    const startsOn = String(b.startsOn), endsOn = String(b.endsOn);
    if (endsOn < startsOn) throw new BadRequestException("the last day cannot be before the first day");
    if ((Date.parse(endsOn) - Date.parse(startsOn)) / 86_400_000 > 60) throw new BadRequestException("at most 60 days in one request");
    const note = typeof b.note === "string" && b.note.trim() ? b.note.trim().slice(0, 500) : null;
    return withOrg(this.pool, orgId, async (c) => {
      const who = (await c.query("SELECT id, coalesce(display_name, email) AS name FROM users WHERE id = $1", [target])).rows[0];
      if (!who) throw new BadRequestException("unknown person");
      const status = forOther ? "approved" : "pending";
      const row = (await c.query(`INSERT INTO time_off (org_id, user_id, kind, starts_on, ends_on, status, note, decided_by, decided_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id, status`,
        [orgId, target, kind, startsOn, endsOn, status, note, forOther ? me : null, forOther ? new Date() : null])).rows[0];
      if (forOther) await addNotification(c, orgId, target, "time_off", `Time off booked for you: ${startsOn} to ${endsOn}`, "/schedule");
      else {
        const bosses = (await c.query("SELECT id FROM users WHERE role IN ('owner','admin','manager') AND disabled_at IS NULL AND id <> $1", [me])).rows;
        for (const u of bosses) await addNotification(c, orgId, u.id, "time_off", `${who.name} asks for time off: ${startsOn} to ${endsOn}`, "/schedule");
      }
      return row;
    });
  }

  @Post("time-off/:id/decide")
  @HttpCode(200)
  async decide(@Req() req: AuthedRequest, @Param("id") id: string, @Body() b: { decision?: unknown }) {
    const orgId = requirePerm(req, "reports.manage");
    if (b?.decision !== "approved" && b?.decision !== "rejected") throw new BadRequestException("decision must be approved or rejected");
    return withOrg(this.pool, orgId, async (c) => {
      const r = (await c.query("UPDATE time_off SET status = $2, decided_by = $3, decided_at = now() WHERE id = $1 AND status = 'pending' RETURNING user_id, starts_on::text AS s, ends_on::text AS e",
        [parseUuid(id), b.decision, /^[0-9a-f-]{36}$/.test(req.session!.userId) ? req.session!.userId : null])).rows[0];
      if (!r) throw new NotFoundException("that request is already decided or does not exist");
      await addNotification(c, orgId, r.user_id, "time_off", `Your time off ${r.s} to ${r.e} was ${b.decision}`, "/schedule");
      return { id, status: b.decision };
    });
  }

  @Delete("time-off/:id")
  @HttpCode(200)
  async removeOff(@Req() req: AuthedRequest, @Param("id") id: string) {
    const orgId = requireAny(req, "routes.view", "driver.app");
    return withOrg(this.pool, orgId, async (c) => {
      const cur = (await c.query("SELECT user_id, status FROM time_off WHERE id = $1", [parseUuid(id)])).rows[0];
      if (!cur) throw new NotFoundException();
      const mine = cur.user_id === req.session!.userId && cur.status === "pending";
      if (!mine && !hasPerm(req, "reports.manage")) throw new ForbiddenException("you can only withdraw your own pending request");
      await c.query("DELETE FROM time_off WHERE id = $1", [parseUuid(id)]);
      return { ok: true };
    });
  }
}
