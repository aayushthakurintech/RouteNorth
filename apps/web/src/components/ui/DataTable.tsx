"use client";
import { ArrowDown, ArrowUp, Columns3, Download, Filter, Pin, PinOff, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n-context";
import { useMe, type SavedView } from "@/lib/me-context";
import { filterRows, groupRows, sortRows, toCsv, windowRange, type Cell, type SortSpec } from "@/lib/table-logic";
import { EmptyState } from "./primitives";

export interface Column<T> {
  key: string;
  header: string;
  /** Raw value for sorting, filtering and export. */
  value: (row: T) => Cell;
  /** How the cell looks. Defaults to the raw value. */
  render?: (row: T) => ReactNode;
  width?: number;
  numeric?: boolean;
  /** Double-click the cell to edit it. Return a rejected promise to cancel the edit. */
  edit?: (row: T, text: string) => Promise<void> | void;
  hidden?: boolean;
  pinned?: boolean;
  noGroup?: boolean;
}

interface TableState { sort: SortSpec | null; global: string; per: Record<string, string>; hidden: string[]; pinned: string[]; widths: Record<string, number>; group: string | null }
const ROW_H = 38;
const VIRTUAL_AFTER = 150;

/**
 * A table that people can work in: click a header to sort, filter, group, pin and hide columns,
 * drag column edges to resize, double-click an editable cell, export CSV, and save the arrangement as a named view.
 * Sticky header; long lists are windowed so ten thousand rows stay smooth.
 */
export function DataTable<T>({
  tableId, columns, rows, rowKey, onRowClick, empty, maxHeight = "70vh", csvName,
}: {
  tableId: string; columns: Column<T>[]; rows: T[]; rowKey: (row: T) => string; onRowClick?: (row: T) => void;
  empty?: ReactNode; maxHeight?: string; csvName?: string;
}) {
  const { t } = useI18n();
  const { prefs, setPrefs } = useMe();
  const [st, setSt] = useState<TableState>(() => ({
    sort: null, global: "", per: {}, hidden: columns.filter((c) => c.hidden).map((c) => c.key),
    pinned: columns.filter((c) => c.pinned).map((c) => c.key), widths: {}, group: null,
  }));
  const [showFilters, setShowFilters] = useState(false);
  const [showCols, setShowCols] = useState(false);
  const [editing, setEditing] = useState<{ id: string; key: string } | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(600);
  const scroller = useRef<HTMLDivElement>(null);
  const patch = (p: Partial<TableState>) => setSt((s) => ({ ...s, ...p }));

  const visible = columns.filter((c) => !st.hidden.includes(c.key));
  const ordered = [...visible.filter((c) => st.pinned.includes(c.key)), ...visible.filter((c) => !st.pinned.includes(c.key))];
  const width = (c: Column<T>) => st.widths[c.key] ?? c.width ?? 160;
  const get = useCallback((r: T, k: string) => columns.find((c) => c.key === k)?.value(r), [columns]);

  const items = useMemo(() => {
    const filtered = filterRows(rows, get, visible.map((c) => c.key), st.global, st.per);
    return groupRows(sortRows(filtered, get, st.sort), get, st.group);
  }, [rows, get, visible, st.global, st.per, st.sort, st.group]);
  const rowCount = items.reduce((n, i) => n + (i.kind === "row" ? 1 : 0), 0);

  const virtual = items.length > VIRTUAL_AFTER;
  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewport(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const win = virtual ? windowRange(items.length, scrollTop, viewport, ROW_H) : { first: 0, last: items.length, padTop: 0, padBottom: 0 };

  const sortBy = (key: string) => {
    const cur = st.sort;
    patch({ sort: !cur || cur.key !== key ? { key, dir: "asc" } : cur.dir === "asc" ? { key, dir: "desc" } : null });
  };
  const startResize = (e: React.PointerEvent, c: Column<T>) => {
    e.preventDefault();
    const startX = e.clientX, start = width(c), rtl = document.documentElement.dir === "rtl";
    const move = (ev: PointerEvent) => patch({ widths: { ...st.widths, [c.key]: Math.max(60, start + (rtl ? startX - ev.clientX : ev.clientX - startX)) } });
    const up = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };
  const pinOffset = (c: Column<T>) => {
    let off = 0;
    for (const o of ordered) { if (o.key === c.key) break; if (st.pinned.includes(o.key)) off += width(o); }
    return off;
  };

  const exportCsv = () => {
    const flat = items.filter((i): i is { kind: "row"; row: T } => i.kind === "row");
    const csv = toCsv(visible.map((c) => c.header), flat.map((i) => visible.map((c) => c.value(i.row))));
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url; a.download = `${csvName ?? tableId}.csv`; a.click();
    URL.revokeObjectURL(url);
  };

  const views = (prefs.savedViews ?? []).filter((v) => v.page === `table:${tableId}`);
  const saveView = () => {
    const name = window.prompt(t("viewName"));
    if (!name) return;
    const view: SavedView = { id: crypto.randomUUID(), page: `table:${tableId}`, name, state: st as unknown as Record<string, unknown> };
    setPrefs({ savedViews: [...(prefs.savedViews ?? []), view] });
  };

  return (
    <div className="dt-wrap">
      <div className="dt-tools" role="toolbar" aria-label={t("tableSearch")}>
        <input type="search" aria-label={t("tableSearch")} placeholder={t("tableSearch")} value={st.global} onChange={(e) => patch({ global: e.target.value })} />
        <button type="button" className="icon-btn" aria-pressed={showFilters} aria-label={t("tableClearFilters")} title={t("tableSearch")} onClick={() => setShowFilters((v) => !v)}><Filter size={18} /></button>
        <div className="rel">
          <button type="button" className="icon-btn" aria-expanded={showCols} aria-label={t("tableColumns")} title={t("tableColumns")} onClick={() => setShowCols((v) => !v)}><Columns3 size={18} /></button>
          {showCols && (
            <div className="menu" role="group" aria-label={t("tableColumns")}>
              {columns.map((c) => (
                <label key={c.key} className="check menu-item">
                  <input type="checkbox" checked={!st.hidden.includes(c.key)} onChange={() => patch({ hidden: st.hidden.includes(c.key) ? st.hidden.filter((k) => k !== c.key) : [...st.hidden, c.key] })} />
                  {c.header}
                </label>
              ))}
              <div className="menu-sep" />
              <label className="field menu-item" style={{ flexDirection: "column", alignItems: "stretch" }}>
                <span>{t("tableGroupBy")}</span>
                <select value={st.group ?? ""} onChange={(e) => patch({ group: e.target.value || null })}>
                  <option value="">{t("tableNoGroup")}</option>
                  {columns.filter((c) => !c.noGroup).map((c) => <option key={c.key} value={c.key}>{c.header}</option>)}
                </select>
              </label>
            </div>
          )}
        </div>
        <select aria-label={t("savedViews")} value="" onChange={(e) => { const v = views.find((x) => x.id === e.target.value); if (v) setSt(v.state as unknown as TableState); }}>
          <option value="">{views.length ? t("savedViews") : t("noViews")}</option>
          {views.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
        </select>
        <button type="button" className="icon-btn" aria-label={t("saveView")} title={t("saveView")} onClick={saveView}><Save size={18} /></button>
        {views.length > 0 && (
          <button type="button" className="icon-btn" aria-label={t("deleteView")} title={t("deleteView")} onClick={() => setPrefs({ savedViews: (prefs.savedViews ?? []).filter((v) => v.id !== views[views.length - 1]!.id) })}><Trash2 size={18} /></button>
        )}
        <button type="button" className="icon-btn" aria-label={t("exportCsv")} title={t("exportCsv")} onClick={exportCsv}><Download size={18} /></button>
      </div>
      <div ref={scroller} className="dt-scroll" style={{ ["--dt-max" as string]: maxHeight }} onScroll={(e) => virtual && setScrollTop(e.currentTarget.scrollTop)}>
        <table className="dt">
          <colgroup>{ordered.map((c) => <col key={c.key} style={{ width: width(c) }} />)}</colgroup>
          <thead>
            <tr>
              {ordered.map((c) => {
                const pinned = st.pinned.includes(c.key);
                const sorted = st.sort?.key === c.key ? st.sort.dir : null;
                return (
                  <th
                    key={c.key} scope="col" className={`${c.numeric ? "n" : ""} ${pinned ? "pinned" : ""}`} style={{ insetInlineStart: pinned ? pinOffset(c) : undefined, position: "sticky" }}
                    aria-sort={sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"}
                  >
                    <div className="th-inner" style={{ justifyContent: c.numeric ? "flex-end" : undefined }}>
                      <button type="button" className="th-btn" onClick={() => sortBy(c.key)} title={sorted === "asc" ? t("tableSortAsc") : sorted === "desc" ? t("tableSortDesc") : undefined}>
                        {c.header}{sorted === "asc" && <ArrowUp size={14} aria-hidden />}{sorted === "desc" && <ArrowDown size={14} aria-hidden />}
                      </button>
                      <button
                        type="button" className="icon-btn" style={{ width: 22, height: 22 }} aria-label={pinned ? t("tableUnpin") : t("tablePin")} title={pinned ? t("tableUnpin") : t("tablePin")}
                        onClick={() => patch({ pinned: pinned ? st.pinned.filter((k) => k !== c.key) : [...st.pinned, c.key] })}
                      >{pinned ? <PinOff size={13} /> : <Pin size={13} />}</button>
                    </div>
                    <span className="resizer" role="separator" aria-label={t("tableResize")} onPointerDown={(e) => startResize(e, c)} />
                  </th>
                );
              })}
            </tr>
            {showFilters && (
              <tr>
                {ordered.map((c) => (
                  <th key={c.key} style={{ position: "sticky", top: 36, background: "var(--surface)" }}>
                    <input className="cell-edit" aria-label={`${t("tableSearch")}: ${c.header}`} value={st.per[c.key] ?? ""} onChange={(e) => patch({ per: { ...st.per, [c.key]: e.target.value } })} />
                  </th>
                ))}
              </tr>
            )}
          </thead>
          <tbody>
            {win.padTop > 0 && <tr aria-hidden><td colSpan={ordered.length} style={{ height: win.padTop, padding: 0, border: 0 }} /></tr>}
            {items.slice(win.first, win.last).map((it, idx) => {
              if (it.kind === "group") {
                return <tr key={`g${win.first + idx}${it.label}`} className="group-row" style={{ height: ROW_H }}><td colSpan={ordered.length}>{it.label} · {t("tableRows", { n: it.count })}</td></tr>;
              }
              const id = rowKey(it.row);
              return (
                <tr key={id} style={{ height: ROW_H }} data-clickable={!!onRowClick} onClick={() => onRowClick?.(it.row)}>
                  {ordered.map((c) => {
                    const pinned = st.pinned.includes(c.key);
                    const isEditing = editing?.id === id && editing.key === c.key;
                    return (
                      <td
                        key={c.key} className={`${c.numeric ? "n" : ""} ${pinned ? "pinned" : ""}`} style={{ insetInlineStart: pinned ? pinOffset(c) : undefined }}
                        onDoubleClick={c.edit ? (e) => { e.stopPropagation(); setEditing({ id, key: c.key }); } : undefined}
                        title={c.edit ? t("edit") : undefined}
                      >
                        {isEditing ? (
                          <input
                            className="cell-edit" autoFocus defaultValue={String(c.value(it.row) ?? "")} aria-label={c.header}
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={async (e) => {
                              if (e.key === "Escape") setEditing(null);
                              if (e.key === "Enter") { const v = e.currentTarget.value; setEditing(null); try { await c.edit?.(it.row, v); } catch { /* the page shows the error */ } }
                            }}
                            onBlur={() => setEditing(null)}
                          />
                        ) : c.render ? c.render(it.row) : String(c.value(it.row) ?? "—")}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
            {win.padBottom > 0 && <tr aria-hidden><td colSpan={ordered.length} style={{ height: win.padBottom, padding: 0, border: 0 }} /></tr>}
          </tbody>
        </table>
        {rowCount === 0 && (empty ?? <EmptyState title={t("tableEmpty")} action={(st.global || Object.values(st.per).some(Boolean)) ? <button type="button" className="btn alt" onClick={() => patch({ global: "", per: {} })}>{t("tableClearFilters")}</button> : undefined} />)}
      </div>
      <div className="dt-foot"><span>{t("tableRows", { n: rowCount })}</span></div>
    </div>
  );
}
