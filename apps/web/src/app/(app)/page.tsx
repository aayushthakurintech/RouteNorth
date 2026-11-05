"use client";
import { Crosshair, Link2 } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import type { MessageKey } from "@routenorth/shared";
import type { ZoneShape } from "@/components/GeofenceMap";
import { EmptyState, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";
import { filterFleet, STATUS_COLORS, type LiveVehicle } from "@/lib/fleet";
import { useI18n } from "@/lib/i18n-context";
import { loadSession } from "@/lib/session";
import { useFleet } from "@/lib/use-fleet";

// MapLibre needs the browser (WebGL), so it is never rendered on the server.
const FleetMap = dynamic(() => import("@/components/FleetMap").then((m) => m.FleetMap), { ssr: false });

/** Map-first live view: the map fills the page and the vehicle list floats on top of it. */
export default function LivePage() {
  return <Suspense fallback={null}><LiveView /></Suspense>;
}

function LiveView() {
  const { t, locale } = useI18n();
  const params = useSearchParams();
  const [token, setToken] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(params.get("v"));
  const [follow, setFollow] = useState(false);
  const { can } = useMe();
  const { toast } = useToast();
  const [showZones, setShowZones] = useState(false);
  const [heatKind, setHeatKind] = useState("");
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const zones = useApi<ZoneShape[]>(showZones ? "/r/geofences?limit=500" : null);
  const heatRange = useMemo(() => `from=${encodeURIComponent(new Date(Date.now() - 7 * 86_400_000).toISOString())}&to=${encodeURIComponent(new Date().toISOString())}`, [heatKind]); // eslint-disable-line react-hooks/exhaustive-deps
  const heat = useApi<{ lat: number; lng: number; weight: number }[]>(heatKind ? `/heat?kind=${heatKind}&${heatRange}` : null);

  useEffect(() => { setToken(loadSession()?.token ?? null); }, []);
  const { fleet, connected, loaded } = useFleet(token);

  const list = useMemo(() => filterFleet(fleet, query), [fleet, query]);
  const selected = selectedId ? fleet[selectedId] : undefined;
  // Sensor values change slowly and are not in the WebSocket message, so refresh them once a minute.
  const live = useApi<LiveVehicle[]>(selected ? "/vehicles/live" : null, { intervalMs: 60_000 });
  const telemetry = live.data?.find((v) => v.deviceId === selectedId)?.telemetry ?? selected?.telemetry;
  const weather = useApi<{ available: boolean; tempC?: number; label?: string; level?: string; reason?: string | null; windKmh?: number; precipProb?: number }>(selected ? `/weather?lat=${selected.lat.toFixed(3)}&lng=${selected.lng.toFixed(3)}` : null);
  async function share() {
    if (!selected) return;
    try {
      const r = await apiSend<{ path: string }>("POST", "/share", { deviceId: selected.deviceId, hours: 24 });
      const url = `${location.origin}${r.path}`;
      setShareUrl(url);
      try { await navigator.clipboard.writeText(url); toast(t("share_copied")); } catch { /* shown below */ }
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  const time = (iso: string) => new Date(iso).toLocaleTimeString(locale === "fr" ? "fr-CA" : "en-CA");

  return (
    <div className="mapfirst">
      <FleetMap fleet={fleet} selectedId={selectedId} follow={follow} onSelect={(id) => { setSelectedId(id); setFollow(false); setShareUrl(null); }} zones={showZones ? zones.data ?? [] : []} heat={heatKind ? heat.data ?? [] : []} />
      <aside className="float-panel" aria-label={t("vehicles")}>
        <div className="row">
          <strong className="display" style={{ fontSize: 16 }}>{t("vehicles")}</strong>
          <span className={connected ? "pill ok" : "pill warn"} role="status">{connected ? t("connected") : t("reconnecting")}</span>
        </div>
        <div className="row" role="group" aria-label={t("live_layers")}>
          <label className="row"><input type="checkbox" checked={showZones} onChange={(e) => setShowZones(e.target.checked)} />{t("navGeofences")}</label>
          <select aria-label={t("live_heat")} value={heatKind} onChange={(e) => setHeatKind(e.target.value)}>
            <option value="">{t("live_heatOff")}</option>
            <option value="stops">{t("live_heatStops")}</option>
            <option value="delays">{t("live_heatDelays")}</option>
            <option value="speeding">{t("live_heatSpeeding")}</option>
          </select>
        </div>
        <input type="search" placeholder={t("searchVehicles")} aria-label={t("searchVehicles")} value={query} onChange={(e) => setQuery(e.target.value)} />
        {!loaded && <SkeletonList rows={3} h={44} />}
        {loaded && list.length === 0 && <EmptyState title={t("noVehicles")} />}
        {list.length > 0 && (
          <ul className="vehicles" aria-label={t("vehicles")}>
            {list.map((v) => (
              <li key={v.deviceId}>
                <button type="button" aria-pressed={v.deviceId === selectedId} onClick={() => { setSelectedId(v.deviceId); setFollow(false); }}>
                  <span className="dot" style={{ background: STATUS_COLORS[v.status] }} aria-hidden />
                  <span className="name">{v.name}</span>
                  <span className="meta">{t(`status_${v.status}` as MessageKey)} · {Math.round(v.speed)} km/h</span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {selected && (
          <section className="detail" aria-live="polite">
            <h2>{selected.name}</h2>
            <p style={{ margin: 0 }}>{t(`kind_${selected.kind}` as MessageKey)} · {t(`status_${selected.status}` as MessageKey)}</p>
            <dl>
              <dt>{t("speed")}</dt><dd>{Math.round(selected.speed)} km/h</dd>
              <dt>{t("heading")}</dt><dd>{Math.round(selected.heading)}°</dd>
              <dt>{t("lastUpdate")}</dt><dd>{time(selected.time)}</dd>
              {weather.data?.available && <><dt>{t("planWeather")}</dt><dd>{Math.round(weather.data.tempC ?? 0)}°C · {weather.data.label}{weather.data.reason ? ` · ${weather.data.reason}` : ""}</dd></>}
            </dl>
            {telemetry && <TelemetryPanel tm={telemetry} />}
            {shareUrl && <input readOnly aria-label={t("shareLink")} value={shareUrl} onFocus={(e) => e.currentTarget.select()} />}
            <div className="row">
              <button type="button" className="btn alt sm" aria-pressed={follow} onClick={() => setFollow((f) => !f)}><Crosshair size={14} aria-hidden />{follow ? t("stopFollowing") : t("follow")}</button>
              <Link href={`/history/${selected.deviceId}`} className="btn sm">{t("history")}</Link>
              {(can("fleet.manage") || can("routes.dispatch")) && <button type="button" className="btn alt sm" onClick={() => void share()}><Link2 size={14} aria-hidden />{t("share_title")}</button>}
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}

const has = (...v: (number | null)[]) => v.some((x) => x != null);

/** What the tracker itself reports beyond position. Only values the tracker actually sends are shown. */
function TelemetryPanel({ tm }: { tm: NonNullable<LiveVehicle["telemetry"]> }) {
  const { t, locale } = useI18n();
  const nf = (n: number, d = 0) => new Intl.NumberFormat(locale, { maximumFractionDigits: d }).format(n);
  const rows: [string, string][] = [];
  if (tm.fuelLevelPct != null) rows.push([t("tm_fuel"), `${nf(tm.fuelLevelPct)}%`]);
  if (tm.rpm != null) rows.push([t("tm_rpm"), nf(tm.rpm)]);
  if (tm.coolantC != null) rows.push([t("tm_coolant"), `${nf(tm.coolantC)} °C`]);
  if (tm.extVoltage != null) rows.push([t("tm_voltage"), `${nf(tm.extVoltage, 1)} V`]);
  if (tm.batteryPct != null) rows.push([t("tm_battery"), `${nf(tm.batteryPct)}%`]);
  if (tm.satellites != null) rows.push([t("tm_sats"), nf(tm.satellites)]);
  if (tm.hdop != null) rows.push([t("tm_hdop"), nf(tm.hdop, 1)]);
  if (tm.signal != null) rows.push([t("tm_signal"), `${tm.signal}/5`]);
  if (tm.engineHours != null) rows.push([t("tm_hours"), `${nf(tm.engineHours, 1)} h`]);
  if (tm.odometerKm != null) rows.push([t("tm_odometer"), `${nf(tm.odometerKm, 1)} km`]);
  if (tm.altitude != null) rows.push([t("tm_altitude"), `${nf(tm.altitude)} m`]);
  if (!has(tm.fuelLevelPct, tm.rpm, tm.extVoltage, tm.batteryPct, tm.satellites) || rows.length === 0) return <p className="meta">{t("tm_none")}</p>;
  return (
    <details className="telemetry" open>
      <summary>{t("tm_section")}</summary>
      <dl>{rows.map(([k, v]) => <div key={k} className="kv"><dt>{k}</dt><dd>{v}</dd></div>)}</dl>
    </details>
  );
}
