"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { MessageKey } from "@routenorth/shared";
import { Sheet } from "@/components/DriverSheet";
import { driverGet, driverPost } from "@/components/DriverMore";
import { useI18n } from "@/lib/i18n-context";

type T = (k: MessageKey, v?: Record<string, string | number>) => string;
const PREF = "routenorth.driver.safety";
const newId = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
const here = (): Promise<{ lat: number; lng: number } | null> => new Promise((ok) => {
  if (!navigator.geolocation) return ok(null);
  navigator.geolocation.getCurrentPosition((p) => ok({ lat: p.coords.latitude, lng: p.coords.longitude }), () => ok(null), { timeout: 4000, maximumAge: 60_000 });
});

/** A hard jolt: total acceleration (gravity included) of about 4 g for a moment. Phones differ, so this is a prompt to ask "are you OK?", never an alarm by itself. */
export const CRASH_G = 4 * 9.81;
export const jolt = (a: { x?: number | null; y?: number | null; z?: number | null }) => Math.hypot(a.x ?? 0, a.y ?? 0, a.z ?? 0);

interface Fatigue { onShift: boolean; level?: "ok" | "soon" | "now"; sinceBreakMin?: number; shiftMin?: number }
interface Tips { enabled: boolean; km?: number; score?: number | null; tips: { key: string; value?: number }[] }
interface Board { enabled: boolean; rows: { rank: number; score: number; you: boolean; name: string | null; badges: string[] }[] }
interface Checkin { active: { id: string; everyMin: number; lastOkAt: string } | null }

/** Safety tools for the driver: SOS, crash check, hours warning, tips after a trip, lone-worker check-ins, ranking and bonuses. */
export function DriverSafety() {
  const { t } = useI18n() as { t: T };
  const [open, setOpen] = useState<null | "sos" | "crash" | "rank" | "checkin">(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [fatigue, setFatigue] = useState<Fatigue | null>(null);
  const [tips, setTips] = useState<Tips | null>(null);
  const [check, setCheck] = useState<Checkin["active"]>(null);
  const [crashOn, setCrashOn] = useState(false);
  const [count, setCount] = useState(30);
  const [now, setNow] = useState(() => Date.now());
  const lastJolt = useRef(0);
  const say = (m: string) => { setMsg(m); setTimeout(() => setMsg(null), 6000); };

  const load = useCallback(async () => {
    try {
      setFatigue(await driverGet<Fatigue>("/safety/my-fatigue"));
      setTips(await driverGet<Tips>("/safety/my-tips"));
      setCheck((await driverGet<Checkin>("/safety/checkins/mine")).active);
    } catch { /* offline: keep what we have */ }
  }, []);
  useEffect(() => { try { setCrashOn(localStorage.getItem(PREF) === "crash"); } catch { /* optional */ } void load(); const id = setInterval(() => { setNow(Date.now()); if (!document.hidden) void load(); }, 120_000); return () => clearInterval(id); }, [load]);
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 15_000); return () => clearInterval(id); }, []);

  async function sendSos() {
    const where = await here();
    try { const r = await driverPost("/driver/help", { kind: "sos", note: "SOS", clientId: newId(), ...(where ?? {}) }); say(r.queued ? t("sf_d_queued") : t("sf_d_sosSent")); setOpen(null); }
    catch (e) { say((e as Error).message); }
  }
  async function sendCrash() {
    const where = await here();
    try { await driverPost("/safety/crash", { source: "phone", clientId: newId(), ...(where ?? {}) }); say(t("sf_d_crashSent")); } catch (e) { say((e as Error).message); }
    setOpen(null);
  }

  // Crash check: ask first, and tell the office only if the driver does not answer.
  useEffect(() => {
    if (!crashOn || typeof window === "undefined" || !("DeviceMotionEvent" in window)) return;
    const onMotion = (e: DeviceMotionEvent) => {
      const g = e.accelerationIncludingGravity;
      if (!g || jolt(g) < CRASH_G || Date.now() - lastJolt.current < 120_000) return;
      lastJolt.current = Date.now(); setCount(30); setOpen("crash");
    };
    window.addEventListener("devicemotion", onMotion);
    return () => window.removeEventListener("devicemotion", onMotion);
  }, [crashOn]);
  useEffect(() => {
    if (open !== "crash") return;
    if (count <= 0) { void sendCrash(); return; }
    const id = setTimeout(() => setCount((c) => c - 1), 1000);
    return () => clearTimeout(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, count]);

  async function toggleCrash() {
    if (crashOn) { setCrashOn(false); try { localStorage.removeItem(PREF); } catch { /* optional */ } return; }
    const DME = (window as unknown as { DeviceMotionEvent?: { requestPermission?: () => Promise<string> } }).DeviceMotionEvent;
    if (!("DeviceMotionEvent" in window)) { say(t("sf_d_noSensor")); return; }
    if (DME?.requestPermission && (await DME.requestPermission()) !== "granted") { say(t("sf_d_noSensor")); return; }
    setCrashOn(true); try { localStorage.setItem(PREF, "crash"); } catch { /* optional */ }
  }

  async function startCheckin(everyMin: number) {
    try { const where = await here(); const r = await driverPost<Checkin["active"]>("/safety/checkins/start", { everyMin, ...(where ?? {}) }); if (r.data) setCheck(r.data); setOpen(null); } catch (e) { say((e as Error).message); }
  }
  async function imOk() { try { const where = await here(); await driverPost("/safety/checkins/ok", where ?? {}); await load(); say(t("sf_d_thanks")); } catch (e) { say((e as Error).message); } }
  async function endCheckin() { try { await driverPost("/safety/checkins/end", {}); setCheck(null); } catch (e) { say((e as Error).message); } }

  const dueIn = check ? Math.round((new Date(check.lastOkAt).getTime() + check.everyMin * 60000 - now) / 60000) : null;

  return (
    <section className="card" aria-label={t("sf_d_title")} style={{ marginTop: "var(--s4)" }}>
      <h2>{t("sf_d_title")}</h2>
      {fatigue?.onShift && fatigue.level && fatigue.level !== "ok" && <p role="alert" className="banner warn">{t(fatigue.level === "now" ? "sf_d_fatigueNow" : "sf_d_fatigueSoon", { h: Math.round(((fatigue.sinceBreakMin ?? 0) / 60) * 10) / 10 })}</p>}
      {check && dueIn != null && dueIn <= 1 && <p role="alert" className="banner warn">{t("sf_d_checkNow")}</p>}
      <div className="row" style={{ flexWrap: "wrap", gap: "var(--s2)" }}>
        <button type="button" className="btn danger" style={{ minHeight: 48 }} onClick={() => setOpen("sos")}>{t("sf_d_sos")}</button>
        {check ? <button type="button" className="btn" style={{ minHeight: 48 }} onClick={() => void imOk()}>{t("sf_d_imOk")}{dueIn != null ? ` · ${dueIn > 0 ? t("sf_d_inMin", { n: dueIn }) : t("sf_d_due")}` : ""}</button> : <button type="button" className="btn" style={{ minHeight: 48 }} onClick={() => setOpen("checkin")}>{t("sf_d_startCheck")}</button>}
        {check && <button type="button" className="btn" onClick={() => void endCheckin()}>{t("sf_d_endCheck")}</button>}
        <button type="button" className="btn" onClick={() => setOpen("rank")}>{t("sf_d_rank")}</button>
        <label className="check"><input type="checkbox" checked={crashOn} onChange={() => void toggleCrash()} /> {t("sf_d_crashCheck")}</label>
      </div>
      {tips?.enabled && tips.tips.length > 0 && (
        <div style={{ marginTop: "var(--s3)" }}>
          <strong>{t("sf_d_tipsTitle")}{tips.score != null ? ` · ${tips.score}` : ""}</strong>
          <ul>{tips.tips.map((x) => <li key={x.key}>{t(`sf_${x.key}` as MessageKey, { n: x.value ?? 0 })}</li>)}</ul>
        </div>
      )}
      {msg && <p role="status" className="meta">{msg}</p>}

      {open === "sos" && (
        <Sheet title={t("sf_d_sosTitle")} t={t as never} onClose={() => setOpen(null)}>
          <p>{t("sf_d_sosBody")}</p>
          <button type="button" className="btn danger" style={{ minHeight: 56, width: "100%" }} onClick={() => void sendSos()}>{t("sf_d_sosSend")}</button>
        </Sheet>
      )}
      {open === "crash" && (
        <Sheet title={t("sf_d_crashTitle")} t={t as never} onClose={() => setOpen(null)}>
          <p>{t("sf_d_crashBody", { n: count })}</p>
          <button type="button" className="btn primary" style={{ minHeight: 56, width: "100%" }} onClick={() => setOpen(null)}>{t("sf_d_imFine")}</button>
          <button type="button" className="btn danger" style={{ minHeight: 48, width: "100%", marginTop: 8 }} onClick={() => void sendCrash()}>{t("sf_d_needHelp")}</button>
        </Sheet>
      )}
      {open === "checkin" && (
        <Sheet title={t("sf_d_startCheck")} t={t as never} onClose={() => setOpen(null)}>
          <p>{t("sf_d_checkBody")}</p>
          {[15, 30, 60].map((m) => <button key={m} type="button" className="btn" style={{ minHeight: 48, width: "100%", marginBottom: 8 }} onClick={() => void startCheckin(m)}>{t("sf_d_every", { n: m })}</button>)}
        </Sheet>
      )}
      {open === "rank" && <RankSheet onClose={() => setOpen(null)} />}
    </section>
  );
}

