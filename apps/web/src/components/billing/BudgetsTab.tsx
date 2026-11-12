"use client";
import type { MessageKey } from "@routenorth/shared";
import ResourcePage from "@/components/ResourcePage";
import { Chip, ErrorState, SkeletonList } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { barPct, money } from "@/lib/money";
import { useApi } from "@/lib/use-api";

interface Row { id: string; name: string; category: string; period: string; amount: number; spent: number; pct: number; projected: number; state: "ok" | "warn" | "over"; vehicleName: string | null; from: string; to: string }

export function BudgetsTab({ currency }: { currency: string }) {
  const { t, locale } = useI18n();
  const b = useApi<{ alertPct: number; items: Row[] }>("/billing/budgets");
  return (
    <div className="stack">
      <p className="meta small">{b.data ? t("bl_budgetNote", { pct: b.data.alertPct }) : t("bl_budgetNote", { pct: 90 })}</p>
      {b.error && !b.loaded && <ErrorState error={b.error} onRetry={b.reload} />}
      {!b.loaded && !b.error && <SkeletonList rows={3} />}
      {b.data && b.data.items.length > 0 && (
        <table className="ptable"><thead><tr><th>{t("f_name")}</th><th>{t("f_category")}</th><th>{t("bl_spent")}</th><th>{t("f_amount")}</th><th>{t("bl_share")}</th><th>{t("bl_projected")}</th></tr></thead><tbody>
          {b.data.items.map((r) => (
            <tr key={r.id}>
              <td>{r.name}{r.vehicleName ? ` · ${r.vehicleName}` : ""}</td><td>{t(`v_${r.category}` as MessageKey)} / {t(`v_${r.period}` as MessageKey)}</td>
              <td>{money(r.spent, currency, locale)}</td><td>{money(r.amount, currency, locale)}</td>
              <td><span className="row" style={{ gap: 8 }}><progress className={`meter ${r.state}`} max={100} value={barPct(r.pct)} aria-label={r.name} /> {r.pct}% <Chip tone={r.state === "over" ? "danger" : r.state === "warn" ? "warn" : "ok"}>{t(`bl_bs_${r.state}` as MessageKey)}</Chip></span></td>
              <td>{money(r.projected, currency, locale)}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      <h2>{t("bl_manage")}</h2>
      <ResourcePage name="budgets" embedded />
    </div>
  );
}
