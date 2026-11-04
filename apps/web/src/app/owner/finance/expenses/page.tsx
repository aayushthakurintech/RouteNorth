"use client";
import { Archive, Plus, RotateCcw, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DataTable, type Col } from "@/components/portal/data-table";
import { RecordDialog, type FieldSpec } from "@/components/portal/field-form";
import { PageHeader, StatCard, StatusBadge } from "@/components/portal/parts";
import { useOwnerRange } from "@/components/portal/range-context";
import { apiSend } from "@/lib/api";
import { parseCsvText } from "@/lib/csv-parse";
import { useMe } from "@/lib/me-context";
import { plainMoney, useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

interface Exp { id: string; spentOn: string; category: string; amountCents: number; taxCents: number; vendor: string | null; description: string | null; vehicleId: string | null; vehicleName: string | null; source: string; archivedAt: string | null }
interface Res { rows: Exp[]; byCategory: Record<string, number>; totalCents: number }
interface Report { line: number; ok: boolean; duplicate?: boolean; errors: string[] }
const CATS = ["fuel", "maintenance", "insurance", "finance", "tolls", "parking", "fines", "tires", "software", "payroll", "other"];

function ImportDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [rows, setRows] = useState<Record<string, string>[] | null>(null); const [report, setReport] = useState<{ ok: boolean; created: number; skippedDuplicates: number; report: Report[] } | null>(null); const [busy, setBusy] = useState(false);
  async function pick(f: File) { setReport(null); try { setRows(parseCsvText(await f.text()).rows); } catch { toast.error("Could not read that file"); } }
  async function run(dryRun: boolean) {
    setBusy(true);
    try {
      const r = await apiSend<{ ok: boolean; created: number; skippedDuplicates: number; report: Report[] }>("POST", "/portal/finance/expenses/import", { rows, dryRun }); setReport(r);
      if (!dryRun && r.ok) { toast.success(`${r.created} expenses added`); onDone(); onClose(); }
      else if (!dryRun) toast.error("Nothing was added. Fix the lines marked in red first.");
    } catch (e) { toast.error(e instanceof Error ? e.message : "Import failed"); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent className="sm:max-w-xl">
      <DialogHeader><DialogTitle>Import expenses</DialogTitle><DialogDescription>A bank or card file saved as CSV, with columns date, category, amount, tax, vendor, description, vehicle (plate or name) and ref. Lines whose ref is already in the books are skipped, so you can import the same file twice safely.</DialogDescription></DialogHeader>
      <Input type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
      {rows && <p className="text-sm">{rows.length} lines read.</p>}
      {report && <div className="text-sm"><p>{report.report.filter((r) => r.ok && !r.duplicate).length} ready, {report.skippedDuplicates} already in the books, {report.report.filter((r) => !r.ok).length} with a problem.</p>
        <ul className="max-h-40 overflow-y-auto text-xs">{report.report.filter((r) => !r.ok).slice(0, 20).map((r) => <li key={r.line} className="text-destructive">Line {r.line}: {r.errors.join("; ")}</li>)}</ul></div>}
      <DialogFooter><Button variant="outline" disabled={!rows || busy} onClick={() => void run(true)}>Check</Button><Button disabled={!rows || busy} onClick={() => void run(false)}>Import</Button></DialogFooter>
    </DialogContent></Dialog>
  );
}

/** Expenses: everything the business spent, by type. Archived lines drop out of every total and can be restored. */
export default function ExpensesPage() {
  const fmt = useFmt(); const { can } = useMe(); const { range } = useOwnerRange(); const write = can("finance.manage");
  const [showArchived, setShowArchived] = useState(false); const [adding, setAdding] = useState(false); const [editing, setEditing] = useState<Exp | null>(null); const [importing, setImporting] = useState(false);
  const api = useApi<Res>(`/portal/finance/expenses?from=${range.from}&to=${range.to}${showArchived ? "&archived=1" : ""}`);
  const cars = useApi<{ id: string; name: string }[]>(write ? "/portal/vehicles" : null);
  const fields: FieldSpec[] = [
    { key: "spentOn", label: "Date", type: "date", required: true }, { key: "category", label: "Type", type: "select", required: true, options: CATS.map((c) => ({ value: c, label: c })) },
    { key: "amountCents", label: "Amount", type: "money", required: true }, { key: "taxCents", label: "Of which tax", type: "money" },
    { key: "vendor", label: "Paid to" }, { key: "vehicleId", label: "Car", type: "select", options: (cars.data ?? []).map((v) => ({ value: v.id, label: v.name })), help: "Leave empty for a cost of the whole business" },
    { key: "description", label: "Note", wide: true },
  ];
  async function toggle(e: Exp) {
    try { await apiSend("POST", `/portal/finance/expenses/${e.id}/${e.archivedAt ? "restore" : "archive"}`); toast.success(e.archivedAt ? "Restored" : "Archived"); api.reload(); } catch (x) { toast.error(x instanceof Error ? x.message : "Could not do that"); }
  }
  const columns = useMemo<Col<Exp>[]>(() => [
    { id: "date", accessorKey: "spentOn", header: "Date", cell: ({ row }) => fmt.date(row.original.spentOn), meta: { label: "Date", csv: (r) => r.spentOn, xtype: "date" } },
    { id: "category", accessorKey: "category", header: "Type", cell: ({ row: { original: r } }) => <>{r.category}{r.archivedAt && <> <StatusBadge>archived</StatusBadge></>}</>, meta: { label: "Type" } },
    { id: "vendor", accessorFn: (r) => r.vendor ?? "", header: "Paid to", cell: ({ row }) => row.original.vendor ?? "—", meta: { label: "Paid to" } },
    { id: "car", accessorFn: (r) => r.vehicleName ?? "", header: "Car", cell: ({ row }) => row.original.vehicleName ?? "Whole business", meta: { label: "Car" } },
    { id: "amount", accessorKey: "amountCents", header: "Amount", cell: ({ row }) => fmt.money(row.original.amountCents), meta: { label: "Amount", align: "end", csv: (r) => plainMoney(r.amountCents), xtype: "num" } },
    { id: "tax", accessorKey: "taxCents", header: "Tax", cell: ({ row }) => fmt.money(row.original.taxCents), meta: { label: "Tax", align: "end", csv: (r) => plainMoney(r.taxCents), xtype: "num" } },
    { id: "source", accessorKey: "source", header: "How added", cell: ({ row }) => row.original.source, meta: { label: "How added" } },
    ...(write ? [{ id: "act", header: "", enableSorting: false, cell: ({ row: { original: r } }: { row: { original: Exp } }) => <span className="flex justify-end"><Button size="icon" variant="ghost" aria-label={r.archivedAt ? "Restore" : "Archive"} onClick={(ev) => { ev.stopPropagation(); void toggle(r); }}>{r.archivedAt ? <RotateCcw className="size-4" /> : <Archive className="size-4" />}</Button></span> } as Col<Exp>] : []),
  ], [fmt, write]);
  return (
    <>
      <PageHeader title="Expenses" description="Everything spent in the dates picked at the top. Costs tied to a car also show on that car's page."
        actions={<><Button size="sm" variant="outline" onClick={() => setShowArchived(!showArchived)}>{showArchived ? "Hide archived" : "Show archived"}</Button>{write && <><Button size="sm" variant="outline" onClick={() => setImporting(true)}><Upload className="size-4" /> Import</Button><Button size="sm" onClick={() => setAdding(true)}><Plus className="size-4" /> Add expense</Button></>}</>} />
      <div className="mb-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Total" value={fmt.money(api.data?.totalCents)} loading={!api.data} />
        {Object.entries(api.data?.byCategory ?? {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => <StatCard key={k} label={k} value={fmt.money(v)} />)}
      </div>
      <DataTable id="finance-expenses" data={api.data?.rows ?? null} loading={api.loading} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => r.id} searchText={(r) => `${r.vendor ?? ""} ${r.category} ${r.vehicleName ?? ""} ${r.description ?? ""}`} selectable={false} exportName="expenses"
        filters={[{ id: "category", label: "Type", options: CATS.map((c) => ({ value: c, label: c })), get: (r) => r.category }]} onRowClick={write ? (r) => !r.archivedAt && setEditing(r) : undefined}
        empty={{ title: "No expenses in these dates", description: "Add one, or import a bank or card file.", action: write ? <Button size="sm" onClick={() => setAdding(true)}><Plus className="size-4" /> Add expense</Button> : undefined }} />
      <RecordDialog open={adding} onOpenChange={setAdding} title="Add expense" fields={fields} method="POST" path="/portal/finance/expenses" onDone={() => { toast.success("Expense added"); api.reload(); }} />
      {editing && <RecordDialog open record={editing as unknown as Record<string, unknown>} onOpenChange={(o) => !o && setEditing(null)} title="Edit expense" fields={fields} method="PATCH" path={`/portal/finance/expenses/${editing.id}`} onDone={() => { toast.success("Saved"); api.reload(); }} />}
      {importing && <ImportDialog onClose={() => setImporting(false)} onDone={api.reload} />}
    </>
  );
}
