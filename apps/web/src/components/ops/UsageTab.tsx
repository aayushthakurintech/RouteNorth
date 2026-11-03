"use client";
import { useState } from "react";
import { EmptyState, ErrorState, Kpi, SkeletonList } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { useApi } from "@/lib/use-api";

interface Row { name: string; n: number }
interface Usage { days: number; optedOut: boolean; pages: Row[]; features: Row[]; byRole: { role: string; n: number }[]; byDay: { day: string; n: number }[] }

/** Which pages and features people really use. Only names and counts: no people, no content. */
export function UsageTab() {
  const { t } = useI18n();
  const [days, setDays] = useState(30);
  const u = useApi<Usage>(`/ops/usage?days=${days}`);
  if (u.error && !u.loaded) return <ErrorState error={u.error} onRetry={u.reload} />;
  if (!u.data) return <SkeletonList rows={5} />;
  const d = u.data;
  const total = d.byDay.reduce((s, x) => s + x.n, 0);
  const max = Math.max(1, ...d.byDay.map((x) => x.n));
  const list = (title: string, rows: Row[]) => (
    <section aria-label={title}>
      <h2>{title}</h2>
      <table className="ptable"><caption className="sr-only">{title}</caption>
        <thead><tr><th scope="col">{t("ux_name")}</th><th scope="col" style={{ textAlign: "end" }}>{t("ux_count")}</th></tr></thead>
        <tbody>{rows.map((r) => <tr key={r.name}><td className="mono">{r.name}</td><td style={{ textAlign: "end" }}>{r.n}</td></tr>)}</tbody>
      </table>
    </section>
  );
  return (
    <div className="stack">
      <p>{t("ux_intro")}</p>
      {d.optedOut && <p role="status" className="card">{t("ux_optout")}</p>}
      <div className="seg" role="group" aria-label={t("ux_range")}>
        {[7, 30, 90].map((n) => <button key={n} type="button" aria-pressed={days === n} className={days === n ? "on" : ""} onClick={() => setDays(n)}>{t("ux_days", { n })}</button>)}
      </div>
      {total === 0 ? <EmptyState title={t("ux_none")} body={t("ux_none_body")} /> : (
        <>
          <div className="kpi-row"><Kpi label={t("ux_views")} value={total} /><Kpi label={t("ux_pages")} value={d.pages.length} /><Kpi label={t("ux_features")} value={d.features.length} /></div>
          <figure style={{ margin: 0 }}>
            <figcaption className="meta">{t("ux_by_day")}</figcaption>
            <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 80 }} role="img" aria-label={t("ux_by_day")}>
              {d.byDay.map((x) => <div key={x.day} title={`${x.day}: ${x.n}`} style={{ flex: 1, minWidth: 2, height: `${Math.max(4, (x.n / max) * 100)}%`, background: "var(--accent)", borderRadius: "3px 3px 0 0" }} />)}
            </div>
          </figure>
          <div className="grid2">{list(t("ux_top_pages"), d.pages)}{d.features.length > 0 ? list(t("ux_top_features"), d.features) : <section><h2>{t("ux_by_role")}</h2><table className="ptable"><tbody>{d.byRole.map((r) => <tr key={r.role}><td>{r.role}</td><td style={{ textAlign: "end" }}>{r.n}</td></tr>)}</tbody></table></section>}</div>
          {d.features.length > 0 && <section><h2>{t("ux_by_role")}</h2><table className="ptable"><tbody>{d.byRole.map((r) => <tr key={r.role}><td>{r.role}</td><td style={{ textAlign: "end" }}>{r.n}</td></tr>)}</tbody></table></section>}
        </>
      )}
    </div>
  );
}
