"use client";
import { ArrowLeft, ArrowRight, Check, Loader2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AnimatePresence, motion } from "@/components/motion";
import { apiSend } from "@/lib/api";
import { useApi } from "@/lib/use-api";
import type { ConnMeta, TrackerCheck, VehicleConnDetail } from "@/lib/portal/connections";
import { StatusExplainer, StatusPill } from "./parts";
import { EMPTY_TRACKER, TrackerFields, type TrackerValue } from "./TrackerFields";

const KINDS = [["truck", "Truck"], ["bus", "Bus"], ["van", "Van"], ["car", "Car"], ["suv", "SUV"], ["other", "Other"]] as const;
const STEPS = ["Vehicle", "Tracker", "Connect"] as const;

interface Draft { name: string; kind: string; plate: string; make: string; model: string; year: string }
const EMPTY: Draft = { name: "", kind: "truck", plate: "", make: "", model: "", year: "" };

/**
 * Add a vehicle and connect its tracker in one flow: the vehicle, then how its tracker reaches RouteNorth, then a live
 * view of the connection coming up. The tracker step can be skipped; the vehicle is then saved with no tracker and the
 * connection panel on its page finishes the job later.
 */
export function AddVehicleFlow({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: (vehicleId: string) => void }) {
  const meta = useApi<ConnMeta>(open ? "/portal/connections/meta" : null);
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  const [tracker, setTracker] = useState<TrackerValue>(EMPTY_TRACKER);
  const [check, setCheck] = useState<TrackerCheck | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [vehicleId, setVehicleId] = useState<string | null>(null);
  const [withTracker, setWithTracker] = useState(false);

  useEffect(() => { if (open) { setStep(0); setDraft(EMPTY); setTracker(EMPTY_TRACKER); setCheck(null); setError(null); setVehicleId(null); setWithTracker(false); } }, [open]);

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));
  const vehicleOk = draft.name.trim().length > 0;

  async function save(useTracker: boolean) {
    setSaving(true); setError(null);
    const year = draft.year.trim() ? Number(draft.year) : undefined;
    const body: Record<string, unknown> = { name: draft.name.trim(), kind: draft.kind, ...(draft.plate.trim() ? { plate: draft.plate.trim() } : {}), ...(draft.make.trim() ? { make: draft.make.trim() } : {}), ...(draft.model.trim() ? { model: draft.model.trim() } : {}), ...(year && Number.isFinite(year) ? { year } : {}) };
    if (useTracker) body.tracker = { method: tracker.method, trackerId: tracker.trackerId, providerConnectionId: tracker.providerConnectionId };
    try {
      const v = await apiSend<{ id: string }>("POST", "/portal/vehicles", body);
      setVehicleId(v.id); setWithTracker(useTracker); setStep(2);
    } catch (e) { setError(e instanceof Error ? e.message : "Could not save the vehicle."); }
    finally { setSaving(false); }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[92vh] gap-0 overflow-y-auto p-0 sm:max-w-2xl">
        <DialogHeader className="border-b px-6 pb-4 pt-6 text-left">
          <DialogTitle className="font-display text-xl font-extrabold tracking-[-0.025em]">Add a vehicle</DialogTitle>
          <DialogDescription>Tell us about the vehicle, then connect the tracker that reports its position.</DialogDescription>
          <ol className="mt-3 flex items-center gap-2" aria-label="Progress">
            {STEPS.map((s, i) => (
              <li key={s} className="flex flex-1 items-center gap-2" aria-current={i === step ? "step" : undefined}>
                <span className={`flex size-6 items-center justify-center rounded-full text-xs font-bold transition-colors ${i < step ? "bg-primary text-primary-foreground" : i === step ? "bg-foreground text-background" : "bg-muted text-muted-foreground"}`}>{i < step ? <Check className="size-3.5" /> : i + 1}</span>
                <span className={`text-sm ${i === step ? "font-semibold" : "text-muted-foreground"}`}>{s}</span>
                {i < STEPS.length - 1 && <span className="relative h-px flex-1 bg-border"><motion.span className="absolute inset-y-0 left-0 bg-primary" initial={false} animate={{ width: i < step ? "100%" : "0%" }} /></span>}
              </li>
            ))}
          </ol>
        </DialogHeader>

        <div className="px-6 py-5">
          <AnimatePresence mode="wait" initial={false}>
            {step === 0 && (
              <motion.form key="s0" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} className="space-y-4" onSubmit={(e) => { e.preventDefault(); if (vehicleOk) setStep(1); }}>
                <div className="space-y-1.5"><Label htmlFor="v-name" className="font-semibold">Name</Label><Input id="v-name" autoFocus value={draft.name} onChange={(e) => set("name", e.target.value)} placeholder="Truck 12, Bus 3, Van 8…" maxLength={120} /><p className="text-xs text-muted-foreground">What your drivers and dispatchers call it.</p></div>
                <div className="space-y-1.5"><Label className="font-semibold">Type</Label>
                  <div className="flex flex-wrap gap-2">{KINDS.map(([k, label]) => <button key={k} type="button" aria-pressed={draft.kind === k} onClick={() => set("kind", k)} className={`rounded-md border px-3 py-1.5 text-sm font-semibold transition-colors ${draft.kind === k ? "border-primary bg-primary/10 text-primary" : "hover:bg-muted"}`}>{label}</button>)}</div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5"><Label htmlFor="v-plate" className="font-semibold">Licence plate <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="v-plate" value={draft.plate} onChange={(e) => set("plate", e.target.value)} maxLength={20} /></div>
                  <div className="space-y-1.5"><Label htmlFor="v-year" className="font-semibold">Year <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="v-year" inputMode="numeric" value={draft.year} onChange={(e) => set("year", e.target.value.replace(/\D/g, "").slice(0, 4))} /></div>
                  <div className="space-y-1.5"><Label htmlFor="v-make" className="font-semibold">Make <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="v-make" value={draft.make} onChange={(e) => set("make", e.target.value)} maxLength={60} /></div>
                  <div className="space-y-1.5"><Label htmlFor="v-model" className="font-semibold">Model <span className="font-normal text-muted-foreground">(optional)</span></Label><Input id="v-model" value={draft.model} onChange={(e) => set("model", e.target.value)} maxLength={60} /></div>
                </div>
                <div className="flex justify-end pt-2"><Button type="submit" disabled={!vehicleOk}>Next: tracker <ArrowRight className="size-4" /></Button></div>
              </motion.form>
            )}

            {step === 1 && (
              <motion.div key="s1" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0, x: -16 }} className="space-y-4">
                {meta.data ? <TrackerFields meta={meta.data} value={tracker} onChange={setTracker} onCheck={setCheck} /> : <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin" /> Loading…</div>}
                {error && <p role="alert" className="rounded-md px-3 py-2 text-sm" style={{ background: "var(--danger-soft)", color: "var(--danger)" }}>{error}</p>}
                <div className="flex flex-wrap items-center justify-between gap-2 border-t pt-4">
                  <Button type="button" variant="ghost" onClick={() => setStep(0)}><ArrowLeft className="size-4" /> Back</Button>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button type="button" variant="outline" disabled={saving} onClick={() => void save(false)}>Skip, add the tracker later</Button>
                    <Button type="button" disabled={saving || !check?.canRegister} onClick={() => void save(true)}>{saving && <Loader2 className="size-4 animate-spin" />} Save and connect</Button>
                  </div>
                </div>
              </motion.div>
            )}

            {step === 2 && vehicleId && (
              <motion.div key="s2" initial={{ opacity: 0, x: 16 }} animate={{ opacity: 1, x: 0 }} className="space-y-4">
                <LiveConnection vehicleId={vehicleId} name={draft.name.trim()} withTracker={withTracker} />
                <div className="flex flex-wrap justify-between gap-2 border-t pt-4">
                  <Button variant="outline" asChild><Link href={`/owner/vehicles/${vehicleId}`} onClick={() => onOpenChange(false)}>Open {draft.name.trim() || "vehicle"}</Link></Button>
                  <Button onClick={() => { onOpenChange(false); onDone(vehicleId); }}>Done</Button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </DialogContent>
    </Dialog>
  );
}

