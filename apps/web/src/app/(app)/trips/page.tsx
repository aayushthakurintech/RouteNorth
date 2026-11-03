"use client";
import { Download } from "lucide-react";
import { useState } from "react";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Chip, EmptyState, ErrorState, PageHead, SkeletonList } from "@/components/ui/primitives";
import { apiDownload, apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Trip { deviceId: string; vehicleId: string | null; vehicle: string; start: string; end: string; km: number; minutes: number; from: string | null; to: string | null; purpose: "business" | "personal" | null; note: string | null }
interface Log { trips: Trip[]; totals: { km: number; business: number; personal: number; untagged: number } }
interface Vehicle { id: string; name: string }

const dayStart = (d: string) => new Date(`${d}T00:00:00`).toISOString();
const dayEnd = (d: string) => new Date(new Date(`${d}T00:00:00`).getTime() + 86_400_000).toISOString();

/** Every trip the vehicles made, with a business or personal tag for mileage and tax records. */
export default function TripsPage() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const { toast } = useToast();
  const [from, setFrom] = useState(new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(new Date().toISOString().slice(0, 10));
  const [vehicleId, setVehicleId] = useState("");
  const vehicles = useApi<Vehicle[]>("/r/vehicles");
  const qs = `from=${encodeURIComponent(dayStart(from))}&to=${encodeURIComponent(dayEnd(to))}${vehicleId ? `&vehicleId=${vehicleId}` : ""}`;
  const log = useApi<Log>(`/fleet/trip-log?${qs}`);
  const canTag = can("fleet.manage");
  const when = (iso: string) => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "short" }).format(new Date(iso));

  async function tag(trip: Trip, purpose: "business" | "personal") {
    try {
      await apiSend("PUT", "/fleet/trip-log/purpose", { deviceId: trip.deviceId, start: trip.start, purpose });
      log.setData((d) => d && { ...d, trips: d.trips.map((x) => (x === trip ? { ...x, purpose } : x)) });
      log.reload();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }

  const cols: Column<Trip>[] = [
    { key: "vehicle", header: t("f_vehicleId"), value: (r) => r.vehicle, width: 150 },
    { key: "start", header: t("trip_start"), value: (r) => r.start, render: (r) => when(r.start), width: 150 },
    { key: "end", header: t("trip_end"), value: (r) => r.end, render: (r) => when(r.end), width: 150 },
    { key: "km", header: "km", value: (r) => r.km, numeric: true, width: 80 },
    { key: "minutes", header: t("trip_minutes"), value: (r) => r.minutes, numeric: true, width: 90 },
    { key: "from", header: t("trip_from"), value: (r) => r.from ?? "", render: (r) => r.from ?? "—", width: 150 },
    { key: "to", header: t("trip_to"), value: (r) => r.to ?? "", render: (r) => r.to ?? "—", width: 150 },
    {
      key: "purpose", header: t("trip_purpose"), value: (r) => r.purpose ?? "", width: 210,
      render: (r) => (
        <span className="row">
          {canTag ? (
            <>
              <button type="button" className={`btn sm ${r.purpose === "business" ? "" : "alt"}`} aria-pressed={r.purpose === "business"} onClick={() => void tag(r, "business")}>{t("trip_business")}</button>
              <button type="button" className={`btn sm ${r.purpose === "personal" ? "" : "alt"}`} aria-pressed={r.purpose === "personal"} onClick={() => void tag(r, "personal")}>{t("trip_personal")}</button>
            </>
          ) : r.purpose ? <Chip>{t(r.purpose === "business" ? "trip_business" : "trip_personal")}</Chip> : "—"}
        </span>
      ),
    },
  ];
  const n = (x: number) => new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(x);

  return (
    <div className="content stack">
      <PageHead title={t("navTripLog")} subtitle={t("trip_hint")}
        actions={can("reports.export") ? <button type="button" className="btn alt" onClick={() => void apiDownload(`/fleet/trip-log?${qs}&format=csv`, `trip-log-${from}-${to}.csv`).catch((e: Error) => toast(e.message, { tone: "error" }))}><Download size={16} aria-hidden />{t("rExport")}</button> : undefined} />
      <div className="row">
        <label className="field">{t("fuel_from")}<input type="date" value={from} max={to} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field">{t("fuel_to")}<input type="date" value={to} min={from} onChange={(e) => setTo(e.target.value)} /></label>
        <label className="field">{t("f_vehicleId")}
          <select value={vehicleId} onChange={(e) => setVehicleId(e.target.value)}>
            <option value="">{t("trip_allVehicles")}</option>
            {(vehicles.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
          </select>
        </label>
      </div>
      {log.error ? <ErrorState error={log.error} onRetry={log.reload} />
        : !log.loaded || !log.data ? <SkeletonList rows={6} />
        : (
          <>
            <p className="meta" role="status">{t("trip_totals", { km: n(log.data.totals.km), business: n(log.data.totals.business), personal: n(log.data.totals.personal), untagged: log.data.totals.untagged })}</p>
            <DataTable tableId="trip-log" columns={cols} rows={log.data.trips} rowKey={(r) => `${r.deviceId}-${r.start}`} csvName={`trip-log-${from}-${to}`} empty={<EmptyState title={t("trip_none")} />} />
          </>
        )}
    </div>
  );
}
