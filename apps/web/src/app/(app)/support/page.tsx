"use client";
import { useMemo, useState } from "react";
import { ContactTab } from "@/components/support/ContactTab";
import { HelpCenter } from "@/components/support/HelpCenter";
import { RoadmapList, type RoadmapItem } from "@/components/support/RoadmapList";
import { ErrorState, PageHead, SkeletonList, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";
import { track } from "@/lib/usage";

function Ideas() {
  const { t } = useI18n(); const { toast } = useToast(); const { me } = useMe();
  const r = useApi<RoadmapItem[]>("/support/roadmap");
  if (r.error && !r.loaded) return <ErrorState error={r.error} onRetry={r.reload} />;
  if (!r.data) return <SkeletonList rows={5} />;
  const canVote = me?.flags.roadmapVotes !== false;
  const vote = async (id: string) => { try { await apiSend("POST", `/support/roadmap/${id}/vote`); track("feature", "roadmap.vote"); r.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } };
  return (
    <div className="stack" style={{ maxWidth: 800 }}>
      <p>{t("sp_roadmap_intro")}</p>
      <RoadmapList items={r.data} onVote={canVote ? vote : undefined} />
      <p className="meta"><a href="/roadmap">{t("sp_public_roadmap")}</a></p>
    </div>
  );
}

/** Help articles, a way to write to the product team, and the roadmap. Everyone can reach it. */
export default function SupportPage() {
  const { t } = useI18n();
  const tabs = useMemo(() => [{ id: "help", label: t("sp_tab_help") }, { id: "contact", label: t("sp_tab_contact") }, { id: "ideas", label: t("sp_tab_ideas") }], [t]);
  const [tab, setTab] = useState("help");
  return (
    <div className="content">
      <PageHead title={t("navSupport")} subtitle={t("sp_sub")} />
      <Tabs label={t("navSupport")} value={tab} onChange={setTab} tabs={tabs} />
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} style={{ marginTop: "var(--s4)" }}>
        {tab === "help" && <HelpCenter onContact={() => setTab("contact")} />}
        {tab === "contact" && <ContactTab />}
        {tab === "ideas" && <Ideas />}
      </div>
    </div>
  );
}
