"use client";
import { AlertTriangle, Archive, ArchiveRestore, Camera, CheckCircle2, Pencil, Tag } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { ChildSection, type Rec } from "@/components/portal/child-section";
import { DataTable, type Col } from "@/components/portal/data-table";
import { RecordDialog, type FieldSpec } from "@/components/portal/field-form";
import { PageHeader, StatCard, StatusBadge, ConfirmDialog } from "@/components/portal/parts";
import { Async } from "@/components/portal/states";
import { apiSend } from "@/lib/api";
import { useBreadcrumbs } from "@/lib/breadcrumbs";
import { useMe } from "@/lib/me-context";
import { useFmt, type Fmt } from "@/lib/portal/format";
import { STATUS_LABEL, STATUS_TONE, VEHICLE_FORM } from "@/lib/portal/vehicle-fields";
import { loadSession, API_URL } from "@/lib/session";
import { useApi } from "@/lib/use-api";

interface Vehicle extends Record<string, unknown> {
  id: string; name: string; status: string; storedStatus: string; plate: string | null; vin: string | null; kind: string; make: string | null; model: string | null; year: number | null; odometerKm: number;
  currentDriverName: string | null; currentDriverId: string | null; archivedAt: string | null; hasPhoto: boolean; blockedReasons: string[]; canSeeCosts: boolean;
  service: { state: string; nextDate: string | null; nextKm: number | null; daysLeft: number | null; kmLeft: number | null; task: string | null };
  docs: { expired: number; expiring: number; nextExpiry: string | null }; counts: { documents: number; maintenance: number; openWorkOrders: number; trips: number };
  lastEvents: { at: string; action: string; label: string | null; actor: string | null }[]; lastActivity: string | null; lastSeen: string | null; deviceId: string | null;
}

const SERVICE_TONE = { ok: "good", due_soon: "warn", overdue: "bad", none: "neutral" } as const;
const SERVICE_LABEL = { ok: "On schedule", due_soon: "Due soon", overdue: "Overdue", none: "No plan set" } as const;
const sel = (xs: string[]) => xs.map((x) => ({ value: x, label: x.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) }));
const col = (id: string, header: string, cell: (r: Rec) => React.ReactNode, o: { csv?: (r: Rec) => string | number | null | undefined; end?: boolean; num?: boolean } = {}): Col<Rec> => ({
  id, accessorFn: (r) => r[id] as unknown, header, cell: ({ row }) => cell(row.original) ?? "—",
  meta: { label: header, csv: o.csv ?? ((r) => (r[id] == null ? "" : String(r[id]))), align: o.end ? "end" : undefined, xtype: o.num ? "num" : undefined },
});
const dollars = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));

