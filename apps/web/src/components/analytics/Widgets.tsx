"use client";
import type { MessageKey } from "@routenorth/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
import { Chart, ChartTable, Sparkline, type ChartData } from "@/components/charts/Charts";
import { EmptyState, ErrorState, Kpi, SkeletonList } from "@/components/ui/primitives";
import { addDays, fmtMetric, metricLabel, query, type Filters, type MetricMeta, type Metrics, type Widget } from "@/lib/analytics";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useApi } from "@/lib/use-api";

export type Compare = "none" | "prev" | "year";
export interface Ctx { filters: Filters; compare: Compare; meta: MetricMeta; summary: { metrics: Metrics; previous?: Metrics; deltas?: Record<string, { abs: number; pct: number | null } | null> } | null; refresh: number }

/** The same length of time just before (or a year before) the chosen dates. */
export function comparisonRange(f: Filters, mode: Compare): { from: string; to: string } | null {
  if (mode === "none") return null;
  const len = Math.round((Date.parse(f.to) - Date.parse(f.from)) / 86_400_000) + 1;
  if (mode === "prev") return { from: addDays(f.from, -len), to: addDays(f.from, -1) };
  return { from: addDays(f.from, -365), to: addDays(f.to, -365) };
}

function Box({ title, children, link, wide }: { title: string; children: React.ReactNode; link?: { href: string; label: string }; wide?: boolean }) {
  return (
    <section className={`card widget ${wide ? "wide" : ""}`}>
      <div className="card-head"><h3>{title}</h3>{link && <Link href={link.href} className="link">{link.label}</Link>}</div>
      {children}
    </section>
  );
}

function useUnit(meta: MetricMeta, metric?: string) { return metric ? meta[metric]?.unit : undefined; }

function KpiWidget({ w, ctx }: { w: Widget; ctx: Ctx }) {
  const { t, locale } = useI18n();
  const { me } = useMe();
  const m = w.metric!;
  const unit = useUnit(ctx.meta, m);
  const v = ctx.summary?.metrics[m] ?? null;
  const d = ctx.summary?.deltas?.[m];
  const better = ctx.meta[m]?.better;
  return (
    <div className="card widget kpi-card">
      <Kpi label={t(metricLabel(m))} value={v} format={(n) => fmtMetric(n, unit, locale, me?.org.settings.currency)} delta={d?.pct != null ? d.pct / 100 : null}
        upIsGood={better !== "down"} sub={ctx.compare !== "none" && ctx.summary?.previous ? t("dash_was", { value: fmtMetric(ctx.summary.previous[m] ?? null, unit, locale, me?.org.settings.currency) }) : undefined} />
    </div>
  );
}

function TrendWidget({ w, ctx }: { w: Widget; ctx: Ctx }) {
  const { t, locale } = useI18n();
  const { me } = useMe();
  const m = w.metric!;
  const prevRange = comparisonRange(ctx.filters, ctx.compare);
  const cur = useApi<{ days: { date: string; value: number | null }[] }>(`/analytics/series?${query(ctx.filters, { metric: m })}`);
  const prev = useApi<{ days: { date: string; value: number | null }[] }>(prevRange ? `/analytics/series?${query({ ...ctx.filters, ...prevRange }, { metric: m })}` : null);
  const unit = useUnit(ctx.meta, m);
  const fmt = (n: number) => fmtMetric(n, unit, locale, me?.org.settings.currency);
  const data: ChartData | null = cur.data ? {
    labels: cur.data.days.map((d) => d.date.slice(5)),
    series: [{ name: t(metricLabel(m)), values: cur.data.days.map((d) => d.value) }, ...(prev.data ? [{ name: t("dash_prevPeriod"), values: prev.data.days.map((d) => d.value) }] : [])],
  } : null;
  const [table, setTable] = useState(false);
  return (
    <Box title={w.title || t(metricLabel(m))} wide={(w.w ?? 2) > 2}>
      {cur.error ? <ErrorState error={cur.error} onRetry={cur.reload} /> : !data ? <SkeletonList rows={3} h={40} /> : (
        <>
          {table ? <ChartTable data={data} format={fmt} /> : <Chart type="line" data={data} format={fmt} ariaLabel={t(metricLabel(m))} height={200} />}
          <button className="linklike small" onClick={() => setTable(!table)}>{table ? t("dash_showChart") : t("dash_showTable")}</button>
        </>
      )}
    </Box>
  );
}

