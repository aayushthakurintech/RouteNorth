"use client";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Col } from "@/components/portal/data-table";
import { PageHeader, StatCard } from "@/components/portal/parts";
import { useOwnerRange } from "@/components/portal/range-context";
import { plainMoney, useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

interface Row { label: string; trips: number; revenueCents: number; driverPayCents: number; carCostCents: number; marginCents: number; marginPct: number | null }
interface Res { rows: Row[]; definition: string; totals: { revenueCents: number; marginCents: number } }
const GROUPS = [["vehicle", "Car"], ["driver", "Driver"], ["customer", "Customer"], ["route", "Route"], ["zone", "Zone"], ["day_of_week", "Day of week"], ["hour", "Hour of day"], ["rate_card", "Rate card"]] as const;

/** Margin explorer: where the business makes money and where it loses it. Worst first, so problems are at the top. */
export default function MarginPage() {
  const fmt = useFmt(); const { range } = useOwnerRange(); const [by, setBy] = useState("vehicle");
  const api = useApi<Res>(`/portal/finance/margin?from=${range.from}&to=${range.to}&by=${by}`);
  const label = GROUPS.find((g) => g[0] === by)![1];
  const bad = (n: number) => (n < 0 ? "text-destructive" : "");
  const columns = useMemo<Col<Row>[]>(() => [
    { id: "label", accessorKey: "label", header: label, cell: ({ row }) => row.original.label, meta: { label, csv: (r) => r.label } },
    { id: "trips", accessorKey: "trips", header: "Trips", cell: ({ row }) => fmt.num(row.original.trips), meta: { label: "Trips", align: "end", xtype: "num" } },
    { id: "revenue", accessorKey: "revenueCents", header: "Revenue", cell: ({ row }) => fmt.money(row.original.revenueCents), meta: { label: "Revenue", align: "end", csv: (r) => plainMoney(r.revenueCents), xtype: "num" } },
    { id: "pay", accessorKey: "driverPayCents", header: "Driver earned", cell: ({ row }) => fmt.money(row.original.driverPayCents), meta: { label: "Driver earned", align: "end", csv: (r) => plainMoney(r.driverPayCents), xtype: "num" } },
    { id: "car", accessorKey: "carCostCents", header: "Car running cost", cell: ({ row }) => fmt.money(row.original.carCostCents), meta: { label: "Car running cost", align: "end", csv: (r) => plainMoney(r.carCostCents), xtype: "num" } },
    { id: "margin", accessorKey: "marginCents", header: "Left over", cell: ({ row }) => <span className={bad(row.original.marginCents)}>{fmt.money(row.original.marginCents)}</span>, meta: { label: "Left over", align: "end", csv: (r) => plainMoney(r.marginCents), xtype: "num" } },
    { id: "pct", accessorFn: (r) => r.marginPct ?? 0, header: "Margin", cell: ({ row }) => <span className={bad(row.original.marginCents)}>{row.original.marginPct == null ? "—" : fmt.pct(row.original.marginPct, 1)}</span>, meta: { label: "Margin %", align: "end", csv: (r) => r.marginPct ?? "", xtype: "num" } },
  ], [fmt, label]);
  return (
    <>
      <PageHeader title="Margin explorer" description="Revenue minus driver pay minus the car's running cost, per trip, added up the way you choose." actions={
        <Select value={by} onValueChange={setBy}><SelectTrigger className="w-44" aria-label="Group by"><SelectValue /></SelectTrigger><SelectContent>{GROUPS.map(([k, l]) => <SelectItem key={k} value={k}>By {l.toLowerCase()}</SelectItem>)}</SelectContent></Select>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label="Revenue" value={fmt.money(api.data?.totals.revenueCents)} loading={!api.data} />
        <StatCard label="Left over" value={fmt.money(api.data?.totals.marginCents)} loading={!api.data} />
        <StatCard label="Margin" value={api.data && api.data.totals.revenueCents > 0 ? fmt.pct((100 * api.data.totals.marginCents) / api.data.totals.revenueCents, 1) : "—"} loading={!api.data} />
      </div>
      {api.data && <p className="mb-3 text-xs text-muted-foreground">{api.data.definition}</p>}
      <DataTable id={`margin-${by}`} data={api.data?.rows ?? null} loading={api.loading} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => r.label} searchText={(r) => r.label} selectable={false} exportName={`margin-by-${by}`} defaultSort={[{ id: "margin", desc: false }]}
        empty={{ title: "No completed trips in these dates", description: "Pick a longer range at the top.", action: <Button asChild size="sm" variant="outline"><Link href="/owner/start">See how data gets in</Link></Button> }} />
    </>
  );
}