/** One car: summary on top, then a tab for each part of its life. */
export default function VehicleProfile() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const fmt = useFmt();
  const { can } = useMe();
  const api = useApi<Vehicle>(`/portal/vehicles/${id}`);
  const v = api.data;
  useBreadcrumbs([{ label: "Vehicles", href: "/owner/vehicles" }, { label: v?.name ?? "Car" }]);
  const [editing, setEditing] = useState(false);
  const [sell, setSell] = useState(false);
  const [confirmArchive, setConfirmArchive] = useState(false);
  const write = can("vehicles.manage");
  const costs = can("vehicles.costs");
  const base = `/portal/vehicles/${id}`;

  async function archive() {
    try { await apiSend("POST", `${base}/${v?.archivedAt ? "restore" : "archive"}`); toast.success(v?.archivedAt ? "Restored" : "Archived. You can restore it from the list with Show archived."); api.reload(); if (!v?.archivedAt) router.push("/owner/vehicles"); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }

  return (
    <Async state={api}>
      {() => v && (
        <>
          <PageHeader
            title={<span className="flex flex-wrap items-center gap-2">{v.name}<StatusBadge tone={STATUS_TONE[v.status] ?? "neutral"}>{STATUS_LABEL[v.status] ?? v.status}</StatusBadge></span>}
            description={[v.year, v.make, v.model].filter(Boolean).join(" ") + (v.plate ? ` · ${v.plate}` : "") || v.kind}
            actions={write && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(true)} disabled={!!v.archivedAt}><Pencil className="size-4" /> Edit</Button>
                {v.status !== "sold" && <Button size="sm" variant="outline" onClick={() => setSell(true)}><Tag className="size-4" /> Mark as sold</Button>}
                <Button size="sm" variant="outline" onClick={() => (v.archivedAt ? void archive() : setConfirmArchive(true))}>{v.archivedAt ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />} {v.archivedAt ? "Restore" : "Archive"}</Button>
              </div>
            )} />

          {v.blockedReasons.length > 0 && (
            <div className="mb-4 flex gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm" role="alert">
              <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" />
              <div><strong>This car cannot take new jobs or routes.</strong><ul className="list-disc pl-5">{v.blockedReasons.map((r) => <li key={r}>{r}</li>)}</ul></div>
            </div>
          )}

          <Tabs defaultValue="overview" className="space-y-4">
            <TabsList className="h-auto flex-wrap justify-start">
              {([["overview", "Overview"], ["papers", "Papers"], ["service", "Service"], ["fuel", "Fuel"], ["checks", "Inspections"], ["incidents", "Incidents"], ["drivers", "Drivers"], ...(costs ? [["money", "Money"]] : []), ["trips", "Trips"], ["live", "Tracking"], ["activity", "Activity"]] as [string, string][]).map(([k, l]) => <TabsTrigger key={k} value={k}>{l}</TabsTrigger>)}
            </TabsList>

            <TabsContent value="overview" className="space-y-4"><Overview v={v} fmt={fmt} write={write} base={base} reload={api.reload} /></TabsContent>

            <TabsContent value="papers" className="space-y-8">
              <ChildSection id={`veh-docs-${id}`} title="Documents" base={base} name="documents" canWrite={write || can("fleet.manage")} onChange={api.reload} addLabel="Add document"
                fields={[{ key: "kind", label: "Kind", required: true, placeholder: "Insurance, Registration, Safety inspection ..." }, { key: "number", label: "Number" }, { key: "issuedOn", label: "Issued", type: "date" }, { key: "expiresOn", label: "Expires", type: "date" }, { key: "remindDays", label: "Remind me (days before)", type: "number", step: "1" }, { key: "notes", label: "Notes", type: "textarea" }]}
                columns={[col("kind", "Kind", (r) => String(r.kind)), col("number", "Number", (r) => r.number as string), col("issuedOn", "Issued", (r) => fmt.date(r.issuedOn as string)), col("expiresOn", "Expires", (r) => <ExpiryBadge date={r.expiresOn as string | null} fmt={fmt} />)]}
                empty={{ title: "No documents yet", description: "Add insurance, registration and inspection papers. An expired legal paper blocks the car from new jobs." }} />
              <ChildSection id={`veh-war-${id}`} title="Warranties and recalls" base={base} name="warranties" canWrite={write || can("fleet.manage")} addLabel="Add warranty or recall"
                fields={[{ key: "kind", label: "Kind", type: "select", required: true, options: sel(["warranty", "recall"]) }, { key: "title", label: "Title", required: true }, { key: "provider", label: "Provider" }, { key: "startsOn", label: "Starts", type: "date" }, { key: "expiresOn", label: "Expires", type: "date" }, { key: "kmLimit", label: "Km limit", type: "number", step: "1" }, { key: "status", label: "Status", type: "select", options: sel(["open", "done"]) }, { key: "notes", label: "Notes", type: "textarea" }]}
                columns={[col("kind", "Kind", (r) => String(r.kind)), col("title", "Title", (r) => String(r.title)), col("expiresOn", "Expires", (r) => fmt.date(r.expiresOn as string)), col("status", "Status", (r) => String(r.status ?? ""))]}
                empty={{ title: "No warranties or recalls", description: "Track what is still covered and any recall that needs a visit." }} />
            </TabsContent>

            <TabsContent value="service" className="space-y-8">
              <ChildSection id={`veh-plans-${id}`} title="Service plans" base={base} name="plans" canWrite={write || can("fleet.manage")} addLabel="Add plan" onChange={api.reload}
                fields={[{ key: "task", label: "Task", required: true }, { key: "everyDays", label: "Every (days)", type: "number", step: "1" }, { key: "everyKm", label: "Every (km)", type: "number", step: "1" }, { key: "lastDoneOn", label: "Last done", type: "date" }, { key: "lastDoneKm", label: "Last done at (km)", type: "number" }, { key: "notes", label: "Notes", type: "textarea" }]}
                columns={[col("task", "Task", (r) => String(r.task)), col("everyDays", "Every", (r) => [r.everyDays && `${r.everyDays} days`, r.everyKm && `${fmt.num(Number(r.everyKm))} km`].filter(Boolean).join(" or ")), col("lastDoneOn", "Last done", (r) => fmt.date(r.lastDoneOn as string))]}
                empty={{ title: "No service plans", description: "Add an oil change, tire rotation or brake check and the car shows when each is due." }}
                extra={write ? <TemplateButtons base={base} onDone={api.reload} /> : undefined} />
              <ChildSection id={`veh-maint-${id}`} title="Maintenance history" base={base} name="maintenance" canWrite={write || can("fleet.manage")} addLabel="Log maintenance" onChange={api.reload}
                fields={[{ key: "task", label: "What was done", required: true }, { key: "kind", label: "Kind", type: "select", options: sel(["service", "repair", "inspection", "tires", "other"]) }, { key: "doneOn", label: "Date", type: "date", required: true }, { key: "odometerKm", label: "Odometer (km)", type: "number" }, { key: "vendor", label: "Shop" }, { key: "labourCents", label: "Labour", type: "money" }, { key: "partsCents", label: "Parts", type: "money" }, { key: "partsNote", label: "Parts used" }, { key: "nextDueOn", label: "Next due on", type: "date" }, { key: "nextDueKm", label: "Next due at (km)", type: "number" }, { key: "notes", label: "Notes", type: "textarea" }]}
                columns={[col("doneOn", "Date", (r) => fmt.date(r.doneOn as string)), col("task", "Task", (r) => String(r.task)), col("kind", "Kind", (r) => String(r.kind ?? "")), col("vendor", "Shop", (r) => r.vendor as string), col("totalCents", "Cost", (r) => fmt.money(r.totalCents as number | null), { end: true, num: true, csv: (r) => dollars(r.totalCents as number | null) })]}
                empty={{ title: "No maintenance logged", description: "Every service and repair adds to the car's cost per kilometre." }} />
              <WorkOrders base={base} fmt={fmt} write={write || can("fleet.manage")} onChange={api.reload} />
              <ChildSection id={`veh-parts-${id}`} title="Parts" base={base} name="parts" canWrite={write || can("fleet.manage")} addLabel="Add part"
                fields={[{ key: "name", label: "Part", required: true }, { key: "partNumber", label: "Part number" }, { key: "quantity", label: "Quantity", type: "number" }, { key: "installedOn", label: "Installed", type: "date" }, { key: "costCents", label: "Cost", type: "money" }, { key: "supplier", label: "Supplier" }, { key: "notes", label: "Notes", type: "textarea" }]}
                columns={[col("name", "Part", (r) => String(r.name)), col("partNumber", "Number", (r) => r.partNumber as string), col("quantity", "Qty", (r) => String(r.quantity ?? "")), col("installedOn", "Installed", (r) => fmt.date(r.installedOn as string)), col("costCents", "Cost", (r) => fmt.money(r.costCents as number | null), { end: true, num: true, csv: (r) => dollars(r.costCents as number | null) })]}
                empty={{ title: "No parts recorded", description: "Keep track of tires, batteries and other parts fitted to this car." }} />
            </TabsContent>

            <TabsContent value="fuel">
              <ChildSection id={`veh-fuel-${id}`} title="Fuel and charging" base={base} name="fuel" canWrite={write || can("fleet.manage")} addLabel="Log fill-up" onChange={api.reload}
                fields={[{ key: "filledOn", label: "Date", type: "date", required: true }, { key: "litres", label: "Litres or kWh", type: "number", required: true }, { key: "unit", label: "Unit", type: "select", options: [{ value: "L", label: "Litres" }, { value: "kWh", label: "kWh" }] }, { key: "costCents", label: "Total cost", type: "money" }, { key: "odometerKm", label: "Odometer (km)", type: "number" }, { key: "station", label: "Station" }]}
                columns={[col("filledOn", "Date", (r) => fmt.date(r.filledOn as string)), col("litres", "Amount", (r) => `${fmt.num(Number(r.litres), 1)} ${r.unit ?? "L"}`, { end: true }), col("costCents", "Cost", (r) => fmt.money(r.costCents as number | null), { end: true, num: true, csv: (r) => dollars(r.costCents as number | null) }), col("odometerKm", "Odometer", (r) => (r.odometerKm == null ? "—" : `${fmt.num(Number(r.odometerKm))} km`)), col("station", "Station", (r) => r.station as string)]}
                empty={{ title: "No fuel logged", description: "Log fill-ups to see cost per kilometre and fuel use." }} />
            </TabsContent>

            <TabsContent value="checks" className="space-y-4">
              <Inspections base={base} fmt={fmt} write={write || can("fleet.manage")} onChange={api.reload} />
            </TabsContent>

            <TabsContent value="incidents">
              <ChildSection id={`veh-inc-${id}`} title="Incidents, claims and tickets" base={base} name="incidents" canWrite={write || can("fleet.manage")} addLabel="Report incident"
                fields={[{ key: "occurredAt", label: "When", type: "datetime" }, { key: "kind", label: "Kind", type: "select", required: true, options: sel(["accident", "near_miss", "theft", "damage", "breakdown", "other"]) }, { key: "severity", label: "How bad", type: "select", options: sel(["minor", "moderate", "major"]) }, { key: "description", label: "What happened", type: "textarea", required: true }, { key: "location", label: "Where" }, { key: "injuries", label: "Anyone hurt", type: "checkbox" }, { key: "policeReport", label: "Police report number" }, { key: "status", label: "Status", type: "select", options: sel(["open", "investigating", "closed"]) }, { key: "claimNumber", label: "Insurance claim number" }, { key: "claimStatus", label: "Claim status", type: "select", options: sel(["none", "filed", "approved", "denied", "paid"]) }, { key: "ticket", label: "This is a ticket or fine", type: "checkbox" }, { key: "fineCents", label: "Fine", type: "money" }, { key: "repairCostCents", label: "Repair estimate", type: "money", help: "An estimate only. Log the real repair under Service so it counts in the totals." }]}
                columns={[col("occurredAt", "When", (r) => fmt.dateTime(r.occurredAt as string)), col("kind", "Kind", (r) => String(r.kind).replace(/_/g, " ")), col("severity", "Severity", (r) => String(r.severity ?? "")), col("description", "What happened", (r) => <span className="line-clamp-2 max-w-md">{String(r.description)}</span>), col("status", "Status", (r) => String(r.status ?? ""))]}
                empty={{ title: "No incidents", description: "Record accidents, damage, tickets and insurance claims here." }} />
            </TabsContent>

            <TabsContent value="drivers"><Assignments base={base} id={id} v={v} fmt={fmt} write={write || can("vehicles.assign")} onChange={api.reload} /></TabsContent>
            {costs && <TabsContent value="money"><Money base={base} fmt={fmt} /></TabsContent>}
            <TabsContent value="trips"><Trips base={base} fmt={fmt} costs={costs} /></TabsContent>
            <TabsContent value="live"><Tracking base={base} fmt={fmt} /></TabsContent>
            <TabsContent value="activity"><Activity base={base} fmt={fmt} write={write || can("fleet.manage")} /></TabsContent>
          </Tabs>

          <RecordDialog open={editing} onOpenChange={setEditing} title={`Edit ${v.name}`} fields={VEHICLE_FORM} record={v} method="PATCH" path={base} onDone={api.reload} />
          <RecordDialog open={sell} onOpenChange={setSell} title={`Mark ${v.name} as sold`} description="The car leaves the active fleet and any open booking ends. It stays in every old report."
            fields={[{ key: "soldOn", label: "Sold on", type: "date", required: true }, { key: "salePriceCents", label: "Sale price", type: "money" }]} record={{ soldOn: new Date().toISOString().slice(0, 10) }} method="POST" path={`${base}/sell`} onDone={api.reload} submitLabel="Mark as sold" />
          <ConfirmDialog open={confirmArchive} onOpenChange={setConfirmArchive} title={`Archive ${v.name}?`} description="It leaves every list and any open booking ends, but it stays in old reports and you can restore it." confirmLabel="Archive" destructive onConfirm={archive} />
        </>
      )}
    </Async>
  );
}

