"use client";
import { useEffect, useState } from "react";
import { ErrorState, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface OrgFull { retentionDays: number; settings: { trackOnlyDuringShift: boolean; sessionHours: number; ipAllowList: string[]; platform: { analyticsOptOut: boolean }; privacy: { messageRetentionDays: number } } }

/** Driver privacy, how long data is kept, who may sign in from where, and product analytics. */
export function PrivacyTab() {
  const { t } = useI18n(); const { toast } = useToast(); const { reload } = useMe();
  const org = useApi<OrgFull>("/org");
  const [f, setF] = useState<{ shift: boolean; days: string; msgDays: string; opt: boolean; hours: string; ips: string } | null>(null);
  useEffect(() => {
    const o = org.data;
    if (o) setF({ shift: o.settings.trackOnlyDuringShift, days: String(o.retentionDays), msgDays: String(o.settings.privacy.messageRetentionDays), opt: o.settings.platform.analyticsOptOut, hours: String(o.settings.sessionHours), ips: o.settings.ipAllowList.join(", ") });
  }, [org.data]);
  if (org.error && !org.loaded) return <ErrorState error={org.error} onRetry={org.reload} />;
  if (!f) return <SkeletonList rows={4} />;
  const set = (p: Partial<typeof f>) => setF({ ...f, ...p });
  async function save() {
    try {
      await apiSend("PUT", "/org", {
        retentionDays: Number(f!.days),
        settings: {
          trackOnlyDuringShift: f!.shift, sessionHours: Number(f!.hours), ipAllowList: f!.ips.split(/[,\s]+/).filter(Boolean),
          platform: { analyticsOptOut: f!.opt }, privacy: { messageRetentionDays: Number(f!.msgDays) },
        },
      });
      toast(t("settingsSaved")); org.reload(); reload();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  return (
    <form className="stack" style={{ maxWidth: 640 }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <fieldset className="stack"><legend>{t("sx_priv_drivers")}</legend>
        <label className="check"><input type="checkbox" className="switch" checked={f.shift} onChange={(e) => set({ shift: e.target.checked })} /> {t("sx_priv_shift")}</label>
        <p className="meta">{t("sx_priv_shift_note")}</p>
      </fieldset>
      <fieldset className="stack"><legend>{t("sx_priv_keep")}</legend>
        <label className="field"><span>{t("sx_priv_pos_days")}</span><input type="number" min={30} max={3650} value={f.days} onChange={(e) => set({ days: e.target.value })} /></label>
        <label className="field"><span>{t("sx_priv_msg_days")}</span><input type="number" min={0} max={3650} value={f.msgDays} onChange={(e) => set({ msgDays: e.target.value })} /></label>
        <p className="meta">{t("sx_priv_keep_note")}</p>
      </fieldset>
      <fieldset className="stack"><legend>{t("sx_priv_signin")}</legend>
        <label className="field"><span>{t("sx_priv_hours")}</span><input type="number" min={1} max={168} value={f.hours} onChange={(e) => set({ hours: e.target.value })} /></label>
        <label className="field"><span>{t("sx_priv_ips")}</span><input value={f.ips} placeholder="203.0.113.7, 10.0.0.0/8" onChange={(e) => set({ ips: e.target.value })} /></label>
        <p className="meta">{t("sx_priv_ips_note")}</p>
      </fieldset>
      <fieldset className="stack"><legend>{t("sx_priv_analytics")}</legend>
        <label className="check"><input type="checkbox" className="switch" checked={f.opt} onChange={(e) => set({ opt: e.target.checked })} /> {t("sx_priv_optout")}</label>
        <p className="meta">{t("sx_priv_analytics_note")}</p>
      </fieldset>
      <div><button type="submit" className="btn">{t("saveSettings")}</button></div>
    </form>
  );
}
