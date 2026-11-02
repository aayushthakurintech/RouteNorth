"use client";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { LanguageToggle } from "@/components/LanguageToggle";
import { filterFleet, STATUS_COLORS } from "@/lib/fleet";
import { useI18n } from "@/lib/i18n-context";
import { loadSession, saveSession } from "@/lib/session";
import { useFleet } from "@/lib/use-fleet";
import type { MessageKey } from "@routenorth/shared";

// MapLibre needs the browser (WebGL), so it is never rendered on the server.
const FleetMap = dynamic(() => import("@/components/FleetMap").then((m) => m.FleetMap), { ssr: false });

export default function LivePage() {
  const { t, locale } = useI18n();
  const router = useRouter();
  const [token, setToken] = useState<string | null>(null);
  const [checked, setChecked] = useState(false);
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [follow, setFollow] = useState(false);

  useEffect(() => {
    const s = loadSession();
    if (!s) router.replace("/login");
    else setToken(s.token);
    setChecked(true);
  }, [router]);

  const { fleet, connected, unauthorized } = useFleet(token);

  useEffect(() => {
    if (unauthorized) { saveSession(null); router.replace("/login"); }
  }, [unauthorized, router]);

  const list = useMemo(() => filterFleet(fleet, query), [fleet, query]);
  const selected = selectedId ? fleet[selectedId] : undefined;
  const time = (iso: string) => new Date(iso).toLocaleTimeString(locale === "fr" ? "fr-CA" : "en-CA");

  if (!checked || !token) return null;

  return (
    <div className="shell">
      <aside className="panel">
        <header>
          <strong>{t("appName")}</strong>
          <span className={connected ? "pill ok" : "pill warn"}>{connected ? t("connected") : t("reconnecting")}</span>
          <LanguageToggle />
          <Link href="/reports" className="link">{t("reports")}</Link>
          <button type="button" className="link" onClick={() => { saveSession(null); router.replace("/login"); }}>
            {t("signOut")}
          </button>
        </header>
        <input
          type="search" placeholder={t("searchVehicles")} aria-label={t("searchVehicles")}
          value={query} onChange={(e) => setQuery(e.target.value)}
        />
        {list.length === 0 ? (
          <p className="empty">{t("noVehicles")}</p>
        ) : (
          <ul className="vehicles" aria-label={t("vehicles")}>
            {list.map((v) => (
              <li key={v.deviceId}>
                <button
                  type="button" aria-pressed={v.deviceId === selectedId}
                  onClick={() => { setSelectedId(v.deviceId); setFollow(false); }}
                >
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
            <p>{t(`kind_${selected.kind}` as MessageKey)} · {t(`status_${selected.status}` as MessageKey)}</p>
            <dl>
              <dt>{t("speed")}</dt><dd>{Math.round(selected.speed)} km/h</dd>
              <dt>{t("heading")}</dt><dd>{Math.round(selected.heading)}°</dd>
              <dt>{t("lastUpdate")}</dt><dd>{time(selected.time)}</dd>
            </dl>
            <div className="row">
              <button type="button" onClick={() => setFollow((f) => !f)}>
                {follow ? t("stopFollowing") : t("follow")}
              </button>
              <Link href={`/history/${selected.deviceId}`} className="btn">{t("history")}</Link>
            </div>
          </section>
        )}
      </aside>
      <FleetMap fleet={fleet} selectedId={selectedId} follow={follow} onSelect={(id) => { setSelectedId(id); setFollow(false); }} />
    </div>
  );
}
