import { BadRequestException, Body, ConflictException, Controller, Get, Inject, NotFoundException, Param, Patch, Post, Query, Req, Res, UseGuards } from "@nestjs/common";
import { pg, withOrg } from "@routenorth/db";
import type { Response } from "express";
import PDFDocument from "pdfkit";
import { emit } from "../automation/events.js";
import { AuthGuard, requirePerm, type AuthedRequest } from "../auth/auth.guard.js";
import { parseUuid } from "../history/range.js";
import { collect, pdfHeader } from "../reports/export.js";
import { csvEscape } from "../resources/engine.js";
import { JWT_SECRET, PG_POOL } from "../tokens.js";
import { createInvoiceForJob } from "./invoices.js";
import { ensureJobLink } from "./links.js";

/** What a signed-in customer sees: their own orders (matched by the email on the order), invoices, and a way to reach the office. */
@Controller("portal")
@UseGuards(AuthGuard)
export class PortalController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool, @Inject(JWT_SECRET) private readonly secret: string) {}

  private async me(c: pg.PoolClient, userId: string) {
    const u = (await c.query("SELECT lower(email) AS email, coalesce(display_name, email) AS name FROM users WHERE id = $1", [userId])).rows[0];
    return u as { email: string; name: string };
  }

  @Get("orders")
  async orders(@Req() req: AuthedRequest) {
    requirePerm(req, "customer.portal");
    const { orgId, userId } = req.session!;
    return withOrg(this.pool, orgId, async (c) => {
      const me = await this.me(c, userId);
      const rows = (await c.query(
        `SELECT j.id, j.ref, j.title, j.status, j.type, j.address, j.scheduled_date::text AS date, j.window_start AS "windowStart", j.window_end AS "windowEnd", j.price::float AS price,
                (SELECT number FROM invoices i WHERE i.job_id = j.id AND i.status <> 'void' LIMIT 1) AS invoice
         FROM jobs j WHERE lower(j.customer_email) = $1 ORDER BY coalesce(j.scheduled_date, j.created_at::date) DESC, j.created_at DESC LIMIT 100`, [me.email])).rows;
      for (const r of rows) r.track = `/j/${(await ensureJobLink(c, orgId, r.id, this.secret)).token}`;
      return { name: me.name, orders: rows.map(({ id, ...r }) => r) };
    });
  }

  @Get("invoices")
  async invoices(@Req() req: AuthedRequest) {
    requirePerm(req, "customer.portal");
    const { orgId, userId } = req.session!;
    return withOrg(this.pool, orgId, async (c) => {
      const me = await this.me(c, userId);
      return (await c.query(
        `SELECT id, number, status, issued_on::text AS "issuedOn", due_on::text AS "dueOn", currency, subtotal::float AS subtotal, tax::float AS tax, total::float AS total, lines
         FROM invoices WHERE lower(customer_email) = $1 AND status <> 'draft' ORDER BY issued_on DESC, number DESC LIMIT 200`, [me.email])).rows;
    });
  }

  @Get("invoices/:id/pdf")
  async pdf(@Req() req: AuthedRequest, @Param("id") id: string, @Res() res: Response) {
    requirePerm(req, "customer.portal");
    const { orgId, userId } = req.session!;
    const buf = await withOrg(this.pool, orgId, async (c) => {
      const me = await this.me(c, userId);
      const inv = (await c.query("SELECT id FROM invoices WHERE id = $1 AND lower(customer_email) = $2 AND status <> 'draft'", [parseUuid(id), me.email])).rows[0];
      return inv ? invoicePdf(c, inv.id) : null;
    });
    if (!buf) throw new NotFoundException();
    res.type("application/pdf").setHeader("Content-Disposition", 'inline; filename="invoice.pdf"');
    res.send(buf);
  }

  /** A message to the office about one order (or in general). The office answers in its Messages inbox and by email or text. */
  @Post("support")
  async support(@Req() req: AuthedRequest, @Body() body: { body?: unknown; jobId?: unknown }) {
    requirePerm(req, "customer.portal");
    const { orgId, userId } = req.session!;
    if (typeof body?.body !== "string" || !body.body.trim() || body.body.length > 1000) throw new BadRequestException("write a message up to 1000 characters");
    const message = body.body.trim();
    return withOrg(this.pool, orgId, async (c) => {
      const me = await this.me(c, userId);
      let thread = userId;
      let jobId: string | null = null;
      if (body.jobId) {
        jobId = parseUuid(String(body.jobId));
        if (!(await c.query("SELECT 1 FROM jobs WHERE id = $1 AND lower(customer_email) = $2", [jobId, me.email])).rowCount) throw new NotFoundException();
        thread = jobId;
      }
      const recent = (await c.query("SELECT count(*)::int AS n FROM messages WHERE thread_kind = 'customer' AND thread_id = $1 AND sender_kind = 'customer' AND created_at > now() - interval '1 hour'", [thread])).rows[0].n;
      if (recent >= 20) throw new BadRequestException("please wait a little before sending more messages");
      await c.query("INSERT INTO messages (org_id, thread_kind, thread_id, sender_kind, sender_id, body, job_id) VALUES ($1,'customer',$2,'customer',$3,$4,$5)", [orgId, thread, userId, message, jobId]);
      await emit(c, orgId, "message.received", "job", jobId, { from: "customer", jobId, body: message });
      return { ok: true };
    });
  }

  @Get("support")
  async thread(@Req() req: AuthedRequest, @Query("jobId") jobId?: string) {
    requirePerm(req, "customer.portal");
    const { orgId, userId } = req.session!;
    return withOrg(this.pool, orgId, async (c) => {
      const me = await this.me(c, userId);
      const thread = jobId ? parseUuid(jobId) : userId;
      if (jobId && !(await c.query("SELECT 1 FROM jobs WHERE id = $1 AND lower(customer_email) = $2", [thread, me.email])).rowCount) throw new NotFoundException();
      return (await c.query(`SELECT id, sender_kind AS "from", body, created_at AS at FROM messages WHERE thread_kind = 'customer' AND thread_id = $1 ORDER BY created_at LIMIT 200`, [thread])).rows;
    });
  }
}

