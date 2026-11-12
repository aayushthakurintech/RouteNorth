/** Pure sorting, filtering and grouping for the smart table, kept apart so it can be tested. */

export type Cell = string | number | boolean | null | undefined | Date;

export interface SortSpec { key: string; dir: "asc" | "desc" }

export function compareCells(a: Cell, b: Cell): number {
  const na = a === null || a === undefined || a === "";
  const nb = b === null || b === undefined || b === "";
  if (na || nb) return na === nb ? 0 : na ? 1 : -1; // blanks always last
  if (a instanceof Date || b instanceof Date) return new Date(a as Date).getTime() - new Date(b as Date).getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return Number(a) - Number(b);
  return String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: "base" });
}

export function matches(value: Cell, needle: string): boolean {
  if (!needle) return true;
  if (value === null || value === undefined) return false;
  const text = value instanceof Date ? value.toISOString() : String(value);
  return text.toLowerCase().includes(needle.toLowerCase());
}

export function sortRows<T>(rows: readonly T[], get: (row: T, key: string) => Cell, sort: SortSpec | null): T[] {
  if (!sort) return [...rows];
  const sign = sort.dir === "asc" ? 1 : -1;
  // Blanks stay last in both directions, so compare them separately from the sign.
  return rows
    .map((r, i) => ({ r, i, v: get(r, sort.key) }))
    .sort((x, y) => {
      const bx = x.v === null || x.v === undefined || x.v === "";
      const by = y.v === null || y.v === undefined || y.v === "";
      if (bx || by) return bx === by ? x.i - y.i : bx ? 1 : -1;
      return sign * compareCells(x.v, y.v) || x.i - y.i;
    })
    .map((x) => x.r);
}

export function filterRows<T>(
  rows: readonly T[], get: (row: T, key: string) => Cell, keys: readonly string[], global: string, perColumn: Record<string, string>,
): T[] {
  return rows.filter((r) =>
    (!global || keys.some((k) => matches(get(r, k), global))) &&
    Object.entries(perColumn).every(([k, needle]) => matches(get(r, k), needle)),
  );
}

export type DisplayItem<T> = { kind: "row"; row: T } | { kind: "group"; label: string; count: number };

export function groupRows<T>(rows: readonly T[], get: (row: T, key: string) => Cell, key: string | null, blank = "—"): DisplayItem<T>[] {
  if (!key) return rows.map((row) => ({ kind: "row", row }));
  const groups = new Map<string, T[]>();
  for (const r of rows) {
    const v = get(r, key);
    const label = v === null || v === undefined || v === "" ? blank : v instanceof Date ? v.toISOString() : String(v);
    (groups.get(label) ?? groups.set(label, []).get(label)!).push(r);
  }
  const out: DisplayItem<T>[] = [];
  for (const label of [...groups.keys()].sort((a, b) => (a === blank ? 1 : b === blank ? -1 : a.localeCompare(b, undefined, { numeric: true })))) {
    const list = groups.get(label)!;
    out.push({ kind: "group", label, count: list.length });
    for (const row of list) out.push({ kind: "row", row });
  }
  return out;
}

/** Which slice of fixed-height rows to draw for a scroll position. */
export function windowRange(total: number, scrollTop: number, viewport: number, rowHeight: number, overscan = 8) {
  const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
  const last = Math.min(total, Math.ceil((scrollTop + viewport) / rowHeight) + overscan);
  return { first, last, padTop: first * rowHeight, padBottom: Math.max(0, (total - last) * rowHeight) };
}

/** CSV with quotes escaped and spreadsheet-formula starts neutralised. */
export function toCsv(header: string[], rows: Cell[][]): string {
  const cell = (v: Cell) => {
    let s = v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [header, ...rows].map((r) => r.map(cell).join(",")).join("\n");
}