function RankSheet({ onClose }: { onClose: () => void }) {
  const { t } = useI18n() as { t: T };
  const [board, setBoard] = useState<Board | null>(null);
  const [rewards, setRewards] = useState<{ rewards: { rule: string; periodEnd: string; amount: number; status: string }[]; total: number } | null>(null);
  useEffect(() => { void driverGet<Board>("/safety/leaderboard").then(setBoard).catch(() => setBoard({ enabled: false, rows: [] })); void driverGet<NonNullable<typeof rewards>>("/safety/my-rewards").then(setRewards).catch(() => {}); }, []);
  return (
    <Sheet title={t("sf_d_rank")} t={t as never} onClose={onClose}>
      <h3>{t("sf_d_bonuses")}</h3>
      {!rewards || rewards.rewards.length === 0 ? <p className="meta">{t("sf_d_noBonuses")}</p> : <ul>{rewards.rewards.map((r, i) => <li key={i}>{r.rule} · {r.amount.toLocaleString(undefined, { style: "currency", currency: "CAD" })} <span className="meta">({t(`sf_r_${r.status}` as MessageKey)})</span></li>)}</ul>}
      <h3>{t("sf_d_ranking")}</h3>
      {!board?.enabled ? <p className="meta">{t("sf_d_boardOff")}</p> : board.rows.length === 0 ? <p className="meta">{t("sf_d_boardEmpty")}</p> : (
        <ol>{board.rows.map((r) => <li key={r.rank} aria-current={r.you ? "true" : undefined}>{r.you ? <strong>{t("sf_d_you")}</strong> : (r.name ?? `#${r.rank}`)} · {r.score}{r.badges.length > 0 && ` · ${r.badges.map((b) => t(`sf_badge_${b}` as MessageKey)).join(", ")}`}</li>)}</ol>
      )}
    </Sheet>
  );
}
