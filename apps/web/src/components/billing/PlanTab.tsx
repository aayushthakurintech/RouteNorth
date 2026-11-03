"use client";
import type { MessageKey } from "@routenorth/shared";
import { Chip, ErrorState, Kpi, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { barPct, money } from "@/lib/money";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Usage { metric: "vehicles" | "users" | "jobs"; used: number; limit: number | null; pct: number | null; state: "ok" | "warn" | "over" }
interface PlanDef { id: string; vehicles: number | null; users: number | null; jobsPerMonth: number | null; perVehicleCad: number; baseCad: number }
interface Plan { plan: string; trialEndsAt: string; trialDaysLeft: number | null; trialExpired: boolean; usage: Usage[]; estimate: number; currency: string; plans: PlanDef[]; canChange: boolean }

export function PlanTab() {
  const { t, locale } = useI18n(); const { toast } = useToast();
  const plan = useApi<Plan>("/billing/plan");
  if (plan.error && !plan.loaded) return <ErrorState error={plan.error} onRetry={plan.reload} />;
  if (!plan.data) return <SkeletonList rows={4} />;
  const p = plan.data;
  async function choose(id: string) {
    if (!window.confirm(t("bl_planAsk", { plan: t(`bl_plan_${id}` as MessageKey) }))) return;
    try { await apiSend("PUT", "/billing/plan", { plan: id }); toast(t("bl_planChanged")); plan.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  const lim = (v: number | null) => (v == null ? t("bl_unlimited") : v.toLocaleString(locale === "fr" ? "fr-CA" : "en-CA"));
  return (
    <div className="stack">
      {p.plan === "trial" && <div className={`banner ${p.trialExpired ? "warn" : "info"}`} role="status">{p.trialExpired ? t("bl_trialOver") : t("bl_trialLeft", { n: p.trialDaysLeft ?? 0 })}</div>}
      <div className="kpi-row">
        <div className="card"><span className="meta small">{t("bl_currentPlan")}</span><strong style={{ fontSize: 24 }}>{t(`bl_plan_${p.plan}` as MessageKey)}</strong></div>
        <Kpi label={t("bl_monthEstimate")} value={p.estimate} format={(n) => money(n, p.currency, locale)} sub={t("bl_estimateNote")} />
      </div>
      <h2>{t("bl_usage")}</h2>
      <table className="ptable"><thead><tr><th>{t("bl_metric")}</th><th>{t("bl_used")}</th><th>{t("bl_limit")}</th><th>{t("bl_share")}</th></tr></thead><tbody>
        {p.usage.map((u) => (
          <tr key={u.metric}>
            <td>{t(`bl_m_${u.metric}` as MessageKey)}</td><td>{u.used}</td><td>{lim(u.limit)}</td>
            <td>{u.pct == null ? "–" : <span className="row" style={{ gap: 8 }}><progress className={`meter ${u.state}`} max={100} value={barPct(u.pct)} aria-label={t(`bl_m_${u.metric}` as MessageKey)} /> {u.pct}% {u.state !== "ok" && <Chip tone={u.state === "over" ? "danger" : "warn"}>{t(u.state === "over" ? "bl_over" : "bl_near")}</Chip>}</span>}</td>
          </tr>
        ))}
      </tbody></table>
      <p className="meta small">{t("bl_softNote")}</p>
      <h2>{t("bl_plans")}</h2>
      <div className="grid2">
        {p.plans.filter((x) => x.id !== "trial").map((x) => (
          <section key={x.id} className="card stack" aria-label={t(`bl_plan_${x.id}` as MessageKey)}>
            <h3>{t(`bl_plan_${x.id}` as MessageKey)} {p.plan === x.id && <Chip tone="ok">{t("bl_current")}</Chip>}</h3>
            <p>{money(x.baseCad, p.currency, locale)} + {money(x.perVehicleCad, p.currency, locale)} {t("bl_perVehicle")}</p>
            <p className="meta small">{t("bl_includes", { v: lim(x.vehicles), u: lim(x.users), j: lim(x.jobsPerMonth) })}</p>
            {p.canChange && p.plan !== x.id && <button type="button" className="btn alt" onClick={() => choose(x.id)}>{t("bl_choose")}</button>}
          </section>
        ))}
      </div>
      <p className="meta small">{t("bl_paymentsNote")}</p>
    </div>
  );
}
