import { useEffect, useRef, useState } from "react";

export const PULL_THRESHOLD = 70;
const MAX_PULL = 110;

/** How far the page follows the finger: it resists, so a long drag does not run away. */
export function pullDistance(dy: number): number {
  if (dy <= 0) return 0;
  return Math.min(MAX_PULL, dy * 0.5);
}

/**
 * Pull down from the top of the page to refresh, the way phone apps do.
 * Returns how far the user has pulled (for the indicator) and whether a refresh is running.
 * Only starts when the page is scrolled to the very top, so normal scrolling is never hijacked.
 */
export function usePullToRefresh(onRefresh: () => Promise<unknown> | void, enabled = true) {
  const [pull, setPull] = useState(0);
  const [busy, setBusy] = useState(false);
  const start = useRef<number | null>(null);
  const latest = useRef(onRefresh);
  latest.current = onRefresh;
  const pulled = useRef(0);

  useEffect(() => {
    if (!enabled) return;
    const down = (e: TouchEvent) => { start.current = window.scrollY <= 0 && e.touches.length === 1 ? e.touches[0]!.clientY : null; };
    const move = (e: TouchEvent) => {
      if (start.current === null) return;
      const d = pullDistance(e.touches[0]!.clientY - start.current);
      pulled.current = d;
      setPull(d);
    };
    const up = async () => {
      const go = pulled.current >= PULL_THRESHOLD * 0.5 && start.current !== null;
      start.current = null;
      pulled.current = 0;
      setPull(0);
      if (!go) return;
      setBusy(true);
      try { await latest.current(); } finally { setBusy(false); }
    };
    window.addEventListener("touchstart", down, { passive: true });
    window.addEventListener("touchmove", move, { passive: true });
    window.addEventListener("touchend", up);
    window.addEventListener("touchcancel", up);
    return () => {
      window.removeEventListener("touchstart", down);
      window.removeEventListener("touchmove", move);
      window.removeEventListener("touchend", up);
      window.removeEventListener("touchcancel", up);
    };
  }, [enabled]);

  return { pull, busy, ready: pull >= PULL_THRESHOLD * 0.5 };
}