export async function invoicePdf(c: pg.PoolClient, invoiceId: string): Promise<Buffer> {
  const inv = (await c.query(
    `SELECT i.*, coalesce(o.brand_name, o.name) AS org, o.brand_color, o.logo_data_url, o.locale FROM invoices i JOIN organizations o ON o.id = i.org_id WHERE i.id = $1`, [invoiceId])).rows[0];
  const fr = inv.locale === "fr";
  const doc = new PDFDocument({ size: "LETTER", margin: 36, info: { Title: `${inv.number}`, Producer: "RouteNorth" } });
  const color = pdfHeader(doc, { name: inv.org, color: inv.brand_color, logoDataUrl: inv.logo_data_url }, `${fr ? "Facture" : "Invoice"} ${inv.number}`, `${fr ? "Émise le" : "Issued"} ${inv.issued_on instanceof Date ? inv.issued_on.toISOString().slice(0, 10) : inv.issued_on}${inv.due_on ? `   ·   ${fr ? "Échéance" : "Due"} ${inv.due_on instanceof Date ? inv.due_on.toISOString().slice(0, 10) : inv.due_on}` : ""}`);
  doc.moveDown(2).font("Helvetica-Bold").fontSize(11).text(fr ? "Facturé à" : "Billed to");
  doc.font("Helvetica").fontSize(10).text([inv.customer_name, inv.customer_email, inv.customer_address].filter(Boolean).join("\n") || "-");
  doc.moveDown(1.5);
  const money = (n: number | string) => `${inv.currency} ${Number(n).toFixed(2)}`;
  const y0 = doc.y;
  doc.font("Helvetica-Bold").fontSize(9).fillColor(color).text(fr ? "Description" : "Description", 36, y0).text(fr ? "Qté" : "Qty", 360, y0, { width: 40, align: "right" }).text(fr ? "Prix" : "Price", 410, y0, { width: 70, align: "right" }).text("Total", 490, y0, { width: 86, align: "right" });
  doc.moveTo(36, y0 + 14).lineTo(576, y0 + 14).strokeColor("#cbd5e1").stroke();
  let y = y0 + 22;
  doc.font("Helvetica").fontSize(10).fillColor("#0f172a");
  for (const l of inv.lines as { description: string; qty: number; unitPrice: number; amount: number }[]) {
    doc.text(l.description, 36, y, { width: 310 }).text(String(l.qty), 360, y, { width: 40, align: "right" }).text(money(l.unitPrice), 410, y, { width: 70, align: "right" }).text(money(l.amount), 490, y, { width: 86, align: "right" });
    y += 22;
  }
  y += 10;
  const row = (label: string, v: string, bold = false) => { doc.font(bold ? "Helvetica-Bold" : "Helvetica").text(label, 360, y, { width: 120, align: "right" }).text(v, 490, y, { width: 86, align: "right" }); y += 18; };
  row(fr ? "Sous-total" : "Subtotal", money(inv.subtotal)); row(fr ? "Taxes" : "Tax", money(inv.tax)); row("Total", money(inv.total), true);
  if (inv.notes) doc.font("Helvetica").fontSize(9).fillColor("#475569").text(inv.notes, 36, y + 20, { width: 400 });
  return collect(doc);
}

/** The office's invoices: see them, mark them sent or paid, make one for a job by hand, download a PDF or CSV. */
@Controller("invoices")
@UseGuards(AuthGuard)
export class InvoicesController {
  constructor(@Inject(PG_POOL) private readonly pool: pg.Pool) {}

