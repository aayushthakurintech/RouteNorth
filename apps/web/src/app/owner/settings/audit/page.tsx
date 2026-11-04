"use client";
import { ShieldAlert } from "lucide-react";
import { useMemo, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DataTable, type BuiltInView, type Col, type FilterDef } from "@/components/portal/data-table";
import { PageHeader, StatusBadge } from "@/components/portal/parts";
import { useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

interface Row { id: string; at: string; actor: string | null; action: string; entity: string | null; entityId: string | null; label: string | null; oldValue: Record<string, unknown> | null; newValue: Record<string, unknown> | null; sensitive: boolean; method: string | null; path: string | null; status: number | null; detail: unknown; ip: string | null }

const json = (v: unknown) => (v == null ? "" : JSON.stringify(v));
/** Audit log: who changed what, with old and new values. Pay rate changes, payout approvals and bank changes are highlighted. */
export default function AuditPage() {
  const fmt = useFmt();
  const api = useApi<Row[]>("/audit?limit=500");
  const [open, setOpen] = useState<Row | null>(null);
  const columns = useMemo<Col<Row>[]>(() => [
    { id: "at", accessorKey: "at", header: "Time", cell: ({ row }) => fmt.dateTime(row.original.at), meta: { label: "Time", csv: (r) => r.at, xtype: "date" } },
    { id: "actor", accessorKey: "actor", header: "Person", cell: ({ row }) => row.original.actor ?? "—", meta: { label: "Person" } },
    { id: "action", accessorKey: "action", header: "Action", cell: ({ row }) => <span className="inline-flex items-center gap-1.5">{row.original.sensitive && <ShieldAlert className="size-4 text-warn" aria-label="Sensitive change" />}<code className="text-xs">{row.original.action}</code></span>, meta: { label: "Action", csv: (r) => r.action } },
    { id: "item", accessorFn: (r) => r.label ?? r.entity ?? "", header: "Item", cell: ({ row }) => row.original.label ?? row.original.entity ?? "—", meta: { label: "Item", csv: (r) => r.label ?? r.entity ?? "" } },
    { id: "old", accessorFn: (r) => json(r.oldValue), header: "Old value", cell: ({ row }) => <span className="font-mono text-xs">{json(row.original.oldValue) || "—"}</span>, meta: { label: "Old value", csv: (r) => json(r.oldValue) } },
    { id: "new", accessorFn: (r) => json(r.newValue ?? r.detail), header: "New value", cell: ({ row }) => <span className="font-mono text-xs">{json(row.original.newValue ?? row.original.detail) || "—"}</span>, meta: { label: "New value", csv: (r) => json(r.newValue ?? r.detail) } },
    { id: "ip", accessorKey: "ip", header: "IP", cell: ({ row }) => row.original.ip ?? "—", meta: { label: "IP address" } },
  ], [fmt]);
  const entities = useMemo(() => [...new Set((api.data ?? []).map((r) => r.entity).filter(Boolean) as string[])].sort(), [api.data]);
  const filters: FilterDef<Row>[] = [
    { id: "entity", label: "Item type", options: entities.map((e) => ({ value: e, label: e })), get: (r) => r.entity },
    { id: "kind", label: "Action", options: ["create", "update", "archive", "restore", "delete", "approve", "export", "login"].map((a) => ({ value: a, label: a })), get: (r) => r.action.split(".").filter((p) => ["create", "update", "archive", "restore", "delete", "approve", "export", "login"].includes(p)).slice(-1)[0] ?? null },
  ];
  const views: BuiltInView<Row>[] = [
    { id: "sensitive", name: "Pay, payouts and bank changes", predicate: (r) => r.sensitive },
    { id: "exports", name: "Exports", predicate: (r) => r.action === "export" || r.action === "audit.export" },
    { id: "logins", name: "Sign-ins", predicate: (r) => r.action.startsWith("auth.") },
  ];
  return (
    <>
      <PageHeader title="Audit log" description="Every create, edit, archive, export, approval and sign-in. Nobody can edit or delete these lines." crumbs={[{ label: "Settings", href: "/owner/settings" }, { label: "Audit log" }]} />
      <DataTable id="audit" data={api.data} loading={api.loading} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => r.id} searchText={(r) => `${r.actor} ${r.action} ${r.label} ${r.entity} ${json(r.oldValue)} ${json(r.newValue)}`}
        filters={filters} builtInViews={views} onRowClick={setOpen} exportName="audit-log" selectable={false} defaultSort={[{ id: "at", desc: true }]} pageSize={50}
        empty={{ title: "No changes logged yet", description: "Changes to vehicles, drivers, pay rates and settings appear here as they happen." }} />
      <Sheet open={!!open} onOpenChange={(o) => !o && setOpen(null)}>
        <SheetContent className="w-full overflow-y-auto sm:max-w-lg">
          {open && (
            <>
              <SheetHeader><SheetTitle>{open.action}</SheetTitle><SheetDescription>{fmt.dateTime(open.at)} · {open.actor ?? "system"} · {open.ip ?? "no IP"}</SheetDescription></SheetHeader>
              <div className="space-y-3 p-4 text-sm">
                {open.sensitive && <StatusBadge tone="warn">Sensitive change</StatusBadge>}
                <div><div className="text-muted-foreground">Item</div>{open.label ?? open.entity ?? "—"} {open.entityId && <Badge variant="outline" className="ml-1 font-mono text-[10px]">{open.entityId.slice(0, 8)}</Badge>}</div>
                <div><div className="text-muted-foreground">Old value</div><pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{JSON.stringify(open.oldValue, null, 2) ?? "—"}</pre></div>
                <div><div className="text-muted-foreground">New value</div><pre className="overflow-x-auto rounded bg-muted p-2 text-xs">{JSON.stringify(open.newValue ?? open.detail, null, 2) ?? "—"}</pre></div>
                <div className="text-xs text-muted-foreground">{open.method} {open.path} → {open.status}</div>
              </div>
            </>
          )}
        </SheetContent>
      </Sheet>
    </>
  );
}