function ExpiryBadge({ date, fmt }: { date: string | null; fmt: Fmt }) {
  if (!date) return <span className="text-muted-foreground">No expiry</span>;
  const days = Math.round((Date.parse(`${date.slice(0, 10)}T00:00:00Z`) - Date.now()) / 86_400_000);
  return <StatusBadge tone={days < 0 ? "bad" : days <= 30 ? "warn" : "good"}>{fmt.date(date)}{days < 0 ? " · expired" : days <= 30 ? ` · ${days}d left` : ""}</StatusBadge>;
}

function Overview({ v, fmt, write, base, reload }: { v: Vehicle; fmt: Fmt; write: boolean; base: string; reload: () => void }) {
  const photo = useRef<HTMLInputElement>(null);
  const s = v.service;
  async function upload(f: File | undefined) {
    if (!f) return;
    const sess = loadSession();
    const r = await fetch(`${API_URL}${base}/photos?angle=front&main=1`, { method: "PUT", headers: { Authorization: `Bearer ${sess?.token}`, "content-type": f.type }, body: f });
    if (r.ok) { toast.success("Photo added"); reload(); } else toast.error(r.status === 413 ? "That photo is over 5 MB" : r.status === 415 ? "Use a JPEG, PNG or WebP photo" : "Could not add the photo");
  }
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <StatCard label="Odometer" value={`${fmt.num(v.odometerKm)} km`} hint={v.lastActivity ? `Last active ${fmt.date(v.lastActivity)}` : undefined} />
        <StatCard label="Driver" value={v.currentDriverName ?? "Nobody"} hint="Today" />
        <StatCard label="Next service" value={<StatusBadge tone={SERVICE_TONE[s.state as keyof typeof SERVICE_TONE] ?? "neutral"}>{SERVICE_LABEL[s.state as keyof typeof SERVICE_LABEL] ?? s.state}</StatusBadge>} hint={[s.task, s.nextDate && fmt.date(s.nextDate), s.kmLeft != null && `${fmt.num(s.kmLeft)} km left`].filter(Boolean).join(" · ") || undefined} />
        <StatCard label="Papers" value={v.docs.expired ? `${v.docs.expired} expired` : v.docs.expiring ? `${v.docs.expiring} expiring` : "All valid"} hint={v.docs.nextExpiry ? `Next: ${fmt.date(v.docs.nextExpiry)}` : undefined} />
      </div>
      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader><CardTitle className="text-base">Details</CardTitle></CardHeader>
          <CardContent>
            <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
              {([["Type", v.kind], ["VIN", v.vin], ["Fuel", v.fuelType], ["Ownership", v.ownershipType], ["Purchased", v.purchaseDate && fmt.date(v.purchaseDate as string)], ["Insurance until", v.insuranceExpiry && fmt.date(v.insuranceExpiry as string)], ["Max load", v.capacityKg && `${fmt.num(Number(v.capacityKg))} kg`], ["Seats", v.seats], ["Tags", (v.tags as string[] | undefined)?.join(", ")]] as [string, unknown][]).map(([k, val]) => (
                <div key={k} className="flex justify-between gap-3 border-b py-1"><dt className="text-muted-foreground">{k}</dt><dd className="text-right font-medium">{val ? String(val) : "—"}</dd></div>
              ))}
              {v.canSeeCosts && <div className="flex justify-between gap-3 border-b py-1"><dt className="text-muted-foreground">Purchase price</dt><dd className="font-medium">{fmt.money(v.purchasePriceCents as number | null)}</dd></div>}
              {v.canSeeCosts && <div className="flex justify-between gap-3 border-b py-1"><dt className="text-muted-foreground">Value today</dt><dd className="font-medium">{fmt.money(v.currentValueCents as number | null)}</dd></div>}
            </dl>
            {Boolean(v.notes) && <p className="mt-3 whitespace-pre-wrap text-sm text-muted-foreground">{String(v.notes)}</p>}
          </CardContent>
        </Card>
        <Card>
          <CardHeader><CardTitle className="text-base">Photo and recent changes</CardTitle></CardHeader>
          <CardContent className="space-y-3 text-sm">
            {write && <><input ref={photo} type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" aria-label="Add photo" onChange={(e) => void upload(e.target.files?.[0])} /><Button size="sm" variant="outline" onClick={() => photo.current?.click()}><Camera className="size-4" /> Add photo</Button></>}
            {v.hasPhoto && <p className="flex items-center gap-1 text-muted-foreground"><CheckCircle2 className="size-4 text-ok" /> Main photo set</p>}
            <ul className="space-y-1">{v.lastEvents.map((e, i) => <li key={i} className="text-muted-foreground"><span className="text-foreground">{e.action.replace(/[._]/g, " ")}</span> · {e.actor ?? "system"} · {fmt.dateTime(e.at)}</li>)}{!v.lastEvents.length && <li className="text-muted-foreground">Nothing yet.</li>}</ul>
          </CardContent>
        </Card>
      </div>
    </>
  );
}

