"use client";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, Pie, PieChart, Scatter, ScatterChart, XAxis, YAxis, ZAxis } from "recharts";
import { Bars } from "@/components/portal/charts";
import { ChartContainer, ChartLegend, ChartLegendContent, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { useFmt } from "@/lib/portal/format";

export interface RCol { key: string; label: string; type: "text" | "num" | "date" | "ts" | "bool" | "pct" | "money"; calc?: boolean; agg?: string }
export interface RResult {
  id?: string | null; name: string; dataset: string; range: { from: string; to: string }; columns: RCol[]; rows: Record<string, unknown>[]; total: number; truncated: boolean; totals: Record<string, number | null>;
  pivot?: { columns: string[]; rows: { name: string; cells: (number | null)[]; total: number | null }[]; totals: (number | null)[]; grand: number | null };
  spec: { dataset: string; groupBy?: string[]; chart?: { type: string; x?: string; y?: string[]; series?: string; bucket?: "month" }; columns?: { key: string }[]; filters?: unknown[] };
  currency: string; generatedAt: string; filters: string[]; region: boolean;
  previous: { kind: string; range: { from: string; to: string }; totals: Record<string, number | null>; byKey: Record<string, Record<string, number | null>> } | null;
  meta: { status: "full" | "partial"; note: string | null; specChart: string; drill: { dataset: string; map: Record<string, string> } | null; fixedRange: boolean; groupBy: string[] | null; question: string } | null;
}

const PALETTE = ["var(--info)", "var(--warn)", "var(--ok)", "var(--danger)", "#7c5cd6", "#0e9aa7", "#b5651d", "#6b7280"];
const isNum = (t: string) => t === "num" || t === "pct" || t === "money";
const isDay = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}(-\d{2})?/.test(v);

interface Series { key: string; label: string; color: string; money: boolean }
export interface Prepared { x: string; xLabel: string; data: Record<string, string | number | null>[]; series: Series[] }

/** Turn a result into points for a chart: bucket dates by month if asked, add up rows that share an x value (or average a column that is an average), and spread a series column into separate lines or bars. */
export function prepare(r: RResult): Prepared | null {
  const c = r.spec.chart; if (!c || c.type === "table" || c.type === "heat" || c.type === "map") return null;
  const cols = r.columns;
  const xKey = c.x && (cols.some((k) => k.key === c.x) || c.x === "count") ? c.x : (cols.find((k) => !isNum(k.type)) ?? cols[0])?.key;
  if (!xKey) return null;
  const yKeys = (c.y?.length ? c.y : cols.filter((k) => isNum(k.type) && k.key !== xKey).slice(0, 3).map((k) => k.key));
  if (!yKeys.length) return null;
  const col = (k: string) => cols.find((x) => x.key === k);
  const bucket = (v: unknown) => (c.bucket === "month" && isDay(v) ? String(v).slice(0, 7) : v == null || v === "" ? "(none)" : String(v));
  const names: string[] = []; const spread = c.series && cols.some((k) => k.key === c.series) ? c.series : null;
  const groups = new Map<string, { x: string; sums: Record<string, number>; n: Record<string, number> }>();
  for (const row of r.rows) {
    const x = bucket(row[xKey]); const sName = spread ? String(row[spread] ?? "(none)") : null;
    if (sName && !names.includes(sName)) names.push(sName);
    if (!groups.has(x)) groups.set(x, { x, sums: {}, n: {} });
    const g = groups.get(x)!;
    for (const y of yKeys) {
      const raw = y === "count" && row.count == null ? 1 : row[y]; const v = typeof raw === "number" ? raw : null; if (v == null) continue;
      const id = spread ? `${y}\u0001${sName}` : y;
      g.sums[id] = (g.sums[id] ?? 0) + v; g.n[id] = (g.n[id] ?? 0) + 1;
    }
  }
  const series: Series[] = spread
    ? names.flatMap((n, i) => yKeys.map((y, j) => ({ key: `${y}\u0001${n}`, label: yKeys.length > 1 ? `${n} · ${col(y)?.label ?? y}` : n, color: PALETTE[(i * yKeys.length + j) % PALETTE.length]!, money: col(y)?.type === "money" })))
    : yKeys.map((y, i) => ({ key: y, label: col(y)?.label ?? (y === "count" ? "Count" : y), color: PALETTE[i % PALETTE.length]!, money: col(y)?.type === "money" }));
  let xs = [...groups.values()];
  if (xs.every((g) => isDay(g.x)) || c.type === "line" || c.type === "area") xs = xs.sort((a, b) => a.x.localeCompare(b.x, undefined, { numeric: true }));
  const data = xs.map((g) => {
    const o: Record<string, string | number | null> = { x: g.x };
    series.forEach((s, i) => {
      const base = s.key.split("\u0001")[0]!; const isAvg = col(base)?.agg === "avg" || col(base)?.type === "pct";
      o[`k${i}`] = g.sums[s.key] == null ? null : isAvg ? Math.round((g.sums[s.key]! / (g.n[s.key] ?? 1)) * 100) / 100 : Math.round(g.sums[s.key]! * 100) / 100;
    });
    return o;
  });
  return { x: xKey, xLabel: col(xKey)?.label ?? xKey, data, series };
}

