"use client";
import { ArrowDownRight, ArrowUpRight, Info } from "lucide-react";
import { useMemo, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { DataTable, type Col } from "@/components/portal/data-table";
import { ReportChart, type RCol, type RResult } from "@/components/portal/report-chart";
import { StatusBadge } from "@/components/portal/parts";
import { EmptyState } from "@/components/portal/states";
import { apiSend } from "@/lib/api";
import { plainMoney, useFmt, type Fmt } from "@/lib/portal/format";

type Row = Record<string, unknown>;
const BAD = /^(expired|overdue|over|failed|late|defect|fail|sell|disputed|open|not done|over 90 days late|61-90 days late)/i;
const WARN = /^(expiring|due_soon|warning|31-60 days late|1-30 days late|repair|pending|draft|not due yet)/i;
const GOOD = /^(ok|valid|passed|paid|done|keep|approved|yes|closed|resolved|active|completed)$/i;
const isFlag = (c: RCol) => c.type === "text" && /^(status|state|result|advice|serviceState|bucket|onTime)$/i.test(c.key);

export function cellText(v: unknown, c: RCol, fmt: Fmt): string {
  if (v == null || v === "") return "—";
  if (c.type === "money" && typeof v === "number") return fmt.money(v);
  if (c.type === "pct" && typeof v === "number") return `${fmt.num(v, 1)}%`;
  if (c.type === "num" && typeof v === "number") return fmt.num(v, 2);
  if (c.type === "date" && typeof v === "string") return fmt.date(v);
  if (c.type === "ts") return fmt.dateTime(String(v));
  return String(v);
}

/** The rows of a result as a table: money with the currency, dates in the company's time zone, status words as badges. */
export function ResultTable({ result, onNumber, id }: { result: RResult; onNumber?: (row: Row, col: RCol) => void; id: string }) {
  const fmt = useFmt();
  const group = result.spec.groupBy ?? [];
  const columns = useMemo<Col<Row>[]>(() => result.columns.map((c) => ({
    id: c.key, accessorFn: (r) => r[c.key] as never, header: c.label,
    cell: ({ row: { original: r } }) => {
      const v = r[c.key]; const text = cellText(v, c, fmt);
      if (isFlag(c) && typeof v === "string" && v) return <StatusBadge tone={BAD.test(v) ? "bad" : WARN.test(v) ? "warn" : GOOD.test(v) ? "good" : "neutral"}>{v.replace("_", " ")}</StatusBadge>;
      const before = result.previous?.byKey[group.map((g) => String(r[g] ?? "")).join("|")]?.[c.key];
      const delta = typeof v === "number" && typeof before === "number" && before !== 0 ? ((v - before) / Math.abs(before)) * 100 : null;
      const body = onNumber && typeof v === "number" && group.length ? <button type="button" className="underline-offset-4 hover:underline focus-visible:underline" title="Open the rows behind this number" onClick={(e) => { e.stopPropagation(); onNumber(r, c); }}>{text}</button> : text;
      return <span>{body}{delta != null && <span className="ml-1 text-xs text-muted-foreground" title={`Before: ${cellText(before, c, fmt)}`}>{delta >= 0 ? "▲" : "▼"}{Math.abs(delta).toFixed(0)}%</span>}</span>;
    },
    meta: { label: c.type === "money" ? `${c.label} (${result.currency})` : c.label, align: ["num", "pct", "money"].includes(c.type) ? "end" as const : undefined, xtype: ["num", "pct", "money"].includes(c.type) ? "num" as const : c.type === "date" ? "date" as const : "text" as const, csv: (r: Row) => (c.type === "money" && typeof r[c.key] === "number" ? plainMoney(r[c.key] as number) : (r[c.key] as string | number | null)) },
  })), [result, fmt, group, onNumber]);
  return (
    <DataTable id={id} data={result.rows} loading={false} error={null} columns={columns} rowId={(r) => JSON.stringify(result.columns.map((c) => r[c.key])) + String(result.rows.indexOf(r))} searchText={(r) => result.columns.map((c) => String(r[c.key] ?? "")).join(" ")} selectable={false} exportName={result.name}
      empty={{ title: "Nothing to show for these dates", description: "Try a wider date range at the top, or remove a filter. " + (result.region ? "You only see your own region." : "") }} />
  );
}

function Totals({ result }: { result: RResult }) {
  const fmt = useFmt();
  const cols = result.columns.filter((c) => ["num", "money"].includes(c.type) && result.totals[c.key] != null && c.key !== "count" && !c.calc).slice(0, 5);
  if (!cols.length || !result.rows.length) return null;
  return (
    <dl className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3 lg:grid-cols-5" aria-label="Totals">{cols.map((c) => {
      const now = result.totals[c.key] as number, before = result.previous?.totals[c.key];
      const d = before != null && before !== 0 ? ((now - before) / Math.abs(before)) * 100 : null;
      return <div key={c.key}><dt className="text-xs text-muted-foreground">Total {c.label.toLowerCase()}</dt><dd className="text-lg font-semibold tabular-nums">{cellText(now, c, fmt)}</dd>
        {result.previous && <p className="flex items-center gap-1 text-xs text-muted-foreground">{d == null ? "no change figure" : <>{d >= 0 ? <ArrowUpRight className="size-3" /> : <ArrowDownRight className="size-3" />}{Math.abs(d).toFixed(1)}%</>} vs {cellText(before ?? 0, c, fmt)}</p>}</div>;
    })}</dl>
  );
}

