import type { Locale } from "@routenorth/shared";

export const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
export const WS_URL = API_URL.replace(/^http/, "ws");

export interface StoredSession {
  token: string;
  locale: Locale;
  role?: string;
}

const KEY = "routenorth.session";
/**
 * A staff "view as client" session lives in sessionStorage, which belongs to one browser tab, so it never replaces the
 * staff member's own console session (localStorage) in their other tabs, and it disappears when the tab is closed.
 */
const VIEW_KEY = "routenorth.staffview";

export function loadSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(VIEW_KEY) ?? localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as StoredSession) : null;
  } catch {
    return null;
  }
}

export function saveSession(s: StoredSession | null): void {
  try {
    if (s) localStorage.setItem(KEY, JSON.stringify(s));
    else if (sessionStorage.getItem(VIEW_KEY)) sessionStorage.removeItem(VIEW_KEY);
    else localStorage.removeItem(KEY);
  } catch {
    /* storage unavailable: the session just won't persist */
  }
}

export function saveStaffView(s: StoredSession): void {
  try { sessionStorage.setItem(VIEW_KEY, JSON.stringify(s)); } catch { /* the tab cannot hold a view */ }
}

/** Staff accounts carry a role like "platform:support"; clients never do. */
export const isStaffRole = (role: string | undefined): boolean => !!role && role.startsWith("platform:");
