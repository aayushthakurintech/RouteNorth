"use client";
import type { MessageKey } from "@routenorth/shared";
import { ExternalLink, Plus, Trash2 } from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { ErrorState, PageHead, SkeletonList, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Slot { label: string; start: string; end: string }
interface Cfg {
  slug: string | null;
  settings: {
    customerNotify: { enabled: boolean; minutesAway: number; stopsAway: number; events: Record<string, boolean> };
    customerPortal: { showDriver: boolean; allowReschedule: boolean; allowCancel: boolean; allowInstructions: boolean; allowReturns: boolean; cutoffMin: number; horizonDays: number; slotCapacity: number; slots: Slot[] };
    booking: { enabled: boolean; baseFee: number; perKm: number; perKg: number; rushPct: number; minimum: number; requirePhone: boolean };
    approvals: { expenseLimit: number; overtimeNeedsApproval: boolean };
    publicStatus: boolean;
  };
}
interface OrgRaw { slug?: string | null; settings: Record<string, any> }

const EVENTS = ["received", "scheduled", "on_the_way", "minutes_away", "stops_away", "arrived", "delivered", "failed", "rescheduled", "cancelled"];
const DEFAULT_SLOTS: Slot[] = [{ label: "Morning", start: "08:00", end: "12:00" }, { label: "Afternoon", start: "12:00", end: "16:00" }, { label: "Evening", start: "16:00", end: "20:00" }];

/** Everything about what customers see: messages, their page, the booking form, status and help pages. */
export default function CustomerSettingsPage() {
  const { t } = useI18n();
  const { can } = useMe();
  const [tab, setTab] = useState("messages");
  if (!can("settings.manage")) return <div className="content"><ErrorState forbidden /></div>;
  return (
    <div className="content">
      <PageHead title={t("navCustomerSettings")} subtitle={t("cx_subtitle")} />
      <Tabs label={t("navCustomerSettings")} value={tab} onChange={setTab} tabs={[
        { id: "messages", label: t("cx_messages") }, { id: "wording", label: t("cx_wording") }, { id: "page", label: t("cx_page") }, { id: "booking", label: t("cx_booking") }, { id: "content", label: t("cx_content") }, { id: "rules", label: t("cx_rules") },
      ]} />
      {tab === "wording" ? <Wording /> : tab === "content" ? <Content /> : <Options tab={tab} />}
    </div>
  );
}

function Options({ tab }: { tab: string }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const org = useApi<OrgRaw>("/org");
  const [form, setForm] = useState<Cfg["settings"] | null>(null);
  const [slug, setSlug] = useState("");
  useEffect(() => {
    if (!org.data) return;
    const s = org.data.settings;
    setSlug(org.data.slug ?? "");
    setForm({
      customerNotify: { enabled: s.customerNotify?.enabled !== false, minutesAway: s.customerNotify?.minutesAway ?? 10, stopsAway: s.customerNotify?.stopsAway ?? 3, events: Object.fromEntries(EVENTS.map((e) => [e, s.customerNotify?.events?.[e] ?? e !== "stops_away"])) },
      customerPortal: { showDriver: s.customerPortal?.showDriver === true, allowReschedule: s.customerPortal?.allowReschedule !== false, allowCancel: s.customerPortal?.allowCancel !== false, allowInstructions: s.customerPortal?.allowInstructions !== false, allowReturns: s.customerPortal?.allowReturns !== false, cutoffMin: s.customerPortal?.cutoffMin ?? 60, horizonDays: s.customerPortal?.horizonDays ?? 14, slotCapacity: s.customerPortal?.slotCapacity ?? 20, slots: s.customerPortal?.slots?.length ? s.customerPortal.slots : DEFAULT_SLOTS },
      booking: { enabled: s.booking?.enabled === true, baseFee: s.booking?.baseFee ?? 15, perKm: s.booking?.perKm ?? 1.2, perKg: s.booking?.perKg ?? 0.05, rushPct: s.booking?.rushPct ?? 50, minimum: s.booking?.minimum ?? 20, requirePhone: s.booking?.requirePhone === true },
      approvals: { expenseLimit: s.approvals?.expenseLimit ?? 200, overtimeNeedsApproval: s.approvals?.overtimeNeedsApproval !== false },
      publicStatus: s.publicStatus !== false,
    });
  }, [org.data]);
  if (org.error) return <ErrorState error={org.error} onRetry={org.reload} />;
  if (!form) return <SkeletonList rows={4} h={48} />;

  const n = form.customerNotify, p = form.customerPortal, b = form.booking, a = form.approvals;
  const upd = <K extends keyof Cfg["settings"]>(k: K, v: Cfg["settings"][K]) => setForm({ ...form, [k]: v });
  const num = (v: string) => (v === "" ? 0 : Number(v));
  async function save() {
    try {
      await apiSend("PUT", "/org", { settings: form, ...(slug && slug !== org.data?.slug ? { slug } : {}) });
      toast(t("settingsSaved")); org.reload();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  const origin = typeof window !== "undefined" ? window.location.origin : "";

  return (
    <section className="card" style={{ padding: "var(--s4)" }} role="tabpanel">
      {tab === "messages" && (
        <>
          <label className="check"><input type="checkbox" className="switch" checked={n.enabled} onChange={(e) => upd("customerNotify", { ...n, enabled: e.target.checked })} /> {t("cx_notifyOn")}</label>
          <p className="meta small">{t("cx_notifyHelp")}</p>
          <fieldset disabled={!n.enabled} style={{ border: 0, padding: 0 }}>
            <legend>{t("cx_whichMessages")}</legend>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(250px,1fr))", gap: 4 }}>
              {EVENTS.map((e) => <label key={e} className="check"><input type="checkbox" checked={n.events[e] ?? false} onChange={(ev) => upd("customerNotify", { ...n, events: { ...n.events, [e]: ev.target.checked } })} /> {t(`cx_ev_${e}` as MessageKey)}</label>)}
            </div>
            <div className="form-grid">
              <label className="field">{t("cx_minutesAway")}<input type="number" min={2} max={120} value={n.minutesAway} onChange={(e) => upd("customerNotify", { ...n, minutesAway: num(e.target.value) })} /></label>
              <label className="field">{t("cx_stopsAway")}<input type="number" min={1} max={20} value={n.stopsAway} onChange={(e) => upd("customerNotify", { ...n, stopsAway: num(e.target.value) })} /></label>
            </div>
          </fieldset>
          <p className="meta small">{t("cx_channelsNote")}</p>
        </>
      )}
      {tab === "page" && (
        <>
          <div className="form-grid">
            {(["showDriver", "allowReschedule", "allowCancel", "allowInstructions", "allowReturns"] as const).map((k) => (
              <label key={k} className="check"><input type="checkbox" className="switch" checked={p[k]} onChange={(e) => upd("customerPortal", { ...p, [k]: e.target.checked })} /> {t(`cx_p_${k}` as MessageKey)}</label>
            ))}
            <label className="field">{t("cx_cutoff")}<input type="number" min={0} max={10080} value={p.cutoffMin} onChange={(e) => upd("customerPortal", { ...p, cutoffMin: num(e.target.value) })} /><span className="hint">{t("cx_cutoffHelp")}</span></label>
            <label className="field">{t("cx_horizon")}<input type="number" min={1} max={60} value={p.horizonDays} onChange={(e) => upd("customerPortal", { ...p, horizonDays: num(e.target.value) })} /></label>
            <label className="field">{t("cx_capacity")}<input type="number" min={1} max={1000} value={p.slotCapacity} onChange={(e) => upd("customerPortal", { ...p, slotCapacity: num(e.target.value) })} /><span className="hint">{t("cx_capacityHelp")}</span></label>
          </div>
          <h2>{t("cx_slots")}</h2>
          {p.slots.map((s, i) => (
            <div className="row" key={i}>
              <input aria-label={t("f_label")} value={s.label} maxLength={40} onChange={(e) => upd("customerPortal", { ...p, slots: p.slots.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)) })} />
              <input type="time" aria-label={t("ts_start")} value={s.start} onChange={(e) => upd("customerPortal", { ...p, slots: p.slots.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) })} />
              <input type="time" aria-label={t("ts_end")} value={s.end} onChange={(e) => upd("customerPortal", { ...p, slots: p.slots.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) })} />
              <button className="icon-btn" aria-label={t("delete")} disabled={p.slots.length < 2} onClick={() => upd("customerPortal", { ...p, slots: p.slots.filter((_, j) => j !== i) })}><Trash2 size={15} /></button>
            </div>
          ))}
          {p.slots.length < 8 && <button className="btn sm" onClick={() => upd("customerPortal", { ...p, slots: [...p.slots, { label: "", start: "08:00", end: "12:00" }] })}><Plus size={14} /> {t("cx_addSlot")}</button>}
        </>
      )}
      {tab === "booking" && (
        <>
          <label className="field">{t("cx_slug")}<input value={slug} maxLength={49} pattern="[a-z0-9][a-z0-9-]*" onChange={(e) => setSlug(e.target.value.toLowerCase())} /><span className="hint">{t("cx_slugHelp")}</span></label>
          {org.data?.slug && (
            <ul className="plainlist">
              {[["book", "cx_bookLink"], ["status", "cx_statusLink"], ["help", "cx_helpLink"]].map(([path, label]) => <li key={path}><a href={`${origin}/${path}/${org.data!.slug}`} target="_blank" rel="noreferrer">{t(label as MessageKey)} <ExternalLink size={13} /></a> <code className="small">{origin}/{path}/{org.data!.slug}</code></li>)}
            </ul>
          )}
          <label className="check"><input type="checkbox" className="switch" checked={b.enabled} onChange={(e) => upd("booking", { ...b, enabled: e.target.checked })} /> {t("cx_bookingOn")}</label>
          <label className="check"><input type="checkbox" className="switch" checked={b.requirePhone} onChange={(e) => upd("booking", { ...b, requirePhone: e.target.checked })} /> {t("cx_requirePhone")}</label>
          <label className="check"><input type="checkbox" className="switch" checked={form.publicStatus} onChange={(e) => upd("publicStatus", e.target.checked)} /> {t("cx_statusOn")}</label>
          <h2>{t("cx_pricing")}</h2>
          <div className="form-grid">
            <label className="field">{t("cx_baseFee")}<input type="number" min={0} step="0.01" value={b.baseFee} onChange={(e) => upd("booking", { ...b, baseFee: num(e.target.value) })} /></label>
            <label className="field">{t("cx_perKm")}<input type="number" min={0} step="0.01" value={b.perKm} onChange={(e) => upd("booking", { ...b, perKm: num(e.target.value) })} /></label>
            <label className="field">{t("cx_perKg")}<input type="number" min={0} step="0.01" value={b.perKg} onChange={(e) => upd("booking", { ...b, perKg: num(e.target.value) })} /></label>
            <label className="field">{t("cx_rush")}<input type="number" min={0} max={500} value={b.rushPct} onChange={(e) => upd("booking", { ...b, rushPct: num(e.target.value) })} /></label>
            <label className="field">{t("cx_minimum")}<input type="number" min={0} step="0.01" value={b.minimum} onChange={(e) => upd("booking", { ...b, minimum: num(e.target.value) })} /></label>
          </div>
          <p className="meta small">{t("cx_pricingNote")}</p>
        </>
      )}
      {tab === "rules" && (
        <div className="form-grid">
          <label className="field">{t("cx_expenseLimit")}<input type="number" min={0} max={100000} value={a.expenseLimit} onChange={(e) => upd("approvals", { ...a, expenseLimit: num(e.target.value) })} /><span className="hint">{t("cx_expenseLimitHelp")}</span></label>
          <label className="check"><input type="checkbox" className="switch" checked={a.overtimeNeedsApproval} onChange={(e) => upd("approvals", { ...a, overtimeNeedsApproval: e.target.checked })} /> {t("cx_overtimeApproval")}</label>
        </div>
      )}
      <div className="row" style={{ marginTop: "var(--s4)" }}><button className="btn primary" onClick={() => void save()}>{t("saveSettings")}</button></div>
    </section>
  );
}

