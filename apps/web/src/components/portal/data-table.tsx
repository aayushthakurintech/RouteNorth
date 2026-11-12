"use client";
import {
  flexRender, getCoreRowModel, getPaginationRowModel, getSortedRowModel, useReactTable,
  type ColumnDef, type RowSelectionState, type SortingState, type VisibilityState,
} from "@tanstack/react-table";
import { ArrowDown, ArrowUp, ArrowUpDown, Bookmark, Columns3, Download, LayoutGrid, Rows3, Save, Search, Trash2, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { DropdownMenu, DropdownMenuCheckboxItem, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { apiDownload, apiSend } from "@/lib/api";
import { useMe, type SavedView } from "@/lib/me-context";
import { cn } from "@/lib/utils";
import { EmptyState, ErrorState, LoadingState } from "./states";
import { toast } from "sonner";

export interface ColMeta<T> {
  /** Column title (also used in the column picker and exports). */
  label: string;
  /** Plain value for CSV/Excel. Default: the accessor value. Money should be exported as plain digits. */
  csv?: (row: T) => string | number | null | undefined;
  /** How the value is typed in an Excel export. */
  xtype?: "text" | "num" | "date" | "bool";
  align?: "end";
  /** Hide on phones' card view. */
  hideOnCard?: boolean;
}
export type Col<T> = ColumnDef<T, unknown> & { meta?: ColMeta<T> };

export interface FilterDef<T> { id: string; label: string; options: { value: string; label: string }[]; get: (row: T) => string | string[] | null | undefined }
export interface BuiltInView<T> { id: string; name: string; predicate: (row: T) => boolean }
export interface BulkAction<T> { label: string; icon?: ReactNode; destructive?: boolean; run: (rows: T[]) => Promise<void> | void; /** Ask first. */ confirm?: string }

interface ViewState { search: string; filters: Record<string, string>; sort: SortingState; hidden: string[] }

/**
 * The portal's list pattern (shadcn Data Table + TanStack Table), used by every list screen:
 * search, filters, sort, column toggle, pagination, saved views, bulk actions with a floating bar, CSV/Excel export,
 * a table or a grid of cards, loading / empty / error states, and cards instead of a table on phones.
 */
export function DataTable<T>({
  id, data, loading, error, onRetry, columns, rowId, searchText, filters = [], builtInViews = [], bulkActions = [], onRowClick, renderCard, exportName,
  empty, toolbar, pageSize = 25, defaultSort, selectable = true, exportFilters,
}: {
  id: string; data: T[] | null; loading?: boolean; error?: Error | null; onRetry?: () => void;
  columns: Col<T>[]; rowId: (r: T) => string; searchText: (r: T) => string;
  filters?: FilterDef<T>[]; builtInViews?: BuiltInView<T>[]; bulkActions?: BulkAction<T>[];
  onRowClick?: (r: T) => void; renderCard?: (r: T) => ReactNode; exportName?: string;
  empty?: { title: string; description?: ReactNode; action?: ReactNode }; toolbar?: ReactNode; pageSize?: number; defaultSort?: SortingState; selectable?: boolean;
  /** Shown in the export log so the file can be traced back to the screen's filters. */
  exportFilters?: Record<string, unknown>;
}) {
  const { prefs, setPrefs } = useMe();
  const page = `portal:${id}`;
  const saved = useMemo(() => (prefs.savedViews ?? []).filter((v) => v.page === page), [prefs.savedViews, page]);
  const [st, setSt] = useState<ViewState>({ search: "", filters: {}, sort: defaultSort ?? [], hidden: [] });
  const [builtIn, setBuiltIn] = useState<string | null>(null);
  const [activeSaved, setActiveSaved] = useState<string | null>(null);
  const [view, setView] = useState<"table" | "grid">("table");
  const [selection, setSelection] = useState<RowSelectionState>({});
  const [pageIndex, setPageIndex] = useState(0);
  const [size, setSize] = useState(pageSize);
  const [busy, setBusy] = useState(false);

  const rows = useMemo(() => {
    const q = st.search.trim().toLowerCase();
    const bi = builtInViews.find((v) => v.id === builtIn);
    return (data ?? []).filter((r) => {
      if (bi && !bi.predicate(r)) return false;
      if (q && !searchText(r).toLowerCase().includes(q)) return false;
      for (const f of filters) {
        const want = st.filters[f.id];
        if (!want || want === "all") continue;
        const got = f.get(r);
        if (Array.isArray(got) ? !got.includes(want) : got !== want) return false;
      }
      return true;
    });
  }, [data, st.search, st.filters, builtIn, builtInViews, filters, searchText]);

  const withSelect = useMemo<Col<T>[]>(() => !selectable || bulkActions.length === 0 ? columns : [{
    id: "_select", enableSorting: false, enableHiding: false,
    header: ({ table }) => <Checkbox aria-label="Select all rows on this page" checked={table.getIsAllPageRowsSelected() || (table.getIsSomePageRowsSelected() && "indeterminate")} onCheckedChange={(v) => table.toggleAllPageRowsSelected(!!v)} onClick={(e) => e.stopPropagation()} />,
    cell: ({ row }) => <Checkbox aria-label="Select row" checked={row.getIsSelected()} onCheckedChange={(v) => row.toggleSelected(!!v)} onClick={(e) => e.stopPropagation()} />,
  } as Col<T>, ...columns], [columns, selectable, bulkActions.length]);

  const visibility: VisibilityState = useMemo(() => Object.fromEntries(st.hidden.map((k) => [k, false])), [st.hidden]);
  const table = useReactTable({
    data: rows, columns: withSelect, getRowId: rowId,
    state: { sorting: st.sort, columnVisibility: visibility, rowSelection: selection, pagination: { pageIndex, pageSize: size } },
    onSortingChange: (u) => setSt((s) => ({ ...s, sort: typeof u === "function" ? u(s.sort) : u })),
    onRowSelectionChange: setSelection,
    onPaginationChange: (u) => { const n = typeof u === "function" ? u({ pageIndex, pageSize: size }) : u; setPageIndex(n.pageIndex); setSize(n.pageSize); },
    getCoreRowModel: getCoreRowModel(), getSortedRowModel: getSortedRowModel(), getPaginationRowModel: getPaginationRowModel(),
    enableRowSelection: selectable && bulkActions.length > 0,
    autoResetPageIndex: false,
  });
  useEffect(() => { setPageIndex(0); }, [st.search, st.filters, builtIn]);
  const selected = useMemo(() => rows.filter((r) => selection[rowId(r)]), [rows, selection, rowId]);
  const clearSelection = useCallback(() => setSelection({}), []);

  const colMeta = (c: Col<T>): ColMeta<T> | undefined => c.meta;
  const exportCols = columns.filter((c) => c.id !== "_select" && !!colMeta(c) && !st.hidden.includes(String(c.id ?? ""))).map((c) => ({ c, m: colMeta(c)! }));
  const valueOf = (c: Col<T>, m: ColMeta<T>, r: T) => m.csv ? m.csv(r) : ("accessorKey" in c && c.accessorKey ? (r as Record<string, unknown>)[String(c.accessorKey)] as string | number | null : "");
  const doExport = async (format: "csv" | "xlsx", only?: T[]) => {
    const list = only ?? table.getSortedRowModel().rows.map((r) => r.original);
    if (!list.length) { toast.info("Nothing to export."); return; }
    setBusy(true);
    try {
      // Goes through the API so every export is written to the audit log, and the file matches what is on screen.
      await apiDownloadPost(`/portal/export?format=${format}`, `${exportName ?? id}.${format}`, {
        title: exportName ?? id, filters: { search: st.search || undefined, ...st.filters, view: builtIn ?? undefined, ...exportFilters },
        columns: exportCols.map(({ c, m }) => ({ key: String(c.id), label: m.label, type: m.xtype ?? "text" })),
        rows: list.map((r) => Object.fromEntries(exportCols.map(({ c, m }) => [String(c.id), valueOf(c, m, r) ?? null]))),
      });
    } catch (e) { toast.error(e instanceof Error ? e.message : "Export failed"); } finally { setBusy(false); }
  };

  const saveView = () => {
    const name = window.prompt("Name this view");
    if (!name?.trim()) return;
    const v: SavedView = { id: crypto.randomUUID(), page, name: name.trim().slice(0, 60), state: { ...st, builtIn } };
    setPrefs({ savedViews: [...(prefs.savedViews ?? []), v] });
    setActiveSaved(v.id);
    toast.success(`Saved view "${v.name}"`);
  };
  const applySaved = (v: SavedView) => {
    const s = v.state as Partial<ViewState> & { builtIn?: string | null };
    setSt({ search: s.search ?? "", filters: s.filters ?? {}, sort: s.sort ?? [], hidden: s.hidden ?? [] });
    setBuiltIn(s.builtIn ?? null); setActiveSaved(v.id);
  };
  const reset = () => { setSt({ search: "", filters: {}, sort: defaultSort ?? [], hidden: [] }); setBuiltIn(null); setActiveSaved(null); };
  const dirty = !!(st.search || Object.values(st.filters).some((v) => v && v !== "all") || builtIn || st.hidden.length);

  if (error && !data) return <ErrorState error={error} onRetry={onRetry} />;
  if (loading && !data) return <LoadingState />;

  const total = data?.length ?? 0;
  const cardRows = table.getRowModel().rows;
  const gridLike = (view === "grid" && !!renderCard);

  return (
    <div className="space-y-3">
      {(builtInViews.length > 0 || saved.length > 0) && (
        <div className="flex flex-wrap items-center gap-1.5" role="toolbar" aria-label="Saved views">
          <Bookmark className="size-4 text-muted-foreground" aria-hidden />
          <Button size="sm" variant={!builtIn && !activeSaved ? "secondary" : "outline"} onClick={reset}>All</Button>
          {builtInViews.map((v) => <Button key={v.id} size="sm" variant={builtIn === v.id ? "secondary" : "outline"} onClick={() => { reset(); setBuiltIn(v.id); }}>{v.name}</Button>)}
          {saved.map((v) => (
            <span key={v.id} className="inline-flex">
              <Button size="sm" variant={activeSaved === v.id ? "secondary" : "outline"} className="rounded-r-none" onClick={() => applySaved(v)}>{v.name}</Button>
              <Button size="icon" variant="outline" className="size-8 rounded-l-none border-l-0" aria-label={`Delete saved view ${v.name}`} onClick={() => { setPrefs({ savedViews: (prefs.savedViews ?? []).filter((x) => x.id !== v.id) }); if (activeSaved === v.id) reset(); }}><X className="size-3" /></Button>
            </span>
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 size-4 text-muted-foreground" aria-hidden />
          <Input aria-label="Search" placeholder="Search…" className="pl-8" value={st.search} onChange={(e) => setSt((s) => ({ ...s, search: e.target.value }))} />
        </div>
        {filters.map((f) => (
          <Select key={f.id} value={st.filters[f.id] ?? "all"} onValueChange={(v) => { setSt((s) => ({ ...s, filters: { ...s.filters, [f.id]: v } })); setActiveSaved(null); }}>
            <SelectTrigger size="sm" className="w-auto min-w-28" aria-label={`Filter by ${f.label}`}><span className="text-muted-foreground">{f.label}:</span><SelectValue /></SelectTrigger>
            <SelectContent><SelectItem value="all">All</SelectItem>{f.options.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}</SelectContent>
          </Select>
        ))}
        {dirty && <Button size="sm" variant="ghost" onClick={reset}><X /> Clear</Button>}
        <div className="ml-auto flex items-center gap-1.5">
          {toolbar}
          {renderCard && (
            <div className="hidden overflow-hidden rounded-md border sm:flex" role="group" aria-label="View">
              <Button size="icon" variant={view === "table" ? "secondary" : "ghost"} className="size-8 rounded-none" aria-label="Table view" aria-pressed={view === "table"} onClick={() => setView("table")}><Rows3 /></Button>
              <Button size="icon" variant={view === "grid" ? "secondary" : "ghost"} className="size-8 rounded-none" aria-label="Grid view" aria-pressed={view === "grid"} onClick={() => setView("grid")}><LayoutGrid /></Button>
            </div>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="outline" aria-label="Choose columns"><Columns3 /><span className="hidden sm:inline">Columns</span></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Show columns</DropdownMenuLabel>
              {columns.filter((c) => c.id && c.id !== "_select" && colMeta(c)).map((c) => (
                <DropdownMenuCheckboxItem key={String(c.id)} checked={!st.hidden.includes(String(c.id))} onSelect={(e) => e.preventDefault()}
                  onCheckedChange={(v) => setSt((s) => ({ ...s, hidden: v ? s.hidden.filter((h) => h !== String(c.id)) : [...s.hidden, String(c.id)] }))}>{colMeta(c)!.label}</DropdownMenuCheckboxItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Button size="sm" variant="outline" onClick={saveView} aria-label="Save this view"><Save /><span className="hidden sm:inline">Save view</span></Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild><Button size="sm" variant="outline" disabled={busy} aria-label="Export"><Download /><span className="hidden sm:inline">Export</span></Button></DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={() => void doExport("csv")}>CSV ({rows.length} rows)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => void doExport("xlsx")}>Excel ({rows.length} rows)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>

      {rows.length === 0 ? (
        total === 0
          ? <EmptyState title={empty?.title ?? "Nothing here yet"} action={empty?.action}>{empty?.description}</EmptyState>
          : <EmptyState title="No rows match these filters" action={<Button size="sm" variant="outline" onClick={reset}>Clear filters</Button>}>Try a wider search, or clear the filters above.</EmptyState>
      ) : (
        <>
          {/* Phones: cards instead of a table. Grid view: the same cards on a wider screen. */}
          <div className={cn("grid gap-3 sm:grid-cols-2 xl:grid-cols-3", gridLike ? "" : "md:hidden")}>
            {(renderCard || gridLike || true) && cardRows.map((r) => (
              <div key={r.id} role={onRowClick ? "button" : undefined} tabIndex={onRowClick ? 0 : undefined} className={cn("rounded-lg border bg-card p-3 text-sm", onRowClick && "cursor-pointer hover:border-primary")}
                onClick={() => onRowClick?.(r.original)} onKeyDown={(e) => { if (e.key === "Enter") onRowClick?.(r.original); }}>
                {renderCard ? renderCard(r.original) : (
                  <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                    {r.getVisibleCells().filter((c) => c.column.id !== "_select" && !colMeta(c.column.columnDef as Col<T>)?.hideOnCard).map((c) => (
                      <div key={c.id} className="contents"><dt className="text-muted-foreground">{colMeta(c.column.columnDef as Col<T>)?.label ?? ""}</dt><dd className="min-w-0 truncate text-right">{flexRender(c.column.columnDef.cell, c.getContext())}</dd></div>
                    ))}
                  </dl>
                )}
              </div>
            ))}
          </div>
          {!gridLike && (
            <div className="hidden rounded-lg border md:block">
              <Table>
                <TableHeader>
                  {table.getHeaderGroups().map((hg) => (
                    <TableRow key={hg.id}>
                      {hg.headers.map((h) => {
                        const m = colMeta(h.column.columnDef as Col<T>);
                        const sorted = h.column.getIsSorted();
                        return (
                          <TableHead key={h.id} aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : undefined} className={cn(m?.align === "end" && "text-right")}>
                            {h.isPlaceholder ? null : h.column.getCanSort() ? (
                              <button className={cn("inline-flex items-center gap-1 font-medium hover:text-foreground", m?.align === "end" && "flex-row-reverse")} onClick={h.column.getToggleSortingHandler()}>
                                {flexRender(h.column.columnDef.header, h.getContext())}
                                {sorted === "asc" ? <ArrowUp className="size-3" /> : sorted === "desc" ? <ArrowDown className="size-3" /> : <ArrowUpDown className="size-3 opacity-40" />}
                              </button>
                            ) : flexRender(h.column.columnDef.header, h.getContext())}
                          </TableHead>
                        );
                      })}
                    </TableRow>
                  ))}
                </TableHeader>
                <TableBody>
                  {cardRows.map((r) => (
                    <TableRow key={r.id} data-state={r.getIsSelected() ? "selected" : undefined} className={cn(onRowClick && "cursor-pointer")} onClick={() => onRowClick?.(r.original)}>
                      {r.getVisibleCells().map((c) => <TableCell key={c.id} className={cn("max-w-[22rem] truncate", colMeta(c.column.columnDef as Col<T>)?.align === "end" && "text-right tabular-nums")}>{flexRender(c.column.columnDef.cell, c.getContext())}</TableCell>)}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
            <span>{rows.length === total ? `${total} rows` : `${rows.length} of ${total} rows`}</span>
            <div className="flex items-center gap-2">
              <Select value={String(size)} onValueChange={(v) => { setSize(Number(v)); setPageIndex(0); }}>
                <SelectTrigger size="sm" className="w-24" aria-label="Rows per page"><SelectValue /></SelectTrigger>
                <SelectContent>{[10, 25, 50, 100].map((n) => <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>)}</SelectContent>
              </Select>
              <Button size="sm" variant="outline" disabled={!table.getCanPreviousPage()} onClick={() => table.previousPage()}>Previous</Button>
              <span>Page {pageIndex + 1} of {Math.max(1, table.getPageCount())}</span>
              <Button size="sm" variant="outline" disabled={!table.getCanNextPage()} onClick={() => table.nextPage()}>Next</Button>
            </div>
          </div>
        </>
      )}

      {/* Floating bar while rows are selected. */}
      {selected.length > 0 && (
        <div role="region" aria-label="Bulk actions" className="fixed inset-x-0 bottom-20 z-50 mx-auto flex w-fit max-w-[95vw] flex-wrap items-center gap-2 rounded-full border bg-popover px-4 py-2 shadow-lg md:bottom-6">
          <span className="text-sm font-medium">{selected.length} selected</span>
          {bulkActions.map((a) => (
            <Button key={a.label} size="sm" variant={a.destructive ? "destructive" : "secondary"} disabled={busy} onClick={async () => {
              if (a.confirm && !window.confirm(a.confirm.replace("{n}", String(selected.length)))) return;
              setBusy(true);
              try { await a.run(selected); clearSelection(); } catch (e) { toast.error(e instanceof Error ? e.message : "That did not work"); } finally { setBusy(false); }
            }}>{a.icon}{a.label}</Button>
          ))}
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void doExport("csv", selected)}><Download /> Export selected</Button>
          <Button size="icon" variant="ghost" className="size-8" aria-label="Clear selection" onClick={clearSelection}><Trash2 className="hidden" /><X /></Button>
        </div>
      )}
    </div>
  );
}

/** POST JSON, save the file the server sends back. */
export async function apiDownloadPost(path: string, filename: string, body: unknown): Promise<void> {
  const { loadSession, API_URL } = await import("@/lib/session");
  const s = loadSession();
  if (!s) throw new Error("Not signed in");
  const res = await fetch(`${API_URL}${path}`, { method: "POST", headers: { Authorization: `Bearer ${s.token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!res.ok) throw new Error(`Export failed (HTTP ${res.status})`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(await res.blob());
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

export { apiDownload, apiSend };
