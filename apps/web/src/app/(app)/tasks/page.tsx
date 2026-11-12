"use client";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { Chip, EmptyState, ErrorState, Modal, PageHead, SkeletonList, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";
import type { MessageKey } from "@routenorth/shared";

interface Task { id: string; title: string; detail: string | null; status: string; priority: string; dueOn: string | null; assigneeId: string | null; assignee: string | null; overdue: boolean; comments: number }
interface Person { id: string; name: string }

export default function TasksPage() {
  const { t } = useI18n(); const { toast } = useToast(); const { can } = useMe();
  const [tab, setTab] = useState("open");
  const path = tab === "mine" ? "/tasks?mine=1" : tab === "done" ? "/tasks?status=done" : "/tasks";
  const tasks = useApi<Task[]>(can("routes.view") ? path : null);
  const people = useApi<Person[]>(can("routes.view") ? "/comments/people" : null);
  const [add, setAdd] = useState(false);
  const [f, setF] = useState({ title: "", detail: "", dueOn: "", assigneeId: "", priority: "normal" });
  const canWrite = can("routes.write");
  if (!can("routes.view")) return <div className="content"><ErrorState forbidden /></div>;
  const rows = (tasks.data ?? []).filter((x) => tab === "open" ? x.status !== "done" : true);
  async function create() {
    try { await apiSend("POST", "/tasks", { title: f.title, detail: f.detail || undefined, dueOn: f.dueOn || undefined, assigneeId: f.assigneeId || undefined, priority: f.priority }); setAdd(false); setF({ title: "", detail: "", dueOn: "", assigneeId: "", priority: "normal" }); tasks.reload(); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function toggle(x: Task) { try { await apiSend("PATCH", `/tasks/${x.id}`, { status: x.status === "done" ? "todo" : "done" }); tasks.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function remove(x: Task) { if (!window.confirm(t("tk_deleteAsk"))) return; try { await apiSend("DELETE", `/tasks/${x.id}`); tasks.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  return (
    <div className="content">
      <PageHead title={t("navTasks")} subtitle={t("tk_sub")} actions={canWrite ? <button type="button" className="btn" onClick={() => setAdd(true)}><Plus size={16} aria-hidden /> {t("tk_new")}</button> : undefined} />
      <Tabs label={t("navTasks")} value={tab} onChange={setTab} tabs={[{ id: "open", label: t("tk_open") }, { id: "mine", label: t("tk_mine") }, { id: "done", label: t("tk_done") }]} />
      {tasks.error && !tasks.loaded && <ErrorState error={tasks.error} onRetry={tasks.reload} />}
      {!tasks.loaded && !tasks.error && <SkeletonList rows={5} />}
      {tasks.loaded && rows.length === 0 && <EmptyState title={t("tk_none")} body={t("tk_noneBody")} />}
      {rows.length > 0 && (
        <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
          {rows.map((x) => (
            <li key={x.id} className="card" style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
              <input type="checkbox" aria-label={x.title} checked={x.status === "done"} disabled={!canWrite} onChange={() => toggle(x)} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ textDecoration: x.status === "done" ? "line-through" : undefined, fontWeight: 600 }}>{x.title}</div>
                {x.detail && <div className="meta small">{x.detail}</div>}
                <div className="row" style={{ gap: 6, marginTop: 4, flexWrap: "wrap" }}>
                  {x.priority === "high" && <Chip tone="danger">{t("tk_p_high")}</Chip>}
                  {x.dueOn && <Chip tone={x.overdue ? "warn" : undefined}>{x.overdue ? t("tk_overdue", { date: x.dueOn }) : t("tk_due", { date: x.dueOn })}</Chip>}
                  {x.assignee && <Chip tone="info">{x.assignee}</Chip>}
                  {x.status === "doing" && <Chip tone="brand">{t("tk_doing")}</Chip>}
                </div>
              </div>
              {canWrite && <button type="button" className="btn sm ghost" aria-label={`${t("rDelete")}: ${x.title}`} onClick={() => remove(x)}><Trash2 size={14} aria-hidden /></button>}
            </li>
          ))}
        </ul>
      )}
      <Modal open={add} onClose={() => setAdd(false)} title={t("tk_new")} actions={<><button type="button" className="btn alt" onClick={() => setAdd(false)}>{t("cancel")}</button><button type="submit" form="task-form" className="btn">{t("save")}</button></>}>
        <form id="task-form" className="stack" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <label className="field"><span>{t("f_title")} *</span><input required maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} /></label>
          <label className="field"><span>{t("tk_detail")}</span><textarea rows={2} maxLength={2000} value={f.detail} onChange={(e) => setF({ ...f, detail: e.target.value })} /></label>
          <label className="field"><span>{t("tk_dueOn")}</span><input type="date" value={f.dueOn} onChange={(e) => setF({ ...f, dueOn: e.target.value })} /></label>
          <label className="field"><span>{t("tk_assignee")}</span><select value={f.assigneeId} onChange={(e) => setF({ ...f, assigneeId: e.target.value })}><option value="">{t("rNone")}</option>{(people.data ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select></label>
          <label className="field"><span>{t("tk_priority")}</span><select value={f.priority} onChange={(e) => setF({ ...f, priority: e.target.value })}>{["low", "normal", "high"].map((p) => <option key={p} value={p}>{t(`tk_p_${p}` as MessageKey)}</option>)}</select></label>
        </form>
      </Modal>
    </div>
  );
}
