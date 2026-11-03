"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { apiGet, Unauthorized } from "./api";

export interface ApiState<T> {
  data: T | null;
  error: Error | null;
  loading: boolean;
  /** true once a first load has finished (so refreshes do not flash skeletons) */
  loaded: boolean;
  reload: () => void;
  /** Replace the data locally (optimistic edits). */
  setData: (updater: (d: T | null) => T | null) => void;
}

/**
 * GET a JSON endpoint with loading and error state. `path` null skips the request.
 * `intervalMs` refreshes quietly in the background.
 */
export function useApi<T>(path: string | null, opts: { intervalMs?: number } = {}): ApiState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [loading, setLoading] = useState(path !== null);
  const [loaded, setLoaded] = useState(false);
  const [tick, setTick] = useState(0);
  const alive = useRef(0);

  useEffect(() => {
    if (path === null) { setLoading(false); return; }
    const run = ++alive.current;
    setLoading(true);
    apiGet<T>(path)
      .then((d) => { if (run === alive.current) { setDataState(d); setError(null); setLoaded(true); } })
      .catch((e: unknown) => {
        if (run !== alive.current) return;
        if (e instanceof Unauthorized && typeof window !== "undefined") window.location.assign("/login");
        setError(e instanceof Error ? e : new Error(String(e)));
      })
      .finally(() => { if (run === alive.current) setLoading(false); });
    return () => { alive.current++; };
  }, [path, tick]);

  useEffect(() => {
    if (!opts.intervalMs || path === null) return;
    const id = setInterval(() => setTick((n) => n + 1), opts.intervalMs);
    return () => clearInterval(id);
  }, [opts.intervalMs, path]);

  const reload = useCallback(() => setTick((n) => n + 1), []);
  const setData = useCallback((fn: (d: T | null) => T | null) => setDataState((d) => fn(d)), []);
  return { data, error, loading, loaded, reload, setData };
}