function TemplateButtons({ base, onDone }: { base: string; onDone: () => void }) {
  const tpl = [["oil", "Oil change"], ["tires", "Tire rotation"], ["brakes", "Brake check"], ["annual", "Annual inspection"]];
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm"><span className="text-muted-foreground">Quick add:</span>
      {tpl.map(([k, l]) => <Button key={k} size="sm" variant="secondary" onClick={async () => { try { await apiSend("POST", `${base}/apply-template`, { template: k }); toast.success(`${l} plan added`); onDone(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); } }}>{l}</Button>)}
    </div>
  );
}

const WO_NEXT: Record<string, string[]> = { open: ["assigned", "awaiting_approval", "cancelled"], assigned: ["awaiting_approval", "closed", "cancelled"], awaiting_approval: ["approved", "open", "cancelled"], approved: ["closed", "cancelled"], closed: [], cancelled: ["open"] };
function WorkOrders({ base, fmt, write, onChange }: { base: string; fmt: Fmt; write: boolean; onChange: () => void }) {
  const shops = useApi<{ id: string; name: string }[]>("/portal/shops");
  const [step, setStep] = useState<{ rec: Rec; next: string } | null>(null);
  const fields = useMemo<FieldSpec[]>(() => [{ key: "title", label: "Job", required: true }, { key: "description", label: "Details", type: "textarea" }, { key: "shopId", label: "Shop", type: "select", options: (shops.data ?? []).map((s) => ({ value: s.id, label: s.name })) }, { key: "estimateCents", label: "Estimate", type: "money" }, { key: "dueOn", label: "Due", type: "date" }, { key: "invoiceRef", label: "Invoice number" }], [shops.data]);
  return (
    <>
      <ChildSection id="veh-wo" title="Work orders" base={base} name="work-orders" canWrite={write} addLabel="New work order" onChange={onChange} fields={fields}
        columns={[col("title", "Job", (r) => String(r.title)), col("status", "Status", (r) => <StatusBadge tone={r.status === "closed" ? "good" : r.status === "cancelled" ? "neutral" : r.status === "approved" ? "info" : "warn"}>{String(r.status).replace(/_/g, " ")}</StatusBadge>, { csv: (r) => String(r.status) }), col("estimateCents", "Estimate", (r) => fmt.money(r.estimateCents as number | null), { end: true, num: true, csv: (r) => dollars(r.estimateCents as number | null) }), col("actualCents", "Final cost", (r) => fmt.money(r.actualCents as number | null), { end: true, num: true, csv: (r) => dollars(r.actualCents as number | null) })]}
        rowActions={(r, reload) => (WO_NEXT[String(r.status)] ?? []).filter((n) => n !== "cancelled" && n !== "open").map((n) => <Button key={n} size="sm" variant="outline" onClick={() => (n === "closed" ? setStep({ rec: r, next: n }) : void advance(r, n, reload))}>{n === "awaiting_approval" ? "Ask approval" : n === "approved" ? "Approve" : n === "closed" ? "Close" : "Assign"}</Button>)}
        empty={{ title: "No work orders", description: "Open a work order to get a repair estimate approved, then close it with the final cost." }} />
      {step && <RecordDialog open onOpenChange={(o) => !o && setStep(null)} title={`Close “${String(step.rec.title)}”`} description="The final cost is added to this car's maintenance history so reports include it." fields={[{ key: "actualCents", label: "Final cost", type: "money", required: true }, { key: "invoiceRef", label: "Invoice number" }]}
        record={{ actualCents: step.rec.actualCents ?? step.rec.estimateCents, invoiceRef: step.rec.invoiceRef }} extra={{ status: "closed" }} method="PATCH" path={`${base}/work-orders/${step.rec.id}`} submitLabel="Close work order" onDone={onChange} />}
    </>
  );
  async function advance(r: Rec, next: string, reload: () => void) {
    try { await apiSend("PATCH", `${base}/work-orders/${r.id}`, { status: next }); toast.success("Updated"); reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); }
  }
}

