"use client";
import { ArrowRight, Mail } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Async } from "@/components/portal/states";
import { PageHeader, StatusBadge } from "@/components/portal/parts";
import { apiSend } from "@/lib/api";
import { STATE_LABEL, STATE_TONE, ago, type Result } from "@/lib/portal/data-sources";
import { useApi } from "@/lib/use-api";

const GROUPS: { id: string; title: string; hint: string }[] = [
  { id: "positions", title: "Where vehicles are", hint: "GPS trackers and feeds that send positions." },
  { id: "people", title: "Drivers", hint: "What drivers send from their phones." },
  { id: "work", title: "Work coming in", hint: "Orders and files. Everything you type or upload also counts." },
  { id: "services", title: "Services we call", hint: "Roads, addresses, email, texts and your other tools." },
  { id: "partners", title: "Partner feeds", hint: "Not built yet. Listed so nobody wonders." },
];


/** Where your data comes from and whether each source is still flowing, in plain words. */
export default function DataSourcesPage() {
  const state = useApi<Result>("/portal/data-sources", { intervalMs: 60_000 });
  const [busy, setBusy] = useState(false);
  async function testEmail() {
    setBusy(true);
    try {
      const r = await apiSend<{ ok: boolean; to?: string; error?: string }>("POST", "/portal/data-sources/test-email");
      if (r.ok) toast.success(`Test email sent to ${r.to}. Check your inbox.`); else toast.error(r.error ?? "The test email failed");
    } catch (e) { toast.error(e instanceof Error ? e.message : "The test email failed"); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader title="Data sources" description="Where your data comes from, and whether each source is still sending. Checked every minute."
        actions={<Button asChild size="sm" variant="outline"><Link href="/owner/start">Open the start guide</Link></Button>} />
      <Async state={state}>
        {(d) => (
          <div className="space-y-6">
            <div className="flex flex-wrap items-center gap-2 text-sm" aria-live="polite">
              {d.needsAttention > 0 && <StatusBadge tone="bad">{d.needsAttention} {d.needsAttention === 1 ? "problem" : "problems"}</StatusBadge>}
              <StatusBadge tone="good">{d.counts.live} live</StatusBadge>
              {d.counts.needs_setup > 0 && <StatusBadge tone="warn">{d.counts.needs_setup} need setup</StatusBadge>}
              {d.counts.not_connected > 0 && <StatusBadge>{d.counts.not_connected} not connected</StatusBadge>}
              <span className="text-muted-foreground">Checked {ago(d.checkedAt)}</span>
            </div>
            {GROUPS.map((g) => {
              const rows = d.sources.filter((s) => s.group === g.id);
              if (!rows.length) return null;
              return (
                <Card key={g.id}>
                  <CardHeader><CardTitle>{g.title}</CardTitle><CardDescription>{g.hint}</CardDescription></CardHeader>
                  <CardContent className="divide-y">
                    {rows.map((s) => (
                      <div key={s.id} className="flex flex-col gap-2 py-3 first:pt-0 last:pb-0 sm:flex-row sm:items-start sm:justify-between">
                        <div className="min-w-0 space-y-1">
                          <div className="flex flex-wrap items-center gap-2"><span className="font-medium">{s.name}</span><StatusBadge tone={STATE_TONE[s.state]}>{STATE_LABEL[s.state]}</StatusBadge></div>
                          <p className="text-sm text-muted-foreground">{s.summary}</p>
                          {s.lastDataAt && <p className="text-xs text-muted-foreground">Last data {ago(s.lastDataAt)}</p>}
                          {s.needs.length > 0 && (
                            <p className="text-xs text-muted-foreground">To switch on, the person who runs the server sets: {s.needs.map((n, i) => <code key={i} className="mr-1 rounded bg-muted px-1 py-0.5">{n}</code>)}</p>
                          )}
                        </div>
                        <div className="flex shrink-0 gap-2">
                          {s.canTest && <Button size="sm" variant="outline" disabled={busy} onClick={() => void testEmail()}><Mail /> Send me a test</Button>}
                          {s.next && <Button asChild size="sm" variant={s.state === "problem" ? "default" : "outline"}><Link href={s.next.href}>{s.next.label} <ArrowRight /></Link></Button>}
                        </div>
                      </div>
                    ))}
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}
      </Async>
    </>
  );
}
