"use client";
import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export interface Crumb { label: string; href?: string }
interface Ctx { crumbs: Crumb[]; setCrumbs: (c: Crumb[]) => void }
const C = createContext<Ctx>({ crumbs: [], setCrumbs: () => {} });

export function CrumbsProvider({ children }: { children: ReactNode }) {
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const value = useMemo(() => ({ crumbs, setCrumbs }), [crumbs]);
  return <C.Provider value={value}>{children}</C.Provider>;
}

/** A page calls this to say where it sits: useBreadcrumbs([{label:"Routes", href:"/routes"}, {label:"Downtown"}]). */
export function useBreadcrumbs(items: Crumb[]) {
  const { setCrumbs } = useContext(C);
  const key = JSON.stringify(items);
  useEffect(() => { setCrumbs(JSON.parse(key) as Crumb[]); return () => setCrumbs([]); }, [key, setCrumbs]);
}

export const useCrumbs = () => useContext(C).crumbs;
