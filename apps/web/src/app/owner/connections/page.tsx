"use client";
import { Plus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { AddVehicleFlow } from "@/components/connections/AddVehicleFlow";
import { StatusPill } from "@/components/connections/parts";
import { CountUp, Stagger, StaggerItem } from "@/components/motion";
import { Button } from "@/components/ui/button";
import { PageHeader } from "@/components/portal/parts";
import { ErrorState } from "@/components/portal/states";
import { useMe } from "@/lib/me-context";
import { useApi } from "@/lib/use-api";
import { STATE_COLOR, STATE_LABEL, type ConnOverview } from "@/lib/portal/connections";
import { METHOD_INFO, ago, type ConnectionState } from "@routenorth/shared";

const ORDER: ConnectionState[] = ["connected", "waiting_first_ping", "quiet", "error", "not_connected"];

/** Every vehicle and whether its tracker is reporting. The place to find what needs fixing. */
export default function ConnectionsPage() {
  const router = useRouter();
  const { can } = useMe();
  const api = useApi<ConnOverview>("/portal/connections/overview", { intervalMs: 15_000 });
  const [filter, setFilter] = useState<ConnectionState | "all">("all");
  const [adding, setAdding] = useState(false);
  const rows = useMemo(() => {
    const all = api.data?.vehicles ?? [];
    const sorted = [...all].sort((a, b) => ORDER.indexOf(a.status.state) - ORDER.indexOf(b.status.state) || a.vehicleName.localeCompare(b.vehicleName));
    return filter === "all" ? sorted : sorted.filter((r) => r.status.state === filter);
  }, [api.data, filter]);
  const counts = api.data?.counts;
  const total = api.data?.vehicles.length ?? 0;

  return (
    <div>
      <PageHeader title="Connections" description="Which vehicles are reporting their position, and what to do about the ones that are not." crumbs={[{ label: "Fleet" }, { label: "Connections" }]}
        actions={<>{can("settings.manage", "integrations.manage") && <Button variant="outline" asChild><Link href="/owner/settings/connect-gps">Provider accounts and keys</Link></Button>}{can("vehicles.manage") && <Button onClick={() => setAdding(true)}><Plus className="size-4" /> Add vehicle</Button>}</>} />
      {api.error && !api.data ? <ErrorState error={api.error} onRetry={api.reload} /> : (
        <>
          <Stagger className="mb-6 grid grid-cols-2 gap-x-6 gap-y-4 border-b pb-6 sm:grid-cols-3 lg:grid-cols-5">
            {ORDER.map((s) => (
              <StaggerItem key={s}>
                <button type="button" onClick={() => setFilter(filter === s ? "all" : s)} aria-pressed={filter === s} className="group w-full rounded-md p-2 text-left transition-colors hover:bg-muted aria-pressed:bg-muted">
                  <div className="flex items-center gap-2 text-[13px] text-muted-foreground"><span className="size-2 rounded-full" style={{ background: STATE_COLOR[s] }} />{STATE_LABEL[s]}</div>
                  <div className="font-display text-[34px] leading-none font-extrabold tracking-[-0.03em] mt-1.5">{counts ? <CountUp value={counts[s]} /> : "–"}</div>
                </button>
              </StaggerItem>
            ))}
          </Stagger>
          {total === 0 && api.loaded ? (
            <div className="rounded-lg border border-dashed p-10 text-center"><div className="font-display text-lg font-bold">No vehicles yet</div><p className="mx-auto mt-1 max-w-md text-sm text-muted-foreground">Add your first vehicle and its tracker's ID. It takes about two minutes, and its position shows within a few minutes of the tracker getting power.</p>{can("vehicles.manage") && <Button className="mt-4" onClick={() => setAdding(true)}>Add your first vehicle</Button>}</div>
          ) : (
            <div className="overflow-hidden rounded-lg border bg-card">
              <div className="hidden grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,.8fr)] gap-4 border-b bg-muted/40 px-4 py-2 text-xs font-semibold text-muted-foreground md:grid"><div>Vehicle</div><div>Tracker ID</div><div>Connects by</div><div>Status</div><div className="text-right">Last position</div></div>
              <Stagger as="ul" className="divide-y" key={filter}>
                {rows.map((r) => (
                  <StaggerItem as="li" key={r.vehicleId}>
                    <button type="button" onClick={() => router.push(`/owner/vehicles/${r.vehicleId}?tab=tracker`)} className="grid w-full gap-1 px-4 py-3 text-left transition-colors hover:bg-muted/50 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.1fr)_minmax(0,1.2fr)_minmax(0,.8fr)] md:items-center md:gap-4">
                      <div className="min-w-0"><div className="truncate font-semibold">{r.vehicleName}</div><div className="truncate text-xs text-muted-foreground">{r.plate ?? r.vehicleKind}</div></div>
                      <div className="truncate font-mono text-[13px]">{r.device?.trackerId ?? <span className="font-sans text-muted-foreground">No tracker</span>}</div>
                      <div className="truncate text-sm text-muted-foreground">{r.device?.method ? METHOD_INFO[r.device.method].title : "–"}{r.provider ? ` · ${r.provider.name}` : ""}</div>
                      <div className="min-w-0"><StatusPill state={r.status.state} /></div>
                      <div className="text-sm tabular-nums text-muted-foreground md:text-right">{r.lastSeen ? ago(Math.round((Date.now() - Date.parse(r.lastSeen)) / 60_000)) : "–"}</div>
                    </button>
                  </StaggerItem>
                ))}
                {rows.length === 0 && <li className="px-4 py-8 text-center text-sm text-muted-foreground">Nothing in this state.</li>}
              </Stagger>
            </div>
          )}
        </>
      )}
      <AddVehicleFlow open={adding} onOpenChange={setAdding} onDone={(id) => { api.reload(); router.push(`/owner/vehicles/${id}`); }} />
    </div>
  );
}
