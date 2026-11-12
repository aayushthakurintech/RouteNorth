"use client";
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type RangePreset = "today" | "7d" | "30d" | "month" | "last_month" | "quarter" | "ytd" | "custom";
export interface OwnerRange { from: string; to: string; preset: RangePreset }
interface Ctx { range: OwnerRange; setRange: (r: OwnerRange) => void; compare: boolean; setCompare: (b: boolean) => void; query: string }

const KEY = "routenorth.owner.range";
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function presetRange(p: Exclude<RangePreset, "custom">, now = new Date()): OwnerRange {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const add = (n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  switch (p) {
    case "today": return { from: ymd(d), to: ymd(d), preset: p };
    case "7d": return { from: ymd(add(-6)), to: ymd(d), preset: p };
    case "30d": return { from: ymd(add(-29)), to: ymd(d), preset: p };
    case "month": return { from: ymd(new Date(d.getFullYear(), d.getMonth(), 1)), to: ymd(d), preset: p };
    case "last_month": return { from: ymd(new Date(d.getFullYear(), d.getMonth() - 1, 1)), to: ymd(new Date(d.getFullYear(), d.getMonth(), 0)), preset: p };
    case "quarter": return { from: ymd(new Date(d.getFullYear(), Math.floor(d.getMonth() / 3) * 3, 1)), to: ymd(d), preset: p };
    case "ytd": return { from: ymd(new Date(d.getFullYear(), 0, 1)), to: ymd(d), preset: p };
  }
}

const RangeCtx = createContext<Ctx>({ range: presetRange("30d"), setRange: () => {}, compare: false, setCompare: () => {}, query: "" });

/** The date range and "compare to last period" switch in the top bar apply to every card and report (spec: dashboard). */
export function RangeProvider({ children }: { children: ReactNode }) {
  const [range, setRangeState] = useState<OwnerRange>(() => presetRange("30d"));
  const [compare, setCompareState] = useState(false);
  useEffect(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(KEY) ?? "null") as { range?: OwnerRange; compare?: boolean } | null;
      if (raw?.range && /^\d{4}-\d{2}-\d{2}$/.test(raw.range.from) && /^\d{4}-\d{2}-\d{2}$/.test(raw.range.to)) {
        setRangeState(raw.range.preset !== "custom" ? presetRange(raw.range.preset as Exclude<RangePreset, "custom">) : raw.range);
      }
      if (typeof raw?.compare === "boolean") setCompareState(raw.compare);
    } catch { /* a convenience only */ }
  }, []);
  const save = (r: OwnerRange, c: boolean) => { try { localStorage.setItem(KEY, JSON.stringify({ range: r, compare: c })); } catch { /* ignore */ } };
  const setRange = useCallback((r: OwnerRange) => { setRangeState(r); save(r, compare); }, [compare]);
  const setCompare = useCallback((c: boolean) => { setCompareState(c); save(range, c); }, [range]);
  const query = `from=${range.from}&to=${range.to}${compare ? "&compare=1" : ""}`;
  const value = useMemo(() => ({ range, setRange, compare, setCompare, query }), [range, setRange, compare, setCompare, query]);
  return <RangeCtx.Provider value={value}>{children}</RangeCtx.Provider>;
}
export const useOwnerRange = () => useContext(RangeCtx);
