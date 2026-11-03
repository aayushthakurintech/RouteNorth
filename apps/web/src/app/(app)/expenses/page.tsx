"use client";
import type { MessageKey } from "@routenorth/shared";
import { Download, Paperclip } from "lucide-react";
import { useState } from "react";
import { Chip, EmptyState, ErrorState, Kpi, Modal, PageHead, SkeletonList } from "@/components/ui/primitives";
import { apiDownload, apiGet, apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Expense { id: string; kind: string; amount: number; tax: number; currency: string; spentOn: string; vendor: string | null; note: string | null; status: string; litres: number | null; hasReceipt: boolean; driver: string; vehicle: string | null; decisionNote: string | null }
interface Data { items: Expense[]; totals: Record<string, number>; total: number }
const day = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** What drivers spent on the road: fuel, tolls, parking and more. Approved ones can be marked as paid back. */
export default function ExpensesPage() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const { toast } = useToast();
  const [from, setFrom] = useState(() => day(new Date(Date.now() - 30 * 86_400_000)));
  const [to, setTo] = useState(() => day(new Date()));
  const [status, setStatus] = useState("");
  const q = `from=${encodeURIComponent(new Date(`${from}T00:00:00`).toISOString())}&to=${encodeURIComponent(new Date(`${to}T23:59:59`).toISOString())}`;
  const data = useApi<Data>(`/expenses?${q}${status ? `&status=${status}` : ""}`);
  const [receipt, setReceipt] = useState<string | null>(null);
  const money = new Intl.NumberFormat(locale === "fr" ? "fr-CA" : "en-CA", { style: "currency", currency: "CAD" });

  async function show(id: string) { try { setReceipt((await apiGet<{ url: string }>(`/expenses/${id}/receipt`)).url); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function reimburse(id: string) { try { await apiSend("POST", `/expenses/${id}/reimburse`); data.reload(); toast(t("ex_reimbursed")); } catch (e) { toast((e as Error).message, { tone: "error" }); } }

  return (
    <div className="content">
      <PageHead title={t("navExpenses")} subtitle={t("ex_subtitle")} actions={can("reports.export") ? <button className="btn" onClick={() => void apiDownload(`/expenses/export.csv?${q}`, "expenses.csv").catch((e) => toast((e as Error).message, { tone: "error" }))}><Download size={15} /> CSV</button> : undefined} />
      <div className="row">
        <label className="field">{t("from")}<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">{t("to")}<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="field">{t("f_status")}<select value={status} onChange={(e) => setStatus(e.target.value)}><option value="">{t("all")}</option>{["submitted", "approved", "rejected", "reimbursed"].map((s) => <option key={s} value={s}>{t(`ex_s_${s}` as MessageKey)}</option>)}</select></label>
      </div>
      {data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : !data.loaded ? <SkeletonList rows={5} h={48} /> : (data.data?.items ?? []).length === 0 ? <EmptyState title={t("ex_empty")} body={t("ex_emptyBody")} /> : (
        <>
          <div className="kpi-row">
            <Kpi label={t("ex_total")} value={data.data!.total} format={(v) => money.format(v)} />
            {Object.entries(data.data!.totals).map(([k, v]) => <Kpi key={k} label={t(`ex_k_${k}` as MessageKey)} value={v} format={(n) => money.format(n)} />)}
          </div>
          <div className="card" style={{ overflowX: "auto" }}>
            <table className="ptable">
              <caption className="sr-only">{t("navExpenses")}</caption>
              <thead><tr><th scope="col">{t("date")}</th><th scope="col">{t("f_driver")}</th><th scope="col">{t("f_kind")}</th><th scope="col">{t("f_vendor")}</th><th scope="col" className="tnum">{t("ex_amount")}</th><th scope="col">{t("f_status")}</th><th scope="col"><span className="sr-only">{t("actions")}</span></th></tr></thead>
              <tbody>{data.data!.items.map((e) => (
                <tr key={e.id}>
                  <td>{e.spentOn}</td><th scope="row">{e.driver}</th><td>{t(`ex_k_${e.kind}` as MessageKey)}{e.litres ? ` · ${e.litres} L` : ""}</td><td>{e.vendor ?? "–"}</td>
                  <td className="tnum">{money.format(e.amount)}{e.tax > 0 && <span className="meta small"> ({t("ex_tax", { amount: money.format(e.tax) })})</span>}</td>
                  <td><Chip tone={e.status === "rejected" ? "danger" : e.status === "submitted" ? "warn" : "ok"}>{t(`ex_s_${e.status}` as MessageKey)}</Chip></td>
                  <td>
                    {e.hasReceipt && <button className="icon-btn" aria-label={t("ex_receipt")} onClick={() => void show(e.id)}><Paperclip size={15} /></button>}
                    {e.status === "approved" && can("reports.manage") && <button className="btn sm" onClick={() => void reimburse(e.id)}>{t("ex_markPaid")}</button>}
                  </td>
                </tr>))}</tbody>
            </table>
          </div>
          <p className="meta small">{t("ex_approveHint")}</p>
        </>
      )}
      <Modal open={!!receipt} onClose={() => setReceipt(null)} title={t("ex_receipt")}>{receipt && /* eslint-disable-next-line @next/next/no-img-element */ <img src={receipt} alt={t("ex_receipt")} style={{ maxWidth: "100%", maxHeight: "70vh" }} />}</Modal>
    </div>
  );
}
