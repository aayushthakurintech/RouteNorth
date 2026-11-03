"use client";
import { Upload } from "lucide-react";
import { useRef, useState } from "react";
import ResourcePage from "@/components/ResourcePage";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { EmptyState, ErrorState, PageHead, SkeletonList, Tabs } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Econ { vehicleId: string; name: string; fills: number; litres: number; cost: number; km: number; lPer100: number | null; costPerKm: number | null }

function Summary() {
  const { t, locale } = useI18n();
  const month = new Date(); month.setDate(1);
  const [from, setFrom] = useState(month.toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const data = useApi<Econ[]>(`/fleet/fuel/summary?from=${from}&to=${to}`);
  const money = (n: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "CAD" }).format(n);
  const num = (n: number | null, d = 1) => (n == null ? "—" : new Intl.NumberFormat(locale, { maximumFractionDigits: d }).format(n));
  const cols: Column<Econ>[] = [
    { key: "name", header: t("f_vehicleId"), value: (r) => r.name, width: 180 },
    { key: "fills", header: t("fuel_fills"), value: (r) => r.fills, numeric: true, width: 90 },
    { key: "litres", header: t("f_litres"), value: (r) => Math.round(r.litres), render: (r) => num(r.litres), numeric: true, width: 110 },
    { key: "cost", header: t("f_cost"), value: (r) => r.cost, render: (r) => money(r.cost), numeric: true, width: 120 },
    { key: "km", header: t("fuel_km"), value: (r) => r.km, render: (r) => num(r.km, 0), numeric: true, width: 100 },
    { key: "lPer100", header: t("fuel_lPer100"), value: (r) => r.lPer100, render: (r) => num(r.lPer100), numeric: true, width: 130 },
    { key: "costPerKm", header: t("fuel_costPerKm"), value: (r) => r.costPerKm, render: (r) => (r.costPerKm == null ? "—" : money(r.costPerKm)), numeric: true, width: 130 },
  ];
  const rows = data.data ?? [];
  const best = rows.filter((r) => r.lPer100 != null).sort((a, b) => a.lPer100! - b.lPer100!);
  return (
    <>
      <div className="row">
        <label className="field">{t("fuel_from")}<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">{t("fuel_to")}<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      {data.error ? <ErrorState error={data.error} onRetry={data.reload} />
        : !data.loaded ? <SkeletonList rows={4} />
        : rows.length === 0 ? <EmptyState title={t("rEmpty")} body={t("fuel_hint")} />
        : (
          <>
            {best.length > 1 && <p className="meta" role="status">{t("fuel_bestWorst", { best: best[0]!.name, worst: best[best.length - 1]!.name })}</p>}
            <DataTable tableId="fuel-summary" columns={cols} rows={rows} rowKey={(r) => r.vehicleId} csvName={`fuel-${from}-${to}`} />
          </>
        )}
    </>
  );
}

function ImportCard({ onDone }: { onDone: () => void }) {
  const { t } = useI18n();
  const { toast } = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [res, setRes] = useState<{ created: number; duplicates: number; errors: { row: number; message: string }[] } | null>(null);
  async function pick(file: File) {
    try {
      const r = await apiSend<NonNullable<typeof res>>("POST", "/fleet/fuel/import", { csv: await file.text() });
      setRes(r);
      toast(t("fuel_imported", { n: r.created, dup: r.duplicates }));
      onDone();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  return (
    <div className="stack">
      <div className="row">
        <button type="button" className="btn alt" onClick={() => input.current?.click()}><Upload size={16} aria-hidden />{t("fuel_import")}</button>
        <input ref={input} type="file" accept=".csv,text/csv" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void pick(f); e.target.value = ""; }} />
        <span className="meta">{t("fuel_importHelp")}</span>
      </div>
      {res?.errors.slice(0, 8).map((e) => <p key={e.row} className="err">{t("rowError", { row: e.row })}: {e.message}</p>)}
    </div>
  );
}

/** Fuel use and cost per vehicle, the fill-up log, and fuel-card CSV import. */
export default function FuelPage() {
  const { t } = useI18n();
  const { can } = useMe();
  const [tab, setTab] = useState("summary");
  const [tick, setTick] = useState(0);
  return (
    <div className="content stack">
      <PageHead title={t("navFuel")} subtitle={t("fuel_hint")} />
      <Tabs label={t("navFuel")} value={tab} onChange={setTab} tabs={[{ id: "summary", label: t("fuel_summary") }, { id: "logs", label: t("res_fuel-logs") }]} />
      {tab === "summary" ? <Summary key={tick} /> : <ResourcePage key={tick} name="fuel-logs" extra={can("fleet.manage") ? <ImportCard onDone={() => setTick((n) => n + 1)} /> : undefined} />}
    </div>
  );
}
