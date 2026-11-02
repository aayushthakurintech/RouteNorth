"use client";
import { API_URL, loadSession, saveSession } from "./session";

export class Unauthorized extends Error {}

/** GET a JSON endpoint with the saved token. Throws Unauthorized on 401 (and clears the session). */
export async function apiGet<T>(path: string): Promise<T> {
  const session = loadSession();
  if (!session) throw new Unauthorized();
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${session.token}` } });
  if (res.status === 401) { saveSession(null); throw new Unauthorized(); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** Send JSON with the saved token. Throws Unauthorized on 401 and Error on any other failure. */
export async function apiSend<T>(method: "POST" | "PUT" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  const session = loadSession();
  if (!session) throw new Unauthorized();
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${session.token}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401) { saveSession(null); throw new Unauthorized(); }
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(typeof detail?.message === "string" ? detail.message : `HTTP ${res.status}`);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}
