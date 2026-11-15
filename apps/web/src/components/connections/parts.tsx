"use client";
import { AlertTriangle, CheckCircle2, CircleAlert, Radio } from "lucide-react";
import { motion, AnimatePresence, PulseDot } from "@/components/motion";
import { cn } from "@/lib/utils";
import { STATE_COLOR, STATE_LABEL, type ConnStatus } from "@/lib/portal/connections";
import type { ConnectionMethod } from "@routenorth/shared";
import type { MethodMeta } from "@/lib/portal/connections";

/** A small live-status chip: the colour says the state, the dot breathes while we are waiting or live. */
export function StatusPill({ state, label, className }: { state: ConnStatus["state"]; label?: string; className?: string }) {
  const c = STATE_COLOR[state];
  return (
    <span className={cn("inline-flex items-center gap-2 rounded-md border px-2 py-0.5 text-xs font-semibold whitespace-nowrap", className)} style={{ color: c, borderColor: `color-mix(in srgb, ${c} 35%, transparent)`, background: `color-mix(in srgb, ${c} 10%, transparent)` }}>
      <PulseDot color={c} size={7} live={state === "connected" || state === "waiting_first_ping"} />{label ?? STATE_LABEL[state]}
    </span>
  );
}

/** The one-glance explanation of a connection: what is true, and what to try next. */
export function StatusExplainer({ status }: { status: ConnStatus }) {
  const bad = status.state === "error";
  const Icon = status.state === "connected" ? CheckCircle2 : bad ? AlertTriangle : status.state === "quiet" ? CircleAlert : Radio;
  return (
    <motion.div layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} className="rounded-lg border p-4" style={{ borderColor: `color-mix(in srgb, ${STATE_COLOR[status.state]} 40%, var(--line))` }} role="status" aria-live="polite">
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 size-5 shrink-0" style={{ color: STATE_COLOR[status.state] }} aria-hidden />
        <div className="min-w-0">
          <div className="font-display text-base font-bold tracking-tight">{status.title}</div>
          <p className="mt-0.5 text-sm text-muted-foreground">{status.detail}</p>
          <AnimatePresence initial={false}>
            {status.fixes.length > 0 && (
              <motion.ol key="fixes" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="mt-3 list-decimal space-y-1.5 overflow-hidden pl-5 text-sm">
                {status.fixes.map((f) => <li key={f}>{f}</li>)}
              </motion.ol>
            )}
          </AnimatePresence>
        </div>
      </div>
    </motion.div>
  );
}

const ART: Record<ConnectionMethod, string> = { traccar: "M3 17l4-4 3 3 5-6 6 7", feed: "M4 12h16M14 6l6 6-6 6", geotab: "M12 3v18M3 12h18M6 6l12 12", samsara: "M4 18c4-10 12-10 16 0M8 18c2-5 6-5 8 0" };

/** One way a tracker can reach RouteNorth, as a pick-one card. */
export function MethodCard({ m, selected, onSelect, unavailable }: { m: MethodMeta; selected: boolean; onSelect: () => void; unavailable?: string | null }) {
  return (
    <motion.button type="button" onClick={onSelect} aria-pressed={selected} whileTap={{ scale: 0.985 }}
      className={cn("group relative flex flex-col items-start gap-2 rounded-lg border bg-card p-4 text-left transition-colors", selected ? "border-primary bg-primary/5" : "hover:border-foreground/30")}>
      <span className="flex w-full items-center gap-2">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke={selected ? "var(--brand)" : "var(--muted)"} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d={ART[m.id]} /></svg>
        <span className="font-display text-[15px] font-bold tracking-tight">{m.title}</span>
        {selected && <motion.span layoutId="method-dot" className="ml-auto size-2.5 rounded-full" style={{ background: "var(--amber)" }} />}
      </span>
      <span className="text-[13px] leading-snug text-muted-foreground">{m.summary}</span>
      <span className="text-xs text-muted-foreground/80">{m.forWho}</span>
      {unavailable && <span className="text-xs font-medium" style={{ color: "var(--warn)" }}>{unavailable}</span>}
    </motion.button>
  );
}

/** Numbered steps, in the order the owner does them. */
export function Steps({ steps, className }: { steps: string[]; className?: string }) {
  return (
    <ol className={cn("space-y-2.5", className)}>
      {steps.map((s, i) => (
        <li key={i} className="flex gap-3 text-sm">
          <span className="font-display mt-px flex size-5 shrink-0 items-center justify-center rounded-full bg-foreground text-[11px] font-bold text-background">{i + 1}</span>
          <span className="leading-snug">{s}</span>
        </li>
      ))}
    </ol>
  );
}

/** A value an owner has to type into another system: monospace, with a copy button. */
export function CopyValue({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/50 px-3 py-2">
      <div className="min-w-0"><div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</div><code className="block truncate text-[13px]">{value}</code></div>
      <button type="button" className="shrink-0 rounded px-2 py-1 text-xs font-semibold text-primary hover:bg-primary/10" onClick={() => { void navigator.clipboard?.writeText(value); }}>Copy</button>
    </div>
  );
}
