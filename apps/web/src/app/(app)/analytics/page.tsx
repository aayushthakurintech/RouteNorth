"use client";
import type { MessageKey } from "@routenorth/shared";
import { GripVertical, Maximize2, Pencil, Plus, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FilterBar } from "@/components/analytics/FilterBar";
import { AskBox, WidgetView, type Compare, type Ctx } from "@/components/analytics/Widgets";
import { ErrorState, PageHead, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { metricLabel, presetRange, query, TEMPLATES, wid, type Filters, type MetricMeta, type Metrics, type Widget, type WidgetKind } from "@/lib/analytics";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Saved { id: string; name: string; widgets: Widget[]; shared: boolean }
const KINDS: WidgetKind[] = ["kpi", "trend", "breakdown", "reasons", "insights", "goals", "safety", "savings", "live", "forecast", "benchmarks", "feedback"];
const KEY = "routenorth.dashboard";

function roleDefault(role: string | undefined): string {
  return role === "driver" ? "driver" : role === "dispatcher" ? "operations" : role === "customer" ? "customer" : "executive";
}

export default function AnalyticsPage() {
  const { t } = useI18n();
  const { me, can } = useMe();
  const { toast } = useToast();
  const [filters, setFilters] = useState<Filters>({ ...presetRange("last7") });
  const [compare, setCompare] = useState<Compare>("prev");
  const [pick, setPick] = useState<string>("");
  const [widgets, setWidgets] = useState<Widget[]>([]);
  const [editing, setEditing] = useState(false);
  const [tv, setTv] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const dragId = useRef<string | null>(null);
  const canSee = can("reports.view");

  const meta = useApi<MetricMeta>(canSee ? "/analytics/metrics" : null);
  const saved = useApi<Saved[]>(canSee ? "/r/dashboards" : null);

  // Start on the dashboard that fits the person's role (or the one they used last).
  useEffect(() => {
    if (pick || !me) return;
    let last: string | null = null;
    try { last = localStorage.getItem(KEY); } catch { /* ignore */ }
    setPick(last ?? `t:${roleDefault(me.user.role)}`);
    setTv(new URLSearchParams(window.location.search).has("tv"));
  }, [me, pick]);

  useEffect(() => {
    if (!pick) return;
    try { localStorage.setItem(KEY, pick); } catch { /* ignore */ }
    if (pick.startsWith("t:")) { const tpl = TEMPLATES[pick.slice(2)]; setWidgets(tpl ? tpl.widgets() : TEMPLATES.executive!.widgets()); }
    else { const s = saved.data?.find((d) => d.id === pick); if (s) setWidgets(s.widgets); else if (saved.loaded) setPick(`t:${roleDefault(me?.user.role)}`); }
    setEditing(false);
  }, [pick, saved.data, saved.loaded, me]);

  // TV wall: refresh every minute.
  useEffect(() => {
    if (!tv) return;
    const id = setInterval(() => setRefresh((n) => n + 1), 60_000);
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") setTv(false); };
    window.addEventListener("keydown", esc);
    return () => { clearInterval(id); window.removeEventListener("keydown", esc); };
  }, [tv]);

  const f = useMemo<Filters>(() => ({ ...filters, refresh: refresh || undefined }), [filters, refresh]);
  const summary = useApi<{ metrics: Metrics; previous?: Metrics; deltas?: Record<string, { abs: number; pct: number | null } | null> }>(canSee ? `/analytics/summary?${query(f, compare === "none" ? {} : { compare })}` : null);
  const ctx: Ctx = { filters: f, compare, meta: meta.data ?? {}, summary: summary.data, refresh };

  const move = useCallback((from: string, to: string) => {
    setWidgets((ws) => { const a = ws.findIndex((w) => w.id === from), b = ws.findIndex((w) => w.id === to); if (a < 0 || b < 0 || a === b) return ws; const next = ws.slice(); const [x] = next.splice(a, 1); next.splice(b, 0, x!); return next; });
  }, []);

  async function save(asNew: boolean) {
    const current = saved.data?.find((d) => d.id === pick);
    try {
      if (!asNew && current) { await apiSend("PATCH", `/r/dashboards/${current.id}`, { widgets }); toast(t("dash_saved")); }
      else {
        const name = window.prompt(t("dash_namePrompt"), current ? `${current.name} (2)` : t("dash_myDashboard"));
        if (!name) return;
        const r = await apiSend<{ id: string }>("POST", "/r/dashboards", { name, widgets, shared: false });
        saved.reload(); setPick(r.id); toast(t("dash_saved"));
      }
      saved.reload();
    } catch (e) { toast((e as Error).message); }
  }
  async function share(on: boolean) {
    const current = saved.data?.find((d) => d.id === pick);
    if (!current) return;
    try { await apiSend("PATCH", `/r/dashboards/${current.id}`, { shared: on }); saved.reload(); } catch (e) { toast((e as Error).message); }
  }
  async function remove() {
    const current = saved.data?.find((d) => d.id === pick);
    if (!current || !window.confirm(t("dash_confirmDelete", { name: current.name }))) return;
    try { await apiSend("DELETE", `/r/dashboards/${current.id}`); saved.reload(); setPick(`t:${roleDefault(me?.user.role)}`); } catch (e) { toast((e as Error).message); }
  }

  const tabs = [
    ...Object.entries(TEMPLATES).filter(([k]) => k !== "driver" || !canSee || me?.user.role === "driver").map(([id, v]) => ({ id: `t:${id}`, label: t(v.label) })),
    ...(saved.data ?? []).map((d) => ({ id: d.id, label: d.name })),
  ];
  const isSaved = !!saved.data?.find((d) => d.id === pick);
  const driverOnly = !canSee;

  const grid = (
    <div className="dash-grid">
      {widgets.map((w) => (
        <div key={w.id} className={`dash-cell w${w.w ?? 2} ${editing ? "editing" : ""}`} draggable={editing}
          onDragStart={() => { dragId.current = w.id; }} onDragOver={(e) => editing && e.preventDefault()} onDrop={() => dragId.current && move(dragId.current, w.id)}>
          {editing && (
            <div className="cell-tools">
              <span className="grip" aria-hidden="true"><GripVertical size={16} /></span>
              <select aria-label={t("dash_width")} value={w.w ?? 2} onChange={(e) => setWidgets((ws) => ws.map((x) => (x.id === w.id ? { ...x, w: Number(e.target.value) } : x)))}>
                {[1, 2, 3, 4].map((n) => <option key={n} value={n}>{t("dash_cols", { n })}</option>)}
              </select>
              <button className="icon-btn" aria-label={t("dash_moveUp")} onClick={() => { const i = widgets.findIndex((x) => x.id === w.id); if (i > 0) move(w.id, widgets[i - 1]!.id); }}>↑</button>
              <button className="icon-btn" aria-label={t("dash_moveDown")} onClick={() => { const i = widgets.findIndex((x) => x.id === w.id); if (i < widgets.length - 1) move(w.id, widgets[i + 1]!.id); }}>↓</button>
              <button className="icon-btn" aria-label={t("dash_remove")} onClick={() => setWidgets((ws) => ws.filter((x) => x.id !== w.id))}><Trash2 size={15} /></button>
            </div>
          )}
          <WidgetView w={w} ctx={ctx} />
        </div>
      ))}
    </div>
  );

  if (tv) {
    return (
      <div className="tv-wall" role="region" aria-label={t("dash_tvMode")}>
        <header><h1>{me?.org.brandName ?? me?.org.name}</h1><span className="meta">{t("dash_tvHint")}</span><button className="btn" onClick={() => setTv(false)}><X size={16} /> {t("dash_exitTv")}</button></header>
        {grid}
      </div>
    );
  }

  return (
    <div className="content">
      <PageHead title={t("navAnalytics")} subtitle={t("dash_subtitle")} actions={(
        <>
          {canSee && <button className="btn" onClick={() => { setTv(true); document.documentElement.requestFullscreen?.().catch(() => {}); }}><Maximize2 size={16} /> {t("dash_tvMode")}</button>}
          {canSee && (editing
            ? <><button className="btn primary" onClick={() => void save(false)} disabled={!isSaved}>{t("save")}</button><button className="btn" onClick={() => void save(true)}>{t("dash_saveCopy")}</button><button className="btn" onClick={() => setPick((p) => p + "")}>{t("cancel")}</button></>
            : <button className="btn" onClick={() => setEditing(true)}><Pencil size={16} /> {t("dash_customize")}</button>)}
        </>
      )} />
      {!driverOnly && <Tabs label={t("navAnalytics")} value={pick} onChange={setPick} tabs={tabs} />}
      {!driverOnly && <FilterBar value={filters} onChange={setFilters} compare={compare} onCompare={setCompare} />}
      {driverOnly && <FilterBar value={filters} onChange={setFilters} showCompare={false} />}
      {isSaved && !editing && can("reports.manage") && (
        <p className="row meta">
          <label className="check"><input type="checkbox" checked={!!saved.data?.find((d) => d.id === pick)?.shared} onChange={(e) => void share(e.target.checked)} /> {t("dash_shareWithTeam")}</label>
          <button className="linklike" onClick={() => void remove()}>{t("delete")}</button>
        </p>
      )}
      {summary.error && !driverOnly && <ErrorState error={summary.error} onRetry={summary.reload} />}
      {canSee && !editing && <AskBox />}
      {editing && <AddWidget meta={meta.data ?? {}} onAdd={(w) => setWidgets((ws) => [...ws, w])} />}
      {grid}
    </div>
  );
}

function AddWidget({ meta, onAdd }: { meta: MetricMeta; onAdd: (w: Widget) => void }) {
  const { t } = useI18n();
  const [kind, setKind] = useState<WidgetKind>("kpi");
  const [metric, setMetric] = useState("onTimeRate");
  const [by, setBy] = useState("driver");
  const [chart, setChart] = useState<"bar" | "pie">("bar");
  const needsMetric = kind === "kpi" || kind === "trend" || kind === "breakdown";
  return (
    <div className="card add-widget row">
      <label className="field">{t("dash_widgetType")}<select value={kind} onChange={(e) => setKind(e.target.value as WidgetKind)}>{KINDS.map((k) => <option key={k} value={k}>{t(`wk_${k}` as MessageKey)}</option>)}</select></label>
      {needsMetric && <label className="field">{t("dash_metric")}<select value={metric} onChange={(e) => setMetric(e.target.value)}>{Object.keys(meta).map((k) => <option key={k} value={k}>{t(metricLabel(k))}</option>)}</select></label>}
      {kind === "breakdown" && <>
        <label className="field">{t("dash_groupBy")}<select value={by} onChange={(e) => setBy(e.target.value)}>{["driver", "vehicle", "route", "depot", "customer", "day"].map((g) => <option key={g} value={g}>{t(`dash_by_${g}` as MessageKey)}</option>)}</select></label>
        <label className="field">{t("dash_chart")}<select value={chart} onChange={(e) => setChart(e.target.value as "bar" | "pie")}><option value="bar">{t("ch_bar")}</option><option value="pie">{t("ch_pie")}</option></select></label>
      </>}
      <button className="btn" onClick={() => onAdd({ id: wid(), kind, w: kind === "kpi" ? 1 : 2, ...(needsMetric ? { metric } : {}), ...(kind === "breakdown" ? { by, chart } : {}) })}><Plus size={16} /> {t("dash_addWidget")}</button>
    </div>
  );
}
