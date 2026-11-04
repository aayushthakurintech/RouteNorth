"use client";
import { Plus, RotateCcw } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Async, EmptyState } from "@/components/portal/states";
import { PageHeader, StatusBadge } from "@/components/portal/parts";
import { apiSend } from "@/lib/api";
import { useMe } from "@/lib/me-context";
import { useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

interface Field { key: string; label: string; unit: string; min: number; max: number; step?: number; help?: string; optional?: boolean }
interface Rule { id: string; name: string; kind: string; params: Record<string, unknown>; severity: "info" | "warn" | "critical"; active: boolean; area: string; systemKey: string | null; description: string | null; recipientIds: string[]; recipients: string[]; quietStart: string | null; quietEnd: string | null; repeatMinutes: number; openCount: number; lastRaisedAt: string | null; isDefault: boolean; fields: Field[]; defaults: Record<string, unknown> | null; spec: string | null; note: string | null }
interface Person { id: string; displayName?: string | null; email: string; role?: string }
interface Measure { key: string; label: string; subject: "vehicle" | "driver" | "company"; unit: string; unitLabel: string; help: string }
interface Prefs { channels: Record<"info" | "warn" | "critical", string[]>; mutedAreas: string[]; quietStart: string | null; quietEnd: string | null; digest: boolean; phone: string | null; areas: string[]; available: Record<string, boolean>; notes: Record<string, string | null> }
interface AutoField { key: string; label: string; type: "number" | "select" | "list"; unit?: string; min?: number; max?: number; options?: { value: string; label: string }[]; help?: string }
interface Auto { key: string; spec: number; name: string; description: string; note: string | null; builtIn: boolean; fields: AutoField[]; enabled: boolean; settings: Record<string, unknown>; last: { at: string; status: string; message: string; n: number } | null; extra: { active: number; total: number } | null }

const SEV_LABEL = { info: "Info", warn: "Warning", critical: "Critical" } as const;
const AREA_LABEL: Record<string, string> = { vehicle: "Cars", driver: "Drivers", pay: "Pay", money: "Money", custom: "My own rules" };
const CHANNEL_LABEL: Record<string, string> = { inapp: "In the app", email: "Email", sms: "Text message", push: "Push", slack: "Slack", teams: "Teams" };
const sel = "h-9 rounded-md border bg-background px-2 text-sm";
const err = (e: unknown, d: string) => toast.error(e instanceof Error ? e.message : d);

export default function AlertSettings() {
  const { can } = useMe();
  return (
    <>
      <PageHeader title="Alert settings" description="The app tells you when something needs you, so you do not have to look. Change what counts, who is told, and how."
        actions={<Button asChild size="sm" variant="outline"><Link href="/owner/alerts">Open the alert inbox</Link></Button>} />
      <Tabs defaultValue={can("alerts.manage") ? "rules" : "mine"} className="space-y-4">
        <TabsList className="h-auto flex-wrap justify-start">
          {can("alerts.manage") && <TabsTrigger value="rules">Rules</TabsTrigger>}
          <TabsTrigger value="mine">How I am told</TabsTrigger>
          {can("alerts.manage") && <TabsTrigger value="auto">Automations</TabsTrigger>}
          {can("integrations.manage") && <TabsTrigger value="where">Where alerts go</TabsTrigger>}
        </TabsList>
        {can("alerts.manage") && <TabsContent value="rules"><Rules /></TabsContent>}
        <TabsContent value="mine"><Mine /></TabsContent>
        {can("alerts.manage") && <TabsContent value="auto"><Automations /></TabsContent>}
        {can("integrations.manage") && <TabsContent value="where"><Where /></TabsContent>}
      </Tabs>
    </>
  );
}

// ---- rules ---------------------------------------------------------------------------------------------------------------------
function Rules() {
  const fmt = useFmt(); const { can } = useMe();
  const rules = useApi<Rule[]>("/portal/alerts/rules");
  const people = useApi<Person[]>(can("users.view") ? "/users" : null);
  const [edit, setEdit] = useState<Rule | null>(null); const [make, setMake] = useState(false);
  async function toggle(r: Rule, active: boolean) { try { await apiSend("PUT", `/portal/alerts/rules/${r.id}`, { active }); rules.reload(); } catch (e) { err(e, "Could not change it"); } }
  return (
    <Async state={rules}>{(list) => (
      <div className="space-y-6">
        {["vehicle", "driver", "pay", "money", "custom"].map((area) => {
          const items = list.filter((r) => r.area === area);
          if (!items.length && area !== "custom") return null;
          return (
            <section key={area} aria-label={AREA_LABEL[area]}>
              <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">{AREA_LABEL[area]}</h2>
                {area === "custom" && <Button size="sm" variant="outline" onClick={() => setMake(true)}><Plus className="size-4" /> New rule</Button>}</div>
              {!items.length ? <p className="text-sm text-muted-foreground">You have not made any rules of your own. A rule reads: when a number is above or below a value, for a car, a driver or the company, tell someone.</p> : (
                <ul className="divide-y rounded-lg border">{items.map((r) => (
                  <li key={r.id} className="flex flex-wrap items-center gap-3 p-3">
                    <Switch checked={r.active} onCheckedChange={(v) => void toggle(r, v)} aria-label={`${r.active ? "Switch off" : "Switch on"} ${r.name}`} />
                    <div className="min-w-0 flex-1">
                      <p className="font-medium">{r.name} <StatusBadge tone={r.severity === "critical" ? "bad" : r.severity === "warn" ? "warn" : "info"}>{SEV_LABEL[r.severity]}</StatusBadge></p>
                      <p className="text-xs text-muted-foreground">{r.spec ? `Default: ${r.spec}. ` : ""}{r.recipients.length ? `Tells ${r.recipients.join(", ")}.` : "Tells the owners and admins."} {r.openCount ? `${r.openCount} open now.` : "Nothing open."} {r.lastRaisedAt ? `Last raised ${fmt.dateTime(r.lastRaisedAt)}.` : ""}</p>
                    </div>
                    <Button size="sm" variant="outline" onClick={() => setEdit(r)}>Edit</Button>
                  </li>))}</ul>)}
            </section>);
        })}
        {edit && <RuleDialog rule={edit} people={people.data ?? []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); rules.reload(); }} />}
        {make && <NewRuleDialog people={people.data ?? []} onClose={() => setMake(false)} onSaved={() => { setMake(false); rules.reload(); }} />}
      </div>)}</Async>
  );
}

