"use client";
import type { MessageKey } from "@routenorth/shared";
import { Download } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { PublicShell } from "@/components/public/PublicShell";
import { EmptyState, ErrorState, Chip, SkeletonList, Tabs } from "@/components/ui/primitives";
import { apiDownload, apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { saveSession } from "@/lib/session";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Order { ref: string | null; title: string; status: string; type: string; address: string | null; date: string | null; windowStart: string | null; windowEnd: string | null; price: number | null; invoice: string | null; track: string }
interface Invoice { id: string; number: string; status: string; issuedOn: string; dueOn: string; currency: string; total: number }
interface Msg { id: string; from: string; body: string; at: string }

/** Where a signed-in customer sees their orders and invoices and writes to the company. */
export default function PortalPage() {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const router = useRouter();
  const [tab, setTab] = useState("orders");
  const orders = useApi<{ name: string; orders: Order[] }>("/portal/orders");
  const invoices = useApi<Invoice[]>(tab === "invoices" ? "/portal/invoices" : null);
  const chat = useApi<Msg[]>(tab === "support" ? "/portal/support" : null, { intervalMs: 20_000 });
  const [text, setText] = useState("");
  const money = (v: number, c: string) => new Intl.NumberFormat(locale, { style: "currency", currency: c }).format(v);
  const dt = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso));

  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    try { await apiSend("POST", "/portal/support", { body: text.trim() }); setText(""); chat.reload(); toast(t("pt_sent")); } catch (er) { toast((er as Error).message, { tone: "error" }); }
  }
  return (
    <PublicShell org={null} wide>
      <div className="row">
        <h1 className="grow">{orders.data ? t("pt_hello", { name: orders.data.name }) : t("pt_title")}</h1>
        <button className="btn" onClick={() => { saveSession(null); router.replace("/login"); }}>{t("signOut")}</button>
      </div>
      <Tabs label={t("pt_title")} value={tab} onChange={setTab} tabs={[{ id: "orders", label: t("pt_orders") }, { id: "invoices", label: t("pt_invoices") }, { id: "support", label: t("pt_support") }]} />
      {tab === "orders" && (orders.error ? <ErrorState error={orders.error} onRetry={orders.reload} /> : !orders.loaded ? <SkeletonList rows={3} h={72} /> : (orders.data?.orders ?? []).length === 0 ? <EmptyState title={t("pt_noOrders")} body={t("pt_noOrdersBody")} /> : (
        <ul className="plainlist">{orders.data!.orders.map((o, i) => (
          <li key={i} className="pub-card">
            <div className="row"><strong className="grow">{o.title}</strong><Chip tone={o.status === "done" ? "ok" : o.status === "failed" || o.status === "cancelled" ? "danger" : "info"}>{t(`cj_s_${o.status}` as MessageKey)}</Chip></div>
            <div className="meta small">{[o.ref, o.date, o.address].filter(Boolean).join(" · ")}</div>
            <div className="row"><Link className="btn" href={o.track}>{t("pt_trackOrder")}</Link>{o.invoice && <span className="meta small">{t("pt_invoice", { number: o.invoice })}</span>}</div>
          </li>))}
        </ul>
      ))}
      {tab === "invoices" && (invoices.error ? <ErrorState error={invoices.error} onRetry={invoices.reload} /> : !invoices.loaded ? <SkeletonList rows={3} h={52} /> : (invoices.data ?? []).length === 0 ? <EmptyState title={t("pt_noInvoices")} /> : (
        <div className="pub-card" style={{ overflowX: "auto" }}>
          <table className="ptable"><caption className="sr-only">{t("pt_invoices")}</caption>
            <thead><tr><th scope="col">{t("f_number")}</th><th scope="col">{t("iv_issued")}</th><th scope="col">{t("iv_due")}</th><th scope="col" className="tnum">{t("total")}</th><th scope="col">{t("f_status")}</th><th scope="col"><span className="sr-only">{t("download")}</span></th></tr></thead>
            <tbody>{invoices.data!.map((i) => <tr key={i.id}><th scope="row">{i.number}</th><td>{i.issuedOn}</td><td>{i.dueOn}</td><td className="tnum">{money(i.total, i.currency)}</td><td>{t(`iv_s_${i.status}` as MessageKey)}</td><td><button className="icon-btn" aria-label={t("iv_pdf")} onClick={() => void apiDownload(`/portal/invoices/${i.id}/pdf`, `${i.number}.pdf`).catch((e) => toast((e as Error).message, { tone: "error" }))}><Download size={15} /></button></td></tr>)}</tbody>
          </table>
        </div>
      ))}
      {tab === "support" && (
        <section className="pub-card">
          <h2>{t("pt_support")}</h2>
          <p className="meta">{t("pt_supportHelp")}</p>
          {(chat.data ?? []).length > 0 && <div className="pub-chat" aria-live="polite">{chat.data!.map((m) => <div key={m.id} className={`bubble${m.from === "customer" ? " me" : ""}`}>{m.body}<div className="small" style={{ opacity: 0.95 }}>{dt(m.at)}</div></div>)}</div>}
          <form className="row" onSubmit={send}><input className="grow" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} aria-label={t("cj_writeMessage")} placeholder={t("cj_writeMessage")} /><button className="btn primary" disabled={!text.trim()}>{t("ib_send")}</button></form>
        </section>
      )}
    </PublicShell>
  );
}
