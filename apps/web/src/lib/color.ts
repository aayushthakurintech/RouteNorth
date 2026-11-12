/** Brand color helpers: derive the hover, soft and text colors from one hex so any company color stays readable. */

export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const toHex = (r: number, g: number, b: number) =>
  "#" + [r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0")).join("");

/** WCAG relative luminance. */
export function luminance([r, g, b]: [number, number, number]): number {
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

export function contrast(a: [number, number, number], b: [number, number, number]): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const mix = (a: [number, number, number], b: [number, number, number], t: number): [number, number, number] =>
  [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * CSS variables for a company's brand color. On dark backgrounds the color is lightened until it reads
 * (contrast 4.5 against the dark surface); on light ones it is darkened until white text on it reads.
 */
export function brandVars(hex: string, dark: boolean): Record<string, string> | null {
  const base = parseHex(hex);
  if (!base) return null;
  const white: [number, number, number] = [255, 255, 255];
  const black: [number, number, number] = [0, 0, 0];
  const surface: [number, number, number] = dark ? [19, 26, 39] : white;
  let c = base;
  for (let i = 0; i < 20 && contrast(c, surface) < 4.5; i++) c = mix(c, dark ? white : black, 0.1);
  const text = contrast(c, white) >= contrast(c, black) ? "#ffffff" : "#000000";
  const hover = mix(c, dark ? white : black, 0.14);
  const soft = mix(surface, c, dark ? 0.22 : 0.1);
  return {
    "--brand": toHex(...c), "--brand-hover": toHex(...hover), "--brand-soft": toHex(...soft), "--brand-fg": text,
  };
}