function PeoplePicker({ people, value, onChange }: { people: Person[]; value: string[]; onChange: (v: string[]) => void }) {
  const list = people.filter((p) => p.role !== "driver");
  return (
    <fieldset className="space-y-1"><legend className="text-sm font-medium">Who is told</legend>
      <p className="text-xs text-muted-foreground">Leave all unticked to tell the owners and admins.</p>
      <div className="grid max-h-40 gap-1 overflow-y-auto sm:grid-cols-2">{list.map((p) => (
        <label key={p.id} className="flex items-center gap-2 text-sm"><Checkbox checked={value.includes(p.id)} onCheckedChange={(v) => onChange(v ? [...value, p.id] : value.filter((x) => x !== p.id))} />{p.displayName || p.email}</label>))}</div>
    </fieldset>
  );
}

function RuleDialog({ rule, people, onClose, onSaved }: { rule: Rule; people: Person[]; onClose: () => void; onSaved: () => void }) {
  const [params, setParams] = useState<Record<string, string>>(Object.fromEntries(rule.fields.map((f) => [f.key, rule.params[f.key] == null ? "" : String(rule.params[f.key])])));
  const [sev, setSev] = useState(rule.severity); const [who, setWho] = useState(rule.recipientIds);
  const [qs, setQs] = useState(rule.quietStart?.slice(0, 5) ?? ""); const [qe, setQe] = useState(rule.quietEnd?.slice(0, 5) ?? ""); const [rep, setRep] = useState(String(rule.repeatMinutes));
  const [preview, setPreview] = useState<{ count: number; matches: { title: string }[] } | null>(null); const [busy, setBusy] = useState(false);
  const body = () => ({ severity: sev, recipientIds: who, quietStart: qs || null, quietEnd: qe || null, repeatMinutes: Number(rep), ...(rule.fields.length ? { params: Object.fromEntries(rule.fields.map((f) => [f.key, params[f.key] === "" ? null : Number(params[f.key])])) } : {}) });
  async function save() { setBusy(true); try { await apiSend("PUT", `/portal/alerts/rules/${rule.id}`, body()); toast.success("Saved"); onSaved(); } catch (e) { err(e, "Could not save"); } finally { setBusy(false); } }
  async function test() {
    try { setPreview(await apiSend("POST", `/portal/alerts/rules/${rule.id}/preview`, rule.fields.length ? { params: body().params } : {})); } catch (e) { err(e, "Could not check"); }
  }
  async function sendNow() {
    try { const r = await apiSend<{ raised: number; sent: number; failed: number; open: number }>("POST", `/portal/alerts/rules/${rule.id}/run`); toast.success(`Checked now: ${r.open} open, ${r.sent} message${r.sent === 1 ? "" : "s"} sent${r.failed ? `, ${r.failed} failed` : ""}`); } catch (e) { err(e, "Could not check"); }
  }
  async function reset() { try { await apiSend("POST", `/portal/alerts/rules/${rule.id}/reset`); toast.success("Back to the default"); onSaved(); } catch (e) { err(e, "Could not reset"); } }
  async function archive() { try { await apiSend("DELETE", `/portal/alerts/rules/${rule.id}`); toast.success("Rule removed"); onSaved(); } catch (e) { err(e, "Could not remove it"); } }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>{rule.name}</DialogTitle><DialogDescription>{rule.description}</DialogDescription></DialogHeader>
      {rule.note && <p className="rounded-md border bg-muted/40 p-2 text-xs">{rule.note}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        {rule.fields.map((f) => (
          <div key={f.key} className="space-y-1"><label htmlFor={`f-${f.key}`} className="text-sm font-medium">{f.label}</label>
            <div className="flex items-center gap-2"><Input id={`f-${f.key}`} inputMode="decimal" value={params[f.key] ?? ""} placeholder={f.optional ? "Default" : undefined} onChange={(e) => setParams({ ...params, [f.key]: e.target.value })} /><span className="text-xs text-muted-foreground">{f.unit}</span></div>
            {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}</div>))}
        <div className="space-y-1"><label htmlFor="r-sev" className="text-sm font-medium">How serious</label>
          <select id="r-sev" className={`${sel} w-full`} value={sev} onChange={(e) => setSev(e.target.value as Rule["severity"])}><option value="info">Info</option><option value="warn">Warning</option><option value="critical">Critical</option></select>
          <p className="text-xs text-muted-foreground">Critical alerts ignore quiet hours and are sent again until someone acts.</p></div>
        {sev === "critical" || rule.severity === "critical" || rule.kind.startsWith("vehicle_docs") || rule.kind === "driver_docs" || rule.kind === "payout_waiting" ? (
          <div className="space-y-1"><label htmlFor="r-rep" className="text-sm font-medium">Send a Critical one again every</label><div className="flex items-center gap-2"><Input id="r-rep" inputMode="numeric" value={rep} onChange={(e) => setRep(e.target.value)} /><span className="text-xs text-muted-foreground">minutes</span></div></div>) : null}
        <div className="space-y-1"><label htmlFor="r-qs" className="text-sm font-medium">Quiet hours for this rule</label>
          <div className="flex items-center gap-2"><Input id="r-qs" type="time" value={qs} onChange={(e) => setQs(e.target.value)} aria-label="Quiet from" /><span>to</span><Input type="time" value={qe} onChange={(e) => setQe(e.target.value)} aria-label="Quiet until" /></div></div>
      </div>
      <PeoplePicker people={people} value={who} onChange={setWho} />
      {preview && <div role="status" className="rounded-md border p-2 text-sm"><p className="font-medium">{preview.count === 0 ? "Nothing matches right now." : `${preview.count} match${preview.count === 1 ? "es" : ""} right now:`}</p><ul className="ml-4 list-disc">{preview.matches.slice(0, 5).map((m, i) => <li key={i}>{m.title}</li>)}</ul></div>}
      <DialogFooter className="flex-wrap gap-2 sm:justify-between">
        <span className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void test()}>What matches now?</Button><Button variant="outline" onClick={() => void sendNow()}>Check and send now</Button>
          {rule.isDefault ? <Button variant="ghost" onClick={() => void reset()}><RotateCcw className="size-4" /> Back to default</Button> : <Button variant="ghost" onClick={() => void archive()}>Remove rule</Button>}</span>
        <span className="flex gap-2"><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={busy} onClick={() => void save()}>Save</Button></span>
      </DialogFooter>
    </DialogContent></Dialog>
  );
}

