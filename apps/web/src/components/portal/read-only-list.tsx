"use client";
import { DataTable, type Col } from "@/components/portal/data-table";
import type { Rec } from "@/components/portal/child-section";
import { useApi } from "@/lib/use-api";

/** A table of rows fetched from one URL, with the usual search, sort, export and loading / empty / error states. */
export function ReadOnlyList({ id, url, columns, empty, pageSize = 10 }: { id: string; url: string; columns: Col<Rec>[]; empty: { title: string; description?: string }; pageSize?: number }) {
  const api = useApi<Rec[]>(url);
  return <DataTable id={id} data={api.data} loading={api.loading && !api.loaded} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => String(r.id ?? JSON.stringify(r))} searchText={(r) => Object.values(r).filter((x) => typeof x === "string").join(" ")} selectable={false} exportName={id} pageSize={pageSize} empty={empty} />;
}
