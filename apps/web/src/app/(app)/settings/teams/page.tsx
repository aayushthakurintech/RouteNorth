"use client";
import { useMemo, useState } from "react";
import { ActivityTab } from "@/components/teams/ActivityTab";
import { InvitesTab } from "@/components/teams/InvitesTab";
import { TeamsTab } from "@/components/teams/TeamsTab";
import { ErrorState, PageHead, Tabs } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";

export default function TeamsPage() {
  const { t } = useI18n(); const { can } = useMe();
  const tabs = useMemo(() => [
    { id: "teams", label: t("tm_tab_teams") },
    can("users.manage") && { id: "invites", label: t("tm_tab_invites") },
    can("audit.view") && { id: "activity", label: t("tm_tab_activity") },
  ].filter((x): x is { id: string; label: string } => !!x), [can, t]);
  const [tab, setTab] = useState("teams");
  if (!can("users.view") && !can("fleet.view") && !can("routes.view")) return <div className="content"><ErrorState forbidden /></div>;
  const cur = tabs.some((x) => x.id === tab) ? tab : "teams";
  return (
    <div className="content">
      <PageHead title={t("navTeams")} subtitle={t("tm_sub")} />
      <Tabs label={t("navTeams")} value={cur} onChange={setTab} tabs={tabs} />
      <div role="tabpanel" id={`panel-${cur}`} aria-labelledby={`tab-${cur}`} style={{ marginTop: "var(--s4)" }}>
        {cur === "teams" && <TeamsTab />}
        {cur === "invites" && <InvitesTab />}
        {cur === "activity" && <ActivityTab />}
      </div>
    </div>
  );
}
