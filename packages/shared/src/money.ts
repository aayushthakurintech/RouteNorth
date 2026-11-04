/**
 * Money for the Owner Portal: whole cents, always. No floating-point arithmetic is ever done on amounts.
 * A company has one fixed currency; amounts are stored as integer cents in that currency.
 * (Older RouteNorth tables keep dollars as decimals. They are read through `centsFromDollars` and never rewritten.)
 */
export type Cents = number;

export const isCents = (n: unknown): n is Cents => typeof n === "number" && Number.isSafeInteger(n);

/** Parse "12.34", "$1,200", "12" or a number into cents without float error. Throws on anything else. */
export function parseCents(input: string | number): Cents {
  if (typeof input === "number") {
    if (!Number.isFinite(input)) throw new Error("not a number");
    return centsFromDollars(input);
  }
  const s = input.trim().replace(/[$,\s]/g, "");
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) throw new Error(`not an amount: ${input}`);
  const cents = Number(m[2]) * 100 + Number((m[3] ?? "").padEnd(2, "0"));
  return m[1] ? -cents : cents;
}

/** Dollars as a decimal number (older tables) to cents. Rounds half away from zero at the cent. */
export function centsFromDollars(d: number): Cents {
  const c = Math.round(Math.abs(d) * 100 + 1e-9);
  return d < 0 ? -c : c;
}

/** Round an exact integer fraction num/den (den > 0) half away from zero. */
function divRound(num: number, den: number): number {
  const neg = num < 0;
  const q = Math.floor((Math.abs(num) * 2 + den) / (den * 2));
  return neg ? -q : q;
}

/** `pct` percent of an amount, e.g. percentOf(4850, 20) = 970. `pct` may have up to 4 decimals. */
export function percentOf(amount: Cents, pct: number): Cents {
  const bp = Math.round(pct * 10_000); // hundredths of a basis point: 20% -> 200000
  return divRound(amount * bp, 1_000_000);
}

/** `unitCents` for each of `qty` units, qty with up to 3 decimals (25.4 km). */
export function times(unitCents: Cents, qty: number): Cents {
  return divRound(unitCents * Math.round(qty * 1000), 1000);
}

export type RoundingRule = "cent" | "5c" | "10c" | "dollar";

/** The company's rounding rule, applied to a final amount. */
export function applyRounding(amount: Cents, rule: RoundingRule): Cents {
  const step = rule === "cent" ? 1 : rule === "5c" ? 5 : rule === "10c" ? 10 : 100;
  return step === 1 ? amount : divRound(amount, step) * step;
}

/** Split `total` into `parts` whole-cent shares that add back to exactly `total` (the first shares get the extra cents). */
export function allocate(total: Cents, weights: number[]): Cents[] {
  const sum = weights.reduce((a, b) => a + b, 0);
  if (sum <= 0) return weights.map(() => 0);
  const raw = weights.map((w) => Math.floor((total * w) / sum));
  let left = total - raw.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0 && i < raw.length; i++, left--) raw[i]!++;
  return raw;
}

export const sumCents = (xs: readonly Cents[]): Cents => xs.reduce((a, b) => a + b, 0);

/** "$1,234.50" style text for a currency. Display only. */
export function formatCents(c: Cents, currency = "CAD", locale = "en-CA"): string {
  return new Intl.NumberFormat(locale, { style: "currency", currency }).format(c / 100);
}

/** "1234.50" for CSV and spreadsheets: plain digits, no symbol, always two decimals. */
export function centsToPlain(c: Cents): string {
  const neg = c < 0; const a = Math.abs(c);
  return `${neg ? "-" : ""}${Math.floor(a / 100)}.${String(a % 100).padStart(2, "0")}`;
}
