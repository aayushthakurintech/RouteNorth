"use client";
import { ArrowRight, Check, Circle, FileSpreadsheet, MinusCircle, Radio, Smartphone } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Async } from "@/components/portal/states";
import { PageHeader, StatusBadge } from "@/components/portal/parts";
import { cn } from "@/lib/utils";
import { STATE_LABEL, STATE_TONE, type Result } from "@/lib/portal/data-sources";
import { useApi } from "@/lib/use-api";

interface Step { title: string; detail: string; href?: string; cta?: string; /** true = done, false = not yet, null = cannot be checked from here */ done: boolean | null }
interface Path { id: string; title: string; blurb: string; icon: typeof Radio; steps: (d: Result) => Step[] }

const sourceState = (d: Result, id: string) => d.sources.find((s) => s.id === id)?.state ?? "not_connected";

const PATHS: Path[] = [
  { id: "trackers", title: "I have GPS trackers", blurb: "Best for trucks and buses. Positions arrive on their own once the tracker is registered.", icon: Radio,
    steps: (d) => [
      { title: "Add your vehicles", detail: "One at a time, or import a CSV from the vehicles page.", href: "/owner/vehicles", cta: "Open vehicles", done: d.totals.vehicles > 0 },
      { title: "Register each tracker", detail: "Enter the tracker's ID (its IMEI) and choose its vehicle. A tracker nobody registered is counted and ignored, so nothing from another company can land here.", href: "/devices", cta: "Open trackers", done: sourceState(d, "trackers") !== "not_connected" },
      { title: "Point the tracker at your Traccar server", detail: "This happens on the tracker and on the server, not in this app. The exact settings are in the go-live guide (docs/GO_LIVE.md in the repository).", done: null },
      { title: "Watch it go live", detail: "The first position shows on the live map within a minute or two. This page turns green when it arrives.", href: "/owner/settings/data-sources", cta: "Check data sources", done: sourceState(d, "trackers") === "live" },
    ] },
  { id: "phones", title: "I only have drivers' phones", blurb: "No hardware. Drivers share their position from the driver app while a shift or route is on.", icon: Smartphone,
    steps: (d) => [
      { title: "Add your vehicles", detail: "So each driver's work is tied to a car, truck or bus.", href: "/owner/vehicles", cta: "Open vehicles", done: d.totals.vehicles > 0 },
      { title: "Invite your drivers", detail: "Each driver gets an invite link and signs up. Emailing the link needs email set up on the server; text-message invites are not sent yet.", href: "/owner/drivers", cta: "Open drivers", done: d.totals.drivers > 0 },
      { title: "A driver starts a shift in the app", detail: "The driver app works in the phone's browser and keeps working offline. Positions are only shared while the app is open.", done: sourceState(d, "driver-app") !== "not_connected" },
      { title: "Check it arrived", detail: "Shifts show here once a driver has started one.", href: "/owner/settings/data-sources", cta: "Check data sources", done: sourceState(d, "driver-app") === "live" },
    ] },
  { id: "files", title: "I have spreadsheets", blurb: "Bring in what you already track. Every import shows what is wrong, row by row, before anything is saved.", icon: FileSpreadsheet,
    steps: (d) => [
      { title: "Import your vehicles", detail: "Save the sheet as CSV. You will see a check-and-fix step first.", href: "/owner/vehicles", cta: "Import vehicles", done: d.totals.vehicles > 0 },
      { title: "Import your drivers", detail: "Name, email and phone, from a CSV file.", href: "/owner/drivers", cta: "Import drivers", done: d.totals.drivers > 0 },
      { title: "Import stops or orders", detail: "Jobs and stops from CSV, with errors listed by row.", href: "/import", cta: "Open the import wizard", done: sourceState(d, "files") === "live" || d.totals.orders > 0 },
      { title: "Import fuel statements", detail: "Optional. Fuel-card statements in CSV feed fuel cost and fuel economy.", href: "/fuel", cta: "Open fuel", done: null },
    ] },
];

const KEY = "rn.start.path";

