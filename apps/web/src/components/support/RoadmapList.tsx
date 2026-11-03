"use client";
import type { MessageKey } from "@routenorth/shared";
import { ThumbsUp } from "lucide-react";
import { useI18n } from "@/lib/i18n-context";

export interface RoadmapItem { id: string; status: "considering" | "planned" | "building" | "shipped"; titleEn: string; titleFr: string; bodyEn: string; bodyFr: string; votes: number; voted?: boolean }
const ORDER = ["building", "planned", "considering", "shipped"] as const;

/** The roadmap grouped by stage. With `onVote`, each open item has a vote button; without it the list is read-only. */
export function RoadmapList({ items, onVote }: { items: RoadmapItem[]; onVote?: (id: string) => void }) {
  const { t, locale } = useI18n();
  return (
    <div className="stack">
      {ORDER.map((st) => {
        const rows = items.filter((i) => i.status === st);
        if (!rows.length) return null;
        return (
          <section key={st} aria-labelledby={`rm-${st}`}>
            <h2 id={`rm-${st}`}>{t(`rm_s_${st}` as MessageKey)}</h2>
            <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {rows.map((i) => {
                const title = locale === "fr" ? i.titleFr : i.titleEn, body = locale === "fr" ? i.bodyFr : i.bodyEn;
                return (
                  <li key={i.id} className="card row" style={{ gap: 12, alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}><strong>{title}</strong>{body && <p className="meta" style={{ margin: "4px 0 0" }}>{body}</p>}</div>
                    {st !== "shipped" && (onVote
                      ? <button type="button" className={`btn sm ${i.voted ? "" : "alt"}`} aria-pressed={!!i.voted} onClick={() => onVote(i.id)}><ThumbsUp size={14} aria-hidden /> {i.voted ? t("rm_voted") : t("rm_vote")} · {i.votes}</button>
                      : <span className="chip"><ThumbsUp size={12} aria-hidden /> {t("rm_votes", { n: i.votes })}</span>)}
                  </li>
                );
              })}
            </ul>
          </section>
        );
      })}
    </div>
  );
}
