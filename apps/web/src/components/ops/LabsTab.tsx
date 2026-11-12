"use client";
import type { MessageKey } from "@routenorth/shared";
import { ErrorState, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Flag { key: string; enabled: boolean; overridden: boolean; default: boolean; rolloutPct: number }

/** Switch new or optional features on or off for this organization. "Default" follows what the product team has decided. */
export function LabsTab() {
  const { t } = useI18n(); const { toast } = useToast(); const { reload } = useMe();
  const flags = useApi<Flag[]>("/ops/flags");
  if (flags.error && !flags.loaded) return <ErrorState error={flags.error} onRetry={flags.reload} />;
  if (!flags.data) return <SkeletonList rows={4} />;
  const set = async (key: string, enabled: boolean | null) => {
    try { await apiSend("PUT", `/ops/flags/${key}`, { enabled }); flags.reload(); reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); }
  };
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <p>{t("lb_intro")}</p>
      <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {flags.data.map((f) => (
          <li key={f.key} className="card row" style={{ gap: 12, alignItems: "flex-start" }}>
            <div style={{ flex: 1 }}>
              <strong>{t(`lb_f_${f.key}` as MessageKey)}</strong> {f.overridden ? <span className="chip">{t("lb_yours")}</span> : <span className="chip">{t("lb_default")}</span>}
              <p className="meta" style={{ margin: "4px 0 0" }}>{t(`lb_f_${f.key}_d` as MessageKey)}</p>
            </div>
            <label className="check"><input type="checkbox" className="switch" checked={f.enabled} aria-label={t(`lb_f_${f.key}` as MessageKey)} onChange={(e) => void set(f.key, e.target.checked)} /></label>
            {f.overridden && <button type="button" className="btn sm alt" onClick={() => void set(f.key, null)}>{t("lb_reset")}</button>}
          </li>
        ))}
      </ul>
    </div>
  );
}
