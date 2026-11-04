"use client";
import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { StatusBadge } from "@/components/portal/parts";
import { Async } from "@/components/portal/states";
import { PAYOUT_TONE } from "@/lib/portal/pay-form";
import { useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

interface Pay {
  rateCard: { name: string; summary: string; version: number; via?: string } | null; unpaidCents: number; unpaidTrips: number; window: { from: string; to: string };
  bonusProgress: { id: string; name: string; earnedCents: number; current: number; target: number; label: string }[];
  payouts: { id: string; from: string; to: string; status: string; netCents: number; holdReason: string | null; runId: string }[];
  deductions: { id: string; label: string; reason: string; totalCents: number; takenCents: number; status: string }[];
}

/** The Pay and Money tabs of a driver: rate card, what is owed now, bonus progress, deductions with reasons, and past payouts. */
export function DriverPay({ id }: { id: string }) {
  const fmt = useFmt();
  const api = useApi<Pay>(`/portal/pay/drivers/${id}`);
  return (
    <Async state={api}>{(p) => (
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle>Rate card</CardTitle><CardDescription>What this driver earns per trip</CardDescription></CardHeader>
          <CardContent className="text-sm">{p.rateCard ? <><p className="font-medium">{p.rateCard.name} <span className="font-normal text-muted-foreground">v{p.rateCard.version}</span></p><p>{p.rateCard.summary}</p></> : <p className="text-muted-foreground">No rate card applies. <Link className="underline" href="/owner/pay-rates">Assign one</Link> so trips are paid.</p>}
            <p className="mt-3 text-2xl font-semibold tabular-nums">{fmt.money(p.unpaidCents)}</p><p className="text-xs text-muted-foreground">earned and not paid out yet, from {p.unpaidTrips} trip{p.unpaidTrips === 1 ? "" : "s"}</p></CardContent></Card>
        <Card><CardHeader><CardTitle>Bonus progress</CardTitle><CardDescription>{fmt.date(p.window.from)} to {fmt.date(p.window.to)}</CardDescription></CardHeader>
          <CardContent className="space-y-3 text-sm">{p.bonusProgress.length ? p.bonusProgress.map((b) => (
            <div key={b.id}><div className="flex justify-between"><span>{b.name}</span><span className={b.earnedCents ? "font-medium text-ok" : "text-muted-foreground"}>{b.earnedCents ? `${fmt.money(b.earnedCents)} earned` : b.label}</span></div>
              <Progress className="mt-1" value={b.target > 0 ? Math.min(100, (100 * b.current) / b.target) : b.earnedCents ? 100 : 0} /></div>)) : <p className="text-muted-foreground">No bonus rules are set up.</p>}</CardContent></Card>
        <Card><CardHeader><CardTitle>Deductions</CardTitle><CardDescription>The driver sees each one with its reason</CardDescription></CardHeader>
          <CardContent className="text-sm">{p.deductions.length ? <ul className="space-y-2">{p.deductions.map((d) => <li key={d.id}><div className="flex justify-between"><span>{d.label}</span><span className="tabular-nums">{fmt.money(d.takenCents)} of {fmt.money(d.totalCents)}</span></div><p className="text-xs text-muted-foreground">{d.reason} · {d.status.replace(/_/g, " ")}</p></li>)}</ul> : <p className="text-muted-foreground">None.</p>}</CardContent></Card>
        <Card><CardHeader><CardTitle>Past payouts</CardTitle></CardHeader>
          <CardContent className="text-sm">{p.payouts.length ? <ul className="space-y-1">{p.payouts.map((x) => <li key={x.id} className="flex items-center justify-between gap-2"><Link className="hover:underline" href={`/owner/pay-rates/runs/${x.runId}`}>{fmt.date(x.from)} to {fmt.date(x.to)}</Link>
            <span className="flex items-center gap-2"><StatusBadge tone={PAYOUT_TONE[x.status] ?? "neutral"}>{x.status}</StatusBadge><span className="tabular-nums">{fmt.money(x.netCents)}</span></span></li>)}</ul> : <p className="text-muted-foreground">No payouts yet.</p>}</CardContent></Card>
      </div>)}</Async>
  );
}