  @Get()
  async list(@Req() req: AuthedRequest, @Query("status") status?: string) {
    const orgId = requirePerm(req, "customers.view");
    if (status && !["draft", "sent", "paid", "void"].includes(status)) throw new BadRequestException("unknown status");
    return withOrg(this.pool, orgId, async (c) => {
      const items = (await c.query(
        `SELECT id, number, job_id AS "jobId", customer_name AS "customerName", customer_email AS "customerEmail", status, issued_on::text AS "issuedOn", due_on::text AS "dueOn", currency, subtotal::float AS subtotal, tax::float AS tax, total::float AS total,
                (status = 'sent' AND due_on < current_date) AS overdue
         FROM invoices WHERE ($1::text IS NULL OR status = $1) ORDER BY issued_on DESC, number DESC LIMIT 500`, [status ?? null])).rows;
      const sum = (f: (i: typeof items[number]) => boolean) => Math.round(items.filter(f).reduce((a, i) => a + i.total, 0) * 100) / 100;
      return { items, totals: { outstanding: sum((i) => i.status === "sent"), overdue: sum((i) => i.overdue), paid: sum((i) => i.status === "paid") } };
    });
  }

  @Get("export.csv")
  async csv(@Req() req: AuthedRequest, @Res() res: Response) {
    const orgId = requirePerm(req, "reports.export");
    const rows = (await withOrg(this.pool, orgId, (c) => c.query(`SELECT number, issued_on::text AS d, due_on::text AS due, customer_name, customer_email, status, currency, subtotal, tax, total FROM invoices ORDER BY issued_on DESC, number DESC LIMIT 5000`))).rows;
    const lines = [["Number", "Issued", "Due", "Customer", "Email", "Status", "Currency", "Subtotal", "Tax", "Total"].join(",")];
    for (const r of rows) lines.push([r.number, r.d, r.due, r.customer_name, r.customer_email, r.status, r.currency, r.subtotal, r.tax, r.total].map(csvEscape).join(","));
    res.type("text/csv").setHeader("Content-Disposition", 'attachment; filename="invoices.csv"');
    res.send(lines.join("\n"));
  }

  @Get(":id/pdf")
  async pdf(@Req() req: AuthedRequest, @Param("id") id: string, @Res() res: Response) {
    const orgId = requirePerm(req, "customers.view");
    const buf = await withOrg(this.pool, orgId, async (c) => ((await c.query("SELECT 1 FROM invoices WHERE id = $1", [parseUuid(id)])).rowCount ? invoicePdf(c, id) : null));
    if (!buf) throw new NotFoundException();
    res.type("application/pdf").setHeader("Content-Disposition", 'inline; filename="invoice.pdf"');
    res.send(buf);
  }

  @Post("for-job/:jobId")
  async forJob(@Req() req: AuthedRequest, @Param("jobId") jobId: string) {
    const orgId = requirePerm(req, "customers.manage");
    return withOrg(this.pool, orgId, async (c) => {
      const r = await createInvoiceForJob(c, orgId, parseUuid(jobId), req.session!.userId);
      if (!r) throw new NotFoundException();
      return r;
    });
  }

  @Patch(":id")
  async update(@Req() req: AuthedRequest, @Param("id") id: string, @Body() body: { status?: unknown; notes?: unknown; dueOn?: unknown }) {
    const orgId = requirePerm(req, "customers.manage");
    const status = body?.status === undefined ? null : String(body.status);
    if (status !== null && !["draft", "sent", "paid", "void"].includes(status)) throw new BadRequestException("status must be draft, sent, paid or void");
    const due = typeof body?.dueOn === "string" && /^\d{4}-\d{2}-\d{2}$/.test(body.dueOn) ? body.dueOn : null;
    const notes = typeof body?.notes === "string" ? body.notes.slice(0, 1000) : null;
    return withOrg(this.pool, orgId, async (c) => {
      const cur = (await c.query("SELECT status FROM invoices WHERE id = $1 FOR UPDATE", [parseUuid(id)])).rows[0];
      if (!cur) throw new NotFoundException();
      if (cur.status === "void" && status && status !== "void") throw new ConflictException("a void invoice cannot be changed");
      const r = (await c.query("UPDATE invoices SET status = coalesce($2, status), notes = coalesce($3, notes), due_on = coalesce($4::date, due_on), paid_at = CASE WHEN $2 = 'paid' THEN now() WHEN $2 IS NOT NULL THEN NULL ELSE paid_at END WHERE id = $1 RETURNING id, number, status", [id, status, notes, due])).rows[0];
      if (status) await emit(c, orgId, "invoice.updated", "invoice", r.id, { invoiceId: r.id, number: r.number, status: r.status });
      return r;
    });
  }
}
