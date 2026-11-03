"use client";
import type { Stop, Trip } from "@routenorth/shared";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { LanguageToggle } from "@/components/LanguageToggle";
import type { TrackPoint } from "@/components/ReplayMap";
import { apiGet, Unauthorized } from "@/lib/api";
import { dayRange, formatDuration, formatKm, formatTime, todayLocal } from "@/lib/format";
import { useI18n } from "@/lib/i18n-context";

const ReplayMap = dynamic(() => import("@/components/ReplayMap").then((m) => m.ReplayMap), { ssr: false });

const SPEEDS = [1, 4, 16, 64];

export default function HistoryPage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { deviceId } = useParams<{ deviceId: string }>();
  const [date, setDate] = useState(todayLocal());
  const [track, setTrack] = useState<TrackPoint[]>([]);
  const [data, setData] = useState<{ trips: Trip[]; stops: Stop[] } | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [index, setIndex] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(16);
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    setState("loading"); setPlaying(false); setIndex(0);
    const { from, to } = dayRange(date);
    const q = `from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`;
    Promise.all([
      apiGet<TrackPoint[]>(`/vehicles/${deviceId}/track?${q}`),
      apiGet<{ trips: Trip[]; stops: Stop[] }>(`/vehicles/${deviceId}/trips?${q}`),
    ])
      .then(([tr, td]) => { if (!cancelled) { setTrack(tr); setData(td); setState("ready"); } })
      .catch((e) => {
        if (e instanceof Unauthorized) router.replace("/login");
        else if (!cancelled) setState("error");
      });
    return () => { cancelled = true; };
  }, [date, deviceId, router]);

  // Replay: each tick advances by `speed` real fixes' worth of time.
  useEffect(() => {
    clearInterval(timer.current);
    if (!playing) return;
    timer.current = setInterval(() => {
      setIndex((i) => {
        if (i >= track.length - 1) { setPlaying(false); return i; }
        return Math.min(track.length - 1, i + Math.max(1, Math.round(speed / 4)));
      });
    }, 250);
    return () => clearInterval(timer.current);
  }, [playing, speed, track.length]);

  const stopMarkers = useMemo(
    () => (data?.stops ?? []).map((s) => ({ lat: s.start.lat, lng: s.start.lng, idling: s.idling })),
    [data],
  );
  const current = track[Math.min(index, track.length - 1)];

  return (
    <div className="shell">
      <aside className="panel">
        <header>
          <Link href="/" className="link">← {t("back")}</Link>
          <LanguageToggle />
        </header>
        <h1 className="h">{t("history")}</h1>
        <label className="field">
          {t("date")}
          <input type="date" value={date} max={todayLocal()} onChange={(e) => e.target.value && setDate(e.target.value)} />
        </label>

        {state === "loading" && <p className="empty">{t("loading")}</p>}
        {state === "error" && <p className="error" role="alert">{t("loadFailed")}</p>}

        {state === "ready" && track.length > 0 && (
          <section aria-label={t("replaySpeed")} className="replay">
            <div className="row">
              <button type="button" onClick={() => setPlaying((p) => !p)}>{playing ? t("pause") : t("play")}</button>
              <select aria-label={t("replaySpeed")} value={speed} onChange={(e) => setSpeed(Number(e.target.value))}>
                {SPEEDS.map((s) => <option key={s} value={s}>{s}×</option>)}
              </select>
              {current && <span className="meta">{formatTime(current.time, locale)} · {Math.round(current.speed)} km/h</span>}
            </div>
            <input
              type="range" min={0} max={track.length - 1} value={index} aria-label={t("position")}
              onChange={(e) => { setPlaying(false); setIndex(Number(e.target.value)); }}
            />
          </section>
        )}

        {state === "ready" && track.length === 0 && <p className="empty">{t("noData")}</p>}

        {state === "ready" && data && track.length > 0 && (
          <>
            <h2>{t("trips")}</h2>
            {data.trips.length === 0 ? <p className="empty">{t("noTrips")}</p> : (
              <ul className="cards">
                {data.trips.map((trip) => (
                  <li key={trip.start.time}>
                    <button
                      type="button"
                      onClick={() => {
                        const i = track.findIndex((p) => p.time >= trip.start.time);
                        setPlaying(false); setIndex(Math.max(0, i));
                      }}
                    >
                      <strong>{formatTime(trip.start.time, locale)} – {formatTime(trip.end.time, locale)}</strong>
                      <span className="meta">
                        {formatKm(trip.distanceM, locale)} · {formatDuration(trip.durationS)} · {t("idleTime")} {formatDuration(trip.idleS)}
                      </span>
                      <span className="meta">{t("maxSpeed")} {Math.round(trip.maxSpeedKmh)} km/h · {t("avgSpeed")} {Math.round(trip.avgSpeedKmh)} km/h</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <h2>{t("stops")}</h2>
            <ul className="cards">
              {data.stops.map((s) => (
                <li key={s.start.time} className="static">
                  <strong>{formatTime(s.start.time, locale)}{s.open ? ` (${t("ongoing")})` : ` – ${formatTime(s.end.time, locale)}`}</strong>
                  <span className="meta">{s.idling ? t("idling") : t("parked")} · {formatDuration(s.durationS)}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </aside>
      <ReplayMap track={track} stops={stopMarkers} index={index} />
    </div>
  );
}
