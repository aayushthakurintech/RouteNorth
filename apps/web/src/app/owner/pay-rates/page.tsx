"use client";
import { Check } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/portal/parts";
import { Async } from "@/components/portal/states";
import { apiSend } from "@/lib/api";
import { useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";
import { CardsTab, type Meta } from "./cards";
import { BonusesTab, DeductionsTab } from "./money";
import { PayoutsTab } from "./payouts";
import { SimulatorTab } from "./simulator";

interface Approvals { rateCards: { id: string; versionId: string; summary: string; requestedBy: string | null }[]; deductions: unknown[]; adjustments: unknown[]; payouts: unknown[] }

/** Pay rates: the three rates side by side (customer price, driver pay, car cost), bonuses, deductions and payouts. */
export default function PayRatesPage() {
  const meta = useApi<Meta>("/portal/pay/meta");
  const approvals = useApi<Approvals>("/portal/pay/approvals");
  const fmt = useFmt();
  const settings = useApi<Meta["settings"] & { holdOnExpiredDocs: boolean; holdOnOpenIncident: boolean }>("/portal/pay/settings");
  async function decide(versionId: string, ok: boolean) {
    try {
      if (ok) await apiSend("POST", `/portal/pay/versions/${versionId}/approve`);
      else { const note = window.prompt("Why is it sent back?"); if (!note) return; await apiSend("POST", `/portal/pay/versions/${versionId}/reject`, { note }); }
      toast.success(ok ? "Approved" : "Sent back"); approvals.reload();
    } catch (e) { toast.error(e instanceof Error ? e.message : "Could not do that"); }
  }
  return (
    <>
      <PageHeader title="Pay rates" description="What the customer pays, what the driver earns and what the car costs, side by side. Every change is dated, approved by a second person when it is big, and logged." />
      <Async state={meta}>{(m) => (
        <div className="space-y-4">
          {(approvals.data?.rateCards.length ?? 0) > 0 && (
            <Card className="border-warn/40"><CardContent className="space-y-2 pt-4 text-sm"><p className="font-medium">Waiting for a second person</p>
              {approvals.data!.rateCards.map((r) => <div key={r.id} className="flex flex-wrap items-center justify-between gap-2"><span>{r.summary} <span className="text-muted-foreground">(asked by {r.requestedBy ?? "someone"})</span></span>
                {m.canManage && <span className="flex gap-1"><Button size="sm" onClick={() => decide(r.versionId, true)}><Check className="size-4" /> Approve</Button><Button size="sm" variant="outline" onClick={() => decide(r.versionId, false)}>Send back</Button></span>}</div>)}</CardContent></Card>)}
          <Tabs defaultValue="cards" className="space-y-4">
            <TabsList className="h-auto flex-wrap justify-start">
              {[["cards", "Rate cards"], ["simulator", "Simulator and compare"], ["bonuses", "Bonuses"], ["deductions", "Deductions"], ["payouts", "Payouts"]].map(([k, l]) => <TabsTrigger key={k} value={k!}>{l}</TabsTrigger>)}
            </TabsList>
            <TabsContent value="cards"><CardsTab meta={m} onChange={approvals.reload} /></TabsContent>
            <TabsContent value="simulator"><SimulatorTab meta={m} /></TabsContent>
            <TabsContent value="bonuses"><BonusesTab meta={m} /></TabsContent>
            <TabsContent value="deductions"><DeductionsTab meta={m} onChange={approvals.reload} /></TabsContent>
            <TabsContent value="payouts"><PayoutsTab meta={m} /></TabsContent>
          </Tabs>
          {settings.data && <p className="text-xs text-muted-foreground">Second-person approval is {settings.data.secondApprover ? "on" : "off"}; deductions are capped at {settings.data.deductionCapPct}% of earnings per payout. {fmt.currency} is the company currency.</p>}
        </div>)}</Async>
    </>
  );
}
