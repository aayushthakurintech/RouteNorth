"use client";
import { Button } from "@/components/ui/button";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Col } from "@/components/portal/data-table";
import { Bars } from "@/components/portal/charts";
import { PageHeader, StatCard } from "@/components/portal/parts";
import { useOwnerRange } from "@/components/portal/range-context";
import { plainMoney, useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

interface Row { label: string; trips: number; revenueCents: number; tipsCents: number; km: number }
interface Res { from: string; to: string; by: string; rows: Row[]; totals: { trips: number; revenueCents: number; tipsCents: number } }
const GROUPS = [["day", "Day"], ["customer", "Customer"], ["vehicle", "Car"], ["driver", "Driver"], ["route", "Route"], ["zone", "Zone"]] as const;

/** Earnings: what customers paid for completed trips, grouped the way you ask. Tips are shown but are not part of revenue. */
export default function EarningsPage() {
  const fmt = useFmt(); const { range } = useOwnerRange(); const [by, setBy] = useState("day");
  const api = useApi<Res>(`/portal/finance/earnings?from=${range.from}&to=${range.to}&by=${by}`);
  const label = GROUPS.find((g) => g[0] === by)![1];
  const columns = useMemo<Col<Row>[]>(() => [
    { id: "label", accessorKey: "label", header: label, cell: ({ row }) => by === "day" ? fmt.date(row.original.label) : row.original.label, meta: { label, csv: (r) => r.label } },
    { id: "trips", accessorKey: "trips", header: "Trips", cell: ({ row }) => fmt.num(row.original.trips), meta: { label: "Trips", align: "end", xtype: "num" } },
    { id: "km", accessorKey: "km", header: "km", cell: ({ row }) => fmt.num(row.original.km, 1), meta: { label: "km", align: "end", xtype: "num", csv: (r) => Number(r.km.toFixed(2)) } },
    { id: "revenue", accessorKey: "revenueCents", header: "Revenue", cell: ({ row }) => fmt.money(row.original.revenueCents), meta: { label: "Revenue", align: "end", csv: (r) => plainMoney(r.revenueCents), xtype: "num" } },
    { id: "tips", accessorKey: "tipsCents", header: "Tips", cell: ({ row }) => fmt.money(row.original.tipsCents), meta: { label: "Tips", align: "end", csv: (r) => plainMoney(r.tipsCents), xtype: "num" } },
  ], [fmt, by, label]);
  const top = by === "day" ? [] : (api.data?.rows ?? []).slice(0, 6);
  return (
    <>
      <PageHeader title="Earnings" description="What customers paid for completed trips in the dates picked at the top." actions={
        <Select value={by} onValueChange={setBy}><SelectTrigger className="w-40" aria-label="Group by"><SelectValue /></SelectTrigger><SelectContent>{GROUPS.map(([k, l]) => <SelectItem key={k} value={k}>By {l.toLowerCase()}</SelectItem>)}</SelectContent></Select>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label="Revenue" value={fmt.money(api.data?.totals.revenueCents)} loading={!api.data} href="/owner/trips" />
        <StatCard label="Trips" value={fmt.num(api.data?.totals.trips)} loading={!api.data} />
        <StatCard label="Tips" value={fmt.money(api.data?.totals.tipsCents)} loading={!api.data} hint="Paid on to drivers, not counted as revenue" />
      </div>
      {top.length > 1 && <div className="mb-4 rounded-lg border p-3"><h2 className="mb-2 text-sm font-medium">Biggest {label.toLowerCase()}s</h2><Bars format={fmt.money} rows={top.map((r) => ({ label: r.label, value: r.revenueCents }))} /></div>}
      <DataTable id={`earnings-${by}`} data={api.data?.rows ?? null} loading={api.loading} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => r.label} searchText={(r) => r.label} selectable={false} exportName={`earnings-by-${by}`}
        empty={{ title: "No completed trips in these dates", description: "Pick a longer range at the top, or add trips on the Trips page.", action: <Button asChild size="sm" variant="outline"><Link href="/owner/trips">Open trips</Link></Button> }} />
    </>
  );
}
