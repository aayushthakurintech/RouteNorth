export type Pt = [number, number];

/** Linear interpolation of positions so markers glide to a new fix instead of jumping. */
export function interpolate(from: Pt, to: Pt, t: number): Pt {
  const k = Math.max(0, Math.min(1, t));
  return [from[0] + (to[0] - from[0]) * k, from[1] + (to[1] - from[1]) * k];
}

/** Ease-out so a marker decelerates into place. */
export const easeOut = (t: number) => 1 - (1 - Math.max(0, Math.min(1, t))) ** 3;

/** Where each id should be drawn `t` (0..1) of the way from its old to its new position. New ids appear at their target. */
export function glideFrame(from: Record<string, Pt>, to: Record<string, Pt>, t: number): Record<string, Pt> {
  const out: Record<string, Pt> = {};
  const e = easeOut(t);
  for (const [id, target] of Object.entries(to)) out[id] = from[id] ? interpolate(from[id], target, e) : target;
  return out;
}
