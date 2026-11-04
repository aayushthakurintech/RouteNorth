"use client";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { apiSend } from "@/lib/api";
import { useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";
import type { Meta } from "./cards";

interface Line { key: string; label: string; cents: number }
interface Sim {
  customer: { card: string; lines: Line[]; subtotalCents: number; totalCents: number; notes: string[] } | null;
  driver: { card: string; lines: Line[]; payCents: number; totalCents: number; notes: string[] } | null;
  carCost: { perKmCents: number; totalCents: number }; marginCents: number; marginPct: number | null; priceCents: number;
}
interface CardRow { id: string; name: string; kind: string }
const NONE = "__none";

function Lines({ title, card, lines, total, fmt }: { title: string; card: string; lines: Line[]; total: number; fmt: ReturnType<typeof useFmt> }) {
  return (
    <div><h4 className="text-sm font-medium">{title} <span className="font-normal text-muted-foreground">({card})</span></h4>
      <table className="mt-1 w-full text-sm"><tbody>
        {lines.map((l, i) => <tr key={i}><td className="py-0.5 pr-2">{l.label}</td><td className="py-0.5 text-right tabular-nums">{fmt.money(l.cents)}</td></tr>)}
        <tr className="border-t font-medium"><td className="py-1">Total</td><td className="py-1 text-right tabular-nums">{fmt.money(total)}</td></tr></tbody></table></div>
  );
}

/** Price simulator, "which card wins", compare two cards, and replay last month with a new card. Nothing here is saved. */
export function SimulatorTab({ meta }: { meta: Meta }) {
  const fmt = useFmt();
  const cards = useApi<CardRow[]>("/portal/pay/cards");
  const [f, setF] = useState({ distanceKm: "25", durationMin: "40", waitingMin: "10", stops: "1", tip: "5", zone: "", vehicleKind: "", peak: true, night: false, weekend: false, holiday: false, weather: false });
  const [dc, setDc] = useState(NONE); const [cc, setCc] = useState(NONE);
  const [res, setRes] = useState<Sim | null>(null); const [err, setErr] = useState<string | null>(null);
  const set = (k: string, v: string | boolean) => setF((s) => ({ ...s, [k]: v }));
  const driver = (cards.data ?? []).filter((c) => c.kind === "driver"), customer = (cards.data ?? []).filter((c) => c.kind === "customer");

  async function run() {
    setErr(null);
    try {
      const n = (s: string) => (s.trim() === "" ? undefined : Number(s));
      setRes(await apiSend<Sim>("POST", "/portal/pay/simulate", {
        driverCardId: dc === NONE ? undefined : dc, customerCardId: cc === NONE ? undefined : cc,
        trip: { distanceKm: n(f.distanceKm), durationMin: n(f.durationMin), waitingMin: n(f.waitingMin), stops: n(f.stops), tipCents: f.tip.trim() ? Math.round(Number(f.tip) * 100) : undefined, zone: f.zone || undefined, vehicleKind: f.vehicleKind || undefined,
          conditions: { peak: f.peak, night: f.night, weekend: f.weekend, holiday: f.holiday, weather: f.weather } },
      }));
    } catch (e) { setErr(e instanceof Error ? e.message : "Could not work it out"); }
  }

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader><CardTitle>Price simulator</CardTitle><CardDescription>Type a trip and see what the customer pays, what the driver earns, what the car costs and what is left. Nothing is saved.</CardDescription></CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            {([["distanceKm", "Distance (km)"], ["durationMin", "Time (minutes)"], ["waitingMin", "Waiting (minutes)"], ["stops", "Stops"], ["tip", "Tip ($)"], ["zone", "Zone"], ["vehicleKind", "Vehicle type"]] as const).map(([k, l]) => (
              <div key={k}><Label className="mb-1 block text-sm" htmlFor={`sim-${k}`}>{l}</Label><Input id={`sim-${k}`} value={f[k]} onChange={(e) => set(k, e.target.value)} inputMode="decimal" /></div>))}
          </div>
          <div className="flex flex-wrap gap-4 text-sm">{(["peak", "night", "weekend", "holiday", "weather"] as const).map((k) => <label key={k} className="flex items-center gap-2"><Checkbox checked={f[k]} onCheckedChange={(c) => set(k, c === true)} />{k[0]!.toUpperCase() + k.slice(1)}</label>)}</div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div><Label className="mb-1 block text-sm">Customer price card</Label><Select value={cc} onValueChange={setCc}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NONE}>None</SelectItem>{customer.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select></div>
            <div><Label className="mb-1 block text-sm">Driver pay card</Label><Select value={dc} onValueChange={setDc}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value={NONE}>None</SelectItem>{driver.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select></div>
          </div>
          <Button onClick={run} disabled={dc === NONE && cc === NONE}>Work it out</Button>
          {err && <p className="text-sm text-destructive" role="alert">{err}</p>}
        </CardContent>
      </Card>
      <Card>
        <CardHeader><CardTitle>Result</CardTitle><CardDescription>Customer price, driver pay and car cost side by side.</CardDescription></CardHeader>
        <CardContent className="space-y-4">
          {!res ? <p className="text-sm text-muted-foreground">Pick a card and press “Work it out”.</p> : <>
            {res.customer && <Lines title="Customer pays" card={res.customer.card} lines={res.customer.lines} total={res.customer.totalCents} fmt={fmt} />}
            {res.driver && <Lines title="Driver earns" card={res.driver.card} lines={res.driver.lines} total={res.driver.totalCents} fmt={fmt} />}
            <div className="rounded-md bg-muted p-3 text-sm">
              <div className="flex justify-between"><span>Price (before tax)</span><span className="tabular-nums">{fmt.money(res.priceCents)}</span></div>
              <div className="flex justify-between"><span>Driver pay (without tip)</span><span className="tabular-nums">− {fmt.money(res.driver?.payCents ?? 0)}</span></div>
              <div className="flex justify-between"><span>Car cost ({fmt.money(res.carCost.perKmCents)} per km)</span><span className="tabular-nums">− {fmt.money(res.carCost.totalCents)}</span></div>
              <div className="mt-1 flex justify-between border-t pt-1 font-semibold"><span>Left for you</span><span className="tabular-nums">{fmt.money(res.marginCents)}{res.marginPct != null && ` (${res.marginPct}%)`}</span></div></div>
            {[...(res.customer?.notes ?? []), ...(res.driver?.notes ?? [])].map((n, i) => <p key={i} className="text-xs text-muted-foreground">{n}</p>)}
          </>}
        </CardContent>
      </Card>
      <WinsCard meta={meta} />
      <ReplayCard cards={driver} />
    </div>
  );
}

function WinsCard({ meta }: { meta: Meta }) {
  const fmt = useFmt();
  const [q, setQ] = useState({ kind: "driver", driverId: NONE, customer: "", zone: "", vehicleKind: "" });
  const [r, setR] = useState<{ version: { name: string; version: number; summary: string } | null; winner: { kind: string } | null; considered: { cardName: string; kind: string; target: string | null; matches: boolean; why: string; startsOn: string }[] } | null>(null);
  async function go() {
    const p = new URLSearchParams({ kind: q.kind }); if (q.driverId !== NONE) p.set("driverId", q.driverId); if (q.customer) p.set("customer", q.customer); if (q.zone) p.set("zone", q.zone); if (q.vehicleKind) p.set("vehicleKind", q.vehicleKind);
    try { const { apiGet } = await import("@/lib/api"); setR(await apiGet(`/portal/pay/resolve?${p}`)); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not check"); }
  }
  return (
    <Card>
      <CardHeader><CardTitle>Which card wins?</CardTitle><CardDescription>When more than one card applies, the most specific one is used: driver, customer, zone, vehicle type, team, everyone.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2">
          <Select value={q.kind} onValueChange={(v) => setQ({ ...q, kind: v })}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="driver">Driver pay</SelectItem><SelectItem value="customer">Customer price</SelectItem></SelectContent></Select>
          <Select value={q.driverId} onValueChange={(v) => setQ({ ...q, driverId: v })}><SelectTrigger className="w-full"><SelectValue placeholder="Driver" /></SelectTrigger><SelectContent><SelectItem value={NONE}>Any driver</SelectItem>{meta.drivers.map((d) => <SelectItem key={d.id} value={d.id}>{d.name}</SelectItem>)}</SelectContent></Select>
          <Input placeholder="Customer" value={q.customer} onChange={(e) => setQ({ ...q, customer: e.target.value })} /><Input placeholder="Zone" value={q.zone} onChange={(e) => setQ({ ...q, zone: e.target.value })} />
        </div>
        <Button variant="outline" size="sm" onClick={go}>Check</Button>
        {r && <div className="text-sm">
          <p className="font-medium">{r.version ? `${r.version.name} v${r.version.version} wins (${r.version.summary})` : "No card applies"}</p>
          <ul className="mt-1 space-y-0.5 text-xs text-muted-foreground">{r.considered.map((c, i) => <li key={i}>{c.matches ? "✓" : "✗"} {c.cardName} for {c.kind}{c.target ? ` ${c.target}` : ""} from {fmt.date(c.startsOn)}: {c.why}</li>)}</ul></div>}
      </CardContent>
    </Card>
  );
}

function ReplayCard({ cards }: { cards: CardRow[] }) {
  const fmt = useFmt();
  const [a, setA] = useState(NONE); const [b, setB] = useState(NONE);
  const [out, setOut] = useState<{ title: string; rows: [string, string][] } | null>(null);
  async function compare() {
    try {
      const r = await apiSend<{ a: { name: string; trips: number; averageNewCents: number; newTotalCents: number }; b: { name: string; averageNewCents: number; newTotalCents: number }; differenceAverageCents: number; differenceTotalCents: number }>("POST", "/portal/pay/compare", { kind: "driver", aCardId: a, bCardId: b });
      setOut({ title: `Last 30 days, ${r.a.trips} trips`, rows: [[r.a.name, `${fmt.money(r.a.averageNewCents)} average, ${fmt.money(r.a.newTotalCents)} total`], [r.b.name, `${fmt.money(r.b.averageNewCents)} average, ${fmt.money(r.b.newTotalCents)} total`], ["Change in average trip pay", fmt.money(r.differenceAverageCents)], ["Change in total pay", fmt.money(r.differenceTotalCents)]] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not compare"); }
  }
  async function whatIf() {
    try {
      const r = await apiSend<{ card: string; trips: number; currentTotalCents: number; newTotalCents: number; costChangeCents: number; marginNowCents: number; marginNewCents: number; marginChangeCents: number }>("POST", "/portal/pay/what-if", { cardId: b });
      setOut({ title: `What if the last 30 days (${r.trips} trips) were paid with ${r.card}?`, rows: [["Driver pay now", fmt.money(r.currentTotalCents)], ["Driver pay with this card", fmt.money(r.newTotalCents)], ["Change in cost", fmt.money(r.costChangeCents)], ["Margin now", fmt.money(r.marginNowCents)], ["Margin with this card", fmt.money(r.marginNewCents)], ["Change in margin", fmt.money(r.marginChangeCents)]] });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not replay"); }
  }
  const pick = (v: string, s: (x: string) => void) => <Select value={v} onValueChange={s}><SelectTrigger className="w-full"><SelectValue placeholder="Pick a card" /></SelectTrigger><SelectContent><SelectItem value={NONE}>—</SelectItem>{cards.map((c) => <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>)}</SelectContent></Select>;
  return (
    <Card>
      <CardHeader><CardTitle>Compare cards and replay last month</CardTitle><CardDescription>Uses the last 30 days of real trips. Saves nothing.</CardDescription></CardHeader>
      <CardContent className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2"><div><Label className="mb-1 block text-sm">Card A</Label>{pick(a, setA)}</div><div><Label className="mb-1 block text-sm">Card B (or the new card)</Label>{pick(b, setB)}</div></div>
        <div className="flex gap-2"><Button size="sm" variant="outline" disabled={a === NONE || b === NONE} onClick={compare}>Compare A and B</Button><Button size="sm" variant="outline" disabled={b === NONE} onClick={whatIf}>What if we used B?</Button></div>
        {out && <div className="text-sm"><p className="font-medium">{out.title}</p><dl className="mt-1 space-y-0.5">{out.rows.map(([k, v]) => <div key={k} className="flex justify-between gap-4"><dt className="text-muted-foreground">{k}</dt><dd className="tabular-nums">{v}</dd></div>)}</dl></div>}
      </CardContent>
    </Card>
  );
}
