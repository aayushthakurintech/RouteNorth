import { createHash, randomBytes } from "node:crypto";

export const KEY_KINDS = ["api", "feed", "inbound", "gps"] as const;
export type KeyKind = (typeof KEY_KINDS)[number];
export const hashKey = (key: string) => createHash("sha256").update(key).digest("hex");
export const isKeyToken = (s: string) => /^rn_(api|feed|in|gps)_[A-Za-z0-9_-]{32,}$/.test(s);

/** A new random key. Only its hash is stored, so it can be shown once and never again. */
export function newKey(kind: KeyKind): { key: string; prefix: string; hash: string } {
  const tag = kind === "inbound" ? "in" : kind;
  const key = `rn_${tag}_${randomBytes(24).toString("base64url")}`;
  return { key, prefix: key.slice(0, 12), hash: hashKey(key) };
}
