import type { pg } from "@routenorth/db";
import { haversine } from "@routenorth/shared";
import { emit } from "../automation/events.js";
import { withDefaults } from "../org/settings.js";
import { orgTax } from "../business/money.js";
import { customerOptions, type CustomerOptions } from "./settings.js";

export interface Quote { distanceKm: number; base: number; distance: number; weight: number; rush: number; total: number; currency: string }
export const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * A price estimate from the organization's own rates. Distance is the straight line times 1.3 (a typical detour); it is
 * an estimate, shown as one, and the office can still set the real price on the job.
 */
export function estimateQuote(b: CustomerOptions["booking"], currency: string, input: { from?: { lat: number; lng: number } | null; to: { lat: number; lng: number }; weightKg?: number; rush?: boolean }): Quote {
  const km = input.from ? (haversine(input.from.lat, input.from.lng, input.to.lat, input.to.lng) / 1000) * 1.3 : 0;
  const distance = km * b.perKm, weight = (input.weightKg ?? 0) * b.perKg;
  let sub = Math.max(b.minimum, b.baseFee + distance + weight);
  const rush = input.rush ? sub * (b.rushPct / 100) : 0;
  sub += rush;
  return { distanceKm: round2(km), base: b.baseFee, distance: round2(distance), weight: round2(weight), rush: round2(rush), total: round2(sub), currency };
}

/** One invoice per job. The price is the job's own price, or an estimate from the organization's rates when there is none. */
export async function createInvoiceForJob(c: pg.PoolClient, orgId: string, jobId: string, createdBy: string | null): Promise<{ id: string; number: string; total: number; existing: boolean } | null> {
  const dup = (await c.query("SELECT id, number, total FROM invoices WHERE job_id = $1 AND status <> 'void'", [jobId])).rows[0];
  if (dup) return { id: dup.id, number: dup.number, total: Number(dup.total), existing: true };
  const job = (await c.query(
    `SELECT j.id, j.ref, j.title, j.price, j.weight_kg, j.customer_name, j.customer_email, j.address, j.lat, j.lng, o.settings FROM jobs j JOIN organizations o ON o.id = j.org_id WHERE j.id = $1`, [jobId])).rows[0];
  if (!job) return null;
  const s = withDefaults(job.settings);
  const opt = customerOptions(job.settings);
  let sub: number;
  if (job.price != null) sub = Number(job.price);
  else {
    const depot = (await c.query<{ lat: number; lng: number }>("SELECT lat, lng FROM depots ORDER BY created_at LIMIT 1")).rows[0] ?? null;
    sub = job.lat != null && job.lng != null ? estimateQuote(opt.booking, s.currency, { from: depot, to: { lat: job.lat, lng: job.lng }, weightKg: job.weight_kg }).total : opt.booking.minimum;
  }
  sub = round2(sub);
  const taxed = orgTax(job.settings, sub);
  const tax = taxed.total;
  const n = (await c.query<{ n: number }>("SELECT next_counter($1, 'invoice') AS n", [orgId])).rows[0]!.n;
  const number = `INV-${new Date().getUTCFullYear()}-${String(n).padStart(4, "0")}`;
  const lines = [{ description: job.ref ? `${job.title} (${job.ref})` : job.title, qty: 1, unitPrice: sub, amount: sub }];
  const row = (await c.query(
    `INSERT INTO invoices (org_id, number, job_id, customer_name, customer_email, customer_address, status, due_on, currency, lines, subtotal, tax, tax_lines, total, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,'sent', current_date + $13::int, $7,$8,$9,$10,$14,$11,$12) RETURNING id`,
    [orgId, number, jobId, job.customer_name, job.customer_email, job.address, s.currency, JSON.stringify(lines), sub, tax, round2(sub + tax), createdBy, s.billing.paymentTermsDays, JSON.stringify(taxed.lines)])).rows[0];
  await emit(c, orgId, "invoice.created", "invoice", row.id, { invoiceId: row.id, number, total: round2(sub + tax), jobId });
  return { id: row.id, number, total: round2(sub + tax), existing: false };
}
