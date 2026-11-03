"use client";
import type { MessageKey } from "@routenorth/shared";
import { useState } from "react";
import { Chip, EmptyState, ErrorState, PageHead, SkeletonList, TabDef, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

const n = (x: number | null | undefined) => (x == null ? "–" : String(x));
const scoreTone = (s: number | null) => (s == null ? undefined : s >= 85 ? "ok" : s >= 65 ? "warn" : "danger") as "ok" | "warn" | "danger" | undefined;

function Scores() {
  const { t, locale } = useI18n();
  const s = useApi<{ cornering: boolean; drivers: { driverId: string; name: string; km: number; score: number | null; speeding: number; harshBrakes: number; harshAccels: number; corners: number | null; incidents: number }[] }>("/safety/scores");
  const ev = useApi<{ events: { kind: string; time: string; vehicle: string; value: number; clips: { id: string; url: string }[] }[] }>("/safety/events");
  const when = (iso: string) => new Date(iso).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" });
  return (
    <div className="stack">
      <p className="meta small">{t("sf_scoreNote")}</p>
      {s.error ? <ErrorState error={s.error} onRetry={s.reload} /> : !s.loaded ? <SkeletonList rows={4} /> : s.data!.drivers.length === 0 ? <EmptyState title={t("sf_noScores")} body={t("sf_noScoresBody")} /> : (
        <table className="ptable">
          <thead><tr><th>{t("f_driver")}</th><th className="tnum">km</th><th className="tnum">{t("sf_score")}</th><th className="tnum">{t("sf_speeding")}</th><th className="tnum">{t("sf_brakes")}</th><th className="tnum">{t("sf_accel")}</th><th className="tnum">{t("sf_corners")}</th><th className="tnum">{t("sf_incidents")}</th></tr></thead>
          <tbody>{s.data!.drivers.map((d) => <tr key={d.driverId}><td>{d.name}</td><td className="tnum">{d.km}</td><td className="tnum">{d.score == null ? "–" : <Chip tone={scoreTone(d.score)}>{d.score}</Chip>}</td><td className="tnum">{d.speeding}</td><td className="tnum">{d.harshBrakes}</td><td className="tnum">{d.harshAccels}</td><td className="tnum">{n(d.corners)}</td><td className="tnum">{d.incidents}</td></tr>)}</tbody>
        </table>
      )}
      <p className="meta small">{t("sf_phoneNote")}</p>
      <h2>{t("sf_events")}</h2>
      {ev.error ? <ErrorState error={ev.error} onRetry={ev.reload} /> : !ev.loaded ? <SkeletonList rows={3} /> : ev.data!.events.length === 0 ? <EmptyState title={t("sf_noEvents")} /> : (
        <table className="ptable">
          <thead><tr><th>{t("f_when")}</th><th>{t("f_vehicle")}</th><th>{t("sf_event")}</th><th>{t("sf_clip")}</th></tr></thead>
          <tbody>{ev.data!.events.slice(0, 50).map((e, i) => <tr key={i}><td>{when(e.time)}</td><td>{e.vehicle}</td><td>{t(`sf_ev_${e.kind}` as MessageKey)}</td><td>{e.clips.length ? e.clips.map((c) => <a key={c.id} href={c.url} target="_blank" rel="noreferrer noopener">{t("sf_watch")}</a>) : "–"}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}

function Live() {
  const { t, locale } = useI18n();
  const f = useApi<{ drivers: { driverId: string; name: string; level: string; sinceBreakMin: number; shiftMin: number }[] }>("/safety/fatigue", { intervalMs: 60_000 });
  const c = useApi<{ graceMin: number; active: { id: string; name: string; everyMin: number; lastOkAt: string; dueAt: string; missed: boolean; note: string | null }[] }>("/safety/checkins", { intervalMs: 30_000 });
  const h = (m: number) => `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
  const time = (iso: string) => new Date(iso).toLocaleTimeString(locale === "fr" ? "fr-CA" : "en-CA", { timeStyle: "short" });
  return (
    <div className="stack">
      <h2>{t("sf_hours")}</h2>
      {f.error ? <ErrorState error={f.error} onRetry={f.reload} /> : !f.loaded ? <SkeletonList rows={2} /> : f.data!.drivers.length === 0 ? <EmptyState title={t("sf_noOnShift")} /> : (
        <table className="ptable"><thead><tr><th>{t("f_driver")}</th><th className="tnum">{t("sf_onShift")}</th><th className="tnum">{t("sf_sinceBreak")}</th><th>{t("sf_level")}</th></tr></thead>
          <tbody>{f.data!.drivers.map((d) => <tr key={d.driverId}><td>{d.name}</td><td className="tnum">{h(d.shiftMin)}</td><td className="tnum">{h(d.sinceBreakMin)}</td><td><Chip tone={d.level === "now" ? "danger" : d.level === "soon" ? "warn" : "ok"}>{t(`sf_lvl_${d.level}` as MessageKey)}</Chip></td></tr>)}</tbody></table>
      )}
      <h2>{t("sf_checkins")}</h2>
      <p className="meta small">{t("sf_checkinsNote")}</p>
      {c.error ? <ErrorState error={c.error} onRetry={c.reload} /> : !c.loaded ? <SkeletonList rows={2} /> : c.data!.active.length === 0 ? <EmptyState title={t("sf_noCheckins")} /> : (
        <table className="ptable"><thead><tr><th>{t("sf_person")}</th><th className="tnum">{t("sf_every")}</th><th>{t("sf_lastOk")}</th><th>{t("sf_status")}</th></tr></thead>
          <tbody>{c.data!.active.map((k) => <tr key={k.id}><td>{k.name}{k.note && <div className="meta small">{k.note}</div>}</td><td className="tnum">{k.everyMin} {t("ai_min")}</td><td>{time(k.lastOkAt)}</td><td>{k.missed ? <Chip tone="danger">{t("sf_missed")}</Chip> : <Chip tone="ok">{t("sf_ok")}</Chip>}</td></tr>)}</tbody></table>
      )}
    </div>
  );
}

function Rewards() {
  const { t } = useI18n(); const { toast } = useToast(); const { can } = useMe();
  const rules = useApi<{ id: string; name: string; metric: string; op: string; target: number; bonus: number; period: string; active: boolean }[]>("/safety/reward-rules");
  const list = useApi<{ id: string; driverName: string; rule: string; periodStart: string; periodEnd: string; amount: number; status: string }[]>("/safety/rewards");
  const [f, setF] = useState({ name: "", metric: "driverScore", op: "gte", target: "90", bonus: "50", period: "month" });
  const manage = can("reports.manage");
  const money = (x: number) => x.toLocaleString(undefined, { style: "currency", currency: "CAD" });
  async function add() { try { await apiSend("POST", "/safety/reward-rules", { ...f, target: Number(f.target), bonus: Number(f.bonus) }); setF({ ...f, name: "" }); rules.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function run() { try { const r = await apiSend<{ earned: number }>("POST", "/safety/rewards/run", {}); toast(t("sf_earnedToast", { n: r.earned })); list.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function mark(id: string, status: string) { try { await apiSend("PATCH", `/safety/rewards/${id}`, { status }); list.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function toggle(id: string, active: boolean) { try { await apiSend("PATCH", `/safety/reward-rules/${id}`, { active }); rules.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function del(id: string) { try { await apiSend("DELETE", `/safety/reward-rules/${id}`); rules.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  return (
    <div className="stack">
      <p className="meta small">{t("sf_rewardsNote")}</p>
      <h2>{t("sf_rules")}</h2>
      {rules.error ? <ErrorState error={rules.error} onRetry={rules.reload} /> : !rules.loaded ? <SkeletonList rows={2} /> : rules.data!.length === 0 ? <EmptyState title={t("sf_noRules")} body={t("sf_noRulesBody")} /> : (
        <table className="ptable"><thead><tr><th>{t("sf_rule")}</th><th>{t("sf_when")}</th><th className="tnum">{t("sf_bonus")}</th><th /></tr></thead>
          <tbody>{rules.data!.map((r) => <tr key={r.id}><td>{r.name}{!r.active && <> <Chip>{t("sf_off")}</Chip></>}</td><td>{t(`sf_m_${r.metric}` as MessageKey)} {r.op === "gte" ? "≥" : "≤"} {r.target} / {t(`sf_p_${r.period}` as MessageKey)}</td><td className="tnum">{money(r.bonus)}</td>
            <td>{manage && <><button className="btn" onClick={() => void toggle(r.id, !r.active)}>{r.active ? t("sf_pause") : t("sf_resume")}</button> <button className="btn" onClick={() => void del(r.id)}>{t("delete")}</button></>}</td></tr>)}</tbody></table>
      )}
      {manage && (
        <div className="card" style={{ padding: "var(--s3) var(--s4)" }}>
          <div className="grid2">
            <label>{t("sf_rule")}<input value={f.name} maxLength={80} onChange={(e) => setF({ ...f, name: e.target.value })} /></label>
            <label>{t("sf_measure")}<select value={f.metric} onChange={(e) => setF({ ...f, metric: e.target.value })}>{["driverScore", "onTimeRate", "stopsDone", "csat", "speedingEvents", "harshBrakes"].map((m) => <option key={m} value={m}>{t(`sf_m_${m}` as MessageKey)}</option>)}</select></label>
            <label>{t("sf_op")}<select value={f.op} onChange={(e) => setF({ ...f, op: e.target.value })}><option value="gte">≥</option><option value="lte">≤</option></select></label>
            <label>{t("sf_target")}<input type="number" value={f.target} onChange={(e) => setF({ ...f, target: e.target.value })} /></label>
            <label>{t("sf_bonus")}<input type="number" min={0} value={f.bonus} onChange={(e) => setF({ ...f, bonus: e.target.value })} /></label>
            <label>{t("sf_period")}<select value={f.period} onChange={(e) => setF({ ...f, period: e.target.value })}><option value="week">{t("sf_p_week")}</option><option value="month">{t("sf_p_month")}</option></select></label>
          </div>
          <button className="btn primary" disabled={!f.name.trim()} onClick={() => void add()}>{t("sf_addRule")}</button>
        </div>
      )}
      <h2>{t("sf_earned")}</h2>
      {manage && <button className="btn" onClick={() => void run()}>{t("sf_calculate")}</button>}
      {list.error ? <ErrorState error={list.error} onRetry={list.reload} /> : !list.loaded ? <SkeletonList rows={2} /> : list.data!.length === 0 ? <EmptyState title={t("sf_noRewards")} /> : (
        <table className="ptable"><thead><tr><th>{t("f_driver")}</th><th>{t("sf_rule")}</th><th>{t("sf_periodCol")}</th><th className="tnum">{t("sf_bonus")}</th><th>{t("sf_status")}</th><th /></tr></thead>
          <tbody>{list.data!.map((r) => <tr key={r.id}><td>{r.driverName}</td><td>{r.rule}</td><td>{r.periodStart} → {r.periodEnd}</td><td className="tnum">{money(r.amount)}</td><td><Chip tone={r.status === "paid" ? "ok" : r.status === "void" ? undefined : "info"}>{t(`sf_r_${r.status}` as MessageKey)}</Chip></td>
            <td>{manage && r.status === "earned" && <><button className="btn" onClick={() => void mark(r.id, "paid")}>{t("sf_markPaid")}</button> <button className="btn" onClick={() => void mark(r.id, "void")}>{t("sf_void")}</button></>}</td></tr>)}</tbody></table>
      )}
    </div>
  );
}

function Clips() {
  const { t, locale } = useI18n(); const { toast } = useToast(); const { can } = useMe();
  const clips = useApi<{ id: string; vehicle: string | null; eventKind: string; eventAt: string; url: string; note: string | null }[]>("/safety/clips");
  const vehicles = useApi<{ id: string; name: string }[]>("/r/vehicles");
  const [f, setF] = useState({ vehicleId: "", eventKind: "speeding", eventAt: "", url: "", note: "" });
  async function add() { try { await apiSend("POST", "/safety/clips", { ...f, vehicleId: f.vehicleId || undefined, eventAt: new Date(f.eventAt).toISOString() }); setF({ ...f, url: "", note: "" }); clips.reload(); toast(t("sf_clipAdded")); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function del(id: string) { try { await apiSend("DELETE", `/safety/clips/${id}`); clips.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  return (
    <div className="stack">
      <p className="meta small">{t("sf_clipsNote")}</p>
      {can("fleet.manage") && (
        <div className="card" style={{ padding: "var(--s3) var(--s4)" }}>
          <div className="grid2">
            <label>{t("f_vehicle")}<select value={f.vehicleId} onChange={(e) => setF({ ...f, vehicleId: e.target.value })}><option value="">–</option>{(vehicles.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
            <label>{t("sf_event")}<select value={f.eventKind} onChange={(e) => setF({ ...f, eventKind: e.target.value })}>{["speeding", "harsh_brake", "harsh_accel", "harsh_corner", "crash", "sos", "incident", "other"].map((k) => <option key={k} value={k}>{t(`sf_ev_${k}` as MessageKey)}</option>)}</select></label>
            <label>{t("f_when")}<input type="datetime-local" value={f.eventAt} onChange={(e) => setF({ ...f, eventAt: e.target.value })} /></label>
            <label>{t("sf_clipUrl")}<input type="url" placeholder="https://" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} /></label>
            <label>{t("sf_note")}<input value={f.note} maxLength={500} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>
          </div>
          <button className="btn primary" disabled={!f.url.startsWith("https://") || !f.eventAt} onClick={() => void add()}>{t("sf_addClip")}</button>
        </div>
      )}
      {clips.error ? <ErrorState error={clips.error} onRetry={clips.reload} /> : !clips.loaded ? <SkeletonList rows={2} /> : clips.data!.length === 0 ? <EmptyState title={t("sf_noClips")} /> : (
        <table className="ptable"><thead><tr><th>{t("f_when")}</th><th>{t("f_vehicle")}</th><th>{t("sf_event")}</th><th>{t("sf_clip")}</th><th /></tr></thead>
          <tbody>{clips.data!.map((c) => <tr key={c.id}><td>{new Date(c.eventAt).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA", { dateStyle: "short", timeStyle: "short" })}</td><td>{c.vehicle ?? "–"}</td><td>{t(`sf_ev_${c.eventKind}` as MessageKey)}{c.note && <div className="meta small">{c.note}</div>}</td><td><a href={c.url} target="_blank" rel="noreferrer noopener">{t("sf_watch")}</a></td><td>{can("fleet.manage") && <button className="btn" onClick={() => void del(c.id)}>{t("delete")}</button>}</td></tr>)}</tbody></table>
      )}
    </div>
  );
}

function Settings() {
  const { t } = useI18n(); const { toast } = useToast(); const { can } = useMe();
  const org = useApi<{ settings: { safety: Record<string, number | boolean> } }>("/org");
  const [draft, setDraft] = useState<Record<string, number | boolean>>({});
  if (!can("settings.manage")) return <EmptyState title={t("sf_adminOnly")} />;
  if (org.error) return <ErrorState error={org.error} onRetry={org.reload} />;
  if (!org.loaded) return <SkeletonList rows={3} />;
  const s = { ...org.data!.settings.safety, ...draft };
  async function save() { try { await apiSend("PUT", "/org", { settings: { safety: draft } }); setDraft({}); org.reload(); toast(t("sf_saved")); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  const sw = (k: string, label: MessageKey) => <label className="row"><input type="checkbox" checked={Boolean(s[k])} onChange={(e) => setDraft({ ...draft, [k]: e.target.checked })} /> {t(label)}</label>;
  const nf = (k: string, label: MessageKey, min: number, max: number) => <label>{t(label)}<input type="number" min={min} max={max} value={Number(s[k])} onChange={(e) => setDraft({ ...draft, [k]: Number(e.target.value) })} /></label>;
  return (
    <div className="stack">
      {sw("coaching", "sf_set_coaching")}{sw("leaderboard", "sf_set_leaderboard")}{sw("anonymous", "sf_set_anonymous")}{sw("crashDetection", "sf_set_crash")}
      <div className="grid2">{nf("fatigueWarnMin", "sf_set_warnBreak", 30, 720)}{nf("fatigueStopMin", "sf_set_stopBreak", 30, 900)}{nf("shiftWarnMin", "sf_set_warnShift", 60, 1200)}{nf("shiftMaxMin", "sf_set_maxShift", 60, 1440)}{nf("checkinGraceMin", "sf_set_grace", 1, 120)}</div>
      <p className="meta small">{t("sf_set_note")}</p>
      <button className="btn primary" disabled={Object.keys(draft).length === 0} onClick={() => void save()}>{t("save")}</button>
    </div>
  );
}

export default function SafetyPage() {
  const { t } = useI18n(); const { can } = useMe();
  const [tab, setTab] = useState("scores");
  const tabs: TabDef[] = ["scores", "live", "rewards", "clips", ...(can("settings.manage") ? ["settings"] : [])].map((id) => ({ id, label: t(`sf_tab_${id}` as MessageKey) }));
  return (
    <div className="content">
      <PageHead title={t("navSafety")} subtitle={t("sf_subtitle")} />
      <Tabs tabs={tabs} value={tab} onChange={setTab} label={t("navSafety")} />
      <div role="tabpanel" style={{ marginTop: "var(--s4)" }}>
        {tab === "scores" && <Scores />}{tab === "live" && <Live />}{tab === "rewards" && <Rewards />}{tab === "clips" && <Clips />}{tab === "settings" && <Settings />}
      </div>
    </div>
  );
}