function Inspections({ base, fmt, write, onChange }: { base: string; fmt: Fmt; write: boolean; onChange: () => void }) {
  return (
    <ChildSection id="veh-insp" title="Inspections" base={base} name="inspections" canWrite={write} addLabel="Record inspection" onChange={onChange}
      fields={[{ key: "kind", label: "When", type: "select", required: true, options: [{ value: "check_out", label: "Check-out (start of day)" }, { value: "check_in", label: "Check-in (end of day)" }] }, { key: "at", label: "Date and time", type: "datetime" }, { key: "defects", label: "Defects found", type: "checkbox", help: "A defect blocks the car from new jobs until someone signs it off." }, { key: "odometerKm", label: "Odometer (km)", type: "number" }, { key: "notes", label: "What was wrong", type: "textarea" }]}
      columns={[col("at", "When", (r) => fmt.dateTime(r.createdAt as string)), col("kind", "Kind", (r) => String(r.kind).replace(/_/g, " ")), col("defects", "Result", (r) => (r.defects ? (r.signedOffAt ? <StatusBadge tone="good">Fixed and signed off</StatusBadge> : <StatusBadge tone="bad">Defects: needs sign-off</StatusBadge>) : <StatusBadge tone="good">Passed</StatusBadge>), { csv: (r) => (r.defects ? "defects" : "passed") }), col("notes", "Notes", (r) => r.notes as string)]}
      rowActions={(r, reload) => (r.defects && !r.signedOffAt && write ? <Button size="sm" variant="outline" onClick={async () => { try { await apiSend("POST", `${base}/inspections/${r.id}/sign-off`, {}); toast.success("Signed off. The car can take jobs again."); reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); } }}>Sign off</Button> : null)}
      empty={{ title: "No inspections", description: "Drivers' check-out and check-in inspections show up here." }} />
  );
}

