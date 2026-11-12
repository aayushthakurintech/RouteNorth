"use client";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { MoneyChart } from "@/components/portal/charts";
import { PageHeader, StatCard } from "@/components/portal/parts";
import { Async } from "@/components/portal/states";
import { useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

type M = { month: string; future?: boolean } & Partial<Record<"revenueCents" | "driverPayCents" | "fuelCents" | "maintenanceCents" | "insuranceCents" | "financeCents" | "otherCents" | "costCents" | "profitCents", number>>;
interface Res { year: number; months: M[]; total: Record<string, number>; definition: string }
const LINES = [["revenueCents", "Revenue"], ["driverPayCents", "Driver pay"], ["fuelCents", "Fuel"], ["maintenanceCents", "Repairs and service"], ["insuranceCents", "Insurance"], ["financeCents", "Loan and lease"], ["otherCents", "Tires, fines and other"], ["costCents", "Total costs"], ["profitCents", "Profit"]] as const;

/** Profit and loss for a year, month by month. Costs are what the business spent; buying a car is not a cost here (see the car's page for payback). */
export default function ProfitLossPage() {
  const fmt = useFmt(); const [year, setYear] = useState(new Date().getFullYear());
  const api = useApi<Res>(`/portal/finance/profit-loss?year=${year}`);
  return (
    <>
      <PageHeader title="Profit and loss" description="Revenue, every cost, and what was left, month by month." actions={
        <div className="flex items-center gap-1"><Button size="icon" variant="outline" aria-label="Previous year" onClick={() => setYear(year - 1)}><ChevronLeft className="size-4" /></Button><span className="w-14 text-center font-medium tabular-nums">{year}</span><Button size="icon" variant="outline" aria-label="Next year" onClick={() => setYear(year + 1)}><ChevronRight className="size-4" /></Button></div>} />
      <Async state={api}>{(d) => (
        <div className="space-y-4">
          <div className="grid gap-3 sm:grid-cols-3">
            <StatCard label="Revenue" value={fmt.money(d.total.revenueCents)} /><StatCard label="Costs" value={fmt.money(d.total.costCents)} />
            <StatCard label="Profit" value={fmt.money(d.total.profitCents)} hint={d.total.revenueCents ? `${fmt.pct((100 * d.total.profitCents!) / d.total.revenueCents!, 1)} of revenue` : undefined} />
          </div>
          <div className="rounded-lg border p-3"><MoneyChart series={d.months.filter((m) => !m.future).map((m) => ({ from: `${m.month}-01`, to: `${m.month}-01`, revenueCents: m.revenueCents ?? 0, costCents: m.costCents ?? 0, profitCents: m.profitCents ?? 0, trips: 0 }))} /></div>
          <div className="overflow-x-auto rounded-lg border">
            <table className="w-full min-w-[900px] text-sm">
              <thead><tr className="border-b bg-muted/40 text-left"><th scope="col" className="p-2">&nbsp;</th>{d.months.map((m) => <th scope="col" key={m.month} className="p-2 text-right font-medium">{new Date(`${m.month}-01T12:00:00Z`).toLocaleString("en-CA", { month: "short", timeZone: "UTC" })}</th>)}<th scope="col" className="p-2 text-right font-semibold">Year</th></tr></thead>
              <tbody>{LINES.map(([k, l]) => (
                <tr key={k} className={`border-b last:border-0 ${k === "costCents" || k === "profitCents" ? "font-semibold" : ""}`}>
                  <th scope="row" className="p-2 text-left font-medium">{l}</th>
                  {d.months.map((m) => <td key={m.month} className={`p-2 text-right tabular-nums ${k === "profitCents" && (m[k] ?? 0) < 0 ? "text-destructive" : ""}`}>{m.future ? <span className="text-muted-foreground">—</span> : fmt.money(m[k])}</td>)}
                  <td className="p-2 text-right tabular-nums">{fmt.money(d.total[k])}</td>
                </tr>))}</tbody>
            </table>
          </div>
          <p className="text-xs text-muted-foreground">{d.definition}</p>
        </div>)}</Async>
    </>
  );
}
