"use client";
import dynamic from "next/dynamic";
import { useParams } from "next/navigation";
import type { MessageKey } from "@routenorth/shared";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { PublicShell } from "@/components/public/PublicShell";
import { useI18n } from "@/lib/i18n-context";
import { PublicError, publicGet, publicSend, safeBrand } from "@/lib/public-api";
import { API_URL } from "@/lib/session";

const TrackMap = dynamic(() => import("@/components/TrackMap").then((m) => m.TrackMap), { ssr: false });

interface Job {
  org: { name: string; color: string | null; logo: string | null; locale: string; slug: string };
  job: { ref: string | null; title: string; type: string; status: string; address: string | null; lat: number | null; lng: number | null; customer: string | null; date: string | null; windowStart: string | null; windowEnd: string | null; instructions: string | null; deliveredAt: string | null; isReturn: boolean };
  driver: { name: string; photo: string | null } | null;
  vehicle: { name: string; kind: string; plate: string | null; color: string | null; make: string | null; model: string | null } | null;
  live: { stopsAway: number; eta: string | null; position: { lat: number; lng: number; heading: number | null; time: string } | null } | null;
  proofs: { id: string; kind: string; takenAt: string }[];
  messages: { id: string; from: string; body: string; at: string }[];
  feedback: { csat: number | null; nps: number | null; comment: string | null } | null;
  prefs: { emailOn: boolean; smsOn: boolean; mutedEvents: string[]; locale: string | null } | null;
  can: { reschedule: boolean; cancel: boolean; why: string | null; instructions: boolean; returns: boolean; rate: boolean };
  slots: { label: string; start: string; end: string }[];
}
interface Day { date: string; slots: { index: number; label: string; start: string; end: string; full: boolean }[] }

const MUTABLE = ["scheduled", "on_the_way", "minutes_away", "stops_away", "arrived", "delivered"];

