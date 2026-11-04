"use client";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Col } from "@/components/portal/data-table";
import { RecordDialog, type FieldSpec } from "@/components/portal/field-form";
import { StatusBadge } from "@/components/portal/parts";
import { apiSend } from "@/lib/api";
import { BONUS_KINDS, DEDUCTION_KINDS } from "@/lib/portal/pay-form";
import { plainMoney, useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";
import type { Meta } from "./cards";

interface Bonus { id: string; name: string; kind: string; amountCents: number; params: Record<string, unknown>; period: string; active: boolean; timesPaid: number }
interface Ded { id: string; driver: string; kind: string; label: string; reason: string; totalCents: number; perPayoutCents: number; takenCents: number; remainingCents: number; recurring: boolean; status: string; createdById: string }
interface Adj { id: string; driver: string; kind: string; label: string; amountCents: number; reason: string; date: string; approval: string; payoutId: string | null }

const PARAMS: Record<string, [string, string][]> = {
  trip_count: [["minTrips", "Trips needed"]], on_time: [["minPct", "On-time % needed"], ["minTrips", "At least this many trips"]], rating: [["minRating", "Rating needed (1 to 5)"], ["minTrips", "At least this many trips"]],
  peak: [], busy_zone: [["zone", "Zone"]], safety: [], streak: [["days", "Days in a row"]], tiered: [],
};

function BonusDialog({ open, onOpenChange, onDone, rec }: { open: boolean; onOpenChange: (b: boolean) => void; onDone: () => void; rec: Bonus | null }) {
  const [v, setV] = useState({ name: "", kind: "trip_count", amount: "", period: "week", p: {} as Record<string, string>, tiers: "" });
  const [seed, setSeed] = useState<string | null>(null); const [err, setErr] = useState<string | null>(null);
  const key = `${open}:${rec?.id}`;
  if (open && seed !== key) {
    setSeed(key); setErr(null);
    setV(rec ? { name: rec.name, kind: rec.kind, amount: String(rec.amountCents / 100), period: rec.period, p: Object.fromEntries(Object.entries(rec.params).filter(([k]) => k !== "tiers" && k !== "perTripCents").map(([k, x]) => [k, String(x)])), tiers: ((rec.params.tiers as { trips: number; cents: number }[]) ?? []).map((t) => `${t.trips}: ${(t.cents / 100).toFixed(2)}`).join("\n") }
      : { name: "", kind: "trip_count", amount: "", period: "week", p: {}, tiers: "" });
  }
  const perTrip = v.kind === "peak" || v.kind === "busy_zone";
  async function save() {
    setErr(null);
    try {
      const params: Record<string, unknown> = {};
      for (const [k] of PARAMS[v.kind] ?? []) if (v.p[k]) params[k] = k === "zone" ? v.p[k] : Number(v.p[k]);
      const cents = Math.round(Number(v.amount || 0) * 100);
      if (perTrip) params.perTripCents = cents;
      if (v.kind === "tiered") params.tiers = v.tiers.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [t, c] = l.split(":"); return { trips: Number(t), cents: Math.round(Number(c) * 100) }; });
      await apiSend(rec ? "PATCH" : "POST", rec ? `/portal/pay/bonuses/${rec.id}` : "/portal/pay/bonuses", { name: v.name, kind: v.kind, amountCents: perTrip ? 0 : cents, params, period: v.period });
      toast.success("Saved"); onOpenChange(false); onDone();
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not save"); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
      <DialogHeader><DialogTitle>{rec ? "Edit bonus" : "New bonus"}</DialogTitle><DialogDescription>Paid automatically in a payout run when the driver reaches the goal. Drivers see a progress bar.</DialogDescription></DialogHeader>
      <div className="space-y-3">
        <div><Label className="mb-1 block text-sm">Name *</Label><Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} placeholder="50 trips this week" /></div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div><Label className="mb-1 block text-sm">Kind</Label><Select value={v.kind} onValueChange={(k) => setV({ ...v, kind: k, p: {} })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>{BONUS_KINDS.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select></div>
          <div><Label className="mb-1 block text-sm">Counted over</Label><Select value={v.period} onValueChange={(k) => setV({ ...v, period: k })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="week">A week</SelectItem><SelectItem value="month">A month</SelectItem></SelectContent></Select></div>
        </div>
        {v.kind !== "tiered" && <div><Label className="mb-1 block text-sm">{perTrip ? "Bonus per trip ($)" : "Bonus amount ($)"} *</Label><Input value={v.amount} onChange={(e) => setV({ ...v, amount: e.target.value })} inputMode="decimal" /></div>}
        {(PARAMS[v.kind] ?? []).map(([k, l]) => <div key={k}><Label className="mb-1 block text-sm">{l}</Label><Input value={v.p[k] ?? ""} onChange={(e) => setV({ ...v, p: { ...v.p, [k]: e.target.value } })} /></div>)}
        {v.kind === "tiered" && <div><Label className="mb-1 block text-sm">Tiers</Label><textarea className="w-full rounded-md border bg-transparent p-2 text-sm" rows={3} value={v.tiers} onChange={(e) => setV({ ...v, tiers: e.target.value })} placeholder={"30: 25.00\n50: 75.00"} /><p className="mt-1 text-xs text-muted-foreground">One tier per line: trips needed, a colon, the bonus in dollars.</p></div>}
        {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
      </div>
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save} disabled={!v.name.trim()}>Save</Button></DialogFooter>
    </DialogContent></Dialog>
  );
}

export function BonusesTab({ meta }: { meta: Meta }) {
  const fmt = useFmt();
  const api = useApi<Bonus[]>("/portal/pay/bonuses");
  const [dlg, setDlg] = useState<{ rec: Bonus | null } | null>(null); const [oneOff, setOneOff] = useState(false);
  const columns = useMemo<Col<Bonus>[]>(() => [
    { id: "name", accessorKey: "name", header: "Bonus", cell: ({ row: { original: r } }) => <button className="font-medium hover:underline" onClick={() => meta.canManage && setDlg({ rec: r })}>{r.name}</button>, meta: { label: "Bonus" } },
    { id: "kind", accessorKey: "kind", header: "Kind", cell: ({ row }) => BONUS_KINDS.find((k) => k.value === row.original.kind)?.label ?? row.original.kind, meta: { label: "Kind" } },
    { id: "amount", accessorKey: "amountCents", header: "Amount", cell: ({ row: { original: r } }) => (r.kind === "tiered" ? "By tier" : r.params.perTripCents ? `${fmt.money(Number(r.params.perTripCents))} per trip` : fmt.money(r.amountCents)), meta: { label: "Amount", align: "end", csv: (r) => plainMoney(r.amountCents) } },
    { id: "period", accessorKey: "period", header: "Over", cell: ({ row }) => (row.original.period === "week" ? "A week" : "A month"), meta: { label: "Over" } },
    { id: "paid", accessorKey: "timesPaid", header: "Times paid", cell: ({ row }) => row.original.timesPaid, meta: { label: "Times paid", align: "end", xtype: "num" } },
    { id: "active", accessorKey: "active", header: "", cell: ({ row }) => (row.original.active ? <StatusBadge tone="good">On</StatusBadge> : <StatusBadge>Off</StatusBadge>), meta: { label: "Active", csv: (r) => (r.active ? "yes" : "no") } },
  ], [fmt, meta.canManage]);
  const fields: FieldSpec[] = [
    { key: "driverId", label: "Driver", type: "select", required: true, options: meta.drivers.map((d) => ({ value: d.id, label: d.name })) },
    { key: "kind", label: "Kind", type: "select", required: true, options: [{ value: "bonus", label: "One-time bonus" }, { value: "adjustment", label: "Adjustment (plus or minus)" }] },
    { key: "amountCents", label: "Amount", type: "money", required: true, help: "Use a minus sign to take money off." },
    { key: "date", label: "Counts on", type: "date" }, { key: "reason", label: "Reason", type: "textarea", required: true, wide: true },
  ];
  return (
    <div className="space-y-3">
      {meta.canManage && <div className="flex flex-wrap justify-end gap-2"><Button size="sm" variant="outline" onClick={() => setOneOff(true)}>One-time bonus or adjustment</Button><Button size="sm" onClick={() => setDlg({ rec: null })}><Plus className="size-4" /> New bonus rule</Button></div>}
      <DataTable id="pay-bonuses" data={api.data} loading={api.loading} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => r.id} searchText={(r) => r.name} selectable={false} exportName="bonus-rules"
        empty={{ title: "No bonus rules", description: "For example: complete 50 trips this week, get $75." } as never} />
      {dlg && <BonusDialog open rec={dlg.rec} onOpenChange={(o) => !o && setDlg(null)} onDone={api.reload} />}
      <RecordDialog open={oneOff} onOpenChange={setOneOff} title="One-time bonus or adjustment" description="Needs a reason. A second person approves it before it is counted." fields={fields} method="POST" path="/portal/pay/adjustments" onDone={() => toast.info("Sent for approval")} />
    </div>
  );
}

export function DeductionsTab({ meta, onChange }: { meta: Meta; onChange: () => void }) {
  const fmt = useFmt();
  const api = useApi<Ded[]>("/portal/pay/deductions");
  const adj = useApi<Adj[]>("/portal/pay/adjustments?status=pending");
  const [adding, setAdding] = useState(false);
  const act = async (path: string, ok: string) => { try { await apiSend("POST", path); toast.success(ok); api.reload(); adj.reload(); onChange(); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not do that"); } };
  const fields: FieldSpec[] = [
    { key: "driverId", label: "Driver", type: "select", required: true, options: meta.drivers.map((d) => ({ value: d.id, label: d.name })) },
    { key: "kind", label: "Kind", type: "select", required: true, options: DEDUCTION_KINDS }, { key: "label", label: "Name", required: true, placeholder: "Parking ticket" },
    { key: "totalCents", label: "Total to take back", type: "money", required: true }, { key: "perPayoutCents", label: "Most to take per payout", type: "money", help: "Empty means all at once. The company cap still applies." },
    { key: "recurring", label: "A fee taken every payout until cancelled", type: "checkbox", wide: true }, { key: "reason", label: "Reason (the driver can see it)", type: "textarea", required: true, wide: true },
  ];
  const columns = useMemo<Col<Ded>[]>(() => [
    { id: "driver", accessorKey: "driver", header: "Driver", cell: ({ row }) => row.original.driver, meta: { label: "Driver" } },
    { id: "label", accessorKey: "label", header: "Deduction", cell: ({ row: { original: r } }) => <span>{r.label}<span className="block text-xs text-muted-foreground">{r.reason}</span></span>, meta: { label: "Deduction", csv: (r) => `${r.label} (${r.reason})` } },
    { id: "total", accessorKey: "totalCents", header: "Total", cell: ({ row }) => fmt.money(row.original.totalCents), meta: { label: "Total", align: "end", csv: (r) => plainMoney(r.totalCents), xtype: "num" } },
    { id: "taken", accessorKey: "takenCents", header: "Taken so far", cell: ({ row }) => fmt.money(row.original.takenCents), meta: { label: "Taken", align: "end", csv: (r) => plainMoney(r.takenCents), xtype: "num" } },
    { id: "status", accessorKey: "status", header: "Status", cell: ({ row: { original: r } }) => <StatusBadge tone={r.status === "active" ? "good" : r.status === "pending_approval" ? "warn" : "neutral"}>{r.status.replace(/_/g, " ")}</StatusBadge>, meta: { label: "Status" } },
    ...(meta.canManage ? [{ id: "_a", header: "", enableSorting: false, cell: ({ row: { original: r } }: { row: { original: Ded } }) => (
      <span className="flex gap-1">{r.status === "pending_approval" && <Button size="sm" variant="outline" onClick={() => void act(`/portal/pay/deductions/${r.id}/approve`, "Approved")}>Approve</Button>}
        {(r.status === "pending_approval" || r.status === "active") && <Button size="sm" variant="ghost" onClick={() => void act(`/portal/pay/deductions/${r.id}/cancel`, "Cancelled")}>Cancel</Button>}</span>) } as Col<Ded>] : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [fmt, meta.canManage]);
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">Deductions are taken in parts, never more than {meta.settings.deductionCapPct}% of a driver's earnings in one payout. Drivers see every deduction with its reason.</p>
      {meta.canManage && <div className="flex justify-end"><Button size="sm" onClick={() => setAdding(true)}><Plus className="size-4" /> Add deduction</Button></div>}
      <DataTable id="pay-deductions" data={api.data} loading={api.loading} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => r.id} searchText={(r) => `${r.driver} ${r.label}`} selectable={false} exportName="deductions"
        empty={{ title: "No deductions", description: "Fines, fuel advances, equipment and loans paid back in parts show up here." } as never} />
      {(adj.data ?? []).length > 0 && <div className="rounded-md border p-3"><h3 className="mb-2 text-sm font-medium">Bonuses and adjustments waiting for approval</h3>
        <ul className="space-y-1 text-sm">{adj.data!.map((a) => <li key={a.id} className="flex flex-wrap items-center justify-between gap-2"><span>{a.driver}: {a.label} <strong className="tabular-nums">{fmt.money(a.amountCents)}</strong> <span className="text-muted-foreground">— {a.reason}</span></span>
          {meta.canManage && <span className="flex gap-1"><Button size="sm" variant="outline" onClick={() => void act(`/portal/pay/adjustments/${a.id}/approve`, "Approved")}>Approve</Button><Button size="sm" variant="ghost" onClick={() => void act(`/portal/pay/adjustments/${a.id}/reject`, "Rejected")}>Reject</Button></span>}</li>)}</ul></div>}
      <RecordDialog open={adding} onOpenChange={setAdding} title="Add a deduction" description="A second person approves it before anything is taken." fields={fields} method="POST" path="/portal/pay/deductions" onDone={() => { api.reload(); onChange(); }} />
    </div>
  );
}