function NewRuleDialog({ people, onClose, onSaved }: { people: Person[]; onClose: () => void; onSaved: () => void }) {
  const measures = useApi<Measure[]>("/portal/alerts/measures");
  const cars = useApi<{ id: string; name: string }[]>("/portal/vehicles");
  const drivers = useApi<{ id: string; name: string }[]>("/portal/drivers");
  const [measure, setMeasure] = useState(""); const [op, setOp] = useState<"gt" | "lt">("gt"); const [value, setValue] = useState(""); const [scope, setScope] = useState(""); const [sev, setSev] = useState("warn"); const [who, setWho] = useState<string[]>([]);
  const m = measures.data?.find((x) => x.key === measure);
  const [preview, setPreview] = useState<string | null>(null);
  const body = () => ({ measure, op, value, scopeId: scope || undefined, severity: sev, recipientIds: who });
  async function check() { try { const r = await apiSend<{ count: number }>("POST", "/portal/alerts/rules/new/preview", body()); setPreview(r.count ? `This would alert for ${r.count} right now.` : "Nothing would alert right now."); } catch (e) { err(e, "Check the rule"); } }
  async function save() { try { await apiSend("POST", "/portal/alerts/rules", body()); toast.success("Rule added"); onSaved(); } catch (e) { err(e, "Could not add the rule"); } }
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-xl">
      <DialogHeader><DialogTitle>New rule</DialogTitle><DialogDescription>When [a number] is above or below [a value], for [a car, a driver or the company], tell [people].</DialogDescription></DialogHeader>
      <div className="space-y-3">
        <div className="space-y-1"><label className="text-sm font-medium" htmlFor="n-measure">When this number</label>
          <select id="n-measure" className={`${sel} w-full`} value={measure} onChange={(e) => { setMeasure(e.target.value); setScope(""); setPreview(null); }}><option value="">Choose a number</option>
            {(["vehicle", "driver", "company"] as const).map((s) => <optgroup key={s} label={s === "vehicle" ? "For a car" : s === "driver" ? "For a driver" : "For the company"}>{measures.data?.filter((x) => x.subject === s).map((x) => <option key={x.key} value={x.key}>{x.label}</option>)}</optgroup>)}</select>
          {m && <p className="text-xs text-muted-foreground">{m.help}</p>}</div>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1"><label className="text-sm font-medium" htmlFor="n-op">Is</label><select id="n-op" className={`${sel} w-full`} value={op} onChange={(e) => setOp(e.target.value as "gt" | "lt")}><option value="gt">above</option><option value="lt">below</option></select></div>
          <div className="space-y-1"><label className="text-sm font-medium" htmlFor="n-value">This value {m?.unitLabel ? `(${m.unitLabel})` : ""}</label><Input id="n-value" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></div>
        </div>
        {m && m.subject !== "company" && (
          <div className="space-y-1"><label className="text-sm font-medium" htmlFor="n-scope">For</label>
            <select id="n-scope" className={`${sel} w-full`} value={scope} onChange={(e) => setScope(e.target.value)}><option value="">{m.subject === "vehicle" ? "Every car" : "Every driver"}</option>
              {(m.subject === "vehicle" ? cars.data : drivers.data)?.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select></div>)}
        <div className="space-y-1"><label className="text-sm font-medium" htmlFor="n-sev">How serious</label><select id="n-sev" className={`${sel} w-full`} value={sev} onChange={(e) => setSev(e.target.value)}><option value="info">Info</option><option value="warn">Warning</option><option value="critical">Critical</option></select></div>
        <PeoplePicker people={people} value={who} onChange={setWho} />
        {preview && <p role="status" className="rounded-md border p-2 text-sm">{preview}</p>}
      </div>
      <DialogFooter><Button variant="outline" disabled={!measure || value === ""} onClick={() => void check()}>What would match now?</Button><Button variant="outline" onClick={onClose}>Cancel</Button><Button disabled={!measure || value === ""} onClick={() => void save()}>Add rule</Button></DialogFooter>
    </DialogContent></Dialog>
  );
}

