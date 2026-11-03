"use client";
import type { MessageKey } from "@routenorth/shared";
import { Megaphone, Send } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Chip, EmptyState, ErrorState, Modal, PageHead, SkeletonList, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Thread { id: string; name: string | null; lastAt: string; unread: number; last: string | null }
interface Msg { id: string; from: "driver" | "customer" | "dispatch"; body: string; quickKey: string | null; audio: string | null; at: string }
interface Help { id: string; kind: string; note: string | null; status: "open" | "acknowledged" | "resolved"; createdAt: string; resolution: string | null; driver: string; job: string | null; phone: string | null; lat: number | null; lng: number | null }
interface Unread { drivers: number; customers: number; help: number }

/** One place for what drivers and customers send, and for calls for help. */
export default function InboxPage() {
  const { t } = useI18n();
  const { can } = useMe();
  const [tab, setTab] = useState(can("routes.dispatch") ? "driver" : "customer");
  const unread = useApi<Unread>("/messages/unread", { intervalMs: 20_000 });
  const tabs = [
    ...(can("routes.dispatch") ? [{ id: "driver", label: `${t("ib_drivers")}${unread.data?.drivers ? ` (${unread.data.drivers})` : ""}` }, { id: "help", label: `${t("ib_help")}${unread.data?.help ? ` (${unread.data.help})` : ""}` }] : []),
    ...(can("customers.manage") ? [{ id: "customer", label: `${t("ib_customers")}${unread.data?.customers ? ` (${unread.data.customers})` : ""}` }] : []),
  ];
  return (
    <div className="content">
      <PageHead title={t("navInbox")} subtitle={t("ib_subtitle")} />
      <Tabs label={t("navInbox")} value={tab} onChange={setTab} tabs={tabs} />
      {tab === "help" ? <HelpPanel onChange={unread.reload} /> : <Threads kind={tab as "driver" | "customer"} onChange={unread.reload} />}
    </div>
  );
}

