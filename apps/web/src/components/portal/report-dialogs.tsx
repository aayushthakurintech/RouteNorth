"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Async } from "@/components/portal/states";
import { apiSend } from "@/lib/api";
import { useMe } from "@/lib/me-context";
import { useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

const fail = (e: unknown) => toast.error(e instanceof Error ? e.message : "Could not do that");

/** A private link that opens the results, until it expires. Links keep the person's region limit. */
export function ShareDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const fmt = useFmt(); const [days, setDays] = useState("7"); const [link, setLink] = useState<string | null>(null);
  const shares = useApi<{ id: string; name: string; expiresAt: string; revokedAt: string | null }[]>("/reports/shares");
  async function make() { try { const r = await apiSend<{ path: string }>("POST", `/reports/saved/${id}/share`, { days: Number(days) }); setLink(`${window.location.origin}${r.path}`); shares.reload(); } catch (e) { fail(e); } }
  const live = (shares.data ?? []).filter((s) => !s.revokedAt && new Date(s.expiresAt) > new Date());
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent>
      <DialogHeader><DialogTitle>Share a private link</DialogTitle><DialogDescription>Anyone with the link can read these results until it expires. They do not need to sign in and cannot change anything.</DialogDescription></DialogHeader>
      <div className="flex items-end gap-2"><div className="grow"><Label htmlFor="share-days">Link works for</Label>
        <Select value={days} onValueChange={setDays}><SelectTrigger id="share-days"><SelectValue /></SelectTrigger><SelectContent>{[1, 7, 30, 90].map((d) => <SelectItem key={d} value={String(d)}>{d} day{d === 1 ? "" : "s"}</SelectItem>)}</SelectContent></Select></div>
        <Button onClick={() => void make()}>Make link</Button></div>
      {link && <div role="status" className="space-y-1"><Input readOnly aria-label="Link" value={link} onFocus={(e) => e.target.select()} /><p className="text-xs text-muted-foreground">Copy it now. It is shown only here.</p></div>}
      {live.length > 0 && <div><h4 className="mb-1 text-sm font-medium">Links that still work</h4><ul className="space-y-1 text-sm">{live.map((s) => <li key={s.id} className="flex items-center justify-between gap-2"><span>{s.name} · until {fmt.date(s.expiresAt)}</span><Button size="sm" variant="ghost" onClick={() => void apiSend("DELETE", `/reports/shares/${s.id}`).then(shares.reload).catch(fail)}>Turn off</Button></li>)}</ul></div>}
    </DialogContent></Dialog>
  );
}

interface Endpoint { id: string; label: string; kind: string; enabled: boolean }
interface Schedule { id: string; reportId: string; freq: string; hour: number; weekday: number | null; monthday: number | null; format: string; endpointIds: string[]; active: boolean; lastRunAt: string | null; lastStatus: string | null }

