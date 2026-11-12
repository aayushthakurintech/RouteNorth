"use client";
import { AlertTriangle, Archive, Bell, Check, CircleDashed, Pencil, ShieldCheck, X } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ChildSection } from "@/components/portal/child-section";
import { col, dollars, initials, sel } from "@/components/portal/cols";
import { DriverPay } from "@/components/portal/driver-pay";
import { RecordDialog, type FieldSpec } from "@/components/portal/field-form";
import { ConfirmDialog, PageHeader, StatCard, StatusBadge } from "@/components/portal/parts";
import { ReadOnlyList } from "@/components/portal/read-only-list";
import { Async } from "@/components/portal/states";
import { apiSend } from "@/lib/api";
import { useBreadcrumbs } from "@/lib/breadcrumbs";
import { useMe } from "@/lib/me-context";
import { DRIVER_STATUS_LABEL, DRIVER_STATUS_TONE, PERSONAL_FORM, STORED_DRIVER_STATUSES } from "@/lib/portal/driver-fields";
import { useFmt, type Fmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

interface Driver extends Record<string, unknown> {
  id: string; name: string; email: string; phone: string | null; status: string; storedStatus: string; statusReason: string | null; vehicleId: string | null; vehicleName: string | null; rateCardName: string | null;
  rating: number | null; onTimePct: number | null; score: number | null; safety: number | null; compliance: number; tripsMonth: number; revenueMonthCents: number; licenseExpiry: string | null; licenseClass: string | null;
  docs: { expired: number; expiring: number; nextExpiry: string | null }; blockedReasons: string[]; archivedAt: string | null; lastActive: string | null; canSeeBank: boolean;
  profile: Record<string, unknown>; counts: { documents: number; trips: number; openFollowUps: number }; onboarding: { done: number; total: number; requiredOpen: string[] };
}

/** One driver: summary on top, then a tab for each part of their record. */
export default function DriverProfile() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const fmt = useFmt();
  const { can } = useMe();
  const api = useApi<Driver>(`/portal/drivers/${id}`);
  const d = api.data;
  useBreadcrumbs([{ label: "Drivers", href: "/owner/drivers" }, { label: d?.name ?? "Driver" }]);
  const write = can("drivers.manage");
  const base = `/portal/drivers/${id}`;
  const [editing, setEditing] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [offboard, setOffboard] = useState(false);

  const tabs: [string, string][] = [["overview", "Overview"], ["personal", "Personal"], ["documents", "Documents"], ["vehicle", "Vehicle"], ["schedule", "Schedule"], ["trips", "Trips"], ["performance", "Performance"], ["safety", "Safety"], ["pay", "Pay"], ...(d?.canSeeBank ? [["bank", "Bank and tax"] as [string, string]] : []), ["training", "Training"], ["notes", "Notes and activity"]];

  return (
    <Async state={api}>
      {() => d && (
        <>
          <PageHeader
            title={<span className="flex flex-wrap items-center gap-2"><span className="grid size-9 place-items-center rounded-full bg-muted text-sm">{initials(d.name)}</span>{d.name}<StatusBadge tone={DRIVER_STATUS_TONE[d.status] ?? "neutral"}>{DRIVER_STATUS_LABEL[d.status] ?? d.status}</StatusBadge></span>}
            description={[d.email, d.phone].filter(Boolean).join(" · ")}
            actions={write && !d.archivedAt && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil className="size-4" /> Edit</Button>
                <Button size="sm" variant="outline" onClick={() => setStatus(d.storedStatus === "suspended" ? "active" : "suspended")}>{d.storedStatus === "suspended" ? "Reinstate" : "Suspend"}</Button>
                <Button size="sm" variant="outline" onClick={() => setOffboard(true)}><Archive className="size-4" /> Offboard</Button>
              </div>
            )} />
          {d.archivedAt && <div className="mb-4 flex items-center justify-between rounded-lg border p-3 text-sm"><span>This driver is archived and cannot sign in.</span>{write && <Button size="sm" onClick={async () => { await apiSend("POST", `${base}/restore`); toast.success("Restored"); api.reload(); }}>Restore</Button>}</div>}
          {d.blockedReasons.length > 0 && !d.archivedAt && (
            <div className="mb-4 flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert"><AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div><strong>This driver cannot be given jobs or go on duty.</strong><ul className="list-disc pl-5">{d.blockedReasons.map((r) => <li key={r}>{r}</li>)}</ul></div></div>
          )}
          <Tabs defaultValue="overview" className="space-y-4">
            <TabsList className="h-auto flex-wrap justify-start">{tabs.map(([k, l]) => <TabsTrigger key={k} value={k}>{l}</TabsTrigger>)}</TabsList>

            <TabsContent value="overview" className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                <StatCard label="Score (30 days)" value={d.score ?? "—"} hint="See the Performance tab for the formula" />
                <StatCard label="Rating" value={d.rating ? `${d.rating.toFixed(2)} ★` : "—"} hint={d.onTimePct != null ? `${d.onTimePct}% on time` : "No trips rated yet"} />
                <StatCard label="Trips this month" value={fmt.num(d.tripsMonth)} hint={can("pay.view") ? `${fmt.money(d.revenueMonthCents)} brought in` : undefined} />
                <StatCard label="Compliance" value={`${d.compliance}/100`} hint={d.docs.expired ? `${d.docs.expired} document(s) expired` : d.docs.expiring ? `${d.docs.expiring} expiring soon` : "Papers in order"} />
              </div>
              <div className="grid gap-4 lg:grid-cols-2">
                <Card><CardHeader><CardTitle className="text-base">Key details</CardTitle></CardHeader><CardContent><dl className="space-y-1 text-sm">
                  {([["Car", d.vehicleName], ["Rate card", d.rateCardName], ["Licence", [d.licenseClass, d.licenseExpiry && `until ${fmt.date(d.licenseExpiry)}`].filter(Boolean).join(" ")], ["Last active", d.lastActive && fmt.date(d.lastActive)], ["Open follow-ups", d.counts.openFollowUps]] as [string, unknown][]).map(([k, v]) => <div key={k} className="flex justify-between border-b py-1"><dt className="text-muted-foreground">{k}</dt><dd className="font-medium">{v ? String(v) : "—"}</dd></div>)}
                </dl>{d.statusReason && <p className="mt-2 text-sm text-muted-foreground">Status note: {d.statusReason}</p>}</CardContent></Card>
                <Onboarding id={id} d={d} write={write} onChange={api.reload} />
              </div>
            </TabsContent>

            <TabsContent value="personal"><Card><CardContent className="pt-6"><dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {([["Name", d.name], ["Phone", d.profile.phone], ["Email", d.email], ["Address", d.profile.address], ["Date of birth", d.profile.birthDate && fmt.date(d.profile.birthDate as string)], ["Languages", (d.profile.languages as string[])?.join(", ")], ["Home base", d.profile.homeBase], ["Employment", d.profile.employmentType], ["Emergency contact", [d.profile.emergencyName, d.profile.emergencyPhone].filter(Boolean).join(" · ")], ["Licence number", d.profile.licenseNo]] as [string, unknown][]).map(([k, v]) => <div key={k} className="flex justify-between gap-3 border-b py-1"><dt className="text-muted-foreground">{k}</dt><dd className="text-right font-medium">{v ? String(v) : "—"}</dd></div>)}
            </dl>{write && <Button className="mt-4" size="sm" variant="outline" onClick={() => setEditing(true)}><Pencil className="size-4" /> Edit details</Button>}</CardContent></Card></TabsContent>

            <TabsContent value="documents"><ChildSection id={`drv-docs-${id}`} title="Documents" base={base} name="documents" canWrite={write} addLabel="Add document" onChange={api.reload}
              fields={[{ key: "kind", label: "Kind", required: true, placeholder: "Driver licence, Work permit, Background check, Medical, Contract ..." }, { key: "number", label: "Number" }, { key: "issuedOn", label: "Issued", type: "date" }, { key: "expiresOn", label: "Expires", type: "date" }, { key: "remindDays", label: "Remind me (days before)", type: "number", step: "1" }, { key: "notes", label: "Notes", type: "textarea" }]}
              columns={[col("kind", "Kind", (r) => String(r.kind)), col("number", "Number", (r) => r.number as string), col("issuedOn", "Issued", (r) => fmt.date(r.issuedOn as string)), col("expiresOn", "Expires", (r) => <Expiry date={r.expiresOn as string | null} fmt={fmt} />)]}
              empty={{ title: "No documents yet", description: "Add the licence, permit, background check, certificates and contract. An expired licence or permit blocks the driver from jobs." }} /></TabsContent>

            <TabsContent value="vehicle"><VehicleTab base={base} fmt={fmt} write={write} onChange={api.reload} /></TabsContent>
            <TabsContent value="schedule"><ScheduleTab base={base} fmt={fmt} write={write} /></TabsContent>
            <TabsContent value="trips"><ReadOnlyList id={`drv-trips-${id}`} url={`${base}/trips`} columns={[col("startedAt", "Started", (r) => fmt.dateTime(r.startedAt as string)), col("customer", "Customer", (r) => r.customer as string), col("vehicle", "Car", (r) => r.vehicle as string), col("distanceM", "Distance", (r) => `${fmt.num(Number(r.distanceM) / 1000, 1)} km`, { end: true, num: true, csv: (r) => Number(r.distanceM) / 1000 }), col("durationS", "Duration", (r) => `${Math.round(Number(r.durationS) / 60)} min`, { end: true }), ...(can("pay.view") ? [col("revenueCents", "Revenue", (r) => fmt.money(r.revenueCents as number | null), { end: true, num: true, csv: (r) => dollars(r.revenueCents as number | null) })] : []), col("rating", "Rating", (r) => (r.rating ? `${r.rating} ★` : "—")), col("status", "Issues", (r) => [r.status !== "completed" && String(r.status), r.onTime === false && "late", r.complaint && "complaint"].filter(Boolean).join(", ") || "None")]} empty={{ title: "No trips yet", description: "Completed trips with distance, revenue and rating appear here." }} /></TabsContent>
            <TabsContent value="performance"><Performance base={base} id={id} fmt={fmt} write={write} /></TabsContent>
            <TabsContent value="safety"><Safety base={base} fmt={fmt} write={write} /></TabsContent>
            <TabsContent value="pay"><DriverPay id={id} /></TabsContent>
            {d.canSeeBank && <TabsContent value="bank"><Bank base={base} fmt={fmt} /></TabsContent>}
            <TabsContent value="training"><ChildSection id={`drv-train-${id}`} title="Training and certificates" base={base} name="trainings" canWrite={write} addLabel="Add course" onChange={api.reload}
              fields={[{ key: "course", label: "Course", required: true }, { key: "required", label: "Required for this driver", type: "checkbox" }, { key: "completedOn", label: "Completed on", type: "date" }, { key: "expiresOn", label: "Expires on", type: "date" }, { key: "score", label: "Test score (%)", type: "number", step: "1" }, { key: "certificateRef", label: "Certificate number" }]}
              columns={[col("course", "Course", (r) => String(r.course)), col("required", "Required", (r) => (r.required ? "Yes" : "No")), col("completedOn", "Completed", (r) => (r.completedOn ? fmt.date(r.completedOn as string) : <StatusBadge tone={r.required ? "warn" : "neutral"}>Not yet</StatusBadge>), { csv: (r) => String(r.completedOn ?? "") }), col("expiresOn", "Expires", (r) => <Expiry date={r.expiresOn as string | null} fmt={fmt} />), col("score", "Score", (r) => (r.score == null ? "—" : `${r.score}%`))]}
              empty={{ title: "No training recorded", description: "Add required courses, completion dates and certificates." }} /></TabsContent>
            <TabsContent value="notes"><NotesTab base={base} fmt={fmt} write={write} onChange={api.reload} /></TabsContent>
          </Tabs>

          <RecordDialog open={editing} onOpenChange={setEditing} title={`Edit ${d.name}`} fields={PERSONAL_FORM} record={{ ...d.profile, displayName: d.name }} method="PATCH" path={base} onDone={api.reload} />
          <StatusDialog status={status} onClose={() => setStatus(null)} base={base} onDone={api.reload} />
          <OffboardDialog open={offboard} onOpenChange={setOffboard} base={base} onDone={() => router.push("/owner/drivers")} />
        </>
      )}
    </Async>
  );
}

