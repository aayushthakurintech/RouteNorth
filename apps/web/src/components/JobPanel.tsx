"use client";
import { Paperclip, Plus } from "lucide-react";
import { useRef, useState, type FormEvent } from "react";
import type { MessageKey } from "@routenorth/shared";
import { CommentsPanel } from "@/components/CommentsPanel";
import { CustomFieldsPanel } from "@/components/CustomFieldsPanel";
import { ProofGallery } from "@/components/ProofGallery";
import { Chip, ErrorState, Modal, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { downscaleImage } from "@/lib/image";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { API_URL, loadSession } from "@/lib/session";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface JobDetail {
  job: Record<string, any> & { id: string };
  events: { id: string; at: string; kind: string; detail: Record<string, any> | null; actor: string | null }[];
  attachments: { id: string; name: string }[];
  stop: { id: string; status: string; eta: string | null; arrivedAt: string | null; departedAt: string | null; failureReason: string | null; recipientName: string | null; proofCount: number } | null;
}

const NEXT: Record<string, string[]> = {
  assigned: ["started", "arrived", "done", "failed"], started: ["arrived", "done", "failed"], arrived: ["done", "failed"],
};
const CANCEL = ["customer_cancelled", "duplicate", "address_invalid", "no_capacity", "weather", "vehicle_issue", "other"];
const RESCHED = ["customer_request", "not_ready", "no_capacity", "weather", "vehicle_issue", "access_problem", "other"];
const FAIL = ["not_home", "refused", "wrong_address", "access_denied", "damaged", "no_time", "other"];
const tone = (s: string) => (s === "done" ? "ok" : s === "failed" || s === "cancelled" ? "danger" : s === "unassigned" ? "warn" : "info") as "ok" | "danger" | "warn" | "info";

/** The company's own status label for a job, offered only while the job is in the state the label belongs to. */
function JobLabel({ jobId, status, current, onChanged }: { jobId: string; status: string; current: string | null; onChanged: () => void }) {
  const { t, locale } = useI18n(); const { can } = useMe(); const { toast } = useToast();
  const list = useApi<{ key: string; label: string; labelFr: string | null; baseStatus: string; color: string; active: boolean }[]>("/platform/statuses");
  const options = (list.data ?? []).filter((s) => s.active && s.baseStatus === status);
  const shown = (list.data ?? []).find((s) => s.key === current);
  if (!shown && options.length === 0) return null;
  const name = (s: { label: string; labelFr: string | null }) => (locale === "fr" && s.labelFr ? s.labelFr : s.label);
  async function set(key: string) { try { await apiSend("PUT", `/platform/jobs/${jobId}/status`, { key: key || null }); onChanged(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  return (
    <div className="row">
      <strong>{t("cs_label")}</strong>
      {can("routes.write") ? <select aria-label={t("cs_label")} value={current ?? ""} onChange={(e) => void set(e.target.value)}><option value="">–</option>{options.map((s) => <option key={s.key} value={s.key}>{name(s)}</option>)}{shown && !options.some((o) => o.key === shown.key) && <option value={shown.key}>{name(shown)}</option>}</select> : shown && <Chip>{name(shown)}</Chip>}
    </div>
  );
}

/** Everything about one job: status flow, cancel and reschedule with reasons, files, history, delivery proof. */
export function JobPanel({ jobId, onClose, onChanged }: { jobId: string; onClose: () => void; onChanged: () => void }) {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const { toast } = useToast();
  const d = useApi<JobDetail>(`/jobs/${jobId}`);
  const [mode, setMode] = useState<null | "cancel" | "reschedule" | "fail">(null);
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [date, setDate] = useState("");
  const file = useRef<HTMLInputElement>(null);
  const dispatch = can("routes.dispatch");
  const job = d.data?.job;

  async function act(path: string, body: Record<string, unknown>) {
    try {
      await apiSend("POST", `/jobs/${jobId}/${path}`, body);
      toast(t("rSaved"));
      setMode(null); setReason(""); setNote("");
      d.reload(); onChanged();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function openFile(id: string) {
    const res = await fetch(`${API_URL}/attachments/${id}`, { headers: { Authorization: `Bearer ${loadSession()?.token}` } });
    if (res.ok) window.open(URL.createObjectURL(await res.blob()), "_blank", "noopener");
  }
  async function upload(f: File) {
    const body = f.type.startsWith("image/") ? await downscaleImage(f) : f;
    const res = await fetch(`${API_URL}/jobs/${jobId}/attachments?name=${encodeURIComponent(f.name)}`, { method: "PUT", headers: { Authorization: `Bearer ${loadSession()?.token}`, "content-type": body.type || f.type }, body });
    if (res.ok) { toast(t("rUploaded")); d.reload(); } else toast(t("saveFailed"), { tone: "error" });
  }
  const when = (iso: string) => new Date(iso).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" });
  const eventText = (e: JobDetail["events"][number]) => {
    const det = e.detail ?? {};
    const parts = [t(`jobEvent_${e.kind}` as MessageKey)];
    if (det.status) parts.push(t(`v_${det.status}` as MessageKey));
    if (det.reasonCode) parts.push(t(`why_${det.reasonCode}` as MessageKey));
    if (det.note) parts.push(`“${det.note}”`);
    return parts.join(" · ");
  };

  function submit(e: FormEvent) {
    e.preventDefault();
    if (mode === "cancel") void act("cancel", { reasonCode: reason, note });
    if (mode === "fail") void act("status", { status: "failed", reasonCode: reason, note });
    if (mode === "reschedule") void act("reschedule", { date, reasonCode: reason, note });
  }

  return (
    <Modal open onClose={onClose} title={job?.title ?? t("navJobs")}>
      {d.error && !d.loaded && <ErrorState error={d.error} onRetry={d.reload} />}
      {!d.loaded && !d.error && <SkeletonList rows={4} />}
      {job && d.data && (
        <div className="stack">
          <div className="row">
            <Chip tone={tone(job.status)}>{t(`v_${job.status}` as MessageKey)}</Chip>
            <Chip tone={job.priority === "urgent" ? "danger" : undefined}>{t(`v_${job.priority}` as MessageKey)}</Chip>
            <Chip>{t(`v_${job.type}` as MessageKey)}</Chip>
            {(job.tags as string[]).map((x) => <Chip key={x} tone="brand">{x}</Chip>)}
          </div>
          <dl className="detail" style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "2px 12px", margin: 0 }}>
            {job.customer_name && <><dt>{t("f_customerName")}</dt><dd>{job.customer_name}{job.customer_phone ? ` · ${job.customer_phone}` : ""}</dd></>}
            {job.address && <><dt>{t("f_address")}</dt><dd>{job.address}</dd></>}
            {job.scheduled_date && <><dt>{t("f_scheduledDate")}</dt><dd>{job.scheduled_date}</dd></>}
            {(job.window_start || job.window_end) && <><dt>{t("jobWindow")}</dt><dd>{job.window_start ? when(job.window_start) : "…"} – {job.window_end ? when(job.window_end) : "…"}</dd></>}
            {Number(job.weight_kg) > 0 && <><dt>{t("f_weightKg")}</dt><dd>{job.weight_kg}</dd></>}
            {job.reason_code && <><dt>{t("f_reasonCode")}</dt><dd>{t(`why_${job.reason_code}` as MessageKey)}{job.reason_note ? ` · ${job.reason_note}` : ""}</dd></>}
            {d.data.stop?.eta && job.status !== "done" && <><dt>{t("eta")}</dt><dd>{when(d.data.stop.eta)}</dd></>}
            {job.notes && <><dt>{t("f_notes")}</dt><dd>{job.notes}</dd></>}
          </dl>

          {dispatch && !mode && (
            <div className="row">
              {(NEXT[job.status] ?? []).map((s) => (
                <button key={s} type="button" className={`btn sm ${s === "failed" ? "alt" : ""}`} onClick={() => (s === "failed" ? setMode("fail") : void act("status", { status: s }))}>{t(`v_${s}` as MessageKey)}</button>
              ))}
              {!["done", "cancelled"].includes(job.status) && <button type="button" className="btn sm alt" onClick={() => setMode("reschedule")}>{t("jobReschedule")}</button>}
              {!["done", "cancelled"].includes(job.status) && <button type="button" className="btn sm danger outline" onClick={() => setMode("cancel")}>{t("jobCancel")}</button>}
              {job.status === "assigned" && <button type="button" className="btn sm ghost" onClick={() => void act("assign", { driverId: null })}>{t("jobUnassign")}</button>}
              {["failed", "cancelled"].includes(job.status) && <button type="button" className="btn sm" onClick={() => void act("status", { status: "unassigned" })}>{t("jobReopen")}</button>}
            </div>
          )}

          {mode && (
            <form className="stack" onSubmit={submit} style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10 }}>
              <strong>{mode === "cancel" ? t("jobCancel") : mode === "fail" ? t("v_failed") : t("jobReschedule")}</strong>
              {mode === "reschedule" && <label className="field">{t("f_scheduledDate")}<input type="date" required value={date} onChange={(e) => setDate(e.target.value)} /></label>}
              <label className="field">{t("f_reasonCode")}
                <select required value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="">{t("rChoose")}</option>
                  {(mode === "cancel" ? CANCEL : mode === "fail" ? FAIL : RESCHED).map((r) => <option key={r} value={r}>{t(`why_${r}` as MessageKey)}</option>)}
                </select>
              </label>
              <label className="field">{t("f_notes")}<input maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
              <div className="row"><button type="button" className="btn alt sm" onClick={() => setMode(null)}>{t("cancel")}</button><button type="submit" className="btn sm">{t("confirm")}</button></div>
            </form>
          )}

          <JobLabel jobId={jobId} status={job.status} current={job.custom_status ?? null} onChanged={() => { d.reload(); onChanged(); }} />
          <CustomFieldsPanel entity="job" recordId={jobId} />
          <CommentsPanel entity="job" entityId={jobId} />

          {d.data.stop && ["done", "failed"].includes(d.data.stop.status) && d.data.stop.proofCount > 0 && <ProofGallery stopId={d.data.stop.id} label={t("proofs")} />}
          {d.data.stop?.recipientName && <p className="meta">{t("receivedBy")}: {d.data.stop.recipientName}</p>}

          <div className="stack" style={{ gap: 6 }}>
            <strong>{t("rAttachments")}</strong>
            <div className="row">
              {d.data.attachments.map((a) => <button key={a.id} type="button" className="btn sm alt" onClick={() => openFile(a.id)}><Paperclip size={14} aria-hidden />{a.name}</button>)}
              {can("routes.write") && <button type="button" className="btn sm ghost" onClick={() => file.current?.click()}><Plus size={14} aria-hidden />{t("rAddFile")}</button>}
              <input ref={file} type="file" accept="image/*,application/pdf" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void upload(f); e.target.value = ""; }} />
            </div>
          </div>

          <div className="stack" style={{ gap: 4 }}>
            <strong>{t("jobHistory")}</strong>
            <ul className="cards">
              {d.data.events.map((e) => <li key={e.id}><span className="static"><span>{eventText(e)}</span><span className="meta">{when(e.at)}{e.actor ? ` · ${e.actor}` : ""}</span></span></li>)}
            </ul>
          </div>
        </div>
      )}
    </Modal>
  );
}
