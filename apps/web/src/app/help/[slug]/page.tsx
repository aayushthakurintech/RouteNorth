"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { PublicShell } from "@/components/public/PublicShell";
import { useI18n } from "@/lib/i18n-context";
import { publicGet } from "@/lib/public-api";

interface Faq { id: string; question: string; answer: string; lang: string | null }
interface Org { name: string; color: string | null; logo: string | null; booking: { enabled: boolean } }

/** Questions and answers a company wrote for its customers, with a search box. Shown in the customer's language. */
export default function HelpPage() {
  const { slug } = useParams<{ slug: string }>();
  const { t, locale } = useI18n();
  const [org, setOrg] = useState<Org | null>(null);
  const [items, setItems] = useState<Faq[] | null>(null);
  const [gone, setGone] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => { publicGet<Org>(`/public/org/${encodeURIComponent(slug)}`).then(setOrg).catch(() => setGone(true)); }, [slug]);
  useEffect(() => { publicGet<Faq[]>(`/public/org/${encodeURIComponent(slug)}/faq?lang=${locale}`).then(setItems).catch(() => setGone(true)); }, [slug, locale]);
  const shown = useMemo(() => {
    const n = q.trim().toLowerCase();
    return (items ?? []).filter((i) => !n || `${i.question} ${i.answer}`.toLowerCase().includes(n));
  }, [items, q]);
  if (gone) return <PublicShell org={null}><div className="pub-card" role="alert"><h1>{t("bk_gone")}</h1></div></PublicShell>;
  return (
    <PublicShell org={org}>
      <section className="pub-card pub-faq">
        <h1>{t("hp_title")}</h1>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} aria-label={t("hp_search")} placeholder={t("hp_search")} />
        {!items ? <p role="status">{t("loading")}</p> : shown.length === 0 ? <p className="meta" role="status">{items.length === 0 ? t("hp_none") : t("searchNoResults", { q })}</p> : shown.map((i) => <details key={i.id} open={shown.length === 1}><summary>{i.question}</summary><p style={{ whiteSpace: "pre-wrap" }}>{i.answer}</p></details>)}
        {org?.booking.enabled && <p><Link className="btn" href={`/book/${slug}`}>{t("hp_book")}</Link></p>}
      </section>
    </PublicShell>
  );
}