function BreakdownWidget({ w, ctx }: { w: Widget; ctx: Ctx }) {
  const { t, locale } = useI18n();
  const { me } = useMe();
  const m = w.metric!, by = w.by ?? "driver";
  const rows = useApi<{ rows: { key: string; name: string; metrics: Metrics }[] }>(`/analytics/breakdown?${query(ctx.filters, { by })}`);
  const unit = useUnit(ctx.meta, m);
  const fmt = (n: number) => fmtMetric(n, unit, locale, me?.org.settings.currency);
  const better = ctx.meta[m]?.better;
  const list = useMemo(() => {
    const r = (rows.data?.rows ?? []).filter((x) => x.metrics[m] != null);
    if (by === "day") return r.sort((a, b) => a.key.localeCompare(b.key));
    return r.sort((a, b) => (better === "down" ? a.metrics[m]! - b.metrics[m]! : b.metrics[m]! - a.metrics[m]!)).slice(0, 12);
  }, [rows.data, m, by, better]);
  const data: ChartData = { labels: list.map((r) => r.name), series: [{ name: t(metricLabel(m)), values: list.map((r) => r.metrics[m] ?? null) }] };
  const [table, setTable] = useState(false);
  const chart = w.chart === "pie" ? "pie" : by === "day" ? "line" : w.chart === "stacked" ? "bar" : "bar";
  return (
    <Box title={w.title || `${t(metricLabel(m))} · ${t(`dash_by_${by}` as MessageKey)}`} wide={(w.w ?? 2) > 2}>
      {rows.error ? <ErrorState error={rows.error} onRetry={rows.reload} /> : !rows.loaded ? <SkeletonList rows={3} h={40} /> : list.length === 0 ? <EmptyState title={t("noData")} /> : (
        <>
          {table ? <ChartTable data={data} format={fmt} /> : <Chart type={chart} data={data} format={fmt} ariaLabel={t(metricLabel(m))} height={220} />}
          <button className="linklike small" onClick={() => setTable(!table)}>{table ? t("dash_showChart") : t("dash_showTable")}</button>
        </>
      )}
    </Box>
  );
}

function ReasonsWidget({ w, ctx }: { w: Widget; ctx: Ctx }) {
  const { t } = useI18n();
  const r = useApi<{ reason: string; count: number }[]>(`/analytics/reasons?${query(ctx.filters)}`);
  const data: ChartData = { labels: (r.data ?? []).map((x) => x.reason), series: [{ name: t("dash_failures"), values: (r.data ?? []).map((x) => x.count) }] };
  return (
    <Box title={w.title || t("dash_reasons")}>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.loaded ? <SkeletonList rows={3} h={30} /> : (r.data ?? []).length === 0 ? <EmptyState title={t("dash_noFailures")} /> : <Chart type="funnel" data={data} ariaLabel={t("dash_reasons")} height={Math.max(120, 36 * data.labels.length)} />}
    </Box>
  );
}

export function InsightText({ i }: { i: { type: string; params: Record<string, string | number> } }) {
  const { t } = useI18n();
  return <>{t(`insight_${i.type}` as MessageKey, i.params)}</>;
}

function InsightsWidget({ w }: { w: Widget }) {
  const { t } = useI18n();
  const r = useApi<{ type: string; severity: string; params: Record<string, string | number>; link?: string }[]>("/analytics/insights");
  return (
    <Box title={w.title || t("dash_insights")}>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.loaded ? <SkeletonList rows={3} h={32} /> : (
        <ul className="insights">
          {(r.data ?? []).map((i, n) => (
            <li key={n} className={`insight ${i.severity}`}><span className="dot" aria-hidden="true" /><span>{i.link ? <Link href={i.link} className="link"><InsightText i={i} /></Link> : <InsightText i={i} />}</span></li>
          ))}
        </ul>
      )}
    </Box>
  );
}