function Assignments({ base, id, v, fmt, write, onChange }: { base: string; id: string; v: Vehicle; fmt: Fmt; write: boolean; onChange: () => void }) {
  const meta = useApi<{ drivers: { id: string; name: string }[] }>("/portal/vehicles/meta");
  const [force, setForce] = useState<Record<string, unknown> | null>(null);
  const fields = useMemo<FieldSpec[]>(() => [{ key: "driverId", label: "Driver", type: "select", required: true, options: (meta.data?.drivers ?? []).map((d) => ({ value: d.id, label: d.name })) }, { key: "kind", label: "For", type: "select", options: [{ value: "day", label: "A day" }, { value: "week", label: "A week" }, { value: "permanent", label: "Permanent" }] }, { key: "startAt", label: "Starts", type: "datetime", required: true }, { key: "endAt", label: "Ends", type: "datetime", help: "Leave blank for a day or week to use the default length." }, { key: "odometerStartKm", label: "Odometer at pick-up (km)", type: "number" }, { key: "fuelStartPct", label: "Fuel at pick-up (%)", type: "number", step: "1" }, { key: "damageNotes", label: "Damage at pick-up", type: "textarea" }], [meta.data]);
  void force; void setForce; void id;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">Today: <strong>{v.currentDriverName ?? "nobody"}</strong>. Overlapping bookings are refused so a car or driver is never double-booked. Licence class is checked against the vehicle type.</p>
      <ChildSection id={`veh-asg-${id}`} base={base} name="assignments" canWrite={write} addLabel="Assign driver" onChange={onChange} fields={fields} defaults={{ kind: "day", startAt: new Date().toISOString() }}
        columns={[col("driverId", "Driver", (r) => (meta.data?.drivers.find((d) => d.id === r.driverId)?.name ?? String(r.driverId).slice(0, 8)), { csv: (r) => String(r.driverId) }), col("kind", "For", (r) => String(r.kind)), col("startAt", "Starts", (r) => fmt.dateTime(r.startAt as string)), col("endAt", "Ends", (r) => (r.endAt ? fmt.dateTime(r.endAt as string) : "Open-ended"), { csv: (r) => String(r.endAt ?? "") })]}
        empty={{ title: "No bookings", description: "Assign a driver for a day, a week or permanently." }} />
    </div>
  );
}

