"use client";
import type { MessageKey } from "@routenorth/shared";
import { AlertTriangle, ChevronLeft, ChevronRight, Plus } from "lucide-react";
import { useState } from "react";
import { Chip, EmptyState, ErrorState, Modal, PageHead, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { addDays, isoDay, localeTag, weekStart } from "@/lib/money";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Plan { id: string; driverId: string; driver: string; startsAt: string; endsAt: string; vehicle: string | null; note: string | null }
interface Off { id: string; userId: string; person: string; kind: string; startsOn: string; endsOn: string; status: string; note: string | null }
interface Sched { drivers: { id: string; name: string }[]; plans: Plan[]; timeOff: Off[]; conflicts: { planId: string; kind: string; withId: string }[] }

const hhmm = (iso: string, loc: string) => new Date(iso).toLocaleTimeString(localeTag(loc), { hour: "2-digit", minute: "2-digit" });

export default function SchedulePage() {
  const { t, locale } = useI18n(); const { toast } = useToast(); const { can, me } = useMe();
  const today = isoDay(new Date());
  const [from, setFrom] = useState(weekStart(today));
  const to = addDays(from, 6);
  const s = useApi<Sched>(can("routes.view") ? `/schedule?from=${from}&to=${to}` : null);
  const vehicles = useApi<{ id: string; name: string }[]>(can("routes.dispatch") ? "/r/vehicles" : null);
  const [shift, setShift] = useState<{ driverId: string; date: string; start: string; end: string; vehicleId: string; note: string } | null>(null);
  const [off, setOff] = useState<{ userId: string; kind: string; startsOn: string; endsOn: string; note: string } | null>(null);
  const days = Array.from({ length: 7 }, (_, i) => addDays(from, i));
  const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString(localeTag(locale), { weekday: "short", day: "numeric" });
  if (!can("routes.view")) return <div className="content"><ErrorState forbidden /></div>;
  const clash = new Set((s.data?.conflicts ?? []).filter((c) => c.kind === "overlap" || c.kind === "time_off").map((c) => c.planId));
  const pending = (s.data?.timeOff ?? []).filter((o) => o.status === "pending");

  async function addShift() {
    if (!shift) return;
    try {
      await apiSend("POST", "/r/shift-plans", { driverId: shift.driverId, startsAt: new Date(`${shift.date}T${shift.start}`).toISOString(), endsAt: new Date(`${shift.date}T${shift.end}`).toISOString(), vehicleId: shift.vehicleId || undefined, note: shift.note || undefined });
      setShift(null); s.reload(); toast(t("rSaved"));
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function askOff() {
    if (!off) return;
    try { await apiSend("POST", "/time-off", { userId: off.userId || undefined, kind: off.kind, startsOn: off.startsOn, endsOn: off.endsOn, note: off.note || undefined }); setOff(null); s.reload(); toast(t("sc_requested")); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function decide(id: string, decision: "approved" | "rejected") { try { await apiSend("POST", `/time-off/${id}/decide`, { decision }); s.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }
  async function removeShift(id: string) { if (!window.confirm(t("sc_deleteAsk"))) return; try { await apiSend("DELETE", `/r/shift-plans/${id}`); s.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); } }

  return (
    <div className="content">
      <PageHead title={t("navSchedule")} subtitle={t("sc_sub")} actions={<>
        <button type="button" className="btn alt" onClick={() => setOff({ userId: "", kind: "vacation", startsOn: today, endsOn: today, note: "" })}>{t("sc_askOff")}</button>
        {can("routes.dispatch") && <button type="button" className="btn" onClick={() => setShift({ driverId: s.data?.drivers[0]?.id ?? "", date: today, start: "08:00", end: "16:00", vehicleId: "", note: "" })}><Plus size={16} aria-hidden /> {t("sc_addShift")}</button>}
      </>} />
      <div className="row" style={{ gap: 8, alignItems: "center" }}>
        <button type="button" className="btn sm alt" aria-label={t("sc_prev")} onClick={() => setFrom(addDays(from, -7))}><ChevronLeft size={16} aria-hidden /></button>
        <strong role="status">{from} – {to}</strong>
        <button type="button" className="btn sm alt" aria-label={t("sc_next")} onClick={() => setFrom(addDays(from, 7))}><ChevronRight size={16} aria-hidden /></button>
        <button type="button" className="btn sm ghost" onClick={() => setFrom(weekStart(today))}>{t("sc_thisWeek")}</button>
      </div>
      {s.error && !s.loaded && <ErrorState error={s.error} onRetry={s.reload} />}
      {!s.loaded && !s.error && <SkeletonList rows={5} />}
      {s.data && s.data.drivers.length === 0 && <EmptyState title={t("sc_noDrivers")} />}
      {s.data && s.data.drivers.length > 0 && (
        <div className="sched-wrap"><table className="sched"><caption className="sr-only">{t("navSchedule")}</caption>
          <thead><tr><th scope="col">{t("bl_driver")}</th>{days.map((d) => <th scope="col" key={d} className={d === today ? "today" : undefined}>{dayLabel(d)}</th>)}</tr></thead>
          <tbody>
            {s.data.drivers.map((dr) => (
              <tr key={dr.id}>
                <th scope="row">{dr.name}</th>
                {days.map((d) => {
                  const plans = s.data!.plans.filter((p) => p.driverId === dr.id && isoDay(new Date(p.startsAt)) === d);
                  const offs = s.data!.timeOff.filter((o) => o.userId === dr.id && o.status !== "rejected" && o.startsOn <= d && d <= o.endsOn);
                  return (
                    <td key={d} className={d === today ? "today" : undefined}>
                      {offs.map((o) => <span key={o.id} className={`shift-chip off${o.status === "pending" ? " pending" : ""}`}>{t(`sc_off_${o.kind}` as MessageKey)}{o.status === "pending" ? ` · ${t("sc_pending")}` : ""}</span>)}
                      {plans.map((p) => (
                        <span key={p.id} className={`shift-chip${clash.has(p.id) ? " clash" : ""}`}>
                          {clash.has(p.id) && <AlertTriangle size={12} aria-label={t("sc_clash")} />} {hhmm(p.startsAt, locale)}–{hhmm(p.endsAt, locale)}{p.vehicle ? ` · ${p.vehicle}` : ""}
                          {can("routes.dispatch") && <button type="button" className="btn sm ghost" style={{ padding: "0 4px", minHeight: 0 }} aria-label={`${t("rDelete")} ${hhmm(p.startsAt, locale)}`} onClick={() => removeShift(p.id)}>×</button>}
                        </span>
                      ))}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody></table></div>
      )}
      {clash.size > 0 && <p className="banner warn" role="status">{t("sc_clashNote", { n: clash.size })}</p>}
      {pending.length > 0 && (
        <section aria-label={t("sc_pendingTitle")}>
          <h2>{t("sc_pendingTitle")}</h2>
          <ul className="stack" style={{ listStyle: "none", padding: 0 }}>
            {pending.map((o) => (
              <li key={o.id} className="row" style={{ gap: 8, alignItems: "center" }}>
                <span>{o.person}: {o.startsOn} → {o.endsOn} <Chip>{t(`sc_off_${o.kind}` as MessageKey)}</Chip></span>
                {can("reports.manage") && <><button type="button" className="btn sm" onClick={() => decide(o.id, "approved")}>{t("ap_approve")}</button><button type="button" className="btn sm alt" onClick={() => decide(o.id, "rejected")}>{t("ap_reject")}</button></>}
                {o.userId === me?.user.id && <button type="button" className="btn sm ghost" onClick={async () => { await apiSend("DELETE", `/time-off/${o.id}`).catch(() => {}); s.reload(); }}>{t("sc_withdraw")}</button>}
              </li>
            ))}
          </ul>
        </section>
      )}
      <Modal open={!!shift} onClose={() => setShift(null)} title={t("sc_addShift")} actions={<><button type="button" className="btn alt" onClick={() => setShift(null)}>{t("cancel")}</button><button type="submit" form="shift-form" className="btn">{t("save")}</button></>}>
        {shift && <form id="shift-form" className="stack" onSubmit={(e) => { e.preventDefault(); void addShift(); }}>
          <label className="field"><span>{t("bl_driver")} *</span><select required value={shift.driverId} onChange={(e) => setShift({ ...shift, driverId: e.target.value })}>{(s.data?.drivers ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>
          <label className="field"><span>{t("sc_date")}</span><input type="date" required value={shift.date} onChange={(e) => setShift({ ...shift, date: e.target.value })} /></label>
          <div className="row" style={{ gap: 8 }}><label className="field"><span>{t("sc_start")}</span><input type="time" required value={shift.start} onChange={(e) => setShift({ ...shift, start: e.target.value })} /></label><label className="field"><span>{t("sc_end")}</span><input type="time" required value={shift.end} onChange={(e) => setShift({ ...shift, end: e.target.value })} /></label></div>
          <label className="field"><span>{t("f_vehicleId")}</span><select value={shift.vehicleId} onChange={(e) => setShift({ ...shift, vehicleId: e.target.value })}><option value="">{t("rNone")}</option>{(vehicles.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
          <label className="field"><span>{t("f_note")}</span><input maxLength={500} value={shift.note} onChange={(e) => setShift({ ...shift, note: e.target.value })} /></label>
        </form>}
      </Modal>
      <Modal open={!!off} onClose={() => setOff(null)} title={t("sc_askOff")} actions={<><button type="button" className="btn alt" onClick={() => setOff(null)}>{t("cancel")}</button><button type="submit" form="off-form" className="btn">{t("save")}</button></>}>
        {off && <form id="off-form" className="stack" onSubmit={(e) => { e.preventDefault(); void askOff(); }}>
          {can("routes.dispatch") && <label className="field"><span>{t("tm_person")}</span><select value={off.userId} onChange={(e) => setOff({ ...off, userId: e.target.value })}><option value="">{t("sc_me")}</option>{(s.data?.drivers ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
          <label className="field"><span>{t("sc_kind")}</span><select value={off.kind} onChange={(e) => setOff({ ...off, kind: e.target.value })}>{["vacation", "sick", "personal", "other"].map((k) => <option key={k} value={k}>{t(`sc_off_${k}` as MessageKey)}</option>)}</select></label>
          <div className="row" style={{ gap: 8 }}><label className="field"><span>{t("sc_firstDay")}</span><input type="date" required value={off.startsOn} onChange={(e) => setOff({ ...off, startsOn: e.target.value })} /></label><label className="field"><span>{t("sc_lastDay")}</span><input type="date" required min={off.startsOn} value={off.endsOn} onChange={(e) => setOff({ ...off, endsOn: e.target.value })} /></label></div>
          <label className="field"><span>{t("f_note")}</span><input maxLength={500} value={off.note} onChange={(e) => setOff({ ...off, note: e.target.value })} /></label>
        </form>}
      </Modal>
    </div>
  );
}
