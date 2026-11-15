"use client";
import { Loader2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useAdmin } from "@/components/admin/AdminShell";
import { fail, selectCls } from "@/components/admin/parts";
import { PageHeader } from "@/components/portal/parts";
import { EmptyState, ErrorState, LoadingState } from "@/components/portal/states";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { ACTION_LABEL, when, type AuditRow } from "@/lib/admin";
import { apiGet } from "@/lib/api";

const GROUPS = [["", "Everything"], ["login", "Sign-ins"], ["mfa", "Authenticator codes"], ["stepup", "Confirmations"], ["client", "Client changes"], ["view_as", "Views as a client"], ["admin", "Staff accounts"], ["device", "Tracker lookups"]];

/** The staff audit log. It is append-only: nothing here can be edited or deleted from the console or the API. */
export default function AuditPage() {
  const { can } = useAdmin();
  const [group, setGroup] = useState("");
  const [who, setWho] = useState("");
  const [dwho, setDwho] = useState("");
  const [rows, setRows] = useState<AuditRow[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => { const t = setTimeout(() => setDwho(who.trim()), 300); return () => clearTimeout(t); }, [who]);
  const qs = (before?: string) => { const p = new URLSearchParams({ limit: "50" }); if (group) p.set("action", group); if (dwho) p.set("admin", dwho); if (before) p.set("before", before); return p.toString(); };
  useEffect(() => {
    if (!can("audit.view")) return;
    let live = true; setRows(null); setErr(null);
    apiGet<{ rows: AuditRow[]; next: string | null }>(`/admin/audit?${qs()}`).then((r) => { if (live) { setRows(r.rows); setNext(r.next); } }).catch((e: unknown) => live && setErr(e instanceof Error ? e : new Error("failed")));
    return () => { live = false; };
  }, [group, dwho, can]); // eslint-disable-line react-hooks/exhaustive-deps
  async function loadMore() {
    if (!next) return; setMore(true);
    try { const r = await apiGet<{ rows: AuditRow[]; next: string | null }>(`/admin/audit?${qs(next)}`); setRows((p) => [...(p ?? []), ...r.rows]); setNext(r.next); } catch (e) { fail(e); } finally { setMore(false); }
  }
  if (!can("audit.view")) return <ErrorState error="HTTP 403" />;
  return (
    <>
      <PageHeader title="Audit log" description="Everything staff do, including failed sign-ins. Entries cannot be edited or removed." crumbs={[{ label: "Audit log" }]} />
      <div className="mb-4 flex flex-wrap gap-2">
        <select aria-label="What" className={selectCls} value={group} onChange={(e) => setGroup(e.target.value)}>{GROUPS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        <Input aria-label="Staff email" placeholder="Staff email (exact)" className="max-w-64" value={who} onChange={(e) => setWho(e.target.value)} />
      </div>
      {err && !rows ? <ErrorState error={err} /> : !rows ? <LoadingState /> : rows.length === 0 ? <EmptyState title="Nothing logged for that filter" /> : (
        <div className="rounded-xl border"><Table>
          <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Staff</TableHead><TableHead>What</TableHead><TableHead>Client</TableHead><TableHead>Reason / target</TableHead><TableHead>From</TableHead></TableRow></TableHeader>
          <TableBody>{rows.map((r) => (
            <TableRow key={r.id} className={r.detail ? "cursor-pointer" : undefined} onClick={() => setOpen(open === r.id ? null : r.id)}>
              <TableCell className="whitespace-nowrap align-top">{when(r.at)}</TableCell><TableCell className="align-top">{r.adminEmail ?? "–"}</TableCell>
              <TableCell className="align-top"><span className={r.status && r.status >= 400 ? "text-destructive" : undefined}>{ACTION_LABEL[r.action] ?? r.action}</span>
                {open === r.id && r.detail != null && <pre className="mt-2 max-w-md overflow-x-auto rounded-md bg-muted p-2 text-xs">{JSON.stringify(r.detail, null, 2)}</pre>}</TableCell>
              <TableCell className="align-top">{r.orgName ?? ""}</TableCell>
              <TableCell className="max-w-xs align-top break-words whitespace-normal text-muted-foreground">{[r.reason, r.target].filter(Boolean).join(" · ")}</TableCell>
              <TableCell className="align-top whitespace-nowrap text-muted-foreground">{r.ip ?? ""}</TableCell>
            </TableRow>
          ))}</TableBody>
        </Table></div>
      )}
      {next && <div className="mt-4 text-center"><Button variant="outline" onClick={() => void loadMore()} disabled={more}>{more && <Loader2 className="animate-spin" />} Older entries</Button></div>}
    </>
  );
}
