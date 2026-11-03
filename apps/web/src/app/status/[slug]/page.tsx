"use client";
import type { MessageKey } from "@routenorth/shared";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";
import { PublicShell, type PublicOrg } from "@/components/public/PublicShell";
import { useI18n } from "@/lib/i18n-context";
import { publicGet } from "@/lib/public-api";

interface Status {
  org: PublicOrg; level: "operational" | "degraded" | "major";
  today: { total: number; done: number; failed: number; cancelled: number; late: number; vehiclesReporting: number };
  days: { day: string; total: number; onTimePct: number }[];
  notices: { id: string; level: string; title: string; body: string | null; startsAt: string; endsAt: string | null }[];
}

/** A company's public service status: is everything running, today's numbers, the last 30 days and any notices. */
export default function StatusPage() {
  const { slug } = useParams<{ slug: string }>();
  const { t, locale } = useI18n();
  const [s, setS] = useState<Status | null>(null);
  const [gone, setGone] = useState(false);
  useEffect(() => {
    const load = () => publicGet<Status>(`/public/org/${encodeURIComponent(slug)}/status`).then(setS).catch(() => setGone(true));
    void load();
    const id = setInterval(() => { if (!document.hidden) void load(); }, 60_000);
    return () => clearInterval(id);
  }, [slug]);
  if (gone) return <PublicShell org={null}><div className="pub-card" role="alert"><h1>{t("st_gone")}</h1></div></PublicShell>;
  if (!s) return <PublicShell org={null}><p role="status">{t("loading")}</p></PublicShell>;
  const tone = s.level === "operational" ? "ok" : s.level === "degraded" ? "warn" : "bad";
  const dt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));
  return (
    <PublicShell org={s.org}>
      <section className="pub-card" aria-live="polite">
        <h1>{t("st_title", { name: s.org.name })}</h1>
        <p><span className={`pub-pill ${tone}`}>{t(`st_level_${s.level}` as MessageKey)}</span></p>
        <div className="kpi-row">
          <div className="kpi"><span className="kpi-label">{t("st_today")}</span><span className="kpi-value">{s.today.total}</span></div>
          <div className="kpi"><span className="kpi-label">{t("st_delivered")}</span><span className="kpi-value">{s.today.done}</span></div>
          <div className="kpi"><span className="kpi-label">{t("st_late")}</span><span className="kpi-value">{s.today.late}</span></div>
          <div className="kpi"><span className="kpi-label">{t("st_vehicles")}</span><span className="kpi-value">{s.today.vehiclesReporting}</span></div>
        </div>
      </section>
      {s.days.length > 0 && (
        <section className="pub-card" aria-label={t("st_history")}>
          <h2>{t("st_history")}</h2>
          <div className="pub-bars" role="img" aria-label={t("st_historyAlt", { pct: Math.round(s.days.reduce((a, d) => a + d.onTimePct, 0) / s.days.length) })}>
            {s.days.map((d) => <span key={d.day} className={d.onTimePct < 70 ? "bad" : d.onTimePct < 90 ? "low" : ""} style={{ height: `${Math.max(6, d.onTimePct)}%` }} title={`${d.day}: ${d.onTimePct}%`} />)}
          </div>
          <p className="meta small">{t("st_historyNote")}</p>
          <table className="ptable"><caption className="sr-only">{t("st_history")}</caption><thead><tr><th scope="col">{t("date")}</th><th scope="col" className="tnum">{t("st_stops")}</th><th scope="col" className="tnum">{t("st_onTime")}</th></tr></thead>
            <tbody>{[...s.days].reverse().slice(0, 7).map((d) => <tr key={d.day}><th scope="row">{d.day}</th><td className="tnum">{d.total}</td><td className="tnum">{d.onTimePct}%</td></tr>)}</tbody></table>
        </section>
      )}
      <section className="pub-card" aria-label={t("st_notices")}>
        <h2>{t("st_notices")}</h2>
        {s.notices.length === 0 ? <p className="meta">{t("st_noNotices")}</p> : s.notices.map((n) => (
          <article key={n.id}><strong>{n.title}</strong> <span className={`pub-pill ${n.level === "major" ? "bad" : n.level === "minor" ? "warn" : n.level === "resolved" ? "ok" : ""}`}>{t(`st_n_${n.level}` as MessageKey)}</span><div className="meta small">{dt(n.startsAt)}</div>{n.body && <p>{n.body}</p>}</article>
        ))}
      </section>
    </PublicShell>
  );
}