/** First run: pick how data will arrive, then follow a short checklist that ticks itself off as data shows up. */
export default function StartPage() {
  const state = useApi<Result>("/portal/data-sources", { intervalMs: 30_000 });
  const [picked, setPicked] = useState<string | null>(null);
  useEffect(() => { try { setPicked(localStorage.getItem(KEY)); } catch { /* storage can be blocked */ } }, []);
  const pick = (id: string) => { setPicked(id); try { localStorage.setItem(KEY, id); } catch { /* ignore */ } };
  return (
    <>
      <PageHeader title="Get your fleet's data in" description="Choose how your data will arrive. You can do all three; each has a short checklist that ticks itself off."
        actions={<Button asChild size="sm" variant="outline"><Link href="/owner/settings/data-sources">All data sources</Link></Button>} />
      <Async state={state}>
        {(d) => {
          const path = PATHS.find((p) => p.id === picked) ?? null;
          const steps = path?.steps(d) ?? [];
          const checkable = steps.filter((s) => s.done !== null);
          const done = checkable.filter((s) => s.done).length;
          return (
            <div className="space-y-6">
              <div className="grid gap-3 md:grid-cols-3" role="radiogroup" aria-label="How will your data arrive?">
                {PATHS.map((p) => {
                  const total = p.steps(d).filter((s) => s.done !== null);
                  const n = total.filter((s) => s.done).length;
                  return (
                    <button key={p.id} type="button" role="radio" aria-checked={picked === p.id} onClick={() => pick(p.id)}
                      className={cn("flex flex-col items-start gap-2 rounded-xl border p-4 text-left transition-colors hover:bg-accent focus-visible:outline-2", picked === p.id && "border-primary bg-primary/5")}>
                      <p.icon className="size-6 text-primary" aria-hidden />
                      <span className="font-medium">{p.title}</span>
                      <span className="text-sm text-muted-foreground">{p.blurb}</span>
                      <span className="mt-1 text-xs text-muted-foreground">{n} of {total.length} steps done</span>
                    </button>
                  );
                })}
              </div>
              {!path && <p className="text-sm text-muted-foreground">Pick one above to see its steps.</p>}
              {path && (
                <Card>
                  <CardHeader>
                    <CardTitle>{path.title}</CardTitle>
                    <CardDescription>{done} of {checkable.length} steps done{steps.some((s) => s.done === null) ? "; steps marked with a dash cannot be checked from here" : ""}.</CardDescription>
                  </CardHeader>
                  <CardContent>
                    <ol className="space-y-4">
                      {steps.map((s, i) => (
                        <li key={i} className="flex gap-3">
                          {s.done === true ? <Check className="mt-0.5 size-5 shrink-0 text-ok" aria-label="Done" /> : s.done === null ? <MinusCircle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-label="Cannot be checked from here" /> : <Circle className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-label="Not done yet" />}
                          <div className="min-w-0 flex-1 space-y-1">
                            <p className={cn("font-medium", s.done === true && "text-muted-foreground line-through")}>{i + 1}. {s.title}</p>
                            <p className="text-sm text-muted-foreground">{s.detail}</p>
                            {s.href && <Button asChild size="sm" variant={s.done ? "ghost" : "outline"} className="mt-1"><Link href={s.href}>{s.cta} <ArrowRight /></Link></Button>}
                          </div>
                        </li>
                      ))}
                    </ol>
                  </CardContent>
                </Card>
              )}
              <Card>
                <CardHeader><CardTitle>Right now</CardTitle><CardDescription>What each source is doing. Full detail on the Data sources page.</CardDescription></CardHeader>
                <CardContent className="flex flex-wrap gap-2">
                  {d.sources.filter((s) => ["trackers", "driver-app", "files", "email"].includes(s.id)).map((s) => <StatusBadge key={s.id} tone={STATE_TONE[s.state]}>{s.name}: {STATE_LABEL[s.state]}</StatusBadge>)}
                </CardContent>
              </Card>
            </div>
          );
        }}
      </Async>
    </>
  );
}
