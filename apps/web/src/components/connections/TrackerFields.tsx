"use client";
import { CheckCircle2, CircleAlert, Loader2, Search, TriangleAlert } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { AnimatePresence, motion } from "@/components/motion";
import { apiGet, apiSend } from "@/lib/api";
import type { ConnMeta, MethodMeta, TrackerCheck } from "@/lib/portal/connections";
import type { ConnectionMethod } from "@routenorth/shared";
import { ago } from "@routenorth/shared";
import { CopyValue, MethodCard, Steps } from "./parts";

export interface TrackerValue { method: ConnectionMethod; trackerId: string; providerConnectionId: string | null }
export const EMPTY_TRACKER: TrackerValue = { method: "traccar", trackerId: "", providerConnectionId: null };

/**
 * Pick how the tracker connects, type its ID, and see at once whether RouteNorth can use it.
 * The check runs against the server a moment after typing stops and writes nothing.
 */
export function TrackerFields({ meta, value, onChange, vehicleId, onCheck }: { meta: ConnMeta; value: TrackerValue; onChange: (v: TrackerValue) => void; vehicleId?: string | null; onCheck?: (c: TrackerCheck | null) => void }) {
  const m = meta.methods.find((x) => x.id === value.method)!;
  const accounts = meta.providers.filter((p) => p.provider === value.method);
  const [check, setCheck] = useState<TrackerCheck | null>(null);
  const [checking, setChecking] = useState(false);
  const run = useRef(0);

  // Pick the only matching provider account for the owner.
  useEffect(() => {
    if (m.needsProvider && !value.providerConnectionId && accounts.length === 1) onChange({ ...value, providerConnectionId: accounts[0]!.id });
  }, [value.method, accounts.length]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const id = value.trackerId.trim();
    if (!id) { setCheck(null); onCheck?.(null); return; }
    const mine = ++run.current;
    setChecking(true);
    const t = setTimeout(() => {
      apiSend<TrackerCheck>("POST", "/portal/connections/check", { method: value.method, trackerId: id, providerConnectionId: value.providerConnectionId, vehicleId: vehicleId ?? undefined })
        .then((c) => { if (mine === run.current) { setCheck(c); onCheck?.(c); } })
        .catch(() => { if (mine === run.current) { setCheck(null); onCheck?.(null); } })
        .finally(() => { if (mine === run.current) setChecking(false); });
    }, 450);
    return () => clearTimeout(t);
  }, [value.method, value.trackerId, value.providerConnectionId, vehicleId]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-5">
      <div>
        <div className="mb-2 text-sm font-semibold">How does this vehicle's tracker reach RouteNorth?</div>
        <div className="grid gap-2.5 sm:grid-cols-2">
          {meta.methods.map((x) => (
            <MethodCard key={x.id} m={x} selected={x.id === value.method} onSelect={() => { onChange({ ...value, method: x.id, providerConnectionId: null }); }}
              unavailable={!x.setup.ready ? "Not set up on this install yet" : null} />
          ))}
        </div>
      </div>

      {m.needsProvider && <ProviderPicker meta={meta} method={m} value={value} onChange={onChange} accounts={accounts} />}

      <div className="space-y-1.5">
        <Label htmlFor="tracker-id" className="text-sm font-semibold">{m.idLabel}</Label>
        <div className="relative">
          <Input id="tracker-id" value={value.trackerId} onChange={(e) => onChange({ ...value, trackerId: e.target.value })} placeholder={m.idPlaceholder} autoComplete="off" spellCheck={false} inputMode={value.method === "traccar" ? "numeric" : "text"} className="pr-9 font-mono" aria-describedby="tracker-id-help" aria-invalid={!!check && !check.canRegister} />
          <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2">{checking ? <Loader2 className="size-4 animate-spin text-muted-foreground" /> : check?.canRegister ? <CheckCircle2 className="size-4" style={{ color: "var(--ok)" }} /> : check && !check.canRegister ? <CircleAlert className="size-4" style={{ color: "var(--danger)" }} /> : null}</span>
        </div>
        <p id="tracker-id-help" className="text-xs text-muted-foreground">{m.idHelp}</p>
      </div>

      <AnimatePresence mode="popLayout" initial={false}>
        {check && (
          <motion.div key={check.canRegister ? "ok" : "bad"} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="space-y-2">
            {check.problems.map((p) => <Note key={p} tone="bad">{p}</Note>)}
            {check.warnings.map((p) => <Note key={p} tone="warn">{p}</Note>)}
            {check.canRegister && check.heard && <Note tone="good">A tracker with this ID reached RouteNorth {ago(Math.round((Date.now() - Date.parse(check.heard.lastSeen)) / 60_000))} ({check.heard.messages} message{check.heard.messages === 1 ? "" : "s"}). Once you save, its next position will show.</Note>}
            {check.canRegister && !check.heard && check.provider?.found && <Note tone="good">Found in {check.provider.name}: {check.provider.found.name}{check.provider.found.plate ? ` (${check.provider.found.plate})` : ""}.</Note>}
            {check.canRegister && !check.heard && !check.provider && <Note tone="good">This ID looks right and is free to use.</Note>}
          </motion.div>
        )}
      </AnimatePresence>

      <SetupPanel meta={meta} method={m} />
    </div>
  );
}

