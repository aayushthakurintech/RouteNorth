"use client";
import { applyMapping, autoMap, IMPORT_PRESETS, JOB_IMPORT_FIELDS, rowsToCsv, type JobImportField, type MessageKey } from "@routenorth/shared";
import { useMemo, useState } from "react";
import { EmptyState, ErrorState, PageHead } from "@/components/ui/primitives";
import { apiSend } from "@/lib/api";
import { useI18n } from "@/lib/i18n-context";
import { useMe } from "@/lib/me-context";
import { parseCsvText } from "@/lib/csv-parse";
import { useToast } from "@/lib/toast";

interface Result { created: number; needLocation?: number[]; errors: { row: number; message: string }[] }

export default function ImportPage() {
  const { t } = useI18n(); const { can } = useMe(); const { toast } = useToast();
  const [data, setData] = useState<{ headers: string[]; rows: Record<string, string>[]; name: string } | null>(null);
  const [preset, setPreset] = useState("generic");
  const [map, setMap] = useState<Partial<Record<JobImportField, string>>>({});
  const [date, setDate] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const mapped = useMemo(() => (data ? applyMapping(data.rows, map) : []), [data, map]);
  if (!can("routes.write")) return <div className="content"><ErrorState forbidden /></div>;

  async function load(f: File) {
    if (f.size > 1_000_000) { toast(t("imp_tooBig"), { tone: "error" }); return; }
    const parsed = parseCsvText(await f.text());
    setData({ ...parsed, name: f.name }); setResult(null); setMap(autoMap(parsed.headers, preset));
  }
  async function run() {
    if (!data) return;
    setBusy(true);
    try { setResult(await apiSend<Result>("POST", "/jobs/import", { csv: rowsToCsv(mapped), ...(date ? { date } : {}) })); }
    catch (e) { toast((e as Error).message, { tone: "error" }); }
    finally { setBusy(false); }
  }
  const field = (f: JobImportField) => (
    <label key={f}>{t(`imp_f_${f}` as MessageKey)}
      <select value={map[f] ?? ""} onChange={(e) => setMap({ ...map, [f]: e.target.value })}><option value="">{t("imp_skip")}</option>{data!.headers.map((h) => <option key={h} value={h}>{h}</option>)}</select>
    </label>
  );
  return (
    <div className="content">
      <PageHead title={t("navImport")} subtitle={t("imp_subtitle")} />
      <div className="stack">
        <h2>{t("imp_step1")}</h2>
        <div className="row">
          <label>{t("imp_from")}<select value={preset} onChange={(e) => { setPreset(e.target.value); if (data) setMap(autoMap(data.headers, e.target.value)); }}>{IMPORT_PRESETS.map((p) => <option key={p.id} value={p.id}>{p.id === "generic" ? t("imp_generic") : p.id === "routenorth" ? t("imp_template") : p.label}</option>)}</select></label>
          <label>{t("imp_file")}<input type="file" accept=".csv,text/csv,text/plain" onChange={(e) => { const f = e.target.files?.[0]; if (f) void load(f); }} /></label>
        </div>
        <p className="meta small">{t("imp_presetNote")}</p>
        {!data ? <EmptyState title={t("imp_noFile")} body={t("imp_noFileBody")} /> : (
          <>
            <h2>{t("imp_step2")}</h2>
            <p className="meta small">{t("imp_found", { n: data.rows.length, file: data.name })}</p>
            <div className="grid2">{JOB_IMPORT_FIELDS.map(field)}</div>
            <label>{t("imp_defaultDate")}<input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
            <h2>{t("imp_step3")}</h2>
            {mapped.length === 0 || !JOB_IMPORT_FIELDS.some((f) => map[f]) ? <EmptyState title={t("imp_nothing")} /> : (
              <div style={{ overflowX: "auto" }}><table className="ptable"><thead><tr>{JOB_IMPORT_FIELDS.filter((f) => map[f]).map((f) => <th key={f}>{t(`imp_f_${f}` as MessageKey)}</th>)}</tr></thead>
                <tbody>{mapped.slice(0, 5).map((r, i) => <tr key={i}>{JOB_IMPORT_FIELDS.filter((f) => map[f]).map((f) => <td key={f}>{r[f] ?? ""}</td>)}</tr>)}</tbody></table></div>
            )}
            <div><button className="btn primary" disabled={busy || mapped.length === 0 || !(map.title || map.customer_name || map.address)} onClick={() => void run()}>{t("imp_run", { n: mapped.length })}</button></div>
          </>
        )}
        {result && (
          <div className="card" role="status" style={{ padding: "var(--s3) var(--s4)" }}>
            <strong>{t("imp_done", { n: result.created })}</strong>
            {(result.needLocation?.length ?? 0) > 0 && <p className="small">{t("imp_needLocation", { n: result.needLocation?.length ?? 0 })}</p>}
            {result.errors.length > 0 && <><p className="small">{t("imp_errors", { n: result.errors.length })}</p><ul className="small">{result.errors.slice(0, 20).map((e) => <li key={e.row}>{t("imp_row", { n: e.row })}: {e.message}</li>)}</ul></>}
          </div>
        )}
      </div>
    </div>
  );
}