/** The page a customer opens from the link in their message: where the order is, what they can change, proof, and a way to reach the company. */
export default function JobPage() {
  const { token } = useParams<{ token: string }>();
  const { t, locale } = useI18n();
  const [data, setData] = useState<Job | null>(null);
  const [state, setState] = useState<"loading" | "ok" | "gone" | "busy">("loading");
  const [panel, setPanel] = useState<null | "reschedule" | "cancel" | "return">(null);

  const load = useCallback(async () => {
    try { setData(await publicGet<Job>(`/public/job/${encodeURIComponent(token)}`)); setState("ok"); }
    catch (e) { if (e instanceof PublicError && e.status === 404) setState("gone"); else setState((s) => (s === "ok" ? s : "busy")); }
  }, [token]);
  useEffect(() => {
    void load();
    const id = setInterval(() => { if (!document.hidden) void load(); }, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const fmt = useMemo(() => ({
    time: (iso: string) => new Intl.DateTimeFormat(locale, { timeStyle: "short" }).format(new Date(iso)),
    day: (d: string) => new Intl.DateTimeFormat(locale, { dateStyle: "full" }).format(new Date(`${d}T12:00:00`)),
    dt: (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)),
  }), [locale]);

  if (state === "loading") return <PublicShell org={null}><p role="status">{t("track_loading")}</p></PublicShell>;
  if (state === "gone") return <PublicShell org={null}><div className="pub-card" role="alert"><h1>{t("cj_gone")}</h1><p>{t("cj_goneHelp")}</p></div></PublicShell>;
  if (!data) return <PublicShell org={null}><p role="alert">{t("track_busy")}</p></PublicShell>;

  const { job, live, can } = data;
  const tone = job.status === "done" ? "ok" : job.status === "failed" || job.status === "cancelled" ? "bad" : job.status === "started" || job.status === "arrived" ? "" : "warn";
  const win = job.windowStart && job.windowEnd ? `${job.date ? `${fmt.day(job.date)}, ` : ""}${fmt.time(job.windowStart)} – ${fmt.time(job.windowEnd)}` : job.date ? fmt.day(job.date) : null;
  const mapData = { vehicle: live?.position ?? null, trail: [], stops: job.lat != null && job.lng != null ? [{ lat: job.lat, lng: job.lng, sequence: 1, status: "pending" }] : [] };
  const brand = safeBrand(data.org.color);

  return (
    <PublicShell org={data.org}>
      <section className="pub-card" aria-live="polite">
        <div className="pub-status"><span className={`pub-pill ${tone}`}>{t(`cj_s_${job.status}` as MessageKey)}</span>{job.ref && <span className="meta">{job.ref}</span>}{job.isReturn && <span className="pub-pill">{t("cj_return")}</span>}</div>
        <h1>{job.title}</h1>
        {job.customer && <p className="meta">{t("cj_hello", { name: job.customer })}</p>}
        {job.address && <p>{job.address}</p>}
        {win && <p><strong>{t("cj_window")}:</strong> {win}</p>}
        {live && (
          <p className="track-eta" role="status">
            {live.eta ? t("cj_eta", { time: fmt.time(live.eta) }) : null}{live.eta && live.stopsAway > 0 ? " · " : ""}
            {live.stopsAway > 0 ? t("cj_stopsAway", { n: live.stopsAway }) : t("cj_next")}
          </p>
        )}
        {job.status === "done" && job.deliveredAt && <p>{t("cj_deliveredAt", { time: fmt.dt(job.deliveredAt) })}</p>}
        {(live?.position || mapData.stops.length > 0) && ["assigned", "started", "arrived"].includes(job.status) && <div className="pub-map"><TrackMap data={mapData} brand={brand} /></div>}
        {data.driver && (
          <div className="row">
            {data.driver.photo && /* eslint-disable-next-line @next/next/no-img-element */ <img src={data.driver.photo} alt="" width={56} height={56} style={{ borderRadius: "50%", objectFit: "cover" }} />}
            <div><strong>{t("cj_yourDriver", { name: data.driver.name })}</strong>{data.vehicle && <div className="meta small">{[data.vehicle.color, data.vehicle.make, data.vehicle.model, data.vehicle.plate].filter(Boolean).join(" · ") || data.vehicle.name}</div>}</div>
          </div>
        )}
      </section>

      {data.proofs.length > 0 && (
        <section className="pub-card" aria-label={t("cj_proof")}>
          <h2>{t("cj_proof")}</h2>
          <div className="pub-proofs">{data.proofs.map((p) => /* eslint-disable-next-line @next/next/no-img-element */ <a key={p.id} href={`${API_URL}/public/job/${encodeURIComponent(token)}/proof/${p.id}`} target="_blank" rel="noreferrer"><img src={`${API_URL}/public/job/${encodeURIComponent(token)}/proof/${p.id}`} alt={t(p.kind === "signature" ? "cj_signature" : "cj_photo")} loading="lazy" /></a>)}</div>
        </section>
      )}

      {can.instructions && <Instructions token={token} initial={job.instructions ?? ""} onSaved={load} />}

      {(can.reschedule || can.cancel || can.returns || can.why) && (
        <section className="pub-card" aria-label={t("cj_changes")}>
          <h2>{t("cj_changes")}</h2>
          <div className="row">
            {can.reschedule && <button className="btn" onClick={() => setPanel(panel === "reschedule" ? null : "reschedule")} aria-expanded={panel === "reschedule"}>{t("cj_changeTime")}</button>}
            {can.cancel && <button className="btn" onClick={() => setPanel(panel === "cancel" ? null : "cancel")} aria-expanded={panel === "cancel"}>{t("cj_cancel")}</button>}
            {can.returns && <button className="btn" onClick={() => setPanel(panel === "return" ? null : "return")} aria-expanded={panel === "return"}>{t("cj_requestReturn")}</button>}
          </div>
          {!can.reschedule && !can.cancel && !can.returns && can.why && <p className="meta">{t("cj_cannotChange")}</p>}
          {panel === "reschedule" && <Reschedule token={token} onDone={() => { setPanel(null); void load(); }} fmtDay={fmt.day} />}
          {panel === "cancel" && <Cancel token={token} onDone={() => { setPanel(null); void load(); }} />}
          {panel === "return" && <ReturnForm token={token} slots={data.slots} onDone={() => setPanel(null)} />}
        </section>
      )}

      {can.rate && <Rate token={token} existing={data.feedback} onDone={load} />}
      <Chat token={token} messages={data.messages} onSent={load} fmt={fmt.dt} />
      {data.prefs && <Prefs token={token} initial={data.prefs} />}
    </PublicShell>
  );
}

function Instructions({ token, initial, onSaved }: { token: string; initial: string; onSaved: () => void }) {
  const { t } = useI18n();
  const [text, setText] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  async function save(e: FormEvent) {
    e.preventDefault();
    try { await publicSend("PUT", `/public/job/${encodeURIComponent(token)}/instructions`, { text }); setMsg(t("cj_saved")); onSaved(); } catch (er) { setMsg((er as Error).message); }
  }
  return (
    <form className="pub-card" onSubmit={save}>
      <h2>{t("cj_instructions")}</h2>
      <label className="field"><span className="sr-only">{t("cj_instructions")}</span><textarea rows={3} maxLength={500} value={text} placeholder={t("cj_instructionsHint")} onChange={(e) => setText(e.target.value)} /></label>
      <div className="row"><button className="btn primary">{t("save")}</button>{msg && <span role="status" className="meta">{msg}</span>}</div>
    </form>
  );
}

function Reschedule({ token, onDone, fmtDay }: { token: string; onDone: () => void; fmtDay: (d: string) => string }) {
  const { t } = useI18n();
  const [days, setDays] = useState<Day[] | null>(null);
  const [pick, setPick] = useState<{ date: string; slot: number } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { publicGet<Day[]>(`/public/job/${encodeURIComponent(token)}/slots`).then(setDays).catch((e) => setErr((e as Error).message)); }, [token]);
  async function go() {
    if (!pick) return;
    try { await publicSend("POST", `/public/job/${encodeURIComponent(token)}/reschedule`, pick); onDone(); } catch (e) { setErr((e as Error).message); }
  }
  return (
    <div className="pub-slots" role="group" aria-label={t("cj_changeTime")}>
      {!days && !err && <p role="status">{t("loading")}</p>}
      {days?.map((d) => (
        <div className="day" key={d.date}>
          <strong>{fmtDay(d.date)}</strong>
          {d.slots.map((s) => <button key={s.index} type="button" disabled={s.full} aria-pressed={pick?.date === d.date && pick.slot === s.index} onClick={() => setPick({ date: d.date, slot: s.index })}>{s.label} {s.start}–{s.end}{s.full ? ` (${t("cj_full")})` : ""}</button>)}
        </div>
      ))}
      {err && <p role="alert" className="error">{err}</p>}
      <div className="row"><button className="btn primary" disabled={!pick} onClick={() => void go()}>{t("cj_confirmTime")}</button></div>
    </div>
  );
}

function Cancel({ token, onDone }: { token: string; onDone: () => void }) {
  const { t } = useI18n();
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function go() { try { await publicSend("POST", `/public/job/${encodeURIComponent(token)}/cancel`, { note }); onDone(); } catch (e) { setErr((e as Error).message); } }
  return (
    <div className="stack">
      <p>{t("cj_cancelAsk")}</p>
      <label className="field">{t("cj_cancelWhy")}<input value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} /></label>
      {err && <p role="alert" className="error">{err}</p>}
      <div className="row"><button className="btn primary" onClick={() => void go()}>{t("cj_cancelYes")}</button></div>
    </div>
  );
}