function GoalsWidget({ w, ctx }: { w: Widget; ctx: Ctx }) {
  const { t, locale } = useI18n();
  const { me } = useMe();
  const r = useApi<{ id: string; name: string; metric: string; target: number; direction: string; period: string; value: number | null; progressPct: number | null; status: string }[]>("/analytics/goals");
  return (
    <Box title={w.title || t("dash_goals")} link={{ href: "/analytics/goals", label: t("dash_manageGoals") }}>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.loaded ? <SkeletonList rows={3} h={32} /> : (r.data ?? []).length === 0 ? <EmptyState title={t("dash_noGoals")} body={t("dash_noGoalsBody")} /> : (
        <ul className="goals">
          {r.data!.map((g) => {
            const unit = ctx.meta[g.metric]?.unit;
            const f = (n: number | null) => fmtMetric(n, unit, locale, me?.org.settings.currency);
            return (
              <li key={g.id}>
                <div className="goal-top"><span>{g.name}</span><span className="mono-num">{f(g.value)} / {g.direction === "up" ? "≥" : "≤"} {f(g.target)}</span></div>
                <div className={`bar ${g.status}`} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={g.progressPct ?? 0} aria-label={g.name}><span style={{ width: `${g.progressPct ?? 0}%` }} /></div>
                <span className={`chip-text ${g.status}`}>{t(`goal_${g.status}` as MessageKey)}</span>
              </li>
            );
          })}
        </ul>
      )}
    </Box>
  );
}

function SafetyWidget({ w, ctx }: { w: Widget; ctx: Ctx }) {
  const { t, locale } = useI18n();
  const r = useApi<{ totals: Record<string, number>; events: { kind: string; time: string; driver: string | null; vehicle: string; value: number }[] }>(`/analytics/safety?${query(ctx.filters)}`);
  return (
    <Box title={w.title || t("dash_safetyEvents")} wide>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.loaded ? <SkeletonList rows={3} h={30} /> : (r.data?.events ?? []).length === 0 ? <EmptyState title={t("dash_noEvents")} /> : (
        <table className="plain">
          <thead><tr><th>{t("date")}</th><th>{t("an_vehicle")}</th><th>{t("an_driver")}</th><th>{t("an_kind")}</th><th style={{ textAlign: "right" }}>{t("an_value")}</th></tr></thead>
          <tbody>{r.data!.events.slice(0, 10).map((e, i) => (
            <tr key={i}><td>{new Date(e.time).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" })}</td><td>{e.vehicle}</td><td>{e.driver ?? "—"}</td><td>{t(`safe_${e.kind}` as MessageKey)}</td><td className="mono-num" style={{ textAlign: "right" }}>{Math.round(e.value)}</td></tr>
          ))}</tbody>
        </table>
      )}
    </Box>
  );
}

function SavingsWidget({ w, ctx }: { w: Widget; ctx: Ctx }) {
  const { t, locale } = useI18n();
  const r = useApi<{ optimizedRoutes: number; kmSaved: number; costSaved: number; co2KgSaved: number; assumption: string }>(`/analytics/savings?${query(ctx.filters)}`);
  return (
    <Box title={w.title || t("dash_savings")} wide>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data ? <SkeletonList rows={1} h={60} /> : r.data.optimizedRoutes === 0 ? <EmptyState title={t("dash_noSavings")} body={t("dash_noSavingsBody")} /> : (
        <div className="kpi-row">
          <Kpi label={t("dash_routesOptimized")} value={r.data.optimizedRoutes} />
          <Kpi label={t("dash_kmSaved")} value={r.data.kmSaved} format={(n) => fmtMetric(n, "km", locale)} />
          <Kpi label={t("dash_moneySaved")} value={r.data.costSaved} format={(n) => fmtMetric(n, "$", locale)} />
          <Kpi label={t("dash_co2Saved")} value={r.data.co2KgSaved} format={(n) => fmtMetric(n, "kg", locale)} sub={t("dash_assumes30")} />
        </div>
      )}
    </Box>
  );
}

