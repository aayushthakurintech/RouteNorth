"use client";
import type { MessageKey } from "@routenorth/shared";
import { PRESETS, presetRange, today, type Filters, type Preset } from "@/lib/analytics";
import { useI18n } from "@/lib/i18n-context";
import { useApi } from "@/lib/use-api";
import type { Compare } from "./Widgets";

/** One set of filters for everything on the page: dates, depot, driver, vehicle, and what to compare with. */
export function FilterBar({ value, onChange, compare, onCompare, showCompare = true }: { value: Filters; onChange: (f: Filters) => void; compare?: Compare; onCompare?: (c: Compare) => void; showCompare?: boolean }) {
  const { t } = useI18n();
  const depots = useApi<{ id: string; name: string }[]>("/r/depots");
  const drivers = useApi<{ id: string; name: string }[]>("/fleet/drivers");
  const vehicles = useApi<{ id: string; name: string }[]>("/r/vehicles");
  const set = (patch: Partial<Filters>) => onChange({ ...value, ...patch });
  const current = PRESETS.find((p) => { const r = presetRange(p); return r.from === value.from && r.to === value.to; }) ?? "custom";
  const sel = (label: MessageKey, key: "depotId" | "driverId" | "vehicleId", list: { id: string; name: string }[] | null) => (
    <label className="field">{t(label)}
      <select value={value[key] ?? ""} onChange={(e) => set({ [key]: e.target.value || undefined })}>
        <option value="">{t("dash_all")}</option>
        {(list ?? []).map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}
      </select>
    </label>
  );
  return (
    <div className="filters" role="group" aria-label={t("dash_filters")}>
      <label className="field">{t("dash_period")}
        <select value={current} onChange={(e) => { if (e.target.value !== "custom") onChange({ ...value, ...presetRange(e.target.value as Preset) }); }}>
          {PRESETS.map((p) => <option key={p} value={p}>{t(`dash_p_${p}` as MessageKey)}</option>)}
          <option value="custom">{t("dash_p_custom")}</option>
        </select>
      </label>
      <label className="field">{t("from")}<input type="date" value={value.from} max={value.to} onChange={(e) => e.target.value && set({ from: e.target.value })} /></label>
      <label className="field">{t("to")}<input type="date" value={value.to} min={value.from} max={today()} onChange={(e) => e.target.value && set({ to: e.target.value })} /></label>
      {sel("dash_depot", "depotId", depots.data)}
      {sel("dash_driver", "driverId", drivers.data)}
      {sel("dash_vehicle", "vehicleId", vehicles.data)}
      {showCompare && onCompare && (
        <label className="field">{t("dash_compare")}
          <select value={compare} onChange={(e) => onCompare(e.target.value as Compare)}>
            <option value="none">{t("dash_cmp_none")}</option><option value="prev">{t("dash_cmp_prev")}</option><option value="year">{t("dash_cmp_year")}</option>
          </select>
        </label>
      )}
    </div>
  );
}
