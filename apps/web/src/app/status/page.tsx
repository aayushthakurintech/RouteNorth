"use client";
import type { MessageKey } from "@routenorth/shared";
import { useEffect, useState } from "react";
import { PublicShell } from "@/components/public/PublicShell";
import { useI18n } from "@/lib/i18n-context";
import { publicGet } from "@/lib/public-api";

interface Incident { id: string; title: string; body: string | null; level: "info" | "minor" | "major"; status: "investigating" | "monitoring" | "resolved"; startedAt: string; resolvedAt: string | null }
interface Sys { level: "operational" | "degraded" | "major"; checkedAt: string; components: { id: string; ok: boolean; ms?: number }[]; incidents: Incident[] }

/** Is RouteNorth itself up? Live checks of the service and the last 90 days of incidents. */
export default function SystemStatus() {
  const { t, locale } = useI18n();
  const [s, setS] = useState<Sys | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => {
    const load = () => publicGet<Sys>("/public/system-status").then((x) => { setS(x); setFailed(false); }).catch(() => setFailed(true));
    void load();
    const id = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => clearInterval(id);
  }, []);
  const dt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  const tone = (l: string) => (l === "operational" ? "ok" : l === "degraded" ? "warn" : "bad");
  return (
    <PublicShell org={null} wide>
      <section className="pub-card" aria-live="polite">
        <h1>{t("pb_sys_title")}</h1>
        {failed && !s ? <p role="alert"><span className="pub-pill bad">{t("st_level_major")}</span> {t("pb_sys_unreachable")}</p> : !s ? <p role="status">{t("loading")}</p> : (
          <>
            <p><span className={`pub-pill ${tone(s.level)}`}>{t(`st_level_${s.level}` as MessageKey)}</span> <span className="meta">{t("hx_checked", { time: dt(s.checkedAt) })}</span></p>
            <ul style={{ listStyle: "none", padding: 0 }}>{s.components.map((c) => <li key={c.id}><span className={`pub-pill ${c.ok ? "ok" : "bad"}`}>{c.ok ? t("hx_s_ok") : t("hx_s_fail")}</span> {t(`pb_sys_c_${c.id}` as MessageKey)}</li>)}</ul>
          </>
        )}
      </section>
      {s && (
        <section className="pub-card" aria-label={t("pb_sys_history")}>
          <h2>{t("pb_sys_history")}</h2>
          {s.incidents.length === 0 ? <p className="meta">{t("pb_sys_none")}</p> : s.incidents.map((i) => (
            <article key={i.id}>
              <strong>{i.title}</strong> <span className={`pub-pill ${i.status === "resolved" ? "ok" : i.level === "major" ? "bad" : "warn"}`}>{t(`pb_sys_s_${i.status}` as MessageKey)}</span>
              <div className="meta small">{dt(i.startedAt)}{i.resolvedAt ? ` → ${dt(i.resolvedAt)}` : ""}</div>
              {i.body && <p>{i.body}</p>}
            </article>
          ))}
        </section>
      )}
    </PublicShell>
  );
}
