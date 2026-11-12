"use client";
import { AlertTriangle, CheckCircle2 } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Bars, MoneyChart, type Point } from "@/components/portal/charts";
import { DataFreshness } from "@/components/portal/DataFreshness";
import { PageHeader, StatCard, StatusBadge } from "@/components/portal/parts";
import { useOwnerRange } from "@/components/portal/range-context";
import { Async } from "@/components/portal/states";
import { cellText } from "@/components/portal/report-view";
import type { RCol } from "@/components/portal/report-chart";
import { useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

interface Cards { revenueCents: number; driverPayCents: number; vehicleCostsCents: number; profitCents: number; marginPct: number | null; trips: number; onTimePct?: number | null }
interface Dash {
  range: { from: string; to: string }; previous: { from: string; to: string }; today: string; access: { money: boolean; fleet: boolean; drivers: boolean };
  overview: Partial<Cards> & { onTimePct: number | null; activeCars: number; activeDrivers: number; previous: (Cards & { onTimePct: number | null }) | null };
  money?: { series: Point[]; costSplit: { label: string; cents: number }[]; unpaidPayoutsCents: number; upcomingBills: { date: string; label: string; amountCents: number | null; href: string }[] };
  fleet?: { byStatus: Record<string, number>; total: number; utilizationPct: number | null; utilizationFormula: string; dueForService: number; overdueService: number; expiringDocuments: number; costPerKmCents: number | null; top: { id: string; name: string; profitCents: number }[]; bottom: { id: string; name: string; profitCents: number }[] };
  drivers?: { byStatus: Record<string, number>; averageScore: number | null; top: { id: string; name: string; score: number }[]; bottom: { id: string; name: string; score: number }[]; hoursWorked: number; overtimeHours: number; expiringDocuments: number; openDisputes: number };
  live?: { moving: number; parked: number; offline: number; idleCars: number; onTrip: number; lateTrips: number; activeAlerts: number };
  attention: { key: string; severity: 1 | 2 | 3; title: string; count: number; href: string; action: string }[];
}

const change = (now: number | null | undefined, before: number | null | undefined) => (now == null || before == null || before === 0 ? null : ((now - before) / Math.abs(before)) * 100);
const SEVERITY = { 1: ["bad", "Urgent"], 2: ["warn", "Soon"], 3: ["neutral", "When you can"] } as const;

function Attention({ items }: { items: Dash["attention"] }) {
  return (
    <Card>
      <CardHeader><CardTitle className="text-base">Needs your attention</CardTitle><CardDescription>Most urgent first. Each one opens the place where you fix it.</CardDescription></CardHeader>
      <CardContent>
        {items.length === 0 ? <p className="flex items-center gap-2 text-sm text-muted-foreground"><CheckCircle2 className="size-4 text-ok" /> Nothing needs you right now.</p> : (
          <ul className="divide-y text-sm">{items.map((a) => (
            <li key={a.key} className="flex flex-wrap items-center justify-between gap-2 py-2">
              <span className="flex min-w-0 items-center gap-2"><StatusBadge tone={SEVERITY[a.severity][0]}>{a.count}</StatusBadge><span>{a.title}</span></span>
              <Button asChild size="sm" variant="outline"><Link href={a.href}>{a.action}</Link></Button>
            </li>))}</ul>)}
      </CardContent>
    </Card>
  );
}

function Overview({ d }: { d: Dash }) {
  const fmt = useFmt(); const o = d.overview; const p = o.previous; const money = d.access.money;
  const vs = d.previous ? `vs ${fmt.date(d.previous.from)} to ${fmt.date(d.previous.to)}` : undefined;
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      {money && <>
        <StatCard label="Revenue" value={fmt.money(o.revenueCents)} href="/owner/finance" delta={change(o.revenueCents, p?.revenueCents)} hint={p ? vs : `${o.trips ?? 0} trips`} />
        <StatCard label="Driver pay" value={fmt.money(o.driverPayCents)} href="/owner/pay-rates" delta={change(o.driverPayCents, p?.driverPayCents)} deltaGoodWhen="down" hint={p ? vs : undefined} />
        <StatCard label="Car costs" value={fmt.money(o.vehicleCostsCents)} href="/owner/finance/expenses" delta={change(o.vehicleCostsCents, p?.vehicleCostsCents)} deltaGoodWhen="down" hint={p ? vs : "Fuel, repairs, insurance, loans, tires, fines"} />
        <StatCard label="Profit" value={fmt.money(o.profitCents)} href="/owner/finance/profit-loss" delta={change(o.profitCents, p?.profitCents)} hint={o.marginPct == null ? "No revenue yet" : `${fmt.pct(o.marginPct, 1)} of revenue`} />
        <StatCard label="Trips" value={fmt.num(o.trips)} href="/owner/trips" delta={change(o.trips, p?.trips)} hint={p ? vs : undefined} />
      </>}
      <StatCard label="On-time" value={o.onTimePct == null ? "—" : `${o.onTimePct}%`} href="/owner/trips" delta={change(o.onTimePct, p?.onTimePct)} hint={o.onTimePct == null ? "No trips with a promised time yet" : p ? vs : "Trips that arrived by the promised time"} />
      {d.access.fleet && <StatCard label="Active cars" value={fmt.num(o.activeCars)} href="/owner/vehicles" hint="Active or on a trip" />}
      {d.access.drivers && <StatCard label="Active drivers" value={fmt.num(o.activeDrivers)} href="/owner/drivers" hint="Active or on a trip" />}
    </div>
  );
}

