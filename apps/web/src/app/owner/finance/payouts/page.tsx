"use client";
import { useMemo, useState } from "react";
import Link from "next/link";
import { DataTable, type Col } from "@/components/portal/data-table";
import { PageHeader, StatCard, StatusBadge } from "@/components/portal/parts";
import { useOwnerRange } from "@/components/portal/range-context";
import { StatementDialog } from "../../pay-rates/payouts";
import { plainMoney, useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

interface Row { id: string; runId: string; driver: string; from: string; to: string; status: string; netCents: number; holdReason: string | null; paidAt: string | null }
interface Res { rows: Row[]; totals: { paidCents: number; waitingCents: number; unbuiltCents: number } }

/** Payouts as the books see them. Building, approving and paying them happens under Pay rates. */
export default function FinancePayoutsPage() {
  const fmt = useFmt(); const { range } = useOwnerRange(); const [open, setOpen] = useState<string | null>(null);
  const api = useApi<Res>(`/portal/finance/payouts?from=${range.from}&to=${range.to}`);
  const columns = useMemo<Col<Row>[]>(() => [
    { id: "driver", accessorKey: "driver", header: "Driver", cell: ({ row }) => row.original.driver, meta: { label: "Driver" } },
    { id: "period", accessorKey: "from", header: "Period", cell: ({ row: { original: r } }) => <Link href={`/owner/pay-rates/runs/${r.runId}`} className="hover:underline" onClick={(e) => e.stopPropagation()}>{fmt.date(r.from)} to {fmt.date(r.to)}</Link>, meta: { label: "Period", csv: (r) => `${r.from} to ${r.to}` } },
    { id: "status", accessorKey: "status", header: "Status", cell: ({ row: { original: r } }) => <StatusBadge tone={r.status === "paid" ? "good" : r.status === "failed" || r.status === "disputed" ? "bad" : "warn"}>{r.status}</StatusBadge>, meta: { label: "Status" } },
    { id: "net", accessorKey: "netCents", header: "Net pay", cell: ({ row }) => fmt.money(row.original.netCents), meta: { label: "Net pay", align: "end", csv: (r) => plainMoney(r.netCents), xtype: "num" } },
    { id: "paid", accessorFn: (r) => r.paidAt ?? "", header: "Paid on", cell: ({ row }) => (row.original.paidAt ? fmt.date(row.original.paidAt) : "—"), meta: { label: "Paid on", csv: (r) => r.paidAt ?? "" } },
    { id: "hold", accessorFn: (r) => r.holdReason ?? "", header: "On hold because", cell: ({ row }) => row.original.holdReason ?? "", meta: { label: "On hold because", csv: (r) => r.holdReason ?? "" } },
  ], [fmt]);
  return (
    <>
      <PageHeader title="Payouts" description="Driver payouts for the dates picked at the top. Build, approve and mark them paid under Pay rates." />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label="Paid" value={fmt.money(api.data?.totals.paidCents)} loading={!api.data} />
        <StatCard label="Waiting to be paid" value={fmt.money(api.data?.totals.waitingCents)} loading={!api.data} href="/owner/pay-rates" />
        <StatCard label="Earned, not in a payout yet" value={fmt.money(api.data?.totals.unbuiltCents)} loading={!api.data} hint="Approved lines not yet in a run" />
      </div>
      <DataTable id="finance-payouts" data={api.data?.rows ?? null} loading={api.loading} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => r.id} searchText={(r) => `${r.driver} ${r.status}`} selectable={false} exportName="payouts" onRowClick={(r) => setOpen(r.id)}
        empty={{ title: "No payouts in these dates", description: "Make a payout run under Pay rates." }} />
      {open && <StatementDialog id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
