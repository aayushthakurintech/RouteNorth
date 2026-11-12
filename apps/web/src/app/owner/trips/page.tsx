"use client";
import { Plus, Upload } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Col } from "@/components/portal/data-table";
import { RecordDialog, type FieldSpec } from "@/components/portal/field-form";
import { PageHeader, StatusBadge } from "@/components/portal/parts";
import { Async } from "@/components/portal/states";
import { apiSend } from "@/lib/api";
import { parseCsvText } from "@/lib/csv-parse";
import { useMe } from "@/lib/me-context";
import { plainMoney, useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";
import { useOwnerRange } from "@/components/portal/range-context";

interface Trip {
  id: string; vehicleName: string | null; driverName: string | null; customerName: string | null; title: string | null; startedAt: string; distanceKm: number; durationMin: number; zone: string | null; status: string;
  revenueCents: number; tipCents: number; driverPayCents: number | null; marginCents: number | null; vehicleCostCents: number | null; locked: boolean;
}
interface TripsRes { from: string; to: string; trips: Trip[]; totals: { count: number; revenueCents: number; driverPayCents: number | null } }
interface Detail extends Trip { driverLines: { id: string; label: string; cents: number; kind: string }[]; customerLines: { key: string; label: string; cents: number }[] | null; driverCard: { name: string; version: number } | null; customerCard: { name: string; version: number } | null; carCostCents: number; revenueManual: boolean }
interface Meta { drivers: { id: string; name: string }[] }

function TripDetail({ id, onClose }: { id: string; onClose: () => void }) {
  const fmt = useFmt(); const api = useApi<Detail>(`/portal/trips/${id}`);
  const [busy, setBusy] = useState(false);
  async function recalc() { setBusy(true); try { await apiSend("POST", `/portal/trips/${id}/recalculate`); toast.success("Pay worked out again"); api.reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not recalculate"); } finally { setBusy(false); } }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
      <DialogHeader><DialogTitle>Trip breakdown</DialogTitle><DialogDescription>What the customer paid, what the driver earned, what the car cost, and what was left.</DialogDescription></DialogHeader>
      <Async state={api}>{(t) => (
        <div className="space-y-3 text-sm">
          <p>{fmt.dateTime(t.startedAt)} · {t.driverName ?? "No driver"} · {t.vehicleName ?? "No car"} · {t.distanceKm.toFixed(1)} km · {t.customerName ?? "No customer"}</p>
          <div className="grid gap-4 sm:grid-cols-2">
            <div><h4 className="font-medium">Customer pays <span className="font-normal text-muted-foreground">{t.revenueManual ? "(price typed in)" : t.customerCard ? `(${t.customerCard.name} v${t.customerCard.version})` : ""}</span></h4>
              <ul className="mt-1">{(t.customerLines ?? []).map((l, i) => <li key={i} className="flex justify-between"><span>{l.label}</span><span className="tabular-nums">{fmt.money(l.cents)}</span></li>)}
                <li className="flex justify-between border-t font-medium"><span>Price used</span><span className="tabular-nums">{fmt.money(t.revenueCents)}</span></li></ul></div>
            <div><h4 className="font-medium">Driver earns <span className="font-normal text-muted-foreground">{t.driverCard ? `(${t.driverCard.name} v${t.driverCard.version})` : ""}</span></h4>
              <ul className="mt-1">{t.driverLines.map((l) => <li key={l.id} className="flex justify-between"><span>{l.label}</span><span className="tabular-nums">{fmt.money(l.cents)}</span></li>)}
                {!t.driverLines.length && <li className="text-muted-foreground">No pay lines. Assign a driver card, then recalculate.</li>}</ul></div>
          </div>
          <div className="rounded-md bg-muted p-3"><div className="flex justify-between"><span>Price</span><span className="tabular-nums">{fmt.money(t.revenueCents)}</span></div><div className="flex justify-between"><span>Driver pay (without tip)</span><span className="tabular-nums">− {fmt.money(t.driverPayCents)}</span></div>
            <div className="flex justify-between"><span>Car cost</span><span className="tabular-nums">− {fmt.money(t.carCostCents)}</span></div><div className="flex justify-between border-t pt-1 font-semibold"><span>Left for you</span><span className="tabular-nums">{fmt.money(t.marginCents)}</span></div></div>
          {t.locked ? <p className="text-xs text-muted-foreground">This trip is in a payout, so its pay is locked. Use an adjustment for changes.</p> : <Button size="sm" variant="outline" disabled={busy} onClick={recalc}>Work out the pay again</Button>}
        </div>)}</Async>
    </DialogContent></Dialog>
  );
}

function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (b: boolean) => void; onDone: () => void }) {
  const [rows, setRows] = useState<Record<string, string>[] | null>(null); const [report, setReport] = useState<{ line: number; ok: boolean; errors: string[] }[] | null>(null);
  async function pick(file: File) { const t = parseCsvText(await file.text()); setRows(t.rows); setReport(null); }
  async function run(dry: boolean) {
    try { const r = await apiSend<{ report: { line: number; ok: boolean; errors: string[] }[]; created: number; ok: boolean }>("POST", "/portal/trips/import", { rows, dryRun: dry }); setReport(r.report); if (!dry && r.ok) { toast.success(`${r.created} trips added`); onOpenChange(false); onDone(); } } catch (e) { toast.error(e instanceof Error ? e.message : "Could not import"); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
      <DialogHeader><DialogTitle>Import trips</DialogTitle><DialogDescription>A CSV with columns startedAt, driverEmail, vehicle (plate or name), customer, zone, distanceKm, durationMin, waitingMin, stops, weightKg, price, tip, toll, peak, night, weekend, holiday, weather. Money in dollars. Every line is checked first.</DialogDescription></DialogHeader>
      <Input type="file" accept=".csv,text/csv" onChange={(e) => e.target.files?.[0] && void pick(e.target.files[0])} />
      {rows && <p className="text-sm">{rows.length} lines read.</p>}
      {report && <ul className="max-h-40 overflow-y-auto text-xs">{report.filter((r) => !r.ok).slice(0, 20).map((r) => <li key={r.line} className="text-destructive">Line {r.line}: {r.errors.join("; ")}</li>)}{report.every((r) => r.ok) && <li className="text-ok">All lines look good.</li>}</ul>}
      <DialogFooter><Button variant="outline" disabled={!rows} onClick={() => void run(true)}>Check</Button><Button disabled={!rows} onClick={() => void run(false)}>Import</Button></DialogFooter>
    </DialogContent></Dialog>
  );
}

/** Trips: each job with what the customer paid, what the driver earned and what was left. Pay comes from the rate cards in force that day. */
export default function TripsPage() {
  const fmt = useFmt(); const { can } = useMe(); const { range } = useOwnerRange();
  const api = useApi<TripsRes>(`/portal/trips?from=${range.from}&to=${range.to}&limit=1000`);
  const meta = useApi<Meta>("/portal/pay/meta");
  const [open, setOpen] = useState<string | null>(null); const [adding, setAdding] = useState(false); const [importing, setImporting] = useState(false);
  const write = can("pay.manage"), pay = can("pay.view");
  const fields: FieldSpec[] = [
    { key: "startedAt", label: "Started", type: "datetime", required: true }, { key: "driverId", label: "Driver", type: "select", options: (meta.data?.drivers ?? []).map((d) => ({ value: d.id, label: d.name })) },
    { key: "customerName", label: "Customer" }, { key: "zone", label: "Zone" }, { key: "distanceKm", label: "Distance (km)", type: "number", required: true }, { key: "durationMin", label: "Time (minutes)", type: "number", required: true },
    { key: "waitingMin", label: "Waiting (minutes)", type: "number" }, { key: "stops", label: "Stops", type: "number" }, { key: "weightKg", label: "Weight (kg)", type: "number" },
    { key: "status", label: "Result", type: "select", options: [{ value: "completed", label: "Completed" }, { value: "cancelled", label: "Cancelled" }, { value: "failed", label: "Failed" }, { value: "no_show", label: "No-show" }] },
    { key: "revenueCents", label: "Price", type: "money", help: "Leave empty to price it from the customer card" }, { key: "tipCents", label: "Tip", type: "money" }, { key: "tollCents", label: "Tolls", type: "money" },
    { key: "title", label: "Title", wide: true },
  ];
  const columns = useMemo<Col<Trip>[]>(() => [
    { id: "when", accessorKey: "startedAt", header: "Started", cell: ({ row }) => fmt.dateTime(row.original.startedAt), meta: { label: "Started", csv: (r) => r.startedAt, xtype: "date" } },
    { id: "driver", accessorFn: (r) => r.driverName ?? "", header: "Driver", cell: ({ row }) => row.original.driverName ?? "—", meta: { label: "Driver" } },
    { id: "car", accessorFn: (r) => r.vehicleName ?? "", header: "Car", cell: ({ row }) => row.original.vehicleName ?? "—", meta: { label: "Car" } },
    { id: "customer", accessorFn: (r) => r.customerName ?? r.title ?? "", header: "Customer", cell: ({ row }) => row.original.customerName ?? row.original.title ?? "—", meta: { label: "Customer" } },
    { id: "km", accessorKey: "distanceKm", header: "km", cell: ({ row }) => fmt.num(row.original.distanceKm, 1), meta: { label: "Distance (km)", align: "end", xtype: "num", csv: (r) => Number(r.distanceKm.toFixed(2)) } },
    { id: "status", accessorKey: "status", header: "Result", cell: ({ row: { original: r } }) => <StatusBadge tone={r.status === "completed" ? "good" : "warn"}>{r.status.replace("_", " ")}</StatusBadge>, meta: { label: "Result" } },
    { id: "price", accessorKey: "revenueCents", header: "Customer paid", cell: ({ row }) => fmt.money(row.original.revenueCents), meta: { label: "Customer paid", align: "end", csv: (r) => plainMoney(r.revenueCents), xtype: "num" } },
    ...(pay ? [
      { id: "pay", accessorFn: (r: Trip) => r.driverPayCents ?? 0, header: "Driver earned", cell: ({ row }: { row: { original: Trip } }) => fmt.money(row.original.driverPayCents), meta: { label: "Driver earned", align: "end", csv: (r: Trip) => plainMoney(r.driverPayCents), xtype: "num" } } as Col<Trip>,
      { id: "margin", accessorFn: (r: Trip) => r.marginCents ?? 0, header: "Left for you", cell: ({ row }: { row: { original: Trip } }) => <span className={(row.original.marginCents ?? 0) < 0 ? "text-destructive" : ""}>{fmt.money(row.original.marginCents)}</span>, meta: { label: "Margin", align: "end", csv: (r: Trip) => plainMoney(r.marginCents), xtype: "num" } } as Col<Trip>] : []),
  ], [fmt, pay]);
  return (
    <>
      <PageHeader title="Trips" description="Each job with what the customer paid, what the driver earned and what was left, priced from the rate cards in force on that day."
        actions={write && <><Button size="sm" variant="outline" onClick={() => setImporting(true)}><Upload className="size-4" /> Import</Button><Button size="sm" onClick={() => setAdding(true)}><Plus className="size-4" /> Add trip</Button></>} />
      <DataTable id="trips" data={api.data?.trips ?? null} loading={api.loading} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => r.id} searchText={(r) => `${r.driverName} ${r.vehicleName} ${r.customerName} ${r.title} ${r.zone}`} selectable={false} exportName="trips" pageSize={50}
        filters={[{ id: "status", label: "Result", options: ["completed", "cancelled", "failed", "no_show"].map((v) => ({ value: v, label: v.replace("_", " ") })), get: (r) => r.status }]}
        onRowClick={(r) => setOpen(r.id)} empty={{ title: "No trips in this period", description: "Trips appear here when they are added, imported, or created from completed jobs." } as never} />
      <RecordDialog open={adding} onOpenChange={setAdding} title="Add a trip" description="The pay is worked out as soon as it is saved." fields={fields} method="POST" path="/portal/trips" onDone={api.reload} />
      <ImportDialog open={importing} onOpenChange={setImporting} onDone={api.reload} />
      {open && <TripDetail id={open} onClose={() => setOpen(null)} />}
    </>
  );
}