// ---- my own choices --------------------------------------------------------------------------------------------------------------
function Mine() {
  const prefs = useApi<Prefs>("/portal/alerts/prefs");
  return <Async state={prefs}>{(p) => <MineForm p={p} reload={prefs.reload} />}</Async>;
}
function MineForm({ p, reload }: { p: Prefs; reload: () => void }) {
  const [ch, setCh] = useState(p.channels); const [muted, setMuted] = useState(p.mutedAreas); const [qs, setQs] = useState(p.quietStart ?? ""); const [qe, setQe] = useState(p.quietEnd ?? "");
  const [digest, setDigest] = useState(p.digest); const [phone, setPhone] = useState(p.phone ?? ""); const [busy, setBusy] = useState(false);
  const toggle = (sev: "info" | "warn" | "critical", c: string, on: boolean) => setCh({ ...ch, [sev]: on ? [...ch[sev], c] : ch[sev].filter((x) => x !== c) });
  async function save() {
    setBusy(true);
    try { await apiSend("PUT", "/portal/alerts/prefs", { channels: ch, mutedAreas: muted, quietStart: qs || null, quietEnd: qe || null, digest, phone: phone || null }); toast.success("Saved"); reload(); } catch (e) { err(e, "Could not save"); } finally { setBusy(false); }
  }
  async function digestNow() { try { toast.info((await apiSend<{ message: string }>("POST", "/portal/alerts/digest/me")).message); } catch (e) { err(e, "Could not send it"); } }
  return (
    <Card>
      <CardHeader><CardTitle>How I am told</CardTitle><CardDescription>Pick, for each kind of alert, where it reaches you. Alerts always appear in the app. Critical alerts ignore quiet hours and muted areas.</CardDescription></CardHeader>
      <CardContent className="space-y-6">
        <div className="overflow-x-auto"><table className="w-full text-sm">
          <thead><tr><th scope="col" className="pb-2 text-left font-medium">Alert</th>{(["inapp", "email", "sms", "push", "slack", "teams"] as const).map((c) => <th key={c} scope="col" className="pb-2 text-center font-medium">{CHANNEL_LABEL[c]}</th>)}</tr></thead>
          <tbody>{(["critical", "warn", "info"] as const).map((sev) => (
            <tr key={sev} className="border-t"><th scope="row" className="py-2 text-left font-medium">{SEV_LABEL[sev]}</th>
              {(["inapp", "email", "sms", "push", "slack", "teams"] as const).map((c) => (
                <td key={c} className="py-2 text-center"><Checkbox checked={ch[sev].includes(c) || c === "inapp"} disabled={c === "inapp" || !p.available[c]} onCheckedChange={(v) => toggle(sev, c, v === true)} aria-label={`${SEV_LABEL[sev]} alerts by ${CHANNEL_LABEL[c]}`} /></td>))}</tr>))}</tbody></table></div>
        <ul className="space-y-1 text-xs text-muted-foreground">{Object.entries(p.notes).filter(([, v]) => v).map(([k, v]) => <li key={k}><Badge variant="outline" className="mr-1">{CHANNEL_LABEL[k]}</Badge>{v}</li>)}</ul>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1"><label htmlFor="p-phone" className="text-sm font-medium">My mobile number (for text messages)</label><Input id="p-phone" inputMode="tel" placeholder="+14165550123" value={phone} onChange={(e) => setPhone(e.target.value)} /></div>
          <div className="space-y-1"><span className="text-sm font-medium">Quiet hours</span>
            <div className="flex items-center gap-2"><Input type="time" aria-label="Quiet from" value={qs} onChange={(e) => setQs(e.target.value)} /><span>to</span><Input type="time" aria-label="Quiet until" value={qe} onChange={(e) => setQe(e.target.value)} /></div></div>
        </div>
        <fieldset className="space-y-1"><legend className="text-sm font-medium">Do not message me about</legend>
          <div className="flex flex-wrap gap-4">{p.areas.filter((a) => a !== "live").map((a) => <label key={a} className="flex items-center gap-2 text-sm"><Checkbox checked={muted.includes(a)} onCheckedChange={(v) => setMuted(v ? [...muted, a] : muted.filter((x) => x !== a))} />{AREA_LABEL[a] ?? a}</label>)}</div></fieldset>
        <div className="flex items-center gap-3"><Switch id="p-digest" checked={digest} onCheckedChange={setDigest} /><label htmlFor="p-digest" className="text-sm">Email me “Here is what needs you today” every morning at 7</label><Button size="sm" variant="outline" onClick={() => void digestNow()}>Send it to me now</Button></div>
        <Button disabled={busy} onClick={() => void save()}>Save</Button>
      </CardContent>
    </Card>
  );
}

