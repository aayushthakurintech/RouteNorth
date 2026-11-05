"use client";
import { Antenna, Plus, Satellite, Trash2 } from "lucide-react";
import { useMemo, useState } from "react";
import type { MessageKey } from "@routenorth/shared";
import { DataTable, type Column } from "@/components/ui/DataTable";
import { Chip, EmptyState, ErrorState, Kpi, Modal, PageHead, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { ago } from "@/lib/format";
import { useApi } from "@/lib/use-api";

type Health = "healthy" | "attention" | "offline" | "never_reported";
interface Device {
  id: string; source: string; externalId: string; label: string | null; vehicleId: string | null; vehicleName: string | null;
  lastSeen: string | null; satellites: number | null; hdop: number | null; batteryPct: number | null; extVoltage: number | null;
  fuelLevelPct: number | null; signal: number | null; health: Health; issues: string[];
}
interface Quality { days: number; total: number; accepted: number; rejected: number; duplicates: number; acceptedPct: number | null; outcomes: { outcome: string; count: number }[] }
interface Alarm { id: string; time: string; kind: string; severity: number; name: string }
interface VehicleOpt { id: string; name: string }

const TONE: Record<Health, "ok" | "warn" | "danger" | undefined> = { healthy: "ok", attention: "warn", offline: "danger", never_reported: undefined };

export default function DevicesPage() {
  const { t, locale } = useI18n();
  const { can } = useMe();
  const { toast } = useToast();
  const devices = useApi<Device[]>("/devices", { intervalMs: 30_000 });
  const quality = useApi<Quality>("/devices/quality?days=7");
  const alarms = useApi<Alarm[]>("/devices/events?limit=12");
  const vehicles = useApi<VehicleOpt[]>("/vehicles");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState({ externalId: "", label: "", vehicleId: "", source: "traccar" });
  const canManage = can("fleet.manage");
  const list = devices.data ?? [];

  const counts = useMemo(() => ({
    healthy: list.filter((d) => d.health === "healthy").length,
    attention: list.filter((d) => d.health === "attention").length,
    offline: list.filter((d) => d.health === "offline").length,
  }), [list]);

  async function add() {
    try {
      await apiSend("POST", "/devices", { source: draft.source, externalId: draft.externalId.trim(), label: draft.label.trim() || undefined, vehicleId: draft.vehicleId || null });
      toast(t("dv_saved"));
      setAdding(false);
      setDraft({ externalId: "", label: "", vehicleId: "", source: "traccar" });
      devices.reload();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function unassign(d: Device) {
    try { await apiSend("PATCH", `/devices/${d.id}`, { vehicleId: null }); devices.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }
  async function remove(d: Device) {
    try { await apiSend("DELETE", `/devices/${d.id}`); toast(t("dv_removed")); devices.reload(); } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }

  const cols: Column<Device>[] = [
    { key: "tracker", header: t("dv_id"), value: (d) => d.label ?? d.externalId, width: 200, render: (d) => <span><strong>{d.label ?? d.externalId}</strong>{d.label && <span className="meta"> · {d.externalId}</span>}</span> },
    { key: "vehicle", header: t("dv_vehicle"), value: (d) => d.vehicleName ?? t("dv_unassigned"), width: 150 },
    {
      key: "health", header: t("dv_status"), value: (d) => d.health, width: 170,
      render: (d) => (
        <span title={d.issues.map((i) => t(`dv_issue_${i}` as MessageKey)).join("\n")}>
          <Chip tone={TONE[d.health]} dot>{t(`dv_health_${d.health}` as MessageKey)}</Chip>
        </span>
      ),
    },
    { key: "seen", header: t("dv_last_seen"), value: (d) => d.lastSeen ?? "", width: 120, render: (d) => (d.lastSeen ? ago(d.lastSeen, locale) : t("dv_never")) },
    { key: "sats", header: t("dv_sats"), value: (d) => d.satellites, numeric: true, width: 90 },
    { key: "bat", header: t("dv_battery"), value: (d) => d.batteryPct, numeric: true, width: 110, render: (d) => (d.batteryPct == null ? "—" : `${Math.round(d.batteryPct)}%`) },
    { key: "volt", header: t("dv_voltage"), value: (d) => d.extVoltage, numeric: true, width: 120, render: (d) => (d.extVoltage == null ? "—" : `${d.extVoltage.toFixed(1)} V`) },
    { key: "fuel", header: t("dv_fuel"), value: (d) => d.fuelLevelPct, numeric: true, width: 100, render: (d) => (d.fuelLevelPct == null ? "—" : `${Math.round(d.fuelLevelPct)}%`) },
    ...(canManage ? [{
      key: "act", header: "", value: () => "", width: 150, noGroup: true,
      render: (d: Device) => (
        <span className="row">
          {d.vehicleId && <button type="button" className="btn ghost sm" onClick={() => void unassign(d)}>{t("dv_unassign")}</button>}
          {!d.lastSeen && <button type="button" className="btn ghost sm" aria-label={`${t("dv_remove")} ${d.externalId}`} onClick={() => void remove(d)}><Trash2 size={14} aria-hidden /></button>}
        </span>
      ),
    } satisfies Column<Device>] : []),
  ];

  const host = typeof window === "undefined" ? "your-server" : window.location.hostname;

  return (
    <div className="content stack">
      <PageHead title={t("dv_title")} subtitle={t("dv_sub")} actions={canManage ? <button type="button" className="btn" onClick={() => setAdding(true)}><Plus size={16} aria-hidden />{t("dv_add")}</button> : undefined} />

      {devices.error ? <ErrorState error={devices.error} onRetry={devices.reload} />
        : !devices.loaded ? <SkeletonList rows={5} />
        : list.length === 0 ? <EmptyState icon={<Antenna size={36} aria-hidden />} title={t("dv_empty_t")} body={t("dv_empty_b")} action={canManage ? <button type="button" className="btn" onClick={() => setAdding(true)}>{t("dv_add")}</button> : undefined} />
        : (
          <>
            <div className="grid cols-3">
              <Kpi label={t("dv_health_healthy")} value={counts.healthy} />
              <Kpi label={t("dv_health_attention")} value={counts.attention} />
              <Kpi label={t("dv_health_offline")} value={counts.offline} />
            </div>
            <DataTable tableId="devices" columns={cols} rows={list} rowKey={(d) => d.id} csvName="trackers" />
          </>
        )}

      <div className="grid cols-2">
        <section className="card" aria-labelledby="dq-h">
          <div className="card-head"><h2 id="dq-h">{t("dv_quality")}</h2></div>
          <p className="meta">{t("dv_quality_sub", { days: 7 })}</p>
          {!quality.loaded ? <SkeletonList rows={3} h={28} /> : !quality.data || quality.data.total === 0 ? <p className="meta">{t("dv_q_none")}</p> : <QualityBars q={quality.data} />}
        </section>
        <section className="card" aria-labelledby="al-h">
          <div className="card-head"><h2 id="al-h">{t("dv_alarms")}</h2></div>
          {!alarms.loaded ? <SkeletonList rows={3} h={28} /> : (alarms.data ?? []).length === 0 ? <p className="meta">{t("dv_alarms_none")}</p> : (
            <ul className="plainlist">
              {alarms.data!.map((a) => (
                <li key={a.id} className="row">
                  <Chip tone={a.severity >= 3 ? "danger" : a.severity === 2 ? "warn" : "info"}>{t(`dv_alarm_${a.kind}` as MessageKey)}</Chip>
                  <span className="grow">{a.name}</span>
                  <span className="meta">{ago(a.time, locale)}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>

      <section className="card" aria-labelledby="setup-h">
        <div className="card-head"><Satellite size={18} aria-hidden /><h2 id="setup-h">{t("dv_setup")}</h2></div>
        <ol>
          <li>{t("dv_setup_1")}</li>
          <li>{t("dv_setup_2", { host })}</li>
          <li>{t("dv_setup_3")}</li>
        </ol>
        <p className="meta">{t("dv_setup_note")}</p>
      </section>

      <Modal open={adding} onClose={() => setAdding(false)} title={t("dv_add")} actions={<button type="submit" form="add-device" className="btn" disabled={draft.externalId.trim().length < 3}>{t("dv_add")}</button>}>
        <form id="add-device" className="stack" onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <label className="field">{t("dv_id")}
            <input required autoFocus inputMode="numeric" autoComplete="off" spellCheck={false} maxLength={80} value={draft.externalId} onChange={(e) => setDraft({ ...draft, externalId: e.target.value })} />
            <span className="meta">{t("dv_id_hint")}</span>
          </label>
          <label className="field">{t("dv_vehicle")}
            <select value={draft.vehicleId} onChange={(e) => setDraft({ ...draft, vehicleId: e.target.value })}>
              <option value="">{t("dv_unassigned")}</option>
              {(vehicles.data ?? []).map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </label>
          <label className="field">{t("dv_source")}
            <select value={draft.source} onChange={(e) => setDraft({ ...draft, source: e.target.value })}>
              <option value="traccar">{t("dv_source_traccar")}</option>
              <option value="api">{t("dv_source_api")}</option>
            </select>
          </label>
          <label className="field">{t("dv_label")}<input maxLength={80} value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} /></label>
        </form>
      </Modal>
    </div>
  );
}

function QualityBars({ q }: { q: Quality }) {
  const { t, locale } = useI18n();
  const max = Math.max(...q.outcomes.map((o) => o.count), 1);
  const nf = new Intl.NumberFormat(locale);
  return (
    <>
      <div className="grid cols-3">
        <Kpi label={t("dv_q_accepted")} value={q.acceptedPct ?? 0} format={(n) => `${n}%`} />
        <Kpi label={t("dv_q_rejected")} value={q.rejected} format={(n) => nf.format(n)} />
        <Kpi label={t("dv_q_dupes")} value={q.duplicates} format={(n) => nf.format(n)} />
      </div>
      <ul className="plainlist" aria-label={t("dv_quality")}>
        {q.outcomes.map((o) => (
          <li key={o.outcome} className="bar-row">
            <span className="bar-label">{t(`dv_out_${o.outcome}` as MessageKey)}</span>
            <span className="bar-track" aria-hidden><span className={`bar-fill ${o.outcome.startsWith("rejected") ? "bad" : ""}`} style={{ width: `${Math.max(2, (o.count / max) * 100)}%` }} /></span>
            <span className="bar-n">{nf.format(o.count)}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