interface Fin { periods: Record<"day" | "week" | "month" | "lifetime" | "range", { revenueCents: number; costCents: number; profitCents: number; fuelCents: number; maintenanceCents: number }>; months: { month: string; revenueCents: number; costCents: number; profitCents: number }[];
  perKm: { range: number | null; lifetime: number | null }; tco: { purchaseCents: number; runningCents: number; totalCents: number; fuelCents: number; repairsCents: number; insuranceCents: number; financeCents: number; tiresCents: number; ticketsCents: number; otherCents: number; driverPayCents: number };
  breakEven: { paybackDays: number | null; date: string | null; profitToDateCents: number; purchaseCents: number }; depreciation: { month?: string; date?: string; valueCents: number }[]; valueNowCents: number | null;
  keepRepairSell: { score: number; advice: string }; formula: string }
function Money({ base, fmt }: { base: string; fmt: Fmt }) {
  const api = useApi<Fin>(`${base}/financials`);
  return (
    <Async state={api}>{() => api.data && (() => { const f = api.data; return (
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {(["day", "week", "month", "lifetime"] as const).map((p) => <StatCard key={p} label={`Profit, ${p === "day" ? "today" : p === "week" ? "last 7 days" : p === "month" ? "this month" : "since purchase"}`} value={<span className={f.periods[p].profitCents < 0 ? "text-destructive" : undefined}>{fmt.money(f.periods[p].profitCents)}</span>} hint={`${fmt.money(f.periods[p].revenueCents)} earned · ${fmt.money(f.periods[p].costCents)} spent`} />)}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <Card><CardHeader><CardTitle className="text-base">Total cost of owning</CardTitle></CardHeader><CardContent>
            <table className="w-full text-sm"><tbody>
              {([["Purchase price", f.tco.purchaseCents], ["Fuel", f.tco.fuelCents], ["Repairs and service", f.tco.repairsCents], ["Insurance", f.tco.insuranceCents], ["Loan or lease", f.tco.financeCents], ["Tires", f.tco.tiresCents], ["Tickets and fines", f.tco.ticketsCents], ["Driver pay", f.tco.driverPayCents], ["Other", f.tco.otherCents]] as [string, number][]).map(([k, c]) => <tr key={k} className="border-b"><td className="py-1 text-muted-foreground">{k}</td><td className="py-1 text-right tabular-nums">{fmt.money(c)}</td></tr>)}
              <tr><td className="py-1 font-semibold">Total</td><td className="py-1 text-right font-semibold tabular-nums">{fmt.money(f.tco.totalCents)}</td></tr>
            </tbody></table>
            <p className="mt-2 text-xs text-muted-foreground">Cost per km: {f.perKm.lifetime != null ? fmt.money(f.perKm.lifetime) : "no distance yet"} (all time). The purchase price is not counted in monthly profit.</p>
          </CardContent></Card>
          <Card><CardHeader><CardTitle className="text-base">Keep, repair or sell?</CardTitle></CardHeader><CardContent className="space-y-2 text-sm">
            <StatusBadge tone={f.keepRepairSell.advice === "keep" ? "good" : f.keepRepairSell.advice === "repair" ? "warn" : "bad"}>{f.keepRepairSell.advice.toUpperCase()} · score {f.keepRepairSell.score}/100</StatusBadge>
            <p className="text-muted-foreground">{f.formula}</p>
            <p>Break-even: {f.breakEven.paybackDays != null ? <>about <strong>{fmt.num(f.breakEven.paybackDays)}</strong> days{f.breakEven.date && <> (around {fmt.date(f.breakEven.date)})</>}</> : "not enough profit yet to estimate"}.</p>
            <p>Value today: {fmt.money(f.valueNowCents)}</p>
          </CardContent></Card>
        </div>
        <Card><CardHeader><CardTitle className="text-base">Last 12 months</CardTitle></CardHeader><CardContent className="overflow-x-auto">
          <table className="w-full text-sm"><thead><tr className="text-left text-muted-foreground"><th className="py-1">Month</th><th className="text-right">Earned</th><th className="text-right">Spent</th><th className="text-right">Profit</th></tr></thead>
            <tbody>{f.months.map((m) => <tr key={m.month} className="border-t"><td className="py-1">{m.month}</td><td className="text-right tabular-nums">{fmt.money(m.revenueCents)}</td><td className="text-right tabular-nums">{fmt.money(m.costCents)}</td><td className={`text-right tabular-nums ${m.profitCents < 0 ? "text-destructive" : ""}`}>{fmt.money(m.profitCents)}</td></tr>)}</tbody></table>
        </CardContent></Card>
      </div>); })()}</Async>
  );
}

function Trips({ base, fmt, costs }: { base: string; fmt: Fmt; costs: boolean }) {
  const cols: Col<Rec>[] = [col("startedAt", "Started", (r) => fmt.dateTime(r.startedAt as string)), col("customer", "Customer", (r) => r.customer as string), col("driver", "Driver", (r) => r.driver as string), col("distanceM", "Distance", (r) => (r.distanceM == null ? "—" : `${fmt.num(Number(r.distanceM) / 1000, 1)} km`), { end: true, num: true, csv: (r) => (r.distanceM == null ? "" : Number(r.distanceM) / 1000) }), ...(costs ? [col("revenueCents", "Earned", (r) => fmt.money(r.revenueCents as number | null), { end: true, num: true, csv: (r) => dollars(r.revenueCents as number | null) })] : []), col("status", "Status", (r) => String(r.status ?? ""))];
  return <ReadOnlyList id="veh-trips" url={`${base}/trips`} columns={cols} empty={{ title: "No trips yet", description: "Completed jobs and trips for this car show up here." }} />;
}