function ReturnForm({ token, slots, onDone }: { token: string; slots: { label: string }[]; onDone: () => void }) {
  const { t } = useI18n();
  const [f, setF] = useState({ kind: "return", date: "", slot: "", note: "" });
  const [msg, setMsg] = useState<string | null>(null);
  async function go() { try { await publicSend("POST", `/public/job/${encodeURIComponent(token)}/return`, f); setMsg(t("cj_returnSent")); setTimeout(onDone, 1500); } catch (e) { setMsg((e as Error).message); } }
  return (
    <div className="form-grid">
      <label className="field">{t("cj_returnKind")}<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}><option value="return">{t("cj_kindReturn")}</option><option value="pickup">{t("cj_kindPickup")}</option></select></label>
      <label className="field">{t("cj_preferredDay")}<input type="date" value={f.date} onChange={(e) => setF({ ...f, date: e.target.value })} /></label>
      <label className="field">{t("cj_preferredSlot")}<select value={f.slot} onChange={(e) => setF({ ...f, slot: e.target.value })}><option value="">–</option>{slots.map((s, i) => <option key={i} value={i}>{s.label}</option>)}</select></label>
      <label className="field">{t("f_notes")}<input value={f.note} maxLength={500} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
      {msg && <p role="status">{msg}</p>}
      <div className="row"><button className="btn primary" onClick={() => void go()}>{t("cj_sendRequest")}</button></div>
    </div>
  );
}

