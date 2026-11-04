"use client";
import { AlertTriangle, Inbox, RefreshCw, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

/** Loading state: grey blocks in the shape of the page, so nothing jumps when data arrives. */
export function LoadingState({ rows = 6, className }: { rows?: number; className?: string }) {
  return (
    <div className={cn("space-y-2", className)} role="status" aria-label="Loading">
      <Skeleton className="h-9 w-full max-w-sm" />
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} className="h-10 w-full" />)}
    </div>
  );
}

/** Empty state: says why it is empty and what to do next. */
export function EmptyState({ icon: Icon = Inbox, title, children, action, className }: { icon?: LucideIcon; title: string; children?: ReactNode; action?: ReactNode; className?: string }) {
  return (
    <div className={cn("flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed p-10 text-center", className)}>
      <Icon className="size-8 text-muted-foreground" aria-hidden />
      <p className="font-medium">{title}</p>
      {children && <div className="max-w-md text-sm text-muted-foreground">{children}</div>}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Error state: what went wrong, in plain words, with a retry. */
export function ErrorState({ error, onRetry, className }: { error: Error | string; onRetry?: () => void; className?: string }) {
  const message = typeof error === "string" ? error : error.message;
  return (
    <Alert variant="destructive" className={className}>
      <AlertTriangle />
      <AlertTitle>Something went wrong</AlertTitle>
      <AlertDescription>
        <p>{/^HTTP 403/.test(message) ? "You do not have permission to see this." : /^HTTP 5\d\d/.test(message) ? "The server had a problem. Try again in a moment." : message}</p>
        {onRetry && <Button variant="outline" size="sm" className="mt-2" onClick={onRetry}><RefreshCw /> Try again</Button>}
      </AlertDescription>
    </Alert>
  );
}

/** One place that shows loading, error, empty or the content. */
export function Async<T>({ state, children, empty, isEmpty }: {
  state: { data: T | null; error: Error | null; loading: boolean; loaded: boolean; reload: () => void };
  children: (data: T) => ReactNode; empty?: ReactNode; isEmpty?: (d: T) => boolean;
}) {
  if (state.error && !state.data) return <ErrorState error={state.error} onRetry={state.reload} />;
  if (!state.data) return <LoadingState />;
  if (isEmpty?.(state.data) && empty) return <>{empty}</>;
  return <>{children(state.data)}</>;
}
