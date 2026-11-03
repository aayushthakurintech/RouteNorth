/**
 * Feature flags: ship a change switched off, then turn it on for a few organizations before everyone.
 * A flag is on for an organization when it has chosen so (an override), or else when the flag is on by default,
 * or when the organization falls inside the rollout percentage. The percentage is stable: the same organization
 * always gets the same answer, and raising the percentage only ever adds organizations.
 */
export interface FlagDef { key: string; default: boolean; rolloutPct: number }

export const FLAGS: readonly FlagDef[] = [
  { key: "assistant", default: true, rolloutPct: 100 },
  { key: "compactTables", default: false, rolloutPct: 0 },
  { key: "roadmapVotes", default: true, rolloutPct: 100 },
  { key: "usageAnalytics", default: true, rolloutPct: 100 },
];

/** A number from 0 to 99 that depends only on the organization and the flag (FNV-1a). */
export function rolloutBucket(orgId: string, key: string): number {
  let h = 0x811c9dc5;
  for (const ch of `${orgId}:${key}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 0x01000193) >>> 0; }
  return h % 100;
}

export function flagEnabled(key: string, orgId: string, overrides: Record<string, boolean> = {}, defs: readonly FlagDef[] = FLAGS): boolean {
  const def = defs.find((d) => d.key === key);
  if (!def) return false;
  if (typeof overrides[key] === "boolean") return overrides[key]!;
  return def.default || rolloutBucket(orgId, key) < def.rolloutPct;
}

export function resolveFlags(orgId: string, overrides: Record<string, boolean> = {}, defs: readonly FlagDef[] = FLAGS): Record<string, boolean> {
  return Object.fromEntries(defs.map((d) => [d.key, flagEnabled(d.key, orgId, overrides, defs)]));
}