// ---- automations -----------------------------------------------------------------------------------------------------------------
function Automations() {
  const fmt = useFmt();
  const autos = useApi<Auto[]>("/portal/alerts/automations");
  const runs = useApi<{ id: string; automation: string; status: string; message: string; at: string }[]>("/portal/alerts/automations/runs");
  return (
    <div className="space-y-4">
      <Async state={autos}>{(list) => <div className="grid gap-3 lg:grid-cols-2">{list.map((a) => <AutoCard key={a.key} a={a} reload={() => { autos.reload(); runs.reload(); }} />)}</div>}</Async>
      <Card><CardHeader><CardTitle className="text-base">What the automations did</CardTitle><CardDescription>The latest 100 things, newest first.</CardDescription></CardHeader>
        <CardContent>{runs.data?.length ? (
          <ul className="divide-y text-sm">{runs.data.slice(0, 30).map((r) => <li key={r.id} className="flex flex-wrap items-center gap-2 py-1.5"><StatusBadge tone={r.status === "ok" ? "good" : r.status === "failed" ? "bad" : "neutral"}>{r.status}</StatusBadge><span className="min-w-0 flex-1">{r.message}</span><span className="text-xs text-muted-foreground">{fmt.dateTime(r.at)}</span></li>)}</ul>
        ) : <EmptyState title="Nothing yet">When an automation does something, it is listed here.</EmptyState>}</CardContent></Card>
    </div>
  );
}

