/** Is a page on `parentOrigin` allowed to show the tracking widget? An empty list allows every site. */
export function frameAllowed(parentOrigin: string | null, allowed: string): boolean {
  const list = allowed.split(/[\s,]+/).map((x) => x.trim().replace(/\/+$/, "").toLowerCase()).filter(Boolean);
  if (list.length === 0) return true;
  if (!parentOrigin) return false;
  const o = parentOrigin.replace(/\/+$/, "").toLowerCase();
  return list.some((a) => a === o || (a.startsWith("https://*.") && o.startsWith("https://") && o.endsWith(a.slice(9))));
}

/** The origin of the page that frames us, as far as the browser tells us. */
export function parentOrigin(): string | null {
  try {
    const anc = (location as unknown as { ancestorOrigins?: DOMStringList }).ancestorOrigins;
    if (anc && anc.length) return anc[0] ?? null;
    return document.referrer ? new URL(document.referrer).origin : null;
  } catch { return null; }
}
