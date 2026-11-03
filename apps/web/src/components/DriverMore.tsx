"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageKey } from "@routenorth/shared";
import { Sheet } from "@/components/DriverSheet";
import { addToOutbox, browserStorage, flushOutbox, type OutboxItem } from "@/lib/driver-outbox";
import { downscaleImage } from "@/lib/image";
import { useI18n } from "@/lib/i18n-context";
import { API_URL, loadSession } from "@/lib/session";
import { parseVoiceCommand, type VoiceCommand } from "@/lib/voice-commands";

type T = (k: MessageKey, v?: Record<string, string | number>) => string;
const store = browserStorage();
const QUICK = ["ok", "late_10", "late_30", "arrived", "loaded", "call_me", "cant_find", "customer_absent"] as const;
const HELP_KINDS = ["flat_tire", "breakdown", "accident", "medical", "wrong_address", "customer_not_home", "access_problem", "other"] as const;
const EXPENSE_KINDS = ["fuel", "parking", "toll", "meal", "repair", "other"] as const;
const PREFS_KEY = "routenorth.driver.prefs";

const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const auth = () => ({ Authorization: `Bearer ${loadSession()?.token}` });

async function get<R>(path: string): Promise<R> {
  const res = await fetch(`${API_URL}${path}`, { headers: auth() });
  if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? `HTTP ${res.status}`);
  return res.json();
}
/** Sends now; when there is no signal the request waits in the outbox and goes out later. */
async function post<R>(path: string, body: unknown): Promise<{ queued: boolean; data?: R }> {
  const item: OutboxItem = { id: (body as { clientId?: string })?.clientId ?? newId(), method: "POST", path, body, at: new Date().toISOString() };
  try {
    const res = await fetch(`${API_URL}${path}`, { method: "POST", headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(body) });
    if (res.status >= 500 || res.status === 408 || res.status === 429) { addToOutbox(store, item); return { queued: true }; }
    if (!res.ok) throw new Error((await res.json().catch(() => null))?.message ?? `HTTP ${res.status}`);
    return { queued: false, data: (await res.json()) as R };
  } catch (e) {
    if (e instanceof TypeError) { addToOutbox(store, item); return { queued: true }; }
    throw e;
  }
}
export const flushDriverOutbox = () => flushOutbox(store, async (i) => ({ status: (await fetch(`${API_URL}${i.path}`, { method: i.method, headers: { ...auth(), "content-type": "application/json" }, body: JSON.stringify(i.body) })).status }));

const here = (): Promise<{ lat: number; lng: number } | null> => new Promise((ok) => {
  if (!navigator.geolocation) return ok(null);
  navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), () => ok(null), { timeout: 4000, maximumAge: 60_000 });
});
const toDataUrl = (b: Blob) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(b); });

interface ShiftState { active: boolean; startedAt?: string; workedMin?: number; onBreak?: boolean; breakKind?: string | null; breakStartedAt?: string | null; sinceBreakMin?: number; breakAfterMin: number; breakMin: number; breaksTakenMin?: number; overtimeAfterMin?: number }
interface Msg { id: string; from: string; body: string; quickKey: string | null; hasAudio: boolean; at: string }
interface Training { id: string; title: string; body: string | null; videoUrl: string | null }

const hm = (m: number) => `${Math.floor(m / 60)}:${String(Math.round(m % 60)).padStart(2, "0")}`;

