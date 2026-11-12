import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { decryptSecret, encryptionKeyProblem, encryptSecret } from "./secrets.js";

const saved = { k: process.env.ENCRYPTION_KEY, p: process.env.ENCRYPTION_KEY_PREVIOUS };
const set = (k?: string, p?: string) => {
  if (k === undefined) delete process.env.ENCRYPTION_KEY; else process.env.ENCRYPTION_KEY = k;
  if (p === undefined) delete process.env.ENCRYPTION_KEY_PREVIOUS; else process.env.ENCRYPTION_KEY_PREVIOUS = p;
};
const KEY_A = "a".repeat(40), KEY_B = "b".repeat(40), JWT = "j".repeat(40);

/** The older v1 format, written the way the previous code did, to prove it still reads. */
function v1(material: string, plain: string) {
  const key = createHash("sha256").update(`routenorth:secrets:${material}`).digest();
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return `v1.${iv.toString("base64url")}.${c.getAuthTag().toString("base64url")}.${body.toString("base64url")}`;
}

beforeEach(() => set());
afterEach(() => set(saved.k, saved.p));

describe("stored secrets", () => {
  it("round-trips with ENCRYPTION_KEY and does not read with the sign-in secret alone", () => {
    set(KEY_A);
    const packed = encryptSecret(JWT, "hunter2");
    expect(packed.startsWith("v2.")).toBe(true);
    expect(decryptSecret(JWT, packed)).toBe("hunter2");
    set();
    expect(decryptSecret(JWT, packed)).toBeNull();
  });
  it("rotates: old values read with ENCRYPTION_KEY_PREVIOUS, new ones use the new key", () => {
    set(KEY_A);
    const old = encryptSecret(JWT, "old");
    set(KEY_B, KEY_A);
    expect(decryptSecret(JWT, old)).toBe("old");
    const fresh = encryptSecret(JWT, "new");
    set(KEY_B);
    expect(decryptSecret(JWT, fresh)).toBe("new");
    expect(decryptSecret(JWT, old)).toBeNull();
  });
  it("still reads the v1 format, written with the sign-in secret or the key", () => {
    expect(decryptSecret(JWT, v1(JWT, "legacy"))).toBe("legacy");
    set(KEY_B, KEY_A);
    expect(decryptSecret(JWT, v1(KEY_A, "legacy-key"))).toBe("legacy-key");
  });
  it("rejects tampering and junk", () => {
    set(KEY_A);
    const p = encryptSecret(JWT, "x").split(".");
    p[4] = Buffer.from("tampered").toString("base64url");
    expect(decryptSecret(JWT, p.join("."))).toBeNull();
    expect(decryptSecret(JWT, "nonsense")).toBeNull();
  });
  it("says what is wrong with the production key", () => {
    expect(encryptionKeyProblem(JWT)).toMatch(/required/);
    set("short");
    expect(encryptionKeyProblem(JWT)).toMatch(/required/);
    set(JWT);
    expect(encryptionKeyProblem(JWT)).toMatch(/differ/);
    set(KEY_A);
    expect(encryptionKeyProblem(JWT)).toBeNull();
  });
});