function Money({ m }: { m: NonNullable<Dash["money"]> }) {
  const fmt = useFmt();
  return (
    <div className="grid gap-4 lg:grid-cols-3">
      <Card className="lg:col-span-2"><CardHeader><CardTitle className="text-base">Revenue, costs and profit</CardTitle><CardDescription>Blue is revenue, amber is costs, green dashed is profit.</CardDescription></CardHeader><CardContent><MoneyChart series={m.series} /></CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Where the money goes</CardTitle></CardHeader><CardContent><Bars tone="warn" format={fmt.money} rows={m.costSplit.map((c) => ({ label: c.label, value: c.cents }))} /></CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Driver pay not yet paid out</CardTitle><CardDescription>Approved lines and payouts that are not marked paid.</CardDescription></CardHeader><CardContent><Link href="/owner/finance/payouts" className="text-2xl font-semibold tabular-nums hover:underline">{fmt.money(m.unpaidPayoutsCents)}</Link></CardContent></Card>
      <Card className="lg:col-span-2"><CardHeader><CardTitle className="text-base">Bills coming in the next 30 days</CardTitle><CardDescription>Loan and lease payments, and insurance renewals (amount not known).</CardDescription></CardHeader>
        <CardContent>{m.upcomingBills.length === 0 ? <p className="text-sm text-muted-foreground">No bills are known for the next 30 days. Add loan or lease payments on a car to see them here.</p> : (
          <ul className="divide-y text-sm">{m.upcomingBills.map((b, i) => <li key={i} className="flex justify-between gap-2 py-1.5"><Link href={b.href} className="hover:underline">{fmt.date(b.date)} · {b.label}</Link><span className="tabular-nums">{b.amountCents == null ? "amount unknown" : fmt.money(b.amountCents)}</span></li>)}</ul>)}</CardContent></Card>
    </div>
  );
}

function Fleet({ f }: { f: NonNullable<Dash["fleet"]> }) {
  const fmt = useFmt();
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Cars" value={fmt.num(f.total)} href="/owner/vehicles" hint={Object.entries(f.byStatus).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ")} />
        <StatCard label="Utilization" value={f.utilizationPct == null ? "—" : `${f.utilizationPct}%`} hint={f.utilizationFormula} />
        <StatCard label="Service due" value={fmt.num(f.dueForService)} href="/owner/vehicles?view=service" hint={`${f.overdueService} overdue`} />
        <StatCard label="Documents expiring" value={fmt.num(f.expiringDocuments)} href="/owner/vehicles?view=docs" hint="Expired or within 14 days" />
        <StatCard label="Cost per km" value={f.costPerKmCents == null ? "—" : fmt.money(f.costPerKmCents)} hint="Running costs, without driver pay" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader><CardTitle className="text-base">Most profitable cars</CardTitle></CardHeader><CardContent>{f.top.length ? <Bars tone="ok" format={fmt.money} rows={f.top.map((c) => ({ label: c.name, value: c.profitCents }))} /> : <p className="text-sm text-muted-foreground">No trips in this period.</p>}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Least profitable cars</CardTitle></CardHeader><CardContent>{f.bottom.length ? <Bars format={fmt.money} rows={f.bottom.map((c) => ({ label: c.name, value: c.profitCents }))} /> : <p className="text-sm text-muted-foreground">Shown once there are more than five cars.</p>}</CardContent></Card>
      </div>
    </div>
  );
}

function Drivers({ d }: { d: NonNullable<Dash["drivers"]> }) {
  const fmt = useFmt();
  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Drivers" value={fmt.num(Object.values(d.byStatus).reduce((a, b) => a + b, 0))} href="/owner/drivers" hint={Object.entries(d.byStatus).map(([k, v]) => `${v} ${k.replace("_", " ")}`).join(", ")} />
        <StatCard label="Average safety score" value={d.averageScore == null ? "—" : String(d.averageScore)} hint="Out of 100" />
        <StatCard label="Hours worked" value={fmt.num(d.hoursWorked, 1)} hint={`${fmt.num(d.overtimeHours, 1)} h overtime`} />
        <StatCard label="Documents expiring" value={fmt.num(d.expiringDocuments)} href="/owner/drivers?view=docs" hint="Expired or within 14 days" />
        <StatCard label="Pay questions open" value={fmt.num(d.openDisputes)} href="/owner/pay-rates" />
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <Card><CardHeader><CardTitle className="text-base">Best scores</CardTitle></CardHeader><CardContent>{d.top.length ? <Bars tone="ok" format={(n) => String(n)} rows={d.top.map((c) => ({ label: c.name, value: c.score }))} /> : <p className="text-sm text-muted-foreground">Scores appear after drivers record trips.</p>}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Lowest scores</CardTitle></CardHeader><CardContent>{d.bottom.length ? <Bars tone="warn" format={(n) => String(n)} rows={d.bottom.map((c) => ({ label: c.name, value: c.score }))} /> : <p className="text-sm text-muted-foreground">Shown once there are more than five scored drivers.</p>}</CardContent></Card>
      </div>
    </div>
  );
}