export interface DriverActions { arrive: () => void; complete: () => void; fail: () => void; navigate: () => void }
interface Prefs { batterySaver: boolean; alerts: boolean }
const loadPrefs = (): Prefs => { try { return { batterySaver: false, alerts: false, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") }; } catch { return { batterySaver: false, alerts: false }; } };

/** Shift clock and breaks, chat with dispatch, call for help, expenses, tips, hands-free commands and a low-distraction driving mode. */
export function DriverMore({ nextStop, actions }: { nextStop: { id: string; name: string; address?: string | null } | null; actions: DriverActions }) {
  const { t, locale } = useI18n() as { t: T; locale: string };
  const [open, setOpen] = useState<null | "chat" | "help" | "expense" | "tips" | "confirm">(null);
  const [toast, setToast] = useState<string | null>(null);
  const [shift, setShift] = useState<ShiftState | null>(null);
  const [unread, setUnread] = useState(0);
  const [prefs, setPrefs] = useState<Prefs>({ batterySaver: false, alerts: false });
  const [driving, setDriving] = useState(false);
  const [listening, setListening] = useState(false);
  const [heard, setHeard] = useState<VoiceCommand | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const since = useRef(new Date().toISOString());
  const say = (m: string) => { setToast(m); setTimeout(() => setToast(null), 6000); };

  useEffect(() => { setPrefs(loadPrefs()); }, []);
  useEffect(() => { document.body.classList.toggle("battery-saver", prefs.batterySaver); try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch { /* optional */ } }, [prefs]);

  const refresh = useCallback(async () => {
    try {
      const s = await get<ShiftState>("/driver/shift");
      setShift(s);
      const u = await get<{ now: string; messages: number; unread: number; jobs: number; latest: string | null }>(`/driver/updates?since=${encodeURIComponent(since.current)}`);
      since.current = u.now; setUnread(u.unread);
      if ((u.messages > 0 || u.jobs > 0) && prefs.alerts && typeof Notification !== "undefined" && Notification.permission === "granted" && document.hidden) {
        new Notification(u.messages > 0 ? t("dx_newMessage") : t("dx_newWork"), { body: u.latest ?? undefined });
      }
      if (u.jobs > 0) say(t("dx_newWork"));
      await flushDriverOutbox();
    } catch { /* offline: try again later */ }
  }, [prefs.alerts, t]);
  useEffect(() => {
    void refresh();
    const id = setInterval(() => { if (!document.hidden) void refresh(); setNow(Date.now()); }, prefs.batterySaver ? 120_000 : 30_000);
    return () => clearInterval(id);
  }, [refresh, prefs.batterySaver]);

  async function shiftCall(path: string, body: unknown = {}) {
    try { const where = await here(); const r = await post<ShiftState>(path, { ...(where ?? {}), ...(body as object) }); if (r.data) setShift(r.data); else say(t("dx_saved")); }
    catch (e) { say((e as Error).message); }
  }
  async function toggleAlerts() {
    if (typeof Notification === "undefined") { say(t("dx_noAlerts")); return; }
    if (prefs.alerts) { setPrefs({ ...prefs, alerts: false }); return; }
    const p = await Notification.requestPermission();
    setPrefs({ ...prefs, alerts: p === "granted" }); if (p !== "granted") say(t("dx_noAlerts"));
  }

  // Hands-free commands: the browser's speech recognition (not on every phone), and a confirmation before anything changes.
  const Rec = typeof window !== "undefined" ? ((window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec }).SpeechRecognition ?? (window as unknown as { webkitSpeechRecognition?: new () => SpeechRec }).webkitSpeechRecognition) : undefined;
  function listen() {
    if (!Rec) { say(t("dx_noVoice")); return; }
    const r = new Rec(); r.lang = locale === "fr" ? "fr-CA" : "en-CA"; r.interimResults = false; r.maxAlternatives = 1;
    r.onresult = (e) => { const cmd = parseVoiceCommand(e.results[0]?.[0]?.transcript ?? ""); if (cmd) { setHeard(cmd); setOpen("confirm"); } else say(t("dx_notUnderstood")); };
    r.onerror = () => say(t("dx_notUnderstood")); r.onend = () => setListening(false);
    setListening(true); r.start();
  }
  async function run(cmd: VoiceCommand) {
    setOpen(null);
    switch (cmd.action) {
      case "arrive": return actions.arrive();
      case "complete": return actions.complete();
      case "fail": return actions.fail();
      case "navigate": return actions.navigate();
      case "help": return setOpen("help");
      case "break_start": return shiftCall("/driver/shift/break", { action: "start", kind: "break" });
      case "break_end": return shiftCall("/driver/shift/break", { action: "end" });
      case "shift_end": return shiftCall("/driver/shift/end");
      case "message": { try { await post("/driver/messages", { body: cmd.text, clientId: newId() }); say(t("dx_sent")); } catch (e) { say((e as Error).message); } }
    }
  }

  const worked = shift?.active && shift.startedAt ? Math.max(0, Math.round((now - new Date(shift.startedAt).getTime()) / 60_000)) : 0;
  const needsBreak = !!shift?.active && !shift.onBreak && (shift.sinceBreakMin ?? 0) >= shift.breakAfterMin;
  const onBreakMin = shift?.onBreak && shift.breakStartedAt ? Math.max(0, Math.round((now - new Date(shift.breakStartedAt).getTime()) / 60_000)) : 0;

  return (
    <section aria-label={t("dx_title")} className="stack">
      <div className="shift-card" role="group" aria-label={t("dx_shift")}>
        {!shift ? <span className="meta">…</span> : !shift.active ? (
          <><span>{t("dx_notOnShift")}</span><button type="button" className="primary" onClick={() => void shiftCall("/driver/shift/start")}>{t("dx_startShift")}</button></>
        ) : (
          <>
            <strong aria-live="off">{shift.onBreak ? t("dx_onBreak", { min: onBreakMin }) : t("dx_onShift", { time: hm(worked) })}</strong>
            {needsBreak && <span className="pill warn" role="status">{t("dx_breakDue", { min: shift.breakMin })}</span>}
            <span className="row">
              {shift.onBreak ? <button type="button" className="primary" onClick={() => void shiftCall("/driver/shift/break", { action: "end" })}>{t("dx_endBreak")}</button> : (
                <><button type="button" onClick={() => void shiftCall("/driver/shift/break", { action: "start", kind: "break" })}>{t("dx_startBreak")}</button><button type="button" onClick={() => void shiftCall("/driver/shift/break", { action: "start", kind: "lunch" })}>{t("dx_startLunch")}</button></>
              )}
              <button type="button" className="link" onClick={() => window.confirm(t("dx_confirmEnd")) && void shiftCall("/driver/shift/end")}>{t("dx_endShift")}</button>
            </span>
          </>
        )}
      </div>
      <div className="big-actions">
        <button type="button" onClick={() => setOpen("chat")}>{t("dx_chat")}{unread > 0 ? ` (${unread})` : ""}</button>
        <button type="button" className="danger" onClick={() => setOpen("help")}>{t("dx_help")}</button>
        <button type="button" onClick={() => setOpen("expense")}>{t("dx_expense")}</button>
        <button type="button" onClick={() => setOpen("tips")}>{t("dx_tips")}</button>
        <button type="button" aria-pressed={driving} onClick={() => setDriving(true)}>{t("dx_driving")}</button>
        <button type="button" onClick={listen} disabled={listening} aria-label={t("dx_voice")}>{listening ? t("dx_listening") : t("dx_voice")}</button>
        <button type="button" aria-pressed={prefs.batterySaver} onClick={() => setPrefs({ ...prefs, batterySaver: !prefs.batterySaver })}>{t("dx_battery")}</button>
        <button type="button" aria-pressed={prefs.alerts} onClick={() => void toggleAlerts()}>{t("dx_alerts")}</button>
      </div>
      {toast && <p className="meta" role="status">{toast}</p>}
      {open === "chat" && <ChatSheet t={t} onClose={() => { setOpen(null); void refresh(); }} />}
      {open === "help" && <HelpSheet t={t} stopId={nextStop?.id ?? null} onClose={() => setOpen(null)} onDone={(m) => { setOpen(null); say(m); }} />}
      {open === "expense" && <ExpenseSheet t={t} onClose={() => setOpen(null)} onDone={(m) => { setOpen(null); say(m); }} />}
      {open === "tips" && <TipsSheet t={t} locale={locale} onClose={() => setOpen(null)} />}
      {open === "confirm" && heard && (
        <Sheet title={t("dx_confirmCommand")} t={t} onClose={() => setOpen(null)}>
          <p><strong>{t(`vc_${heard.action}` as MessageKey)}</strong>{heard.text ? `: ${heard.text}` : ""}</p>
          <div className="big-actions"><button type="button" className="primary" onClick={() => void run(heard)}>{t("confirm")}</button><button type="button" onClick={() => setOpen(null)}>{t("cancel")}</button></div>
        </Sheet>
      )}
      {driving && <DrivingMode t={t} stop={nextStop} onClose={() => setDriving(false)} actions={actions} onVoice={listen} onHelp={() => { setDriving(false); setOpen("help"); }} />}
    </section>
  );
}

interface SpeechRec { lang: string; interimResults: boolean; maxAlternatives: number; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null; onerror: (() => void) | null; onend: (() => void) | null; start: () => void }

function ChatSheet({ t, onClose }: { t: T; onClose: () => void }) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [text, setText] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [rec, setRec] = useState<MediaRecorder | null>(null);
  const end = useRef<HTMLDivElement>(null);
  const load = useCallback(() => { get<Msg[]>("/driver/messages").then(setMsgs).catch(() => {}); }, []);
  useEffect(() => { load(); const id = setInterval(load, 10_000); return () => clearInterval(id); }, [load]);
  useEffect(() => { end.current?.scrollIntoView({ block: "end" }); }, [msgs.length]);

  async function send(body: { body?: string; quickKey?: string; audioDataUrl?: string }) {
    try {
      const r = await post("/driver/messages", { ...body, clientId: newId() });
      setText(""); setNote(r.queued ? t("dx_queued") : null);
      if (!r.queued) load(); else setMsgs((m) => [...m, { id: newId(), from: "driver", body: body.body ?? t("dx_voiceNote"), quickKey: null, hasAudio: !!body.audioDataUrl, at: new Date().toISOString() }]);
    } catch (e) { setNote((e as Error).message); }
  }
  async function toggleRec() {
    if (rec) { rec.stop(); return; }
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") { setNote(t("dx_noMic")); return; }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mr = new MediaRecorder(stream, MediaRecorder.isTypeSupported("audio/webm") ? { mimeType: "audio/webm", audioBitsPerSecond: 24_000 } : undefined);
      const parts: Blob[] = [];
      mr.ondataavailable = (e) => parts.push(e.data);
      mr.onstop = async () => {
        stream.getTracks().forEach((x) => x.stop()); setRec(null);
        const blob = new Blob(parts, { type: mr.mimeType || "audio/webm" });
        const url = await toDataUrl(blob);
        if (url.length > 880_000) { setNote(t("dx_voiceTooLong")); return; }
        await send({ audioDataUrl: url });
      };
      mr.start(); setRec(mr);
      setTimeout(() => { if (mr.state === "recording") mr.stop(); }, 30_000);
    } catch { setNote(t("dx_noMic")); }
  }
  return (
    <Sheet title={t("dx_chat")} t={t} onClose={onClose}>
      <div className="chat" aria-live="polite" style={{ display: "grid", gap: 6, maxHeight: "40vh", overflow: "auto" }}>
        {msgs.length === 0 && <p className="meta">{t("dx_noMessages")}</p>}
        {msgs.map((m) => <div key={m.id} className={`bubble ${m.from === "driver" ? "me" : ""}`} style={{ justifySelf: m.from === "driver" ? "end" : "start", maxWidth: "85%", padding: "8px 12px", borderRadius: 12, background: m.from === "driver" ? "var(--brand)" : "var(--surface-2, #eee)", color: m.from === "driver" ? "var(--brand-fg)" : "inherit" }}>{m.body || (m.hasAudio ? t("dx_voiceNote") : "")}</div>)}
        <div ref={end} />
      </div>
      <div className="quick" role="group" aria-label={t("dx_quick")} style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
        {QUICK.map((k) => <button key={k} type="button" onClick={() => void send({ body: t(`qr_${k}` as MessageKey), quickKey: k })}>{t(`qr_${k}` as MessageKey)}</button>)}
      </div>
      <form className="row" onSubmit={(e) => { e.preventDefault(); if (text.trim()) void send({ body: text.trim() }); }}>
        <input value={text} maxLength={1000} onChange={(e) => setText(e.target.value)} aria-label={t("ib_write")} placeholder={t("ib_write")} style={{ flex: 1 }} />
        <button type="submit" className="primary" disabled={!text.trim()}>{t("ib_send")}</button>
        <button type="button" onClick={() => void toggleRec()} aria-pressed={!!rec}>{rec ? t("dx_stopRec") : t("dx_record")}</button>
      </form>
      {note && <p className="meta" role="status">{note}</p>}
    </Sheet>
  );
}

