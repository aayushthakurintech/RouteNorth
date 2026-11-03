/** The first `fraction` (0 to 1) of a line, measured along its length. Used to draw a route onto the map. */
export function partialLine(coords: [number, number][], fraction: number): [number, number][] {
  if (coords.length < 2 || fraction >= 1) return coords;
  if (fraction <= 0) return coords.slice(0, 1);
  const seg = coords.slice(1).map((c, i) => Math.hypot(c[0] - coords[i]![0], c[1] - coords[i]![1]));
  const total = seg.reduce((a, b) => a + b, 0);
  if (total === 0) return coords;
  let left = total * fraction;
  const out: [number, number][] = [coords[0]!];
  for (let i = 0; i < seg.length; i++) {
    const len = seg[i]!;
    const a = coords[i]!, b = coords[i + 1]!;
    if (left >= len) { out.push(b); left -= len; continue; }
    const f = len === 0 ? 0 : left / len;
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
    break;
  }
  return out;
}

export const prefersReducedMotion = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Draws a line onto a map source over about a second, so the eye follows where the route goes.
 * With reduced motion it shows the whole line at once. Returns a function that cancels the animation.
 */
export function animateLine(set: (coords: [number, number][]) => void, coords: [number, number][], ms = 900): () => void {
  if (coords.length < 2 || prefersReducedMotion()) { set(coords); return () => {}; }
  let raf = 0;
  const start = performance.now();
  const step = (now: number) => {
    const p = Math.min(1, (now - start) / ms);
    set(partialLine(coords, 1 - Math.pow(1 - p, 3)));
    if (p < 1) raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
  return () => cancelAnimationFrame(raf);
}
