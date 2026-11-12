"use client";
import { useEffect, useState } from "react";
import { PublicShell } from "@/components/public/PublicShell";
import { RoadmapList, type RoadmapItem } from "@/components/support/RoadmapList";
import { useI18n } from "@/lib/i18n-context";
import { publicGet } from "@/lib/public-api";

/** What is built, being built and under consideration. Anyone can read it; signed-in people can vote inside the app. */
export default function PublicRoadmap() {
  const { t } = useI18n();
  const [items, setItems] = useState<RoadmapItem[] | null>(null); const [failed, setFailed] = useState(false);
  useEffect(() => { publicGet<RoadmapItem[]>("/public/roadmap").then(setItems).catch(() => setFailed(true)); }, []);
  return (
    <PublicShell org={null} wide>
      <section className="pub-card">
        <h1>{t("pb_roadmap_title")}</h1>
        <p>{t("pb_roadmap_intro")}</p>
        {failed ? <p role="alert">{t("pb_failed")}</p> : !items ? <p role="status">{t("loading")}</p> : <RoadmapList items={items} />}
      </section>
    </PublicShell>
  );
}
