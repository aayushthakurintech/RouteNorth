"use client";
import { useMemo, useState } from "react";
import { Chart, ChartTable, type ChartData } from "@/components/charts/Charts";
import { BarList, StatTile } from "@/components/charts/Parts";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState, ErrorState, PageHead, SkeletonList, Tabs } from "@/components/ui/primitives";
import { dayRange, formatDuration, formatKm, formatTime, todayLocal } from "@/lib/format";
import { useI18n } from "@/lib/i18n-context";
import { useApi } from "@/lib/use-api";

interface DailyRow { deviceId: string; name: string; date: string; distanceM: number; idleS: number; movingS: number }
interface IdleVehicle { deviceId: string; name: string; totalIdleS: number; idleStops: { time: string; durationS: number }[] }
interface Idling {
  thresholdMin: number; fuelPricePerL: number | null; basis: string;
  totals: { episodeS: number; litres: number; cost: number | null; co2Kg: number; episodes: number };
  vehicles: { deviceId: string; name: string; kind: string; idleS: number; movingS: number; idlePct: number | null; episodeS: number; episodes: unknown[]; cost: { litres: number; cost: number | null; co2Kg: number } }[];
}
interface Util {
  workdayHours: number; summary: { vehicles: number; used: number; light: number; unused: number };
  vehicles: { deviceId: string; name: string; kind: string; km: number; daysTracked: number; daysUsed: number; daysUsedPct: number | null; movingPct: number | null; engineOnPct: number | null; avgKmPerUsedDay: number | null; level: "none" | "light" | "normal" }[];
}
interface Fuel {
  note: string;
  vehicles: { deviceId: string; name: string; tankLitres: number; tankKnown: boolean; lastPct: number; events: { kind: "refuel" | "drain"; time: string; endTime: string; fromPct: number; toPct: number; litres: number }[] }[];
}

const DAY = 86_400_000;
const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return todayLocal(new Date(y, m - 1, d + n));
};
const num = (n: number, locale: string, digits = 1) => new Intl.NumberFormat(locale === "fr" ? "fr-CA" : "en-CA", { maximumFractionDigits: digits }).format(n);
const pct = (n: number | null) => (n == null ? "—" : `${Math.round(n)}%`);

