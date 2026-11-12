import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encrypts small secrets (two-factor seeds, GPS provider logins) before they are stored, with AES-256-GCM.
 *
 * The key comes from ENCRYPTION_KEY. Production must set it (the API refuses to start without it), so the secret that
 * signs sign-ins (JWT_SECRET) and the one that protects stored logins are different, and a leak of one does not give
 * away the other. Outside production, `fallback` (JWT_SECRET) stands in when ENCRYPTION_KEY is missing.
 *
 * Format `v2.<key id>.<iv>.<tag>.<data>`: the key id says which key wrote it, so the key can be rotated: set the new
 * value in ENCRYPTION_KEY and the old one in ENCRYPTION_KEY_PREVIOUS; old values still read, new ones use the new key.
 * `v1.<iv>.<tag>.<data>` (no key id) is the older format and is still read.
 */
const derive = (material: string): Buffer => createHash("sha256").update(`routenorth:secrets:${material}`).digest();
const keyId = (key: Buffer) => createHash("sha256").update(key).digest("hex").slice(0, 8);

function keys(fallback: string): Buffer[] {
  const out: Buffer[] = [];
  for (const m of [process.env.ENCRYPTION_KEY, process.env.ENCRYPTION_KEY_PREVIOUS]) if (m) out.push(derive(m));
  if (!process.env.ENCRYPTION_KEY && fallback) out.push(derive(fallback));
  return out;
}

export function encryptSecret(fallback: string, plain: string): string {
  const key = keys(fallback)[0];
  if (!key) throw new Error("ENCRYPTION_KEY is not set");
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v2.${keyId(key)}.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

function open(key: Buffer, iv: string, tag: string, body: string): string | null {
  try {
    const d = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

export function decryptSecret(fallback: string, packed: string): string | null {
  const parts = packed.split(".");
  const candidates = keys(fallback);
  if (parts[0] === "v2" && parts.length === 5) {
    const [, kid, iv, tag, body] = parts as [string, string, string, string, string];
    const key = candidates.find((k) => keyId(k) === kid);
    return key ? open(key, iv, tag, body) : null;
  }
  if (parts[0] === "v1" && parts.length === 4) {
    // Written before key ids: try each key we have.
    const [, iv, tag, body] = parts as [string, string, string, string];
    for (const k of candidates) { const v = open(k, iv, tag, body); if (v != null) return v; }
  }
  return null;
}

/** Why the encryption key is not set the way production needs it (its own value, not the sign-in secret), or null. */
export function encryptionKeyProblem(jwtSecret: string | undefined): string | null {
  const k = process.env.ENCRYPTION_KEY ?? "";
  if (k.length < 32) return "ENCRYPTION_KEY (32+ characters) is required in production";
  if (k === jwtSecret) return "ENCRYPTION_KEY must differ from JWT_SECRET";
  return null;
}
