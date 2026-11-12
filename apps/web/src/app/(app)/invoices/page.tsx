"use client";
import type { MessageKey } from "@routenorth/shared";
import { Download, FileText } from "lucide-react";
import { useState } from "react";
import { Chip, EmptyState, ErrorState, Kpi, PageHead, SkeletonList } from "@/components/ui/primitives";
import { apiDownload, apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Invoice { id: string; number: string; jobId: string | null; customerName: string | null; customerEmail: string | null; status: string; issuedOn: string; dueOn: string; currency: string; subtotal: number; tax: number; total: number; overdue: boolean }
interface Data { items: Invoice[]; totals: { outstanding: number; overdue: number; paid: number } }

/** Invoices made from delivered jobs. Mark them sent or paid, and download the PDF. */
export default function InvoicesPage() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const { toast } = useToast();
  const [status, setStatus] = useState("");
  const data = useApi<Data>(`/invoices${status ? `?status=${status}` : ""}`);
  const money = new Intl.NumberFormat(locale === "fr" ? "fr-CA" : "en-CA", { style: "currency", currency: "CAD" });
  const manage = can("customers.manage");
  async function set(id: string, to: string) { try { await apiSend("PATCH", `/invoices/${id}`, { status: to }); data.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }

  return (
    <div className="content">
      <PageHead title={t("navInvoices")} subtitle={t("iv_subtitle")} actions={can("reports.export") ? <button className="btn" onClick={() => void apiDownload("/invoices/export.csv", "invoices.csv").catch((e) => toast((e as Error).message, { tone: "error" }))}><Download size={15} /> CSV</button> : undefined} />
      <div className="seg" role="group" aria-label={t("f_status")}>
        {["", "draft", "sent", "paid", "void"].map((s) => <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>{s ? t(`iv_s_${s}` as MessageKey) : t("all")}</button>)}
      </div>
      {data.error ? <ErrorState error={data.error} onRetry={data.reload} /> : !data.loaded ? <SkeletonList rows={5} h={48} /> : (data.data?.items ?? []).length === 0 ? <EmptyState title={t("iv_empty")} body={t("iv_emptyBody")} /> : (
        <>
          <div className="kpi-row">
            <Kpi label={t("iv_outstanding")} value={data.data!.totals.outstanding} format={(v) => money.format(v)} />
            <Kpi label={t("iv_overdue")} value={data.data!.totals.overdue} format={(v) => money.format(v)} upIsGood={false} />
            <Kpi label={t("iv_paid")} value={data.data!.totals.paid} format={(v) => money.format(v)} />
          </div>
          <div className="card" style={{ overflowX: "auto" }}>
            <table className="ptable">
              <caption className="sr-only">{t("navInvoices")}</caption>
              <thead><tr><th scope="col">{t("f_number")}</th><th scope="col">{t("f_customer")}</th><th scope="col">{t("iv_issued")}</th><th scope="col">{t("iv_due")}</th><th scope="col" className="tnum">{t("total")}</th><th scope="col">{t("f_status")}</th><th scope="col"><span className="sr-only">{t("actions")}</span></th></tr></thead>
              <tbody>{data.data!.items.map((i) => (
                <tr key={i.id}>
                  <th scope="row">{i.number}</th><td>{i.customerName ?? i.customerEmail ?? "–"}</td><td>{i.issuedOn}</td><td>{i.dueOn}</td><td className="tnum">{money.format(i.total)}</td>
                  <td><Chip tone={i.status === "paid" ? "ok" : i.overdue ? "danger" : i.status === "void" ? undefined : "warn"}>{i.overdue ? t("iv_overdue") : t(`iv_s_${i.status}` as MessageKey)}</Chip></td>
                  <td>
                    <button className="icon-btn" aria-label={t("iv_pdf")} onClick={() => void apiDownload(`/invoices/${i.id}/pdf`, `${i.number}.pdf`).catch((e) => toast((e as Error).message, { tone: "error" }))}><FileText size={15} /></button>
                    {manage && i.status === "draft" && <button className="btn sm" onClick={() => void set(i.id, "sent")}>{t("iv_markSent")}</button>}
                    {manage && i.status === "sent" && <button className="btn sm" onClick={() => void set(i.id, "paid")}>{t("iv_markPaid")}</button>}
                    {manage && (i.status === "draft" || i.status === "sent") && <button className="btn sm ghost" onClick={() => window.confirm(t("iv_confirmVoid", { number: i.number })) && void set(i.id, "void")}>{t("iv_void")}</button>}
                  </td>
                </tr>))}</tbody>
            </table>
          </div>
          <p className="meta small">{t("iv_note")}</p>
        </>
      )}
    </div>
  );
}
