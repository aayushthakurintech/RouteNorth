"use client";
import { useEffect, useState } from "react";
import { ErrorState, PageHead, SkeletonList, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useTheme } from "@/lib/theme-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface OrgFull {
  id: string; name: string; locale: string; timezone: string; retentionDays: number; brandName: string | null; brandColor: string | null; logoDataUrl: string | null;
  settings: { idleThresholdMin: number; speedLimitKmh: number; trackOnlyDuringShift: boolean; sessionHours: number; ipAllowList: string[]; quietHours: { start: string; end: string } | null };
}

const TIMEZONES = ["America/St_Johns", "America/Halifax", "America/Toronto", "America/Winnipeg", "America/Regina", "America/Edmonton", "America/Vancouver"];

export default function SettingsPage() {
  const { t } = useI18n();
  const { can, reload } = useMe();
  const { setBrand } = useTheme();
  const { toast } = useToast();
  const org = useApi<OrgFull>(can("settings.manage") ? "/org" : null);
  const [tab, setTab] = useState("company");
  const [form, setForm] = useState<OrgFull | null>(null);
  const [ips, setIps] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => { if (org.data) { setForm(org.data); setIps(org.data.settings.ipAllowList.join("\n")); } }, [org.data]);
  // Leaving the page without saving drops the colour preview.
  useEffect(() => () => setBrand(org.data?.brandColor ?? null), [org.data, setBrand]);

  if (!can("settings.manage")) return <div className="content"><ErrorState forbidden /></div>;
  if (org.error && !org.loaded) return <div className="content"><ErrorState error={org.error} onRetry={org.reload} /></div>;
  if (!form) return <div className="content"><SkeletonList rows={5} h={48} /></div>;

  const set = <K extends keyof OrgFull>(k: K, v: OrgFull[K]) => setForm({ ...form, [k]: v });
  const setS = <K extends keyof OrgFull["settings"]>(k: K, v: OrgFull["settings"][K]) => setForm({ ...form, settings: { ...form.settings, [k]: v } });

  async function save() {
    if (!form) return;
    setBusy(true);
    try {
      await apiSend("PUT", "/org", {
        name: form.name, timezone: form.timezone, retentionDays: form.retentionDays, brandName: form.brandName, brandColor: form.brandColor, logoDataUrl: form.logoDataUrl,
        settings: {
          idleThresholdMin: form.settings.idleThresholdMin, speedLimitKmh: form.settings.speedLimitKmh, trackOnlyDuringShift: form.settings.trackOnlyDuringShift,
          sessionHours: form.settings.sessionHours, quietHours: form.settings.quietHours,
          ipAllowList: ips.split(/\s+/).map((x) => x.trim()).filter(Boolean),
        },
      });
      toast(t("settingsSaved"));
      reload();
      org.reload();
    } catch (e) {
      toast((e as Error).message || t("saveFailed"), { tone: "error" });
    } finally { setBusy(false); }
  }

  function onLogo(file: File | undefined) {
    if (!file) return;
    if (file.size > 300_000) { toast(t("logoHelp"), { tone: "error" }); return; }
    const r = new FileReader();
    r.onload = () => set("logoDataUrl", String(r.result));
    r.readAsDataURL(file);
  }

  return (
    <div className="content">
      <PageHead title={t("settings")} actions={<button type="button" className="btn" onClick={save} disabled={busy}>{t("saveSettings")}</button>} />
      <Tabs label={t("settings")} value={tab} onChange={setTab} tabs={[
        { id: "company", label: t("settingsCompany") }, { id: "branding", label: t("settingsBranding") },
        { id: "tracking", label: t("settingsTracking") }, { id: "security", label: t("settingsSecurity") },
      ]} />
      <section className="card" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "company" && (
          <div className="form-grid">
            <label className="field">{t("companyName")}<input value={form.name} maxLength={120} onChange={(e) => set("name", e.target.value)} /></label>
            <label className="field">{t("timezone")}
              <select value={form.timezone} onChange={(e) => set("timezone", e.target.value)}>
                {[...new Set([form.timezone, ...TIMEZONES])].map((z) => <option key={z}>{z}</option>)}
              </select>
            </label>
            <label className="field">{t("retentionDays")}<input type="number" min={30} max={3650} value={form.retentionDays} onChange={(e) => set("retentionDays", Number(e.target.value))} /></label>
          </div>
        )}
        {tab === "branding" && (
          <div className="form-grid">
            <label className="field">{t("brandName")}<input value={form.brandName ?? ""} maxLength={60} placeholder="RouteNorth" onChange={(e) => set("brandName", e.target.value || null)} /></label>
            <label className="field">{t("brandColor")}
              <span className="row">
                <input type="color" aria-label={t("brandColor")} value={form.brandColor ?? "#0f5fa8"} onChange={(e) => { set("brandColor", e.target.value); setBrand(e.target.value); }} style={{ width: 56, padding: 2 }} />
                <input value={form.brandColor ?? ""} placeholder="#0f5fa8" pattern="#[0-9a-fA-F]{6}" onChange={(e) => { const v = e.target.value; set("brandColor", v || null); if (/^#[0-9a-fA-F]{6}$/.test(v)) setBrand(v); }} />
                {form.brandColor && <button type="button" className="btn ghost sm" onClick={() => { set("brandColor", null); setBrand(null); }}>{t("reset")}</button>}
              </span>
            </label>
            <div className="field">{t("logo")}
              <div className="row">
                {form.logoDataUrl && <img src={form.logoDataUrl} alt="" width={48} height={48} style={{ objectFit: "contain", background: "#fff", borderRadius: 8, border: "1px solid var(--line)" }} />}
                <input type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" aria-label={t("uploadLogo")} onChange={(e) => onLogo(e.target.files?.[0])} />
                {form.logoDataUrl && <button type="button" className="btn ghost sm" onClick={() => set("logoDataUrl", null)}>{t("removeLogo")}</button>}
              </div>
              <span className="hint">{t("logoHelp")}</span>
            </div>
          </div>
        )}
        {tab === "tracking" && (
          <div className="form-grid">
            <label className="field">{t("idleThreshold")}<input type="number" min={1} max={120} value={form.settings.idleThresholdMin} onChange={(e) => setS("idleThresholdMin", Number(e.target.value))} /></label>
            <label className="field">{t("speedLimit")}<input type="number" min={20} max={200} value={form.settings.speedLimitKmh} onChange={(e) => setS("speedLimitKmh", Number(e.target.value))} /></label>
            <label className="check"><input type="checkbox" className="switch" checked={form.settings.trackOnlyDuringShift} onChange={(e) => setS("trackOnlyDuringShift", e.target.checked)} />{t("trackOnlyDuringShift")}</label>
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend>{t("quietHours")}</legend>
              <span className="row">
                <input type="time" aria-label={t("quietStart")} value={form.settings.quietHours?.start ?? ""} onChange={(e) => setS("quietHours", e.target.value ? { start: e.target.value, end: form.settings.quietHours?.end ?? "06:00" } : null)} />
                <input type="time" aria-label={t("quietEnd")} value={form.settings.quietHours?.end ?? ""} disabled={!form.settings.quietHours} onChange={(e) => setS("quietHours", { start: form.settings.quietHours?.start ?? "22:00", end: e.target.value })} />
              </span>
            </fieldset>
          </div>
        )}
        {tab === "security" && (
          <div className="form-grid">
            <label className="field">{t("sessionHours")}<input type="number" min={1} max={720} value={form.settings.sessionHours} onChange={(e) => setS("sessionHours", Number(e.target.value))} /></label>
            <label className="field">{t("ipAllowList")}<textarea rows={4} value={ips} onChange={(e) => setIps(e.target.value)} placeholder="203.0.113.0/24" /></label>
          </div>
        )}
      </section>
    </div>
  );
}
