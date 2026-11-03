"use client";
import { Plus, Trash2 } from "lucide-react";
import { useI18n } from "@/lib/i18n-context";
import { emptyLine, linesSubtotal, money, type LineDraft } from "@/lib/money";

/** Lines for an invoice or quote: what, how many, how much each. */
export function LinesEditor({ lines, onChange, currency }: { lines: LineDraft[]; onChange: (l: LineDraft[]) => void; currency: string }) {
  const { t, locale } = useI18n();
  const set = (i: number, patch: Partial<LineDraft>) => onChange(lines.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  return (
    <fieldset className="stack" style={{ border: "1px solid var(--line)", borderRadius: 8, padding: 10 }}>
      <legend>{t("bl_lines")}</legend>
      {lines.map((l, i) => (
        <div className="row" key={i} style={{ gap: 8, alignItems: "flex-end" }}>
          <label className="field" style={{ flex: 3 }}>{i === 0 && <span>{t("bl_desc")}</span>}<input aria-label={`${t("bl_desc")} ${i + 1}`} value={l.description} maxLength={200} onChange={(e) => set(i, { description: e.target.value })} /></label>
          <label className="field" style={{ flex: 1 }}>{i === 0 && <span>{t("bl_qty")}</span>}<input aria-label={`${t("bl_qty")} ${i + 1}`} type="number" min={0} step="any" value={l.qty} onChange={(e) => set(i, { qty: e.target.value })} /></label>
          <label className="field" style={{ flex: 1 }}>{i === 0 && <span>{t("bl_unit")}</span>}<input aria-label={`${t("bl_unit")} ${i + 1}`} type="number" min={0} step="any" value={l.unitPrice} onChange={(e) => set(i, { unitPrice: e.target.value })} /></label>
          <button type="button" className="btn sm ghost" aria-label={t("rDelete")} disabled={lines.length === 1} onClick={() => onChange(lines.filter((_, j) => j !== i))}><Trash2 size={14} aria-hidden /></button>
        </div>
      ))}
      <div className="row" style={{ justifyContent: "space-between" }}>
        <button type="button" className="btn sm alt" onClick={() => onChange([...lines, emptyLine()])}><Plus size={14} aria-hidden /> {t("bl_addLine")}</button>
        <strong>{t("bl_subtotal")}: {money(linesSubtotal(lines), currency, locale)}</strong>
      </div>
    </fieldset>
  );
}
