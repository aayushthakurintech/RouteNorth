"use client";
import { Archive, ArchiveRestore, Plus } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { DataTable, type Col } from "@/components/portal/data-table";
import { RecordDialog, type FieldSpec } from "@/components/portal/field-form";
import { apiSend } from "@/lib/api";
import { useApi } from "@/lib/use-api";

export type Rec = Record<string, unknown> & { id: string; archivedAt?: string | null };

/**
 * A list of records that belong to one parent (a car's maintenance, a driver's documents ...) with add, edit and archive.
 * Nothing is deleted: archived lines can be shown and restored. The API checks permission; `canWrite` only hides the buttons.
 */
export function ChildSection({ id, title, base, name, fields, columns, canWrite, empty, addLabel = "Add", describe, rowActions, extra, onChange, defaults, dialogWarning }: {
  id: string; title?: string; base: string; name: string; fields: FieldSpec[]; columns: Col<Rec>[]; canWrite: boolean;
  empty: { title: string; description?: string }; addLabel?: string; describe?: (r: Rec) => string;
  rowActions?: (r: Rec, reload: () => void) => ReactNode; extra?: ReactNode; onChange?: () => void; defaults?: Record<string, unknown>; dialogWarning?: ReactNode;
}) {
  const [showArchived, setShowArchived] = useState(false);
  const api = useApi<Rec[]>(`${base}/${name}${showArchived ? "?archived=1" : ""}`);
  const [dlg, setDlg] = useState<{ rec: Rec | null } | null>(null);
  const reload = () => { api.reload(); onChange?.(); };

  async function toggleArchive(r: Rec) {
    try {
      await apiSend("POST", `${base}/${name}/${r.id}/${r.archivedAt ? "restore" : "archive"}`);
      toast.success(r.archivedAt ? "Restored" : "Archived. You can bring it back from Show archived.");
      reload();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not change this record"); }
  }

  const cols = useMemo<Col<Rec>[]>(() => [
    ...columns,
    ...(canWrite ? [{
      id: "_actions", header: "", enableSorting: false,
      cell: ({ row }: { row: { original: Rec } }) => (
        <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
          {rowActions?.(row.original, reload)}
          <Button size="sm" variant="ghost" onClick={() => toggleArchive(row.original)} aria-label={row.original.archivedAt ? "Restore" : "Archive"}>
            {row.original.archivedAt ? <ArchiveRestore className="size-4" /> : <Archive className="size-4" />}
          </Button>
        </div>
      ),
      meta: { label: "Actions", csv: () => "" },
    } as Col<Rec>] : []),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  ], [columns, canWrite, rowActions]);

  return (
    <section className="space-y-3" aria-label={title ?? name}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        {title ? <h2 className="text-base font-semibold">{title}</h2> : <span />}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2"><Checkbox id={`arch-${id}`} checked={showArchived} onCheckedChange={(c) => setShowArchived(c === true)} /><Label htmlFor={`arch-${id}`} className="text-sm font-normal">Show archived</Label></div>
          {canWrite && <Button size="sm" onClick={() => setDlg({ rec: null })}><Plus className="size-4" /> {addLabel}</Button>}
        </div>
      </div>
      {extra}
      <DataTable id={id} data={api.data} loading={api.loading && !api.loaded} error={api.error} onRetry={api.reload} columns={cols} rowId={(r) => r.id}
        searchText={(r) => describe?.(r) ?? Object.values(r).filter((v) => typeof v === "string").join(" ")} selectable={false} exportName={id} pageSize={10}
        onRowClick={canWrite ? (r) => setDlg({ rec: r }) : undefined}
        empty={{ ...empty, action: canWrite ? <Button size="sm" onClick={() => setDlg({ rec: null })}><Plus className="size-4" /> {addLabel}</Button> : undefined }} />
      {dlg && (
        <RecordDialog open onOpenChange={(o) => !o && setDlg(null)} title={dlg.rec ? `Edit ${title?.toLowerCase() ?? "record"}` : addLabel} fields={fields}
          record={dlg.rec ?? defaults ?? null} method={dlg.rec ? "PATCH" : "POST"} path={dlg.rec ? `${base}/${name}/${dlg.rec.id}` : `${base}/${name}`} warning={dialogWarning} onDone={reload} />
      )}
    </section>
  );
}
