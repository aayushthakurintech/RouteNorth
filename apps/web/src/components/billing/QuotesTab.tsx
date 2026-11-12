"use client";
import type { MessageKey } from "@routenorth/shared";
import { useState } from "react";
import { LinesEditor } from "@/components/LinesEditor";
import { Chip, EmptyState, ErrorState, Modal, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { emptyLine, linesToBody, money, type LineDraft } from "@/lib/money";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Quote { id: string; number: string; customerName: string; status: string; issuedOn: string; validUntil: string | null; currency: string; subtotal: number; tax: number; total: number; invoiceId: string | null; expired: boolean }
interface Card { id: string; name: string; basis: string; active: boolean }
const TONE: Record<string, "ok" | "warn" | "danger" | "info" | undefined> = { draft: undefined, sent: "info", accepted: "ok", declined: "danger" };

/** The quote and invoice builder: pick a rate card or type the lines. */
export function QuotesTab({ newOpen, onClose }: { newOpen: boolean; onClose: () => void }) {
  const { t, locale } = useI18n(); const { toast } = useToast(); const { can } = useMe();
  const list = useApi<{ items: Quote[] }>("/billing/quotes");
  const cards = useApi<Card[]>(newOpen ? "/r/rate-cards" : null);
  const [kind, setKind] = useState<"quote" | "invoice">("quote");
  const [mode, setMode] = useState<"lines" | "card">("lines");
  const [f, setF] = useState({ customerName: "", customerEmail: "", notes: "", taxExempt: false, cardId: "", km: "", kg: "", minutes: "", zone: "" });
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()]);
  const [busy, setBusy] = useState(false);
  const canWrite = can("customers.manage");

  async function create() {
    setBusy(true);
    try {
      const base = { customerName: f.customerName, customerEmail: f.customerEmail || undefined, notes: f.notes || undefined, taxExempt: f.taxExempt };
      if (kind === "invoice") {
        const r = await apiSend<{ number: string }>("POST", "/invoices", { ...base, lines: linesToBody(lines) });
        toast(t("bl_invoiceMade", { n: r.number }));
      } else {
        const body = mode === "card" ? { ...base, rateCard: { id: f.cardId, km: f.km || undefined, kg: f.kg || undefined, minutes: f.minutes || undefined, zone: f.zone || undefined } } : { ...base, lines: linesToBody(lines) };
        const r = await apiSend<{ number: string }>("POST", "/billing/quotes", body);
        toast(t("bl_quoteMade", { n: r.number }));
        list.reload();
      }
      setLines([emptyLine()]); setF({ ...f, customerName: "", customerEmail: "", notes: "" }); onClose();
    } catch (e) { toast((e as Error).message, { tone: "error" }); } finally { setBusy(false); }
  }
  async function setStatus(id: string, status: string) { try { await apiSend("PATCH", `/billing/quotes/${id}`, { status }); list.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function convert(id: string) {
    try { const r = await apiSend<{ number: string }>("POST", `/billing/quotes/${id}/convert`); toast(t("bl_invoiceMade", { n: r.number })); list.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  const card = cards.data?.find((c) => c.id === f.cardId);
  return (
    <div className="stack">
      {list.error && !list.loaded && <ErrorState error={list.error} onRetry={list.reload} />}
      {!list.loaded && !list.error && <SkeletonList rows={4} />}
      {list.loaded && list.data!.items.length === 0 && <EmptyState title={t("bl_noQuotes")} body={t("bl_noQuotesBody")} />}
      {list.loaded && list.data!.items.length > 0 && (
        <table className="ptable"><thead><tr><th>{t("bl_number")}</th><th>{t("bl_customer")}</th><th>{t("bl_validUntil")}</th><th>{t("bl_total")}</th><th>{t("status")}</th><th><span className="sr-only">{t("actions")}</span></th></tr></thead><tbody>
          {list.data!.items.map((q) => (
            <tr key={q.id}>
              <td>{q.number}</td><td>{q.customerName}</td><td>{q.validUntil ?? "–"} {q.expired && <Chip tone="warn">{t("bl_expired")}</Chip>}</td><td>{money(q.total, q.currency, locale)}</td>
              <td><Chip tone={TONE[q.status]}>{t(`bl_qs_${q.status}` as MessageKey)}</Chip></td>
              <td>{canWrite && !q.invoiceId && <span className="row" style={{ gap: 4 }}>
                {q.status === "draft" && <button type="button" className="btn sm alt" onClick={() => setStatus(q.id, "sent")}>{t("bl_markSent")}</button>}
                {q.status === "sent" && <><button type="button" className="btn sm alt" onClick={() => setStatus(q.id, "accepted")}>{t("bl_accept")}</button><button type="button" className="btn sm ghost" onClick={() => setStatus(q.id, "declined")}>{t("bl_decline")}</button></>}
                {q.status !== "declined" && <button type="button" className="btn sm" onClick={() => convert(q.id)}>{t("bl_toInvoice")}</button>}
              </span>}{q.invoiceId && <a className="btn sm ghost" href="/invoices">{t("bl_seeInvoice")}</a>}</td>
            </tr>
          ))}
        </tbody></table>
      )}
      <Modal open={newOpen} onClose={onClose} title={t("bl_newDoc")}
        actions={<><button type="button" className="btn alt" onClick={onClose}>{t("cancel")}</button><button type="submit" form="doc-form" className="btn" disabled={busy}>{t("save")}</button></>}>
        <form id="doc-form" className="stack" onSubmit={(e) => { e.preventDefault(); void create(); }}>
          <div className="seg" role="group" aria-label={t("bl_docKind")}>
            <button type="button" aria-pressed={kind === "quote"} onClick={() => setKind("quote")}>{t("bl_quote")}</button>
            <button type="button" aria-pressed={kind === "invoice"} onClick={() => { setKind("invoice"); setMode("lines"); }}>{t("bl_invoice")}</button>
          </div>
          <label className="field"><span>{t("bl_customer")} *</span><input required maxLength={120} value={f.customerName} onChange={(e) => setF({ ...f, customerName: e.target.value })} /></label>
          <label className="field"><span>{t("bl_email")}</span><input type="email" maxLength={200} value={f.customerEmail} onChange={(e) => setF({ ...f, customerEmail: e.target.value })} /></label>
          {kind === "quote" && <div className="seg" role="group" aria-label={t("bl_priceFrom")}>
            <button type="button" aria-pressed={mode === "lines"} onClick={() => setMode("lines")}>{t("bl_typeLines")}</button>
            <button type="button" aria-pressed={mode === "card"} onClick={() => setMode("card")}>{t("bl_useCard")}</button>
          </div>}
          {mode === "lines" ? <LinesEditor lines={lines} onChange={setLines} currency="CAD" /> : (
            <div className="stack">
              <label className="field"><span>{t("bl_rateCard")} *</span>
                <select required value={f.cardId} onChange={(e) => setF({ ...f, cardId: e.target.value })}><option value="">{t("rChoose")}</option>{(cards.data ?? []).filter((c) => c.active).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
              {card?.basis === "distance" && <label className="field"><span>{t("bl_km")}</span><input type="number" min={0} step="any" value={f.km} onChange={(e) => setF({ ...f, km: e.target.value })} /></label>}
              {card?.basis === "weight" && <label className="field"><span>{t("bl_kg")}</span><input type="number" min={0} step="any" value={f.kg} onChange={(e) => setF({ ...f, kg: e.target.value })} /></label>}
              {card?.basis === "time" && <label className="field"><span>{t("bl_minutes")}</span><input type="number" min={0} step="any" value={f.minutes} onChange={(e) => setF({ ...f, minutes: e.target.value })} /></label>}
              {card?.basis === "zone" && <label className="field"><span>{t("bl_zone")}</span><input value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })} /></label>}
            </div>
          )}
          <label className="row" style={{ gap: 6 }}><input type="checkbox" checked={f.taxExempt} onChange={(e) => setF({ ...f, taxExempt: e.target.checked })} /> {t("bl_taxExempt")}</label>
          <label className="field"><span>{t("bl_notes")}</span><textarea rows={2} maxLength={1000} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
          <p className="meta small">{t("bl_taxNote")}</p>
        </form>
      </Modal>
    </div>
  );
}
