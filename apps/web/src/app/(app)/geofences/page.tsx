"use client";
import { Pencil, Plus, Trash2, Undo2 } from "lucide-react";
import { useState } from "react";
import type { MessageKey } from "@routenorth/shared";
import dynamic from "next/dynamic";
import type { ZoneShape } from "@/components/GeofenceMap";
import { SplitView } from "@/components/ui/SplitView";
import { Chip, EmptyState, ErrorState, PageHead, SkeletonList } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

const GeofenceMap = dynamic(() => import("@/components/GeofenceMap").then((m) => m.GeofenceMap), { ssr: false });

interface Zone extends ZoneShape { id: string; name: string; alertOn: "enter" | "exit" | "both" | "none"; active: boolean; notes?: string | null }
interface Draft extends ZoneShape { name: string; alertOn: Zone["alertOn"]; active: boolean; notes: string }
const blank = (): Draft => ({ name: "", shape: "circle", radiusM: 200, polygon: [], alertOn: "both", active: true, notes: "" });

/** Draw circular and polygon zones on the map; the live feed raises enter and exit events for them. */
export default function GeofencesPage() {
  const { t } = useI18n();
  const { can } = useMe();
  const { toast, undoable } = useToast();
  const zones = useApi<Zone[]>("/r/geofences?limit=500");
  const [draft, setDraft] = useState<(Draft & { id?: string }) | null>(null);
  const canEdit = can("alerts.manage");

  const ready = !!draft && !!draft.name.trim() && (draft.shape === "circle" ? draft.lat != null && draft.lng != null && !!draft.radiusM : (draft.polygon?.length ?? 0) >= 3);

  async function save() {
    if (!draft || !ready) return;
    const body = { name: draft.name.trim(), shape: draft.shape, alertOn: draft.alertOn, active: draft.active, notes: draft.notes || null,
      ...(draft.shape === "circle" ? { lat: draft.lat, lng: draft.lng, radiusM: Number(draft.radiusM) } : { polygon: draft.polygon }) };
    try {
      if (draft.id) await apiSend("PATCH", `/r/geofences/${draft.id}`, body); else await apiSend("POST", "/r/geofences", body);
      toast(t("rSaved"));
      setDraft(null);
      zones.reload();
    } catch (e) { toast((e as Error).message, { tone: "error" }); }
  }

  const [gone, setGone] = useState<Set<string>>(new Set());
  function remove(z: Zone) {
    undoable(t("rDeleted"), {
      hide: () => setGone((s) => new Set(s).add(z.id)),
      restore: () => setGone((s) => { const n = new Set(s); n.delete(z.id); return n; }),
      commit: async () => { await apiSend("DELETE", `/r/geofences/${z.id}`); zones.reload(); },
    });
  }
  const list = (zones.data ?? []).filter((z) => !gone.has(z.id));

  const pick = draft ? (lat: number, lng: number) => setDraft((d) => d && (d.shape === "circle" ? { ...d, lat, lng } : { ...d, polygon: [...(d.polygon ?? []), [lat, lng]] })) : null;

  return (
    <SplitView id="geofences">
      <aside className="panel">
        <PageHead title={t("navGeofences")} subtitle={t("gf_hint")} actions={canEdit && !draft ? <button type="button" className="btn" onClick={() => setDraft(blank())}><Plus size={16} aria-hidden />{t("rNew")}</button> : undefined} />
        {draft && (
          <form className="stack" onSubmit={(e) => { e.preventDefault(); void save(); }} aria-label={t("gf_editor")}>
            <label className="field">{t("f_name")}<input required value={draft.name} maxLength={120} onChange={(e) => setDraft({ ...draft, name: e.target.value })} /></label>
            <label className="field">{t("f_shape")}
              <select value={draft.shape} onChange={(e) => setDraft({ ...draft, shape: e.target.value as Draft["shape"] })}>
                <option value="circle">{t("v_circle")}</option><option value="polygon">{t("v_polygon")}</option>
              </select>
            </label>
            {draft.shape === "circle"
              ? <label className="field">{t("f_radiusM")}<input type="number" min={10} max={100000} value={draft.radiusM ?? ""} onChange={(e) => setDraft({ ...draft, radiusM: Number(e.target.value) })} /></label>
              : <div className="row"><span className="meta">{t("gf_corners", { n: draft.polygon?.length ?? 0 })}</span>
                <button type="button" className="btn sm ghost" disabled={!draft.polygon?.length} onClick={() => setDraft({ ...draft, polygon: (draft.polygon ?? []).slice(0, -1) })}><Undo2 size={14} aria-hidden />{t("gf_undoCorner")}</button></div>}
            <p className="meta">{draft.shape === "circle" ? t("gf_clickCentre") : t("gf_clickCorners")}</p>
            <label className="field">{t("f_alertOn")}
              <select value={draft.alertOn} onChange={(e) => setDraft({ ...draft, alertOn: e.target.value as Draft["alertOn"] })}>
                {(["enter", "exit", "both", "none"] as const).map((v) => <option key={v} value={v}>{t(`v_${v}` as MessageKey)}</option>)}
              </select>
            </label>
            <label className="row"><input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} />{t("f_active")}</label>
            <div className="row">
              <button type="submit" className="btn" disabled={!ready}>{t("save")}</button>
              <button type="button" className="btn alt" onClick={() => setDraft(null)}>{t("cancel")}</button>
            </div>
          </form>
        )}
        {zones.error ? <ErrorState error={zones.error} onRetry={zones.reload} forbidden={/403/.test(zones.error.message)} />
          : !zones.loaded ? <SkeletonList rows={4} />
          : list.length === 0 ? <EmptyState title={t("rEmpty")} body={t("gf_hint")} />
          : (
            <ul className="stoplist" aria-label={t("navGeofences")}>
              {list.map((z) => (
                <li key={z.id} className="row" style={{ justifyContent: "space-between" }}>
                  <span><strong>{z.name}</strong> <span className="meta">{t(`v_${z.shape}` as MessageKey)}{z.shape === "circle" && z.radiusM ? ` · ${z.radiusM} m` : ""}</span></span>
                  <span className="row">
                    <Chip tone={z.active ? "ok" : undefined}>{t(`v_${z.alertOn}` as MessageKey)}</Chip>
                    {canEdit && <button type="button" className="icon-btn" aria-label={`${t("rEdit")}: ${z.name}`} onClick={() => setDraft({ ...z, notes: z.notes ?? "", polygon: z.polygon ?? [] })}><Pencil size={16} aria-hidden /></button>}
                    {canEdit && <button type="button" className="icon-btn" aria-label={`${t("rDelete")}: ${z.name}`} onClick={() => remove(z)}><Trash2 size={16} aria-hidden /></button>}
                  </span>
                </li>
              ))}
            </ul>
          )}
      </aside>
      <GeofenceMap zones={list.filter((z) => z.id !== draft?.id)} draft={draft} onPick={pick} />
    </SplitView>
  );
}