function Threads({ kind, onChange }: { kind: "driver" | "customer"; onChange: () => void }) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const threads = useApi<Thread[]>(`/messages/threads?kind=${kind}`, { intervalMs: 15_000 });
  const [open, setOpen] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [bc, setBc] = useState(false);
  const [bcText, setBcText] = useState("");
  const msgs = useApi<Msg[]>(open ? `/messages/thread/${kind}/${open}` : null, { intervalMs: 8_000 });
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => { setOpen(null); }, [kind]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs.data?.length]);
  useEffect(() => { if (msgs.loaded) { onChange(); threads.reload(); } /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [msgs.loaded, open]);
  const when = (iso: string) => new Date(iso).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" });

  async function send() {
    if (!text.trim() || !open) return;
    try {
      const r = await apiSend<{ customer?: string[] }>("POST", `/messages/thread/${kind}/${open}`, { body: text.trim() });
      setText(""); msgs.reload();
      if (kind === "customer" && r.customer?.some((s) => s.endsWith("skipped"))) toast(t("ib_notEmailed"));
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function broadcast() {
    try { const r = await apiSend<{ sent: number }>("POST", "/messages/broadcast", { body: bcText.trim() }); toast(t("ib_sentTo", { n: r.sent })); setBc(false); setBcText(""); threads.reload(); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
  }

  return (
    <div className="split" style={{ display: "grid", gridTemplateColumns: "minmax(220px,320px) 1fr", gap: "var(--s4)", alignItems: "start" }}>
      <div>
        {kind === "driver" && <div className="row" style={{ marginBottom: "var(--s2)" }}><button className="btn" onClick={() => setBc(true)}><Megaphone size={15} /> {t("ib_broadcast")}</button></div>}
        {threads.error ? <ErrorState error={threads.error} onRetry={threads.reload} /> : !threads.loaded ? <SkeletonList rows={5} h={52} /> : (threads.data ?? []).length === 0 ? <EmptyState title={t("ib_empty")} body={t(kind === "driver" ? "ib_emptyDrivers" : "ib_emptyCustomers")} /> : (
          <ul className="plainlist">
            {threads.data!.map((th) => (
              <li key={th.id}>
                <button type="button" className="card" aria-pressed={open === th.id} onClick={() => setOpen(th.id)} style={{ width: "100%", textAlign: "left", padding: "var(--s3)", borderColor: open === th.id ? "var(--brand)" : undefined }}>
                  <div className="row"><strong className="grow">{th.name ?? t("ib_unknown")}</strong>{th.unread > 0 && <Chip tone="brand">{th.unread}</Chip>}</div>
                  <div className="meta small" style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{th.last}</div>
                  <div className="meta small">{when(th.lastAt)}</div>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
      <section className="card" style={{ padding: "var(--s4)", minHeight: 280 }} aria-label={t("ib_conversation")}>
        {!open ? <p className="meta">{t("ib_pick")}</p> : (
          <>
            <div style={{ display: "grid", gap: 8, maxHeight: "50vh", overflow: "auto" }} aria-live="polite">
              {(msgs.data ?? []).map((m) => (
                <div key={m.id} style={{ justifySelf: m.from === "dispatch" ? "end" : "start", maxWidth: "80%", background: m.from === "dispatch" ? "var(--brand)" : "var(--surface-2, #eef2f6)", color: m.from === "dispatch" ? "var(--brand-fg)" : "inherit", borderRadius: 12, padding: "8px 12px" }}>
                  {m.quickKey && !m.body ? t(`qr_${m.quickKey}` as MessageKey) : m.body}
                  {m.audio && <audio controls src={m.audio} style={{ display: "block", maxWidth: "100%" }} aria-label={t("ib_voice")} />}
                  <div className="small" style={{ opacity: 0.95 }}>{when(m.at)}</div>
                </div>
              ))}
              <div ref={end} />
            </div>
            <form className="row" style={{ marginTop: "var(--s3)" }} onSubmit={(e) => { e.preventDefault(); void send(); }}>
              <input className="grow" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} aria-label={t("ib_write")} placeholder={t("ib_write")} />
              <button className="btn primary" disabled={!text.trim()}><Send size={15} /> {t("ib_send")}</button>
            </form>
            {kind === "customer" && <p className="meta small">{t("ib_customerNote")}</p>}
          </>
        )}
      </section>
      <Modal open={bc} onClose={() => setBc(false)} title={t("ib_broadcast")} actions={<><button className="btn" onClick={() => setBc(false)}>{t("cancel")}</button><button className="btn primary" disabled={!bcText.trim()} onClick={() => void broadcast()}>{t("ib_send")}</button></>}>
        <label className="field">{t("ib_broadcastHelp")}<textarea rows={4} maxLength={1000} value={bcText} onChange={(e) => setBcText(e.target.value)} /></label>
      </Modal>
    </div>
  );
}

function HelpPanel({ onChange }: { onChange: () => void }) {
  const { t, locale } = useI18n();
  const { toast } = useToast();
  const [status, setStatus] = useState("");
  const list = useApi<Help[]>(`/help-requests${status ? `?status=${status}` : ""}`, { intervalMs: 15_000 });
  const [closing, setClosing] = useState<Help | null>(null);
  const [note, setNote] = useState("");
  async function act(h: Help, what: "acknowledge" | "resolve") {
    try { await apiSend("POST", `/help-requests/${h.id}/${what}`, what === "resolve" ? { resolution: note } : undefined); setClosing(null); setNote(""); list.reload(); onChange(); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  return (
    <>
      <div className="seg" role="group" aria-label={t("al_status")}>
        {["", "open", "acknowledged", "resolved"].map((s) => <button key={s} aria-pressed={status === s} onClick={() => setStatus(s)}>{s ? t(`hr_s_${s}` as MessageKey) : t("all")}</button>)}
      </div>
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.loaded ? <SkeletonList rows={3} h={64} /> : (list.data ?? []).length === 0 ? <EmptyState title={t("hr_empty")} body={t("hr_emptyBody")} /> : (
        <ul className="plainlist">
          {list.data!.map((h) => (
            <li key={h.id} className="card" style={{ padding: "var(--s3) var(--s4)" }}>
              <div className="row">
                <div className="grow">
                  <strong>{h.driver}</strong> · {t(`hk_${h.kind}` as MessageKey)} <Chip tone={h.status === "open" ? "danger" : h.status === "acknowledged" ? "warn" : "ok"}>{t(`hr_s_${h.status}` as MessageKey)}</Chip>
                  <div className="meta small">{new Date(h.createdAt).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" })}{h.job ? ` · ${h.job}` : ""}{h.phone ? ` · ${h.phone}` : ""}</div>
                  {h.note && <div>{h.note}</div>}
                  {h.lat != null && h.lng != null && <a className="small" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${h.lat}&mlon=${h.lng}#map=16/${h.lat}/${h.lng}`}>{t("hr_where")}</a>}
                  {h.resolution && <div className="meta small">{h.resolution}</div>}
                </div>
                {h.status === "open" && <button className="btn" onClick={() => void act(h, "acknowledge")}>{t("hr_onIt")}</button>}
                {h.status !== "resolved" && <button className="btn primary" onClick={() => setClosing(h)}>{t("al_resolve")}</button>}
              </div>
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!closing} onClose={() => setClosing(null)} title={t("hr_close")} actions={<><button className="btn" onClick={() => setClosing(null)}>{t("cancel")}</button><button className="btn primary" onClick={() => closing && void act(closing, "resolve")}>{t("al_resolve")}</button></>}>
        <label className="field">{t("hr_resolution")}<textarea rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} /></label>
      </Modal>
    </>
  );
}
