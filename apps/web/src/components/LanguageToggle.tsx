"use client";
import { LOCALES, LOCALE_NAMES, type Locale } from "@routenorth/shared";
import { useI18n } from "@/lib/i18n-context";

export function LanguageToggle() {
  const { locale, setLocale, t } = useI18n();
  return (
    <div className="lang">
      <select aria-label={t("language")} value={locale} onChange={(e) => setLocale(e.target.value as Locale)}>
        {LOCALES.map((l) => <option key={l} value={l} lang={l}>{LOCALE_NAMES[l]}</option>)}
      </select>
    </div>
  );
}
