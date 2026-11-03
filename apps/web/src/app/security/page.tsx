"use client";
import type { MessageKey } from "@routenorth/shared";
import { PublicShell } from "@/components/public/PublicShell";
import { useI18n } from "@/lib/i18n-context";

const SECTIONS = { tenant: 3, signin: 4, data: 4, privacy: 3, ops: 3, canada: 2, gaps: 4 } as const;

/** A plain list of how accounts and data are protected, and what is not finished. Written to match what the product really does. */
export default function PublicSecurity() {
  const { t } = useI18n();
  return (
    <PublicShell org={null} wide>
      <section className="pub-card">
        <h1>{t("pb_sec_title")}</h1>
        <p>{t("pb_sec_intro")}</p>
        {(Object.keys(SECTIONS) as (keyof typeof SECTIONS)[]).map((s) => (
          <article key={s} aria-labelledby={`sec-${s}`}>
            <h2 id={`sec-${s}`}>{t(`pb_sec_${s}` as MessageKey)}</h2>
            <ul>{Array.from({ length: SECTIONS[s] }, (_, i) => i + 1).map((n) => <li key={n}>{t(`pb_sec_${s}_${n}` as MessageKey)}</li>)}</ul>
          </article>
        ))}
        <p className="meta">{t("pb_sec_contact")}</p>
      </section>
    </PublicShell>
  );
}
