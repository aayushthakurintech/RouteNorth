"use client";
import { Loader2, RefreshCw, Unplug } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { motion } from "@/components/motion";
import { ConfirmDialog } from "@/components/portal/parts";
import { apiSend } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import { METHOD_INFO, ago } from "@routenorth/shared";
import type { ConnMeta, TrackerCheck, VehicleConnDetail } from "@/lib/portal/connections";
import { StatusExplainer, StatusPill, Steps } from "./parts";
import { EMPTY_TRACKER, TrackerFields, type TrackerValue } from "./TrackerFields";

/**
 * The connection panel on a vehicle's page: which tracker, how it connects, whether it is reporting, and the buttons to
 * connect, change or disconnect it. Refreshes on its own while the vehicle is waiting for its first position.
 */
export function ConnectionPanel({ vehicleId, canManage, onChanged }: { vehicleId: string; canManage: boolean; onChanged?: () => void }) {
  const api = useApi<VehicleConnDetail>(`/portal/connections/vehicle/${vehicleId}`, { intervalMs: 8_000 });
  const meta = useApi<ConnMeta>("/portal/connections/meta");
  const [editing, setEditing] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const c = api.data;

  if (api.error && !c) return <p className="text-sm text-destructive">Could not load the connection: {api.error.message}</p>;
  if (!c || !meta.data) return <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading the connection…</div>;

  const d = c.device;
  const method = d?.method ? METHOD_INFO[d.method] : null;
  return (
    <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="space-y-5">
      <div className="flex flex-wrap items-center gap-3">
        <StatusPill state={c.status.state} />
        {c.lastSeen && <span className="text-sm text-muted-foreground">Last position {ago(Math.round((Date.now() - Date.parse(c.lastSeen)) / 60_000))}</span>}
        <div className="ml-auto flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => { api.reload(); toast.success("Checked just now"); }}><RefreshCw className="size-4" /> Check now</Button>
          {canManage && d && <Button size="sm" variant="outline" onClick={() => setEditing(true)}>Change tracker</Button>}
          {canManage && d && <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setDisconnecting(true)}><Unplug className="size-4" /> Disconnect</Button>}
          {canManage && !d && <Button size="sm" onClick={() => setEditing(true)}>Connect a tracker</Button>}
        </div>
      </div>

      <StatusExplainer status={c.status} />

      {d && (
        <dl className="grid gap-x-8 gap-y-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <Fact label="Tracker ID" value={<code className="font-mono">{d.trackerId}</code>} />
          <Fact label="How it connects" value={method?.title ?? "Unknown"} />
          <Fact label="Provider account" value={c.provider ? c.provider.name : "None needed"} />
          <Fact label="Registered" value={new Date(d.registeredAt).toLocaleDateString()} />
        </dl>
      )}

      {c.status.state === "waiting_first_ping" && c.setup && (
        <div className="rounded-lg border bg-muted/30 p-4"><div className="mb-3 font-display text-sm font-bold tracking-tight">While you wait</div><Steps steps={c.setup.steps} /></div>
      )}

      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader><DialogTitle className="font-display text-xl font-extrabold tracking-[-0.025em]">{d ? "Change tracker" : "Connect a tracker"}</DialogTitle><DialogDescription>{d ? "The old tracker is unlinked and keeps its history." : "Link the tracker that reports this vehicle's position."}</DialogDescription></DialogHeader>
          <Editor key={String(editing)} vehicleId={vehicleId} meta={meta.data} replace={!!d} onSaved={() => { setEditing(false); api.reload(); onChanged?.(); }} />
        </DialogContent>
      </Dialog>

      <ConfirmDialog open={disconnecting} onOpenChange={setDisconnecting} destructive title="Disconnect this tracker?" confirmLabel="Disconnect"
        description="The vehicle stops showing on the live map. The tracker and everything it recorded are kept, and it can be linked again."
        onConfirm={async () => { try { await apiSend("POST", `/portal/connections/vehicle/${vehicleId}/disconnect`); toast.success("Tracker disconnected"); api.reload(); onChanged?.(); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not disconnect"); } }} />
    </motion.div>
  );
}

const Fact = ({ label, value }: { label: string; value: React.ReactNode }) => <div><dt className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{label}</dt><dd className="mt-0.5">{value}</dd></div>;

function Editor({ vehicleId, meta, replace, onSaved }: { vehicleId: string; meta: ConnMeta; replace: boolean; onSaved: () => void }) {
  const [value, setValue] = useState<TrackerValue>(EMPTY_TRACKER);
  const [check, setCheck] = useState<TrackerCheck | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setSaving(true); setError(null);
    try {
      await apiSend("POST", `/portal/connections/vehicle/${vehicleId}/connect`, { tracker: value, replace });
      toast.success("Tracker connected. We are waiting for its first position.");
      onSaved();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not connect the tracker."); }
    finally { setSaving(false); }
  }
  return (
    <div className="space-y-4">
      <TrackerFields meta={meta} value={value} onChange={setValue} vehicleId={vehicleId} onCheck={setCheck} />
      {error && <p role="alert" className="rounded-md px-3 py-2 text-sm" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>{error}</p>}
      <div className="flex justify-end border-t pt-4"><Button disabled={saving || !check?.canRegister} onClick={() => void save()}>{saving && <Loader2 className="size-4 animate-spin" />} {replace ? "Replace tracker" : "Save and connect"}</Button></div>
    </div>
  );
}
