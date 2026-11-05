"use client";
import Link from "next/link";
import { Logo } from "@/components/Logo";
import { LanguageToggle } from "@/components/LanguageToggle";
import { useI18n } from "@/lib/i18n-context";
import { DOCS, TERMS_VERSION, UI, UPDATED, type DocKey } from "./content";

const slug = (s: string) => s.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");

/** A readable long-form page for the terms, privacy notice and accessibility statement, with a contents list and a plain "draft" banner. */
export function LegalPage({ doc }: { doc: DocKey }) {
  const { locale } = useI18n();
  const l = locale === "fr" ? "fr" : "en";
  const d = DOCS[doc][l]; const ui = UI[l];
  return (
    <div className="legal" lang={l}>
      <a href="#main" className="skip-link">{l === "fr" ? "Aller au contenu" : "Skip to content"}</a>
      <header className="legal-bar">
        <Logo size={28} href="/" />
        <span style={{ flex: 1 }} />
        <LanguageToggle />
      </header>
      <main id="main" className="legal-main">
        <nav className="legal-links" aria-label="Legal">
          <Link href="/terms" aria-current={doc === "terms" ? "page" : undefined}>{ui.terms}</Link>
          <Link href="/privacy" aria-current={doc === "privacy" ? "page" : undefined}>{ui.privacy}</Link>
          <Link href="/accessibility" aria-current={doc === "accessibility" ? "page" : undefined}>{ui.accessibility}</Link>
        </nav>
        <h1>{d.title}</h1>
        <p className="legal-meta">{ui.updated}: {UPDATED[l]}{doc !== "accessibility" ? ` · ${ui.version} ${TERMS_VERSION}` : ""}</p>
        <p className="legal-draft" role="note">{ui.draft}</p>
        <p className="legal-intro">{d.intro}</p>
        <div className="legal-grid">
          <nav className="legal-toc" aria-label={ui.on}>
            <h2>{ui.on}</h2>
            <ol>{d.sections.map((s) => <li key={s.h}><a href={`#${slug(s.h)}`}>{s.h}</a></li>)}</ol>
          </nav>
          <div className="legal-body">
            {d.sections.map((s) => (
              <section key={s.h} id={slug(s.h)} aria-labelledby={`h-${slug(s.h)}`}>
                <h2 id={`h-${slug(s.h)}`}>{s.h}</h2>
                {s.p?.map((p) => <p key={p}>{p}</p>)}
                {s.ul ? <ul>{s.ul.map((x) => <li key={x}>{x}</li>)}</ul> : null}
              </section>
            ))}
          </div>
        </div>
        <p><Link href="/" className="legal-back">← {ui.back}</Link></p>
      </main>
    </div>
  );
}