function AutoCard({ a, reload }: { a: Auto; reload: () => void }) {
  const fmt = useFmt();
  const [vals, setVals] = useState<Record<string, string>>(Object.fromEntries(a.fields.map((f) => [f.key, Array.isArray(a.settings[f.key]) ? (a.settings[f.key] as number[]).join(", ") : String(a.settings[f.key] ?? "")])));
  const [dirty, setDirty] = useState(false); const [out, setOut] = useState<string | null>(null);
  async function put(body: unknown, ok: string) { try { await apiSend("PUT", `/portal/alerts/automations/${a.key}`, body); toast.success(ok); setDirty(false); reload(); } catch (e) { err(e, "Could not save"); } }
  async function run() {
    try { const r = await apiSend<{ results: { status: string; message: string }[] }>("POST", `/portal/alerts/automations/${a.key}/run`); setOut(r.results.length ? r.results.map((x) => x.message).join(" · ") : "Nothing to do right now."); reload(); } catch (e) { err(e, "Could not run it"); }
  }
  return (
    <Card>
      <CardHeader className="pb-2"><div className="flex items-start gap-3">
        {a.builtIn ? <Badge variant="secondary">Always on</Badge> : <Switch checked={a.enabled} onCheckedChange={(v) => void put({ enabled: v }, v ? "Switched on" : "Switched off")} aria-label={`${a.enabled ? "Switch off" : "Switch on"}: ${a.name}`} />}
        <div><CardTitle className="text-base">{a.spec}. {a.name}</CardTitle><CardDescription>{a.description}</CardDescription></div></div></CardHeader>
      <CardContent className="space-y-3 text-sm">
        {a.note && <p className="rounded-md border bg-muted/40 p-2 text-xs">{a.note}</p>}
        {a.key === "webhooks" && a.extra && <p>{a.extra.active} of {a.extra.total} webhook{a.extra.total === 1 ? "" : "s"} switched on. Manage them under “Where alerts go”.</p>}
        {a.fields.length > 0 && <div className="grid gap-3 sm:grid-cols-2">{a.fields.map((f) => (
          <div key={f.key} className="space-y-1"><label className="text-xs font-medium" htmlFor={`${a.key}-${f.key}`}>{f.label}</label>
            {f.type === "select" ? <select id={`${a.key}-${f.key}`} className={`${sel} w-full`} value={vals[f.key]} onChange={(e) => { setVals({ ...vals, [f.key]: e.target.value }); setDirty(true); }}>{f.options!.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
              : <div className="flex items-center gap-2"><Input id={`${a.key}-${f.key}`} value={vals[f.key]} onChange={(e) => { setVals({ ...vals, [f.key]: e.target.value }); setDirty(true); }} /><span className="text-xs text-muted-foreground">{f.unit}</span></div>}
            {f.help && <p className="text-xs text-muted-foreground">{f.help}</p>}</div>))}</div>}
        <div className="flex flex-wrap items-center gap-2">
          {dirty && <Button size="sm" onClick={() => void put({ settings: vals }, "Saved")}>Save settings</Button>}
          {!a.builtIn && a.enabled && <Button size="sm" variant="outline" onClick={() => void run()}>Run now</Button>}
          {a.key === "block_on_expiry" && <Button asChild size="sm" variant="outline"><Link href="/owner/drivers?view=blocked">See who is blocked</Link></Button>}
        </div>
        {out && <p role="status" className="text-xs text-muted-foreground">{out}</p>}
        {a.last && <p className="text-xs text-muted-foreground">Last: {a.last.message} ({fmt.dateTime(a.last.at)})</p>}
      </CardContent>
    </Card>
  );
}

// ---- destinations and webhooks -------------------------------------------------------------------------------------------------------
interface Dest { id: string; kind: string; label: string; target: string; enabled: boolean }
interface Hook { id: string; label: string; url: string; events: string[]; active: boolean; failedLastWeek: number; lastDeliveredAt: string | null }
function Where() {
  const fmt = useFmt();
  const dests = useApi<Dest[]>("/r/notification-endpoints");
  const hooks = useApi<Hook[]>("/webhooks");
  const events = useApi<string[]>("/webhooks/events");
  const [kind, setKind] = useState("slack"); const [label, setLabel] = useState(""); const [target, setTarget] = useState("");
  const [hl, setHl] = useState(""); const [url, setUrl] = useState(""); const [picked, setPicked] = useState<string[]>(["alert.raised"]); const [secret, setSecret] = useState<string | null>(null);
  async function addDest() { try { await apiSend("POST", "/r/notification-endpoints", { kind, label, target, enabled: true }); setLabel(""); setTarget(""); toast.success("Added"); dests.reload(); } catch (e) { err(e, "Could not add it"); } }
  async function test(id: string) { try { const r = await apiSend<{ ok: boolean; error?: string }>("POST", `/alerts/endpoints/${id}/test`); if (r.ok) toast.success("Test message sent"); else toast.error(r.error ?? "The test did not arrive"); } catch (e) { err(e, "Could not test it"); } }
  async function addHook() { try { const r = await apiSend<{ secret: string }>("POST", "/webhooks", { label: hl, url, events: picked }); setSecret(r.secret); setHl(""); setUrl(""); hooks.reload(); } catch (e) { err(e, "Could not add the webhook"); } }
  async function flip(h: Hook) { try { await apiSend("PATCH", `/webhooks/${h.id}`, { active: !h.active }); hooks.reload(); } catch (e) { err(e, "Could not change it"); } }
  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card><CardHeader><CardTitle className="text-base">Slack, Teams and email addresses</CardTitle><CardDescription>Shared places alerts can go. People choose them under “How I am told”. Texts and push need outside accounts.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <Async state={dests}>{(list) => list.length ? <ul className="divide-y text-sm">{list.map((d) => <li key={d.id} className="flex items-center gap-2 py-1.5"><Badge variant="outline">{d.kind}</Badge><span className="min-w-0 flex-1 truncate">{d.label}</span><Button size="sm" variant="outline" onClick={() => void test(d.id)}>Send a test</Button></li>)}</ul> : <p className="text-sm text-muted-foreground">Nothing added yet.</p>}</Async>
          <div className="grid gap-2 sm:grid-cols-[8rem_1fr]"><select aria-label="Kind" className={sel} value={kind} onChange={(e) => setKind(e.target.value)}><option value="slack">Slack</option><option value="teams">Teams</option><option value="email">Email</option><option value="sms">SMS</option></select><Input aria-label="Name" placeholder="Name, such as Ops channel" value={label} onChange={(e) => setLabel(e.target.value)} /></div>
          <Input aria-label="Address" placeholder={kind === "slack" ? "https://hooks.slack.com/services/…" : kind === "email" ? "ops@yourcompany.ca" : kind === "sms" ? "+14165550123" : "Teams webhook address"} value={target} onChange={(e) => setTarget(e.target.value)} />
          <Button size="sm" disabled={!label || !target} onClick={() => void addDest()}>Add</Button>
        </CardContent></Card>
      <Card><CardHeader><CardTitle className="text-base">Webhooks</CardTitle><CardDescription>Call another tool's web address when something happens. Every call is signed and retried if it fails.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <Async state={hooks}>{(list) => list.length ? <ul className="divide-y text-sm">{list.map((h) => <li key={h.id} className="flex flex-wrap items-center gap-2 py-1.5"><Switch checked={h.active} onCheckedChange={() => void flip(h)} aria-label={`${h.active ? "Switch off" : "Switch on"} ${h.label}`} /><span className="min-w-0 flex-1"><span className="font-medium">{h.label}</span><span className="block truncate text-xs text-muted-foreground">{h.url} · {h.events.length ? `${h.events.length} events` : "all events"}{h.failedLastWeek ? ` · ${h.failedLastWeek} failed this week` : ""}{h.lastDeliveredAt ? ` · last ok ${fmt.dateTime(h.lastDeliveredAt)}` : ""}</span></span></li>)}</ul> : <p className="text-sm text-muted-foreground">No webhooks yet.</p>}</Async>
          <Input aria-label="Webhook name" placeholder="Name" value={hl} onChange={(e) => setHl(e.target.value)} />
          <Input aria-label="Webhook address" placeholder="https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
          <fieldset><legend className="mb-1 text-xs font-medium">Call it when</legend><div className="grid max-h-36 gap-1 overflow-y-auto sm:grid-cols-2">{(events.data ?? []).map((e) => <label key={e} className="flex items-center gap-2 text-xs"><Checkbox checked={picked.includes(e)} onCheckedChange={(v) => setPicked(v ? [...picked, e] : picked.filter((x) => x !== e))} />{e}</label>)}</div></fieldset>
          <Button size="sm" disabled={!hl || !url} onClick={() => void addHook()}>Add webhook</Button>
          {secret && <p role="status" className="rounded-md border p-2 text-xs">Signing secret (shown once, copy it now): <code className="break-all">{secret}</code></p>}
        </CardContent></Card>
    </div>
  );
}
