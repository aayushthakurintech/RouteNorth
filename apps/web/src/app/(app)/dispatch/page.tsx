"use client";
import { GripVertical, RefreshCw, Siren, Sparkles } from "lucide-react";
import { useState } from "react";
import type { MessageKey } from "@routenorth/shared";
import { JobPanel } from "@/components/JobPanel";
import { Chip, ErrorState, Modal, PageHead, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { formatTime, todayLocal } from "@/lib/format";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { STOP_COLORS } from "@/lib/routes";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface BoardStop { id: string; routeId: string; sequence: number; name: string; status: keyof typeof STOP_COLORS; jobId: string | null; eta: string | null; windowEnd: string | null; priority: string; weightKg: number }
interface BoardRoute { id: string; name: string; status: string; driverId: string | null; vehicleName: string | null; capacityKg: number | null; stops: BoardStop[] }
interface BoardJob { id: string; title: string; type: string; priority: string; address: string | null; weightKg: number; customerName: string | null; lat: number | null; tags: string[] }
interface Board { date: string; drivers: { id: string; name: string; skills: string[] | null }[]; routes: BoardRoute[]; unassigned: BoardJob[] }
interface Proposal { jobId: string; driverId: string; driverName: string }

const prioTone = (p: string) => (p === "urgent" ? "danger" : p === "high" ? "warn" : undefined) as "danger" | "warn" | undefined;

/** The dispatch board: unassigned jobs on the left, one lane per driver. Drag a job onto a lane (or use the menu) to assign it. */
export default function DispatchPage() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const { toast } = useToast();
  const [date, setDate] = useState(todayLocal());
  const board = useApi<Board>(`/jobs/board?date=${date}`, { intervalMs: 15_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [drag, setDrag] = useState<string | null>(null);
  const [over, setOver] = useState<string | null>(null);
  const [plan, setPlan] = useState<{ proposals: Proposal[]; unassigned: { jobId: string; reason: string }[] } | null>(null);
  const dispatch = can("routes.dispatch");

  async function assign(jobId: string, driverId: string | null, position?: number) {
    try {
      await apiSend("POST", `/jobs/${jobId}/assign`, { driverId, position });
      board.reload();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function urgent(jobId: string) {
    try {
      const r = await apiSend<{ addedMinutes: number; othersNowLate: number }>("POST", `/jobs/${jobId}/urgent`, {});
      toast(t("urgentPlaced", { min: r.addedMinutes, late: r.othersNowLate }));
      board.reload();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function suggest(apply: boolean) {
    try {
      const r = await apiSend<NonNullable<typeof plan> & { applied: boolean }>("POST", "/jobs/auto-assign", { date, apply });
      if (apply) { setPlan(null); toast(t("autoAssigned", { n: r.proposals.length })); board.reload(); } else setPlan(r);
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }

  const data = board.data;
  const jobTitle = (id: string) => data?.unassigned.find((j) => j.id === id)?.title ?? id.slice(0, 8);
  const laneRoutes = (driverId: string) => (data?.routes ?? []).filter((r) => r.driverId === driverId);
  const loose = (data?.routes ?? []).filter((r) => !r.driverId);

  const drop = (e: React.DragEvent, driverId: string, position?: number) => {
    e.preventDefault(); e.stopPropagation();
    const id = e.dataTransfer.getData("text/job") || drag;
    setDrag(null); setOver(null);
    if (id) void assign(id, driverId, position);
  };

  return (
    <div className="content">
      <PageHead
        title={t("navDispatch")}
        actions={<>
          <label className="field row" style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>{t("date")}<input type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} /></label>
          <button type="button" className="btn alt" onClick={board.reload}><RefreshCw size={16} aria-hidden />{t("refresh")}</button>
          {dispatch && <button type="button" className="btn" onClick={() => suggest(false)}><Sparkles size={16} aria-hidden />{t("autoAssign")}</button>}
        </>}
      />
      {!board.loaded && !board.error && <SkeletonList rows={5} h={60} />}
      {board.error && !board.loaded && <ErrorState error={board.error} onRetry={board.reload} />}
      {data && (
        <div className="dispatch" style={{ display: "grid", gridTemplateColumns: "minmax(240px, 300px) 1fr", gap: 16, alignItems: "start" }}>
          <section aria-label={t("unassignedJobs")} className="lane"
            onDragOver={(e) => { if (dispatch) { e.preventDefault(); setOver("unassigned"); } }} onDragLeave={() => setOver(null)}
            onDrop={(e) => { e.preventDefault(); const id = e.dataTransfer.getData("text/job"); setOver(null); if (id && dispatch) void assign(id, null); }}
            data-over={over === "unassigned"}>
            <h2 className="lane-title">{t("unassignedJobs")} <Chip tone={data.unassigned.length ? "warn" : "ok"}>{data.unassigned.length}</Chip></h2>
            {data.unassigned.length === 0 && <p className="meta">{t("allAssigned")}</p>}
            <ul className="cards">
              {data.unassigned.map((j) => (
                <li key={j.id} draggable={dispatch} onDragStart={(e) => { e.dataTransfer.setData("text/job", j.id); setDrag(j.id); }} onDragEnd={() => { setDrag(null); setOver(null); }} className="job-card" data-priority={j.priority}>
                  <div className="row" style={{ justifyContent: "space-between", flexWrap: "nowrap" }}>
                    <button type="button" className="linklike" onClick={() => setOpen(j.id)}><strong>{j.title}</strong></button>
                    {dispatch && <GripVertical size={14} aria-hidden style={{ color: "var(--muted)", flex: "none" }} />}
                  </div>
                  <div className="row"><Chip tone={prioTone(j.priority)}>{t(`v_${j.priority}` as MessageKey)}</Chip><Chip>{t(`v_${j.type}` as MessageKey)}</Chip>{j.lat == null && <Chip tone="danger">{t("noLocation")}</Chip>}</div>
                  <span className="meta">{j.address ?? j.customerName ?? ""}</span>
                  {dispatch && (
                    <div className="row">
                      <select aria-label={`${t("assignTo")}: ${j.title}`} value="" onChange={(e) => e.target.value && assign(j.id, e.target.value)} disabled={j.lat == null}>
                        <option value="">{t("assignTo")}…</option>
                        {data.drivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                      </select>
                      <button type="button" className="btn sm ghost" onClick={() => urgent(j.id)} disabled={j.lat == null} aria-label={`${t("rushJob")}: ${j.title}`} title={t("rushJob")}><Siren size={14} aria-hidden /></button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </section>

          <div className="lanes" style={{ display: "grid", gap: 12, gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))" }}>
            {data.drivers.length === 0 && <p className="meta">{t("noDriversYet")}</p>}
            {data.drivers.map((d) => {
              const routes = laneRoutes(d.id);
              const load = routes.reduce((a, r) => a + r.stops.reduce((s, x) => s + (x.weightKg || 0), 0), 0);
              const cap = routes.find((r) => r.capacityKg)?.capacityKg ?? null;
              return (
                <section key={d.id} aria-label={d.name} className="lane" data-over={over === d.id}
                  onDragOver={(e) => { if (dispatch) { e.preventDefault(); setOver(d.id); } }} onDragLeave={() => setOver(null)} onDrop={(e) => drop(e, d.id)}>
                  <h2 className="lane-title">{d.name}</h2>
                  <span className="meta">{routes.map((r) => r.vehicleName).filter(Boolean).join(", ") || t("noVehicle")}{load > 0 ? ` · ${Math.round(load)}${cap ? `/${cap}` : ""} kg` : ""}</span>
                  {cap && load > cap && <Chip tone="danger">{t("overCapacity")}</Chip>}
                  {routes.length === 0 && <p className="meta">{t("dropJobsHere")}</p>}
                  {routes.map((r) => (
                    <ol key={r.id} className="stoplist" aria-label={r.name}>
                      {r.stops.map((s, i) => (
                        <li key={s.id} draggable={dispatch && !!s.jobId && s.status === "pending"}
                          onDragStart={(e) => { if (s.jobId) { e.dataTransfer.setData("text/job", s.jobId); setDrag(s.jobId); } }} onDragEnd={() => { setDrag(null); setOver(null); }}
                          onDragOver={(e) => { if (dispatch) e.preventDefault(); }} onDrop={(e) => drop(e, d.id, i)}>
                          <div className="stop-head">
                            <span className="num" style={{ background: STOP_COLORS[s.status] }} aria-hidden>{s.sequence}</span>
                            {s.jobId ? <button type="button" className="linklike" onClick={() => setOpen(s.jobId)}>{s.name}</button> : <span>{s.name}</span>}
                            {s.priority === "urgent" && <Chip tone="danger">{t("v_urgent")}</Chip>}
                          </div>
                          <span className="meta">{t(`status_${s.status}` as MessageKey)}{s.eta && s.status === "pending" ? ` · ${t("eta")} ${formatTime(s.eta, locale)}` : ""}</span>
                        </li>
                      ))}
                    </ol>
                  ))}
                </section>
              );
            })}
            {loose.length > 0 && (
              <section className="lane" aria-label={t("routesNoDriver")}>
                <h2 className="lane-title">{t("routesNoDriver")}</h2>
                {loose.map((r) => <a key={r.id} className="meta" href={`/routes/${r.id}`}>{r.name} · {r.stops.length}</a>)}
              </section>
            )}
          </div>
        </div>
      )}

      <Modal open={!!plan} onClose={() => setPlan(null)} title={t("autoAssign")}
        actions={<><button type="button" className="btn alt" onClick={() => setPlan(null)}>{t("cancel")}</button>{plan && plan.proposals.length > 0 && <button type="button" className="btn" onClick={() => suggest(true)}>{t("applyPlan")}</button>}</>}>
        {plan && (plan.proposals.length === 0 && plan.unassigned.length === 0 ? <p>{t("allAssigned")}</p> : (
          <div className="stack">
            <ul className="cards">{plan.proposals.map((p) => <li key={p.jobId}><span className="static"><strong>{jobTitle(p.jobId)}</strong><span className="meta">→ {p.driverName}</span></span></li>)}</ul>
            {plan.unassigned.length > 0 && <>
              <strong>{t("couldNotAssign")}</strong>
              <ul className="cards">{plan.unassigned.map((u) => <li key={u.jobId}><span className="static">{jobTitle(u.jobId)}<span className="meta">{t(`unassignedWhy_${u.reason}` as MessageKey)}</span></span></li>)}</ul>
            </>}
          </div>
        ))}
      </Modal>
      {open && <JobPanel jobId={open} onClose={() => setOpen(null)} onChanged={board.reload} />}
    </div>
  );
}