/** Watches the connection come up: refreshes every few seconds until the first position arrives. */
function LiveConnection({ vehicleId, name, withTracker }: { vehicleId: string; name: string; withTracker: boolean }) {
  const api = useApi<VehicleConnDetail>(`/portal/connections/vehicle/${vehicleId}`, { intervalMs: 4_000 });
  const c = api.data;
  if (!withTracker) {
    return (
      <div className="space-y-3">
        <motion.div initial={{ scale: 0.9, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} className="flex items-center gap-3"><span className="flex size-9 items-center justify-center rounded-full bg-primary text-primary-foreground"><Check className="size-5" /></span><div><div className="font-display text-lg font-bold tracking-tight">{name} is saved</div><div className="text-sm text-muted-foreground">No tracker yet, so it will not appear on the live map. You can add one any time from its page or the Connections page.</div></div></motion.div>
      </div>
    );
  }
  const state = c?.status.state ?? "waiting_first_ping";
  const stages = [
    { label: "Vehicle saved", done: true },
    { label: "Tracker registered", done: !!c?.device },
    { label: c?.device?.method === "geotab" || c?.device?.method === "samsara" ? "Asking your provider" : "Listening for the tracker", done: state === "connected" || state === "quiet" },
    { label: "First position received", done: state === "connected" || state === "quiet" },
  ];
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3"><div className="font-display text-lg font-bold tracking-tight">{name}</div>{c && <StatusPill state={c.status.state} />}</div>
      <ul className="space-y-2.5">
        {stages.map((s, i) => {
          const active = !s.done && stages.slice(0, i).every((x) => x.done);
          return (
            <motion.li key={s.label} initial={{ opacity: 0, x: -8 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: i * 0.08 }} className="flex items-center gap-3 text-sm">
              <span className={`flex size-5 items-center justify-center rounded-full border text-[10px] ${s.done ? "border-transparent bg-primary text-primary-foreground" : active ? "border-amber-500" : "text-muted-foreground"}`} style={active ? { borderColor: "var(--amber)" } : undefined}>
                {s.done ? <Check className="size-3" /> : active ? <Loader2 className="size-3 animate-spin" /> : ""}
              </span>
              <span className={s.done ? "" : active ? "font-semibold" : "text-muted-foreground"}>{s.label}</span>
            </motion.li>
          );
        })}
      </ul>
      {c && <StatusExplainer status={c.status} />}
      {c?.lastPosition && <p className="text-sm text-muted-foreground">Last position: {c.lastPosition.lat.toFixed(4)}, {c.lastPosition.lng.toFixed(4)} · {c.lastPosition.speedKmh} km/h</p>}
    </div>
  );
}