export default function ReportsPage() {
  const { t, locale } = useI18n();
  const [tab, setTab] = useState("distance");
  const [to, setTo] = useState(todayLocal());
  const [from, setFrom] = useState(addDays(todayLocal(), -6));
  const [workday, setWorkday] = useState(10);
  const valid = from <= to;
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  const q = valid ? `from=${encodeURIComponent(dayRange(from).from)}&to=${encodeURIComponent(dayRange(to).to)}&tz=${encodeURIComponent(tz)}` : null;
  // The telematics reports are capped at 14 days; say so instead of failing.
  const clamped = valid && (new Date(`${to}T12:00:00`).getTime() - new Date(`${from}T12:00:00`).getTime()) / DAY > 13;
  const tFrom = clamped ? addDays(to, -13) : from;
  const tq = valid ? `from=${encodeURIComponent(dayRange(tFrom).from)}&to=${encodeURIComponent(dayRange(to).to)}&tz=${encodeURIComponent(tz)}` : null;

  const daily = useApi<DailyRow[]>(tab === "distance" && q ? `/reports/daily?${q}` : null);
  const idle = useApi<IdleVehicle[]>(tab === "distance" && q ? `/reports/idle?${q}` : null);
  const idling = useApi<Idling>(tab === "idling" && tq ? `/telematics/idling?${tq}` : null);
  const util = useApi<Util>(tab === "utilization" && tq ? `/telematics/utilization?${tq}&workday=${workday}` : null);
  const fuel = useApi<Fuel>(tab === "fuel" && tq ? `/telematics/fuel-events?${tq}` : null);

  const tabs = [
    { id: "distance", label: t("rep_distance") }, { id: "idling", label: t("rep_idling") },
    { id: "utilization", label: t("rep_utilization") }, { id: "fuel", label: t("rep_fuel") },
  ];

  const dailyCols: Column<DailyRow>[] = useMemo(() => [
    { key: "date", header: t("date"), value: (r) => r.date, width: 120, pinned: true },
    { key: "name", header: t("vehicle"), value: (r) => r.name, width: 160 },
    { key: "distance", header: `${t("distance")} (km)`, value: (r) => Math.round(r.distanceM / 100) / 10, render: (r) => formatKm(r.distanceM, locale), numeric: true, width: 130 },
    { key: "moving", header: `${t("movingTime")} (min)`, value: (r) => Math.round(r.movingS / 60), render: (r) => formatDuration(r.movingS), numeric: true, width: 150 },
    { key: "idle", header: `${t("idleTime")} (min)`, value: (r) => Math.round(r.idleS / 60), render: (r) => formatDuration(r.idleS), numeric: true, width: 150 },
  ], [t, locale]);
  const idleCols: Column<IdleVehicle>[] = useMemo(() => [
    { key: "name", header: t("vehicle"), value: (r) => r.name, width: 160 },
    { key: "total", header: `${t("totalIdle")} (min)`, value: (r) => Math.round(r.totalIdleS / 60), render: (r) => formatDuration(r.totalIdleS), numeric: true, width: 150 },
    {
      key: "stops", header: t("idleStopsTitle"), width: 460, noGroup: true,
      value: (r) => r.idleStops.slice().sort((a, b) => b.durationS - a.durationS).slice(0, 3)
        .map((s) => `${new Date(s.time).toLocaleDateString(locale === "fr" ? "fr-CA" : "en-CA")} ${formatTime(s.time, locale)} (${formatDuration(s.durationS)})`).join(" · ") || "—",
    },
  ], [t, locale]);

  // Fleet distance per day, for the chart above the table.
  const distanceChart = useMemo<ChartData | null>(() => {
    const rows = daily.data ?? [];
    if (!rows.length) return null;
    const by = new Map<string, number>();
    for (const r of rows) by.set(r.date, (by.get(r.date) ?? 0) + r.distanceM / 1000);
    const days = [...by.keys()].sort();
    const lab = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(locale === "fr" ? "fr-CA" : "en-CA", { month: "short", day: "numeric" });
    return { labels: days.map(lab), series: [{ name: "km", values: days.map((d) => Math.round(by.get(d)! * 10) / 10) }] };
  }, [daily.data, locale]);

  const utilCols: Column<Util["vehicles"][number]>[] = useMemo(() => [
    { key: "name", header: t("vehicle"), value: (r) => r.name, width: 170, pinned: true },
    { key: "level", header: t("rep_utilization"), value: (r) => t(`rep_level_${r.level}`), width: 120 },
    { key: "days", header: t("rep_daysUsed"), value: (r) => r.daysUsed, render: (r) => `${r.daysUsed} / ${r.daysTracked}`, numeric: true, width: 120 },
    { key: "moving", header: t("rep_moving"), value: (r) => r.movingPct ?? -1, render: (r) => pct(r.movingPct), numeric: true, width: 230 },
    { key: "engine", header: t("rep_engineOn"), value: (r) => r.engineOnPct ?? -1, render: (r) => pct(r.engineOnPct), numeric: true, width: 170 },
    { key: "km", header: "km", value: (r) => r.km, render: (r) => num(r.km, locale), numeric: true, width: 100 },
    { key: "kmday", header: t("rep_kmDay"), value: (r) => r.avgKmPerUsedDay ?? -1, render: (r) => (r.avgKmPerUsedDay == null ? "—" : num(r.avgKmPerUsedDay, locale)), numeric: true, width: 170 },
  ], [t, locale]);

  const fuelRows = useMemo(() => (fuel.data?.vehicles ?? []).flatMap((v) => v.events.map((e) => ({ ...e, name: v.name, tank: v.tankLitres, tankKnown: v.tankKnown, id: `${v.deviceId}${e.time}` })))
    .sort((a, b) => b.time.localeCompare(a.time)), [fuel.data]);
  const fuelCols: Column<(typeof fuelRows)[number]>[] = useMemo(() => [
    { key: "time", header: t("rep_fuelWhen"), value: (r) => r.time, render: (r) => `${new Date(r.time).toLocaleDateString(locale === "fr" ? "fr-CA" : "en-CA")} ${formatTime(r.time, locale)}`, width: 170 },
    { key: "name", header: t("vehicle"), value: (r) => r.name, width: 160 },
    { key: "kind", header: t("rep_fuelType"), value: (r) => (r.kind === "refuel" ? t("rep_refuel") : t("rep_drain")), width: 150 },
    { key: "change", header: t("rep_fuelChange"), value: (r) => r.toPct - r.fromPct, render: (r) => `${Math.round(r.fromPct)}% → ${Math.round(r.toPct)}%`, numeric: true, width: 150 },
    { key: "litres", header: t("rep_idleLitres"), value: (r) => r.litres, render: (r) => `${num(r.litres, locale, 0)}${r.tankKnown ? "" : " *"}`, numeric: true, width: 110 },
  ], [t, locale]);

  const active = tab === "distance" ? [daily, idle] : tab === "idling" ? [idling] : tab === "utilization" ? [util] : [fuel];
  const loading = valid && active.some((a) => !a.loaded && !a.error);
  const error = active.map((a) => a.error).find(Boolean);
  const reload = () => active.forEach((a) => a.reload());
  const tqs = tab !== "distance";

  return (
    <div className="content">
      <PageHead title={t("reports")} />
      <div className="row">
        <label className="field">{t("from")}<input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className="field">{t("to")}<input type="date" value={to} min={from} max={todayLocal()} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        {tab === "utilization" && (
          <label className="field">{t("rep_workday")}
            <select value={workday} onChange={(e) => setWorkday(Number(e.target.value))}>{[6, 8, 10, 12, 14].map((h) => <option key={h} value={h}>{h}</option>)}</select>
          </label>
        )}
      </div>
      <Tabs tabs={tabs} value={tab} onChange={setTab} label={t("rep_tabs")} />
      {tqs && clamped && <p className="panel-note" role="status">{t("rep_clamped", { to })}</p>}

      <div className="tab-panel" role="tabpanel" aria-labelledby={`tab-${tab}`}>
        {loading && <SkeletonList rows={5} h={38} />}
        {error && !loading && <ErrorState error={error} onRetry={reload} />}

        {!loading && !error && tab === "distance" && (
          <>
            {distanceChart && (
              <section>
                <h2 className="section-title">{t("dailyDistance")}</h2>
                <Chart type="bar" data={distanceChart} height={220} ariaLabel={t("dailyDistance")} format={(n) => `${num(n, locale)} km`} />
                <details><summary>{t("dash_showTable")}</summary><ChartTable data={distanceChart} /></details>
              </section>
            )}
            <DataTable tableId="report-daily" csvName={`routenorth-daily-${from}-${to}`} columns={dailyCols} rows={daily.data ?? []} rowKey={(r) => r.date + r.deviceId} empty={<EmptyState title={t("noData")} />} maxHeight="50vh" />
            <h2 className="section-title">{t("idleReport")}</h2>
            <DataTable tableId="report-idle" csvName={`routenorth-idle-${from}-${to}`} columns={idleCols} rows={idle.data ?? []} rowKey={(r) => r.deviceId} empty={<EmptyState title={t("noData")} />} maxHeight="40vh" />
          </>
        )}

        {!loading && !error && tab === "idling" && idling.data && (
          idling.data.vehicles.length === 0 || idling.data.totals.episodes === 0 ? <EmptyState title={t("rep_idleEmpty")} body={t("rep_idleThreshold", { min: idling.data.thresholdMin })} /> : (
            <>
              <div className="kpi-row">
                <StatTile label={t("rep_idleTime")} value={formatDuration(idling.data.totals.episodeS)} sub={t("rep_idleThreshold", { min: idling.data.thresholdMin })} />
                <StatTile label={t("rep_idleFuel")} value={`${num(idling.data.totals.litres, locale)} L`} sub={idling.data.basis} />
                <StatTile label={t("rep_idleCost")} value={idling.data.totals.cost == null ? "—" : new Intl.NumberFormat(locale === "fr" ? "fr-CA" : "en-CA", { style: "currency", currency: "CAD" }).format(idling.data.totals.cost)} sub={idling.data.totals.cost == null ? t("rep_idleNoPrice") : undefined} />
                <StatTile label={t("rep_idleCo2")} value={`${num(idling.data.totals.co2Kg, locale)} kg`} />
              </div>
              <section>
                <h2 className="section-title">{t("rep_idleBy")}</h2>
                <BarList
                  ariaLabel={t("rep_idleBy")}
                  items={idling.data.vehicles.filter((v) => v.episodeS > 0).map((v) => ({ key: v.deviceId, label: v.name, value: v.episodeS, display: formatDuration(v.episodeS), note: `${t("rep_idlePct")} ${pct(v.idlePct)} · ${num(v.cost.litres, locale)} L · ${v.episodes.length} ${t("rep_idleEpisodes").toLowerCase()}` }))}
                />
              </section>
            </>
          )
        )}

        {!loading && !error && tab === "utilization" && util.data && (
          util.data.vehicles.length === 0 ? <EmptyState title={t("noData")} /> : (
            <>
              <div className="kpi-row">
                <StatTile label={t("rep_vehicles")} value={util.data.summary.vehicles} />
                <StatTile label={t("rep_usedVehicles")} value={util.data.summary.used - util.data.summary.light} tone="good" />
                <StatTile label={t("rep_lightVehicles")} value={util.data.summary.light} tone={util.data.summary.light ? "warn" : undefined} />
                <StatTile label={t("rep_unusedVehicles")} value={util.data.summary.unused} tone={util.data.summary.unused ? "bad" : undefined} />
              </div>
              <section>
                <h2 className="section-title">{t("rep_utilBy")}</h2>
                <BarList
                  ariaLabel={t("rep_utilBy")} max={100}
                  items={util.data.vehicles.map((v) => ({ key: v.deviceId, label: v.name, value: v.daysUsedPct ?? 0, display: pct(v.daysUsedPct), note: `${v.daysUsed} / ${v.daysTracked} · ${t(`rep_level_${v.level}`)}` }))}
                />
              </section>
              <DataTable tableId="report-util" csvName={`routenorth-utilization-${tFrom}-${to}`} columns={utilCols} rows={util.data.vehicles} rowKey={(r) => r.deviceId} empty={<EmptyState title={t("noData")} />} maxHeight="50vh" />
            </>
          )
        )}

        {!loading && !error && tab === "fuel" && fuel.data && (
          fuel.data.vehicles.length === 0 ? <EmptyState title={t("rep_fuelEmpty")} /> : (
            <>
              <div className="kpi-row">
                <StatTile label={t("rep_refuel")} value={fuelRows.filter((r) => r.kind === "refuel").length} />
                <StatTile label={t("rep_drain")} value={fuelRows.filter((r) => r.kind === "drain").length} tone={fuelRows.some((r) => r.kind === "drain") ? "warn" : undefined} />
              </div>
              <DataTable tableId="report-fuel" csvName={`routenorth-fuel-${tFrom}-${to}`} columns={fuelCols} rows={fuelRows} rowKey={(r) => r.id} empty={<EmptyState title={t("rep_fuelNone")} />} maxHeight="50vh" />
              {fuelRows.some((r) => !r.tankKnown) && <p className="panel-note">* {t("rep_fuelTank")}</p>}
              <p className="panel-note">{fuel.data.note}</p>
            </>
          )
        )}
      </div>
    </div>
  );
}
