"use client";
import { Lock, Pin, Search, Sparkles, Star, Wrench } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { PageHeader, StatusBadge } from "@/components/portal/parts";
import { Async } from "@/components/portal/states";
import { apiSend } from "@/lib/api";
import { useMe } from "@/lib/me-context";
import { useFmt } from "@/lib/portal/format";
import { useApi } from "@/lib/use-api";

interface Item { id: string; group: string; name: string; question: string; specChart: string; status: "full" | "partial"; note: string | null; available: boolean; fixedRange: boolean; favorite: boolean; pinned: boolean; lastOpenedAt: string | null }
interface Saved { id: string; name: string; dataset: string; shared: boolean; folder: string | null; mine: boolean; updatedAt: string; version: number; favorite: boolean; pinned: boolean; lastOpenedAt: string | null }
interface Cat { groups: { key: string; label: string }[]; reports: Item[]; saved: Saved[] }
interface Draft { found: boolean; message?: string; spec?: unknown; understood?: string[]; ignored?: string[]; note?: string }

function ReportCard({ r, onPref }: { r: Item; onPref: (id: string, p: { favorite?: boolean; pinned?: boolean }) => void }) {
  const body = (
    <div className="flex h-full flex-col gap-1 rounded-lg border p-3 transition-colors hover:border-primary">
      <div className="flex items-start justify-between gap-2"><span className="text-xs font-medium text-muted-foreground">{r.id}</span>
        {!r.available ? <span className="flex items-center gap-1 text-xs text-muted-foreground"><Lock className="size-3" /> Needs more access</span> : r.status === "partial" ? <StatusBadge tone="warn">Partly as in the spec</StatusBadge> : null}</div>
      <p className="font-medium">{r.name}</p>
      <p className="text-sm text-muted-foreground">{r.question}</p>
      <p className="mt-auto pt-1 text-xs text-muted-foreground">Chart: {r.specChart}</p>
    </div>
  );
  return (
    <li className="relative">
      {r.available ? <Link href={`/owner/reports/${r.id}`} className="block h-full">{body}</Link> : <div aria-disabled className="h-full opacity-60">{body}</div>}
      {r.available && <div className="absolute right-2 top-7 flex gap-0.5">
        <Button size="icon" variant="ghost" className="size-7" aria-label={r.favorite ? `Remove ${r.name} from favorites` : `Add ${r.name} to favorites`} aria-pressed={r.favorite} onClick={() => onPref(r.id, { favorite: !r.favorite })}><Star className={`size-4 ${r.favorite ? "fill-current text-warn" : ""}`} /></Button>
        <Button size="icon" variant="ghost" className="size-7" aria-label={r.pinned ? `Unpin ${r.name}` : `Pin ${r.name} to the dashboard`} aria-pressed={r.pinned} onClick={() => onPref(r.id, { pinned: !r.pinned })}><Pin className={`size-4 ${r.pinned ? "fill-current text-info" : ""}`} /></Button></div>}
    </li>
  );
}

/** The five an owner opens first: money, which cars lose money, drivers, what needs servicing, and whether trips are on time. */
const KEY_REPORTS = ["F1", "V2", "D2", "V6", "T2"];

