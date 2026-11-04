"use client";
import { Plus, Save, Trash2 } from "lucide-react";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/portal/parts";
import { useOwnerRange } from "@/components/portal/range-context";
import type { RResult } from "@/components/portal/report-chart";
import { ReportView } from "@/components/portal/report-view";
import { ErrorState, LoadingState } from "@/components/portal/states";
import { apiSend } from "@/lib/api";
import { useApi } from "@/lib/use-api";

interface DsCol { key: string; label: string; type: string; agg?: string }
interface Ds { key: string; label: string; about?: string; columns: DsCol[] }
interface Spec {
  dataset: string; title?: string; range?: { from?: string; to?: string; preset?: string }; columns?: { key: string; agg?: string }[]; filters?: { key: string; op: string; value: unknown }[]; groupBy?: string[];
  calc?: { key: string; label?: string; formula: string }[]; sort?: { key: string; dir: "asc" | "desc" } | null; limit?: number; chart?: { type: string; x?: string; y?: string[]; series?: string; bucket?: "month" }; pivot?: { row: string; col: string; value: string; agg?: string };
}
const SOURCES = ["vehicles", "carMoney", "carLifetime", "drivers", "driverProfit", "trips", "payLines", "payouts", "expenses", "invoices", "customers", "repairs", "documents"];
const CHARTS = [["table", "Table"], ["bar", "Bar"], ["stacked", "Stacked bar"], ["line", "Line"], ["area", "Area"], ["pie", "Pie"], ["donut", "Donut"], ["scatter", "Scatter"], ["heat", "Heat map (needs a pivot)"], ["funnel", "Funnel"], ["waterfall", "Waterfall"], ["map", "Map (not drawn yet)"]];
const OPS: [string, string][] = [["eq", "is"], ["ne", "is not"], ["contains", "contains"], ["in", "is one of"], ["gt", "is more than"], ["gte", "is at least"], ["lt", "is less than"], ["lte", "is at most"]];
const AGGS = ["sum", "avg", "min", "max", "count"];

