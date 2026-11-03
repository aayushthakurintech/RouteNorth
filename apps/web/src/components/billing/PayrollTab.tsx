"use client";
import { Download } from "lucide-react";
import { useState } from "react";
import { EmptyState, ErrorState, Kpi, SkeletonList } from "@/components/ui/primitives";
import { apiDownload } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { addDays, isoDay, money } from "@/lib/money";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Row { driverId: string; name: string; hourlyRate: number | null; workedH: number; regularH: number; overtimeH: number; pendingOvertimeH: number; stops: number; km: number; regular: number; overtime: number; perStop: number; perKm: number; gross: number; reimbursable: number; total: number; missingRate: boolean }
interface Pay { from: string; to: string; currency: string; rows: Row[]; totals: { gross: number; reimbursable: number; total: number } }

export function PayrollTab() {
  const { t, locale } = useI18n(); const { toast } = useToast(); const { can } = useMe();
  const today = isoDay(new Date());
  const [range, setRange] = useState({ from: addDays(today, -13), to: today });
  const pay = useApi<Pay>(`/billing/payroll?from=${range.from}&to=${range.to}`);
  const cur = pay.data?.currency ?? "CAD";
  return (
    <div className="stack">
      <p className="meta small">{t("bl_payNote")}</p>
      <div className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }}>
        <label className="field"><span>{t("from")}</span><input type="date" value={range.from} max={range.to} onChange={(e) => setRange({ ...range, from: e.target.value })} /></label>
        <label className="field"><span>{t("to")}</span><input type="date" value={range.to} min={range.from} onChange={(e) => setRange({ ...range, to: e.target.value })} /></label>
        {can("reports.export") && <button type="button" className="btn alt" onClick={() => apiDownload(`/billing/payroll.csv?from=${range.from}&to=${range.to}`, `payroll-${range.from}-${range.to}.csv`).catch((e) => toast((e as Error).message, { tone: "error" }))}><Download size={16} aria-hidden /> {t("rExport")}</button>}
      </div>
      {pay.error && <ErrorState error={pay.error} onRetry={pay.reload} />}
      {!pay.loaded && !pay.error && <SkeletonList rows={4} />}
      {pay.data && <div className="kpi-row"><Kpi label={t("bl_gross")} value={pay.data.totals.gross} format={(n) => money(n, cur, locale)} /><Kpi label={t("bl_reimburse")} value={pay.data.totals.reimbursable} format={(n) => money(n, cur, locale)} /><Kpi label={t("bl_total")} value={pay.data.totals.total} format={(n) => money(n, cur, locale)} /></div>}
      {pay.data && pay.data.rows.length === 0 && <EmptyState title={t("bl_noPay")} />}
      {pay.data && pay.data.rows.length > 0 && (
        <div style={{ overflowX: "auto" }}><table className="ptable"><thead><tr>
          <th>{t("bl_driver")}</th><th className="tnum">{t("bl_hours")}</th><th className="tnum">{t("bl_overtimeH")}</th><th className="tnum">{t("bl_stops")}</th><th className="tnum">{t("bl_kmShort")}</th>
          <th className="tnum">{t("bl_hourPay")}</th><th className="tnum">{t("bl_otPay")}</th><th className="tnum">{t("bl_stopKmPay")}</th><th className="tnum">{t("bl_gross")}</th><th className="tnum">{t("bl_reimburse")}</th><th className="tnum">{t("bl_total")}</th></tr></thead><tbody>
          {pay.data.rows.map((r) => (
            <tr key={r.driverId}>
              <td>{r.name}{r.missingRate && <span className="meta small"> · {t("bl_noRate")}</span>}</td><td className="tnum">{r.workedH}</td>
              <td className="tnum">{r.overtimeH}{r.pendingOvertimeH > 0 && <span className="meta small"> (+{r.pendingOvertimeH} {t("bl_pending")})</span>}</td><td className="tnum">{r.stops}</td><td className="tnum">{r.km}</td>
              <td className="tnum">{money(r.regular, cur, locale)}</td><td className="tnum">{money(r.overtime, cur, locale)}</td><td className="tnum">{money(r.perStop + r.perKm, cur, locale)}</td>
              <td className="tnum">{money(r.gross, cur, locale)}</td><td className="tnum">{money(r.reimbursable, cur, locale)}</td><td className="tnum"><strong>{money(r.total, cur, locale)}</strong></td>
            </tr>
          ))}
        </tbody></table></div>
      )}
    </div>
  );
}
