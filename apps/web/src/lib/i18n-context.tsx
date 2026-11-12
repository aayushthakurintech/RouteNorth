"use client";
import { DEFAULT_LOCALE, LOCALES, isRtl, translate, type Locale, type MessageKey } from "@routenorth/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Vars = Record<string, string | number>;

interface I18n {
  locale: Locale;
  setLocale: (l: Locale) => void;
  t: (key: MessageKey, vars?: Vars) => string;
}

const Ctx = createContext<I18n>({ locale: DEFAULT_LOCALE, setLocale: () => {}, t: (k) => k });
const KEY = "routenorth.locale";

/** Replace {name} placeholders. */
export function fill(text: string, vars?: Vars): string {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [locale, setLocaleState] = useState<Locale>(DEFAULT_LOCALE);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY) as Locale | null;
      const lang = navigator.language.toLowerCase();
      const browser = lang.startsWith("fr") ? "fr" : null;
      const pick = saved && LOCALES.includes(saved) ? saved : browser;
      if (pick) setLocaleState(pick);
    } catch { /* ignore */ }
  }, []);

  const setLocale = useCallback((l: Locale) => {
    setLocaleState(l);
    try { localStorage.setItem(KEY, l); } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dir = isRtl(locale) ? "rtl" : "ltr";
  }, [locale]);

  const value = useMemo<I18n>(() => ({ locale, setLocale, t: (k, vars) => fill(translate(locale, k), vars) }), [locale, setLocale]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useI18n = () => useContext(Ctx);
