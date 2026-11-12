"use client";
import { ArrowRight, Rocket } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { StatusBadge } from "@/components/portal/parts";
import { ago, type Result } from "@/lib/portal/data-sources";
import { useMe } from "@/lib/me-context";
import { useApi } from "@/lib/use-api";

/**
 * Sits under a page title. A company with no real data yet gets one clear way in; one with data gets a single line saying how fresh it is
 * and whether anything is failing. Only people who can manage the account see it (the data comes from the Data sources check).
 */
export function DataFreshness() {
  const { can } = useMe();
  const allowed = can("settings.manage") || can("fleet.manage") || can("integrations.manage");
  const api = useApi<Result>(allowed ? "/portal/data-sources" : null, { intervalMs: 60_000 });
  const d = api.data;
  if (!d) return null;
  const real = d.sources.filter((s) => ["trackers", "driver-app", "files", "orders-booking", "orders-email", "orders-store"].includes(s.id) && s.state !== "not_connected");
  if (real.length === 0 && d.totals.vehicles === 0) {
    return (
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-primary/30 bg-primary/5 p-4">
        <div className="flex items-start gap-3"><Rocket className="mt-0.5 size-5 text-primary" aria-hidden /><div><p className="font-medium">No data has arrived yet</p><p className="text-sm text-muted-foreground">The numbers below are zero because nothing has been added. Pick how your data will arrive and follow the short checklist.</p></div></div>
        <Button asChild size="sm"><Link href="/owner/start">Get your fleet's data in <ArrowRight /></Link></Button>
      </div>
    );
  }
  const trackers = d.sources.find((s) => s.id === "trackers");
  const driver = d.sources.find((s) => s.id === "driver-app");
  const latest = [trackers?.lastDataAt, driver?.lastDataAt].filter(Boolean).sort().at(-1) ?? null;
  return (
    <p className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
      <span>Positions: {latest ? `last data ${ago(latest)}` : "none from real trackers yet"}</span>
      <span>Money: same rules as the finance pages and reports</span>
      {d.needsAttention > 0 && <StatusBadge tone="bad">{d.needsAttention} data {d.needsAttention === 1 ? "problem" : "problems"}</StatusBadge>}
      <Link href="/owner/settings/data-sources" className="underline underline-offset-2">Data sources</Link>
    </p>
  );
}
