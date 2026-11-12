"use client";
import { CalendarDays } from "lucide-react";
import { useState } from "react";
import type { DateRange } from "react-day-picker";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { presetRange, useOwnerRange, type RangePreset } from "./range-context";
import { useFmt } from "@/lib/portal/format";

const PRESETS: { id: Exclude<RangePreset, "custom">; label: string }[] = [
  { id: "today", label: "Today" }, { id: "7d", label: "Last 7 days" }, { id: "30d", label: "Last 30 days" }, { id: "month", label: "This month" },
  { id: "last_month", label: "Last month" }, { id: "quarter", label: "This quarter" }, { id: "ytd", label: "Year to date" },
];
const toDate = (s: string) => new Date(`${s}T12:00:00`);
const pad = (n: number) => String(n).padStart(2, "0");
const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Date range (Calendar + Popover) and the "compare to last period" switch. */
export function DateRangePicker() {
  const { range, setRange, compare, setCompare } = useOwnerRange();
  const fmt = useFmt();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<DateRange | undefined>(undefined);
  const label = PRESETS.find((p) => p.id === range.preset)?.label ?? `${fmt.date(range.from)} – ${fmt.date(range.to)}`;
  return (
    <Popover open={open} onOpenChange={(o) => { setOpen(o); if (o) setDraft({ from: toDate(range.from), to: toDate(range.to) }); }}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2" aria-label="Date range">
          <CalendarDays className="size-4" /> <span className="hidden sm:inline">{label}</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <div className="flex flex-col sm:flex-row">
          <div className="flex flex-row gap-1 overflow-x-auto border-b p-2 sm:w-40 sm:flex-col sm:border-b-0 sm:border-r">
            {PRESETS.map((p) => (
              <Button key={p.id} variant={range.preset === p.id ? "secondary" : "ghost"} size="sm" className="justify-start whitespace-nowrap" onClick={() => { setRange(presetRange(p.id)); setOpen(false); }}>
                {p.label}
              </Button>
            ))}
          </div>
          <div className="p-2">
            <Calendar mode="range" numberOfMonths={1} selected={draft} onSelect={setDraft} defaultMonth={draft?.from} />
            <div className="flex items-center justify-between gap-3 border-t p-2">
              <div className="flex items-center gap-2">
                <Switch id="cmp" checked={compare} onCheckedChange={setCompare} />
                <Label htmlFor="cmp" className="text-sm">Compare to last period</Label>
              </div>
              <Button size="sm" disabled={!draft?.from} onClick={() => { if (draft?.from) { setRange({ from: ymd(draft.from), to: ymd(draft.to ?? draft.from), preset: "custom" }); setOpen(false); } }}>Apply</Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}
