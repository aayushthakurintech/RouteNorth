"use client";
import { Download, Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTable, type Col } from "@/components/portal/data-table";
import { RecordDialog, type FieldSpec } from "@/components/portal/field-form";
import { StatusBadge } from "@/components/portal/parts";
import { Async } from "@/components/portal/states";
import { apiDownload } from "@/lib/api";
import { PAYOUT_TONE } from "@/lib/portal/pay-form";
import { plainMoney, useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";
import type { Meta } from "./cards";

interface Run { id: string; cycle: string; from: string; to: string; status: string; payouts: number; netCents: number; held: number; disputed: number; failed: number; createdBy: string | null }
interface Dispute { id: string; payoutId: string; driver: string; message: string; status: string; reply: string | null; createdAt: string; lineLabel: string | null; lineCents: number | null; from: string; to: string }
interface Line { id: string; label: string; cents: number; reason: string | null; kind: string }
export interface Statement {
  payout: { id: string; driverName: string; from: string; to: string; status: string; earningsCents: number; bonusCents: number; tipsCents: number; deductionCents: number; netCents: number; holdReason: string | null; employmentType: string | null };
  trips: { tripId: string; date: string; title: string | null; customer: string | null; distanceKm: number; zone: string | null; lines: Line[]; totalCents: number }[];
  bonuses: Line[]; deductions: Line[]; adjustments: Line[]; otherLines: Line[]; ratesUsed: { name: string; version: number; summary: string }[];
  disputes: { id: string; message: string; status: string; reply: string | null }[];
}

/** The driver's statement: each trip with the rate used, bonuses, deductions with reasons, tips and net pay. */
export function StatementView({ s }: { s: Statement }) {
  const fmt = useFmt();
  const money = (c: number) => <span className="tabular-nums">{fmt.money(c)}</span>;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{s.payout.driverName}</span><span className="text-muted-foreground">{fmt.date(s.payout.from)} to {fmt.date(s.payout.to)}</span><StatusBadge tone={PAYOUT_TONE[s.payout.status] ?? "neutral"}>{s.payout.status}</StatusBadge>{s.payout.employmentType && <StatusBadge>{s.payout.employmentType}</StatusBadge>}</div>
      {s.payout.holdReason && <p className="rounded-md border border-warn/40 bg-warn/10 p-2 text-warn">On hold: {s.payout.holdReason}</p>}
      <dl className="grid grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-5">
        {([["Earnings", s.payout.earningsCents], ["Bonuses", s.payout.bonusCents], ["Tips", s.payout.tipsCents], ["Deductions", -s.payout.deductionCents], ["Net pay", s.payout.netCents]] as const).map(([k, v]) => <div key={k}><dt className="text-xs text-muted-foreground">{k}</dt><dd className={k === "Net pay" ? "text-base font-semibold" : ""}>{money(v)}</dd></div>)}
      </dl>
      {s.ratesUsed.length > 0 && <p className="text-xs text-muted-foreground">Rates used: {s.ratesUsed.map((r) => `${r.name} v${r.version} (${r.summary})`).join("; ")}</p>}
      <details open={s.trips.length <= 8}><summary className="cursor-pointer font-medium">{s.trips.length} trip{s.trips.length === 1 ? "" : "s"}</summary>
        <div className="mt-2 space-y-2">{s.trips.map((t) => (
          <div key={t.tripId} className="rounded-md border p-2"><div className="flex justify-between"><span>{fmt.date(t.date)} · {t.title ?? t.customer ?? "Trip"} · {t.distanceKm} km{t.zone ? ` · ${t.zone}` : ""}</span><strong>{money(t.totalCents)}</strong></div>
            <ul className="mt-1 text-xs text-muted-foreground">{t.lines.map((l) => <li key={l.id} className="flex justify-between"><span>{l.label}</span>{money(l.cents)}</li>)}</ul></div>))}</div></details>
      {[["Bonuses", s.bonuses], ["Adjustments", s.adjustments], ["Deductions", s.deductions], ["Other", s.otherLines]].map(([title, ls]) => (ls as Line[]).length > 0 && (
        <div key={title as string}><h4 className="font-medium">{title as string}</h4><ul className="text-xs">{(ls as Line[]).map((l) => <li key={l.id} className="flex justify-between"><span>{l.label}{l.reason ? <span className="text-muted-foreground"> — {l.reason}</span> : ""}</span>{money(l.cents)}</li>)}</ul></div>))}
      {s.disputes.length > 0 && <div><h4 className="font-medium">Questions about this payout</h4><ul className="text-xs">{s.disputes.map((d) => <li key={d.id}>“{d.message}” — {d.status}{d.reply ? `: ${d.reply}` : ""}</li>)}</ul></div>}
    </div>
  );
}

export function StatementDialog({ id, base = "/portal/payouts", onClose }: { id: string; base?: string; onClose: () => void }) {
  const api = useApi<Statement>(`${base}/${id}`);
  return <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl"><DialogHeader><DialogTitle>Pay statement</DialogTitle><DialogDescription>Every line adds up to the net pay.</DialogDescription></DialogHeader><Async state={api}>{(s) => <StatementView s={s} />}</Async></DialogContent></Dialog>;
}

