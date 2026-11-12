"use client";
import { CheckCircle2 } from "lucide-react";
import { useState } from "react";
import type { MessageKey } from "@routenorth/shared";
import ResourcePage from "@/components/ResourcePage";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Chip, EmptyState, ErrorState, Modal, PageHead, SkeletonList, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Reminder { type: "document" | "licence" | "maintenance" | "defect"; state: "overdue" | "due_soon"; title: string; subject: string; detail: string; refId: string; due: string | null; daysLeft: number | null; kmLeft?: number | null }
interface Remind { today: string; counts: { overdue: number; dueSoon: number }; items: Reminder[] }
interface Plan { id: string; vehicleId: string; vehicleName: string; task: string; everyDays: number | null; everyKm: number | null; lastDoneOn: string | null; odometerKm: number; state: "ok" | "due_soon" | "overdue"; dueOn: string | null; dueKm: number | null; daysLeft: number | null; kmLeft: number | null }

const tone = (s: string) => (s === "overdue" ? "danger" : s === "due_soon" ? "warn" : "ok") as "danger" | "warn" | "ok";

function Timing({ daysLeft, kmLeft }: { daysLeft: number | null; kmLeft?: number | null }) {
  const { t } = useI18n();
  const parts: string[] = [];
  if (daysLeft != null) parts.push(daysLeft < 0 ? t("care_daysOver", { n: -daysLeft }) : t("care_daysLeft", { n: daysLeft }));
  if (kmLeft != null) parts.push(kmLeft < 0 ? t("care_kmOver", { n: -kmLeft }) : t("care_kmLeft", { n: kmLeft }));
  return <>{parts.join(" · ") || "—"}</>;
}

function RemindersTab() {
  const { t } = useI18n();
  const data = useApi<Remind>("/fleet/reminders", { intervalMs: 60_000 });
  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.loaded || !data.data) return <SkeletonList rows={5} />;
  const { items, counts } = data.data;
  if (items.length === 0) return <EmptyState icon={<CheckCircle2 aria-hidden />} title={t("care_allClear")} body={t("care_hint")} />;
  const cols: Column<Reminder>[] = [
    { key: "state", header: t("f_status"), value: (r) => r.state, render: (r) => <Chip tone={tone(r.state)}>{t(r.state === "overdue" ? "care_overdue" : "care_dueSoon")}</Chip>, width: 120 },
    { key: "type", header: t("f_type"), value: (r) => r.type, render: (r) => t(`care_type_${r.type}` as MessageKey), width: 140 },
    { key: "subject", header: t("f_name"), value: (r) => r.subject, width: 180 },
    { key: "title", header: t("f_task"), value: (r) => r.title, render: (r) => `${r.title}${r.detail ? ` · ${r.detail}` : ""}`, width: 220 },
    { key: "due", header: t("care_due"), value: (r) => r.due, width: 120 },
    { key: "left", header: t("care_left"), value: (r) => r.daysLeft, render: (r) => <Timing daysLeft={r.daysLeft} kmLeft={r.kmLeft} />, width: 200 },
  ];
  return (
    <>
      <p className="meta" role="status">{t("care_summary", { overdue: counts.overdue, soon: counts.dueSoon })}</p>
      <DataTable tableId="care-reminders" columns={cols} rows={items} rowKey={(r) => `${r.type}-${r.refId}`} csvName="reminders" />
    </>
  );
}

