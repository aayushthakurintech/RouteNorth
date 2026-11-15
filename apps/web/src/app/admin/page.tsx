"use client";
import { AlertTriangle, Eye } from "lucide-react";
import Link from "next/link";
import { useAdmin } from "@/components/admin/AdminShell";
import { HealthPill } from "@/components/admin/parts";
import { PageHeader, StatCard } from "@/components/portal/parts";
import { EmptyState, ErrorState, LoadingState } from "@/components/portal/states";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Stagger, StaggerItem } from "@/components/motion";
import type { Overview } from "@/lib/admin";
import { useApi } from "@/lib/use-api";

const n = (x: number) => Math.round(x).toLocaleString("en-CA");

export default function AdminOverview() {
  const { can } = useAdmin();
  const q = useApi<Overview>(can("monitor.view") ? "/admin/overview" : null, { intervalMs: 60_000 });
  if (!can("monitor.view")) return <ErrorState error="HTTP 403" />;
  if (q.error && !q.data) return <ErrorState error={q.error} onRetry={q.reload} />;
  const o = q.data;
  return (
    <>
      <PageHeader title="Overview" description="How every client is doing right now. Numbers refresh every minute." />
      {!o ? <LoadingState rows={5} /> : (
        <div className="space-y-8">
          <Stagger className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <StaggerItem><StatCard hero label="Clients" value={n(o.clients.total)} count={{ value: o.clients.total, format: n }} hint={`${o.clients.active} active · ${o.clients.suspended} suspended`} href="/admin/clients" /></StaggerItem>
            <StaggerItem><StatCard label="Trackers reporting now" value={n(o.fleet.reportingNow)} count={{ value: o.fleet.reportingNow, format: n }} hint={`${n(o.fleet.reporting24h)} in the last 24 h · ${n(o.fleet.devices)} connected`} /></StaggerItem>
            <StaggerItem><StatCard label="Vehicles" value={n(o.fleet.vehicles)} count={{ value: o.fleet.vehicles, format: n }} hint={`${n(o.fleet.users)} people across clients`} /></StaggerItem>
            <StaggerItem><StatCard label="Staff views open" value={n(o.activeStaffViews)} count={{ value: o.activeStaffViews, format: n }} hint={can("audit.view") ? "Read-only, logged" : undefined} href={can("audit.view") ? "/admin/views" : undefined} /></StaggerItem>
          </Stagger>

          <section aria-labelledby="h-attn" className="space-y-3">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <div>
                <h2 id="h-attn" className="font-display text-lg font-bold tracking-tight">Needs a look</h2>
                <p className="text-sm text-muted-foreground">{o.health.bad} need attention, {o.health.warn} to look at, {o.health.ok} healthy. {o.clients.restricted} client{o.clients.restricted === 1 ? " has" : "s have"} a limited set of sections; {o.clients.trials} on trial.</p>
              </div>
              <Link href="/admin/clients" className="text-sm underline underline-offset-4">All clients</Link>
            </div>
            {o.attention.length === 0 ? (
              <EmptyState title="Nothing needs attention">Every active client has reported recently and is inside its limits.</EmptyState>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2">
                {o.attention.map((c) => (
                  <li key={c.id}>
                    <Link href={`/admin/clients/${c.id}`} className="block rounded-xl focus-visible:outline-2">
                      <Card className="h-full gap-2 py-4 transition-[border-color,transform] hover:-translate-y-px hover:border-primary">
                        <CardHeader className="px-4">
                          <CardTitle className="flex items-center justify-between gap-2 text-base"><span className="truncate">{c.name}</span><HealthPill level={c.health.level} /></CardTitle>
                          <CardDescription>{c.plan} · {c.usage.vehicles} vehicles · {c.usage.devices} trackers</CardDescription>
                        </CardHeader>
                        <CardContent className="px-4">
                          <ul className="space-y-1 text-sm">
                            {c.health.flags.map((f) => (<li key={f.code} className="flex items-start gap-2"><AlertTriangle className="mt-0.5 size-3.5 shrink-0" style={{ color: f.level === "bad" ? "var(--danger)" : "var(--warn)" }} aria-hidden />{f.text}</li>))}
                          </ul>
                        </CardContent>
                      </Card>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          {o.activeStaffViews > 0 && can("audit.view") && (
            <p className="flex items-center gap-2 rounded-lg border bg-muted/40 p-3 text-sm"><Eye className="size-4" aria-hidden /> {o.activeStaffViews} staff view{o.activeStaffViews === 1 ? " is" : "s are"} open right now. <Link href="/admin/views" className="underline underline-offset-4">See who and why</Link></p>
          )}
        </div>
      )}
    </>
  );
}
