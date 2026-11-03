import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** Time-based one-time passwords (RFC 6238), compatible with any authenticator app. */
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32(buf: Buffer): string {
  let bits = 0, value = 0, out = "";
  for (const b of buf) {
    value = (value << 8) | b; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function fromBase32(s: string): Buffer {
  let bits = 0, value = 0; const out: number[] = [];
  for (const ch of s.replace(/[\s=-]/g, "").toUpperCase()) {
    const i = ALPHABET.indexOf(ch);
    if (i < 0) throw new Error("not base32");
    value = (value << 5) | i; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const newSecret = (): string => base32(randomBytes(20));

export function hotp(key: Buffer, counter: number, digits = 6): string {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(counter));
  const h = createHmac("sha1", key).update(msg).digest();
  const o = h[h.length - 1]! & 15;
  const n = ((h[o]! & 127) << 24) | (h[o + 1]! << 16) | (h[o + 2]! << 8) | h[o + 3]!;
  return String(n % 10 ** digits).padStart(digits, "0");
}

export const stepOf = (ms = Date.now()): number => Math.floor(ms / 30_000);

/** The step the code belongs to (allowing one step of clock drift either way), or null when it is wrong. */
export function matchStep(secret: string, code: string, ms = Date.now()): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const key = fromBase32(secret);
  for (const d of [0, -1, 1]) {
    const step = stepOf(ms) + d;
    const a = Buffer.from(hotp(key, step)), b = Buffer.from(code);
    if (a.length === b.length && timingSafeEqual(a, b)) return step;
  }
  return null;
}

export function otpauthUrl(secret: string, account: string, issuer = "RouteNorth"): string {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

/** Ten one-time recovery codes like "k3f9-a8d2-x1"; only their hashes are stored. */
export function newRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => { const s = randomBytes(8).toString("hex"); return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8, 12)}`; });
}
export const hashRecovery = (code: string): string => createHash("sha256").update(code.replace(/[\s-]/g, "").toLowerCase()).digest("hex");