function Live({ l }: { l: NonNullable<Dash["live"]> }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
      <StatCard label="Moving now" value={l.moving} href="/live" hint="Seen in the last 10 minutes" />
      <StatCard label="Parked" value={l.parked} href="/live" />
      <StatCard label="Not reporting" value={l.offline} href="/live" hint="No position for 10 minutes" />
      <StatCard label="Cars on a trip" value={l.onTrip} href="/owner/vehicles" />
      <StatCard label="Idle cars" value={l.idleCars} href="/owner/vehicles" />
      <StatCard label="Late trips" value={l.lateTrips} href="/jobs" hint="Past their window and not finished" />
      <StatCard label="Open alerts" value={l.activeAlerts} href="/owner/settings/alerts" />
    </div>
  );
}

interface Pinned { ref: string; name: string; columns: RCol[]; rows: Record<string, unknown>[]; total: number }

/** Reports the person pinned from the Reports page: the first rows of each, with a link to the whole report. */
function PinnedReports({ query }: { query: string }) {
  const fmt = useFmt();
  const api = useApi<Pinned[]>(`/portal/reports/pinned?${query}`);
  const list = api.data ?? [];
  if (!list.length) return null;
  return (
    <section aria-label="Pinned reports" className="grid gap-3 lg:grid-cols-2">{list.map((p) => (
      <Card key={p.ref}><CardHeader><CardTitle className="text-base"><Link href={`/owner/reports/${p.ref}`} className="hover:underline">{p.name}</Link></CardTitle><CardDescription>First {p.rows.length} of {fmt.num(p.total)} rows. Unpin it on the Reports page.</CardDescription></CardHeader>
        <CardContent>{p.rows.length === 0 ? <p className="text-sm text-muted-foreground">Nothing to show for these dates.</p> : (
          <table className="w-full text-sm"><thead><tr>{p.columns.map((c) => <th key={c.key} scope="col" className={`pb-1 text-xs font-medium text-muted-foreground ${["num", "pct", "money"].includes(c.type) ? "text-right" : "text-left"}`}>{c.label}</th>)}</tr></thead>
            <tbody>{p.rows.map((r, i) => <tr key={i} className="border-t">{p.columns.map((c) => <td key={c.key} className={`py-1 ${["num", "pct", "money"].includes(c.type) ? "text-right tabular-nums" : ""}`}>{cellText(r[c.key], c, fmt)}</td>)}</tr>)}</tbody></table>)}</CardContent></Card>))}</section>
  );
}

/** The owner's dashboard: one page, five tabs. Every number uses the same money rules as the cars, finance pages and reports, so they always agree. */
export default function OwnerHome() {
  const { query } = useOwnerRange();
  const [tab, setTab] = useState("overview");
  const api = useApi<Dash>(`/portal/dashboard?${query}&tab=${tab}`, { intervalMs: tab === "live" ? 30_000 : undefined });
  const a = api.data?.access;
  return (
    <>
      <PageHeader title="Dashboard" description="How the business is doing in the dates picked at the top. Click any number to see the rows behind it." />
      <DataFreshness />
      <Async state={api}>{(d) => (
        <div className="space-y-4">
          {d.attention.some((x) => x.severity === 1) && <p className="flex items-center gap-2 rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive"><AlertTriangle className="size-4" /> {d.attention.filter((x) => x.severity === 1).length} urgent {d.attention.filter((x) => x.severity === 1).length === 1 ? "item needs" : "items need"} you. See the list below.</p>}
          <Tabs value={tab} onValueChange={setTab} className="space-y-4">
            <TabsList className="h-auto flex-wrap justify-start">
              <TabsTrigger value="overview">Overview</TabsTrigger>
              {a?.money && <TabsTrigger value="money">Money</TabsTrigger>}
              {a?.fleet && <TabsTrigger value="fleet">Fleet</TabsTrigger>}
              {a?.drivers && <TabsTrigger value="drivers">Drivers</TabsTrigger>}
              <TabsTrigger value="live">Live</TabsTrigger>
            </TabsList>
            <TabsContent value="overview"><Overview d={d} /></TabsContent>
            <TabsContent value="money">{d.money ? <Money m={d.money} /> : null}</TabsContent>
            <TabsContent value="fleet">{d.fleet ? <Fleet f={d.fleet} /> : null}</TabsContent>
            <TabsContent value="drivers">{d.drivers ? <Drivers d={d.drivers} /> : null}</TabsContent>
            <TabsContent value="live">{d.live ? <Live l={d.live} /> : null}</TabsContent>
          </Tabs>
          <Attention items={d.attention} />
          <PinnedReports query={query} />
        </div>)}</Async>
    </>
  );
}
