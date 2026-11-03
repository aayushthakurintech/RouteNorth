"use client";
import { Download, Pencil, Plus } from "lucide-react";
import { useState } from "react";
import { Chip, EmptyState, ErrorState, Kpi, Modal, PageHead, SkeletonList } from "@/components/ui/primitives";
import { apiDownload, apiSend } from "@/lib/api";
import { isoToLocalInput } from "@/lib/resources";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Shift { id: string; driverId: string; name: string; startedAt: string; endedAt: string | null; source: string; note: string | null; workedMin: number; breakMin: number; overtimeMin: number; overtimeStatus: string; rate: number | null; date: string; pay: number }
interface PerDriver { driverId: string; name: string; shifts: number; workedMin: number; breakMin: number; overtimeMin: number; pendingOvertimeMin: number; pay: number; rate: number | null }
interface Sheet { from: string; to: string; drivers: PerDriver[]; shifts: Shift[] }

const hm = (min: number) => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, "0")}`;
const dayInput = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

/** What the shift clocks recorded, per driver, with overtime and a pay estimate. */
export default function TimesheetsPage() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const { toast } = useToast();
  const [from, setFrom] = useState(() => dayInput(new Date(Date.now() - 13 * 86_400_000)));
  const [to, setTo] = useState(() => dayInput(new Date()));
  const [driver, setDriver] = useState("");
  const q = `from=${encodeURIComponent(new Date(`${from}T00:00:00`).toISOString())}&to=${encodeURIComponent(new Date(`${to}T23:59:59`).toISOString())}`;
  const sheet = useApi<Sheet>(`/timesheets?${q}${driver ? `&driverId=${driver}` : ""}`);
  const drivers = useApi<{ id: string; name: string }[]>(can("reports.manage") ? "/fleet/drivers" : null);
  const [edit, setEdit] = useState<{ id?: string; driverId: string; startedAt: string; endedAt: string; note: string } | null>(null);
  const money = new Intl.NumberFormat(locale === "fr" ? "fr-CA" : "en-CA", { style: "currency", currency: "CAD" });
  const when = (iso: string) => new Date(iso).toLocaleTimeString(locale === "fr" ? "fr-CA" : "en-CA", { timeStyle: "short" });
  const totals = (sheet.data?.drivers ?? []).reduce((a, d) => ({ worked: a.worked + d.workedMin, ot: a.ot + d.overtimeMin, pay: a.pay + d.pay }), { worked: 0, ot: 0, pay: 0 });

  async function save() {
    if (!edit) return;
    try {
      const body = { startedAt: new Date(edit.startedAt).toISOString(), endedAt: edit.endedAt ? new Date(edit.endedAt).toISOString() : null, note: edit.note || null };
      if (edit.id) await apiSend("PATCH", `/timesheets/shifts/${edit.id}`, body); else await apiSend("POST", "/timesheets/shifts", { ...body, driverId: edit.driverId });
      setEdit(null); sheet.reload(); toast(t("ts_saved"));
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }

  return (
    <div className="content">
      <PageHead title={t("navTimesheets")} subtitle={t("ts_subtitle")} actions={<>
        {can("reports.export") && <button className="btn" onClick={() => void apiDownload(`/timesheets/export.csv?${q}`, "timesheets.csv").catch((e) => toast((e as Error).message, { tone: "error" }))}><Download size={15} /> CSV</button>}
        {can("reports.manage") && <button className="btn primary" onClick={() => setEdit({ driverId: drivers.data?.[0]?.id ?? "", startedAt: "", endedAt: "", note: "" })}><Plus size={15} /> {t("ts_addShift")}</button>}
      </>} />
      <div className="row">
        <label className="field">{t("from")}<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">{t("to")}<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        {can("reports.manage") && <label className="field">{t("f_driver")}<select value={driver} onChange={(e) => setDriver(e.target.value)}><option value="">{t("all")}</option>{(drivers.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
      </div>
      {sheet.error ? <ErrorState error={sheet.error} onRetry={sheet.reload} /> : !sheet.loaded ? <SkeletonList rows={5} h={48} /> : (sheet.data?.shifts ?? []).length === 0 ? <EmptyState title={t("ts_empty")} body={t("ts_emptyBody")} /> : (
        <>
          <div className="kpi-row"><Kpi label={t("ts_worked")} value={totals.worked / 60} format={(v) => `${v.toFixed(1)} h`} /><Kpi label={t("ts_overtime")} value={totals.ot / 60} format={(v) => `${v.toFixed(1)} h`} /><Kpi label={t("ts_pay")} value={totals.pay} format={(v) => money.format(v)} sub={t("ts_payNote")} /></div>
          <div className="card" style={{ overflowX: "auto" }}>
            <table className="ptable">
              <caption className="sr-only">{t("ts_perDriver")}</caption>
              <thead><tr><th scope="col">{t("f_driver")}</th><th scope="col">{t("ts_shifts")}</th><th scope="col">{t("ts_worked")}</th><th scope="col">{t("ts_breaks")}</th><th scope="col">{t("ts_overtime")}</th><th scope="col">{t("ts_pay")}</th></tr></thead>
              <tbody>{sheet.data!.drivers.map((d) => <tr key={d.driverId}><th scope="row">{d.name}</th><td>{d.shifts}</td><td>{hm(d.workedMin)}</td><td>{hm(d.breakMin)}</td><td>{hm(d.overtimeMin)}{d.pendingOvertimeMin > 0 && <> <Chip tone="warn">{t("ts_pending", { time: hm(d.pendingOvertimeMin) })}</Chip></>}</td><td>{d.rate == null ? <span className="meta">{t("ts_noRate")}</span> : money.format(d.pay)}</td></tr>)}</tbody>
            </table>
          </div>
          <div className="card" style={{ overflowX: "auto" }}>
            <table className="ptable">
              <caption className="sr-only">{t("ts_allShifts")}</caption>
              <thead><tr><th scope="col">{t("date")}</th><th scope="col">{t("f_driver")}</th><th scope="col">{t("ts_start")}</th><th scope="col">{t("ts_end")}</th><th scope="col">{t("ts_worked")}</th><th scope="col">{t("ts_breaks")}</th><th scope="col">{t("ts_overtime")}</th><th scope="col"><span className="sr-only">{t("actions")}</span></th></tr></thead>
              <tbody>{sheet.data!.shifts.map((s) => (
                <tr key={s.id}>
                  <td>{s.date}</td><th scope="row">{s.name}</th><td>{when(s.startedAt)}</td><td>{s.endedAt ? when(s.endedAt) : <Chip tone="info">{t("ts_running")}</Chip>}</td><td>{hm(s.workedMin)}</td><td>{hm(s.breakMin)}</td>
                  <td>{s.overtimeMin > 0 ? <>{hm(s.overtimeMin)} <Chip tone={s.overtimeStatus === "approved" ? "ok" : s.overtimeStatus === "rejected" ? "danger" : "warn"}>{t(`ap_s_${s.overtimeStatus === "none" ? "pending" : s.overtimeStatus}` as "ap_s_pending")}</Chip></> : "–"}</td>
                  <td>{can("reports.manage") && <button className="icon-btn" aria-label={t("edit")} onClick={() => setEdit({ id: s.id, driverId: s.driverId, startedAt: isoToLocalInput(s.startedAt), endedAt: isoToLocalInput(s.endedAt), note: s.note ?? "" })}><Pencil size={15} /></button>}</td>
                </tr>))}</tbody>
            </table>
          </div>
        </>
      )}
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? t("ts_editShift") : t("ts_addShift")} actions={<><button className="btn" onClick={() => setEdit(null)}>{t("cancel")}</button><button className="btn primary" disabled={!edit?.startedAt || (!edit?.id && !edit?.driverId)} onClick={() => void save()}>{t("save")}</button></>}>
        {edit && (
          <div className="form-grid">
            {!edit.id && <label className="field">{t("f_driver")}<select value={edit.driverId} onChange={(e) => setEdit({ ...edit, driverId: e.target.value })}>{(drivers.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}</select></label>}
            <label className="field">{t("ts_start")}<input type="datetime-local" value={edit.startedAt} onChange={(e) => setEdit({ ...edit, startedAt: e.target.value })} /></label>
            <label className="field">{t("ts_end")}<input type="datetime-local" value={edit.endedAt} onChange={(e) => setEdit({ ...edit, endedAt: e.target.value })} /></label>
            <label className="field">{t("f_notes")}<input value={edit.note} maxLength={300} onChange={(e) => setEdit({ ...edit, note: e.target.value })} /></label>
          </div>
        )}
      </Modal>
    </div>
  );
}