interface Tpl { id: string; event: string; channel: "email" | "sms"; locale: "en" | "fr"; subject: string | null; body: string }
interface Defaults { events: string[]; defaults: Record<string, Record<string, { subject: string; sms: string; email: string }>>; placeholders: string[] }

function Wording() {
  const { t, locale: ui } = useI18n();
  const { toast } = useToast();
  const defs = useApi<Defaults>("/message-defaults");
  const tpls = useApi<Tpl[]>("/r/message-templates");
  const [event, setEvent] = useState("on_the_way");
  const [loc, setLoc] = useState<"en" | "fr">(ui === "fr" ? "fr" : "en");
  const [f, setF] = useState({ subject: "", email: "", sms: "" });
  const [preview, setPreview] = useState<{ subject: string; text: string; sms: string } | null>(null);
  const mine = (ch: "email" | "sms") => (tpls.data ?? []).find((x) => x.event === event && x.channel === ch && x.locale === loc);
  useEffect(() => {
    const d = defs.data?.defaults[event]?.[loc];
    if (!d || !tpls.loaded) return;
    const e = mine("email"), s = mine("sms");
    setF({ subject: e?.subject ?? d.subject, email: e?.body ?? d.email, sms: s?.body ?? d.sms }); setPreview(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [event, loc, defs.data, tpls.data]);
  if (defs.error) return <ErrorState error={defs.error} onRetry={defs.reload} />;
  if (!defs.data) return <SkeletonList rows={4} h={48} />;
  const d = defs.data.defaults[event]![loc]!;

  async function put(ch: "email" | "sms", body: string, subject: string | null, same: boolean) {
    const cur = mine(ch);
    if (same) { if (cur) await apiSend("DELETE", `/r/message-templates/${cur.id}`); return; }
    const payload = { event, channel: ch, locale: loc, subject, body };
    if (cur) await apiSend("PATCH", `/r/message-templates/${cur.id}`, payload); else await apiSend("POST", "/r/message-templates", payload);
  }
  async function save() {
    try {
      await put("email", f.email, f.subject, f.email === d.email && f.subject === d.subject);
      await put("sms", f.sms, null, f.sms === d.sms);
      toast(t("cx_wordingSaved")); tpls.reload();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function show() { try { setPreview(await apiSend("POST", "/message-defaults/preview", { event, locale: loc, subject: f.subject, email: f.email, sms: f.sms })); } catch (e) { toast((e as Error).message, { tone: "error" }); } }

  return (
    <section className="card" style={{ padding: "var(--s4)" }}>
      <div className="row">
        <label className="field">{t("cx_message")}<select value={event} onChange={(e) => setEvent(e.target.value)}>{defs.data.events.map((e) => <option key={e} value={e}>{t(`cx_ev_${e}` as MessageKey)}</option>)}</select></label>
        <label className="field">{t("language")}<select value={loc} onChange={(e) => setLoc(e.target.value as "en" | "fr")}><option value="en">English</option><option value="fr">Français</option></select></label>
        {(mine("email") || mine("sms")) && <span className="meta small">{t("cx_customised")}</span>}
      </div>
      <label className="field">{t("wf_subject")}<input value={f.subject} maxLength={200} onChange={(e) => setF({ ...f, subject: e.target.value })} /></label>
      <label className="field">{t("cx_emailText")}<textarea rows={6} maxLength={2000} value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
      <label className="field">{t("cx_smsText")}<textarea rows={3} maxLength={2000} value={f.sms} onChange={(e) => setF({ ...f, sms: e.target.value })} /><span className="hint">{t("cx_smsLen", { n: f.sms.length })}</span></label>
      <p className="meta small">{t("cx_placeholders")}: {defs.data.placeholders.map((p) => `{{${p}}}`).join("  ")}</p>
      <div className="row">
        <button className="btn" onClick={() => setF({ subject: d.subject, email: d.email, sms: d.sms })}>{t("cx_useDefault")}</button>
        <button className="btn" onClick={() => void show()}>{t("cx_preview")}</button>
        <button className="btn primary" onClick={() => void save()}>{t("save")}</button>
      </div>
      {preview && <div className="card" style={{ padding: "var(--s3)", marginTop: "var(--s3)" }} role="status"><strong>{preview.subject}</strong><pre style={{ whiteSpace: "pre-wrap", font: "inherit" }}>{preview.text}</pre><div className="meta small">SMS: {preview.sms}</div></div>}
    </section>
  );
}

function Content() {
  const { t } = useI18n();
  const items: { href: string; title: MessageKey; body: MessageKey }[] = [
    { href: "/fleet/faq-items", title: "res_faq-items", body: "cx_faqHelp" }, { href: "/fleet/status-notices", title: "res_status-notices", body: "cx_noticeHelp" },
    { href: "/fleet/training-items", title: "res_training-items", body: "cx_trainingHelp" },
  ];
  return (
    <ul className="plainlist" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(260px,1fr))", gap: "var(--s3)" }}>
      {items.map((i) => <li key={i.href} className="card" style={{ padding: "var(--s4)" }}><strong>{t(i.title)}</strong><p className="meta small">{t(i.body)}</p><Link className="btn sm" href={i.href}>{t("cx_open")}</Link></li>)}
    </ul>
  );
}
