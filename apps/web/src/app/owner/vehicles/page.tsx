"use client";
import { Archive, Car, ClipboardCheck, MessageSquarePlus, Plus, Upload, UserPlus } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type BuiltInView, type Col, type FilterDef } from "@/components/portal/data-table";
import { RecordDialog } from "@/components/portal/field-form";
import { PageHeader, StatusBadge } from "@/components/portal/parts";
import { apiSend } from "@/lib/api";
import { parseCsvText } from "@/lib/csv-parse";
import { useMe } from "@/lib/me-context";
import { useFmt, plainMoney } from "@/lib/portal/format";
import { KINDS, STATUS_LABEL, STATUS_TONE, STORED_STATUSES, VEHICLE_FORM } from "@/lib/portal/vehicle-fields";
import { useApi } from "@/lib/use-api";

export interface VehicleRowT {
  id: string; name: string; kind: string; plate: string | null; vin: string | null; make: string | null; model: string | null; year: number | null; status: string; odometerKm: number;
  currentDriverId: string | null; currentDriverName: string | null; teamId: string | null; depotId: string | null; tags: string[]; hasPhoto: boolean; lastSeen: string | null; lastActivity: string | null;
  service: { state: string; label?: string; dueOn?: string | null; dueKm?: number | null; reasons?: string[] } & Record<string, unknown>;
  docs: { expired: number; expiring: number; nextExpiry: string | null }; blockedReasons: string[]; monthProfitCents?: number | null; archivedAt: string | null;
}
interface Meta { teams: { id: string; name: string }[]; depots: { id: string; name: string }[]; drivers: { id: string; name: string }[] }

const SERVICE_TONE: Record<string, "good" | "warn" | "bad" | "neutral"> = { ok: "good", due_soon: "warn", overdue: "bad", none: "neutral" };
const SERVICE_LABEL: Record<string, string> = { ok: "OK", due_soon: "Due soon", overdue: "Overdue", none: "No plan" };
const IMPORT_COLUMNS = ["name", "kind", "plate", "vin", "make", "model", "year", "fuelType", "odometerKm", "ownershipType", "purchaseDate", "purchasePriceCents"];

