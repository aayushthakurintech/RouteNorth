"use client";
import { useMemo, useState } from "react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState, ErrorState, PageHead, SkeletonList } from "@/components/ui/primitives";
import { dayRange, formatDuration, formatKm, formatTime, todayLocal } from "@/lib/format";
import { useI18n } from "@/lib/i18n-context";
import { useApi } from "@/lib/use-api";

interface DailyRow { deviceId: string; name: string; date: string; distanceM: number; idleS: number; movingS: number }
interface IdleVehicle { deviceId: string; name: string; totalIdleS: number; idleStops: { time: string; durationS: number }[] }

const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return todayLocal(new Date(y, m - 1, d + n));
};

export default function ReportsPage() {
  const { t, locale } = useI18n();
  const [to, setTo] = useState(todayLocal());
  const [from, setFrom] = useState(addDays(todayLocal(), -6));
  const q = from > to ? null : `from=${encodeURIComponent(dayRange(from).from)}&to=${encodeURIComponent(dayRange(to).to)}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`;
  const daily = useApi<DailyRow[]>(q && `/reports/daily?${q}`);
  const idle = useApi<IdleVehicle[]>(q && `/reports/idle?${q}`);

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

  const loading = (!daily.loaded && !daily.error) || (!idle.loaded && !idle.error);
  const error = daily.error ?? idle.error;
  return (
    <div className="content">
      <PageHead title={t("reports")} />
      <div className="row">
        <label className="field">{t("from")}<input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className="field">{t("to")}<input type="date" value={to} min={from} max={todayLocal()} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
      </div>
      {loading && <SkeletonList rows={5} h={38} />}
      {error && !loading && <ErrorState error={error} onRetry={() => { daily.reload(); idle.reload(); }} />}
      {!loading && !error && (
        <>
          <h2>{t("dailyDistance")}</h2>
          <DataTable tableId="report-daily" csvName={`routenorth-daily-${from}-${to}`} columns={dailyCols} rows={daily.data ?? []} rowKey={(r) => r.date + r.deviceId} empty={<EmptyState title={t("noData")} />} maxHeight="50vh" />
          <h2>{t("idleReport")}</h2>
          <DataTable tableId="report-idle" csvName={`routenorth-idle-${from}-${to}`} columns={idleCols} rows={idle.data ?? []} rowKey={(r) => r.deviceId} empty={<EmptyState title={t("noData")} />} maxHeight="40vh" />
        </>
      )}
    </div>
  );
}
