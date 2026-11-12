"use client";
import { useState } from "react";
import { EmptyState, ErrorState, SkeletonList } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { useApi } from "@/lib/use-api";

interface Row { id: string; at: string; actor: string | null; action: string; entity: string | null; method: string; status: number }

/** A readable feed of what people did, newest first, built from the audit log. */
export function ActivityTab() {
  const { t, locale } = useI18n();
  const [who, setWho] = useState("");
  const feed = useApi<Row[]>(`/audit?limit=150${who ? `&actor=${encodeURIComponent(who)}` : ""}`);
  const people = useApi<{ id: string; email: string; displayName: string | null }[]>("/users");
  const loc = locale === "fr" ? "fr-CA" : "en-CA";
  const verb = (r: Row) => (r.action.startsWith("auth.login") ? (r.status >= 400 || r.action.endsWith("failed") || r.action.endsWith("blocked_ip") ? t("tm_act_loginFailed") : t("tm_act_login")) : r.method === "POST" ? t("tm_act_created") : r.method === "DELETE" ? t("tm_act_deleted") : t("tm_act_updated"));
  const days = new Map<string, Row[]>();
  for (const r of feed.data ?? []) { const d = new Date(r.at).toLocaleDateString(loc, { dateStyle: "full" }); days.set(d, [...(days.get(d) ?? []), r]); }
  return (
    <div className="stack">
      <p className="meta small">{t("tm_activityNote")}</p>
      <label className="field" style={{ maxWidth: 320 }}><span>{t("tm_person")}</span>
        <select value={who} onChange={(e) => setWho(e.target.value)}><option value="">{t("tm_everyone")}</option>{(people.data ?? []).map((p) => <option key={p.id} value={p.email}>{p.displayName ?? p.email}</option>)}</select></label>
      {feed.error && !feed.loaded && <ErrorState error={feed.error} onRetry={feed.reload} />}
      {!feed.loaded && !feed.error && <SkeletonList rows={6} />}
      {feed.loaded && feed.data!.length === 0 && <EmptyState title={t("tm_noActivity")} />}
      {[...days.entries()].map(([d, rows]) => (
        <section key={d} aria-label={d}>
          <h2>{d}</h2>
          <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
            {rows.map((r) => <li key={r.id} className="row" style={{ gap: 12 }}><span className="meta small" style={{ width: 52 }}>{new Date(r.at).toLocaleTimeString(loc, { timeStyle: "short" })}</span><span><strong>{r.actor ?? "–"}</strong> {verb(r)}{r.entity && !r.action.startsWith("auth.") ? ` · ${r.entity}` : ""}</span></li>)}
          </ul>
        </section>
      ))}
    </div>
  );
}