function Expiry({ date, fmt }: { date: string | null; fmt: Fmt }) {
  if (!date) return <span className="text-muted-foreground">No expiry</span>;
  const days = Math.round((Date.parse(`${date.slice(0, 10)}T00:00:00Z`) - Date.now()) / 86_400_000);
  return <StatusBadge tone={days < 0 ? "bad" : days <= 30 ? "warn" : "good"}>{fmt.date(date)}{days < 0 ? " · expired" : days <= 30 ? ` · ${days}d left` : ""}</StatusBadge>;
}

interface Step { key: string; label: string; required: boolean; status: string; reason?: string | null }
function Onboarding({ id, d, write, onChange }: { id: string; d: Driver; write: boolean; onChange: () => void }) {
  const api = useApi<{ steps: Step[] }>(`/portal/drivers/${id}/onboarding`);
  const [reject, setReject] = useState<Step | null>(null); const [reason, setReason] = useState("");
  async function act(step: string, action: string, why?: string) {
    try { const r = await apiSend<{ activated: boolean }>("POST", `/portal/drivers/${id}/onboarding/${step}`, { action, reason: why }); if (r.activated) toast.success("All required steps are approved. The driver is now active."); api.reload(); onChange(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }
  const steps = api.data?.steps ?? [];
  const done = steps.filter((s) => s.status === "approved").length;
  return (
    <Card><CardHeader className="flex-row items-center justify-between"><CardTitle className="text-base">Onboarding</CardTitle>{write && d.storedStatus === "onboarding" && <Button size="sm" variant="outline" onClick={async () => { const r = await apiSend<{ sent: boolean; reason?: string }>("POST", `/portal/drivers/${id}/remind`); toast[r.sent ? "success" : "message"](r.sent ? "Reminder sent" : (r.reason ?? "Not sent")); }}><Bell className="size-4" /> Remind</Button>}</CardHeader>
      <CardContent className="space-y-2">
        <Progress value={steps.length ? (100 * done) / steps.length : 0} aria-label="Onboarding progress" />
        <ul className="space-y-1 text-sm">{steps.map((s) => (
          <li key={s.key} className="flex flex-wrap items-center justify-between gap-2 border-b py-1">
            <span className="flex items-center gap-2">{s.status === "approved" ? <Check className="size-4 text-ok" /> : s.status === "rejected" ? <X className="size-4 text-destructive" /> : <CircleDashed className="size-4 text-muted-foreground" />}{s.label}{s.required && <span className="text-xs text-muted-foreground">(required)</span>}</span>
            <span className="flex items-center gap-1"><StatusBadge tone={s.status === "approved" ? "good" : s.status === "rejected" ? "bad" : s.status === "submitted" ? "info" : "neutral"}>{s.status}</StatusBadge>
              {write && s.status !== "approved" && <Button size="sm" variant="ghost" onClick={() => act(s.key, "approve")}>Approve</Button>}
              {write && s.status !== "rejected" && s.status !== "approved" && <Button size="sm" variant="ghost" onClick={() => { setReject(s); setReason(""); }}>Reject</Button>}
              {write && s.status === "pending" && <Button size="sm" variant="ghost" onClick={() => act(s.key, "submit")}>Mark handed in</Button>}
              {write && (s.status === "approved" || s.status === "rejected") && <Button size="sm" variant="ghost" onClick={() => act(s.key, "reset")}>Undo</Button>}</span>
            {s.status === "rejected" && s.reason && <span className="w-full pl-6 text-xs text-destructive">Rejected: {s.reason}</span>}
          </li>))}</ul>
        {reject && <div className="flex gap-2"><Input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder={`Why is “${reject.label}” rejected?`} /><Button disabled={!reason.trim()} onClick={async () => { await act(reject.key, "reject", reason); setReject(null); }}>Reject</Button><Button variant="outline" onClick={() => setReject(null)}>Cancel</Button></div>}
      </CardContent></Card>
  );
}

function StatusDialog({ status, onClose, base, onDone }: { status: string | null; onClose: () => void; base: string; onDone: () => void }) {
  const [reason, setReason] = useState(""); const [s, setS] = useState("active");
  const target = status === "suspended" ? "suspended" : s;
  return (
    <ConfirmDialog open={!!status} onOpenChange={(o) => !o && onClose()} title={status === "suspended" ? "Suspend this driver?" : "Change status"} confirmLabel={status === "suspended" ? "Suspend" : "Save"} destructive={status === "suspended"}
      description={<div className="space-y-2">{status === "suspended" ? <p>They cannot be given jobs or go on duty until reinstated. A reason is required and goes on the audit log.</p> : <Select value={s} onValueChange={setS}><SelectTrigger aria-label="Status"><SelectValue /></SelectTrigger><SelectContent>{STORED_DRIVER_STATUSES.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent></Select>}
        {status === "suspended" && <Input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (required)" />}</div>}
      onConfirm={async () => { try { await apiSend("POST", `${base}/status`, { status: target, reason }); toast.success("Status updated"); onClose(); onDone(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); } }} />
  );
}

interface Checklist { items: { key: string; label: string; done: boolean; detail: string }[]; unpaidCents: number }
function OffboardDialog({ open, onOpenChange, base, onDone }: { open: boolean; onOpenChange: (o: boolean) => void; base: string; onDone: () => void }) {
  const fmt = useFmt();
  const api = useApi<Checklist>(open ? `${base}/offboarding` : null);
  const [reason, setReason] = useState("");
  return (
    <ConfirmDialog open={open} onOpenChange={onOpenChange} title="Offboard this driver" confirmLabel="Offboard and archive" destructive
      description={<div className="space-y-2 text-left"><p>This returns the car, removes sign-in access and archives the record. Their trips, pay and history stay in reports.</p>
        <ul className="space-y-1">{(api.data?.items ?? []).map((i) => <li key={i.key} className="flex items-start gap-2">{i.done ? <Check className="mt-0.5 size-4 text-ok" /> : <CircleDashed className="mt-0.5 size-4 text-muted-foreground" />}<span>{i.label}: <span className="text-muted-foreground">{i.detail}</span></span></li>)}</ul>
        {api.data && api.data.unpaidCents > 0 && <p className="text-destructive">They are still owed {fmt.money(api.data.unpaidCents)}. Pay it out first.</p>}
        <Input aria-label="Reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason (optional)" /></div>}
      onConfirm={async () => { try { await apiSend("POST", `${base}/offboard`, { reason, acknowledgeUnpaid: false }); toast.success("Driver offboarded"); onDone(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); } }} />
  );
}

function VehicleTab({ base, fmt, write, onChange }: { base: string; fmt: Fmt; write: boolean; onChange: () => void }) {
  const api = useApi<{ current: { id: string; name: string; licenceCheck: string | null } | null; licenseClass: string | null; history: { id: string; vehicle: string; assignKind: string; startAt: string; endAt: string | null; damageNotes: string | null }[]; incidents: { id: string; occurredAt: string; kind: string; description: string; vehicle: string | null }[] }>(`${base}/vehicle`);
  const meta = useApi<{ vehicles: { id: string; name: string }[] }>("/portal/drivers/meta");
  const [assign, setAssign] = useState(false);
  const fields = useMemo<FieldSpec[]>(() => [{ key: "vehicleId", label: "Car", type: "select", required: true, options: (meta.data?.vehicles ?? []).map((v) => ({ value: v.id, label: v.name })) }], [meta.data]);
  return (
    <Async state={api}>{() => { const v = api.data!; return (
      <div className="space-y-4 text-sm">
        <Card><CardHeader className="flex-row items-center justify-between"><CardTitle className="text-base">Current car</CardTitle>{write && <Button size="sm" onClick={() => setAssign(true)}>{v.current ? "Change car" : "Assign car"}</Button>}</CardHeader>
          <CardContent>{v.current ? <p><strong>{v.current.name}</strong> · licence class {v.licenseClass ?? "unknown"} {v.current.licenceCheck === "ok" ? <StatusBadge tone="good">Licence covers this car</StatusBadge> : v.current.licenceCheck === "not_licensed" ? <StatusBadge tone="bad">Licence does not cover this car</StatusBadge> : <StatusBadge tone="warn">Check licence by hand</StatusBadge>}</p> : <p className="text-muted-foreground">No car assigned.</p>}</CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Hand-over history</CardTitle></CardHeader><CardContent><ul className="space-y-1">{v.history.map((h) => <li key={h.id} className="flex flex-wrap justify-between gap-2 border-b py-1"><span>{h.vehicle} · {h.assignKind}</span><span className="text-muted-foreground">{fmt.date(h.startAt)} to {h.endAt ? fmt.date(h.endAt) : "now"}</span>{h.damageNotes && <span className="w-full text-destructive">Damage: {h.damageNotes}</span>}</li>)}{!v.history.length && <li className="text-muted-foreground">No cars yet.</li>}</ul></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Damage and incident reports</CardTitle></CardHeader><CardContent><ul className="space-y-1">{v.incidents.map((i) => <li key={i.id} className="border-b py-1">{fmt.dateTime(i.occurredAt)} · {i.kind.replace(/_/g, " ")} · {i.vehicle ?? "no car"}<div className="text-muted-foreground">{i.description}</div></li>)}{!v.incidents.length && <li className="text-muted-foreground">None.</li>}</ul></CardContent></Card>
        <RecordDialog open={assign} onOpenChange={setAssign} title="Assign a car" description="Permanent assignment. A car that is booked by someone else, or that the licence class does not cover, is refused." fields={fields} method="POST" path={`${base}/vehicle`} onDone={() => { api.reload(); onChange(); }} />
      </div>); }}</Async>
  );
}

function ScheduleTab({ base, fmt, write }: { base: string; fmt: Fmt; write: boolean }) {
  const api = useApi<{ shifts: { id: string; startsAt: string; endsAt: string; note: string | null; conflict: string | null }[]; timeOff: { id: string; kind: string; startsOn: string; endsOn: string; status: string }[] }>(`${base}/schedule`);
  const [add, setAdd] = useState(false);
  return (
    <Async state={api}>{() => { const s = api.data!; return (
      <div className="space-y-4 text-sm">
        <Card><CardHeader className="flex-row items-center justify-between"><CardTitle className="text-base">Planned shifts (next 4 weeks)</CardTitle>{write && <Button size="sm" onClick={() => setAdd(true)}>Add shift</Button>}</CardHeader>
          <CardContent><ul className="space-y-1">{s.shifts.map((x) => <li key={x.id} className={`flex flex-wrap justify-between gap-2 rounded border-b px-2 py-1 ${x.conflict ? "bg-destructive/10 text-destructive" : ""}`}><span>{fmt.dateTime(x.startsAt)} to {fmt.dateTime(x.endsAt)}</span><span>{x.conflict ? `Conflict: ${x.conflict}` : x.note ?? ""}</span></li>)}{!s.shifts.length && <li className="text-muted-foreground">No shifts planned.</li>}</ul></CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Time off</CardTitle></CardHeader><CardContent><ul className="space-y-1">{s.timeOff.map((o) => <li key={o.id} className="flex justify-between border-b py-1"><span>{o.kind} · {fmt.date(o.startsOn)} to {fmt.date(o.endsOn)}</span><StatusBadge tone={o.status === "approved" ? "good" : o.status === "rejected" ? "bad" : "warn"}>{o.status}</StatusBadge></li>)}{!s.timeOff.length && <li className="text-muted-foreground">No time off booked.</li>}</ul></CardContent></Card>
        <RecordDialog open={add} onOpenChange={setAdd} title="Add a shift" fields={[{ key: "startsAt", label: "Starts", type: "datetime", required: true }, { key: "endsAt", label: "Ends", type: "datetime", required: true, help: "Up to 24 hours after the start." }, { key: "note", label: "Note" }]} method="POST" path={`${base}/schedule`} onDone={api.reload} />
      </div>); }}</Async>
  );
}

interface Perf { score: number | null; parts: { key: string; label: string; weight: number; value: number | null; points: number | null }[]; formula: string; vsTeam: Record<string, { driver: number | null; team: number | null }>; acceptanceRate: number | null; cancellationRate: number | null; ratingAvg: number | null; complaints: number; tripsPerHour: number | null;
  goals: { id: string; metric: string; target: number; period: string; current: number | null; pct: number | null }[]; belowFloor: boolean; scoreFloor: number; windowDays: number }
function Performance({ base, id, fmt, write }: { base: string; id: string; fmt: Fmt; write: boolean }) {
  const api = useApi<Perf>(`${base}/performance`);
  return (
    <Async state={api}>{() => { const p = api.data!; return (
      <div className="space-y-4">
        {p.belowFloor && <div className="rounded-lg border border-warn/40 bg-warn/10 p-3 text-sm">Score is below {p.scoreFloor}. Consider an improvement plan under Notes and activity.</div>}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard label={`Score (last ${p.windowDays} days)`} value={p.score ?? "—"} hint={p.vsTeam.score?.team != null ? `Team average ${p.vsTeam.score.team}` : undefined} />
          <StatCard label="Acceptance rate" value={p.acceptanceRate == null ? "—" : `${p.acceptanceRate}%`} hint={`Cancellation ${p.cancellationRate ?? "—"}%`} />
          <StatCard label="Customer rating" value={p.ratingAvg ? `${p.ratingAvg.toFixed(2)} ★` : "—"} hint={`${p.complaints} complaint${p.complaints === 1 ? "" : "s"}`} />
          <StatCard label="Trips per hour" value={p.tripsPerHour ?? "—"} />
        </div>
        <Card><CardHeader><CardTitle className="text-base">How the score is made</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
          <p className="text-muted-foreground">{p.formula}</p>
          <table className="w-full"><thead><tr className="text-left text-muted-foreground"><th>Part</th><th className="text-right">Weight</th><th className="text-right">Result (0 to 100)</th><th className="text-right">Points</th></tr></thead>
            <tbody>{p.parts.map((x) => <tr key={x.key} className="border-t"><td className="py-1">{x.label}</td><td className="text-right">{x.weight}%</td><td className="text-right">{x.value ?? "no data"}</td><td className="text-right">{x.points ?? "—"}</td></tr>)}<tr className="border-t font-semibold"><td className="py-1">Score</td><td /><td /><td className="text-right">{p.score ?? "—"}</td></tr></tbody></table>
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Compared with the team</CardTitle></CardHeader><CardContent className="grid gap-2 text-sm sm:grid-cols-3">
          {[["Score", p.vsTeam.score], ["Rating", p.vsTeam.rating], ["On-time %", p.vsTeam.onTimePct]].map(([l, v]) => { const x = v as { driver: number | null; team: number | null }; return <div key={String(l)} className="rounded border p-2"><div className="text-muted-foreground">{String(l)}</div><div className="text-lg font-semibold">{x.driver ?? "—"} <span className="text-sm font-normal text-muted-foreground">vs {x.team ?? "—"} team</span></div></div>; })}
        </CardContent></Card>
        <ChildSection id={`drv-goals-${id}`} title="Goals" base={base} name="goals" canWrite={write} addLabel="Add goal" onChange={api.reload}
          fields={[{ key: "metric", label: "Measure", type: "select", required: true, options: [{ value: "trips", label: "Trips" }, { value: "on_time_rate", label: "On-time rate (%)" }, { value: "rating", label: "Rating" }, { value: "safety_score", label: "Safety score" }] }, { key: "target", label: "Target", type: "number", required: true }, { key: "period", label: "Per", type: "select", options: sel(["week", "month"]) }]}
          columns={[col("metric", "Measure", (r) => String(r.metric).replace(/_/g, " ")), col("target", "Target", (r) => String(r.target)), col("period", "Per", (r) => String(r.period)), col("progress", "Progress", (r) => { const g = p.goals.find((x) => x.id === r.id); return g?.pct == null ? "—" : <span className="flex items-center gap-2"><Progress value={g.pct} className="w-24" aria-label="Progress" />{g.current} ({g.pct}%)</span>; }, { csv: (r) => String(p.goals.find((x) => x.id === r.id)?.pct ?? "") })]}
          empty={{ title: "No goals", description: "Set a target, for example 40 trips a month or 95% on time, and see progress here." }} />
        <span className="hidden">{fmt.currency}</span>
      </div>); }}</Async>
  );
}

function Safety({ base, fmt, write }: { base: string; fmt: Fmt; write: boolean }) {
  const api = useApi<{ score: number | null; formula: string; counts: Record<string, number>; trend: { weekStart: string; score: number; events: number }[] }>(`${base}/safety`);
  return (
    <Async state={api}>{() => { const s = api.data!; return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-4"><StatCard label="Safety score" value={s.score ?? "—"} hint="Last 30 days" />
          {["speeding", "harsh_brake", "harsh_turn", "phone_use", "late_night", "incident", "ticket"].slice(0, 3).map((k) => <StatCard key={k} label={k.replace(/_/g, " ")} value={s.counts[k] ?? 0} />)}</div>
        <Card><CardHeader><CardTitle className="text-base">Score trend (weekly)</CardTitle></CardHeader><CardContent><div className="flex items-end gap-2" role="img" aria-label="Weekly safety score">{s.trend.map((t) => <div key={t.weekStart} className="flex flex-1 flex-col items-center gap-1 text-xs"><div className="w-full rounded-t bg-primary" style={{ height: `${Math.max(4, t.score)}px` }} title={`${t.score} (${t.events} events)`} /><span className="text-muted-foreground">{fmt.date(t.weekStart).replace(/, \d{4}/, "")}</span></div>)}</div><p className="mt-3 text-xs text-muted-foreground"><ShieldCheck className="mr-1 inline size-3" />{s.formula}</p></CardContent></Card>
        <ChildSection id="drv-safety" title="Safety events" base={base} name="safety-events" canWrite={write} addLabel="Log event"
          fields={[{ key: "kind", label: "Kind", type: "select", required: true, options: sel(["speeding", "harsh_brake", "harsh_turn", "phone_use", "late_night", "incident", "ticket"]) }, { key: "severity", label: "Severity (1 to 3)", type: "number", step: "1" }, { key: "at", label: "When", type: "datetime" }, { key: "detail", label: "Details", type: "textarea" }]} onChange={api.reload}
          columns={[col("at", "When", (r) => fmt.dateTime(r.at as string)), col("kind", "Kind", (r) => String(r.kind).replace(/_/g, " ")), col("severity", "Severity", (r) => String(r.severity)), col("detail", "Details", (r) => r.detail as string)]}
          empty={{ title: "No safety events", description: "Speeding, harsh braking, phone use, late-night driving, incidents and tickets show up here." }} />
      </div>); }}</Async>
  );
}

function Bank({ base, fmt }: { base: string; fmt: Fmt }) {
  const api = useApi<{ payoutMethod: string | null; bankInstitution: string | null; bankAccountLast4: string | null; taxForm: string | null; taxFormReceivedOn: string | null; employmentType: string; note: string }>(`${base}/bank`);
  const [edit, setEdit] = useState(false);
  return (
    <Async state={api}>{() => { const b = api.data!; return (
      <Card><CardHeader className="flex-row items-center justify-between"><CardTitle className="text-base">Bank and tax</CardTitle><Button size="sm" variant="outline" onClick={() => setEdit(true)}><Pencil className="size-4" /> Edit</Button></CardHeader>
        <CardContent className="space-y-2 text-sm">
          <dl className="grid gap-x-6 gap-y-1 sm:grid-cols-2">{([["Payout method", b.payoutMethod], ["Bank", b.bankInstitution], ["Account ending", b.bankAccountLast4 && `••${b.bankAccountLast4}`], ["Tax form", b.taxForm], ["Received", b.taxFormReceivedOn && fmt.date(b.taxFormReceivedOn)], ["Employee or contractor", b.employmentType]] as [string, unknown][]).map(([k, v]) => <div key={k} className="flex justify-between border-b py-1"><dt className="text-muted-foreground">{k}</dt><dd className="font-medium">{v ? String(v) : "—"}</dd></div>)}</dl>
          <p className="text-xs text-muted-foreground">{b.note} Every view and change here is written to the audit log.</p>
          <RecordDialog open={edit} onOpenChange={setEdit} title="Edit bank and tax" fields={[{ key: "payoutMethod", label: "Payout method", type: "select", options: [{ value: "direct_deposit", label: "Direct deposit" }, { value: "etransfer", label: "Interac e-Transfer" }, { value: "cheque", label: "Cheque" }, { value: "cash", label: "Cash" }] }, { key: "bankInstitution", label: "Bank" }, { key: "bankAccountLast4", label: "Last 4 digits of the account", help: "Never type the full number." }, { key: "taxForm", label: "Tax form", type: "select", options: [{ value: "td1", label: "TD1 (employee)" }, { value: "t4a_contractor", label: "Contractor (T4A)" }, { value: "gst_hst_number", label: "GST/HST number" }, { value: "none", label: "None on file" }] }, { key: "taxFormReceivedOn", label: "Received on", type: "date" }]} record={b} method="PATCH" path={`${base}/bank`} onDone={api.reload} />
        </CardContent></Card>); }}</Async>
  );
}

function NotesTab({ base, fmt, write, onChange }: { base: string; fmt: Fmt; write: boolean; onChange: () => void }) {
  const act = useApi<{ id: string; at: string; actor: string | null; action: string; label: string | null; oldValue: unknown; newValue: unknown }[]>(write ? `${base}/activity` : null);
  return (
    <div className="space-y-8">
      {write && <ChildSection id="drv-notes" title="Warnings, praise, coaching and private notes" base={base} name="notes" canWrite addLabel="Add note" onChange={onChange}
        fields={[{ key: "kind", label: "Kind", type: "select", required: true, options: sel(["note", "warning", "praise", "coaching", "improvement_plan", "private"]) }, { key: "body", label: "Note", type: "textarea", required: true }, { key: "notedOn", label: "Date", type: "date" }, { key: "dueOn", label: "Follow up by", type: "date" }, { key: "doneOn", label: "Done on", type: "date" }]}
        columns={[col("notedOn", "Date", (r) => fmt.date(r.notedOn as string)), col("kind", "Kind", (r) => <StatusBadge tone={r.kind === "warning" ? "bad" : r.kind === "praise" ? "good" : "neutral"}>{String(r.kind).replace(/_/g, " ")}</StatusBadge>, { csv: (r) => String(r.kind) }), col("body", "Note", (r) => <span className="line-clamp-2 max-w-md">{String(r.body)}</span>), col("dueOn", "Follow up", (r) => (r.dueOn ? <>{fmt.date(r.dueOn as string)} {r.doneOn ? <StatusBadge tone="good">done</StatusBadge> : null}</> : "—"), { csv: (r) => String(r.dueOn ?? "") })]}
        empty={{ title: "No notes yet", description: "Record warnings and praise with dates, coaching notes with follow-up tasks, and improvement plans." }} />}
      {write && <Card><CardHeader><CardTitle className="text-base">Change history</CardTitle></CardHeader><CardContent><Async state={act}>{() => <ul className="space-y-2 text-sm">{act.data!.map((a) => <li key={a.id} className="border-b pb-2"><strong>{a.action.replace(/[._]/g, " ")}</strong>{a.label && ` · ${a.label}`}<div className="text-xs text-muted-foreground">{a.actor ?? "system"} · {fmt.dateTime(a.at)}</div>{(a.oldValue || a.newValue) != null && <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-[11px]">{JSON.stringify({ was: a.oldValue, now: a.newValue })}</pre>}</li>)}{!act.data!.length && <li className="text-muted-foreground">No changes logged.</li>}</ul>}</Async></CardContent></Card>}
      {!write && <p className="text-sm text-muted-foreground">Notes are visible to people who can manage drivers.</p>}
    </div>
  );
}
