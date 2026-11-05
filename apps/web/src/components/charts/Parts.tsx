import type { ReactNode } from "react";

/**
 * Small building blocks for dashboards that are not full charts: a headline number, a ranked list of bars and a progress meter.
 * Numbers are set in type (no coloured boxes); colour is spent only on the data itself.
 */
export function StatTile({ label, value, sub, tone }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "good" | "warn" | "bad" }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value" data-tone={tone}>{value}</span>
      {sub ? <span className="kpi-sub">{sub}</span> : null}
    </div>
  );
}

export interface BarItem { key: string; label: string; value: number; display: string; note?: string }

/** Horizontal bars ranked by value, one hue, the value written at the end. Reads as a list for screen readers. */
export function BarList({ items, ariaLabel, max }: { items: BarItem[]; ariaLabel: string; max?: number }) {
  const top = max ?? Math.max(...items.map((i) => i.value), 0);
  return (
    <ul className="bar-list" aria-label={ariaLabel}>
      {items.map((i) => (
        <li key={i.key} className="bar-row">
          <span className="bar-label" title={i.label}>{i.label}</span>
          <span className="bar-track" aria-hidden="true"><span className="bar-fill" style={{ width: `${top > 0 ? Math.max(i.value > 0 ? 1.5 : 0, (i.value / top) * 100) : 0}%` }} /></span>
          <span className="bar-value">{i.display}</span>
          {i.note ? <span className="bar-note">{i.note}</span> : null}
        </li>
      ))}
    </ul>
  );
}

/** A used-versus-limit meter. `remaining` colours the fill: plenty is neutral, low is amber, none is red (always with the text beside it). */
export function Meter({ label, used, limit, display, caption }: { label: string; used: number; limit: number; display: string; caption?: string }) {
  const pct = limit > 0 ? Math.max(0, Math.min(100, (used / limit) * 100)) : 0;
  const state = pct >= 100 ? "over" : pct >= 85 ? "low" : "ok";
  return (
    <div className="meter" data-state={state}>
      <div className="meter-head"><span>{label}</span><span className="meter-value">{display}</span></div>
      <div className="meter-track" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={limit} aria-valuenow={Math.round(Math.min(used, limit) * 10) / 10} aria-valuetext={display}>
        <span className="meter-fill" style={{ width: `${pct}%` }} />
      </div>
      {caption ? <div className="meter-cap">{caption}</div> : null}
    </div>
  );
}
