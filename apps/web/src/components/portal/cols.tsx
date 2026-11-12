import type { ReactNode } from "react";
import type { Col } from "@/components/portal/data-table";
import type { Rec } from "@/components/portal/child-section";

/** Column builder for lists of loose records (child tabs): reads r[id] unless a cell function is given. */
export const col = (id: string, header: string, cell: (r: Rec) => ReactNode, o: { csv?: (r: Rec) => string | number | null | undefined; end?: boolean; num?: boolean } = {}): Col<Rec> => ({
  id, accessorFn: (r) => r[id] as unknown, header, cell: ({ row }) => cell(row.original) ?? "—",
  meta: { label: header, csv: o.csv ?? ((r) => (r[id] == null ? "" : String(r[id]))), align: o.end ? "end" : undefined, xtype: o.num ? "num" : undefined },
});
export const sel = (xs: string[]) => xs.map((x) => ({ value: x, label: x.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase()) }));
export const dollars = (c: number | null | undefined) => (c == null ? "" : (c / 100).toFixed(2));
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join("") || "?";
