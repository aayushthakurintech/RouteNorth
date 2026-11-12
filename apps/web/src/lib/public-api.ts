import { API_URL } from "./session";

export class PublicError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

async function parse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new PublicError(res.status, typeof detail?.message === "string" ? detail.message : `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

/** Calls the API without a sign-in, for the pages customers open from a link. */
export async function publicGet<T>(path: string): Promise<T> {
  return parse<T>(await fetch(`${API_URL}${path}`));
}

export async function publicSend<T>(method: "POST" | "PUT", path: string, body: unknown): Promise<T> {
  return parse<T>(await fetch(`${API_URL}${path}`, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
}

/** A brand colour from the company's settings, or the product blue if it is missing or odd. */
export function safeBrand(c: string | null | undefined): string {
  return c && /^#[0-9a-f]{6}$/i.test(c) ? c : "#0f5fa8";
}
