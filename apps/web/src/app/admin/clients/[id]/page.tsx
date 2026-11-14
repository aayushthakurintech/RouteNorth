"use client";
import { ExternalLink, Eye, Loader2, Search } from "lucide-react";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import type { SectionId } from "@routenorth/shared";
import { useAdmin } from "@/components/admin/AdminShell";
import { useStepUp } from "@/components/admin/StepUp";
import { Facts, Field, HealthPill, fail, selectCls } from "@/components/admin/parts";
import { ConfirmDialog, PageHeader, StatusBadge } from "@/components/portal/parts";
import { ErrorState, LoadingState } from "@/components/portal/states";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tabs } from "@/components/ui/primitives";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Textarea } from "@/components/ui/textarea";
import { ACTION_LABEL, ago, when, type ClientDetail } from "@/lib/admin";
import { apiGet, apiSend } from "@/lib/api";
import { useApi } from "@/lib/use-api";

export default function ClientPage() {
  const { id } = useParams<{ id: string }>();
  const { can } = useAdmin();
  const q = useApi<ClientDetail>(can("clients.view") ? `/admin/clients/${id}` : null);
  const [tab, setTab] = useState("overview");
  const [viewing, setViewing] = useState(false);
  if (!can("clients.view")) return <ErrorState error="HTTP 403" />;
  if (q.error && !q.data) return <ErrorState error={q.error.message === "HTTP 404" ? "That client does not exist." : q.error} onRetry={q.reload} />;
  const c = q.data;
  if (!c) return <LoadingState rows={6} />;
  const tabs = [
    { id: "overview", label: "Overview" }, { id: "people", label: `People (${c.users.length})` }, { id: "access", label: "Access" }, { id: "account", label: "Account" }, { id: "activity", label: "Staff activity" },
  ];
  return (
    <>
      <PageHeader
        title={<span className="flex flex-wrap items-center gap-3">{c.name} <HealthPill level={c.health.level} /></span>}
        description={`${c.slug} · created ${when(c.createdAt)}${c.status === "suspended" ? " · suspended" : ""}`}
        crumbs={[{ label: "Clients", href: "/admin/clients" }, { label: c.name }]}
        actions={can("impersonate.view") ? <Button variant="outline" onClick={() => setViewing(true)} disabled={c.status === "suspended" && false}><Eye /> View as client</Button> : undefined}
      />
      <Tabs label="Client sections" value={tab} onChange={setTab} tabs={tabs} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="mt-5">
        {tab === "overview" && <OverviewTab c={c} />}
        {tab === "people" && <PeopleTab c={c} />}
        {tab === "access" && <AccessTab c={c} onSaved={q.reload} />}
        {tab === "account" && <AccountTab c={c} onSaved={q.reload} />}
        {tab === "activity" && <ActivityTab c={c} />}
      </div>
      <ViewAsDialog c={c} open={viewing} onClose={() => setViewing(false)} />
    </>
  );
}

