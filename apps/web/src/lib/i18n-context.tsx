"use client";
import { DEFAULT_LOCALE, LOCALES, translate, type Locale, type MessageKey } from "@routenorth/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: MessageKey) => string;
}

const Ctx = createContext<I18n>({ locale: DEFAULT_LOCALE, setLocale: () => {}, t: (k) => k });
const KEY = "routenorth.locale";

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY) as Locale | null;
      const browser = navigator.language.toLowerCase().startsWith("fr") ? "fr" : null;
      const pick = saved && LOCALES.includes(saved) ? saved : browser;
      if (pick) setLocaleState(pick);
    } catch { /* ignore */ }
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
    document.documentElement.lang = l;
  }, []);

  useEffect(() => { document.documentElement.lang = locale; }, [locale]);

  const value = useMemo<I18n>(() => ({ locale, setLocale, t: (k) => translate(locale, k) }), [locale, setLocale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
