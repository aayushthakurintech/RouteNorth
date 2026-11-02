"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LanguageToggle } from "@/components/LanguageToggle";
import { apiGet, Unauthorized } from "@/lib/api";
import { dayRange, formatDuration, formatKm, formatTime, toCsv, todayLocal } from "@/lib/format";
import { useI18n } from "@/lib/i18n-context";

interface DailyRow { deviceId: string; name: string; date: string; distanceM: number; idleS: number; movingS: number }
interface IdleVehicle { deviceId: string; name: string; totalIdleS: number; idleStops: { time: string; durationS: number }[] }

const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return todayLocal(new Date(y, m - 1, d + n));
};

export default function ReportsPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [to, setTo] = useState(todayLocal());
  const [from, setFrom] = useState(addDays(todayLocal(), -6));
  const [daily, setDaily] = useState<DailyRow[]>([]);
  const [idle, setIdle] = useState<IdleVehicle[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");

  useEffect(() => {
    if (from > to) return;
    let cancelled = false;
    setState("loading");
    const q = `from=${encodeURIComponent(dayRange(from).from)}&to=${encodeURIComponent(dayRange(to).to)}&tz=${encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)}`;
    Promise.all([apiGet<DailyRow[]>(`/reports/daily?${q}`), apiGet<IdleVehicle[]>(`/reports/idle?${q}`)])
      .then(([d, i]) => { if (!cancelled) { setDaily(d); setIdle(i); setState("ready"); } })
      .catch((e) => {
        if (e instanceof Unauthorized) router.replace("/login");
        else if (!cancelled) setState("error");
      });
    return () => { cancelled = true; };
  }, [from, to, router]);

  function exportCsv() {
    const csv = toCsv(
      [t("date"), t("vehicle"), `${t("distance")} (km)`, `${t("movingTime")} (min)`, `${t("idleTime")} (min)`],
      daily.map((r) => [r.date, r.name, (r.distanceM / 1000).toFixed(1), Math.round(r.movingS / 60), Math.round(r.idleS / 60)]),
    );
    const url = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `routenorth-daily-${from}-${to}.csv`; a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="page">
      <header className="row">
        <Link href="/" className="link">← {t("back")}</Link>
        <LanguageToggle />
      </header>
      <h1>{t("reports")}</h1>
      <div className="row">
        <label className="field">{t("from")}<input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} /></label>
        <label className="field">{t("to")}<input type="date" value={to} min={from} max={todayLocal()} onChange={(e) => e.target.value && setTo(e.target.value)} /></label>
        <button type="button" onClick={exportCsv} disabled={daily.length === 0}>{t("exportCsv")}</button>
      </div>

      {state === "loading" && <p className="empty">{t("loading")}</p>}
      {state === "error" && <p className="error" role="alert">{t("loadFailed")}</p>}
      {state === "ready" && (
        <>
          <h2>{t("dailyDistance")}</h2>
          {daily.length === 0 ? <p className="empty">{t("noData")}</p> : (
            <table>
              <thead><tr><th>{t("date")}</th><th>{t("vehicle")}</th><th>{t("distance")}</th><th>{t("movingTime")}</th><th>{t("idleTime")}</th></tr></thead>
              <tbody>
                {daily.map((r) => (
                  <tr key={r.date + r.deviceId}>
                    <td>{r.date}</td><td>{r.name}</td><td>{formatKm(r.distanceM, locale)}</td>
                    <td>{formatDuration(r.movingS)}</td><td>{formatDuration(r.idleS)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          <h2>{t("idleReport")}</h2>
          {idle.length === 0 ? <p className="empty">{t("noData")}</p> : (
            <table>
              <thead><tr><th>{t("vehicle")}</th><th>{t("totalIdle")}</th><th>{t("idleStopsTitle")}</th></tr></thead>
              <tbody>
                {idle.map((v) => (
                  <tr key={v.deviceId}>
                    <td>{v.name}</td><td>{formatDuration(v.totalIdleS)}</td>
                    <td>
                      {v.idleStops.slice().sort((a, b) => b.durationS - a.durationS).slice(0, 3)
                        .map((s) => `${new Date(s.time).toLocaleDateString(locale === "fr" ? "fr-CA" : "en-CA")} ${formatTime(s.time, locale)} (${formatDuration(s.durationS)})`)
                        .join(" · ") || "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </main>
  );
}
