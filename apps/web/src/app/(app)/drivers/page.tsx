"use client";
import { useState } from "react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Chip, EmptyState, ErrorState, Modal, PageHead, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { downscaleImage } from "@/lib/image";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Training { name: string; date?: string }
interface Driver {
  id: string; name: string; email: string; disabled: boolean; phone: string | null; licenseNo: string | null; licenseClass: string | null; licenseExpiry: string | null;
  emergencyName: string | null; emergencyPhone: string | null; homeDepotId: string | null; maxShiftMin: number; breakAfterMin: number; breakMin: number; skills: string[]; training: Training[]; notes: string | null; hourlyRate: number | null; hasPhoto: boolean;
}
interface Depot { id: string; name: string }
type Form = Omit<Driver, "skills" | "training"> & { skills: string; training: string };

const daysUntil = (d: string | null) => (d ? Math.round((new Date(`${d}T00:00:00`).getTime() - Date.now()) / 86_400_000) : null);

/** Driver profiles: licence, contact, shift limits, skills and training. Dispatch and the planner read these. */
export default function DriversPage() {
  const { t } = useI18n();
  const { can } = useMe();
  const { toast } = useToast();
  const drivers = useApi<Driver[]>("/fleet/drivers");
  const depots = useApi<Depot[]>("/r/depots");
  const [form, setForm] = useState<Form | null>(null);
  const canEdit = can("fleet.manage");

  const open = (d: Driver) => setForm({ ...d, skills: d.skills.join(", "), training: d.training.map((x) => (x.date ? `${x.name} ; ${x.date}` : x.name)).join("\n") });
  async function save() {
    if (!form) return;
    const training = form.training.split("\n").map((l) => l.trim()).filter(Boolean).map((l) => { const [name, date] = l.split(";").map((s) => s.trim()); return date ? { name: name!, date } : { name: name! }; });
    try {
      await apiSend("PUT", `/fleet/drivers/${form.id}`, {
        phone: form.phone, licenseNo: form.licenseNo, licenseClass: form.licenseClass, licenseExpiry: form.licenseExpiry || null, emergencyName: form.emergencyName, emergencyPhone: form.emergencyPhone,
        homeDepotId: form.homeDepotId || null, maxShiftMin: Number(form.maxShiftMin), breakAfterMin: Number(form.breakAfterMin), breakMin: Number(form.breakMin),
        hourlyRate: form.hourlyRate == null || String(form.hourlyRate) === "" ? null : Number(form.hourlyRate),
        skills: form.skills.split(",").map((s) => s.trim()).filter(Boolean), training, notes: form.notes,
      });
      toast(t("rSaved"));
      setForm(null);
      drivers.reload();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }

  const cols: Column<Driver>[] = [
    { key: "name", header: t("f_name"), value: (d) => d.name, render: (d) => <>{d.name}{d.disabled && <> <Chip>{t("drv_disabled")}</Chip></>}</>, width: 180 },
    { key: "phone", header: t("drv_phone"), value: (d) => d.phone ?? "", width: 140 },
    { key: "licenseClass", header: t("drv_licenceClass"), value: (d) => d.licenseClass ?? "", width: 100 },
    {
      key: "licenseExpiry", header: t("drv_licenceExpiry"), value: (d) => d.licenseExpiry ?? "", width: 160,
      render: (d) => { const n = daysUntil(d.licenseExpiry); return d.licenseExpiry ? <Chip tone={n != null && n < 0 ? "danger" : n != null && n <= 30 ? "warn" : "ok"}>{d.licenseExpiry}</Chip> : "—"; },
    },
    { key: "skills", header: t("f_skills"), value: (d) => d.skills.join(", "), width: 200 },
    { key: "shift", header: t("drv_maxShift"), value: (d) => d.maxShiftMin, render: (d) => `${Math.round(d.maxShiftMin / 6) / 10} h`, numeric: true, width: 110 },
    { key: "training", header: t("drv_training"), value: (d) => d.training.length, numeric: true, width: 100 },
  ];

  if (drivers.error) return <div className="content"><ErrorState error={drivers.error} onRetry={drivers.reload} forbidden={/403/.test(drivers.error.message)} /></div>;
  async function photo(file: File | undefined) {
    if (!file || !form) return;
    try {
      const small = await downscaleImage(file, 320, 0.8);
      const url = await new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result)); r.onerror = rej; r.readAsDataURL(small); });
      await apiSend("PUT", `/fleet/drivers/${form.id}/photo`, { dataUrl: url });
      setForm({ ...form, hasPhoto: true }); toast(t("drv_photoSaved")); drivers.reload();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function removePhoto() {
    if (!form) return;
    try { await apiSend("PUT", `/fleet/drivers/${form.id}/photo`, { dataUrl: null }); setForm({ ...form, hasPhoto: false }); drivers.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  const text = (k: keyof Form, label: string, props: Record<string, unknown> = {}) => (
    <label className="field">{label}<input value={String(form?.[k] ?? "")} onChange={(e) => form && setForm({ ...form, [k]: e.target.value })} {...props} /></label>
  );
  return (
    <div className="content stack">
      <PageHead title={t("navDrivers")} subtitle={t("drv_hint")} />
      {!drivers.loaded ? <SkeletonList rows={5} />
        : <DataTable tableId="drivers" columns={cols} rows={drivers.data ?? []} rowKey={(d) => d.id} csvName="drivers" onRowClick={canEdit ? open : undefined} empty={<EmptyState title={t("drv_none")} body={t("drv_noneHelp")} />} />}
      <Modal open={!!form} onClose={() => setForm(null)} title={form?.name ?? ""}
        actions={<><button type="button" className="btn alt" onClick={() => setForm(null)}>{t("cancel")}</button><button type="submit" form="drv-form" className="btn">{t("save")}</button></>}>
        {form && (
          <form id="drv-form" className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }}>
            {text("phone", t("drv_phone"), { type: "tel", maxLength: 40 })}
            <div className="row">{text("licenseNo", t("drv_licenceNo"), { maxLength: 40 })}{text("licenseClass", t("drv_licenceClass"), { maxLength: 20 })}</div>
            {text("licenseExpiry", t("drv_licenceExpiry"), { type: "date" })}
            <div className="row">{text("emergencyName", t("drv_emergencyName"), { maxLength: 120 })}{text("emergencyPhone", t("drv_emergencyPhone"), { type: "tel", maxLength: 40 })}</div>
            <label className="field">{t("drv_homeDepot")}
              <select value={form.homeDepotId ?? ""} onChange={(e) => setForm({ ...form, homeDepotId: e.target.value || null })}>
                <option value="">{t("rNone")}</option>
                {(depots.data ?? []).map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </label>
            <div className="row">
              {text("maxShiftMin", t("drv_maxShiftMin"), { type: "number", min: 30, max: 1440 })}
              {text("breakAfterMin", t("drv_breakAfterMin"), { type: "number", min: 30, max: 1440 })}
              {text("breakMin", t("drv_breakMin"), { type: "number", min: 5, max: 240 })}
            </div>
            {text("hourlyRate", t("drv_hourlyRate"), { type: "number", min: 0, max: 1000, step: "0.01" })}
            <div className="field">{t("drv_photo")}<span className="row"><input type="file" accept="image/jpeg,image/png,image/webp" aria-label={t("drv_photo")} onChange={(e) => void photo(e.target.files?.[0])} />{form.hasPhoto && <><Chip tone="ok">{t("drv_hasPhoto")}</Chip><button type="button" className="btn ghost sm" onClick={() => void removePhoto()}>{t("removeLogo")}</button></>}</span><span className="hint">{t("drv_photoHelp")}</span></div>
            {text("skills", t("f_skills"), { placeholder: t("rCommaList") })}
            <label className="field">{t("drv_training")}<textarea rows={3} value={form.training} placeholder={t("drv_trainingHelp")} onChange={(e) => setForm({ ...form, training: e.target.value })} /></label>
            <label className="field">{t("f_notes")}<textarea maxLength={2000} value={form.notes ?? ""} onChange={(e) => setForm({ ...form, notes: e.target.value })} /></label>
          </form>
        )}
      </Modal>
    </div>
  );
}