function ReadOnlyList({ id, url, columns, empty }: { id: string; url: string; columns: Col<Rec>[]; empty: { title: string; description?: string } }) {
  const api = useApi<Rec[]>(url);
  return <ChildReadOnly id={id} api={api} columns={columns} empty={empty} />;
}
function ChildReadOnly({ id, api, columns, empty }: { id: string; api: ReturnType<typeof useApi<Rec[]>>; columns: Col<Rec>[]; empty: { title: string; description?: string } }) {
  return <DataTable id={id} data={api.data} loading={api.loading && !api.loaded} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => r.id} searchText={(r) => Object.values(r).filter((x) => typeof x === "string").join(" ")} selectable={false} exportName={id} pageSize={10} empty={empty} />;
}

interface Tracking { device: { id: string; source: string } | null; position?: { time: string; lat: number; lng: number; speed: number; ignition: boolean } | null; events?: { kind: string; at: string; geofence: string | null }[]; last24h?: { moving: number; idling: number; top: number | null; fast: number }; replay?: string }
function Tracking({ base, fmt }: { base: string; fmt: Fmt }) {
  const api = useApi<Tracking>(`${base}/tracking`, { intervalMs: 30_000 });
  return (
    <Async state={api}>{() => { const t = api.data!; return !t.device ? (
      <p className="text-sm text-muted-foreground">No tracker is linked to this car yet. Add a device under Settings, then live position, geofence events and trip replay appear here.</p>
    ) : (
      <div className="space-y-3 text-sm">
        <div className="grid gap-3 sm:grid-cols-3">
          <StatCard label="Last position" value={t.position ? fmt.dateTime(t.position.time) : "No data"} hint={t.position ? `${t.position.lat.toFixed(4)}, ${t.position.lng.toFixed(4)} · ${Math.round(t.position.speed)} km/h` : undefined} />
          <StatCard label="Moving, last 24 h" value={`${t.last24h?.moving ?? 0} pings`} hint={`${t.last24h?.idling ?? 0} idling · top ${Math.round(t.last24h?.top ?? 0)} km/h`} />
          <StatCard label="Speeding pings" value={t.last24h?.fast ?? 0} hint="Over 110 km/h" />
        </div>
        <div className="flex gap-2">{t.replay && <Button asChild size="sm" variant="outline"><Link href={t.replay}>Trip replay</Link></Button>}</div>
        <ul className="space-y-1">{(t.events ?? []).map((e, i) => <li key={i}>{fmt.dateTime(e.at)} · {e.kind} {e.geofence ?? ""}</li>)}</ul>
      </div>
    ); }}</Async>
  );
}

function Activity({ base, fmt, write }: { base: string; fmt: Fmt; write: boolean }) {
  const api = useApi<{ audit: { id: string; at: string; actor: string | null; action: string; label: string | null; oldValue: unknown; newValue: unknown }[]; notes: { id: string; body: string; createdAt: string; author: string | null }[] }>(`${base}/activity`);
  const [text, setText] = useState("");
  async function add() { try { await apiSend("POST", `${base}/notes`, { body: text }); setText(""); api.reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Failed"); } }
  return (
    <Async state={api}>{() => (
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader><CardTitle className="text-base">Notes</CardTitle></CardHeader><CardContent className="space-y-3">
          {write && <div className="space-y-2"><Textarea aria-label="New note" value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a note for the team" /><Button size="sm" disabled={!text.trim()} onClick={add}>Add note</Button></div>}
          <ul className="space-y-2 text-sm">{api.data!.notes.map((n) => <li key={n.id} className="rounded border p-2"><div className="whitespace-pre-wrap">{n.body}</div><div className="text-xs text-muted-foreground">{n.author ?? "someone"} · {fmt.dateTime(n.createdAt)}</div></li>)}{!api.data!.notes.length && <li className="text-muted-foreground">No notes yet.</li>}</ul>
        </CardContent></Card>
        <Card><CardHeader><CardTitle className="text-base">Who changed what</CardTitle></CardHeader><CardContent>
          <ul className="space-y-2 text-sm">{api.data!.audit.map((a) => <li key={a.id} className="border-b pb-2"><div><strong>{a.action.replace(/[._]/g, " ")}</strong> {a.label && `· ${a.label}`}</div><div className="text-xs text-muted-foreground">{a.actor ?? "system"} · {fmt.dateTime(a.at)}</div>
            {(a.oldValue || a.newValue) != null && <pre className="mt-1 overflow-x-auto rounded bg-muted p-2 text-[11px]">{JSON.stringify({ was: a.oldValue, now: a.newValue })}</pre>}</li>)}{!api.data!.audit.length && <li className="text-muted-foreground">No changes logged.</li>}</ul>
        </CardContent></Card>
      </div>
    )}</Async>
  );
}