/** Vehicles list: every car with status, driver, service and paperwork state, and what it earned this month. */
export default function VehiclesPage() {
  const fmt = useFmt();
  const router = useRouter();
  const { can } = useMe();
  const [archived, setArchived] = useState(false);
  const api = useApi<VehicleRowT[]>(`/portal/vehicles${archived ? "?archived=1" : ""}`);
  const meta = useApi<Meta>("/portal/vehicles/meta");
  const [adding, setAdding] = useState(false);
  const [importing, setImporting] = useState(false);
  const [assign, setAssign] = useState<VehicleRowT[] | null>(null);
  const [noteFor, setNoteFor] = useState<VehicleRowT[] | null>(null);
  const [statusFor, setStatusFor] = useState<VehicleRowT[] | null>(null);
  const costs = can("vehicles.costs");
  const write = can("vehicles.manage");

  const columns = useMemo<Col<VehicleRowT>[]>(() => [
    { id: "name", accessorKey: "name", header: "Car", cell: ({ row: { original: r } }) => (
      <Link href={`/owner/vehicles/${r.id}`} className="font-medium hover:underline" onClick={(e) => e.stopPropagation()}>{r.name}<span className="block text-xs font-normal text-muted-foreground">{[r.year, r.make, r.model].filter(Boolean).join(" ") || r.kind}</span></Link>
    ), meta: { label: "Car", csv: (r) => r.name } },
    { id: "plate", accessorKey: "plate", header: "Plate", cell: ({ row }) => row.original.plate ?? "—", meta: { label: "Plate" } },
    { id: "status", accessorKey: "status", header: "Status", cell: ({ row: { original: r } }) => (
      <span title={r.blockedReasons.join("; ") || undefined}><StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>{STATUS_LABEL[r.status] ?? r.status}</StatusBadge>{r.blockedReasons.length > 0 && r.status !== "out_of_service" && r.status !== "in_service" && <StatusBadge tone="bad" className="ml-1">Blocked</StatusBadge>}</span>
    ), meta: { label: "Status", csv: (r) => STATUS_LABEL[r.status] ?? r.status } },
    { id: "driver", accessorFn: (r) => r.currentDriverName ?? "", header: "Driver", cell: ({ row }) => row.original.currentDriverName ?? <span className="text-muted-foreground">Nobody</span>, meta: { label: "Driver" } },
    { id: "odometer", accessorKey: "odometerKm", header: "Odometer", cell: ({ row }) => `${fmt.num(row.original.odometerKm)} km`, meta: { label: "Odometer (km)", align: "end", csv: (r) => r.odometerKm, xtype: "num" } },
    { id: "service", accessorFn: (r) => r.service.state, header: "Service", cell: ({ row: { original: r } }) => <StatusBadge tone={SERVICE_TONE[r.service.state] ?? "neutral"}>{r.service.label ?? SERVICE_LABEL[r.service.state] ?? r.service.state}</StatusBadge>, meta: { label: "Service", csv: (r) => SERVICE_LABEL[r.service.state] ?? r.service.state } },
    { id: "docs", accessorFn: (r) => r.docs.expired * 100 + r.docs.expiring, header: "Papers", cell: ({ row: { original: r } }) => r.docs.expired ? <StatusBadge tone="bad">{r.docs.expired} expired</StatusBadge> : r.docs.expiring ? <StatusBadge tone="warn">{r.docs.expiring} expiring</StatusBadge> : <span className="text-muted-foreground">OK</span>, meta: { label: "Papers", csv: (r) => (r.docs.expired ? `${r.docs.expired} expired` : r.docs.expiring ? `${r.docs.expiring} expiring` : "OK") } },
    { id: "activity", accessorKey: "lastActivity", header: "Last active", cell: ({ row }) => fmt.date(row.original.lastActivity), meta: { label: "Last active", csv: (r) => r.lastActivity ?? "", xtype: "date" } },
    ...(costs ? [{ id: "profit", accessorKey: "monthProfitCents", header: "Profit this month", cell: ({ row: { original: r } }) => <span className={(r.monthProfitCents ?? 0) < 0 ? "text-destructive" : undefined}>{fmt.money(r.monthProfitCents)}</span>, meta: { label: "Profit this month", align: "end", csv: (r: VehicleRowT) => plainMoney(r.monthProfitCents), xtype: "num" } } as Col<VehicleRowT>] : []),
  ], [fmt, costs]);

  const filters: FilterDef<VehicleRowT>[] = [
    { id: "status", label: "Status", options: Object.entries(STATUS_LABEL).map(([value, label]) => ({ value, label })), get: (r) => r.status },
    { id: "kind", label: "Type", options: KINDS, get: (r) => r.kind },
    { id: "service", label: "Service", options: Object.entries(SERVICE_LABEL).map(([value, label]) => ({ value, label })), get: (r) => r.service.state },
    { id: "team", label: "Region", options: (meta.data?.teams ?? []).map((t) => ({ value: t.id, label: t.name })), get: (r) => r.teamId },
    { id: "depot", label: "Depot", options: (meta.data?.depots ?? []).map((t) => ({ value: t.id, label: t.name })), get: (r) => r.depotId },
  ];
  const views: BuiltInView<VehicleRowT>[] = [
    { id: "attention", name: "Needs attention", predicate: (r) => r.blockedReasons.length > 0 || r.service.state === "overdue" || r.docs.expired > 0 },
    { id: "service", name: "Service due", predicate: (r) => r.service.state === "overdue" || r.service.state === "due_soon" },
    { id: "docs", name: "Papers expiring", predicate: (r) => r.docs.expired > 0 || r.docs.expiring > 0 },
    { id: "nodriver", name: "No driver", predicate: (r) => !r.currentDriverId && r.status !== "sold" && r.status !== "archived" },
  ];

  async function bulk(action: string, ids: string[], extra: Record<string, unknown> = {}) {
    try {
      const r = await apiSend<{ done: number; skipped: { reason: string }[] }>("POST", "/portal/vehicles/bulk", { action, ids, ...extra });
      toast.success(`${r.done} car${r.done === 1 ? "" : "s"} updated${r.skipped.length ? `, ${r.skipped.length} skipped (${[...new Set(r.skipped.map((s) => s.reason))].join(", ")})` : ""}`);
      api.reload();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not update the cars"); }
  }

  return (
    <>
      <PageHeader title="Vehicles" description="Every car, truck and bus: status, driver, service and paperwork in one place."
        actions={write && (
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setImporting(true)}><Upload className="size-4" /> Import CSV</Button>
            <Button size="sm" onClick={() => setAdding(true)}><Plus className="size-4" /> Add vehicle</Button>
          </div>
        )} />
      <DataTable id="vehicles" data={api.data} loading={api.loading && !api.loaded} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => r.id}
        searchText={(r) => `${r.name} ${r.plate} ${r.vin} ${r.make} ${r.model} ${r.currentDriverName} ${r.tags.join(" ")}`} filters={filters} builtInViews={views}
        onRowClick={(r) => router.push(`/owner/vehicles/${r.id}`)} exportName="vehicles"
        toolbar={<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>}
        bulkActions={[
          ...(can("vehicles.manage", "vehicles.assign") ? [{ label: "Assign driver", icon: <UserPlus className="size-4" />, run: (rows: VehicleRowT[]) => setAssign(rows) }] : []),
          ...(write ? [
            { label: "Change status", icon: <ClipboardCheck className="size-4" />, run: (rows: VehicleRowT[]) => setStatusFor(rows) },
            { label: "Add a note", icon: <MessageSquarePlus className="size-4" />, run: (rows: VehicleRowT[]) => setNoteFor(rows) },
            { label: "Archive", icon: <Archive className="size-4" />, destructive: true, confirm: "Archive the selected cars? They leave every list but stay in old reports, and you can restore them.", run: (rows: VehicleRowT[]) => bulk("archive", rows.map((r) => r.id)) },
          ] : []),
        ]}
        renderCard={(r) => (
          <Link href={`/owner/vehicles/${r.id}`} className="block rounded-lg border p-3">
            <div className="flex items-center justify-between"><span className="font-medium">{r.name}</span><StatusBadge tone={STATUS_TONE[r.status] ?? "neutral"}>{STATUS_LABEL[r.status] ?? r.status}</StatusBadge></div>
            <div className="mt-1 text-sm text-muted-foreground">{r.plate ?? "No plate"} · {r.currentDriverName ?? "No driver"} · {fmt.num(r.odometerKm)} km</div>
          </Link>
        )}
        empty={{ title: archived ? "No archived cars" : "No vehicles yet", description: "Add your first car, or import a list from a spreadsheet.", action: write ? <Button size="sm" onClick={() => setAdding(true)}><Car className="size-4" /> Add vehicle</Button> : undefined }} />

      <RecordDialog open={adding} onOpenChange={setAdding} title="Add vehicle" description="Only the nickname and type are needed. Everything else can be filled in later." fields={VEHICLE_FORM} record={{ status: "active", kind: "truck" }}
        method="POST" path="/portal/vehicles" onDone={(r) => router.push(`/owner/vehicles/${(r as { id: string }).id}`)} />
      <ImportDialog open={importing} onOpenChange={setImporting} onDone={api.reload} />
      <AssignDialog rows={assign} drivers={meta.data?.drivers ?? []} onClose={() => setAssign(null)} onRun={(driverId, kind, startAt) => { void bulk("assign_driver", assign!.map((r) => r.id), { driverId, kind, startAt }); setAssign(null); }} />
      <TextDialog open={!!noteFor} title="Add a note to the selected cars" label="Note" onClose={() => setNoteFor(null)} onSubmit={(text) => { void bulk("note", noteFor!.map((r) => r.id), { text }); setNoteFor(null); }} />
      <StatusDialog rows={statusFor} onClose={() => setStatusFor(null)} onRun={(status) => { void bulk("status", statusFor!.map((r) => r.id), { status }); setStatusFor(null); }} />
    </>
  );
}

