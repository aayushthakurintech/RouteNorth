"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";
import type { MessageKey, StopStatus } from "@routenorth/shared";
import { LanguageToggle } from "@/components/LanguageToggle";
import { ProofGallery } from "@/components/ProofGallery";
import { apiGet, apiSend, Unauthorized } from "@/lib/api";
import { formatDuration, formatTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n-context";
import { localToIso, moveStop, STOP_COLORS, type RouteDetail, type RouteReport, type RouteStop } from "@/lib/routes";

const RouteMap = dynamic(() => import("@/components/RouteMap").then((m) => m.RouteMap), { ssr: false });

interface LiveVehicle { vehicleId: string | null; lat: number; lng: number }

export default function RoutePage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const [route, setRoute] = useState<RouteDetail | null>(null);
  const [report, setReport] = useState<RouteReport | null>(null);
  const [live, setLive] = useState<LiveVehicle[]>([]);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [placing, setPlacing] = useState(false);
  const [pin, setPin] = useState<{ lat: number; lng: number } | null>(null);
  const [form, setForm] = useState({ name: "", address: "", windowStart: "", windowEnd: "", packages: "0" });
  const [saveError, setSaveError] = useState<string | null>(null);
  const [drivers, setDrivers] = useState<{ id: string; email: string }[]>([]);

  const load = useCallback(async () => {
    try {
      const [r, rep, l] = await Promise.all([
        apiGet<RouteDetail>(`/routes/${id}`),
        apiGet<RouteReport>(`/routes/${id}/report`),
        apiGet<LiveVehicle[]>("/vehicles/live"),
      ]);
      setRoute(r); setReport(rep); setLive(l); setState("ready");
    } catch (e) {
      if (e instanceof Unauthorized) router.replace("/login"); else setState("error");
    }
  }, [id, router]);

  useEffect(() => { apiGet<{ id: string; email: string }[]>("/users?role=driver").then(setDrivers).catch(() => setDrivers([])); }, []);

  useEffect(() => { load(); const i = setInterval(load, 10_000); return () => clearInterval(i); }, [load]);

  const run = async (fn: () => Promise<RouteDetail | void>) => {
    setSaveError(null);
    try {
      const next = await fn();
      if (next) setRoute(next);
      await load();
    } catch (e) {
      if (e instanceof Unauthorized) router.replace("/login");
      else setSaveError((e as Error).message || t("saveFailed"));
    }
  };

  const vehicle = useMemo(() => live.find((v) => v.vehicleId && v.vehicleId === route?.vehicleId) ?? null, [live, route]);
  const outcomes = useMemo(() => new Map(report?.stops.map((s) => [s.id, s])), [report]);

  function addStop(e: FormEvent) {
    e.preventDefault();
    if (!pin) return;
    run(async () => {
      const next = await apiSend<RouteDetail>("POST", `/routes/${id}/stops`, {
        stops: [{
          name: form.name, address: form.address || undefined, lat: pin.lat, lng: pin.lng,
          windowStart: localToIso(form.windowStart), windowEnd: localToIso(form.windowEnd), packages: Number(form.packages) || 0,
        }],
      });
      setForm({ name: "", address: "", windowStart: "", windowEnd: "", packages: "0" });
      setPin(null); setPlacing(false);
      return next;
    });
  }

  async function onCsv(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    const csv = await file.text();
    run(() => apiSend<RouteDetail>("POST", `/routes/${id}/stops/import`, { csv }));
  }

  const move = (index: number, delta: -1 | 1) => {
    const order = moveStop(route!.stops.map((s) => s.id), index, delta);
    if (order) run(() => apiSend<RouteDetail>("PUT", `/routes/${id}/stops/order`, { stopIds: order }));
  };
  const setStatus = (s: RouteStop, status: StopStatus) =>
    run(() => apiSend<RouteDetail>("PATCH", `/routes/${id}/stops/${s.id}`, { status }));
  const remove = (s: RouteStop) => {
    if (window.confirm(`${t("confirmRemoveStop")}\n${s.name}`)) run(() => apiSend<RouteDetail>("DELETE", `/routes/${id}/stops/${s.id}`));
  };

  if (state === "loading") return <main className="page"><p className="empty">{t("loading")}</p></main>;
  if (state === "error" || !route) return <main className="page"><p className="error" role="alert">{t("loadFailed")}</p></main>;

  return (
    <div className="shell">
      <aside className="panel">
        <header>
          <Link href="/routes" className="link">← {t("routes")}</Link>
          <LanguageToggle />
        </header>
        <h1 className="h">{route.name}</h1>
        <p className="meta">{route.date} · {t(`route_${route.status}` as MessageKey)}</p>

        <label className="field">
          {t("assignDriver")}
          <select
            value={route.driverId ?? ""}
            onChange={(e) => run(() => apiSend<RouteDetail>("PATCH", `/routes/${route.id}`, { driverId: e.target.value || null }))}
          >
            <option value="">{t("noDriver")}</option>
            {drivers.map((d) => <option key={d.id} value={d.id}>{d.email}</option>)}
          </select>
        </label>

        {report && (
          <section className="summary" aria-label={t("plannedVsActual")} aria-live="polite">
            <strong>{report.summary.done}/{report.summary.total} {t("stopsProgress")}</strong>
            {report.summary.onTimePct !== null && (
              <span className="meta">{t("onTimeRate")}: {report.summary.onTimePct}% · {t("outcome_late")}: {report.summary.late}</span>
            )}
          </section>
        )}

        {saveError && <p className="error" role="alert">{saveError}</p>}

        {route.stops.length === 0 ? <p className="empty">{t("noStops")}</p> : (
          <ol className="stoplist">
            {route.stops.map((s, i) => {
              const o = outcomes.get(s.id);
              return (
                <li key={s.id}>
                  <div className="stop-head">
                    <span className="num" style={{ background: STOP_COLORS[s.status] }} aria-hidden>{s.sequence}</span>
                    <strong>{s.name}</strong>
                    <span className="meta">{t(`status_${s.status}` as MessageKey)}</span>
                  </div>
                  <div className="meta">
                    {s.windowStart || s.windowEnd ? `${s.windowStart ? formatTime(s.windowStart, locale) : "…"} – ${s.windowEnd ? formatTime(s.windowEnd, locale) : "…"}` : ""}
                    {s.eta && s.status === "pending" ? ` · ${t("eta")} ${formatTime(s.eta, locale)}` : ""}
                    {s.arrivedAt ? ` · ${t("arrived")} ${formatTime(s.arrivedAt, locale)}` : ""}
                    {s.departedAt ? ` · ${t("departed")} ${formatTime(s.departedAt, locale)}` : ""}
                    {o && o.outcome !== "pending" && o.outcome !== "no_window" ? ` · ${t(`outcome_${o.outcome}` as MessageKey)}` : ""}
                    {o?.dwellS != null ? ` · ${formatDuration(o.dwellS)}` : ""}
                  </div>
                  {(s.status === "done" || s.status === "failed") && <ProofGallery stopId={s.id} label={t("proofs")} />}
                  <div className="actions">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`${t("moveUp")}: ${s.name}`}>↑</button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === route.stops.length - 1} aria-label={`${t("moveDown")}: ${s.name}`}>↓</button>
                    <button type="button" onClick={() => setStatus(s, "done")} aria-label={`${t("markDone")}: ${s.name}`}>{t("markDone")}</button>
                    <button type="button" onClick={() => setStatus(s, "failed")} aria-label={`${t("markFailed")}: ${s.name}`}>{t("markFailed")}</button>
                    <button type="button" onClick={() => setStatus(s, "skipped")} aria-label={`${t("markSkipped")}: ${s.name}`}>{t("markSkipped")}</button>
                    <button type="button" className="danger" onClick={() => remove(s)} aria-label={`${t("remove")}: ${s.name}`}>×</button>
                  </div>
                </li>
              );
            })}
          </ol>
        )}

        <h2>{t("addStop")}</h2>
        <form className="stack" onSubmit={addStop}>
          <label className="field">{t("stopName")}
            <input required maxLength={200} name="stopName" autoComplete="off" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
          </label>
          <label className="field">{t("address")}
            <input maxLength={300} name="address" autoComplete="off" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />
          </label>
          <div className="row">
            <label className="field">{t("windowStart")}
              <input type="datetime-local" value={form.windowStart} onChange={(e) => setForm({ ...form, windowStart: e.target.value })} />
            </label>
            <label className="field">{t("windowEnd")}
              <input type="datetime-local" value={form.windowEnd} onChange={(e) => setForm({ ...form, windowEnd: e.target.value })} />
            </label>
          </div>
          <label className="field">{t("packagesCount")}
            <input type="number" min={0} value={form.packages} onChange={(e) => setForm({ ...form, packages: e.target.value })} />
          </label>
          <div className="row">
            <button type="button" className="btn" onClick={() => setPlacing((p) => !p)} aria-pressed={placing}>{t("clickMapToPlace")}</button>
          </div>
          <div className="row">
            <label className="field">{t("latitude")}
              <input
                type="number" step="any" min={-90} max={90} inputMode="decimal" autoComplete="off" name="lat"
                value={pin ? pin.lat : ""} onChange={(e) => setPin(e.target.value === "" ? null : { lat: Number(e.target.value), lng: pin?.lng ?? 0 })}
              />
            </label>
            <label className="field">{t("longitude")}
              <input
                type="number" step="any" min={-180} max={180} inputMode="decimal" autoComplete="off" name="lng"
                value={pin ? pin.lng : ""} onChange={(e) => setPin(e.target.value === "" ? null : { lat: pin?.lat ?? 0, lng: Number(e.target.value) })}
              />
            </label>
          </div>
          <button type="submit" className="btn" disabled={!pin || !form.name}>{t("addStop")}</button>
        </form>

        <label className="field">{t("importCsv")}
          <input type="file" accept=".csv,text/csv" onChange={onCsv} />
          <span className="meta">{t("csvHelp")}</span>
        </label>
      </aside>
      <RouteMap
        stops={route.stops} vehicle={vehicle} pin={pin}
        onPick={placing ? (lat, lng) => setPin({ lat, lng }) : null}
      />
    </div>
  );
}
