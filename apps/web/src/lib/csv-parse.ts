/** A small CSV reader for the browser: quoted values, doubled quotes, commas, semicolons and tabs as separators. */
export function parseCsvText(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const src = text.replace(/^﻿/, "");
  const first = src.split(/\r?\n/, 1)[0] ?? "";
  const sep = [",", ";", "\t"].map((s) => [s, first.split(s).length] as const).sort((a, b) => b[1] - a[1])[0]![0];
  const rows: string[][] = [];
  let cur: string[] = [], cell = "", q = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i]!;
    if (q) { if (ch === '"') { if (src[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
    else if (ch === '"') q = true;
    else if (ch === sep) { cur.push(cell); cell = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && src[i + 1] === "\n") i++; cur.push(cell); cell = ""; if (cur.some((x) => x.trim())) rows.push(cur); cur = []; }
    else cell += ch;
  }
  cur.push(cell); if (cur.some((x) => x.trim())) rows.push(cur);
  const headers = (rows.shift() ?? []).map((h) => h.trim());
  return { headers, rows: rows.map((r) => Object.fromEntries(headers.map((h, i) => [h, r[i] ?? ""]))) };
}

