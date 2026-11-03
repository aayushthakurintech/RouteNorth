"use client";
import { useMemo, useState } from "react";
import { HealthTab } from "@/components/ops/HealthTab";
import { LabsTab } from "@/components/ops/LabsTab";
import { UsageTab } from "@/components/ops/UsageTab";
import { ErrorState, PageHead, Tabs } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";

/** For whoever runs the account: system health and errors, which features get used, and feature switches. */
export default function HealthPage() {
  const { t } = useI18n(); const { can } = useMe();
  const tabs = useMemo(() => [{ id: "health", label: t("hx_tab_health") }, { id: "usage", label: t("hx_tab_usage") }, { id: "labs", label: t("hx_tab_labs") }], [t]);
  const [tab, setTab] = useState("health");
  if (!can("settings.manage")) return <div className="content"><ErrorState forbidden /></div>;
  return (
    <div className="content">
      <PageHead title={t("navHealth")} subtitle={t("hx_sub")} />
      <Tabs label={t("navHealth")} value={tab} onChange={setTab} tabs={tabs} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} style={{ marginTop: "var(--s4)" }}>
        {tab === "health" && <HealthTab />}
        {tab === "usage" && <UsageTab />}
        {tab === "labs" && <LabsTab />}
      </div>
    </div>
  );
}
