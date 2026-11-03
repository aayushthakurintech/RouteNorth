"use client";
import type { MessageKey } from "@routenorth/shared";
import ResourcePage from "@/components/ResourcePage";
import { Chip, ErrorState, SkeletonList } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { money } from "@/lib/money";
import { useApi } from "@/lib/use-api";

interface Row { id: string; customerName: string; title: string; startsOn: string; endsOn: string | null; value: number | null; target: number; status: string; done: number; failed: number; onTimePct: number | null; sla: string; daysLeft: number | null; expiringSoon: boolean; ended: boolean; autoRenew: boolean }
const TONE: Record<string, "ok" | "warn" | "danger" | undefined> = { ok: "ok", at_risk: "warn", breached: "danger" };

export function ContractsTab({ currency }: { currency: string }) {
  const { t, locale } = useI18n();
  const c = useApi<{ items: Row[] }>("/billing/contracts");
  return (
    <div className="stack">
      <p className="meta small">{t("bl_contractNote")}</p>
      {c.error && !c.loaded && <ErrorState error={c.error} onRetry={c.reload} />}
      {!c.loaded && !c.error && <SkeletonList rows={3} />}
      {c.data && c.data.items.length > 0 && (
        <table className="ptable"><thead><tr><th>{t("bl_customer")}</th><th>{t("f_title")}</th><th>{t("bl_term")}</th><th>{t("f_value")}</th><th>{t("bl_onTime")}</th><th>{t("bl_target")}</th><th>{t("status")}</th></tr></thead><tbody>
          {c.data.items.map((r) => (
            <tr key={r.id}>
              <td>{r.customerName}</td><td>{r.title}</td>
              <td>{r.startsOn} → {r.endsOn ?? "∞"} {r.expiringSoon && <Chip tone="warn">{t("bl_daysLeft", { n: r.daysLeft ?? 0 })}</Chip>} {r.ended && <Chip tone="danger">{t("bl_ended")}</Chip>} {r.autoRenew && <Chip>{t("bl_renews")}</Chip>}</td>
              <td>{money(r.value, currency, locale)}</td>
              <td>{r.onTimePct == null ? "–" : `${r.onTimePct}%`} <span className="meta small">({r.done})</span></td><td>{r.target}%</td>
              <td>{r.status === "active" ? <Chip tone={TONE[r.sla]}>{t(`bl_sla_${r.sla}` as MessageKey)}</Chip> : <Chip>{t(`v_${r.status}` as MessageKey)}</Chip>}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      <h2>{t("bl_manage")}</h2>
      <ResourcePage name="contracts" embedded />
    </div>
  );
}
