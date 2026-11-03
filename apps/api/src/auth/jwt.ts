import { jwtVerify, SignJWT } from "jose";

export interface Session {
  userId: string;
  orgId: string;
  role: string;
  /** The sign-in this token belongs to (a row in user_sessions). Older tokens have none. */
  sid?: string;
}

const enc = (secret: string) => new TextEncoder().encode(secret);

export async function signSession(secret: string, s: Session, expiresIn = "12h"): Promise<string> {
  return new SignJWT({ org: s.orgId, role: s.role, ...(s.sid ? { sid: s.sid } : {}) })
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
    if (!payload.sub || typeof payload.org !== "string" || typeof payload.role !== "string" || payload.mfa) return null;
    return { userId: payload.sub, orgId: payload.org, role: payload.role, ...(typeof payload.sid === "string" ? { sid: payload.sid } : {}) };
  } catch {
    return null;
  }
}

/** A five-minute pass that proves the password was right and a second factor is still needed. It is never a session. */
export async function signChallenge(secret: string, userId: string, orgId: string): Promise<string> {
  return new SignJWT({ org: orgId, mfa: 1 }).setProtectedHeader({ alg: "HS256" }).setSubject(userId).setIssuedAt().setExpirationTime("5m").sign(enc(secret));
}

export async function verifyChallenge(secret: string, token: string): Promise<{ userId: string; orgId: string } | null> {
  try {
    const { payload } = await jwtVerify(token, enc(secret), { algorithms: ["HS256"] });
    if (!payload.sub || typeof payload.org !== "string" || payload.mfa !== 1) return null;
    return { userId: payload.sub, orgId: payload.org };
  } catch {
    return null;
  }
}