function Note({ tone, children }: { tone: "good" | "warn" | "bad"; children: React.ReactNode }) {
  const c = tone === "good" ? "var(--ok)" : tone === "warn" ? "var(--warn)" : "var(--danger)";
  const Icon = tone === "good" ? CheckCircle2 : tone === "warn" ? TriangleAlert : CircleAlert;
  return <div className="flex items-start gap-2 rounded-md px-3 py-2 text-sm" style={{ background: `color-mix(in srgb, ${c} 9%, transparent)`, color: "var(--fg)" }}><Icon className="mt-0.5 size-4 shrink-0" style={{ color: c }} aria-hidden /><span>{children}</span></div>;
}

function ProviderPicker({ method, value, onChange, accounts }: { meta: ConnMeta; method: MethodMeta; value: TrackerValue; onChange: (v: TrackerValue) => void; accounts: ConnMeta["providers"] }) {
  const name = method.id === "geotab" ? "Geotab" : "Samsara";
  const [list, setList] = useState<{ id: string; name: string; plate: string | null; linked: boolean }[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  useEffect(() => { setList(null); setErr(null); }, [value.providerConnectionId]);
  if (accounts.length === 0) {
    return <Note tone="warn">No {name} account is saved yet. <Link href="/owner/settings/connect-gps" className="font-semibold underline">Add your {name} login</Link> first, then come back here.</Note>;
  }
  async function load() {
    if (!value.providerConnectionId) return;
    setLoading(true); setErr(null);
    try { const r = await apiGet<{ vehicles: NonNullable<typeof list> }>(`/portal/connections/provider/${value.providerConnectionId}/vehicles`); setList(r.vehicles); }
    catch (e) { setErr(e instanceof Error ? e.message : "Could not load the list."); }
    finally { setLoading(false); }
  }
  return (
    <div className="space-y-2">
      <Label htmlFor="provider-acct" className="text-sm font-semibold">{name} account</Label>
      <div className="flex flex-wrap gap-2">
        <select id="provider-acct" className="h-9 min-w-48 flex-1 rounded-md border border-input bg-transparent px-3 text-sm" value={value.providerConnectionId ?? ""} onChange={(e) => onChange({ ...value, providerConnectionId: e.target.value || null })}>
          <option value="">Choose an account…</option>
          {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <button type="button" disabled={!value.providerConnectionId || loading} onClick={() => void load()} className="inline-flex h-9 items-center gap-2 rounded-md border px-3 text-sm font-semibold hover:bg-muted disabled:opacity-50">
          {loading ? <Loader2 className="size-4 animate-spin" /> : <Search className="size-4" />} Pick from {name}'s list
        </button>
      </div>
      {err && <Note tone="bad">{err}</Note>}
      {list && (
        <motion.ul initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} className="max-h-44 divide-y overflow-auto rounded-md border text-sm">
          {list.length === 0 && <li className="px-3 py-2 text-muted-foreground">{name} lists no vehicles in this account.</li>}
          {list.map((v) => (
            <li key={v.id}>
              <button type="button" disabled={v.linked} onClick={() => onChange({ ...value, trackerId: v.id })} className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left hover:bg-muted disabled:opacity-50">
                <span className="truncate font-medium">{v.name}{v.plate ? <span className="ml-2 font-normal text-muted-foreground">{v.plate}</span> : null}</span>
                <span className="shrink-0 font-mono text-xs text-muted-foreground">{v.linked ? "already linked" : v.id}</span>
              </button>
            </li>
          ))}
        </motion.ul>
      )}
    </div>
  );
}

/** What to do on the other side, and the addresses to type there, for the chosen method. */
function SetupPanel({ meta, method }: { meta: ConnMeta; method: MethodMeta }) {
  return (
    <div className="rounded-lg border bg-muted/30 p-4">
      <div className="mb-3 font-display text-sm font-bold tracking-tight">Set up on the tracker's side</div>
      {method.setup.missing.map((x) => <Note key={x} tone="warn">{x}</Note>)}
      <div className={method.setup.missing.length ? "mt-3" : ""}><Steps steps={method.setup.steps} /></div>
      {method.id === "traccar" && meta.traccarHost && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2">
          <CopyValue label="Server address" value={meta.traccarHost} />
          {meta.traccarPorts.map((p) => <CopyValue key={p.protocol} label={`${p.protocol} port`} value={String(p.port)} />)}
        </div>
      )}
      {method.id === "feed" && meta.ingestUrl && (
        <div className="mt-4 space-y-2">
          <CopyValue label="JSON push" value={`${meta.ingestUrl}/ingest/feed`} />
          <CopyValue label="Traccar forward" value={`${meta.ingestUrl}/ingest/feed/traccar?key=YOUR_KEY`} />
          <p className="text-xs text-muted-foreground">Keys are made on <Link href="/owner/settings/connect-gps" className="font-semibold underline">Connect your GPS</Link>. {meta.gpsKeys === 0 ? "You have none yet." : `You have ${meta.gpsKeys} active.`}</p>
        </div>
      )}
    </div>
  );
}