/** Send a saved report by email, Slack or Teams every day, week or month, with a record of each delivery. */
export function ScheduleDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const fmt = useFmt(); const { can } = useMe();
  const endpoints = useApi<Endpoint[]>(can("alerts.manage") || can("reports.manage") ? "/r/notification-endpoints" : null);
  const sch = useApi<Schedule[]>("/r/report-schedules");
  const [freq, setFreq] = useState("weekly"); const [hour, setHour] = useState("7"); const [weekday, setWeekday] = useState("1"); const [monthday, setMonthday] = useState("1"); const [format, setFormat] = useState("pdf"); const [to, setTo] = useState<string[]>([]);
  const mine = (sch.data ?? []).filter((s) => s.reportId === id); const dest = (endpoints.data ?? []).filter((e) => e.enabled);
  async function add() {
    try { await apiSend("POST", "/r/report-schedules", { reportId: id, freq, hour: Number(hour), format, endpointIds: to, active: true, ...(freq === "weekly" ? { weekday: Number(weekday) } : {}), ...(freq === "monthly" ? { monthday: Number(monthday) } : {}) }); toast.success("Scheduled"); sch.reload(); } catch (e) { fail(e); }
  }
  async function sendNow() {
    try { const r = await apiSend<{ results: { endpoint: string; ok: boolean; error?: string }[] }>("POST", `/reports/saved/${id}/send`, { endpointIds: to, format }); toast(r.results.map((x) => `${x.endpoint}: ${x.ok ? "sent" : x.error}`).join(" · ")); } catch (e) { fail(e); }
  }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent className="max-h-[90vh] overflow-y-auto">
      <DialogHeader><DialogTitle>Send this report on a schedule</DialogTitle><DialogDescription>Times are in your company's time zone ({fmt.timeZone}). Each delivery is recorded below, and failures are shown.</DialogDescription></DialogHeader>
      <div className="grid grid-cols-2 gap-3">
        <div><Label htmlFor="sch-freq">How often</Label><Select value={freq} onValueChange={setFreq}><SelectTrigger id="sch-freq"><SelectValue /></SelectTrigger><SelectContent>{["daily", "weekly", "monthly"].map((f) => <SelectItem key={f} value={f}>{f}</SelectItem>)}</SelectContent></Select></div>
        <div><Label htmlFor="sch-hour">At hour (0-23)</Label><Input id="sch-hour" type="number" min={0} max={23} value={hour} onChange={(e) => setHour(e.target.value)} /></div>
        {freq === "weekly" && <div><Label htmlFor="sch-wd">On</Label><Select value={weekday} onValueChange={setWeekday}><SelectTrigger id="sch-wd"><SelectValue /></SelectTrigger><SelectContent>{["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"].map((d, i) => <SelectItem key={d} value={String(i)}>{d}</SelectItem>)}</SelectContent></Select></div>}
        {freq === "monthly" && <div><Label htmlFor="sch-md">Day of month (1-28)</Label><Input id="sch-md" type="number" min={1} max={28} value={monthday} onChange={(e) => setMonthday(e.target.value)} /></div>}
        <div><Label htmlFor="sch-fmt">File</Label><Select value={format} onValueChange={setFormat}><SelectTrigger id="sch-fmt"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="pdf">PDF</SelectItem><SelectItem value="xlsx">Excel</SelectItem><SelectItem value="csv">CSV</SelectItem></SelectContent></Select></div>
      </div>
      <fieldset className="space-y-1"><legend className="mb-1 text-sm font-medium">Send to</legend>
        {dest.length === 0 ? <p className="text-sm text-muted-foreground">No places to send to are set up yet. Add an email, Slack or Teams address under Settings, then Alerts.</p> : dest.map((e) => (
          <label key={e.id} className="flex items-center gap-2 text-sm"><Checkbox checked={to.includes(e.id)} onCheckedChange={(v) => setTo(v ? [...to, e.id] : to.filter((x) => x !== e.id))} /> {e.label} <span className="text-muted-foreground">({e.kind})</span></label>))}
      </fieldset>
      <DialogFooter className="gap-2 sm:gap-2"><Button variant="outline" disabled={!to.length} onClick={() => void sendNow()}>Send now to test</Button><Button disabled={!to.length} onClick={() => void add()}>Add schedule</Button></DialogFooter>
      {mine.length > 0 && <div><h4 className="mb-1 text-sm font-medium">Schedules for this report</h4>
        <ul className="space-y-1 text-sm">{mine.map((s) => <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"><span>{s.freq}{s.freq === "weekly" ? ` on ${["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][s.weekday ?? 0]}` : s.freq === "monthly" ? ` on day ${s.monthday}` : ""} at {s.hour}:00 · {s.format.toUpperCase()}
          <span className={`block text-xs ${s.lastStatus && s.lastStatus !== "ok" ? "text-destructive" : "text-muted-foreground"}`}>{s.lastRunAt ? `Last sent ${fmt.dateTime(s.lastRunAt)}: ${s.lastStatus}` : "Not sent yet"}</span></span>
          <span className="flex gap-1"><Button size="sm" variant="ghost" onClick={() => void apiSend("PATCH", `/r/report-schedules/${s.id}`, { active: !s.active }).then(sch.reload).catch(fail)}>{s.active ? "Pause" : "Resume"}</Button><Button size="sm" variant="ghost" onClick={() => void apiSend("DELETE", `/r/report-schedules/${s.id}`).then(sch.reload).catch(fail)}>Remove</Button></span></li>)}</ul></div>}
    </DialogContent></Dialog>
  );
}

/** Every saved change to a report, with who made it, and a way back. */
export function VersionsDialog({ id, onClose, onRestored }: { id: string; onClose: () => void; onRestored: () => void }) {
  const fmt = useFmt(); const v = useApi<{ version: number; name: string; savedAt: string; savedBy: string | null; note: string | null }[]>(`/reports/saved/${id}/versions`);
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent>
      <DialogHeader><DialogTitle>Version history</DialogTitle><DialogDescription>Restoring an old version keeps the newer ones in this list.</DialogDescription></DialogHeader>
      <Async state={v}>{(list) => <ul className="space-y-1 text-sm">{list.map((x, i) => <li key={x.version} className="flex items-center justify-between gap-2"><span><strong>Version {x.version}</strong> · {fmt.dateTime(x.savedAt)}{x.note ? ` · ${x.note}` : ""}</span>{i > 0 && <Button size="sm" variant="outline" onClick={() => void apiSend("POST", `/reports/saved/${id}/restore/${x.version}`).then(() => { toast.success("Restored"); onRestored(); onClose(); }).catch(fail)}>Restore</Button>}</li>)}</ul>}</Async>
    </DialogContent></Dialog>
  );
}

/** Save a copy under the person's own name, ready to change, share and schedule. */
export function SaveDialog({ spec, name, onClose, onSaved }: { spec: unknown; name: string; onClose: () => void; onSaved: (id: string) => void }) {
  const [title, setTitle] = useState(`Copy of ${name}`.slice(0, 120)); const [shared, setShared] = useState(false); const [busy, setBusy] = useState(false);
  async function save() { setBusy(true); try { const r = await apiSend<{ id: string }>("POST", "/reports/saved", { name: title, spec, shared }); toast.success("Saved"); onSaved(r.id); } catch (e) { fail(e); } finally { setBusy(false); } }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent>
      <DialogHeader><DialogTitle>Save as my report</DialogTitle><DialogDescription>Your copy keeps the choices you made here. The ready-made report stays as it is.</DialogDescription></DialogHeader>
      <div><Label htmlFor="save-name">Name</Label><Input id="save-name" value={title} maxLength={120} onChange={(e) => setTitle(e.target.value)} /></div>
      <label className="flex items-center gap-2 text-sm"><Checkbox checked={shared} onCheckedChange={(v) => setShared(!!v)} /> Share with the team (they can open it, only you can change it)</label>
      <DialogFooter><Button disabled={busy || !title.trim()} onClick={() => void save()}>Save</Button></DialogFooter>
    </DialogContent></Dialog>
  );
}

interface Comment { id: string; body: string; author: string; createdAt: string; mentionNames: string[] }
/** Comments on a report, with @tags for teammates. */
export function Comments({ reportRef }: { reportRef: string }) {
  const fmt = useFmt(); const list = useApi<Comment[]>(`/portal/reports/comments/${reportRef}`);
  const { can } = useMe();
  const people = useApi<{ id: string; displayName?: string | null; email: string }[]>(can("users.view") ? "/users" : null);
  const [text, setText] = useState(""); const [tag, setTag] = useState<string[]>([]); const [busy, setBusy] = useState(false);
  async function send() { setBusy(true); try { await apiSend("POST", `/portal/reports/comments/${reportRef}`, { body: text, mentions: tag }); setText(""); setTag([]); list.reload(); } catch (e) { fail(e); } finally { setBusy(false); } }
  return (
    <section aria-label="Comments" className="space-y-3 rounded-lg border p-3">
      <h2 className="text-sm font-medium">Comments</h2>
      {(list.data ?? []).length === 0 ? <p className="text-sm text-muted-foreground">No comments yet. Ask a question or tag a teammate.</p> : (
        <ul className="space-y-2 text-sm">{list.data!.map((c) => <li key={c.id}><span className="font-medium">{c.author}</span> <span className="text-xs text-muted-foreground">{fmt.dateTime(c.createdAt)}</span><p>{c.body}</p>{c.mentionNames.length > 0 && <p className="text-xs text-muted-foreground">Tagged: {c.mentionNames.join(", ")}</p>}</li>)}</ul>)}
      <Textarea aria-label="Write a comment" value={text} maxLength={2000} onChange={(e) => setText(e.target.value)} placeholder="Write a comment" />
      {(people.data ?? []).length > 0 && <div className="flex flex-wrap items-center gap-2"><Label className="text-xs">Tag:</Label>
        <Select value="" onValueChange={(v) => v && !tag.includes(v) && setTag([...tag, v])}><SelectTrigger className="h-8 w-48" aria-label="Tag a teammate"><SelectValue placeholder="Add a teammate" /></SelectTrigger><SelectContent>{people.data!.map((p) => <SelectItem key={p.id} value={p.id}>{p.displayName ?? p.email}</SelectItem>)}</SelectContent></Select>
        {tag.map((id) => <Button key={id} size="sm" variant="secondary" onClick={() => setTag(tag.filter((x) => x !== id))}>{(people.data!.find((p) => p.id === id)?.displayName ?? people.data!.find((p) => p.id === id)?.email) ?? "?"} ×</Button>)}</div>}
      <Button size="sm" disabled={busy || !text.trim()} onClick={() => void send()}>Post comment</Button>
      <p className="text-xs text-muted-foreground">Tagged people are listed on the comment. They are not emailed.</p>
    </section>
  );
}
