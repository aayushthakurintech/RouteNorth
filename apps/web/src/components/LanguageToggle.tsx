"use client";
import { LOCALES } from "@routenorth/shared";
import { useI18n } from "@/lib/i18n-context";

export function LanguageToggle() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div role="group" aria-label={t("language")} className="lang">
      {LOCALES.map((l) => (
        <button key={l} type="button" aria-pressed={l === locale} onClick={() => setLocale(l)}>
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}