function TextDialog({ open, title, label, onClose, onSubmit }: { open: boolean; title: string; label: string; onClose: () => void; onSubmit: (t: string) => void }) {
  const [t, setT] = useState("");
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) { onClose(); setT(""); } }}>
      <DialogContent><DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <Input aria-label={label} value={t} onChange={(e) => setT(e.target.value)} placeholder={label} />
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!t.trim()} onClick={() => { onSubmit(t.trim()); setT(""); }}>Add note</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function StatusDialog({ rows, onClose, onRun }: { rows: VehicleRowT[] | null; onClose: () => void; onRun: (s: string) => void }) {
  const [s, setS] = useState("active");
  return (
    <Dialog open={!!rows} onOpenChange={(o) => !o && onClose()}>
      <DialogContent><DialogHeader><DialogTitle>Change status of {rows?.length} car{rows?.length === 1 ? "" : "s"}</DialogTitle><DialogDescription>On trip and Idle are worked out automatically. A car that is out of service or in service cannot be given new jobs.</DialogDescription></DialogHeader>
        <Select value={s} onValueChange={setS}><SelectTrigger aria-label="Status"><SelectValue /></SelectTrigger><SelectContent>{STORED_STATUSES.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button onClick={() => onRun(s)}>Change status</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssignDialog({ rows, drivers, onClose, onRun }: { rows: VehicleRowT[] | null; drivers: { id: string; name: string }[]; onClose: () => void; onRun: (driverId: string, kind: string, startAt: string) => void }) {
  const [driver, setDriver] = useState("");
  const [kind, setKind] = useState("day");
  const [start, setStart] = useState(() => new Date().toISOString().slice(0, 16));
  return (
    <Dialog open={!!rows} onOpenChange={(o) => !o && onClose()}>
      <DialogContent><DialogHeader><DialogTitle>Assign a driver to {rows?.length} car{rows?.length === 1 ? "" : "s"}</DialogTitle><DialogDescription>Cars or drivers that are already booked at that time are skipped and listed afterwards.</DialogDescription></DialogHeader>
        <div className="grid gap-3">
          <Select value={driver} onValueChange={setDriver}><SelectTrigger aria-label="Driver"><SelectValue placeholder="Choose a driver" /></SelectTrigger><SelectContent>{drivers.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent></Select>
          <Select value={kind} onValueChange={setKind}><SelectTrigger aria-label="For how long"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="day">For a day</SelectItem><SelectItem value="week">For a week</SelectItem><SelectItem value="permanent">Permanent</SelectItem></SelectContent></Select>
          <Input type="datetime-local" aria-label="Starts" value={start} onChange={(e) => setStart(e.target.value)} />
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!driver} onClick={() => onRun(driver, kind, new Date(start).toISOString())}>Assign</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Read a CSV in the browser, check it with the server (nothing is saved), then create the good lines. */
function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const file = useRef<HTMLInputElement>(null);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [report, setReport] = useState<{ total: number; valid: number; rows: { line: number; ok: boolean; errors: string[] }[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const reset = () => { setRows([]); setReport(null); setErr(null); };

  async function pick(f: File | undefined) {
    if (!f) return;
    reset();
    const parsed = parseCsvText(await f.text());
    if (!parsed.rows.length) { setErr("The file has no lines under the header row."); return; }
    // accept headers like "Plate", "fuel type" or "fuel_type"
    const norm = (h: string) => IMPORT_COLUMNS.find((c) => c.toLowerCase() === h.toLowerCase().replace(/[\s_-]+/g, "")) ?? h;
    const mapped = parsed.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [norm(k), v])));
    setRows(mapped);
    setBusy(true);
    try { setReport(await apiSend("POST", "/portal/vehicles/import", { rows: mapped, dryRun: true })); } catch (e) { setErr(e instanceof Error ? e.message : "Could not check the file"); } finally { setBusy(false); }
  }
  async function run() {
    setBusy(true);
    try {
      const r = await apiSend<{ created: number }>("POST", "/portal/vehicles/import", { rows, dryRun: false });
      toast.success(`${r.created} car${r.created === 1 ? "" : "s"} added`);
      onOpenChange(false); reset(); onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Import failed"); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>Import vehicles from a CSV</DialogTitle><DialogDescription>Columns: {IMPORT_COLUMNS.join(", ")}. Money is whole cents. Only name is required. The file is checked first and nothing is saved until you confirm.</DialogDescription></DialogHeader>
        <input ref={file} type="file" accept=".csv,text/csv" onChange={(e) => void pick(e.target.files?.[0])} aria-label="CSV file" />
        {busy && <p className="text-sm text-muted-foreground">Working…</p>}
        {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
        {report && (
          <div className="space-y-2 text-sm">
            <p><strong>{report.valid}</strong> of {report.total} lines are ready. {report.total - report.valid > 0 && <span className="text-destructive">{report.total - report.valid} have problems and will be skipped.</span>}</p>
            <ul className="max-h-48 space-y-1 overflow-y-auto">{report.rows.filter((r) => !r.ok).map((r) => <li key={r.line} className="rounded bg-destructive/10 px-2 py-1">Line {r.line}: {r.errors.join("; ")}</li>)}</ul>
          </div>
        )}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={busy || !report || report.valid === 0} onClick={run}>Add {report?.valid ?? 0} cars</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
