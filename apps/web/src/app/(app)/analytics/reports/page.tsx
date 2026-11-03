"use client";
import type { MessageKey } from "@routenorth/shared";
import { Copy, Download, Link2, Play, Save, Send, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Chart, ChartTable, type ChartData, type ChartType } from "@/components/charts/Charts";
import { PointsMap } from "@/components/charts/PointsMap";
import { EmptyState, ErrorState, Modal, PageHead, SkeletonList, Tabs } from "@/components/ui/primitives";
import { fmtMetric, wid } from "@/lib/analytics";
import { apiDownload, apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

type Agg = "sum" | "avg" | "count" | "min" | "max";
interface DsCol { key: string; label: string; type: "text" | "num" | "date" | "ts" | "bool" | "pct"; agg?: Agg }
interface Dataset { key: string; label: string; columns: DsCol[] }
interface Spec {
  dataset: string; range?: { from?: string; to?: string; preset?: string };
  filters?: { key: string; op: string; value: unknown }[]; columns?: { key: string; agg?: Agg }[]; groupBy?: string[];
  calc?: { key: string; label?: string; formula: string }[]; sort?: { key: string; dir: "asc" | "desc" } | null; limit?: number;
  chart?: { type: string; x?: string; y?: string[] }; pivot?: { row: string; col: string; value: string; agg?: Agg };
}
interface Result { dataset: string; range: { from: string; to: string }; columns: { key: string; label: string; type: string; calc?: boolean }[]; rows: Record<string, unknown>[]; total: number; truncated: boolean; totals: Record<string, number | null>; pivot?: { rows: string[]; cols: string[]; cells: (number | null)[][]; rowTotals?: number[]; colTotals?: number[] } | null }
interface Template { id: string; playbook: string; spec: Spec }
interface Saved { id: string; name: string; spec: Spec; shared: boolean; version: number; mine: boolean }
interface Endpoint { id: string; label: string; kind: string; enabled: boolean }

const OPS = ["eq", "ne", "gt", "gte", "lt", "lte", "contains"] as const;
const CHARTS = ["table", "bar", "line", "stacked", "pie", "heat", "funnel", "scatter", "map"] as const;
const RANGES = ["yesterday", "last7", "last30", "thisMonth", "lastMonth"] as const;
const BLANK: Spec = { dataset: "stops", range: { preset: "last7" }, chart: { type: "table" } };

export default function ReportBuilderPage() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const { toast } = useToast();
  const datasets = useApi<Dataset[]>("/reports/datasets");
  const templates = useApi<Template[]>("/reports/templates");
  const saved = useApi<Saved[]>("/reports/saved");
  const endpoints = useApi<Endpoint[]>(can("alerts.manage") || can("reports.manage") ? "/r/notification-endpoints" : null);
  const [spec, setSpec] = useState<Spec>(BLANK);
  const [name, setName] = useState("");
  const [current, setCurrent] = useState<Saved | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [err, setErr] = useState<Error | null>(null);
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState("result");
  const [drill, setDrill] = useState<{ label: string; spec: Spec }[]>([]);
  const [dlg, setDlg] = useState<null | "share" | "schedule" | "versions" | "send">(null);

  const ds = datasets.data?.find((d) => d.key === spec.dataset);
  const label = (k: string) => { const key = `an_${k}` as MessageKey; const v = t(key); return v === key ? k : v; };
  const dsLabel = (d: Dataset) => { const key = `an_ds_${d.key.replace(".", "_")}` as MessageKey; const v = t(key); return v === key ? d.label : v; };

  async function run(s: Spec = spec) {
    setBusy(true); setErr(null);
    try { setResult(await apiSend<Result>("POST", "/reports/run", { spec: s })); setView("result"); } catch (e) { setErr(e as Error); } finally { setBusy(false); }
  }
  useEffect(() => { if (datasets.loaded && !result && !err) void run(); }, [datasets.loaded]); // eslint-disable-line react-hooks/exhaustive-deps

  const patch = (p: Partial<Spec>) => setSpec((s) => ({ ...s, ...p }));
  const load = (s: Spec, nm = "", cur: Saved | null = null) => { setSpec(JSON.parse(JSON.stringify(s))); setName(nm); setCurrent(cur); setDrill([]); void run(s); };
  const grouped = (spec.groupBy?.length ?? 0) > 0;
  const chosen = new Set((spec.columns ?? []).map((c) => c.key));

  function toggleCol(k: string) {
    const cols = spec.columns?.length ? spec.columns : (ds?.columns ?? []).filter((c) => c.key !== "count").slice(0, 8).map((c) => ({ key: c.key }));
    patch({ columns: cols.some((c) => c.key === k) ? cols.filter((c) => c.key !== k) : [...cols, { key: k }] });
  }

  // Chart data from the result
  const chartType = (spec.chart?.type ?? "table") as (typeof CHARTS)[number];
  const numericCols = (result?.columns ?? []).filter((c) => c.type === "num" || c.type === "pct");
  const xKey = spec.chart?.x ?? (result?.columns.find((c) => c.type !== "num" && c.type !== "pct")?.key ?? result?.columns[0]?.key ?? "");
  const yKeys = (spec.chart?.y?.length ? spec.chart.y : numericCols.slice(0, 1).map((c) => c.key)).filter((k) => result?.columns.some((c) => c.key === k));
  const chartData: ChartData | null = useMemo(() => {
    if (!result || !xKey) return null;
    const rows = result.rows.slice(0, 200);
    return { labels: rows.map((r) => String(r[xKey] ?? "—")), series: yKeys.map((k) => ({ name: label(k), values: rows.map((r) => (typeof r[k] === "number" ? (r[k] as number) : null)) })) };
  }, [result, xKey, yKeys.join(",")]); // eslint-disable-line react-hooks/exhaustive-deps
  const points = useMemo(() => (result?.rows ?? []).filter((r) => typeof r.lat === "number" && typeof r.lng === "number").map((r) => ({ lat: r.lat as number, lng: r.lng as number, label: String(r[xKey] ?? "") })), [result, xKey]);

  // Drill: click a mark -> filter to it; scorecards open their detail rows
  function drillInto(l: string) {
    const detail: Record<string, [string, string]> = { "scorecard.driver": ["stops", "driver"], "scorecard.vehicle": ["vehicleDays", "vehicle"], "scorecard.route": ["stops", "route"], "scorecard.customer": ["stops", "customer"], "scorecard.day": ["stops", "date"], "scorecard.depot": ["stops", "depot"] };
    const d = detail[spec.dataset];
    const next: Spec = d
      ? { dataset: d[0], range: spec.range, filters: [{ key: d[1], op: "eq", value: l }], chart: { type: "table" } }
      : { ...spec, filters: [...(spec.filters ?? []), { key: xKey, op: "eq", value: l }], groupBy: [], columns: undefined, chart: { type: "table" }, pivot: undefined };
    setDrill((x) => [...x, { label: l, spec }]);
    setSpec(next); void run(next);
  }
  function drillBack(i: number) { const s = drill[i]!.spec; setDrill(drill.slice(0, i)); setSpec(s); void run(s); }

  const money = (n: number) => fmtMetric(n, "$", locale);
  const exportAs = async (f: "csv" | "xlsx" | "pdf") => {
    try {
      const labels = Object.fromEntries((result?.columns ?? []).map((c) => [c.key, c.calc ? c.label : label(c.key)]));
      const res = await apiSend<unknown>("POST", `/reports/export?format=${f}`, { spec, title: name || (ds ? dsLabel(ds) : "report"), labels }).catch(() => null);
      void res;
    } catch { /* replaced below */ }
  };
  void exportAs; void money;

  async function download(f: "csv" | "xlsx" | "pdf") {
    const { loadSession } = await import("@/lib/session");
    const { API_URL } = await import("@/lib/session");
    const s = loadSession();
    if (!s) return;
    const labels = Object.fromEntries((result?.columns ?? []).map((c) => [c.key, c.calc ? c.label : label(c.key)]));
    const r = await fetch(`${API_URL}/reports/export?format=${f}`, { method: "POST", headers: { Authorization: `Bearer ${s.token}`, "content-type": "application/json" }, body: JSON.stringify({ spec, title: name || (ds ? dsLabel(ds) : "report"), labels }) });
    if (!r.ok) { toast(t("rb_exportFailed")); return; }
    const a = document.createElement("a"); a.href = URL.createObjectURL(await r.blob()); a.download = `${(name || "report").replace(/[^\w.-]+/g, "-")}.${f}`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
  }
  void apiDownload;

  async function saveReport(asNew = false) {
    try {
      if (current && !asNew) { const r = await apiSend<{ version: number }>("PUT", `/reports/saved/${current.id}`, { name, spec }); setCurrent({ ...current, name, spec, version: r.version }); toast(t("rb_savedV", { v: r.version })); }
      else {
        const nm = name.trim() || window.prompt(t("rb_namePrompt")) || "";
        if (!nm) return;
        const r = await apiSend<{ id: string; version: number }>("POST", "/reports/saved", { name: nm, spec, shared: false });
        setName(nm); setCurrent({ id: r.id, name: nm, spec, shared: false, version: r.version, mine: true }); toast(t("rb_saved"));
      }
      saved.reload();
    } catch (e) { toast((e as Error).message); }
  }

  const cell = (v: unknown, type: string, key: string) => {
    if (v == null) return "—";
    if (type === "ts" && typeof v === "string") return new Date(v).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" });
    if (typeof v === "number") return /cost|amount|price/i.test(key) ? money(v) : new Intl.NumberFormat(locale === "fr" ? "fr-CA" : "en-CA", { maximumFractionDigits: 2 }).format(v);
    return String(v);
  };

  return (
    <div className="content">
      <PageHead title={t("rb_title")} subtitle={t("rb_subtitle")} actions={(
        <>
          <button className="btn primary" onClick={() => void run()} disabled={busy}><Play size={16} /> {t("rb_run")}</button>
          {can("reports.manage") && <button className="btn" onClick={() => void saveReport()}><Save size={16} /> {current ? t("rb_saveVersion") : t("save")}</button>}
          {can("reports.manage") && current && <button className="btn" onClick={() => void saveReport(true)}><Copy size={16} /> {t("rb_saveCopy")}</button>}
        </>
      )} />
      <div className="row">
        <label className="field">{t("rb_template")}
          <select value="" onChange={(e) => { const tp = templates.data?.find((x) => x.id === e.target.value); if (tp) load(tp.spec, t(`rb_t_${tp.id}` as MessageKey)); }}>
            <option value="">{t("rb_pickTemplate")}</option>
            {(templates.data ?? []).map((x) => <option key={x.id} value={x.id}>{t(`rb_t_${x.id}` as MessageKey)}</option>)}
          </select>
        </label>
        <label className="field">{t("rb_saved")}
          <select value={current?.id ?? ""} onChange={(e) => { const s = saved.data?.find((x) => x.id === e.target.value); if (s) load(s.spec, s.name, s); else { setCurrent(null); } }}>
            <option value="">{t("rb_pickSaved")}</option>
            {(saved.data ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
          </select>
        </label>
        <label className="field grow">{t("rb_name")}<input value={name} onChange={(e) => setName(e.target.value)} maxLength={120} /></label>
        <button className="btn" onClick={() => load(BLANK)}>{t("rb_new")}</button>
      </div>

      <div className="builder">
        <aside className="builder-side" aria-label={t("rb_settings")}>
          <fieldset><legend>{t("rb_data")}</legend>
            <label className="field">{t("rb_dataset")}<select value={spec.dataset} onChange={(e) => setSpec({ dataset: e.target.value, range: spec.range, chart: { type: "table" } })}>{(datasets.data ?? []).map((d) => <option key={d.key} value={d.key}>{dsLabel(d)}</option>)}</select></label>
            <label className="field">{t("dash_period")}<select value={spec.range?.from ? "custom" : spec.range?.preset ?? "last7"} onChange={(e) => patch({ range: e.target.value === "custom" ? { from: spec.range?.from ?? new Date().toISOString().slice(0, 10), to: spec.range?.to ?? new Date().toISOString().slice(0, 10) } : { preset: e.target.value } })}>
              {RANGES.map((r) => <option key={r} value={r}>{t(`rb_r_${r}` as MessageKey)}</option>)}<option value="custom">{t("dash_p_custom")}</option></select></label>
            {spec.range?.from && <div className="row"><input type="date" aria-label={t("from")} value={spec.range.from} onChange={(e) => patch({ range: { ...spec.range, from: e.target.value } })} /><input type="date" aria-label={t("to")} value={spec.range.to ?? ""} onChange={(e) => patch({ range: { ...spec.range, to: e.target.value } })} /></div>}
          </fieldset>

          <fieldset><legend>{t("rb_columns")}</legend>
            <div className="colpick">{(ds?.columns ?? []).filter((c) => c.key !== "count").map((c) => (
              <label key={c.key} className="check"><input type="checkbox" checked={spec.columns?.length ? chosen.has(c.key) : false} onChange={() => toggleCol(c.key)} /> {label(c.key)}</label>
            ))}</div>
            <p className="meta small">{spec.columns?.length ? t("rb_colsChosen", { n: spec.columns.length }) : t("rb_colsAll")}</p>
          </fieldset>

          <fieldset><legend>{t("rb_filters")}</legend>
            {(spec.filters ?? []).map((f, i) => (
              <div key={i} className="row">
                <select aria-label={t("rb_column")} value={f.key} onChange={(e) => patch({ filters: spec.filters!.map((x, j) => (j === i ? { ...x, key: e.target.value } : x)) })}>{(ds?.columns ?? []).map((c) => <option key={c.key} value={c.key}>{label(c.key)}</option>)}</select>
                <select aria-label={t("rb_operator")} value={f.op} onChange={(e) => patch({ filters: spec.filters!.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)) })}>{OPS.map((o) => <option key={o} value={o}>{t(`op_${o}` as MessageKey)}</option>)}</select>
                <input aria-label={t("rb_value")} value={String(f.value ?? "")} onChange={(e) => patch({ filters: spec.filters!.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)) })} />
                <button className="icon-btn" aria-label={t("dash_remove")} onClick={() => patch({ filters: spec.filters!.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
              </div>
            ))}
            <button className="btn" onClick={() => patch({ filters: [...(spec.filters ?? []), { key: ds?.columns[0]?.key ?? "date", op: "eq", value: "" }] })}>{t("rb_addFilter")}</button>
          </fieldset>

          <fieldset><legend>{t("rb_group")}</legend>
            {[0, 1].map((i) => (
              <select key={i} aria-label={t("rb_groupBy", { n: i + 1 })} value={spec.groupBy?.[i] ?? ""} onChange={(e) => { const g = [...(spec.groupBy ?? [])]; if (e.target.value) g[i] = e.target.value; else g.splice(i); patch({ groupBy: g.filter(Boolean) }); }}>
                <option value="">{i === 0 ? t("rb_noGroup") : t("rb_thenBy")}</option>{(ds?.columns ?? []).filter((c) => c.type === "text" || c.type === "date").map((c) => <option key={c.key} value={c.key}>{label(c.key)}</option>)}
              </select>
            ))}
            {grouped && <p className="meta small">{t("rb_groupHint")}</p>}
            {grouped && (spec.columns ?? []).filter((c) => (ds?.columns.find((d) => d.key === c.key)?.type === "num")).map((c) => (
              <label key={c.key} className="field">{label(c.key)}<select value={c.agg ?? ds?.columns.find((d) => d.key === c.key)?.agg ?? "sum"} onChange={(e) => patch({ columns: spec.columns!.map((x) => (x.key === c.key ? { ...x, agg: e.target.value as Agg } : x)) })}>{["sum", "avg", "count", "min", "max"].map((a) => <option key={a} value={a}>{t(`agg_${a}` as MessageKey)}</option>)}</select></label>
            ))}
          </fieldset>

          <fieldset><legend>{t("rb_calc")}</legend>
            {(spec.calc ?? []).map((c, i) => (
              <div key={i} className="row">
                <input aria-label={t("rb_calcName")} placeholder={t("rb_calcName")} value={c.key} onChange={(e) => patch({ calc: spec.calc!.map((x, j) => (j === i ? { ...x, key: e.target.value.replace(/[^A-Za-z0-9_]/g, ""), label: e.target.value } : x)) })} />
                <input aria-label={t("rb_formula")} placeholder="cost / stops" value={c.formula} onChange={(e) => patch({ calc: spec.calc!.map((x, j) => (j === i ? { ...x, formula: e.target.value } : x)) })} />
                <button className="icon-btn" aria-label={t("dash_remove")} onClick={() => patch({ calc: spec.calc!.filter((_, j) => j !== i) })}><Trash2 size={14} /></button>
              </div>
            ))}
            <button className="btn" onClick={() => patch({ calc: [...(spec.calc ?? []), { key: `field${(spec.calc?.length ?? 0) + 1}`, formula: "" }] })}>{t("rb_addCalc")}</button>
            <p className="meta small">{t("rb_calcHint")}</p>
          </fieldset>

          <fieldset><legend>{t("rb_sort")}</legend>
            <div className="row">
              <select aria-label={t("rb_column")} value={spec.sort?.key ?? ""} onChange={(e) => patch({ sort: e.target.value ? { key: e.target.value, dir: spec.sort?.dir ?? "desc" } : null })}>
                <option value="">{t("rb_noSort")}</option>{(result?.columns ?? ds?.columns ?? []).map((c) => <option key={c.key} value={c.key}>{(c as { calc?: boolean }).calc ? (c as { label: string }).label : label(c.key)}</option>)}
              </select>
              <select aria-label={t("rb_direction")} value={spec.sort?.dir ?? "desc"} disabled={!spec.sort} onChange={(e) => patch({ sort: spec.sort ? { ...spec.sort, dir: e.target.value as "asc" | "desc" } : null })}><option value="asc">{t("rb_asc")}</option><option value="desc">{t("rb_desc")}</option></select>
            </div>
          </fieldset>

          <fieldset><legend>{t("rb_chart")}</legend>
            <label className="field">{t("rb_chartType")}<select value={chartType} onChange={(e) => patch({ chart: { ...spec.chart, type: e.target.value } })}>{CHARTS.map((c) => <option key={c} value={c}>{t(`ch_${c}` as MessageKey)}</option>)}</select></label>
            {!["table", "map"].includes(chartType) && <>
              <label className="field">{t("rb_xAxis")}<select value={xKey} onChange={(e) => patch({ chart: { type: chartType, ...spec.chart, x: e.target.value } })}>{(result?.columns ?? []).map((c) => <option key={c.key} value={c.key}>{c.calc ? c.label : label(c.key)}</option>)}</select></label>
              <label className="field">{t("rb_yAxis")}<select multiple size={4} value={yKeys} onChange={(e) => patch({ chart: { type: chartType, ...spec.chart, y: [...e.target.selectedOptions].map((o) => o.value) } })}>{numericCols.map((c) => <option key={c.key} value={c.key}>{c.calc ? c.label : label(c.key)}</option>)}</select></label>
            </>}
          </fieldset>

          <fieldset><legend>{t("rb_pivot")}</legend>
            <label className="check"><input type="checkbox" checked={!!spec.pivot} onChange={(e) => patch({ pivot: e.target.checked ? { row: ds?.columns.find((c) => c.type === "text")?.key ?? "driver", col: "date", value: "count", agg: "sum" } : undefined })} /> {t("rb_usePivot")}</label>
            {spec.pivot && <>
              {(["row", "col", "value"] as const).map((k) => (
                <label key={k} className="field">{t(`rb_pivot_${k}` as MessageKey)}<select value={spec.pivot![k]} onChange={(e) => patch({ pivot: { ...spec.pivot!, [k]: e.target.value } })}>{(ds?.columns ?? []).filter((c) => k === "value" ? c.type === "num" || c.type === "pct" : true).map((c) => <option key={c.key} value={c.key}>{label(c.key)}</option>)}</select></label>
              ))}
              <label className="field">{t("rb_agg")}<select value={spec.pivot.agg ?? "sum"} onChange={(e) => patch({ pivot: { ...spec.pivot!, agg: e.target.value as Agg } })}>{["sum", "avg", "count", "min", "max"].map((a) => <option key={a} value={a}>{t(`agg_${a}` as MessageKey)}</option>)}</select></label>
            </>}
          </fieldset>
        </aside>

        <section aria-live="polite">
          {drill.length > 0 && (
            <nav className="row" aria-label={t("rb_drillPath")}>
              {drill.map((d, i) => <button key={i} className="linklike" onClick={() => drillBack(i)}>← {d.label}</button>)}
            </nav>
          )}
          <div className="row">
            <Tabs label={t("rb_views")} value={view} onChange={setView} tabs={[{ id: "result", label: t("rb_result") }, ...(result?.pivot ? [{ id: "pivot", label: t("rb_pivot") }] : []), { id: "table", label: t("rb_tableView") }]} />
            <span className="nav-spacer" />
            <button className="btn" onClick={() => void download("csv")}><Download size={15} /> CSV</button>
            <button className="btn" onClick={() => void download("xlsx")}><Download size={15} /> Excel</button>
            <button className="btn" onClick={() => void download("pdf")}><Download size={15} /> PDF</button>
            {current && can("reports.manage") && <>
              <button className="btn" onClick={() => setDlg("share")}><Link2 size={15} /> {t("rb_share")}</button>
              <button className="btn" onClick={() => setDlg("schedule")}><Send size={15} /> {t("rb_schedule")}</button>
              <button className="btn" onClick={() => setDlg("versions")}>{t("rb_history", { v: current.version })}</button>
            </>}
          </div>
          {err ? <ErrorState error={err} onRetry={() => void run()} /> : !result ? <SkeletonList rows={6} h={34} /> : (
            <>
              <p className="meta">{t("rb_summary", { n: result.total, from: result.range.from, to: result.range.to })}{result.truncated ? ` · ${t("rb_truncated")}` : ""}</p>
              {view === "result" && chartType !== "table" && (chartType === "map"
                ? (points.length ? <PointsMap points={points} ariaLabel={t("ch_map")} /> : <EmptyState title={t("rb_noPoints")} body={t("rb_noPointsBody")} />)
                : chartData && <Chart type={chartType as ChartType} data={chartData} ariaLabel={name || t("rb_chart")} onPick={(l) => drillInto(l)} />)}
              {view === "pivot" && result.pivot && (
                <div className="dt-scroll"><table className="plain pivot"><thead><tr><th />{result.pivot.cols.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{result.pivot.rows.map((r, i) => <tr key={r}><th scope="row">{r}</th>{result.pivot!.cells[i]!.map((v, j) => <td key={j} className="mono-num">{v == null ? "—" : Math.round(v * 100) / 100}</td>)}</tr>)}</tbody></table></div>
              )}
              {(view === "table" || (view === "result" && chartType === "table")) && (result.rows.length === 0 ? <EmptyState title={t("noData")} /> : (
                <div className="dt-scroll" style={{ maxHeight: "60vh" }}><table className="plain">
                  <thead><tr>{result.columns.map((c) => <th key={c.key} style={{ textAlign: c.type === "num" || c.type === "pct" ? "right" : "left" }}>{c.calc ? c.label : label(c.key)}</th>)}</tr></thead>
                  <tbody>
                    {result.rows.slice(0, 500).map((r, i) => (
                      <tr key={i}>{result.columns.map((c, k) => (
                        <td key={c.key} className={c.type === "num" || c.type === "pct" ? "mono-num" : ""} style={{ textAlign: c.type === "num" || c.type === "pct" ? "right" : "left" }}>
                          {k === 0 && (grouped || spec.dataset.startsWith("scorecard")) ? <button className="linklike" onClick={() => drillInto(String(r[c.key] ?? ""))}>{cell(r[c.key], c.type, c.key)}</button> : cell(r[c.key], c.type, c.key)}
                        </td>
                      ))}</tr>
                    ))}
                    {grouped && <tr className="median">{result.columns.map((c, k) => <th key={c.key} style={{ textAlign: k === 0 ? "left" : "right" }}>{k === 0 ? t("rb_totals") : result.totals[c.key] != null ? cell(result.totals[c.key], c.type, c.key) : ""}</th>)}</tr>}
                  </tbody>
                </table></div>
              ))}
              {view === "result" && chartType !== "table" && chartType !== "map" && chartData && <details><summary>{t("dash_showTable")}</summary><ChartTable data={chartData} /></details>}
            </>
          )}
        </section>
      </div>

      {current && dlg === "share" && <ShareDialog id={current.id} onClose={() => setDlg(null)} />}
      {current && dlg === "schedule" && <ScheduleDialog id={current.id} endpoints={endpoints.data ?? []} onClose={() => setDlg(null)} />}
      {current && dlg === "versions" && <VersionsDialog id={current.id} onClose={() => setDlg(null)} onRestore={(s) => { setDlg(null); saved.reload(); void apiSend<{ version: number }>("POST", `/reports/saved/${current.id}/restore/${s}`).then((r) => { setCurrent({ ...current, version: r.version }); return apiSend<Saved[]>("POST", "/reports/run", { spec }).catch(() => null); }).then(() => saved.reload()); }} />}
    </div>
  );
}

function ShareDialog({ id, onClose }: { id: string; onClose: () => void }) {
  const { t } = useI18n();
  const [days, setDays] = useState(7);
  const [link, setLink] = useState<{ path: string; csvPath: string; expiresAt: string } | null>(null);
  const shares = useApi<{ id: string; name: string; expiresAt: string; revokedAt: string | null }[]>("/reports/shares");
  const origin = typeof window !== "undefined" ? window.location.origin : "";
  async function make() { setLink(await apiSend("POST", `/reports/saved/${id}/share`, { days })); shares.reload(); }
  return (
    <Modal open onClose={onClose} title={t("rb_shareTitle")} actions={<button className="btn" onClick={onClose}>{t("close")}</button>}>
      <label className="field">{t("rb_expires")}<select value={days} onChange={(e) => setDays(Number(e.target.value))}>{[1, 7, 30, 90].map((d) => <option key={d} value={d}>{t("rb_days", { n: d })}</option>)}</select></label>
      <button className="btn primary" onClick={() => void make()}>{t("rb_makeLink")}</button>
      {link && (
        <div role="status">
          <p className="meta">{t("rb_linkNote", { date: new Date(link.expiresAt).toLocaleDateString() })}</p>
          <input readOnly aria-label={t("rb_link")} value={`${origin}${link.path}`} onFocus={(e) => e.target.select()} />
          <p className="meta small">{t("rb_embed")}: <code>{`<iframe src="${origin}${link.path}?embed=1" width="100%" height="480"></iframe>`}</code></p>
        </div>
      )}
      {(shares.data ?? []).filter((s) => !s.revokedAt && new Date(s.expiresAt) > new Date()).length > 0 && <>
        <h4>{t("rb_activeLinks")}</h4>
        <ul className="plainlist">{shares.data!.filter((s) => !s.revokedAt && new Date(s.expiresAt) > new Date()).map((s) => (
          <li key={s.id}>{s.name} · {new Date(s.expiresAt).toLocaleDateString()} <button className="linklike" onClick={() => void apiSend("DELETE", `/reports/shares/${s.id}`).then(shares.reload)}>{t("rb_revoke")}</button></li>
        ))}</ul>
      </>}
    </Modal>
  );
}

function ScheduleDialog({ id, endpoints, onClose }: { id: string; endpoints: Endpoint[]; onClose: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const sch = useApi<{ id: string; reportId: string; freq: string; hour: number; weekday: number | null; monthday: number | null; format: string; endpointIds: string[]; active: boolean }[]>("/r/report-schedules");
  const [freq, setFreq] = useState("weekly"); const [hour, setHour] = useState(7); const [weekday, setWeekday] = useState(1); const [monthday, setMonthday] = useState(1);
  const [format, setFormat] = useState("pdf"); const [to, setTo] = useState<string[]>([]);
  const mine = (sch.data ?? []).filter((s) => s.reportId === id);
  async function add() {
    try {
      await apiSend("POST", "/r/report-schedules", { reportId: id, freq, hour, format, endpointIds: to, active: true, ...(freq === "weekly" ? { weekday } : {}), ...(freq === "monthly" ? { monthday } : {}) });
      sch.reload(); toast(t("rb_scheduled"));
    } catch (e) { toast((e as Error).message); }
  }
  async function sendNow() {
    try { const r = await apiSend<{ rows: number; results: { endpoint: string; ok: boolean; error?: string }[] }>("POST", `/reports/saved/${id}/send`, { endpointIds: to, format }); toast(r.results.map((x) => `${x.endpoint}: ${x.ok ? "✓" : x.error}`).join(" · ")); } catch (e) { toast((e as Error).message); }
  }
  return (
    <Modal open onClose={onClose} title={t("rb_scheduleTitle")} actions={<button className="btn" onClick={onClose}>{t("close")}</button>}>
      <div className="form-grid">
        <label className="field">{t("f_freq")}<select value={freq} onChange={(e) => setFreq(e.target.value)}>{["daily", "weekly", "monthly"].map((f) => <option key={f} value={f}>{t(`v_${f}` as MessageKey)}</option>)}</select></label>
        <label className="field">{t("f_hour")}<input type="number" min={0} max={23} value={hour} onChange={(e) => setHour(Number(e.target.value))} /></label>
        {freq === "weekly" && <label className="field">{t("f_weekday")}<select value={weekday} onChange={(e) => setWeekday(Number(e.target.value))}>{[0, 1, 2, 3, 4, 5, 6].map((d) => <option key={d} value={d}>{new Intl.DateTimeFormat(undefined, { weekday: "long", timeZone: "UTC" }).format(new Date(Date.UTC(2023, 0, 1 + d)))}</option>)}</select></label>}
        {freq === "monthly" && <label className="field">{t("f_monthday")}<input type="number" min={1} max={28} value={monthday} onChange={(e) => setMonthday(Number(e.target.value))} /></label>}
        <label className="field">{t("f_format")}<select value={format} onChange={(e) => setFormat(e.target.value)}><option value="csv">CSV</option><option value="xlsx">Excel</option><option value="pdf">PDF</option></select></label>
      </div>
      <fieldset><legend>{t("rb_sendTo")}</legend>
        {endpoints.filter((e) => e.enabled).length === 0 ? <p className="meta">{t("rb_noDestinations")} <a className="link" href="/alerts">{t("navAlerts")}</a></p> : endpoints.filter((e) => e.enabled).map((e) => (
          <label key={e.id} className="check"><input type="checkbox" checked={to.includes(e.id)} onChange={(ev) => setTo(ev.target.checked ? [...to, e.id] : to.filter((x) => x !== e.id))} /> {e.label} <span className="meta">({t(`v_${e.kind}` as MessageKey)})</span></label>
        ))}
      </fieldset>
      <div className="row"><button className="btn primary" disabled={!to.length} onClick={() => void add()}>{t("rb_addSchedule")}</button><button className="btn" disabled={!to.length} onClick={() => void sendNow()}>{t("rb_sendNow")}</button></div>
      {mine.length > 0 && <><h4>{t("rb_existing")}</h4><ul className="plainlist">{mine.map((s) => <li key={s.id}>{t(`v_${s.freq}` as MessageKey)} · {s.hour}:00 · {s.format.toUpperCase()} <button className="linklike" onClick={() => void apiSend("DELETE", `/r/report-schedules/${s.id}`).then(sch.reload)}>{t("delete")}</button></li>)}</ul></>}
    </Modal>
  );
}

function VersionsDialog({ id, onClose, onRestore }: { id: string; onClose: () => void; onRestore: (v: number) => void }) {
  const { t } = useI18n();
  const v = useApi<{ version: number; name: string; savedAt: string; savedBy: string | null; note: string | null }[]>(`/reports/saved/${id}/versions`);
  return (
    <Modal open onClose={onClose} title={t("rb_historyTitle")} actions={<button className="btn" onClick={onClose}>{t("close")}</button>}>
      {!v.data ? <SkeletonList rows={3} h={30} /> : <ul className="plainlist">{v.data.map((x, i) => (
        <li key={x.version}><strong>v{x.version}</strong> · {new Date(x.savedAt).toLocaleString()} · {x.savedBy ?? "—"}{x.note ? ` · ${x.note}` : ""} {i > 0 && <button className="linklike" onClick={() => onRestore(x.version)}>{t("rb_restore")}</button>}</li>
      ))}</ul>}
    </Modal>
  );
}
void wid;
