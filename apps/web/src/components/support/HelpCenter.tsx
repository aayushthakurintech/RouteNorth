"use client";
import { HELP_ARTICLES, HELP_TOPICS, scoreArticle, type MessageKey } from "@routenorth/shared";
import Link from "next/link";
import { useMemo, useState } from "react";
import { EmptyState } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { track } from "@/lib/usage";

/** Short how-to articles with search. Each one links to the screen it is about. */
export function HelpCenter({ onContact }: { onContact: () => void }) {
  const { t } = useI18n(); const { me } = useMe();
  const [q, setQ] = useState(""); const [topic, setTopic] = useState<string>("all");
  const rows = useMemo(() => HELP_ARTICLES
    .map((a) => ({ a, title: t(`hlp_${a.id}_t` as MessageKey), body: t(`hlp_${a.id}_b` as MessageKey) }))
    .map((r) => ({ ...r, score: scoreArticle(r, q) }))
    .filter((r) => r.score > 0 && (topic === "all" || r.a.topic === topic))
    .sort((x, y) => (q.trim() ? y.score - x.score : 0)), [q, topic, t]);
  return (
    <div className="stack" style={{ maxWidth: 800 }}>
      <label className="field"><span>{t("sp_search")}</span><input type="search" value={q} placeholder={t("sp_search_ph")} onChange={(e) => { setQ(e.target.value); if (e.target.value.length === 3) track("feature", "help.search"); }} /></label>
      <div className="seg" role="group" aria-label={t("sp_topics")}>
        {["all", ...HELP_TOPICS].map((x) => <button key={x} type="button" aria-pressed={topic === x} className={topic === x ? "on" : ""} onClick={() => setTopic(x)}>{t(`hlp_topic_${x}` as MessageKey)}</button>)}
      </div>
      <p className="meta" role="status">{t("sp_results", { n: rows.length })}</p>
      {rows.length === 0 ? (
        <EmptyState title={t("sp_none")} body={t("sp_none_body")} action={<button type="button" className="btn" onClick={onContact}>{t("sp_ask")}</button>} />
      ) : (
        <div className="stack">
          {rows.map(({ a, title, body }) => (
            <details key={a.id} className="card" onToggle={(e) => { if ((e.target as HTMLDetailsElement).open) track("feature", `help.${a.id}`); }}>
              <summary style={{ cursor: "pointer", fontWeight: 600 }}>{title}</summary>
              <p>{body}</p>
              {(me?.perms.length ?? 0) > 0 && a.href !== "/live" && <Link className="btn sm alt" href={a.href}>{t("sp_open")}</Link>}
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
