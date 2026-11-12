"use client";
import { Area, CartesianGrid, ComposedChart, Line, XAxis, YAxis } from "recharts";
import { ChartContainer, ChartTooltip, ChartTooltipContent, type ChartConfig } from "@/components/ui/chart";
import { cn } from "@/lib/utils";
import { useFmt } from "@/lib/portal/format";

export interface Point { from: string; to: string; revenueCents: number; costCents: number; profitCents: number; trips: number }

const config = {
  revenueCents: { label: "Revenue", color: "var(--info)" },
  costCents: { label: "Costs", color: "var(--warn)" },
  profitCents: { label: "Profit", color: "var(--ok)" },
} satisfies ChartConfig;

/** Revenue, costs and profit over time. The line is the same money the cards above add up to. */
export function MoneyChart({ series, className }: { series: Point[]; className?: string }) {
  const fmt = useFmt();
  const data = series.map((p) => ({ ...p, label: p.from === p.to ? fmt.date(p.from) : `${fmt.date(p.from)} to ${fmt.date(p.to)}` }));
  return (
    <ChartContainer config={config} className={cn("h-64 w-full", className)}>
      <ComposedChart data={data} margin={{ left: 4, right: 8, top: 8 }}>
        <CartesianGrid vertical={false} />
        <XAxis dataKey="from" tickFormatter={(v: string) => fmt.date(v).replace(/,? \d{4}$/, "")} tickLine={false} axisLine={false} minTickGap={24} />
        <YAxis tickFormatter={(v: number) => fmt.moneyShort(v)} width={64} tickLine={false} axisLine={false} />
        <ChartTooltip content={<ChartTooltipContent labelFormatter={(_: unknown, items: readonly { payload?: { label?: string } }[]) => items?.[0]?.payload?.label ?? ""} formatter={(v: unknown, name: unknown) => <span className="flex w-full justify-between gap-4"><span>{config[name as keyof typeof config]?.label ?? String(name)}</span><span className="font-mono tabular-nums">{fmt.money(Number(v))}</span></span>} />} />
        <Area dataKey="revenueCents" type="monotone" stroke="var(--color-revenueCents)" fill="var(--color-revenueCents)" fillOpacity={0.12} strokeWidth={2} />
        <Line dataKey="costCents" type="monotone" stroke="var(--color-costCents)" strokeWidth={2} dot={false} />
        <Line dataKey="profitCents" type="monotone" stroke="var(--color-profitCents)" strokeWidth={2} strokeDasharray="4 3" dot={false} />
      </ComposedChart>
    </ChartContainer>
  );
}

/** Horizontal bars with the number next to each, for splits and rankings. The numbers are always printed, so colour is never the only signal. */
export function Bars({ rows, format, tone = "info" }: { rows: { label: string; value: number; note?: string }[]; format: (n: number) => string; tone?: "info" | "ok" | "warn" | "danger" }) {
  const max = Math.max(1, ...rows.map((r) => Math.abs(r.value)));
  return (
    <ul className="space-y-2 text-sm">
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex justify-between gap-2"><span className="truncate">{r.label}{r.note && <span className="text-muted-foreground"> {r.note}</span>}</span><span className="tabular-nums">{format(r.value)}</span></div>
          <div className="mt-1 h-1.5 rounded-full bg-muted"><div className="h-full rounded-full" style={{ width: `${Math.max(2, (Math.abs(r.value) / max) * 100)}%`, background: r.value < 0 ? "var(--danger)" : `var(--${tone})` }} /></div>
        </li>
      ))}
    </ul>
  );
}