interface Live { date: string; jobs: { status: string; n: number }[]; lateStops: { id: string; name: string; routeName: string; lateMin: number; routeId: string }[]; idleVehicles: { deviceId: string; name: string }[]; vehiclesMoving: number; routesActive: number; idleThresholdMin: number }
function LiveWidget({ w, ctx }: { w: Widget; ctx: Ctx }) {
  const { t } = useI18n();
  const r = useApi<Live>("/analytics/live", { intervalMs: 30_000 });
  void ctx;
  const count = (s: string[]) => (r.data?.jobs ?? []).filter((j) => s.includes(j.status)).reduce((a, b) => a + b.n, 0);
  return (
    <Box title={w.title || t("dash_liveNow")} wide>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data ? <SkeletonList rows={2} h={60} /> : (
        <>
          <div className="kpi-row">
            <Kpi label={t("dash_jobsOpen")} value={count(["unassigned", "assigned", "started", "arrived"])} href="/jobs" />
            <Kpi label={t("dash_jobsDone")} value={count(["done"])} />
            <Kpi label={t("dash_lateNow")} value={r.data.lateStops.length} upIsGood={false} />
            <Kpi label={t("dash_idleNow")} value={r.data.idleVehicles.length} upIsGood={false} sub={t("dash_idleSub", { min: r.data.idleThresholdMin })} />
            <Kpi label={t("dash_moving")} value={r.data.vehiclesMoving} sub={t("dash_routesActive", { n: r.data.routesActive })} />
          </div>
          <div className="two-col">
            <div>
              <h4>{t("dash_lateStops")}</h4>
              {r.data.lateStops.length === 0 ? <p className="meta">{t("dash_nothingLate")}</p> : <ul className="plainlist">{r.data.lateStops.slice(0, 6).map((s) => <li key={s.id}><Link href={`/routes?id=${s.routeId}`} className="link">{s.name}</Link> <span className="meta">{s.routeName} · +{s.lateMin} min</span></li>)}</ul>}
            </div>
            <div>
              <h4>{t("dash_idleVehicles")}</h4>
              {r.data.idleVehicles.length === 0 ? <p className="meta">{t("dash_nothingIdle")}</p> : <ul className="plainlist">{r.data.idleVehicles.slice(0, 6).map((v) => <li key={v.deviceId}>{v.name}</li>)}</ul>}
            </div>
          </div>
        </>
      )}
    </Box>
  );
}

function ForecastWidget({ w, ctx }: { w: Widget; ctx: Ctx }) {
  const { t, locale } = useI18n();
  const { me } = useMe();
  const r = useApi<{ from: string; stops: { date: string; value: number }[]; cost: { date: string; value: number }[]; driveHours: { date: string; value: number }[]; booked: Record<string, number> }>("/analytics/forecast");
  void ctx;
  const d = r.data;
  const labels = d?.stops.map((x) => x.date.slice(5)) ?? [];
  return (
    <Box title={w.title || t("dash_forecast")} wide>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !d ? <SkeletonList rows={3} h={40} /> : d.stops.length === 0 ? <EmptyState title={t("dash_noForecast")} body={t("dash_noForecastBody")} /> : (
        <div className="two-col">
          <div><h4>{t("dash_expectedStops")}</h4><Chart type="bar" ariaLabel={t("dash_expectedStops")} height={180} data={{ labels, series: [{ name: t("dash_expected"), values: d.stops.map((x) => Math.round(x.value)) }, { name: t("dash_booked"), values: d.stops.map((x) => d.booked[x.date] ?? 0) }] }} /></div>
          <div><h4>{t("dash_expectedCost")}</h4><Chart type="line" ariaLabel={t("dash_expectedCost")} height={180} format={(n) => fmtMetric(n, "$", locale, me?.org.settings.currency)} data={{ labels, series: [{ name: t("dash_expected"), values: d.cost.map((x) => Math.round(x.value)) }] }} /></div>
        </div>
      )}
    </Box>
  );
}

