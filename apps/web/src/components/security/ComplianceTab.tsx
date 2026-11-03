"use client";
import type { MessageKey } from "@routenorth/shared";
import { Check, CircleDashed, ExternalLink } from "lucide-react";
import Link from "next/link";
import { ErrorState, SkeletonList } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { useApi } from "@/lib/use-api";

interface Control { id: string; status: "ok" | "todo" | "external"; params: Record<string, string | number> }

const FIX: Record<string, string> = { twoFactorRequired: "twofactor", twoFactorAdmins: "twofactor", twoFactorCoverage: "twofactor", ipAllow: "privacy", sessionLength: "privacy", driverPrivacy: "privacy", staleKeys: "/integrations" };
const PLAN = ["now", "policies", "audit", "iso"] as const;

/** A live checklist of controls the product can show evidence for, and a plain-language path towards SOC 2 and ISO 27001. */
export function ComplianceTab({ onGo }: { onGo: (tab: string) => void }) {
  const { t } = useI18n();
  const r = useApi<{ controls: Control[] }>("/security/compliance");
  if (r.error && !r.loaded) return <ErrorState error={r.error} onRetry={r.reload} />;
  if (!r.data) return <SkeletonList rows={6} />;
  const done = r.data.controls.filter((c) => c.status === "ok").length;
  return (
    <div className="stack">
      <p>{t("sx_cmp_intro")}</p>
      <p><strong>{t("sx_cmp_score", { done, total: r.data.controls.length })}</strong></p>
      <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {r.data.controls.map((c) => {
          const fix = FIX[c.id];
          return (
            <li key={c.id} className="card row" style={{ alignItems: "flex-start", gap: 12 }}>
              <span aria-hidden style={{ color: c.status === "ok" ? "var(--ok)" : "var(--muted)" }}>{c.status === "ok" ? <Check size={18} /> : c.status === "external" ? <ExternalLink size={18} /> : <CircleDashed size={18} />}</span>
              <div style={{ flex: 1 }}>
                <strong>{t(`sx_ctl_${c.id}` as MessageKey)}</strong> <span className={`chip ${c.status === "ok" ? "ok" : ""}`}>{t(`sx_cs_${c.status}` as MessageKey)}</span>
                <p className="meta" style={{ margin: "4px 0 0" }}>{t(`sx_ctl_${c.id}_d` as MessageKey, c.params)}</p>
              </div>
              {c.status === "todo" && fix && (fix.startsWith("/") ? <Link className="btn sm alt" href={fix}>{t("sx_fix")}</Link> : <button type="button" className="btn sm alt" onClick={() => onGo(fix)}>{t("sx_fix")}</button>)}
            </li>
          );
        })}
      </ul>
      <h2>{t("sx_plan_title")}</h2>
      <p className="meta">{t("sx_plan_note")}</p>
      <ol className="stack" style={{ paddingInlineStart: 20 }}>
        {PLAN.map((p) => <li key={p}><strong>{t(`sx_plan_${p}` as MessageKey)}</strong>: {t(`sx_plan_${p}_d` as MessageKey)}</li>)}
      </ol>
    </div>
  );
}
