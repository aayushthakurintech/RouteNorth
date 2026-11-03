"use client";
import type { MessageKey } from "@routenorth/shared";
import { useState } from "react";
import ResourcePage from "@/components/ResourcePage";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { money } from "@/lib/money";
import { useToast } from "@/lib/toast";
import { useApi } from "@/lib/use-api";

interface Card { id: string; name: string; basis: string; active: boolean }
interface Priced { amount: number; parts: { label: string; amount: number }[] }

/** Rate cards (price by distance, weight, zone or time) with a small calculator to try them. */
export function RateCardsTab() {
  const { t, locale } = useI18n(); const { toast } = useToast();
  const cards = useApi<Card[]>("/r/rate-cards");
  const [id, setId] = useState(""); const [q, setQ] = useState({ km: "", kg: "", minutes: "", zone: "" });
  const [res, setRes] = useState<Priced | null>(null);
  const card = cards.data?.find((c) => c.id === id);
  async function price() {
    try { setRes(await apiSend<Priced>("POST", `/billing/rate-cards/${id}/price`, q)); } catch (e) { setRes(null); toast((e as Error).message, { tone: "error" }); }
  }
  return (
    <div className="stack">
      <p className="meta small">{t("bl_rateNote")}</p>
      {(cards.data?.length ?? 0) > 0 && (
        <section className="card" aria-label={t("bl_calc")}>
          <h2>{t("bl_calc")}</h2>
          <form className="row" style={{ gap: 8, alignItems: "flex-end", flexWrap: "wrap" }} onSubmit={(e) => { e.preventDefault(); void price(); }}>
            <label className="field"><span>{t("bl_rateCard")}</span><select value={id} onChange={(e) => { setId(e.target.value); setRes(null); }}><option value="">{t("rChoose")}</option>{cards.data!.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></label>
            {card?.basis === "distance" && <label className="field"><span>{t("bl_km")}</span><input type="number" min={0} step="any" value={q.km} onChange={(e) => setQ({ ...q, km: e.target.value })} /></label>}
            {card?.basis === "weight" && <label className="field"><span>{t("bl_kg")}</span><input type="number" min={0} step="any" value={q.kg} onChange={(e) => setQ({ ...q, kg: e.target.value })} /></label>}
            {card?.basis === "time" && <label className="field"><span>{t("bl_minutes")}</span><input type="number" min={0} step="any" value={q.minutes} onChange={(e) => setQ({ ...q, minutes: e.target.value })} /></label>}
            {card?.basis === "zone" && <label className="field"><span>{t("bl_zone")}</span><input value={q.zone} onChange={(e) => setQ({ ...q, zone: e.target.value })} /></label>}
            <button type="submit" className="btn" disabled={!id}>{t("bl_priceIt")}</button>
          </form>
          {res && <div role="status"><strong>{money(res.amount, "CAD", locale)}</strong>
            <ul className="meta small">{res.parts.map((p, i) => <li key={i}>{p.label === "base" || p.label === "minimum" ? t(`bl_part_${p.label}` as MessageKey) : p.label}: {money(p.amount, "CAD", locale)}</li>)}</ul></div>}
        </section>
      )}
      <ResourcePage name="rate-cards" embedded />
    </div>
  );
}
