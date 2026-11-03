"use client";
import { PROVINCES, taxFor } from "@routenorth/shared";
import { useEffect, useState } from "react";
import { ErrorState, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface OrgFull { settings: { currency: string; taxRatePct: number; billing: Record<string, string | number> } }
type Form = Record<string, string>;

const NUMS = ["paymentTermsDays", "quoteValidDays", "payPerStop", "payPerKm", "overtimeMultiplier", "budgetAlertPct"] as const;

/** Tax, payment terms, driver pay rates and exchange rates. */
export function BillingSettingsTab() {
  const { t } = useI18n(); const { toast } = useToast();
  const org = useApi<OrgFull>("/org");
  const [f, setF] = useState<Form | null>(null);
  useEffect(() => {
    const s = org.data?.settings;
    if (s) setF(Object.fromEntries([["currency", s.currency], ["taxRatePct", String(s.taxRatePct)], ...Object.entries(s.billing).map(([k, v]) => [k, String(v ?? "")])]));
  }, [org.data]);
  if (org.error && !org.loaded) return <ErrorState error={org.error} onRetry={org.reload} />;
  if (!f) return <SkeletonList rows={5} />;
  const set = (k: string, v: string) => setF({ ...f, [k]: v });
  async function save() {
    try {
      const billing: Record<string, unknown> = { province: f!.province, taxMode: f!.taxMode, companyName: f!.companyName, taxNumber: f!.taxNumber, fxRates: f!.fxRates };
      for (const k of NUMS) billing[k] = Number(f![k]);
      await apiSend("PUT", "/org", { settings: { currency: f!.currency, taxRatePct: Number(f!.taxRatePct), billing } });
      toast(t("settingsSaved"));
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  const sample = taxFor(f.province ?? "ON", 100, { mode: f.taxMode, customRatePct: Number(f.taxRatePct) });
  const num = (k: string, label: string, step = "any") => <label className="field"><span>{label}</span><input type="number" min={0} step={step} value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)} /></label>;
  return (
    <form className="stack" style={{ maxWidth: 640 }} onSubmit={(e) => { e.preventDefault(); void save(); }}>
      <fieldset className="stack"><legend>{t("bl_set_tax")}</legend>
        <label className="field"><span>{t("bl_province")}</span><select value={f.province} onChange={(e) => set("province", e.target.value)}>{PROVINCES.map((p) => <option key={p} value={p}>{p}</option>)}</select></label>
        <label className="field"><span>{t("bl_taxMode")}</span><select value={f.taxMode} onChange={(e) => set("taxMode", e.target.value)}><option value="province">{t("bl_taxByProvince")}</option><option value="custom">{t("bl_taxFlat")}</option></select></label>
        {f.taxMode === "custom" && num("taxRatePct", t("bl_flatRate"))}
        <p className="meta small" role="status">{t("bl_taxSample", { tax: sample.lines.map((l) => `${l.code} ${l.rate}%`).join(" + ") || "0%", amount: sample.total.toFixed(2) })}</p>
        <label className="field"><span>{t("bl_companyName")}</span><input maxLength={120} value={f.companyName ?? ""} onChange={(e) => set("companyName", e.target.value)} /></label>
        <label className="field"><span>{t("bl_taxNumber")}</span><input maxLength={40} value={f.taxNumber ?? ""} onChange={(e) => set("taxNumber", e.target.value)} /></label>
      </fieldset>
      <fieldset className="stack"><legend>{t("bl_set_terms")}</legend>
        <label className="field"><span>{t("bl_currency")}</span><input maxLength={3} pattern="[A-Z]{3}" value={f.currency ?? ""} onChange={(e) => set("currency", e.target.value.toUpperCase())} /></label>
        <label className="field"><span>{t("bl_fx")}</span><input placeholder="USD=1.37, EUR=1.47" maxLength={300} value={f.fxRates ?? ""} onChange={(e) => set("fxRates", e.target.value)} /></label>
        <p className="meta small">{t("bl_fxNote")}</p>
        {num("paymentTermsDays", t("bl_terms"), "1")}{num("quoteValidDays", t("bl_quoteValid"), "1")}{num("budgetAlertPct", t("bl_alertPct"), "1")}
      </fieldset>
      <fieldset className="stack"><legend>{t("bl_set_pay")}</legend>
        {num("payPerStop", t("bl_payPerStop"))}{num("payPerKm", t("bl_payPerKm"))}{num("overtimeMultiplier", t("bl_otMult"))}
        <p className="meta small">{t("bl_payRateNote")}</p>
      </fieldset>
      <div><button type="submit" className="btn">{t("saveSettings")}</button></div>
    </form>
  );
}