/** The chart for a report: bar, stacked bar, line, area, pie or donut, scatter, waterfall, funnel or heat map (a table of coloured squares). */
export function ReportChart({ result }: { result: RResult }) {
  const fmt = useFmt();
  const t = result.spec.chart?.type ?? "table";
  if (t === "heat") return <Heat result={result} />;
  if (t === "map") return <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Map charts are not drawn yet. The table below has the rows.</p>;
  const p = prepare(result);
  if (!p || !p.data.length) return null;
  const cfg: ChartConfig = Object.fromEntries(p.series.map((s, i) => [`k${i}`, { label: s.label, color: s.color }]));
  const money = p.series.every((s) => s.money);
  const val = (v: unknown, s?: Series) => (typeof v !== "number" ? "—" : (s?.money ?? money) ? fmt.money(v) : fmt.num(v, 2));
  const axis = (v: number) => (money ? fmt.moneyShort(v) : fmt.num(v));
  const tip = <ChartTooltipContent formatter={(v: unknown, name: unknown) => { const s = p.series.find((x, i) => `k${i}` === name); return <span className="flex w-full justify-between gap-4"><span>{s?.label ?? String(name)}</span><span className="font-mono tabular-nums">{val(v, s)}</span></span>; }} />;
  const xTick = (v: string) => (isDay(v) && v.length === 10 ? fmt.date(v).replace(/,? \d{4}$/, "") : v.length > 14 ? `${v.slice(0, 13)}…` : v);

  if (t === "donut" || t === "pie") {
    const total = p.data.reduce((a, d) => a + Number(d.k0 ?? 0), 0);
    return (
      <div className="grid items-center gap-4 sm:grid-cols-2">
        <ChartContainer config={cfg} className="mx-auto h-56 w-full max-w-xs"><PieChart><ChartTooltip content={tip} /><Pie data={p.data.map((d, i) => ({ ...d, name: d.x, fill: PALETTE[i % PALETTE.length] }))} dataKey="k0" nameKey="x" innerRadius={t === "donut" ? 55 : 0} strokeWidth={2}>{p.data.map((_, i) => <Cell key={i} fill={PALETTE[i % PALETTE.length]} />)}</Pie></PieChart></ChartContainer>
        <ul className="space-y-1 text-sm">{p.data.map((d, i) => <li key={String(d.x)} className="flex items-center justify-between gap-2"><span className="flex items-center gap-2"><span className="size-3 rounded-sm" style={{ background: PALETTE[i % PALETTE.length] }} aria-hidden />{String(d.x)}</span><span className="tabular-nums">{val(d.k0, p.series[0])}{total > 0 ? ` · ${Math.round((Number(d.k0 ?? 0) / total) * 100)}%` : ""}</span></li>)}</ul>
      </div>
    );
  }
  if (t === "funnel") {
    const top = Math.max(1, ...p.data.map((d) => Number(d.k0 ?? 0)));
    return <Bars format={(n) => fmt.num(n)} rows={p.data.map((d) => ({ label: String(d.x), value: Number(d.k0 ?? 0), note: `${Math.round((Number(d.k0 ?? 0) / top) * 100)}% of the first step` }))} />;
  }
  if (t === "waterfall") {
    let run = 0;
    const rows = p.data.map((d, i) => {
      const v = Number(d.k0 ?? 0); const last = i === p.data.length - 1;
      if (last) return { x: d.x, base: Math.min(0, v), up: v >= 0 ? v : 0, down: v < 0 ? -v : 0, total: true };
      const start = run; run += v; return { x: d.x, base: Math.min(start, run), up: v >= 0 ? v : 0, down: v < 0 ? -v : 0, total: false };
    });
    return (
      <ChartContainer config={{ up: { label: "Up", color: "var(--ok)" }, down: { label: "Down", color: "var(--danger)" } }} className="h-64 w-full">
        <BarChart data={rows} margin={{ left: 4, right: 8, top: 8 }}><CartesianGrid vertical={false} /><XAxis dataKey="x" tickLine={false} axisLine={false} tickFormatter={xTick} interval={0} /><YAxis tickFormatter={axis} width={64} tickLine={false} axisLine={false} />
          <ChartTooltip content={<ChartTooltipContent formatter={(v: unknown, name: unknown) => (name === "base" ? null : <span className="flex w-full justify-between gap-4"><span>{name === "up" ? "Adds" : "Takes away"}</span><span className="font-mono tabular-nums">{val(v)}</span></span>)} />} />
          <Bar dataKey="base" stackId="w" fill="transparent" /><Bar dataKey="up" stackId="w" fill="var(--ok)" radius={2} /><Bar dataKey="down" stackId="w" fill="var(--danger)" radius={2} /></BarChart>
      </ChartContainer>
    );
  }
  if (t === "scatter") {
    const yk = result.spec.chart?.y?.[0]; const xc = result.columns.find((c) => c.key === p.x); const yc = result.columns.find((c) => c.key === yk);
    const pts = result.rows.map((r) => ({ x: Number(r[p.x]), y: Number(r[yk ?? ""]), name: String(r[result.columns.find((c) => c.type === "text")?.key ?? ""] ?? "") })).filter((q) => Number.isFinite(q.x) && Number.isFinite(q.y));
    return (
      <ChartContainer config={{ y: { label: yc?.label ?? "", color: "var(--info)" } }} className="h-64 w-full">
        <ScatterChart margin={{ left: 4, right: 8, top: 8 }}><CartesianGrid /><XAxis type="number" dataKey="x" name={xc?.label} tickLine={false} /><YAxis type="number" dataKey="y" name={yc?.label} width={64} tickFormatter={(v: number) => (yc?.type === "money" ? fmt.moneyShort(v) : fmt.num(v))} tickLine={false} /><ZAxis range={[60, 60]} />
          <ChartTooltip cursor={{ strokeDasharray: "3 3" }} content={({ payload }) => { const d = payload?.[0]?.payload as { name: string; x: number; y: number } | undefined; return d ? <div className="rounded-md border bg-background px-2 py-1 text-xs shadow"><p className="font-medium">{d.name}</p><p>{xc?.label}: {fmt.num(d.x, 1)}</p><p>{yc?.label}: {yc?.type === "money" ? fmt.money(d.y) : fmt.num(d.y, 1)}</p></div> : null; }} />
          <Scatter data={pts} fill="var(--info)" /></ScatterChart>
      </ChartContainer>
    );
  }
  const many = p.data.length > 8 && (t === "bar" || t === "stacked") && !p.data.every((d) => isDay(String(d.x)));
  if (many) {
    return (
      <ChartContainer config={cfg} className="w-full" style={{ height: Math.min(640, 40 + p.data.length * (p.series.length > 1 ? 34 : 24)) }}>
        <BarChart data={p.data} layout="vertical" margin={{ left: 4, right: 16 }}><CartesianGrid horizontal={false} /><YAxis dataKey="x" type="category" width={120} tickLine={false} axisLine={false} tickFormatter={xTick} interval={0} /><XAxis type="number" tickFormatter={axis} tickLine={false} axisLine={false} /><ChartTooltip content={tip} />
          {p.series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}{p.series.map((s, i) => <Bar key={s.key} dataKey={`k${i}`} stackId={t === "stacked" ? "a" : undefined} fill={s.color} radius={2} />)}</BarChart>
      </ChartContainer>
    );
  }
  const Chart = t === "line" ? LineChart : t === "area" ? AreaChart : BarChart;
  return (
    <ChartContainer config={cfg} className="h-64 w-full">
      <Chart data={p.data} margin={{ left: 4, right: 8, top: 8 }}><CartesianGrid vertical={false} /><XAxis dataKey="x" tickLine={false} axisLine={false} tickFormatter={xTick} minTickGap={16} /><YAxis tickFormatter={axis} width={64} tickLine={false} axisLine={false} /><ChartTooltip content={tip} />
        {p.series.length > 1 && <ChartLegend content={<ChartLegendContent />} />}
        {p.series.map((s, i) => t === "line" ? <Line key={s.key} dataKey={`k${i}`} stroke={s.color} strokeWidth={2} dot={p.data.length < 25} type="monotone" connectNulls /> : t === "area" ? <Area key={s.key} dataKey={`k${i}`} stroke={s.color} fill={s.color} fillOpacity={0.15} strokeWidth={2} type="monotone" /> : <Bar key={s.key} dataKey={`k${i}`} stackId={t === "stacked" ? "a" : undefined} fill={s.color} radius={2} />)}
      </Chart>
    </ChartContainer>
  );
}