/** Reports: 56 ready-made reports in 7 groups, favorites and recent, saved reports in folders, a builder, and a box to ask in plain words. */
export default function ReportsPage() {
  const fmt = useFmt(); const { can } = useMe(); const router = useRouter();
  const cat = useApi<Cat>("/portal/reports/catalog");
  const [q, setQ] = useState(""); const [ask, setAsk] = useState(""); const [draft, setDraft] = useState<Draft | null>(null); const [busy, setBusy] = useState(false); const [moving, setMoving] = useState<Saved | null>(null); const [folder, setFolder] = useState("");
  const match = (s: string) => !q.trim() || s.toLowerCase().includes(q.trim().toLowerCase());
  async function pref(id: string, p: { favorite?: boolean; pinned?: boolean }) { try { await apiSend("POST", "/portal/reports/prefs", { ref: id, ...p }); cat.reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not do that"); } }
  async function doAsk() {
    setBusy(true); setDraft(null);
    try { setDraft(await apiSend<Draft>("POST", "/portal/reports/ask", { text: ask })); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not make a draft"); } finally { setBusy(false); }
  }
  function openDraft() { try { sessionStorage.setItem("routenorth.builder.draft", JSON.stringify(draft!.spec)); } catch { /* the builder then starts empty */ } router.push("/owner/reports/builder?draft=1"); }
  async function moveTo() {
    try { await apiSend("PATCH", `/portal/reports/saved/${moving!.id}`, { folder: folder.trim() || null }); toast.success("Moved"); setMoving(null); cat.reload(); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not move it"); }
  }
  const view = useMemo(() => {
    const d = cat.data; if (!d) return null;
    const reports = d.reports.filter((r) => match(`${r.id} ${r.name} ${r.question}`));
    return {
      start: KEY_REPORTS.map((id) => d.reports.find((r) => r.id === id && r.available)).filter((r): r is Item => !!r),
      favorites: [...d.reports.filter((r) => r.favorite && r.available)],
      recent: [...d.reports.filter((r) => r.lastOpenedAt && r.available)].sort((a, b) => b.lastOpenedAt!.localeCompare(a.lastOpenedAt!)).slice(0, 4),
      byGroup: d.groups.map((g) => ({ ...g, items: reports.filter((r) => r.group === g.key) })).filter((g) => g.items.length),
      saved: d.saved.filter((s) => match(`${s.name} ${s.folder ?? ""}`)),
    };
  }, [cat.data, q]);
  const folders = [...new Set((view?.saved ?? []).map((s) => s.folder ?? ""))].sort((a, b) => (a === "" ? 1 : b === "" ? -1 : a.localeCompare(b)));
  return (
    <>
      <PageHeader title="Reports" description="56 ready-made reports. Every one has dates, filters, a chart and a table, compares with the period before, opens the rows behind each number, and exports to PDF, Excel and CSV."
        actions={can("reports.builder") || can("reports.manage") ? <Button asChild size="sm"><Link href="/owner/reports/builder"><Wrench className="size-4" /> Build a report</Link></Button> : undefined} />
      <div className="mb-4 grid gap-3 lg:grid-cols-2">
        <div className="relative"><Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" aria-hidden /><Input aria-label="Search reports" className="pl-9" placeholder="Search reports, such as fuel, profit or V2" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        {(can("reports.builder") || can("reports.manage")) && <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); if (ask.trim()) void doAsk(); }}>
          <Input aria-label="Ask for a report in plain words" placeholder="Ask in plain words: profit per car last quarter" value={ask} onChange={(e) => setAsk(e.target.value)} maxLength={300} />
          <Button type="submit" variant="outline" disabled={busy || !ask.trim()}><Sparkles className="size-4" /> Draft</Button></form>}
      </div>
      {draft && (
        <div className="mb-4 rounded-lg border p-3 text-sm" role="status">
          {!draft.found ? <p>{draft.message}</p> : <>
            <p className="font-medium">Here is what I understood</p>
            <ul className="ml-4 list-disc">{draft.understood!.map((u) => <li key={u}>{u}</li>)}{draft.ignored!.map((u) => <li key={u} className="text-warn">{u}</li>)}</ul>
            <p className="mt-1 text-xs text-muted-foreground">{draft.note}</p>
            <Button size="sm" className="mt-2" onClick={openDraft}>Open the draft in the builder</Button></>}
        </div>)}
      <Async state={cat}>{() => view && (
        <div className="space-y-6">
          {view.start.length > 0 && !q && <section aria-label="Start here"><h2 className="mb-1 text-sm font-semibold">Start here</h2><p className="mb-2 text-xs text-muted-foreground">The five most owners open first. The other reports are below, or ask for one in plain words.</p><ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">{view.start.map((r) => <ReportCard key={r.id} r={r} onPref={pref} />)}</ul></section>}
          {view.favorites.length > 0 && !q && <section aria-label="Favorites"><h2 className="mb-2 text-sm font-semibold">Favorites</h2><ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{view.favorites.map((r) => <ReportCard key={r.id} r={r} onPref={pref} />)}</ul></section>}
          {view.recent.length > 0 && !q && <section aria-label="Recent"><h2 className="mb-2 text-sm font-semibold">Recently opened</h2><ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">{view.recent.map((r) => <ReportCard key={r.id} r={r} onPref={pref} />)}</ul></section>}
          {view.saved.length > 0 && (
            <section aria-label="My and shared reports"><h2 className="mb-2 text-sm font-semibold">Saved reports</h2>
              {folders.map((f) => (
                <div key={f || "none"} className="mb-3"><h3 className="mb-1 text-xs font-medium text-muted-foreground">{f || "No folder"}</h3>
                  <ul className="divide-y rounded-lg border">{view.saved.filter((s) => (s.folder ?? "") === f).map((s) => (
                    <li key={s.id} className="flex flex-wrap items-center justify-between gap-2 p-2 text-sm">
                      <Link href={`/owner/reports/${s.id}`} className="font-medium hover:underline">{s.name}</Link>
                      <span className="flex items-center gap-2 text-xs text-muted-foreground">{s.shared ? "Shared with the team" : "Private"} · version {s.version} · {fmt.date(s.updatedAt)}
                        {s.mine && can("reports.manage") && <Button size="sm" variant="ghost" onClick={() => { setMoving(s); setFolder(s.folder ?? ""); }}>Folder</Button>}</span></li>))}</ul></div>))}
            </section>)}
          {view.byGroup.length === 0 && <p className="text-sm text-muted-foreground">No report matches "{q}". Try a shorter word, or open the builder to make your own.</p>}
          {view.byGroup.map((g) => <section key={g.key} aria-label={g.label}><h2 className="mb-2 text-sm font-semibold">{g.label}</h2><ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">{g.items.map((r) => <ReportCard key={r.id} r={r} onPref={pref} />)}</ul></section>)}
        </div>)}</Async>
      {moving && <Dialog open onOpenChange={(o) => !o && setMoving(null)}><DialogContent>
        <DialogHeader><DialogTitle>Put "{moving.name}" in a folder</DialogTitle><DialogDescription>Folders help the team find reports. Leave it empty to take the report out of its folder.</DialogDescription></DialogHeader>
        <Input aria-label="Folder name" value={folder} maxLength={60} onChange={(e) => setFolder(e.target.value)} placeholder="Finance team" /><DialogFooter><Button onClick={() => void moveTo()}>Save</Button></DialogFooter></DialogContent></Dialog>}
    </>
  );
}
