"use client";
import { useEffect, useRef, useState, type ReactNode } from "react";

const KEY = "routenorth.split";

/** Two panes with a draggable divider (arrow keys work too). The width is remembered per page. */
export function SplitView({ id = "default", children, min = 280, max = 640 }: { id?: string; children: [ReactNode, ReactNode]; min?: number; max?: number }) {
  const [w, setW] = useState(360);
  const [drag, setDrag] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);

  useEffect(() => {
    try { const v = Number(JSON.parse(localStorage.getItem(KEY) ?? "{}")[id]); if (v >= min && v <= max) setW(v); } catch { /* ignore */ }
  }, [id, min, max]);
  const save = (v: number) => { try { const all = JSON.parse(localStorage.getItem(KEY) ?? "{}"); all[id] = v; localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* ignore */ } };

  const onDown = (e: React.PointerEvent) => {
    e.preventDefault();
    setDrag(true);
    const rtl = document.documentElement.dir === "rtl";
    const left = wrap.current?.getBoundingClientRect();
    const move = (ev: PointerEvent) => {
      if (!left) return;
      const x = rtl ? left.right - ev.clientX : ev.clientX - left.left;
      setW(Math.max(min, Math.min(max, x)));
    };
    const up = () => { setDrag(false); window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up); setW((v) => { save(v); return v; }); };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return (
    <div ref={wrap} className="split" style={{ ["--split-left" as string]: `${w}px` }}>
      <div className="split-left">{children[0]}</div>
      <div
        className={`split-handle ${drag ? "active" : ""}`} role="separator" aria-orientation="vertical" tabIndex={0} aria-valuenow={w} aria-valuemin={min} aria-valuemax={max}
        onPointerDown={onDown}
        onKeyDown={(e) => {
          const step = e.key === "ArrowRight" ? 24 : e.key === "ArrowLeft" ? -24 : 0;
          if (step) { e.preventDefault(); const v = Math.max(min, Math.min(max, w + (document.documentElement.dir === "rtl" ? -step : step))); setW(v); save(v); }
        }}
      />
      <div className="split-right">{children[1]}</div>
    </div>
  );
}
