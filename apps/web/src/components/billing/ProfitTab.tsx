"use client";
import type { MessageKey } from "@routenorth/shared";
import { useState } from "react";
import { EmptyState, ErrorState, Kpi, SkeletonList } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { addDays, isoDay, money } from "@/lib/money";
import { useApi } from "@/lib/use-api";

interface Row { key: string; name: string; revenue: number; cost: number; profit: number; marginPct: number | null; stops: number }
interface Profit { currency: string; rows: Row[]; totals: { revenue: number; cost: number; profit: number; marginPct: number | null }; missingFx: number }

export function ProfitTab() {
  const { t, locale } = useI18n();
  const today = isoDay(new Date());
  const [range, setRange] = useState({ from: addDays(today, -6), to: today });
  const [by, setBy] = useState("customer");
  const p = useApi<Profit>(`/billing/profit?from=${range.from}&to=${range.to}&by=${by}`);
  const cur = p.data?.currency ?? "CAD";
  return (
    <div className="stack">
      <p className="meta small">{t("bl_profitNote")}</p>
      <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label className="field"><span>{t("from")}</span><input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label className="field"><span>{t("to")}</span><input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        <div className="seg" role="group" aria-label={t("bl_by")}>
          {["customer", "job", "route"].map((k) => <button key={k} type="button" aria-pressed={by === k} onClick={() => setBy(k)}>{t(`bl_by_${k}` as MessageKey)}</button>)}
        </div>
      </div>
      {p.error && <ErrorState error={p.error} onRetry={p.reload} />}
      {!p.loaded && !p.error && <SkeletonList rows={4} />}
      {p.data && <div className="kpi-row">
        <Kpi label={t("bl_revenue")} value={p.data.totals.revenue} format={(n) => money(n, cur, locale)} />
        <Kpi label={t("bl_cost")} value={p.data.totals.cost} format={(n) => money(n, cur, locale)} sub={t("bl_estimated")} />
        <Kpi label={t("bl_profit")} value={p.data.totals.profit} format={(n) => money(n, cur, locale)} sub={p.data.totals.marginPct == null ? undefined : `${p.data.totals.marginPct}%`} />
      </div>}
      {p.data && p.data.missingFx > 0 && <div className="banner warn" role="status">{t("bl_missingFx", { n: p.data.missingFx })}</div>}
      {p.data && p.data.rows.length === 0 && <EmptyState title={t("bl_noProfit")} body={t("bl_noProfitBody")} />}
      {p.data && p.data.rows.length > 0 && (
        <table className="ptable"><thead><tr><th>{t(`bl_by_${by}` as MessageKey)}</th><th className="tnum">{t("bl_stops")}</th><th className="tnum">{t("bl_revenue")}</th><th className="tnum">{t("bl_cost")}</th><th className="tnum">{t("bl_profit")}</th><th className="tnum">{t("bl_margin")}</th></tr></thead><tbody>
          {p.data.rows.map((r) => (
            <tr key={r.key}><td>{r.name}</td><td className="tnum">{r.stops}</td><td className="tnum">{money(r.revenue, cur, locale)}</td><td className="tnum">{money(r.cost, cur, locale)}</td>
              <td className="tnum"><strong style={{ color: r.profit < 0 ? "var(--danger)" : undefined }}>{money(r.profit, cur, locale)}</strong></td><td className="tnum">{r.marginPct == null ? "–" : `${r.marginPct}%`}</td></tr>
          ))}
        </tbody></table>
      )}
    </div>
  );
}