function Rate({ token, existing, onDone }: { token: string; existing: Job["feedback"]; onDone: () => void }) {
  const { t } = useI18n();
  const [csat, setCsat] = useState(existing?.csat ?? 0);
  const [nps, setNps] = useState<number | null>(existing?.nps ?? null);
  const [comment, setComment] = useState(existing?.comment ?? "");
  const [state, setState] = useState<"form" | "sent" | "error">("form");
  async function send(e: FormEvent) {
    e.preventDefault();
    try { await publicSend("POST", `/public/job/${encodeURIComponent(token)}/feedback`, { csat: csat || undefined, nps: nps ?? undefined, comment }); setState("sent"); onDone(); } catch { setState("error"); }
  }
  if (state === "sent") return <p className="pub-card" role="status">{t("fb_thanks")}</p>;
  return (
    <form onSubmit={send} className="pub-card" aria-label={t("fb_title")}>
      <h2>{existing ? t("cj_rateAgain") : t("fb_title")}</h2>
      <div className="stars" role="radiogroup" aria-label={t("fb_howWas")}>{[1, 2, 3, 4, 5].map((n) => <button type="button" key={n} role="radio" aria-checked={csat === n} aria-label={t("fb_stars", { n })} className={csat >= n ? "on" : ""} onClick={() => setCsat(n)}>★</button>)}</div>
      <label className="field">{t("fb_comment")}<textarea rows={2} maxLength={2000} value={comment} onChange={(e) => setComment(e.target.value)} /></label>
      <div className="nps" role="radiogroup" aria-label={t("fb_recommend")}>{Array.from({ length: 11 }, (_, n) => <button type="button" key={n} role="radio" aria-checked={nps === n} className={nps === n ? "on" : ""} onClick={() => setNps(n)}>{n}</button>)}</div>
      {state === "error" && <p role="alert" className="error">{t("fb_error")}</p>}
      <div className="row"><button className="btn primary" disabled={!csat && nps == null}>{t("fb_send")}</button></div>
    </form>
  );
}

function Chat({ token, messages, onSent, fmt }: { token: string; messages: Job["messages"]; onSent: () => void; fmt: (iso: string) => string }) {
  const { t } = useI18n();
  const [text, setText] = useState("");
  const [err, setErr] = useState<string | null>(null);
  async function send(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    try { await publicSend("POST", `/public/job/${encodeURIComponent(token)}/message`, { body: text }); setText(""); setErr(null); onSent(); } catch (er) { setErr((er as Error).message); }
  }
  return (
    <section className="pub-card" aria-label={t("cj_contact")}>
      <h2>{t("cj_contact")}</h2>
      {messages.length > 0 && <div className="pub-chat" aria-live="polite">{messages.map((m) => <div key={m.id} className={`bubble${m.from === "customer" ? " me" : ""}`}>{m.body}<div className="small" style={{ opacity: 0.95 }}>{fmt(m.at)}</div></div>)}</div>}
      <form className="row" onSubmit={send}><input className="grow" value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} aria-label={t("cj_writeMessage")} placeholder={t("cj_writeMessage")} /><button className="btn primary" disabled={!text.trim()}>{t("ib_send")}</button></form>
      {err && <p role="alert" className="error">{err}</p>}
    </section>
  );
}

function Prefs({ token, initial }: { token: string; initial: NonNullable<Job["prefs"]> }) {
  const { t, locale } = useI18n();
  const [p, setP] = useState(initial);
  const [msg, setMsg] = useState<string | null>(null);
  async function save(next: typeof p) {
    setP(next);
    try { await publicSend("PUT", `/public/job/${encodeURIComponent(token)}/prefs`, { ...next, locale }); setMsg(t("cj_saved")); } catch (e) { setMsg((e as Error).message); }
  }
  return (
    <details className="pub-card">
      <summary><strong>{t("cj_notifications")}</strong></summary>
      <label className="check"><input type="checkbox" checked={p.emailOn} onChange={(e) => void save({ ...p, emailOn: e.target.checked })} /> {t("cj_byEmail")}</label>
      <label className="check"><input type="checkbox" checked={p.smsOn} onChange={(e) => void save({ ...p, smsOn: e.target.checked })} /> {t("cj_byText")}</label>
      <fieldset><legend>{t("cj_dontTellMe")}</legend>
        {MUTABLE.map((ev) => <label key={ev} className="check"><input type="checkbox" checked={p.mutedEvents.includes(ev)} onChange={(e) => void save({ ...p, mutedEvents: e.target.checked ? [...p.mutedEvents, ev] : p.mutedEvents.filter((x) => x !== ev) })} /> {t(`cx_ev_${ev}` as MessageKey)}</label>)}
      </fieldset>
      {msg && <span role="status" className="meta">{msg}</span>}
    </details>
  );
}