function OverviewTab({ c }: { c: ClientDetail }) {
  const u = c.usage;
  const { can } = useAdmin();
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle>How it is doing</CardTitle><CardDescription>Worked out from the numbers below, with reasons.</CardDescription></CardHeader>
        <CardContent>
          {c.health.flags.length === 0 ? <p className="text-sm text-muted-foreground">Nothing to flag.</p> : (
            <ul className="space-y-1.5 text-sm">{c.health.flags.map((f) => <li key={f.code} className="flex gap-2"><span aria-hidden className="mt-1.5 inline-block size-2 shrink-0 rounded-full" style={{ background: f.level === "bad" ? "var(--danger)" : f.level === "warn" ? "var(--warn)" : "var(--muted)" }} />{f.text}</li>)}</ul>
          )}
        </CardContent></Card>
      <Card><CardHeader><CardTitle>Usage</CardTitle></CardHeader>
        <CardContent><Facts rows={[
          ["Vehicles", `${u.vehicles}${c.entitlements.limits.vehicles !== null ? ` of ${c.entitlements.limits.vehicles} allowed` : ""}`],
          ["Trackers", `${u.devices} connected, ${u.devicesLive} reporting now, ${u.devicesRecent} in 24 h`],
          ["Drivers", u.drivers], ["People who sign in", `${u.users}${c.entitlements.limits.users !== null ? ` of ${c.entitlements.limits.users} allowed` : ""}`],
          ["Jobs this month", u.jobsMonth], ["Last position", ago(u.lastPositionAt)], ["Last sign-in", ago(u.lastLoginAt)],
        ]} /></CardContent></Card>
      <Card><CardHeader><CardTitle>How trackers connect</CardTitle></CardHeader>
        <CardContent>{c.trackerMethods.length === 0 ? <p className="text-sm text-muted-foreground">No trackers connected yet.</p> : <Facts rows={c.trackerMethods.map((m) => [m.method, `${m.n}`])} />}</CardContent></Card>
      <Card><CardHeader><CardTitle>Plan</CardTitle></CardHeader>
        <CardContent><Facts rows={[
          ["Plan", <span key="p" className="capitalize">{c.plan}</span>], ["Trial ends", c.trialEndsAt ? when(c.trialEndsAt) : "–"],
          ["Owner", c.ownerEmail ? `${c.ownerName ?? ""} ${c.ownerEmail}` : "–"], ["Staff views", c.staffAccessAllowed ? "Allowed (client has not turned it off)" : "Switched off by the client"],
        ]} /></CardContent></Card>
      {can("clients.view") && <TrackerLookup />}
    </div>
  );
}

/** Which client holds a tracker ID: answers "two companies claim the same tracker" without opening anyone's devices. */
function TrackerLookup() {
  const [source, setSource] = useState("traccar");
  const [tid, setTid] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ found: boolean; holder: { orgName: string; orgId: string; deviceId: string; method: string | null; registeredAt: string; lastPositionAt: string | null } | null } | null>(null);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try { setRes(await apiGet(`/admin/devices/lookup?source=${encodeURIComponent(source)}&id=${encodeURIComponent(tid.trim())}`)); } catch (er) { fail(er); setRes(null); } finally { setBusy(false); }
  }
  return (
    <Card><CardHeader><CardTitle>Who holds a tracker ID?</CardTitle><CardDescription>For disputes. Shows the holder only, never positions. Each lookup is logged.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <form onSubmit={go} className="flex flex-wrap gap-2">
          <select aria-label="Tracker source" className={selectCls} value={source} onChange={(e) => setSource(e.target.value)}>{["traccar", "geotab", "samsara", "terminal", "simulator"].map((s) => <option key={s}>{s}</option>)}</select>
          <Input aria-label="Tracker ID" className="min-w-40 flex-1" placeholder="IMEI or provider ID" required maxLength={100} value={tid} onChange={(e) => setTid(e.target.value)} />
          <Button type="submit" variant="outline" disabled={busy}>{busy ? <Loader2 className="animate-spin" /> : <Search />} Look up</Button>
        </form>
        {res && (res.found && res.holder ? (
          <p className="text-sm"><a className="font-medium underline underline-offset-4" href={`/admin/clients/${res.holder.orgId}`}>{res.holder.orgName}</a> holds it{res.holder.method ? ` (${res.holder.method})` : ""}, registered {when(res.holder.registeredAt)}, last position {ago(res.holder.lastPositionAt)}.</p>
        ) : <p className="text-sm text-muted-foreground">No client holds that ID.</p>)}
      </CardContent></Card>
  );
}

