import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encrypts small secrets (such as two-factor seeds) before they are stored, with AES-256-GCM.
 * The key comes from ENCRYPTION_KEY when set, otherwise from JWT_SECRET, so a database copy alone cannot read them.
 */
const keyFor = (secret: string): Buffer => createHash("sha256").update(`routenorth:secrets:${process.env.ENCRYPTION_KEY || secret}`).digest();

export function encryptSecret(secret: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", keyFor(secret), iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

export function decryptSecret(secret: string, packed: string): string | null {
  const [v, iv, tag, body] = packed.split(".");
  if (v !== "v1" || !iv || !tag || !body) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", keyFor(secret), Buffer.from(iv, "base64url"));
    d.setAuthTag(Buffer.from(tag, "base64url"));
    return Buffer.concat([d.update(Buffer.from(body, "base64url")), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}