function HelpSheet({ t, stopId, onClose, onDone }: { t: T; stopId: string | null; onClose: () => void; onDone: (m: string) => void }) {
  const [kind, setKind] = useState<string>("breakdown");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  return (
    <Sheet title={t("dx_help")} t={t} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try { const where = await here(); const r = await post("/driver/help", { kind, note: note || undefined, stopId: stopId ?? undefined, clientId: newId(), ...(where ?? {}) }); onDone(r.queued ? t("dx_helpQueued") : t("dx_helpSent")); }
        catch (x) { setErr((x as Error).message); setBusy(false); }
      }}>
        <p className="meta">{t("dx_helpExplain")}</p>
        <div className="stack" role="radiogroup" aria-label={t("dx_help")}>
          {HELP_KINDS.map((k) => <label key={k} className="row"><input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />{t(`hk_${k}` as MessageKey)}</label>)}
        </div>
        <label className="field">{t("f_notes")}<input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} /></label>
        {err && <p className="error" role="alert">{err}</p>}
        <button type="submit" className="primary" disabled={busy}>{t("dx_sendHelp")}</button>
      </form>
    </Sheet>
  );
}

function ExpenseSheet({ t, onClose, onDone }: { t: T; onClose: () => void; onDone: (m: string) => void }) {
  const [f, setF] = useState({ kind: "fuel", amount: "", tax: "", vendor: "", litres: "", note: "" });
  const [receipt, setReceipt] = useState<string | null>(null);
  const [vehicle, setVehicle] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => { get<{ id: string } | null>("/driver/vehicle").then((v) => setVehicle(v?.id ?? null)).catch(() => {}); }, []);
  return (
    <Sheet title={t("dx_expense")} t={t} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault(); setBusy(true); setErr(null);
        try {
          const r = await post<{ needsApproval?: boolean }>("/driver/expenses", { ...f, vehicleId: vehicle ?? undefined, receiptDataUrl: receipt ?? undefined, clientId: newId() });
          onDone(r.queued ? t("dx_expenseQueued") : r.data?.needsApproval ? t("dx_expenseApproval") : t("dx_expenseSaved"));
        } catch (x) { setErr((x as Error).message); setBusy(false); }
      }}>
        <label className="field">{t("f_kind")}<select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>{EXPENSE_KINDS.map((k) => <option key={k} value={k}>{t(`ex_k_${k}` as MessageKey)}</option>)}</select></label>
        <div className="row"><label className="field">{t("ex_amount")}<input type="number" inputMode="decimal" step="0.01" min="0.01" required value={f.amount} onChange={(e) => setF({ ...f, amount: e.target.value })} /></label><label className="field">{t("ex_taxField")}<input type="number" inputMode="decimal" step="0.01" min="0" value={f.tax} onChange={(e) => setF({ ...f, tax: e.target.value })} /></label></div>
        {f.kind === "fuel" && <label className="field">{t("f_litres")}<input type="number" inputMode="decimal" step="0.01" min="0" value={f.litres} onChange={(e) => setF({ ...f, litres: e.target.value })} /></label>}
        <label className="field">{t("f_vendor")}<input value={f.vendor} maxLength={120} onChange={(e) => setF({ ...f, vendor: e.target.value })} /></label>
        <label className="field">{t("ex_receipt")}<input type="file" accept="image/*" capture="environment" onChange={async (e) => { const file = e.target.files?.[0]; if (file) setReceipt(await toDataUrl(await downscaleImage(file, 1000, 0.7))); }} /></label>
        {receipt && /* eslint-disable-next-line @next/next/no-img-element */ <img src={receipt} alt={t("ex_receipt")} className="proof-preview" />}
        {err && <p className="error" role="alert">{err}</p>}
        <button type="submit" className="primary" disabled={busy || !f.amount}>{t("confirm")}</button>
      </form>
    </Sheet>
  );
}

