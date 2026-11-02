import { jwtVerify, SignJWT } from "jose";

export interface Session {
  userId: string;
  orgId: string;
  role: string;
}

const enc = (secret: string) => new TextEncoder().encode(secret);

export async function signSession(secret: string, s: Session, expiresIn = "12h"): Promise<string> {
  return new SignJWT({ org: s.orgId, role: s.role })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(s.userId)
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(enc(secret));
}

/** Returns the session, or null for any invalid/expired token. */
export async function verifySession(secret: string, token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, enc(secret), { algorithms: ["HS256"] });
    if (!payload.sub || typeof payload.org !== "string" || typeof payload.role !== "string") return null;
    return { userId: payload.sub, orgId: payload.org, role: payload.role };
  } catch {
    return null;
  }
}
