"use client";
import { useMemo } from "react";
import { DataTable, type Col } from "@/components/portal/data-table";
import { PageHeader, StatCard } from "@/components/portal/parts";
import { useOwnerRange } from "@/components/portal/range-context";
import { plainMoney, useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

interface Row { month: string; salesCents: number; taxCollectedCents: number; spendCents: number; taxPaidCents: number; netOwedCents: number }
interface Res { months: Row[]; totals: Omit<Row, "month">; driverPaidByType: { type: string; cents: number }[]; note: string }

/** Tax summary for your accountant: tax collected on invoices, tax paid on expenses, and what drivers were paid by employment type. Not a filing. */
export default function TaxPage() {
  const fmt = useFmt(); const { range } = useOwnerRange();
  const api = useApi<Res>(`/portal/finance/tax?from=${range.from}&to=${range.to}`);
  const money = (key: keyof Row, header: string): Col<Row> => ({ id: key, accessorKey: key, header, cell: ({ row }) => fmt.money(row.original[key] as number), meta: { label: header, align: "end", csv: (r) => plainMoney(r[key] as number), xtype: "num" } });
  const columns = useMemo<Col<Row>[]>(() => [
    { id: "month", accessorKey: "month", header: "Month", cell: ({ row }) => row.original.month, meta: { label: "Month" } },
    money("salesCents", "Sales"), money("taxCollectedCents", "Tax collected"), money("spendCents", "Expenses"), money("taxPaidCents", "Tax paid"), money("netOwedCents", "Net tax owed"),
  ], [fmt]);
  const t = api.data?.totals;
  return (
    <>
      <PageHeader title="Tax summary" description="For your accountant, for the dates picked at the top." />
      <div className="mb-4 grid gap-3 sm:grid-cols-3">
        <StatCard label="Tax collected" value={fmt.money(t?.taxCollectedCents)} loading={!t} hint="On invoices sent or paid" />
        <StatCard label="Tax paid" value={fmt.money(t?.taxPaidCents)} loading={!t} hint="Recorded on expenses" />
        <StatCard label="Net tax owed" value={fmt.money(t?.netOwedCents)} loading={!t} />
      </div>
      {api.data && <p className="mb-3 text-xs text-muted-foreground">{api.data.note}</p>}
      <DataTable id="finance-tax" data={api.data?.months ?? null} loading={api.loading} error={api.error} onRetry={api.reload} columns={columns} rowId={(r) => r.month} searchText={(r) => r.month} selectable={false} exportName="tax-summary"
        empty={{ title: "No invoices or expenses in these dates", description: "Pick a longer range at the top." }} />
      {(api.data?.driverPaidByType.length ?? 0) > 0 && <div className="mt-4 rounded-lg border p-3 text-sm"><h2 className="mb-2 font-medium">Paid to drivers in these dates</h2>
        <ul>{api.data!.driverPaidByType.map((d) => <li key={d.type} className="flex justify-between"><span className="capitalize">{d.type.replace("_", " ")}</span><span className="tabular-nums">{fmt.money(d.cents)}</span></li>)}</ul></div>}
    </>
  );
}
