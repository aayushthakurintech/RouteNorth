"use client";
import { BellOff, Check, CheckCheck, Clock, History, Settings, UserPlus } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { EmptyState, Async } from "@/components/portal/states";
import { PageHeader, StatusBadge } from "@/components/portal/parts";
import { apiSend } from "@/lib/api";
import { useMe } from "@/lib/me-context";
import { useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

export interface AlertRow { id: string; title: string; severity: "info" | "warn" | "critical"; status: string; area: string | null; count: number; firstAt: string; lastAt: string; snoozedUntil: string | null; assignedToId: string | null; assignedTo: string | null; resolvedAt: string | null; resolvedHow: string | null; resolvedBy: string | null; rule: string | null; detail: { href?: string } }
interface Inbox { counts: { active: number; critical: number; mine: number; snoozed: number; done: number }; alerts: AlertRow[] }
interface Person { id: string; displayName?: string | null; email: string; role?: string }
interface Event { id: string; at: string; kind: string; note: string | null; actor: string; detail: Record<string, unknown> }

const SEV = { critical: ["bad", "Critical"], warn: ["warn", "Warning"], info: ["info", "Info"] } as const;
const AREA: Record<string, string> = { vehicle: "Cars", driver: "Drivers", pay: "Pay", money: "Money", custom: "My rules", live: "Live" };
const VIEWS = [["active", "Needs action", "active"], ["mine", "Mine", "mine"], ["snoozed", "Snoozed", "snoozed"], ["done", "Done", "done"]] as const;
const EVENT_TEXT: Record<string, string> = {
  raised: "Raised", escalated: "Became more serious", sent: "Sent to people", repeated: "Sent again because nobody had acted", acknowledged: "Acknowledged", assigned: "Assigned", unassigned: "Taken off the person it was given to",
  snoozed: "Snoozed", unsnoozed: "Snooze ended", done: "Marked done", reopened: "Opened again", auto_resolved: "Closed by itself", note: "Note",
};

function Inner() {
  const fmt = useFmt(); const { can } = useMe(); const params = useSearchParams();
  const [view, setView] = useState<(typeof VIEWS)[number][0]>("active");
  const [area, setArea] = useState(""); const [sev, setSev] = useState(""); const [q, setQ] = useState("");
  const qs = `view=${view}${area ? `&area=${area}` : ""}${sev ? `&severity=${sev}` : ""}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ""}`;
  const inbox = useApi<Inbox>(`/portal/alerts?${qs}`, { intervalMs: 60_000 });
  const people = useApi<Person[]>(can("alerts.manage") && can("users.view") ? "/users" : null);
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [assign, setAssign] = useState<AlertRow | null>(null); const [done, setDone] = useState<AlertRow | null>(null); const [openId, setOpenId] = useState<string | null>(params.get("id"));
  useEffect(() => { setSel(new Set()); }, [view, area, sev, q]);
  const manage = can("alerts.manage");

  async function act(id: string, what: string, body?: unknown, okText?: string) {
    try { await apiSend("POST", `/portal/alerts/${id}/${what}`, body ?? {}); if (okText) toast.success(okText); inbox.reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not do that"); }
  }
  async function bulk(action: "acknowledge" | "snooze" | "done") {
    try {
      const r = await apiSend<{ done: number; failed: string[] }>("POST", "/portal/alerts/bulk", { ids: [...sel], action, hours: 24 });
      toast.success(`${r.done} alert${r.done === 1 ? "" : "s"} updated${r.failed.length ? `, ${r.failed.length} could not be changed` : ""}`); setSel(new Set()); inbox.reload();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not do that"); }
  }
  const c = inbox.data?.counts;
  return (
    <>
      <PageHeader title="Alerts" description="What needs you, most serious first. Each one says what is wrong and where to fix it."
        actions={can("alerts.manage") ? <Button asChild size="sm" variant="outline"><Link href="/owner/settings/alerts"><Settings className="size-4" /> Alert settings</Link></Button> : undefined} />
      <div className="mb-3 flex flex-wrap items-center gap-2" role="tablist" aria-label="Alert views">
        {VIEWS.map(([key, label, count]) => (
          <Button key={key} role="tab" aria-selected={view === key} size="sm" variant={view === key ? "default" : "outline"} onClick={() => setView(key)}>
            {label}{c ? <span className="ml-1.5 tabular-nums opacity-80">{c[count]}</span> : null}
          </Button>))}
        <div className="ml-auto flex flex-wrap gap-2">
          <select aria-label="Area" className="h-9 rounded-md border bg-background px-2 text-sm" value={area} onChange={(e) => setArea(e.target.value)}><option value="">All areas</option>{Object.entries(AREA).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
          <select aria-label="Severity" className="h-9 rounded-md border bg-background px-2 text-sm" value={sev} onChange={(e) => setSev(e.target.value)}><option value="">Any severity</option><option value="critical">Critical</option><option value="warn">Warning</option><option value="info">Info</option></select>
          <Input aria-label="Search alerts" className="w-48" placeholder="Search alerts" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>
      </div>
      <Async state={inbox} empty={null}>{(d) => d.alerts.length === 0 ? (
        <EmptyState title={view === "done" ? "Nothing has been closed yet" : "Nothing needs you"} >{view === "active" ? "No open alerts right now. They appear here when something needs a look, and go away by themselves when it is fixed." : "Nothing here."}</EmptyState>
      ) : (
        <ul className="space-y-2">{d.alerts.map((a) => (
          <li key={a.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-start gap-3">
              {manage && view !== "done" && <Checkbox aria-label={`Select: ${a.title}`} checked={sel.has(a.id)} onCheckedChange={(v) => setSel((s) => { const n = new Set(s); if (v) n.add(a.id); else n.delete(a.id); return n; })} className="mt-1" />}
              <div className="min-w-0 flex-1">
                <div className="mb-1 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <StatusBadge tone={SEV[a.severity][0]}>{SEV[a.severity][1]}</StatusBadge>
                  {a.area && <span>{AREA[a.area] ?? a.area}</span>}{a.rule && <span>· {a.rule}</span>}
                  <span>· since {fmt.dateTime(a.firstAt)}</span>{a.count > 1 && <span>· seen {a.count} times</span>}
                  {a.assignedTo && <span>· with {a.assignedTo}</span>}
                  {a.snoozedUntil && new Date(a.snoozedUntil) > new Date() && <span className="flex items-center gap-1"><BellOff className="size-3" /> snoozed until {fmt.dateTime(a.snoozedUntil)}</span>}
                  {a.status === "resolved" && <span>· {a.resolvedHow === "auto" ? "closed by itself" : `done by ${a.resolvedBy ?? "someone"}`} {a.resolvedAt ? fmt.dateTime(a.resolvedAt) : ""}</span>}
                </div>
                <p className="font-medium">{a.detail?.href ? <Link href={a.detail.href} className="hover:underline">{a.title}</Link> : a.title}</p>
              </div>
              <div className="flex flex-wrap gap-1">
                {manage && a.status !== "resolved" && <>
                  {a.status === "open" && <Button size="sm" variant="outline" onClick={() => void act(a.id, "acknowledge", {}, "Acknowledged")}><Check className="size-4" /> Acknowledge</Button>}
                  <Button size="sm" variant="outline" onClick={() => setAssign(a)}><UserPlus className="size-4" /> Assign</Button>
                  <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="outline"><Clock className="size-4" /> Snooze</Button></DropdownMenuTrigger>
                    <DropdownMenuContent align="end">{([["1 hour", 1], ["4 hours", 4], ["Tomorrow", 24], ["3 days", 72], ["A week", 168]] as const).map(([l, h]) => <DropdownMenuItem key={h} onSelect={() => void act(a.id, "snooze", { hours: h }, `Snoozed for ${l.toLowerCase()}`)}>{l}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu>
                  <Button size="sm" onClick={() => setDone(a)}><CheckCheck className="size-4" /> Done</Button>
                </>}
                {manage && a.status === "resolved" && <Button size="sm" variant="outline" onClick={() => void act(a.id, "reopen", {}, "Opened again")}>Open again</Button>}
                <Button size="sm" variant="ghost" aria-label={`History of: ${a.title}`} onClick={() => setOpenId(a.id)}><History className="size-4" /> History</Button>
              </div>
            </div>
          </li>))}</ul>
      )}</Async>
      {sel.size > 0 && (
        <div role="region" aria-label="Selected alerts" className="fixed inset-x-4 bottom-20 z-30 mx-auto flex max-w-xl items-center justify-between gap-2 rounded-lg border bg-background p-3 shadow-lg md:bottom-6">
          <span className="text-sm">{sel.size} selected</span>
          <span className="flex gap-2"><Button size="sm" variant="outline" onClick={() => void bulk("acknowledge")}>Acknowledge</Button><Button size="sm" variant="outline" onClick={() => void bulk("snooze")}>Snooze a day</Button><Button size="sm" onClick={() => void bulk("done")}>Done</Button><Button size="sm" variant="ghost" onClick={() => setSel(new Set())}>Clear</Button></span>
        </div>)}
      {assign && <AssignDialog alert={assign} people={people.data ?? []} onClose={() => setAssign(null)} onDone={() => { setAssign(null); inbox.reload(); }} />}
      {done && <DoneDialog alert={done} onClose={() => setDone(null)} onDone={() => { setDone(null); inbox.reload(); }} />}
      {openId && <HistorySheet id={openId} onClose={() => setOpenId(null)} />}
    </>
  );
}

function AssignDialog({ alert, people, onClose, onDone }: { alert: AlertRow; people: Person[]; onClose: () => void; onDone: () => void }) {
  const [who, setWho] = useState(alert.assignedToId ?? ""); const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await apiSend("POST", `/portal/alerts/${alert.id}/assign`, { userId: who || null, note: note || undefined }); toast.success(who ? "Assigned" : "Taken off"); onDone(); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not assign it"); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent>
      <DialogHeader><DialogTitle>Give this alert to someone</DialogTitle><DialogDescription>{alert.title}</DialogDescription></DialogHeader>
      <label className="text-sm font-medium" htmlFor="assign-who">Who</label>
      <select id="assign-who" className="h-9 rounded-md border bg-background px-2 text-sm" value={who} onChange={(e) => setWho(e.target.value)}><option value="">Nobody</option>{people.filter((p) => p.role !== "driver").map((p) => <option key={p.id} value={p.id}>{p.displayName || p.email}</option>)}</select>
      <label className="text-sm font-medium" htmlFor="assign-note">Note (optional)</label>
      <Textarea id="assign-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} placeholder="What do you want them to do?" />
      <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>Save</Button></DialogFooter>
    </DialogContent></Dialog>
  );
}

function DoneDialog({ alert, onClose, onDone }: { alert: AlertRow; onClose: () => void; onDone: () => void }) {
  const [note, setNote] = useState(""); const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    try { await apiSend("POST", `/portal/alerts/${alert.id}/done`, { note: note || undefined }); toast.success("Marked done"); onDone(); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not close it"); } finally { setBusy(false); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent>
      <DialogHeader><DialogTitle>Mark this alert done</DialogTitle><DialogDescription>{alert.title} If the problem is still there it will not come back for a week, unless it gets worse.</DialogDescription></DialogHeader>
      <label className="text-sm font-medium" htmlFor="done-note">What was done? (optional)</label>
      <Textarea id="done-note" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
      <DialogFooter><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>Mark done</Button></DialogFooter>
    </DialogContent></Dialog>
  );
}

function HistorySheet({ id, onClose }: { id: string; onClose: () => void }) {
  const fmt = useFmt();
  const one = useApi<AlertRow & { history: Event[] }>(`/portal/alerts/${id}`);
  return (
    <Sheet open onOpenChange={(o) => !o && onClose()}><SheetContent className="w-full overflow-y-auto sm:max-w-md">
      <SheetHeader><SheetTitle>Who handled this alert</SheetTitle><SheetDescription>{one.data?.title ?? "Loading"}</SheetDescription></SheetHeader>
      <Async state={one}>{(d) => (
        <ol className="space-y-3 px-4 pb-6 text-sm">{d.history.map((e) => (
          <li key={e.id} className="border-l-2 pl-3">
            <p className="font-medium">{EVENT_TEXT[e.kind] ?? e.kind}{e.kind === "assigned" && e.detail.to ? ` to ${String(e.detail.to)}` : ""}{e.kind === "snoozed" && e.detail.until ? ` until ${fmt.dateTime(String(e.detail.until))}` : ""}</p>
            <p className="text-xs text-muted-foreground">{e.actor} · {fmt.dateTime(e.at)}</p>
            {e.kind === "sent" || e.kind === "repeated" ? <p className="text-xs text-muted-foreground">{[...((e.detail.channels as string[] | undefined) ?? []).map((c) => `sent by ${c.replace(":", " to ")}`), ...((e.detail.notSent as string[] | undefined) ?? []).map((c) => `${c.replace(":", " to ")} not set up`), ...((e.detail.failed as string[] | undefined) ?? []).map((c) => `${c.replace(":", " to ")} failed`)].join("; ") || "shown in the app"}</p> : null}
            {e.note && <p className="mt-1 rounded bg-muted/50 p-2">{e.note}</p>}
          </li>))}</ol>)}</Async>
    </SheetContent></Sheet>
  );
}

export default function AlertsPage() { return <Suspense fallback={null}><Inner /></Suspense>; }
