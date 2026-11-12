/** Declares one area's strings. English and French must have exactly the same keys (checked by the compiler). */
export function defineMessages<K extends string>(m: { en: Record<K, string>; fr: Record<K, string> }) {
  return m;
}
