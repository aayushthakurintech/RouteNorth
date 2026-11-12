"use client";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { PageHeader, StatusBadge } from "@/components/portal/parts";
import { Async } from "@/components/portal/states";
import { useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

interface Win { days: number; inCents: number; outCents: number; netCents: number; parts: { invoicesCents: number; billsCents: number; driverPayOwedCents: number; usualRunningCostsCents: number } }
interface Res { today: string; windows: Win[]; invoices: { number: string; customer: string; due: string | null; cents: number; overdue: boolean }[]; bills: { date: string; label: string; amountCents: number | null; href: string }[]; note: string }

/** Cash flow: what will come in and go out over the next 30, 60 and 90 days. The running costs part is an estimate from the last 90 days and says so. */
export default function CashFlowPage() {
  const fmt = useFmt(); const api = useApi<Res>("/portal/finance/cash-flow");
  return (
    <>
      <PageHeader title="Cash flow" description="What we expect to come in and go out. Money in is unpaid invoices. Money out is loan and lease payments, driver pay owed, and usual running costs." />
      <Async state={api}>{(d) => (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">{d.windows.map((w) => (
            <Card key={w.days}><CardHeader><CardDescription>Next {w.days} days</CardDescription><CardTitle className={`text-2xl tabular-nums ${w.netCents < 0 ? "text-destructive" : ""}`}>{fmt.money(w.netCents)}</CardTitle></CardHeader>
              <CardContent className="space-y-1 text-sm">
                <p className="flex justify-between"><span>Money in</span><span className="tabular-nums">{fmt.money(w.inCents)}</span></p>
                <p className="flex justify-between"><span>Loan and lease payments</span><span className="tabular-nums">{fmt.money(w.parts.billsCents)}</span></p>
                <p className="flex justify-between"><span>Driver pay owed</span><span className="tabular-nums">{fmt.money(w.parts.driverPayOwedCents)}</span></p>
                <p className="flex justify-between"><span>Usual running costs <StatusBadge>estimate</StatusBadge></span><span className="tabular-nums">{fmt.money(w.parts.usualRunningCostsCents)}</span></p>
              </CardContent></Card>))}</div>
          <div className="grid gap-4 md:grid-cols-2">
            <Card><CardHeader><CardTitle className="text-base">Invoices waiting to be paid</CardTitle></CardHeader><CardContent>{d.invoices.length === 0 ? <p className="text-sm text-muted-foreground">No sent invoices are waiting.</p> : <ul className="divide-y text-sm">{d.invoices.map((i) => <li key={i.number} className="flex justify-between gap-2 py-1.5"><span>{i.number} · {i.customer} {i.overdue && <StatusBadge tone="bad">overdue</StatusBadge>}</span><span className="tabular-nums">{fmt.money(i.cents)}</span></li>)}</ul>}</CardContent></Card>
            <Card><CardHeader><CardTitle className="text-base">Known bills</CardTitle></CardHeader><CardContent>{d.bills.length === 0 ? <p className="text-sm text-muted-foreground">No loan, lease or insurance dates are known. Add them on a car.</p> : <ul className="divide-y text-sm">{d.bills.map((b, i) => <li key={i} className="flex justify-between gap-2 py-1.5"><Link href={b.href} className="hover:underline">{fmt.date(b.date)} · {b.label}</Link><span className="tabular-nums">{b.amountCents == null ? "amount unknown" : fmt.money(b.amountCents)}</span></li>)}</ul>}</CardContent></Card>
          </div>
          <p className="text-xs text-muted-foreground">{d.note}</p>
        </div>)}</Async>
    </>
  );
}