function PeopleTab({ c }: { c: ClientDetail }) {
  return (
    <div className="rounded-xl border">
      <Table>
        <TableHeader><TableRow><TableHead>Person</TableHead><TableHead>Role</TableHead><TableHead>Two-factor</TableHead><TableHead>Last sign-in</TableHead><TableHead>Status</TableHead></TableRow></TableHeader>
        <TableBody>
          {c.users.map((u) => (
            <TableRow key={u.id}>
              <TableCell><div className="font-medium">{u.displayName ?? u.email}</div><div className="text-xs text-muted-foreground">{u.email}</div></TableCell>
              <TableCell className="capitalize">{u.role.replace(/_/g, " ")}</TableCell>
              <TableCell>{u.twoFactor ? "On" : <span className="text-muted-foreground">Off</span>}</TableCell>
              <TableCell className="whitespace-nowrap text-muted-foreground">{ago(u.lastSignIn)}</TableCell>
              <TableCell>{u.disabled ? <StatusBadge tone="neutral">Disabled</StatusBadge> : <StatusBadge tone="good">Active</StatusBadge>}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
      <p className="border-t p-3 text-xs text-muted-foreground">Drivers and customers are not listed here. Staff see people, counts and sign-in times; positions, trips, pay and customer data open only through a logged “view as client”.</p>
    </div>
  );
}

function AccessTab({ c, onSaved }: { c: ClientDetail; onSaved: () => void }) {
  const { can, catalog } = useAdmin();
  const withStepUp = useStepUp();
  const editable = can("clients.access");
  const all = useMemo(() => (catalog?.sections.map((s) => s.id) ?? []) as SectionId[], [catalog]);
  const initial = useMemo(() => new Set<SectionId>(c.entitlements.sections), [c]);
  const [on, setOn] = useState<Set<SectionId>>(initial);
  const [vehicles, setVehicles] = useState(c.entitlements.limits.vehicles?.toString() ?? "");
  const [users, setUsers] = useState(c.entitlements.limits.users?.toString() ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { setOn(new Set(c.entitlements.sections)); setVehicles(c.entitlements.limits.vehicles?.toString() ?? ""); setUsers(c.entitlements.limits.users?.toString() ?? ""); }, [c]);
  if (!catalog) return <LoadingState rows={4} />;
  const changed = on.size !== initial.size || [...on].some((s) => !initial.has(s)) || vehicles !== (c.entitlements.limits.vehicles?.toString() ?? "") || users !== (c.entitlements.limits.users?.toString() ?? "");
  const toggle = (s: SectionId) => setOn((p) => { const n = new Set(p); if (n.has(s)) n.delete(s); else n.add(s); return n; });
  async function save() {
    setBusy(true);
    try {
      const body = { sections: all.filter((s) => on.has(s)), limits: { vehicles: vehicles === "" ? null : Number(vehicles), users: users === "" ? null : Number(users) }, reason: reason.trim() || undefined };
      const r = await withStepUp(() => apiSend<{ added: string[]; removed: string[] }>("PUT", `/admin/clients/${c.id}/access`, body));
      const label = (x: string) => catalog!.sections.find((s) => s.id === x)?.label ?? x;
      toast.success(r.added.length || r.removed.length ? `Saved. ${r.added.length ? `Added: ${r.added.map(label).join(", ")}. ` : ""}${r.removed.length ? `Removed: ${r.removed.map(label).join(", ")}.` : ""} It applies on their next click.` : "Saved.");
      setReason(""); onSaved();
    } catch (e) { fail(e); } finally { setBusy(false); }
  }
  return (
    <div className="space-y-6">
      <div className="rounded-xl border bg-muted/30 p-4 text-sm">
        <p className="font-medium">What this client can see</p>
        <p className="mt-1 text-muted-foreground">Always on for every client: {catalog.core.join("; ").toLowerCase()}. Sections you turn off disappear from the client's menu and their API refuses them too, including API keys and shared links. A person's own role still decides what they can do inside a section.</p>
      </div>
      {editable && (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Presets">
          <span className="text-sm text-muted-foreground">Start from:</span>
          {catalog.presets.map((p) => <Button key={p.id} type="button" variant="outline" size="sm" onClick={() => setOn(new Set(p.sections))}>{p.label}</Button>)}
        </div>
      )}
      <fieldset className="grid min-w-0 gap-3 border-0 p-0 md:grid-cols-2" disabled={!editable || busy}>
        <legend className="sr-only">Sections</legend>
        {catalog.sections.map((s) => (
          <label key={s.id} className="flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors has-[:checked]:border-primary has-[:checked]:bg-primary/5 has-[:disabled]:cursor-default">
            <input type="checkbox" className="mt-1 size-4 accent-[var(--brand,currentColor)]" checked={on.has(s.id)} onChange={() => toggle(s.id)} />
            <span><span className="block text-sm font-semibold">{s.label}</span><span className="block text-xs text-muted-foreground">{s.blurb}</span></span>
          </label>
        ))}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2 lg:max-w-xl">
        <Field label="Vehicle limit" hint="Hard stop. Leave empty for the plan's own soft limit."><Input type="number" min={0} max={100000} inputMode="numeric" disabled={!editable} value={vehicles} onChange={(e) => setVehicles(e.target.value)} /></Field>
        <Field label="People limit" hint="Hard stop on adding users. Empty for none."><Input type="number" min={0} max={100000} inputMode="numeric" disabled={!editable} value={users} onChange={(e) => setUsers(e.target.value)} /></Field>
      </div>
      {editable ? (
        <div className="max-w-xl space-y-3">
          <Field label="Reason (optional, kept in the audit log)"><Input maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Contract signed for tracking and reports" /></Field>
          {on.size === 0 && <p role="status" className="text-sm text-[var(--warn)]">With no sections, this client can only sign in and manage its own account.</p>}
          <Button onClick={() => void save()} disabled={!changed || busy}>{busy && <Loader2 className="animate-spin" />} Save access</Button>
          {changed && <Button variant="ghost" className="ms-2" onClick={() => { setOn(new Set(initial)); setVehicles(c.entitlements.limits.vehicles?.toString() ?? ""); setUsers(c.entitlements.limits.users?.toString() ?? ""); }}>Discard</Button>}
        </div>
      ) : <p className="text-sm text-muted-foreground">Your role can look at this but not change it.</p>}
    </div>
  );
}

function AccountTab({ c, onSaved }: { c: ClientDetail; onSaved: () => void }) {
  const { can, catalog } = useAdmin();
  const withStepUp = useStepUp();
  const edit = can("clients.edit");
  const [name, setName] = useState(c.name);
  const [plan, setPlan] = useState(c.plan);
  const [trial, setTrial] = useState(c.trialEndsAt ? c.trialEndsAt.slice(0, 10) : "");
  const [notes, setNotes] = useState(c.internalNotes ?? "");
  const [busy, setBusy] = useState(false);
  const [suspend, setSuspend] = useState(false);
  const [reason, setReason] = useState("");
  useEffect(() => { setName(c.name); setPlan(c.plan); setTrial(c.trialEndsAt ? c.trialEndsAt.slice(0, 10) : ""); setNotes(c.internalNotes ?? ""); }, [c]);
  async function save(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const body: Record<string, unknown> = {};
      if (name !== c.name) body.name = name;
      if (plan !== c.plan) body.plan = plan;
      if (trial && trial !== (c.trialEndsAt ?? "").slice(0, 10)) body.trialEndsAt = new Date(`${trial}T23:59:00`).toISOString();
      if (notes !== (c.internalNotes ?? "")) body.internalNotes = notes;
      if (!Object.keys(body).length) { toast("Nothing changed"); return; }
      await apiSend("PATCH", `/admin/clients/${c.id}`, body);
      toast.success("Saved"); onSaved();
    } catch (er) { fail(er); } finally { setBusy(false); }
  }
  async function toggleSuspend() {
    setBusy(true);
    try {
      await withStepUp(() => apiSend("POST", `/admin/clients/${c.id}/${c.status === "active" ? "suspend" : "reinstate"}`, { reason: reason.trim() }));
      toast.success(c.status === "active" ? "Suspended. Their people are signed out of the product at their next click." : "Reinstated");
      setSuspend(false); setReason(""); onSaved();
    } catch (er) { fail(er); } finally { setBusy(false); }
  }
  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <form onSubmit={save} className="space-y-3">
        <Field label="Company name"><Input disabled={!edit} minLength={2} maxLength={100} value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Plan"><select disabled={!edit} className={`${selectCls} w-full`} value={plan} onChange={(e) => setPlan(e.target.value)}>{(catalog?.plans ?? []).map((p) => <option key={p.id}>{p.id}</option>)}</select></Field>
          <Field label="Trial ends"><Input type="date" disabled={!edit} value={trial} onChange={(e) => setTrial(e.target.value)} /></Field>
        </div>
        <Field label="Internal notes" hint="Only staff see these. Never shown to the client."><Textarea disabled={!edit} rows={5} maxLength={4000} value={notes} onChange={(e) => setNotes(e.target.value)} /></Field>
        {edit && <Button type="submit" disabled={busy}>{busy && <Loader2 className="animate-spin" />} Save</Button>}
      </form>
      <div className="space-y-3">
        <Card className={c.status === "suspended" ? "border-[var(--danger)]" : undefined}>
          <CardHeader><CardTitle>{c.status === "active" ? "Suspend this client" : "This client is suspended"}</CardTitle>
            <CardDescription>{c.status === "active" ? "Stops everyone at this company from using the product. Their data is kept, trackers keep arriving, and you can reinstate at any time." : `Since ${when(c.suspendedAt)}${c.suspendedReason ? `: ${c.suspendedReason}` : ""}`}</CardDescription></CardHeader>
          <CardContent>{can("clients.suspend") ? <Button variant={c.status === "active" ? "destructive" : "default"} onClick={() => setSuspend(true)}>{c.status === "active" ? "Suspend…" : "Reinstate…"}</Button> : <p className="text-sm text-muted-foreground">Your role cannot suspend or reinstate.</p>}</CardContent>
        </Card>
      </div>
      <ConfirmDialog open={suspend} onOpenChange={(o) => { setSuspend(o); if (!o) setReason(""); }} destructive={c.status === "active"}
        title={c.status === "active" ? `Suspend ${c.name}?` : `Reinstate ${c.name}?`}
        description={<span className="block space-y-3"><span className="block">{c.status === "active" ? "Everyone at this company is blocked from the product until you reinstate it. A reason is required and goes in the audit log and the client's own log." : "Everyone at this company can sign in again."}</span><Input aria-label="Reason" autoFocus placeholder="Reason (at least 10 characters)" value={reason} onChange={(e) => setReason(e.target.value)} /></span>}
        confirmLabel={c.status === "active" ? "Suspend" : "Reinstate"}
        onConfirm={() => { if (reason.trim().length < 10) { toast.error("Write a reason of at least 10 characters."); return; } return toggleSuspend(); }} />
    </div>
  );
}

function ActivityTab({ c }: { c: ClientDetail }) {
  return (
    <div className="space-y-8">
      <section className="space-y-2">
        <h2 className="font-display text-lg font-bold">Staff views of this client</h2>
        {c.staffViews.length === 0 ? <p className="text-sm text-muted-foreground">Staff have never opened this client.</p> : (
          <div className="rounded-xl border"><Table>
            <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Who</TableHead><TableHead>Reason</TableHead><TableHead className="text-end">Requests</TableHead><TableHead className="text-end">Writes refused</TableHead></TableRow></TableHeader>
            <TableBody>{c.staffViews.map((v) => (<TableRow key={v.id}><TableCell className="whitespace-nowrap">{when(v.startedAt)}</TableCell><TableCell>{v.adminEmail}</TableCell><TableCell className="max-w-xs whitespace-normal">{v.reason}</TableCell><TableCell className="text-end tabular-nums">{v.requests}</TableCell><TableCell className="text-end tabular-nums">{v.blockedWrites}</TableCell></TableRow>))}</TableBody>
          </Table></div>
        )}
      </section>
      <section className="space-y-2">
        <h2 className="font-display text-lg font-bold">Recent staff actions</h2>
        <div className="rounded-xl border"><Table>
          <TableHeader><TableRow><TableHead>When</TableHead><TableHead>Who</TableHead><TableHead>What</TableHead><TableHead>Reason</TableHead></TableRow></TableHeader>
          <TableBody>{c.staffActions.map((a) => (<TableRow key={a.id}><TableCell className="whitespace-nowrap">{when(a.at)}</TableCell><TableCell>{a.adminEmail ?? "–"}</TableCell><TableCell>{ACTION_LABEL[a.action] ?? a.action}</TableCell><TableCell className="max-w-xs whitespace-normal text-muted-foreground">{a.reason ?? ""}</TableCell></TableRow>))}</TableBody>
        </Table></div>
      </section>
    </div>
  );
}

/** Opens a short, read-only session in a new tab, as one of the client's own people. A reason is required. */
function ViewAsDialog({ c, open, onClose }: { c: ClientDetail; open: boolean; onClose: () => void }) {
  const { catalog } = useAdmin();
  const withStepUp = useStepUp();
  const [reason, setReason] = useState("");
  const [ticket, setTicket] = useState("");
  const [userId, setUserId] = useState("");
  const [busy, setBusy] = useState(false);
  const [href, setHref] = useState<string | null>(null);
  useEffect(() => { if (!open) { setReason(""); setTicket(""); setUserId(""); setHref(null); } }, [open]);
  const people = c.users.filter((u) => !u.disabled);
  async function go(e: React.FormEvent) {
    e.preventDefault(); setBusy(true);
    try {
      const r = await withStepUp(() => apiSend<{ token: string; viewingAs: { role: string } }>("POST", `/admin/clients/${c.id}/view-as`, { reason: reason.trim(), ticket: ticket.trim() || undefined, userId: userId || undefined }));
      const p = new URLSearchParams({ t: r.token, r: r.viewingAs.role, l: c.locale === "fr" ? "fr" : "en" });
      setHref(`/impersonate#${p}`);
    } catch (er) { fail(er); } finally { setBusy(false); }
  }
  const minutes = catalog?.impersonationMinutes ?? 30;
  return (
    <Dialog open={open} onOpenChange={(o) => { if (!o && !busy) onClose(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>View {c.name} as the client</DialogTitle>
          <DialogDescription>Read-only, {minutes} minutes, in a new tab with an amber banner. Nothing can be changed, and credentials, exports and API keys are hidden. The reason is saved in the audit log and in {c.name}'s own log.</DialogDescription></DialogHeader>
        {!c.staffAccessAllowed ? <p role="alert" className="text-sm text-destructive">This client has turned off staff access in its privacy settings. A view cannot be opened.</p> : href ? (
          <div className="space-y-3">
            <p className="text-sm">The view is ready. It ends by itself after {minutes} minutes, or when you press “End view” in its banner.</p>
            <a href={href} target="_blank" rel="noopener" className="inline-flex h-9 items-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground no-underline" onClick={() => setTimeout(onClose, 300)}><ExternalLink className="size-4" aria-hidden /> Open the client's view</a>
          </div>
        ) : (
          <form onSubmit={go} className="space-y-3">
            <Field label="Why are you looking? (required)" hint="Say what you are helping with, at least 10 characters."><Textarea required minLength={10} maxLength={500} rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Support ticket (optional)"><Input maxLength={80} value={ticket} onChange={(e) => setTicket(e.target.value)} /></Field>
              <Field label="View as"><select className={`${selectCls} w-full`} value={userId} onChange={(e) => setUserId(e.target.value)}><option value="">The owner</option>{people.map((u) => <option key={u.id} value={u.id}>{u.displayName ?? u.email} ({u.role.replace(/_/g, " ")})</option>)}</select></Field>
            </div>
            <Button type="submit" className="w-full" disabled={busy || reason.trim().length < 10}>{busy && <Loader2 className="animate-spin" />} Start the view</Button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
