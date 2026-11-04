"use client";
import { CalendarClock, Download, Filter, History, Link2, Pin, Printer, Save, Star, X } from "lucide-react";
import { useParams, useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { PageHeader } from "@/components/portal/parts";
import { useOwnerRange } from "@/components/portal/range-context";
import { Comments, SaveDialog, ScheduleDialog, ShareDialog, VersionsDialog } from "@/components/portal/report-dialogs";
import type { RResult } from "@/components/portal/report-chart";
import { ReportView } from "@/components/portal/report-view";
import { ErrorState, LoadingState } from "@/components/portal/states";
import { apiDownloadPost, apiSend } from "@/lib/api";
import { useMe } from "@/lib/me-context";
import { useApi } from "@/lib/use-api";

interface Filter { key: string; op: "eq" | "ne" | "contains" | "in" | "gt" | "lt"; value: string | string[] }
interface Catalog { reports: { id: string; favorite: boolean; pinned: boolean }[]; saved: { id: string; favorite: boolean; pinned: boolean; mine: boolean; version: number }[] }
const OPS: [Filter["op"], string][] = [["eq", "is"], ["ne", "is not"], ["contains", "contains"], ["in", "is one of (comma between)"], ["gt", "is more than"], ["lt", "is less than"]];
const isUuid = (s: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(s);

/** One report: dates and compare from the top bar, group-by and filters here, a chart and table, rows behind every number, exports, sharing, schedules, history and comments. */
export default function ReportPage() {
  const params = useParams<{ id: string }>(); const id = decodeURIComponent(params.id); const router = useRouter();
  const { range } = useOwnerRange(); const { can } = useMe();
  const saved = isUuid(id);
  const [compare, setCompare] = useState<"none" | "prev" | "year">("none"); const [group, setGroup] = useState<string>(""); const [filters, setFilters] = useState<Filter[]>([]);
  const [draft, setDraft] = useState<Filter>({ key: "", op: "eq", value: "" });
  const [state, setState] = useState<{ data: RResult | null; error: Error | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0); const [dlg, setDlg] = useState<null | "share" | "schedule" | "versions" | "save">(null);
  const cat = useApi<Catalog>("/portal/reports/catalog", { });
  const body = useMemo(() => ({ id, from: range.from, to: range.to, compare: compare === "none" ? undefined : compare, groupBy: group || undefined, filters: filters.length ? filters.map((f) => ({ key: f.key, op: f.op, value: f.op === "in" ? String(f.value).split(",").map((x) => x.trim()).filter(Boolean) : f.op === "gt" || f.op === "lt" ? Number(f.value) : f.value })) : undefined }), [id, range.from, range.to, compare, group, filters]);
  useEffect(() => {
    let alive = true; setState((s) => ({ ...s, loading: true }));
    apiSend<RResult>("POST", "/portal/reports/run", body).then((d) => alive && setState({ data: d, error: null, loading: false })).catch((e) => alive && setState((s) => ({ data: s.data, error: e instanceof Error ? e : new Error(String(e)), loading: false })));
    return () => { alive = false; };
  }, [body, tick]);
  useEffect(() => { void apiSend("POST", `/portal/reports/open/${encodeURIComponent(id)}`).catch(() => {}); }, [id]);
  const d = state.data; const pref = (saved ? cat.data?.saved : cat.data?.reports)?.find((r) => r.id === id);
  const mine = saved ? cat.data?.saved.find((r) => r.id === id)?.mine : false;
  const setPref = useCallback(async (p: { favorite?: boolean; pinned?: boolean }) => { try { await apiSend("POST", "/portal/reports/prefs", { ref: id, ...p }); cat.reload(); toast.success(p.pinned ? "Pinned to your dashboard" : p.pinned === false ? "Unpinned" : p.favorite ? "Added to favorites" : "Removed from favorites"); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not do that"); } }, [id, cat]);
  async function download(format: "csv" | "xlsx" | "pdf") {
    try { await apiDownloadPost(`/portal/reports/export?format=${format}`, { ...body, compare: undefined, title: d?.name }, `${(d?.name ?? "report").replace(/[^\w.-]+/g, "-")}-${range.from}.${format}`); } catch (e) { toast.error(e instanceof Error ? e.message : "Could not export"); }
  }
  const textCols = (d?.columns ?? []).filter((c) => c.type === "text" || c.type === "date");
  const labelOf = (k: string) => d?.columns.find((c) => c.key === k)?.label ?? k;
  return (
    <>
      <PageHeader title={d?.name ?? "Report"} description={d?.meta?.question} crumbs={[{ label: "Reports", href: "/owner/reports" }, { label: d?.name ?? "Report" }]}
        actions={<>
          <Button size="sm" variant="outline" aria-pressed={!!pref?.favorite} onClick={() => void setPref({ favorite: !pref?.favorite })}><Star className={`size-4 ${pref?.favorite ? "fill-current" : ""}`} /> Favorite</Button>
          <Button size="sm" variant="outline" aria-pressed={!!pref?.pinned} onClick={() => void setPref({ pinned: !pref?.pinned })}><Pin className={`size-4 ${pref?.pinned ? "fill-current" : ""}`} /> Pin to dashboard</Button>
          {can("reports.export") && <DropdownMenu><DropdownMenuTrigger asChild><Button size="sm" variant="outline"><Download className="size-4" /> Export</Button></DropdownMenuTrigger><DropdownMenuContent align="end"><DropdownMenuItem onClick={() => void download("pdf")}>PDF (with logo and dates)</DropdownMenuItem><DropdownMenuItem onClick={() => void download("xlsx")}>Excel</DropdownMenuItem><DropdownMenuItem onClick={() => void download("csv")}>CSV</DropdownMenuItem></DropdownMenuContent></DropdownMenu>}
          <Button size="sm" variant="outline" onClick={() => window.print()}><Printer className="size-4" /> Print</Button>
          {can("reports.manage") && !saved && d && <Button size="sm" onClick={() => setDlg("save")}><Save className="size-4" /> Save as my report</Button>}
          {saved && can("reports.manage") && <><Button size="sm" variant="outline" onClick={() => setDlg("schedule")}><CalendarClock className="size-4" /> Schedule</Button><Button size="sm" variant="outline" onClick={() => setDlg("share")}><Link2 className="size-4" /> Share</Button><Button size="sm" variant="outline" onClick={() => setDlg("versions")}><History className="size-4" /> History</Button>
            {mine && <Button size="sm" variant="outline" onClick={() => router.push(`/owner/reports/builder?edit=${id}`)}>Edit</Button>}</>}
        </>} />
      <div className="mb-4 flex flex-wrap items-end gap-3 print:hidden">
        {!d?.meta?.fixedRange && <div><label className="mb-1 block text-xs text-muted-foreground" htmlFor="cmp">Compare with</label>
          <Select value={compare} onValueChange={(v) => setCompare(v as typeof compare)}><SelectTrigger id="cmp" className="w-52"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="none">Nothing</SelectItem><SelectItem value="prev">The period before</SelectItem><SelectItem value="year">Same dates last year</SelectItem></SelectContent></Select></div>}
        {d?.meta?.groupBy && <div><label className="mb-1 block text-xs text-muted-foreground" htmlFor="grp">Group by</label>
          <Select value={group || d.meta.groupBy[0]!} onValueChange={setGroup}><SelectTrigger id="grp" className="w-44"><SelectValue /></SelectTrigger><SelectContent>{d.meta.groupBy.map((g) => <SelectItem key={g} value={g}>{g}</SelectItem>)}</SelectContent></Select></div>}
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (draft.key && String(draft.value).trim()) { setFilters([...filters, draft]); setDraft({ key: "", op: "eq", value: "" }); } }}>
          <div><label className="mb-1 block text-xs text-muted-foreground" htmlFor="fk">Filter</label>
            <Select value={draft.key} onValueChange={(v) => setDraft({ ...draft, key: v })}><SelectTrigger id="fk" className="w-44"><SelectValue placeholder="Pick a column" /></SelectTrigger><SelectContent>{(d?.columns ?? []).map((c) => <SelectItem key={c.key} value={c.key}>{c.label}</SelectItem>)}</SelectContent></Select></div>
          <Select value={draft.op} onValueChange={(v) => setDraft({ ...draft, op: v as Filter["op"] })}><SelectTrigger className="w-48" aria-label="Filter rule"><SelectValue /></SelectTrigger><SelectContent>{OPS.map(([k, l]) => <SelectItem key={k} value={k}>{l}</SelectItem>)}</SelectContent></Select>
          <Input aria-label="Filter value" className="w-44" value={String(draft.value)} onChange={(e) => setDraft({ ...draft, value: e.target.value })} placeholder="Value" />
          <Button type="submit" size="sm" variant="outline" disabled={!draft.key}><Filter className="size-4" /> Add</Button>
        </form>
        {filters.map((f, i) => <Button key={i} size="sm" variant="secondary" onClick={() => setFilters(filters.filter((_, j) => j !== i))} aria-label={`Remove filter ${labelOf(f.key)}`}>{labelOf(f.key)} {OPS.find((o) => o[0] === f.op)![1].replace(" (comma between)", "")} {String(f.value)} <X className="size-3" /></Button>)}
        <span className="sr-only">{textCols.length} text columns</span>
      </div>
      {state.error && !d ? <ErrorState error={state.error} onRetry={() => setTick((n) => n + 1)} /> : !d ? <LoadingState /> : (
        <div className={state.loading ? "opacity-60 transition-opacity" : ""} aria-busy={state.loading}>
          {state.error && <ErrorState error={state.error} onRetry={() => setTick((n) => n + 1)} className="mb-3" />}
          <ReportView result={d} tableId={`report-${id}`} />
        </div>)}
      <div className="mt-6 print:hidden"><Comments reportRef={id} /></div>
      {dlg === "save" && d && <SaveDialog name={d.name} spec={{ ...d.spec, scope: undefined, range: { from: d.range.from, to: d.range.to } }} onClose={() => setDlg(null)} onSaved={(sid) => { setDlg(null); router.push(`/owner/reports/${sid}`); }} />}
      {dlg === "share" && <ShareDialog id={id} onClose={() => setDlg(null)} />}
      {dlg === "schedule" && <ScheduleDialog id={id} onClose={() => setDlg(null)} />}
      {dlg === "versions" && <VersionsDialog id={id} onClose={() => setDlg(null)} onRestored={() => setTick((n) => n + 1)} />}
    </>
  );
}
