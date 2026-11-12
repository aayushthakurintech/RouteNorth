"use client";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useState, type FormEvent } from "react";
import { PublicShell } from "@/components/public/PublicShell";
import { useI18n } from "@/lib/i18n-context";
import { PublicError, publicGet, publicSend } from "@/lib/public-api";

interface Info { name: string; color: string | null; logo: string | null; currency: string; booking: { enabled: boolean; requirePhone?: boolean; slots?: { label: string; start: string; end: string }[]; taxRatePct?: number; horizonDays?: number }; statusPage: boolean; faq: boolean }
interface Quote { total: number; tax: number; totalWithTax: number; currency: string; distanceKm: number; distanceKnown: boolean; rush: number }
interface Done { ref: string; total: number; currency: string; track: string }

const day = (offset: number) => { const d = new Date(Date.now() + offset * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`; };

/** A company's own page where customers ask for a delivery or pickup and see an estimated price first. */
export default function BookPage() {
  const { slug } = useParams<{ slug: string }>();
  const { t, locale } = useI18n();
  const [info, setInfo] = useState<Info | null>(null);
  const [gone, setGone] = useState(false);
  const [f, setF] = useState({ type: "delivery", name: "", email: "", phone: "", address: "", description: "", weightKg: "", rush: false, date: "", slot: "", notes: "", website: "" });
  const [quote, setQuote] = useState<Quote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<Done | null>(null);
  useEffect(() => { publicGet<Info>(`/public/org/${encodeURIComponent(slug)}`).then(setInfo).catch(() => setGone(true)); }, [slug]);

  const money = (v: number, cur: string) => new Intl.NumberFormat(locale, { style: "currency", currency: cur }).format(v);
  async function getQuote() {
    setErr(null);
    try { setQuote(await publicSend<Quote>("POST", `/public/org/${encodeURIComponent(slug)}/quote`, { address: f.address, weightKg: f.weightKg, rush: f.rush })); } catch (e) { setErr((e as Error).message); }
  }
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setErr(null);
    try { setDone(await publicSend<Done>("POST", `/public/org/${encodeURIComponent(slug)}/book`, f)); }
    catch (er) { setErr(er instanceof PublicError && er.status === 429 ? t("bk_slowDown") : (er as Error).message); }
    finally { setBusy(false); }
  }

  if (gone) return <PublicShell org={null}><div className="pub-card" role="alert"><h1>{t("bk_gone")}</h1></div></PublicShell>;
  if (!info) return <PublicShell org={null}><p role="status">{t("loading")}</p></PublicShell>;
  if (!info.booking.enabled) return <PublicShell org={info}><div className="pub-card"><h1>{t("bk_off")}</h1><p>{t("bk_offHelp")}</p></div></PublicShell>;
  if (done) {
    return (
      <PublicShell org={info}>
        <div className="pub-card" role="status">
          <h1>{t("bk_thanks")}</h1>
          <p>{t("bk_ref", { ref: done.ref })} · {t("bk_estimate", { price: money(done.total, done.currency) })}</p>
          <p>{t("bk_next")}</p>
          <div className="row"><Link className="btn primary" href={done.track}>{t("bk_follow")}</Link></div>
        </div>
      </PublicShell>
    );
  }
  const slots = info.booking.slots ?? [];
  return (
    <PublicShell org={info}>
      <form className="pub-card" onSubmit={submit}>
        <h1>{t("bk_title", { name: info.name })}</h1>
        <p className="meta">{t("bk_intro")}</p>
        <div className="seg" role="group" aria-label={t("f_kind")}>
          {["delivery", "pickup"].map((k) => <button type="button" key={k} aria-pressed={f.type === k} onClick={() => setF({ ...f, type: k })}>{t(k === "delivery" ? "bk_delivery" : "bk_pickup")}</button>)}
        </div>
        <div className="form-grid">
          <label className="field">{t("bk_name")}<input required maxLength={120} value={f.name} autoComplete="name" onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
          <label className="field">{t("f_email")}<input type="email" maxLength={200} value={f.email} autoComplete="email" onChange={(e) => setF({ ...f, email: e.target.value })} /></label>
          <label className="field">{t("f_phone")}{info.booking.requirePhone ? " *" : ""}<input type="tel" required={info.booking.requirePhone} maxLength={40} value={f.phone} autoComplete="tel" onChange={(e) => setF({ ...f, phone: e.target.value })} /></label>
        </div>
        <label className="field">{t("bk_address")}<input required maxLength={300} value={f.address} autoComplete="street-address" onChange={(e) => { setF({ ...f, address: e.target.value }); setQuote(null); }} /></label>
        <label className="field">{t("bk_what")}<input required maxLength={300} value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} /></label>
        <div className="form-grid">
          <label className="field">{t("bk_weight")}<input type="number" min={0} max={50000} step="any" value={f.weightKg} onChange={(e) => { setF({ ...f, weightKg: e.target.value }); setQuote(null); }} /></label>
          <label className="field">{t("cj_preferredDay")}<input type="date" min={day(0)} max={day(info.booking.horizonDays ?? 14)} value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
          <label className="field">{t("cj_preferredSlot")}<select value={f.slot} disabled={!f.date} onChange={(e) => setF({ ...f, slot: e.target.value })}><option value="">{t("bk_anyTime")}</option>{slots.map((s, i) => <option key={i} value={i}>{s.label} ({s.start}–{s.end})</option>)}</select></label>
        </div>
        <label className="check"><input type="checkbox" checked={f.rush} onChange={(e) => { setF({ ...f, rush: e.target.checked }); setQuote(null); }} /> {t("bk_rush")}</label>
        <label className="field">{t("f_notes")}<textarea rows={2} maxLength={500} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} /></label>
        <div className="pub-hp" aria-hidden><label>Website<input tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => setF({ ...f, website: e.target.value })} /></label></div>
        <div className="row">
          <button type="button" className="btn" disabled={!f.address.trim()} onClick={() => void getQuote()}>{t("bk_getQuote")}</button>
          {quote && <span role="status"><strong>{money(quote.total, quote.currency)}</strong> <span className="meta">+ {money(quote.tax, quote.currency)} {t("bk_tax")}{quote.distanceKnown ? ` · ${quote.distanceKm} km` : ""}</span></span>}
        </div>
        {quote && <p className="meta small">{t("bk_quoteNote")}</p>}
        {err && <p role="alert" className="error">{err}</p>}
        <div className="row"><button className="btn primary" disabled={busy}>{t("bk_submit")}</button></div>
        <p className="meta small">{[info.statusPage && <Link key="s" href={`/status/${slug}`}>{t("cx_statusLink")}</Link>, info.faq && <Link key="h" href={`/help/${slug}`}>{t("cx_helpLink")}</Link>].filter(Boolean).reduce<React.ReactNode[]>((a, x, i) => (i ? [...a, " · ", x] : [x]), [])}</p>
      </form>
    </PublicShell>
  );
}
