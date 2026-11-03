"use client";
import { Plus } from "lucide-react";
import { useMemo, useState } from "react";
import { BillingSettingsTab } from "@/components/billing/BillingSettingsTab";
import { BudgetsTab } from "@/components/billing/BudgetsTab";
import { ContractsTab } from "@/components/billing/ContractsTab";
import { PayrollTab } from "@/components/billing/PayrollTab";
import { PlanTab } from "@/components/billing/PlanTab";
import { ProfitTab } from "@/components/billing/ProfitTab";
import { QuotesTab } from "@/components/billing/QuotesTab";
import { RateCardsTab } from "@/components/billing/RateCardsTab";
import { ErrorState, PageHead, Tabs } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";

export default function BillingPage() {
  const { t } = useI18n(); const { can, me } = useMe();
  const tabs = useMemo(() => [
    (can("billing.manage") || can("settings.manage")) && { id: "plan", label: t("bl_tab_plan") },
    can("customers.view") && { id: "quotes", label: t("bl_tab_quotes") },
    (can("reports.view") || can("customers.view")) && { id: "rates", label: t("bl_tab_rates") },
    can("reports.view") && { id: "budgets", label: t("bl_tab_budgets") },
    (can("reports.view") || can("customers.view")) && { id: "contracts", label: t("bl_tab_contracts") },
    can("reports.view") && { id: "payroll", label: t("bl_tab_payroll") },
    can("reports.view") && { id: "profit", label: t("bl_tab_profit") },
    can("settings.manage") && { id: "settings", label: t("bl_tab_settings") },
  ].filter((x): x is { id: string; label: string } => !!x), [can, t]);
  const [tab, setTab] = useState<string | null>(null);
  const [newDoc, setNewDoc] = useState(false);
  const cur = tab && tabs.some((x) => x.id === tab) ? tab : tabs[0]?.id;
  if (!cur) return <div className="content"><ErrorState forbidden /></div>;
  const currency = me?.org.settings.currency ?? "CAD";
  return (
    <div className="content">
      <PageHead title={t("navBilling")} subtitle={t("bl_sub")} actions={cur === "quotes" && can("customers.manage") ? <button type="button" className="btn" onClick={() => setNewDoc(true)}><Plus size={16} aria-hidden /> {t("bl_newDoc")}</button> : undefined} />
      <Tabs label={t("navBilling")} value={cur} onChange={setTab} tabs={tabs} />
      <div role="tabpanel" id={`panel-${cur}`} aria-labelledby={`tab-${cur}`} style={{ marginTop: "var(--s4)" }}>
        {cur === "plan" && <PlanTab />}
        {cur === "quotes" && <QuotesTab newOpen={newDoc} onClose={() => setNewDoc(false)} />}
        {cur === "rates" && <RateCardsTab />}
        {cur === "budgets" && <BudgetsTab currency={currency} />}
        {cur === "contracts" && <ContractsTab currency={currency} />}
        {cur === "payroll" && <PayrollTab />}
        {cur === "profit" && <ProfitTab />}
        {cur === "settings" && <BillingSettingsTab />}
      </div>
    </div>
  );
}
