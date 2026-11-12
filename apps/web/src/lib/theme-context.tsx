"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { brandVars } from "./color";

export type ThemeMode = "light" | "dark" | "auto" | "contrast";
export type MotionMode = "auto" | "reduce" | "full";

interface Theme {
  mode: ThemeMode;
  /** What is actually shown: light, dark or contrast. */
  resolved: "light" | "dark" | "contrast";
  motion: MotionMode;
  setMode: (m: ThemeMode) => void;
  setMotion: (m: MotionMode) => void;
  /** A company brand color (#rrggbb) or null for the default. */
  setBrand: (hex: string | null) => void;
}

const Ctx = createContext<Theme>({ mode: "auto", resolved: "light", motion: "auto", setMode: () => {}, setMotion: () => {}, setBrand: () => {} });
const MODE_KEY = "routenorth.theme";
const MOTION_KEY = "routenorth.motion";
const BRAND_VARS = ["--brand", "--brand-hover", "--brand-soft", "--brand-fg"];

/** Runs before first paint (inlined in the page head) so there is no flash of the wrong theme. */
export const THEME_BOOT_SCRIPT = `try{var m=localStorage.getItem("${MODE_KEY}")||"auto";var d=matchMedia("(prefers-color-scheme: dark)").matches;document.documentElement.dataset.theme=m==="auto"?(d?"dark":"light"):m;var mo=localStorage.getItem("${MOTION_KEY}");if(mo&&mo!=="auto")document.documentElement.dataset.motion=mo}catch(e){}`;

function read<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return v && (allowed as readonly string[]).includes(v) ? (v as T) : fallback;
  } catch { return fallback; }
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("auto");
  const [motion, setMotionState] = useState<MotionMode>("auto");
  const [systemDark, setSystemDark] = useState(false);
  const [brand, setBrandState] = useState<string | null>(null);

  useEffect(() => {
    setModeState(read(MODE_KEY, ["light", "dark", "auto", "contrast"] as const, "auto"));
    setMotionState(read(MOTION_KEY, ["auto", "reduce", "full"] as const, "auto"));
    const mq = matchMedia("(prefers-color-scheme: dark)");
    setSystemDark(mq.matches);
    const on = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);

  const resolved: Theme["resolved"] = mode === "auto" ? (systemDark ? "dark" : "light") : mode;

  useEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolved;
    if (motion === "auto") delete root.dataset.motion;
    else root.dataset.motion = motion === "reduce" ? "reduce" : "full";
    // Company brand color; high contrast keeps its own accessible palette.
    for (const v of BRAND_VARS) root.style.removeProperty(v);
    const vars = brand && resolved !== "contrast" ? brandVars(brand, resolved === "dark") : null;
    if (vars) for (const [k, v] of Object.entries(vars)) root.style.setProperty(k, v);
  }, [resolved, motion, brand]);

  const setMode = useCallback((m: ThemeMode) => { setModeState(m); try { localStorage.setItem(MODE_KEY, m); } catch { /* ignore */ } }, []);
  const setMotion = useCallback((m: MotionMode) => { setMotionState(m); try { localStorage.setItem(MOTION_KEY, m); } catch { /* ignore */ } }, []);
  const value = useMemo(() => ({ mode, resolved, motion, setMode, setMotion, setBrand: setBrandState }), [mode, resolved, motion, setMode, setMotion]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const useTheme = () => useContext(Ctx);
