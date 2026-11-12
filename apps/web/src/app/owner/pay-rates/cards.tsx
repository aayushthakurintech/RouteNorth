"use client";
import { Check, Copy, History, Link2, Plus, X } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { DataTable, type Col } from "@/components/portal/data-table";
import { FieldInputs } from "@/components/portal/field-form";
import { ConfirmDialog, StatusBadge } from "@/components/portal/parts";
import { Async } from "@/components/portal/states";
import { apiSend } from "@/lib/api";
import { useMe } from "@/lib/me-context";
import { CARD_TONE, SPEC_FIELDS, specFromValues, valuesFromSpec } from "@/lib/portal/pay-form";
import { useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

export interface Meta { drivers: { id: string; name: string }[]; teams: { id: string; name: string }[]; vehicleKinds: string[]; customers: string[]; zones: string[]; settings: { secondApprover: boolean; deductionCapPct: number }; canManage: boolean }
interface CardRow { id: string; name: string; kind: "customer" | "driver"; state: string; notes: string | null; assignments: number; versions: number; pending: boolean; archivedAt: string | null; current: { id: string; version: number; summary: string; type: string; startsOn: string; endsOn: string | null } | null }
interface Version { id: string; version: number; summary: string; spec: Record<string, unknown>; startsOn: string; endsOn: string | null; status: string; bigChange: boolean; changeNote: string | null; createdBy: string | null; approvedBy: string | null; trips: number }
interface Detail { id: string; name: string; kind: string; notes: string | null; archivedAt: string | null; versions: Version[]; assignments: Assignment[]; history: { at: string; action: string; actor: string | null; new: unknown }[] }
interface Assignment { id: string; kind: string; target: string | null; targetName: string | null; startsOn: string; endsOn: string | null; cardName: string }
const today = () => new Date().toISOString().slice(0, 10);

/** Make or change a card: the rules, a start date and (for a change) a note. Saves a draft, then sends it for approval when it is a big change. */
export function CardEditor({ open, onOpenChange, card, from, onDone }: { open: boolean; onOpenChange: (b: boolean) => void; card: { id: string; name: string; kind: string } | null; from: Version | null; onDone: () => void }) {
  const [name, setName] = useState(""); const [kind, setKind] = useState("driver");
  const [startsOn, setStartsOn] = useState(today()); const [endsOn, setEndsOn] = useState(""); const [note, setNote] = useState("");
  const [values, setValues] = useState<Record<string, string | boolean>>(valuesFromSpec(null));
  const [busy, setBusy] = useState(false); const [error, setError] = useState<string | null>(null);
  const [seed, setSeed] = useState<string | null>(null);
  const key = `${open}:${card?.id}:${from?.id}`;
  if (open && seed !== key) { setSeed(key); setName(""); setKind(card?.kind ?? "driver"); setStartsOn(today()); setEndsOn(""); setNote(""); setValues(valuesFromSpec((from?.spec as never) ?? null)); setError(null); }

  async function save() {
    setBusy(true); setError(null);
    try {
      const spec = specFromValues(values);
      let versionId: string;
      if (card) {
        const r = await apiSend<{ id: string; bigChange: boolean }>("POST", `/portal/pay/cards/${card.id}/versions`, { spec, startsOn, endsOn: endsOn || undefined, changeNote: note || undefined });
        versionId = r.id;
      } else {
        const r = await apiSend<{ versionId: string }>("POST", "/portal/pay/cards", { name, kind, spec, startsOn, endsOn: endsOn || undefined, changeNote: note || undefined });
        versionId = r.versionId;
      }
      const s = await apiSend<{ status: string }>("POST", `/portal/pay/versions/${versionId}/submit`);
      toast.success(s.status === "pending" ? "Saved. A second person needs to approve it before it is used." : "Saved. It is live from its start date.");
      onOpenChange(false); onDone();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{card ? `New version of ${card.name}` : "New rate card"}</DialogTitle>
          <DialogDescription>{card ? "Trips before the start date keep the old rate. Changes of more than 10 percent, or a new rate type, need a second person to approve." : "A customer card sets what the customer pays. A driver card sets what the driver earns."}</DialogDescription></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          {!card && <div><Label className="mb-1 block text-sm">Name *</Label><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Standard driver pay" /></div>}
          {!card && <div><Label className="mb-1 block text-sm">What is it for *</Label>
            <Select value={kind} onValueChange={setKind}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="driver">Driver pay</SelectItem><SelectItem value="customer">Customer price</SelectItem></SelectContent></Select></div>}
          <div><Label className="mb-1 block text-sm">Starts on *</Label><Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></div>
          <div><Label className="mb-1 block text-sm">Ends on</Label><Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} /></div>
        </div>
        <FieldInputs fields={SPEC_FIELDS} values={values} set={(k, v) => setValues((s) => ({ ...s, [k]: v }))} />
        <div><Label className="mb-1 block text-sm">{card ? "Why are you changing it?" : "Note"}</Label><Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Fuel went up" maxLength={500} /></div>
        {error && <p className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-sm text-destructive" role="alert">{error}</p>}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button onClick={save} disabled={busy || (!card && !name.trim())}>{busy ? "Saving…" : "Save"}</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AssignDialog({ card, meta, open, onOpenChange, onDone }: { card: { id: string; name: string }; meta: Meta; open: boolean; onOpenChange: (b: boolean) => void; onDone: () => void }) {
  const [kind, setKind] = useState("all"); const [target, setTarget] = useState(""); const [startsOn, setStartsOn] = useState(today()); const [busy, setBusy] = useState(false);
  const options = kind === "driver" ? meta.drivers.map((d) => ({ value: d.id, label: d.name })) : kind === "group" ? meta.teams.map((t) => ({ value: t.id, label: t.name }))
    : kind === "vehicle_type" ? meta.vehicleKinds.map((v) => ({ value: v, label: v })) : kind === "customer" ? meta.customers.map((v) => ({ value: v, label: v })) : kind === "zone" ? meta.zones.map((v) => ({ value: v, label: v })) : [];
  async function go() {
    setBusy(true);
    try { await apiSend("POST", "/portal/pay/assignments", { cardId: card.id, kind, target: kind === "all" ? undefined : target, startsOn }); toast.success("Assigned"); onOpenChange(false); onDone(); }
    catch (e) { toast.error(e instanceof Error ? e.message : "Could not assign"); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}><DialogContent>
      <DialogHeader><DialogTitle>Use “{card.name}” for…</DialogTitle><DialogDescription>When more than one card applies, the most specific wins: a driver, then a customer, a zone, a vehicle type, a team, then everyone.</DialogDescription></DialogHeader>
      <div className="space-y-3">
        <Select value={kind} onValueChange={(v) => { setKind(v); setTarget(""); }}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent>
          {[["all", "Everyone (company default)"], ["group", "A team"], ["vehicle_type", "A vehicle type"], ["zone", "A zone"], ["customer", "A customer"], ["driver", "One driver"]].map(([v, l]) => <SelectItem key={v} value={v!}>{l}</SelectItem>)}</SelectContent></Select>
        {kind !== "all" && (options.length ? <Select value={target} onValueChange={setTarget}><SelectTrigger className="w-full"><SelectValue placeholder="Choose" /></SelectTrigger><SelectContent>{options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>
          : <Input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Type the exact name" />)}
        <div><Label className="mb-1 block text-sm">From</Label><Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} /></div>
      </div>
      <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={busy || (kind !== "all" && !target)} onClick={go}>Assign</Button></DialogFooter>
    </DialogContent></Dialog>
  );
}

/** One card: its versions with dates, who it is assigned to, and the change history. */
function CardDetail({ id, meta, onClose, onChange }: { id: string; meta: Meta; onClose: () => void; onChange: () => void }) {
  const fmt = useFmt(); const { me } = useMe();
  const api = useApi<Detail>(`/portal/pay/cards/${id}`);
  const [edit, setEdit] = useState<Version | "new" | null>(null); const [assign, setAssign] = useState(false); const [archive, setArchive] = useState(false);
  const reload = () => { api.reload(); onChange(); };
  const act = async (path: string, body?: unknown, ok = "Done") => { try { await apiSend("POST", path, body); toast.success(ok); reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not do that"); } };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
        <Async state={api}>{(d) => (
          <>
            <DialogHeader><DialogTitle>{d.name}</DialogTitle><DialogDescription>{d.kind === "driver" ? "What the driver earns" : "What the customer pays"}. Every change is a new version with its own dates.</DialogDescription></DialogHeader>
            {meta.canManage && !d.archivedAt && <div className="flex flex-wrap gap-2">
              <Button size="sm" onClick={() => setEdit(d.versions.find((v) => v.status !== "pending") ?? "new")}><Plus className="size-4" /> New version</Button>
              <Button size="sm" variant="outline" onClick={() => setAssign(true)}><Link2 className="size-4" /> Assign</Button>
              <Button size="sm" variant="outline" onClick={() => act(`/portal/pay/cards/${id}/clone`, {}, "Copied as a new card")}><Copy className="size-4" /> Clone</Button>
              <Button size="sm" variant="outline" onClick={() => setArchive(true)}>Archive</Button></div>}
            <h3 className="text-sm font-medium">Versions</h3>
            <div className="space-y-2">{d.versions.map((v) => (
              <div key={v.id} className="rounded-md border p-3 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="font-medium">Version {v.version} <StatusBadge tone={CARD_TONE[v.status] ?? "neutral"}>{v.status === "pending" ? "Waiting for approval" : v.status}</StatusBadge>{v.bigChange && <StatusBadge tone="warn" className="ml-1">Big change</StatusBadge>}</div>
                  <div className="text-muted-foreground">{fmt.date(v.startsOn)} to {v.endsOn ? fmt.date(v.endsOn) : "no end date"}</div></div>
                <p className="mt-1">{v.summary}</p>
                <p className="text-xs text-muted-foreground">{v.changeNote ?? ""} {v.createdBy ? `Made by ${v.createdBy}. ` : ""}{v.approvedBy ? `Approved by ${v.approvedBy}. ` : ""}{v.trips} trip{v.trips === 1 ? "" : "s"} priced with this version.</p>
                {meta.canManage && v.status === "draft" && <div className="mt-2 flex gap-2"><Button size="sm" onClick={() => act(`/portal/pay/versions/${v.id}/submit`, undefined, "Submitted")}>Submit</Button><Button size="sm" variant="outline" onClick={() => setEdit(v)}>Edit as new</Button></div>}
                {meta.canManage && v.status === "pending" && <div className="mt-2 flex gap-2"><Button size="sm" onClick={() => act(`/portal/pay/versions/${v.id}/approve`, undefined, "Approved")}><Check className="size-4" /> Approve</Button>
                  <Button size="sm" variant="outline" onClick={() => { const note = window.prompt("Why is it sent back?"); if (note) void act(`/portal/pay/versions/${v.id}/reject`, { note }, "Sent back"); }}><X className="size-4" /> Send back</Button></div>}
              </div>))}</div>
            <h3 className="text-sm font-medium">Used for</h3>
            {d.assignments.length ? <ul className="space-y-1 text-sm">{d.assignments.map((a) => (
              <li key={a.id} className="flex items-center justify-between rounded-md border px-3 py-2"><span>{({ all: "Everyone", driver: "Driver", customer: "Customer", zone: "Zone", vehicle_type: "Vehicle type", group: "Team" } as Record<string, string>)[a.kind]}{a.target ? `: ${a.targetName ?? a.target}` : ""} <span className="text-muted-foreground">from {fmt.date(a.startsOn)}{a.endsOn ? ` to ${fmt.date(a.endsOn)}` : ""}</span></span>
                {meta.canManage && <Button size="sm" variant="ghost" onClick={() => act(`/portal/pay/assignments/${a.id}/end`, {}, "Ended")}>End</Button>}</li>))}</ul>
              : <p className="text-sm text-muted-foreground">Not assigned yet, so no trip uses this card.</p>}
            <h3 className="flex items-center gap-1 text-sm font-medium"><History className="size-4" /> History</h3>
            {d.history.length ? <ul className="space-y-1 text-xs text-muted-foreground">{d.history.map((h, i) => <li key={i}>{fmt.dateTime(h.at)} · {h.actor ?? "System"} · {h.action.replace(/_/g, " ").replace(/\./g, ": ")}</li>)}</ul> : <p className="text-sm text-muted-foreground">No changes yet.</p>}
            {edit && <CardEditor open card={{ id: d.id, name: d.name, kind: d.kind }} from={edit === "new" ? null : edit} onOpenChange={(o) => !o && setEdit(null)} onDone={reload} />}
            {assign && <AssignDialog open card={d} meta={meta} onOpenChange={setAssign} onDone={reload} />}
            <ConfirmDialog open={archive} onOpenChange={setArchive} title={`Archive ${d.name}?`} description="Trips keep the rate they were priced with. The card stops being used for new trips, and you can bring it back later." confirmLabel="Archive" destructive
              onConfirm={async () => { await act(`/portal/pay/cards/${id}/archive`, undefined, "Archived"); onClose(); }} />
            {me && !meta.canManage && <p className="text-xs text-muted-foreground">You can look at rate cards but not change them.</p>}
          </>)}</Async>
      </DialogContent>
    </Dialog>
  );
}

export function CardsTab({ meta, onChange }: { meta: Meta; onChange: () => void }) {
  const fmt = useFmt();
  const [archived, setArchived] = useState(false);
  const api = useApi<CardRow[]>(`/portal/pay/cards${archived ? "?archived=1" : ""}`);
  const [open, setOpen] = useState<string | null>(null); const [creating, setCreating] = useState(false);
  const columns = useMemo<Col<CardRow>[]>(() => [
    { id: "name", accessorKey: "name", header: "Card", cell: ({ row: { original: r } }) => <button className="text-left font-medium hover:underline" onClick={() => setOpen(r.id)}>{r.name}</button>, meta: { label: "Card" } },
    { id: "kind", accessorKey: "kind", header: "For", cell: ({ row }) => (row.original.kind === "driver" ? "Driver pay" : "Customer price"), meta: { label: "For" } },
    { id: "state", accessorKey: "state", header: "State", cell: ({ row: { original: r } }) => <><StatusBadge tone={CARD_TONE[r.state] ?? "neutral"}>{r.state}</StatusBadge>{r.pending && <StatusBadge tone="warn" className="ml-1">Change waiting</StatusBadge>}</>, meta: { label: "State" } },
    { id: "rate", accessorFn: (r) => r.current?.summary ?? "", header: "Rate", cell: ({ row }) => row.original.current?.summary ?? "—", meta: { label: "Rate" } },
    { id: "since", accessorFn: (r) => r.current?.startsOn ?? "", header: "Version", cell: ({ row: { original: r } }) => (r.current ? `v${r.current.version} from ${fmt.date(r.current.startsOn)}` : "—"), meta: { label: "Version", csv: (r) => r.current ? `v${r.current.version} from ${r.current.startsOn}` : "" } },
    { id: "assign", accessorKey: "assignments", header: "Assigned", cell: ({ row }) => row.original.assignments, meta: { label: "Assignments", align: "end", xtype: "num", csv: (r) => r.assignments } },
  ], [fmt]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>
        {meta.canManage && <Button size="sm" onClick={() => setCreating(true)}><Plus className="size-4" /> New rate card</Button>}
      </div>
      <DataTable id="pay-cards" data={api.data} loading={api.loading} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => r.id} searchText={(r) => `${r.name} ${r.current?.summary ?? ""}`} selectable={false} exportName="rate-cards"
        filters={[{ id: "kind", label: "For", options: [{ value: "driver", label: "Driver pay" }, { value: "customer", label: "Customer price" }], get: (r) => r.kind }, { id: "state", label: "State", options: ["draft", "pending", "active", "scheduled", "expired", "archived"].map((v) => ({ value: v, label: v })), get: (r) => r.state }]}
        onRowClick={(r) => setOpen(r.id)} empty={{ title: "No rate cards yet", description: "Make a customer card and a driver card, then assign them. Trips are priced from the card that applies on their day." } as never} />
      {creating && <CardEditor open card={null} from={null} onOpenChange={setCreating} onDone={() => { api.reload(); onChange(); }} />}
      {open && <CardDetail id={open} meta={meta} onClose={() => setOpen(null)} onChange={() => { api.reload(); onChange(); }} />}
    </div>
  );
}
