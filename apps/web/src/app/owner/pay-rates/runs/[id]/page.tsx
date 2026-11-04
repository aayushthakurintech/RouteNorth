"use client";
import { Check, Download } from "lucide-react";
import { useParams } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DataTable, type Col } from "@/components/portal/data-table";
import { RecordDialog, type FieldSpec } from "@/components/portal/field-form";
import { PageHeader, StatCard, StatusBadge } from "@/components/portal/parts";
import { Async } from "@/components/portal/states";
import { apiDownload, apiSend } from "@/lib/api";
import { useMe } from "@/lib/me-context";
import { PAYOUT_TONE } from "@/lib/portal/pay-form";
import { plainMoney, useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";
import { StatementDialog } from "../../payouts";

interface P { id: string; driverId: string; driverName: string; status: string; earningsCents: number; bonusCents: number; tipsCents: number; deductionCents: number; netCents: number; holdReason: string | null; employmentType: string | null; trips: number; method: string | null; paymentRef: string | null }
interface Run { id: string; from: string; to: string; cycle: string; status: string; payouts: P[]; totals: { earningsCents: number; bonusCents: number; tipsCents: number; deductionCents: number; netCents: number }; canApprove: boolean }

/** One payout run: every driver's line items, holds, approvals and the export for payroll or accounting. */
export default function RunPage() {
  const { id } = useParams<{ id: string }>();
  const fmt = useFmt(); const { can } = useMe();
  const api = useApi<Run>(`/portal/payouts/runs/${id}`);
  const [stmt, setStmt] = useState<string | null>(null); const [dlg, setDlg] = useState<{ p: P; kind: "paid" | "failed" | "send" | "hold" | "release" } | null>(null);
  const approve = can("payouts.approve"), manage = can("pay.manage") || approve;
  const act = async (path: string, ok: string, body?: unknown) => { try { await apiSend("POST", path, body); toast.success(ok); api.reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not do that"); } };
  const dl = (format: string, ext: string) => apiDownload(`/portal/payouts/runs/${id}/export?format=${format}`, `payouts-${api.data?.from ?? ""}-${api.data?.to ?? ""}-${format}.${ext}`).catch((e: Error) => toast.error(e.message));

  const columns = useMemo<Col<P>[]>(() => [
    { id: "driver", accessorKey: "driverName", header: "Driver", cell: ({ row: { original: r } }) => <button className="font-medium hover:underline" onClick={() => setStmt(r.id)}>{r.driverName}</button>, meta: { label: "Driver" } },
    { id: "type", accessorKey: "employmentType", header: "Type", cell: ({ row }) => row.original.employmentType ?? "—", meta: { label: "Employee or contractor", csv: (r) => r.employmentType ?? "" } },
    { id: "trips", accessorKey: "trips", header: "Trips", cell: ({ row }) => row.original.trips, meta: { label: "Trips", align: "end", xtype: "num" } },
    ...(["earningsCents:Earnings", "bonusCents:Bonuses", "tipsCents:Tips", "deductionCents:Deductions", "netCents:Net pay"] as const).map((s) => {
      const [k, l] = s.split(":") as [keyof P, string];
      return { id: String(k), accessorKey: k, header: l, cell: ({ row }: { row: { original: P } }) => <span className={k === "netCents" ? "font-semibold" : ""}>{fmt.money(row.original[k] as number)}</span>, meta: { label: l, align: "end", csv: (r: P) => plainMoney(r[k] as number), xtype: "num" } } as Col<P>;
    }),
    { id: "status", accessorKey: "status", header: "Status", cell: ({ row: { original: r } }) => <span title={r.holdReason ?? undefined}><StatusBadge tone={PAYOUT_TONE[r.status] ?? "neutral"}>{r.status}</StatusBadge>{r.holdReason && <StatusBadge tone="warn" className="ml-1">On hold</StatusBadge>}</span>, meta: { label: "Status" } },
    { id: "_a", header: "", enableSorting: false, cell: ({ row: { original: r } }) => (
      <span className="flex flex-wrap gap-1">
        {r.status === "draft" && !r.holdReason && approve && <Button size="sm" variant="outline" onClick={() => void act(`/portal/payouts/${r.id}/approve`, "Approved")}>Approve</Button>}
        {r.status === "draft" && manage && (r.holdReason ? approve && <Button size="sm" variant="outline" onClick={() => setDlg({ p: r, kind: "release" })}>Release hold</Button> : <Button size="sm" variant="ghost" onClick={() => setDlg({ p: r, kind: "hold" })}>Hold</Button>)}
        {r.status === "approved" && manage && <Button size="sm" variant="outline" onClick={() => setDlg({ p: r, kind: "send" })}>Mark sent</Button>}
        {["approved", "sent", "failed"].includes(r.status) && manage && <Button size="sm" variant="outline" onClick={() => setDlg({ p: r, kind: "paid" })}>Mark paid</Button>}
        {["approved", "sent"].includes(r.status) && manage && <Button size="sm" variant="ghost" onClick={() => setDlg({ p: r, kind: "failed" })}>Failed</Button>}
      </span>) },
  ], [fmt, approve, manage]); // eslint-disable-line react-hooks/exhaustive-deps

  const f = (extra: FieldSpec[]) => extra;
  const dialogs = dlg && {
    send: { title: "Mark as sent", fields: f([{ key: "method", label: "How was it sent", type: "select", options: [{ value: "etransfer", label: "Interac e-Transfer" }, { value: "bank", label: "Bank transfer" }, { value: "cheque", label: "Cheque" }, { value: "cash", label: "Cash" }, { value: "payroll", label: "Payroll provider" }] }]), path: `/portal/payouts/${dlg.p.id}/send` },
    paid: { title: "Mark as paid", fields: f([{ key: "method", label: "How was it paid", type: "select", options: [{ value: "etransfer", label: "Interac e-Transfer" }, { value: "bank", label: "Bank transfer" }, { value: "cheque", label: "Cheque" }, { value: "cash", label: "Cash" }, { value: "payroll", label: "Payroll provider" }] }, { key: "paymentRef", label: "Reference" }]), path: `/portal/payouts/${dlg.p.id}/paid` },
    failed: { title: "Payment failed", fields: f([{ key: "note", label: "What went wrong", type: "textarea", required: true, wide: true }]), path: `/portal/payouts/${dlg.p.id}/failed` },
    hold: { title: "Hold this payout", fields: f([{ key: "reason", label: "Why", type: "textarea", required: true, wide: true }]), path: `/portal/payouts/${dlg.p.id}/hold` },
    release: { title: "Release the hold", fields: f([{ key: "overrideNote", label: "Why is it fine to pay now", type: "textarea", required: true, wide: true }, { key: "release", label: "Yes, release it", type: "checkbox" }]), path: `/portal/payouts/${dlg.p.id}/hold` },
  }[dlg.kind];

  return (
    <Async state={api}>{(r) => (
      <>
        <PageHeader title={`Payout run ${fmt.date(r.from)} to ${fmt.date(r.to)}`} crumbs={[{ label: "Pay rates", href: "/owner/pay-rates" }, { label: "Payout run" }]}
          description={<>Status: <StatusBadge tone={r.status === "paid" ? "good" : r.status === "approved" ? "info" : "warn"}>{r.status}</StatusBadge>. Each driver's lines add up exactly to their net pay.</>}
          actions={<>
            {r.status === "draft" && manage && <Button size="sm" variant="outline" onClick={() => void act(`/portal/payouts/runs/${id}/rebuild`, "Rebuilt")}>Rebuild</Button>}
            {r.status === "draft" && manage && <Button size="sm" variant="outline" onClick={() => void act(`/portal/payouts/runs/${id}/cancel`, "Run cancelled")}>Cancel run</Button>}
            {r.status === "draft" && approve && <Button size="sm" onClick={() => void act(`/portal/payouts/runs/${id}/approve`, "Approved the payouts that are not on hold")}><Check className="size-4" /> Approve all</Button>}
            <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="outline"><Download className="size-4" /> Export</Button></DropdownMenuTrigger>
              <DropdownMenuContent align="end"><DropdownMenuItem onClick={() => void dl("csv", "csv")}>CSV</DropdownMenuItem><DropdownMenuItem onClick={() => void dl("xlsx", "xlsx")}>Excel</DropdownMenuItem><DropdownMenuItem onClick={() => void dl("quickbooks", "csv")}>QuickBooks layout (CSV)</DropdownMenuItem><DropdownMenuItem onClick={() => void dl("xero", "csv")}>Xero bills layout (CSV)</DropdownMenuItem></DropdownMenuContent></DropdownMenu></>} />
        <div className="mb-4 grid gap-3 sm:grid-cols-5">
          <StatCard label="Earnings" value={fmt.money(r.totals.earningsCents)} /><StatCard label="Bonuses" value={fmt.money(r.totals.bonusCents)} /><StatCard label="Tips" value={fmt.money(r.totals.tipsCents)} /><StatCard label="Deductions" value={fmt.money(-r.totals.deductionCents)} /><StatCard label="Net pay" value={fmt.money(r.totals.netCents)} />
        </div>
        <DataTable id="pay-run" data={r.payouts} columns={columns} rowId={(p) => p.id} searchText={(p) => p.driverName} selectable={false} exportName={`payout-run-${r.from}`} pageSize={50}
          empty={{ title: "Nothing in this run" } as never} />
        {stmt && <StatementDialog id={stmt} onClose={() => setStmt(null)} />}
        {dlg && dialogs && <RecordDialog open record={null} onOpenChange={(o) => !o && setDlg(null)} title={`${dialogs.title}: ${dlg.p.driverName}`} fields={dialogs.fields} method={dlg.kind === "hold" || dlg.kind === "release" ? "PATCH" : "POST"} path={dialogs.path} extra={dlg.kind === "release" ? { release: true } : undefined} onDone={api.reload} />}
      </>)}</Async>
  );
}
