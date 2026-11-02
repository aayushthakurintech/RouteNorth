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