/** The result of a report: how it was made, totals, chart and table. The same view is used by the ready-made reports and the builder preview. */
export function ReportView({ result, tableId }: { result: RResult; tableId: string }) {
  const fmt = useFmt();
  const [drill, setDrill] = useState<{ title: string; result: RResult } | null>(null);
  const [drillErr, setDrillErr] = useState<string | null>(null);
  const group = result.spec.groupBy ?? [];
  async function open(row: Row) {
    const d = result.meta?.drill; if (!d) return; setDrillErr(null);
    try {
      const filters = Object.entries(d.map).filter(([k]) => k in row).map(([k, to]) => ({ key: to, op: "eq", value: row[k] }));
      const r = await apiSend<RResult>("POST", "/portal/reports/run", { spec: { dataset: d.dataset, filters }, from: result.range.from, to: result.range.to });
      setDrill({ title: group.map((g) => String(row[g] ?? "(none)")).join(" · "), result: { ...r, spec: { ...r.spec, chart: { type: "table" } }, name: `${result.name} - ${group.map((g) => String(row[g] ?? "")).join(" ")}` } });
    } catch (e) { setDrillErr(e instanceof Error ? e.message : "Could not open the rows"); }
  }
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>Dates: {fmt.date(result.range.from)} to {fmt.date(result.range.to)}</span>
        <span>Last updated: {fmt.dateTime(result.generatedAt)}</span>
        <span>Amounts in {result.currency}</span>
        {result.previous && <span>Compared with {result.previous.kind}: {fmt.date(result.previous.range.from)} to {fmt.date(result.previous.range.to)}</span>}
        {result.region && <StatusBadge tone="info">Your region only</StatusBadge>}
      </div>
      <p className="text-xs text-muted-foreground">Filters: {result.filters.length ? result.filters.join("; ") : "none"}</p>
      {result.meta?.fixedRange && <p className="flex items-center gap-2 rounded-md border bg-muted/40 p-2 text-xs"><Info className="size-4 shrink-0" /> The dates at the top do not change this report. It looks at the fleet as it is today, a whole life, one month or the future.</p>}
      {result.meta?.status === "partial" && result.meta.note && <p className="flex items-start gap-2 rounded-md border border-warn/40 bg-warn/10 p-2 text-xs text-warn"><Info className="mt-0.5 size-4 shrink-0" /> <span>Not exactly as the spec describes: {result.meta.note}</span></p>}
      {result.meta?.status === "full" && result.meta.note && <p className="text-xs text-muted-foreground">{result.meta.note}</p>}
      {result.truncated && <p className="rounded-md border border-warn/40 bg-warn/10 p-2 text-xs text-warn">Showing the first {fmt.num(result.rows.length)} of {fmt.num(result.total)} rows. Narrow the dates or add a filter to see the rest.</p>}
      {!result.rows.length ? (
        <EmptyState title="This report is empty for these dates">
          {result.filters.length ? "A filter may be hiding everything; try removing one. " : ""}Try a wider date range at the top (for example the last 90 days or this year). {result.region ? "You only see your own region." : "If you expected rows, check that trips, expenses or pay have been added for these dates."}
        </EmptyState>
      ) : (<>
        <Totals result={result} />
        <ReportChart result={result} />
        {drillErr && <p role="alert" className="text-sm text-destructive">{drillErr}</p>}
        <ResultTable result={result} id={tableId} onNumber={result.meta?.drill && group.length ? (row) => void open(row) : undefined} />
        {result.meta?.drill && group.length > 0 && <p className="text-xs text-muted-foreground">Click a number in a row to open the rows behind it.</p>}
      </>)}
      {drill && (
        <Dialog open onOpenChange={(o) => !o && setDrill(null)}><DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-5xl">
          <DialogHeader><DialogTitle>{drill.title}</DialogTitle><DialogDescription>The rows behind this number, for {fmt.date(result.range.from)} to {fmt.date(result.range.to)}.</DialogDescription></DialogHeader>
          <Totals result={drill.result} /><ResultTable result={drill.result} id={`${tableId}-drill`} />
        </DialogContent></Dialog>
      )}
    </div>
  );
}
