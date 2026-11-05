"use client";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";

/**
 * Small SVG charts with no chart library. Colors come from the theme tokens (--chart-1 to --chart-8, a color-blind-safe set),
 * every chart with two or more series has a legend, hovering shows exact values, and each can be read as a table.
 */
export type ChartType = "bar" | "line" | "stacked" | "pie" | "heat" | "funnel" | "scatter";
export interface Series { name: string; values: (number | null)[] }
export interface ChartData { labels: string[]; series: Series[] }
export interface ChartProps {
  type: ChartType; data: ChartData; height?: number; format?: (n: number) => string; ariaLabel: string;
  /** Called with the label (and series index) of a clicked mark, for drill-down. */
  onPick?: (label: string, series: number) => void;
}

const color = (i: number) => `var(--chart-${(i % 8) + 1})`;
const defaultFormat = (n: number) => new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(n);
const DEFAULT_W = 640;

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v)); const f = v / p;
  // Steps whose quarters are tidy numbers, so the four grid lines read 60, 120, 180, 240 and not 62.5, 125...
  const step = [1, 1.2, 1.6, 2, 2.4, 2.8, 3.2, 4, 4.8, 6, 8, 10].find((x) => f <= x + 1e-9) ?? 10;
  return step * p;
}
const short = (s: string, n = 14) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

export function Legend({ names }: { names: string[] }) {
  if (names.length < 2) return null;
  return (
    <ul className="legend" aria-hidden="false">
      {names.map((n, i) => <li key={n + i}><span className="swatch" style={{ background: color(i) }} />{n}</li>)}
    </ul>
  );
}