function ScheduleTab() {
  const { t } = useI18n();
  const { can } = useMe();
  const { toast } = useToast();
  const data = useApi<Plan[]>("/fleet/maintenance");
  const [done, setDone] = useState<Plan | null>(null);
  const [form, setForm] = useState({ doneOn: "", odometerKm: "", cost: "", vendor: "", notes: "" });
  const canManage = can("fleet.manage");

  async function complete() {
    if (!done) return;
    try {
      await apiSend("POST", `/fleet/maintenance/${done.id}/complete`, {
        doneOn: form.doneOn || undefined, odometerKm: form.odometerKm || undefined, cost: form.cost || undefined, vendor: form.vendor || undefined, notes: form.notes || undefined,
      });
      toast(t("care_logged"));
      setDone(null);
      data.reload();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }

  if (data.error) return <ErrorState error={data.error} onRetry={data.reload} />;
  if (!data.loaded) return <SkeletonList rows={5} />;
  const cols: Column<Plan>[] = [
    { key: "state", header: t("f_status"), value: (p) => p.state, render: (p) => <Chip tone={tone(p.state)}>{t(p.state === "overdue" ? "care_overdue" : p.state === "due_soon" ? "care_dueSoon" : "care_ok")}</Chip>, width: 120 },
    { key: "vehicle", header: t("f_vehicleId"), value: (p) => p.vehicleName, width: 160 },
    { key: "task", header: t("f_task"), value: (p) => p.task, width: 200 },
    { key: "every", header: t("care_every"), value: (p) => p.everyDays ?? p.everyKm, render: (p) => [p.everyDays ? `${p.everyDays} d` : "", p.everyKm ? `${p.everyKm} km` : ""].filter(Boolean).join(" / "), width: 130 },
    { key: "last", header: t("f_lastDoneOn"), value: (p) => p.lastDoneOn, width: 120 },
    { key: "due", header: t("care_due"), value: (p) => p.dueOn, render: (p) => [p.dueOn, p.dueKm != null ? `${Math.round(p.dueKm)} km` : ""].filter(Boolean).join(" · ") || "—", width: 170 },
    { key: "left", header: t("care_left"), value: (p) => p.daysLeft ?? p.kmLeft, render: (p) => <Timing daysLeft={p.daysLeft} kmLeft={p.kmLeft} />, width: 190 },
    ...(canManage ? [{ key: "act", header: "", value: () => "", width: 120, render: (p: Plan) => <button type="button" className="btn sm" onClick={() => { setDone(p); setForm({ doneOn: "", odometerKm: String(p.odometerKm), cost: "", vendor: "", notes: "" }); }}>{t("care_markDone")}</button> }] : []),
  ];
  return (
    <>
      {data.data && data.data.length === 0 ? <EmptyState title={t("rEmpty")} body={t("care_scheduleHelp")} /> : <DataTable tableId="care-schedule" columns={cols} rows={data.data ?? []} rowKey={(p) => p.id} csvName="maintenance" />}
      <Modal open={!!done} onClose={() => setDone(null)} title={`${t("care_markDone")}: ${done?.task ?? ""}`}
        actions={<><button type="button" className="btn alt" onClick={() => setDone(null)}>{t("cancel")}</button><button type="submit" form="care-done" className="btn">{t("save")}</button></>}>
        <form id="care-done" className="stack" onSubmit={(e) => { e.preventDefault(); void complete(); }}>
          <label className="field">{t("f_doneOn")}<input type="date" value={form.doneOn} onChange={(e) => setForm({ ...form, doneOn: e.target.value })} /></label>
          <label className="field">{t("f_odometerKm")}<input type="number" min={0} value={form.odometerKm} onChange={(e) => setForm({ ...form, odometerKm: e.target.value })} /></label>
          <label className="field">{t("f_cost")}<input type="number" min={0} step="0.01" value={form.cost} onChange={(e) => setForm({ ...form, cost: e.target.value })} /></label>
          <label className="field">{t("f_vendor")}<input maxLength={120} value={form.vendor} onChange={(e) => setForm({ ...form, vendor: e.target.value })} /></label>
          <label className="field">{t("f_notes")}<textarea maxLength={1000} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
        </form>
      </Modal>
    </>
  );
}

/** Maintenance, documents and licences: what is due, what is overdue, and the records behind them. */
export default function CarePage() {
  const { t } = useI18n();
  const [tab, setTab] = useState("reminders");
  return (
    <div className="content stack">
      <PageHead title={t("navFleetCare")} subtitle={t("care_hint")} />
      <Tabs label={t("navFleetCare")} value={tab} onChange={setTab} tabs={[
        { id: "reminders", label: t("navReminders") }, { id: "schedule", label: t("res_maintenance-plans") },
        { id: "plans", label: t("care_editPlans") }, { id: "documents", label: t("res_documents") }, { id: "history", label: t("res_maintenance-logs") },
      ]} />
      {tab === "reminders" && <RemindersTab />}
      {tab === "schedule" && <ScheduleTab />}
      {tab === "plans" && <ResourcePage name="maintenance-plans" />}
      {tab === "documents" && <ResourcePage name="documents" />}
      {tab === "history" && <ResourcePage name="maintenance-logs" />}
    </div>
  );
}