function TipsSheet({ t, locale, onClose }: { t: T; locale: string; onClose: () => void }) {
  const [items, setItems] = useState<Training[] | null>(null);
  useEffect(() => { get<Training[]>(`/driver/training?lang=${locale}`).then(setItems).catch(() => setItems([])); }, [locale]);
  return (
    <Sheet title={t("dx_tips")} t={t} onClose={onClose}>
      {!items ? <p className="meta">…</p> : items.length === 0 ? <p className="meta">{t("dx_noTips")}</p> : items.map((i) => (
        <article key={i.id} className="stack"><strong>{i.title}</strong>{i.body && <p style={{ whiteSpace: "pre-wrap" }}>{i.body}</p>}{i.videoUrl && <a href={i.videoUrl} target="_blank" rel="noreferrer">{t("dx_watch")}</a>}</article>
      ))}
    </Sheet>
  );
}

/** A plain, large screen for when the truck is moving: the next stop, one-tap navigation and the few things a driver needs. */
function DrivingMode({ t, stop, onClose, actions, onVoice, onHelp }: { t: T; stop: { name: string; address?: string | null } | null; onClose: () => void; actions: DriverActions; onVoice: () => void; onHelp: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  return (
    <dialog ref={ref} className="sheet driving" onClose={onClose} aria-label={t("dx_driving")} style={{ width: "100%", maxWidth: "100%", minHeight: "100dvh", background: "#0b1019", color: "#fff", display: "grid", alignContent: "center", gap: 16, textAlign: "center" }}>
      <p style={{ opacity: 0.7, margin: 0 }}>{t("nextStop")}</p>
      <h2 style={{ fontSize: "2rem", margin: 0 }}>{stop?.name ?? t("noRouteToday")}</h2>
      {stop?.address && <p style={{ fontSize: "1.25rem", margin: 0 }}>{stop.address}</p>}
      <button type="button" className="primary" style={{ minHeight: 72, fontSize: "1.4rem" }} onClick={actions.navigate} disabled={!stop}>{t("navigate")}</button>
      <div className="row" style={{ justifyContent: "center", gap: 12 }}>
        <button type="button" style={{ minHeight: 64, minWidth: 140, fontSize: "1.1rem" }} onClick={onVoice}>{t("dx_voice")}</button>
        <button type="button" style={{ minHeight: 64, minWidth: 140, fontSize: "1.1rem" }} onClick={onHelp}>{t("dx_help")}</button>
      </div>
      <button type="button" className="link" style={{ color: "#fff" }} onClick={() => ref.current?.close()}>{t("closeSheet")}</button>
      <p style={{ opacity: 0.6, fontSize: 13 }}>{t("dx_drivingNote")}</p>
    </dialog>
  );
}
