"use client";
import { useMemo } from "react";
import { DataTable, type Col } from "@/components/portal/data-table";
import { PageHeader, StatCard, StatusBadge } from "@/components/portal/parts";
import { plainMoney, useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

interface Row { id: string; number: string; customer: string; email: string | null; status: string; issuedOn: string; dueOn: string | null; subtotalCents: number; taxCents: number; totalCents: number; paidAt: string | null; overdue: boolean; daysOverdue: number | null }
interface Res { rows: Row[]; totals: { openCents: number; overdueCents: number; paidCents: number; draftCents: number } }

/** Invoices: who owes you money, and who is late. Overdue is worked out from the due date each day. */
export default function InvoicesPage() {
  const fmt = useFmt(); const api = useApi<Res>("/portal/finance/invoices");
  const columns = useMemo<Col<Row>[]>(() => [
    { id: "number", accessorKey: "number", header: "Invoice", cell: ({ row }) => <span className="font-medium">{row.original.number}</span>, meta: { label: "Invoice" } },
    { id: "customer", accessorKey: "customer", header: "Customer", cell: ({ row }) => row.original.customer, meta: { label: "Customer" } },
    { id: "status", accessorFn: (r) => (r.overdue ? "overdue" : r.status), header: "Status", cell: ({ row: { original: r } }) => <StatusBadge tone={r.overdue ? "bad" : r.status === "paid" ? "good" : r.status === "sent" ? "info" : "neutral"}>{r.overdue ? `overdue ${r.daysOverdue} days` : r.status}</StatusBadge>, meta: { label: "Status", csv: (r) => (r.overdue ? "overdue" : r.status) } },
    { id: "issued", accessorKey: "issuedOn", header: "Issued", cell: ({ row }) => fmt.date(row.original.issuedOn), meta: { label: "Issued", csv: (r) => r.issuedOn, xtype: "date" } },
    { id: "due", accessorFn: (r) => r.dueOn ?? "", header: "Due", cell: ({ row }) => (row.original.dueOn ? fmt.date(row.original.dueOn) : "—"), meta: { label: "Due", csv: (r) => r.dueOn ?? "", xtype: "date" } },
    { id: "tax", accessorKey: "taxCents", header: "Tax", cell: ({ row }) => fmt.money(row.original.taxCents), meta: { label: "Tax", align: "end", csv: (r) => plainMoney(r.taxCents), xtype: "num" } },
    { id: "total", accessorKey: "totalCents", header: "Total", cell: ({ row }) => fmt.money(row.original.totalCents), meta: { label: "Total", align: "end", csv: (r) => plainMoney(r.totalCents), xtype: "num" } },
  ], [fmt]);
  return (
    <>
      <PageHeader title="Invoices" description="Money customers owe you. Invoices are made and sent from Billing." />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Owed to you" value={fmt.money(api.data?.totals.openCents)} loading={!api.data} hint="Sent, not paid" />
        <StatCard label="Overdue" value={fmt.money(api.data?.totals.overdueCents)} loading={!api.data} hint="Past the due date" />
        <StatCard label="Paid" value={fmt.money(api.data?.totals.paidCents)} loading={!api.data} />
        <StatCard label="Drafts" value={fmt.money(api.data?.totals.draftCents)} loading={!api.data} hint="Not sent yet" />
      </div>
      <DataTable id="finance-invoices" data={api.data?.rows ?? null} loading={api.loading} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => r.id} searchText={(r) => `${r.number} ${r.customer} ${r.status}`} selectable={false} exportName="invoices"
        filters={[{ id: "status", label: "Status", options: ["draft", "sent", "paid", "overdue"].map((s) => ({ value: s, label: s })), get: (r) => (r.overdue ? "overdue" : r.status) }]}
        empty={{ title: "No invoices yet", description: "Invoices appear here once you make them in Billing." }} />
    </>
  );
}
