"use client";
import type { MessageKey } from "@routenorth/shared";
import { Check, X } from "lucide-react";
import { useState } from "react";
import { Chip, EmptyState, ErrorState, PageHead, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Approval {
  id: string; kind: string; title: string; detail: Record<string, unknown> | null; status: "pending" | "approved" | "rejected";
  decisionNote: string | null; createdAt: string; decidedAt: string | null; requestedBy: string | null; decidedBy: string | null;
}

/** Overtime, big expenses and anything a workflow asked about wait here for a yes or a no. */
export default function ApprovalsPage() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const { toast } = useToast();
  const [status, setStatus] = useState("pending");
  const [note, setNote] = useState<Record<string, string>>({});
  const list = useApi<Approval[]>(`/approvals?status=${status}`, { intervalMs: 30_000 });
  const manage = can("reports.manage");
  const when = (iso: string) => new Date(iso).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" });

  async function decide(id: string, decision: "approved" | "rejected") {
    try { await apiSend("POST", `/approvals/${id}/decide`, { decision, note: note[id] || undefined }); toast(t(decision === "approved" ? "ap_approvedToast" : "ap_rejectedToast")); list.reload(); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
  }

  return (
    <div className="content">
      <PageHead title={t("navApprovals")} subtitle={t("ap_subtitle")} />
      <div className="seg" role="group" aria-label={t("al_status")}>
        {["pending", "approved", "rejected"].map((s) => <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>{t(`ap_s_${s}` as MessageKey)}</button>)}
      </div>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.loaded ? <SkeletonList rows={4} h={64} /> : (list.data ?? []).length === 0 ? <EmptyState title={t("ap_empty")} body={t("ap_emptyBody")} /> : (
        <ul className="plainlist">
          {list.data!.map((a) => (
            <li key={a.id} className="card" style={{ padding: "var(--s3) var(--s4)" }}>
              <div className="row">
                <div className="grow">
                  <strong>{a.title}</strong> <Chip tone={a.status === "approved" ? "ok" : a.status === "rejected" ? "danger" : "warn"}>{t(`ap_s_${a.status}` as MessageKey)}</Chip>
                  <div className="meta small">{t(`ap_k_${a.kind}` as MessageKey)} · {a.requestedBy ?? t("ap_system")} · {when(a.createdAt)}{a.decidedBy ? ` · ${t("ap_decidedBy", { name: a.decidedBy })}` : ""}</div>
                  {a.decisionNote && <div className="small">{a.decisionNote}</div>}
                </div>
                {manage && a.status === "pending" && (
                  <>
                    <input aria-label={t("ap_note")} placeholder={t("ap_note")} maxLength={500} value={note[a.id] ?? ""} onChange={(e) => setNote({ ...note, [a.id]: e.target.value })} style={{ maxWidth: 220 }} />
                    <button className="btn primary" onClick={() => void decide(a.id, "approved")}><Check size={15} /> {t("ap_approve")}</button>
                    <button className="btn" onClick={() => void decide(a.id, "rejected")}><X size={15} /> {t("ap_reject")}</button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