/** A heat map: rows by columns with the number in each square, darker meaning more. */
function Heat({ result }: { result: RResult }) {
  const fmt = useFmt(); const pv = result.pivot;
  if (!pv || !pv.rows.length) return <p className="rounded-md border border-dashed p-4 text-sm text-muted-foreground">Nothing to draw for these dates.</p>;
  const max = Math.max(1e-9, ...pv.rows.flatMap((r) => r.cells.map((c) => Math.abs(c ?? 0))));
  return (
    <div className="overflow-x-auto"><table className="text-xs" aria-label="Heat map"><thead><tr><th className="p-1 text-left font-medium">&nbsp;</th>{pv.columns.map((c) => <th key={c} scope="col" className="p-1 font-normal text-muted-foreground">{isDay(c) && c.length === 10 ? c.slice(5) : c}</th>)}</tr></thead>
      <tbody>{pv.rows.map((r) => <tr key={r.name}><th scope="row" className="whitespace-nowrap p-1 pr-2 text-left font-medium">{r.name}</th>{r.cells.map((c, i) => <td key={i} title={`${r.name} · ${pv.columns[i]}: ${c ?? 0}`} className="size-7 min-w-7 border border-background text-center tabular-nums" style={{ background: `color-mix(in oklab, var(--info) ${Math.round((Math.abs(c ?? 0) / max) * 85)}%, transparent)` }}>{c ? fmt.num(c, 0) : ""}</td>)}</tr>)}</tbody></table></div>
  );
}
