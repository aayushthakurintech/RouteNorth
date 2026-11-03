"use client";
import type { Permission } from "@routenorth/shared";
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { apiGet, apiSend, Unauthorized } from "./api";
import { loadSession, saveSession } from "./session";
import { useTheme } from "./theme-context";

export interface Me {
  user: { id: string; email: string; displayName: string | null; role: string; locale: string; customRoleId: string | null; customRoleName: string | null };
  perms: Permission[];
  home: string;
  org: {
    id: string; name: string; locale: string; timezone: string; brandName: string | null; brandColor: string | null; logoDataUrl: string | null;
    settings: { idleThresholdMin: number; speedLimitKmh: number; trackOnlyDuringShift: boolean; defaultMapProvider: string; currency: string; taxRatePct: number; featureFlags: Record<string, boolean> };
  };
  prefs: Prefs;
}

export interface Favorite { href: string; label: string }
export interface SavedView { id: string; page: string; name: string; state: Record<string, unknown> }
export interface Prefs {
  favorites?: Favorite[];
  savedViews?: SavedView[];
  onboarding?: { hidden?: boolean; tourDone?: boolean; steps?: string[] };
  whatsNewSeen?: string;
  navCollapsed?: boolean;
  recent?: Favorite[];
  [key: string]: unknown;
}

interface Ctx {
  me: Me | null;
  loading: boolean;
  error: Error | null;
  can: (...p: Permission[]) => boolean;
  prefs: Prefs;
  /** Merge into the saved preferences (saved after a short pause). */
  setPrefs: (patch: Partial<Prefs>) => void;
  reload: () => void;
}

const MeCtx = createContext<Ctx>({ me: null, loading: true, error: null, can: () => false, prefs: {}, setPrefs: () => {}, reload: () => {} });

/** Loads /me once the person has signed in. Pages under the app shell can rely on it. */
export function MeProvider({ children }: { children: ReactNode }) {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(true);
  const [prefs, setPrefsState] = useState<Prefs>({});
  const [tick, setTick] = useState(0);
  const { setBrand } = useTheme();
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef<Prefs>({});

  useEffect(() => {
    if (!loadSession()) { setLoading(false); return; }
    let live = true;
    apiGet<Me>("/me")
      .then((m) => { if (live) { setMe(m); setPrefsState(m.prefs ?? {}); latest.current = m.prefs ?? {}; setBrand(m.org.brandColor); setError(null); } })
      .catch((e: unknown) => {
        if (!live) return;
        if (e instanceof Unauthorized) { saveSession(null); window.location.assign("/login"); return; }
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [tick, setBrand]);

  const setPrefs = useCallback((patch: Partial<Prefs>) => {
    latest.current = { ...latest.current, ...patch };
    setPrefsState(latest.current);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { void apiSend("PUT", "/me/prefs", { prefs: latest.current }).catch(() => { /* preferences are a convenience */ }); }, 600);
  }, []);

  const can = useCallback((...p: Permission[]) => !!me && p.every((x) => me.perms.includes(x)), [me]);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  const value = useMemo(() => ({ me, loading, error, can, prefs, setPrefs, reload }), [me, loading, error, can, prefs, setPrefs, reload]);
  return <MeCtx.Provider value={value}>{children}</MeCtx.Provider>;
}

export const useMe = () => useContext(MeCtx);
