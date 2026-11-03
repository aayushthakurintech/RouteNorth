"use client";
import { CloudSnow, Copy, FileStack, Link2, Scissors, Sparkles, Merge } from "lucide-react";
import { useEffect, useState } from "react";
import type { MessageKey } from "@routenorth/shared";
import { Chip, Tabs } from "@/components/ui/primitives";
import { apiGet, apiSend } from "@/lib/api";
import { formatDuration, formatKm, formatTime } from "@/lib/format";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import type { RouteDetail } from "@/lib/routes";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Totals { distanceM: number; durationS: number; lateCount: number; waitS: number; breakS: number; chargeS: number }
interface Plan { order: string[]; totals: Totals; cost: number; violations: string[]; source: string; stops: { id: string; arriveAt: string; lateS: number }[]; pauses: { kind: string; at: string }[] }
interface Compare { a: Plan; b: Plan; comparison: { winner: "a" | "b" | "tie"; delta: { distanceM: number; durationS: number; cost: number; lateCount: number } } }
interface WhatIf { insertAt: number; addedDistanceM: number; addedDurationS: number; newLate: number; addedCost: number; violations: string[]; source: string }
const AVOIDS = ["tolls", "highways", "ferries", "unpaved"] as const;

/** Route planning tools: optimize, compare plan A with plan B, preview adding a stop, weather along the way, templates, sharing, splitting. */
export function PlannerPanel({ route, pin, selected, onChanged }: { route: RouteDetail; pin: { lat: number; lng: number } | null; selected: string[]; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const { toast } = useToast();
  const [tab, setTab] = useState("optimize");
  const [objective, setObjective] = useState<"time" | "distance">(route.objective ?? "time");
  const [avoid, setAvoid] = useState<string[]>(route.avoid ?? []);
  const [startTime, setStartTime] = useState((route.startTime ?? "08:00").slice(0, 5));
  const [cmp, setCmp] = useState<Compare | null>(null);
  const [what, setWhat] = useState<WhatIf | null>(null);
  const [busy, setBusy] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const weather = useApi<{ available: boolean; worst?: string; stops: { id: string; weather: { label: string; level: string; reason: string | null; tempC: number } }[] }>(tab === "weather" ? `/weather/route/${route.id}` : null);
  const sameDay = useApi<{ id: string; name: string }[]>(tab === "split" ? `/routes?date=${route.date}` : null);
  const [mergeFrom, setMergeFrom] = useState("");
  useEffect(() => setCmp(null), [objective, avoid, startTime]);

  const pending = route.stops.filter((s) => s.status === "pending");
  const base = {
    date: route.date, vehicleId: route.vehicleId ?? undefined, driverId: route.driverId ?? undefined, depotId: route.depotId ?? undefined, startTime, objective, avoid,
    stops: pending.map((s) => ({ id: s.id, name: s.name, lat: s.lat, lng: s.lng, windowStart: s.windowStart ?? undefined, windowEnd: s.windowEnd ?? undefined, serviceMin: s.serviceMin ?? 5, weightKg: s.weightKg ?? 0, volumeM3: s.volumeM3 ?? 0, packages: s.packages, priority: s.priority ?? "normal", kind: s.kind ?? "delivery" })),
  };
  const run = async <T,>(fn: () => Promise<T>, done: (r: T) => void) => {
    setBusy(true);
    try { done(await fn()); } catch (e) { toast((e as Error).message, { tone: "error" }); } finally { setBusy(false); }
  };
  const km = (m: number) => formatKm(Math.abs(m), locale);
  const signed = (n: number, f: (x: number) => string) => `${n > 0 ? "+" : n < 0 ? "−" : ""}${f(Math.abs(n))}`;

  const planTable = (p: Plan, title: string, winner: boolean) => (
    <div className="stack" style={{ gap: 2, flex: 1, minWidth: 140 }}>
      <strong>{title} {winner && <Chip tone="ok">{t("planBest")}</Chip>}</strong>
      <span>{km(p.totals.distanceM)} · {formatDuration(p.totals.durationS)}</span>
      <span className="meta">{t("planCost")}: ${p.cost.toFixed(2)}</span>
      <span className="meta">{t("planLate")}: {p.totals.lateCount}</span>
      {p.violations.length > 0 && <Chip tone="danger">{p.violations.map((v) => t(`planViolation_${v}` as MessageKey)).join(", ")}</Chip>}
    </div>
  );

  async function savePrefs() {
    await apiSend("PATCH", `/routes/${route.id}`, { objective, avoid, startTime });
  }

  return (
    <section className="stack" aria-label={t("planTools")} style={{ border: "1px solid var(--line)", borderRadius: 10, padding: 10 }}>
      <Tabs label={t("planTools")} value={tab} onChange={setTab} tabs={[
        { id: "optimize", label: t("planOptimize") }, { id: "whatif", label: t("planWhatIf") }, { id: "weather", label: t("planWeather") }, { id: "split", label: t("planSplitMerge") }, { id: "share", label: t("planShare") },
      ]} />
      {tab === "optimize" && (
        <div className="stack">
          <div className="row">
            <label className="field">{t("f_objective")}
              <select value={objective} onChange={(e) => setObjective(e.target.value as "time" | "distance")}><option value="time">{t("v_time")}</option><option value="distance">{t("v_distance")}</option></select>
            </label>
            <label className="field">{t("f_startTime")}<input type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} /></label>
          </div>
          <div className="row" role="group" aria-label={t("f_avoid")}>
            <span className="meta">{t("f_avoid")}:</span>
            {AVOIDS.map((a) => <label key={a} className="row" style={{ gap: 4 }}><input type="checkbox" checked={avoid.includes(a)} onChange={(e) => setAvoid(e.target.checked ? [...avoid, a] : avoid.filter((x) => x !== a))} />{t(`v_${a}` as MessageKey)}</label>)}
          </div>
          <button type="button" className="btn" disabled={busy || pending.length < 2 || !can("routes.write")} onClick={() => run(
            () => apiSend<Compare>("POST", "/plan/compare", { a: { ...base, fixedOrder: true }, b: base }), setCmp)}>
            <Sparkles size={16} aria-hidden />{t("planOptimize")}
          </button>
          {pending.length < 2 && <span className="meta">{t("planNeedStops")}</span>}
          {cmp && (
            <div className="stack">
              <div className="row" style={{ alignItems: "flex-start" }}>{planTable(cmp.a, t("planCurrent"), cmp.comparison.winner === "a")}{planTable(cmp.b, t("planOptimized"), cmp.comparison.winner === "b")}</div>
              <span className="meta">
                {signed(cmp.comparison.delta.distanceM, km)} · {signed(cmp.comparison.delta.durationS, formatDuration)} · {signed(cmp.comparison.delta.cost, (x) => `$${x.toFixed(2)}`)}
                {" · "}{t("planEstimateNote", { source: cmp.b.source === "estimate" ? t("planEstimated") : cmp.b.source })}
              </span>
              <ol className="stoplist" aria-label={t("planOptimized")}>
                {cmp.b.order.map((id, i) => {
                  const s = route.stops.find((x) => x.id === id)!; const st = cmp.b.stops.find((x) => x.id === id);
                  return <li key={id}><strong>{i + 1}. {s.name}</strong><span className="meta"> {st ? `${t("eta")} ${formatTime(st.arriveAt, locale)}` : ""}{st && st.lateS > 0 ? ` · ${t("outcome_late")}` : ""}</span></li>;
                })}
              </ol>
              {cmp.b.pauses.length > 0 && <span className="meta">{cmp.b.pauses.map((p) => `${t(`pause_${p.kind}` as MessageKey)} ${formatTime(p.at, locale)}`).join(" · ")}</span>}
              <div className="row">
                <button type="button" className="btn" disabled={busy} onClick={() => run(async () => { await savePrefs(); return apiSend("POST", `/plan/routes/${route.id}/optimize`, { apply: true, startTime, objective, avoid }); }, () => { toast(t("planApplied")); setCmp(null); onChanged(); })}>{t("planApply")}</button>
                <button type="button" className="btn alt" onClick={() => setCmp(null)}>{t("planKeepCurrent")}</button>
              </div>
            </div>
          )}
        </div>
      )}
      {tab === "whatif" && (
        <div className="stack">
          <p className="meta">{t("planWhatIfHelp")}</p>
          <button type="button" className="btn" disabled={busy || !pin} onClick={() => run(() => apiSend<WhatIf>("POST", "/plan/whatif", { plan: { ...base, fixedOrder: true }, add: { name: "?", lat: pin!.lat, lng: pin!.lng } }), setWhat)}>{t("planWhatIfRun")}</button>
          {!pin && <span className="meta">{t("planPlacePin")}</span>}
          {what && <div role="status" className="stack" style={{ gap: 2 }}>
            <strong>{t("planWhatIfResult", { pos: what.insertAt + 1 })}</strong>
            <span>{signed(what.addedDistanceM, km)} · {signed(what.addedDurationS, formatDuration)} · ${what.addedCost.toFixed(2)}</span>
            <span className={what.newLate ? "err" : "meta"}>{what.newLate ? t("planWhatIfLate", { n: what.newLate }) : t("planWhatIfNoLate")}</span>
          </div>}
        </div>
      )}
      {tab === "weather" && (
        <div className="stack">
          {weather.loading && !weather.loaded && <span className="meta">{t("loading")}</span>}
          {weather.data && !weather.data.available && <span className="meta">{t("weatherUnavailable")}</span>}
          {weather.data?.available && <>
            <Chip tone={weather.data.worst === "severe" ? "danger" : weather.data.worst === "caution" ? "warn" : "ok"}><CloudSnow size={14} aria-hidden />{t(`weatherLevel_${weather.data.worst ?? "ok"}` as MessageKey)}</Chip>
            <ul className="cards">{weather.data.stops.map((w) => <li key={w.id}><span className="static">{route.stops.find((s) => s.id === w.id)?.name}<span className="meta">{w.weather.label} · {Math.round(w.weather.tempC)}°C{w.weather.reason ? ` · ${w.weather.reason}` : ""}</span></span></li>)}</ul>
          </>}
        </div>
      )}
      {tab === "split" && (
        <div className="stack">
          <p className="meta">{t("planSplitHelp")}</p>
          <button type="button" className="btn alt" disabled={busy || selected.length === 0 || !can("routes.dispatch")} onClick={() => run(() => apiSend("POST", `/dispatch/routes/${route.id}/split`, { stopIds: selected }), () => { toast(t("planSplitDone")); onChanged(); })}><Scissors size={16} aria-hidden />{t("planSplit", { n: selected.length })}</button>
          <label className="field">{t("planMergeFrom")}
            <select value={mergeFrom} onChange={(e) => setMergeFrom(e.target.value)}><option value="">{t("rChoose")}</option>{(sameDay.data ?? []).filter((r) => r.id !== route.id).map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
          </label>
          <button type="button" className="btn alt" disabled={busy || !mergeFrom || !can("routes.dispatch")} onClick={() => run(() => apiSend("POST", `/dispatch/routes/${route.id}/merge`, { fromId: mergeFrom }), () => { toast(t("planMergeDone")); setMergeFrom(""); onChanged(); })}><Merge size={16} aria-hidden />{t("planMerge")}</button>
          <button type="button" className="btn alt" disabled={busy || !can("routes.write")} onClick={() => run(() => apiSend("POST", `/route-templates/from-route/${route.id}`, { name: `${route.name}` }), () => toast(t("planTemplateSaved")))}><FileStack size={16} aria-hidden />{t("planSaveTemplate")}</button>
        </div>
      )}
      {tab === "share" && (
        <div className="stack">
          <p className="meta">{t("shareHelp")}</p>
          <button type="button" className="btn alt" disabled={busy || !(can("routes.dispatch") || can("fleet.manage"))} onClick={() => run(() => apiSend<{ path: string }>("POST", "/share", { routeId: route.id, hours: 24, label: route.name }), (r) => setShareUrl(`${location.origin}${r.path}`))}><Link2 size={16} aria-hidden />{t("shareCreate")}</button>
          {shareUrl && <div className="row"><input readOnly value={shareUrl} aria-label={t("shareLink")} onFocus={(e) => e.currentTarget.select()} style={{ flex: 1 }} /><button type="button" className="btn sm" onClick={() => navigator.clipboard?.writeText(shareUrl).then(() => toast(t("copied")))}><Copy size={14} aria-hidden />{t("copy")}</button></div>}
        </div>
      )}
    </section>
  );
}
