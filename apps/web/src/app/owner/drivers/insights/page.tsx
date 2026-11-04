"use client";
import { Trophy } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { PageHeader, StatCard, StatusBadge } from "@/components/portal/parts";
import { Async } from "@/components/portal/states";
import { apiSend } from "@/lib/api";
import { useBreadcrumbs } from "@/lib/breadcrumbs";
import { useMe } from "@/lib/me-context";
import { useApi } from "@/lib/use-api";

interface Settings { weights: Record<string, number>; requiredSteps: string[]; hours: { region: string; overtimeWeeklyHours: number; maxDailyHours: number; maxWeeklyHours: number; minRestHours: number }; leaderboard: boolean; scoreFloor: number }
const WEIGHT_LABELS: Record<string, string> = { onTime: "On-time rate", safety: "Safety", rating: "Customer rating", acceptance: "Acceptance", cleanliness: "Cleanliness" };

/** Leaderboard, company-wide compliance, and the rules behind driver scores and hours. */
export default function DriverInsights() {
  useBreadcrumbs([{ label: "Drivers", href: "/owner/drivers" }, { label: "Scores and rules" }]);
  const { can } = useMe();
  const lb = useApi<{ enabled: boolean; windowDays?: number; rows: { rank: number; id: string; name: string; score: number; rating: number | null; onTimePct: number | null; tripsMonth: number }[] }>("/portal/drivers/leaderboard");
  const comp = useApi<{ companyScore: number | null; formula: string; drivers: { id: string; name: string; score: number; expired: number; expiring: number; blockedReasons: string[] }[] }>("/portal/drivers/compliance");
  const st = useApi<Settings>("/portal/drivers/settings");
  const canEdit = can("settings.manage", "drivers.manage");
  const [draft, setDraft] = useState<Settings | null>(null);
  useEffect(() => { if (st.data) setDraft(st.data); }, [st.data]);
  const sum = draft ? Object.values(draft.weights).reduce((a, x) => a + Number(x), 0) : 0;

  async function save(patch: Partial<Settings>) {
    try { await apiSend("PUT", "/portal/drivers/settings", patch); toast.success("Saved"); st.reload(); lb.reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not save"); }
  }
  return (
    <>
      <PageHeader title="Scores and rules" description="The leaderboard, company compliance, and the formulas and limits behind driver numbers." actions={<Button asChild variant="outline" size="sm"><Link href="/owner/drivers">All drivers</Link></Button>} />
      <div className="grid gap-4 lg:grid-cols-2">
        <Card><CardHeader className="flex-row items-center justify-between"><CardTitle className="flex items-center gap-2 text-base"><Trophy className="size-4" /> Leaderboard</CardTitle>
          {canEdit && st.data && <div className="flex items-center gap-2"><Label htmlFor="lb" className="text-sm font-normal">Show leaderboard</Label><Switch id="lb" checked={st.data.leaderboard} onCheckedChange={(v) => void save({ leaderboard: v })} /></div>}</CardHeader>
          <CardContent><Async state={lb}>{() => !lb.data!.enabled ? <p className="text-sm text-muted-foreground">The leaderboard is switched off. Turn it on to rank drivers by score over the last 30 days. A driver can ask to be left out.</p> : (
            <ol className="space-y-1 text-sm">{lb.data!.rows.map((r) => <li key={r.id} className="flex items-center justify-between border-b py-1"><span><span className="mr-2 inline-block w-5 text-muted-foreground">{r.rank}</span><Link href={`/owner/drivers/${r.id}`} className="hover:underline">{r.name}</Link></span><span className="tabular-nums">{r.score} <span className="text-xs text-muted-foreground">· {r.tripsMonth} trips</span></span></li>)}{!lb.data!.rows.length && <li className="text-muted-foreground">No scored drivers yet.</li>}</ol>)}</Async></CardContent></Card>

        <Card><CardHeader><CardTitle className="text-base">Company compliance</CardTitle></CardHeader><CardContent className="space-y-3"><Async state={comp}>{() => (
          <>
            <StatCard label="Company compliance score" value={comp.data!.companyScore == null ? "—" : `${comp.data!.companyScore}/100`} hint={comp.data!.formula} />
            <ul className="space-y-1 text-sm">{comp.data!.drivers.filter((d) => d.score < 100).slice(0, 8).map((d) => <li key={d.id} className="flex items-center justify-between border-b py-1"><Link href={`/owner/drivers/${d.id}`} className="hover:underline">{d.name}</Link><span className="flex items-center gap-2">{d.expired > 0 && <StatusBadge tone="bad">{d.expired} expired</StatusBadge>}{d.expiring > 0 && <StatusBadge tone="warn">{d.expiring} expiring</StatusBadge>}<span className="tabular-nums">{d.score}</span></span></li>)}</ul>
          </>)}</Async></CardContent></Card>

        <Card className="lg:col-span-2"><CardHeader><CardTitle className="text-base">Driver score weights</CardTitle></CardHeader><CardContent className="space-y-3">
          <Async state={st}>{() => draft && (
            <>
              <p className="text-sm text-muted-foreground">Changes apply to all driver scores straight away. The weights must add up to 100.</p>
              <div className="grid gap-3 sm:grid-cols-5">{Object.keys(WEIGHT_LABELS).map((k) => <div key={k}><Label htmlFor={`w-${k}`} className="text-xs">{WEIGHT_LABELS[k]} (%)</Label><Input id={`w-${k}`} type="number" min={0} max={100} value={draft.weights[k] ?? 0} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, weights: { ...draft.weights, [k]: Number(e.target.value) } })} /></div>)}</div>
              <div className="flex items-center gap-3"><span className={`text-sm ${sum === 100 ? "text-muted-foreground" : "text-destructive"}`}>Total: {sum}</span>{canEdit && <Button size="sm" disabled={sum !== 100} onClick={() => void save({ weights: draft.weights })}>Save weights</Button>}</div>
              <h3 className="pt-2 text-sm font-semibold">Hours rules ({draft.hours.region})</h3>
              <p className="text-xs text-muted-foreground">Starting points based on Ontario overtime and the federal commercial hours-of-service limits. Check them against your own situation. Hours come from shifts started in the driver app. This is not a certified ELD.</p>
              <div className="grid gap-3 sm:grid-cols-4">{([["overtimeWeeklyHours", "Overtime after (h/week)"], ["maxDailyHours", "Longest day (h)"], ["maxWeeklyHours", "Longest 7 days (h)"], ["minRestHours", "Rest between shifts (h)"]] as const).map(([k, l]) => <div key={k}><Label htmlFor={`h-${k}`} className="text-xs">{l}</Label><Input id={`h-${k}`} type="number" value={draft.hours[k]} disabled={!canEdit} onChange={(e) => setDraft({ ...draft, hours: { ...draft.hours, [k]: Number(e.target.value) } })} /></div>)}</div>
              {canEdit && <Button size="sm" variant="outline" onClick={() => void save({ hours: draft.hours } as never)}>Save hours rules</Button>}
              <h3 className="pt-2 text-sm font-semibold">Onboarding steps that must be approved before a driver gets jobs</h3>
              <div className="flex flex-wrap gap-4">{[["personal_details", "Personal details"], ["license", "Licence upload"], ["background_check", "Background check"], ["vehicle_training", "Vehicle training"], ["contract", "Contract signed"], ["bank_details", "Bank details"], ["test_trip", "First test trip"]].map(([k, l]) => (
                <div key={k} className="flex items-center gap-2"><Checkbox id={`s-${k}`} disabled={!canEdit} checked={draft.requiredSteps.includes(k!)} onCheckedChange={(c) => setDraft({ ...draft, requiredSteps: c === true ? [...draft.requiredSteps, k!] : draft.requiredSteps.filter((x) => x !== k) })} /><Label htmlFor={`s-${k}`} className="font-normal">{l}</Label></div>))}</div>
              {canEdit && <Button size="sm" variant="outline" onClick={() => void save({ requiredSteps: draft.requiredSteps })}>Save required steps</Button>}
            </>)}</Async></CardContent></Card>
      </div>
    </>
  );
}
