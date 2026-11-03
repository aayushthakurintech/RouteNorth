"use client";
import type { MessageKey } from "@routenorth/shared";
import { ErrorState } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { useApi } from "@/lib/use-api";
import { FeedbackForm } from "./FeedbackForm";

interface Req { id: string; kind: string; subject: string | null; body: string; status: string; reply: string | null; repliedAt: string | null; createdAt: string; from: string }

/** Write to the product team and see what you sent before. Replies arrive by email. */
export function ContactTab() {
  const { t, locale } = useI18n();
  const list = useApi<Req[]>("/support/requests");
  const fmt = (d: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(d));
  return (
    <div className="stack" style={{ maxWidth: 720 }}>
      <p>{t("sp_contact_intro")}</p>
      <FeedbackForm initialKind="question" onSent={list.reload} />
      <h2>{t("sp_sent")}</h2>
      {list.error && !list.loaded && <ErrorState error={list.error} onRetry={list.reload} />}
      {list.data && list.data.length === 0 && <p className="meta">{t("sp_sent_none")}</p>}
      {list.data?.map((r) => (
        <article key={r.id} className="card stack" style={{ gap: 4 }}>
          <div><strong>{r.subject ?? t(`fb_k_${r.kind}` as MessageKey)}</strong> <span className="chip">{t(`fb_k_${r.kind}` as MessageKey)}</span> <span className="chip">{t(`fb_s_${r.status}` as MessageKey)}</span></div>
          <span className="meta">{r.from} · {fmt(r.createdAt)}</span>
          <p style={{ margin: 0, whiteSpace: "pre-wrap" }}>{r.body}</p>
          {r.reply && <blockquote style={{ margin: 0, paddingInlineStart: 12, borderInlineStart: "3px solid var(--accent)" }}>{r.reply}</blockquote>}
        </article>
      ))}
    </div>
  );
}
