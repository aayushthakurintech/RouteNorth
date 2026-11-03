"use client";
import { useParams, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useMemo, useState } from "react";
import { Chart, type ChartType } from "@/components/charts/Charts";
import { PointsMap } from "@/components/charts/PointsMap";
import { API_URL } from "@/lib/session";
import { useI18n } from "@/lib/i18n-context";

interface Shared {
  name: string; expiresAt: string; org: { name: string; color: string | null; logo: string | null };
  result: { columns: { key: string; label: string; type: string; calc?: boolean }[]; rows: Record<string, unknown>[]; total: number; range: { from: string; to: string }; spec: { chart?: { type?: string; x?: string; y?: string[] } } };
}

function View() {
  const { token } = useParams<{ token: string }>();
  const embed = useSearchParams().has("embed");
  const { t, locale } = useI18n();
  const [data, setData] = useState<Shared | null>(null);
  const [state, setState] = useState<"loading" | "gone" | "error">("loading");
  useEffect(() => {
    let alive = true;
    fetch(`${API_URL}/public/report/${encodeURIComponent(token)}`).then(async (r) => {
      if (!alive) return;
      if (r.status === 404) return setState("gone");
      if (!r.ok) return setState("error");
      setData(await r.json());
    }).catch(() => alive && setState("error"));
    return () => { alive = false; };
  }, [token]);
  const label = (k: string) => { const key = `an_${k}`; const v = t(key as never); return v === key ? k : v; };
  const res = data?.result;
  const type = (res?.spec.chart?.type ?? "table") as string;
  const xKey = res?.spec.chart?.x ?? res?.columns.find((c) => c.type !== "num" && c.type !== "pct")?.key ?? res?.columns[0]?.key ?? "";
  const yKeys = useMemo(() => (res?.spec.chart?.y?.length ? res.spec.chart.y : res?.columns.filter((c) => c.type === "num" || c.type === "pct").slice(0, 1).map((c) => c.key) ?? []), [res]);
  const points = (res?.rows ?? []).filter((r) => typeof r.lat === "number" && typeof r.lng === "number").map((r) => ({ lat: r.lat as number, lng: r.lng as number }));
  const brand = data?.org.color ?? undefined;
  return (
    <main className={`shared-report ${embed ? "embed" : ""}`} style={brand ? ({ "--brand": brand } as React.CSSProperties) : undefined}>
      {state === "gone" && <div className="empty"><h1>{t("sr_gone")}</h1><p>{t("sr_goneBody")}</p></div>}
      {state === "error" && <div className="error" role="alert">{t("sr_error")}</div>}
      {state === "loading" && <p className="meta">{t("loading")}</p>}
      {data && res && (
        <>
          {!embed && <header className="row">{data.org.logo && <img src={data.org.logo} alt="" height={36} />}<div><h1 style={{ margin: 0 }}>{data.name}</h1><p className="meta">{data.org.name} · {res.range.from} – {res.range.to}</p></div></header>}
          {type !== "table" && type !== "map" && yKeys.length > 0 && (
            <Chart type={type as ChartType} ariaLabel={data.name} data={{ labels: res.rows.slice(0, 200).map((r) => String(r[xKey] ?? "—")), series: yKeys.map((k) => ({ name: label(k), values: res.rows.slice(0, 200).map((r) => (typeof r[k] === "number" ? (r[k] as number) : null)) })) }} />
          )}
          {type === "map" && points.length > 0 && <PointsMap points={points} ariaLabel={data.name} />}
          <div className="dt-scroll" style={{ maxHeight: embed ? 320 : "60vh" }}>
            <table className="plain">
              <thead><tr>{res.columns.map((c) => <th key={c.key}>{c.calc ? c.label : label(c.key)}</th>)}</tr></thead>
              <tbody>{res.rows.slice(0, 500).map((r, i) => <tr key={i}>{res.columns.map((c) => <td key={c.key} className={c.type === "num" ? "mono-num" : ""}>{r[c.key] == null ? "—" : c.type === "ts" ? new Date(String(r[c.key])).toLocaleString(locale === "fr" ? "fr-CA" : "en-CA") : String(r[c.key])}</td>)}</tr>)}</tbody>
            </table>
          </div>
          {!embed && <p className="meta small">{t("sr_expires", { date: new Date(data.expiresAt).toLocaleDateString() })} · <a className="link" href={`${API_URL}/public/report/${encodeURIComponent(token)}?format=csv`}>CSV</a></p>}
        </>
      )}
    </main>
  );
}

export default function SharedReportPage() { return <Suspense><View /></Suspense>; }
