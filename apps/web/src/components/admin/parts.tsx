"use client";
import { Check, Copy } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { LEVEL_COLOR, LEVEL_LABEL, type Level } from "@/lib/admin";
import { ApiError } from "@/lib/api";
import { cn } from "@/lib/utils";

/** A coloured dot and a word, never colour alone. */
export function HealthPill({ level, className }: { level: Level; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1.5 text-xs font-medium whitespace-nowrap", className)}>
      <span aria-hidden className="inline-block size-2 rounded-full" style={{ background: LEVEL_COLOR[level] }} />
      {LEVEL_LABEL[level]}
    </span>
  );
}

/** What a person should read when a call fails: the server's reason if it gave one, otherwise a plain sentence. */
export function problem(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.code === "staff_access_off") return "This client has turned off staff access in its privacy settings, so a view cannot be opened.";
    if (e.status === 403) return e.detail ?? "Your role does not allow that.";
    if (e.status === 429) return "Too many tries. Wait a minute.";
    if (e.status >= 500) return "The server had a problem. Try again in a moment.";
    return e.detail ?? e.message;
  }
  return e instanceof Error && e.message === "Cancelled" ? "Cancelled." : "Something went wrong. Try again.";
}
export const fail = (e: unknown) => toast.error(problem(e));

export function CopyButton({ value, label = "Copy" }: { value: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <Button type="button" variant="outline" size="sm" onClick={() => { void navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1500); }).catch(() => toast.error("Copy was blocked. Select the text and copy it by hand.")); }}>
      {done ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />} {done ? "Copied" : label}
    </Button>
  );
}

export function Secret({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 rounded-md border bg-muted px-2.5 py-1.5 text-sm break-all select-all">{value}</code>
        <CopyButton value={value} />
      </div>
    </div>
  );
}

/** Shown once, then gone: a setup link, or a temporary password with its authenticator secret. */
export function OneTimeDialog({ open, onClose, title, description, children }: { open: boolean; onClose: () => void; title: string; description: string; children: ReactNode }) {
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o) onClose(); }}>
      <DialogContent className="sm:max-w-lg" onInteractOutside={(e) => e.preventDefault()}>
        <DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader>
        <div className="space-y-3">{children}</div>
        <DialogFooter><Button type="button" onClick={onClose}>I have saved it</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <span className="text-sm font-medium">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

/** A plain list of key/value rows. */
export function Facts({ rows }: { rows: [string, ReactNode][] }) {
  return (
    <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
      {rows.map(([k, v]) => (<div key={k} className="contents"><dt className="text-muted-foreground">{k}</dt><dd className="min-w-0 break-words">{v}</dd></div>))}
    </dl>
  );
}

export const selectCls = "h-9 rounded-md border border-input bg-background px-2.5 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 outline-none";
