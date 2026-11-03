"use client";
import { Crosshair } from "lucide-react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import type { MessageKey } from "@routenorth/shared";
import { EmptyState, SkeletonList } from "@/components/ui/primitives";
import { filterFleet, STATUS_COLORS } from "@/lib/fleet";
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

  useEffect(() => { setToken(loadSession()?.token ?? null); }, []);
  const { fleet, connected, loaded } = useFleet(token);

  const list = useMemo(() => filterFleet(fleet, query), [fleet, query]);
  const selected = selectedId ? fleet[selectedId] : undefined;
  const time = (iso: string) => new Date(iso).toLocaleTimeString(locale === "fr" ? "fr-CA" : "en-CA");

  return (
    <div className="mapfirst">
      <FleetMap fleet={fleet} selectedId={selectedId} follow={follow} onSelect={(id) => { setSelectedId(id); setFollow(false); }} />
      <aside className="float-panel" aria-label={t("vehicles")}>
        <div className="row">
          <strong className="display" style={{ fontSize: 16 }}>{t("vehicles")}</strong>
          <span className={connected ? "pill ok" : "pill warn"} role="status">{connected ? t("connected") : t("reconnecting")}</span>
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
            </dl>
            <div className="row">
              <button type="button" className="btn alt sm" aria-pressed={follow} onClick={() => setFollow((f) => !f)}><Crosshair size={14} aria-hidden />{follow ? t("stopFollowing") : t("follow")}</button>
              <Link href={`/history/${selected.deviceId}`} className="btn sm">{t("history")}</Link>
            </div>
          </section>
        )}
      </aside>
    </div>
  );
}