export function Chart({ type, data, height = 240, format = defaultFormat, ariaLabel, onPick }: ChartProps) {
  const [tip, setTip] = useState<{ x: number; y: number; text: string; title?: string; rows?: { color: string; name: string; value: string }[] } | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  // Draw at the real pixel width, so type and marks keep their size on a wide monitor and a phone alike.
  const wrap = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(DEFAULT_W);
  useEffect(() => {
    const el = wrap.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const measure = () => { const w = Math.round(el.getBoundingClientRect().width); if (w > 0) setW(Math.max(280, Math.min(1400, w))); };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const place = (e: React.MouseEvent | React.FocusEvent) => {
    const box = (e.currentTarget.closest(".chart") as HTMLElement).getBoundingClientRect();
    const t = e.currentTarget.getBoundingClientRect();
    return { x: t.left - box.left + t.width / 2, y: t.top - box.top };
  };
  const show = (e: React.MouseEvent | React.FocusEvent, text: string) => setTip({ ...place(e), text });
  /** One card per category: its label and a coloured row per series, so values are read off the card, not off colour alone. */
  const showMulti = (e: React.MouseEvent | React.FocusEvent, i: number) => {
    setHover(i);
    setTip({
      ...place(e), text: "", title: data.labels[i],
      rows: data.series.map((s, k) => ({ color: color(k), name: s.name, value: s.values[i] == null ? "—" : format(s.values[i]!) })),
    });
  };
  const hide = () => { setTip(null); setHover(null); };
  const names = data.series.map((s) => s.name);
  const empty = data.labels.length === 0 || data.series.every((s) => s.values.every((v) => v == null));
  const body = useMemo<ReactNode>(() => {
    if (empty) return null;
    const H = height, padL = 58, padR = 12, padT = 12, padB = 30;
    const iw = W - padL - padR, ih = H - padT - padB;
    const pick = (i: number, s: number) => onPick?.(data.labels[i]!, s);
    const grid = (max: number) => [0, 0.25, 0.5, 0.75, 1].map((f) => (
      <g key={f}>
        <line x1={padL} x2={W - padR} y1={padT + ih * (1 - f)} y2={padT + ih * (1 - f)} className="chart-grid" />
        <text x={padL - 6} y={padT + ih * (1 - f) + 4} textAnchor="end" className="chart-axis">{format(max * f)}</text>
      </g>
    ));
    const xLabels = (n: number, pos: (i: number) => number) => {
      const step = Math.ceil(n / 8);
      return data.labels.map((l, i) => (i % step === 0 ? <text key={i} x={pos(i)} y={H - 10} textAnchor="middle" className="chart-axis">{short(l)}</text> : null));
    };

    if (type === "pie") {
      const vals = data.series[0]!.values.map((v) => Math.max(0, v ?? 0));
      const total = vals.reduce((a, b) => a + b, 0) || 1;
      const R = Math.min(ih, 200) / 2, cx = 150, cy = H / 2;
      let a0 = -Math.PI / 2;
      return (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
          {vals.map((v, i) => {
            if (v <= 0) return null;
            const a1 = a0 + (v / total) * Math.PI * 2;
            const large = a1 - a0 > Math.PI ? 1 : 0;
            const p = `M ${cx} ${cy} L ${cx + R * Math.cos(a0)} ${cy + R * Math.sin(a0)} A ${R} ${R} 0 ${large} 1 ${cx + R * Math.cos(a1 - 0.0001)} ${cy + R * Math.sin(a1 - 0.0001)} Z`;
            a0 = a1;
            return <path key={i} d={p} fill={color(i)} className="chart-mark" tabIndex={0} onClick={() => pick(i, 0)} onMouseEnter={(e) => show(e, `${data.labels[i]}: ${format(v)} (${Math.round((v / total) * 100)}%)`)} onMouseLeave={hide} onFocus={(e) => show(e, `${data.labels[i]}: ${format(v)}`)} onBlur={hide} />;
          })}
          {data.labels.slice(0, 10).map((l, i) => (
            <g key={i} transform={`translate(${cx + R + 40}, ${24 + i * 22})`}><rect width="10" height="10" rx="2" fill={color(i)} /><text x="16" y="9" className="chart-axis" style={{ textAnchor: "start" }}>{short(l, 26)} · {Math.round(((vals[i] ?? 0) / total) * 100)}%</text></g>
          ))}
        </svg>
      );
    }

    if (type === "funnel") {
      const vals = data.series[0]!.values.map((v) => v ?? 0);
      const max = Math.max(...vals, 1), rowH = Math.min(44, (H - 8) / vals.length);
      return (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
          {vals.map((v, i) => {
            const w = Math.max(4, (v / max) * (W - 200));
            return (
              <g key={i} onClick={() => pick(i, 0)} className="chart-mark" tabIndex={0} onMouseEnter={(e) => show(e, `${data.labels[i]}: ${format(v)}`)} onMouseLeave={hide}>
                <text x={130} y={4 + i * rowH + rowH / 2 + 4} textAnchor="end" className="chart-axis">{short(data.labels[i]!, 18)}</text>
                <rect x={140} y={4 + i * rowH + 2} width={w} height={rowH - 6} rx={4} fill={color(0)} opacity={1 - Math.min(0.6, i * 0.12)} />
                <text x={146 + w} y={4 + i * rowH + rowH / 2 + 4} className="chart-axis" style={{ textAnchor: "start" }}>{format(v)}</text>
              </g>
            );
          })}
        </svg>
      );
    }

    if (type === "heat") {
      // rows are series, columns are labels; darker means more
      const all = data.series.flatMap((s) => s.values).filter((v): v is number => v != null);
      const max = Math.max(...all, 1);
      const cw = Math.min(56, iw / data.labels.length), rh = Math.min(30, ih / data.series.length);
      return (
        <svg viewBox={`0 0 ${W} ${Math.max(H, padT + rh * data.series.length + padB)}`} role="img" aria-label={ariaLabel}>
          {data.series.map((s, r) => (
            <g key={r}>
              <text x={padL + 40} y={padT + r * rh + rh / 2 + 4} textAnchor="end" className="chart-axis">{short(s.name, 12)}</text>
              {s.values.map((v, c) => (
                <rect key={c} x={padL + 48 + c * cw} y={padT + r * rh} width={cw - 2} height={rh - 2} rx={3} className="chart-mark" tabIndex={0}
                  fill={v == null ? "var(--surface-2)" : "var(--chart-1)"} opacity={v == null ? 1 : 0.12 + 0.88 * (v / max)}
                  onClick={() => pick(c, r)} onMouseEnter={(e) => show(e, `${s.name} · ${data.labels[c]}: ${v == null ? "—" : format(v)}`)} onMouseLeave={hide} />
              ))}
            </g>
          ))}
          {data.labels.map((l, c) => (c % Math.ceil(data.labels.length / 10) === 0 ? <text key={c} x={padL + 48 + c * cw + cw / 2} y={padT + rh * data.series.length + 16} textAnchor="middle" className="chart-axis">{short(l, 8)}</text> : null))}
        </svg>
      );
    }

    if (type === "scatter") {
      // first series is x, second is y
      const xs = data.series[0]!.values, ys = (data.series[1] ?? data.series[0]!).values;
      const pts = xs.map((x, i) => ({ x, y: ys[i] ?? null, i })).filter((p): p is { x: number; y: number; i: number } => p.x != null && p.y != null);
      const mx = niceMax(Math.max(...pts.map((p) => p.x), 1)), my = niceMax(Math.max(...pts.map((p) => p.y), 1));
      return (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
          {grid(my)}
          {[0, 0.5, 1].map((f) => <text key={f} x={padL + iw * f} y={H - 10} textAnchor="middle" className="chart-axis">{format(mx * f)}</text>)}
          {pts.map((p) => (
            <circle key={p.i} cx={padL + (p.x / mx) * iw} cy={padT + ih * (1 - p.y / my)} r={5} fill={color(0)} stroke="var(--surface)" strokeWidth={2} className="chart-mark" tabIndex={0}
              onClick={() => pick(p.i, 0)} onMouseEnter={(e) => show(e, `${data.labels[p.i]}: ${format(p.x)} / ${format(p.y)}`)} onMouseLeave={hide} />
          ))}
        </svg>
      );
    }

    const stacked = type === "stacked";
    const sums = data.labels.map((_, i) => data.series.reduce((a, s) => a + Math.max(0, s.values[i] ?? 0), 0));
    const maxV = niceMax(stacked ? Math.max(...sums, 0) : Math.max(...data.series.flatMap((s) => s.values.map((v) => v ?? 0)), 0));
    const y = (v: number) => padT + ih * (1 - v / maxV);

    if (type === "line") {
      const x = (i: number) => padL + (data.labels.length === 1 ? iw / 2 : (i / (data.labels.length - 1)) * iw);
      const lastIdx = (vals: (number | null)[]) => { for (let i = vals.length - 1; i >= 0; i--) if (vals[i] != null) return i; return -1; };
      return (
        <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
          {grid(maxV)}
          {xLabels(data.labels.length, x)}
          {data.series.length === 1 && (() => {
            const s0 = data.series[0]!;
            const pts = s0.values.map((v, i) => (v == null ? null : [x(i), y(v)] as const)).filter((p): p is readonly [number, number] => p != null);
            if (pts.length < 2) return null;
            return <path d={`M${pts[0]![0]} ${padT + ih} ${pts.map((p) => `L${p[0]} ${p[1]}`).join(" ")} L${pts[pts.length - 1]![0]} ${padT + ih} Z`} fill={color(0)} opacity={0.1} />;
          })()}
          {data.series.map((s, k) => {
            let d = "", pen = false;
            s.values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${x(i)} ${y(v)} `; pen = true; });
            return <path key={k} d={d} fill="none" stroke={color(k)} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />;
          })}
          {hover != null && <line x1={x(hover)} x2={x(hover)} y1={padT} y2={padT + ih} className="chart-cross" />}
          {data.series.map((s, k) => {
            const end = lastIdx(s.values);
            const idxs = [...new Set([end, hover ?? -1].filter((i) => i >= 0))];
            return idxs.map((i) => (s.values[i] == null ? null : <circle key={`${k}-${i}`} cx={x(i)} cy={y(s.values[i]!)} r={4} fill={color(k)} stroke="var(--surface)" strokeWidth={2} pointerEvents="none" />));
          })}
          {data.labels.map((l, i) => (
            <rect key={i} x={x(i) - iw / data.labels.length / 2} y={padT} width={iw / data.labels.length} height={ih} fill="transparent" className="chart-hit" tabIndex={0}
              onClick={() => pick(i, 0)} onMouseEnter={(e) => showMulti(e, i)} onMouseLeave={hide} onFocus={(e) => showMulti(e, i)} onBlur={hide} />
          ))}
        </svg>
      );
    }

    // bar and stacked: thin marks, 4px rounded at the data end and square on the baseline, a 2px gap between neighbours
    const n = data.labels.length, slot = iw / n, groups = stacked ? 1 : data.series.length, bw = Math.max(3, Math.min(24, (slot * 0.7) / groups));
    const barPath = (bx: number, by: number, w: number, h: number, round: boolean) => {
      const r = round ? Math.min(4, w / 2, h) : 0;
      return `M${bx} ${by + h} L${bx} ${by + r} Q${bx} ${by} ${bx + r} ${by} L${bx + w - r} ${by} Q${bx + w} ${by} ${bx + w} ${by + r} L${bx + w} ${by + h} Z`;
    };
    return (
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={ariaLabel}>
        {grid(maxV)}
        {xLabels(n, (i) => padL + slot * i + slot / 2)}
        {data.labels.map((l, i) => {
          let acc = 0;
          const tops = stacked ? data.series.map((s, k) => ((s.values[i] ?? 0) > 0 ? k : -1)).filter((k) => k >= 0) : [];
          const topK = tops.length ? tops[tops.length - 1] : -1;
          return (
            <g key={i} className="chart-mark" tabIndex={0} onClick={() => pick(i, 0)} onMouseEnter={(e) => showMulti(e, i)} onMouseLeave={hide} onFocus={(e) => showMulti(e, i)} onBlur={hide}>
              <rect x={padL + slot * i} y={padT} width={slot} height={ih} fill={hover === i ? "var(--chart-grid)" : "transparent"} opacity={0.5} />
              {data.series.map((s, k) => {
                const v = Math.max(0, s.values[i] ?? 0);
                if (stacked) { const y0 = y(acc + v), h = y(acc) - y0; acc += v; return h > 0 ? <path key={k} d={barPath(padL + slot * i + (slot - bw) / 2, y0, bw, Math.max(1, h - 2), k === topK)} fill={color(k)} /> : null; }
                const h = ih * (v / maxV);
                return h > 0 ? <path key={k} d={barPath(padL + slot * i + (slot - bw * groups) / 2 + k * bw, padT + ih - h, bw - 2, h, true)} fill={color(k)} /> : null;
              })}
            </g>
          );
        })}
      </svg>
    );
  }, [type, data, height, format, ariaLabel, onPick, empty, hover, W]);

  if (empty) return <div className="chart-empty">—</div>;
  return (
    <div className="chart" ref={wrap} style={{ position: "relative" }}>
      {type !== "pie" && type !== "funnel" && type !== "scatter" && type !== "heat" && <Legend names={names} />}
      {body}
      {tip && (
        <div className="chart-tip" style={{ left: tip.x, top: tip.y }} role="status">
          {tip.rows ? (
            <>
              <strong>{tip.title}</strong>
              {tip.rows.map((r, i) => <span key={i} className="tip-row"><span className="swatch" style={{ background: r.color }} aria-hidden />{tip.rows!.length > 1 && <span className="tip-name">{r.name}</span>}<span className="tip-val">{r.value}</span></span>)}
            </>
          ) : tip.text}
        </div>
      )}
    </div>
  );
}

/** The same numbers as a table, for people who prefer reading them (and for screen readers). */
export function ChartTable({ data, format = defaultFormat }: { data: ChartData; format?: (n: number) => string }) {
  return (
    <div className="dt-scroll" style={{ maxHeight: 260 }}>
      <table className="plain">
        <thead><tr><th />{data.series.map((s, i) => <th key={i} style={{ textAlign: "right" }}>{s.name}</th>)}</tr></thead>
        <tbody>{data.labels.map((l, i) => <tr key={i}><th scope="row">{l}</th>{data.series.map((s, k) => <td key={k} className="mono-num" style={{ textAlign: "right" }}>{s.values[i] == null ? "—" : format(s.values[i]!)}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

/** A tiny trend line for a key number. */
export function Sparkline({ values, width = 96, height = 28 }: { values: (number | null)[]; width?: number; height?: number }) {
  const nums = values.filter((v): v is number => v != null);
  if (nums.length < 2) return null;
  const min = Math.min(...nums), max = Math.max(...nums), span = max - min || 1;
  let d = "", pen = false;
  values.forEach((v, i) => { if (v == null) { pen = false; return; } d += `${pen ? "L" : "M"}${(i / (values.length - 1)) * width} ${height - 3 - ((v - min) / span) * (height - 6)} `; pen = true; });
  return <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><path d={d} fill="none" stroke="var(--chart-1)" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