function Builder() {
  const router = useRouter(); const qs = useSearchParams(); const { range } = useOwnerRange();
  const edit = qs.get("edit"); const fromDraft = qs.get("draft") === "1";
  const all = useApi<Ds[]>("/portal/reports/datasets");
  const saved = useApi<{ id: string; name: string; spec: Spec; shared: boolean }[]>(edit ? "/reports/saved" : null);
  const [spec, setSpec] = useState<Spec>({ dataset: "carMoney", columns: [], chart: { type: "table" } });
  const [name, setName] = useState(""); const [shared, setShared] = useState(false); const [compare, setCompare] = useState("none");
  const [state, setState] = useState<{ data: RResult | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: false });
  useEffect(() => {
    if (fromDraft) { try { const raw = sessionStorage.getItem("routenorth.builder.draft"); if (raw) { const s = JSON.parse(raw) as Spec; setSpec({ chart: { type: "table" }, ...s }); setName(s.title ?? ""); } } catch { /* start empty */ } }
  }, [fromDraft]);
  useEffect(() => { const s = saved.data?.find((r) => r.id === edit); if (s) { setSpec(s.spec); setName(s.name); setShared(s.shared); } }, [saved.data, edit]);
  const sources = (all.data ?? []).filter((d) => SOURCES.includes(d.key) || d.key === spec.dataset);
  const ds = all.data?.find((d) => d.key === spec.dataset);
  const cols = ds?.columns ?? []; const nums = cols.filter((c) => ["num", "money", "pct"].includes(c.type)); const texts = cols.filter((c) => !["num", "money", "pct"].includes(c.type));
  const patch = (p: Partial<Spec>) => setSpec((s) => ({ ...s, ...p }));
  const chosen = new Set((spec.columns ?? []).map((c) => c.key));
  const toggle = (k: string, on: boolean) => patch({ columns: on ? [...(spec.columns ?? []), { key: k }] : (spec.columns ?? []).filter((c) => c.key !== k) });
  const group = spec.groupBy ?? [];
  // A live preview that refreshes a moment after each change.
  const runBody = useMemo(() => ({ spec: { ...spec, range: undefined }, from: range.from, to: range.to, compare: compare === "none" ? undefined : compare }), [spec, range.from, range.to, compare]);
  useEffect(() => {
    if (!ds) return;
    const t = setTimeout(() => {
      setState((s) => ({ ...s, loading: true }));
      apiSend<RResult>("POST", "/portal/reports/run", runBody).then((d) => setState({ data: d, error: null, loading: false })).catch((e) => setState((s) => ({ data: s.data, error: e instanceof Error ? e : new Error(String(e)), loading: false })));
    }, 500);
    return () => clearTimeout(t);
  }, [runBody, ds]);
  async function save() {
    try {
      const body = { name: name.trim(), spec: { ...spec, range: { from: range.from, to: range.to } }, shared };
      const r = edit ? await apiSend<{ id: string }>("PUT", `/reports/saved/${edit}`, body).then(() => ({ id: edit })) : await apiSend<{ id: string }>("POST", "/reports/saved", body);
      toast.success("Saved"); router.push(`/owner/reports/${r.id}`);
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not save"); }
  }
  return (
    <>
      <PageHeader title={edit ? "Edit report" : "Report builder"} description="Pick the data, the columns, the rules and the chart. The preview updates as you go, using the dates at the top." crumbs={[{ label: "Reports", href: "/owner/reports" }, { label: "Builder" }]}
        actions={<Button size="sm" disabled={!name.trim() || !ds} onClick={() => void save()}><Save className="size-4" /> {edit ? "Save changes" : "Save report"}</Button>} />
      {!all.data ? <LoadingState /> : (
        <div className="grid gap-4 lg:grid-cols-[22rem_1fr]">
          <div className="space-y-4">
            <section className="space-y-2 rounded-lg border p-3"><h2 className="text-sm font-semibold">1. Name and data</h2>
              <div><Label htmlFor="b-name">Name</Label><Input id="b-name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} placeholder="Profit per car" /></div>
              <div><Label htmlFor="b-ds">Data</Label>
                <Select value={spec.dataset} onValueChange={(v) => setSpec({ dataset: v, columns: [], chart: { type: "table" } })}><SelectTrigger id="b-ds"><SelectValue /></SelectTrigger><SelectContent>{sources.map((d) => <SelectItem key={d.key} value={d.key}>{d.label}</SelectItem>)}</SelectContent></Select>
                {ds?.about && <p className="mt-1 text-xs text-muted-foreground">{ds.about}</p>}</div>
              <label className="flex items-center gap-2 text-sm"><Checkbox checked={shared} onCheckedChange={(v) => setShared(!!v)} /> Share with the team</label>
              <div><Label htmlFor="b-cmp">Compare with</Label><Select value={compare} onValueChange={setCompare}><SelectTrigger id="b-cmp"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Nothing</SelectItem><SelectItem value="prev">The period before</SelectItem><SelectItem value="year">Same dates last year</SelectItem></SelectContent></Select></div>
            </section>
            <section className="space-y-2 rounded-lg border p-3"><h2 className="text-sm font-semibold">2. Columns</h2><p className="text-xs text-muted-foreground">Leave all unchecked to show every column.</p>
              <ul className="max-h-56 space-y-1 overflow-y-auto">{cols.filter((c) => c.key !== "count").map((c) => (
                <li key={c.key} className="flex items-center justify-between gap-2 text-sm"><label className="flex items-center gap-2"><Checkbox checked={chosen.has(c.key)} onCheckedChange={(v) => toggle(c.key, !!v)} /> {c.label}</label>
                  {group.length > 0 && chosen.has(c.key) && ["num", "money", "pct"].includes(c.type) && <Select value={spec.columns?.find((x) => x.key === c.key)?.agg ?? c.agg ?? "sum"} onValueChange={(v) => patch({ columns: (spec.columns ?? []).map((x) => (x.key === c.key ? { ...x, agg: v } : x)) })}><SelectTrigger className="h-7 w-20 text-xs" aria-label={`How to combine ${c.label}`}><SelectValue /></SelectTrigger><SelectContent>{AGGS.map((a) => <SelectItem key={a} value={a}>{a}</SelectItem>)}</SelectContent></Select>}</li>))}</ul>
            </section>
            <section className="space-y-2 rounded-lg border p-3"><h2 className="text-sm font-semibold">3. Rules (all must match)</h2>
              {(spec.filters ?? []).map((f, i) => (
                <div key={i} className="flex flex-wrap items-center gap-1 text-sm">
                  <Select value={f.key} onValueChange={(v) => patch({ filters: spec.filters!.map((x, j) => (j === i ? { ...x, key: v } : x)) })}><SelectTrigger className="h-8 w-32" aria-label="Rule column"><SelectValue /></SelectTrigger><SelectContent>{cols.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}</SelectContent></Select>
                  <Select value={f.op} onValueChange={(v) => patch({ filters: spec.filters!.map((x, j) => (j === i ? { ...x, op: v } : x)) })}><SelectTrigger className="h-8 w-28" aria-label="Rule"><SelectValue /></SelectTrigger><SelectContent>{OPS.map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent></Select>
                  <Input aria-label="Rule value" className="h-8 w-28" value={Array.isArray(f.value) ? f.value.join(", ") : String(f.value ?? "")} onChange={(e) => patch({ filters: spec.filters!.map((x, j) => (j === i ? { ...x, value: x.op === "in" ? e.target.value.split(",").map((s) => s.trim()).filter(Boolean) : ["gt", "gte", "lt", "lte"].includes(x.op) ? Number(e.target.value) : e.target.value } : x)) })} />
                  <Button size="icon" variant="ghost" className="size-8" aria-label="Remove rule" onClick={() => patch({ filters: spec.filters!.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button></div>))}
              <Button size="sm" variant="outline" disabled={!cols.length} onClick={() => patch({ filters: [...(spec.filters ?? []), { key: cols[0]!.key, op: "eq", value: "" }] })}><Plus className="size-4" /> Add a rule</Button>
              <p className="text-xs text-muted-foreground">For "this or that", use "is one of" with the choices separated by commas.</p>
            </section>
            <section className="space-y-2 rounded-lg border p-3"><h2 className="text-sm font-semibold">4. Group, sort and totals</h2>
              {[0, 1].map((i) => (
                <div key={i}><Label htmlFor={`b-g${i}`}>{i === 0 ? "Group by" : "Then by"}</Label>
                  <Select value={group[i] ?? "none"} onValueChange={(v) => { const g = [...group]; if (v === "none") g.splice(i); else g[i] = v; patch({ groupBy: g.filter(Boolean) }); }}><SelectTrigger id={`b-g${i}`}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Nothing</SelectItem>{texts.filter((c) => c.key !== group[1 - i]).map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}</SelectContent></Select></div>))}
              <div className="flex gap-2"><div className="grow"><Label htmlFor="b-sort">Sort by</Label>
                <Select value={spec.sort?.key ?? "none"} onValueChange={(v) => patch({ sort: v === "none" ? null : { key: v, dir: spec.sort?.dir ?? "desc" } })}><SelectTrigger id="b-sort"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Nothing</SelectItem>{[...cols, ...(spec.calc ?? []).map((c) => ({ key: c.key, label: c.label ?? c.key }))].map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}</SelectContent></Select></div>
                <div><Label htmlFor="b-dir">Order</Label><Select value={spec.sort?.dir ?? "desc"} onValueChange={(v) => spec.sort && patch({ sort: { ...spec.sort, dir: v as "asc" | "desc" } })}><SelectTrigger id="b-dir" className="w-28"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="desc">Biggest first</SelectItem><SelectItem value="asc">Smallest first</SelectItem></SelectContent></Select></div></div>
              <p className="text-xs text-muted-foreground">Totals sit under the table. When grouping, pick sum, average, smallest or biggest for each number in step 2.</p>
            </section>
            <section className="space-y-2 rounded-lg border p-3"><h2 className="text-sm font-semibold">5. Calculated columns</h2>
              {(spec.calc ?? []).map((c, i) => (
                <div key={i} className="space-y-1 rounded-md border p-2"><Input aria-label="Calculated column name" className="h-8" placeholder="Name, for example Profit per km" value={c.label ?? ""} onChange={(e) => patch({ calc: spec.calc!.map((x, j) => (j === i ? { ...x, label: e.target.value, key: x.key } : x)) })} />
                  <div className="flex gap-1"><Input aria-label="Formula" className="h-8" placeholder="profit / km" value={c.formula} onChange={(e) => patch({ calc: spec.calc!.map((x, j) => (j === i ? { ...x, formula: e.target.value } : x)) })} /><Button size="icon" variant="ghost" className="size-8" aria-label="Remove calculated column" onClick={() => patch({ calc: spec.calc!.filter((_, j) => j !== i) })}><Trash2 className="size-4" /></Button></div></div>))}
              <Button size="sm" variant="outline" onClick={() => patch({ calc: [...(spec.calc ?? []), { key: `calc${(spec.calc?.length ?? 0) + 1}`, label: "", formula: "" }] })}><Plus className="size-4" /> Add a calculated column</Button>
              <p className="text-xs text-muted-foreground">Use column keys and + − × ÷, for example <code>profit / km</code>. Keys: {nums.slice(0, 8).map((c) => c.key).join(", ")}{nums.length > 8 ? "…" : ""}. Money is in cents inside a formula.</p>
            </section>
            <section className="space-y-2 rounded-lg border p-3"><h2 className="text-sm font-semibold">6. Chart and pivot</h2>
              <div><Label htmlFor="b-chart">Chart</Label><Select value={spec.chart?.type ?? "table"} onValueChange={(v) => patch({ chart: { ...spec.chart, type: v } })}><SelectTrigger id="b-chart"><SelectValue /></SelectTrigger><SelectContent>{CHARTS.map(([k, l]) => <SelectItem key={k} value={k!}>{l}</SelectItem>)}</SelectContent></Select></div>
              {spec.chart?.type && spec.chart.type !== "table" && spec.chart.type !== "heat" && <>
                <div><Label htmlFor="b-x">Across</Label><Select value={spec.chart.x ?? "auto"} onValueChange={(v) => patch({ chart: { ...spec.chart!, x: v === "auto" ? undefined : v } })}><SelectTrigger id="b-x"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">Choose for me</SelectItem>{cols.map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}</SelectContent></Select></div>
                <div><Label htmlFor="b-y">Height shows</Label><Select value={spec.chart.y?.[0] ?? "auto"} onValueChange={(v) => patch({ chart: { ...spec.chart!, y: v === "auto" ? undefined : [v] } })}><SelectTrigger id="b-y"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="auto">Choose for me</SelectItem>{[...nums, ...(group.length ? [{ key: "count", label: "Number of rows" }] : [])].map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}</SelectContent></Select></div></>}
              <div className="space-y-1"><label className="flex items-center gap-2 text-sm"><Checkbox checked={!!spec.pivot} onCheckedChange={(v) => patch({ pivot: v ? { row: texts[0]?.key ?? "", col: texts[1]?.key ?? texts[0]?.key ?? "", value: nums[0]?.key ?? "count", agg: "sum" } : undefined })} /> Pivot (rows by columns)</label>
                {spec.pivot && <div className="grid grid-cols-3 gap-1">{(["row", "col", "value"] as const).map((k) => <Select key={k} value={spec.pivot![k]} onValueChange={(v) => patch({ pivot: { ...spec.pivot!, [k]: v } })}><SelectTrigger className="h-8 text-xs" aria-label={`Pivot ${k}`}><SelectValue /></SelectTrigger><SelectContent>{(k === "value" ? [...nums, { key: "count", label: "Number of rows" }] : cols).map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}</SelectContent></Select>)}</div>}</div>
            </section>
          </div>
          <div className="min-w-0">
            {state.error && <ErrorState error={state.error} className="mb-3" />}
            {!state.data ? (state.loading ? <LoadingState /> : <p className="text-sm text-muted-foreground">Pick data to see a preview.</p>) : <div className={state.loading ? "opacity-60" : ""} aria-busy={state.loading}><ReportView result={state.data} tableId="builder-preview" /></div>}
          </div>
        </div>)}
    </>
  );
}

export default function BuilderPage() { return <Suspense fallback={<LoadingState />}><Builder /></Suspense>; }
