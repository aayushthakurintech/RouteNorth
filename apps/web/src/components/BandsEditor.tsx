"use client";
import { Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n-context";

interface Tier { upTo: number | null; rate: number }
interface Zone { name: string; price: number }

const parse = (v: unknown): unknown[] => { try { const x = typeof v === "string" ? (v ? JSON.parse(v) : []) : v; return Array.isArray(x) ? x : []; } catch { return []; } };

/** Rate bands (up to N units costs R per unit) or named zones with one price each, for a rate card. The value is kept as JSON text like other JSON fields. */
export default function BandsEditor({ basis, tiers, zones, onTiers, onZones }: { basis: string; tiers: unknown; zones: unknown; onTiers: (v: string) => void; onZones: (v: string) => void }) {
  const { t } = useI18n();
  if (basis === "zone") {
    const rows = parse(zones) as Zone[];
    const set = (next: Zone[]) => onZones(JSON.stringify(next));
    return (
      <fieldset className="stack" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10 }}>
        <legend>{t("bl_zones")}</legend>
        {rows.map((z, i) => (
          <div className="row" key={i} style={{ gap: 8 }}>
            <input aria-label={t("bl_zoneName")} placeholder={t("bl_zoneName")} value={z.name} maxLength={60} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))} />
            <input aria-label={t("bl_zonePrice")} type="number" min={0} step="any" value={z.price} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, price: Number(e.target.value) } : x)))} />
            <button type="button" className="btn sm ghost" aria-label={t("rDelete")} onClick={() => set(rows.filter((_, j) => j !== i))}><Trash2 size={14} aria-hidden /></button>
          </div>
        ))}
        <button type="button" className="btn sm alt" onClick={() => set([...rows, { name: "", price: 0 }])}><Plus size={14} aria-hidden /> {t("bl_addZone")}</button>
      </fieldset>
    );
  }
  const rows = parse(tiers) as Tier[];
  const set = (next: Tier[]) => onTiers(JSON.stringify(next));
  const unit = basis === "weight" ? "kg" : basis === "time" ? "min" : "km";
  return (
    <fieldset className="stack" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10 }}>
      <legend>{t("bl_bands")}</legend>
      <p className="meta small">{t("bl_bandsNote", { unit })}</p>
      {rows.map((b, i) => (
        <div className="row" key={i} style={{ gap: 8, alignItems: "center" }}>
          <label className="row" style={{ gap: 4 }}>{t("bl_upTo", { unit })}
            <input type="number" min={0} step="any" value={b.upTo ?? ""} placeholder={t("bl_andMore")} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, upTo: e.target.value === "" ? null : Number(e.target.value) } : x)))} />
          </label>
          <label className="row" style={{ gap: 4 }}>{t("bl_ratePer", { unit })}
            <input type="number" min={0} step="any" value={b.rate} onChange={(e) => set(rows.map((x, j) => (j === i ? { ...x, rate: Number(e.target.value) } : x)))} />
          </label>
          <button type="button" className="btn sm ghost" aria-label={t("rDelete")} onClick={() => set(rows.filter((_, j) => j !== i))}><Trash2 size={14} aria-hidden /></button>
        </div>
      ))}
      <button type="button" className="btn sm alt" onClick={() => set([...rows, { upTo: rows.length ? null : 10, rate: 0 }])}><Plus size={14} aria-hidden /> {t("bl_addBand")}</button>
    </fieldset>
  );
}
