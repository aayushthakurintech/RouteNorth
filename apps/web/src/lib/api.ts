"use client";
import { API_URL, loadSession, saveSession } from "./session";

export class Unauthorized extends Error {}

/** A failed call. `message` keeps the old "HTTP 403" wording for reads; `code` is the server's machine-readable reason, such as "step_up_required". */
export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string, readonly detail?: string) { super(message); }
}
async function failure(res: Response, plain: boolean): Promise<ApiError> {
  const d = await res.json().catch(() => null) as { message?: unknown; code?: unknown } | null;
  const detail = typeof d?.message === "string" ? d.message : undefined;
  return new ApiError(plain ? `HTTP ${res.status}` : detail ?? `HTTP ${res.status}`, res.status, typeof d?.code === "string" ? d.code : undefined, detail);
}

/** GET a JSON endpoint with the saved token. Throws Unauthorized on 401 (and clears the session). */
export async function apiGet<T>(path: string): Promise<T> {
  const session = loadSession();
  if (!session) throw new Unauthorized();
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${session.token}` } });
  if (res.status === 401) { saveSession(null); throw new Unauthorized(); }
  if (!res.ok) throw await failure(res, true);
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
  if (!res.ok) throw await failure(res, false);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** Download a file from the API (it needs the sign-in header, so a plain link will not do). */
export async function apiDownload(path: string, filename: string): Promise<void> {
  const session = loadSession();
  if (!session) throw new Unauthorized();
  const res = await fetch(`${API_URL}${path}`, { headers: { Authorization: `Bearer ${session.token}` } });
  if (res.status === 401) { saveSession(null); throw new Unauthorized(); }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await res.blob());
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

/** Download a file that the API builds from a JSON request (a report export). */
export async function apiDownloadPost(path: string, body: unknown, filename: string): Promise<void> {
  const session = loadSession();
  if (!session) throw new Unauthorized();
  const res = await fetch(`${API_URL}${path}`, { method: "POST", headers: { Authorization: `Bearer ${session.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (res.status === 401) { saveSession(null); throw new Unauthorized(); }
  if (!res.ok) { const d = await res.json().catch(() => null); throw new Error(typeof d?.message === "string" ? d.message : `HTTP ${res.status}`); }
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await res.blob());
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}
