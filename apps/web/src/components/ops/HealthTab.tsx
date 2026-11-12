"use client";
import type { MessageKey } from "@routenorth/shared";
import { AlertTriangle, Check, CircleSlash, XCircle } from "lucide-react";
import Link from "next/link";
import { ErrorState, SkeletonList } from "@/components/ui/primitives";
import { useI18n } from "@/lib/i18n-context";
import { useApi } from "@/lib/use-api";

type Status = "ok" | "warn" | "fail" | "off";
interface Check { id: string; status: Status; value?: number | string | null; extra?: number }
interface Health { overall: Status; checkedAt: string; checks: Check[] }
interface Err { id: string; at: string; status: number; method: string | null; path: string | null; message: string | null }

const ICON = { ok: Check, warn: AlertTriangle, fail: XCircle, off: CircleSlash } as const;
const LINK: Record<string, string> = { webhooks: "/integrations", customerMessages: "/settings/customers", workflows: "/automation", email: "/integrations", geocoder: "/integrations", gpsFeed: "/fleet/vehicles", silentDevices: "/fleet/vehicles" };

/** Is everything running? Each check says what it looked at, in plain words, and where to go to fix it. */
export function HealthTab() {
  const { t, locale } = useI18n();
  const h = useApi<Health>("/ops/health", { intervalMs: 60_000 });
  const errs = useApi<Err[]>("/ops/errors");
  if (h.error && !h.loaded) return <ErrorState error={h.error} onRetry={h.reload} />;
  if (!h.data) return <SkeletonList rows={6} />;
  const fmt = (d: string) => new Intl.DateTimeFormat(locale, { dateStyle: "short", timeStyle: "medium" }).format(new Date(d));
  return (
    <div className="stack">
      <p role="status"><strong>{t(`hx_overall_${h.data.overall}` as MessageKey)}</strong> <span className="meta">{t("hx_checked", { time: fmt(h.data.checkedAt) })}</span></p>
      <ul className="stack" style={{ listStyle: "none", padding: 0, margin: 0 }}>
        {h.data.checks.map((c) => {
          const Icon = ICON[c.status];
          return (
            <li key={c.id} className="card row" style={{ gap: 12, alignItems: "flex-start" }}>
              <span aria-hidden style={{ color: c.status === "ok" ? "var(--ok)" : c.status === "off" ? "var(--muted)" : "var(--danger)" }}><Icon size={18} /></span>
              <div style={{ flex: 1 }}>
                <strong>{t(`hx_c_${c.id}` as MessageKey)}</strong> <span className={`chip ${c.status === "ok" ? "ok" : ""}`}>{t(`hx_s_${c.status}` as MessageKey)}</span>
                <p className="meta" style={{ margin: "4px 0 0" }}>{t(`hx_c_${c.id}_${c.status}` as MessageKey, { value: c.value ?? 0, extra: c.extra ?? 0 })}</p>
              </div>
              {(c.status === "warn" || c.status === "fail" || c.status === "off") && LINK[c.id] && <Link className="btn sm alt" href={LINK[c.id]!}>{t("hx_open")}</Link>}
            </li>
          );
        })}
      </ul>
      <h2>{t("hx_errors")}</h2>
      {errs.data && errs.data.length === 0 && <p className="meta">{t("hx_no_errors")}</p>}
      {errs.data && errs.data.length > 0 && (
        <table className="ptable">
          <caption className="sr-only">{t("hx_errors")}</caption>
          <thead><tr><th scope="col">{t("hx_when")}</th><th scope="col">{t("hx_what")}</th><th scope="col">{t("hx_message")}</th></tr></thead>
          <tbody>{errs.data.map((e) => <tr key={e.id}><td>{fmt(e.at)}</td><td className="mono">{e.status} {e.method} {e.path}</td><td>{e.message}</td></tr>)}</tbody>
        </table>
      )}
    </div>
  );
}
