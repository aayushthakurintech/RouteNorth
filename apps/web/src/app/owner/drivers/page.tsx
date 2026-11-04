"use client";
import { Check, Copy, MessageSquarePlus, Plus, Upload, UserCheck, Car } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { initials } from "@/components/portal/cols";
import { DataTable, type BuiltInView, type Col, type FilterDef } from "@/components/portal/data-table";
import { PageHeader, StatusBadge } from "@/components/portal/parts";
import { apiSend } from "@/lib/api";
import { parseCsvText } from "@/lib/csv-parse";
import { useMe } from "@/lib/me-context";
import { DRIVER_STATUS_LABEL, DRIVER_STATUS_TONE, STORED_DRIVER_STATUSES } from "@/lib/portal/driver-fields";
import { plainMoney, useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

export interface DriverRowT {
  id: string; name: string; email: string; phone: string | null; status: string; storedStatus: string; hasPhoto: boolean; teamId: string | null; vehicleId: string | null; vehicleName: string | null; rateCardId: string | null; rateCardName: string | null;
  rating: number | null; onTimePct: number | null; score: number | null; tripsMonth: number; revenueMonthCents: number; earningsMonthCents: number | null; licenseExpiry: string | null;
  docs: { expired: number; expiring: number }; blockedReasons: string[]; lastActive: string | null; createdAt: string; applicant?: boolean; inviteId?: string;
}
interface Meta { teams: { id: string; name: string }[]; vehicles: { id: string; name: string }[] }
const DAY = 86_400_000;

/** Drivers list: who they are, whether they can work today, how they are doing, and what they earned. */
export default function DriversPage() {
  const fmt = useFmt();
  const router = useRouter();
  const { can } = useMe();
  const [archived, setArchived] = useState(false);
  const api = useApi<DriverRowT[]>(`/portal/drivers${archived ? "?archived=1" : ""}`);
  const meta = useApi<Meta>("/portal/drivers/meta");
  const [inviting, setInviting] = useState(false);
  const [importing, setImporting] = useState(false);
  const [dlg, setDlg] = useState<{ kind: "message" | "status" | "car"; rows: DriverRowT[] } | null>(null);
  const write = can("drivers.manage");
  const pay = can("pay.view");
  const monthAgo = Date.now() - 30 * DAY;

  const columns = useMemo<Col<DriverRowT>[]>(() => [
    { id: "name", accessorKey: "name", header: "Driver", cell: ({ row: { original: r } }) => (
      r.applicant ? <span className="text-muted-foreground">{r.email}</span> :
      <Link href={`/owner/drivers/${r.id}`} className="flex items-center gap-2 font-medium hover:underline" onClick={(e) => e.stopPropagation()}>
        <span className="grid size-7 shrink-0 place-items-center rounded-full bg-muted text-xs">{initials(r.name)}</span><span>{r.name}<span className="block text-xs font-normal text-muted-foreground">{r.email}</span></span>
      </Link>), meta: { label: "Driver", csv: (r) => r.name } },
    { id: "phone", accessorKey: "phone", header: "Phone", cell: ({ row }) => row.original.phone ?? "—", meta: { label: "Phone" } },
    { id: "status", accessorKey: "status", header: "Status", cell: ({ row: { original: r } }) => <span title={r.blockedReasons.join("; ") || undefined}><StatusBadge tone={DRIVER_STATUS_TONE[r.status] ?? "neutral"}>{DRIVER_STATUS_LABEL[r.status] ?? r.status}</StatusBadge>{r.blockedReasons.length > 0 && r.status === "active" && <StatusBadge tone="bad" className="ml-1">Blocked</StatusBadge>}</span>, meta: { label: "Status", csv: (r) => DRIVER_STATUS_LABEL[r.status] ?? r.status } },
    { id: "car", accessorFn: (r) => r.vehicleName ?? "", header: "Car", cell: ({ row }) => row.original.vehicleName ?? <span className="text-muted-foreground">None</span>, meta: { label: "Assigned car" } },
    { id: "rating", accessorKey: "rating", header: "Rating", cell: ({ row }) => (row.original.rating == null ? "—" : `${row.original.rating.toFixed(2)} ★`), meta: { label: "Rating", align: "end", csv: (r) => r.rating, xtype: "num" } },
    { id: "ontime", accessorKey: "onTimePct", header: "On time", cell: ({ row }) => (row.original.onTimePct == null ? "—" : `${row.original.onTimePct}%`), meta: { label: "On-time rate (%)", align: "end", csv: (r) => r.onTimePct, xtype: "num" } },
    { id: "trips", accessorKey: "tripsMonth", header: "Trips this month", cell: ({ row }) => fmt.num(row.original.tripsMonth), meta: { label: "Trips this month", align: "end", csv: (r) => r.tripsMonth, xtype: "num" } },
    ...(pay ? [{ id: "earn", accessorFn: (r: DriverRowT) => r.earningsMonthCents ?? 0, header: "Earnings this month", cell: ({ row }: { row: { original: DriverRowT } }) => (row.original.earningsMonthCents == null ? <span className="text-muted-foreground" title="Appears once a rate card is assigned">—</span> : fmt.money(row.original.earningsMonthCents)), meta: { label: "Earnings this month", align: "end", csv: (r: DriverRowT) => plainMoney(r.earningsMonthCents), xtype: "num" } } as Col<DriverRowT>] : []),
    { id: "license", accessorKey: "licenseExpiry", header: "Licence expires", cell: ({ row: { original: r } }) => (r.licenseExpiry ? <span className={Date.parse(r.licenseExpiry) < Date.now() ? "font-medium text-destructive" : undefined}>{fmt.date(r.licenseExpiry)}</span> : "—"), meta: { label: "Licence expiry", csv: (r) => r.licenseExpiry ?? "", xtype: "date" } },
    { id: "active", accessorKey: "lastActive", header: "Last active", cell: ({ row }) => fmt.date(row.original.lastActive), meta: { label: "Last active", csv: (r) => r.lastActive ?? "", xtype: "date" } },
  ], [fmt, pay]);

  const filters: FilterDef<DriverRowT>[] = [
    { id: "status", label: "Status", options: Object.entries(DRIVER_STATUS_LABEL).map(([value, label]) => ({ value, label })), get: (r) => r.status },
    { id: "car", label: "Car", options: [{ value: "yes", label: "Has a car" }, { value: "no", label: "No car" }], get: (r) => (r.vehicleId ? "yes" : "no") },
    { id: "card", label: "Rate card", options: [...new Map((api.data ?? []).filter((r) => r.rateCardId).map((r) => [r.rateCardId!, r.rateCardName ?? ""])).entries()].map(([value, label]) => ({ value, label })), get: (r) => r.rateCardId },
    { id: "region", label: "Region", options: (meta.data?.teams ?? []).map((t) => ({ value: t.id, label: t.name })), get: (r) => r.teamId },
    { id: "rating", label: "Rating", options: [{ value: "low", label: "Under 4.0" }, { value: "mid", label: "4.0 to 4.7" }, { value: "high", label: "Over 4.7" }], get: (r) => (r.rating == null ? null : r.rating < 4 ? "low" : r.rating <= 4.7 ? "mid" : "high") },
    { id: "docs", label: "Documents", options: [{ value: "expiring", label: "Expiring or expired" }], get: (r) => (r.docs.expired || r.docs.expiring ? "expiring" : null) },
    { id: "new", label: "Joined", options: [{ value: "new", label: "New this month" }], get: (r) => (Date.parse(r.createdAt) >= monthAgo ? "new" : null) },
  ];
  const views: BuiltInView<DriverRowT>[] = [
    { id: "docs", name: "Documents expiring", predicate: (r) => r.docs.expired > 0 || r.docs.expiring > 0 },
    { id: "low", name: "Low rating", predicate: (r) => r.rating != null && r.rating < 4 },
    { id: "idle", name: "No trips in 14 days", predicate: (r) => !r.applicant && r.status !== "archived" && (!r.lastActive || Date.parse(r.lastActive) < Date.now() - 14 * DAY) },
    { id: "top", name: "Top 10 this month", predicate: (r) => [...(api.data ?? [])].filter((x) => !x.applicant).sort((a, b) => b.tripsMonth - a.tripsMonth).slice(0, 10).some((x) => x.id === r.id) && r.tripsMonth > 0 },
  ];

  async function bulk(action: string, rows: DriverRowT[], extra: Record<string, unknown> = {}) {
    const ids = rows.filter((r) => !r.applicant).map((r) => r.id);
    if (!ids.length) { toast.error("Applicants have not signed up yet, so this does not apply to them."); return; }
    try {
      const r = await apiSend<{ done: number; skipped: { reason: string }[] }>("POST", "/portal/drivers/bulk", { action, ids, ...extra });
      toast.success(`${r.done} driver${r.done === 1 ? "" : "s"} updated${r.skipped.length ? `, ${r.skipped.length} skipped (${[...new Set(r.skipped.map((s) => s.reason))].join(", ")})` : ""}`);
      api.reload();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not update the drivers"); }
  }

  return (
    <>
      <PageHeader title="Drivers" description="Who is on the road, who is legal and safe to drive today, how they are doing, and what they earned."
        actions={<div className="flex gap-2"><Button asChild variant="outline" size="sm"><Link href="/owner/drivers/insights">Scores and rules</Link></Button>{write && <><Button variant="outline" size="sm" onClick={() => setImporting(true)}><Upload className="size-4" /> Import CSV</Button><Button size="sm" onClick={() => setInviting(true)}><Plus className="size-4" /> Invite driver</Button></>}</div>} />
      <DataTable id="drivers" data={api.data} loading={api.loading && !api.loaded} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => r.id}
        searchText={(r) => `${r.name} ${r.email} ${r.phone} ${r.vehicleName}`} filters={filters} builtInViews={views} exportName="drivers"
        onRowClick={(r) => (r.applicant ? toast.message("This person has not signed up yet. Use Invite driver to send the link again.") : router.push(`/owner/drivers/${r.id}`))}
        toolbar={<label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={archived} onChange={(e) => setArchived(e.target.checked)} /> Show archived</label>}
        bulkActions={write ? [
          { label: "Message", icon: <MessageSquarePlus className="size-4" />, run: (rows) => setDlg({ kind: "message", rows }) },
          { label: "Assign car", icon: <Car className="size-4" />, run: (rows) => setDlg({ kind: "car", rows }) },
          { label: "Change status", icon: <UserCheck className="size-4" />, run: (rows) => setDlg({ kind: "status", rows }) },
        ] : []}
        renderCard={(r) => <Link href={r.applicant ? "/owner/drivers" : `/owner/drivers/${r.id}`} className="block rounded-lg border p-3"><div className="flex items-center justify-between"><span className="font-medium">{r.name}</span><StatusBadge tone={DRIVER_STATUS_TONE[r.status] ?? "neutral"}>{DRIVER_STATUS_LABEL[r.status] ?? r.status}</StatusBadge></div><div className="mt-1 text-sm text-muted-foreground">{r.vehicleName ?? "No car"} · {r.rating ? `${r.rating.toFixed(1)} ★` : "no rating"} · {r.tripsMonth} trips</div></Link>}
        empty={{ title: archived ? "No archived drivers" : "No drivers yet", description: "Invite your first driver by email. They sign up, finish onboarding, and appear here.", action: write ? <Button size="sm" onClick={() => setInviting(true)}><Plus className="size-4" /> Invite driver</Button> : undefined }} />
      <InviteDialog open={inviting} onOpenChange={setInviting} teams={meta.data?.teams ?? []} onDone={api.reload} />
      <ImportDialog open={importing} onOpenChange={setImporting} onDone={api.reload} />
      <BulkDialog dlg={dlg} vehicles={meta.data?.vehicles ?? []} onClose={() => setDlg(null)} onRun={(action, extra) => { void bulk(action, dlg!.rows, extra); setDlg(null); }} />
    </>
  );
}

function InviteDialog({ open, onOpenChange, teams, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; teams: { id: string; name: string }[]; onDone: () => void }) {
  const [email, setEmail] = useState(""); const [team, setTeam] = useState("none");
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const [res, setRes] = useState<{ link: string; emailSent: boolean; emailNote: string | null } | null>(null);
  const reset = () => { setEmail(""); setTeam("none"); setErr(null); setRes(null); };
  async function send() {
    setBusy(true); setErr(null);
    try { setRes(await apiSend("POST", "/invites", { email, role: "driver", teamId: team === "none" ? undefined : team })); onDone(); } catch (e) { setErr(e instanceof Error ? e.message : "Could not send the invitation"); } finally { setBusy(false); }
  }
  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent>
        <DialogHeader><DialogTitle>Invite a driver</DialogTitle><DialogDescription>They get an email with a sign-up link (valid for 7 days). You can also copy the link and send it by text yourself. RouteNorth does not send text messages.</DialogDescription></DialogHeader>
        {!res ? (
          <div className="grid gap-3">
            <Input type="email" aria-label="Email" placeholder="driver@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            {teams.length > 0 && <Select value={team} onValueChange={setTeam}><SelectTrigger aria-label="Region"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">No region</SelectItem>{teams.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}</SelectContent></Select>}
            {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
          </div>
        ) : (
          <div className="space-y-2 text-sm">
            <p className="flex items-center gap-1"><Check className="size-4 text-ok" /> {res.emailSent ? "Invitation emailed." : `Invitation created. Email was not sent${res.emailNote ? ` (${res.emailNote})` : ""}.`}</p>
            <div className="flex gap-2"><Input readOnly value={res.link} aria-label="Invite link" /><Button variant="outline" onClick={async () => { await navigator.clipboard.writeText(res.link); toast.success("Link copied"); }}><Copy className="size-4" /></Button></div>
          </div>
        )}
        <DialogFooter>{!res ? <><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={busy || !email.includes("@")} onClick={send}>{busy ? "Sending…" : "Send invitation"}</Button></> : <Button onClick={() => onOpenChange(false)}>Done</Button>}</DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ImportDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; onDone: () => void }) {
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [report, setReport] = useState<{ total: number; valid: number; rows: { line: number; ok: boolean; errors: string[]; email: string }[] } | null>(null);
  const [busy, setBusy] = useState(false); const [err, setErr] = useState<string | null>(null);
  const ref = useRef<HTMLInputElement>(null);
  async function pick(f?: File) {
    if (!f) return; setErr(null); setReport(null);
    const p = parseCsvText(await f.text());
    const mapped = p.rows.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase().trim(), v])));
    if (!mapped.length) { setErr("The file has no lines under the header row."); return; }
    setRows(mapped); setBusy(true);
    try { setReport(await apiSend("POST", "/portal/drivers/import", { rows: mapped, dryRun: true })); } catch (e) { setErr(e instanceof Error ? e.message : "Could not check the file"); } finally { setBusy(false); }
  }
  async function run() {
    if (!report) return; setBusy(true); let ok = 0;
    for (const r of report.rows.filter((x) => x.ok)) { try { await apiSend("POST", "/invites", { email: r.email, role: "driver" }); ok++; } catch { /* reported below */ } }
    setBusy(false); toast.success(`${ok} invitation${ok === 1 ? "" : "s"} sent`); onOpenChange(false); setReport(null); onDone();
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
        <DialogHeader><DialogTitle>Import drivers from a CSV</DialogTitle><DialogDescription>A column called email is needed (name and phone are optional). Each valid line gets an invitation email.</DialogDescription></DialogHeader>
        <input ref={ref} type="file" accept=".csv,text/csv" aria-label="CSV file" onChange={(e) => void pick(e.target.files?.[0])} />
        {busy && <p className="text-sm text-muted-foreground">Working…</p>}
        {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
        {report && <div className="space-y-2 text-sm"><p><strong>{report.valid}</strong> of {report.total} lines are ready.</p><ul className="max-h-40 space-y-1 overflow-y-auto">{report.rows.filter((r) => !r.ok).map((r) => <li key={r.line} className="rounded bg-destructive/10 px-2 py-1">Line {r.line}: {r.errors.join("; ")}</li>)}</ul></div>}
        <DialogFooter><Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button><Button disabled={busy || !report || report.valid === 0 || rows.length === 0} onClick={run}>Send {report?.valid ?? 0} invitations</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BulkDialog({ dlg, vehicles, onClose, onRun }: { dlg: { kind: "message" | "status" | "car"; rows: DriverRowT[] } | null; vehicles: { id: string; name: string }[]; onClose: () => void; onRun: (a: string, x: Record<string, unknown>) => void }) {
  const [text, setText] = useState(""); const [status, setStatus] = useState("active"); const [reason, setReason] = useState(""); const [car, setCar] = useState("");
  return (
    <Dialog open={!!dlg} onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        {dlg?.kind === "message" && <><DialogHeader><DialogTitle>Message {dlg.rows.length} driver{dlg.rows.length === 1 ? "" : "s"}</DialogTitle><DialogDescription>Shows up as a notification in their app.</DialogDescription></DialogHeader><Input aria-label="Message" value={text} onChange={(e) => setText(e.target.value)} placeholder="Your message (190 characters)" maxLength={190} /><DialogFooter><Button disabled={!text.trim()} onClick={() => onRun("message", { text })}>Send</Button></DialogFooter></>}
        {dlg?.kind === "status" && <><DialogHeader><DialogTitle>Change status</DialogTitle><DialogDescription>On trip is worked out automatically. Suspending needs a reason and blocks the driver from new jobs.</DialogDescription></DialogHeader>
          <Select value={status} onValueChange={setStatus}><SelectTrigger aria-label="Status"><SelectValue /></SelectTrigger><SelectContent>{STORED_DRIVER_STATUSES.map((s) => <SelectItem key={s.value} value={s.value}>{s.label}</SelectItem>)}</SelectContent></Select>
          {status === "suspended" && <Input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" />}
          <DialogFooter><Button disabled={status === "suspended" && !reason.trim()} onClick={() => onRun("status", { status, reason })}>Change status</Button></DialogFooter></>}
        {dlg?.kind === "car" && <><DialogHeader><DialogTitle>Assign a car</DialogTitle><DialogDescription>Permanent assignment. Cars that are booked by someone else, or that the driver's licence class does not cover, are skipped and listed afterwards. Only one driver can be selected for one car.</DialogDescription></DialogHeader>
          <Select value={car} onValueChange={setCar}><SelectTrigger aria-label="Car"><SelectValue placeholder="Choose a car" /></SelectTrigger><SelectContent>{vehicles.map((v) => <SelectItem key={v.id} value={v.id}>{v.name}</SelectItem>)}</SelectContent></Select>
          <DialogFooter><Button disabled={!car || dlg.rows.length !== 1} onClick={() => onRun("assign_vehicle", { vehicleId: car })}>Assign</Button></DialogFooter></>}
      </DialogContent>
    </Dialog>
  );
}
