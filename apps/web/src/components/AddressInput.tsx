"use client";
import { useEffect, useId, useRef, useState } from "react";
import { apiGet } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";

interface Hit { label: string; lat: number; lng: number; source: string }
interface Result { check: { suggestion: string; issues: string[] } | null; results: Hit[] }

/** An address box that suggests places as you type (saved addresses and, when set up, a geocoder) and offers a tidier spelling. */
export function AddressInput({ value, onChange, onPlace, name = "address" }: { value: string; onChange: (v: string) => void; onPlace: (lat: number, lng: number, label: string) => void; name?: string }) {
  const { t } = useI18n();
  const listId = useId();
  const [res, setRes] = useState<Result | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const seq = useRef(0);

  useEffect(() => {
    clearTimeout(timer.current);
    if (value.trim().length < 4) { setRes(null); return; }
    const run = ++seq.current;
    timer.current = setTimeout(() => {
      apiGet<Result>(`/geocode?q=${encodeURIComponent(value.trim())}`).then((r) => { if (run === seq.current) setRes(r); }).catch(() => {});
    }, 350);
    return () => clearTimeout(timer.current);
  }, [value]);

  const pick = (label: string) => {
    onChange(label);
    const hit = res?.results.find((h) => h.label === label);
    if (hit) onPlace(hit.lat, hit.lng, hit.label);
  };
  const fix = res?.check && res.check.suggestion && res.check.suggestion !== value.trim() && res.check.issues.some((i) => i !== "no_postal_code" && i !== "no_province") ? res.check.suggestion : null;
  const missing = res?.check?.issues.filter((i) => ["no_street_number", "no_postal_code", "no_province", "too_short"].includes(i)) ?? [];

  return (
    <div className="stack" style={{ gap: 4 }}>
      <input maxLength={300} name={name} autoComplete="off" list={listId} value={value} onChange={(e) => pick(e.target.value)} />
      <datalist id={listId}>{(res?.results ?? []).map((h) => <option key={`${h.label}-${h.lat}`} value={h.label}>{h.source === "saved" ? t("savedPlace") : ""}</option>)}</datalist>
      {fix && <button type="button" className="btn sm ghost" style={{ justifyContent: "flex-start" }} onClick={() => onChange(fix)}>{t("didYouMean")} <em>{fix}</em></button>}
      {missing.length > 0 && <span className="hint">{missing.map((m) => t(`addrIssue_${m}` as never)).join(" · ")}</span>}
    </div>
  );
}