export function PayoutsTab({ meta }: { meta: Meta }) {
  const fmt = useFmt(); const router = useRouter();
  const runs = useApi<Run[]>("/portal/payouts/runs");
  const disputes = useApi<Dispute[]>("/portal/payouts/disputes?status=open");
  const [creating, setCreating] = useState(false); const [reply, setReply] = useState<Dispute | null>(null); const [stmt, setStmt] = useState<string | null>(null);
  const year = new Date().getFullYear();
  const runFields: FieldSpec[] = [
    { key: "cycle", label: "Pay cycle", type: "select", required: true, options: [{ value: "daily", label: "Daily" }, { value: "weekly", label: "Weekly" }, { value: "biweekly", label: "Every two weeks" }, { value: "monthly", label: "Monthly" }, { value: "custom", label: "Custom dates" }] },
    { key: "from", label: "From", type: "date", required: true }, { key: "to", label: "To", type: "date", required: true },
  ];
  const resolveFields: FieldSpec[] = [
    { key: "reply", label: "Your reply to the driver", type: "textarea", required: true, wide: true },
    { key: "fixCents", label: "Fix (plus or minus)", type: "money", help: "Added to the driver's next payout. The paid one is not changed." }, { key: "fixReason", label: "Reason for the fix" },
    { key: "reject", label: "Nothing is wrong: reject the question", type: "checkbox", wide: true },
  ];
  const columns = useMemo<Col<Run>[]>(() => [
    { id: "period", accessorKey: "from", header: "Period", cell: ({ row: { original: r } }) => <Link href={`/owner/pay-rates/runs/${r.id}`} className="font-medium hover:underline">{fmt.date(r.from)} to {fmt.date(r.to)}</Link>, meta: { label: "Period", csv: (r) => `${r.from} to ${r.to}` } },
    { id: "cycle", accessorKey: "cycle", header: "Cycle", cell: ({ row }) => row.original.cycle, meta: { label: "Cycle" } },
    { id: "status", accessorKey: "status", header: "Status", cell: ({ row: { original: r } }) => <StatusBadge tone={r.status === "paid" ? "good" : r.status === "cancelled" ? "neutral" : r.status === "approved" ? "info" : "warn"}>{r.status}</StatusBadge>, meta: { label: "Status" } },
    { id: "n", accessorKey: "payouts", header: "Drivers", cell: ({ row }) => row.original.payouts, meta: { label: "Drivers", align: "end", xtype: "num" } },
    { id: "net", accessorKey: "netCents", header: "Net pay", cell: ({ row }) => fmt.money(row.original.netCents), meta: { label: "Net pay", align: "end", csv: (r) => plainMoney(r.netCents), xtype: "num" } },
    { id: "flags", accessorFn: (r) => r.held + r.disputed + r.failed, header: "Needs attention", cell: ({ row: { original: r } }) => <span className="flex gap-1">{r.held > 0 && <StatusBadge tone="warn">{r.held} held</StatusBadge>}{r.disputed > 0 && <StatusBadge tone="warn">{r.disputed} disputed</StatusBadge>}{r.failed > 0 && <StatusBadge tone="bad">{r.failed} failed</StatusBadge>}</span>, meta: { label: "Held, disputed, failed", csv: (r) => `${r.held}/${r.disputed}/${r.failed}` } },
  ], [fmt]);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm text-muted-foreground">Pick a period, review each driver, fix problems, approve, send and mark paid.</p>
        <div className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void apiDownload(`/portal/payouts/year-end?year=${year}&format=csv`, `year-end-${year}.csv`).catch((e) => toast.error(e.message))}><Download className="size-4" /> Year-end {year}</Button>
          {meta.canManage && <Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" /> New payout run</Button>}</div>
      </div>
      <DataTable id="pay-runs" data={runs.data} loading={runs.loading} error={runs.error} onRetry={runs.reload} columns={columns} rowId={(r) => r.id} searchText={(r) => `${r.from} ${r.to} ${r.status}`} selectable={false} exportName="payout-runs"
        onRowClick={(r) => router.push(`/owner/pay-rates/runs/${r.id}`)} empty={{ title: "No payout runs yet", description: "Make a run for the last week to see what each driver is owed." } as never} />
      {(disputes.data ?? []).length > 0 && <div className="rounded-md border p-3"><h3 className="mb-2 text-sm font-medium">Questions from drivers</h3>
        <ul className="space-y-2 text-sm">{disputes.data!.map((d) => <li key={d.id} className="flex flex-wrap items-start justify-between gap-2"><span><strong>{d.driver}</strong> ({fmt.date(d.from)} to {fmt.date(d.to)}){d.lineLabel ? ` about “${d.lineLabel}”` : ""}: {d.message}</span>
          <span className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => setStmt(d.payoutId)}>Statement</Button>{meta.canManage && <Button size="sm" variant="outline" onClick={() => setReply(d)}>Reply</Button>}</span></li>)}</ul></div>}
      <RecordDialog open={creating} onOpenChange={setCreating} title="New payout run" description="Takes every approved, unpaid line up to the end date: trips, bonuses, deductions in parts, and salaries." fields={runFields} method="POST" path="/portal/payouts/runs" submitLabel="Build the run"
        onDone={(r) => router.push(`/owner/pay-rates/runs/${(r as { id: string }).id}`)} />
      {reply && <RecordDialog open record={null} onOpenChange={(o) => !o && setReply(null)} title="Reply to the driver" description={reply.message} fields={resolveFields} method="POST" path={`/portal/payouts/disputes/${reply.id}/resolve`} submitLabel="Send reply" onDone={() => { disputes.reload(); runs.reload(); }} />}
      {stmt && <StatementDialog id={stmt} onClose={() => setStmt(null)} />}
    </div>
  );
}
