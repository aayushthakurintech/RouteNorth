"use client";
import { Pencil } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { toast } from "sonner";
import { PageHeader, StatusBadge } from "@/components/portal/parts";
import { Async } from "@/components/portal/states";
import { apiSend } from "@/lib/api";
import { useMe } from "@/lib/me-context";
import { useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";
import { centsToPlain, parseCents } from "@routenorth/shared";

interface Row { category: string; budgetCents: number | null; appliesTo: string | null; actualCents: number; usedPct: number | null; state: "none" | "ok" | "warning" | "over" }
const NAMES: Record<string, string> = { driver_pay: "Driver pay", fuel: "Fuel", maintenance: "Repairs and service", insurance: "Insurance", finance: "Loan and lease", tires: "Tires", fines: "Fines", other: "Other", total: "Everything" };
const TONE = { none: "neutral", ok: "good", warning: "warn", over: "bad" } as const;
const WORDS = { none: "No budget", ok: "On track", warning: "Close to the limit", over: "Over budget" } as const;

/** Budget: a monthly limit per cost type. Amber at 80% used, red at 100%. A number for one month beats the every-month number. */
export default function BudgetPage() {
  const fmt = useFmt(); const { can } = useMe(); const write = can("finance.manage");
  const now = new Date(); const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}`);
  const api = useApi<{ month: string; rows: Row[] }>(`/portal/finance/budget?month=${month}`);
  const [edit, setEdit] = useState<Row | null>(null); const [text, setText] = useState(""); const [scope, setScope] = useState("every"); const [busy, setBusy] = useState(false);
  const months = Array.from({ length: 13 }, (_, i) => { const d = new Date(now.getFullYear(), now.getMonth() - 6 + i, 1); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`; });
  async function save(clear: boolean) {
    if (!edit) return; setBusy(true);
    try {
      await apiSend("PUT", "/portal/finance/budget", { category: edit.category, month: scope === "month" ? month : null, amountCents: clear ? null : parseCents(text) });
      toast.success(clear ? "Budget removed" : "Budget saved"); setEdit(null); api.reload();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not save"); } finally { setBusy(false); }
  }
  return (
    <>
      <PageHeader title="Budget" description="Set a limit for each kind of cost and watch how much of it is used." actions={
        <Select value={month} onValueChange={setMonth}><SelectTrigger className="w-40" aria-label="Month"><SelectValue /></SelectTrigger><SelectContent>{months.map((m) => <SelectItem key={m} value={m}>{new Date(`${m}-01T12:00:00Z`).toLocaleString("en-CA", { month: "long", year: "numeric", timeZone: "UTC" })}</SelectItem>)}</SelectContent></Select>} />
      <Async state={api}>{(d) => (
        <ul className="space-y-3">{d.rows.map((r) => (
          <li key={r.category} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{NAMES[r.category] ?? r.category}</span>
              <span className="flex items-center gap-2 text-sm"><StatusBadge tone={TONE[r.state]}>{WORDS[r.state]}</StatusBadge>
                {write && <Button size="sm" variant="ghost" aria-label={`Set budget for ${NAMES[r.category]}`} onClick={() => { setEdit(r); setText(r.budgetCents ? centsToPlain(r.budgetCents) : ""); setScope(r.appliesTo === "this month" ? "month" : "every"); }}><Pencil className="size-4" /></Button>}</span>
            </div>
            <Progress className="my-2" value={Math.min(100, r.usedPct ?? 0)} aria-label={`${NAMES[r.category]} budget used`} />
            <p className="flex flex-wrap justify-between gap-2 text-sm text-muted-foreground"><span>{fmt.money(r.actualCents)} spent{r.budgetCents != null ? ` of ${fmt.money(r.budgetCents)}` : ""}{r.appliesTo ? ` (${r.appliesTo})` : ""}</span><span>{r.usedPct == null ? "" : `${fmt.pct(r.usedPct, 1)} used`}</span></p>
          </li>))}</ul>)}</Async>
      <Dialog open={!!edit} onOpenChange={(o) => !o && setEdit(null)}><DialogContent>
        <DialogHeader><DialogTitle>Budget for {edit ? NAMES[edit.category] : ""}</DialogTitle><DialogDescription>The most you want to spend in a month, in dollars.</DialogDescription></DialogHeader>
        <Input inputMode="decimal" aria-label="Monthly budget" value={text} onChange={(e) => setText(e.target.value)} placeholder="5000.00" />
        <Select value={scope} onValueChange={setScope}><SelectTrigger aria-label="Applies to"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="every">Every month</SelectItem><SelectItem value="month">Only {month}</SelectItem></SelectContent></Select>
        <DialogFooter>{edit?.budgetCents != null && <Button variant="outline" disabled={busy} onClick={() => void save(true)}>Remove</Button>}<Button disabled={busy || !text.trim()} onClick={() => void save(false)}>Save</Button></DialogFooter>
      </DialogContent></Dialog>
    </>
  );
}