function BenchmarksWidget({ w, ctx }: { w: Widget; ctx: Ctx }) {
  const { t, locale } = useI18n();
  const { me } = useMe();
  const [by, setBy] = useState(w.by ?? "driver");
  const keys = w.metrics ?? ["onTimeRate", "avgDelayMin", "idleSharePct", "costPerKm", "driverScore"];
  const r = useApi<{ rows: { key: string; name: string; values: Record<string, { value: number | null; rank: number | null; of: number; vsMedianPct: number | null }> }[]; stats: Record<string, { median: number | null }> }>(`/analytics/benchmarks?${query(ctx.filters, { by, metrics: keys.join(",") })}`);
  return (
    <Box title={w.title || t("dash_benchmarks")} wide>
      <div className="seg" role="group" aria-label={t("dash_groupBy")}>{["driver", "vehicle", "depot", "route"].map((g) => <button key={g} aria-pressed={by === g} onClick={() => setBy(g)}>{t(`dash_by_${g}` as MessageKey)}</button>)}</div>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data ? <SkeletonList rows={4} h={30} /> : r.data.rows.length === 0 ? <EmptyState title={t("noData")} /> : (
        <div className="dt-scroll"><table className="plain">
          <thead><tr><th>{t(`dash_by_${by}` as MessageKey)}</th>{keys.map((k) => <th key={k} style={{ textAlign: "right" }}>{t(metricLabel(k))}</th>)}</tr></thead>
          <tbody>
            {r.data.rows.map((row) => (
              <tr key={row.key}><th scope="row">{row.name}</th>{keys.map((k) => {
                const c = row.values[k];
                const good = c?.rank != null && c.of > 1 ? (c.rank === 1 ? "best" : c.rank === c.of ? "worst" : "") : "";
                return <td key={k} className={`mono-num ${good}`} style={{ textAlign: "right" }}>{fmtMetric(c?.value ?? null, ctx.meta[k]?.unit, locale, me?.org.settings.currency)}{c?.vsMedianPct != null && c.of > 2 && <small className="meta"> {c.vsMedianPct > 0 ? "+" : ""}{c.vsMedianPct}%</small>}</td>;
              })}</tr>
            ))}
            <tr className="median"><th scope="row">{t("dash_median")}</th>{keys.map((k) => <td key={k} className="mono-num" style={{ textAlign: "right" }}>{fmtMetric(r.data!.stats[k]?.median ?? null, ctx.meta[k]?.unit, locale, me?.org.settings.currency)}</td>)}</tr>
          </tbody>
        </table></div>
      )}
    </Box>
  );
}

interface Answer { understood: boolean; metric?: string; unit?: string; period?: string; clamped?: boolean; by?: string | null; value?: number | null; rows?: { key: string; name: string; value: number }[] }
export function AskBox() {
  const { t, locale } = useI18n();
  const { me } = useMe();
  const [q, setQ] = useState("");
  const [ans, setAns] = useState<Answer | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function go(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) return;
    setBusy(true); setErr(null);
    try { setAns(await apiSend<Answer>("POST", "/analytics/ask", { q })); } catch (x) { setErr((x as Error).message); } finally { setBusy(false); }
  }
  const fmt = (n: number) => fmtMetric(n, ans?.unit, locale, me?.org.settings.currency);
  return (
    <section className="card widget wide ask">
      <form onSubmit={go} className="row">
        <label className="field grow">{t("ask_label")}<input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("ask_placeholder")} maxLength={300} /></label>
        <button className="btn primary" disabled={busy}>{t("ask_go")}</button>
      </form>
      {err && <p className="error" role="alert">{err}</p>}
      {ans && !ans.understood && <p className="meta" role="status">{t("ask_notUnderstood")}</p>}
      {ans?.understood && (
        <div role="status">
          <p><strong>{t(metricLabel(ans.metric!))}</strong> · {ans.period}{ans.clamped ? ` · ${t("ask_clamped")}` : ""}</p>
          {ans.by == null ? <p className="big">{fmt(ans.value ?? 0)}</p> : (ans.rows ?? []).length === 0 ? <p className="meta">{t("noData")}</p> : (
            <Chart type={ans.by === "day" ? "line" : "bar"} ariaLabel={t(metricLabel(ans.metric!))} format={fmt} height={200} data={{ labels: ans.rows!.map((r) => r.name), series: [{ name: t(metricLabel(ans.metric!)), values: ans.rows!.map((r) => r.value) }] }} />
          )}
        </div>
      )}
    </section>
  );
}

