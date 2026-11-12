"use client";
import { AlertTriangle, Inbox, Lock } from "lucide-react";
import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useI18n } from "@/lib/i18n-context";

export function Skeleton({ w, h = 14, style }: { w?: number | string; h?: number | string; style?: CSSProperties }) {
  return <div className="skeleton" aria-hidden style={{ width: w ?? "100%", height: h, ...style }} />;
}

/** Placeholder rows shaped like the content that is loading. */
export function SkeletonList({ rows = 5, h = 44 }: { rows?: number; h?: number }) {
  const { t } = useI18n();
  return (
    <div role="status" aria-label={t("loading")} style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      {Array.from({ length: rows }, (_, i) => <Skeleton key={i} h={h} />)}
    </div>
  );
}

export function EmptyState({ icon, title, body, action }: { icon?: ReactNode; title: string; body?: string; action?: ReactNode }) {
  return (
    <div className="state">
      {icon ?? <Inbox size={36} aria-hidden />}
      <h2>{title}</h2>
      {body && <p>{body}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, onRetry, forbidden }: { error?: Error | null; onRetry?: () => void; forbidden?: boolean }) {
  const { t } = useI18n();
  if (forbidden) return <div className="state error"><Lock size={36} aria-hidden /><h2>{t("forbiddenTitle")}</h2><p>{t("forbiddenBody")}</p></div>;
  const status = /HTTP (\d+)/.exec(error?.message ?? "")?.[1];
  return (
    <div className="state error" role="alert">
      <AlertTriangle size={36} aria-hidden />
      <h2>{t("loadError")}</h2>
      <p>{status === "403" ? t("forbiddenBody") : t("loadErrorBody")}</p>
      {onRetry && <button type="button" className="btn alt" onClick={onRetry}>{t("retry")}</button>}
    </div>
  );
}

export function Chip({ tone, children, dot }: { tone?: "ok" | "warn" | "danger" | "info" | "brand"; children: ReactNode; dot?: boolean }) {
  return <span className={`chip ${tone ?? ""}`}>{dot && <span className="dot" aria-hidden />}{children}</span>;
}

export function PageHead({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: ReactNode }) {
  return (
    <div className="page-head">
      <div className="grow"><h1>{title}</h1>{subtitle && <p>{subtitle}</p>}</div>
      {actions && <div className="row">{actions}</div>}
    </div>
  );
}

export function Tooltip({ text, children }: { text: string; children: ReactNode }) {
  const id = useId();
  return (
    <span className="tip">
      <span aria-describedby={id} style={{ display: "contents" }}>{children}</span>
      <span role="tooltip" id={id} className="tip-bubble">{text}</span>
    </span>
  );
}

export interface TabDef { id: string; label: string }
export function Tabs({ tabs, value, onChange, label }: { tabs: TabDef[]; value: string; onChange: (id: string) => void; label: string }) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const move = (i: number) => { const n = (i + tabs.length) % tabs.length; onChange(tabs[n]!.id); refs.current[n]?.focus(); };
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tb, i) => (
        <button
          key={tb.id} ref={(el) => { refs.current[i] = el; }} role="tab" type="button" className="tab" id={`tab-${tb.id}`}
          aria-selected={tb.id === value} tabIndex={tb.id === value ? 0 : -1}
          onClick={() => onChange(tb.id)}
          onKeyDown={(e) => {
            if (e.key === "ArrowRight") { e.preventDefault(); move(i + 1); }
            if (e.key === "ArrowLeft") { e.preventDefault(); move(i - 1); }
          }}
        >{tb.label}</button>
      ))}
    </div>
  );
}

/** A dialog that traps focus and closes on Escape or a click outside (native <dialog>). */
export function Modal({ open, onClose, title, children, actions }: { open: boolean; onClose: () => void; title: string; children: ReactNode; actions?: ReactNode }) {
  const ref = useRef<HTMLDialogElement>(null);
  const { t } = useI18n();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  return (
    <dialog
      ref={ref} className="modal" aria-label={title} onClose={onClose}
      onClick={(e) => { if (e.target === ref.current) onClose(); }}
    >
      {open && (
        <div className="modal-body">
          <h2>{title}</h2>
          {children}
          <div className="modal-actions">
            {actions ?? <button type="button" className="btn alt" onClick={onClose}>{t("close")}</button>}
          </div>
        </div>
      )}
    </dialog>
  );
}

/** Animates a number up to its value. Jumps straight there when motion is reduced. */
export function useCountUp(value: number, ms = 700): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    const reduced =
      document.documentElement.dataset.motion === "reduce" ||
      (document.documentElement.dataset.motion !== "full" && matchMedia("(prefers-reduced-motion: reduce)").matches);
    if (reduced || from.current === value) { from.current = value; setShown(value); return; }
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = (now: number) => {
      const p = Math.min(1, (now - start) / ms);
      const eased = 1 - (1 - p) ** 3;
      setShown(a + (value - a) * eased);
      if (p < 1) raf = requestAnimationFrame(step); else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}

export interface KpiProps {
  label: string;
  value: number | null;
  /** How to print the number, e.g. (n) => `${n.toFixed(1)}%`. */
  format?: (n: number) => string;
  sub?: string;
  /** Change versus the previous period, as a fraction (0.12 = +12%). */
  delta?: number | null;
  /** Whether going up is good (default) or bad (e.g. idle time). */
  upIsGood?: boolean;
  href?: string;
}

/** A key number: big type, no tile, no icon. Clickable when it has somewhere to drill down to. */
export function Kpi({ label, value, format, sub, delta, upIsGood = true, href }: KpiProps) {
  const { t } = useI18n();
  const shown = useCountUp(value ?? 0);
  const fmt = format ?? ((n: number) => Math.round(n).toLocaleString());
  const good = delta === null || delta === undefined || delta === 0 ? null : (delta > 0) === upIsGood;
  const body = (
    <>
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value === null ? "—" : fmt(shown)}</span>
      {(sub || (delta !== null && delta !== undefined)) && (
        <span className="kpi-sub">
          {delta !== null && delta !== undefined && (
            <span className={`kpi-delta ${good === null ? "" : good ? "good" : "bad"}`}>
              {delta === 0 ? t("noChange") : `${delta > 0 ? "▲" : "▼"} ${Math.abs(delta * 100).toFixed(1)}%`}
            </span>
          )}
          {sub && <> {sub}</>}
        </span>
      )}
    </>
  );
  return href ? <a className="kpi" href={href}>{body}</a> : <div className="kpi">{body}</div>;
}

/** Brief check-mark celebration for a finished task (static when motion is reduced). */
export function SuccessMark({ label }: { label: string }) {
  return (
    <svg className="check-pop" width="44" height="44" viewBox="0 0 44 44" role="img" aria-label={label}>
      <circle cx="22" cy="22" r="20" fill="var(--ok-soft)" stroke="var(--ok)" strokeWidth="2" />
      <path d="M13 23l6 6 12-13" fill="none" stroke="var(--ok)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
