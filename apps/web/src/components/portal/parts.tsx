"use client";
import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useBreadcrumbs, type Crumb } from "@/lib/breadcrumbs";
import { cn } from "@/lib/utils";

export function PageHeader({ title, description, actions, crumbs }: { title: ReactNode; description?: ReactNode; actions?: ReactNode; crumbs?: Crumb[] }) {
  useBreadcrumbs(crumbs ?? []);
  return (
    <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0">
        <h1 className="truncate text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="mt-1 text-sm text-muted-foreground">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Breadcrumbs({ items }: { items: Crumb[] }) {
  if (!items.length) return null;
  return (
    <nav aria-label="Breadcrumb" className="mb-3 flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
      {items.map((c, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <span aria-hidden>/</span>}
          {c.href && i < items.length - 1 ? <Link href={c.href} className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">{c.label}</Link> : <span aria-current={i === items.length - 1 ? "page" : undefined} className={i === items.length - 1 ? "text-foreground" : ""}>{c.label}</span>}
        </span>
      ))}
    </nav>
  );
}

type Tone = "neutral" | "good" | "warn" | "bad" | "info";
const TONE: Record<Tone, string> = {
  neutral: "bg-secondary text-secondary-foreground",
  good: "bg-ok/15 text-ok", warn: "bg-warn/15 text-warn", bad: "bg-destructive/15 text-destructive", info: "bg-info/15 text-info",
};
export function StatusBadge({ tone = "neutral", children, className }: { tone?: Tone; children: ReactNode; className?: string }) {
  return <Badge variant="outline" className={cn("border-transparent font-medium", TONE[tone], className)}>{children}</Badge>;
}

/** A dashboard number. Click-through: pass `href` and the number opens the rows behind it (spec rule 4). */
export function StatCard({ label, value, hint, href, delta, deltaGoodWhen = "up", loading }: { label: string; value: ReactNode; hint?: ReactNode; href?: string; delta?: number | null; deltaGoodWhen?: "up" | "down"; loading?: boolean }) {
  const inner = (
    <Card className={cn("h-full gap-2 py-4 transition-colors", href && "hover:border-primary")}>
      <CardHeader className="px-4"><CardDescription>{label}</CardDescription><CardTitle className="text-2xl tabular-nums">{loading ? <Skeleton className="h-8 w-24" /> : value}</CardTitle></CardHeader>
      {(hint || delta != null) && (
        <CardContent className="flex items-center gap-2 px-4 text-xs text-muted-foreground">
          {delta != null && (
            <span className={cn("inline-flex items-center gap-0.5 font-medium", delta === 0 ? "" : (delta > 0) === (deltaGoodWhen === "up") ? "text-ok" : "text-destructive")}>
              {delta === 0 ? <Minus className="size-3" /> : delta > 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}{Math.abs(delta).toFixed(1)}%
            </span>
          )}
          {hint}
        </CardContent>
      )}
    </Card>
  );
  return href ? <Link href={href} className="block rounded-xl focus-visible:outline-2" aria-label={`${label}: open the rows behind this number`}>{inner}</Link> : inner;
}

/** "Are you sure?" before archiving or any change that is hard to take back. */
export function ConfirmDialog({ open, onOpenChange, title, description, confirmLabel = "Confirm", destructive, onConfirm }: {
  open: boolean; onOpenChange: (b: boolean) => void; title: string; description: ReactNode; confirmLabel?: string; destructive?: boolean; onConfirm: () => void | Promise<void>;
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction className={destructive ? "bg-destructive text-white hover:bg-destructive/90" : undefined} onClick={() => void onConfirm()}>{confirmLabel}</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
