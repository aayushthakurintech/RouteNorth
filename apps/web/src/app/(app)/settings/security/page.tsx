"use client";
import { useMemo, useState } from "react";
import { ComplianceTab } from "@/components/security/ComplianceTab";
import { DataTab } from "@/components/security/DataTab";
import { PrivacyTab } from "@/components/security/PrivacyTab";
import { SessionsTab } from "@/components/security/SessionsTab";
import { TwoFactorTab } from "@/components/security/TwoFactorTab";
import { PageHead, Tabs } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";

/** Everything about keeping accounts and data safe, in one place. Two-factor and sessions are for everyone; the rest is for managers. */
export default function SecurityPage() {
  const { t } = useI18n(); const { can, me } = useMe();
  const tabs = useMemo(() => [
    { id: "twofactor", label: t("sx_tab_2fa") },
    { id: "sessions", label: t("sx_tab_sessions") },
    can("settings.manage") && { id: "privacy", label: t("sx_tab_privacy") },
    (can("settings.manage") || can("users.manage") || me?.user.role === "owner") && { id: "data", label: t("sx_tab_data") },
    can("settings.manage") && { id: "compliance", label: t("sx_tab_compliance") },
  ].filter((x): x is { id: string; label: string } => !!x), [can, me, t]);
  const [tab, setTab] = useState("twofactor");
  const cur = tabs.some((x) => x.id === tab) ? tab : "twofactor";
  return (
    <div className="content">
      <PageHead title={t("navSecurity")} subtitle={t("sx_sub")} />
      {me?.security?.mustSetUpTwoFactor && <div role="alert" className="card" style={{ borderColor: "var(--danger)", marginBottom: "var(--s4)" }}>{t("sx_must_setup")}</div>}
      <Tabs label={t("navSecurity")} value={cur} onChange={setTab} tabs={tabs} />
      <div role="tabpanel" id={`panel-${cur}`} aria-labelledby={`tab-${cur}`} style={{ marginTop: "var(--s4)" }}>
        {cur === "twofactor" && <TwoFactorTab />}
        {cur === "sessions" && <SessionsTab />}
        {cur === "privacy" && <PrivacyTab />}
        {cur === "data" && <DataTab />}
        {cur === "compliance" && <ComplianceTab onGo={setTab} />}
      </div>
    </div>
  );
}
