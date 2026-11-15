"use client";
import { Loader2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { useAdmin } from "@/components/admin/AdminShell";
import { fail } from "@/components/admin/parts";
import { PageHeader, StatusBadge } from "@/components/portal/parts";
import { EmptyState, ErrorState, LoadingState } from "@/components/portal/states";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { when } from "@/lib/admin";
import { apiSend } from "@/lib/api";
import { useApi } from "@/lib/use-api";

interface ViewRow { id: string; orgId: string; orgName: string; adminEmail: string; reason: string; ticket: string | null; startedAt: string; expiresAt: string; endedAt: string | null; requests: number; blockedWrites: number; paths: string[] | null }

/** Every "view as client" session, open or finished, with why it was opened and how much it did. */
export default function ViewsPage() {
  const { can } = useAdmin();
  const [onlyOpen, setOnlyOpen] = useState(false);
  const q = useApi<ViewRow[]>(can("audit.view") ? `/admin/view-as${onlyOpen ? "?active=1" : ""}` : null, { intervalMs: 30_000 });
  const [busy, setBusy] = useState<string | null>(null);
  if (!can("audit.view")) return <ErrorState error="HTTP 403" />;
  const isOpen = (v: ViewRow) => !v.endedAt && new Date(v.expiresAt).getTime() > Date.now();
  async function end(id: string) {
    setBusy(id);
    try { await apiSend("POST", `/admin/view-as/${id}/end`); toast.success("View ended"); q.reload(); } catch (e) { fail(e); } finally { setBusy(null); }
  }
  return (
    <>
      <PageHeader title="Staff views" description="Each time someone from RouteNorth looked inside a client's account: who, why, for how long, and how much they opened." crumbs={[{ label: "Staff views" }]}
        actions={<label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={onlyOpen} onChange={(e) => setOnlyOpen(e.target.checked)} /> Only open now</label>} />
      {q.error && !q.data ? <ErrorState error={q.error} onRetry={q.reload} /> : !q.data ? <LoadingState /> : q.data.length === 0 ? <EmptyState title="No views">{onlyOpen ? "No staff view is open right now." : "Nobody has opened a client's account yet."}</EmptyState> : (
        <div className="rounded-xl border"><Table>
          <TableHeader><TableRow><TableHead>Client</TableHead><TableHead>Staff</TableHead><TableHead>Reason</TableHead><TableHead>Started</TableHead><TableHead className="text-end">Requests</TableHead><TableHead className="text-end">Writes refused</TableHead><TableHead>State</TableHead></TableRow></TableHeader>
          <TableBody>{q.data.map((v) => (
            <TableRow key={v.id}>
              <TableCell className="font-medium">{v.orgName}</TableCell><TableCell>{v.adminEmail}</TableCell>
              <TableCell className="max-w-xs whitespace-normal">{v.reason}{v.ticket ? <span className="text-muted-foreground"> · {v.ticket}</span> : null}</TableCell>
              <TableCell className="whitespace-nowrap">{when(v.startedAt)}</TableCell>
              <TableCell className="text-end tabular-nums">{v.requests}</TableCell><TableCell className="text-end tabular-nums">{v.blockedWrites}</TableCell>
              <TableCell>{isOpen(v) ? (can("impersonate.view") ? <Button size="xs" variant="outline" disabled={busy === v.id} onClick={() => void end(v.id)}>{busy === v.id && <Loader2 className="animate-spin" />} End now</Button> : <StatusBadge tone="warn">Open</StatusBadge>) : <span className="text-muted-foreground">{v.endedAt ? "Ended" : "Expired"}</span>}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table></div>
      )}
    </>
  );
}