interface Me2 { range: { from: string; to: string }; metrics: Metrics; earnings: { hours: number; rate: number; overtimeH: number; estimate: number } | null; days: { date: string; distanceKm: number; stops: number }[]; note: string }
export function MyWidget({ w, ctx }: { w: Widget; ctx: Ctx }) {
  const { t, locale } = useI18n();
  const { me } = useMe();
  const r = useApi<Me2>(`/analytics/me?${query(ctx.filters)}`);
  const m = r.data?.metrics;
  const cur = me?.org.settings.currency;
  return (
    <Box title={w.title || t("dash_myNumbers")} wide>
      {r.error ? <ErrorState error={r.error} onRetry={r.reload} /> : !r.data ? <SkeletonList rows={3} h={50} /> : (
        <>
          <div className="kpi-row">
            <Kpi label={t("an_driverScore")} value={m?.driverScore ?? null} format={(n) => fmtMetric(n, "score", locale)} />
            <Kpi label={t("an_stopsDone")} value={m?.stopsDone ?? null} />
            <Kpi label={t("an_onTimeRate")} value={m?.onTimeRate ?? null} format={(n) => fmtMetric(n, "%", locale)} />
            <Kpi label={t("an_distanceKm")} value={m?.distanceKm ?? null} format={(n) => fmtMetric(n, "km", locale)} />
            <Kpi label={t("an_speedingEvents")} value={(m?.speedingEvents ?? 0) + (m?.harshBrakes ?? 0) + (m?.harshAccels ?? 0)} upIsGood={false} />
            {r.data.earnings && <Kpi label={t("dash_earnings")} value={r.data.earnings.estimate} format={(n) => fmtMetric(n, "$", locale, cur)} sub={t("dash_earningsSub", { h: r.data.earnings.hours, ot: r.data.earnings.overtimeH })} />}
          </div>
          <Chart type="bar" ariaLabel={t("an_distanceKm")} height={180} format={(n) => fmtMetric(n, "km", locale)} data={{ labels: r.data.days.map((d) => d.date.slice(5)), series: [{ name: t("an_distanceKm"), values: r.data.days.map((d) => d.distanceKm) }] }} />
          <p className="meta">{t("dash_earningsNote")}</p>
        </>
      )}
    </Box>
  );
}

function FeedbackWidget({ w, ctx }: { w: Widget; ctx: Ctx }) {
  const { t, locale } = useI18n();
  const s = ctx.summary?.metrics;
  return (
    <Box title={w.title || t("dash_feedback")}>
      {(s?.feedbackCount ?? 0) === 0 ? <EmptyState title={t("dash_noFeedback")} body={t("dash_noFeedbackBody")} /> : (
        <div className="kpi-row">
          <Kpi label={t("an_csat")} value={s?.csat ?? null} format={(n) => `${fmtMetric(n, "score", locale)} / 5`} />
          <Kpi label={t("an_nps")} value={s?.nps ?? null} format={(n) => fmtMetric(n, "score", locale)} />
          <Kpi label={t("an_feedbackCount")} value={s?.feedbackCount ?? null} />
        </div>
      )}
    </Box>
  );
}

export function WidgetView({ w, ctx }: { w: Widget; ctx: Ctx }) {
  switch (w.kind) {
    case "kpi": return <KpiWidget w={w} ctx={ctx} />;
    case "trend": return <TrendWidget w={w} ctx={ctx} />;
    case "breakdown": return <BreakdownWidget w={w} ctx={ctx} />;
    case "reasons": return <ReasonsWidget w={w} ctx={ctx} />;
    case "insights": return <InsightsWidget w={w} />;
    case "goals": return <GoalsWidget w={w} ctx={ctx} />;
    case "safety": return <SafetyWidget w={w} ctx={ctx} />;
    case "savings": return <SavingsWidget w={w} ctx={ctx} />;
    case "live": return <LiveWidget w={w} ctx={ctx} />;
    case "forecast": return <ForecastWidget w={w} ctx={ctx} />;
    case "benchmarks": return <BenchmarksWidget w={w} ctx={ctx} />;
    case "ask": return <AskBox />;
    case "me": return <MyWidget w={w} ctx={ctx} />;
    case "feedback": return <FeedbackWidget w={w} ctx={ctx} />;
    default: return null;
  }
}

export { Sparkline };
